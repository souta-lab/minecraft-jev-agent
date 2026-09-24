import { expect, test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import type { WorldState } from './src/state.ts'

const mission = { id: 'runtime-reach-oak', kind: 'inventory_at_least' as const, item: 'oak_log', count: 1 }
const identity = {
  worldKey: '127.0.0.1:25569|minecraft:overworld|1',
  dimension: 'minecraft:overworld', worldEpoch: 1,
  generationId: 'runtime-reach-generation', leaseId: 'runtime-reach-lease',
}
const fixtureStartedAt = Date.now() - 32_000

function candidate(source: number, target: number, tick: number): Candidate {
  return {
    id: `MOVE:b${source}_64_0`, kind: 'MOVE', label: `approach oak log at ${source}`,
    targetName: 'oak_log', target: { x: target, y: 64, z: 0 }, targetEntityId: null,
    itemName: null, requiresTool: false, toolName: null, inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick, targetBlockName: 'oak_log', targetBlockX: source, targetBlockY: 64,
      targetBlockZ: 0, vertical: 'none',
    },
  }
}

function world(tick: number, playerX: number, sourceX: number): WorldState {
  return {
    schemaVersion: 1, tick, timestampMs: fixtureStartedAt + tick * 1_000,
    self: {
      username: 'AI_Buddy', position: { x: playerX, y: 64, z: 0 },
      eyePosition: { x: playerX, y: 65.62, z: 0 }, yaw: 0, pitch: 0,
      onGround: true, health: 20, food: 20, gameMode: 'survival',
      dimension: identity.dimension, isDay: true, heldItem: null, air: 300,
      feetInWater: false, eyesInWater: false, envHazard: { active: false },
    },
    inventory: { slots: [], counts: {}, totalItems: 0 }, entities: [],
    blocks: [{
      kind: 'log', name: 'oak_log', yield: 'oak_log', visible: true,
      diggable: true, harvestTool: 'axe', distance: Math.abs(sourceX - playerX),
      hasAdjacentStandable: true, adjacentStandable: { x: sourceX - 1, y: 64, z: 0 },
      inReach: false, position: { x: sourceX, y: 64, z: 0 },
    }],
    terrain: { standable: [{ x: playerX, y: 64, z: 0 }, { x: sourceX - 1, y: 64, z: 0 }] },
    craftingTables: [], placementSpots: [],
    goal: { item: 'oak_log', count: 1 },
    goalQueue: { depth: 0, empty: true, current: null, pending: [] },
    recentEvents: [], signals: { threat: { active: false }, knownResources: [] },
  } as unknown as WorldState
}

