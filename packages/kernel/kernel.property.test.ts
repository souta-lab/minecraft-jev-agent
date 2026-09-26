import { describe, expect, test } from 'bun:test'
import {
  applyKernelCommand,
  assertKernelInvariants,
  createKernelState,
  createTransitionContract,
  kernelSemanticDigest,
  replayKernelEvents,
  resourceId,
  type KernelCommand,
  type KernelEvent,
  type KernelState,
} from './kernel.ts'
import { trustedContractCompiler, trustedController, trustedDispatcher, trustedMissionAuthority, trustedProgressEvaluator, trustedScheduler, trustedVerifier, trustedWorldAdapter } from './kernel-internal/trusted-adapter.ts'

const verifier = { id: 'verifier:world', version: '1' } as const
const progress = { id: 'progress:random', version: '1' } as const
const terminal = { id: 'terminal:random', version: '1' } as const
const controller = { id: 'controller:random', version: '1' } as const
const compiler = { id: 'compiler:random', version: '1' } as const
const missionAuthority = { id: 'mission:random', version: '1' } as const
const baseWorld = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 } as const
const locomotion = resourceId('body', ['locomotion'])
const orientation = resourceId('body', ['orientation'])
const blocks = resourceId('world', ['blocks'])
const memory = resourceId('memory', ['worldModel'])

function mk(id: string, klass: 'MISSION' | 'VIABILITY' | 'BACKGROUND', resource: ReturnType<typeof resourceId>, mode: 'EXCLUSIVE_WRITE' | 'APPEND' = 'EXCLUSIVE_WRITE', effectKind?: 'MOVE' | 'LOOK' | 'DIG', critical = false) {
  const desired = `goal:${id}`
  return createTransitionContract({
    transitionId: id, family: id.split(':')[0]!, class: klass, world: baseWorld,
    desiredPredicate: desired, requires: [], ensures: [desired], invariants: [],
    // `critical` claims are bounded non-preemptible critical sections: terminal
    // and cancel requests wait for a safe yield, which is where quiescing races live.
    claims: [critical ? { resource, mode, preemptible: false, resumable: true, maxNonPreemptibleMs: 8 } : { resource, mode, preemptible: true, resumable: true }],
    effects: effectKind === undefined ? [] : [{ kind: effectKind, scope: `scope:${id}`, irreversible: true, maxCount: 3, requiredResources: [{ resource, mode: 'EXCLUSIVE_WRITE' }] }],
    budget: { maxActiveMs: 2_000, deadlineAtMonoMs: 5_000, maxMechanicalSteps: 20, resources: { items: 10 }, risk: { damage: 10 } },
    progressDefinition: progress, controllerDefinition: controller, verificationDefinition: verifier, terminalPolicy: terminal,
  })
}

function rng(seed: number) {
  let x = seed >>> 0
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    return (x >>> 0) / 0x1_0000_0000
  }
}
function pick<T>(r: () => number, xs: readonly T[]): T { return xs[Math.floor(r() * xs.length)]! }

function assertMonotonic(before: KernelState, after: KernelState) {
  expect(after.factRevision).toBeGreaterThanOrEqual(before.factRevision)
  expect(after.registryRevision).toBeGreaterThanOrEqual(before.registryRevision)
  expect(after.missionRevision).toBeGreaterThanOrEqual(before.missionRevision)
  expect(after.schedulerEpoch).toBeGreaterThanOrEqual(before.schedulerEpoch)
  expect(after.journalSequence).toBeGreaterThanOrEqual(before.journalSequence)
}
function assertUsageWithinContract(state: KernelState) {
  for (const t of Object.values(state.transitions)) {
    const c = state.contracts[t.contractHash]
    if (c === undefined) throw new Error('missing contract')
    for (const permit of c.effects) expect(state.effectUsage[`${t.transitionId}|${permit.key}`] ?? 0).toBeLessThanOrEqual(permit.maxCount)
  }
}

