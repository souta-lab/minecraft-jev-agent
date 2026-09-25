import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { JevController } from './src/controller-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { ReachIdentity, ReachTerminalOutcome } from './src/vtr/reach.ts'
import { createVtrReachTestCells, installVtrReachTestRuntimePorts } from './test-vtr-reach-test-cells.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const identity: ReachIdentity = {
  worldKey: 'reach-step-terminal-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 4,
  generationId: 'reach-step-terminal-generation',
  leaseId: 'reach-step-terminal-lease',
}
const mission = { id: 'mission-reach-oak-log', item: 'oak_log', count: 1 }
const transitionId = 'transition-reach-step-terminal'
const contractHash = 'contract-reach-step-terminal'
const intentId = 'intent-reach-step-terminal'
const target = { x: 4.5, y: 64, z: 0.5 }

interface Fixture {
  readonly executor: Executor
  readonly claim: ReturnType<Executor['claim']>
  readonly settled: Promise<Awaited<ReturnType<Executor['claim']>['completion']>>
  readonly trace: string[]
  readonly reservations: string[]
  readonly recordedSteps: string[]
  readonly goals: number[]
  readonly logs: string[]
  readonly scheduled: Array<{ trigger: string; detail: Record<string, unknown> }>
  readonly pathStops: () => number
}

