// test-stale-drop-cells.mts - a remembered cell is a route only while the thing
// it CLAIMS is still true in the world.
//
// Measured live shape (resident run-mucaq28q-1ftq1, main 99f0020, Nether):
//
//   HEARTBEAT 06:42:46 pos=24.7,60.2,-2.8 health=3.58 rung=blaze_rods action=RETRIEVE
//   offer: ['MOVE:b39_59_-22','ACCESS:b35_60_-22','ACCESS:b37_58_-21', ...]
//   actions: RETRIEVE:known:blaze_rod:b39_59_-20 phase=digging|approaching
//   MOB_DROP_SOURCE_NONE item=blaze_rod reason=no_producer_sensed   (9x, sensed=0)
//
// The memory cell was the fortress FABRIC (`nether_bricks`, recorded from a
// sighting by #342), offered as a `blaze_rod` deposit route. Every block was
// still standing, so no staleness rule fired (`KNOWN_RESOURCE_STALE` only ever
// named obsidian/coal/copper in that run), no retire marker fired, and the body
// kept walking to fortress cells while the run's OWN entity sensor reported that
// no blaze existed anywhere in its envelope. The prior run shows the same shape
// for raw_iron (`observable=false progressDelta=0 execution=failure`).
//
// The rule fixed here is the CLAIM, not the item: a remembered cell must be
// verified against what it asserts, and when the loaded world contradicts it the
// cell is invalidated (`block_mined` -> durable removal) or withheld with a typed
// reason (`mob_gone` / `drop_absent` -> the landmark may still be real). A cell
// that is merely UNREACHABLE keeps its existing bounded retire behaviour, and an
// UNOBSERVABLE cell (unloaded chunk / outside the entity envelope) is never
// "gone": unknown is not absence.
//
// Cases:
//   (a) an ore cell the loaded world reads as air -> falsified/block_mined, no
//       RETRIEVE offer, and the durable store drops the cell (mob_gone/drop_absent
//       never delete the landmark);
//   (a) a fortress landmark with no producer inside the entity envelope ->
//       falsified/mob_gone and no RETRIEVE:known:blaze_rod offer (the measured
//       live shape), while the sensed structure route stays available;
//   (b) the same landmark outside the envelope (unloaded / too far) -> unknown,
//       route kept; a present cell below the retire limit -> offered, and the
//       retire boundary still needs its bounded attempts (no premature retire);
//   (c) a sensed producer (or a sensed dropped item) -> present + offered again;
//   (d) no memory -> the offer is byte-identical to the pre-change baseline.
//
// Run: bun test ./test-stale-drop-cells.mts

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import {
  defaultCandidateOptions,
  formatResourceSourceGap,
  generateCandidates,
  generateGroundedCandidates,
} from '../jev-agent/src/candidates.ts'
import { emptyGoalQueueState } from '../jev-agent/src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import {
  buildWorldState,
  defaultSensorOptions,
  makeGoal,
  probeKnownResources,
} from '../jev-agent/src/state.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, KnownResourceEvidence, SelfState, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import { knownResourceFalsifiedRemovals } from './generation-entry.ts'
import type { KnownResourceJson } from './resident-types.ts'
import {
  decideKnownRetrieve,
  formatKnownResourceFalsified,
  formatKnownResourceResighted,
  formatKnownResourceRetired,
  nextKnownResourceVerdict,
} from '../jev-agent/src/controller-legacy.ts'
import { formatSkillEnd, formatSkillInterrupt } from '../jev-agent/src/netherPortalPlan.ts'
import type { KnownResourceVerdictLatch } from '../jev-agent/src/controller-legacy.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// --- the measured Nether layout ------------------------------------------------

/** The live heartbeat cell (run-mucaq28q-1ftq1). */
const BOT_POS: Vec3Json = { x: 24.7, y: 60, z: -2.8 }
/** The live offered/selected fortress fabric cells (nether_bricks). */
const FORTRESS_CELLS: Vec3Json[] = [
  { x: 39, y: 59, z: -20 },
  { x: 37, y: 58, z: -21 },
  { x: 35, y: 60, z: -22 },
]

/** The prior run's remembered raw_iron cells (`observable=false progressDelta=0`). */
const ORE_CELL: Vec3Json = { x: 24, y: 22, z: 11 }

