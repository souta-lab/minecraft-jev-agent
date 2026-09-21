// test-live-structure-source.mts - the general "do not source an item by
// dismantling a structure you depend on" regression.
//
// Live defect (operator report, source cb3e4ed):
//
//   The bot reached the Nether and came back. It then ran `collect obsidian`
//   (10 needed for a fresh frame) and the only obsidian its memory held was the
//   frame of the very portal it had just used:
//     ACTION MINE:b27_66_9 / MINE:b28_67_9 / MINE:b26_66_9   (frame cells)
//     obsidian inventory stays 0 ; the portal it just used is being dismantled
//
// The fix is a GENERAL predicate, not a portal rule: a world block that is a
// member of a structure the world model currently holds as LIVE must not be
// offered as a collect/mine source while that structure validates. The portal
// contributes only the structure-membership fact; the sourcing layer
// (candidates.ts) never learns the word "portal" (see blockSafety.ts).
//
// Cases:
//   (a) a live portal frame's obsidian cells are not offered as `collect obsidian`
//       sources while the structure is valid, and an identical obsidian block
//       outside the structure still is;
//   (b) the typed `RESOURCE_SOURCE_EXCLUDED ... reason=live_structure` marker
//       names every refused cell;
//   (c) a synthetic (non-portal) live structure is refused by the same rule,
//       proving the predicate is structure-agnostic;
//   (d) after the structure is invalidated (a required edge removed) those cells
//       become ordinary sources again - legitimate deconstruction still works;
//   (e) a remembered (durable) frame cell is refused as a `RETRIEVE:known` route
//       while a farther ordinary remembered cell is still offered.
//
// Run: bun test-live-structure-source.mts
import { createRequire } from 'node:module'
import {
  defaultCandidateOptions,
  formatResourceSourceExclusion,
  generateGroundedCandidates,
  resourceSourceExclusions,
} from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { portalFrameLayout } from './src/netherPortalPlan.ts'
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

/** Bot standing right beside the portal's bottom row (the live geometry). */
const ORIGIN = { x: 30.5, y: 66.0, z: 35.5 }
/** The portal frame plane: z=36, x 30..33, y 66..70 (widthAxis 'x'). */
const FRAME_ORIGIN = { x: 30, y: 66, z: 36 }
/** An identical obsidian block OUTSIDE any structure, pickup-adjacent to ORIGIN. */
const OUTSIDE_POS: Vec3Json = { x: 29, y: 66, z: 35 }

const FRAME_LAYOUT = portalFrameLayout(FRAME_ORIGIN, 'x')
const FRAME_CELLS: Vec3Json[] = FRAME_LAYOUT.frame.map((cell) => ({ x: cell.x, y: cell.y, z: cell.z }))

/** `bX_Y_Z` is the id encoding the candidate generator uses for a block cell. */
function cellToken(position: Vec3Json): string {
  return `b${position.x}_${position.y}_${position.z}`
}

const FRAME_TOKENS = new Set(FRAME_CELLS.map(cellToken))

/**
 * Sensor double: `sensed` maps a block name to the positions the scan can see.
 * Unlisted cells read as air. `solids` are extra solid blocks (ground) that back
 * the standable cells the MINE/MOVE machinery needs.
 */
