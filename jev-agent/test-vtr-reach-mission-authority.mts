import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import { nearestGroundedReachRoutePolicy } from './src/vtr/reach-controller.ts'
import { filterLegacyReachCandidates } from './src/vtr/legacy-reach-compat.ts'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import { createVtrReachTestCells } from './test-vtr-reach-test-cells.mts'
import type { Candidate } from './src/candidates.ts'
import type { WorldState } from './src/state.ts'

const configuredMission = {
  id: 'run-mission:oak_log:1',
  kind: 'inventory_at_least' as const,
  item: 'oak_log',
  count: 1,
}

const identity = {
  worldKey: 'mission-authority-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 4,
  generationId: 'mission-authority-generation',
  leaseId: 'mission-authority-lease',
}

const sourcePosition = { x: 8, y: 64, z: 0 }
const walkUpPosition = { x: 7, y: 64, z: 0 }

function propositionItem(proposition: unknown): string | null {
  if (proposition === null || typeof proposition !== 'object' || Array.isArray(proposition)) return null
  const item = (proposition as Record<string, unknown>).item
  return typeof item === 'string' ? item : null
}

function moveToOakLog(): Candidate {
  return {
    id: 'MOVE:oak_log@8,64,0',
    kind: 'MOVE',
    label: 'approach the configured Mission oak log source',
    targetName: 'oak_log',
    target: walkUpPosition,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      targetBlockName: 'oak_log',
      targetBlockX: sourcePosition.x,
      targetBlockY: sourcePosition.y,
      targetBlockZ: sourcePosition.z,
    },
  }
}

function worldWithOakSource(): WorldState {
  return {
    schemaVersion: 1,
    tick: 10,
    timestampMs: 10_000,
    self: {
      username: 'AI_Buddy',
      position: { x: 0, y: 64, z: 0 },
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
    inventory: { slots: [], counts: { oak_log: 0, iron_ingot: 0 }, totalItems: 0 },
    entities: [],
    blocks: [{
      name: 'oak_log',
      yield: 'oak_log',
      kind: 'block',
      visible: true,
      inReach: false,
      position: sourcePosition,
      hasAdjacentStandable: true,
      adjacentStandable: walkUpPosition,
    }],
    terrain: { standable: [] },
    craftingTables: [],
    placementSpots: [],
    goal: {
      id: configuredMission.id,
      description: 'configured Mission oak_log >= 1',
      targetItem: configuredMission.item,
      requiredCount: configuredMission.count,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    // buildReachWorldState deliberately gives its compatibility sensor view an
    // empty queue. The ordinary controller queue is represented separately in
    // makeController below and can point at a different ladder rung.
    goalQueue: { depth: 0, empty: true, current: null, pending: [] },
    recentEvents: [],
    signals: { threat: { active: false }, knownResources: [] },
  } as unknown as WorldState
}

function makeController(input: {
  readonly probe: boolean
  readonly ladderRootItem: string
  readonly ladderRootCount: number
  readonly queueHeadItem: string
  readonly candidates: readonly Candidate[]
}) {
  const controller = Object.create(JevController.prototype) as JevController
  const events: Array<{ line: string; detail: Record<string, unknown> }> = []
  const claimed: string[] = []
  const requestedDecisions: string[] = []
  const world = worldWithOakSource()
  const reachCandidateCalls: Array<{ missionItem: string; worldGoalItem: string | null }> = []
  const reachRuntime = new ReachMissionRuntime({
    routePolicy: nearestGroundedReachRoutePolicy,
    commitFreshnessFence: () => ({ status: 'current' }),
  })

  Object.assign(controller as unknown as Record<string, unknown>, {
    reachVtrCells: createVtrReachTestCells({ tickCounter: world.tick }),
    options: {
      vtrMission: configuredMission,
      vtrReachProbe: input.probe,
      // These stand in for a deterministic ladder-derived root goal.
      goalItem: input.ladderRootItem,
      goalCount: input.ladderRootCount,
      serverId: '127.0.0.1:25569',
      worldEpoch: identity.worldEpoch,
      reach: 4,
      maxCandidateAgeTicks: 8,
      actuationPort: null,
      decisionProvenance: { generationId: identity.generationId },
    },
    queue: {
      current: {
        id: `legacy:${input.queueHeadItem}`,
        kind: 'collect',
        targetItem: input.queueHeadItem,
        requiredCount: 1,
        description: `legacy ladder head ${input.queueHeadItem}`,
        origin: 'system2',
      },
    },
    reachRuntime,
    reachRunMetadata: null,
    reachTerminalHandoff: null,
    lastReachActionFailure: null,
    vtrOwnsReachMoveThisTick: false,
    modelRecoveryStopping: false,
    modelRecoveryReachDrainTransitionId: null,
    tickCounter: world.tick,
    jevCalls: 0,
    runtimeLlmCalls: 0,
    planCalls: 0,
    executor: {
      current: null,
      authorityConflictCount: 0,
      claim: (candidate: Candidate) => {
        claimed.push(candidate.id)
        return { kept: true, epoch: 1, completion: new Promise(() => undefined) }
      },
    },
    logger: {
      info: (_source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ line, detail }),
      warn: (_source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ line, detail }),
      error: (_source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ line, detail }),
    },
    requestDecision: (trigger: string) => requestedDecisions.push(trigger),
    buildReachWorldState: (mission: typeof configuredMission) => {
      assert.equal(mission.item, configuredMission.item)
      return world
    },
    reachIdentity: () => identity,
    reachCandidates: (candidateWorld: WorldState, mission: typeof configuredMission) => {
      reachCandidateCalls.push({ missionItem: mission.item, worldGoalItem: candidateWorld.goal.targetItem })
      return {
        candidates: [...input.candidates],
        grounded: { candidates: [...input.candidates] },
      }
    },
    reachabilityGateOptions: () => ({ pathProbe: () => 'reachable', stationApproach: null }),
    canComputePath: () => true,
    recipeIndex: {},
    unreachableStationKeys: () => new Set<string>(),
    blacklistedMoveTargets: () => new Set<string>(),
    searchedSurfaceTargets: new Set<string>(),
    placementRetries: { retiredItemSet: () => new Set<string>() },
  })

  return { controller, events, claimed, requestedDecisions, reachCandidateCalls, world }
}

