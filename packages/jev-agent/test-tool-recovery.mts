// test-tool-recovery.mts - a route whose missing capability is itself craftable
// from the held inventory must be offered as a craft-then-use chain.
//
// MEASURED LIVE (run-mubobiq6-12onv, source 580705a, m3-live, overworld):
//   HEARTBEAT pos=19.4,80.0,-4.5 health=19 rung=charcoal queue=smelt charcoal depth=1 action=idle
//   inv={oak_log:2,oak_planks:5,stick:4,leaf_litter:16,raw_iron:2,dirt:25,
//        cobblestone:64,iron_ingot:3,raw_copper:11}
//   CANDIDATE_STARVATION presented=2 productive=0 goal="smelt:charcoal:1"
//     missing=["RETRIEVE:known:station:furnace:b8_65_24:tool:pickaxe@0",
//              "RETRIEVE:known:station:crafting_table:b17_71_-11:tool:pickaxe@0"]
// The body stood inside an oak-leaf canopy 7 blocks above the remembered furnace
// with NO pickaxe, so every known station was withheld `needs_descend`
// `missing=[tool:pickaxe@0]`. The duplicate-station-craft guard then refused to
// craft a new table (`stationCraftAllowed` treated the remembered-but-unreachable
// table as usable) and the body idled forever, even though a crafting_table is a
// 2x2 INVENTORY-GRID recipe (4 planks - it holds 5) and a stone_pickaxe is 3
// cobblestone + 2 sticks (it holds 64 and 4).
//
// The fix is capability truth, not a semantic choice:
//   * a station the runtime PROVED unreachable (the gate withheld its RETRIEVE)
//     is not usable, so it must not block making a new one
//     (`stationCraftAllowed` / `retiredStationsFromWithheld`);
//   * a table that must itself be made is a valid route for the 3x3 furnace
//     (`PrereqInput.tableCraftable` / `craftFurnaceCandidate`);
//   * the tool acquisition pass enumerates every tier-satisfying tool the
//     inventory can actually produce (`toolItemsForCapability`).
// Jev/System2 still choose among the grounded candidates; nothing here ranks or
// force-selects.
//
// Run: bun test ./test-tool-recovery.mts
import { createRequire } from 'node:module'
import { defaultCandidateOptions, generateGroundedCandidates, stationCraftAllowed, stationWorldTruth } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { knownStationKey } from './src/prereqOption.ts'
import type { DescentOption, GoalState, InventoryState, KnownResource, StationEntry, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const recipes = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

// --- the measured live world ---------------------------------------------------

const FEET: Vec3Json = { x: 19.4, y: 80.0, z: -4.5 }
const EYE: Vec3Json = { x: FEET.x, y: FEET.y + 1.62, z: FEET.z }
const TABLE_AT: Vec3Json = { x: 17, y: 71, z: -11 }
const FURNACE_AT: Vec3Json = { x: 8, y: 65, z: 24 }
/** the live inventory: everything for the table + stone pickaxe, no pickaxe */
const LIVE_INV: Record<string, number> = {
  oak_log: 2,
  oak_planks: 5,
  stick: 4,
  leaf_litter: 16,
  raw_iron: 2,
  dirt: 25,
  cobblestone: 64,
  iron_ingot: 3,
  raw_copper: 11,
}

function inventory(counts: Record<string, number>): InventoryState {
  return {
    slots: Object.entries(counts).map(([name, count], slot) => ({ name, count, slot })),
    counts,
    totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0),
  }
}

function queued(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g4:smelt:charcoal',
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
    ...overrides,
  }
}

/** A safe down staircase whose cut block needs a pickaxe (the canopy descent). */
function pickaxeDescent(): DescentOption {
  const step: Vec3Json = { x: 19, y: 79, z: -5 }
  return {
    dir: 'N',
    mode: 'down',
    dx: 0,
    dz: -1,
    step,
    wall: { x: step.x, y: step.y + 1, z: step.z },
    head: { x: step.x, y: step.y + 2, z: step.z },
    floor: { x: step.x, y: step.y - 1, z: step.z },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
    diggable: true,
  }
}

const station = (name: string, position: Vec3Json): KnownResource => ({ name, kind: 'station', position })
const KNOWN: KnownResource[] = [station('crafting_table', TABLE_AT), station('furnace', FURNACE_AT)]

