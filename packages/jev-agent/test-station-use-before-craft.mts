// test-station-use-before-craft.mts - OPERATOR RULE (measured live 2026-09-21).
//
// Live shape: the queue held `craft furnace` while world memory knew 26
// crafting tables and 17 furnaces, and the plan still produced
//   CRAFT:crafting_table (wasted planks) then CRAFT:furnace (wasted cobblestone)
// with the mirrored CRAFT_INGREDIENT_PREREQ chain naming both:
//   CRAFT_INGREDIENT_PREREQ item=furnace missing=crafting_table producer=craft crafting_table
//   CRAFT_INGREDIENT_PREREQ item=furnace missing=furnace        producer=craft furnace
//
// The rule this suite locks (candidates.ts#stationWorldTruth):
//
//   A station the world model already KNOWS DURABLY (remembered/registered, plus
//   a copy the bot holds) must be USED or WALKED TO before that station is
//   crafted. Crafting a station item is correct only when the world model holds
//   no durable station of that kind and none is held.
//
// Two decision points produced the duplicates and both are covered here:
//   * the recipe-required 3x3 station (`crafting.ts#planNextCraftStep` recursed
//     into `produce('crafting_table')`, and craftCandidates merged that step);
//   * the goal's own product when it IS a station (`craft furnace`).
//
// The deliberate #58 SENSED-ONLY semantics stay load-bearing (case (g)): a
// near-field sensed cell is decided by `sensedCraftingTableAvailable` /
// `sensedTableUsable` (in-place availability, and "a sensed station that already
// failed a pathing craft is re-planned as unavailable"), so it is not part of the
// durable set this rule owns. buddy-driver/test-furnace-place pins that boundary.
//
//   bun test ./test-station-use-before-craft.mts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  craftStationGap,
  defaultCandidateOptions,
  formatCraftStationGap,
  formatSmeltRouteGap,
  furnacePrereqInputFromState,
  generateGroundedCandidates,
  smeltRouteGap,
  stationCraftAllowed,
  stationWorldTruth,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { knownStationKey, planPrereqOptions, PREREQ_STATION_ALREADY_KNOWN, prereqWithheldCraft, formatPrereqStationKnown, selectPrereqPath } from './src/prereqOption.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import type { AgentSignals, GoalState, InventoryState, KnownResource, SelfState, StationEntry, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const recipes = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

// --- world state ---------------------------------------------------------------

const FEET: Vec3Json = { x: 56.2, y: 59, z: -2.5 }
const EYE: Vec3Json = { x: FEET.x, y: FEET.y + 1.62, z: FEET.z }
const SENSED_TABLE: Vec3Json = { x: 55, y: 59, z: -2 }
const PLACE_SPOT: Vec3Json = { x: 57, y: 59, z: -2 }

function inventory(counts: Record<string, number>): InventoryState {
  return {
    slots: Object.entries(counts).map(([name, count], slot) => ({ name, count, slot })),
    counts,
    totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0),
  }
}

