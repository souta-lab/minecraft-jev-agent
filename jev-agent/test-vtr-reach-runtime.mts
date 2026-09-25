import { expect, test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import type { WorldState } from './src/state.ts'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import { nearestGroundedReachRoutePolicy } from './src/vtr/reach-controller.ts'
import { createVtrReachTestCells } from './test-vtr-reach-test-cells.mts'

const mission = { id: 'runtime-reach-oak', kind: 'inventory_at_least' as const, item: 'oak_log', count: 1 }
const identity = {
  worldKey: '127.0.0.1:25569|minecraft:overworld|1',
  dimension: 'minecraft:overworld', worldEpoch: 1,
  generationId: 'runtime-reach-generation', leaseId: 'runtime-reach-lease',
}

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

function world(
  tick: number,
  playerX: number,
  sourceX: number,
  fixtureStartedAt: number,
  sourceInReach = false,
): WorldState {
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
      inReach: sourceInReach, position: { x: sourceX, y: 64, z: 0 },
    }],
    terrain: { standable: [{ x: playerX, y: 64, z: 0 }, { x: sourceX - 1, y: 64, z: 0 }] },
    craftingTables: [], placementSpots: [],
    goal: { item: 'oak_log', count: 1 },
    goalQueue: { depth: 0, empty: true, current: null, pending: [] },
    recentEvents: [], signals: { threat: { active: false }, knownResources: [] },
  } as unknown as WorldState
}

