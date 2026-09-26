// test-station-reachability.mts - EXECUTOR/station selection defect.
//
// Live RC9 (source generation gen-mu8w0kmw-kcbrpv): the first smelt selected
// `SMELT:iron_ingot` for a SENSED furnace, the executor's pathfinder stuck, the
// action failed with `failureCode=path_stuck`, and after the bounded retries the
// station was skipped. The recovery direction (craft/place a reachable station
// through the #204 prerequisite envelope) is correct; the defect is that an
// unreachable sensed station was committed to at all.
//
// A sensed station is not automatically a usable station. Before it is offered
// as a direct SMELT/CRAFT target the station's approach must be evaluated with
// the SAME generic machinery the executor uses to open it: the #244 interaction
// stand (a passable, supported cell whose face is in reach) and the bounded
// `canDig=false` path verdict to that stand. An unreachable sensed station is
// skipped, so `smeltCandidates` falls through to the existing furnace
// prerequisite recovery (`RETRIEVE`/`CRAFT`/`PLACE` a reachable station) instead
// of path_stuck-ing at the same coordinate until the move-failure memory retires
// it.
//
// Pure: no bot, no network, no model. The station approach is a fact the caller
// supplies (`CandidateOptions.reachability.stationApproach`); the controller
// wires it to the live bot, tests inject it.
//
// Run: bun --test test-station-reachability.mts
import { readFileSync } from 'node:fs'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { MoveFailMemory, moveFailureKey } from './src/moveFailMemory.ts'
import { knownStationKey } from './src/prereqOption.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { StationApproachFact, StationKindName } from './src/reachability.ts'
import type { AgentSignals, GoalState, InventoryState, StationEntry, Vec3Json, WorldState } from './src/state.ts'
import type { Candidate } from './src/candidates.ts'

