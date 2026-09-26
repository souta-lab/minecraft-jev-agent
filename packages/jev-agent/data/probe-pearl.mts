// probe-pearl.mts - MEASURE (before/after) what a `collect 12 x ender_pearl`
// goal can actually offer. Read-only probe: it prints the offered candidate set
// and the typed facts for each shape the pearl route must handle.
//
//   bun jev-agent/data/probe-pearl.mts
import { createRequire } from 'node:module'
import { createRecipeIndex } from '../src/crafting.ts'
import {
  defaultCandidateOptions,
  formatExploreRouteBlocked,
  formatMobDropSourceGap,
  formatResourceSourceGap,
  generateGroundedCandidates,
} from '../src/candidates.ts'
import type { ReachabilityGateOptions } from '../src/candidates.ts'
import { scannedBlockNames } from '../src/state.ts'
import type { BlockState, EntityState, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from '../src/state.ts'
import type { GoalQueueState, QueuedGoal } from '../src/goalQueue.ts'

const require = createRequire(import.meta.url)
const RECIPES = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }
const FRONTIER: Vec3Json[] = [
  SELF,
  { x: 3, y: 61, z: 0 },
  { x: 0, y: 61, z: 3 },
  { x: -3, y: 61, z: 0 },
  { x: 0, y: 61, z: -3 },
  { x: 3, y: 61, z: 3 },
]

function selfState(dimension: string): SelfState {
  return {
    username: 'AI_PEARL',
    position: SELF,
    eyePosition: { x: SELF.x, y: SELF.y + 1.62, z: SELF.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension,
    isDay: true,
    heldItem: null,
  }
}

function goalState(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 12 x ${targetItem}`,
    targetItem,
    requiredCount: 12,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string): QueuedGoal {
  return {
    id: `g1:collect:${targetItem}`,
    kind: 'collect',
    description: `collect 12 x ${targetItem}`,
    targetItem,
    requiredCount: 12,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queue(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function enderman(distance: number, position: Vec3Json): EntityState {
  return {
    id: 31,
    name: 'enderman',
    kind: 'hostile',
    username: null,
    position,
    distance,
    hostile: true,
    lineOfSight: true,
  }
}

function build(input: {
  dimension: string
  blocks?: BlockState[]
  entities?: EntityState[]
  standable?: Vec3Json[]
}): WorldState {
  const current = queuedGoal('ender_pearl')
  const inventory: InventoryState = { slots: [], counts: { diamond_sword: 1, diamond_pickaxe: 1 }, totalItems: 2 }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(input.dimension),
    inventory,
    entities: input.entities ?? [],
    blocks: input.blocks ?? [],
    terrain: { standable: input.standable ?? FRONTIER },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState('ender_pearl'),
    goalQueue: queue(current),
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: [],
    },
  }
}

function options(): typeof defaultCandidateOptions & {
  recipes: ReturnType<typeof createRecipeIndex>
  reachability: ReachabilityGateOptions
} {
  return {
    ...defaultCandidateOptions,
    recipes: RECIPES,
    reachability: { memory: null, pathProbe: () => 'reachable' },
  }
}

function dump(name: string, state: WorldState): void {
  const grounded = generateGroundedCandidates(state, options())
  const ids = grounded.candidates.map((c) => c.id)
  const attacks = grounded.candidates.filter((c) => c.kind === 'ATTACK')
  process.stdout.write(`\n== ${name}\n`)
  process.stdout.write(`   dimension=${state.self.dimension} entities=${state.entities.length}\n`)
  process.stdout.write(`   scannedBlockNames(ender_pearl)=${JSON.stringify(scannedBlockNames('ender_pearl') ?? null)}\n`)
  process.stdout.write(`   offered(${ids.length})=${JSON.stringify(ids)}\n`)
  process.stdout.write(`   withheld=${JSON.stringify(grounded.withheld.map((w) => `${w.candidate.id}:${w.result.reason}`))}\n`)
  for (const attack of attacks) {
    process.stdout.write(
      `   ATTACK ${attack.id} label="${attack.label}" meta=${JSON.stringify(attack.meta)}\n`,
    )
  }
  process.stdout.write(
    `   exploreRouteBlocked=${grounded.exploreRouteBlocked === null ? 'none' : formatExploreRouteBlocked(grounded.exploreRouteBlocked)}\n`,
  )
  const gap = (
    grounded as unknown as { resourceSourceGap?: unknown }
  ).resourceSourceGap
  process.stdout.write(
    `   resourceSourceGap=${gap === undefined || gap === null ? 'none' : formatResourceSourceGap(gap as never)}\n`,
  )
  const mobGap = grounded.mobDropGap
  process.stdout.write(
    `   mobDropGap=${mobGap === null ? 'none' : formatMobDropSourceGap(mobGap)}\n`,
  )
}

process.stdout.write('MEASURE: what a `collect 12 x ender_pearl` goal offers today\n')

// (a) one sensed enderman inside melee/hunt range
dump('(a) pearl goal, enderman sensed at 6m', build({
  dimension: 'minecraft:overworld',
  entities: [enderman(6, { x: 6, y: 61, z: 0 })],
}))

// (b) nothing sensed at all
dump('(b) pearl goal, nothing sensed', build({ dimension: 'minecraft:overworld' }))

// (b2) Nether, nothing sensed (the M3 shape after nether_reached)
dump('(b2) pearl goal, the_nether, nothing sensed', build({ dimension: 'minecraft:the_nether' }))

// (d) the same sighting in the Nether: must stay generic
dump('(d) pearl goal, the_nether, enderman sensed at 6m', build({
  dimension: 'minecraft:the_nether',
  entities: [enderman(6, { x: 6, y: 61, z: 0 })],
}))

// (e) the teleport shape: the only enderman is far outside melee range
dump('(e) pearl goal, enderman sensed at 24m', build({
  dimension: 'minecraft:the_nether',
  entities: [enderman(24, { x: 24, y: 61, z: 0 })],
}))