function makeFixture(terminalOutcome: ReachTerminalOutcome, arrived: boolean): Fixture {
  const events = new EventEmitter()
  const position = new Vec3(0.5, 64, 0.5)
  const trace: string[] = []
  const reservations: string[] = []
  const recordedSteps: string[] = []
  const goals: number[] = []
  const logs: string[] = []
  const scheduled: Array<{ trigger: string; detail: Record<string, unknown> }> = []
  let pathStops = 0
  const bot = {
    registry,
    game: { dimension: identity.dimension },
    health: 20,
    food: 20,
    heldItem: null,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      velocity: new Vec3(0, 0, 0),
    },
    inventory: { items: () => [], count: () => 0 },
    pathfinder: {
      movements: null as unknown,
      setMovements(movements: unknown) { this.movements = movements },
      setGoal(goal: unknown | null) {
        if (goal === null) return
        goals.push(goals.length + 1)
        trace.push('dispatch')
        position.set(arrived ? target.x : 2.5, target.y, target.z)
        queueMicrotask(() => {
          trace.push(arrived ? 'arrive' : 'leg-settled')
          events.emit('goal_reached')
        })
      },
      stop() { pathStops += 1 },
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    blockAt: () => null,
    stopDigging: () => undefined,
    clearControlStates: () => undefined,
    canDigBlock: () => true,
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as Bot

  const active = {
    contract: {
      transitionId,
      contractHash,
      identity,
      budget: { maxMechanicalSteps: 8 },
    },
    state: {
      contractHash,
      identity,
      status: 'active',
      usage: { mechanicalSteps: 1, elapsedMs: 1, resources: {}, risk: {}, effects: { locomotion: 1 } },
    },
    intent: { intentId, transitionId, contractHash },
    mission,
  }
  const terminalState = {
    contractHash,
    identity,
    status: 'terminal',
    usage: {
      mechanicalSteps: 1,
      elapsedMs: 10,
      resources: {},
      risk: {},
      effects: { locomotion: 1 },
    },
    progress: {
      latestPredicateDistance: terminalOutcome.kind === 'SUCCESS' ? 0 : 2,
      bestPredicateDistance: 0,
      reachability: 'reachable',
      frontierId: 'MOVE:oak-log-source',
      evidenceId: 'step-terminal-progress',
      observationSequence: 2,
    },
    witness: { witnessId: 'oak_log@5,64,0' },
    terminalOutcome,
  }
  let current: typeof active | null = active
  let terminalHandoff: { contractHash: string; outcome: ReachTerminalOutcome; state: typeof terminalState } | null = null
  const reachRuntime = {
    get current() { return current },
    authorizeMechanicalStep: (_id: string, _observed: ReachIdentity, step: { stepId: string }) => {
      reservations.push(step.stepId)
      trace.push('reserved')
      return { status: 'authorized', state: active.state }
    },
    recordMechanicalStepOutcome: (_id: string, stepId: string) => {
      recordedSteps.push(stepId)
      trace.push('verified-outcome')
      current = null
      terminalHandoff = { contractHash, outcome: terminalOutcome, state: terminalState }
      return {
        status: 'terminal',
        outcome: terminalOutcome,
        state: terminalState,
        // Production ReachController closes the in-flight intent even when its
        // post-step predicate verifies. The selected Skill must settle that
        // verified boundary without revoking its own actuation lease.
        cancelIntentId: intentId,
      }
    },
    takeTerminalHandoff: () => {
      const handoff = terminalHandoff
      terminalHandoff = null
      return handoff
    },
  }

  const candidate: Candidate = {
    id: 'MOVE:oak-log-source',
    kind: 'MOVE',
    label: 'walk to the grounded oak log approach cell',
    targetName: null,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { vertical: 'none' },
  }
  const executor = new Executor(bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 1_000,
  })
  const controller = Object.create(JevController.prototype) as JevController
  const recordReachMechanicalOutcome = (JevController.prototype as unknown as {
    recordReachMechanicalOutcome(
      this: JevController,
      callbackIntentId: string,
      fallbackIdentity: ReachIdentity,
      step: { stepId: string; leg: number; effectKind: 'locomotion' },
    ): boolean | 'verified-terminal'
  }).recordReachMechanicalOutcome
  const authorizeReachMechanicalStep = (JevController.prototype as unknown as {
    authorizeReachMechanicalStep(
      this: JevController,
      callbackIntentId: string,
      fallbackIdentity: ReachIdentity,
      step: { stepId: string; leg: number; effectKind: 'locomotion' },
    ): boolean
  }).authorizeReachMechanicalStep
  Object.assign(controller as unknown as Record<string, any>, {
    reachVtrCells: createVtrReachTestCells({ tickCounter: 1 }),
    // `closeReachTransition` journals host lineage on every terminal result.
    // Keep the Object.create adapter's options shape production-compatible while
    // making this standalone fixture explicitly unbound to a live run.
    options: {
      actuationPort: { assertLease: () => undefined },
      decisionProvenance: { runId: null, generationId: null, sourceSha: null },
    },
    reachRuntime,
    reachRunMetadata: {
      mission,
      transitionId,
      contractHash,
      identity,
      ensures: [],
      jevCallsAtStart: 0,
      system2CallsAtStart: 0,
      authorityConflictsAtStart: 0,
      nonVtrActuationsAtStart: 0,
      duplicateAuthorityObserved: false,
      lastHealth: 20,
    },
    pendingReachTerminalAction: null,
    tickCounter: 1,
    jevCalls: 0,
    runtimeLlmCalls: 0,
    planCalls: 0,
    running: true,
    modelRecoveryStopping: false,
    modelRecoveryReachDrainTransitionId: null,
    ticking: false,
    deferredTrigger: null,
    executor,
    buildReachWorldState: () => ({ self: { health: 20 }, timestampMs: 100 }),
    reachIdentity: () => identity,
    liveReachIdentity: () => identity,
    projectReachMission: () => ({
      snapshot: { observation: { identity, observedAtMs: 100, predicates: {} }, routes: [], progress: {} },
      candidates: [], sourceCandidates: [], inadmissibleCandidates: [], missionSourceNames: [], hasObservedMissionSource: false,
    }),
    logReachVerification: () => undefined,
    logger: {
      info: (_category: string, message: string) => logs.push(message),
      warn: (_category: string, message: string) => logs.push(message),
      error: (_category: string, message: string) => logs.push(message),
    },
    scheduleTick: (event: { trigger: string; detail: Record<string, unknown> }) => scheduled.push(event),
    requestDecision: (JevController.prototype as unknown as {
      requestDecision(this: JevController, trigger: string, detail: Record<string, unknown>): void
    }).requestDecision,
    // Bind the actual close/completion path so the regression covers both the
    // VTR terminal handoff and the executor's later lease settlement callback.
    closeReachTransition: (JevController.prototype as unknown as {
      closeReachTransition(
        this: JevController,
        outcome: ReachTerminalOutcome,
        state: typeof terminalState,
        boundary: string,
        cancelIntentId?: string | null,
        action?: { intentId: string; actionId: string },
      ): void
    }).closeReachTransition,
    onReachActionComplete: (JevController.prototype as unknown as {
      onReachActionComplete(
        this: JevController,
        result: Awaited<ReturnType<Executor['claim']>['completion']>,
        candidate: Candidate,
        callbackTransitionId: string,
        callbackIntentId: string,
      ): Promise<void>
    }).onReachActionComplete,
  })
  installVtrReachTestRuntimePorts(controller)
  const claim = executor.claim(candidate, {
    authority: 'vtr-reach',
    transitionId,
    transitionContractHash: contractHash,
    beforeMechanicalStep: (step) => authorizeReachMechanicalStep.call(controller, intentId, identity, step),
    afterMechanicalStep: (step) => recordReachMechanicalOutcome.call(controller, intentId, identity, step),
  })
  const settled = claim.completion.then(async (result) => {
    await (controller as unknown as {
      onReachActionComplete(
        execution: typeof result,
        completedCandidate: Candidate,
        completedTransitionId: string,
        completedIntentId: string,
      ): Promise<void>
    }).onReachActionComplete(result, candidate, transitionId, intentId)
    return result
  })

  return { executor, claim, settled, trace, reservations, recordedSteps, goals, logs, scheduled, pathStops: () => pathStops }
}