const tickReachTransition = (JevController.prototype as unknown as {
  tickReachTransition(this: JevController, trigger: string, detail: Record<string, unknown>): Promise<boolean>
}).tickReachTransition

test('Reach contract uses configured Mission when ladder root and GoalQueue head differ', async () => {
  const generationEntry = readFileSync(new URL('../buddy-driver/generation-entry.ts', import.meta.url), 'utf8')
  const missionWireStart = generationEntry.indexOf('    vtrMission: {')
  const missionWireEnd = generationEntry.indexOf('    vtrReachProbe,', missionWireStart)
  assert.ok(missionWireStart >= 0 && missionWireEnd > missionWireStart)
  const missionWire = generationEntry.slice(missionWireStart, missionWireEnd)
  assert.match(missionWire, /item: ctx\.goalItem/)
  assert.match(missionWire, /count: ctx\.goalCount/)
  assert.doesNotMatch(missionWire, /rootGoal|RUNGS|ladder/)

  const controllerSource = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const vtrHandoff = controllerSource.indexOf('const handled = await this.tickReachTransition(trigger, detail)')
  const legacyQueueReconcile = controllerSource.indexOf('this.syncQueue(trigger)', vtrHandoff)
  assert.ok(vtrHandoff >= 0 && legacyQueueReconcile > vtrHandoff)
  assert.match(controllerSource.slice(vtrHandoff, legacyQueueReconcile), /if \(handled\) return/)

  const cases = [
    { ladderRootItem: 'iron_ingot', ladderRootCount: 3, queueHeadItem: 'blaze_rod' },
    { ladderRootItem: 'nether_portal', ladderRootCount: 1, queueHeadItem: 'ender_pearl' },
  ]
  for (const divergentAuthority of cases) {
    const fixture = makeController({ probe: false, ...divergentAuthority, candidates: [moveToOakLog()] })
    const handled = await tickReachTransition.call(fixture.controller, 'heartbeat', {})
    const runtime = fixture.controller as unknown as { reachRuntime: ReachMissionRuntime }
    const active = runtime.reachRuntime.current

    assert.equal(handled, true)
    assert.ok(active)
    assert.equal(propositionItem(active.contract.desiredPredicate.proposition), configuredMission.item)
    assert.equal(propositionItem(active.contract.ensures[0]?.proposition), configuredMission.item)
    assert.equal(active.state.witness?.witnessId, 'oak_log@8,64,0')
    assert.equal(fixture.reachCandidateCalls[0]?.missionItem, configuredMission.item)
    assert.equal(fixture.reachCandidateCalls[0]?.worldGoalItem, configuredMission.item)
    assert.deepEqual(fixture.claimed, ['MOVE:oak_log@8,64,0'])
    const commitEvent = fixture.events.find(({ line }) => line.includes('VTR_TRANSITION_COMMIT'))
    assert.ok(commitEvent)
    assert.equal(commitEvent.detail.contractHash, active.contract.contractHash)
    assert.equal(fixture.requestedDecisions.length, 0)
    assert.equal(fixture.events.some(({ line }) => line.includes('VTR_LEGACY_REACH_MOVE_WITHHELD')), false)
  }
})