type LooseCommand = Record<string, unknown> & { readonly kind: string }
function authorize(state: KernelState, command: LooseCommand): KernelCommand {
  if ('capability' in command) return command as unknown as KernelCommand
  switch (command.kind) {
    case 'REGISTER_TRANSITION': return { ...command, compiler, capability: trustedContractCompiler(compiler.id) } as unknown as KernelCommand
    case 'ADMIT_TRANSITION': case 'ACQUIRE_DECLARED_RESOURCES': case 'PAUSE_ACTIVE': case 'RESUME_TRANSITION': case 'AGE_RUNNABLE': case 'START_PREEMPTION': case 'COMMIT_PREEMPTION': case 'REQUEST_CANCEL':
      return { ...command, capability: trustedScheduler() } as unknown as KernelCommand
    case 'ACK_PREEMPTION_YIELD': {
      const id = String(command.victimId); return { ...command, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) } as unknown as KernelCommand
    }
    case 'ISSUE_EFFECT': case 'APPEND_RECORD': case 'ACK_CANCEL_YIELD': {
      const id = String(command.transitionId); return { ...command, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) } as unknown as KernelCommand
    }
    case 'DEBIT_USAGE': {
      const id = String(command.actorTransitionId); return { ...command, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) } as unknown as KernelCommand
    }
    case 'BEGIN_EFFECT_DISPATCH': return { ...command, capability: trustedDispatcher() } as unknown as KernelCommand
    case 'REPORT_PROGRESS': return { ...command, evaluator: progress, capability: trustedProgressEvaluator(progress.id) } as unknown as KernelCommand
    case 'VERIFY_SUCCESS': return { ...command, verifier, capability: trustedVerifier(verifier.id) } as unknown as KernelCommand
    default: return command as unknown as KernelCommand
  }
}

const exercised = new Set<string>()

/**
 * A command whose preconditions the current state can actually satisfy. Pure
 * uniform sampling almost never reaches preemption, dispatch/reconcile or the
 * safe-yield acknowledgements; guided picks keep those edges under test.
 */
function guidedCommand(state: KernelState, r: () => number): LooseCommand | null {
  const transitions = Object.values(state.transitions)
  const options: LooseCommand[] = []
  for (const t of transitions) {
    if (t.lifecycle === 'RUNNABLE') {
      options.push({ kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: t.transitionId })
      options.push({ kind: 'START_PREEMPTION', requesterId: t.transitionId })
    }
    if (t.lifecycle === 'ACTIVE') {
      const c = state.contracts[t.contractHash]; const p = c?.effects[0]
      if (p !== undefined) options.push({ kind: 'ISSUE_EFFECT', transitionId: t.transitionId, effect: p.kind, scope: p.scope, ttlMs: 20 })
      options.push({ kind: 'VERIFY_SUCCESS', transitionId: t.transitionId, causalCredit: 'external' })
      options.push({ kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, facts: [{ predicateId: state.contracts[t.contractHash]!.desiredPredicate, truth: 'true' as const, valueHash: `guided:${state.journalSequence}` }], materialChange: false, observedAtMonoMs: state.monotonicMs, capability: trustedVerifier(verifier.id) })
      options.push({ kind: 'REQUEST_CANCEL', transitionId: t.transitionId, reason: 'guided' })
    }
    if (t.cancelRequested) options.push({ kind: 'ACK_CANCEL_YIELD', transitionId: t.transitionId, atMonoMs: state.monotonicMs })
    if (t.pendingTerminalOutcome !== null) options.push({ kind: 'ACK_TERMINAL_YIELD', transitionId: t.transitionId, atMonoMs: state.monotonicMs, capability: trustedController(t.transitionId, state.transitionContracts[t.transitionId] ?? '', state.generationId) })
    if (t.lifecycle === 'SUSPENDED' || t.lifecycle === 'OBSERVING' || t.lifecycle === 'BLOCKED') options.push({ kind: 'RESUME_TRANSITION', transitionId: t.transitionId })
  }
  for (const tx of Object.values(state.preemptions)) {
    if (tx.status === 'PLANNED') for (const v of tx.victims) if (!v.safeYieldAcknowledged) options.push({ kind: 'ACK_PREEMPTION_YIELD', transactionId: tx.transactionId, victimId: v.transitionId, safeYield: true, atMonoMs: state.monotonicMs })
    if (tx.status === 'READY') options.push({ kind: 'COMMIT_PREEMPTION', transactionId: tx.transactionId })
  }
  for (const token of Object.values(state.effects)) {
    if (token.status === 'ISSUED') options.push({ kind: 'BEGIN_EFFECT_DISPATCH', commitId: token.commitId })
    if (token.status === 'DISPATCHING' || token.status === 'UNKNOWN') options.push({ kind: 'RECONCILE_EFFECT', commitId: token.commitId, observation: pick(r, ['OCCURRED', 'NOT_OCCURRED', 'UNKNOWN'] as const), factIds: [], verifier, capability: trustedVerifier(verifier.id) })
  }
  if (transitions.some((t) => t.cancelRequested || t.pendingTerminalOutcome !== null) && r() < 0.25) {
    options.push({ kind: 'CHANGE_GENERATION', generationId: `gen:guided:${state.journalSequence}`, capability: trustedWorldAdapter('runtime') })
  }
  // Rare, short-lived edges (a READY plan, a pending safe yield) are taken with
  // priority so they are exercised before the state moves past them.
  const urgent = options.filter((o) => o.kind === 'COMMIT_PREEMPTION' || o.kind === 'ACK_TERMINAL_YIELD' || o.kind === 'ACK_CANCEL_YIELD' || o.kind === 'ACK_PREEMPTION_YIELD')
  if (urgent.length > 0 && r() < 0.5) return pick(r, urgent)
  return options.length === 0 ? null : pick(r, options)
}