test('verified SUCCESS after the reserved walk leg lets the arrived skill settle done', async () => {
  const outcome: ReachTerminalOutcome = {
    kind: 'SUCCESS',
    contractHash,
    desiredPredicateIdentity: 'reach-resource-source',
    verifiedAtMs: 100,
    evidenceIds: ['verify:reach-resource-source'],
  }
  const fixture = makeFixture(outcome, true)
  const result = await fixture.settled

  expect(fixture.reservations).toHaveLength(1)
  expect(fixture.recordedSteps).toEqual(fixture.reservations)
  expect(fixture.trace.indexOf('reserved')).toBeLessThan(fixture.trace.indexOf('dispatch'))
  expect(fixture.trace.indexOf('arrive')).toBeLessThan(fixture.trace.indexOf('verified-outcome'))
  expect(fixture.goals).toHaveLength(1)
  expect(fixture.pathStops()).toBe(0)
  expect(result.status).toBe('done')
  expect(result.verified).toBe(true)
  expect(fixture.logs.some((line) => line.includes('VTR_TERMINAL_ACTION_CORRELATED') && line.includes('outcome=SUCCESS') && line.includes('status=done verified=true'))).toBe(true)
  expect(fixture.logs.some((line) => line.includes('VTR_MECHANICAL_STEP_OUTCOME') && line.includes(`step=${fixture.recordedSteps[0]}`) && /action=(?!missing\b)[^ ]+/.test(line) && line.includes('status=terminal outcome=SUCCESS verified=true'))).toBe(true)
  expect(fixture.logs.some((line) => line.includes('VTR_ORPHAN_ACTION_OUTCOME'))).toBe(false)
  expect(fixture.scheduled).toHaveLength(1)
  expect(fixture.scheduled[0]?.detail.schedulerHandoff).toBe(true)
})

test('typed non-success terminal after a reserved walk leg still stops the skill', async () => {
  const outcome: ReachTerminalOutcome = {
    kind: 'BUDGET_EXHAUSTED',
    contractHash,
    budget: 'mechanicalSteps',
    limit: 1,
    attempted: 2,
  }
  const fixture = makeFixture(outcome, false)
  const result = await fixture.settled

  expect(fixture.reservations).toHaveLength(1)
  expect(fixture.recordedSteps).toEqual(fixture.reservations)
  expect(fixture.goals).toHaveLength(1)
  expect(fixture.pathStops()).toBeGreaterThan(0)
  expect(result.status).toBe('cancelled')
  expect(result.failure).toBe('cancelled')
  expect(fixture.logs.some((line) => line.includes('VTR_TERMINAL_ACTION_CORRELATED') && line.includes('outcome=BUDGET_EXHAUSTED') && line.includes('status=cancelled'))).toBe(true)
  expect(fixture.logs.some((line) => line.includes('VTR_MECHANICAL_STEP_OUTCOME') && line.includes(`step=${fixture.recordedSteps[0]}`) && /action=(?!missing\b)[^ ]+/.test(line) && line.includes('status=terminal outcome=BUDGET_EXHAUSTED verified=false'))).toBe(true)
  expect(fixture.logs.some((line) => line.includes('VTR_ORPHAN_ACTION_OUTCOME'))).toBe(false)
  expect(fixture.scheduled).toHaveLength(1)
  expect(fixture.scheduled[0]?.detail.schedulerHandoff).toBe(true)
})