test('production Reach controller keeps one contract through a grounded witness and waypoint change', async () => {
  let observedWorld = world(31, 0, 8)
  let offered = candidate(8, 7, observedWorld.tick)
  let currentAction: Record<string, unknown> | null = null
  const claims: Array<{ candidate: string; authority: string; transitionId: string }> = []
  const events: string[] = []
  const controller = Object.create(JevController.prototype) as JevController
  Object.assign(controller as unknown as Record<string, any>, {
    options: {
      vtrMission: mission, serverId: '127.0.0.1:25569', worldEpoch: identity.worldEpoch,
      reach: 4, maxCandidateAgeTicks: 8,
      actuationPort: { generationId: identity.leaseId, assertLease: () => undefined },
      decisionProvenance: { generationId: identity.generationId },
    },
    queue: { current: null }, reachTransition: null, reachTerminalHandoff: null,
    modelRecoveryStopping: false, modelRecoveryReachDrainTransitionId: null,
    vtrOwnsReachMoveThisTick: false, tickCounter: observedWorld.tick,
    jevCalls: 0, runtimeLlmCalls: 0, planCalls: 0, lastReachActionFailure: null,
    candidateFailures: new Map(),
    bot: { health: 20, entity: { position: { clone: () => ({ ...observedWorld.self.position }) } } },
    buildReachWorldState: () => observedWorld,
    reachIdentity: () => identity,
    liveReachIdentity: () => identity,
    reachabilityGateOptions: () => ({ pathProbe: () => 'reachable' }),
    reachCandidates: () => ({ candidates: [offered], grounded: { candidates: [offered] } }),
    requestDecision: () => undefined,
    logger: {
      info: (_source: string, line: string) => events.push(line),
      warn: (_source: string, line: string) => events.push(line),
      error: (_source: string, line: string) => events.push(line),
    },
    executor: {
      get current() { return currentAction },
      authorityConflictCount: 0,
      cancelCurrent: () => { currentAction = null; return true },
      claim: (selected: Candidate, context: Record<string, any>) => {
        const transitionId = String(context.transitionId)
        claims.push({ candidate: selected.id, authority: String(context.authority), transitionId })
        const step = {
          stepId: `${selected.id}#${claims.length}:walk-leg-1`, leg: 1, effectKind: 'locomotion' as const,
        }
        const reserved = context.beforeMechanicalStep(step)
        if (reserved) context.afterMechanicalStep(step)
        currentAction = { id: selected.id, kind: 'MOVE', authority: 'vtr-reach', transitionId, status: 'running' }
        const completion = Promise.resolve({
          actionId: selected.id, status: 'done', verified: true, failure: null,
          progressed: true, distanceClosed: true,
        } as any)
        queueMicrotask(() => { currentAction = null })
        return { kept: false, epoch: claims.length, completion }
      },
    },
  })

  const tickReachTransition = (JevController.prototype as unknown as {
    tickReachTransition(this: JevController, trigger: string, detail: Record<string, unknown>): Promise<boolean>
  }).tickReachTransition
  expect(await tickReachTransition.call(controller, 'heartbeat', {})).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const runtime = (controller as unknown as Record<string, any>).reachTransition
  expect(runtime).not.toBeNull()
  const transitionId = runtime.contract.transitionId
  const contractHash = runtime.contract.contractHash
  const desiredPredicateIdentity = runtime.contract.desiredPredicateIdentity
  const firstWitnessId = runtime.state.witness.witnessId
  expect(runtime.state.usage.mechanicalSteps).toBe(1)

  // The first source is no longer in the observed world. A different valid
  // grounded source and temporary waypoint appear; the ensured predicate is
  // unchanged, so the same committed controller owns the next leg.
  observedWorld = world(32, 2, 16)
  offered = candidate(16, 15, observedWorld.tick)
  ;(controller as unknown as Record<string, any>).tickCounter = observedWorld.tick
  expect(await tickReachTransition.call(controller, 'heartbeat', {})).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))

  const continued = (controller as unknown as Record<string, any>).reachTransition
  expect(continued.contract.transitionId).toBe(transitionId)
  expect(continued.contract.contractHash).toBe(contractHash)
  expect(continued.contract.desiredPredicateIdentity).toBe(desiredPredicateIdentity)
  expect(continued.state.witness.witnessId).not.toBe(firstWitnessId)
  expect(continued.state.temporaryWaypoint.waypointId).toBe(offered.id)
  expect(continued.state.usage.mechanicalSteps).toBe(2)
  expect(claims).toHaveLength(2)
  expect(claims.map((claim) => claim.authority)).toEqual(['vtr-reach', 'vtr-reach'])
  expect(new Set(claims.map((claim) => claim.transitionId))).toEqual(new Set([transitionId]))
  expect((controller as unknown as Record<string, any>).jevCalls).toBe(0)
  expect((controller as unknown as Record<string, any>).runtimeLlmCalls).toBe(0)
  expect((controller as unknown as Record<string, any>).planCalls).toBe(0)
  expect(events.filter((line) => line.includes('VTR_TRANSITION_COMMIT'))).toHaveLength(1)
  expect(events.filter((line) => line.includes('VTR_TRANSITION_ACTUATION'))).toHaveLength(2)
})
