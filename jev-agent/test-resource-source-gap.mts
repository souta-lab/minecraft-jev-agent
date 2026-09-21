// test-resource-source-gap.mts - the general "a remembered resource the loaded
// world contradicts is not a route" regression, plus the typed no-source gap.
//
// Live defect (source de1e98c, resident in the m3-live worktree):
//
//   probe bot AI_M3CELLS over the remembered frame region (x 0..6, y 58..64,
//   z -5..0) reported stone where the resident's durable memory still held
//   obsidian:
//     {"event":"cell_probe","obsidian":[],"counts":{"stone":281,...}}
//   => `collect 10 x obsidian` kept offering `RETRIEVE:known:obsidian:<stale>`
//      routes, so the body walked to cells that no longer hold obsidian, while
//      the only remaining obsidian (the LIT portal frame) is correctly refused
//      by the live-structure guard, and no typed "there is no source" fact was
//      ever surfaced.
//
// The fix is world truth, not an obsidian rule:
//   * `state.ts#probeKnownResources` reads the actual block at every remembered
//     resource cell matching the active focus. `bot.blockAt` returns null for an
//     unloaded chunk, so a far-but-loaded REPLACEMENT (stone where obsidian was)
//     is proof while an unloaded cell stays `unknown`. Falsified cells are
//     removed from `signals.knownResources`;
//   * `candidates.ts#resourceSourceGapFor` reports the typed
//     `RESOURCE_SOURCE_NONE item=<item> reason=... next=explore|escalate` fact
//     when no source route survived, so escalation does not depend on a silent
//     stale retarget loop.
//
// The predicate names no item: obsidian is only the measured focus.
//
// Cases:
//   (a) a remembered cell the loaded world reads as a DIFFERENT solid block is
//       falsified and produces no route, with typed evidence;
//   (a) the same cell in an UNLOADED chunk stays `unknown` and keeps its route
//       (no false falsification);
//   (a) a directly-built state with falsified evidence and the stale entry still
//       present is still refused by the candidate layer (defense in depth);
//   (b) a genuinely sensed obsidian block yields a grounded route and no gap;
//   (b) a remembered obsidian cell the world CONFIRMS yields the RETRIEVE;
//   (c) no sensed and no remembered source -> typed `no_source_sensed` gap with
//       `next=explore` and grounded exploration candidates, never WAIT-only;
//   (c) every remembered source falsified -> typed `remembered_falsified` gap;
//   (c) only live-structure members remain -> typed `live_structure` gap.
//
// Run: bun test-resource-source-gap.mts
import { createRequire } from 'node:module'
import {
  defaultCandidateOptions,
  formatResourceSourceGap,
  generateGroundedCandidates,
  resourceSourceGapFor,
  resourceSourceExclusions,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { AgentSignals, KnownResource, Vec3Json, WorldState } from './src/state.ts'

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

type Bot = Parameters<typeof buildWorldState>[0]

/** The live resident cell the starvation line walked around (y=67 surface). */
const BOT_POS: Vec3Json = { x: 55.7, y: 67.0, z: -2.5 }
/** The stale remembered obsidian cells from the measured probe (now stone). */
const STALE_CELLS: Vec3Json[] = [
  { x: 3, y: 60, z: -1 },
  { x: 3, y: 61, z: -2 },
  { x: 3, y: 62, z: -3 },
  { x: 3, y: 60, z: -4 },
]
/** A sensed obsidian block pickup-adjacent to BOT_POS (ground at y=65). */
const SENSED_POS: Vec3Json = { x: 56, y: 66, z: -3 }
/** A remembered obsidian cell the world still confirms, beyond the 8m proxy. */
const CONFIRMED_CELL: Vec3Json = { x: 60, y: 67, z: -14 }

function key(position: Vec3Json): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

/** Solid ground under the whole area so `findAdjacentStandable`/terrain resolve. */
function groundCells(): Vec3Json[] {
  const out: Vec3Json[] = []
  for (let x = 52; x <= 62; x += 1) {
    for (let z = -8; z <= 4; z += 1) out.push({ x, y: 65, z })
  }
  return out
}

/**
 * Sensor double with explicit world truth:
 *   - `world`    cell -> block name (solid, loaded);
 *   - `unloaded` cells read as null (chunk not loaded) - the discriminator that
 *                must NOT be treated as "resource gone";
 *   - `sensed`   block name -> positions `findBlocks` reports;
 *   - everything else is air, so the historical fixtures' shape is preserved.
 */
function fakeBot(opts: {
  position?: Vec3Json
  world?: Record<string, string>
  unloaded?: Vec3Json[]
  sensed?: Record<string, Vec3Json[]>
  counts?: Record<string, number>
}): Bot {
  const position = opts.position ?? BOT_POS
  const botPosition = new Vec3(position.x, position.y, position.z)
  const world = new Map<string, string>(Object.entries(opts.world ?? {}))
  const unloaded = new Set((opts.unloaded ?? []).map(key))
  for (const cell of groundCells()) {
    if (!world.has(key(cell))) world.set(key(cell), 'stone')
  }
  // A sensed block IS a real loaded block: register it so `blockAt` agrees with
  // `findBlocks` (the scanner reads the block back by position).
  for (const [name, positions] of Object.entries(opts.sensed ?? {})) {
    for (const p of positions) world.set(key(p), name)
  }
  const blockAt = (p: { x: number; y: number; z: number }) => {
    const cell = key(p)
    if (unloaded.has(cell)) return null
    const name = world.get(cell)
    if (name === undefined) return { name: 'air', boundingBox: 'empty', diggable: false }
    return { name, boundingBox: 'block', diggable: true }
  }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance: number
    count: number
  }): unknown[] => {
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
  const items = Object.entries(opts.counts ?? {}).map(([name, count], slot) => ({ name, count, slot }))
  return {
    username: 'AI_SOURCEGAP',
    entity: { id: 1, position: botPosition, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
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

function obsidianGoal(count = 10): QueuedGoal {
  return {
    id: 'g1:collect:obsidian',
    kind: 'collect',
    description: `mine ${count} x obsidian with diamond_pickaxe`,
    targetItem: 'obsidian',
    requiredCount: count,
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

function obsidianMemories(cells: Vec3Json[]): KnownResource[] {
  return cells.map((position) => ({ name: 'obsidian', kind: 'ore', position }))
}

function perceive(bot: Bot, known: KnownResource[] = []): WorldState {
  return buildWorldState(
    bot,
    {
      tick: 1,
      goal: makeGoal('obsidian', 10),
      goalQueue: queueWith(obsidianGoal()),
      focusItem: 'obsidian',
      recentEvents: [],
      signals: signals({ knownResources: known }),
    },
    defaultSensorOptions,
  )
}

/** A host path fact so a level remembered coordinate is `reachable`. */
const reachableOptions = {
  ...defaultCandidateOptions,
  reachability: { memory: null, pathProbe: () => 'reachable' as const },
}

function generated(state: WorldState, options = defaultCandidateOptions): ReturnType<typeof generateGroundedCandidates> {
  return generateGroundedCandidates(state, options)
}

function allIds(result: ReturnType<typeof generateGroundedCandidates>): string[] {
  return [...result.candidates.map((candidate) => candidate.id), ...result.withheld.map((entry) => entry.candidate.id)]
}

function obsidianRoutes(result: ReturnType<typeof generateGroundedCandidates>): Candidate[] {
  return result.candidates.filter(
    (candidate) =>
      (candidate.kind === 'MINE' || candidate.kind === 'MOVE' || candidate.kind === 'DESCEND') &&
      candidate.targetName === 'obsidian',
  )
}

// --- (a) positive world proof: stone where obsidian was ----------------------

addCase('(a) a remembered obsidian cell the loaded world reads as stone is falsified', () => {
  const world: Record<string, string> = {}
  for (const cell of STALE_CELLS) world[key(cell)] = 'stone'
  const state = perceive(fakeBot({ world, counts: { diamond_pickaxe: 1 } }), obsidianMemories(STALE_CELLS))
  const evidence = (state.knownResourceEvidence ?? []).filter((entry) => entry.status === 'falsified')
  const stillRemembered = (state.signals.knownResources ?? []).filter(
    (resource) => resource.name === 'obsidian' && STALE_CELLS.some((cell) => key(cell) === key(resource.position)),
  )
  return {
    pass: evidence.length === STALE_CELLS.length && stillRemembered.length === 0,
    detail: `falsified=${evidence.length}/${STALE_CELLS.length} observed=${evidence[0]?.observed ?? 'none'} stillRemembered=${stillRemembered.length}`,
  }
})

addCase('(a) the falsified cell yields no route and a typed remembered_falsified gap', () => {
  const world: Record<string, string> = {}
  for (const cell of STALE_CELLS) world[key(cell)] = 'stone'
  const state = perceive(fakeBot({ world, counts: { diamond_pickaxe: 1 } }), obsidianMemories(STALE_CELLS))
  const result = generated(state)
  const ids = allIds(result)
  const obsidianIds = ids.filter((id) => id.includes('obsidian'))
  const gap = result.sourceGap
  return {
    pass:
      obsidianIds.length === 0 &&
      gap !== null &&
      gap.reason === 'remembered_falsified' &&
      gap.falsified === STALE_CELLS.length &&
      formatResourceSourceGap(gap).startsWith('RESOURCE_SOURCE_NONE item=obsidian reason=remembered_falsified'),
    detail: `obsidianIds=${obsidianIds.join(',') || 'none'} gap=${gap === null ? 'none' : formatResourceSourceGap(gap)}`,
  }
})

addCase('(a) the same cell in an UNLOADED chunk stays unknown and keeps its remembered route', () => {
  const state = perceive(
    fakeBot({ unloaded: [CONFIRMED_CELL], counts: { diamond_pickaxe: 1 } }),
    obsidianMemories([CONFIRMED_CELL]),
  )
  const evidence = state.knownResourceEvidence ?? []
  const kept = (state.signals.knownResources ?? []).length
  const result = generated(state, reachableOptions)
  const retrieve = allIds(result).find((id) => id.startsWith('RETRIEVE:known:obsidian:'))
  return {
    pass:
      evidence.length === 1 &&
      evidence[0]?.status === 'unknown' &&
      evidence[0]?.observed === null &&
      kept === 1 &&
      retrieve !== undefined &&
      result.sourceGap === null,
    detail: `statuses=${evidence.map((entry) => entry.status).join(',')} kept=${kept} retrieve=${retrieve ?? 'none'} gap=${result.sourceGap === null ? 'none' : 'present'}`,
  }
})

addCase('(a) a directly-built state with falsified evidence refuses the stale entry (candidate-layer defense)', () => {
  const base = perceive(fakeBot({ counts: { diamond_pickaxe: 1 } }), obsidianMemories(STALE_CELLS))
  const injected: WorldState = {
    ...base,
    knownResourceEvidence: STALE_CELLS.map((position) => ({
      name: 'obsidian',
      position,
      observed: 'stone',
      status: 'falsified' as const,
    })),
  }
  const result = generated(injected)
  const obsidianIds = allIds(result).filter((id) => id.startsWith('RETRIEVE:known:obsidian:'))
  return {
    pass: obsidianIds.length === 0,
    detail: `retrieves=${obsidianIds.join(',') || 'none'}`,
  }
})

// --- (b) a real source still routes ------------------------------------------

addCase('(b) a sensed obsidian block yields a grounded route and no source gap', () => {
  const state = perceive(
    fakeBot({ sensed: { obsidian: [SENSED_POS] }, counts: { diamond_pickaxe: 1 } }),
    [],
  )
  const result = generated(state)
  const routes = obsidianRoutes(result)
  return {
    pass: routes.length > 0 && result.sourceGap === null,
    detail: `routes=${routes.map((candidate) => candidate.id).join(',') || 'none'} gap=${result.sourceGap === null ? 'none' : formatResourceSourceGap(result.sourceGap)}`,
  }
})

addCase('(b) a remembered obsidian cell the world confirms yields a grounded route', () => {
  const state = perceive(
    fakeBot({ world: { [key(CONFIRMED_CELL)]: 'obsidian' }, counts: { diamond_pickaxe: 1 } }),
    obsidianMemories([CONFIRMED_CELL]),
  )
  const evidence = state.knownResourceEvidence ?? []
  const result = generated(state, reachableOptions)
  const ids = allIds(result)
  const route = ids.find((id) => id.includes('obsidian'))
  return {
    pass:
      route !== undefined &&
      evidence.length === 1 &&
      evidence[0]?.status === 'present' &&
      result.sourceGap === null,
    detail: `status=${evidence[0]?.status ?? 'none'} route=${route ?? 'none'} ids=${ids.join(',')}`,
  }
})

// --- (c) no source -> typed gap, never a silent stall ------------------------

addCase('(c) with no sensed and no remembered source the gap is no_source_sensed and exploration is offered', () => {
  const state = perceive(fakeBot({ counts: { diamond_pickaxe: 1 } }), [])
  const result = generated(state)
  const gap = result.sourceGap
  const explore = result.candidates.filter((candidate) => candidate.meta.explore === true)
  return {
    pass:
      gap !== null &&
      gap.reason === 'no_source_sensed' &&
      gap.sensed === 0 &&
      gap.remembered === 0 &&
      gap.next === 'explore' &&
      explore.length >= 1 &&
      result.candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'),
    detail: `gap=${gap === null ? 'none' : formatResourceSourceGap(gap)} explore=${explore.map((candidate) => candidate.id).join(',') || 'none'}`,
  }
})

addCase('(c) a collect focus with no source is never WAIT-only', () => {
  const state = perceive(fakeBot({ counts: { diamond_pickaxe: 1 } }), [])
  const result = generated(state)
  const productive = result.candidates.filter(
    (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
  )
  return {
    pass: productive.length >= 2,
    detail: `presented=${result.candidates.map((candidate) => candidate.id).join(',')}`,
  }
})

addCase('(c) only live-structure members remain -> typed live_structure gap, still refused', () => {
  const frameCell: Vec3Json = { x: 56, y: 66, z: -5 }
  const base = perceive(
    fakeBot({ world: { [key(frameCell)]: 'obsidian' }, sensed: { obsidian: [frameCell] }, counts: { diamond_pickaxe: 1 } }),
    [],
  )
  const state: WorldState = {
    ...base,
    liveStructureMembers: [{ kind: 'nether_portal', position: frameCell }],
  }
  const exclusions = resourceSourceExclusions(state)
  const result = generated(state)
  const gap = resourceSourceGapFor(state, result.candidates, exclusions)
  const obsidianIds = allIds(result).filter((id) => id.includes('obsidian'))
  return {
    pass:
      exclusions.length === 1 &&
      obsidianIds.length === 0 &&
      gap !== null &&
      gap.reason === 'live_structure' &&
      gap.excluded === 1,
    detail: `excluded=${exclusions.length} ids=${obsidianIds.join(',') || 'none'} gap=${gap === null ? 'none' : formatResourceSourceGap(gap)}`,
  }
})

let failures = 0
process.stdout.write('resource source gap: world-proof + typed no-source regression\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} resource-source-gap cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
