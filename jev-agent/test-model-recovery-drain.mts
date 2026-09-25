import { expect, test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import type { CurrentAction, ExecutionResult } from './src/executor.ts'
import type { SkillCommitment } from './src/skillCommitment.ts'
import type { Candidate } from './src/candidates.ts'
import {
  nearestGroundedReachRoutePolicy,
  type ReachRoute,
  type ReachRuntimeSnapshot,
} from './src/vtr/reach-controller.ts'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import {
  createReachTransitionContract,
  type ReachIdentity,
  type ReachObservation,
  type ReachTerminalOutcome,
  type ReachTransitionContract,
  type ReachTransitionState,
} from './src/vtr/reach.ts'
import { createVtrReachTestCells } from './test-vtr-reach-test-cells.mts'

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
    reachVtrCells: createVtrReachTestCells({ tickCounter: 1 }),
    running: true,
    modelRecoveryStopping: false,
    modelRecoveryDrainTimer: null,
    modelRecoveryReachDrainTransitionId: null,
    modelRecoveryReachDrainAdvancing: false,
    modelRecoveryReachDrainPending: false,
    reachRuntime: { current: null },
    reachRunMetadata: null,
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

function makeReachContract(): { contract: ReachTransitionContract; identity: ReachIdentity } {
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
  return { contract, identity }
}

function makeReachRoute(contract: ReachTransitionContract, identity: ReachIdentity, at: number): ReachRoute {
  const evidenceId = `reach-route:${at}`
  return {
    routeId: 'MOVE:reach-recovery-route',
    groundingPredicateId: 'reach.route:recovery',
    waypointGroundingPredicateId: null,
    witness: {
      witnessId: 'log@12,64,8',
      target: { x: 12, y: 64, z: 8 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: identity,
      observedAtMs: at,
    },
    waypoint: null,
    tactic: 'walk',
    effectKind: 'locomotion',
    estimatedDistance: 12,
    resources: {},
    risk: {},
  }
}

function makeReachSnapshot(
  contract: ReachTransitionContract,
  identity: ReachIdentity,
  at: number,
  reached: boolean,
): ReachRuntimeSnapshot {
  const route = makeReachRoute(contract, identity, at)
  const observation: ReachObservation = {
    identity,
    observedAtMs: at,
    predicates: {
      'mission.unsatisfied': { truth: 'true', evidenceId: `mission:${at}` },
      'body.alive': { truth: 'true', evidenceId: `alive:${at}` },
      'reach.resource-source': { truth: reached ? 'true' : 'false', evidenceId: `reach:${at}` },
      [route.groundingPredicateId]: { truth: 'true', evidenceId: route.witness.evidenceId },
    },
  }
  return {
    observation,
    routes: [route],
    progress: {
      predicateDistance: reached ? 0 : route.estimatedDistance,
      reachability: 'reachable',
      frontierId: route.routeId,
      evidenceId: `reach-progress:${at}`,
    },
  }
}

async function makeReachRecoveryFixture(): Promise<{
  controller: JevController
  transitionId: string
  actions: CurrentAction[]
  completeAction: (index: number) => void
  events: string[]
  metrics: { legacyActuations: number; cancellations: number; schedulerStops: number }
}> {
  const startedAt = Date.now()
  const { contract, identity } = makeReachContract()
  const transitionId = contract.transitionId
  let observedAt = startedAt
  const reachRuntime = new ReachMissionRuntime({
    routePolicy: nearestGroundedReachRoutePolicy,
    commitFreshnessFence: () => ({ status: 'current' }),
  })
  const committed = await reachRuntime.commit(contract, makeReachSnapshot(contract, identity, observedAt, false))
  if (committed.status !== 'active' || committed.intent === undefined) {
    throw new Error(`Reach fixture failed to commit: ${JSON.stringify(committed)}`)
  }
  const events: string[] = []
  const metrics = { legacyActuations: 0, cancellations: 0, schedulerStops: 0 }
  const actions: CurrentAction[] = []
  const resolvers: Array<(result: ExecutionResult) => void> = []
  let active: CurrentAction | null = null
  const candidateFor = (intentIndex: number): Candidate => ({
    id: `MOVE:reach-recovery-leg-${intentIndex}`,
    kind: 'MOVE',
    label: 'continue the committed Reach predicate',
    targetName: 'log',
    target: { x: 12 + intentIndex, y: 64, z: 8 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {},
  } as Candidate)
  let resolveRun: (summary: never) => void = () => undefined
  const runCompletion = new Promise<never>((resolve) => { resolveRun = resolve })
  const controller = Object.create(JevController.prototype) as JevController
  const stateBag = controller as unknown as Record<string, any>
  Object.assign(stateBag, {
    reachVtrCells: createVtrReachTestCells({ tickCounter: 1 }),
    running: true,
    modelRecoveryStopping: false,
    modelRecoveryDrainTimer: null,
    modelRecoveryReachDrainTransitionId: null,
    modelRecoveryReachDrainAdvancing: false,
    modelRecoveryReachDrainPending: false,
    reachRuntime,
    reachRunMetadata: {
      mission: { id: 'mission-log-1', kind: 'inventory_at_least', item: 'log', count: 1 },
      transitionId,
      contractHash: contract.contractHash,
      ensures: contract.ensures,
      identity,
      jevCallsAtStart: 0,
      system2CallsAtStart: 0,
      authorityConflictsAtStart: 0,
      duplicateAuthorityObserved: false,
      lastHealth: 20,
    },
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
    buildReachWorldState: () => {
      observedAt = Math.max(Date.now(), observedAt + 1)
      return { timestampMs: observedAt, self: { health: 20 } }
    },
    reachIdentity: () => identity,
    reachCandidates: () => ({ candidates: [candidateFor(actions.length)], grounded: {} }),
    reachRuntimeSnapshot: (_runtime: unknown, world: { timestampMs: number }, _identity: ReachIdentity) =>
      makeReachSnapshot(contract, identity, world.timestampMs, false),
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

  // Stand in for grounded candidate selection only. Controller progression,
  // action completion and terminal verification use the production VTR runtime.
  Object.defineProperty(controller, 'tickReachTransition', {
    configurable: true,
    value: async function (this: JevController): Promise<boolean> {
      const runtime = (this as unknown as Record<string, any>).reachTransition
      if (runtime?.contract.transitionId !== transitionId) throw new Error('Reach recovery changed contract identity')
      const current = (this as unknown as Record<string, any>).executor.current as CurrentAction | null
      if (current !== null) return true
      const actionCount = actions.length
      observedAt = Math.max(Date.now(), observedAt + 1)
      const reached = actionCount >= 3
      const result = await reachRuntime.tick(makeReachSnapshot(contract, identity, observedAt, reached))
      if (result.status === 'terminal') {
        if (result.outcome.kind !== 'SUCCESS') throw new Error(`unexpected Reach terminal: ${JSON.stringify(result.outcome)}`)
        ;(this as unknown as { closeReachTransition(outcome: ReachTerminalOutcome, state: ReachTransitionState, boundary: string): void })
          .closeReachTransition(result.outcome, result.state, 'verified-terminal')
        return true
      }
      if (result.status !== 'active' || result.intent === undefined) throw new Error(`Reach controller did not issue next intent: ${JSON.stringify(result)}`)
      const candidate = candidateFor(actionCount + 1)
      const claim = (this as unknown as Record<string, any>).executor.claim(candidate, {
        authority: 'vtr-reach',
        transitionId,
      })
      void claim.completion.then((completion: ExecutionResult) => {
        void (this as unknown as { onReachActionComplete(result: ExecutionResult, candidate: Candidate, id: string, intentId: string): Promise<void> })
          .onReachActionComplete(completion, candidate, transitionId, result.intent!.intentId)
      })
      return true
    },
  })

  const claimInitial = (controller as unknown as Record<string, any>).executor.claim
  const initialCandidate = candidateFor(0)
  const initial = claimInitial(initialCandidate, { authority: 'vtr-reach', transitionId })
  void initial.completion.then((result: ExecutionResult) => {
    void (controller as unknown as { onReachActionComplete(result: ExecutionResult, candidate: Candidate, id: string, intentId: string): Promise<void> })
      .onReachActionComplete(result, initialCandidate, transitionId, committed.intent!.intentId)
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
  const fixture = await makeReachRecoveryFixture()
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