test('normal mode reconciles a non-admitted Mission source so legacy cannot replay its Reach MOVE', async () => {
  const fixture = makeController({
    probe: false,
    ladderRootItem: 'iron_ingot',
    ladderRootCount: 3,
    queueHeadItem: 'blaze_rod',
    candidates: [],
  })
  const handled = await tickReachTransition.call(fixture.controller, 'heartbeat', {})
  const runtime = fixture.controller as unknown as { reachRuntime: ReachMissionRuntime; vtrOwnsReachMoveThisTick: boolean }

  // A missing admissible route has no active Reach controller state. The
  // compatibility scheduler may continue for other work, but the currently
  // grounded same-Mission source MOVE is marked for suppression/reconciliation.
  assert.equal(handled, false)
  assert.equal(runtime.reachRuntime.current, null)
  assert.equal(runtime.vtrOwnsReachMoveThisTick, true)
  assert.deepEqual(fixture.claimed, [])
  assert.equal(fixture.events.some(({ line }) => line.includes('VTR_REACH_PROBE_HOLD')), false)
  assert.equal(fixture.requestedDecisions.length, 0)

  const unrelated = moveToOakLog()
  unrelated.id = 'MOVE:iron_ore@24,64,0'
  unrelated.label = 'approach unrelated iron ore source'
  unrelated.targetName = 'iron_ore'
  unrelated.meta = {
    targetBlockName: 'iron_ore',
    targetBlockX: 24,
    targetBlockY: 64,
    targetBlockZ: 0,
  }
  const declinedWorld = {
    ...fixture.world,
    blocks: [
      ...fixture.world.blocks,
      {
        name: 'iron_ore',
        yield: 'raw_iron',
        kind: 'ore' as const,
        visible: true,
        inReach: false,
        distance: 16,
        diggable: true,
        position: { x: 24, y: 64, z: 0 },
        hasAdjacentStandable: true,
        adjacentStandable: { x: 23, y: 64, z: 0 },
      },
    ],
  }
  const afterVtrDecline = filterLegacyReachCandidates({
    candidates: [moveToOakLog(), unrelated],
    world: declinedWorld,
    missionItem: configuredMission.item,
    missionSourceNames: ['oak_log'],
    vtrOwnsReachMove: runtime.vtrOwnsReachMoveThisTick,
  })
  assert.deepEqual(afterVtrDecline.withheld.map((candidate) => candidate.id), ['MOVE:oak_log@8,64,0'])
  assert.deepEqual(afterVtrDecline.candidates.map((candidate) => candidate.id), ['MOVE:iron_ore@24,64,0'])
  assert.equal(afterVtrDecline.candidates[0]?.id, unrelated.id, 'the unrelated candidate remains eligible to legacy policy')

  const legacyOwnsNoSamePredicateTick = filterLegacyReachCandidates({
    candidates: [moveToOakLog(), unrelated],
    world: declinedWorld,
    missionItem: configuredMission.item,
    missionSourceNames: ['oak_log'],
    vtrOwnsReachMove: false,
  })
  assert.deepEqual(legacyOwnsNoSamePredicateTick.candidates.map((candidate) => candidate.id), [
    'MOVE:oak_log@8,64,0',
    'MOVE:iron_ore@24,64,0',
  ])
})