function cellKey(position: Vec3Json): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function netherGround(): Vec3Json[] {
  const out: Vec3Json[] = []
  for (let x = 20; x <= 42; x += 1) {
    for (let z = -24; z <= 4; z += 1) out.push({ x, y: 58, z })
  }
  return out
}

/**
 * Sensor double with explicit world truth, mirroring the resident shape:
 *   - `world`    cell -> block name (loaded);
 *   - `unloaded` cells read null (chunk not loaded) and must stay `unknown`;
 *   - `sensed`   block name -> positions `findBlocks` reports (also loaded);
 *   - `entities` the live entity map (`bot.entities`), the producer envelope.
 */
function fakeBot(opts: {
  position?: Vec3Json
  dimension?: string
  world?: Record<string, string>
  unloaded?: Vec3Json[]
  sensed?: Record<string, Vec3Json[]>
  entities?: Record<string, { name: string; kind?: string; position: Vec3Json; getDroppedItem?: () => { name?: string } | null }>
  counts?: Record<string, number>
}): Parameters<typeof buildWorldState>[0] {
  const position = opts.position ?? BOT_POS
  const dimension = opts.dimension ?? 'minecraft:the_nether'
  const botPosition = new Vec3(position.x, position.y, position.z)
  const world = new Map<string, string>(Object.entries(opts.world ?? {}))
  const unloaded = new Set((opts.unloaded ?? []).map(cellKey))
  for (const cell of netherGround()) if (!world.has(cellKey(cell))) world.set(cellKey(cell), 'netherrack')
  for (const [name, positions] of Object.entries(opts.sensed ?? {})) {
    for (const p of positions) world.set(cellKey(p), name)
  }
  const blockAt = (p: { x: number; y: number; z: number }) => {
    const cell = cellKey(p)
    if (unloaded.has(cell)) return null
    const name = world.get(cell)
    if (name === undefined) return { name: 'air', boundingBox: 'empty', diggable: false }
    return { name, boundingBox: 'block', diggable: true }
  }
  const findBlocks = (options: { matching: (block: { name: string }) => boolean; maxDistance: number; count: number }): unknown[] => {
    const origin = new Vec3(Math.floor(botPosition.x), Math.floor(botPosition.y), Math.floor(botPosition.z))
    const out: unknown[] = []
    for (const [cell, name] of world) {
      if (!options.matching({ name })) continue
      const [x, y, z] = cell.split(',').map(Number)
      const block = new Vec3(x, y, z)
      if (block.distanceTo(origin) <= options.maxDistance) out.push(block)
    }
    return out.slice(0, options.count)
  }
  const entities: Record<string, unknown> = {}
  for (const [id, entity] of Object.entries(opts.entities ?? {})) {
    entities[id] = {
      id: Number(id),
      name: entity.name,
      kind: entity.kind ?? 'Hostile',
      username: null,
      position: new Vec3(entity.position.x, entity.position.y, entity.position.z),
      isValid: true,
      ...(entity.getDroppedItem === undefined ? {} : { getDroppedItem: entity.getDroppedItem }),
    }
  }
  const items = Object.entries(opts.counts ?? {}).map(([name, count], slot) => ({ name, count, slot }))
  return {
    username: 'AI_STALECELL',
    entity: { id: 1, position: botPosition, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension, minY: dimension === 'minecraft:the_nether' ? 0 : -64, height: 384 },
    time: { isDay: true },
    registry,
    entities,
    inventory: { items: () => items },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
  } as never
}

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
    ...overrides,
  }
}