function fakeBot(
  sensed: Record<string, Vec3Json[]>,
  counts: Record<string, number>,
  position: { x: number; y: number; z: number } = ORIGIN,
  solids: Vec3Json[] = [],
): Bot {
  const botPosition = new Vec3(position.x, position.y, position.z)
  const blocks = new Map<string, { name: string; boundingBox: string; diggable: boolean }>()
  for (const [name, positions] of Object.entries(sensed)) {
    for (const p of positions) blocks.set(`${p.x},${p.y},${p.z}`, { name, boundingBox: 'block', diggable: true })
  }
  for (const p of solids) {
    const key = `${p.x},${p.y},${p.z}`
    if (!blocks.has(key)) blocks.set(key, { name: 'stone', boundingBox: 'block', diggable: true })
  }
  const blockAt = (p: { x: number; y: number; z: number }) =>
    blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? {
      name: 'air',
      boundingBox: 'empty',
      diggable: false,
    }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance: number
    count: number
  }): unknown[] => {
    const origin = new Vec3(Math.floor(botPosition.x), Math.floor(botPosition.y), Math.floor(botPosition.z))
    const out: unknown[] = []
    for (const [name, positions] of Object.entries(sensed)) {
      if (!options.matching({ name })) continue
      for (const p of positions) {
        const block = new Vec3(p.x, p.y, p.z)
        if (block.distanceTo(origin) <= options.maxDistance) out.push(block)
      }
    }
    return out.slice(0, options.count)
  }
  const items = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return {
    username: 'AI_STRUCT',
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

/** Ground under the whole test area so `findAdjacentStandable` resolves. */
function ground(): Vec3Json[] {
  const out: Vec3Json[] = []
  for (let x = 26; x <= 36; x += 1) {
    for (let z = 32; z <= 40; z += 1) out.push({ x, y: 65, z })
  }
  return out
}

function perceiveSensed(sensedObsidian: Vec3Json[], known: KnownResource[] = []): WorldState {
  return buildWorldState(
    fakeBot({ obsidian: sensedObsidian }, { diamond_pickaxe: 1 }, ORIGIN, ground()),
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

/** Every id the generator produced, offered OR withheld by the reachability gate. */
function generatedIds(state: WorldState): string[] {
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  return [
    ...grounded.candidates.map((candidate) => candidate.id),
    ...grounded.withheld.map((entry) => entry.candidate.id),
  ]
}

function offeredCandidates(state: WorldState): string[] {
  return generateGroundedCandidates(state, defaultCandidateOptions).candidates.map((candidate) => candidate.id)
}

// --- (a) a live structure's cells are not sources; an outside cell still is ----

addCase('(a) the sensed live frame validates and contributes membership cells', () => {
  const state = perceiveSensed([...FRAME_CELLS, OUTSIDE_POS])
  const members = state.liveStructureMembers ?? []
  const frameMember = members.some(
    (member) =>
      member.position.x === FRAME_ORIGIN.x &&
      member.position.y === FRAME_ORIGIN.y &&
      member.position.z === FRAME_ORIGIN.z,
  )
  return {
    pass: state.portalFrame?.shape === 'ok' && members.length > 0 && frameMember,
    detail: `portalFrame=${state.portalFrame?.shape ?? 'none'} members=${members.length} frameMember=${frameMember}`,
  }
})

addCase('(a) no collect-obsidian candidate targets a live frame cell', () => {
  const state = perceiveSensed([...FRAME_CELLS, OUTSIDE_POS])
  const ids = generatedIds(state)
  const leaked = ids.filter((id) => FRAME_CELLS.some((cell) => id.includes(cellToken(cell))))
  return {
    pass: leaked.length === 0,
    detail: `leaked=${leaked.join(',') || 'none'} offered=${ids.filter((id) => id.includes('obsidian')).join(',')}`,
  }
})

addCase('(a) an identical obsidian block outside the structure is still offered', () => {
  const state = perceiveSensed([...FRAME_CELLS, OUTSIDE_POS])
  const ids = offeredCandidates(state)
  const outsideIds = ids.filter((id) => id.includes(cellToken(OUTSIDE_POS)))
  return {
    pass: outsideIds.length > 0,
    detail: `outside=${outsideIds.join(',') || 'none'} all=${ids.slice(0, 8).join(',')}`,
  }
})

addCase('(a) with only the live frame known the plan re-sources elsewhere, never dismantles it', () => {
  const state = perceiveSensed([...FRAME_CELLS])
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const leaked = ids.filter((id) => FRAME_CELLS.some((cell) => id.includes(cellToken(cell))))
  // A non-destructive forward action must remain: an exploration MOVE / DESCEND /
  // WAIT / ESCALATE. The frame must never be the offered route.
  const forward = ids.filter(
    (id) => id.startsWith('MOVE:') || id.startsWith('DESCEND') || id === 'WAIT' || id === 'ESCALATE',
  )
  return {
    pass: leaked.length === 0 && forward.length > 0,
    detail: `leaked=${leaked.join(',') || 'none'} forward=${forward.slice(0, 6).join(',') || 'none'}`,
  }
})

// --- (b) the typed marker ------------------------------------------------------

addCase('(b) every refused frame cell is surfaced as RESOURCE_SOURCE_EXCLUDED reason=live_structure', () => {
  const state = perceiveSensed([...FRAME_CELLS, OUTSIDE_POS])
  const exclusions = resourceSourceExclusions(state)
  const lines = exclusions.map(formatResourceSourceExclusion)
  const frameExclusions = exclusions.filter((exclusion) =>
    FRAME_CELLS.some(
      (cell) => cell.x === exclusion.cell.x && cell.y === exclusion.cell.y && cell.z === exclusion.cell.z,
    ),
  )
  const sample = formatResourceSourceExclusion({
    item: 'obsidian',
    cell: FRAME_ORIGIN,
    reason: 'live_structure',
    structure: 'nether_portal',
  })
  const declinedOutside = exclusions.some(
    (exclusion) => exclusion.cell.x === OUTSIDE_POS.x && exclusion.cell.z === OUTSIDE_POS.z,
  )
  return {
    pass:
      frameExclusions.length === FRAME_CELLS.length &&
      !declinedOutside &&
      lines.every((line) => line.startsWith('RESOURCE_SOURCE_EXCLUDED item=obsidian')) &&
      sample === `RESOURCE_SOURCE_EXCLUDED item=obsidian cell=${FRAME_ORIGIN.x},${FRAME_ORIGIN.y},${FRAME_ORIGIN.z} reason=live_structure`,
    detail: `${lines.length} lines; sample="${sample}"; first="${lines[0] ?? 'none'}"`,
  }
})

// --- (c) the predicate is structure-agnostic (no portal special case) ----------

addCase('(c) a synthetic non-portal live structure refuses its member cell too', () => {
  const base = perceiveSensed([OUTSIDE_POS])
  const state: WorldState = {
    ...base,
    portalFrame: null,
    portalFrameSites: [],
    liveStructureMembers: [{ kind: 'synthetic_structure', position: OUTSIDE_POS }],
  }
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const offered = grounded.candidates.map((candidate) => candidate.id)
  const leaked = offered.filter((id) => id.includes(cellToken(OUTSIDE_POS)))
  const marker = grounded.sourceExclusions.map(formatResourceSourceExclusion)
  return {
    pass:
      leaked.length === 0 &&
      marker.length === 1 &&
      marker[0] === `RESOURCE_SOURCE_EXCLUDED item=obsidian cell=${OUTSIDE_POS.x},${OUTSIDE_POS.y},${OUTSIDE_POS.z} reason=live_structure`,
    detail: `leaked=${leaked.join(',') || 'none'} marker=${marker.join('|') || 'none'}`,
  }
})

// --- (d) invalidation restores ordinary sourcing (legitimate deconstruction) ---

addCase('(d) removing one required edge invalidates the structure and frees its cells', () => {
  const remaining = FRAME_CELLS.slice(0, FRAME_CELLS.length - 1)
  const state = perceiveSensed([...remaining, OUTSIDE_POS])
  const ids = offeredCandidates(state)
  const freed = ids.filter((id) => remaining.some((cell) => id.includes(cellToken(cell))))
  return {
    pass: (state.liveStructureMembers ?? []).length === 0 && freed.length > 0,
    detail: `members=${(state.liveStructureMembers ?? []).length} freed=${freed.join(',') || 'none'}`,
  }
})

// --- (e) remembered (durable) frame cells are refused as retrieval routes ------

/** The same frame geometry, remembered at a distance (bot at the live M2 cell). */
const KNOWN_ORIGIN = { x: 30, y: 47, z: 36 }
const KNOWN_FRAME_CELLS: Vec3Json[] = portalFrameLayout(KNOWN_ORIGIN, 'x').frame.map((cell) => ({
  x: cell.x,
  y: cell.y,
  z: cell.z,
}))
const KNOWN_OUTSIDE: Vec3Json = { x: 40, y: 48, z: 34 }
// Far enough (> KNOWN_RESOURCE_PROOF_DISTANCE) that a remembered-but-unsensed
// cell is not treated as depleted; this keeps the retrieval route observable.
const KNOWN_BOT = { x: 20, y: 47.75, z: 34.19 }

function rememberedFrameState(invalidate: boolean): WorldState {
  const cells = invalidate ? KNOWN_FRAME_CELLS.slice(0, KNOWN_FRAME_CELLS.length - 1) : KNOWN_FRAME_CELLS
  const known: KnownResource[] = [
    {
      name: 'nether_portal',
      kind: 'portal',
      position: KNOWN_ORIGIN,
      widthAxis: 'x',
      frameCells: cells,
    },
    ...cells.map((position): KnownResource => ({ name: 'obsidian', kind: 'ore', position })),
    { name: 'obsidian', kind: 'ore', position: KNOWN_OUTSIDE },
  ]
  return buildWorldState(
    fakeBot({}, { diamond_pickaxe: 1 }, KNOWN_BOT),
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

addCase('(e) a remembered frame cell is refused while a farther ordinary cell is offered', () => {
  const state = rememberedFrameState(false)
  const options = { ...defaultCandidateOptions, reachability: { memory: null, pathProbe: () => 'reachable' as const } }
  const grounded = generateGroundedCandidates(state, options)
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const frameRetrievals = ids.filter((id) => KNOWN_FRAME_CELLS.some((cell) => id.includes(cellToken(cell))))
  const outsideRetrieval = ids.some((id) => id === `RETRIEVE:known:obsidian:${cellToken(KNOWN_OUTSIDE)}`)
  const members = state.liveStructureMembers ?? []
  return {
    pass: members.length > 0 && frameRetrievals.length === 0 && outsideRetrieval,
    detail: `members=${members.length} frameRetrievals=${frameRetrievals.join(',') || 'none'} outside=${outsideRetrieval}`,
  }
})

addCase('(e) invalidating the remembered structure frees its retrieval route again', () => {
  const state = rememberedFrameState(true)
  const options = { ...defaultCandidateOptions, reachability: { memory: null, pathProbe: () => 'reachable' as const } }
  const grounded = generateGroundedCandidates(state, options)
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const freed = ids.filter((id) => KNOWN_FRAME_CELLS.some((cell) => id.includes(cellToken(cell))))
  return {
    pass: (state.liveStructureMembers ?? []).length === 0 && freed.length > 0,
    detail: `members=${(state.liveStructureMembers ?? []).length} freed=${freed.join(',') || 'none'}`,
  }
})

let failures = 0
process.stdout.write('live-structure source protection: general-predicate regression\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} live-structure-source cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