function world(
  goal: QueuedGoal,
  counts: Record<string, number>,
  known: KnownResource[],
  unreachable: ReadonlySet<string>,
  extra: Partial<WorldState> = {},
): WorldState {
  const goalState: GoalState = {
    id: goal.id,
    description: goal.description,
    targetItem: goal.targetItem ?? 'charcoal',
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
  return {
    schemaVersion: 1,
    tick: 900,
    timestampMs: 1_700_000_000_000,
    self: {
      username: 'AI_TOOL_RECOVERY',
      position: FEET,
      eyePosition: EYE,
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 19,
      food: 20,
      gameMode: 'survival',
      dimension: 'overworld',
      isDay: true,
      heldItem: null,
    },
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    terrain: { standable: [FEET, { x: 19, y: 80, z: -4 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [{ x: 20, y: 80, z: -4 }],
    descent: [pickaxeDescent()],
    stepCuts: [],
    headroomCuts: [],
    goal: goalState,
    goalQueue: queue,
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
      knownResources: known,
    },
    ...extra,
  }
}

const options = (unreachable: ReadonlySet<string> = new Set()): typeof defaultCandidateOptions => ({
  ...defaultCandidateOptions,
  recipes,
  unreachableStations: unreachable,
})

const ids = (candidates: readonly Candidate[]): string => candidates.map((candidate) => candidate.id).join(', ')
const isProductive = (candidate: Candidate): boolean => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'
const stationRetrieve = (candidates: readonly Candidate[]): Candidate | undefined =>
  candidates.find((candidate) => candidate.kind === 'RETRIEVE' && candidate.meta.resourceKind === 'station')

function main(): void {
  process.stdout.write('tool recovery: a missing capability craftable from the inventory is offered\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (a) THE LIVE SHAPE. The controller's explicit unreachable set is empty (the
  // one-decision lag), so both station retrieves are generated and the gate
  // withholds them for `needs_descend` + `tool:pickaxe@0`. The gate must still
  // surface the 2x2 inventory-grid table craft instead of a WAIT/ESCALATE pair.
  {
    const state = world(queued({}), LIVE_INV, KNOWN, new Set())
    const grounded = generateGroundedCandidates(state, options())
    const table = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:crafting_table')
    const withheldTool = grounded.withheld.filter((entry) =>
      entry.result.missingCapabilities.some((capability) => capability.kind === 'tool' && capability.tool === 'pickaxe'),
    )
    const productive = grounded.candidates.filter(isProductive)
    check(
      '(a) live shape: both station retrieves are withheld for tool:pickaxe@0',
      withheldTool.length === 2 &&
        withheldTool.every((entry) => entry.result.reason === 'needs_descend'),
      `withheld=[${grounded.withheld.map((entry) => `${entry.candidate.id}:${entry.result.reason}`).join(', ')}]`,
    )
    check(
      '(a) live shape: the 2x2 inventory-grid craft:crafting_table is offered as the enabling step',
      table !== undefined &&
        table.kind === 'CRAFT' &&
        table.meta.capabilityAcquisition === true &&
        table.meta.missingCapability === 'tool:pickaxe@0' &&
        table.meta.requiresTable === false,
      `table=${table === undefined ? 'none' : JSON.stringify({ id: table.id, cap: table.meta.missingCapability, requiresTable: table.meta.requiresTable })}`,
    )
    check(
      '(a) live shape: the body is no longer starved (>=1 productive candidate)',
      productive.length >= 1,
      `presented=[${ids(grounded.candidates)}]`,
    )
  }

  // (a2) ONCE THE TABLE IS PLACED (planks 5 -> 1, table sensed in reach), the
  // still-withheld station retrieve must yield the table-requiring pickaxe the
  // inventory can actually make: craft:stone_pickaxe (3 cobblestone + 2 sticks).
  {
    const state = world(queued({}), { ...LIVE_INV, oak_planks: 1 }, KNOWN, new Set(), {
      craftingTables: [{ x: 20, y: 80, z: -4, source: 'sensed' } as StationEntry],
    })
    const grounded = generateGroundedCandidates(state, options())
    const stone = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:stone_pickaxe')
    check(
      '(a2) after the table is placed, craft:stone_pickaxe follows for the withheld station route',
      stone !== undefined &&
        stone.kind === 'CRAFT' &&
        stone.meta.capabilityAcquisition === true &&
        stone.meta.missingCapability === 'tool:pickaxe@0',
      `presented=[${ids(grounded.candidates)}]`,
    )
  }

  // (a3) the System2 plan head is `craft 1 x furnace`: the same enabling chain
  // must be offered there (the compressor compiled craft furnace -> place furnace
  // -> smelt charcoal, and the furnace craft is a 3x3 recipe).
  {
    const state = world(
      queued({ id: 'g17:craft:furnace', kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace' }),
      LIVE_INV,
      KNOWN,
      new Set(),
    )
    const grounded = generateGroundedCandidates(state, options())
    const table = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:crafting_table')
    check(
      '(a3) craft:furnace with only unreachable stations offers the table craft',
      table !== undefined && table.meta.requiresTable === false,
      `presented=[${ids(grounded.candidates)}]`,
    )
  }

  // (b) THE MATERIALS ARE NOT HELD: no unexecutable craft may be fabricated and
  // the refusal must NAME the missing tool instead of silently idling.
  {
    const state = world(queued({}), { dirt: 3 }, KNOWN, new Set())
    const grounded = generateGroundedCandidates(state, options())
    const bogusCraft = grounded.candidates.some(
      (candidate) => candidate.id === 'CRAFT:crafting_table' || candidate.id === 'CRAFT:stone_pickaxe',
    )
    const escalate = grounded.candidates.find((candidate) => candidate.kind === 'ESCALATE')
    const named =
      String(escalate?.meta.capabilities ?? '').includes('tool:pickaxe') ||
      grounded.withheld.some((entry) =>
        entry.result.missingCapabilities.some((capability) => capability.kind === 'tool' && capability.tool === 'pickaxe'),
      )
    check(
      '(b) with no materials the recovery fabricates no unexecutable craft and names the missing tool',
      !bogusCraft && named,
      `presented=[${ids(grounded.candidates)}] escalate=${escalate === undefined ? 'none' : String(escalate.meta.capabilities ?? '')} withheld=[${grounded.withheld.map((entry) => entry.candidate.id).join(', ')}]`,
    )
  }

  // (c) A REACHABLE STATION IS UNCHANGED: the retrieve is offered, nothing is
  // crafted, and the duplicate-craft guard still fires.
  {
    const nearTable: KnownResource = station('crafting_table', { x: 19, y: 80, z: -3 })
    const state = world(queued({ id: 'g17:craft:furnace', kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace' }), LIVE_INV, [nearTable], new Set())
    const grounded = generateGroundedCandidates(state, options())
    const retrieve = stationRetrieve(grounded.candidates)
    const strayCraft = grounded.candidates.some((candidate) => candidate.id === 'CRAFT:crafting_table')
    check(
      '(c) a reachable known station keeps the existing retrieve path and no redundant craft',
      retrieve !== undefined && !strayCraft,
      `presented=[${ids(grounded.candidates)}]`,
    )
  }

  // (d) A NORMAL CRAFT CHAIN IS UNCHANGED: a craft goal with a sensed table and
  // its own inputs held yields exactly that craft step.
  {
    const state = world(
      queued({ id: 'g3:craft:wooden_pickaxe', kind: 'craft', description: 'craft 1 x wooden_pickaxe', targetItem: 'wooden_pickaxe' }),
      { oak_planks: 5, stick: 4 },
      [],
      new Set(),
      { craftingTables: [{ x: 20, y: 80, z: -4, source: 'sensed' } as StationEntry] },
    )
    const grounded = generateGroundedCandidates(state, options())
    const craft = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:wooden_pickaxe')
    check(
      '(d) a normal craft chain is unchanged',
      craft !== undefined && craft.meta.craftItem === 'wooden_pickaxe',
      `presented=[${ids(grounded.candidates)}]`,
    )
  }

  // The truth helpers behind the fix: a retired remembered cell makes the craft
  // legal again, and the acquisition closure names the pass's own refusals.
  {
    const state = world(queued({}), LIVE_INV, KNOWN, new Set())
    const retired = new Set([
      knownStationKey({ name: 'crafting_table', position: TABLE_AT }),
      knownStationKey({ name: 'furnace', position: FURNACE_AT }),
    ])
    const truth = stationWorldTruth(state, options(retired), 'crafting_table', 'crafting_table')
    const openTruth = stationWorldTruth(state, options(), 'crafting_table', 'crafting_table')
    check(
      '(e) all-retired stations make the station craft legal; an unretired one does not',
      stationCraftAllowed(truth) === true && stationCraftAllowed(openTruth) === false,
      `retired=${truth.unreachable.length}/${truth.remembered.length} allowed=${stationCraftAllowed(truth)} open=${stationCraftAllowed(openTruth)}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`tool-recovery: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
