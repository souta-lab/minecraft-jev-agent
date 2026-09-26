// test-eye-chain.mts - the general CRAFT/DROP chain, measured on M3's eye chain.
//
// WHY (live evidence). M3's terminal condition is `ender_eye >= 12` in ONE run's
// final inventory (AGENTS.md section 5; `tools/m3-gate.mjs#evaluateEnderEyes`),
// and the chain after the Nether is:
//
//   blaze_rod (MOB DROP: blaze)  --craft 1 -> 2-->  blaze_powder
//   ender_pearl (MOB DROP: enderman) + blaze_powder --craft--> ender_eye
//
// so 12 eyes need >= 12 pearls AND >= 12 powder, i.e. >= 6 rods (the ladder's
// `blaze_rods` rung asks 7, a deliberate surplus). Every live run tonight ended
// with `blaze_rod 0` / `ender_pearl 0` while hunts and swings were measured, and
// the two halves of that gap are DIFFERENT defects:
//
//   * the KILL half (a blaze hovering above a fortress ledge ends the lease
//     `HUNT_END reason=unreachable|out_of_range swings=0 hits=0`) belongs to the
//     combat-contact layer and is not this fixture's subject;
//   * the DROP half was genuinely ABSENT from the decision layer. A killed mob
//     leaves an item ENTITY on the ground; the sensor reported it with a position
//     but not an item identity (`EntityState.droppedItem` did not exist), there
//     was no candidate kind for "walk onto that drop", and the executor's
//     reasonable pickup loop (`collectDrop`) could only ever run from inside
//     another action's tail. An item that outlived that bounded window was
//     invisible to the planner forever, and a `craft ender_eye` goal could not
//     even offer the hunt for its own ingredient (`goalKind !== 'collect'`
//     withheld the whole mob-drop producer family).
//
// What this fixture pins, in the five shapes the task names:
//   (i)   the FULL CHAIN with the materials held: 6 rods + 12 pearls -> powder ->
//         12 eyes, and the INVENTORY DELTA is the verification (nothing else is
//         trusted: no marker, no counter).
//   (ii)  a killed mob's DROP: a grounded PICKUP candidate exists for the sensed
//         item entity, and claiming it lands the item in the inventory. The item
//         entity is MODELLED by the fixture's bot (an object with `name: 'item'`
//         and `getDroppedItem()`), and the server's automatic pickup is modelled
//         as "the inventory count rises once the body is inside the pickup
//         volume" - which is the actual mechanic (Mineflayer 4.39.0 sends
//         nothing; it only observes the inbound `collect` packet). The pickup
//         POST-CONDITION is the inventory delta, so a drop the body reaches but
//         does not collect is a typed `pickup_failed`, never a success.
//   (iii) a PARTIAL BATCH: `craft 12 x ender_eye` at 3 eyes still emits the next
//         craft step, so progress is recorded rather than discarded.
//   (iv)  a MISSING INGREDIENT: the typed evidence names the missing ingredient,
//         its raw producer, AND the mob that drops it - three different facts,
//         because `missing=blaze_powder producer=collect blaze_rod` alone does
//         not tell a reader whether the run needed a dig site or a kill.
//   (v)   ordinary crafting is byte-identical: the same goal shapes produce the
//         same candidate ids and the same `CRAFT_INGREDIENT_PREREQ` lines as the
//         pristine tree (literals captured from 877c3ac before this change).
//
// Authority split: code owns CAN/TRUE (which recipe, which mob, what is sensed,
// whether the item actually landed); Jev owns WHICH action; nothing here ranks.
//
// Run: bun test ./test-eye-chain.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  craftIngredientPrereq,
  defaultCandidateOptions,
  formatCraftIngredientPrereq,
  generateGroundedCandidates,
  goalMaterialNeeds,
  mobDropNeedsForGoal,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { createRecipeIndex, planNextCraftStep } from './src/crafting.ts'
