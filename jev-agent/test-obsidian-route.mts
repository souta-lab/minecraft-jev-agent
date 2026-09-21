// test-obsidian-route.mts - grounded obsidian-acquisition regression (M2).
//
// Live defect (typed portal plan, planId=g1:collect:obsidian):
//
//   CAUSAL record=causal ... optionId=front_nether_portal planId=g1:collect:obsidian
//     strategy=llm:collect candidateId=MOVE:p41_66_8 ... verified=true status=done
//     resource=null progressDelta=0 progress=body
//   CANDIDATE_STARVATION presented=1 productive=0 goal=objective:...
//     blockedBy=no_productive_action
//
// The planner emitted `mine 10 x obsidian with diamond_pickaxe` while the bot held
// the diamond pickaxe, but no obsidian action ever entered the candidate set, so
// the body only walked and the rung deadlocked.
//
// Root cause (PERCEPTION truth, not policy):
//   * `state.ts#buildBlocks` name-scanned only `ORE_SOURCES` (`_ore` blocks) and
//     `STONE_LIKE`, so a sensed obsidian block never reached `state.blocks` and
//     `candidates.ts#mineCandidates` had nothing to ground a MINE/MOVE/DESCEND on;
//   * `candidates.ts#retrievalWant` recognised only ore/log focuses, so a
//     remembered obsidian coordinate never produced `RETRIEVE:known:obsidian:*`.
//
// The fix reports CAN only: obsidian is name-scanned when the active goal targets
// it, and the existing tool-gated MINE/MOVE/DESCEND/known-retrieval machinery
// exposes the route. No action is ranked and no goal is reordered.
//
// Run: bun test-obsidian-route.mts
import { createRequire } from 'node:module'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { AgentSignals, BlockState, DescentOption, KnownResource, Vec3Json, WorldState } from './src/state.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
/** The live server version's real registry (mineflayer loads the same object). */
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

/** The live M2 bot cell the starvation line walked around (y=66 surface). */
const ORIGIN = { x: 29.12, y: 47.75, z: 34.19 }
/** A sensed lava-adjacent obsidian cell, pickup-adjacent to ORIGIN. */
const OBSIDIAN_POS: Vec3Json = { x: 30, y: 47, z: 35 }

/**
 * Sensor double: `sensed` maps block name -> positions the scan can see. The real
 * minecraft-data registry is attached so `resolveHarvest` answers the genuine
 * obsidian harvest truth (pickaxe, diamond tier).
 */
