import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import type { Bot } from 'mineflayer'
import type { Candidate } from './src/candidates.ts'
import { JevController } from './src/controller.ts'
import type { JevResult } from './src/jev/client.ts'
import { ReachMissionRuntime } from './src/reach/mission-runtime.ts'
import type { ReachIdentity, ReachTransitionContract } from './src/reach/transition.ts'
import type { ReachRoute, ReachRuntimeSnapshot } from './src/reach/controller.ts'
import { createTestKernelAuthority } from './test-vtr-kernel-authority-stub.mts'


const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')

const origin = { x: 0, y: 64, z: 0 }
const oakAt = { x: 8, y: 64, z: 0 }
const birchAt = { x: 0, y: 64, z: 8 }
const mission = { id: 'mission:oak_log:1', kind: 'inventory_at_least' as const, item: 'oak_log', count: 1 }
const identity: ReachIdentity = {
  worldKey: '127.0.0.1:25565|minecraft:overworld|4',
  dimension: 'minecraft:overworld',
  worldEpoch: 4,
  generationId: 'full-tick-generation',
  leaseId: 'full-tick-lease',
}

function makeBot(): Bot {
  const position = new Vec3(origin.x, origin.y, origin.z)
  const logs = new Map([
    [`${oakAt.x},${oakAt.y},${oakAt.z}`, 'oak_log'],
    [`${birchAt.x},${birchAt.y},${birchAt.z}`, 'birch_log'],
  ])
  const blockAt = (cell: { x: number; y: number; z: number }) => {
    const key = `${cell.x},${cell.y},${cell.z}`
    const name = logs.get(key) ?? (cell.y <= 63 ? 'stone' : 'air')
    const solid = name !== 'air'
    return {
      name,
      boundingBox: solid ? 'block' : 'empty',
      diggable: solid,
      position: new Vec3(cell.x, cell.y, cell.z),
    }
  }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance?: number
    count?: number
  }): unknown[] => {
    const maxDistance = options.maxDistance ?? 48
    const count = options.count ?? 256
    const out: unknown[] = []
    for (const [key, name] of logs) {
      if (!options.matching({ name })) continue
      const [x, y, z] = key.split(',').map(Number) as [number, number, number]
      if (Math.hypot(x - origin.x, y - origin.y, z - origin.z) > maxDistance) continue
      out.push(new Vec3(x, y, z))
      if (out.length >= count) break
    }
    return out
  }
  return {
    username: 'AI_VTR_TICK',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    // Exercise the production MineflayerReachRuntimeAdapter's real path-probe
    // boundary. The adapter converts this grounded path to the typed CAN fact;
    // the test does not inject ReachRoute or reachability evidence directly.
    pathfinder: {
      movements: {},
      getPathTo: (_movements: unknown, goal: { x: number; y: number; z: number }) => ({
        status: 'success',
        path: [
          { x: origin.x, y: origin.y, z: origin.z },
          { x: goal.x, y: goal.y, z: goal.z },
        ],
      }),
    },
    inventory: { items: () => [], count: () => 0 },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
    on: () => undefined,
    once: () => undefined,
    removeListener: () => undefined,
  } as never
}