import { MIRRORED_MARKERS } from './src/controller-legacy.ts'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import { guardDecision } from './src/policy.ts'
import type { AgentLevel } from './src/jev/client.ts'
import type {
  EntityState,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { GoalKind, GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const REGISTRY = require('minecraft-data')('1.21.11')
const RECIPES = createRecipeIndex(REGISTRY as unknown)

const ENDER_EYE = 'ender_eye'
const ENDER_PEARL = 'ender_pearl'
const BLAZE_POWDER = 'blaze_powder'
const BLAZE_ROD = 'blaze_rod'
const EYES_REQUIRED = 12
const POWDER_PER_ROD = 2
/** The ladder's own threshold (buddy-driver/planner-legacy.ts rung `blaze_rods`). */
const LADDER_BLAZE_RODS = 7
/** The exact rod minimum for 12 eyes: 12 powder / 2 per rod. */
const RODS_EXACT = EYES_REQUIRED / POWDER_PER_ROD

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// ---------------------------------------------------------------------------
// candidate-level world (pure: no bot, no network)
// ---------------------------------------------------------------------------

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }
const FRONTIER: Vec3Json[] = [SELF, { x: 3, y: 61, z: 0 }, { x: 0, y: 61, z: 3 }]

function selfState(): SelfState {
  return {
    username: 'AI_EYE',
    position: SELF,
    eyePosition: { x: SELF.x, y: SELF.y + 1.62, z: SELF.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:the_nether',
    isDay: true,
    heldItem: null,
  }
}

function queuedGoal(kind: GoalKind, targetItem: string, requiredCount: number): QueuedGoal {
  return {
    id: `g1:${kind}:${targetItem}`,
    kind,
    description: `${kind} ${requiredCount} x ${targetItem}`,
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

function goalState(kind: GoalKind, targetItem: string, requiredCount: number): GoalState {
  return {
    id: `${kind}:${targetItem}`,
    description: `${kind} ${requiredCount} x ${targetItem}`,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function world(input: {
  kind: GoalKind
  targetItem: string
  requiredCount: number
  counts: Record<string, number>
  entities?: EntityState[]
}): WorldState {
  const current = queuedGoal(input.kind, input.targetItem, input.requiredCount)
  const inventory: InventoryState = {
    slots: [],
    counts: input.counts,
    totalItems: Object.values(input.counts).reduce((sum, count) => sum + count, 0),
  }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(),
    inventory,
    entities: input.entities ?? [],
    blocks: [],
    terrain: { standable: FRONTIER },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(input.kind, input.targetItem, input.requiredCount),
    goalQueue: { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] } as GoalQueueState,
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

const options = {
  ...defaultCandidateOptions,
  recipes: RECIPES,
  reachability: { memory: null, pathProbe: () => 'reachable' as const },
}

/** JSON id list - the exact shape the pristine probe captured. */
const ids = (candidates: readonly Candidate[]): string => JSON.stringify(candidates.map((c) => c.id))

function offered(state: WorldState): Candidate[] {
  return generateGroundedCandidates(state, options).candidates
}

/** A sensed BLAZE (the only producer of `blaze_rod`), 6 m out. */
const SENSED_BLAZE: EntityState = {
  id: 31,
  name: 'blaze',
  kind: 'hostile',
  username: null,
  position: { x: 6, y: 62, z: 0 },
  distance: 6,
  hostile: true,
  lineOfSight: true,
}

/**
 * A sensed DROPPED ITEM ENTITY (the shape `state.ts#buildEntities` now emits):
 * Mineflayer names the entity `item` and the sensor decodes WHICH item it is.
 */
function droppedItem(id: number, item: string, position: Vec3Json, distance: number): EntityState {
  return {
    id,
    name: 'item',
    kind: 'object',
    username: null,
    position,
    distance,
    hostile: false,
    droppedItem: item,
  }
}

// ---------------------------------------------------------------------------
// executor-level fixture: a bot whose world contains a dropped item ENTITY
// ---------------------------------------------------------------------------

class P {
  constructor(public x: number, public y: number, public z: number) {}
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  offset(x: number, y: number, z: number): P {
    return new P(this.x + x, this.y + y, this.z + z)
  }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

/** Captures the executor's typed markers so the fixture can assert on them. */
class CapturingLogger extends EventLogger {
  readonly lines: string[] = []
  constructor() {
    super(null, false)
  }
  override log(
    source: string,
    level: AgentLevel,
    message: string,
    detail: Record<string, unknown> = {},
    tick: number | null = null,
  ): void {
    this.lines.push(message)
    super.log(source, level, message, detail, tick)
  }
  has(prefix: string): boolean {
    return this.lines.some((line) => line.startsWith(prefix))
  }
  matching(prefix: string): string[] {
    return this.lines.filter((line) => line.startsWith(prefix))
  }
}

interface DropFixture {
  bot: Bot
  logger: CapturingLogger
  held: () => number
  /** how many times the modelled collectblock/`playerCollect` transfer ran */
  pickups: () => number
  dropped: () => boolean
}

/**
 * A dropped-item fixture.
 *
 * MODELLED, and deliberately so: the dropped item is a real entry in
 * `bot.entities` carrying `name: 'item'`, `kind: 'object'` and a working
 * `getDroppedItem()` (exactly what prismarine-entity exposes), and the SERVER's
 * automatic pickup is modelled by the inventory count rising the moment the body
 * is inside the item's pickup volume. Mineflayer itself never moves an item into
 * the inventory (4.39.0 `lib/plugins/entities.js` only observes the inbound
 * `collect` packet), so this is the mechanic and not a shortcut around it.
 *
 *   mode 'in-volume'  the drop rests 1 block away: the body is already inside the
 *                     pickup volume, so the bounded poll collects it with no walk.
 *   mode 'walk'       the drop rests 4 blocks away and the stock collectblock
 *                     plugin is asked to walk the body onto it (the executor's
 *                     real first path in `collectDrop`).
 *   mode 'never'      the drop is sensed but never reaches the inventory.
 */
function makeDropFixture(mode: 'in-volume' | 'walk' | 'never', item = BLAZE_ROD): DropFixture {
  const emitter = new EventEmitter()
  const itemId = REGISTRY.itemsByName[item].id
  const dropPosition = new P(mode === 'walk' ? 4 : 1, 64, 0)
  const feet = new P(0, 64, 0)
  let held = 0
  let pickups = 0
  let collected = false
  const dropEntity: Record<string, unknown> = {
    id: 77,
    name: 'item',
    kind: 'object',
    isValid: true,
    position: dropPosition,
    getDroppedItem: () => ({ name: item, type: itemId, count: 1 }),
  }
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry: REGISTRY,
    health: 20,
    physicsEnabled: true,
    entity: { id: 1, position: feet, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: { 77: dropEntity },
    game: { dimension: 'minecraft:the_nether' },
    inventory: {
      items: () => (held > 0 ? [{ name: item, type: itemId, count: held, slot: 36 }] : []),
      count: (id: number) => (id === itemId ? held : 0),
    },
    // The stock plugin path: it walks the body onto the entity (here: teleports
    // the modelled feet) and the SERVER then collects the item.
    collectBlock: {
      collect: async (entity: { position: { x: number; y: number; z: number } }) => {
        pickups += 1
        feet.x = entity.position.x
        feet.y = entity.position.y
        feet.z = entity.position.z
        if (mode !== 'never') {
          held += 1
          collected = true
          delete (bot.entities as Record<number, unknown>)[77]
        }
      },
    },
    pathfinder: {
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    lookAt: async () => undefined,
    stopDigging: () => undefined,
    setControlState: () => undefined,
    clearControlStates: () => undefined,
  })
  // `in-volume` / `never`: the modelled server pickup fires on the executor's
  // first POST-ATTEMPT inventory read, which is how the real transfer lands (the
  // `collect` packet arrives a tick or two after the body enters the volume, so
  // it is never part of the "before" count). `reads` makes that ordering
  // deterministic instead of timing-dependent.
  if (mode !== 'walk') {
    let reads = 0
    Object.defineProperty(bot.inventory, 'count', {
      value: (id: number) => {
        if (id !== itemId) return 0
        reads += 1
        const inside = Math.hypot(feet.x - dropPosition.x, feet.z - dropPosition.z) <= 1.15
        if (mode === 'in-volume' && reads >= 2 && inside && !collected) {
          collected = true
          held = 1
          delete (bot.entities as Record<number, unknown>)[77]
        }
        return held
      },
      configurable: true,
    })
  }
  return {
    bot: bot as unknown as Bot,
    logger: new CapturingLogger(),
    held: () => held,
    pickups: () => pickups,
    dropped: () => collected,
  }
}

function pickupCandidate(entityId = 77, item = BLAZE_ROD): Candidate {
  return {
    id: `PICKUP:e${entityId}`,
    kind: 'PICKUP',
    label: `walk onto the dropped ${item}`,
    targetName: item,
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: entityId,
    itemName: item,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 1, pickupItem: item, pickupEntityId: entityId, pickupRoute: 'dropped_item_entity' },
  }
}

function makeExecutor(fixture: DropFixture): Executor {
  return new Executor(fixture.bot, fixture.logger, {
    ...defaultExecutorOptions,
    goalItem: BLAZE_ROD,
    verifyTimeoutMs: 1400,
    pickupPathTimeoutMs: 1400,
  })
}

// ===========================================================================
// (i) THE FULL CHAIN with the materials held: the inventory delta verifies it
// ===========================================================================

addCase('(i) 6 rods + 12 pearls craft through blaze_powder into 12 ender_eye (delta-verified)', () => {
  const counts: Record<string, number> = { [BLAZE_ROD]: RODS_EXACT, [ENDER_PEARL]: EYES_REQUIRED }
  const state = world({ kind: 'craft', targetItem: ENDER_EYE, requiredCount: EYES_REQUIRED, counts })
  const sequence: string[] = []
  let guard = 0
  // The mechanical loop: the SAME `planNextCraftStep` the executor's candidate
  // path uses emits one craft op; apply the recipe's own arithmetic to the
  // inventory and repeat. Nothing here advances the inventory except a real
  // recipe effect, so the final counts ARE the verification.
  while ((counts[ENDER_EYE] ?? 0) < EYES_REQUIRED && guard < 64) {
    guard += 1
    const plan = planNextCraftStep(RECIPES, ENDER_EYE, counts, false, EYES_REQUIRED)
    if (plan.op === null || plan.op.type !== 'craft') break
    const op = plan.op
    sequence.push(`${op.item}x${op.count}`)
    const variant = RECIPES.recipesFor(op.item)[0]
    if (variant === undefined) break
    for (const ingredient of variant.ingredients) {
      counts[ingredient.item] = (counts[ingredient.item] ?? 0) - ingredient.count
    }
    counts[op.item] = (counts[op.item] ?? 0) + variant.resultCount
  }
  const powderCrafts = sequence.filter((entry) => entry.startsWith(`${BLAZE_POWDER}x`)).length
  const eyeCrafts = sequence.filter((entry) => entry.startsWith(`${ENDER_EYE}x`)).length
  const pass =
    guard < 64 &&
    eyeCrafts === EYES_REQUIRED &&
    // 12 powder at 2 per craft = exactly 6 powder crafts, then 12 eye crafts
    powderCrafts === RODS_EXACT &&
    counts[ENDER_EYE] === EYES_REQUIRED &&
    counts[BLAZE_POWDER] === 0 &&
    counts[BLAZE_ROD] === 0 &&
    counts[ENDER_PEARL] === 0
  return {
    pass,
    detail:
      `powderCrafts=${powderCrafts} eyeCrafts=${eyeCrafts} steps=${guard} ` +
      `final=${JSON.stringify(counts)} (12 eyes = ${ENDER_PEARL} 12 + ${BLAZE_POWDER} 12 = ${RODS_EXACT} ${BLAZE_ROD}; ` +
      `ladder rung asks ${LADDER_BLAZE_RODS})`,
  }
})

addCase('(i) the BOM the goal reasons with is the same arithmetic (rods 6, pearls 12, powder 12)', () => {
  const bom = goalMaterialNeeds(ENDER_EYE, EYES_REQUIRED, RECIPES, { [ENDER_PEARL]: EYES_REQUIRED })
  const byItem = new Map(bom.map((need) => [need.item, need.required]))
  const pass =
    byItem.get(ENDER_EYE) === EYES_REQUIRED &&
    byItem.get(ENDER_PEARL) === EYES_REQUIRED &&
    byItem.get(BLAZE_POWDER) === EYES_REQUIRED &&
    byItem.get(BLAZE_ROD) === RODS_EXACT
  return { pass, detail: `bom=${JSON.stringify(bom)}` }
})

addCase('(i) the mob-drop need of the CRAFT goal is only what is still short (pearls held -> rods only)', () => {
  const held = mobDropNeedsForGoal(ENDER_EYE, EYES_REQUIRED, RECIPES, { [ENDER_PEARL]: EYES_REQUIRED })
  const empty = mobDropNeedsForGoal(ENDER_EYE, EYES_REQUIRED, RECIPES, {})
  const enough = mobDropNeedsForGoal(ENDER_EYE, EYES_REQUIRED, RECIPES, {
    [ENDER_PEARL]: EYES_REQUIRED,
    [BLAZE_ROD]: RODS_EXACT,
  })
  const pass =
    JSON.stringify(held) === JSON.stringify([BLAZE_ROD]) &&
    JSON.stringify(empty) === JSON.stringify([BLAZE_ROD, ENDER_PEARL]) &&
    enough.length === 0
  return { pass, detail: `pearlsHeld=${JSON.stringify(held)} empty=${JSON.stringify(empty)} satisfied=${JSON.stringify(enough)}` }
})

// ===========================================================================
// (ii) a killed mob's DROP: grounded pickup step, item lands in the inventory
// ===========================================================================

addCase('(ii) a sensed dropped blaze_rod is offered as a grounded PICKUP under craft ender_eye', () => {
  const state = world({
    kind: 'craft',
    targetItem: ENDER_EYE,
    requiredCount: EYES_REQUIRED,
    counts: { [ENDER_PEARL]: EYES_REQUIRED },
    entities: [droppedItem(77, BLAZE_ROD, { x: 1, y: 61, z: 0 }, 1)],
  })
  const candidates = offered(state)
  const pickup = candidates.find((candidate) => candidate.kind === 'PICKUP')
  const pass =
    pickup !== undefined &&
    pickup.id === 'PICKUP:e77' &&
    pickup.itemName === BLAZE_ROD &&
    pickup.targetEntityId === 77 &&
    pickup.meta.pickupRoute === 'dropped_item_entity' &&
    pickup.meta.pickupItem === BLAZE_ROD
  return { pass, detail: `ids=${ids(candidates)} pickup=${JSON.stringify(pickup?.meta ?? null)}` }
})

addCase('(ii) the same drop is offered for collect blaze_rod, and WITHHELD for an unrelated focus', () => {
  const drop = droppedItem(77, BLAZE_ROD, { x: 1, y: 61, z: 0 }, 1)
  const collecting = offered(
    world({ kind: 'collect', targetItem: BLAZE_ROD, requiredCount: LADDER_BLAZE_RODS, counts: {}, entities: [drop] }),
  )
  const unrelated = offered(
    world({ kind: 'collect', targetItem: 'diamond', requiredCount: 3, counts: {}, entities: [drop] }),
  )
  const pass =
    collecting.some((candidate) => candidate.id === 'PICKUP:e77') &&
    !unrelated.some((candidate) => candidate.kind === 'PICKUP')
  return { pass, detail: `collect=${ids(collecting)} unrelated=${ids(unrelated)}` }
})

addCase('(ii) an IDENTITY-LESS item entity is never offered (fail closed, no invented drop)', () => {
  const anonymous: EntityState = {
    id: 78,
    name: 'item',
    kind: 'object',
    username: null,
    position: { x: 1, y: 61, z: 0 },
    distance: 1,
    hostile: false,
    // no `droppedItem`: the client could not decode the stack
  }
  const candidates = offered(
    world({ kind: 'collect', targetItem: BLAZE_ROD, requiredCount: LADDER_BLAZE_RODS, counts: {}, entities: [anonymous] }),
  )
  const pass = !candidates.some((candidate) => candidate.kind === 'PICKUP')
  return { pass, detail: `ids=${ids(candidates)}` }
})

addCase('(ii) the body already inside the pickup volume: PICKUP lands the item (inventory delta)', async () => {
  const fixture = makeDropFixture('in-volume')
  const result = await makeExecutor(fixture).claim(pickupCandidate()).completion
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.itemsGained === 1 &&
    fixture.held() === 1 &&
    fixture.logger.has('PICKUP_ACQUIRED')
  return {
    pass,
    detail:
      `status=${result.status} verified=${result.verified} itemsGained=${result.itemsGained} ` +
      `held=${fixture.held()} marker=${fixture.logger.matching('PICKUP_ACQUIRED')[0] ?? 'none'}`,
  }
})

addCase('(ii) the drop 4 blocks out: the stock collectblock walk collects it, delta-verified', async () => {
  const fixture = makeDropFixture('walk')
  const result = await makeExecutor(fixture).claim(pickupCandidate()).completion
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.itemsGained === 1 &&
    fixture.held() === 1 &&
    fixture.pickups() === 1 &&
    fixture.dropped() === true
  return {
    pass,
    detail: `status=${result.status} itemsGained=${result.itemsGained} held=${fixture.held()} stockWalks=${fixture.pickups()}`,
  }
})

addCase('(ii) both pickup markers are MIRRORED (they reach the run log, not just the console)', () => {
  const pass = MIRRORED_MARKERS.has('PICKUP_ACQUIRED') && MIRRORED_MARKERS.has('PICKUP_NOT_ACQUIRED')
  return {
    pass,
    detail: `PICKUP_ACQUIRED=${MIRRORED_MARKERS.has('PICKUP_ACQUIRED')} PICKUP_NOT_ACQUIRED=${MIRRORED_MARKERS.has('PICKUP_NOT_ACQUIRED')} (a run that killed a mob and failed to collect the drop is distinguishable from one that never killed)`,
  }
})

addCase('(ii) a drop that never lands is pickup_failed + PICKUP_NOT_ACQUIRED, never a banked item', async () => {
  const fixture = makeDropFixture('never')
  const result = await makeExecutor(fixture).claim(pickupCandidate()).completion
  const line = fixture.logger.matching('PICKUP_NOT_ACQUIRED')[0] ?? 'none'
  const pass =
    result.status === 'failed' &&
    result.verified === false &&
    result.failure === 'pickup_failed' &&
    result.itemsGained === 0 &&
    fixture.held() === 0 &&
    line.includes(`item=${BLAZE_ROD}`) &&
    line.includes('goalItemCount=0')
  return {
    pass,
    detail: `status=${result.status} failure=${result.failure} itemsGained=${result.itemsGained} held=${fixture.held()} marker="${line}"`,
  }
})

addCase('(ii) the guard refuses a stale drop entity and a mislabelled item (TARGET_GONE)', () => {
  const ctx = {
    phase: 'decision' as const,
    candidateIds: new Set(['PICKUP:e77']),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 99,
    canComputePath: () => true,
  }
  const live = world({
    kind: 'collect',
    targetItem: BLAZE_ROD,
    requiredCount: LADDER_BLAZE_RODS,
    counts: {},
    entities: [droppedItem(77, BLAZE_ROD, { x: 1, y: 61, z: 0 }, 1)],
  })
  const stale = { ...live, entities: [] }
  const mislabelled = {
    ...live,
    entities: [droppedItem(77, ENDER_PEARL, { x: 1, y: 61, z: 0 }, 1)],
  }
  const okResult = guardDecision('PICKUP:e77', [pickupCandidate()], live, ctx)
  const staleResult = guardDecision('PICKUP:e77', [pickupCandidate()], stale as WorldState, ctx)
  const wrongResult = guardDecision('PICKUP:e77', [pickupCandidate()], mislabelled as WorldState, ctx)
  const pass =
    okResult.ok === true &&
    staleResult.ok === false &&
    staleResult.code === 'TARGET_GONE' &&
    wrongResult.ok === false &&
    wrongResult.code === 'TARGET_GONE'
  return {
    pass,
    detail: `live=${okResult.ok} stale=${staleResult.ok ? 'ok' : staleResult.code} wrongItem=${wrongResult.ok ? 'ok' : wrongResult.code}`,
  }
})

// ===========================================================================
// (iii) a PARTIAL BATCH: progress is recorded, never discarded
// ===========================================================================

addCase('(iii) craft 12 x ender_eye at 3 eyes still offers the next craft step', () => {
  const state = world({
    kind: 'craft',
    targetItem: ENDER_EYE,
    requiredCount: EYES_REQUIRED,
    counts: { [ENDER_EYE]: 3, [ENDER_PEARL]: 9, [BLAZE_POWDER]: 9 },
  })
  const candidates = offered(state)
  const craft = candidates.find((candidate) => candidate.id === `CRAFT:${ENDER_EYE}`)
  return {
    pass: craft !== undefined && craft.meta.craftCount === 1,
    detail: `ids=${ids(candidates)} craft=${JSON.stringify(craft?.meta ?? null)}`,
  }
})

addCase('(iii) the partial batch makes progress at EVERY count 0..11 (no all-or-nothing stall)', () => {
  const stalls: string[] = []
  for (let eyes = 0; eyes < EYES_REQUIRED; eyes += 1) {
    const remaining = EYES_REQUIRED - eyes
    const counts: Record<string, number> =
      eyes === 0
        ? { [BLAZE_POWDER]: remaining, [ENDER_PEARL]: remaining }
        : { [ENDER_EYE]: eyes, [BLAZE_POWDER]: remaining, [ENDER_PEARL]: remaining }
    const state = world({ kind: 'craft', targetItem: ENDER_EYE, requiredCount: EYES_REQUIRED, counts })
    const has = offered(state).some((candidate) => candidate.id === `CRAFT:${ENDER_EYE}`)
    stalls.push(`${eyes}->${has ? 'craft' : 'STALL'}`)
  }
  const pass = !stalls.some((entry) => entry.endsWith('STALL'))
  return { pass, detail: stalls.join(' ') }
})

addCase('(iii) the recorded delta is the crafted amount: 3 eyes -> 4 on one verified craft', () => {
  const before = { [ENDER_EYE]: 3, [ENDER_PEARL]: 9, [BLAZE_POWDER]: 9 }
  const plan = planNextCraftStep(RECIPES, ENDER_EYE, before, false, EYES_REQUIRED)
  const crafted = plan.op?.type === 'craft' ? (RECIPES.recipesFor(ENDER_EYE)[0]?.resultCount ?? 0) : 0
  const after = (before[ENDER_EYE] ?? 0) + crafted
  return {
    pass: plan.op?.type === 'craft' && crafted === 1 && after === 4 && after < EYES_REQUIRED,
    detail: `op=${JSON.stringify(plan.op)} delta=${before[ENDER_EYE]}->${after} (goal ${EYES_REQUIRED} still open)`,
  }
})

// ===========================================================================
// (iv) a MISSING INGREDIENT: the typed evidence names it AND its producer
// ===========================================================================

addCase('(iv) missing blaze_powder names its raw producer AND the mob that drops it', () => {
  const state = world({
    kind: 'craft',
    targetItem: ENDER_EYE,
    requiredCount: EYES_REQUIRED,
    counts: { [ENDER_PEARL]: EYES_REQUIRED },
  })
  const line = craftIngredientPrereq(state, options)
  const rendered = line === null ? 'null' : formatCraftIngredientPrereq(line)
  const expected = `CRAFT_INGREDIENT_PREREQ item=${ENDER_EYE} missing=${BLAZE_POWDER} producer=collect ${BLAZE_ROD} mob=blaze`
  const pass = rendered === expected && MIRRORED_MARKERS.has('CRAFT_INGREDIENT_PREREQ')
  return { pass, detail: `line="${rendered}" mirrored=${MIRRORED_MARKERS.has('CRAFT_INGREDIENT_PREREQ')}` }
})

addCase('(iv) a missing pearl names enderman, and with nothing held the first missing ingredient is the pearl', () => {
  const state = world({ kind: 'craft', targetItem: ENDER_EYE, requiredCount: EYES_REQUIRED, counts: {} })
  const line = craftIngredientPrereq(state, options)
  const rendered = line === null ? 'null' : formatCraftIngredientPrereq(line)
  const expected = `CRAFT_INGREDIENT_PREREQ item=${ENDER_EYE} missing=${ENDER_PEARL} producer=collect ${ENDER_PEARL} mob=enderman`
  return { pass: rendered === expected, detail: `line="${rendered}"` }
})

addCase('(iv) the craft goal OFFERS the hunt for its own mob-drop ingredient when a producer is sensed', () => {
  const state = world({
    kind: 'craft',
    targetItem: ENDER_EYE,
    requiredCount: EYES_REQUIRED,
    counts: { [ENDER_PEARL]: EYES_REQUIRED },
    entities: [SENSED_BLAZE],
  })
  const candidates = offered(state)
  const hunt = candidates.find((candidate) => candidate.kind === 'ATTACK' && candidate.meta.goalDrop === BLAZE_ROD)
  const pass =
    hunt !== undefined &&
    hunt.targetEntityId === 31 &&
    hunt.itemName === BLAZE_ROD &&
    hunt.meta.producerMob === 'blaze' &&
    hunt.meta.producerRoute === 'mob_drop' &&
    hunt.meta.requiresKill === true
  return { pass, detail: `ids=${ids(candidates)} hunt=${JSON.stringify(hunt?.meta ?? null)}` }
})

addCase('(iv) with NO producer sensed, a craft goal emits the typed no-producer gap for its mob drop', () => {
  const state = world({
    kind: 'craft',
    targetItem: ENDER_EYE,
    requiredCount: EYES_REQUIRED,
    counts: { [ENDER_PEARL]: EYES_REQUIRED },
  })
  const grounded = generateGroundedCandidates(state, options)
  const gap = grounded.mobDropGap
  const pass =
    gap !== null &&
    gap.item === BLAZE_ROD &&
    gap.reason === 'no_producer_sensed' &&
    gap.sensed === 0 &&
    JSON.stringify(gap.producers) === JSON.stringify(['blaze']) &&
    gap.next === 'explore'
  return {
    pass,
    detail: gap === null ? 'gap=null (the craft goal named no producer at all)' : `gap=${JSON.stringify(gap)}`,
  }
})

addCase('(iv) a satisfied collect need keeps its pristine gap rule (item = the focus itself)', () => {
  // The `collect X` half is unchanged even when the body already holds enough:
  // the need IS the focus item, not a recipe-derived shortfall.
  const state = world({
    kind: 'collect',
    targetItem: ENDER_PEARL,
    requiredCount: EYES_REQUIRED,
    counts: { [ENDER_PEARL]: EYES_REQUIRED },
  })
  const gap = generateGroundedCandidates(state, options).mobDropGap
  const pass =
    gap !== null && gap.item === ENDER_PEARL && JSON.stringify(gap.producers) === JSON.stringify(['enderman'])
  return {
    pass,
    detail: gap === null ? 'gap=null' : `gap=${JSON.stringify({ item: gap.item, producers: gap.producers, reason: gap.reason })}`,
  }
})

// ===========================================================================
// (v) ordinary crafting is byte-identical (literals captured from 877c3ac)
// ===========================================================================
/** The candidate id lists the PRISTINE tree (877c3ac) offered for these shapes. */
const PRISTINE_SHAPES: ReadonlyArray<readonly [string, WorldState, string]> = [
  [
    'craft crafting_table from 4 planks',
    world({ kind: 'craft', targetItem: 'crafting_table', requiredCount: 1, counts: { oak_planks: 4 } }),
    '["CRAFT:crafting_table","WAIT"]',
  ],
  [
    'craft wooden_pickaxe from 2 planks',
    world({ kind: 'craft', targetItem: 'wooden_pickaxe', requiredCount: 1, counts: { oak_planks: 2 } }),
    '["MOVE:p3_61_0","MOVE:p0_61_3","WAIT"]',
  ],
  [
    'craft diamond_pickaxe from 3 diamond + 2 stick',
    world({ kind: 'craft', targetItem: 'diamond_pickaxe', requiredCount: 1, counts: { diamond: 3, stick: 2 } }),
    '["MOVE:p3_61_0","MOVE:p0_61_3","WAIT"]',
  ],
  [
    'craft ender_eye with pearls + rods but no powder',
    world({ kind: 'craft', targetItem: ENDER_EYE, requiredCount: EYES_REQUIRED, counts: { [ENDER_PEARL]: EYES_REQUIRED, [BLAZE_ROD]: RODS_EXACT } }),
    '["CRAFT:blaze_powder","WAIT"]',
  ],
  [
    'collect blaze_rod with nothing sensed and nothing dropped',
    world({ kind: 'collect', targetItem: BLAZE_ROD, requiredCount: LADDER_BLAZE_RODS, counts: {} }),
    '["MOVE:p3_61_0","MOVE:p0_61_3","WAIT"]',
  ],
  [
    'collect ender_pearl with nothing sensed',
    world({ kind: 'collect', targetItem: ENDER_PEARL, requiredCount: EYES_REQUIRED, counts: {} }),
    '["MOVE:p3_61_0","MOVE:p0_61_3","WAIT"]',
  ],
]

addCase('(v) ordinary crafting offers exactly the pristine candidate ids (6 shapes)', () => {
  const drift: string[] = []
  for (const [name, state, expected] of PRISTINE_SHAPES) {
    const actual = ids(offered(state))
    if (actual !== expected) drift.push(`${name}: ${actual} != ${expected}`)
  }
  return { pass: drift.length === 0, detail: drift.length === 0 ? `all ${PRISTINE_SHAPES.length} shapes identical` : drift.join(' | ') }
})

addCase('(v) a non-mob ingredient keeps the EXACT pristine CRAFT_INGREDIENT_PREREQ line (no mob= suffix)', () => {
  const pickaxe = world({ kind: 'craft', targetItem: 'wooden_pickaxe', requiredCount: 1, counts: { oak_planks: 2 } })
  const table = world({ kind: 'craft', targetItem: 'crafting_table', requiredCount: 1, counts: { oak_planks: 2 } })
  const pickaxeLine = craftIngredientPrereq(pickaxe, options)
  const tableLine = craftIngredientPrereq(table, options)
  const renderedPickaxe = pickaxeLine === null ? 'null' : formatCraftIngredientPrereq(pickaxeLine)
  const renderedTable = tableLine === null ? 'null' : formatCraftIngredientPrereq(tableLine)
  const pass =
    renderedPickaxe === 'CRAFT_INGREDIENT_PREREQ item=wooden_pickaxe missing=oak_planks producer=collect log' &&
    // Captured from the pristine tree (877c3ac) with 2 oak_planks held: the
    // species is grounded by what the body holds, so it keeps its own name.
    renderedTable === 'CRAFT_INGREDIENT_PREREQ item=crafting_table missing=oak_planks producer=collect log' &&
    !renderedPickaxe.includes(' mob=') &&
    !renderedTable.includes(' mob=')
  return {
    pass,
    detail: `pickaxe="${renderedPickaxe}" table="${renderedTable}" oakPlanksVariants=${RECIPES.recipesFor('oak_planks').length} tableVariants=${RECIPES.recipesFor('crafting_table').length}`,
  }
})

addCase('(v) a decomposition recipe never leaks into the goal BOM (3 diamond stays 3 diamond)', () => {
  const bom = goalMaterialNeeds('diamond', 3, RECIPES, {})
  const names = bom.map((need) => need.item)
  const pass = names.includes('diamond') && !names.includes('diamond_block')
  return { pass, detail: `bom=${JSON.stringify(bom)}` }
})

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('eye chain: craft/drop chains are grounded, drops are picked up, and deltas verify\n')
process.stdout.write(`${'-'.repeat(84)}\n`)
for (const testCase of cases) {
  const outcome = await testCase.run()
  if (!outcome.pass) failures += 1
  process.stdout.write(`${outcome.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${outcome.detail}\n`)
}
process.stdout.write(`${'-'.repeat(84)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} eye-chain cases passed\n`)
if (failures > 0) process.exit(1)