test('production Reach uses injected VTR authority through same-contract continuation and verified closure', async () => {
  const realDateNow = Date.now
  let logicalNow = realDateNow()
  // Tick 31 is fresh at the start of this test; action boundaries advance the
  // logical clock alongside every new WorldState fact snapshot.
  const fixtureStartedAt = logicalNow - 31_000
  Date.now = () => logicalNow

  try {
    let observedWorld = world(31, 0, 8, fixtureStartedAt)
    let offered = candidate(8, 7, observedWorld.tick)
    let currentAction: Record<string, unknown> | null = null
    const pendingCompletions: Array<(result: Record<string, unknown>) => void> = []
    const claims: Array<{ candidate: string; authority: string; transitionId: string }> = []
    const legOutcomes: boolean[] = []
    const events: string[] = []
    const reachRuntime = new ReachMissionRuntime({
      routePolicy: nearestGroundedReachRoutePolicy,
      commitFreshnessFence: () => ({ status: 'current' }),
    })
    let unavailableAuthorityCalls = 0
    const unavailableAuthority = new Proxy({}, {
      get(_target, key) {
        if (key === 'then') return undefined
        return () => {
          unavailableAuthorityCalls += 1
          throw new Error(`model authority unavailable during active Reach: ${String(key)}`)
        }
      },
    })
    const controller = Object.create(JevController.prototype) as JevController
    const controllerFields = controller as unknown as Record<string, any>

    const advanceWorld = (tick: number, playerX: number, sourceX: number, inReach = false): void => {
      observedWorld = world(tick, playerX, sourceX, fixtureStartedAt, inReach)
      logicalNow = observedWorld.timestampMs
      controllerFields.tickCounter = tick
    }

    Object.assign(controllerFields, {
      reachVtrCells: createVtrReachTestCells({ tickCounter: observedWorld.tick }),
      options: {
        vtrMission: mission, serverId: '127.0.0.1:25569', worldEpoch: identity.worldEpoch,
        reach: 4, maxCandidateAgeTicks: 8,
        actuationPort: { generationId: identity.leaseId, assertLease: () => undefined },
        decisionProvenance: { generationId: identity.generationId },
      },
      queue: { current: null },
      // The test injects the VTR object itself. `reachRunMetadata` is diagnostic
      // projection only; no legacy runtime state is assigned as authority.
      reachRuntime,
      reachRunMetadata: null,
      reachTerminalHandoff: null,
      // Active Reach must finish under a Jev/System2 outage because its
      // committed contract still determines the required movement.
      jev: unavailableAuthority,
      system2: unavailableAuthority,
      modelRecoveryStopping: false, modelRecoveryReachDrainTransitionId: null,
      vtrOwnsReachMoveThisTick: false, tickCounter: observedWorld.tick,
      jevCalls: 0, runtimeLlmCalls: 0, planCalls: 0, lastReachActionFailure: null,
      candidateFailures: new Map(), candidateFailureAt: new Map(), signals: { failedCandidates: {} },
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
          expect(reserved).toBe(true)

          // The mechanics settle on a strictly newer fact snapshot than commit/tick.
          const currentWorld = observedWorld
          const sourceX = Number(selected.meta.targetBlockX)
          advanceWorld(currentWorld.tick + 1, currentWorld.self.position.x, sourceX)
          legOutcomes.push(context.afterMechanicalStep(step))

          currentAction = { id: selected.id, kind: 'MOVE', authority: 'vtr-reach', transitionId, status: 'running' }
          let resolve!: (result: Record<string, unknown>) => void
          const completion = new Promise<Record<string, unknown>>((done) => { resolve = done })
          pendingCompletions.push(resolve)
          return { kept: false, epoch: claims.length, completion }
        },
      },
    })
    expect(controllerFields.reachRuntime).toBe(reachRuntime)

    const tickReachTransition = (JevController.prototype as unknown as {
      tickReachTransition(this: JevController, trigger: string, detail: Record<string, unknown>): Promise<boolean>
    }).tickReachTransition

    expect(await tickReachTransition.call(controller, 'heartbeat', {})).toBe(true)
    expect(pendingCompletions).toHaveLength(1)
    const firstOwner = reachRuntime.current
    expect(firstOwner).not.toBeNull()
    if (firstOwner === null || firstOwner.intent === null) throw new Error('expected committed authoritative Reach state')
    const transitionId = firstOwner.contract.transitionId
    const contractHash = firstOwner.contract.contractHash
    const desiredPredicateIdentity = firstOwner.contract.desiredPredicateIdentity
    const firstWitnessId = firstOwner.state.witness?.witnessId
    expect(firstOwner.state.usage.mechanicalSteps).toBe(1)
    expect(controllerFields.reachRunMetadata.transitionId).toBe(transitionId)
    expect(controllerFields.reachRunMetadata.contractHash).toBe(contractHash)
    expect(legOutcomes).toEqual([true])

    // The action reports done while the ensured predicate remains false. Its
    // completion is not SUCCESS; a newer snapshot introduces a valid witness.
    currentAction = null
    offered = candidate(16, 15, 33)
    advanceWorld(33, 2, 16)
    pendingCompletions[0]!({
      actionId: claims[0]!.candidate, status: 'done', verified: true, failure: null,
      progressed: true, distanceClosed: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const afterFirstCompletion = reachRuntime.current
    expect(afterFirstCompletion).not.toBeNull()
    if (afterFirstCompletion === null) throw new Error('executor completion must retain active Reach owner')
    expect(afterFirstCompletion.contract.contractHash).toBe(contractHash)
    expect(afterFirstCompletion.state.status).toBe('active')
    expect(reachRuntime.current?.state.terminalOutcome).toBeNull()
    expect(afterFirstCompletion.intent).toBeNull()

    // A fresh tick chooses the replacement route inside the same desired predicate.
    offered = candidate(16, 15, 34)
    advanceWorld(34, 2, 16)
    expect(await tickReachTransition.call(controller, 'heartbeat', {})).toBe(true)
    expect(pendingCompletions).toHaveLength(2)

    const continued = reachRuntime.current
    expect(continued).not.toBeNull()
    if (continued === null || continued.intent === null) throw new Error('expected second controller-owned action')
    expect(continued.contract.transitionId).toBe(transitionId)
    expect(continued.contract.contractHash).toBe(contractHash)
    expect(continued.contract.desiredPredicateIdentity).toBe(desiredPredicateIdentity)
    expect(continued.state.witness?.witnessId).not.toBe(firstWitnessId)
    expect(continued.state.temporaryWaypoint?.waypointId).toBe(offered.id)
    expect(continued.state.usage.mechanicalSteps).toBe(2)
    expect(legOutcomes).toEqual([true, true])
    expect(claims.map((claim) => claim.authority)).toEqual(['vtr-reach', 'vtr-reach'])
    expect(new Set(claims.map((claim) => claim.transitionId))).toEqual(new Set([transitionId]))

    // A second action-level "done" still cannot close the contract. The next
    // deterministic world observation flips the declared ensures predicate.
    currentAction = null
    offered = candidate(16, 15, 36)
    advanceWorld(36, 2, 16)
    pendingCompletions[1]!({
      actionId: claims[1]!.candidate, status: 'done', verified: true, failure: null,
      progressed: true, distanceClosed: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reachRuntime.current?.state.status).toBe('active')
    expect(reachRuntime.current?.state.usage.mechanicalSteps).toBe(2)
    expect(reachRuntime.current?.intent).toBeNull()
    expect(reachRuntime.current?.state.terminalOutcome).toBeNull()

    advanceWorld(37, 14, 16, true)
    offered = candidate(16, 15, 37)
    expect(await tickReachTransition.call(controller, 'heartbeat', {})).toBe(true)
    expect(reachRuntime.current).toBeNull()
    expect(controllerFields.reachRunMetadata).toBeNull()
    const verifyIndex = events.findIndex((line) => line.includes(`VTR_TRANSITION_VERIFY id=${transitionId} `))
    const outcomeIndex = events.findIndex((line) => line.includes(`VTR_TRANSITION_OUTCOME id=${transitionId} outcome=SUCCESS`))
    expect(verifyIndex).toBeGreaterThanOrEqual(0)
    expect(outcomeIndex > verifyIndex).toBe(true)
    expect(events.filter((line) => line.includes(`VTR_TRANSITION_OUTCOME id=${transitionId} outcome=SUCCESS`))).toHaveLength(1)
    expect(events.filter((line) => line.includes('VTR_TRANSITION_COMMIT'))).toHaveLength(1)
    expect(events.filter((line) => line.includes('VTR_TRANSITION_ACTUATION'))).toHaveLength(2)
    expect(controllerFields.jevCalls).toBe(0)
    expect(controllerFields.runtimeLlmCalls).toBe(0)
    expect(controllerFields.planCalls).toBe(0)
    expect(unavailableAuthorityCalls).toBe(0)
    expect(controllerFields.executor.authorityConflictCount).toBe(0)
  } finally {
    Date.now = realDateNow
  }
})