describe('V4.1.2 seeded randomized kernel invariants', () => {
  for (const seed of [1, 7, 19, 42, 99, 31337, 0x5eed, 3, 5, 11, 13, 17, 23, 29, 101, 202, 404, 808, 1618, 2718]) {
    test(`seed ${seed}: random authority sequence remains coherent and replayable`, () => {
      const r = rng(seed)
      const a = mk('mission:move', 'MISSION', locomotion, 'EXCLUSIVE_WRITE', 'MOVE')
      const v = mk('viability:move', 'VIABILITY', locomotion, 'EXCLUSIVE_WRITE', 'MOVE')
      const look = mk('background:look', 'BACKGROUND', orientation, 'EXCLUSIVE_WRITE', 'LOOK')
      const dig = mk('mission:dig', 'MISSION', blocks, 'EXCLUSIVE_WRITE', 'DIG')
      const append = mk('background:append', 'BACKGROUND', memory, 'APPEND')
      const critical = mk('mission:critical', 'MISSION', blocks, 'EXCLUSIVE_WRITE', 'DIG', true)
      const criticalMove = mk('mission:critical-move', 'MISSION', locomotion, 'EXCLUSIVE_WRITE', 'MOVE', true)
      const contracts = [a, v, look, dig, append, critical, criticalMove]
      const initial = createKernelState({ world: baseWorld, generationId: 'gen:0', missionPredicates: contracts.map((c) => c.desiredPredicate), verifierRegistry: [verifier], progressRegistry: [progress], contractCompilerRegistry: [compiler], missionAuthority, appendResources: [memory], minResidencyMs: 10, preemptibleYieldBudgetMs: 5 })
      let state = initial
      const events: KernelEvent[] = []
      for (const c of contracts) {
        for (const command of [{ kind: 'REGISTER_TRANSITION', contract: c }, { kind: 'ADMIT_TRANSITION', transitionId: c.transitionId }] as const) {
          const result = applyKernelCommand(state, authorize(state, command as unknown as LooseCommand))
          expect(result.ok).toBe(true)
          if (!result.ok) continue
          events.push(...result.events); assertMonotonic(state, result.state); state = result.state; assertKernelInvariants(state)
        }
      }

      let generation = 0
      for (let step = 0; step < 250; step += 1) {
        const ids = Object.keys(state.transitions)
        const id = pick(r, ids)
        const op = Math.floor(r() * 20)
        let command: LooseCommand
        const guided = r() < 0.55 ? guidedCommand(state, r) : null
        if (guided !== null) command = guided
        else if (op === 0) command = { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: id }
        else if (op === 1) command = { kind: 'PAUSE_ACTIVE', transitionId: id, to: r() < 0.5 ? 'OBSERVING' : 'BLOCKED', reason: 'random' }
        else if (op === 2) command = { kind: 'RESUME_TRANSITION', transitionId: id }
        else if (op === 3) command = { kind: 'AGE_RUNNABLE', transitionId: id }
        else if (op === 4) command = { kind: 'START_PREEMPTION', requesterId: id }
        else if (op === 5) {
          const tx = pick(r, Object.keys(state.preemptions).length ? Object.keys(state.preemptions) : ['missing'])
          const victims = state.preemptions[tx]?.victims.map((x) => x.transitionId) ?? [id]
          command = { kind: 'ACK_PREEMPTION_YIELD', transactionId: tx, victimId: pick(r, victims), safeYield: true, atMonoMs: state.monotonicMs }
        } else if (op === 6) command = { kind: 'COMMIT_PREEMPTION', transactionId: pick(r, Object.keys(state.preemptions).length ? Object.keys(state.preemptions) : ['missing']) }
        else if (op === 7) {
          const c = state.contracts[state.transitionContracts[id] ?? '']; const p = c?.effects[0]
          command = p === undefined ? { kind: 'AGE_RUNNABLE', transitionId: id } : { kind: 'ISSUE_EFFECT', transitionId: id, effect: p.kind, scope: p.scope, ttlMs: 20 }
        } else if (op === 8) command = { kind: 'BEGIN_EFFECT_DISPATCH', commitId: pick(r, Object.keys(state.effects).length ? Object.keys(state.effects) : ['missing']) }
        else if (op === 9) command = { kind: 'RECONCILE_EFFECT', commitId: pick(r, Object.keys(state.effects).length ? Object.keys(state.effects) : ['missing']), observation: pick(r, ['OCCURRED', 'NOT_OCCURRED', 'UNKNOWN'] as const), factIds: [], verifier, capability: trustedVerifier(verifier.id) }
        else if (op === 10) command = { kind: 'DEBIT_USAGE', actorTransitionId: id, targetTransitionId: id, mechanicalSteps: 1 }
        else if (op === 11) command = { kind: 'ACCEPT_VERIFIED_SNAPSHOT', verifier, facts: contracts.map((c) => ({ predicateId: c.desiredPredicate, truth: 'true' as const, valueHash: `v:${step}:${c.transitionId}` })), materialChange: r() < 0.2, observedAtMonoMs: state.monotonicMs, capability: trustedVerifier(verifier.id) }
        else if (op === 12) command = { kind: 'VERIFY_SUCCESS', transitionId: id, causalCredit: 'external' }
        else if (op === 13) command = { kind: 'REQUEST_CANCEL', transitionId: id, reason: 'random' }
        else if (op === 14) command = { kind: 'APPEND_RECORD', transitionId: append.transitionId, resource: memory, operationId: `op:${Math.floor(r() * 20)}`, payloadHash: `payload:${Math.floor(r() * 8)}` }
        else if (op === 15) {
          if (r() < 0.7) command = { kind: 'ADVANCE_TIME', toMonoMs: state.monotonicMs + Math.floor(r() * 5), capability: trustedWorldAdapter('clock') }
          else { generation += 1; command = { kind: 'CHANGE_GENERATION', generationId: `gen:${generation}`, capability: trustedWorldAdapter('runtime') } }
        } else if (op === 16) {
          const livePredicates = contracts.filter((_, index) => index !== Math.floor(r() * contracts.length)).map((c) => c.desiredPredicate)
          command = { kind: 'UPDATE_MISSION', predicates: livePredicates, authority: missionAuthority, capability: trustedMissionAuthority(missionAuthority.id) }
        } else if (op === 17) {
          command = { kind: 'ACK_CANCEL_YIELD', transitionId: id, atMonoMs: state.monotonicMs }
        } else if (op === 18) {
          command = { kind: 'ACK_TERMINAL_YIELD', transitionId: id, atMonoMs: state.monotonicMs, capability: trustedController(id, state.transitionContracts[id] ?? '', state.generationId) }
        } else {
          command = r() < 0.3
            ? { kind: 'CHANGE_WORLD', world: { ...baseWorld, worldEpoch: state.world.worldEpoch + 1 }, capability: trustedWorldAdapter('world') }
            : { kind: 'ADVANCE_TIME', toMonoMs: state.monotonicMs + 1, capability: trustedWorldAdapter('clock') }
        }

        const before = state
        const result = applyKernelCommand(state, authorize(state, command))
        if (result.ok) {
          exercised.add(command.kind)
          const quiescing = Object.values(before.transitions).some((t) => t.cancelRequested || t.pendingTerminalOutcome !== null)
          if (quiescing && (command.kind === 'CHANGE_GENERATION' || command.kind === 'CHANGE_WORLD')) exercised.add(`${command.kind}:while-quiescing`)
          events.push(...result.events); state = result.state; assertMonotonic(before, state)
        } else {
          expect(result.state).toBe(before)
        }
        assertKernelInvariants(state)
        assertUsageWithinContract(state)
        for (const c of contracts) {
          expect(Object.isFrozen(c)).toBe(true)
          expect(state.transitionContracts[c.transitionId]).toBe(c.contractHash)
        }
      }

      const roundTrip = JSON.parse(JSON.stringify(events)) as KernelEvent[]
      const replayed = replayKernelEvents(initial, roundTrip)
      assertKernelInvariants(replayed)
      expect(kernelSemanticDigest(replayed)).toBe(kernelSemanticDigest(state))
      expect(replayed.journalSequence).toBe(state.journalSequence)
    })
  }

  // Coverage report: a property run that never reaches a lifecycle edge
  // cannot guard it. These are the edges the closure audit's counterexamples
  // lived on; the seed set above must keep exercising all of them.
  test('the seeded runs exercised every lifecycle edge the invariants depend on', () => {
    const required = [
      'ACQUIRE_DECLARED_RESOURCES', 'START_PREEMPTION', 'ACK_PREEMPTION_YIELD', 'COMMIT_PREEMPTION',
      'ISSUE_EFFECT', 'BEGIN_EFFECT_DISPATCH', 'RECONCILE_EFFECT', 'VERIFY_SUCCESS', 'REQUEST_CANCEL',
      'ACK_CANCEL_YIELD', 'ACK_TERMINAL_YIELD', 'CHANGE_GENERATION', 'CHANGE_WORLD', 'UPDATE_MISSION',
      'CHANGE_GENERATION:while-quiescing',
    ]
    const missing = required.filter((kind) => !exercised.has(kind))
    expect(missing).toEqual([])
  })
})