function queuedGoal(targetItem: string, requiredCount = 1): QueuedGoal {
  return {
    id: `g1:collect:${targetItem}`,
    kind: 'collect',
    description: `collect ${requiredCount} x ${targetItem}`,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function perceive(
  bot: Parameters<typeof buildWorldState>[0],
  item: string,
  known: KnownResource[],
  count = 1,
): WorldState {
  return buildWorldState(
    bot,
    {
      tick: 1,
      goal: makeGoal(item, count),
      goalQueue: queueWith(queuedGoal(item, count)),
      focusItem: item,
      retrievalItems: [item],
      recentEvents: [],
      signals: signals({ knownResources: known }),
    },
    defaultSensorOptions,
  )
}

const reachableOptions = {
  ...defaultCandidateOptions,
  reachability: { memory: null, pathProbe: () => 'reachable' as const },
}

function grounded(state: WorldState): ReturnType<typeof generateGroundedCandidates> {
  return generateGroundedCandidates(state, reachableOptions)
}

function allIds(result: ReturnType<typeof generateGroundedCandidates>): string[] {
  return [...result.candidates.map((candidate) => candidate.id), ...result.withheld.map((entry) => entry.candidate.id)]
}

function evidenceFor(state: WorldState, name: string): KnownResourceEvidence | undefined {
  return (state.knownResourceEvidence ?? []).find((entry) => entry.name === name)
}

function fortressMemories(cells: Vec3Json[]): KnownResource[] {
  return cells.map((position) => ({ name: 'nether_bricks', kind: 'ore', position, dimension: 'minecraft:the_nether', worldEpoch: 1 }))
}

// --- (a) proven absent: block arm ----------------------------------------------

addCase('(a) an ore cell the loaded world reads as air is falsified/block_mined and yields no route', () => {
  const known: KnownResource[] = [{ name: 'iron_ore', kind: 'ore', position: ORE_CELL, dimension: 'minecraft:overworld' }]
  const state = perceive(fakeBot({ position: { x: 24.5, y: 23, z: 31.5 }, dimension: 'minecraft:overworld', world: { [cellKey(ORE_CELL)]: 'air' }, counts: { stone_pickaxe: 1 } }), 'raw_iron', known, 3)
  const evidence = evidenceFor(state, 'iron_ore')
  const result = grounded(state)
  const ids = allIds(result).filter((id) => id.startsWith('RETRIEVE:known:raw_iron:'))
  return {
    pass:
      evidence?.status === 'falsified' &&
      evidence.reason === 'block_mined' &&
      evidence.claim === 'block' &&
      (state.signals.knownResources ?? []).length === 0 &&
      ids.length === 0,
    detail: `status=${evidence?.status} reason=${evidence?.reason} kept=${(state.signals.knownResources ?? []).length} routes=${ids.join(',') || 'none'}`,
  }
})

addCase('(a) a loaded variant still verifies, and an unloaded cell stays unknown (no false falsification)', () => {
  const known: KnownResource[] = [{ name: 'iron_ore', kind: 'ore', position: ORE_CELL, dimension: 'minecraft:overworld' }]
  const present = perceive(fakeBot({ position: { x: 24.5, y: 23, z: 31.5 }, dimension: 'minecraft:overworld', world: { [cellKey(ORE_CELL)]: 'deepslate_iron_ore' }, counts: { stone_pickaxe: 1 } }), 'raw_iron', known, 3)
  const unloaded = perceive(fakeBot({ position: { x: 24.5, y: 23, z: 31.5 }, dimension: 'minecraft:overworld', unloaded: [ORE_CELL], counts: { stone_pickaxe: 1 } }), 'raw_iron', known, 3)
  const variant = evidenceFor(present, 'iron_ore')
  const missing = evidenceFor(unloaded, 'iron_ore')
  return {
    pass:
      variant?.status === 'replaced' &&
      missing?.status === 'unknown' &&
      missing.observed === null &&
      (unloaded.signals.knownResources ?? []).length === 1,
    detail: `variant=${variant?.status} unloaded=${missing?.status} kept=${(unloaded.signals.knownResources ?? []).length}`,
  }
})

addCase('(a) a block whose name equals its item (obsidian) is a block claim, not a drop', () => {
  // `obsidian` is both the block and the item name: an identity match must not
  // turn a mine into a drop claim.
  const bot = fakeBot({
    position: { x: 12.5, y: 41, z: -6.5 },
    dimension: 'minecraft:overworld',
    world: { '12,40,-7': 'obsidian' },
    counts: { diamond_pickaxe: 1 },
  })
  const state = perceive(
    bot,
    'obsidian',
    [{ name: 'obsidian', kind: 'ore', position: { x: 12, y: 40, z: -7 }, dimension: 'minecraft:overworld' }],
    10,
  )
  const evidence = evidenceFor(state, 'obsidian')
  return {
    pass: evidence?.status === 'present' && evidence.claim === 'block' && evidence.source === undefined,
    detail: `status=${evidence?.status} claim=${evidence?.claim} source=${evidence?.source ?? 'none'}`,
  }
})

// --- (a) proven absent: producer/drop arm (the measured live shape) -------------

addCase('(a) a fortress landmark with no producer in the envelope is falsified/mob_gone and offers no blaze_rod route', () => {
  const state = perceive(fakeBot({ sensed: { nether_bricks: FORTRESS_CELLS }, entities: {}, counts: { stone_pickaxe: 1 } }), 'blaze_rod', fortressMemories(FORTRESS_CELLS))
  const evidence = evidenceFor(state, 'nether_bricks')
  const result = grounded(state)
  const ids = allIds(result).filter((id) => id.startsWith('RETRIEVE:known:blaze_rod:'))
  const structureRoutes = result.candidates.filter((candidate) => candidate.kind === 'MOVE' && candidate.targetName === 'nether_bricks')
  return {
    pass:
      evidence?.status === 'falsified' &&
      evidence.reason === 'mob_gone' &&
      evidence.claim === 'producer' &&
      ids.length === 0 &&
      result.mobDropGap?.reason === 'no_producer_sensed' &&
      structureRoutes.length > 0,
    detail: `status=${evidence?.status} reason=${evidence?.reason} blazeRoutes=${ids.join(',') || 'none'} structureRoutes=${structureRoutes.length} gap=${result.mobDropGap?.reason ?? 'none'}`,
  }
})

addCase('(a) a drop cell nothing holds is falsified/drop_absent and offers no route', () => {
  const drop: KnownResource[] = [{ name: 'blaze_rod', kind: 'ore', position: { x: 30, y: 60, z: -10 }, dimension: 'minecraft:the_nether' }]
  const state = perceive(fakeBot({ entities: {} }), 'blaze_rod', drop)
  const evidence = state.knownResourceEvidence?.[0]
  const ids = allIds(grounded(state)).filter((id) => id.startsWith('RETRIEVE:known:blaze_rod:'))
  return {
    pass: evidence?.status === 'falsified' && evidence.reason === 'drop_absent' && evidence.claim === 'drop' && ids.length === 0,
    detail: `status=${evidence?.status} reason=${evidence?.reason} claim=${evidence?.claim} routes=${ids.join(',') || 'none'}`,
  }
})

// --- (a) durable invalidation ---------------------------------------------------

const DURABLE: KnownResourceJson[] = [
  { name: 'iron_ore', kind: 'ore', x: ORE_CELL.x, y: ORE_CELL.y, z: ORE_CELL.z, dimension: 'minecraft:overworld' },
  { name: 'nether_bricks', kind: 'ore', x: FORTRESS_CELLS[0]!.x, y: FORTRESS_CELLS[0]!.y, z: FORTRESS_CELLS[0]!.z, dimension: 'minecraft:the_nether' },
]

addCase('(a) block_mined removes the durable cell; mob_gone/drop_absent only withhold it', () => {
  // #14: `block_mined` is a proof about the world that was probed, so only a row
  // attributable to THAT world is removed. The iron_ore row names the overworld,
  // which is the live dimension here.
  const blockMined = knownResourceFalsifiedRemovals(DURABLE, { reason: 'block_mined', cell: ORE_CELL }, 'minecraft:overworld')
  const mobGone = knownResourceFalsifiedRemovals(DURABLE, { reason: 'mob_gone', cell: FORTRESS_CELLS[0] }, 'minecraft:the_nether')
  const dropAbsent = knownResourceFalsifiedRemovals(DURABLE, { reason: 'drop_absent', cell: FORTRESS_CELLS[0] }, 'minecraft:the_nether')
  const noCell = knownResourceFalsifiedRemovals(DURABLE, { reason: 'block_mined' }, 'minecraft:overworld')
  // A `block_mined` proof read in the NETHER cannot delete the overworld row: the
  // coordinate is a different place in a different world.
  const wrongWorld = knownResourceFalsifiedRemovals(DURABLE, { reason: 'block_mined', cell: ORE_CELL }, 'minecraft:the_nether')
  // An un-attributed row is never deleted on any world's proof.
  const unattributed: KnownResourceJson[] = [{ name: 'iron_ore', kind: 'ore', x: ORE_CELL.x, y: ORE_CELL.y, z: ORE_CELL.z }]
  const noDimension = knownResourceFalsifiedRemovals(unattributed, { reason: 'block_mined', cell: ORE_CELL }, 'minecraft:overworld')
  return {
    pass:
      blockMined.length === 1 &&
      blockMined[0]?.name === 'iron_ore' &&
      mobGone.length === 0 &&
      dropAbsent.length === 0 &&
      noCell.length === 0 &&
      wrongWorld.length === 0 &&
      noDimension.length === 0,
    detail: `blockMined=${blockMined.map((entry) => `${entry.name}@${entry.x},${entry.y},${entry.z}`).join(',') || 'none'} mobGone=${mobGone.length} dropAbsent=${dropAbsent.length} noCell=${noCell.length} wrongWorld=${wrongWorld.length} noDimension=${noDimension.length}`,
  }
})

// --- (b) merely unreachable / unobservable -------------------------------------

addCase('(b) a landmark outside the entity envelope stays unknown and keeps its route', () => {
  const far: Vec3Json = { x: 90, y: 59, z: -20 }
  const state = perceive(fakeBot({ sensed: { nether_bricks: [far] }, entities: {}, counts: { stone_pickaxe: 1 } }), 'blaze_rod', fortressMemories([far]))
  const evidence = evidenceFor(state, 'nether_bricks')
  const ids = allIds(grounded(state)).filter((id) => id.startsWith('RETRIEVE:known:blaze_rod:'))
  const unloadedState = perceive(
    fakeBot({ sensed: { nether_bricks: FORTRESS_CELLS }, unloaded: FORTRESS_CELLS, entities: {}, counts: { stone_pickaxe: 1 } }),
    'blaze_rod',
    fortressMemories(FORTRESS_CELLS),
  )
  const unloadedEvidence = evidenceFor(unloadedState, 'nether_bricks')
  const unloadedIds = allIds(grounded(unloadedState)).filter((id) => id.startsWith('RETRIEVE:known:blaze_rod:'))
  return {
    pass:
      evidence?.status === 'unknown' &&
      unloadedEvidence?.status === 'unknown' &&
      ids.length === 1 &&
      unloadedIds.length === 1,
    detail: `far=${evidence?.status}(${ids.length} route) unloaded=${unloadedEvidence?.status}(${unloadedIds.length} route)`,
  }
})

addCase('(b) a present-but-unreachable remembered cell is still offered and retires only at the bounded limit', () => {
  const known: KnownResource[] = [{ name: 'iron_ore', kind: 'ore', position: ORE_CELL, dimension: 'minecraft:overworld' }]
  const state = perceive(fakeBot({ position: { x: 24.5, y: 23, z: 31.5 }, dimension: 'minecraft:overworld', world: { [cellKey(ORE_CELL)]: 'iron_ore' }, counts: { stone_pickaxe: 1 } }), 'raw_iron', known, 3)
  const evidence = evidenceFor(state, 'iron_ore')
  const ids = allIds(grounded(state)).filter((id) => id.startsWith('RETRIEVE:known:raw_iron:'))
  return {
    pass: evidence?.status === 'present' && ids.length === 1,
    detail: `status=${evidence?.status} routes=${ids.join(',') || 'none'}`,
  }
})

addCase('(b) the retire boundary is attempt-bounded and typed (no premature retirement)', () => {
  const charge = decideKnownRetrieveCase(0)
  const retire = decideKnownRetrieveCase(1)
  return {
    pass:
      charge.kind === 'charge' &&
      charge.attempts === 1 &&
      retire.kind === 'retire' &&
      retire.attempts === 2 &&
      retire.line === 'KNOWN_RESOURCE_RETIRED item=raw_iron cell=24,22,11 attempts=2',
    detail: `charge=${charge.kind}/${charge.attempts} retire=${retire.kind}/${retire.attempts} line="${retire.line ?? 'none'}"`,
  }
})

// --- (c) re-sighted for real ----------------------------------------------------

addCase('(c) a sensed producer re-verifies the landmark and its route is offered again', () => {
  const bot = fakeBot({
    sensed: { nether_bricks: FORTRESS_CELLS },
    entities: { 7: { name: 'blaze', position: { x: 39, y: 59, z: -19 } } },
    counts: { stone_pickaxe: 1 },
  })
  const state = perceive(bot, 'blaze_rod', fortressMemories(FORTRESS_CELLS))
  const evidence = evidenceFor(state, 'nether_bricks')
  const ids = allIds(grounded(state)).filter((id) => id.startsWith('RETRIEVE:known:blaze_rod:'))
  return {
    pass: evidence?.status === 'present' && evidence.source === 'mob' && ids.length === 1,
    detail: `status=${evidence?.status} source=${evidence?.source} routes=${ids.join(',') || 'none'}`,
  }
})

addCase('(c) a sensed dropped item re-verifies a drop cell', () => {
  const cell: Vec3Json = { x: 30, y: 60, z: -10 }
  const bot = fakeBot({
    entities: {
      9: {
        name: 'item',
        kind: 'Object',
        position: { x: 30, y: 60, z: -10 },
        getDroppedItem: () => ({ name: 'blaze_rod' }),
      },
    },
  })
  const state = perceive(bot, 'blaze_rod', [{ name: 'blaze_rod', kind: 'ore', position: cell, dimension: 'minecraft:the_nether' }])
  const evidence = state.knownResourceEvidence?.[0]
  const ids = allIds(grounded(state)).filter((id) => id.startsWith('RETRIEVE:known:blaze_rod:'))
  return {
    pass: evidence?.status === 'present' && evidence.source === 'drop' && ids.length === 1,
    detail: `status=${evidence?.status} source=${evidence?.source} routes=${ids.join(',') || 'none'}`,
  }
})

addCase('(c) a producer at the cell is verified even when the landmark block itself is gone', () => {
  // The producer is the claim: a cell whose fabric was mined away while a blaze
  // stands there is still a grounded producer location.
  const bot = fakeBot({ entities: { 7: { name: 'blaze', position: { x: FORTRESS_CELLS[0]!.x, y: FORTRESS_CELLS[0]!.y, z: FORTRESS_CELLS[0]!.z } } }, counts: { stone_pickaxe: 1 } })
  const state = perceive(bot, 'blaze_rod', fortressMemories([FORTRESS_CELLS[0]!]))
  const evidence = state.knownResourceEvidence?.[0]
  return {
    pass: evidence?.status === 'present' && evidence.source === 'mob' && evidence.observed === 'air',
    detail: `status=${evidence?.status} source=${evidence?.source} observed=${evidence?.observed}`,
  }
})

addCase('(c) the typed markers name the item, cell and reason', () => {
  const falsified = formatKnownResourceFalsified('blaze_rod', 'nether_bricks', { x: 39, y: 59, z: -20 }, 'mob_gone')
  const resighted = formatKnownResourceResighted('blaze_rod', 'nether_bricks', { x: 39, y: 59, z: -20 }, 'mob')
  return {
    pass:
      falsified === 'KNOWN_RESOURCE_FALSIFIED item=blaze_rod name=nether_bricks cell=39,59,-20 reason=mob_gone' &&
      resighted === 'KNOWN_RESOURCE_RESIGHTED item=blaze_rod name=nether_bricks cell=39,59,-20 source=mob',
    detail: `${falsified} | ${resighted}`,
  }
})

// --- #436 section E: cancellation with a typed outcome --------------------------

addCase('(E) a contradicted target ends the skill with SKILL_END/SKILL_INTERRUPT, never a re-target', () => {
  // `block_mined`/`drop_absent` are the selected target itself disappearing;
  // `mob_gone` is the cell standing while the claim it was chosen for is gone.
  const skillEnd = formatSkillEnd('RETRIEVE(knownResource)', 'cancelled', 'failed', 'block_present', 'block_mined')
  const noFailure = formatSkillEnd('ENTER_PORTAL(portalSite)', 'entered', 'dimension', 'portal_entered')
  const gone = formatSkillInterrupt('RETRIEVE(knownResource)', 'target_gone')
  const contradicted = formatSkillInterrupt('RETRIEVE(knownResource)', 'contradicted')
  return {
    pass:
      skillEnd === 'SKILL_END skill=RETRIEVE(knownResource) execution=cancelled verification=failed postcondition=block_present failure=block_mined' &&
      noFailure === 'SKILL_END skill=ENTER_PORTAL(portalSite) execution=entered verification=dimension postcondition=portal_entered' &&
      gone === 'SKILL_INTERRUPT skill=RETRIEVE(knownResource) reason=target_gone' &&
      contradicted === 'SKILL_INTERRUPT skill=RETRIEVE(knownResource) reason=contradicted',
    detail: `${skillEnd} | ${gone} | ${contradicted}`,
  }
})

addCase('(E) the cancellation is wired into the tick, stops the running skill, and never re-targets', () => {
  const controllerSource = readFileSync(new URL('../jev-agent/src/controller-legacy.ts', import.meta.url), 'utf8')
  const source =
    controllerSource +
    readFileSync(new URL('../jev-agent/src/decision-epochs.ts', import.meta.url), 'utf8').replace(/\bhost\./g, 'this.') +
    readFileSync(new URL('../jev-agent/src/retrieval-progress.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('../jev-agent/src/candidate-diagnostics.ts', import.meta.url), 'utf8')
  const wired = /this\.cancelContradictedSkillTarget\(state\)/.test(source)
  const cancels = /this\.executor\.cancelCurrent\(`contradicted target/.test(source)
  const falsifiedOnly = /evidence\.status === 'falsified' &&/.test(source)
  const noRetarget = !/cancelContradictedSkillTarget[\s\S]{0,3000}RETRIEVAL_ESCALATION/.test(controllerSource)
  const markers = ["SKILL_END", "SKILL_INTERRUPT", "'KNOWN_RESOURCE_FALSIFIED'", "'KNOWN_RESOURCE_RETIRED'"].every(
    (token) => source.includes(token),
  )
  const boundedRetryIntact = /KNOWN_RETRIEVE_RETIRE_LIMIT = 2/.test(source)
  return {
    pass: wired && cancels && falsifiedOnly && noRetarget && markers && boundedRetryIntact,
    detail: `wired=${wired} cancels=${cancels} falsifiedOnly=${falsifiedOnly} noRetarget=${noRetarget} markers=${markers} boundedRetryIntact=${boundedRetryIntact}`,
  }
})

addCase('(E) the verdict latch reports once, RE-ARMS on re-sight, and reports a second contradiction', () => {
  const latch: KnownResourceVerdictLatch = { falsified: new Set(), resighted: new Set() }
  const cell = { x: 24, y: 22, z: 11 }
  const base = { item: 'raw_iron', name: 'iron_ore', position: cell }
  const first = nextKnownResourceVerdict(latch, { ...base, status: 'falsified', reason: 'block_mined' })
  const repeat = nextKnownResourceVerdict(latch, { ...base, status: 'falsified', reason: 'block_mined' })
  // The ore is really there again (a fresh sighting): the latch must re-arm even
  // though a block claim has no re-sight line of its own.
  const present = nextKnownResourceVerdict(latch, { ...base, status: 'present' })
  const rearmed = latch.falsified.size === 0
  const second = nextKnownResourceVerdict(latch, { ...base, status: 'falsified', reason: 'block_mined' })
  // A producer re-sight that followed a withhold gets a line, exactly once.
  const producerLatch: KnownResourceVerdictLatch = { falsified: new Set(), resighted: new Set() }
  nextKnownResourceVerdict(producerLatch, { item: 'blaze_rod', name: 'nether_bricks', position: cell, status: 'falsified', reason: 'mob_gone' })
  const resighted = nextKnownResourceVerdict(producerLatch, { item: 'blaze_rod', name: 'nether_bricks', position: cell, status: 'present', source: 'mob' })
  const resightedAgain = nextKnownResourceVerdict(producerLatch, { item: 'blaze_rod', name: 'nether_bricks', position: cell, status: 'present', source: 'mob' })
  return {
    pass:
      first.kind === 'falsified' &&
      first.reason === 'block_mined' &&
      repeat.kind === 'none' &&
      present.kind === 'none' &&
      rearmed &&
      second.kind === 'falsified' &&
      resighted.kind === 'resighted' &&
      resighted.source === 'mob' &&
      resightedAgain.kind === 'none',
    detail: `first=${first.kind} repeat=${repeat.kind} present=${present.kind} rearmed=${rearmed} second=${second.kind} resighted=${resighted.kind} resightedAgain=${resightedAgain.kind}`,
  }
})

// --- (d) no memory: byte-identical offer ---------------------------------------

function baselineSelf(position: Vec3Json): SelfState {
  return {
    username: 'AI_STALE',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:overworld',
    isDay: true,
    heldItem: null,
  }
}

function baselineInventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function baselineGoal(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 3 x ${targetItem}`,
    targetItem,
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function baselineStone(position: Vec3Json): BlockState {
  return {
    kind: 'stone',
    name: 'stone',
    position,
    distance: 2,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y + 1, z: position.z },
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 1,
  }
}

/** A no-memory state, identical in shape to the baseline capture below. */
function baselineState(targetItem: string): WorldState {
  const position: Vec3Json = { x: 0.5, y: 60, z: 0.5 }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: baselineSelf(position),
    inventory: baselineInventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [baselineStone({ x: 0, y: 59, z: 0 }), baselineStone({ x: 3, y: 59, z: 0 })],
    terrain: { standable: [position, { x: 3, y: 60, z: 0 }, { x: 0, y: 60, z: 3 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: baselineGoal(targetItem),
    goalQueue: queueWith(queuedGoal(targetItem, 3)),
    recentEvents: [],
    signals: signals({ knownResources: [] }),
  }
}

addCase('(d) no memory -> the offer is byte-identical to the main baseline', () => {
  // Captured by running this exact state against unmodified main (99f0020)
  // before the verification rule existed.
  const golden = ['MOVE:p3_60_0', 'MOVE:p0_60_3', 'WAIT']
  const iron = generateCandidates(baselineState('raw_iron'), defaultCandidateOptions).map((candidate) => candidate.id)
  const blaze = generateCandidates(baselineState('blaze_rod'), defaultCandidateOptions).map((candidate) => candidate.id)
  return {
    pass: JSON.stringify(iron) === JSON.stringify(golden) && JSON.stringify(blaze) === JSON.stringify(golden),
    detail: `raw_iron=${JSON.stringify(iron)} blaze_rod=${JSON.stringify(blaze)}`,
  }
})

addCase('(d) a typed no-source gap still names the falsified memory on the way out', () => {
  const known: KnownResource[] = [{ name: 'obsidian', kind: 'ore', position: { x: 12, y: 40, z: -7 }, dimension: 'minecraft:overworld' }]
  const state = perceive(
    fakeBot({ position: { x: 12.5, y: 41, z: -6.5 }, dimension: 'minecraft:overworld', world: { '12,40,-7': 'stone' } }),
    'obsidian',
    known,
    10,
  )
  const result = grounded(state)
  const gap = result.sourceGap
  return {
    pass: gap !== null && gap.reason === 'remembered_falsified' && formatResourceSourceGap(gap).startsWith('RESOURCE_SOURCE_NONE item=obsidian reason=remembered_falsified'),
    detail: gap === null ? 'no gap' : formatResourceSourceGap(gap),
  }
})

// --- helpers that need the controller's pure boundary ---------------------------

function decideKnownRetrieveCase(previousAttempts: number): {
  kind: string
  attempts: number
  line?: string
} {
  const decision = decideKnownRetrieve({
    retrieval: 'known',
    target: { x: 24, y: 22, z: 11 },
    result: { status: 'done', verified: false, itemsGained: 0, blockRemoved: false, progressed: false },
    previousAttempts,
  })
  return {
    kind: decision.kind,
    attempts: 'attempts' in decision ? decision.attempts : 0,
    ...(decision.kind === 'retire'
      ? { line: formatKnownResourceRetired('raw_iron', { x: 24, y: 22, z: 11 }, decision.attempts) }
      : {}),
  }
}

let failed = 0
for (const testCase of cases) {
  let result: { pass: boolean; detail: string }
  try {
    result = testCase.run()
  } catch (error) {
    result = { pass: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!result.pass) failed += 1
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${testCase.name}${result.pass ? '' : ` :: ${result.detail}`}`)
}
console.log('------------------------------------------------------------------------')
console.log(`${cases.length - failed}/${cases.length} stale-drop-cell cases passed`)
if (failed > 0) process.exit(1)