let failures = 0
async function check(label: string, ok: boolean, detail: string): Promise<void> {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

// --- world state builders (mirror test-smelt-charcoal-abandon) ----------------

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_STATION',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
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

function goal(): GoalState {
  return {
    id: 'smelt:charcoal',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(): QueuedGoal {
  return {
    id: 'g-smelt',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
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
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(furnaces: StationEntry[], knownResources: AgentSignals['knownResources']): WorldState {
  const feet = LIVE_FEET
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(feet),
    inventory: inventory({ oak_log: 1, birch_planks: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: [feet] },
    craftingTables: [],
    furnaces,
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: goal(),
    goalQueue: queueWith(queuedGoal()),
    recentEvents: [],
    signals: signals({ knownResources }),
  }
}

// --- fixtures -----------------------------------------------------------------

const LIVE_FEET: Vec3Json = { x: 29.5, y: 65, z: 34.5 }
/** Sensed furnaces the bot can see, nearest-first, exactly as `state.furnaces` orders them. */
const UNREACHABLE_FURNACE: StationEntry = { x: 23, y: 69, z: 24, source: 'sensed' }
const REACHABLE_FURNACE: StationEntry = { x: 35, y: 65, z: 34, source: 'sensed' }
/** A durable remembered furnace: the #204 recovery route when the sensed ones are not viable. */
const REMEMBERED_FURNACE: StationEntry = { x: 8, y: 65, z: 24, source: 'remembered' }
const REMEMBERED_KEY = knownStationKey({ name: 'furnace', position: { x: REMEMBERED_FURNACE.x, y: REMEMBERED_FURNACE.y, z: REMEMBERED_FURNACE.z } })

const rememberedResource = [
  { name: 'furnace', kind: 'station' as const, position: { x: REMEMBERED_FURNACE.x, y: REMEMBERED_FURNACE.y, z: REMEMBERED_FURNACE.z } },
]

type StationApproachFn = (station: Vec3Json, kind: StationKindName) => StationApproachFact

function optionsWith(stationApproach: StationApproachFn | null, unreachable: ReadonlySet<string> = new Set<string>()) {
  return { ...defaultCandidateOptions, unreachableStations: unreachable, reachability: { memory: null, stationApproach } }
}

/** A generic interaction stand one block east of the station (face in reach). */
const standEast = (station: Vec3Json): Vec3Json => ({ x: station.x + 1, y: station.y, z: station.z })
const noStand: StationApproachFn = () => ({ approach: null, path: null })
const noPath: StationApproachFn = (station) => ({ approach: standEast(station), path: 'no_path' })
const usable: StationApproachFn = (station) => ({ approach: standEast(station), path: 'reachable' })

function isRecovery(candidate: Candidate): boolean {
  return (
    (candidate.kind === 'RETRIEVE' && candidate.id.startsWith('RETRIEVE:known:station:furnace:')) ||
    candidate.id === 'CRAFT:furnace' ||
    candidate.id.startsWith('PLACE:furnace')
  )
}

function smeltTarget(furnaces: StationEntry[], options: ReturnType<typeof optionsWith>): Candidate | undefined {
  const state = worldState(furnaces, rememberedResource)
  const grounded = generateGroundedCandidates(state, options)
  return grounded.candidates.find((entry) => entry.id === 'SMELT:charcoal')
}

async function main(): Promise<void> {
  process.stdout.write('station reachability: evaluate approach before committing to a sensed station\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (1) A sensed station with NO interaction stand must never become the direct
  // SMELT target. Today `reachableSensedFurnace` ignores the approach and hands
  // back the first sensed cell, so this is the red case.
  {
    const state = worldState([UNREACHABLE_FURNACE, REACHABLE_FURNACE], rememberedResource)
    const grounded = generateGroundedCandidates(state, optionsWith(noStand))
    const smelt = grounded.candidates.find((entry) => entry.id === 'SMELT:charcoal')
    const recovery = grounded.candidates.filter(isRecovery)
    await check(
      '(1) a sensed station with no interaction stand is withheld and the recovery ladder is offered',
      smelt === undefined && recovery.length > 0,
      `smelt=${smelt === undefined ? 'none' : `${smelt.target?.x},${smelt.target?.y},${smelt.target?.z}`} recovery=[${recovery.map((entry) => entry.id).join(',')}] ids=[${grounded.candidates.map((entry) => entry.id).join(',')}]`,
    )
  }

  // (2) A sensed station whose stand exists but has NO canDig=false path is the
  // live `path_stuck` class: reject it before the first attempt.
  {
    const state = worldState([UNREACHABLE_FURNACE, REACHABLE_FURNACE], rememberedResource)
    const grounded = generateGroundedCandidates(state, optionsWith(noPath))
    const smelt = grounded.candidates.find((entry) => entry.id === 'SMELT:charcoal')
    const recovery = grounded.candidates.filter(isRecovery)
    await check(
      '(2) a sensed station with no path to its stand is withheld and the recovery ladder is offered',
      smelt === undefined && recovery.length > 0,
      `smelt=${smelt === undefined ? 'none' : `${smelt.target?.x},${smelt.target?.y},${smelt.target?.z}`} recovery=[${recovery.map((entry) => entry.id).join(',')}]`,
    )
  }

  // (3) A genuinely reachable sensed station is still selected and used - and the
  // nearest unreachable one is skipped, not merely the first cell.
  {
    const probe: StationApproachFn = (station, kind) =>
      kind === 'furnace' && station.x === UNREACHABLE_FURNACE.x && station.z === UNREACHABLE_FURNACE.z
        ? { approach: null, path: null }
        : usable(station, kind)
    const smelt = smeltTarget([UNREACHABLE_FURNACE, REACHABLE_FURNACE], optionsWith(probe))
    await check(
      '(3) an unreachable nearest sensed station is skipped in favour of the reachable one',
      smelt !== undefined &&
        smelt.target !== null &&
        smelt.target.x === REACHABLE_FURNACE.x &&
        smelt.target.y === REACHABLE_FURNACE.y &&
        smelt.target.z === REACHABLE_FURNACE.z,
      `target=${smelt?.target === null || smelt?.target === undefined ? 'none' : `${smelt.target.x},${smelt.target.y},${smelt.target.z}`}`,
    )
  }

  // (4) Backward compatibility: with no station-approach probe the generator is
  // unchanged and still selects the first sensed furnace.
  {
    const smelt = smeltTarget([UNREACHABLE_FURNACE, REACHABLE_FURNACE], optionsWith(null))
    await check(
      '(4) with no station-approach probe the existing first-sensed selection is unchanged',
      smelt !== undefined && smelt.target !== null && smelt.target.x === UNREACHABLE_FURNACE.x,
      `target=${smelt?.target === null || smelt?.target === undefined ? 'none' : `${smelt.target.x},${smelt.target.y},${smelt.target.z}`}`,
    )
  }

  // (5) The bounded-retry retire hands off to the SAME generic recovery: once the
  // coordinate is blacklisted by move-failure memory the sensed station joins the
  // unreachable set and the direct SMELT is no longer offered.
  {
    const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 10_000, now: () => 1_000 })
    for (let attempt = 0; attempt < 3; attempt += 1) memory.record('overworld', UNREACHABLE_FURNACE, 'stuck')
    const key = knownStationKey({ name: 'furnace', position: { x: UNREACHABLE_FURNACE.x, y: UNREACHABLE_FURNACE.y, z: UNREACHABLE_FURNACE.z } })
    const state = worldState([UNREACHABLE_FURNACE], rememberedResource)
    const grounded = generateGroundedCandidates(state, optionsWith(null, new Set([key])))
    const smelt = grounded.candidates.find(
      (entry) => entry.id === 'SMELT:charcoal' && entry.target?.x === UNREACHABLE_FURNACE.x,
    )
    const recovery = grounded.candidates.filter(isRecovery)
    await check(
      '(5) after the bounded retries the retired station is skipped into the recovery ladder',
      memory.isBlacklisted('overworld', UNREACHABLE_FURNACE) &&
        moveFailureKey('overworld', UNREACHABLE_FURNACE) === 'overworld:23,69,24' &&
        smelt === undefined &&
        recovery.length > 0,
      `blacklisted=${memory.isBlacklisted('overworld', UNREACHABLE_FURNACE)} key=${moveFailureKey('overworld', UNREACHABLE_FURNACE)} smelt=${smelt === undefined ? 'none' : smelt.id} recovery=[${recovery.map((entry) => entry.id).join(',')}]`,
    )
  }

  // (6) Wiring: the generator gates sensed selection and the controller supplies
  // the live #244 interaction-stand + bounded path verdict.
  {
    const candidates = source('./src/candidates.ts')
    const controller = `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}\n${source('./src/legacy/path-probes.ts')}`
    const reachability = source('./src/reachability.ts')
    const wired =
      candidates.includes('function stationApproachReachable') &&
      candidates.includes('stationApproach') &&
      controller.includes('stationApproach') &&
      controller.includes('interactionStandCandidates(') &&
      controller.includes('formatStationUnreachable') &&
      reachability.includes('export function formatStationUnreachable') &&
      reachability.includes('STATION_UNREACHABLE')
    await check(
      '(6) station-approach reachability is wired through candidates and the controller',
      wired,
      `gate=${candidates.includes('function stationApproachReachable')} candidatesProbe=${candidates.includes('stationApproach')} controllerProbe=${controller.includes('stationApproach')} stands=${controller.includes('interactionStandCandidates(')} marker=${controller.includes('formatStationUnreachable')}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`station-reachability: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
