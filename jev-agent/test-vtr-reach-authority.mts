import { expect, test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import type { CurrentAction } from './src/executor.ts'
import {
  createReachTransitionContract,
  startReachTransition,
  type ReachIdentity,
  type ReachObservation,
  type ReachTransitionContract,
} from './src/vtr/reach.ts'
import type { WorldState } from './src/state.ts'

const identity: ReachIdentity = {
  worldKey: 'authority-test-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
  generationId: 'authority-test-generation',
  leaseId: 'authority-test-lease',
}

const mission = { id: 'mission-reach-log', kind: 'inventory_at_least' as const, item: 'oak_log', count: 1 }
const desiredPredicate = {
  id: 'reach.resource-source',
  proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log' },
  expected: true,
}

function makeContract(): ReachTransitionContract {
  return createReachTransitionContract({
    transitionId: 'transition-reach-progress-terminal',
    desiredPredicate,
    requires: [{ id: 'mission.unsatisfied', proposition: { kind: 'inventory-below', item: 'oak_log' }, expected: true }],
    ensures: [desiredPredicate],
    invariants: [{ id: 'body.alive', proposition: { kind: 'health-above-zero' }, expected: true }],
    admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
    budget: { maxMechanicalSteps: 8, maxElapsedMs: 30_000, resources: {}, risk: { damage: 2 } },
    controller: {
      allowedTactics: ['walk', 'path_replan'],
      allowTemporaryWaypointChanges: true,
      allowWitnessSubstitution: true,
    },
    identity,
  })
}

test('a typed Reach progress terminal cancels an already-running VTR body action before closing authority', async () => {
  const contract = makeContract()
  const nowMs = Date.now()
  const startObservation: ReachObservation = {
    identity,
    observedAtMs: nowMs,
    predicates: {
      'mission.unsatisfied': { truth: 'true', evidenceId: 'mission:oak_log:0/1' },
      'body.alive': { truth: 'true', evidenceId: 'body:health:20' },
      'reach.resource-source': { truth: 'false', evidenceId: 'reach:outside-interaction-range' },
    },
  }
  const started = startReachTransition(contract, startObservation, { tactic: 'walk' })
  expect(started.status).toBe('active')
  if (started.status !== 'active') return

  // Finite world coordinates can still overflow the Euclidean-distance calculation.
  // That makes recordReachProgress return typed invalid_evidence while the ensure
  // verifier remains pending, exercising the production progress-terminal branch.
  const world = {
    tick: 7,
    timestampMs: nowMs + 1,
    self: {
      dimension: identity.dimension,
      position: { x: -Number.MAX_VALUE, y: 64, z: 0 },
      health: 20,
      food: 20,
      air: 20,
      feetInWater: false,
      eyesInWater: false,
      envHazard: { active: false },
    },
    signals: { threat: { active: false } },
    blocks: [{
      name: 'oak_log',
      yield: 'oak_log',
      inReach: false,
      visible: true,
      position: { x: Number.MAX_VALUE, y: 64, z: 0 },
    }],
    inventory: { counts: { oak_log: 0 } },
  } as unknown as WorldState

  const observation: ReachObservation = {
    ...startObservation,
    observedAtMs: nowMs + 1,
    predicates: {
      ...startObservation.predicates,
      'reach.resource-source': { truth: 'false', evidenceId: 'reach:still-outside-interaction-range' },
    },
  }

  let currentAction: CurrentAction | null = {
    id: 'MOVE:oak-log-source',
    kind: 'MOVE',
    epoch: 3,
    startedAt: nowMs,
    phase: 'moving',
    status: 'running',
    detail: '',
    completion: new Promise(() => undefined),
    authority: 'vtr-reach',
    transitionId: contract.transitionId,
  }
  let cancellations = 0
  const decisions: Array<{ trigger: string; detail: Record<string, unknown> }> = []
  const events: string[] = []

  const controller = Object.create(JevController.prototype) as JevController
  Object.assign(controller as unknown as Record<string, any>, {
    options: { vtrMission: mission, reach: 4, actuationPort: null },
    queue: { current: null },
    reachTransition: {
      mission,
      contract,
      state: started.state,
      jevCallsAtStart: 0,
      system2CallsAtStart: 0,
      authorityConflictsAtStart: 0,
      duplicateAuthorityObserved: false,
      lastHealth: 20,
    },
    reachTerminalHandoff: null,
    lastReachActionFailure: null,
    tickCounter: 7,
    jevCalls: 0,
    runtimeLlmCalls: 0,
    planCalls: 0,
    executor: {
      get current() { return currentAction },
      authorityConflictCount: 0,
      cancelCurrent: () => {
        if (currentAction === null || currentAction.status !== 'running') return false
        cancellations += 1
        currentAction.status = 'cancelled'
        currentAction = null
        return true
      },
    },
    logger: {
      info: (_source: string, line: string) => events.push(line),
      warn: (_source: string, line: string) => events.push(line),
      error: (_source: string, line: string) => events.push(line),
    },
    requestDecision: (trigger: string, detail: Record<string, unknown>) => decisions.push({ trigger, detail }),
    buildReachWorldState: () => world,
    reachIdentity: () => identity,
    reachCandidates: () => ({ candidates: [] }),
    reachObservation: () => observation,
    isMissionSource: () => true,
  })

  const tickReachTransition = (JevController.prototype as unknown as {
    tickReachTransition(this: JevController, trigger: string, detail: Record<string, unknown>): Promise<boolean>
  }).tickReachTransition
  expect(await tickReachTransition.call(controller, 'heartbeat', {})).toBe(true)

  const controllerState = controller as unknown as Record<string, any>
  expect(controllerState.reachTransition).toBeNull()
  expect(events.some((line) => line.includes('outcome=CONTRACT_VIOLATION'))).toBe(true)
  expect(decisions).toHaveLength(1)
  expect(decisions[0]?.detail).toMatchObject({ typedOutcome: 'CONTRACT_VIOLATION', schedulerHandoff: true })

  // The terminal branch must revoke physical ownership before it tells the
  // scheduler the contract has closed. Current 55011cd closes the state but
  // leaves this already-running VTR action active.
  expect(cancellations).toBe(1)
  expect(currentAction).toBeNull()
})
