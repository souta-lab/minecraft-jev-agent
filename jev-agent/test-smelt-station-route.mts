// test-smelt-station-route.mts - the smelt station-source ladder.
//
// Live stall (source e8545f7, body at (24.7,66,9.5), raw_iron=2 held): the queue
// head was `smelt iron_ingot:3`, the input was present and 15 furnaces were
// remembered, yet the decision record showed a degenerate set
//   [{SMELT:iron_ingot target 28,63,6 inReach=false failedCount=14}, {WAIT}]
// and 86 `REJECTED SMELT:iron_ingot code=NO_PATH :: no canDig=false path to
// (28,63,6) (GoalBlock probe)` lines. `SMELT_INPUT_PREREQ ... action=none` kept
// firing and the goal waited out the semantic boundary.
//
// Two structural facts held it open:
//   1. `smeltCandidates` returned EITHER a direct SMELT at the first
//      "reachable" sensed station OR the acquisition ladder, never both. The
//      generation-side fact (`stationApproach`: a `GoalNear` interaction stand)
//      and the guard-side fact (`GoalBlock` on the furnace cell) disagreed, so
//      the direct step was re-offered forever while `furnaceAcquisitionCandidates`
//      (travel to a remembered furnace / place a held one / craft one) never ran.
//   2. A remembered station the body could already interact with, and a smelt
//      goal with NO station route at all, had no direct step and no typed gap -
//      the failure was a bare `[WAIT]` set.
//
// This suite locks the ladder: smelt-here, travel-there, place-held, craft, or a
// TYPED gap - never a silent WAIT. Pure: no bot, no network, no model.
//
//   bun test ./test-smelt-station-route.mts
import { readFileSync } from 'node:fs'
import { defaultCandidateOptions, formatSmeltRouteGap, formatSmeltStationRetry, generateGroundedCandidates, smeltRouteGap, smeltStationRetry } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { orphanedSmeltPrerequisiteReason } from './src/controller-legacy.ts'
import { guardCandidate } from './src/policy.ts'
import { knownStationKey } from './src/prereqOption.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, GoalState, InventoryState, KnownResource, StationEntry, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

// --- world state (mirrors test-smelt-charcoal-abandon) -------------------------

const LIVE_FEET: Vec3Json = { x: 24.7, y: 66, z: 9.5 }
const LIVE_EYE: Vec3Json = { x: LIVE_FEET.x, y: LIVE_FEET.y + 1.62, z: LIVE_FEET.z }
const IN_REACH: Vec3Json = { x: 25, y: 66, z: 11 }
const FAR: Vec3Json = { x: 8, y: 65, z: 24 }

function inventory(counts: Record<string, number>): InventoryState {
  return {
    slots: Object.entries(counts).map(([name, count], slot) => ({ name, count, slot })),
    counts,
    totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0),
  }
}

function signals(knownResources: KnownResource[] = []): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources,
  }
}

