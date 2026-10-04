// test-step-overhead.mts — hand-cut staircase composition out of a sealed pocket.
//
// The p23 live deadlock: a body in a 2-high dug tunnel, every face tops at the
// feet+2 ceiling, inventory empty -> the ascend vocabulary could only name
// `placeable_block` + own-column headroom, both unacquirable. But the pocket is
// hand-escapable: dig the face column's feet+2, then feet+3, then the feet+1
// face block, and step up - an iterated `staircase-up` needing zero placeables.
// The defect was vocabulary, not geometry: no fact named the STEP column's
// overhead cells, so no clearance MINE could ever be offered for them.
//
// This suite drives the REAL sensor (buildWorldState over a block-grid bot
// double) through the whole composition chain:
//   1. `stepCuts[].blockedBy` names each face's feet+2 ceiling cell
//   2. the ascend gate names `headroom@<face feet+2>` beside the still-honest
//      `headroom@<own feet+2>` and `placeable_block`
//   3. the acquisition pass offers `MINE:b<face feet+2>` tagged stepOverhead
//   4. after that dig, `blockedBy` re-derives the feet+3 cell -> MINE offered
//   5. after both overhead digs the feet+1 cut is safe, but `staircase-up`
//      still refuses while the body's own jump headroom is sealed
//   6. clearing the own-column ceiling grounds `staircase-up` -> the far-above
//      target is reachable: a 4-dig hand staircase with zero placeables
//   7. a fluid dam above the overhead cell yields NO named cell (flood safety)
//
// Run: bun test-step-overhead.mts
import { createRequire } from 'node:module'
import {
  applyReachabilityGate,
  defaultCandidateOptions,
  deriveReachabilityAbilities,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey } from './src/reachability.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { AgentSignals, Vec3Json, WorldState } from './src/state.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')
const recipeIndex = createRecipeIndex(registry)

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

type Bot = Parameters<typeof buildWorldState>[0]

