import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { test } from 'bun:test'
import type { Candidate } from './src/candidates.ts'
import { ExecutionAuthorityConflict, Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import { JevController } from './src/controller-legacy.ts'
import type { WorldState } from './src/state.ts'
import { nearestGroundedReachRoutePolicy } from './src/vtr/reach-controller.ts'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import { projectMinecraftReachRoutes } from './src/runtime-adapters/minecraft-reach-mission-projection.ts'
import type { ReachIdentity, ReachTerminalOutcome, ReachTransitionState } from './src/vtr/reach.ts'
import { MineflayerReachRuntimeAdapter } from './src/runtime-adapters/minecraft-reach-runtime-adapter.ts'
import { StateFingerprintMemory } from './src/moveFailMemory.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

const mission = { id: 'executor-authority:oak_log:1', kind: 'inventory_at_least' as const, item: 'oak_log', count: 1 }
const identity: ReachIdentity = {
  worldKey: '127.0.0.1:25569|minecraft:overworld|31',
  dimension: 'minecraft:overworld',
  worldEpoch: 31,
  generationId: 'executor-authority-generation',
  leaseId: 'executor-authority-lease',
}
const sourcePosition = { x: 8, y: 64, z: 0 }
const standPosition = { x: 7, y: 64, z: 0 }

interface MovementBotFixture {
  readonly bot: Bot
  readonly goalStarts: () => number
  readonly goalClears: () => number
  readonly pathStops: () => number
}

function makeBot(): MovementBotFixture {
  const events = new EventEmitter()
  const position = new Vec3(0.5, 64, 0.5)
  let goalStarts = 0
  let goalClears = 0
  let pathStops = 0
  const pathfinder = {
    movements: null as { maxDropDown?: number } | null,
    setMovements(movements: { maxDropDown?: number }): void {
      this.movements = movements
    },
    setGoal(goal: unknown | null): void {
      if (goal === null) goalClears += 1
      else goalStarts += 1
      // Keep the real Executor MOVE open until explicit cancellation. That lets
      // the test attempt a second owner while the first still holds the body.
    },
    stop(): void { pathStops += 1 },
    getPathTo: (_movements: unknown, goal: { x: number; y: number; z: number }) => {
      const target = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) }
      const path: Array<{ x: number; y: number; z: number }> = []
      let x = Math.floor(position.x)
      while (x < target.x) {
        x += 1
        path.push({ x, y: target.y, z: target.z })
      }
      return { status: 'success', path }
    },
  }
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
    pathfinder,
    blockAt: () => null,
    stopDigging: () => undefined,
    clearControlStates: () => undefined,
    canDigBlock: () => false,
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as Bot
  return {
    bot,
    goalStarts: () => goalStarts,
    goalClears: () => goalClears,
    pathStops: () => pathStops,
  }
}

function oakMove(id: string): Candidate {
  return {
    id,
    kind: 'MOVE',
    label: 'approach grounded oak log source',
    targetName: 'oak_log',
    target: standPosition,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: 31,
      targetBlockName: 'oak_log',
      targetBlockX: sourcePosition.x,
      targetBlockY: sourcePosition.y,
      targetBlockZ: sourcePosition.z,
      vertical: 'none',
    },
  }
}

