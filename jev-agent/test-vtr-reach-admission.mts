import { expect, test } from 'bun:test'
import { JevController, reachMoveFitsLocomotionContract } from './src/controller-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import { bodyNeedsBreathEscape } from './src/state.ts'
import type { WorldState } from './src/state.ts'
import { envelopeForCandidate } from './src/skillCommitment.ts'

const mission = { id: 'mission-reach-oak-log', kind: 'inventory_at_least' as const, item: 'oak_log', count: 1 }

const identity = {
  worldKey: 'reach-admission-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
  generationId: 'reach-admission-generation',
  leaseId: 'reach-admission-lease',
}

test('an inadmissible terrain-mutating Mission route is held at a VTR scheduler boundary', async () => {
  const candidate: Candidate = {
    id: 'MOVE:oak-log-source:staircase',
    kind: 'MOVE',
    label: 'approach the oak log using a staircase route',
    targetName: 'oak_log',
    target: { x: 7, y: 64, z: 0 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      vertical: 'staircase',
      targetBlockName: 'oak_log',
      targetBlockX: 8,
      targetBlockY: 64,
      targetBlockZ: 0,
    },
  }
  const envelope = envelopeForCandidate(candidate)
  expect(envelope.mayDigGroundedRoute).toBe(true)
  expect(envelope.mayPlaceGroundedRoute).toBe(true)
  expect(reachMoveFitsLocomotionContract(candidate)).toBe(false)

  const world = {
    schemaVersion: 1,
    tick: 11,
    timestampMs: 1_790_271_800_000,
    self: {
      username: 'AI_Buddy',
      position: { x: 0, y: 64, z: 0 },
      eyePosition: { x: 0, y: 65.62, z: 0 },
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 20,
      food: 20,
      gameMode: 'survival',
      dimension: 'minecraft:overworld',
      isDay: true,
      heldItem: null,
      air: 300,
      feetInWater: false,
      eyesInWater: false,
      envHazard: { active: false },
    },
    inventory: { slots: [], counts: {}, totalItems: 0 },
    entities: [],
    blocks: [{
      name: 'oak_log',
      yield: 'oak_log',
      visible: true,
      inReach: false,
      position: { x: 8, y: 64, z: 0 },
    }],
    terrain: { standable: [] },
    craftingTables: [],
    placementSpots: [],
    goal: { item: 'oak_log', count: 1 },
    goalQueue: { depth: 0, empty: true, current: null, pending: [] },
    recentEvents: [],
    signals: { threat: { active: false }, knownResources: [] },
  } as unknown as WorldState

  // The source is genuinely sensed but outside interaction reach. The body is
  // healthy, breathing normally, and has no environmental or hostile threat, so
  // this cannot be explained by a viability interruption.
  const missionSourceAlreadyReachable = (JevController.prototype as unknown as {
    missionSourceAlreadyReachable(this: JevController, state: WorldState, item: string): boolean
  }).missionSourceAlreadyReachable
  const controller = Object.create(JevController.prototype) as JevController
  expect(missionSourceAlreadyReachable.call(controller, world, mission.item)).toBe(false)
  expect(world.self.health).toBe(20)
  expect(bodyNeedsBreathEscape(world.self)).toBe(false)
  expect(world.self.envHazard?.active).toBe(false)
  expect(world.signals.threat?.active).toBe(false)

  const events: Array<{ source: string; level: string; line: string; detail: Record<string, unknown> }> = []
  let legacyDecisionRequests = 0
  const controllerState = controller as unknown as Record<string, any>
  Object.assign(controllerState, {
    options: { vtrMission: mission, serverId: '127.0.0.1:25565', worldEpoch: 1, actuationPort: null },
    queue: { current: null },
    reachTransition: null,
    reachTerminalHandoff: null,
    modelRecoveryStopping: false,
    modelRecoveryReachDrainTransitionId: null,
    vtrOwnsReachMoveThisTick: false,
    tickCounter: world.tick,
    executor: { current: null, authorityConflictCount: 0 },
    logger: {
      info: (source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ source, level: 'info', line, detail }),
      warn: (source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ source, level: 'warn', line, detail }),
      error: (source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ source, level: 'error', line, detail }),
    },
    requestDecision: () => { legacyDecisionRequests += 1 },
    buildReachWorldState: () => world,
    reachIdentity: () => identity,
    reachCandidates: () => ({ candidates: [], grounded: { candidates: [candidate] } }),
  })

  expect(controllerState.reachTransition).toBeNull()
  expect(controllerState.executor.current).toBeNull()
  expect(controllerState.reachCandidates(world, mission).grounded.candidates).toEqual([candidate])
  const missionSourceCandidateShape = (JevController.prototype as unknown as {
    reachMissionSourceCandidateShape(this: JevController, item: string, candidate: Candidate, state: WorldState): boolean
  }).reachMissionSourceCandidateShape
  const reachWitnessForCandidateShape = (JevController.prototype as unknown as {
    reachWitnessForCandidateShape(this: JevController, item: string, candidate: Candidate, state: WorldState): boolean
  }).reachWitnessForCandidateShape
  expect(missionSourceCandidateShape.call(controller, mission.item, candidate, world)).toBe(true)
  expect(reachWitnessForCandidateShape.call(controller, mission.item, candidate, world)).toBe(false)

  const tickReachTransition = (JevController.prototype as unknown as {
    tickReachTransition(this: JevController, trigger: string, detail: Record<string, unknown>): Promise<boolean>
  }).tickReachTransition
  const handled = await tickReachTransition.call(controller, 'heartbeat', {})

  // This locomotion-only Reach contract cannot claim a route that requires
  // digging/placing terrain. It must preserve VTR scheduler ownership and emit
  // a typed hold/boundary so a different Transition can be scheduled; returning
  // false hands the same unsatisfied Mission back to legacy Jev/GoalQueue.
  expect(handled).toBe(true)
  expect(events.some((event) => event.line.includes('VTR_SCHEDULER_HOLDS_NO_ADMISSIBLE_ROUTE'))).toBe(true)
  expect(events.find((event) => event.line.includes('VTR_SCHEDULER_HOLDS_NO_ADMISSIBLE_ROUTE'))?.detail).toMatchObject({
    mission,
    reason: 'no-admissible-reach-route',
    rejectedCandidates: [candidate.id],
  })
  expect(legacyDecisionRequests).toBe(0)
  expect(controllerState.reachTransition).toBeNull()

  // In probe mode a safety refusal is still contained by the VTR scheduler;
  // the probe must not silently hand the same body to legacy recovery.
  const unsafeWorld = {
    ...world,
    self: { ...world.self, health: 2 },
  } as unknown as WorldState
  const probeEvents: Array<{ source: string; level: string; line: string; detail: Record<string, unknown> }> = []
  let probeLegacyDecisionRequests = 0
  const probeController = Object.create(JevController.prototype) as JevController
  Object.assign(probeController as unknown as Record<string, any>, {
    options: { vtrMission: mission, vtrReachProbe: true, serverId: '127.0.0.1:25565', worldEpoch: 1, actuationPort: null },
    queue: { current: null },
    reachTransition: null,
    reachTerminalHandoff: null,
    modelRecoveryStopping: false,
    modelRecoveryReachDrainTransitionId: null,
    vtrOwnsReachMoveThisTick: false,
    tickCounter: unsafeWorld.tick,
    executor: { current: null, authorityConflictCount: 0 },
    logger: {
      info: (source: string, line: string, detail: Record<string, unknown> = {}) => probeEvents.push({ source, level: 'info', line, detail }),
      warn: (source: string, line: string, detail: Record<string, unknown> = {}) => probeEvents.push({ source, level: 'warn', line, detail }),
      error: (source: string, line: string, detail: Record<string, unknown> = {}) => probeEvents.push({ source, level: 'error', line, detail }),
    },
    requestDecision: () => { probeLegacyDecisionRequests += 1 },
    buildReachWorldState: () => unsafeWorld,
    reachIdentity: () => identity,
    reachCandidates: () => ({ candidates: [candidate], grounded: { candidates: [candidate] } }),
  })
  expect(await tickReachTransition.call(probeController, 'damage_taken', {})).toBe(true)
  expect(probeEvents.find((event) => event.line.includes('VTR_REACH_PROBE_HOLD'))?.detail).toMatchObject({
    reason: 'body-not-safe',
    safetyFacts: { health: 2 },
    authority: 'vtr-transition-scheduler',
  })
  expect(probeLegacyDecisionRequests).toBe(0)
})
