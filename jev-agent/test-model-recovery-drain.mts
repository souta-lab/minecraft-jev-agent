import { expect, test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import type { CurrentAction, ExecutionResult } from './src/executor.ts'
import type { SkillCommitment } from './src/skillCommitment.ts'
import type { Candidate } from './src/candidates.ts'
import {
  createReachTransitionContract,
  startReachTransition,
  verifyReachEnsures,
  type ReachIdentity,
  type ReachObservation,
  type ReachTerminalOutcome,
  type ReachTransitionContract,
  type ReachTransitionState,
} from './src/vtr/reach.ts'

interface Fixture {
  controller: JevController
  current: CurrentAction
  currentAction: () => CurrentAction | null
  resolveAction: (result: ExecutionResult) => void
  cancelAttempts: () => number
  events: string[]
}

function makeFixture(startedAt = Date.now()): Fixture {
  let resolveAction: (result: ExecutionResult) => void = () => undefined
  const completion = new Promise<ExecutionResult>((resolve) => {
    resolveAction = resolve
  })
  const id = 'RETREAT:p108_63_92'
  const commitment = {
    commitmentId: 'retreat-commitment-1',
    candidateId: id,
    skillKind: 'retreat',
    budget: { ms: 15_000 },
  } as unknown as SkillCommitment
  const current: CurrentAction = {
    id,
    kind: 'RETREAT',
    epoch: 1,
    startedAt,
    phase: 'retreating',
    status: 'running',
    detail: '',
    completion,
    commitment,
  }
  let active: CurrentAction | null = current
  let cancels = 0
  const events: string[] = []
  const controller = Object.create(JevController.prototype) as JevController
  const state = controller as unknown as Record<string, any>
  let resolveRun: (summary: never) => void = () => undefined
  const runCompletion = new Promise<never>((resolve) => {
    resolveRun = resolve
  })
  Object.assign(state, {
    running: true,
    modelRecoveryStopping: false,
    modelRecoveryDrainTimer: null,
    modelRecoveryReachDrainTransitionId: null,
    modelRecoveryReachDrainAdvancing: false,
    modelRecoveryReachDrainPending: false,
    reachTransition: null,
    tickCounter: 1,
    watchdog: null,
    completion: runCompletion,
    resolveCompletion: resolveRun,
    pendingDecisions: new Map(),
    decisionWriter: { write: () => undefined },
    saveLedger: () => undefined,
    clearDecisionTimer: () => undefined,
    runSuccess: () => false,
    summary: (stopped: string, success: boolean) => ({ stopped, success }),
    scheduler: { stop: () => undefined },
    bot: { removeListener: () => undefined },
    logger: {
      warn: (_source: string, line: string) => events.push(line),
      error: (_source: string, line: string) => events.push(line),
      info: (_source: string, line: string) => events.push(line),
    },
    executor: {
      get current() { return active },
      cancelCurrent: () => {
        if (active?.status !== 'running') return false
        cancels += 1
        active.status = 'cancelled'
        active = null
        return true
      },
    },
  })

  return {
    controller,
    current,
    currentAction: () => active,
    resolveAction,
    cancelAttempts: () => cancels,
    events,
  }
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('watchdog finish is deferred until a model-recovery RETREAT reaches its terminal boundary', async () => {
  const fixture = makeFixture()
  fixture.controller.stopForModelRecovery()
  const finish = (JevController.prototype as unknown as {
    finish(this: JevController, stopped: string, success: boolean): void
  }).finish

  finish.call(fixture.controller, 'max-runtime', false)
  expect(fixture.currentAction()?.status).toBe('running')
  expect(fixture.cancelAttempts()).toBe(0)
  expect(fixture.events.some((line) => line.includes('phase=finish_deferred') && line.includes('requestedReason=max-runtime'))).toBe(true)

  fixture.current.status = 'done'
  expect(fixture.currentAction()).toBe(fixture.current)
  fixture.resolveAction({ status: 'done', failure: null } as ExecutionResult)
  const result = await fixture.controller.wait()
  expect(result.stopped).toBe('stopped-by-caller')
  expect(fixture.cancelAttempts()).toBe(0)
  expect(fixture.events.some((line) => line.includes('phase=terminal') && line.includes('RETREAT:p108_63_92'))).toBe(true)
})

test('HOST quiesce waits through recovery drain, while ordinary quiesce outside recovery still cancels immediately', async () => {
  const draining = makeFixture()
  draining.controller.stopForModelRecovery()
  let quiesced = false
  const quiesce = draining.controller.quiesce().then(() => { quiesced = true })

  await settle()
  expect(quiesced).toBe(false)
  expect(draining.currentAction()?.status).toBe('running')
  expect(draining.cancelAttempts()).toBe(0)

  draining.current.status = 'done'
  draining.resolveAction({ status: 'done', failure: null } as ExecutionResult)
  await quiesce
  expect(quiesced).toBe(true)
  expect(draining.cancelAttempts()).toBe(0)

  const ordinary = makeFixture()
  await ordinary.controller.quiesce()
  expect(ordinary.currentAction()).toBe(null)
  expect(ordinary.current.status).toBe('cancelled')
  expect(ordinary.cancelAttempts()).toBe(1)
})

test('an over-budget recovery drain has an explicit cancellation terminal boundary', async () => {
  const fixture = makeFixture(Date.now() - 60_000)
  fixture.controller.stopForModelRecovery()
  const result = await fixture.controller.wait()
  expect(result.stopped).toBe('stopped-by-caller')
  expect(fixture.currentAction()).toBe(null)
  expect(fixture.cancelAttempts()).toBe(1)
  expect(fixture.events.some((line) => line.includes('phase=deadline') && line.includes('over-budget Skill'))).toBe(true)
})

function makeReachContract(at: number): { contract: ReachTransitionContract; state: ReachTransitionState; identity: ReachIdentity } {
  const identity: ReachIdentity = {
    worldKey: 'server|minecraft:overworld|epoch:8',
    dimension: 'minecraft:overworld',
    worldEpoch: 8,
    generationId: 'generation-vtr-recovery',
    leaseId: 'lease-vtr-recovery',
  }
  const desired = {
    id: 'reach.resource-source',
    proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'log', interactionReach: 4.5 },
    expected: true,
  } as const
  const contract = createReachTransitionContract({
    transitionId: 'transition-model-recovery-reach-1',
    desiredPredicate: desired,
    requires: [{ id: 'mission.unsatisfied', proposition: { kind: 'inventory-below', item: 'log', count: 1 }, expected: true }],
    ensures: [desired],
    invariants: [{ id: 'body.alive', proposition: { kind: 'health-above-zero' }, expected: true }],
    admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
    budget: { maxMechanicalSteps: 8, maxElapsedMs: 30_000, resources: {}, risk: { damage: 1 } },
    controller: {
      allowedTactics: ['walk', 'path_replan', 'jump', 'detour'],
      allowTemporaryWaypointChanges: true,
      allowWitnessSubstitution: true,
    },
    identity,
  })
  const observation: ReachObservation = {
    identity,
    observedAtMs: at,
    predicates: {
      'mission.unsatisfied': { truth: 'true', evidenceId: `mission:${at}` },
      'body.alive': { truth: 'true', evidenceId: `alive:${at}` },
      'reach.resource-source': { truth: 'false', evidenceId: `not-reached:${at}` },
    },
  }
  const started = startReachTransition(contract, observation, { tactic: 'walk' })
  if (started.status !== 'active') throw new Error(`Reach fixture failed to start: ${JSON.stringify(started)}`)
  return { contract, state: started.state, identity }
}

function makeReachRecoveryFixture(): {
  controller: JevController
  transitionId: string
  actions: CurrentAction[]
  completeAction: (index: number) => void
  events: string[]
  metrics: { legacyActuations: number; cancellations: number; schedulerStops: number }
} {
  const startedAt = Date.now()
  const { contract, state, identity } = makeReachContract(startedAt)
  const transitionId = contract.transitionId
  const events: string[] = []
  const metrics = { legacyActuations: 0, cancellations: 0, schedulerStops: 0 }
  const actions: CurrentAction[] = []
  const resolvers: Array<(result: ExecutionResult) => void> = []
  let active: CurrentAction | null = null
  let resolveRun: (summary: never) => void = () => undefined
  const runCompletion = new Promise<never>((resolve) => { resolveRun = resolve })
  const controller = Object.create(JevController.prototype) as JevController
  const stateBag = controller as unknown as Record<string, any>
  Object.assign(stateBag, {
    running: true,
    modelRecoveryStopping: false,
    modelRecoveryDrainTimer: null,
    modelRecoveryReachDrainTransitionId: null,
    modelRecoveryReachDrainAdvancing: false,
    modelRecoveryReachDrainPending: false,
    ticking: false,
    tickCounter: 1,
    watchdog: null,
    completion: runCompletion,
    resolveCompletion: resolveRun,
    pendingDecisions: new Map(),
    decisionWriter: { write: () => undefined },
    saveLedger: () => undefined,
    clearDecisionTimer: () => undefined,
    runSuccess: () => false,
    summary: (stopped: string, success: boolean) => ({ stopped, success }),
    logger: {
      warn: (_source: string, line: string) => events.push(line),
      error: (_source: string, line: string) => events.push(line),
      info: (_source: string, line: string) => events.push(line),
    },
    bot: { removeListener: () => undefined },
    scheduler: { stop: () => { metrics.schedulerStops += 1 } },
    system2: { cancelPending: () => undefined },
    jevCalls: 0,
    runtimeLlmCalls: 0,
    planCalls: 0,
    lastReachActionFailure: null,
    reachTransition: {
      mission: { id: 'mission-log-1', kind: 'inventory_at_least', item: 'log', count: 1 },
      contract,
      state,
      jevCallsAtStart: 0,
      system2CallsAtStart: 0,
      authorityConflictsAtStart: 0,
      duplicateAuthorityObserved: false,
      lastHealth: 20,
    },
    executor: {
      get current() { return active },
      authorityConflictCount: 0,
      cancelCurrent: () => {
        if (active?.status !== 'running') return false
        metrics.cancellations += 1
        active.status = 'cancelled'
        active = null
        return true
      },
      claim: (candidate: Candidate, context: { authority?: string; transitionId?: string }) => {
        if (context.authority !== 'vtr-reach' || context.transitionId !== transitionId) {
          metrics.legacyActuations += 1
          throw new Error('model-recovery drain attempted a non-VTR action')
        }
        const index = actions.length + 1
        let resolveAction: (result: ExecutionResult) => void = () => undefined
        const completion = new Promise<ExecutionResult>((resolve) => { resolveAction = resolve })
        const action: CurrentAction = {
          id: candidate.id,
          kind: 'MOVE',
          epoch: index,
          startedAt: Date.now(),
          phase: 'moving',
          status: 'running',
          detail: '',
          completion,
          authority: 'vtr-reach',
          transitionId: context.transitionId,
        }
        actions.push(action)
        resolvers.push(resolveAction)
        active = action
        return { kept: false, epoch: index, completion }
      },
    },
  })

  // Stand in for grounded candidate selection only; terminal verification uses
  // the real deterministic VTR verifier and the committed contract object.
  Object.defineProperty(controller, 'tickReachTransition', {
    configurable: true,
    value: async function (this: JevController): Promise<boolean> {
      const runtime = (this as unknown as Record<string, any>).reachTransition
      if (runtime?.contract.transitionId !== transitionId) throw new Error('Reach recovery changed contract identity')
      const current = (this as unknown as Record<string, any>).executor.current as CurrentAction | null
      if (current !== null) return true
      const actionCount = actions.length
      if (actionCount < 3) {
        ;(JevController.prototype as unknown as { finish(this: JevController, stopped: string, success: boolean): void })
          .finish.call(this, 'max-runtime', false)
        if (!(this as unknown as Record<string, any>).running) throw new Error('HOST finish escaped the active Reach contract between legs')
        const candidate = {
          id: `MOVE:reach-recovery-leg-${actionCount + 1}`,
          kind: 'MOVE',
          label: 'continue the committed Reach predicate',
          targetName: 'log',
          target: { x: 12 + actionCount, y: 64, z: 8 },
          targetEntityId: null,
          itemName: null,
          requiresTool: false,
          toolName: null,
          inReach: false,
          hasStandableAdjacent: true,
          meta: {},
        } as Candidate
        const claim = (this as unknown as Record<string, any>).executor.claim(candidate, {
          authority: 'vtr-reach',
          transitionId,
        })
        void claim.completion.then((result: ExecutionResult) => {
          ;(this as unknown as { onReachActionComplete(result: ExecutionResult, candidate: Candidate, id: string): void })
            .onReachActionComplete(result, candidate, transitionId)
        })
        return true
      }
      const nowMs = Date.now()
      const evidence: ReachObservation = {
        identity,
        observedAtMs: nowMs,
        predicates: {
          'mission.unsatisfied': { truth: 'true', evidenceId: `mission:${nowMs}` },
          'body.alive': { truth: 'true', evidenceId: `alive:${nowMs}` },
          'reach.resource-source': { truth: 'true', evidenceId: `reach-verified:${transitionId}:${nowMs}` },
        },
      }
      const verified = verifyReachEnsures(contract, runtime.state, evidence)
      if (verified.status !== 'terminal') throw new Error(`deterministic Reach VERIFY did not terminate: ${verified.status}`)
      const outcome = verified.outcome as ReachTerminalOutcome
      ;(this as unknown as { closeReachTransition(outcome: ReachTerminalOutcome, state: ReachTransitionState, boundary: string): void })
        .closeReachTransition(outcome, verified.state, 'verified-terminal')
      return true
    },
  })

  const initial = (controller as unknown as { executor: { claim(candidate: Candidate, context: { authority: string; transitionId: string }): { completion: Promise<ExecutionResult> } } })
    .executor.claim({
      id: 'MOVE:reach-recovery-leg-0', kind: 'MOVE', label: 'in-flight Reach leg', targetName: 'log',
      target: { x: 12, y: 64, z: 8 }, targetEntityId: null, itemName: null, requiresTool: false,
      toolName: null, inReach: false, hasStandableAdjacent: true, meta: {},
    } as Candidate, { authority: 'vtr-reach', transitionId })
  void initial.completion.then((result) => {
    ;(controller as unknown as { onReachActionComplete(result: ExecutionResult, candidate: Candidate, id: string): void })
      .onReachActionComplete(result, { id: 'MOVE:reach-recovery-leg-0' } as Candidate, transitionId)
  })

  return {
    controller,
    transitionId,
    actions,
    completeAction: (index) => {
      const action = actions[index]
      if (action === undefined) throw new Error(`missing action ${index}`)
      action.status = 'done'
      if (active === action) active = null
      resolvers[index]!({
        actionId: action.id,
        kind: 'MOVE',
        targetName: 'log',
        epoch: action.epoch,
        status: 'done',
        phase: 'arrived-at-waypoint',
        detail: '',
        failure: null,
        verified: false,
        blockRemoved: false,
        dropObserved: false,
        itemsGained: 0,
        goalItemCount: 0,
        progressed: true,
        ms: 10,
      } as ExecutionResult)
    },
    events,
    metrics,
  }
}

test('model recovery keeps one committed Reach transition through multiple actions and deterministic VERIFY', async () => {
  const fixture = makeReachRecoveryFixture()
  fixture.controller.stopForModelRecovery()
  const finish = (JevController.prototype as unknown as {
    finish(this: JevController, stopped: string, success: boolean): void
  }).finish
  finish.call(fixture.controller, 'max-runtime', false)
  expect(fixture.actions).toHaveLength(1)
  expect(fixture.actions[0]?.authority).toBe('vtr-reach')
  expect(fixture.actions[0]?.transitionId).toBe(fixture.transitionId)
  expect(fixture.metrics.cancellations).toBe(0)

  fixture.completeAction(0)
  await settle()
  expect(fixture.actions).toHaveLength(2)
  expect(fixture.actions[1]?.transitionId).toBe(fixture.transitionId)
  expect(fixture.metrics.legacyActuations).toBe(0)
  expect((fixture.controller as unknown as { jevCalls: number }).jevCalls).toBe(0)
  expect((fixture.controller as unknown as { runtimeLlmCalls: number }).runtimeLlmCalls).toBe(0)
  expect((fixture.controller as unknown as { planCalls: number }).planCalls).toBe(0)

  fixture.completeAction(1)
  await settle()
  expect(fixture.actions).toHaveLength(3)
  expect(fixture.actions[2]?.transitionId).toBe(fixture.transitionId)

  fixture.completeAction(2)
  const summary = await fixture.controller.wait()
  expect(summary.stopped).toBe('stopped-by-caller')
  expect(fixture.metrics.cancellations).toBe(0)
  expect(fixture.metrics.legacyActuations).toBe(0)
  expect((fixture.controller as unknown as { jevCalls: number }).jevCalls).toBe(0)
  expect((fixture.controller as unknown as { runtimeLlmCalls: number }).runtimeLlmCalls).toBe(0)
  expect((fixture.controller as unknown as { planCalls: number }).planCalls).toBe(0)
  expect(fixture.actions.every((action) => action.authority === 'vtr-reach' && action.transitionId === fixture.transitionId)).toBe(true)
  expect(fixture.metrics.schedulerStops).toBeGreaterThanOrEqual(1)
  expect(fixture.events.some((line) => line.includes(`VTR_TRANSITION_OUTCOME id=${fixture.transitionId} outcome=SUCCESS`))).toBe(true)
  expect(fixture.events.some((line) => line.includes(`MODEL_RECOVERY_DRAIN phase=terminal transitionId=${fixture.transitionId} outcome=typed-terminal`))).toBe(true)
})