function fakeBot(sensed: Record<string, Vec3Json[]>, counts: Record<string, number>): Bot {
  const position = new Vec3(ORIGIN.x, ORIGIN.y, ORIGIN.z)
  const blocks = new Map<string, { name: string; boundingBox: string; diggable: boolean }>()
  for (const [name, positions] of Object.entries(sensed)) {
    for (const p of positions) blocks.set(`${p.x},${p.y},${p.z}`, { name, boundingBox: 'block', diggable: true })
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
    const origin = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
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
    username: 'AI_OBS',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
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

/** Sensor state for the live `collect:obsidian` goal. */
function perceive(
  counts: Record<string, number>,
  sensed: Record<string, Vec3Json[]>,
  known: KnownResource[] = [],
): WorldState {
  return buildWorldState(
    fakeBot(sensed, counts),
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

// --- (1) perception: the active obsidian goal makes obsidian visible -----------

addCase('(1) a sensed obsidian block enters state.blocks with its pickaxe harvest truth', () => {
  const state = perceive({ diamond_pickaxe: 1 }, { obsidian: [OBSIDIAN_POS] })
  const sensed = state.blocks.filter((block) => block.name === 'obsidian')
  const block = sensed[0]
  return {
    pass:
      sensed.length === 1 &&
      block !== undefined &&
      block.yield === 'obsidian' &&
      block.harvestTool === 'pickaxe' &&
      block.harvestTier === 4 &&
      block.diggable === true,
    detail: `sensed=${sensed.length} block=${JSON.stringify(block ?? null)}`,
  }
})

addCase('(1) obsidian is NOT invented for an unrelated focus item', () => {
  const state = buildWorldState(
    fakeBot({ obsidian: [OBSIDIAN_POS] }, { diamond_pickaxe: 1 }),
    {
      tick: 1,
      goal: makeGoal('diamond', 1),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'diamond',
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
  const hallucinated = state.blocks.filter((block) => block.name === 'obsidian')
  return { pass: hallucinated.length === 0, detail: `obsidianBlocks=${hallucinated.length}` }
})

// --- (2) candidates: the sensed block yields a grounded, tool-gated route ------

addCase('(2) a pickup-adjacent obsidian block yields a MINE candidate while the diamond pickaxe is held', () => {
  const state = perceive({ diamond_pickaxe: 1 }, { obsidian: [OBSIDIAN_POS] })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const mine = grounded.candidates.find(
    (candidate) => candidate.kind === 'MINE' && candidate.targetName === 'obsidian',
  )
  return {
    pass: mine !== undefined && mine.toolName === 'pickaxe' && mine.toolTier === 4,
    detail: `mine=${mine?.id ?? 'none'} presented=${grounded.candidates.map((c) => c.id).join(',')}`,
  }
})

addCase('(2) the diamond-pickaxe tool gate keeps obsidian out of reach without the tool', () => {
  const state = perceive({ iron_pickaxe: 1 }, { obsidian: [OBSIDIAN_POS] })
  const sensed = state.blocks.some((block) => block.name === 'obsidian')
  const ids = generatedIds(state)
  const obsidianIds = ids.filter((id) => id.includes('obsidian'))
  return {
    pass: sensed && obsidianIds.length === 0,
    detail: `sensed=${sensed} obsidianIds=${obsidianIds.join(',') || 'none'} generated=${ids.length}`,
  }
})

// --- (3) remembered coordinates: a known obsidian cell is a route --------------

addCase('(3) a level remembered obsidian coordinate yields a presented RETRIEVE:known:obsidian', () => {
  const known: KnownResource = { name: 'obsidian', kind: 'ore', position: { x: 60, y: 48, z: 35 } }
  const state = perceive({ diamond_pickaxe: 1 }, { obsidian: [] }, [known])
  // The host supplies a path fact; 'reachable' is the walkable case.
  const options = { ...defaultCandidateOptions, reachability: { memory: null, pathProbe: () => 'reachable' as const } }
  const grounded = generateGroundedCandidates(state, options)
  const retrieveId = 'RETRIEVE:known:obsidian:b60_48_35'
  const presented = grounded.candidates.some((candidate) => candidate.id === retrieveId)
  return {
    pass: presented,
    detail: `presented=${grounded.candidates.map((c) => c.id).join(',')} withheld=${grounded.withheld.map((w) => w.candidate.id).join(',') || 'none'}`,
  }
})

addCase('(3) a remembered obsidian cell below the bot is offered with a typed vertical verdict, never silently dropped', () => {
  const known: KnownResource = { name: 'obsidian', kind: 'ore', position: { x: 60, y: 30, z: 35 } }
  const state = perceive({ diamond_pickaxe: 1 }, { obsidian: [] }, [known])
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const offered = [
    ...grounded.candidates.map((candidate) => candidate.id),
    ...grounded.withheld.map((entry) => entry.candidate.id),
  ]
  const verdict = grounded.withheld.find((entry) => entry.candidate.id === 'RETRIEVE:known:obsidian:b60_30_35')
  return {
    pass: offered.includes('RETRIEVE:known:obsidian:b60_30_35') && verdict?.result.reason === 'needs_descend',
    detail: `offered=${offered.includes('RETRIEVE:known:obsidian:b60_30_35')} reason=${verdict?.result.reason ?? 'none'}`,
  }
})

// --- (4) TTL: an unreachable sensed obsidian column is a descent target --------

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

addCase('(4) an unreachable obsidian block below the bot yields a DESCEND step toward obsidian', () => {
  const base = perceive({ diamond_pickaxe: 1 }, { obsidian: [] })
  const feet = { x: Math.floor(ORIGIN.x), y: Math.floor(ORIGIN.y), z: Math.floor(ORIGIN.z) }
  const unreachable: BlockState = {
    kind: 'ore',
    name: 'obsidian',
    position: { x: 30, y: 40, z: 35 },
    distance: 8.2,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'obsidian',
    harvestTool: 'pickaxe',
    harvestTier: 4,
  }
  const state: WorldState = { ...base, blocks: [unreachable], descent: [downStep('W', -1, 0, feet)] }
  const descent = generateGroundedCandidates(state, defaultCandidateOptions).candidates.find(
    (candidate) => candidate.kind === 'DESCEND' && candidate.targetName === 'obsidian',
  )
  return {
    pass: descent !== undefined && descent.meta.focusItem === 'obsidian',
    detail: `descent=${descent?.id ?? 'none'}`,
  }
})

let failures = 0
process.stdout.write('obsidian acquisition: grounded-route regression\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} obsidian-route cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
