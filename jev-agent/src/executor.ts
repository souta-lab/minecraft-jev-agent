// executor.ts - the EXECUTOR.
//
// Owns exactly ONE action at a time. The mechanism is
//   actionEpoch + AbortController + currentAction
// with a strict rule: a new higher-level decision CANCELS the previous action
// before taking ownership. `bot.dig()` is therefore never concurrent, and the
// invariant is asserted (not assumed) in `own()`.
//
// It also pins the movement policy: `movements.canDig = false` and an empty
// scaffolding list, so the bot WALKS to the target and never tunnels through
// the world to reach it. Breaking a block happens only via an explicit,
// guarded `bot.dig()` on the block the policy actually selected.
import pathfinderModule from 'mineflayer-pathfinder'
import type { PartiallyComputedPath } from 'mineflayer-pathfinder'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import type { Candidate, CandidateKind } from './candidates.ts'
import type { ActuationPort } from './actuationPort.ts'
import type { EventLogger } from './jev.ts'
import type { PathStatus, Vec3Json } from './state.ts'
import { distance, PICKAXE_RANKS, resolveBlockHarvest, toVec3, PROBE_FLUIDS, PROBE_HAZARDS, isBreakableSolidBlock } from './state.ts'
import { selectDigTool, toolLabel } from './toolChoice.ts'
import type { DigBlockInfo, ToolChoice } from './toolChoice.ts'
import { craftAtTable } from './craftWindow.ts'
import type { CraftRecipeLike } from './craftWindow.ts'
import { isFuelItem } from './gameData.ts'
import { formatFurnaceReady } from './placementGuard.ts'
import { isPlacePostconditionMet, isSmeltPostconditionMet, describeActionPostcondition, isUnverifiedOutcome } from './actionPostcondition.ts'
import {
  classifyHeadroomBlocker,
  evaluatePillarStep,
  evaluateTunnelEntry,
  formatAscentProgress,
  formatLocalClear,
  formatPillarRefused,
  formatPillarRelocate,
  formatTunnelEntryRefused,
  headroomAcrossFootprint,
  planReuseLeg,
  resolvePillarStep,
  shouldReplanAfterVerticalChunk,
  verticalStepTowardTarget,
} from './verticalPlan.ts'
import type {
  ApproachBlockage,
  HeadroomClearOutcome,
  HeadroomObstacle,
  TunnelEntryBlockerProbe,
  TunnelEntryProbe,
} from './verticalPlan.ts'
import {
  decidePillarPlaceBlock,
  decidePillarRelocation,
  decidePillarStepBudget,
  DEFAULT_PILLAR_SEARCH_POLICY,
  formatPillarSearch,
} from './pillarSearch.ts'
import type { PillarColumnProbe } from './pillarSearch.ts'
import {
  formatPillarFail,
  formatPillarRetire,
  isPillarRefusalUnsatisfiable,
  pillarArcComplete,
  pillarStepUp,
  requiredColumnClearance,
  shouldRelocatePillarAfterFailure,
  takeoffObservedRise,
} from './pillarApex.ts'
import type { PillarRefusalEvidence } from './pillarApex.ts'
import {
  buildPillarTakeoffTelemetry,
  formatPillarTakeoffTelemetry,
  makePillarAttemptId,
  readControlState,
} from './pillarTakeoffTelemetry.ts'
import {
  formatPillarUpStep,
  installGroundCorrection,
  PILLAR_TAKEOFF_BUDGET_MS,
  PILLAR_TAKEOFF_POLL_MS,
} from './pillarJump.ts'
import type { PillarJumpTrace, SolidAt } from './pillarJump.ts'
import { formatHopPlan, planVerticalHop } from './hopPolicy.ts'

const { Movements, goals } = pathfinderModule

/**
 * Server `position` packets per bot, shared by every Executor instance built for
 * that bot (setOptions() rebuilds the executor). `mineflayer` emits `forcedMove`
 * when the server teleports the player, so this is the rubber-band count.
 */
const forcedMoveTrackers = new WeakMap<Bot, { value: number }>()

export function forcedMoveTracker(bot: Bot): { value: number } {
  const existing = forcedMoveTrackers.get(bot)
  if (existing !== undefined) return existing
  const tracker = { value: 0 }
  forcedMoveTrackers.set(bot, tracker)
  bot.on('forcedMove', () => {
    tracker.value += 1
  })
  return tracker
}

export type FailureCode =
  | 'path_no_path'
  | 'path_timeout'
  | 'path_stuck'
  | 'tunnel_entry_refused'
  | 'out_of_reach'
  | 'dig_error'
  | 'dig_timeout'
  | 'craft_error'
  | 'place_error'
  | 'smelt_error'
  | 'smelt_timeout'
  | 'target_gone'
  | 'verify_failed'
  | 'cancelled'
  | 'unknown_event'

export interface ExecutionResult {
  actionId: string
  kind: CandidateKind
  /** the block/entity name the action targeted, when it has one */
  targetName: string | null
  epoch: number
  status: 'done' | 'failed' | 'cancelled'
  phase: string
  detail: string
  failure: FailureCode | null
  verified: boolean
  blockRemoved: boolean
  dropObserved: boolean
  itemsGained: number
  goalItemCount: number
  /**
   * Deterministic evidence that the action durably changed the body even
   * though no block was removed and no item was gained (a bounded PILLAR_UP
   * chunk that gained altitude). Never a substitute for `verified`.
   */
  progressed: boolean
  /**
   * A RETRIEVE proved the remaining feet-distance to the remembered target
   * shrank by the meaningful epsilon. This is completion evidence the truth
   * layer may trust; `progressed` (a vertical chunk step) never is.
   */
  distanceClosed?: boolean
  /** item the action actually produced (MINE drop or crafted item), when known */
  yieldItem?: string | null
  /**
   * #79: set when the action finished `done` but its post-condition was unmet
   * with zero observable change (verified=false, progressDelta=0, no block
   * removed). The result is downgraded to `failed`; the controller logs
   * ACTION_UNVERIFIED and charges the unverified budget against the plan.
   */
  unverifiedPostcondition?: string
  ms: number
}

export interface CurrentAction {
  id: string
  kind: CandidateKind
  epoch: number
  startedAt: number
  phase: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  detail: string
  completion: Promise<ExecutionResult>
}

export interface ClaimResult {
  /** true when the same action is already running and ownership was retained */
  kept: boolean
  epoch: number
  completion: Promise<ExecutionResult>
}

export class ActionCancelled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionCancelled'
  }
}

export class ExecutorError extends Error {
  readonly code: FailureCode
  constructor(code: FailureCode, message: string) {
    super(message)
    this.name = 'ExecutorError'
    this.code = code
  }
}

type PathOutcome = 'reached' | 'noPath' | 'timeout' | 'stuck' | 'cancelled'

export type ActuationMode = 'pathfinder' | 'packet'

export interface PathCompletedEvent {
  actionId: string
  target: Vec3Json
  mode: ActuationMode
}

export interface PathFailedEvent {
  actionId: string
  target: Vec3Json
  mode: ActuationMode
  outcome: 'noPath' | 'stuck' | 'timeout'
}

export interface ExecutorHooks {
  onPathCompleted?: (event: PathCompletedEvent) => void
  /** fired when pathing fails, so the scheduler can wake Jev on stuck/noPath */
  onPathFailed?: (event: PathFailedEvent) => void
}

export interface ExecutorOptions {
  reach: number
  pathTimeoutMs: number
  pickupPathTimeoutMs: number
  digTimeoutMs: number
  verifyTimeoutMs: number
  smeltTimeoutMs: number
  goalItem: string
  /**
   * STOCK-FIRST. 'pathfinder' is the primary MOVE path: `bot.pathfinder.setGoal`
   * lets the stock pathfinder drive `setControlState` and Mineflayer physics tick.
   * Live evidence on this Leaf 26.1 server: stock traverses a 1-block pit with
   * `forcedRepositions=0`, but cannot climb a 1-block step (`path_reset stuck`,
   * dy=0, forcedRepositions=116). 'pathfinder' therefore falls back to our
   * control-walk actuator (`walkByControls`, headroom-gated) only when stock
   * reports stuck/noPath/timeout. 'packet' keeps the legacy pathfinder-planner +
   * `position_look` actuator for the same fallback position.
   */
  actuation: ActuationMode
  /**
   * #38: allowlist actuation capability from the resident. When present, the
   * raw movement packet, the packet-step entity pose write and the stock
   * collectblock call go through it (each asserts the actuation lease) instead
   * of `bot._client`/`bot.entity`/`bot.collectBlock`. Absent standalone.
   */
  actuationPort?: ActuationPort
  packetStepMs: number
  maxStepsPerWaypoint: number
  hooks?: ExecutorHooks
}

/** The control nudge walks ONTO the drop, so it aims inside the pickup volume. */
const PICKUP_APPROACH_RADIUS = 0.7
/** Same-level drops are picked up within ~1.3 m, so a wider window is enough. */
const PICKUP_SAME_LEVEL_RADIUS = 1.15
/** After this many stalled nudges, probe a perpendicular bearing around the drop. */
const PICKUP_BEARING_RETRY_AFTER = 3
/** Bounded per-item approach so an unreachable drop never wedges the run. */
const PICKUP_NUDGE_BUDGET_MS = 2500
/** Reserved window for the control nudge after the STOCK collectblock slice. */
const PICKUP_NUDGE_TOTAL_MS = 6000
/**
 * `mineflayer-collectblock` drives `pathfinder.goto(GoalFollow(entity,0))`, which
 * on the 1.21.11 Leaf server never resolves for a ground drop (the dynamic goal
 * re-paths on `path_reset stuck` forever). It is therefore given a SMALL bounded
 * slice so the collision-shape-independent control nudge always gets its own
 * reserved budget instead of inheriting an exhausted deadline.
 */
const STOCK_COLLECT_BUDGET_MS = 2500
/** A dug drop lands within a block of the mined block; unrelated items do not. */
const DROP_SEARCH_RADIUS = 4

const PLACED_APPROACH_HORIZONTAL = 2.8
const PLACED_STOCK_BUDGET_MS = 3000
const PLACED_NUDGE_BUDGET_MS = 1800
const PLACED_NUDGE_TOTAL_MS = 5000
const PLACED_MAX_STEP_CUTS = 3
/** #79: bounded settle for the PLACE post-condition (client world is one tick behind the server). */
const PLACE_VERIFY_SETTLE_MS = 500

/** PILLAR_UP: jump-apex window in which the block is placed under the feet. */
const PILLAR_APEX_BUDGET_MS = 700
/** PILLAR_UP: settle window for the bot to land on the placed block. */
const PILLAR_LANDING_BUDGET_MS = 2000
/** PILLAR_UP: bounded same-cell nudge away from an adjacent AABB blocker. */
const PILLAR_RECENTER_BUDGET_MS = 1500
/**
 * PILLAR_UP relocation budget: `PillarSearchPolicy.maxRelocations`. Two keeps
 * the action bounded while allowing one retry if the first open neighbour was
 * mis-read; the refused-column set stops any ping-pong between two cells.
 */
const PILLAR_SEARCH_POLICY = DEFAULT_PILLAR_SEARCH_POLICY

/** Stable key for the refused-column set (never fed back into world state). */
function pillarColumnKey(cell: Vec3Json): string {
  return `${cell.x},${cell.y},${cell.z}`
}

/** The cell itself plus its six face neighbours: the flood check for a dig. */
const DIG_SAFETY_OFFSETS: readonly Vec3Json[] = [
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

interface PillarUpPlan {
  placeName: string
  toY: number
  steps: number
}

/** A jump is allowed only with at least two clear blocks above the feet. */
export function headroomSufficient(above1Empty: boolean, above2Empty: boolean): boolean {
  return above1Empty && above2Empty
}

/** How far ahead the terrain-contact probe reads the facing column (blocks). */
const FACE_PROBE_DIST = 0.8

export type ClimbManeuver = 'pre-contact-jump' | 'vertical-hop' | 'continue'

export interface ClimbManeuverInput {
  climbDetected: boolean
  onGround: boolean
  pinned: boolean
  faceAtFeet: boolean
  standingStill: boolean
}

/**
 * The 1-block pit / step decision, extracted so it is unit-testable without a
 * live bot. The Leaf server rejects a movement packet that combines a blocked
 * forward push with a jump (position teleport), so:
 *
 *  - free front (`!contact`): jump PRE-CONTACT with forward held, while the
 *    horizontal move is still unblocked;
 *  - terrain contact (`pinned`/`faceAtFeet`): pure vertical hop first (forward
 *    released), then push forward while airborne.
 *
 * A 1-deep depression is escaped by the contact hop, never by backing off.
 */
export function planClimbManeuver(input: ClimbManeuverInput): ClimbManeuver {
  const contact = input.pinned || input.faceAtFeet
  if (input.climbDetected && input.onGround && !contact) return 'pre-contact-jump'
  if (contact || input.standingStill) return 'vertical-hop'
  return 'continue'
}

/**
 * The vertical-hop body rule, owned by `hopPolicy.planVerticalHop`: a free body
 * holds `forward` through the jump so the packet carries the horizontal
 * component; a pinned body releases forward for the pure jump because the
 * server rejects a blocked forward push combined with a jump. Re-exported for
 * the existing pit-escape regression.
 */
export { hopHoldsForward } from './hopPolicy.ts'

export interface HopOutcome {
  dy: number
  occupiedTarget: boolean
  hopOk: boolean
  /** The JUMP_ESCAPE marker emitted when the hop cleared the step, else null. */
  escapeMarker: string | null
}

/**
 * The hop outcome and its JUMP_ESCAPE marker, extracted so the pit-escape
 * regression can assert the marker without a live bot. `hopOk` is unchanged:
 * `dy >= 0.75` (the measured 1-block climb) or a landing on the target node.
 */
export function evaluateHop(before: Vec3Json, after: Vec3Json, node: Vec3Json): HopOutcome {
  const dy = after.y - before.y
  const occupiedTarget =
    Math.hypot(after.x - (node.x + 0.5), after.z - (node.z + 0.5)) <= 1.1 &&
    Math.abs(after.y - node.y) <= 1
  const hopOk = dy >= 0.75 || occupiedTarget
  return {
    dy,
    occupiedTarget,
    hopOk,
    escapeMarker: hopOk
      ? `JUMP_ESCAPE rise=${round2(dy)} from=(${round2(before.x)},${round2(before.y)},${round2(before.z)}) to=(${round2(after.x)},${round2(after.y)},${round2(after.z)}) target=(${node.x},${node.y},${node.z})`
      : null,
  }
}

export interface MoveArrivalInput {
  /** feet position after the action */
  end: Vec3Json
  /** the standable spot the MOVE was for (a block cell) */
  target: Vec3Json
  /** the anchored resource block, or null for a pure-spot MOVE (explore/retreat) */
  anchor: Vec3Json | null
  /** eyes->anchor distance before the action; null when there is no anchor */
  anchorBefore: number | null
  /** eyes->anchor distance after the action (or feet->target when there is no anchor) */
  anchorDistance: number
  reach: number
  /** the body is still pinned against terrain the actuator could not climb */
  pinned: boolean
}

/** `true` when `end` occupies the same integer block cell as `b`. */
export function sameBlockCell(end: Vec3Json, b: Vec3Json): boolean {
  const cell = (value: number): number => Math.floor(value + 1e-3)
  return cell(end.x) === b.x && cell(end.y) === b.y && cell(end.z) === b.z
}

/**
 * Honest MOVE arrival. `atTarget` requires the FEET to occupy the target's block
 * cell, never merely to be within ~1 m of it.
 *
 * Live `MOVE:p29_58_35` evidence (2026-09-19T10:06:41Z): the packet stepper
 * wrote a transient client pose `end=(28.9,58,35.96)` for `target=(29,58,35)`
 * (cell x=28, one block off) and the server snapped the bot back to
 * `(28.7,59,36.11)`; the old `after <= 1.0` check plus the anchor-null recovery
 * (`after <= 1.5`) reported `verified=true`, so the controller reset the
 * move-failure memory and the exact same MOVE retried forever.
 *
 * The anchored-block recovery is only meaningful when an anchor exists, so it
 * can never degenerate into a bare feet-distance tolerance. A partial step that
 * leaves the spot unreached and the anchor already in reach is NOT success
 * (MOVE:b36_75_-44, a 4-block tree the bot could not climb).
 */
export function classifyMoveArrival(input: MoveArrivalInput): {
  atTarget: boolean
  anchorNowInReach: boolean
  verified: boolean
} {
  const atTarget = !input.pinned && sameBlockCell(input.end, input.target)
  const anchorNowInReach =
    input.anchor !== null &&
    input.anchorDistance <= input.reach &&
    !(input.anchorBefore !== null && input.anchorBefore <= input.reach)
  return { atTarget, anchorNowInReach, verified: atTarget || anchorNowInReach }
}

/** The feet-distance slack that counts as "arrived" for a remembered retrieve. */
export const RETRIEVE_ARRIVAL_RADIUS = 2

/**
 * A retrieve must close at least this much feet distance to count as forward
 * progress. It mirrors `classifyMoveOutcome`'s 0.5 m "moved" threshold so the
 * controller's move-failure memory and this classifier agree on what progress
 * is: a sub-threshold creep is a stall, not an arrival.
 */
export const RETRIEVE_CLOSE_EPSILON = 0.5

export type RetrieveApproachOutcome = 'arrived' | 'progressed' | 'stalled'

export interface RetrieveApproachInput {
  /** feet→target distance before the horizontal approach leg (metres) */
  distanceBefore: number
  /** feet→target distance after the horizontal approach leg (metres) */
  distanceAfter: number
  /** feet Y before the action began */
  startY: number
  /** feet Y now */
  endY: number
  /** the remembered target Y */
  targetY: number
  /** a bounded vertical leg produced a durable body change (Y moved toward target) */
  verticalStep: boolean
  /** the approach leg raised a typed movement error (GoalNear stuck / packet locomotion blocked) */
  approachFailed: boolean
}

export interface RetrieveApproachDecision {
  outcome: RetrieveApproachOutcome
  arrived: boolean
  /** feet closed at least `RETRIEVE_CLOSE_EPSILON` toward the target */
  closed: boolean
  /** |endY-targetY| shrank by more than 0.01 */
  verticalProgress: boolean
  /** the result may be recorded as done/verified */
  verified: boolean
}

/**
 * Honest retrieval-approach outcome, the RETRIEVE analogue of
 * `classifyMoveArrival`. A remembered station/resource retrieve is only
 * `arrived` when the feet are within `RETRIEVE_ARRIVAL_RADIUS`; a bounded
 * vertical leg that gained altitude is `progressed`; everything else is
 * `stalled`.
 *
 * The live M2 defect: `runRetrieve` swallowed the typed `pathToNear` error
 * (`GoalNear -> stuck` / no jump headroom / `packet locomotion blocked`) and
 * still returned a soft `done`. The route never closed, `FURNACE_READY` never
 * fired, and the same blocked retrieve kept being re-selected because no typed
 * failure reached the controller's retirement machinery. A raised approach
 * error is therefore only survivable with durable vertical progress; otherwise
 * the caller must fail loudly with the original typed code.
 */
export function classifyRetrieveApproach(input: RetrieveApproachInput): RetrieveApproachDecision {
  const arrived = input.distanceAfter <= RETRIEVE_ARRIVAL_RADIUS
  const closed = input.distanceAfter <= input.distanceBefore - RETRIEVE_CLOSE_EPSILON
  const verticalProgress = Math.abs(input.endY - input.targetY) < Math.abs(input.startY - input.targetY) - 0.01
  const progressed = input.verticalStep || verticalProgress || (!input.approachFailed && closed)
  const outcome: RetrieveApproachOutcome = arrived ? 'arrived' : progressed ? 'progressed' : 'stalled'
  return {
    outcome,
    arrived,
    closed,
    verticalProgress,
    verified: arrived || verticalProgress || input.verticalStep,
  }
}

export interface RetrieveOutcomeInput {
  /** feet->target distance before the retrieve attempt */
  before: number
  /** feet->target distance after the retrieve attempt */
  after: number
  /** a vertical leg carried the body toward the target's Y */
  verticalStep: boolean
  /** the vertical gap to the target's Y shrank (the body moved) */
  verticalProgress: boolean
}

export interface RetrieveOutcome {
  /** the remaining distance to the target actually decreased */
  closed: boolean
  /** completion of the RETRIEVE post-condition; never `verticalStep` alone */
  verified: boolean
  /** durable body evidence toward the target that is NOT completion */
  progressed: boolean
}

/**
 * Honest RETRIEVE outcome. A retrieve completes only when the remaining
 * distance to the remembered target actually decreased (`closed`): a bounded
 * vertical chunk or a reuse-tunnel nudge toward the target's Y is durable
 * `progressed` evidence - never completion.
 *
 * Live M2 boundary (RC 42cb46e, target 36,56,41):
 *   `arrival targetDistance=11.26m->11.25m y=59.5->58 vertical=reuse`
 * reported `verified=true status=done progressDelta=0` even though the distance
 * did NOT shrink, and the controller then logged `MOVE_FAILMEM_RESET` while the
 * inventory never gained raw_iron and PATH_CALLBACK stayed `outcome=stuck`.
 * `verticalProgress`/`verticalStep` must not promote an unreached retrieve.
 */
export function classifyRetrieveOutcome(input: RetrieveOutcomeInput): RetrieveOutcome {
  const closed = input.after < input.before - 0.01
  return {
    closed,
    verified: closed,
    progressed: input.verticalStep || input.verticalProgress,
  }
}

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker'])

export interface SmeltFurnaceSlot {
  count: number
  /** Mineflayer exposes the concrete item name; test doubles may omit it. */
  name?: string
}

export interface SmeltFurnaceWindow {
  putInput(type: number, metadata: number | null, count: number): Promise<unknown>
  putFuel(type: number, metadata: number | null, count: number): Promise<unknown>
  outputItem(): SmeltFurnaceSlot | null
  takeOutput(): Promise<unknown>
  /**
   * #79: the input stack still inside the furnace, when this window exposes it.
   * A smaller-than-placed stack is the evidence that the furnace consumed the
   * input. Windows that cannot report the slot can only verify via `outputItem`.
   */
  inputItem?(): SmeltFurnaceSlot | null
  /** #79: the fuel stack still inside the furnace, when this window exposes it. */
  fuelItem?(): SmeltFurnaceSlot | null
  /** Mineflayer can return a partially transferred input/fuel to the inventory. */
  takeInput?(): Promise<unknown>
  takeFuel?(): Promise<unknown>
  close(): void
}

export interface SmeltInventoryItem {
  name: string
  type: number
  count: number
}

export interface SmeltExecutionDeps {
  openFurnace(): Promise<SmeltFurnaceWindow>
  inventoryItems(): SmeltInventoryItem[]
  countItem(name: string): number
  wait(ms: number): Promise<void>
  ensureOwned(): void
  timeoutMs: number
  log(event: string, detail: Record<string, unknown>): void
}

export interface SmeltExecutionParams {
  inputItem: string
  fuelItem: string
  outputItem: string
  inputCount: number
  fuelCount: number
}

export interface SmeltExecutionOutcome {
  gained: number
  outputCount: number
  placedInput: number
  placedFuel: number
  consumedInput: boolean
  consumedFuel: boolean
}

export function formatSmeltLog(event: string, detail: Record<string, unknown>): string {
  if (event === 'SMELT_DONE') {
    return `SMELT_DONE item=${detail.item} gained=${detail.gained} input=${detail.inputItem} fuel=${detail.fuelItem} output=${detail.outputCount} delta=${detail.gained}`
  }
  if (event === 'SMELT_UNPRODUCED') {
    return (
      `SMELT_UNPRODUCED item=${detail.item} gained=0 placedInput=${detail.placedInput} placedFuel=${detail.placedFuel} ` +
      `consumedInput=${detail.consumedInput} consumedFuel=${detail.consumedFuel}`
    )
  }
  if (event === 'SMELT_ROLLBACK') {
    return `SMELT_ROLLBACK slot=${detail.slot} count=${detail.count} reason=${detail.reason}`
  }
  return `SMELT_PLACED input=${detail.inputItem}:${detail.inputCount} fuel=${detail.fuelItem}:${detail.fuelCount}`
}

/** The station-family items whose VERIFIED placement is itself station proof. */
export const STATION_PLACE_ITEMS: ReadonlySet<string> = new Set(['furnace', 'blast_furnace', 'smoker'])

/**
 * The `FURNACE_READY source=placed` line a verified placement must emit, or null
 * when nothing was proven. M2 blocker: the PLACE path proved and recorded
 * nothing - FURNACE_READY was only emitted inside `runSmelt`, so a furnace the
 * bot placed and then walked away from was effectively lost (nothing registered
 * it as a usable station) and the smelt goal starved to `[WAIT]`. The emission
 * is gated by the same strict placement post-condition the action already uses,
 * so an unverified/failed placement never registers a station.
 */
export function placedStationReadyLine(itemName: string, placedName: string | null, at: Vec3Json): string | null {
  if (!STATION_PLACE_ITEMS.has(itemName)) return null
  if (!isPlacePostconditionMet(placedName, itemName)) return null
  return formatFurnaceReady('placed', at)
}

/**
 * #79: `true` only when the furnace slot proves the placed stack shrank. `null`
 * is an empty slot (fully consumed); `undefined` means the window does not
 * expose the slot, so nothing is proven.
 */
function furnaceSlotConsumed(placed: number, remaining: { count: number } | null | undefined): boolean {
  if (placed <= 0 || remaining === undefined) return false
  return (remaining?.count ?? 0) < placed
}

function furnaceSlotCount(slot: SmeltFurnaceSlot | null | undefined): number {
  if (slot === null || slot === undefined || !Number.isFinite(slot.count)) return 0
  return Math.max(0, Math.floor(slot.count))
}

function furnaceSlotNameMatches(slot: SmeltFurnaceSlot | null | undefined, expected: string): boolean {
  return slot !== null && slot !== undefined && furnaceSlotCount(slot) > 0 && (slot.name === undefined || slot.name === expected)
}

function inventoryCounts(items: readonly SmeltInventoryItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.count <= 0) continue
    counts.set(item.name, (counts.get(item.name) ?? 0) + Math.floor(item.count))
  }
  return counts
}