const queued: QueuedGoal = {
  id: 'g-smelt',
  kind: 'smelt',
  description: 'smelt 3 x iron_ingot',
  targetItem: 'iron_ingot',
  requiredCount: 3,
  startCount: 0,
  haveCount: 0,
  status: 'active',
  origin: 'llm',
  createdAt: 0,
  updatedAt: 0,
  detail: null,
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

const goal: GoalState = {
  id: 'smelt:iron_ingot',
  description: 'smelt 3 x iron_ingot',
  targetItem: 'iron_ingot',
  requiredCount: 3,
  startCount: 0,
  haveCount: 0,
  progress: 0,
  complete: false,
  startedAtMs: 0,
}

function worldState(overrides: {
  inventory: Record<string, number>
  furnaces?: StationEntry[]
  knownResources?: KnownResource[]
  craftingTables?: StationEntry[]
  placementSpots?: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 92,
    timestampMs: 1_700_000_000_000,
    self: {
      username: 'AI_SMELT_ROUTE',
      position: LIVE_FEET,
      eyePosition: LIVE_EYE,
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 20,
      food: 20,
      gameMode: 'survival',
      dimension: 'overworld',
      isDay: true,
      heldItem: null,
    },
    inventory: inventory(overrides.inventory),
    entities: [],
    blocks: [],
    terrain: { standable: [LIVE_FEET] },
    craftingTables: overrides.craftingTables ?? [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: overrides.placementSpots ?? [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal,
    goalQueue: queueWith(queued),
    recentEvents: [],
    signals: signals(overrides.knownResources),
  }
}

const station = (name: string, position: Vec3Json): KnownResource => ({ name, kind: 'station', position })

const INPUT_AND_FUEL: Record<string, number> = { raw_iron: 2, birch_log: 3, cobblestone: 442 }

function options(
  unreachable: ReadonlySet<string> = new Set(),
  pathProbe: ((position: Vec3Json) => 'reachable' | 'no_path' | 'unknown') | null = null,
): typeof defaultCandidateOptions {
  return { ...defaultCandidateOptions, unreachableStations: unreachable, reachability: { memory: null, pathProbe } }
}

function ids(candidates: readonly Candidate[]): string {
  return candidates
    .map((candidate) => `${candidate.id}@${candidate.target === null ? '-' : `${candidate.target.x},${candidate.target.y},${candidate.target.z}`}`)
    .join(' | ')
}

function sameTarget(candidate: Candidate, position: Vec3Json): boolean {
  return (
    candidate.target !== null &&
    candidate.target.x === position.x &&
    candidate.target.y === position.y &&
    candidate.target.z === position.z
  )
}

// --- the ladder ----------------------------------------------------------------

function main(): void {
  process.stdout.write('smelt station route: smelt here / travel there / place / craft / typed gap\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (a) input present + a known placed furnace in reach: the body can smelt NOW.
  // The station is SENSED, so the direct step is the smelt itself. (A remembered
  // station keeps the pinned walk-to-then-smelt RETRIEVE - see (a2) and
  // buddy-driver/test-furnace-place.mts.)
  {
    const state = worldState({
      inventory: INPUT_AND_FUEL,
      furnaces: [{ ...IN_REACH, source: 'sensed' }],
      knownResources: [station('furnace', IN_REACH)],
    })
    const grounded = generateGroundedCandidates(state, options())
    const direct = grounded.candidates.find((candidate) => candidate.kind === 'SMELT')
    const guarded =
      direct === undefined
        ? null
        : guardCandidate(direct, state, {
            phase: 'decision',
            candidateIds: new Set(grounded.candidates.map((entry) => entry.id)),
            inFlight: null,
            reach: defaultCandidateOptions.reach,
            maxCandidateAgeTicks: 20,
            canComputePath: () => true,
          })
    check(
      '(a) a known placed furnace in reach yields a smelt-capable route',
      direct !== undefined && sameTarget(direct, IN_REACH) && guarded?.ok === true,
      `ids=[${ids(grounded.candidates)}] guard=${guarded === null ? 'no candidate' : guarded.ok ? 'ok' : `${guarded.code}:${guarded.reason}`}`,
    )
  }

  // (a2) the pinned contract for a REMEMBERED station: it is reached by the
  // generic "walk to the remembered station" step, never by a direct in-place
  // smelt the sensor has not confirmed.
  {
    const state = worldState({
      inventory: INPUT_AND_FUEL,
      furnaces: [{ ...IN_REACH, source: 'remembered' }],
      knownResources: [station('furnace', IN_REACH)],
    })
    const grounded = generateGroundedCandidates(state, options())
    const retrieve = grounded.candidates.find(
      (candidate) => candidate.kind === 'RETRIEVE' && sameTarget(candidate, IN_REACH),
    )
    check(
      '(a2) a registered-but-not-sensed station keeps the walk-to-then-smelt route',
      retrieve !== undefined &&
        retrieve.meta.furnaceSource === 'known' &&
        retrieve.label.includes('to smelt') &&
        grounded.candidates.every((candidate) => candidate.kind !== 'SMELT'),
      `ids=[${ids(grounded.candidates)}]`,
    )
  }

  // (b) input present + a known but OUT-of-reach furnace: the body must travel.
  // No direct SMELT for a station this far away - the ladder names the walk.
  {
    const state = worldState({
      inventory: INPUT_AND_FUEL,
      furnaces: [{ ...FAR, source: 'remembered' }],
      knownResources: [station('furnace', FAR)],
    })
    const grounded = generateGroundedCandidates(state, options())
    const travel = grounded.candidates.find((candidate) => candidate.kind === 'RETRIEVE' && sameTarget(candidate, FAR))
    check(
      '(b) a known but out-of-reach furnace yields a travel route',
      travel !== undefined &&
        travel.id === `RETRIEVE:known:station:furnace:b${FAR.x}_${FAR.y}_${FAR.z}` &&
        grounded.candidates.every((candidate) => candidate.kind !== 'SMELT'),
      `ids=[${ids(grounded.candidates)}]`,
    )
  }

  // (c) input present + no station + a held furnace: place it at a grounded cell.
  {
    const state = worldState({
      inventory: { ...INPUT_AND_FUEL, furnace: 1 },
      placementSpots: [IN_REACH],
    })
    const grounded = generateGroundedCandidates(state, options())
    const place = grounded.candidates.find((candidate) => candidate.kind === 'PLACE' && sameTarget(candidate, IN_REACH))
    check(
      '(c) no station + a held furnace yields a placement route',
      place !== undefined && place.id === `PLACE:furnace:p${IN_REACH.x}_${IN_REACH.y}_${IN_REACH.z}`,
      `ids=[${ids(grounded.candidates)}]`,
    )
  }

  // (d) input present + no station and no furnace: no route exists at all, so the
  // goal must surface a TYPED gap instead of a silent `[WAIT]`.
  {
    const state = worldState({ inventory: INPUT_AND_FUEL })
    const grounded = generateGroundedCandidates(state, options())
    const productive = grounded.candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
    const gap = smeltRouteGap(state, options())
    const line = gap === null ? '' : formatSmeltRouteGap(gap)
    check(
      '(d) no station + no furnace yields the typed station gap, never a bare WAIT',
      productive.length === 0 &&
        gap !== null &&
        gap.missing === 'station' &&
        line.startsWith('SMELT_STATION_MISSING') &&
        line.includes('item=iron_ingot') &&
        line.includes('held_furnace=0') &&
        line.includes('stone=442'),
      `productive=${productive.length} line=${line === '' ? 'none' : line}`,
    )
  }

  // (d2) the live shape: a sensed station the executor's path probe rejects, an
  // EMPTY travel alternative and no held furnace -> still typed, still never a
  // silent wait. The retired station is named in the gap.
  {
    const unreachable = new Set([knownStationKey({ name: 'furnace', position: { x: 28, y: 63, z: 6 } })])
    const state = worldState({
      inventory: INPUT_AND_FUEL,
      furnaces: [{ x: 28, y: 63, z: 6, source: 'remembered' }],
      knownResources: [station('furnace', { x: 28, y: 63, z: 6 })],
    })
    const grounded = generateGroundedCandidates(state, options(unreachable))
    const gap = smeltRouteGap(state, options(unreachable))
    const line = gap === null ? '' : formatSmeltRouteGap(gap)
    check(
      '(d2) every known station being retired still reports a typed gap',
      gap !== null &&
        line.startsWith('SMELT_STATION_MISSING') &&
        line.includes('unreachable_stations=[furnace@28,63,6]') &&
        grounded.candidates.some((candidate) => candidate.kind === 'WAIT'),
      `line=${line === '' ? 'none' : line} ids=[${ids(grounded.candidates)}]`,
    )
  }

  // The measured live stall: a sensed station passes the generation-side
  // approach probe but the guard's `GoalBlock` probe rejects it, while 15
  // furnaces are remembered and no furnace is held. The set must carry the
  // generic ladder (travel to a remembered station / craft one), not just
  // `[SMELT, WAIT]`.
  {
    const state = worldState({
      inventory: {
        birch_log: 3,
        cobblestone: 442,
        diamond: 3,
        flint_and_steel: 1,
        oak_log: 4,
        raw_copper: 5,
        raw_iron: 2,
        soul_sand: 13,
        stick: 5,
      },
      furnaces: [
        { x: 20, y: 68, z: 3, source: 'sensed' },
        { x: 23, y: 69, z: 24, source: 'sensed' },
        { x: 28, y: 63, z: 6, source: 'sensed' },
        { x: 33, y: 66, z: 12, source: 'sensed' },
      ],
      knownResources: [
        station('furnace', { x: 8, y: 65, z: 24 }),
        station('furnace', { x: 44, y: 72, z: 26 }),
        station('furnace', { x: 33, y: 75, z: 41 }),
        station('furnace', { x: 33, y: 66, z: 12 }),
        station('furnace', { x: 32, y: 75, z: 44 }),
        station('furnace', { x: 31, y: 75, z: 43 }),
        station('furnace', { x: 30, y: 76, z: 45 }),
        station('furnace', { x: 29, y: 75, z: 43 }),
        station('furnace', { x: 28, y: 63, z: 6 }),
        station('furnace', { x: 26, y: 61, z: 28 }),
        station('furnace', { x: 23, y: 69, z: 24 }),
        station('furnace', { x: 20, y: 68, z: 3 }),
        station('furnace', { x: 19, y: 62, z: 24 }),
        station('furnace', { x: 10, y: 65, z: -9 }),
        station('furnace', { x: -17, y: 67, z: 4 }),
        station('crafting_table', { x: 33, y: 66, z: 10 }),
      ],
      craftingTables: [],
      placementSpots: [],
    })
    const unreachable = new Set([knownStationKey({ name: 'furnace', position: { x: 28, y: 63, z: 6 } })])
    const grounded = generateGroundedCandidates(state, options(unreachable))
    const productive = grounded.candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
    const travel = productive.find((candidate) => candidate.kind === 'RETRIEVE' && candidate.meta.resource === 'furnace')
    check(
      '(live) the measured stall now has a grounded station route besides the direct SMELT',
      productive.length >= 2 &&
        travel !== undefined &&
        grounded.candidates.some((candidate) => candidate.kind === 'SMELT') &&
        smeltRouteGap(state, options(unreachable)) === null,
      `ids=[${ids(grounded.candidates)}]`,
    )
  }

  // The measured live stall, with the guard's own walk verdict: EVERY sensed
  // station is refused, so no direct SMELT at a refused cell is offered at all.
  // The goal keeps a grounded travel route to a remembered furnace.
  {
    const state = worldState({
      inventory: {
        birch_log: 3,
        cobblestone: 442,
        diamond: 3,
        flint_and_steel: 1,
        oak_log: 4,
        raw_copper: 5,
        raw_iron: 2,
        soul_sand: 13,
        stick: 5,
      },
      furnaces: [
        { x: 20, y: 68, z: 3, source: 'sensed' },
        { x: 23, y: 69, z: 24, source: 'sensed' },
        { x: 28, y: 63, z: 6, source: 'sensed' },
        { x: 33, y: 66, z: 12, source: 'sensed' },
      ],
      knownResources: [
        station('furnace', { x: 8, y: 65, z: 24 }),
        station('furnace', { x: 44, y: 72, z: 26 }),
        station('furnace', { x: 33, y: 75, z: 41 }),
        station('furnace', { x: 33, y: 66, z: 12 }),
        station('furnace', { x: 32, y: 75, z: 44 }),
        station('furnace', { x: 31, y: 75, z: 43 }),
        station('furnace', { x: 30, y: 76, z: 45 }),
        station('furnace', { x: 29, y: 75, z: 43 }),
        station('furnace', { x: 28, y: 63, z: 6 }),
        station('furnace', { x: 26, y: 61, z: 28 }),
        station('furnace', { x: 23, y: 69, z: 24 }),
        station('furnace', { x: 20, y: 68, z: 3 }),
        station('furnace', { x: 19, y: 62, z: 24 }),
        station('furnace', { x: 10, y: 65, z: -9 }),
        station('furnace', { x: -17, y: 67, z: 4 }),
        station('crafting_table', { x: 33, y: 66, z: 10 }),
      ],
      craftingTables: [],
      placementSpots: [],
    })
    const refusedCells = new Set(['20,68,3', '23,69,24', '28,63,6', '33,66,12'])
    const opts = options(
      new Set(),
      (position: Vec3Json) => (refusedCells.has(`${position.x},${position.y},${position.z}`) ? 'no_path' : 'reachable'),
    )
    const grounded = generateGroundedCandidates(state, opts)
    const smelt = grounded.candidates.find((candidate) => candidate.kind === 'SMELT')
    const travel = grounded.candidates.find((candidate) => candidate.kind === 'RETRIEVE' && candidate.meta.resource === 'furnace')
    const retry = smeltStationRetry(state, opts)
    check(
      '(live2) a guard-refused station is never a direct SMELT; the goal keeps the travel route',
      smelt === undefined &&
        travel !== undefined &&
        retry !== null &&
        retry.next === 'travel' &&
        travel.target !== null &&
        !refusedCells.has(`${travel.target.x},${travel.target.y},${travel.target.z}`),
      `ids=[${ids(grounded.candidates)}] retry=${retry === null ? 'none' : formatSmeltStationRetry(retry, 234)}`,
    )
  }

  // (r) an unreachable station must become a TYPED, actionable retry - never a
  // silent `NO_PATH` loop on the same cell. The refusal fact is the same
  // `canDig=false` probe the guard runs, and `next` names the route that works.
  {
    const refused = (position: Vec3Json): 'reachable' | 'no_path' =>
      position.x === FAR.x && position.y === FAR.y && position.z === FAR.z ? 'no_path' : 'reachable'
    const sensed: StationEntry[] = [{ ...FAR, source: 'sensed' }]

    // (r1) no furnace held -> the generic travel route to a remembered station.
    {
      const state = worldState({
        inventory: INPUT_AND_FUEL,
        furnaces: sensed,
        knownResources: [station('furnace', { x: 44, y: 72, z: 26 })],
      })
      const entry = smeltStationRetry(state, options(new Set(), refused))
      const line = entry === null ? '' : formatSmeltStationRetry(entry, 7)
      const grounded = generateGroundedCandidates(state, options(new Set(), refused))
      check(
        '(r1) an unreachable station becomes a typed travel retry, not a silent NO_PATH loop',
        entry !== null &&
          entry.next === 'travel' &&
          line === `SMELT_STATION_UNREACHABLE station=${FAR.x},${FAR.y},${FAR.z} attempts=7 next=travel` &&
          grounded.candidates.some((candidate) => candidate.kind === 'RETRIEVE'),
        `line=${line === '' ? 'none' : line} ids=[${ids(grounded.candidates)}]`,
      )
    }

    // (r2) a held furnace -> the placement route.
    {
      const state = worldState({
        inventory: { ...INPUT_AND_FUEL, furnace: 1 },
        furnaces: sensed,
        placementSpots: [IN_REACH],
      })
      const entry = smeltStationRetry(state, options(new Set(), refused))
      check(
        '(r2) an unreachable station with a held furnace becomes a typed place retry',
        entry !== null &&
          entry.next === 'place' &&
          formatSmeltStationRetry(entry, 3) ===
            `SMELT_STATION_UNREACHABLE station=${FAR.x},${FAR.y},${FAR.z} attempts=3 next=place`,
        `line=${entry === null ? 'none' : formatSmeltStationRetry(entry, 3)}`,
      )
    }

    // (r3) nothing else available -> the typed capability gap, said out loud.
    {
      const state = worldState({ inventory: INPUT_AND_FUEL, furnaces: sensed })
      const opts = options(new Set(), refused)
      const entry = smeltStationRetry(state, opts)
      const gap = smeltRouteGap(state, opts)
      check(
        '(r3) an unreachable station with no alternative becomes a typed capability gap',
        entry !== null &&
          entry.next === 'capability_gap' &&
          formatSmeltStationRetry(entry, 12) ===
            `SMELT_STATION_UNREACHABLE station=${FAR.x},${FAR.y},${FAR.z} attempts=12 next=capability_gap` &&
          gap !== null &&
          gap.missing === 'station',
        `line=${entry === null ? 'none' : formatSmeltStationRetry(entry, 12)} gap=${gap === null ? 'none' : formatSmeltRouteGap(gap)}`,
      )
    }

    // (r4) an in-reach station needs no walk, so there is nothing to refuse.
    {
      const state = worldState({
        inventory: INPUT_AND_FUEL,
        furnaces: [{ ...IN_REACH, source: 'sensed' }],
      })
      check(
        '(r4) an in-reach station never carries an unreachable retry marker',
        smeltStationRetry(state, options(new Set(), () => 'no_path')) === null,
        `entry=${smeltStationRetry(state, options(new Set(), () => 'no_path'))}`,
      )
    }
  }

  // (e) the orphaned-smelt retirement is unchanged.
  {
    const retired = orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 1, stillWanted: false })
    check(
      '(e) the orphaned smelt prerequisite still retires, and only when orphaned',
      retired !== null &&
        retired.includes('iron_ingot') &&
        retired.includes('flint_and_steel=1') &&
        orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 1, stillWanted: true }) === null &&
        orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 0, stillWanted: false }) === null,
      `orphaned=${retired} wanted=${orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 1, stillWanted: true })}`,
    )
  }

  // The wiring: the generator owns the ladder and the controller reports the gap
  // through the same starvation evidence the replan path consumes.
  {
    const candidates = source('./src/candidates.ts')
    const controller = `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`
    const wired =
      candidates.includes('function directSmeltFurnace') &&
      candidates.includes('function smeltRouteGap') &&
      candidates.includes('export function smeltStationRetry') &&
      candidates.includes('export function formatSmeltStationRetry') &&
      candidates.includes('export function formatSmeltRouteGap') &&
      candidates.includes('return [direct, ...travel]') &&
      controller.includes('logSmeltRouteGap(') &&
      controller.includes('logSmeltStationRetry(') &&
      controller.includes('smeltRouteGapThisTick')
    check(
      '(f) the ladder, the typed gap, the typed retry and the starvation evidence are wired',
      wired,
      `direct=${candidates.includes('function directSmeltFurnace')} gap=${candidates.includes('function smeltRouteGap')} retry=${candidates.includes('export function smeltStationRetry')} union=${candidates.includes('return [direct, ...travel]')} log=${controller.includes('logSmeltRouteGap(')} retryLog=${controller.includes('logSmeltStationRetry(')} evidence=${controller.includes('smeltRouteGapThisTick')}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`smelt-station-route: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