function primeUnconsumedMissionSatisfiedOutcome(runtime: ReachMissionRuntime): Promise<void> {
  const atMs = 1_000
  const { contract } = runtime.deriveInventoryReachTransition({
    mission,
    interactionReach: 4.5,
    sourceNames: ['oak_log'],
    identity,
    transitionId: 'prior-transition-awaiting-handoff',
  })
  const routeId = 'prior-grounded-oak-route'
  const evidenceId = `prior-route:${atMs}`
  const route: ReachRoute = {
    routeId,
    groundingPredicateId: routeId,
    waypointGroundingPredicateId: null,
    witness: {
      witnessId: `oak_log@${oakAt.x},${oakAt.y},${oakAt.z}`,
      target: oakAt,
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: identity,
      observedAtMs: atMs,
    },
    waypoint: null,
    tactic: 'walk',
    effectKind: 'locomotion',
    estimatedDistance: 8,
    resources: {},
    risk: {},
  }
  const predicates: Record<string, { truth: 'true' | 'false'; evidenceId: string }> = {}
  for (const predicate of [...contract.requires, ...contract.invariants]) {
    predicates[predicate.id] = { truth: predicate.expected ? 'true' : 'false', evidenceId: `prior:${predicate.id}` }
  }
  predicates[routeId] = { truth: 'true', evidenceId }
  predicates[contract.desiredPredicate.id] = { truth: 'false', evidenceId: 'prior:still-outside-reach' }
  const snapshot: ReachRuntimeSnapshot = {
    observation: { identity, observedAtMs: atMs, predicates },
    routes: [route],
    progress: {
      predicateDistance: 8,
      reachability: 'reachable',
      frontierId: routeId,
      evidenceId: `prior-progress:${atMs}`,
    },
    parentMissionSatisfied: { evidenceId: `prior-inventory:${atMs}` },
  }
  return runtime.commit(contract, snapshot).then((result) => {
    assert.equal(result.status, 'terminal')
    if (result.status === 'terminal') assert.equal(result.outcome.kind, 'MISSION_SATISFIED')
  })
}

function answer(value: string) {
  return { name: 'action', type: 'choice' as const, value, probability: 1, confidence: 1, probabilities: { [value]: 1 }, legend: null, note: null }
}