function world(): WorldState {
  return {
    schemaVersion: 1,
    tick: 31,
    timestampMs: Date.now(),
    self: {
      username: 'AI_Buddy',
      position: { x: 0.5, y: 64, z: 0.5 },
      eyePosition: { x: 0.5, y: 65.62, z: 0.5 },
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 20,
      food: 20,
      gameMode: 'survival',
      dimension: identity.dimension,
      isDay: true,
      heldItem: null,
      air: 300,
      feetInWater: false,
      eyesInWater: false,
      envHazard: { active: false },
    },
    inventory: { slots: [], counts: { oak_log: 0 }, totalItems: 0 },
    entities: [],
    blocks: [{
      name: 'oak_log',
      yield: 'oak_log',
      kind: 'log',
      visible: true,
      inReach: false,
      position: sourcePosition,
      hasAdjacentStandable: true,
      adjacentStandable: standPosition,
    }],
    terrain: { standable: [standPosition] },
    craftingTables: [],
    placementSpots: [],
    goal: {
      id: mission.id,
      description: 'inventory oak_log >= 1',
      targetItem: mission.item,
      requiredCount: mission.count,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: { depth: 0, empty: true, current: null, pending: [] },
    recentEvents: [],
    signals: { threat: { active: false }, knownResources: [] },
  } as unknown as WorldState
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
}

test('production Reach dispatch and legacy Executor claim cannot overlap body authority', async () => {
  const fixture = makeBot()
  const logDir = mkdtempSync(join(tmpdir(), 'vtr-reach-executor-dispatch-authority-'))
  const logPath = join(logDir, 'run.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 10_000,
  })
  const reachRuntimeAdapter = new MineflayerReachRuntimeAdapter(fixture.bot, executor)
  const reachRuntime = new ReachMissionRuntime({
    routePolicy: nearestGroundedReachRoutePolicy,
    commitFreshnessFence: () => ({ status: 'current' }),
  })
  const controller = Object.create(JevController.prototype) as JevController
  const fields = controller as unknown as Record<string, any>
  const observedWorld = world()
  const vtrCandidate = oakMove('MOVE:oak-log-vtr')
  const legacyCandidate = oakMove('MOVE:oak-log-legacy')
  const claimCalls: Array<{
    readonly candidateId: string
    readonly authority: string
    readonly transitionId: string | null
    readonly transitionContractHash: string | null
  }> = []
  const claimResults: Array<ReturnType<Executor['claim']>> = []
  const completionEvidence: Array<{
    readonly actionId: unknown
    readonly status: unknown
    readonly failure: unknown
    readonly verified: unknown
    readonly progressed: unknown
    readonly blockRemoved: unknown
    readonly goalItemCount: unknown
    readonly ms: unknown
  }> = []
  const realClaim = executor.claim.bind(executor)
  executor.claim = ((candidate: Candidate, context: Parameters<Executor['claim']>[1] = {}) => {
    claimCalls.push({
      candidateId: candidate.id,
      authority: context.authority ?? 'legacy',
      transitionId: context.transitionId ?? null,
      transitionContractHash: context.transitionContractHash ?? null,
    })
    const result = realClaim(candidate, context)
    claimResults.push(result)
    return result
  }) as Executor['claim']

  Object.assign(fields, {
    options: {
      vtrMission: mission,
      vtrReachProbe: false,
      serverId: '127.0.0.1:25569',
      worldEpoch: identity.worldEpoch,
      reach: 4,
      maxCandidateAgeTicks: 8,
      actuationPort: { generationId: identity.leaseId, assertLease: () => undefined },
      decisionProvenance: { generationId: identity.generationId },
    },
    bot: fixture.bot,
    reachVtrCells: {
      cachedWorldState: { value: null },
      lastRouteDecision: { value: null },
      counters: { jevCalls: { value: 0 }, lastJevAt: { value: 0 }, tickCounter: { value: 0 } },
    },
    queue: { current: null },
    reachRuntime,
    reachRunMetadata: null,
    reachTerminalHandoff: null,
    lastReachActionFailure: null,
    vtrOwnsReachMoveThisTick: false,
    modelRecoveryStopping: false,
    modelRecoveryReachDrainTransitionId: null,
    tickCounter: observedWorld.tick,
    jevCalls: 0,
    runtimeLlmCalls: 0,
    planCalls: 0,
    executor,
    reachRuntimeAdapter,
    reachabilityProofs: new StateFingerprintMemory(),
    logger,
    actionStart: null,
    requestDecision: () => undefined,
    onReachActionComplete: async (execution: Record<string, unknown>) => {
      completionEvidence.push({
        actionId: execution.actionId,
        status: execution.status,
        failure: execution.failure,
        verified: execution.verified,
        progressed: execution.progressed,
        blockRemoved: execution.blockRemoved,
        goalItemCount: execution.goalItemCount,
        ms: execution.ms,
      })
    },
    buildReachWorldState: () => observedWorld,
    reachIdentity: () => identity,
    projectReachMission: (projectMission: typeof mission, world: WorldState, projectionIdentity: typeof identity, contract: any, options: Record<string, unknown>) =>
      projectMinecraftReachRoutes({
        mission: projectMission,
        world,
        identity: projectionIdentity,
        witnessIdentity: projectionIdentity,
        contract,
        previousFrontierId: null,
        previousActionFailure: null,
        candidates: [vtrCandidate],
        snapshotOptions: options,
      }),
  })

  try {
    const tickReachTransition = (JevController.prototype as unknown as {
      tickReachTransition(this: JevController, trigger: string, detail: Record<string, unknown>): Promise<boolean>
    }).tickReachTransition
    assert.equal(await tickReachTransition.call(controller, 'heartbeat', {}), true)

    await waitFor(() => fixture.goalStarts() === 1, 'production VTR dispatch to reach the real pathfinder')
    const activeTransition = reachRuntime.current
    assert.ok(activeTransition)
    assert.ok(activeTransition.intent)
    const vtrAction = executor.current
    assert.ok(vtrAction)
    assert.equal(vtrAction.status, 'running')
    assert.equal(vtrAction.authority, 'vtr-reach')
    assert.equal(vtrAction.transitionId, activeTransition.contract.transitionId)
    assert.equal(vtrAction.transitionContractHash, activeTransition.contract.contractHash)
    const waypoint = vtrAction.resolveVtrReachMechanicalWaypoint?.(vtrCandidate.target!)
    assert.deepEqual(waypoint?.target, { x: 2, y: 64, z: 0 })
    assert.equal(fixture.goalStarts(), 1, 'resolving a path checkpoint does not actuate or create a second owner')
    assert.deepEqual(claimCalls, [{
      candidateId: vtrCandidate.id,
      authority: 'vtr-reach',
      transitionId: activeTransition.contract.transitionId,
      transitionContractHash: activeTransition.contract.contractHash,
    }])

    assert.throws(
      () => executor.claim(legacyCandidate, { authority: 'legacy' }),
      (error: unknown) => error instanceof ExecutionAuthorityConflict,
    )

    assert.equal(executor.current, vtrAction, 'the committed VTR owner retains the body after the legacy refusal')
    assert.equal(vtrAction.status, 'running')
    assert.equal(fixture.goalStarts(), 1, 'the refused legacy claim cannot start a second pathfinder goal')
    assert.equal(executor.maxConcurrentActions, 1)
    assert.equal(executor.authorityConflictCount, 1)
    assert.deepEqual(claimCalls.map(({ authority }) => authority), ['vtr-reach', 'legacy'])

    const active = reachRuntime.current
    assert.ok(active)
    const ended = reachRuntime.supersede({
      reason: 'close authority proof after attempted conflicting legacy dispatch',
      evidenceId: `authority-fixture:${Date.now()}`,
      identity,
      nowMs: Math.max(Date.now(), active.state.startedAtMs),
    })
    assert.equal(ended.status, 'terminal')
    if (ended.status !== 'terminal') throw new Error('expected typed terminal handoff for fixture cleanup')
    const closeReachTransition = (JevController.prototype as unknown as {
      closeReachTransition(this: JevController, outcome: ReachTerminalOutcome, state: ReachTransitionState, boundary: string, cancelIntentId?: string | null): void
    }).closeReachTransition
    closeReachTransition.call(controller, ended.outcome, ended.state, 'authority-fixture', ended.cancelIntentId)
    await waitFor(() => executor.current === null && fixture.goalClears() === 1, 'terminal cancellation to release the real VTR Executor lease')
    await Promise.all(claimResults.map(({ completion }) => completion))
    assert.equal(completionEvidence.length, 1)
    assert.equal(completionEvidence[0]?.actionId, 'MOVE:oak-log-vtr')
    assert.equal(completionEvidence[0]?.status, 'cancelled')
    assert.equal(completionEvidence[0]?.failure, 'cancelled')
    assert.equal(completionEvidence[0]?.verified, false)
    assert.equal(completionEvidence[0]?.progressed, false)
    assert.equal(completionEvidence[0]?.blockRemoved, false)
    assert.equal(typeof completionEvidence[0]?.goalItemCount, 'number')
    assert.equal(typeof completionEvidence[0]?.ms, 'number')

    const records = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      source: string
      message: string
      detail: Record<string, any>
    })
    const conflict = records.find(({ message }) => message.startsWith('ACTUATION_AUTHORITY_CONFLICT'))
    assert.ok(conflict, 'the real Executor must journal its authority conflict')
    assert.equal(conflict.detail.runningAuthority, 'vtr-reach')
    assert.equal(conflict.detail.requestedAuthority, 'legacy')
    assert.equal(conflict.detail.runningTransitionId, active.contract.transitionId)
    assert.equal(conflict.detail.requestedActionId, legacyCandidate.id)

    const actuation = records.find(({ message }) => message.startsWith('VTR_TRANSITION_ACTUATION'))
    assert.ok(actuation, 'the production dispatch adapter must journal the unique VTR actuation')
    assert.equal(actuation.detail.authority, 'vtr-transition-controller')
    assert.equal(actuation.detail.transitionId, active.contract.transitionId)

    const outcome = records.find(({ message }) => message.startsWith('VTR_TRANSITION_OUTCOME'))
    assert.ok(outcome, 'the production close boundary must emit transition-level duplicate-authority evidence')
    assert.equal(outcome.detail.metrics.duplicateAuthority, true)
    assert.equal(outcome.detail.metrics.duplicateAuthorityConflicts, 1)
    assert.equal(outcome.detail.metrics.typedTerminalOutcome, 'CONTRACT_SUPERSEDED')
  } finally {
    const running = executor.current
    if (running !== null) {
      executor.cancelCurrent('authority fixture teardown')
      await running.completion
    }
    await Promise.all(claimResults.map(({ completion }) => completion))
    rmSync(logDir, { recursive: true, force: true })
  }
})