/** Minecraft truth for the few blocks this pocket fixture needs. */
const BLOCKS: Record<string, { boundingBox: string; diggable: boolean }> = {
  air: { boundingBox: 'empty', diggable: false },
  water: { boundingBox: 'empty', diggable: false },
  lava: { boundingBox: 'empty', diggable: false },
  bedrock: { boundingBox: 'block', diggable: false },
  stone: { boundingBox: 'block', diggable: true },
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
const nameAt = (grid: Map<string, string>, x: number, y: number, z: number): string =>
  grid.get(key(x, y, z)) ?? 'air'

/** The canopy-suite block-grid bot double: `grid` is every non-air cell. */
function gridBot(grid: Map<string, string>, position: Vec3Json): Bot {
  const pos = new Vec3(position.x, position.y, position.z)
  const blockAt = (point: { x: number; y: number; z: number }) => {
    const x = Math.floor(point.x)
    const y = Math.floor(point.y)
    const z = Math.floor(point.z)
    const name = nameAt(grid, x, y, z)
    const shape = BLOCKS[name] ?? BLOCKS.air
    return { name, ...shape, position: new Vec3(x, y, z) }
  }
  return {
    username: 'AI_POCKET',
    entity: { id: 1, position: pos, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => [] },
    blockAt,
    canSeeBlock: () => true,
    findBlocks: (query: {
      matching: (block: { name: string }) => boolean
      maxDistance: number
      count: number
    }) => {
      const out: unknown[] = []
      for (const [cell, name] of grid) {
        const [x, y, z] = cell.split(',').map(Number)
        const block = { name, ...(BLOCKS[name as string] ?? BLOCKS.air) }
        if (!query.matching(block)) continue
        if (pos.distanceTo(new Vec3(x as number, y as number, z as number)) > query.maxDistance) continue
        out.push(new Vec3(x as number, y as number, z as number))
        if (out.length >= query.count) break
      }
      return out
    },
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

function goalQueue(current: QueuedGoal | null): GoalQueueState {
  if (current === null) return emptyGoalQueueState()
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

const POSITION: Vec3Json = { x: -20.5, y: 38, z: 11.5 }
const FEET = { x: -21, y: 38, z: 11 }
// East-leaning so the E face is the alignment winner the named cell lands on.
const SURFACE: Vec3Json = { x: -17, y: 66, z: 11 }

function perceive(grid: Map<string, string>): WorldState {
  return buildWorldState(
    gridBot(grid, POSITION),
    {
      tick: 1,
      goal: makeGoal('log', 1),
      goalQueue: goalQueue(null),
      focusItem: null,
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
}

/**
 * The sealed live pocket: solid stone all around, the body's two-column air
 * cells carved out. Every face tops at feet+2; the own-column jump cell is
 * sealed; nothing placeable is held.
 */
function sealedPocket(): Map<string, string> {
  const grid = new Map<string, string>()
  for (let x = FEET.x - 4; x <= FEET.x + 4; x += 1) {
    for (let y = FEET.y - 4; y <= FEET.y + 7; y += 1) {
      for (let z = FEET.z - 4; z <= FEET.z + 4; z += 1) {
        grid.set(key(x, y, z), 'stone')
      }
    }
  }
  grid.delete(key(FEET.x, FEET.y, FEET.z))
  grid.delete(key(FEET.x, FEET.y + 1, FEET.z))
  return grid
}

const options: CandidateOptions = { ...defaultCandidateOptions, recipes: recipeIndex }

/** A locomotion leg to a cell far above - the withheld target the gate judges. */
function aboveMove(): Candidate {
  return {
    id: 'MOVE:p-17_66_11',
    kind: 'MOVE',
    label: 'move toward the remembered resource bearing above',
    targetName: null,
    target: { x: -17, y: 66, z: 11 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

// --- 1+2: the sensor names the face overhead; the gate names it as headroom --
{
  const state = perceive(sealedPocket())
  const cuts = state.stepCuts ?? []
  const named = cuts.filter((cut) => cut.blockedBy !== null && cut.blockedBy !== undefined)
  check(
    '(1) every face tops at feet+2 and names its own ceiling cell via blockedBy',
    cuts.length === 4 &&
      named.length === 4 &&
      cuts.every(
        (cut) =>
          cut.cut.y === FEET.y + 2 &&
          cut.safe === false &&
          cut.reason === 'no headroom above the new step' &&
          cut.blockedBy?.pos.y === FEET.y + 2 &&
          cut.blockedBy.name === 'stone',
      ),
    `cuts=${cuts.map((cut) => `${cut.dir}@${cut.cut.x},${cut.cut.y},${cut.cut.z}:${cut.reason}:blockedBy=${cut.blockedBy?.pos.y ?? 'none'}`).join(' | ')}`,
  )

  const abilities = deriveReachabilityAbilities(state, SURFACE)
  const missing = abilities.ascend.missing.map(capabilityKey)
  check(
    '(2) the sealed-pocket ascend names the step-column overhead as headroom, not only placeable_block',
    !abilities.ascend.available &&
      missing.includes('placeable_block') &&
      missing.includes(`headroom@${FEET.x},${FEET.y + 2},${FEET.z}`) &&
      missing.includes(`headroom@${FEET.x + 1},${FEET.y + 2},${FEET.z}`),
    `available=${abilities.ascend.available} missing=[${missing.join(',')}]`,
  )

  // --- 3: the acquisition pass offers the targeted step-overhead MINE -------
  const gate = applyReachabilityGate([aboveMove()], state, options)
  const stepMine = gate.candidates.find((candidate) => candidate.meta.stepOverhead === true)
  const ownMine = gate.candidates.find(
    (candidate) =>
      candidate.meta.clearance === true &&
      candidate.meta.stepOverhead !== true,
  )
  check(
    '(3) acquisition offers the targeted overhead MINE beside the own-column clearance',
    gate.withheld.some((entry) => entry.candidate.id === 'MOVE:p-17_66_11') &&
      stepMine !== undefined &&
      stepMine.target !== null &&
      stepMine.target.x === FEET.x + 1 &&
      stepMine.target.y === FEET.y + 2 &&
      stepMine.requiresTool === false &&
      ownMine !== undefined,
    `stepMine=${stepMine?.id ?? 'none'} ownMine=${ownMine?.id ?? 'none'} offered=[${gate.candidates
      .filter((c) => c.meta.clearance === true)
      .map((c) => c.id)
      .join(',')}]`,
  )

  // --- 4: after the feet+2 dig the chain re-derives the feet+3 cell ----------
  const grid2 = sealedPocket()
  grid2.delete(key(FEET.x + 1, FEET.y + 2, FEET.z))
  const state2 = perceive(grid2)
  const east = (state2.stepCuts ?? []).find((cut) => cut.dir === 'E')
  const abilities2 = deriveReachabilityAbilities(state2, SURFACE)
  const missing2 = abilities2.ascend.missing.map(capabilityKey)
  check(
    '(4) clearing the face ceiling re-derives feet+3 as the next binding overhead',
    east !== undefined &&
      east.cut.y === FEET.y + 1 &&
      east.blockedBy?.pos.y === FEET.y + 3 &&
      missing2.includes(`headroom@${FEET.x + 1},${FEET.y + 3},${FEET.z}`),
    `eastCut=${east ? `${east.cut.x},${east.cut.y},${east.cut.z}:${east.reason}:blockedBy=${east.blockedBy?.pos.y ?? 'none'}` : 'none'} missing=[${missing2.join(',')}]`,
  )

  const gate2 = applyReachabilityGate([aboveMove()], state2, options)
  const feet3Mine = gate2.candidates.find(
    (candidate) =>
      candidate.meta.stepOverhead === true &&
      candidate.target !== null &&
      candidate.target.y === FEET.y + 3 &&
      candidate.target.x === FEET.x + 1,
  )
  check(
    '(4) the feet+3 cell is offered as a targeted step-overhead MINE',
    feet3Mine !== undefined,
    `stepOverheadMines=[${gate2.candidates
      .filter((c) => c.meta.stepOverhead === true)
      .map((c) => c.id)
      .join(',')}]`,
  )

  // --- 5: both overhead digs land -> the feet+1 cut is safe, but the own ------
  //        column jump headroom still gates the staircase-up -----------------
  const grid3 = sealedPocket()
  grid3.delete(key(FEET.x + 1, FEET.y + 2, FEET.z))
  grid3.delete(key(FEET.x + 1, FEET.y + 3, FEET.z))
  const state3 = perceive(grid3)
  const east3 = (state3.stepCuts ?? []).find((cut) => cut.dir === 'E')
  const abilities3 = deriveReachabilityAbilities(state3, SURFACE)
  const missing3 = abilities3.ascend.missing.map(capabilityKey)
  check(
    '(5) a safe feet+1 cut under a sealed own ceiling stays unavailable and names own headroom',
    east3 !== undefined &&
      east3.safe === true &&
      !abilities3.ascend.available &&
      missing3.includes(`headroom@${FEET.x},${FEET.y + 2},${FEET.z}`) &&
      missing3.filter((cap) => cap.startsWith('headroom@')).length === 1,
    `eastSafe=${east3?.safe} available=${abilities3.ascend.available} missing=[${missing3.join(',')}]`,
  )

  // --- 6: own ceiling cleared -> the staircase-up grounds --------------------
  const grid4 = sealedPocket()
  grid4.delete(key(FEET.x + 1, FEET.y + 2, FEET.z))
  grid4.delete(key(FEET.x + 1, FEET.y + 3, FEET.z))
  grid4.delete(key(FEET.x, FEET.y + 2, FEET.z))
  const state4 = perceive(grid4)
  const abilities4 = deriveReachabilityAbilities(state4, SURFACE)
  check(
    '(6) clearing the own-column ceiling grounds the hand-cut staircase-up (zero placeables)',
    abilities4.ascend.available,
    `available=${abilities4.ascend.available} missing=[${abilities4.ascend.missing.map(capabilityKey).join(',')}]`,
  )

  // --- 7: a fluid dam above the overhead cell yields NO named cell -----------
  const grid5 = sealedPocket()
  grid5.delete(key(FEET.x + 1, FEET.y + 2, FEET.z))
  grid5.set(key(FEET.x + 2, FEET.y + 3, FEET.z), 'water')
  const state5 = perceive(grid5)
  const east5 = (state5.stepCuts ?? []).find((cut) => cut.dir === 'E')
  check(
    '(7) a face-adjacent fluid above the binding cell suppresses the named overhead (flood safety)',
    east5 !== undefined && (east5.blockedBy === null || east5.blockedBy === undefined),
    `east5=${east5 ? `${east5.cut.x},${east5.cut.y},${east5.cut.z}:${east5.reason}:blockedBy=${east5.blockedBy?.pos.y ?? 'none'}` : 'none'}`,
  )

  // --- 8: an unbreakable overhead yields NO named cell ------------------------
  const grid6 = sealedPocket()
  grid6.delete(key(FEET.x + 1, FEET.y + 2, FEET.z))
  grid6.set(key(FEET.x + 1, FEET.y + 3, FEET.z), 'bedrock')
  const state6 = perceive(grid6)
  const east6 = (state6.stepCuts ?? []).find((cut) => cut.dir === 'E')
  check(
    '(8) an unbreakable binding cell suppresses the named overhead (no false route)',
    east6 !== undefined && (east6.blockedBy === null || east6.blockedBy === undefined),
    `east6=${east6 ? `${east6.cut.x},${east6.cut.y},${east6.cut.z}:${east6.reason}:blockedBy=${east6.blockedBy?.pos.y ?? 'none'}` : 'none'}`,
  )
}

process.stdout.write('-'.repeat(72) + '\n')
if (failures > 0) {
  process.stdout.write(`${failures} step-overhead case(s) FAILED\n`)
  process.exit(1)
}
process.stdout.write('all step-overhead cases passed\n')