function signals(knownResources: KnownResource[]): AgentSignals {
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

function queued(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g1:craft:furnace',
    kind: 'craft',
    description: 'craft 1 x furnace',
    targetItem: 'furnace',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function world(goal: QueuedGoal, counts: Record<string, number>, knownResources: KnownResource[], extra: Partial<WorldState> = {}): WorldState {
  const goalState: GoalState = {
    id: goal.id,
    description: goal.description,
    targetItem: goal.targetItem ?? 'furnace',
    requiredCount: goal.requiredCount,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
  const queue: GoalQueueState = {
    depth: 1,
    current: goal,
    empty: false,
    hasImpossible: false,
    done: 0,
    goals: [goal],
  }
  const self: SelfState = {
    username: 'AI_STATION_USE',
    position: FEET,
    eyePosition: EYE,
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
  return {
    schemaVersion: 1,
    tick: 501,
    timestampMs: 1_700_000_000_000,
    self,
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    terrain: { standable: [FEET, { x: 57, y: 59, z: -2 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [PLACE_SPOT],
    goal: goalState,
    goalQueue: queue,
    recentEvents: [],
    signals: signals(knownResources),
    ...extra,
  }
}

const station = (name: string, i: number): KnownResource => ({
  name,
  kind: 'station',
  position: { x: 40 + i, y: 59, z: 30 },
})

/** The measured live memory: 26 crafting tables and 17 furnaces, none sensed. */
const MANY_TABLES: KnownResource[] = Array.from({ length: 26 }, (_, i) => station('crafting_table', i))
const MANY_FURNACES: KnownResource[] = Array.from({ length: 17 }, (_, i) => station('furnace', i + 100))
const MANY_STATIONS: KnownResource[] = [...MANY_TABLES, ...MANY_FURNACES]

const options = (unreachable: ReadonlySet<string> = new Set()): typeof defaultCandidateOptions => ({
  ...defaultCandidateOptions,
  recipes,
  unreachableStations: unreachable,
})

const ids = (candidates: readonly Candidate[]): string => candidates.map((candidate) => candidate.id).join(', ')

const smeltGoal = (): QueuedGoal =>
  queued({ id: 'g2:smelt:iron_ingot', kind: 'smelt', description: 'smelt 1 x iron_ingot', targetItem: 'iron_ingot' })

function main(): void {
  process.stdout.write('station-use-before-craft: use or walk to a known station before crafting one\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (a) the measured live shape: a queued `craft furnace` with 26 known tables
  // and 17 known furnaces, none sensed. The station ladder is the answer and no
  // station is crafted.
  {
    const state = world(queued({}), { cobblestone: 200, oak_planks: 8, stick: 4 }, MANY_STATIONS)
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const travel = grounded.candidates.find((candidate) => candidate.kind === 'RETRIEVE')
    const duplicateTable = candidateIds.some((id) => id === 'CRAFT:crafting_table')
    const duplicateFurnace = candidateIds.some((id) => id === 'CRAFT:furnace')
    const gap = craftStationGap(state, options())
    const line = gap === null ? 'none' : formatCraftStationGap(gap)
    check(
      '(a) 26 known tables + 17 known furnaces: a known-station route is offered and NO station craft exists',
      travel !== undefined &&
        travel.kind === 'RETRIEVE' &&
        !duplicateTable &&
        !duplicateFurnace &&
        gap !== null &&
        gap.reason === 'known_station' &&
        gap.next === 'use_known_station' &&
        line.startsWith('CRAFT_STATION_ALREADY_KNOWN') &&
        line.includes('item=furnace') &&
        line.includes('station=furnace') &&
        gap.knownStations.length === 17,
      `ids=[${ids(grounded.candidates)}] duplicateTable=${duplicateTable} duplicateFurnace=${duplicateFurnace} line=${line}`,
    )
  }

  // (a2) the same memory with a `craft furnace` goal whose product is NOT known
  // (no furnaces) but 26 tables are: the known TABLE is the route, and crafting a
  // duplicate table is still withheld (the live wasted-planks step).
  {
    const state = world(queued({}), { cobblestone: 200, oak_planks: 8, stick: 4 }, MANY_TABLES)
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const travel = grounded.candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:crafting_table:'))
    const gap = craftStationGap(state, options())
    const line = gap === null ? 'none' : formatCraftStationGap(gap)
    check(
      '(a2) a table-requiring craft with 26 known tables walks to the table instead of crafting one',
      travel !== undefined &&
        !candidateIds.some((id) => id === 'CRAFT:crafting_table') &&
        gap !== null &&
        gap.station === 'crafting_table' &&
        gap.next === 'use_known_station' &&
        line.includes('station=crafting_table') &&
        line.includes('reason=known_station'),
      `ids=[${ids(grounded.candidates)}] line=${line}`,
    )
  }

  // (a3) OPERATOR DECISION 2026-09-21: the smelt lane now obeys the same rule for
  // the measured shape (26 known tables + 17 known furnaces, none sensed). The
  // prerequisite cost model used to prefer `craft_and_place` here - walking to a
  // known table to craft a duplicate furnace - because craft+place scored 4
  // against a 93.9 walk. A usable known furnace makes craft_and_place INELIGIBLE,
  // so the known-furnace route is chosen and the duplicate-craft route (the
  // crafting-table retrieve) is not offered at all. Once the body reaches a
  // remembered table it becomes SENSED, which stays the #58 boundary pinned by (g).
  {
    const state = world(smeltGoal(), { raw_iron: 3, coal: 4, cobblestone: 200 }, MANY_STATIONS)
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const input = furnacePrereqInputFromState(state, options())
    const decision = planPrereqOptions(input)
    const chosen = selectPrereqPath(decision)
    const furnaceTravel = grounded.candidates.find(
      (candidate) => candidate.kind === 'RETRIEVE' && candidate.meta.resource === 'furnace',
    )
    const craft = decision.options.find((option) => option.path === 'craft_and_place')
    const withheld = prereqWithheldCraft(decision)
    const marker =
      withheld === null || input.knownStation === null
        ? 'none'
        : formatPrereqStationKnown(input.knownStation, input.heldCount, chosen)
    check(
      '(a3) a smelt with 17 known furnaces walks to one, offers no duplicate-craft route, and types the reason',
      furnaceTravel !== undefined &&
        furnaceTravel.meta.prereqPath === 'use_known_station' &&
        !candidateIds.some((id) => id.startsWith('RETRIEVE:known:station:crafting_table')) &&
        !grounded.candidates.some((candidate) => candidate.meta.prereqPath === 'craft_and_place') &&
        !candidateIds.some((id) => id === 'CRAFT:furnace') &&
        !candidateIds.some((id) => id === 'CRAFT:crafting_table') &&
        chosen === 'use_known_station' &&
        decision.chosen === 'use_known_station' &&
        craft?.feasible === false &&
        craft.reason === 'station_already_known' &&
        withheld !== null &&
        marker.startsWith('PREREQ_STATION_ALREADY_KNOWN') &&
        marker.includes('station=furnace') &&
        marker.includes('held=0') &&
        marker.includes('next=use_known_station'),
      `ids=[${ids(grounded.candidates)}] chosen=${chosen} craft=${craft?.reason ?? 'missing'} marker=${marker}`,
    )
  }

  // (g) #58 SENSED-ONLY SEMANTICS, KEPT LOAD-BEARING (pinned by
  // buddy-driver/test-furnace-place): a SENSED table that already failed a
  // pathing craft is re-planned as unavailable, so a craft goal may still craft a
  // local table. The station-use rule deliberately does not suppress that step -
  // it owns DURABLE (remembered) stations plus a held copy, which is exactly what
  // the in-place sensed-availability machinery must keep deciding for itself.
  {
    const state = world(queued({ id: 'g9:craft:wooden_pickaxe', kind: 'craft', description: 'craft 1 x wooden_pickaxe', targetItem: 'wooden_pickaxe' }), { birch_planks: 7, stick: 2 }, [], {
      craftingTables: [{ ...SENSED_TABLE, source: 'sensed' } as StationEntry],
      signals: signals([]),
    })
    state.signals.lastFailureCode = 'path_stuck'
    state.signals.failedCandidates = { 'CRAFT:wooden_pickaxe': 1 }
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    check(
      '(g) a sensed table that failed pathing keeps the #58 local station craft',
      candidateIds.includes('CRAFT:crafting_table') &&
        !candidateIds.includes('CRAFT:wooden_pickaxe') &&
        craftStationGap(state, options()) === null,
      `ids=[${ids(grounded.candidates)}]`,
    )
  }

  // (h) THE RESIDUAL, NOW FIXED (owner decision 2026-09-21; was pinned as a KNOWN
  // RESIDUAL by lane c4a0c7ec). The measured probe shape: the body walks to a
  // remembered table, so a table becomes SENSED, and
  // `prereqOption.ts#craftAndPlaceOption` used to prefer crafting a furnace over
  // walking to one of the 17 known furnaces:
  //   candidates=[CRAFT:furnace, RETRIEVE:known:station:furnace:b140_59_30, WAIT]
  //   chosen=craft_and_place
  // The duplicate craft is now INELIGIBLE (a usable station exists), so the same
  // shape offers the known-furnace route only, chooses it, and the controller's
  // `filterFurnacePrerequisiteCandidates` keeps that route. The table no longer
  // routes the craft step because there is no craft step to route.
  {
    const state = world(smeltGoal(), { raw_iron: 3, coal: 4, cobblestone: 200 }, MANY_STATIONS, {
      craftingTables: [{ ...SENSED_TABLE, source: 'sensed' } as StationEntry],
    })
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const input = furnacePrereqInputFromState(state, options())
    const decision = planPrereqOptions(input)
    const chosen = selectPrereqPath(decision)
    const furnaceTravel = grounded.candidates.find(
      (candidate) => candidate.kind === 'RETRIEVE' && candidate.meta.resource === 'furnace',
    )
    const craft = decision.options.find((option) => option.path === 'craft_and_place')
    const withheld = prereqWithheldCraft(decision)
    const marker =
      withheld === null || input.knownStation === null
        ? 'none'
        : formatPrereqStationKnown(input.knownStation, input.heldCount, chosen)
    // The sensed table is still what #58 decides about (case (g)); it is NOT what
    // blocks the duplicate craft - the known furnace is.
    const sensedTablePresent = input.tableAvailable === true && input.placedCount === 0
    check(
      '(h) the fixed residual: the smelt prerequisite walks to a known furnace instead of crafting a duplicate',
      candidateIds.length === 2 &&
        candidateIds[0] === 'RETRIEVE:known:station:furnace:b140_59_30' &&
        !candidateIds.some((id) => id === 'CRAFT:furnace') &&
        furnaceTravel !== undefined &&
        furnaceTravel.meta.prereqPath === 'use_known_station' &&
        chosen === 'use_known_station' &&
        craft?.feasible === false &&
        craft.reason === 'station_already_known' &&
        sensedTablePresent &&
        withheld !== null &&
        marker === 'PREREQ_STATION_ALREADY_KNOWN station=furnace at=140,59,30 held=0 next=use_known_station',
      `ids=[${ids(grounded.candidates)}] chosen=${chosen} craft=${craft?.reason ?? 'missing'} marker=${marker}`,
    )
  }

  // (h2) NO usable station anywhere (no furnace known, none held) + a usable sensed
  // table: crafting the furnace is STILL correct, so craft_and_place wins and no
  // withheld-craft marker is emitted. This is the "crafting a station stays correct
  // when no usable station exists anywhere and none is held" half of the rule.
  {
    const state = world(smeltGoal(), { raw_iron: 3, coal: 4, cobblestone: 200 }, MANY_TABLES, {
      craftingTables: [{ ...SENSED_TABLE, source: 'sensed' } as StationEntry],
    })
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const decision = planPrereqOptions(furnacePrereqInputFromState(state, options()))
    const craft = decision.options.find((option) => option.path === 'craft_and_place')
    const craftCandidate = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:furnace')
    check(
      '(h2) with no usable furnace anywhere the furnace craft is still the chosen route',
      selectPrereqPath(decision) === 'craft_and_place' &&
        decision.chosen === 'craft_and_place' &&
        craft?.feasible === true &&
        craftCandidate !== undefined &&
        craftCandidate.meta.prereqPath === 'craft_and_place' &&
        prereqWithheldCraft(decision) === null &&
        !candidateIds.some((id) => id === 'CRAFT:crafting_table'),
      `ids=[${ids(grounded.candidates)}] chosen=${selectPrereqPath(decision)} craft=${craft?.feasible === true ? 'feasible' : (craft?.reason ?? 'missing')}`,
    )
  }

  // (h3) the case the three buddy-driver assertions encode: the remembered furnace
  // is RETIRED (blacklisted / proven unreachable), so no usable station exists and
  // the craft path is allowed again. A blacklisted cell still EXISTS, but it is not
  // USABLE - this is the escape hatch that keeps an unreachable station from
  // starving the smelt, and it is why the station-use rule keys on usability rather
  // than mere existence.
  {
    const retired = MANY_FURNACES.map((entry) => knownStationKey({ name: 'furnace', position: entry.position }))
    const blacklist = new Set(retired)
    const state = world(smeltGoal(), { raw_iron: 3, coal: 4, cobblestone: 200 }, MANY_STATIONS, {
      craftingTables: [{ ...SENSED_TABLE, source: 'sensed' } as StationEntry],
    })
    const grounded = generateGroundedCandidates(state, options(blacklist))
    const decision = planPrereqOptions(furnacePrereqInputFromState(state, options(blacklist)))
    const craft = decision.options.find((option) => option.path === 'craft_and_place')
    const known = decision.options.find((option) => option.path === 'use_known_station')
    const craftCandidate = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:furnace')
    check(
      '(h3) a retired (blacklisted) remembered furnace makes the craft path legitimate again',
      selectPrereqPath(decision) === 'craft_and_place' &&
        craft?.feasible === true &&
        known?.feasible === false &&
        known.reason === 'known_station_unreachable' &&
        craftCandidate !== undefined &&
        craftCandidate.meta.prereqPath === 'craft_and_place' &&
        prereqWithheldCraft(decision) === null,
      `chosen=${selectPrereqPath(decision)} craft=${craft?.feasible === true ? 'feasible' : (craft?.reason ?? 'missing')} known=${known?.reason ?? 'missing'}`,
    )
  }

  // (h4) a held station keeps the inventory-first place route (#78), unchanged by
  // the rule: place_held stays the chosen path and craft_and_place stays ineligible
  // for its own pre-existing reason (`furnace_already_held`), never
  // `station_already_known`.
  {
    const state = world(smeltGoal(), { raw_iron: 3, coal: 4, cobblestone: 200, furnace: 1 }, MANY_STATIONS)
    const grounded = generateGroundedCandidates(state, options())
    const decision = planPrereqOptions(furnacePrereqInputFromState(state, options()))
    const craft = decision.options.find((option) => option.path === 'craft_and_place')
    const place = grounded.candidates.find((candidate) => candidate.kind === 'PLACE')
    check(
      '(h4) a held furnace keeps the place_held route and never reaches the station-use gate',
      selectPrereqPath(decision) === 'place_held' &&
        place !== undefined &&
        place.meta.prereqPath === 'place_held' &&
        craft?.feasible === false &&
        craft.reason === 'furnace_already_held',
      `chosen=${selectPrereqPath(decision)} place=${place?.id ?? 'none'} craft=${craft?.reason ?? 'missing'}`,
    )
  }

  // (b) no station anywhere: crafting the station is STILL a correct route.
  {
    const state = world(queued({}), { cobblestone: 200, oak_planks: 8 }, [])
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const gap = craftStationGap(state, options())
    check(
      '(b) with no station anywhere the station craft is still offered',
      candidateIds.includes('CRAFT:crafting_table') && gap === null,
      `ids=[${ids(grounded.candidates)}] gap=${gap === null ? 'none' : formatCraftStationGap(gap)}`,
    )
  }

  // (b2) no furnace anywhere + a usable sensed table: the furnace craft itself is
  // the correct next step (the rule only withholds DUPLICATE station crafts).
  {
    const state = world(queued({}), { cobblestone: 200 }, [], {
      craftingTables: [{ ...SENSED_TABLE, source: 'sensed' } as StationEntry],
    })
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    check(
      '(b2) with no furnace known the furnace craft at the sensed table is offered',
      candidateIds.includes('CRAFT:furnace') && craftStationGap(state, options()) === null,
      `ids=[${ids(grounded.candidates)}]`,
    )
  }

  // (c) a held station keeps its placement route (inventory first, #78) and the
  // typed fact names the place step, never a craft.
  {
    const state = world(queued({}), { cobblestone: 200, crafting_table: 1 }, [])
    const grounded = generateGroundedCandidates(state, options())
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const gap = craftStationGap(state, options())
    check(
      '(c) a held station still yields the place route, never a craft',
      grounded.candidates.some((candidate) => candidate.kind === 'PLACE') &&
        !candidateIds.some((id) => id === 'CRAFT:crafting_table') &&
        gap !== null &&
        gap.reason === 'station_held' &&
        gap.next === 'place_held',
      `ids=[${ids(grounded.candidates)}] line=${gap === null ? 'none' : formatCraftStationGap(gap)}`,
    )
  }

  // (d) the remembered station is retired (blacklisted / proven unreachable): it
  // is NOT USABLE, so it must not suppress making a new one. The measured live
  // shape (run-mubobiq6-12onv) idled forever because the retired table still
  // counted as "already known"; a retired cell is exactly the case where the
  // local craft becomes legitimate again (pinned by test-tool-recovery).
  {
    const table = station('crafting_table', 0)
    const blacklist = new Set([knownStationKey({ name: 'crafting_table', position: table.position })])
    const state = world(queued({}), { cobblestone: 200, oak_planks: 8 }, [table])
    const grounded = generateGroundedCandidates(state, options(blacklist))
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const gap = craftStationGap(state, options(blacklist))
    const line = gap === null ? 'none' : formatCraftStationGap(gap)
    check(
      '(d) a retired remembered table no longer suppresses the local craft',
      candidateIds.some((id) => id === 'CRAFT:crafting_table') && gap === null,
      `ids=[${ids(grounded.candidates)}] line=${line}`,
    )
  }

  // (d1) the same retired cell with NO craft materials: no duplicate craft is
  // invented (nothing is craftable), and the retired cell is not reported as a
  // usable station either.
  {
    const table = station('crafting_table', 0)
    const blacklist = new Set([knownStationKey({ name: 'crafting_table', position: table.position })])
    const state = world(queued({}), { cobblestone: 200 }, [table])
    const grounded = generateGroundedCandidates(state, options(blacklist))
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    check(
      '(d1) a retired table with no planks yields no unexecutable table craft',
      !candidateIds.some((id) => id === 'CRAFT:crafting_table') &&
        !grounded.candidates.some((candidate) => candidate.kind === 'RETRIEVE'),
      `ids=[${ids(grounded.candidates)}]`,
    )
  }

  // (d2) the smelt lane with every known furnace retired and NO craft route
  // (no table known, no held table, no stone): the existing typed station gap is
  // the answer (`SMELT_STATION_MISSING` + `PREREQ_OPTION chosen=none`), never a
  // silent WAIT.
  {
    const blacklist = new Set(
      MANY_FURNACES.map((entry) => knownStationKey({ name: 'furnace', position: entry.position })),
    )
    const state = world(smeltGoal(), { raw_iron: 3, coal: 4 }, MANY_FURNACES)
    const grounded = generateGroundedCandidates(state, options(blacklist))
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    const decision = planPrereqOptions(furnacePrereqInputFromState(state, options(blacklist)))
    const gap = smeltRouteGap(state, options(blacklist))
    const line = gap === null ? 'none' : formatSmeltRouteGap(gap)
    check(
      '(d2) a smelt whose every known furnace is retired reports the typed station gap',
      !candidateIds.some((id) => id === 'CRAFT:furnace') &&
        !candidateIds.some((id) => id === 'CRAFT:crafting_table') &&
        selectPrereqPath(decision) === null &&
        decision.line.startsWith('PREREQ_OPTION chosen=none') &&
        gap !== null &&
        gap.missing === 'station' &&
        line.startsWith('SMELT_STATION_MISSING') &&
        line.includes('unreachable_stations=['),
      `ids=[${ids(grounded.candidates)}] line=${decision.line} gap=${line}`,
    )
  }

  // The truth helper itself: the count is the world model's, a sensed cell is NOT
  // durable knowledge, and a blacklisted remembered cell still EXISTS (that is
  // what makes the craft illegitimate).
  {
    const state = world(queued({}), { cobblestone: 1 }, MANY_STATIONS)
    const truth = stationWorldTruth(state, options(), 'crafting_table', 'crafting_table')
    const furnaceTruth = stationWorldTruth(state, options(), 'furnace', 'furnace')
    const blacklisted = new Set([knownStationKey({ name: 'crafting_table', position: MANY_TABLES[0]!.position })])
    const retired = stationWorldTruth(state, options(blacklisted), 'crafting_table', 'crafting_table')
    const sensedOnly = world(queued({}), { cobblestone: 1 }, [], {
      craftingTables: [{ ...SENSED_TABLE, source: 'sensed' } as StationEntry],
    })
    const sensedTruth = stationWorldTruth(sensedOnly, options(), 'crafting_table', 'crafting_table')
    check(
      '(e) the station truth counts durable cells, keeps retired cells, and excludes sensed-only cells',
      truth.cells.length === 26 &&
        truth.remembered.length === 26 &&
        furnaceTruth.remembered.length === 17 &&
        stationCraftAllowed(truth) === false &&
        retired.unreachable.length === 1 &&
        stationCraftAllowed(retired) === false &&
        sensedTruth.cells.length === 1 &&
        sensedTruth.remembered.length === 0 &&
        sensedTruth.sensed === 1 &&
        stationCraftAllowed(sensedTruth) === true,
      `tables=${truth.remembered.length} furnaces=${furnaceTruth.remembered.length} retired=${retired.unreachable.length} sensedOnly=${sensedTruth.sensed}/${sensedTruth.remembered.length}`,
    )
  }

  // The wiring: the generator owns the rule, the controller mirrors the typed
  // fact through the same marker family it already uses for craft prerequisites,
  // and the smelt prerequisite's withheld-craft fact is on the mirrored event path
  // (run-scoped evidence that the duplicate craft was refused for a named reason).
  {
    const candidates = source('./src/candidates.ts')
    const controller = `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}\n${source('./src/abandon-lifecycle.ts').replace(/\bhost\./g, 'this.')}`
    const prereq = source('./src/prereqOption.ts')
    const wired =
      candidates.includes('function stationWorldTruth') &&
      candidates.includes('function stationCraftAllowed') &&
      candidates.includes('function planStepCraftsKnownStation') &&
      candidates.includes('export function craftStationGap') &&
      candidates.includes('export function formatCraftStationGap') &&
      candidates.includes('function stationAcquisitionCandidates') &&
      candidates.includes('CRAFT_STATION_ALREADY_KNOWN') &&
      candidates.includes('remembered: nearestFirst') &&
      controller.includes('logCraftStationGap(') &&
      controller.includes('CRAFT_STATION_ALREADY_KNOWN') &&
      prereq.includes('export function prereqWithheldCraft') &&
      prereq.includes('export function formatPrereqStationKnown') &&
      prereq.includes('STATION_ALREADY_KNOWN_REASON') &&
      controller.includes('prereqWithheldCraft(decision)') &&
      controller.includes('formatPrereqStationKnown(') &&
      MIRRORED_MARKERS.has(PREREQ_STATION_ALREADY_KNOWN)
    check(
      '(f) the rule, the typed fact and the controller mirror are wired',
      wired,
      `truth=${candidates.includes('function stationWorldTruth')} allowed=${candidates.includes('function stationCraftAllowed')} planStep=${candidates.includes('function planStepCraftsKnownStation')} gap=${candidates.includes('export function craftStationGap')} ladder=${candidates.includes('function stationAcquisitionCandidates')} durable=${candidates.includes('remembered: nearestFirst')} log=${controller.includes('logCraftStationGap(')} withheld=${controller.includes('prereqWithheldCraft(decision)')} mirrored=${MIRRORED_MARKERS.has(PREREQ_STATION_ALREADY_KNOWN)}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`station-use-before-craft: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