function inventoryCanSupply(
  items: readonly SmeltInventoryItem[],
  inputItem: string,
  inputCount: number,
  fuelItem: string,
  fuelCount: number,
): boolean {
  const counts = inventoryCounts(items)
  const inputAvailable = counts.get(inputItem) ?? 0
  if (inputItem === fuelItem) return inputAvailable >= inputCount + fuelCount
  return inputAvailable >= inputCount && (counts.get(fuelItem) ?? 0) >= fuelCount
}

export async function executeFurnaceSmelt(
  deps: SmeltExecutionDeps,
  params: SmeltExecutionParams,
): Promise<SmeltExecutionOutcome> {
  const inputCount = Math.max(1, Math.floor(params.inputCount))
  const fuelCount = Math.max(1, Math.floor(params.fuelCount))
  const before = deps.countItem(params.outputItem)
  const furnace = await deps.openFurnace()
  let closed = false
  const closeOnce = (): void => {
    if (closed) return
    closed = true
    try {
      furnace.close()
    } catch {
      // the server already closed the window
    }
  }
  try {
    // A previous action can leave a valid batch in the furnace window after a
    // transfer failure. Reuse only a slot whose concrete item is known to
    // match this recipe; a known different item is a hard mechanical refusal,
    // never something to overwrite. Test doubles that expose only `count`
    // retain the old empty/occupied behaviour for compatibility.
    const existingInput = furnace.inputItem?.() ?? null
    const existingFuel = furnace.fuelItem?.() ?? null
    const existingInputCount = furnaceSlotCount(existingInput)
    const existingFuelCount = furnaceSlotCount(existingFuel)
    if (!furnaceSlotNameMatches(existingInput, params.inputItem)) {
      if (existingInputCount > 0 && existingInput?.name !== undefined) {
        throw new ExecutorError('smelt_error', `furnace input contains ${existingInput.name}, expected ${params.inputItem}`)
      }
    }
    // A furnace fuel slot is a mechanical resource class, not a recipe item:
    // coal and charcoal (and every other valid furnace fuel) are equivalent
    // for an iron smelt. Reusing a valid fuel already in the furnace is also
    // necessary because Mineflayer exposes the slot contents from a prior
    // action. Only a known non-fuel is a hard refusal. If a different valid
    // fuel is present but insufficient for this batch, the slot cannot mix
    // item types, so fail loudly instead of pretending the requested fuel was
    // placed.
    const existingFuelIsValid = existingFuel?.name === undefined || isFuelItem(existingFuel.name)
    if (existingFuelCount > 0 && !existingFuelIsValid) {
      throw new ExecutorError('smelt_error', `furnace fuel contains ${existingFuel?.name ?? 'unknown'}, not a valid fuel`)
    }
    if (
      existingFuelCount > 0 &&
      existingFuel?.name !== undefined &&
      existingFuel.name !== params.fuelItem &&
      existingFuelCount < fuelCount
    ) {
      throw new ExecutorError(
        'smelt_error',
        `furnace fuel ${existingFuel.name}:${existingFuelCount} cannot mix with ${params.fuelItem}:${fuelCount}`,
      )
    }

    const inputToPlace = Math.max(0, inputCount - existingInputCount)
    const fuelToPlace = Math.max(0, fuelCount - existingFuelCount)
    const effectiveFuelItem = existingFuelCount > 0 && existingFuel?.name !== undefined ? existingFuel.name : params.fuelItem
    const items = deps.inventoryItems()
    if (!inventoryCanSupply(items, params.inputItem, inputToPlace, params.fuelItem, fuelToPlace)) {
      const counts = inventoryCounts(items)
      const availableInput = counts.get(params.inputItem) ?? 0
      const availableFuel = counts.get(params.fuelItem) ?? 0
      throw new ExecutorError(
        'smelt_error',
        `insufficient transfer inventory input=${params.inputItem}:${availableInput}/${inputToPlace} fuel=${params.fuelItem}:${availableFuel}/${fuelToPlace}`,
      )
    }
    const input = items.find((entry) => entry.name === params.inputItem && entry.count > 0)
    const fuel = items.find((entry) => entry.name === params.fuelItem && entry.count > 0)
    if (inputToPlace > 0 && input === undefined) throw new ExecutorError('smelt_error', `${params.inputItem} left the inventory`)
    if (fuelToPlace > 0 && fuel === undefined) throw new ExecutorError('smelt_error', `${params.fuelItem} left the inventory`)

    const placedInput = Math.max(inputCount, existingInputCount)
    const placedFuel = Math.max(fuelCount, existingFuelCount)
    let inputTransferAttempted = false
    let inputTransferred = false
    try {
      if (inputToPlace > 0) {
        inputTransferAttempted = true
        await furnace.putInput(input!.type, null, inputToPlace)
        inputTransferred = true
      }
      if (fuelToPlace > 0) {
        await furnace.putFuel(fuel!.type, null, fuelToPlace)
      }
    } catch (error) {
      // A successful input transfer followed by a failed fuel transfer is the
      // live `destination full`/same-item failure mode. Roll the new input back
      // when the window can do so, so the next attempt cannot inherit a partial
      // batch. Never remove an input that was already present before this call.
      if (inputTransferAttempted && inputTransferred && existingInputCount === 0 && furnace.takeInput !== undefined) {
        try {
          await furnace.takeInput()
          deps.log('SMELT_ROLLBACK', { slot: 'input', count: inputToPlace, reason: error instanceof Error ? error.message : String(error) })
        } catch (rollbackError) {
          const original = error instanceof Error ? error.message : String(error)
          const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          throw new ExecutorError('smelt_error', `fuel transfer failed (${original}); input rollback failed (${rollback})`)
        }
      }
      if (error instanceof ExecutorError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ExecutorError('smelt_error', `furnace transfer failed: ${message}`)
    }
    deps.log('SMELT_PLACED', { inputItem: params.inputItem, inputCount: placedInput, fuelItem: effectiveFuelItem, fuelCount: placedFuel })
    deps.ensureOwned()
    const deadline = Date.now() + deps.timeoutMs
    // Harvest the WHOLE placed batch, not just the first output. Before this the
    // poll stopped at `harvested === 0` (the guard added with the #199
    // open-window fix), so a `SMELT:iron_ingot` that placed `raw_iron x3` with
    // one charcoal took one ingot and closed the window; the other two
    // inputs/outputs were left inside the furnace while the planner saw raw_iron
    // absent and fell back to re-mining/re-fuelling (live run-mu8c89s6-rnv6:
    // `SMELT_DONE gained=1` then `SMELT_INPUT_PREREQ input=raw_iron present=false`).
    // Keep taking outputs until the placed input is consumed, the furnace reports
    // no remaining input, or the action deadline is reached. While the window is
    // open the bot inventory does not include the output (see the close-and-
    // recount below), so `takeOutput()` is the only production evidence.
    let harvested = 0
    let lastHarvestAt = 0
    // A furnace smelts one item every 200 ticks (10 s); a stall larger than one
    // smelt interval means the batch produced everything it can (e.g. the held
    // fuel ran out). The `inputItem` slot is NOT a valid completion signal: it
    // empties when the LAST smelt BEGINS, while that item is still cooking.
    const noOutputStallMs = 15_000
    while (harvested < placedInput && Date.now() < deadline) {
      await deps.wait(500)
      deps.ensureOwned()
      const output = furnace.outputItem()
      if (output !== null) {
        harvested += Math.max(1, Math.floor(output.count))
        await furnace.takeOutput()
        await deps.wait(250)
        lastHarvestAt = Date.now()
        continue
      }
      // No output ready: keep waiting for the next smelt in the batch, but stop
      // after a full no-output interval so a fuel-starved furnace cannot pin the
      // action to its whole timeout.
      if (harvested > 0 && Date.now() - lastHarvestAt >= noOutputStallMs) break
    }
    // Final sweep: the output can land in the furnace window at/after the last
    // poll (live run-mu89hsqv-rcy0 read charcoal=0 with the item already in the
    // window). Take it once more before closing so production is never missed.
    if (harvested < placedInput) {
      const output = furnace.outputItem()
      if (output !== null) {
        harvested += Math.max(1, Math.floor(output.count))
        await furnace.takeOutput()
        await deps.wait(250)
      }
    }
    // #79: no timeout throw. Evidence is read while the window still exposes its
    // slots, then the window is closed. mineflayer folds an open container's
    // player-inventory slots back into `bot.inventory` only on close
    // (copyInventory is called from closeWindow), so a count taken while the
    // furnace is open is the pre-open snapshot and misses an output harvested
    // during the smelt. Closing first makes the true delta visible.
    const consumedInput = furnaceSlotConsumed(placedInput, furnace.inputItem?.())
    const consumedFuel = furnaceSlotConsumed(placedFuel, furnace.fuelItem?.())
    closeOnce()
    const after = deps.countItem(params.outputItem)
    const gained = Math.max(Math.max(0, after - before), harvested)
    const outputCount = before + gained
    // #79 + live run-mu89hsqv-rcy0: SMELT_DONE is earned by real production - an
    // output gain OR a furnace that actually consumed the placed input+fuel
    // (isSmeltPostconditionMet). A no-op that gained and consumed nothing stays
    // SMELT_UNPRODUCED, so the marker can never fire on a no-op.
    if (isSmeltPostconditionMet({ gained, placedInput, placedFuel, consumedInput, consumedFuel })) {
      deps.log('SMELT_DONE', { item: params.outputItem, gained, inputItem: params.inputItem, fuelItem: effectiveFuelItem, outputCount, beforeCount: before })
    } else {
      deps.log('SMELT_UNPRODUCED', { item: params.outputItem, placedInput, placedFuel, consumedInput, consumedFuel })
    }
    return { gained, outputCount, placedInput, placedFuel, consumedInput, consumedFuel }
  } finally {
    closeOnce()
  }
}

/** Pathfinder goal object used by the control-state walk (typing only). */
type PathGoal = import('mineflayer-pathfinder').goals.Goal

/**
 * Options for the control-state actuator, which ports the proven vertical
 * movement recipe from `mcbot/movement-test/vertical.mjs#navigateTo`.
 *
 * `anchor` is the block the action ultimately wants to reach (success = the eyes
 * come within `reach` of it). When `anchor` is null the success test is the feet
 * distance to `target` (within `range + 0.5`, or 1.2 blocks by default).
 */
interface ControlWalkOptions {
  anchor?: Vec3Json | null
  range?: number
  reach?: number
  /** explicit feet-distance arrival test, overriding the `range`-derived one */
  tolerance?: number
  budgetMs: number
  /** plan with `GoalGetToBlock` so the pathfinder picks a node adjacent to `anchor` */
  anchorIsGoal?: boolean
  /**
   * Require the bot's feet to actually reach the target's level before
   * reporting arrival. On for MOVE (a 3D-only test let the bot "arrive" one
   * block below a step and never climb). Off for drop pickup, where the item
   * legitimately sits a level below and the bot must descend to it.
   */
  requireLevel?: boolean
  /**
   * Steer straight at `target` instead of following a pathfinder plan. A dropped
   * item can sit one level below the bot; planning to its exact spot gets stuck
   * on the ledge, while a direct bearing walks the bot off the edge onto it.
   */
  directBearing?: boolean
  /**
   * Custom arrival predicate. A placed block is interacted with from a
   * horizontal offset (its centre can be one level up), so the default 3D/level
   * test wrongly rejects a legitimately-adjacent stand. When provided this
   * replaces the built-in test entirely.
   */
  arrivedAt?: () => boolean
  /**
   * Drop pickup: a small ground item next to the bot is not a wall. When the
   * drop is on the same level the "unclimbable 2-block face" fail-fast would
   * veto every nudge, so pickup passes this to walk at the item instead. The
   * outer nudge deadline still bounds the attempt (never a wedge).
   */
  ignoreFaceVeto?: boolean
  /**
   * Same-level bounded nudge: never jump and do not apply jump-headroom
   * gating. The physics collision still owns whether the body can move; the
   * caller supplies a tight arrival predicate and a short budget.
   */
  horizontalOnly?: boolean
  /** Exact horizontal point for direct-bearing control, when a diagonal target is unsafe. */
  bearingTarget?: { x: number; z: number }
}

export const defaultExecutorOptions: ExecutorOptions = {
  reach: 4.5,
  pathTimeoutMs: 15000,
  pickupPathTimeoutMs: 8000,
  digTimeoutMs: 15000,
  verifyTimeoutMs: 8000,
  smeltTimeoutMs: 40000,
  goalItem: 'oak_log',
  actuation: 'pathfinder',
  packetStepMs: 45,
  maxStepsPerWaypoint: 400,
}

export interface VerifyReport {
  removed: boolean
  dropObserved: boolean
  itemsGained: number
  goalItemCount: number
  settledMs: number
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ActionCancelled('aborted while waiting'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class Executor {
  private readonly bot: Bot
  private readonly logger: EventLogger
  private readonly options: ExecutorOptions

  private epochCounter = 0
  private activeEpoch = 0
  private controller: AbortController | null = null
  private action: CurrentAction | null = null
  private owned = 0
  private maxConcurrent = 0
  private movementsReady = false
  private lastResultValue: ExecutionResult | null = null
  private pathStatus: PathStatus = 'idle'

  constructor(bot: Bot, logger: EventLogger, options: ExecutorOptions = defaultExecutorOptions) {
    this.bot = bot
    this.logger = logger
    this.options = options
  }

  // -------------------------------------------------------------------------
  // ownership
  // -------------------------------------------------------------------------

  get current(): CurrentAction | null {
    return this.action
  }

  get maxConcurrentActions(): number {
    return this.maxConcurrent
  }

  get lastResult(): ExecutionResult | null {
    return this.lastResultValue
  }

  get lastPathStatus(): PathStatus {
    return this.pathStatus
  }

  get epoch(): number {
    return this.activeEpoch
  }

  /**
   * Movement policy: walk only. This is the code line that proves there is no
   * incidental block breaking - the pathfinder may not dig, may not pillar up
   * and has no scaffolding blocks, so mining only ever happens through a
   * guarded `bot.dig()` on a candidate the policy selected.
   */
  ensureMovements(): void {
    if (this.movementsReady) return
    if (this.bot.pathfinder === undefined) {
      throw new Error('mineflayer-pathfinder is not loaded; call bot.loadPlugin(pathfinder) before jev-agent')
    }
    const movements = new Movements(this.bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.scafoldingBlocks = []
    movements.allowParkour = false
    movements.allowFreeMotion = false
    movements.dontMineUnderFallingBlock = true
    movements.maxDropDown = 8
    movements.infiniteLiquidDropdownDistance = false
    this.bot.pathfinder.setMovements(movements)
    this.movementsReady = true
    this.logger.info('executor', 'movements pinned: canDig=false, allow1by1towers=false, scaffolding=[]', {
      canDig: movements.canDig,
      allow1by1towers: movements.allow1by1towers,
      scaffoldingBlocks: movements.scafoldingBlocks,
      maxDropDown: movements.maxDropDown,
    })
  }

  /**
   * Take ownership of `candidate`. If a *different* action is running it is
   * cancelled first (this is the preemption log line). If the *same* action is
   * running, ownership is retained and the caller just re-attaches to it.
   */
  claim(candidate: Candidate): ClaimResult {
    this.ensureMovements()
    const running = this.action
    if (running !== null && running.status === 'running' && running.id === candidate.id) {
      return { kept: true, epoch: running.epoch, completion: running.completion }
    }

    const cancelled = this.cancelCurrent(`preempted by new decision ${candidate.id}`)

    this.epochCounter += 1
    this.activeEpoch = this.epochCounter
    const epoch = this.activeEpoch
    const controller = new AbortController()
    const startedAt = Date.now()

    let resolveCompletion: (result: ExecutionResult) => void = () => undefined
    const completion = new Promise<ExecutionResult>((resolve) => {
      resolveCompletion = resolve
    })

    const action: CurrentAction = {
      id: candidate.id,
      kind: candidate.kind,
      epoch,
      startedAt,
      phase: 'starting',
      status: 'running',
      detail: '',
      completion,
    }
    this.action = action
    this.own(epoch)
    this.controller = controller

    this.logger.info(
      'executor',
      `action#${epoch} ${candidate.id} START (single-action lock held)`,
      { epoch, kind: candidate.kind, cancelledPrevious: cancelled, maxConcurrent: this.maxConcurrent },
    )

    void this.runAction(candidate, epoch, controller.signal, startedAt)
      .then((result) => {
        const finalResult = this.applyPostcondition(candidate, result)
        action.status = finalResult.status
        action.detail = finalResult.detail
        this.lastResultValue = finalResult
        this.release(epoch)
        resolveCompletion(finalResult)
      })
      // runAction never rejects (it converts every failure into a result), so
      // this only fires on a programming error - never as a silent swallow.
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        const result = this.buildResult(candidate, epoch, startedAt, 'failed', 'crashed', message, 'unknown_event', {
          verified: false,
          dropObserved: false,
          blockRemoved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
        })
        action.status = 'failed'
        action.detail = message
        this.lastResultValue = result
        this.logger.error('executor', `action#${epoch} ${candidate.id} CRASHED`, { message })
        this.release(epoch)
        resolveCompletion(result)
      })

    return { kept: false, epoch, completion }
  }

  /** Cancel the running action, if any. Returns true when something was cancelled. */
  cancelCurrent(reason: string): boolean {
    const running = this.action
    if (running === null || running.status !== 'running') return false

    running.status = 'cancelled'
    running.detail = reason
    this.logger.info(
      'executor',
      `action#${running.epoch} ${running.id} CANCELLED (${reason})`,
      { epoch: running.epoch, actionId: running.id, abortFired: true },
    )
    this.controller?.abort(new Error(reason))
    this.bot.stopDigging()
    if (this.movementsReady) {
      this.bot.pathfinder.setGoal(null)
      this.bot.pathfinder.stop()
    }
    this.release(running.epoch)
    return true
  }

  private own(epoch: number): void {
    if (this.owned !== 0) {
      throw new Error(
        `Executor invariant violated: claiming action#${epoch} while action#${this.action?.epoch ?? -1} is still owned`,
      )
    }
    this.owned = 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.owned)
  }

  private release(epoch: number): void {
    // a stale action finishing must not release the newer action's ownership
    if (this.activeEpoch !== epoch) return
    this.owned = 0
    this.action = null
    this.controller = null
  }

  private ensureOwned(epoch: number, signal: AbortSignal): void {
    if (signal.aborted) throw new ActionCancelled(`action#${epoch} aborted`)
    if (epoch !== this.activeEpoch) {
      throw new ActionCancelled(`action#${epoch} superseded by action#${this.activeEpoch}`)
    }
  }

  // -------------------------------------------------------------------------
  // action runners
  // -------------------------------------------------------------------------

  private async runAction(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    try {
      switch (candidate.kind) {
        case 'MINE':
          return await this.runMine(candidate, epoch, signal, startedAt)
        case 'MOVE':
        case 'RETREAT':
          return await this.runMove(candidate, epoch, signal, startedAt)
        case 'CRAFT':
          return await this.runCraft(candidate, epoch, signal, startedAt)
        case 'SMELT':
          return await this.runSmelt(candidate, epoch, signal, startedAt)
        case 'DESCEND':
          return await this.runDescend(candidate, epoch, signal, startedAt)
        case 'STEP':
          return await this.runStep(candidate, epoch, signal, startedAt)
        case 'RETRIEVE':
          return await this.runRetrieve(candidate, epoch, signal, startedAt)
        case 'PLACE':
          return await this.runPlace(candidate, epoch, signal, startedAt)
        case 'EAT':
          return await this.runEat(candidate, epoch, signal, startedAt)
        case 'ATTACK':
          return await this.runAttack(candidate, epoch, signal, startedAt)
        case 'WAIT':
          return await this.runWait(candidate, epoch, signal, startedAt)
        case 'ESCALATE':
          return this.buildResult(candidate, epoch, startedAt, 'done', 'escalating', 'handed to System 2', null, {
            verified: false,
            dropObserved: false,
            blockRemoved: false,
            itemsGained: 0,
            goalItemCount: this.countGoalItem(),
          })
      }
    } catch (error) {
      if (error instanceof ActionCancelled) {
        return this.buildResult(candidate, epoch, startedAt, 'cancelled', 'cancelled', error.message, 'cancelled', {
          verified: false,
          dropObserved: false,
          blockRemoved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
        })
      }
      const failure = error instanceof ExecutorError ? error.code : 'unknown_event'
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('executor', `action#${epoch} ${candidate.id} FAILED`, { failure, message })
      return this.buildResult(candidate, epoch, startedAt, 'failed', 'failed', message, failure, {
        verified: false,
        dropObserved: false,
        blockRemoved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
      })
    }
  }

  private async runMine(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', 'MINE candidate has no coordinates')

    const inReachNow = this.distanceToEyes(target) <= this.options.reach
    if (!candidate.inReach && !inReachNow) {
      this.setPhase(candidate, epoch, 'pathing')
      await this.pathTo(target, epoch, signal, 'GoalGetToBlock')
    }
    this.ensureOwned(epoch, signal)

    this.setPhase(candidate, epoch, 'digging')
    const block = this.currentBlockAt(target)
    if (block === null || block.name !== candidate.targetName) {
      throw new ExecutorError('target_gone', `block at (${target.x},${target.y},${target.z}) is gone before the dig`)
    }
    if (this.distanceToEyes(target) > this.options.reach) {
      // pathing claimed to finish but we are still too far to legally mine
      throw new ExecutorError(
        'out_of_reach',
        `target is ${round2(this.distanceToEyes(target))}m from the eyes (reach ${this.options.reach})`,
      )
    }

    const yieldItem = readMetaString(candidate, 'yieldItem') ?? candidate.targetName
    const clearance = candidate.meta.clearance === true
    const beforeCount = this.countItem(yieldItem)
    await this.equipTool(candidate, epoch, signal)
    await this.digBlock(block, epoch, signal)
    this.ensureOwned(epoch, signal)

    this.setPhase(candidate, epoch, 'collecting')
    const latest = this.currentBlockAt(target)
    const removed = latest === null || latest.name !== candidate.targetName
    if (clearance) {
      if (!removed) {
        throw new ExecutorError('verify_failed', `ceiling block at (${target.x},${target.y},${target.z}) is still there`)
      }
      const result = this.buildResult(candidate, epoch, startedAt, 'done', 'verified', `cleared ${candidate.targetName} (headroom)`, null, {
        verified: true,
        blockRemoved: true,
        dropObserved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
      })
      result.yieldItem = yieldItem
      return result
    }
    const report = await this.collectDrop(target, yieldItem, beforeCount, removed, epoch, signal)
    this.setPhase(candidate, epoch, 'verified')
    this.logger.info(
      'verify',
      `blockRemoved=${report.removed} dropObserved=${report.dropObserved} ${yieldItem ?? candidate.targetName}_in_inventory=${report.goalItemCount} (gained ${report.itemsGained}, settled ${report.settledMs}ms)`,
      { target, actionId: candidate.id },
    )

    // The spec's VERIFY step accepts either "the block is gone" or "the item is
    // in the inventory". Inventory collection additionally requires walking onto
    // the drop, so a verified dig is: block removed AND (collected OR the drop
    // entity was observed in the world).
    const verified = report.removed && (report.itemsGained > 0 || report.dropObserved)
    if (!verified) {
      throw new ExecutorError(
        'verify_failed',
        `blockRemoved=${report.removed} dropObserved=${report.dropObserved} itemsGained=${report.itemsGained} after ${report.settledMs}ms`,
      )
    }

    const result = this.buildResult(candidate, epoch, startedAt, 'done', 'verified', `dug ${candidate.targetName}`, null, {
      verified,
      blockRemoved: report.removed,
      dropObserved: report.dropObserved,
      itemsGained: report.itemsGained,
      goalItemCount: report.goalItemCount,
    })
    result.yieldItem = yieldItem
    return result
  }

  private async runMove(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', `${candidate.kind} candidate has no coordinates`)
    const anchor = this.anchorBlock(candidate)
    this.setPhase(candidate, epoch, 'pathing')
    const before = this.distanceToFeet(target)
    const startPosition = this.bot.entity.position.clone()
    const startY = startPosition.y
    const anchorBefore = anchor === null ? null : this.distanceToEyes(anchor)

    // A visible resource may be above the current floor.  MINE/MOVE candidates
    // carry the same vertical contract as RETRIEVE candidates so navigation
    // does not throw away the deterministic ascent plan and then retry a
    // horizontal path that cannot reach the resource's Y level.
    const vertical = readMetaString(candidate, 'vertical') ?? 'none'
    let activeVertical = vertical
    let verticalStep = false
    if (vertical !== 'none') {
      this.setPhase(candidate, epoch, 'vertical')
      if (vertical === 'reuse') {
        const reuse = await this.runReuseVerticalLeg(candidate, epoch, signal, target)
        verticalStep = reuse.step
        if (reuse.refused) {
          const fallback = readMetaString(candidate, 'fallbackVertical')
          if (fallback === null || fallback === 'none') {
            throw new ExecutorError(
              'tunnel_entry_refused',
              `${candidate.id} reuse tunnel entry not usable and no fallback vertical plan`,
            )
          }
          activeVertical = fallback
          this.logger.info('agent', `TUNNEL_ENTRY_FALLBACK vertical=${fallback}`, { actionId: candidate.id, target })
          verticalStep = await this.runVerticalLeg(candidate, fallback, true, epoch, signal, target, startY)
        }
      } else {
        verticalStep = await this.runVerticalLeg(candidate, vertical, false, epoch, signal, target, startY)
      }

      this.ensureOwned(epoch, signal)
      const startFloorY = Math.floor(startY)
      const climbedTo = Math.floor(this.bot.entity.position.y)
      const dugVertical = activeVertical === 'staircase' || activeVertical === 'staircase-up'
      if (verticalStep && climbedTo > startFloorY) {
        this.logger.info('agent', formatAscentProgress(startFloorY, climbedTo, target.y), {
          actionId: candidate.id,
          target,
          vertical: activeVertical,
        })
      }
      // Preserve bounded ascent as durable MOVE progress.  The next sensor
      // tick re-plans from the new Y instead of sending a canDig=false
      // horizontal path back down to the original standable spot.
      if (
        shouldReplanAfterVerticalChunk({
          verticalStep,
          startY,
          currentY: this.bot.entity.position.y,
          targetY: target.y,
        })
      ) {
        const direction = climbedTo > startFloorY ? 'climbed' : 'descended'
        return this.buildResult(
          candidate,
          epoch,
          startedAt,
          'done',
          'arrived',
          `${direction} from y=${startFloorY} to y=${climbedTo} toward y=${target.y} (bounded chunk; next decision re-plans)`,
          null,
          {
            verified: true,
            blockRemoved: dugVertical && verticalStep,
            dropObserved: false,
            itemsGained: 0,
            goalItemCount: this.countGoalItem(),
            progressed: true,
          },
        )
      }
    }
    let pathError: unknown = null
    try {
      // STOCK-FIRST: `pathTo` drives the stock pathfinder (`setGoal`) as the
      // primary MOVE path and only falls back to our control-walk actuator
      // (headroom-gated) when stock reports stuck/noPath/timeout. The anchored
      // block is NOT the arrival goal here: a MOVE exists to walk to the
      // standable spot, and `anchorIsGoal` is deliberately omitted so the
      // fallback tests the FEET distance to the spot.
      await this.pathTo(target, epoch, signal, 'GoalBlock', { anchor, requireLevel: true })
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      this.ensureOwned(epoch, signal)
      pathError = error
    }
    const after = this.distanceToFeet(target)
    const endPosition = this.bot.entity.position.clone()
    const anchorDistance = anchor === null ? after : this.distanceToEyes(anchor)
    // A MOVE that ended still pinned against terrain the actuator could not
    // climb is NOT an arrival, even when the standable spot is within the loose
    // horizontal tolerance (the 2-block-face case stopped 0.93m short forever).
    const stuck = pathError !== null && this.isPinned()
    // Navigation succeeds only when the standable spot's block cell is actually
    // occupied, OR (with a real anchor) the anchored block crossed from
    // out-of-reach into reach. The packet stepper's transient client pose is not
    // proof the server accepted the move (see classifyMoveArrival).
    const arrival = classifyMoveArrival({
      end: { x: endPosition.x, y: endPosition.y, z: endPosition.z },
      target,
      anchor,
      anchorBefore,
      anchorDistance,
      reach: this.options.reach,
      pinned: stuck,
    })
    const verified = arrival.verified

    this.logger.info(
      'executor',
      `${candidate.kind} ${candidate.id} arrival start=(${round2(startPosition.x)},${round2(startPosition.y)},${round2(startPosition.z)}) ` +
        `end=(${round2(endPosition.x)},${round2(endPosition.y)},${round2(endPosition.z)}) moved=${round2(startPosition.distanceTo(endPosition))}m ` +
        `targetDistance=${round2(before)}m->${round2(after)}m anchorEyeDistance=${round2(anchorDistance)}m`,
      { target, actionId: candidate.id, start: { x: startPosition.x, y: startPosition.y, z: startPosition.z }, end: { x: endPosition.x, y: endPosition.y, z: endPosition.z } },
    )
    if (pathError !== null && !verified) throw pathError
    if (pathError !== null) {
      const failure = pathError instanceof ExecutorError ? pathError.code : 'unknown_event'
      this.logger.info(
        'executor',
        `${candidate.kind} ${candidate.id} recovered from ${failure}: the anchored target is now ${round2(anchorDistance)}m from the eyes (reach ${this.options.reach})`,
        { actionId: candidate.id, failure },
      )
      this.notifyPathCompleted(target)
    }
    return this.buildResult(candidate, epoch, startedAt, 'done', 'arrived', `moved from ${round2(before)}m to ${round2(after)}m`, null, {
      verified,
      blockRemoved: false,
      dropObserved: false,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
    })
  }

  private async runRetrieve(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', 'RETRIEVE candidate has no coordinates')
    const before = this.distanceToFeet(target)
    const startY = this.bot.entity.position.y
    this.setPhase(candidate, epoch, 'retrieving')

    // Issue #45: close the vertical gap first (reuse a recorded tunnel, else dig
    // one guarded staircase step), then approach horizontally. Without this the
    // canDig=false walk stops at the resource's horizontal bearing and stalls.
    // M2 FURNACE_READY: reuse is validated live; an unusable entry either clears
    // the one blocking cell or falls back to a different vertical plan.
    const vertical = readMetaString(candidate, 'vertical') ?? 'none'
    let activeVertical = vertical
    let verticalStep = false
    if (vertical === 'reuse') {
      const reuse = await this.runReuseVerticalLeg(candidate, epoch, signal, target)
      verticalStep = reuse.step
      if (reuse.refused) {
        const fallback = readMetaString(candidate, 'fallbackVertical')
        if (fallback === null || fallback === 'none') {
          throw new ExecutorError(
            'tunnel_entry_refused',
            `${candidate.id} reuse tunnel entry not usable and no fallback vertical plan`,
          )
        }
        activeVertical = fallback
        this.logger.info('agent', `TUNNEL_ENTRY_FALLBACK vertical=${fallback}`, { actionId: candidate.id, target })
        verticalStep = await this.runVerticalLeg(candidate, fallback, true, epoch, signal, target, startY)
      }
    } else {
      verticalStep = await this.runVerticalLeg(candidate, vertical, false, epoch, signal, target, startY)
    }

    this.ensureOwned(epoch, signal)
    const startFloorY = Math.floor(startY)
    const climbedTo = Math.floor(this.bot.entity.position.y)
    const dugVertical = activeVertical === 'staircase' || activeVertical === 'staircase-up'
    if (verticalStep && climbedTo > startFloorY) {
      this.logger.info('agent', formatAscentProgress(startFloorY, climbedTo, target.y), {
        actionId: candidate.id,
        target,
        vertical: activeVertical,
      })
    }
    // M2 ascent persistence: a bounded climb chunk that has not yet closed the
    // gap must NOT be followed by a horizontal walk to a target ~50 blocks up.
    // canDig=false has no path there, and whatever route the pathfinder does
    // return walks back down (live oscillation y 7.8 -> 11.0 -> 9.8), throwing
    // the altitude away. Return the gained altitude as durable progress and let
    // the next decision re-plan the next chunk from the new Y.
    if (
      shouldReplanAfterVerticalChunk({
        verticalStep,
        startY,
        currentY: this.bot.entity.position.y,
        targetY: target.y,
      })
    ) {
      const direction = climbedTo > startFloorY ? 'climbed' : 'descended'
      const currentY = this.bot.entity.position.y
      const outcome = classifyRetrieveOutcome({
        before,
        after: this.distanceToFeet(target),
        verticalStep,
        verticalProgress: Math.abs(currentY - target.y) < Math.abs(startY - target.y) - 0.01,
      })
      if (!outcome.verified && outcome.progressed) {
        this.logger.warn(
          'executor',
          `RETRIEVE_UNREACHED ${candidate.id} ${direction} from y=${startFloorY} to y=${climbedTo} toward y=${target.y} (bounded chunk without closure)`,
          { target, actionId: candidate.id, vertical: activeVertical, before: round2(before) },
        )
      }
      return this.buildResult(
        candidate,
        epoch,
        startedAt,
        'done',
        'retrieved',
        `${direction} from y=${startFloorY} to y=${climbedTo} toward y=${target.y} (bounded chunk; next decision re-plans)`,
        null,
        {
          verified: outcome.verified,
          blockRemoved: dugVertical && verticalStep,
          dropObserved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
          progressed: outcome.progressed,
          distanceClosed: outcome.closed,
        },
      )
    }
    this.setPhase(candidate, epoch, 'approaching')
    let approachError: ExecutorError | null = null
    try {
      await this.pathToNear(target, RETRIEVE_ARRIVAL_RADIUS, epoch, signal)
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      approachError =
        error instanceof ExecutorError
          ? error
          : new ExecutorError(
              'path_stuck',
              `retrieve approach failed: ${error instanceof Error ? error.message : String(error)}`,
            )
      this.logger.warn(
        'executor',
        `RETRIEVE ${candidate.id} horizontal approach blocked (${approachError.code}): ${approachError.message}`,
        { target, actionId: candidate.id, failure: approachError.code },
      )
    }
    this.ensureOwned(epoch, signal)
    const after = this.distanceToFeet(target)
    const endY = this.bot.entity.position.y
    const approach = classifyRetrieveApproach({
      distanceBefore: before,
      distanceAfter: after,
      startY,
      endY,
      targetY: target.y,
      verticalStep,
      approachFailed: approachError !== null,
    })
    const outcome = classifyRetrieveOutcome({
      before,
      after,
      verticalStep,
      verticalProgress: approach.verticalProgress,
    })
    if (approach.outcome === 'stalled') {
      const failure =
        approachError ??
        new ExecutorError(
          'path_stuck',
          `retrieve made no progress toward (${target.x},${target.y},${target.z}) (${round2(before)}m->${round2(after)}m)`,
        )
      this.logger.error(
        'executor',
        `RETRIEVE ${candidate.id} STALLED failure=${failure.code}: ${failure.message}`,
        { target, actionId: candidate.id, failure: failure.code, before: round2(before), after: round2(after) },
      )
      throw failure
    }
    // Distance-closure requirement (#238 + truthful outcome): an unreached
    // retrieve is a success only when the feet actually arrived or the
    // remaining distance shrank by the meaningful epsilon. A bounded vertical
    // chunk step is durable `progressed` evidence, never completion.
    const verified = approach.arrived || approach.closed
    if (!verified && outcome.progressed) {
      this.logger.warn(
        'executor',
        `RETRIEVE_UNREACHED ${candidate.id} before=${round2(before)}m after=${round2(after)}m vertical=${activeVertical} (progressed without closure)`,
        { target, actionId: candidate.id, before: round2(before), after: round2(after), vertical: activeVertical },
      )
    }
    this.logger.info(
      'executor',
      `RETRIEVE ${candidate.id} arrival targetDistance=${round2(before)}m->${round2(after)}m y=${round2(startY)}->${round2(endY)} vertical=${activeVertical} outcome=${approach.outcome}`,
      { target, actionId: candidate.id },
    )
    return this.buildResult(candidate, epoch, startedAt, 'done', 'retrieved', `approached remembered resource from ${round2(before)}m to ${round2(after)}m (${approach.outcome})`, null, {
      verified,
      blockRemoved: dugVertical && verticalStep,
      dropObserved: false,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
      progressed: outcome.progressed,
      distanceClosed: approach.closed,
    })
  }

  private async digRetrievalStaircase(
    candidate: Candidate,
    dig: Vec3Json,
    step: Vec3Json,
    epoch: number,
    signal: AbortSignal,
    goalKind: 'GoalBlock' | 'GoalGetToBlock' = 'GoalBlock',
  ): Promise<boolean> {
    if (this.distanceToEyes(dig) > this.options.reach) {
      this.setPhase(candidate, epoch, 'pathing-to-staircase')
      await this.pathToNear(dig, 2, epoch, signal)
      this.ensureOwned(epoch, signal)
    }
    const block = this.currentBlockAt(dig)
    if (block === null || block.boundingBox === 'empty') {
      this.setPhase(candidate, epoch, 'stepping')
      try {
        await this.pathTo(step, epoch, signal, goalKind)
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
      }
      return false
    }
    this.setPhase(candidate, epoch, 'digging')
    const live = this.resolveLiveDigTool(block)
    if (!live.ok) {
      this.logger.warn(
        'executor',
        `RETRIEVE staircase cannot dig ${block.name} at (${dig.x},${dig.y},${dig.z}): ${live.reason}`,
        { actionId: candidate.id },
      )
      return false
    }
    await this.equipTool(
      {
        ...candidate,
        toolName: live.tool,
        toolTier: live.tier,
        requiresTool: live.tool !== null,
        meta: { ...candidate.meta, digBlockName: block.name, toolReason: `live:${live.reason}` },
      },
      epoch,
      signal,
    )
    try {
      await this.digBlock(block, epoch, signal)
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      this.logger.warn('executor', `RETRIEVE staircase dig failed: ${error instanceof Error ? error.message : String(error)}`, {
        actionId: candidate.id,
      })
      return false
    }
    this.ensureOwned(epoch, signal)
    this.setPhase(candidate, epoch, 'stepping')
    try {
      await this.pathTo(step, epoch, signal, goalKind)
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
    }
    return true
  }

  private async runVerticalLeg(
    candidate: Candidate,
    vertical: string,
    fallback: boolean,
    epoch: number,
    signal: AbortSignal,
    target: Vec3Json,
    startY: number,
  ): Promise<boolean> {
    const keyBase = this.verticalKeyBase(vertical, fallback)
    if (keyBase === null) return false
    if (vertical === 'staircase') {
      const dig = readMetaPoint(candidate, `${keyBase}DigX`, `${keyBase}DigY`, `${keyBase}DigZ`)
      const step = readMetaPoint(candidate, `${keyBase}StepX`, `${keyBase}StepY`, `${keyBase}StepZ`)
      if (dig === null || step === null) return false
      const fromY = Math.floor(startY)
      const toY = readMetaNumber(candidate, `${keyBase}ToY`, target.y)
      this.logger.info('agent', `STAIRCASE from_y=${fromY} to_y=${toY}`, { actionId: candidate.id, dig, step })
      return this.digRetrievalStaircase(candidate, dig, step, epoch, signal)
    }
    if (vertical === 'staircase-up') {
      const dig = readMetaPoint(candidate, `${keyBase}DigX`, `${keyBase}DigY`, `${keyBase}DigZ`)
      const step = readMetaPoint(candidate, `${keyBase}StepX`, `${keyBase}StepY`, `${keyBase}StepZ`)
      if (dig === null || step === null) return false
      const fromY = Math.floor(startY)
      const toY = readMetaNumber(candidate, `${keyBase}ToY`, target.y)
      const dir = readMetaString(candidate, `${keyBase}Dir`) ?? 'unknown'
      this.logger.info('agent', `ASCEND_STEP from_y=${fromY} to_y=${toY} dir=${dir}`, {
        actionId: candidate.id,
        dig,
        step,
      })
      return this.digRetrievalStaircase(candidate, dig, step, epoch, signal, 'GoalGetToBlock')
    }
    const placeName = readMetaString(candidate, `${keyBase}PlaceName`)
    const steps = Math.floor(readMetaNumber(candidate, `${keyBase}Steps`, 0))
    if (placeName === null || steps < 1) return false
    const fromY = Math.floor(startY)
    const toY = Math.floor(readMetaNumber(candidate, `${keyBase}ToY`, target.y))
    this.logger.info('agent', `PILLAR_UP from_y=${fromY} to_y=${toY} place=${placeName} steps=${steps}`, {
      actionId: candidate.id,
      target,
    })
    return this.pillarUp(candidate, { placeName, toY, steps }, epoch, signal)
  }

  private verticalKeyBase(vertical: string, fallback: boolean): string | null {
    if (vertical === 'staircase') return fallback ? 'fallbackStair' : 'stair'
    if (vertical === 'staircase-up') return fallback ? 'fallbackUp' : 'up'
    if (vertical === 'pillar') return fallback ? 'fallbackPillar' : 'pillar'
    return null
  }

  /**
   * The reuse leg. Validates the remembered tunnel entry against the live world,
   * clears the one blocking cell when it is diggable, walks, and on a near
   * `path_stuck` attempts a local clearance for the single identified approach
   * cell before giving up. An entry that is fundamentally unusable (no clearance
   * openable, or no support) returns `refused` so the caller selects a different
   * vertical plan instead of escalating a 1.5 m gap to `pathfinder_stuck`.
   */
  private async runReuseVerticalLeg(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    target: Vec3Json,
  ): Promise<{ step: boolean; refused: boolean }> {
    const tunnel = readMetaPoint(candidate, 'tunnelX', 'tunnelY', 'tunnelZ')
    if (tunnel === null) return { step: false, refused: false }

    const planClear = readMetaPoint(candidate, 'tunnelClearX', 'tunnelClearY', 'tunnelClearZ')
    if (planClear !== null) {
      await this.localClearCell(candidate, planClear, readMetaString(candidate, 'tunnelClearName'), epoch, signal)
    }

    const entry = evaluateTunnelEntry(this.probeTunnelEntry(tunnel))
    if (entry.kind === 'clear') {
      await this.localClearCell(candidate, entry.blocker.cell, entry.blocker.name, epoch, signal)
    } else if (entry.kind === 'refuse') {
      this.logger.info('agent', formatTunnelEntryRefused({ reason: entry.reason, cell: entry.cell }), {
        actionId: candidate.id,
        target,
      })
      return { step: false, refused: true }
    }

    this.logger.info('agent', `REUSE_TUNNEL at=${tunnel.x},${tunnel.y},${tunnel.z}`, { actionId: candidate.id, target })
    this.setPhase(candidate, epoch, 'reuse-tunnel')
    const startY = this.bot.entity.position.y
    let pathFailed = false
    try {
      await this.pathToNear(tunnel, 1, epoch, signal)
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      if (!(error instanceof ExecutorError)) throw error
      if (error.code !== 'path_stuck' && error.code !== 'path_no_path') throw error
      pathFailed = true
    }
    if (!pathFailed) {
      this.ensureOwned(epoch, signal)
      return { step: verticalStepTowardTarget({ startY, currentY: this.bot.entity.position.y, targetY: target.y }), refused: false }
    }

    const leg = planReuseLeg({
      entry,
      pathFailed: true,
      distanceToTunnel: this.distanceToFeet(tunnel),
      approachBlockages: this.probeApproachBlockages(tunnel),
    })
    if (leg.action === 'clear-approach') {
      const blockName = this.currentBlockAt(leg.cell)?.name ?? null
      const cleared = await this.localClearCell(candidate, leg.cell, blockName, epoch, signal)
      if (cleared) {
        try {
          await this.pathToNear(tunnel, 1, epoch, signal)
          this.ensureOwned(epoch, signal)
          return { step: verticalStepTowardTarget({ startY, currentY: this.bot.entity.position.y, targetY: target.y }), refused: false }
        } catch (retry) {
          if (retry instanceof ActionCancelled) throw retry
        }
      }
    }
    if (leg.action === 'refuse') {
      this.logger.info('agent', formatTunnelEntryRefused({ reason: leg.reason, cell: leg.cell }), {
        actionId: candidate.id,
        target,
      })
      return { step: false, refused: true }
    }
    throw new ExecutorError('path_stuck', `packet locomotion blocked before (${tunnel.x},${tunnel.y},${tunnel.z})`)
  }

  private probeTunnelEntry(cell: Vec3Json): TunnelEntryProbe {
    const bodyClear = this.passableAt(cell.x, cell.y, cell.z)
    const headClear = this.passableAt(cell.x, cell.y + 1, cell.z)
    const supportSolid = this.solidSupportAt(cell.x, cell.y - 1, cell.z)
    let blocker: TunnelEntryBlockerProbe | null = null
    if (!bodyClear || !headClear) {
      const blockerCell = !bodyClear ? cell : { x: cell.x, y: cell.y + 1, z: cell.z }
      const block = this.currentBlockAt(blockerCell)
      if (block !== null && block.boundingBox !== 'empty') {
        const live = this.resolveLiveDigTool(block)
        blocker = {
          cell: blockerCell,
          name: block.name,
          diggable: block.diggable === true,
          fluidOrHazard: PROBE_FLUIDS.has(block.name) || PROBE_HAZARDS.has(block.name),
          floodRisk: !this.cellClearOfFluids(blockerCell),
          toolOk: live.ok,
        }
      }
    }
    return { cell, bodyClear, headClear, supportSolid, blocker }
  }

  private probeApproachBlockages(tunnel: Vec3Json): ApproachBlockage[] {
    const position = this.bot.entity.position
    const feet = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
    const sx = Math.sign(tunnel.x - feet.x)
    const sz = Math.sign(tunnel.z - feet.z)
    const cells: Vec3Json[] = []
    const addColumn = (x: number, y: number, z: number): void => {
      cells.push({ x, y, z })
      cells.push({ x, y: y + 1, z })
    }
    if (sx !== 0) addColumn(feet.x + sx, feet.y, feet.z)
    if (sz !== 0) addColumn(feet.x, feet.y, feet.z + sz)
    if (sx !== 0 && sz !== 0) addColumn(feet.x + sx, feet.y, feet.z + sz)

    const out: ApproachBlockage[] = []
    const seen = new Set<string>()
    for (const cell of cells) {
      const key = `${cell.x},${cell.y},${cell.z}`
      if (seen.has(key)) continue
      seen.add(key)
      if (this.passableAt(cell.x, cell.y, cell.z)) {
        out.push({ cell, passable: true })
        continue
      }
      const block = this.currentBlockAt(cell)
      const live = block !== null ? this.resolveLiveDigTool(block) : null
      out.push({
        cell,
        passable: false,
        name: block?.name,
        diggable: block?.diggable === true,
        fluidOrHazard: block !== null && (PROBE_FLUIDS.has(block.name) || PROBE_HAZARDS.has(block.name)),
        floodRisk: !this.cellClearOfFluids(cell),
        toolOk: live?.ok === true,
      })
    }
    return out
  }

  private async localClearCell(
    candidate: Candidate,
    cell: Vec3Json,
    nameHint: string | null,
    epoch: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const block = this.currentBlockAt(cell)
    if (block === null || block.boundingBox === 'empty') return false
    const live = this.resolveLiveDigTool(block)
    this.logger.info('agent', formatLocalClear(cell, block.name, live.tool, live.tier), {
      actionId: candidate.id,
      hint: nameHint,
    })
    if (!live.ok) {
      this.logger.warn(
        'executor',
        `LOCAL_CLEAR cannot dig ${block.name} at (${cell.x},${cell.y},${cell.z}): ${live.reason}`,
        { actionId: candidate.id },
      )
      return false
    }
    try {
      await this.equipTool(
        {
          ...candidate,
          toolName: live.tool,
          toolTier: live.tier,
          requiresTool: live.tool !== null,
          meta: { ...candidate.meta, digBlockName: block.name, toolReason: `live:${live.reason}` },
        },
        epoch,
        signal,
      )
      await this.digBlock(block, epoch, signal)
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      this.logger.warn('executor', `LOCAL_CLEAR dig failed: ${error instanceof Error ? error.message : String(error)}`, {
        actionId: candidate.id,
      })
      return false
    }
    this.ensureOwned(epoch, signal)
    return true
  }

  /**
   * PILLAR_UP: place the held block under the airborne feet at the jump apex,
   * land on it, and repeat, bounded by `plan.steps`. Refuses on a missing item,
   * a hazard column, a missing footing, blocked headroom that cannot be cleared
   * safely, or a failed placement.
   *
   * Live M2 diagnosis (zero PILLAR_UP_STEP ever executed): the action ran 21x
   * and the apex wait failed 41x with `PILLAR_UP jump never left the ground`.
   * prismarine-physics gates every jump on `entity.onGround`
   * (node_modules/prismarine-physics/index.js:721-725) and this Leaf 26.1
   * server ships no 26.1 collision shapes (README "Environment findings"), so
   * mineflayer reports onGround=false while a solid block is underfoot. The
   * first correction only probed 0.1 blocks below the raw feet, so it missed
   * whenever the server pinned the body at a fractional y (the live y=10.5 /
   * 10.25 over a footing at feet-1): 1055 live hop jumps at that column all
   * measured rise=0. The shared `pillarJump.ts` correction scans the same
   * contiguous column `resolvePillarStep` does (feet cell or feet-1).
   *
   * The second live failure (main d8a7a72, after the correction landed):
   * `PILLAR_UP made no progress` on every attempt while one place DID consume
   * an item, because the place was gated on `velocity.y <= 0.01` - true while
   * standing, at the vertex, and while falling - and the landing test was an
   * unverified `y in [placeY+1 +/- 0.1]` window. `pillarStepUp` now verifies
   * each sub-step (takeoff, apex window, place, landing) and reports the failed
   * one as `PILLAR_FAIL step=...`, so a consumed item can never again read as
   * an unattributed no-progress action.
   */
  private async pillarUp(
    candidate: Candidate,
    plan: PillarUpPlan,
    epoch: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { placeName, toY, steps: maxSteps } = plan
    const item = this.bot.inventory.items().find((entry) => entry.name === placeName)
    if (item === undefined) {
      this.logger.warn('executor', `PILLAR_UP refused: ${placeName} is not in the inventory`, { actionId: candidate.id })
      return false
    }
    if (this.pillarColumnUnsafe()) {
      this.logger.warn('executor', 'PILLAR_UP refused: liquid or hazard in the bot column', { actionId: candidate.id })
      return false
    }
    this.logger.info('agent', formatPillarSearch(decidePillarPlaceBlock(this.inventoryCounts(), PILLAR_SEARCH_POLICY)), {
      actionId: candidate.id,
    })
    const budget = decidePillarStepBudget(toY - Math.floor(this.bot.entity.position.y), PILLAR_SEARCH_POLICY)
    this.logger.info('agent', formatPillarSearch(budget), { actionId: candidate.id })
    this.setPhase(candidate, epoch, 'equipping')
    await this.bot.equip(item, 'hand')
    this.ensureOwned(epoch, signal)
    const solidAt: SolidAt = (x, y, z) => this.solidSupportAt(x, y, z)
    // Exactly the control-walk mechanism, kept for the whole climb: physics on
    // and the stale onGround flag patched from the block grid on every tick.
    const savedPhysics = this.bot.physicsEnabled
    const uninstallGroundCorrection = installGroundCorrection(this.bot, solidAt)
    this.bot.physicsEnabled = true
    try {
      let climbed = 0
      let relocations = 0
      let attemptSequence = 0
      const refusedColumns = new Set<string>()
      while (climbed < maxSteps) {
        this.ensureOwned(epoch, signal)
        const feet = {
          x: Math.floor(this.bot.entity.position.x),
          y: Math.floor(this.bot.entity.position.y),
          z: Math.floor(this.bot.entity.position.z),
        }
        if (feet.y >= toY) break
        const placeStack = this.bot.inventory.items().find((entry) => entry.name === placeName)
        const pose = resolvePillarStep({
          feetY: this.bot.entity.position.y,
          isSolid: (y) => this.solidSupportAt(feet.x, y, feet.z),
        })
        if (placeStack === undefined || pose === null) {
          if (pose === null && placeStack !== undefined) {
            this.logger.warn(
              'executor',
              formatPillarRefused({ reason: 'no_footing', cell: feet, obstacle: null }),
              { actionId: candidate.id, ...feet },
            )
            refusedColumns.add(pillarColumnKey(feet))
            const relocation = decidePillarRelocation({
              relocations,
              policy: PILLAR_SEARCH_POLICY,
              probes: this.probePillarColumns(feet, refusedColumns),
              self: feet,
            })
            this.logger.info('agent', formatPillarSearch(relocation), { actionId: candidate.id, relocations })
            const fallback = relocation.target
            if (fallback !== null) {
              this.logger.info('agent', formatPillarRelocate(feet, fallback, null), {
                actionId: candidate.id,
                from: feet,
                to: fallback,
              })
              try {
                this.setPhase(candidate, epoch, 'pathing-to-pillar-column')
                await this.pathTo(fallback, epoch, signal, 'GoalBlock')
              } catch (error) {
                if (error instanceof ActionCancelled) throw error
                this.logger.warn(
                  'executor',
                  `PILLAR_UP relocation from no-footing column to (${fallback.x},${fallback.y},${fallback.z}) failed: ${error instanceof Error ? error.message : String(error)}`,
                  { actionId: candidate.id },
                )
                break
              }
              this.ensureOwned(epoch, signal)
              relocations += 1
              continue
            }
          }
          if (!(pose === null && placeStack !== undefined)) {
            this.logger.warn(
              'executor',
              formatPillarRefused({ reason: placeStack === undefined ? 'no_placeable' : 'no_footing', cell: feet, obstacle: null }),
              { actionId: candidate.id, ...feet },
            )
          }
          break
        }
        const columnSafe = !this.pillarColumnUnsafe()
        const headroom = columnSafe ? await this.clearPillarHeadroom(candidate, feet, epoch, signal) : null
        const step = evaluatePillarStep({
          placeableCount: placeStack.count,
          columnSafe,
          remaining: maxSteps - climbed,
          footingSolid: true,
          headroomClear: headroom !== null && headroom.cleared,
        })
        if (!step.ok) {
          const blocked = headroom !== null && !headroom.cleared ? headroom : null
          if (step.reason !== 'reached') {
            this.logger.warn(
              'executor',
              formatPillarRefused({
                reason: step.reason,
                cell: feet,
                obstacle: blocked?.obstacle ?? null,
                cause: blocked?.reason ?? null,
              }),
              { actionId: candidate.id, ...feet, obstacle: blocked?.obstacle?.name ?? null },
            )
          }
          if (step.reason === 'no_headroom') {
            refusedColumns.add(pillarColumnKey(feet))
            const relocation = decidePillarRelocation({
              relocations,
              policy: PILLAR_SEARCH_POLICY,
              probes: this.probePillarColumns(feet, refusedColumns),
              self: feet,
            })
            this.logger.info('agent', formatPillarSearch(relocation), { actionId: candidate.id, relocations })
            const fallback = relocation.target
            if (fallback !== null) {
              this.logger.info('agent', formatPillarRelocate(feet, fallback, blocked?.obstacle ?? null), {
                actionId: candidate.id,
                from: feet,
                to: fallback,
              })
              try {
                this.setPhase(candidate, epoch, 'pathing-to-pillar-column')
                await this.pathTo(fallback, epoch, signal, 'GoalBlock')
              } catch (error) {
                if (error instanceof ActionCancelled) throw error
                this.logger.warn(
                  'executor',
                  `PILLAR_UP relocation to (${fallback.x},${fallback.y},${fallback.z}) failed: ${error instanceof Error ? error.message : String(error)}`,
                  { actionId: candidate.id },
                )
                break
              }
              this.ensureOwned(epoch, signal)
              relocations += 1
              continue
            }
          }
          break
        }
        // A headroom dig left a tool in hand; mineflayer's placeBlock sends the
        // HELD item (generic_place.js:12-18), so re-equip the placeable first.
        if (this.bot.heldItem === null || this.bot.heldItem.name !== placeName) {
          const held = this.bot.inventory.items().find((entry) => entry.name === placeName)
          if (held === undefined) break
          this.setPhase(candidate, epoch, 'equipping')
          await this.bot.equip(held, 'hand')
          this.ensureOwned(epoch, signal)
        }
        const footing = this.currentBlockAt({ x: feet.x, y: pose.footingY, z: feet.z })
        if (footing === null || footing.boundingBox !== 'block') break
        this.setPhase(candidate, epoch, 'pillaring')
        const beforeY = this.bot.entity.position.y
        const placeCell = { x: feet.x, y: pose.placeY, z: feet.z }
        // Keep the launch geometry beside the failure evidence. A takeoff
        // failure can be caused by a bad local footing interpretation, a
        // body embedded in the feet cell, or a server correction; the marker
        // alone cannot distinguish those cases. These reads are diagnostic
        // only and are captured before the jump mutates the entity position.
        const launchFeetBlock = this.currentBlockAt(feet)
        const launchHeadBlock = this.currentBlockAt({ x: feet.x, y: feet.y + 1, z: feet.z })

        // Instrumentation only (m2-pillar-takeoff-evidence): one attemptId per
        // climb attempt ties the launch/end telemetry of a single pillar takeoff
        // together. `attemptSequence` is attempt-local and monotonic, so a
        // relocation/retry loop under the same candidate.id + epoch still gets
        // distinct ids. LAUNCH velocity + control state are captured before the
        // jump mutates the entity. No behaviour change.
        attemptSequence += 1
        const attemptId = makePillarAttemptId(candidate.id, epoch, attemptSequence)
        const launchVelocity = {
          x: this.bot.entity.velocity.x,
          y: this.bot.entity.velocity.y,
          z: this.bot.entity.velocity.z,
        }
        const launchPosition = {
          x: this.bot.entity.position.x,
          y: this.bot.entity.position.y,
          z: this.bot.entity.position.z,
        }
        const launchControlState = readControlState(this.bot)
        const forcedTracker = forcedMoveTracker(this.bot)
        const forcedBefore = forcedTracker.value
        // The jump -> apex -> place -> landing timing lives in pillarApex.ts so
        // every sub-step is injected and unit-testable without a server. The
        // old code placed on a `velocity.y <= 0.01` predicate (also true while
        // standing or falling) and never verified the block had landed.
        const climb = await pillarStepUp(
          this.bot,
          {
            isSolid: solidAt,
            budgetMs: PILLAR_TAKEOFF_BUDGET_MS,
            pollMs: PILLAR_TAKEOFF_POLL_MS,
            apexBudgetMs: PILLAR_APEX_BUDGET_MS,
            placeSettleMs: PLACE_VERIFY_SETTLE_MS,
            landingBudgetMs: PILLAR_LANDING_BUDGET_MS,
            sleep: (ms) => delay(ms, signal),
            now: Date.now,
            ensureOwned: () => this.ensureOwned(epoch, signal),
            place: (face) => this.bot.placeBlock(footing, toVec3(this.bot, face)),
            blockPlaced: () => this.currentBlockAt(placeCell)?.boundingBox === 'block',
          },
          { feetCell: feet, placeCell, support: footing.position },
        )
        this.ensureOwned(epoch, signal)
        // Read the forced-reposition count once for the whole attempt: it is
        // both the takeoff telemetry field and the evidence that a position
        // reset may have voided the trace segment.
        const forcedRepositions = forcedTracker.value - forcedBefore
        // Instrumentation only: one deterministic takeoff record per attempt,
        // emitted on the mirrored PILLAR_TAKEOFF marker so it reaches the
        // run-scoped host log. Read-only; no behaviour change.
        const takeoffBase = {
          attemptId,
          launchVelocity,
          launchPosition,
          endVelocity: {
            x: this.bot.entity.velocity.x,
            y: this.bot.entity.velocity.y,
            z: this.bot.entity.velocity.z,
          },
          endPosition: {
            x: this.bot.entity.position.x,
            y: this.bot.entity.position.y,
            z: this.bot.entity.position.z,
          },
          launchControls: launchControlState,
          endControls: readControlState(this.bot),
          forcedRepositions,
        }
        const jumpTrace: PillarJumpTrace | null = climb.ok ? climb.jumpTrace : (climb.fail.jumpTrace ?? null)
        const emitPillarTakeoff = (peakRise: number, failureStep: string | null, failureReason: string | null) => {
          // The bounded trace rides into the record (and therefore into the
          // formatted line AND the PILLAR_FAIL detail, which spreads `takeoff`).
          // Additive only: it never selects a control or changes a value.
          const takeoff = buildPillarTakeoffTelemetry({ ...takeoffBase, peakRise, failureStep, failureReason, jumpTrace })
          this.logger.info('agent', formatPillarTakeoffTelemetry(takeoff), {
            actionId: candidate.id,
            attemptId: takeoff.attemptId,
            horizontalLeak: takeoff.horizontalLeak,
            takeoffDiscriminator: takeoff.takeoffDiscriminator,
            traceTicks: takeoff.traceTicks,
            traceGateFires: takeoff.traceGateFires,
            traceMaxRise: takeoff.traceMaxRise,
            traceTruncated: takeoff.traceTruncated,
            jumpTrace,
          })
          return takeoff
        }
        if (!climb.ok) {
          const endEntity = this.bot.entity as typeof this.bot.entity & {
            isCollidedHorizontally?: boolean
            isCollidedVertically?: boolean
          }
          const takeoff = emitPillarTakeoff(
            Math.max(0, endEntity.position.y - beforeY),
            climb.fail.step,
            climb.fail.reason,
          )
          this.logger.warn('executor', formatPillarFail(climb.fail), {
            actionId: candidate.id,
            ...feet,
            step: climb.fail.step,
            reason: climb.fail.reason,
            detail: climb.fail.detail ?? null,
            launchY: beforeY,
            supportY: pose.footingY,
            placeY: pose.placeY,
            landingY: pose.landingY,
            supportName: footing.name,
            launchFeetBlock: launchFeetBlock?.name ?? null,
            launchHeadBlock: launchHeadBlock?.name ?? null,
            launchAboveHeadBlock: this.currentBlockAt({ x: feet.x, y: feet.y + 2, z: feet.z })?.name ?? null,
            endPosition: {
              x: endEntity.position.x,
              y: endEntity.position.y,
              z: endEntity.position.z,
            },
            endOnGround: endEntity.onGround,
            ...takeoff,
            endCollidedHorizontally: endEntity.isCollidedHorizontally ?? null,
            endCollidedVertically: endEntity.isCollidedVertically ?? null,
            endJumpTicks: (this.bot as Bot & { jumpTicks?: number }).jumpTicks ?? null,
            forcedRepositions,
            jumpTrace,
          })
          // Evidence for the unsatisfiable-column retire. A `place refused`
          // failure alone stays terminal; it becomes relocatable only when the
          // trace proves the column's arc cannot produce the clearance the
          // server refused against (see `isPillarRefusalUnsatisfiable`).
          const refusalEvidence: PillarRefusalEvidence = {
            feetCellY: feet.y,
            placeCellY: pose.placeY,
            achievableRise: jumpTrace === null ? 0 : takeoffObservedRise(jumpTrace),
            arcComplete: jumpTrace !== null && pillarArcComplete(jumpTrace),
            forcedRepositions,
          }
          if (isPillarRefusalUnsatisfiable(climb.fail, refusalEvidence)) {
            this.logger.warn('executor', formatPillarRetire(feet, refusalEvidence), {
              actionId: candidate.id,
              step: climb.fail.step,
              reason: climb.fail.reason,
              required: requiredColumnClearance(feet.y, pose.placeY),
              achievable: refusalEvidence.achievableRise,
            })
          }
          if (shouldRelocatePillarAfterFailure(climb.fail, refusalEvidence)) {
            refusedColumns.add(pillarColumnKey(feet))
            const relocation = decidePillarRelocation({
              relocations,
              policy: PILLAR_SEARCH_POLICY,
              probes: this.probePillarColumns(feet, refusedColumns),
              self: feet,
            })
            this.logger.info('agent', formatPillarSearch(relocation), { actionId: candidate.id, relocations, failure: climb.fail.reason })
            const fallback = relocation.target
            if (fallback !== null) {
              this.logger.info('agent', formatPillarRelocate(feet, fallback, null), {
                actionId: candidate.id,
                from: feet,
                to: fallback,
                failure: climb.fail.reason,
              })
              try {
                this.setPhase(candidate, epoch, 'pathing-to-pillar-column')
                await this.pathTo(fallback, epoch, signal, 'GoalBlock')
              } catch (error) {
                if (error instanceof ActionCancelled) throw error
                this.logger.warn(
                  'executor',
                  `PILLAR_UP relocation after pillar failure to (${fallback.x},${fallback.y},${fallback.z}) failed: ${error instanceof Error ? error.message : String(error)}`,
                  { actionId: candidate.id, failure: climb.fail.reason },
                )
                break
              }
              this.ensureOwned(epoch, signal)
              relocations += 1
              continue
            }
          }
          break
        }
        climbed += 1
        emitPillarTakeoff(climb.apexRise, null, null)
        this.logger.info(
          'agent',
          formatPillarUpStep(climbed, Math.floor(beforeY), Math.floor(this.bot.entity.position.y), placeName),
          { actionId: candidate.id, x: feet.x, z: feet.z, apexRise: climb.apexRise, samples: climb.samples },
        )
      }
      if (climbed === 0) {
        this.logger.warn('executor', `PILLAR_UP made no progress place=${placeName}`, { actionId: candidate.id })
      }
      return climbed > 0
    } finally {
      uninstallGroundCorrection()
      this.bot.physicsEnabled = savedPhysics
      this.bot.setControlState('jump', false)
    }
  }

  /**
   * A jump needs the two cells above the feet clear (`headroomAt`). In a natural
   * tunnel the ceiling is one of them, so the climb would keep failing even with
   * correct grounding. Open the blocking cell(s) with live-world safety checks:
   * never a fluid/hazard target, never a fluid/hazard touching the opened cell.
   * Returns false when the cell cannot be opened safely; the caller turns that
   * into a `no_headroom` step refusal and the next decision re-routes.
   */
  private async clearPillarHeadroom(
    candidate: Candidate,
    column: { x: number; z: number },
    epoch: number,
    signal: AbortSignal,
  ): Promise<HeadroomClearOutcome> {
    let last: HeadroomClearOutcome = { cleared: false, obstacle: null, reason: 'no_obstacle' }
    let recenterAttempted = false
    for (let attempt = 0; attempt < PILLAR_SEARCH_POLICY.headroomAttempts; attempt += 1) {
      const position = this.bot.entity.position
      const headroom = this.headroomAt(column.x, position.y, column.z, position)
      if (headroom.clear) return { cleared: true }
      const blockingCell = headroom.blocker
      if (blockingCell === null) continue
      // A fractional body can touch an adjacent cell even when the canonical
      // centre of this same column has clear headroom. Re-centre once before
      // declaring the column blocked; this is a bounded horizontal nudge and
      // never digs or changes the selected pillar column.
      const centeredHeadroom = this.headroomAt(column.x, position.y, column.z)
      const adjacentBlocker = blockingCell.x !== column.x || blockingCell.z !== column.z
      if (!recenterAttempted && adjacentBlocker && centeredHeadroom.clear) {
        recenterAttempted = true
        if (await this.recenterPillarColumn(candidate, column, blockingCell, epoch, signal)) {
          this.ensureOwned(epoch, signal)
          continue
        }
      }
      const block = this.currentBlockAt(blockingCell)
      if (block === null || block.boundingBox === 'empty') continue
      const live = this.resolveLiveDigTool(block)
      const decision = classifyHeadroomBlocker({
        cell: blockingCell,
        name: block.name,
        diggable: block.diggable === true,
        fluidOrHazard: PROBE_FLUIDS.has(block.name) || PROBE_HAZARDS.has(block.name),
        floodRisk: !this.cellClearOfFluids({ x: blockingCell.x, y: blockingCell.y + 1, z: blockingCell.z }),
        toolOk: live.ok,
      })
      if (decision.kind === 'refuse') return { cleared: false, obstacle: decision.obstacle, reason: decision.reason }
      const obstacle: HeadroomObstacle = decision.obstacle
      last = { cleared: false, obstacle, reason: 'dig_failed' }
      this.logger.info('agent', `PILLAR_UP clearing headroom ${obstacle.name} at (${obstacle.cell.x},${obstacle.cell.y},${obstacle.cell.z})`, {
        actionId: candidate.id,
      })
      await this.equipTool(
        {
          ...candidate,
          toolName: live.tool,
          toolTier: live.tier,
          requiresTool: live.tool !== null,
          meta: { ...candidate.meta, digBlockName: block.name, toolReason: `live:${live.reason}` },
        },
        epoch,
        signal,
      )
      try {
        await this.digBlock(block, epoch, signal)
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        this.logger.warn(
          'executor',
          `PILLAR_UP headroom dig failed: ${error instanceof Error ? error.message : String(error)}`,
          { actionId: candidate.id },
        )
        return last
      }
      this.ensureOwned(epoch, signal)
    }
    const headroom = this.headroomAt(column.x, this.bot.entity.position.y, column.z, this.bot.entity.position)
    if (headroom.clear) return { cleared: true }
    return last
  }

  /**
   * Move to a safe interior point of the current grounded cell when only a
   * fractional AABB overlap blocks headroom. The custom arrival predicate is
   * intentionally tighter than normal path arrival so a same-cell no-op cannot
   * be reported as a successful recenter. The two axis-aligned legs avoid
   * asking the collision resolver to escape a diagonal corner overlap in one
   * step, while the boundary-derived target avoids extending the footprint
   * farther into unsupported neighbouring cells than necessary.
   */
  private async recenterPillarColumn(
    candidate: Candidate,
    column: { x: number; z: number },
    blocker: Vec3Json,
    epoch: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const origin = this.bot.entity.position.clone()
    const halfWidth = this.bot.entity.width > 0 ? this.bot.entity.width / 2 : 0.3
    const margin = 0.04
    const minX = column.x + halfWidth + margin
    const maxX = column.x + 1 - halfWidth - margin
    const minZ = column.z + halfWidth + margin
    const maxZ = column.z + 1 - halfWidth - margin
    const destination = {
      x: blocker.x < column.x ? minX : blocker.x > column.x ? maxX : column.x + 0.5,
      z: blocker.z < column.z ? minZ : blocker.z > column.z ? maxZ : column.z + 0.5,
    }
    const atDestination = (): boolean => {
      const position = this.bot.entity.position
      return (
        Math.floor(position.y + 1e-4) === Math.floor(origin.y + 1e-4) &&
        Math.hypot(position.x - destination.x, position.z - destination.z) <= 0.08
      )
    }
    if (atDestination()) return true
    this.setPhase(candidate, epoch, 'recentering-pillar-column')
    const floorY = Math.floor(origin.y + 1e-4)
    const deadline = Date.now() + PILLAR_RECENTER_BUDGET_MS
    const deltaX = destination.x - origin.x
    const deltaZ = destination.z - origin.z
    const awayX = Math.sign(column.x - blocker.x)
    const awayZ = Math.sign(column.z - blocker.z)
    const xMovesAway = awayX !== 0 && Math.sign(deltaX) === awayX
    const zMovesAway = awayZ !== 0 && Math.sign(deltaZ) === awayZ
    const xFirst =
      xMovesAway && !zMovesAway
        ? true
        : zMovesAway && !xMovesAway
          ? false
          : Math.abs(deltaX) > Math.abs(deltaZ)
    const legs = xFirst
      ? [
          { x: destination.x, z: origin.z },
          destination,
        ]
      : [
          { x: origin.x, z: destination.z },
          destination,
        ]
    const atPoint = (point: { x: number; z: number }): boolean => {
      const position = this.bot.entity.position
      return Math.floor(position.y + 1e-4) === floorY && Math.hypot(position.x - point.x, position.z - point.z) <= 0.08
    }
    try {
      for (const point of legs) {
        if (atPoint(point)) continue
        const budgetMs = deadline - Date.now()
        if (budgetMs <= 0) break
        await this.walkByControls(
          { x: column.x, y: floorY, z: column.z },
          epoch,
          signal,
          {
            directBearing: true,
            horizontalOnly: true,
            bearingTarget: point,
            budgetMs,
            tolerance: 0.08,
            arrivedAt: () => atPoint(point),
          },
        )
      }
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      this.logger.info('agent', `PILLAR_RECENTER failed reason=${error instanceof Error ? error.message : String(error)}`, {
        actionId: candidate.id,
        from: { x: origin.x, y: origin.y, z: origin.z },
        to: { x: destination.x, y: origin.y, z: destination.z },
      })
      return false
    }
    const position = this.bot.entity.position
    const ok = atDestination()
    this.logger.info('agent', `PILLAR_RECENTER from=${origin.x},${origin.y},${origin.z} to=${position.x},${position.y},${position.z} ok=${ok}`, {
      actionId: candidate.id,
      column,
      destination,
    })
    return ok
  }

  /**
   * Grounded pillar fallback probes: the eight same-level neighbours in a fixed
   * order. Columns already refused this action are excluded so the climb cannot
   * ping-pong between two blocked cells; the ranking/refusal decision belongs to
   * `decidePillarRelocation` (pillarSearch.ts).
   */
  private probePillarColumns(feet: Vec3Json, refused: ReadonlySet<string>): PillarColumnProbe[] {
    const dirs: readonly { dx: number; dz: number }[] = [
      { dx: 1, dz: 0 },
      { dx: -1, dz: 0 },
      { dx: 0, dz: -1 },
      { dx: 0, dz: 1 },
      { dx: 1, dz: 1 },
      { dx: 1, dz: -1 },
      { dx: -1, dz: 1 },
      { dx: -1, dz: -1 },
    ]
    const probes: PillarColumnProbe[] = []
    for (const { dx, dz } of dirs) {
      const cell = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
      if (refused.has(pillarColumnKey(cell))) continue
      probes.push({
        cell,
        supported: this.solidSupportAt(cell.x, cell.y - 1, cell.z),
        feetClear: this.passableAt(cell.x, cell.y, cell.z),
        headClear: this.passableAt(cell.x, cell.y + 1, cell.z),
        aboveHeadClear: this.passableAt(cell.x, cell.y + 2, cell.z),
        unsafe: this.columnUnsafeAt(cell.x, cell.y, cell.z),
      })
    }
    return probes
  }

  /** True when no fluid/hazard block touches the cell (a dig there cannot flood it). */
  private cellClearOfFluids(cell: Vec3Json): boolean {
    for (const offset of DIG_SAFETY_OFFSETS) {
      const block = this.currentBlockAt({ x: cell.x + offset.x, y: cell.y + offset.y, z: cell.z + offset.z })
      if (block === null) continue
      if (PROBE_FLUIDS.has(block.name) || PROBE_HAZARDS.has(block.name)) return false
    }
    return true
  }

  private columnUnsafeAt(x: number, feetY: number, z: number): boolean {
    for (const dy of [-1, 0, 1, 2]) {
      const block = this.currentBlockAt({ x, y: feetY + dy, z })
      if (block === null) continue
      if (PROBE_FLUIDS.has(block.name) || PROBE_HAZARDS.has(block.name)) return true
    }
    return false
  }

  private pillarColumnUnsafe(): boolean {
    const feet = {
      x: Math.floor(this.bot.entity.position.x),
      y: Math.floor(this.bot.entity.position.y),
      z: Math.floor(this.bot.entity.position.z),
    }
    return this.columnUnsafeAt(feet.x, feet.y, feet.z)
  }

  private anchorBlock(candidate: Candidate): Vec3Json | null {
    const x = candidate.meta.targetBlockX
    const y = candidate.meta.targetBlockY
    const z = candidate.meta.targetBlockZ
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
    return { x, y, z }
  }

  /**
   * Control-state actuator: the pathfinder plans (`getPathTo`, canDig=false) and
   * Mineflayer physics actuates. This ports the proven vertical-movement recipe
   * from `mcbot/movement-test/vertical.mjs#navigateTo`:
   *
   *   1. `scanAhead()` looks 0.8-2.8 blocks along the travel direction; if the
   *      surface rises 1-2 blocks within ~2.2 m, the bot is grounded and not yet
   *      colliding, jump PRE-EMPTIVELY while holding forward.
   *   2. If already pinned (`isCollidedHorizontally`), hop vertically first
   *      (forward released, jump ~180 ms), then push forward while airborne; if
   *      still pinned, back off ~300 ms so the next approach jumps before contact.
   *      Inside a 1-deep depression it does not back off (that only retreats).
   *   3. `jump` is never sent together with a blocked forward push: the Leaf
   *      server rejects that packet and teleports the bot back.
   *   4. Headroom >= 2 gates every jump, but for a detected rise it is measured
   *      at the LANDING column (the step top), so a canopy leaf over the current
   *      feet cannot veto a legitimate 1-block step whose landing is clear.
   */
  private async walkByControls(
    target: Vec3Json,
    epoch: number,
    signal: AbortSignal,
    options: ControlWalkOptions,
  ): Promise<boolean> {
    const pathfinder = this.bot.pathfinder
    if (pathfinder === undefined) return false
    const horizontalOnly = options.horizontalOnly === true
    const bearingTarget = options.bearingTarget ?? null
    const anchor = options.anchor ?? null
    const reach = options.reach ?? this.options.reach
    const tolerance = options.tolerance ?? (options.range !== undefined ? Math.max(1, options.range) + 0.5 : 1.2)
    const planGoal = (): PathGoal => {
      if (options.anchorIsGoal === true && anchor !== null) return new goals.GoalGetToBlock(anchor.x, anchor.y, anchor.z)
      if (options.range !== undefined) return new goals.GoalNear(target.x, target.y, target.z, Math.max(1, options.range))
      return new goals.GoalBlock(target.x, target.y, target.z)
    }
    const arrived = (): boolean => {
      if (options.arrivedAt !== undefined) return options.arrivedAt()
      if (options.anchorIsGoal === true && anchor !== null) return this.distanceToEyes(anchor) <= reach
      const position = this.bot.entity.position
      const horizontal = Math.hypot(position.x - target.x, position.z - target.z)
      if (options.requireLevel === true) {
        return horizontal <= tolerance && Math.abs(position.y - target.y) <= 0.75
      }
      // Pickup targets legitimately sit a level below; horizontal-only arrival
      // lets the automatic pickup fire instead of the bot hopping at the edge.
      return horizontal <= tolerance && Math.abs(position.y - target.y) <= 2
    }

    let plan: Vec3Json[] = []
    if (options.directBearing !== true) {
      try {
        const computed = pathfinder.getPathTo(pathfinder.movements, planGoal(), 2000)
        if (computed.status !== 'noPath') {
          plan = computed.path.slice(1).map((node) => ({ x: Math.floor(node.x), y: node.y, z: Math.floor(node.z) }))
        }
      } catch {
        plan = []
      }
    }

    const forcedTracker = forcedMoveTracker(this.bot)
    const forcedBefore = forcedTracker.value
    const start = this.bot.entity.position.clone()
    let maxY = start.y
    let jumps = 0
    let recoveries = 0
    let hopAttempts = 0
    let backUntil = 0
    const savedPhysics = this.bot.physicsEnabled
    // The sensor reads `onGround` from Mineflayer, but on this server the flag
    // can be stale while a solid block is underfoot; correct it from the block
    // grid so the recipe's pre-emptive-jump decision is reliable.
    const uninstallGroundCorrection = installGroundCorrection(this.bot, (x, y, z) => this.solidSupportAt(x, y, z))
    this.bot.physicsEnabled = true
    const until = Date.now() + options.budgetMs
    let lastProgressAt = Date.now()
    let lastPosition = this.bot.entity.position.clone()
    let nextReplanAt = 0
    let index = 0
    let jumpStreak = 0
    try {
      while (Date.now() < until) {
        this.ensureOwned(epoch, signal)
        const position = this.bot.entity.position
        maxY = Math.max(maxY, position.y)
        if (arrived()) {
          this.logControlArrival(target, anchor, start, position, maxY, jumps, recoveries, forcedTracker.value - forcedBefore)
          return true
        }

        if (Date.now() < backUntil) {
          this.bot.setControlState('forward', false)
          this.bot.setControlState('jump', false)
          this.bot.setControlState('back', true)
          await delay(50, signal)
          continue
        }
        this.bot.setControlState('back', false)

        if (Date.now() >= nextReplanAt && options.directBearing !== true) {
          nextReplanAt = Date.now() + 1500
          try {
            const replanned = pathfinder.getPathTo(pathfinder.movements, planGoal(), 1200)
            if (replanned.status !== 'noPath') {
              plan = replanned.path.slice(1).map((node) => ({ x: Math.floor(node.x), y: node.y, z: Math.floor(node.z) }))
              index = 0
            }
          } catch {
            nextReplanAt = Date.now() + 500
          }
        }

        while (index < plan.length) {
          const node = plan[index]
          if (node === undefined) break
          if (Math.hypot(node.x + 0.5 - position.x, node.z + 0.5 - position.z) <= 0.6 && Math.abs(node.y - position.y) <= 0.6) {
            index += 1
            continue
          }
          break
        }
        const node = plan[index] ?? target
        const dx = (bearingTarget?.x ?? node.x + 0.5) - position.x
        const dz = (bearingTarget?.z ?? node.z + 0.5) - position.z
        const horizontal = Math.hypot(dx, dz)
        const ux = dx / (horizontal || 1)
        const uz = dz / (horizontal || 1)
        if (horizontal > 0.05) {
          await this.bot.lookAt(this.bot.entity.position.offset(dx, 0, dz), true).catch(() => undefined)
        }

        const step = this.scanAhead(position, ux, uz)
        const rayClimb = step !== null && step.rise >= 1 && step.rise <= 2 && step.dist <= 2.2
        const nodeSurface = this.surfaceBlockAt(node.x, node.z, Math.round(position.y) - 1)
        const nodeRise = nodeSurface === null ? 0 : nodeSurface.y - (Math.round(position.y) - 1)
        const nodeClimb = nodeRise >= 1 && nodeRise <= 2 && horizontal <= 2.5
        const climb: { x: number; z: number; top: number; source: 'ray' | 'node' } | null = rayClimb
          ? { x: step.x, z: step.z, top: step.top, source: 'ray' }
          : nodeClimb && nodeSurface !== null
            ? { x: node.x, z: node.z, top: nodeSurface.y, source: 'node' }
            : null
        // Depression escape aims at the step EDGE (the landing column ahead),
        // not the far target centre, so the pre-contact jump lands on the lip.
        const goalAboveFeet = target.y - position.y >= 0.5 && target.y - position.y <= 2.5
        const depressionEscape = climb !== null && goalAboveFeet
        // Headroom is a hard precondition for every jump, checked at the current
        // feet AND at the landing column. `Math.round(feet)` read one cell too
        // high and vetoed the 1-block escape at (21,63,-72): a canopy leaf sat at
        // feet+2 while the step itself was clear.
        const currentHeadroom = horizontalOnly ? true : this.hasJumpHeadroom()
        const landingHeadroom =
          !horizontalOnly && climb !== null && this.headroomAt(climb.x, climb.top + 1, climb.z).clear
        const jumpAllowed = landingHeadroom || currentHeadroom

        const standingStill = this.bot.entity.onGround === true && Date.now() - lastProgressAt > 250
        const pinned = this.isPinned()
        const climbDist =
          climb === null ? Number.POSITIVE_INFINITY : Math.hypot(climb.x + 0.5 - position.x, climb.z + 0.5 - position.z)
        // `isCollidedHorizontally` can be stale while the body already touches the
        // step, so contact is also read from the terrain: a solid block at the
        // feet level directly ahead, within closing distance. A blocked forward
        // push combined with a jump is rejected by the server (position
        // teleport), so contact must take the hop path. `climb` is `none` in the
        // live pit (no 1-2 rise is visible from inside it), so the facing column
        // is probed directly instead of gating on a detected climb.
        const faceX = Math.floor(position.x + ux * FACE_PROBE_DIST)
        const faceZ = Math.floor(position.z + uz * FACE_PROBE_DIST)
        const faceAtFeet = this.solidSupportAt(faceX, Math.floor(position.y), faceZ)
        const maneuver: ClimbManeuver = horizontalOnly
          ? 'continue'
          : planClimbManeuver({
              climbDetected: climb !== null,
              onGround: this.bot.entity.onGround === true,
              pinned,
              faceAtFeet,
              standingStill,
            })
        // Order matches the harness: a detected climb is attempted BEFORE any
        // recovery, because the in-loop replan alone exceeds the 250 ms
        // standing-still window and would otherwise hijack the pre-contact jump.
        if (maneuver === 'pre-contact-jump' && climb !== null) {
          if (!jumpAllowed) {
            this.logger.warn(
              'executor',
              `no jump headroom for a ${climb.source} climb at (${Math.floor(position.x)},${Math.round(position.y)},${Math.floor(position.z)}): target unreachable (no hopeless jump)`,
              { target, anchor, currentHeadroom, landingHeadroom },
            )
            return false
          }
          // A genuine 2-block vertical face (solid at the feet level in front)
          // cannot be jumped by a vanilla client (apex 1.2522): only a STEP
          // candidate can open it. Fail fast so the agent re-targets instead of
          // burning the budget on hopeless jumps.
          if (
            options.ignoreFaceVeto !== true &&
            step !== null &&
            step.rise >= 2 &&
            this.solidSupportAt(step.x, Math.floor(position.y), step.z)
          ) {
            this.logger.warn(
              'executor',
              `control locomotion 2-block face at (${step.x},${step.top},${step.z}) rise=${round2(step.rise)} is unclimbable: needs a STEP cut`,
              { target, anchor },
            )
            return false
          }
          // Pre-contact jump: jump WHILE the horizontal move is still free, so
          // the packet carries an unblocked forward component (the Leaf server
          // rejects a jump combined with a blocked forward push).
          jumps += 1
          this.logger.info(
            'executor',
            `control locomotion pre-contact jump#${jumps} ${climb.source} rise=${round2(climb.top + 1 - position.y)} dist=${round2(climb.source === 'ray' ? step?.dist ?? climbDist : horizontal)} at y=${round2(position.y)} →(${climb.x},${climb.top},${climb.z}) headroom=[cur=${currentHeadroom} land=${landingHeadroom}]`,
            { target, anchor },
          )
          this.bot.setControlState('back', false)
          this.bot.setControlState('forward', true)
          this.bot.setControlState('jump', true)
          const beforeJump = this.bot.entity.position.clone()
          await delay(110, signal)
          this.bot.setControlState('jump', false)
          await delay(180, signal)
          if (this.bot.entity.position.distanceTo(beforeJump) < 0.05) {
            jumpStreak += 1
            if (jumpStreak >= 4) {
              this.logger.warn(
                'executor',
                `no progress after ${jumpStreak} pre-contact jumps at (${Math.floor(position.x)},${Math.round(position.y)},${Math.floor(position.z)}): target unreachable (no hopeless jump)`,
                { target, anchor, currentHeadroom, landingHeadroom },
              )
              return false
            }
          } else {
            jumpStreak = 0
          }
        } else if (maneuver === 'vertical-hop') {
          // A pinned bot at a genuine 2-block face can never hop it; fail fast so
          // the placed-block approach can cut a stair instead of hopping forever.
          if (
            options.ignoreFaceVeto !== true &&
            climb !== null &&
            step !== null &&
            step.rise >= 2 &&
            this.solidSupportAt(step.x, Math.floor(position.y), step.z)
          ) {
            this.logger.warn(
              'executor',
              `control locomotion 2-block face at (${step.x},${step.top},${step.z}) rise=${round2(step.rise)} is unclimbable: needs a STEP cut`,
              { target, anchor },
            )
            return false
          }
          if (!jumpAllowed) {
            this.logger.warn(
              'executor',
              `no jump headroom at (${Math.floor(position.x)},${Math.round(position.y)},${Math.floor(position.z)}): target unreachable (no hopeless jump)`,
              { target, anchor, currentHeadroom, landingHeadroom },
            )
            return false
          }
          recoveries += 1
          const beforeHop = this.bot.entity.position.clone()
          this.logger.info(
            'executor',
            `control locomotion hop recoveries=${recoveries} (pinned=${pinned} contact=${faceAtFeet} still=${standingStill}) at y=${round2(position.y)} climb=${climb === null ? 'none' : `${climb.source}@${climb.x},${climb.top},${climb.z}`} headroom=[cur=${currentHeadroom} land=${landingHeadroom}]`,
            { target, anchor },
          )
          // Harness-proven pit recipe (movement-test/vertical.mjs#navigateTo): a
          // free body holds forward through the jump so the packet carries its
          // horizontal component, then forward keeps pushing while airborne; a
          // pinned body releases forward for the pure jump because the server
          // rejects a blocked forward push combined with a jump.
          const hopPlan = planVerticalHop(pinned)
          this.logger.info('agent', formatHopPlan(hopPlan), { target, anchor, pinned, recoveries })
          this.bot.setControlState('forward', hopPlan.holdForward)
          this.bot.setControlState('jump', true)
          await delay(hopPlan.riseMs, signal)
          this.bot.setControlState('jump', false)
          this.bot.setControlState('forward', true)
          await delay(hopPlan.pushMs, signal)
          this.bot.setControlState('forward', false)
          const afterHop = this.bot.entity.position
          const hop = evaluateHop(beforeHop, afterHop, node)
          const { dy, occupiedTarget, hopOk } = hop
          this.logger.info(
            'executor',
            `JUMP_ATTEMPT dy=1 ok=${hopOk} attempts=${hopAttempts} from=(${round2(beforeHop.x)},${round2(beforeHop.y)},${round2(beforeHop.z)}) to=(${round2(afterHop.x)},${round2(afterHop.y)},${round2(afterHop.z)}) rise=${round2(dy)} target=(${node.x},${node.y},${node.z}) occupiedTarget=${occupiedTarget}`,
            { target, anchor },
          )
          if (hopOk) {
            hopAttempts = 0
            lastPosition = afterHop.clone()
            lastProgressAt = Date.now()
            if (hop.escapeMarker !== null) {
              this.logger.info('executor', hop.escapeMarker, { target, anchor, rise: dy })
            }
            continue
          }
          hopAttempts += 1
          if (hopAttempts >= 2) {
            this.logger.warn(
              'executor',
              `JUMP_FAIL attempts=${hopAttempts} -> strategy=detour`,
              { target, anchor, obstacle: climb === null ? null : `${climb.source}@${climb.x},${climb.top},${climb.z}` },
            )
            this.logger.info(
              'executor',
              `DETOUR via=alternate_route reason=hop_failed attempts=${hopAttempts}`,
              { target, anchor },
            )
            return false
          }
          if (this.isPinned()) {
            // Back off to create room for the next pre-contact jump; a depression
            // gets a longer back-off so the bot clears the pit wall first.
            this.bot.setControlState('back', true)
            backUntil = Date.now() + (depressionEscape ? 450 : 300)
          }
          lastPosition = this.bot.entity.position.clone()
          lastProgressAt = Date.now() - 300
          continue
        } else {
          this.bot.setControlState('forward', true)
          this.bot.setControlState('jump', false)
          await delay(45, signal)
        }

        const moved = this.bot.entity.position
        if (moved.distanceTo(lastPosition) > 0.03) {
          lastPosition = moved.clone()
          lastProgressAt = Date.now()
          backUntil = 0
          jumpStreak = 0
          hopAttempts = 0
        } else if (Date.now() - lastProgressAt > 2500) {
          nextReplanAt = 0
        }
      }
      this.logger.warn(
        'executor',
        `control locomotion budget exhausted before (${target.x},${target.y},${target.z})`,
        { target, anchor },
      )
      return false
    } finally {
      uninstallGroundCorrection()
      this.bot.setControlState('forward', false)
      this.bot.setControlState('jump', false)
      this.bot.setControlState('back', false)
      this.bot.physicsEnabled = savedPhysics
    }
  }

  private logControlArrival(
    target: Vec3Json,
    anchor: Vec3Json | null,
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
    maxY: number,
    jumps: number,
    recoveries: number,
    forcedRepositions: number,
  ): void {
    const startDetail = { x: start.x, y: start.y, z: start.z }
    const endDetail = { x: end.x, y: end.y, z: end.z }
    this.logger.info(
      'executor',
      `control locomotion arrival start=(${round2(startDetail.x)},${round2(startDetail.y)},${round2(startDetail.z)}) ` +
        `end=(${round2(endDetail.x)},${round2(endDetail.y)},${round2(endDetail.z)}) climbed=${round2(maxY - startDetail.y)}m ` +
        `jumps=${jumps} recoveries=${recoveries} forcedRepositions=${forcedRepositions}` +
        (anchor === null ? '' : ` anchorEyeDistance=${round2(this.distanceToEyes(anchor))}`),
      { target, anchor, start: startDetail, end: endDetail, jumps, recoveries, forcedRepositions },
    )
  }

  /** First column along (ux,uz) whose floor rises above the current feet level. */
  private scanAhead(
    position: { x: number; y: number; z: number },
    ux: number,
    uz: number,
  ): { dist: number; rise: number; top: number; name: string; x: number; z: number } | null {
    const floorY = Math.round(position.y) - 1
    for (const dist of [0.8, 1.2, 1.6, 2.0, 2.4, 2.8]) {
      const x = Math.floor(position.x + ux * dist)
      const z = Math.floor(position.z + uz * dist)
      const surface = this.surfaceBlockAt(x, z, floorY)
      if (surface === null) continue
      const rise = surface.y - floorY
      if (rise >= 1) return { dist, rise, top: surface.y, name: surface.name, x, z }
    }
    return null
  }

  private isPinned(): boolean {
    const entity = this.bot.entity as unknown as { isCollidedHorizontally?: boolean }
    return entity.isCollidedHorizontally === true
  }

  /** Highest non-empty block in column (x,z), searched eight up to fourteen down. */
  private surfaceBlockAt(x: number, z: number, aroundY: number): { y: number; name: string } | null {
    for (let y = aroundY + 8; y >= aroundY - 14; y -= 1) {
      const block = this.bot.blockAt(this.bot.entity.position.clone().set(x, y, z))
      if (block !== null && block.boundingBox !== 'empty') return { y, name: block.name }
    }
    return null
  }

  private async runEat(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const itemName = candidate.itemName
    if (itemName === null) throw new ExecutorError('target_gone', 'EAT candidate has no item')
    const item = this.bot.inventory.items().find((entry) => entry.name === itemName)
    if (item === undefined) throw new ExecutorError('target_gone', `${itemName} left the inventory`)
    this.setPhase(candidate, epoch, 'equipping')
    await this.bot.equip(item, 'hand')
    this.ensureOwned(epoch, signal)
    this.setPhase(candidate, epoch, 'consuming')
    await this.bot.consume()
    return this.buildResult(candidate, epoch, startedAt, 'done', 'ate', `ate ${itemName}`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
    })
  }

  private async runAttack(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const entityId = candidate.targetEntityId
    if (entityId === null) throw new ExecutorError('target_gone', 'ATTACK candidate has no entity id')
    const entity = this.bot.entities[entityId]
    if (entity === undefined) throw new ExecutorError('target_gone', `entity ${entityId} is gone`)
    this.setPhase(candidate, epoch, 'attacking')
    await this.bot.lookAt(entity.position.offset(0, entity.height * 0.5, 0), true)
    this.ensureOwned(epoch, signal)
    this.bot.attack(entity)
    return this.buildResult(candidate, epoch, startedAt, 'done', 'attacked', `attacked ${candidate.targetName ?? entityId}`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
    })
  }

  private async runWait(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const waitMs = typeof candidate.meta.waitMs === 'number' ? candidate.meta.waitMs : 300
    this.setPhase(candidate, epoch, `waiting ${waitMs}ms`)
    await delay(waitMs, signal)
    return this.buildResult(candidate, epoch, startedAt, 'done', 'waited', `waited ${waitMs}ms`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
    })
  }

  private async runCraft(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const itemName = candidate.itemName
    if (itemName === null) throw new ExecutorError('craft_error', 'CRAFT candidate has no item')
    const itemId = this.itemId(itemName)
    if (itemId === null) throw new ExecutorError('craft_error', `${itemName} is unknown to the connected version`)

    let table: Block | null = null
    if (candidate.meta.requiresTable === true) {
      const target = candidate.target
      if (target === null) {
        throw new ExecutorError('craft_error', 'recipe needs a crafting_table but no station position was supplied')
      }
      // The sensor may see a table far outside interaction reach; walking to it
      // is required, otherwise activateBlock never opens the crafting window.
      this.setPhase(candidate, epoch, 'pathing-to-table')
      await this.approachPlacedBlock(target, 'crafting_table', epoch, signal)
      this.ensureOwned(epoch, signal)
      const block = this.currentBlockAt(target)
      if (block === null || block.name !== 'crafting_table') {
        throw new ExecutorError('target_gone', `no crafting_table at (${target.x},${target.y},${target.z})`)
      }
      table = block
    }

    // One CRAFT decision performs ONE craft (producing `recipe.result.count`
    // items); the loop re-decides if more are needed. Passing the result count
    // here would run that many crafts and over-produce.
    const craftCount = 1
    let recipe = this.bot.recipesFor(itemId, null, 1, table ?? null)[0]
    if (recipe === undefined) {
      await delay(300, signal)
      recipe = this.bot.recipesFor(itemId, null, 1, table ?? null)[0]
    }
    if (recipe === undefined) {
      throw new ExecutorError(
        'craft_error',
        `no Mineflayer recipe for ${itemName}${table === null ? '' : ' at the crafting_table'} (inventory ${JSON.stringify(this.inventoryCounts())})`,
      )
    }

    const logRecipe = recipe as unknown as CraftRecipeLike & {
      delta?: Array<{ id: number; count: number }>
      result?: { id?: number; count?: number }
    }
    this.logger.info(
      'executor',
      `craft recipe ${itemName} result=${JSON.stringify(logRecipe.result ?? null)} delta=${JSON.stringify(logRecipe.delta ?? null)} requiresTable=${String(logRecipe.requiresTable)} table=${table === null ? 'none' : `${table.name}@${table.position.x},${table.position.y},${table.position.z}`} inventory=${JSON.stringify(this.inventoryCounts())}`,
      { actionId: candidate.id },
    )

    this.setPhase(candidate, epoch, 'crafting')
    let gained = 0
    let after = this.countItem(itemName)
    for (let attempt = 0; attempt < 3 && gained <= 0; attempt += 1) {
      if (attempt > 0) {
        await delay(400, signal)
        recipe = this.bot.recipesFor(itemId, null, 1, table ?? null)[0] ?? recipe
      }
      const before = this.countItem(itemName)
      // At a table we own the window interaction (openBlock + explicit resync)
      // because bot.craft's crafting-table delivery silently no-ops when the
      // server has moved on (PrismarineJS/mineflayer#3906). The 2x2 player-grid
      // path is stock and proven, so it still uses bot.craft.
      if (table === null) {
        await this.bot.craft(recipe, craftCount)
      } else {
        await craftAtTable(this.bot, table, recipe as unknown as CraftRecipeLike)
      }
      this.ensureOwned(epoch, signal)
      after = this.countItem(itemName)
      // The server's inventory update can lag the craft promise, so poll before
      // declaring the craft produced nothing.
      const deadline = Date.now() + 2000
      while (after <= before && Date.now() < deadline) {
        await delay(150, signal)
        after = this.countItem(itemName)
      }
      gained = after - before
      this.logger.info(
        'executor',
        `craft attempt#${attempt} ${itemName} before=${before} after=${after} gained=${gained} window=${this.bot.currentWindow?.type ?? 'none'} inventory=${JSON.stringify(this.inventoryCounts())}`,
        { actionId: candidate.id },
      )
    }
    if (gained <= 0) {
      throw new ExecutorError(
        'verify_failed',
        `craft ${itemName} gained 0 (after>=${after}); recipe=${JSON.stringify(logRecipe.delta ?? null)} inventory=${JSON.stringify(this.inventoryCounts())} window=${this.bot.currentWindow?.type ?? 'none'}`,
      )
    }
    const result = this.buildResult(candidate, epoch, startedAt, 'done', 'crafted', `crafted ${gained}x ${itemName}`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: gained,
      goalItemCount: after,
    })
    result.yieldItem = itemName
    return result
  }

  private async runSmelt(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('smelt_error', 'SMELT candidate has no furnace position')
    const inputItem = readMetaString(candidate, 'inputItem')
    const fuelItem = readMetaString(candidate, 'fuelItem')
    const outputItem = candidate.itemName
    if (inputItem === null || fuelItem === null || outputItem === null) {
      throw new ExecutorError('smelt_error', 'SMELT candidate is missing input/fuel/output')
    }
    this.setPhase(candidate, epoch, 'pathing-to-furnace')
    await this.approachPlacedBlock(target, 'furnace', epoch, signal)
    this.ensureOwned(epoch, signal)
    const block = this.currentBlockAt(target)
    if (block === null || !FURNACE_BLOCKS.has(block.name)) {
      throw new ExecutorError('target_gone', `no furnace at (${target.x},${target.y},${target.z})`)
    }
    const inputCount = Math.max(1, Math.floor(readMetaNumber(candidate, 'inputCount', 1)))
    const fuelCount = Math.max(1, Math.floor(readMetaNumber(candidate, 'fuelCount', 1)))
    const furnaceSource = readMetaString(candidate, 'furnaceSource') ?? 'known'
    this.logger.info('agent', formatFurnaceReady(furnaceSource, target), {
      source: furnaceSource,
      at: `${target.x},${target.y},${target.z}`,
      target,
      actionId: candidate.id,
      furnaceSource,
    })
    this.setPhase(candidate, epoch, 'smelting')
    const outcome = await executeFurnaceSmelt(
      {
        openFurnace: () => this.bot.openFurnace(block),
        inventoryItems: () => this.bot.inventory.items().map((entry) => ({ name: entry.name, type: entry.type, count: entry.count })),
        countItem: (name) => this.countItem(name),
        wait: (ms) => delay(ms, signal),
        ensureOwned: () => this.ensureOwned(epoch, signal),
        timeoutMs: this.options.smeltTimeoutMs,
        log: (event, detail) => this.logger.info('agent', formatSmeltLog(event, detail), { actionId: candidate.id, ...detail }),
      },
      { inputItem, fuelItem, outputItem, inputCount, fuelCount },
    )
    const after = outcome.outputCount
    // #79: `done` is earned from evidence, never assumed. An increase in the
    // output item count verifies the smelt; a furnace that consumed the placed
    // input+fuel verifies it too even when the output has not landed yet. A run
    // that moved items in and then consumed/produced nothing stays unverified,
    // and applyPostcondition() downgrades it to ACTION_UNVERIFIED.
    const verified = isSmeltPostconditionMet(outcome)
    const detail = verified
      ? `smelted ${outcome.gained}x ${outputItem}`
      : `no ${outputItem} produced (placed input=${outcome.placedInput} fuel=${outcome.placedFuel}, consumed input=${outcome.consumedInput} fuel=${outcome.consumedFuel})`
    const result = this.buildResult(candidate, epoch, startedAt, 'done', verified ? 'smelted' : 'unverified', detail, null, {
      verified,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: outcome.gained,
      goalItemCount: after,
    })
    if (outcome.gained > 0) result.yieldItem = outputItem
    return result
  }

  private async runDescend(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', 'DESCEND candidate has no dig target')
    if (this.distanceToEyes(target) > this.options.reach) {
      this.setPhase(candidate, epoch, 'pathing')
      await this.pathToNear(target, 2, epoch, signal)
      this.ensureOwned(epoch, signal)
    }
    const block = this.currentBlockAt(target)
    if (block === null) {
      throw new ExecutorError('target_gone', `block at (${target.x},${target.y},${target.z}) is gone before the dig`)
    }
    this.setPhase(candidate, epoch, 'digging')
    const live = this.resolveLiveDigTool(block)
    if (!live.ok) {
      throw new ExecutorError('dig_error', `cannot dig ${block.name} at (${target.x},${target.y},${target.z}): ${live.reason}`)
    }
    await this.equipTool(
      {
        ...candidate,
        toolName: live.tool,
        toolTier: live.tier,
        requiresTool: live.tool !== null,
        meta: { ...candidate.meta, digBlockName: block.name, toolReason: `live:${live.reason}` },
      },
      epoch,
      signal,
    )
    await this.digBlock(block, epoch, signal)
    this.ensureOwned(epoch, signal)

    const step = {
      x: readMetaNumber(candidate, 'stepX', Number.NaN),
      y: readMetaNumber(candidate, 'stepY', Number.NaN),
      z: readMetaNumber(candidate, 'stepZ', Number.NaN),
    }
    if (Number.isFinite(step.x) && Number.isFinite(step.y) && Number.isFinite(step.z)) {
      this.setPhase(candidate, epoch, 'stepping')
      try {
        await this.pathTo(step, epoch, signal, 'GoalBlock')
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
      }
    }
    return this.buildResult(candidate, epoch, startedAt, 'done', 'descended', `descended via (${target.x},${target.y},${target.z})`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: true,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
    })
  }

  private async runStep(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', 'STEP candidate has no cut coordinates')
    if (this.distanceToEyes(target) > this.options.reach) {
      this.setPhase(candidate, epoch, 'pathing')
      await this.pathToNear(target, 2, epoch, signal)
      this.ensureOwned(epoch, signal)
    }
    const block = this.currentBlockAt(target)
    if (block === null || block.boundingBox === 'empty') {
      throw new ExecutorError('target_gone', `the face block at (${target.x},${target.y},${target.z}) is already gone`)
    }
    this.setPhase(candidate, epoch, 'digging')
    await this.equipTool(candidate, epoch, signal)
    await this.digBlock(block, epoch, signal)
    this.ensureOwned(epoch, signal)

    const after = this.currentBlockAt(target)
    const removed = after === null || after.boundingBox === 'empty'
    if (!removed) {
      throw new ExecutorError('verify_failed', `stair-cut at (${target.x},${target.y},${target.z}) did not remove ${block.name}`)
    }
    return this.buildResult(candidate, epoch, startedAt, 'done', 'stepped', `cut a 1-block step via (${target.x},${target.y},${target.z})`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: true,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
    })
  }

  private async runPlace(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const itemName = candidate.itemName
    if (itemName === null) throw new ExecutorError('place_error', 'PLACE candidate has no item')
    const target = candidate.target
    if (target === null) throw new ExecutorError('place_error', 'PLACE candidate has no coordinates')
    const item = this.bot.inventory.items().find((entry) => entry.name === itemName)
    if (item === undefined) throw new ExecutorError('target_gone', `${itemName} left the inventory`)
    const reference = this.findPlaceReference(target)
    if (reference === null) {
      throw new ExecutorError('place_error', `no supporting block adjacent to (${target.x},${target.y},${target.z})`)
    }

    this.setPhase(candidate, epoch, 'equipping')
    await this.bot.equip(item, 'hand')
    this.ensureOwned(epoch, signal)
    this.setPhase(candidate, epoch, 'placing')
    await this.bot.placeBlock(reference.block, reference.face)
    this.ensureOwned(epoch, signal)

    const placedName = await this.waitForPlacedBlock(target, itemName, epoch, signal)
    if (!isPlacePostconditionMet(placedName, itemName)) {
      throw new ExecutorError(
        'verify_failed',
        `placeBlock did not create ${itemName} at (${target.x},${target.y},${target.z}) (found ${placedName ?? 'air'})`,
      )
    }
    const readyLine = placedStationReadyLine(itemName, placedName, target)
    if (readyLine !== null) {
      this.logger.info('agent', readyLine, {
        source: 'placed',
        at: `${target.x},${target.y},${target.z}`,
        target,
        actionId: candidate.id,
      })
    }
    return this.buildResult(candidate, epoch, startedAt, 'done', 'placed', `placed ${itemName}`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: 0,
      goalItemCount: this.countItem(itemName),
    })
  }

  /**
   * #79: the PLACE post-condition is "the block exists at the target", checked
   * against the live world. The client applies the block one tick after the
   * server accepts the placement, so poll within a short bound; a block that
   * never appears is never verified.
   */
  private async waitForPlacedBlock(
    target: Vec3Json,
    itemName: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    const deadline = Date.now() + PLACE_VERIFY_SETTLE_MS
    let placedName = this.currentBlockAt(target)?.name ?? null
    while (!isPlacePostconditionMet(placedName, itemName) && Date.now() < deadline) {
      await delay(50, signal)
      this.ensureOwned(epoch, signal)
      placedName = this.currentBlockAt(target)?.name ?? null
    }
    return placedName
  }

  // -------------------------------------------------------------------------
  // primitives
  // -------------------------------------------------------------------------

  private setPhase(candidate: Candidate, epoch: number, phase: string): void {
    if (this.action !== null && this.action.epoch === epoch) this.action.phase = phase
    this.logger.info('executor', `action#${epoch} ${candidate.id} phase=${phase}`, { phase })
  }

  private async pathTo(
    target: Vec3Json,
    epoch: number,
    signal: AbortSignal,
    goalKind: 'GoalGetToBlock' | 'GoalBlock',
    fallback?: { anchor?: Vec3Json | null; requireLevel?: boolean },
  ): Promise<void> {
    if (this.options.actuation === 'pathfinder') {
      try {
        await this.stockPathTo(target, epoch, signal, goalKind)
        return
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        this.ensureOwned(epoch, signal)
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn('executor', `stock pathfinder ${goalKind} failed (${message}); control-walk fallback`, {
          target,
          actionId: this.action?.id ?? 'unknown',
        })
      }
      const controlsWorked = await this.walkByControls(target, epoch, signal, {
        anchor: fallback?.anchor ?? (goalKind === 'GoalGetToBlock' ? target : null),
        anchorIsGoal: goalKind === 'GoalGetToBlock',
        requireLevel: fallback?.requireLevel,
        budgetMs: this.options.pathTimeoutMs,
      })
      if (!controlsWorked) await this.walkByPackets(target, 1, epoch, signal)
      this.notifyPathCompleted(target)
      return
    }
    const controlsWorked =
      goalKind === 'GoalGetToBlock' &&
      (await this.walkByControls(target, epoch, signal, {
        anchor: target,
        anchorIsGoal: true,
        budgetMs: this.options.pathTimeoutMs,
      }))
    if (!controlsWorked) await this.walkByPackets(target, 1, epoch, signal)
    this.notifyPathCompleted(target)
  }

  /**
   * Stock `mineflayer-pathfinder` (the primary MOVE path): `setGoal` with the
   * pinned `canDig=false` Movements, then wait for `goal_reached`. Throws with
   * the exact pathfinder failure code so `pathTo` can log it and fall back.
   */
  private async stockPathTo(
    target: Vec3Json,
    epoch: number,
    signal: AbortSignal,
    goalKind: 'GoalGetToBlock' | 'GoalBlock',
  ): Promise<void> {
    const goal =
      goalKind === 'GoalGetToBlock'
        ? new goals.GoalGetToBlock(target.x, target.y, target.z)
        : new goals.GoalBlock(target.x, target.y, target.z)
    const outcome = this.waitForGoal(epoch, signal, this.options.pathTimeoutMs)
    this.bot.pathfinder.setGoal(goal)
    const result = await outcome
    this.pathStatus = toPathStatus(result)
    if (result !== 'reached') {
      this.notifyPathFailed(target, result)
      throw new ExecutorError(pathFailure(result), `pathfinder ${goalKind} -> ${result}`)
    }
    this.notifyPathCompleted(target)
  }

  private async pathToNear(
    position: Vec3Json,
    range: number,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.options.actuation === 'pathfinder') {
      try {
        const goal = new goals.GoalNear(position.x, position.y, position.z, range)
        const outcome = this.waitForGoal(epoch, signal, this.options.pickupPathTimeoutMs)
        this.bot.pathfinder.setGoal(goal)
        const result = await outcome
        this.pathStatus = toPathStatus(result)
        if (result !== 'reached') {
          this.notifyPathFailed(position, result)
          throw new ExecutorError(pathFailure(result), `pathfinder GoalNear -> ${result}`)
        }
        this.notifyPathCompleted(position)
        return
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        this.ensureOwned(epoch, signal)
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn('executor', `stock pathfinder GoalNear failed (${message}); control-walk fallback`, {
          position,
          actionId: this.action?.id ?? 'unknown',
        })
      }
      const controlsWorked = await this.walkByControls(position, epoch, signal, {
        range,
        budgetMs: this.options.pickupPathTimeoutMs,
      })
      if (!controlsWorked) await this.walkByPackets(position, range, epoch, signal)
      this.notifyPathCompleted(position)
      return
    }
    const controlsWorked = await this.walkByControls(position, epoch, signal, {
      range,
      budgetMs: this.options.pickupPathTimeoutMs,
    })
    if (!controlsWorked) await this.walkByPackets(position, range, epoch, signal)
    this.notifyPathCompleted(position)
  }

  /**
   * Approach a placed station (crafting_table / furnace / chest). Stock
   * `mineflayer-pathfinder` gets a small bounded slice; when it stalls, a
   * direct-bearing control nudge with the pre-contact jump takes over in its own
   * reserved window (the same recipe that fixed drop pickup). Arrival is
   * horizontal distance to the block plus reachability of its interaction face,
   * so a station one level up cannot veto an adjacent stand. A blocked 2-block
   * face is opened by cutting its upper block (the sensor `stepCuts` safety
   * predicates), never by tunnelling, and the whole thing fails fast with a
   * clear reason so the agent re-targets instead of wedging.
   */
  private async approachPlacedBlock(
    block: Vec3Json,
    label: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const arrived = (): boolean => this.interactionArrived(block)
    if (arrived()) return
    const startDistance = this.horizontalToFeet(block)
    const stand = this.bestInteractionStand(block)
    const destination = stand ?? block

    if (this.options.actuation === 'pathfinder') {
      let result: PathOutcome = 'noPath'
      try {
        const goal = new goals.GoalNear(destination.x, destination.y, destination.z, 1)
        const outcome = this.waitForGoal(epoch, signal, PLACED_STOCK_BUDGET_MS)
        this.bot.pathfinder.setGoal(goal)
        result = await outcome
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn('executor', `stock pathfinder GoalNear for ${label} failed: ${message}`)
      } finally {
        this.bot.pathfinder?.setGoal(null)
      }
      this.ensureOwned(epoch, signal)
      if (result === 'reached') this.notifyPathCompleted(block)
      else {
        this.notifyPathFailed(block, result)
        this.logger.warn(
          'executor',
          `stock pathfinder GoalNear for ${label} -> ${result}; direct-bearing nudge fallback`,
          { block, actionId: this.action?.id ?? 'unknown' },
        )
      }
      if (arrived()) {
        this.logger.info(
          'executor',
          `approach ${label} via stock pathfinder horizontal=${round2(this.horizontalToFeet(block))}m face=${round2(this.blockFaceDistance(block))}m`,
          { block },
        )
        return
      }
    }

    let cuts = 0
    const deadline = Date.now() + PLACED_NUDGE_TOTAL_MS
    while (!arrived() && Date.now() < deadline) {
      try {
        await this.walkByControls(destination, epoch, signal, {
          directBearing: true,
          tolerance: PLACED_APPROACH_HORIZONTAL,
          anchor: block,
          reach: this.options.reach,
          budgetMs: PLACED_NUDGE_BUDGET_MS,
          arrivedAt: arrived,
        })
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn('executor', `approach ${label} nudge failed: ${message}`)
      }
      if (arrived()) break
      if (cuts >= PLACED_MAX_STEP_CUTS) continue
      const cut = this.findApproachStepCut(block)
      if (cut === null) continue
      cuts += 1
      const cutBlock = this.currentBlockAt(cut)
      const cutOk = await this.cutApproachStep(cut, epoch, signal)
      this.logger.info(
        'executor',
        `approach ${label}: stair-cut ${cutBlock?.name ?? '?'} at (${cut.x},${cut.y},${cut.z}) ok=${cutOk} cuts=${cuts}`,
        { block },
      )
      this.ensureOwned(epoch, signal)
    }

    if (arrived()) {
      this.logger.info(
        'executor',
        `approach ${label} arrival horizontal=${round2(startDistance)}m->${round2(this.horizontalToFeet(block))}m face=${round2(this.blockFaceDistance(block))}m cuts=${cuts}`,
        { block },
      )
      this.notifyPathCompleted(block)
      return
    }
    this.notifyPathFailed(block, 'stuck')
    throw new ExecutorError(
      'path_stuck',
      `approach to ${label} at (${block.x},${block.y},${block.z}) blocked ${round2(this.horizontalToFeet(block))}m away (face reach ${round2(this.blockFaceDistance(block))}m > ${this.options.reach})`,
    )
  }

  private interactionArrived(block: Vec3Json): boolean {
    return (
      this.horizontalToFeet(block) <= PLACED_APPROACH_HORIZONTAL &&
      this.blockFaceDistance(block) <= this.options.reach
    )
  }

  private blockFaceDistance(block: Vec3Json): number {
    const eye = this.bot.entity.position.offset(0, 1.62, 0)
    const x = Math.max(block.x, Math.min(eye.x, block.x + 1))
    const y = Math.max(block.y, Math.min(eye.y, block.y + 1))
    const z = Math.max(block.z, Math.min(eye.z, block.z + 1))
    return Math.hypot(eye.x - x, eye.y - y, eye.z - z)
  }

  private bestInteractionStand(block: Vec3Json): Vec3Json | null {
    const offsets: Vec3Json[] = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ]
    let best: { spot: Vec3Json; distance: number } | null = null
    for (const offset of offsets) {
      for (const dy of [0, 1, -1]) {
        const spot = { x: block.x + offset.x, y: block.y + dy, z: block.z + offset.z }
        if (
          !this.passableAt(spot.x, spot.y, spot.z) ||
          !this.passableAt(spot.x, spot.y + 1, spot.z) ||
          !this.solidSupportAt(spot.x, spot.y - 1, spot.z)
        ) {
          continue
        }
        const d = this.horizontalToFeet(spot)
        if (best === null || d < best.distance) best = { spot, distance: d }
      }
    }
    return best?.spot ?? null
  }

  private findApproachStepCut(block: Vec3Json): Vec3Json | null {
    const position = this.bot.entity.position
    const feetY = Math.floor(position.y + 1e-4)
    const feetX = Math.floor(position.x + 1e-4)
    const feetZ = Math.floor(position.z + 1e-4)
    const dirs = [
      { dx: 1, dz: 0 },
      { dx: -1, dz: 0 },
      { dx: 0, dz: -1 },
      { dx: 0, dz: 1 },
    ]
    let best: { cut: Vec3Json; distance: number } | null = null
    for (const { dx, dz } of dirs) {
      const towardBlock = (block.x + 0.5 - position.x) * dx + (block.z + 0.5 - position.z) * dz
      if (towardBlock <= 0) continue
      for (const dist of [1, 2, 3]) {
        const x = feetX + dx * dist
        const z = feetZ + dz * dist
        let top: number | null = null
        for (let y = feetY + 2; y >= feetY - 1; y -= 1) {
          if (this.solidSupportAt(x, y, z)) {
            top = y
            break
          }
        }
        if (top === null) continue
        if (top - (feetY - 1) < 2) break
        const upper = this.currentBlockAt({ x, y: top, z })
        if (upper === null || !isBreakableSolidBlock(upper)) break
        if (!this.solidSupportAt(x, top - 1, z)) break
        if (!this.passableAt(x, top + 1, z) || !this.passableAt(x, top + 2, z)) break
        if (
          this.hazardAt(x, top, z) ||
          this.hazardAt(x, top - 1, z) ||
          this.hazardAt(x, top + 1, z)
        ) {
          break
        }
        const d = Math.hypot(x + 0.5 - (block.x + 0.5), z + 0.5 - (block.z + 0.5))
        if (best === null || d < best.distance) best = { cut: { x, y: top, z }, distance: d }
        break
      }
    }
    return best?.cut ?? null
  }

  private hazardAt(x: number, y: number, z: number): boolean {
    const block = this.currentBlockAt({ x, y, z })
    return (
      block !== null &&
      (PROBE_HAZARDS.has(block.name) || PROBE_FLUIDS.has(block.name)) &&
      block.boundingBox === 'empty'
    )
  }

  private async cutApproachStep(cut: Vec3Json, epoch: number, signal: AbortSignal): Promise<boolean> {
    const block = this.currentBlockAt(cut)
    if (block === null || block.boundingBox === 'empty') return false
    if (this.distanceToEyes(cut) > this.options.reach) return false
    const harvestTools = (block as { harvestTools?: Record<string, boolean> }).harvestTools
    if (harvestTools !== undefined) {
      const ids = new Set(
        Object.entries(harvestTools)
          .filter(([, ok]) => ok)
          .map(([id]) => Number(id)),
      )
      const tool = this.bot.inventory.items().find((item) => ids.has(item.type))
      if (tool !== undefined) {
        await this.bot.equip(tool, 'hand')
        this.ensureOwned(epoch, signal)
      }
    }
    if (!this.bot.canDigBlock(block)) return false
    await this.digBlock(block, epoch, signal)
    return true
  }

  private notifyPathCompleted(target: Vec3Json): void {
    this.options.hooks?.onPathCompleted?.({
      actionId: this.action?.id ?? 'unknown',
      target,
      mode: this.options.actuation,
    })
  }

  private notifyPathFailed(target: Vec3Json, outcome: PathOutcome): void {
    if (outcome !== 'noPath' && outcome !== 'stuck' && outcome !== 'timeout') return
    this.options.hooks?.onPathFailed?.({
      actionId: this.action?.id ?? 'unknown',
      target,
      mode: this.options.actuation,
      outcome,
    })
  }

  /**
   * Pathfinder plans (`getPathTo`, honouring `canDig = false`); the packet
   * stepper actuates the resulting waypoints. Used when 'packet' actuation is
   * selected, i.e. when Mineflayer's physics cannot move the bot.
   */
  private async walkByPackets(
    target: Vec3Json,
    range: number,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const planned = this.planWaypoints(target, range)
    const chain = planned.length > 0 ? planned : [target]
    const forcedBefore = forcedMoveTracker(this.bot).value
    this.logger.info(
      'executor',
      `packet locomotion -> (${target.x},${target.y},${target.z}) via ${chain.length} waypoint(s)`,
      { actuation: this.options.actuation, plannedByPathfinder: planned.length > 0 },
    )
    for (const waypoint of chain) {
      const arrived = await this.stepTo(waypoint, range, epoch, signal)
      if (!arrived) {
        this.notifyPathFailed(target, 'stuck')
        throw new ExecutorError(
          'path_stuck',
          `packet locomotion blocked before (${waypoint.x},${waypoint.y},${waypoint.z})`,
        )
      }
    }
    this.logger.info(
      'executor',
      `packet locomotion complete -> (${target.x},${target.y},${target.z}) forcedRepositions=${forcedMoveTracker(this.bot).value - forcedBefore}`,
      { actionId: this.action?.id ?? 'unknown' },
    )
    this.pathStatus = 'success'
    if (this.distanceToFeet(target) > range + 2) {
      throw new ExecutorError('out_of_reach', `stopped ${round2(this.distanceToFeet(target))}m from the target`)
    }
  }

  private planWaypoints(target: Vec3Json, range: number): Vec3Json[] {
    try {
      const goal = new goals.GoalNear(target.x, target.y, target.z, Math.max(1, range))
      const plan = this.bot.pathfinder.getPathTo(this.bot.pathfinder.movements, goal, 2500)
      if (plan.status === 'noPath') return []
      return plan.path.slice(1).map((node) => ({ x: node.x, y: node.y, z: node.z }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('executor', `pathfinder planning failed, walking directly: ${message}`)
      return []
    }
  }

  private async stepTo(
    target: Vec3Json,
    range: number,
    epoch: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const physicsWasEnabled = this.bot.physicsEnabled
    this.bot.physicsEnabled = false
    try {
      let checkpoint = this.bot.entity.position.clone()
      for (let step = 0; step < this.options.maxStepsPerWaypoint; step += 1) {
        this.ensureOwned(epoch, signal)
        const position = this.bot.entity.position
        const dx = target.x + 0.5 - position.x
        const dz = target.z + 0.5 - position.z
        const dy = target.y - position.y
        const horizontal = Math.hypot(dx, dz)
        // Arrival must match the node's level: accepting "one block below" made
        // the stepper skip every climb and then hang on the next waypoint.
        if (horizontal <= range && Math.abs(dy) <= 0.6) return true

        const next = this.chooseStep(position, target)
        if (next === null) return false
        const moveX = next.x - position.x
        const moveZ = next.z - position.z
        const yaw = Math.atan2(-moveX, moveZ)

        if (this.options.actuationPort !== undefined) {
          this.options.actuationPort.setPose({ x: next.x, y: next.y, z: next.z, yaw, onGround: true })
        } else {
          this.bot.entity.yaw = yaw
          this.bot.entity.onGround = true
          this.bot.entity.position.set(next.x, next.y, next.z)
        }
        this.writePacket('position_look', {
          x: next.x,
          y: next.y,
          z: next.z,
          yaw,
          pitch: this.bot.entity.pitch,
          flags: { onGround: true, hasHorizontalCollision: false },
        })

        if (step % 10 === 9) {
          // the server silently rejects some positions; detect the stall
          if (this.bot.entity.position.distanceTo(checkpoint) < 0.15) return false
          checkpoint = this.bot.entity.position.clone()
        }
        await delay(this.options.packetStepMs, signal)
      }
      return false
    } finally {
      this.bot.physicsEnabled = physicsWasEnabled
    }
  }

  /**
   * Pick the next position on the way to `target`. Tries the direct heading
   * first, then 45-degree fan-outs and finally a step back, so a leaf canopy or
   * a wall makes the bot slide around it instead of giving up. Each direction
   * also tries the same level, one block up and one block down, which is what
   * lets it climb a one-block terrain step while physics is disabled.
   */
  private chooseStep(
    position: { x: number; y: number; z: number },
    target: Vec3Json,
  ): { x: number; y: number; z: number } | null {
    const dx = target.x + 0.5 - position.x
    const dz = target.z + 0.5 - position.z
    const horizontal = Math.hypot(dx, dz)
    if (horizontal < 0.05) return null
    const stepLength = Math.min(0.25, horizontal)
    const baseY = Math.floor(position.y + 0.1)
    const heading = Math.atan2(dz, dx)
    const fan = [0, 45, -45, 90, -90, 135, -135, 180]
    let best: { x: number; y: number; z: number } | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const degrees of fan) {
      const angle = heading + (degrees * Math.PI) / 180
      const nx = position.x + Math.cos(angle) * stepLength
      const nz = position.z + Math.sin(angle) * stepLength
      const cellX = Math.floor(nx)
      const cellZ = Math.floor(nz)
      for (const levelDelta of [0, 1, -1]) {
        const feetY = baseY + levelDelta
        // A step must land on solid support. Without this the stepper happily
        // walks into thin air (server snaps it back) and hangs on the first
        // obstacle; with it, a one-block staircase is climbable.
        if (!this.passableAt(cellX, feetY, cellZ) || !this.passableAt(cellX, feetY + 1, cellZ)) continue
        if (!this.solidSupportAt(cellX, feetY - 1, cellZ)) continue
        const stepY =
          levelDelta === 0
            ? position.y + Math.max(-0.25, Math.min(0.25, target.y - position.y))
            : feetY
        const score =
          Math.hypot(cellX + 0.5 - (target.x + 0.5), cellZ + 0.5 - (target.z + 0.5)) +
          Math.abs(feetY - target.y) * 0.4 +
          Math.abs(degrees) * 0.001
        if (score < bestScore) {
          bestScore = score
          best = { x: nx, y: stepY, z: nz }
        }
      }
    }
    return best
  }

  private passableAt(x: number, y: number, z: number): boolean {
    const block = this.bot.blockAt(this.bot.entity.position.clone().set(x, y, z))
    return block === null || block.boundingBox === 'empty'
  }

  /**
   * A jump needs the two cells above the feet clear (headroom >= 2 blocks).
   * `feetY` is the standing level, so `Math.floor` identifies the feet block;
   * `Math.round` read one cell too high and rejected valid 1-block climbs.
   */
  private headroomAt(
    x: number,
    feetY: number,
    z: number,
    center: { x: number; z: number } = { x: x + 0.5, z: z + 0.5 },
  ): { clear: boolean; blocker: Vec3Json | null } {
    const halfWidth = this.bot.entity.width > 0 ? this.bot.entity.width / 2 : 0.3
    return headroomAcrossFootprint({
      center,
      feetY,
      halfWidth,
      isPassable: (cellX, cellY, cellZ) => this.passableAt(cellX, cellY, cellZ),
    })
  }

  private hasJumpHeadroom(): boolean {
    const position = this.bot.entity.position
    return this.headroomAt(Math.floor(position.x), position.y, Math.floor(position.z), position).clear
  }

  private solidSupportAt(x: number, y: number, z: number): boolean {
    const block = this.bot.blockAt(this.bot.entity.position.clone().set(x, y, z))
    return block !== null && block.boundingBox === 'block'
  }

  private writePacket(name: string, data: Record<string, unknown>): void {
    if (this.options.actuationPort !== undefined) {
      this.options.actuationPort.writeMovementPacket(name, data)
      return
    }
    const client = this.bot._client as unknown as {
      write: (packetName: string, payload: Record<string, unknown>) => boolean
    }
    client.write(name, data)
  }

  private waitForGoal(epoch: number, signal: AbortSignal, timeoutMs: number): Promise<PathOutcome> {
    return new Promise<PathOutcome>((resolve) => {
      let settled = false
      const finish = (outcome: PathOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.bot.removeListener('goal_reached', onReached)
        this.bot.removeListener('path_update', onUpdate)
        this.bot.removeListener('path_reset', onReset)
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const onReached = (): void => finish('reached')
      const onUpdate = (path: PartiallyComputedPath): void => {
        if (path.status === 'noPath') finish('noPath')
        else if (path.status === 'timeout') finish('timeout')
      }
      const onReset = (reason: string): void => {
        if (reason === 'stuck') finish('stuck')
      }
      const onAbort = (): void => finish('cancelled')
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      this.bot.on('goal_reached', onReached)
      this.bot.on('path_update', onUpdate)
      this.bot.on('path_reset', onReset)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted || epoch !== this.activeEpoch) finish('cancelled')
    })
  }

  private async digBlock(block: Block, epoch: number, signal: AbortSignal): Promise<void> {
    this.ensureOwned(epoch, signal)
    if (!this.bot.canDigBlock(block)) {
      throw new ExecutorError('dig_error', `canDigBlock() returned false for ${block.name}`)
    }
    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
    this.ensureOwned(epoch, signal)

    let timedOut = false
    const dig = this.bot.dig(block, 'ignore')
    const timer = setTimeout(() => {
      timedOut = true
      this.bot.stopDigging()
    }, this.options.digTimeoutMs)
    try {
      await dig
    } catch (error) {
      if (timedOut) throw new ExecutorError('dig_timeout', `dig timed out after ${this.options.digTimeoutMs}ms`)
      throw new ExecutorError('dig_error', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * `bot.dig()` from a distance leaves the drop outside the ~1 block pickup
   * radius, and a dug mid-air trunk segment drops to the ground below. So the
   * VERIFY step also *collects*: it locates the dropped-item entity, walks onto
   * it and waits for the automatic pickup. Only then is the action verified.
   */
  private async collectDrop(
    target: Vec3Json,
    itemName: string | null,
    beforeCount: number,
    removed: boolean,
    epoch: number,
    signal: AbortSignal,
  ): Promise<VerifyReport> {
    const startedAt = Date.now()
    const settleDeadline = startedAt + this.options.verifyTimeoutMs
    let afterCount = this.countItem(itemName)
    let dropObserved = false
    let nudges = 0
    await delay(400, signal)

    const closest = this.nearestDropPosition(itemName, target, DROP_SEARCH_RADIUS)
    if (closest !== null) dropObserved = true
    const initialProximity = closest === null ? Number.POSITIVE_INFINITY : this.distanceToFeet(closest)
    this.logger.info(
      'executor',
      `pickup approach item=${itemName ?? '?'} drop=${closest === null ? 'none' : 'yes'} distance=${round2(initialProximity)} stock=collectblock`,
      { target, actionId: this.action?.id ?? 'unknown' },
    )

    const stockDrop = this.nearestDropEntity(itemName, target, DROP_SEARCH_RADIUS)
    // A drop already inside the automatic-pickup volume needs no navigation:
    // putting it through the stock collectblock walk just burns its budget.
    if (stockDrop !== null && this.bot.collectBlock !== undefined && initialProximity > 2.0) {
      const stockBudgetMs = Math.min(STOCK_COLLECT_BUDGET_MS, Math.max(1000, Math.floor(this.options.verifyTimeoutMs / 3)))
      const collectRun =
        this.options.actuationPort !== undefined
          ? this.options.actuationPort.collect(stockDrop, { ignoreNoPath: true })
          : this.bot.collectBlock.collect(stockDrop, { ignoreNoPath: true })
      try {
        await Promise.race([
          collectRun,
          delay(stockBudgetMs, signal).then(() => {
            throw new Error(`collectblock budget exhausted (${stockBudgetMs}ms)`)
          }),
        ])
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn('executor', `stock collectblock failed, falling back to the control nudge: ${message}`)
      }
      this.ensureOwned(epoch, signal)
      // collectblock leaves its own Movements (canDig=true) installed on the
      // pathfinder; clear the goal so the nudge starts from a clean state.
      this.bot.pathfinder?.setGoal(null)
      afterCount = this.countItem(itemName)
      this.logger.info(
        'executor',
        `stock collectblock item=${itemName ?? '?'} gained=${Math.max(0, afterCount - beforeCount)}`,
        { target, entityId: stockDrop.id, actionId: this.action?.id ?? 'unknown' },
      )
    }

    const nudgeDeadline = Math.min(settleDeadline, Date.now() + PICKUP_NUDGE_TOTAL_MS)
    let bestHorizontal = Number.POSITIVE_INFINITY
    let stalledNudges = 0
    while (afterCount <= beforeCount && Date.now() < nudgeDeadline) {
      this.ensureOwned(epoch, signal)
      const drop = this.nearestDropPosition(itemName, target, DROP_SEARCH_RADIUS)
      if (drop !== null) dropObserved = true
      const destination = drop ?? target
      const proximity = this.distanceToFeet(destination)
      const horizontal = this.horizontalToFeet(destination)
      const feetY = this.bot.entity.position.y
      const sameLevel = Math.abs(destination.y - feetY) <= 1.0
      // Automatic pickup fires within ~1.3 m horizontally, so a same-level drop
      // needs a wider approach window than the tight 0.7 m used for a drop that
      // sits a level below.
      const approachRadius = sameLevel ? PICKUP_SAME_LEVEL_RADIUS : PICKUP_APPROACH_RADIUS
      if (horizontal < bestHorizontal - 0.15) {
        bestHorizontal = horizontal
        stalledNudges = 0
      } else {
        stalledNudges += 1
      }
      if (horizontal > approachRadius) {
        nudges += 1
        const aim = this.pickupAim(destination, sameLevel, stalledNudges)
        try {
          // Direct, collision-shape-independent approach with the pre-contact
          // jump recipe. No packet-stepper fallback: a rejected teleport there
          // is what stalled every pickup in the previous runs.
          await this.walkByControls(aim, epoch, signal, {
            tolerance: approachRadius,
            budgetMs: PICKUP_NUDGE_BUDGET_MS,
            directBearing: true,
            ignoreFaceVeto: sameLevel,
          })
        } catch (error) {
          if (error instanceof ActionCancelled) throw error
          const message = error instanceof Error ? error.message : String(error)
          this.logger.warn('executor', `pickup nudge failed: ${message}`)
        }
      }
      this.ensureOwned(epoch, signal)
      await delay(250, signal)
      const observed = this.countItem(itemName)
      afterCount = observed
      this.logger.info(
        'executor',
        `pickup ${itemName ?? '?'} distance=${round2(proximity)} nudges=${nudges} ` +
          `drop=${drop === null ? 'none' : 'yes'} gained=${Math.max(0, afterCount - beforeCount)}`,
        { target, actionId: this.action?.id ?? 'unknown' },
      )
    }
    return {
      removed,
      dropObserved,
      itemsGained: Math.max(0, afterCount - beforeCount),
      goalItemCount: afterCount,
      settledMs: Date.now() - startedAt,
    }
  }

  private pickupAim(destination: Vec3Json, sameLevel: boolean, stalledNudges: number): Vec3Json {
    if (!sameLevel || stalledNudges < PICKUP_BEARING_RETRY_AFTER) return destination
    const feet = this.bot.entity.position
    const dx = feet.x - destination.x
    const dz = feet.z - destination.z
    const angle = (Math.floor(stalledNudges / PICKUP_BEARING_RETRY_AFTER) * Math.PI) / 2
    const px = dx * Math.cos(angle) - dz * Math.sin(angle)
    const pz = dx * Math.sin(angle) + dz * Math.cos(angle)
    const length = Math.hypot(px, pz) || 1
    const radius = Math.max(0.8, Math.min(1.4, Math.hypot(dx, dz)))
    return {
      x: destination.x + (px / length) * radius,
      y: destination.y,
      z: destination.z + (pz / length) * radius,
    }
  }

  private nearestDropEntity(itemName: string | null, origin: Vec3Json, maxDistance: number): Entity | null {
    let best: Entity | null = null
    let bestDistance = maxDistance
    for (const entity of Object.values(this.bot.entities)) {
      if (entity.name !== 'item' && entity.name !== 'Item' && entity.name !== 'item_stack') continue
      const dropped = this.droppedItemName(entity)
      if (itemName !== null && dropped !== null && dropped !== itemName) continue
      const position = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
      const d = distance(position, origin)
      if (d < bestDistance) {
        bestDistance = d
        best = entity
      }
    }
    return best
  }

  private nearestDropPosition(itemName: string | null, origin: Vec3Json, maxDistance: number): Vec3Json | null {
    const entity = this.nearestDropEntity(itemName, origin, maxDistance)
    if (entity === null) return null
    return { x: entity.position.x, y: entity.position.y, z: entity.position.z }
  }

  private droppedItemName(entity: Entity): string | null {
    try {
      const item = entity.getDroppedItem()
      return item === null ? null : item.name
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('executor', `could not decode dropped item on entity ${entity.id}: ${message}`)
      return null
    }
  }

  private buildResult(
    candidate: Candidate,
    epoch: number,
    startedAt: number,
    status: ExecutionResult['status'],
    phase: string,
    detail: string,
    failure: FailureCode | null,
    extra: Pick<ExecutionResult, 'verified' | 'blockRemoved' | 'dropObserved' | 'itemsGained' | 'goalItemCount'> & {
      progressed?: boolean
      distanceClosed?: boolean
    },
  ): ExecutionResult {
    return {
      actionId: candidate.id,
      kind: candidate.kind,
      targetName: candidate.targetName,
      epoch,
      status,
      phase,
      detail,
      failure,
      ms: Date.now() - startedAt,
      ...extra,
      progressed: extra.progressed ?? false,
    }
  }

  /**
   * #79: `done` is not success. When a runner returns `done` with an unmet
   * post-condition (`verified=false`) and zero observable change, the action is
   * downgraded to `failed` and tagged so the controller can log ACTION_UNVERIFIED
   * and charge the plan's unverified budget.
   */
  private applyPostcondition(candidate: Candidate, result: ExecutionResult): ExecutionResult {
    const unverified = isUnverifiedOutcome({
      kind: result.kind,
      status: result.status,
      verified: result.verified,
      itemsGained: result.itemsGained,
      blockRemoved: result.blockRemoved,
    })
    if (!unverified) return result
    const postcondition = describeActionPostcondition(result.kind)
    this.logger.warn(
      'executor',
      `ACTION_POSTCONDITION_UNMET actionId=${result.actionId} postcondition=${postcondition} detail=${result.detail}`,
      { actionId: result.actionId, kind: result.kind, postcondition, progressDelta: result.itemsGained },
    )
    return {
      ...result,
      status: 'failed',
      phase: 'unverified',
      failure: 'verify_failed',
      unverifiedPostcondition: postcondition,
    }
  }

  private currentBlockAt(position: Vec3Json): Block | null {
    return this.bot.blockAt(toVec3(this.bot, position))
  }

  private distanceToEyes(position: Vec3Json): number {
    const eye = this.bot.entity.position.offset(0, 1.62, 0)
    return distance(position, { x: eye.x, y: eye.y, z: eye.z })
  }

  private distanceToFeet(position: Vec3Json): number {
    const feet = this.bot.entity.position
    return distance(position, { x: feet.x, y: feet.y, z: feet.z })
  }

  private horizontalToFeet(position: Vec3Json): number {
    const feet = this.bot.entity.position
    return Math.hypot(position.x - feet.x, position.z - feet.z)
  }

  private countGoalItem(): number {
    return this.countItem(this.options.goalItem)
  }

  private countItem(name: string | null): number {
    if (name === null) return 0
    const id = this.itemId(name)
    return id === null ? 0 : this.bot.inventory.count(id, null)
  }

  private inventoryCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const item of this.bot.inventory.items()) {
      counts[item.name] = (counts[item.name] ?? 0) + item.count
    }
    return counts
  }

  private itemId(name: string): number | null {
    const registry = this.bot.registry as { itemsByName?: Record<string, { id?: number }> } | undefined
    const id = registry?.itemsByName?.[name]?.id
    return typeof id === 'number' ? id : null
  }

  private async equipTool(candidate: Candidate, epoch: number, signal: AbortSignal): Promise<void> {
    const toolName = candidate.toolName
    const blockName = readMetaString(candidate, 'digBlockName') ?? candidate.targetName ?? 'unknown'
    const reason =
      readMetaString(candidate, 'toolReason') ??
      (toolName === null ? 'hand_harvestable' : `${toolName}_required`)
    if (toolName !== null) {
      const tool = this.findTool(toolName, candidate.toolTier ?? null)
      if (tool === undefined) {
        this.logger.warn(
          'executor',
          `TOOL_CHOICE block=${blockName} tool=none reason=${reason}`,
          { actionId: candidate.id },
        )
        if (candidate.requiresTool) {
          throw new ExecutorError('dig_error', `no ${toolName} in the inventory`)
        }
      } else {
        await this.bot.equip(tool, 'hand')
        this.ensureOwned(epoch, signal)
      }
    }
    this.logger.info(
      'executor',
      `TOOL_CHOICE block=${blockName} tool=${toolLabel(toolName)} reason=${reason}`,
      { actionId: candidate.id, toolName, tier: candidate.toolTier ?? null },
    )
  }

  private findTool(toolName: 'pickaxe' | 'axe' | 'shovel', tier: number | null): Item | undefined {
    const tools = this.bot.inventory.items().filter((entry) => entry.name.endsWith(`_${toolName}`))
    if (toolName !== 'pickaxe' || tier === null || tier <= 0) return tools[0]
    return tools.find((entry) => (PICKAXE_RANKS[entry.name] ?? -1) >= tier)
  }

  /**
   * Re-resolve the dig tool from the live block (#7, option B). Candidate state
   * can be stale; the actual block in front of the bot is authoritative, so a
   * dirt cell can never inherit a pickaxe from an old resource-scan lookup.
   */
  private resolveLiveDigTool(block: { name: string; diggable: boolean }): ToolChoice {
    const harvest = resolveBlockHarvest(this.bot, block.name)
    const info: DigBlockInfo = {
      name: block.name,
      harvestTool: harvest.harvestTool,
      harvestTier: harvest.harvestTier,
      diggable: block.diggable,
    }
    return selectDigTool(info, (tool, tier) => this.findTool(tool, tier) !== undefined)
  }

  private findPlaceReference(target: Vec3Json): { block: Block; face: ReturnType<Bot['entity']['position']['clone']> } | null {
    const directions: Array<{ offset: Vec3Json; face: Vec3Json }> = [
      { offset: { x: 0, y: -1, z: 0 }, face: { x: 0, y: 1, z: 0 } },
      { offset: { x: 1, y: 0, z: 0 }, face: { x: -1, y: 0, z: 0 } },
      { offset: { x: -1, y: 0, z: 0 }, face: { x: 1, y: 0, z: 0 } },
      { offset: { x: 0, y: 0, z: 1 }, face: { x: 0, y: 0, z: -1 } },
      { offset: { x: 0, y: 0, z: -1 }, face: { x: 0, y: 0, z: 1 } },
      { offset: { x: 0, y: 1, z: 0 }, face: { x: 0, y: -1, z: 0 } },
    ]
    for (const direction of directions) {
      const block = this.currentBlockAt({
        x: target.x + direction.offset.x,
        y: target.y + direction.offset.y,
        z: target.z + direction.offset.z,
      })
      if (block === null || block.boundingBox !== 'block') continue
      const face = this.bot.entity.position.clone().set(direction.face.x, direction.face.y, direction.face.z)
      return { block, face }
    }
    return null
  }
}

function readMetaString(candidate: Candidate, key: string): string | null {
  const value = candidate.meta[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readMetaNumber(candidate: Candidate, key: string, fallback: number): number {
  const value = candidate.meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readMetaPoint(candidate: Candidate, xKey: string, yKey: string, zKey: string): Vec3Json | null {
  const x = candidate.meta[xKey]
  const y = candidate.meta[yKey]
  const z = candidate.meta[zKey]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
  return { x, y, z }
}

function toPathStatus(outcome: PathOutcome): PathStatus {
  if (outcome === 'reached') return 'success'
  if (outcome === 'noPath') return 'noPath'
  if (outcome === 'stuck') return 'stuck'
  if (outcome === 'timeout') return 'timeout'
  return 'idle'
}

function pathFailure(outcome: PathOutcome): FailureCode {
  if (outcome === 'noPath') return 'path_no_path'
  if (outcome === 'stuck') return 'path_stuck'
  if (outcome === 'cancelled') return 'cancelled'
  return 'path_timeout'
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