test('real full tick hands only unrelated grounded candidates to legacy policy after VTR start refusal', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'vtr-full-tick-decline-'))
  const policyOffers: Candidate[][] = []
  const claims: string[] = []
  const policyChoices: string[] = []
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  const startResults: Array<{ status: string; reason?: string }> = []
  const vtrSnapshotRoutes: string[][] = []
  let controller: JevController | null = null
  try {
    controller = new JevController(makeBot(), {
      kernelAuthority: createTestKernelAuthority(),
      vtrMission: mission,
      goalItem: 'oak_log',
      goalCount: 1,
      serverId: '127.0.0.1:25565',
      worldEpoch: identity.worldEpoch,
      decisionProvenance: { generationId: identity.generationId, runId: 'full-tick-run', sourceSha: 'full-tick-source' },
      actuationPort: { generationId: identity.leaseId, assertLease: () => undefined } as never,
      reach: 4.5,
      scanRadius: 48,
      logDir,
      forceFallbackPolicy: true,
      verbose: false,
      eventSink: (event, detail) => events.push({ event, detail }),
    })
    const runtime = new ReachMissionRuntime({ kernelAuthority: createTestKernelAuthority(),
      routePolicy: { async chooseRoute() { return { status: 'unavailable', reason: 'fixture' } } },
      commitFreshnessFence: () => ({ status: 'current' }),
    })
    // A real typed terminal from the VTR runtime intentionally remains unconsumed.
    // Its next Mission start must be refused before any VTR intent can actuate.
    await primeUnconsumedMissionSatisfiedOutcome(runtime)
    assert.equal(runtime.current, null)
    const actualCommit = runtime.commit.bind(runtime)
    ;(runtime as unknown as Record<string, any>).commit = async (contract: ReachTransitionContract, snapshot: ReachRuntimeSnapshot) => {
      vtrSnapshotRoutes.push(snapshot.routes.map((route) => route.routeId))
      const result = await actualCommit(contract, snapshot)
      startResults.push(result)
      return result
    }
    Object.assign(controller as unknown as Record<string, unknown>, { reachRuntime: runtime, running: true })
    const internals = controller as unknown as Record<string, any>
    // The legacy GoalQueue is empty in this tick. Keep its compatibility focus
    // unknown so ordinary grounded affordance generation includes both sensed
    // log sources; the separate VTR Mission remains explicitly oak_log.
    internals.goal = {
      id: 'no-legacy-focus', description: 'no legacy focus', targetItem: null,
      requiredCount: 0, startCount: 0, haveCount: 0, progress: 0, complete: false, startedAtMs: 0,
    }
    internals.summonLlm = () => undefined
    internals.syncQueue = () => undefined
    internals.syncGoalToQueue = () => undefined
    internals.reachabilityGateOptions = () => ({ pathProbe: () => 'reachable', stationApproach: null })

    const fakePolicy = {
      kind: 'typesafe',
      model: 'fixture-policy',
      decide: async (request: { candidates: readonly Candidate[] }): Promise<JevResult> => {
        const offered = [...request.candidates]
        policyOffers.push(offered)
        const unrelated = offered.find((candidate) => candidate.kind === 'MOVE' && candidate.meta.targetBlockName === 'birch_log')
        assert.ok(unrelated, `legacy policy did not receive grounded birch MOVE: ${offered.map(({ id }) => id).join(', ')}`)
        assert.equal(offered.some((candidate) => candidate.kind === 'MOVE' && candidate.meta.targetBlockName === 'oak_log'), false)
        policyChoices.push(unrelated!.id)
        const decision: JevResult = {
          callId: 'full-tick-policy-call',
          policy: 'typesafe',
          source: 'jev',
          model: 'fixture-policy',
          latencyMs: 0,
          usage: null,
          answers: { action: answer(unrelated!.id) },
        }
        return decision
      },
    }
    ;(controller as unknown as Record<string, any>).jev = fakePolicy
    const executor = controller.agent
    ;(executor as unknown as Record<string, any>).claim = (candidate: Candidate) => {
      claims.push(candidate.id)
      return { kept: true, epoch: claims.length, completion: Promise.resolve({}) }
    }

    const tick = (JevController.prototype as unknown as {
      tick(this: JevController, trigger: 'heartbeat', detail: Record<string, unknown>): Promise<void>
    }).tick
    await tick.call(controller, 'heartbeat', {})

    assert.equal(policyOffers.length, 1)
    assert.ok(
      policyOffers[0]!.some((candidate) => candidate.kind === 'MOVE' && candidate.meta.targetBlockName === 'birch_log'),
      `policy offer was ${policyOffers[0]!.map((candidate) => `${candidate.id}:${candidate.kind}:${String(candidate.meta.targetBlockName)}`).join(', ')}`,
    )
    assert.equal(policyOffers[0]!.some((candidate) => candidate.kind === 'MOVE' && candidate.meta.targetBlockName === 'oak_log'), false)
        assert.equal(policyChoices[0], policyOffers[0]!.find((candidate) => candidate.meta.targetBlockName === 'birch_log')?.id)
    assert.equal(vtrSnapshotRoutes.length, 1)
    assert.ok(vtrSnapshotRoutes[0]!.some((routeId) => routeId.startsWith('MOVE:b8_64_0')))
    assert.equal(startResults.length, 1)
    assert.equal(startResults[0]?.status, 'refused')
    assert.match(startResults[0]?.reason ?? '', /unconsumed typed terminal outcome/)
    assert.ok(events.some(({ event, detail }) =>
      event.includes('VTR_LEGACY_REACH_MOVE_WITHHELD') &&
      JSON.stringify(detail).includes('MOVE:b8_64_0'),
    ))
    assert.equal(events.some(({ event }) => event.includes('VTR_TRANSITION_ACTUATION')), false)
    assert.equal(claims.length, 1)
    assert.match(claims[0]!, /^MOVE:b/)
    assert.equal(policyOffers[0]!.some((candidate) => candidate.id === claims[0]), true)
    assert.equal(policyOffers[0]!.find((candidate) => candidate.id === claims[0])?.meta.targetBlockName, 'birch_log')
    assert.equal(controller.lastDecisionCandidateId, claims[0])
    assert.equal((controller as unknown as Record<string, any>).reachRuntime.current, null)
  } finally {
    if (controller !== null) (controller as unknown as Record<string, any>).running = false
    rmSync(logDir, { recursive: true, force: true })
  }
})
