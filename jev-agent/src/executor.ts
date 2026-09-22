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
import type { Bot, EquipmentDestination } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import type { Candidate, CandidateKind } from './candidates.ts'
import { digsBotSupport, formatDigDownRefused } from './candidates.ts'
import type { ActuationPort } from './actuationPort.ts'
import type { EventLogger } from './jev.ts'
import type { PathStatus, Vec3Json } from './state.ts'
import { bodySubmersion, formatBodySubmerged, isStandable, LOW_AIR_LEVEL, MAX_AIR, PICKAXE_RANKS, PROBE_FLUIDS, PROBE_HAZARDS, distance, isBreakableSolidBlock, isPassable, isUsableGroundSupport, probeBridgeDirection, resolveBlockHarvest, toVec3 } from './state.ts'
import {
  BRIDGE_BLOCK_META,
  BRIDGE_DIR_META,
  BRIDGE_MIN_ADVANCE,
  BRIDGE_PROBE_DEPTH,
  BRIDGE_SPAN_META,
  BRIDGE_STEP_CAP,
  bridgeDirOffset,
  formatBridgeEnd,
  formatBridgeRefused,
  formatBridgeStart,
  formatBridgeStep,
  isBridgeDir,
  isBridgeMove,
  planBridgeSpan,
} from './bridgeRoute.ts'
import type { BridgeDir, BridgeRefusal } from './bridgeRoute.ts'
import {
  declaredRoutePlaceBlocks,
  declaredRoutePlacements,
  formatRoutePlaceDeclared,
} from './routePlaceDeclaration.ts'
import type { BodySubmersion } from './state.ts'
import {
  classifyStepLanding,
  formatMoveLegStopped,
  STEP_SUPPORT_UNKNOWN,
} from './stepLanding.ts'
import type { StepLandingBlock, StepLandingReads } from './stepLanding.ts'
import { faceDistanceFromEye, interactionFaceDistance, INTERACTION_STAND_DY, INTERACTION_STAND_OFFSETS } from './reachability.ts'
import { selectDigTool, toolLabel } from './toolChoice.ts'
import type { DigBlockInfo, ToolChoice } from './toolChoice.ts'
import {
  correctDigSpeedMaterials,
  formatDigBudget,
  formatDigFailed,
  formatDigSpeedRepaired,
  planDigTime,
  runBoundedDig,
} from './digTruth.ts'
import type { DigMechanism, DigTimePlan } from './digTruth.ts'
import { craftAtTable } from './craftWindow.ts'
import type { CraftRecipeLike } from './craftWindow.ts'
import { isFuelItem } from './gameData.ts'
import {
  ARMOR_DESTINATION,
  ARMOR_SLOT_INDEX,
  bestWeaponOffer,
  bestWeaponOfferInClass,
  carriedWeaponClasses,
  formatArmorEquip,
  formatWeaponChoiceRequired,
  formatWeaponEquip,
  formatWeaponRefusal,
  holdsCarriedWeapon,
  weaponHoldAlternatives,
} from './gearPlan.ts'
import {
  classifyCombatOutcome,
  combatFailureCode,
  formatCombatOutcome,
  classifyContactApproach,
  formatContactUnreachable,
  HUNT_APPROACH_BUDGET,
} from './combatClosure.ts'
import type { CombatOutcome } from './combatClosure.ts'
import type { ArmorSlot } from './gearPlan.ts'
import { isProtectedStationBlock, PROTECTED_STATION_BLOCKS } from './blockSafety.ts'
import {
  containerItemStacks,
  containerRef,
  containerWindowStacks,
  findContainerStack,
  formatContainerEmpty,
  formatContainerOpen,
  formatContainerReady,
  formatContainerRefusal,
  formatContainerTransfer,
  isContainerBlockName,
  parseContainerRef,
  rollupContainerItems,
} from './containerAccess.ts'
import type { ContainerItemStack, ContainerObservation, ContainerRefusal, ContainerWindowStack } from './containerAccess.ts'
export { isProtectedStationBlock, PROTECTED_STATION_BLOCKS } from './blockSafety.ts'
import { formatFurnaceReady } from './placementGuard.ts'
import { isPlacePostconditionMet, isIgnitePostconditionMet, isSmeltPostconditionMet, isMinePostconditionMet, isMobHuntPostconditionMet, describeActionPostcondition, isUnverifiedOutcome, classifyActionOutcome } from './actionPostcondition.ts'
import {
  committedSkillKind,
  commitmentInvalidation,
  createSkillCommitment,
  declaredPostconditions,
  effectViolation,
  envelopeForCandidate,
  formatCommittedEnd,
  formatCommittedStep,
  formatSkillInvalidated,
  isPolicyBoundaryOutcome,
  skillOutcomeForFailure,
  skillTerminalReasonFor,
  targetIdentityKey,
  targetIdentityOf,
} from './skillCommitment.ts'
import type { SkillTerminalReason } from './jevSemanticProjection.ts'
// issue #436 / OPERATOR DIRECTIVE 2026-09-23: the WALK_TO family is ONE harness-layer
// Skill with a bounded closed loop (see `walkSkill.ts` for the measured symptom and
// the contract). The loop decision is pure and lives there; this file only drives it.
import {
  WALK_SKILL_MIN_PROGRESS,
  WALK_STRICT_ARRIVAL_RANGE,
  WALK_STRICT_ARRIVAL_TOLERANCE,
  walkStageBudgetMs,
  formatWalkBoundary,
  formatWalkLeg,
  formatWalkSkillStart,
  isWalkSkillKind,
  walkBoundaryAfterLeg,
  walkLegEvidence,
  walkSkillBudget,
  walkSkillIdFor,
  walkTargetOf,
} from './walkSkill.ts'
import type { WalkLegFailure, WalkSkillId, WalkStop } from './walkSkill.ts'
import type {
  Effect,
  EffectEnvelope,
  InventoryTransferSpec,
  SkillCommitment,
  SkillEndEvidence,
  SkillOutcome,
  StepAuthority,
} from './skillCommitment.ts'
import { FLINT_AND_STEEL, NETHER, NETHER_PORTAL, PORTAL_ENTER_SKILL, PORTAL_OPEN_FACE_LEVEL_TOLERANCE, PORTAL_OPEN_FACE_MAX_DISTANCE, PORTAL_WALK_IN_LEVEL_TOLERANCE, PRECONDITION_MISSING, formatPortalApproachLeg, formatPortalApproachRefused, formatPortalEntered, formatPortalEntryClimb, formatPortalEntryClimbRefused, formatPortalEntryRouteBlocked, formatPortalLit, formatPortalWalkIn, formatPortalWalkInRefused, formatReflex, formatSkillEnd, formatSkillInterrupt, formatSkillPolicyBoundary, formatSkillStart, formatSkillStep, formatSkillStepAuthority, normalizePortalDimension, parsePortalCells, portalOpenFaceCells, verifyPortal } from './netherPortalPlan.ts'
import type { PortalEntryClimbLeg } from './netherPortalPlan.ts'
import type { PortalApproachRefusal, PortalEntryRouteBlockedReason, PortalWalkInRefusal, SkillSelectionSource, SkillStepAuthority } from './netherPortalPlan.ts'
import {
  classifyHeadroomBlocker,
  evaluatePillarStep,
  evaluateTunnelEntry,
  formatAscentProgress,
  formatDescentChunk,
  formatLocalClear,
  formatPillarRefused,
  formatPillarRelocate,
  formatTunnelEntryRefused,
  headroomAcrossFootprint,
  planReuseLeg,
  resolvePillarStep,
  selectPlaceableBlock,
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
  PILLAR_PLACE_PRIORITY,
} from './pillarSearch.ts'
import type { PillarColumnProbe } from './pillarSearch.ts'
import {
  decidePillarFailureRecovery,
  formatPillarFail,
  formatPillarRetire,
  isPillarRefusalUnsatisfiable,
  pillarArcComplete,
  pillarStepUp,
  requiredColumnClearance,
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
  correctStandingOnGround,
  formatPillarUpStep,
  installClimbGroundCorrection,
  installGroundCorrection,
  PILLAR_TAKEOFF_BUDGET_MS,
  PILLAR_TAKEOFF_POLL_MS,
} from './pillarJump.ts'
import type { JumpBotLike, PillarJumpTrace, SolidAt } from './pillarJump.ts'
import { formatHopPlan, planVerticalHop } from './hopPolicy.ts'
import {
  OBSIDIAN,
  formatFrameBuildBlocked,
  formatFrameBuildIncomplete,
  formatFrameBuildUngrounded,
  formatPortalBlockPlaced,
  formatPortalFrameReady,
  partialPortalFrameLayout,
  portalFrameLayout,
  validatePortalFrame,
} from './netherPortalPlan.ts'

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
  | 'protected_station'
  | 'dig_error'
  | 'dig_timeout'
  | 'dig_no_tool'
  /**
   * issue #436 section 11: the exact selected item is not in the inventory. A
   * typed capability loss - never a silent substitute item.
   */
  | 'item_unavailable'
  | 'dig_down_refused'
  | 'craft_error'
  | 'place_error'
  | 'smelt_error'
  | 'smelt_timeout'
  | 'target_gone'
  | 'verify_failed'
  | 'pickup_failed'
  | 'frame_build_incomplete'
  | 'frame_build_ungrounded'
  | 'frame_build_blocked'
  /** the placement mechanism rejected: the server refused it / never answered */
  | 'place_refused'
  /**
   * SAFE: the body is out of breath, so the mechanical action stops
   */
  | 'submerged'
  /**
   * The per-step landing guard stopped the locomotion leg BEFORE the step: the
   * step's landing cell is a hazard (`hazard_between`) or has no real support
   * within the movement policy's own drop bound (`unsafe_landing`). Both are
   * typed refusals of the LEG, never a re-planned route: the body keeps standing
   * where it is and the decision returns to the policy (`stepLanding.ts`).
   */
  | 'hazard_between'
  | 'unsafe_landing'
  /** issue #436 section 5/27: the step was outside the commitment's effect envelope */
  | 'effect_envelope_violation'
  /** issue #436 section 14/23: the world this commitment was grounded in changed */
  | 'world_changed'
  /** issue #436 section 11: two or more strategically distinct carried weapons */
  | 'weapon_choice_required'
  /** issue #436 section 9: the committed entity left the tracked set, no death event */
  | 'target_despawned'
  /** issue #436 section 9: the committed entity exists but is no longer attackable */
  | 'target_invalidated'
  /** issue #436 section 9: a hard-safety interrupt preempted the combat commitment */
  | 'combat_interrupted'
  /** issue #436 section 9: the bounded combat lease expired with the target alive */
  | 'combat_timeout'
  /**
   * A container interaction failed on a measured fact: the cell no longer holds
   * a container, the container is occluded, the server never opened a window
   * inside the bound, the contents changed under us, or the destination
   * inventory could not take the transfer. Each carries its own
   * `CONTAINER_REFUSED reason=` marker, so the cause is never inferred from a
   * generic error string.
   */
  | 'container_error'
  | 'container_unreachable'
  | 'container_occluded'
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
  /** server `entityDead` event proved that an ATTACK target died during this lease */
  entityDefeated?: boolean
  /**
   * #391 hit evidence for an ATTACK lease: how many swings produced a
   * server-observed damage event on the target attributable to this lease.
   * `bot.attack()` calls are attempts; only this count is a hit.
   */
  attackHits?: number
  /**
   * #391: a server-observed hit/damage on the ATTACK target proved the lease
   * connected (an attributable `entityHurt`, or the target dying during the
   * lease). A non-hunt ATTACK is verified only on this evidence - never on the
   * number of swings issued.
   */
  damageObserved?: boolean
  /**
   * #391: health the target lost during the lease, when the entity exposes a
   * numeric health. 0 when unobservable (the 1.21 metadata carries no mob
   * health), so it is corroborating evidence and never the only hit proof.
   */
  targetHealthDelta?: number
  /**
   * Why a goal-directed hunt (`goalDrop` ATTACK) ended, and what the bounded
   * re-acquisition did. Set only on a hunt: an ordinary ATTACK has no producer
   * contract. `untracked`/`no_reacquire` name the teleport/despawn shape, so a
   * hunt that ends with nothing is never a silent end.
   */
  huntEnd?: HuntEndReason
  /** how many times the bounded hunt adopted another sensed producer of the same mob */
  huntReacquired?: number
  /** the target's last OBSERVED position during the hunt (the only bearing a teleport leaves) */
  huntLastKnown?: Vec3Json
  /**
   * issue #436 section 4/17: the identity of the SkillCommitment this result
   * belongs to, so the outcome joins to the selection that authorized it.
   */
  commitmentId?: string
  /** issue #436 section 9: the honest combat outcome of an ATTACK commitment. */
  combatOutcome?: CombatOutcome
  /**
   * issue #436 section 9: for a `HUNT_DROP`, whether the declared drop actually
   * reached the inventory (verified delta). False is NOT a kill failure - it says
   * the collect half of the postcondition is unmet.
   */
  dropAcquired?: boolean
  /** issue #436 section 6: the typed lifecycle outcome of the commitment. */
  skillOutcome?: SkillOutcome
  /**
   * issue #437 section 2: the §2 terminal reason of that outcome, so the packet
   * builder maps the commitment outcome through ONE pure function.
   */
  skillTerminalReason?: SkillTerminalReason
  /** the committed `CausalTargetIdentity` key (the packet's target identity). */
  skillTargetIdentityKey?: string
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
  /**
   * issue #436 section 4: the first-class SkillCommitment this action realizes.
   * Persisted for the whole action lifetime and carried into the evidence.
   */
  commitment?: SkillCommitment
}

export interface ClaimResult {
  /** true when the same action is already running and ownership was retained */
  kept: boolean
  epoch: number
  completion: Promise<ExecutionResult>
}

/**
 * ONE bounded mechanical leg of a committed locomotion Skill (issue #436 section
 * 3): the result the leg would have settled the action with before the harness
 * layer owned the loop, plus whether THIS leg verified the committed arrival.
 * `Executor#runWalkSkill` - not the controller - decides whether it continues.
 */
export interface WalkLegExecution {
  /** the committed postcondition (arrival predicate) was verified by this leg */
  arrived: boolean
  /** the settled result of this leg (used verbatim when `arrived`) */
  result: ExecutionResult
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
  /**
   * Bounded wait for a container window (see `CONTAINER_OPEN_TIMEOUT_MS`).
   * Optional so a fixture can shorten it; the bound is never unbounded.
   */
  containerOpenTimeoutMs?: number
  goalItem: string
  /**
   * Bounded window for the dimension transfer: walk into the lit portal and
   * wait for the server-side dimension change. A transfer that does not appear
   * within it is a hard `verify_failed`, never a silent success.
   */
  portalEnterTimeoutMs?: number
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
  /**
   * Bounded re-acquisition window for a goal-directed hunt (see
   * `HUNT_REACQUIRE_MS`). Optional so a fixture can shorten it; the hunt lease
   * itself still bounds the closed loop.
   */
  huntReacquireMs?: number
  /**
   * RETIRED (issue #436 section 9): the mob-name re-acquisition radius. A hunt no
   * longer adopts another instance of the mob, so nothing reads this. Kept so an
   * existing fixture that passes it does not break.
   */
  huntReacquireRadius?: number
  /**
   * issue #436 section 5/27 fixture hook: replace the derived effect envelope so
   * a fixture can prove a step outside the declared envelope FAILS CLOSED. Never
   * set in production; production envelopes come from the selected candidate.
   */
  effectEnvelopeOverride?: EffectEnvelope
  /**
   * issue #436 section 14/23: the LIVE world epoch, injected by the host layer
   * that owns it. When absent (standalone/fixture) only the observable dimension
   * is revalidated; the lease itself is owned by the HOST and reaches this class
   * through the action epoch (`ensureOwned`) exactly as before.
   */
  observedWorldEpoch?: () => number
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
/**
 * Bounded window to walk into a lit portal and observe the server-side
 * dimension change. Long enough for a short approach + the respawn round trip,
 * short enough that a portal which never transfers fails loud.
 */
const PORTAL_ENTER_TIMEOUT_MS = 8000
/**
 * Bounded DIRECT WALK into a portal interior cell (`walkIntoPortalEntry`): the
 * stock actuator moves only when one of its physics simulations confirms the
 * next node, and all of them refuse a non-solid cell one block up beside the
 * body (measured `path_stuck` with zero movement), so the entry owns ONE
 * control-walk of its own.
 *
 * `<= 3` horizontal blocks is "beside the gate"; one whole block of level
 * difference is the frame threshold the body must step onto; the body's own
 * horizontal position within 0.5 of the cell centre is IN the interior.
 */
const PORTAL_WALK_IN_MAX_DISTANCE = 3
const PORTAL_WALK_IN_INSIDE_RADIUS = 0.5
/** Hard time budget and distance-progress check: the walk can never spin. */
const PORTAL_WALK_IN_BUDGET_MS = 2500
const PORTAL_WALK_IN_NO_PROGRESS_MS = 800
const PORTAL_WALK_IN_MIN_PROGRESS = 0.05
/** One forward-push tick of the direct walk (the control-walk recipe's cadence). */
const PORTAL_WALK_IN_STEP_MS = 45
/**
 * The bounded step-aside leg onto an OPEN face of the portal (`stepOntoPortalFace`):
 * when a frame column sits between the body and the interior, the straight walk
 * can never get in (measured live: the body pinned at 24.7,67,9.7 behind the
 * left frame column at (25,67,9) while the operator watched it refuse to step
 * one block aside). Each face candidate gets a hard budget, and at most two are
 * tried before the ordinary typed failure.
 */
const PORTAL_FACE_LEG_BUDGET_MS = 1200
/** One class, several equivalent faces: at most two attempts, each bounded. */
const PORTAL_FACE_LEG_MAX_ATTEMPTS = 2
/**
 * The composed entry climb (`runEntryRouteLeg`): at most TWO bounded legs - the
 * candidate's primary grounded vertical plan and the second plan of the SAME
 * contract (`fallbackVertical`, e.g. the own-column pillar behind a remembered
 * tunnel). One commitment owns both, exactly like the face leg's two attempts:
 * a third leg is a re-decision, not a continuation.
 */
const ENTRY_CLIMB_LEG_MAX = 2
/** One forward-push tick of the face leg, and its livelock bound. */
const PORTAL_FACE_LEG_STEP_MS = 45
const PORTAL_FACE_LEG_NO_PROGRESS_MS = 600
/**
 * The entry Skill's DECLARED effect envelope (issue #436 §5/U4). A plain entry is
 * LOCOMOTION ONLY: the skill may move, look, jump and sprint; it may NOT dig,
 * place, equip or use a station - so a wall that appears between the body and the
 * gate can never grant it dig/place authority, and any remedy outside that
 * envelope (mine the blocker, pillar, bridge) is a semantic recovery that must go
 * back to Jev as a `SKILL_POLICY_BOUNDARY` alternative.
 *
 * The declaration must be the TRUTH about the legs THIS entry was grounded with,
 * so it is derived from the candidate's own route contract rather than being a
 * fixed string: an entry whose grounded route places blocks (a PILLAR climb -
 * exactly what the operator's floated gate needs) DECLARES the consumed block,
 * and one whose route digs declares the dig. The live run (run.jsonl
 * 2026-09-22T15:47:20Z) emitted `ROUTE_PLACE_DECLARED actionId=ENTER:27,67,9
 * skill=ENTER_PORTAL blocks=cobblestone source=fallbackPillarPlaceName` while the
 * Skill's own start line still claimed `movement-only(no_dig,no_place)` - a
 * declaration that contradicted the leg the commitment was about to run.
 *
 * The TYPED `EffectEnvelope` and the `SKILL_COMMIT ... effectEnvelopeHash=` line
 * are owned by `skillCommitment.ts`: this skill states the same fact in the
 * Phase-1 vocabulary (the `envelope=` field of its own start/step lines) instead
 * of forking a second commitment formatter. The AUTHORITY is unchanged either
 * way: the typed envelope already derives `mayDigGroundedRoute` /
 * `mayPlaceGroundedRoute` from these same meta keys (`skillCommitment.ts`), so a
 * plain entry still gets neither.
 */
function portalEntryEffectEnvelope(candidate: Candidate): string {
  const vertical = readMetaString(candidate, 'vertical') ?? 'none'
  const fallback = readMetaString(candidate, 'fallbackVertical') ?? 'none'
  const digRoute = candidate.meta.digRoute === true
  if (vertical === 'none' && fallback === 'none' && !digRoute) return 'movement-only(no_dig,no_place)'
  const place = declaredRoutePlaceBlocks(candidate)
  const digs =
    vertical === 'staircase' || vertical === 'staircase-up' || candidate.meta.digStep === true || digRoute
  return `movement+route(dig=${digs ? 'grounded_route' : 'none'},place=${place.length > 0 ? place.join('|') : 'none'})`
}
/** The entry Skill's declared postcondition identity (stable, code-owned). */
const PORTAL_ENTER_POSTCONDITION = 'portal_entered:dimension=minecraft:the_nether'

/**
 * Non-solid cells a body may walk INTO. The same shape covers every portal-like
 * traversal target, so the direct walk is not nether-specific.
 */
const PORTAL_WALK_IN_CELLS = new Set([NETHER_PORTAL, 'end_portal', 'end_gateway'])
/** A server/client inventory update can lag the equip transaction by a tick. */
const PLACE_EQUIP_RETRIES = 4
const PLACE_EQUIP_SETTLE_MS = 50

/**
 * The bounded wait for a container window. Mineflayer's `openBlock` is
 * `activateBlock` + `once('windowOpen')` with NO validation at all
 * (node_modules/mineflayer/lib/plugins/inventory.js:405-410): too far, occluded,
 * no line of sight, block gone and no permission are ALL the same event - a
 * window that never opens, surfacing 20 s later as
 * `Event windowOpen did not fire within timeout of 20000ms`. A 20 s wedge per
 * attempt is not a diagnostic; this bound names the fact
 * (`CONTAINER_REFUSED reason=open_timeout`) and lets the policy re-target.
 */
const CONTAINER_OPEN_TIMEOUT_MS = 4000

/** Upper bound on the per-stack transfer steps one withdraw may take. */
const CONTAINER_TRANSFER_STACK_LIMIT = 64

/**
 * The container window a container interaction consumes, in the REAL
 * mineflayer shape (`prismarine-windows` Window + `extendWindow`): the
 * container's own slots plus the numeric-item-id `withdraw`. Narrow on purpose,
 * like `SmeltFurnaceWindow`, so a fixture drives the real Executor with a
 * structural double and never a live window.
 */
export interface ContainerWindowHandle {
  /** the container's OWN slots right now (never the player-inventory half) */
  containerItems(): readonly ContainerWindowStack[]
  /** move up to `count` of `itemName` out of the container into the inventory */
  withdraw(itemName: string, count: number): Promise<unknown>
  close(): void
}

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

function portalCellKey(cell: Vec3Json): string {
  return `${cell.x}|${cell.y}|${cell.z}`
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

/**
 * How far ahead one locomotion STEP looks for its landing cell (blocks): one
 * cell along the travel heading, so the guard reads the column the body is about
 * to enter and never the one it already stands in.
 */
const MOVE_STEP_PROBE_DISTANCE = 1
/**
 * The bounded window the per-step landing guard reads UNDER the landing cell.
 * The live bound is the movement policy's own `maxDropDown` (8, pinned in
 * `ensureMovements`), so the guard can never refuse a drop the `canDig=false`
 * planner itself would have planned; these are only the fallback/clamp used when
 * the plugin's movements are unreadable, so a hostile value cannot turn one step
 * into a world scan.
 */
const MOVE_STEP_LANDING_WINDOW_DEFAULT = 8
const MOVE_STEP_LANDING_WINDOW_MAX = 16

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

/** Read-only world probe the interaction-stand search needs (never a side effect). */
export interface InteractionStandProbe {
  passable(x: number, y: number, z: number): boolean
  solidSupport(x: number, y: number, z: number): boolean
}

export { interactionFaceDistance }

function standDistanceFromFeet(stand: Vec3Json, feet: Vec3Json): number {
  return Math.hypot(stand.x + 0.5 - feet.x, stand.z + 0.5 - feet.z)
}

/**
 * The valid interaction stands for `block`: each of the four horizontal
 * neighbours at the block's level, one above and one below, whose feet+head
 * cells are passable, which rests on solid support, and from whose eye position
 * the block's own AABB face is within `reach`. Ordered nearest-first from
 * `feet`, so a bot that already stands on a valid cell gets it as candidate[0].
 *
 * This is the generic station-approach geometry. Live RC9 evidence
 * (`craftAtTable` at CRAFT:stone_pickaxe, table `-50,79,-7`, bot below/offset):
 * a bot that is merely below or offset from a station has NO candidate here, so
 * the executor must establish a real stand - or fail loud - before it opens a
 * window, instead of calling `openBlock` blindly with no face.
 */
export function interactionStandCandidates(
  block: Vec3Json,
  feet: Vec3Json,
  probe: InteractionStandProbe,
  reach: number,
): Vec3Json[] {
  const candidates: Vec3Json[] = []
  for (const offset of INTERACTION_STAND_OFFSETS) {
    for (const dy of INTERACTION_STAND_DY) {
      const spot = { x: block.x + offset.x, y: block.y + dy, z: block.z + offset.z }
      if (!probe.passable(spot.x, spot.y, spot.z)) continue
      if (!probe.passable(spot.x, spot.y + 1, spot.z)) continue
      if (!probe.solidSupport(spot.x, spot.y - 1, spot.z)) continue
      if (interactionFaceDistance(spot, block) > reach) continue
      candidates.push(spot)
    }
  }
  candidates.sort((a, b) => standDistanceFromFeet(a, feet) - standDistanceFromFeet(b, feet))
  return candidates
}

/**
 * The geometric face of `block` a body at `from` interacts with, as the outward
 * face normal (the `block_place` direction the server validates):
 *  - `from` at/above the block's top → the top face `(0,1,0)`;
 *  - otherwise the horizontal side the body is on (dominant axis).
 *
 * Live RC9: `openBlock(table)` was called with no direction while the bot was
 * below/offset, so the server rejected the interaction and the 20 s open timed
 * out. The face is derived from where the body actually stands, never hardcoded.
 */
export function deriveInteractionFace(from: Vec3Json, block: Vec3Json): Vec3Json {
  if (from.y - block.y >= 1) return { x: 0, y: 1, z: 0 }
  const dx = from.x - block.x
  const dz = from.z - block.z
  if (Math.abs(dx) >= Math.abs(dz)) return { x: dx >= 0 ? 1 : -1, y: 0, z: 0 }
  return { x: 0, y: 0, z: dz >= 0 ? 1 : -1 }
}

/**
 * The observability marker for a dig whose stale `onGround` flag was corrected
 * from the block grid. prismarine-block divides the break speed by 5 while
 * `entity.onGround` is false, and this Leaf server ships no 26.1 collision
 * shapes, so prismarine-physics reports `onGround=false` while a solid block is
 * underfoot (the same parity quirk `pillarUp` diagnoses). The outgoing position
 * packet then carries `onGround=false`, the server applies the vanilla airborne
 * /5 penalty, and a block whose grounded break time is close to `digTimeoutMs`
 * never lands before the executor aborts it. Live (source 6a7fccd, m3-live):
 * the body reached the verified obsidian at (26,66,9) and every
 * `MINE:b26_66_9` died as `dig timed out after 15000ms` (verified=false,
 * progressDelta=0) until the resident hit `FATAL code=MODEL_UNAVAILABLE`.
 * Obsidian is ~9.4s grounded but ~46.9s airborne, so the corrected dig is the
 * difference between MINE succeeding and the loop that produced this marker.
 */
export function formatDigGroundCorrected(block: { name: string; position: Vec3Json }): string {
  const { x, y, z } = block.position
  return `DIG_GROUND_CORRECTED block=${block.name} at=${Math.round(x)},${Math.round(y)},${Math.round(z)}`
}

/**
 * Run a dig with the block-grid ground correction installed for its whole
 * duration, so the body state mineflayer's `digTime` reads and the body state
 * the outgoing position packet advertises both agree with the world. This is
 * the break-speed half of the same `onGround` parity quirk the pillar path
 * corrects for its jump gate; without it a grounded obsidian dig is priced as
 * airborne (~46.9s vs ~9.4s) and the executor's budget aborts it. The
 * correction is grounded in the block grid: with no solid footing it declines,
 * so a genuinely airborne dig keeps its real cost. `onCorrected` fires at most
 * once, only when the stale flag was actually flipped.
 */
export async function withDigGroundCorrection<T>(
  bot: JumpBotLike,
  isSolid: SolidAt,
  dig: () => Promise<T>,
  onCorrected?: () => void,
): Promise<T> {
  let reported = false
  const report = (grounded: boolean, before: boolean, after: boolean): void => {
    if (reported || !grounded || before === true || after !== true) return
    reported = true
    onCorrected?.()
  }
  const uninstall = installGroundCorrection(bot, isSolid, undefined, (_event, grounded, before, after) => {
    report(grounded, before, after)
  })
  // Ground synchronously too: `bot.dig` reads `digTime` before the first
  // physicsTick listener can run.
  if (bot.entity.onGround !== true) {
    const before = bot.entity.onGround
    report(correctStandingOnGround(bot, isSolid), before, bot.entity.onGround)
  }
  try {
    return await dig()
  } finally {
    uninstall()
  }
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

/**
 * A vertical waypoint is not reached merely because the body is horizontally
 * close to it.  The live M2 run reached the same x/z column one block above a
 * staircase waypoint, then treated the no-op as a completed step and retried
 * the distant resource forever.  Keep this predicate aligned with the
 * `requireLevel` arrival branch in `walkByControls` so callers can verify the
 * postcondition after any pathfinder fallback.
 */
export function isAtRequiredLevel(
  position: { x: number; y: number; z: number },
  target: Vec3Json,
  horizontalTolerance = 1.2,
  verticalTolerance = 0.75,
): boolean {
  const sameFloorLevel = Math.floor(position.y) === Math.floor(target.y)
  // A same-floor neighbor is not the requested step.  The old distance-only
  // check accepted a body one cell short (for example x=54.5 for target x=55)
  // because it was within the 1.2m tolerance.  That let a failed path fallback
  // report a DESCEND step as complete immediately after digging, without any
  // body progress.  Keep the tolerance for positions inside the target cell,
  // but require occupancy of the target x/z cell first.
  const sameTargetCell =
    Math.floor(position.x) === Math.floor(target.x) && Math.floor(position.z) === Math.floor(target.z)
  return (
    sameTargetCell &&
    Math.hypot(position.x - target.x, position.z - target.z) <= horizontalTolerance &&
    (sameFloorLevel || Math.abs(position.y - target.y) <= verticalTolerance)
  )
}

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

/**
 * Far-navigation leg constants (#352).
 *
 * A direct path to a target beyond `LEG_TRAVEL_MIN_DISTANCE` is routinely
 * refused: the exact destination cell may be enclosed/lava-adjacent while its
 * NEIGHBOURHOOD is reachable. Live (source `bd2485d`, resident `m3-live`) the M2
 * `RETRIEVE:known:obsidian:b28_67_9` was chosen every tick from
 * (195.6, 68, -14.5) with all seven remembered obsidian cells 169-172 m away,
 * `no_path` was recorded, the coordinate was blacklisted and the body never
 * moved (`obsidian=0`). This radius matches `FAR_LEG_PROBE_RADIUS` in
 * `candidates.ts`, where a `no_path` probe beyond it is already not treated as a
 * local blockage; within the radius the direct arrival path remains the honest
 * plan.
 */
export const LEG_TRAVEL_MIN_DISTANCE = 24

/**
 * `GoalNear` radius of one committed leg. The leg trades the (possibly
 * unreachable) exact destination for the target's reachable neighbourhood, so
 * the pathfinder can return a route and the body actually closes distance; the
 * next decision then re-plans from the new position.
 */
export const LEG_TRAVEL_RADIUS = 16

/**
 * A leg is positional progress only when the body closes at least this much
 * feet-distance to the final target. The live M2 leg measured ~24 m and ~49 m
 * per tick, so 4 m keeps the noisy sub-metre creeps out of the progress claim.
 */
export const LEG_TRAVEL_MIN_PROGRESS = 4

export interface TravelLegDecision {
  /** the remaining distance was beyond `LEG_TRAVEL_MIN_DISTANCE`, so a leg was warranted */
  warranted: boolean
  /** the BODY position closed at least `LEG_TRAVEL_MIN_PROGRESS` toward the target */
  progressed: boolean
  /** `remainingBefore - remainingAfter`; positive means the body closed distance */
  delta: number
  /** feet-distance to the final target after the leg */
  remaining: number
}

/**
 * Classify one committed travel leg from the BODY positions, never from the fact
 * that a path was attempted: `remainingAfter` must be measured from
 * `bot.entity.position` after the leg. A leg is positional progress only when
 * the remaining feet-distance shrank by `minProgress`. It is **never arrival**:
 * callers keep the final "target reached" post-condition separate from "leg
 * walked", so a successful leg leaves the goal open for the next decision.
 */
export function classifyTravelLeg(input: {
  remainingBefore: number
  remainingAfter: number
  minDistance?: number
  minProgress?: number
}): TravelLegDecision {
  const minDistance = input.minDistance ?? LEG_TRAVEL_MIN_DISTANCE
  const minProgress = input.minProgress ?? LEG_TRAVEL_MIN_PROGRESS
  const delta = input.remainingBefore - input.remainingAfter
  const warranted = input.remainingBefore > minDistance
  return { warranted, progressed: warranted && delta >= minProgress, delta, remaining: input.remainingAfter }
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

/**
 * A pillar leg is a bounded vertical mechanics operation.  If it placed no
 * block and the body's floor never left the launch floor, continuing into a
 * horizontal approach only hides the failed climb and causes the same jump
 * to be replayed on the next decision.  A partial, durable floor change is
 * still allowed to return as progress.
 */
export function shouldAbortUnproductivePillar(input: {
  vertical: string
  verticalStep: boolean
  startY: number
  currentY: number
  targetY: number
}): boolean {
  return (
    input.vertical === 'pillar' &&
    !input.verticalStep &&
    input.targetY > input.startY + 0.5 &&
    Math.floor(input.currentY) <= Math.floor(input.startY)
  )
}

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker'])

/**
 * ATTACK is a Jev-selected intent, not a one-packet action.  The executor may
 * close the mechanically-required gap and deliver several cooldown-spaced
 * swings while that intent owns the actuation lease.  Target/mode selection
 * remains in the candidate and therefore in Jev; this is only the melee
 * mechanics envelope.
 */
export const MELEE_ATTACK_RANGE = 3.1
export const ATTACK_LEASE_MS = 2_200
/** Goal-directed mob hunts are bounded Skills long enough to defeat an enderman. */
export const GOAL_HUNT_LEASE_MS = 10_000
export const ATTACK_COOLDOWN_MS = 500

/**
 * Bounded RE-ACQUISITION for a goal-directed hunt (`goalDrop` ATTACK).
 *
 * Measured live (run-muc3qbug-18vg3 lineage, 2026-09-21T17:07-17:08,
 * `ATTACK:e1758` an enderman): the sensor offered the producer, Jev chose the
 * hunt, and the lease ended after 1.0-2.0 s with ZERO swings because the target
 * had already left `bot.entities` - the enderman teleported out of tracking
 * range between the decision and the first swing. The lease was restarted five
 * times and never re-acquired: the mob the hunt had chosen was gone, so the
 * skill ended `failed/out_of_reach` with nothing, and the next tick had to
 * notice a *new* enderman from scratch.
 *
 * This is the mechanical loop that was missing. Within the SAME bounded lease
 * the executor now:
 *
 *   1. adopts another SENSED entity of the SAME `targetName` when the chosen
 *      target is no longer tracked (or has moved outside the local action
 *      envelope) - the semantic action ("hunt <mob> for <item>") is unchanged,
 *      so this stays mechanics, not a second WHICH;
 *   2. otherwise re-approaches the target's LAST OBSERVED position for a bounded
 *      window and keeps re-scanning there, which is the only grounded bearing a
 *      teleporting mob leaves behind.
 *
 * Both steps happen INSIDE `GOAL_HUNT_LEASE_MS`, so the closed loop is bounded
 * by construction. Only ever the SAME mob name is adopted: code never widens
 * the hunt to a different producer.
 */
export const HUNT_REACQUIRE_MS = 2_500
/**
 * RETIRED NAME (issue #436 section 9). The radius now lives in
 * `combatClosure.ts` as `HUNT_APPROACH_BUDGET`, where the candidate layer reads it
 * as the hunt's reachability contract. Kept as an alias so an existing import
 * cannot silently change meaning.
 */
export const HUNT_REACQUIRE_RADIUS = HUNT_APPROACH_BUDGET
/** Re-scan / re-approach poll period. */
export const HUNT_REACQUIRE_POLL_MS = 150
/**
 * How long the body may stop closing distance to a still-tracked target before
 * the follow goal is re-issued. A stock `GoalFollow` that hit `path_reset stuck`
 * otherwise leaves the body standing while the distance never changes.
 */
export const HUNT_FOLLOW_STALL_MS = 1_500

/**
 * Why a goal-directed hunt ended. Typed and honest, and aligned with the §9
 * combat outcome vocabulary (`combatClosure.ts`): "the target teleported" is NOT
 * observable, so `untracked` is the fact (the committed entity left the client's
 * tracked set - teleport out of range, despawn or chunk unload) and
 * `target_lost` says the bounded SAME-IDENTITY re-acquire could not restore it.
 * Neither is ever a kill.
 */
export type HuntEndReason =
  /** the server `entityDead` event proved the committed entity died */
  | 'killed'
  /** the committed id left the tracked entity set with no death event */
  | 'untracked'
  /** the committed id vanished and the bounded same-identity re-acquire failed */
  | 'target_lost'
  /** the committed id stayed tracked but never entered melee range inside the lease */
  | 'out_of_range'
  /**
   * The committed id stayed tracked and alive and the PROVEN geometry puts it out
   * of melee reach: it is more than `MELEE_ATTACK_RANGE` above the body, and a walk
   * cannot change the body's level, so no horizontal position a walk can occupy
   * brings the melee envelope onto it.
   *
   * Measured shape this names: 9 of the 17 live blaze hunts started at lease
   * gapY >= 4 (values 4,4,4,4,9,9,9,9,5) - the fortress ledges at y=60-69 against
   * the body's y=57-58 - and every one of them ended `out_of_range swings=0 hits=0`
   * after burning the full `GOAL_HUNT_LEASE_MS`. A target the body provably cannot
   * reach is now a different run-scoped fact from one it merely failed to arrive
   * at (`out_of_range`, whose pinned meaning is unchanged).
   */
  | 'unreachable'
  /** swings landed, the committed id survived, and the bounded lease ran out */
  | 'lease_expired'

/** The exact `HUNT_END reason=...` line for one bounded hunt. */
export function formatHuntEnd(input: {
  actionId: string
  targetName: string | null
  goalDrop: string
  reason: HuntEndReason
  swings: number
  hits: number
  reacquired: number
  lastKnown: Vec3Json
  ms: number
}): string {
  return (
    `HUNT_END reason=${input.reason} actionId=${input.actionId} target=${input.targetName ?? 'unknown'} ` +
    `for=${input.goalDrop} swings=${input.swings} hits=${input.hits} reacquired=${input.reacquired} ` +
    `lastKnown=${input.lastKnown.x},${input.lastKnown.y},${input.lastKnown.z} ms=${input.ms}`
  )
}

/** The exact `HUNT_TARGET_LOST ...` line when the bounded re-acquisition is exhausted. */
export function formatHuntTargetLost(input: {
  actionId: string
  targetName: string | null
  goalDrop: string
  entityId: number
  swings: number
  hits: number
  /** how many replacements were actually ADOPTED (attempts are the `polls=` field of HUNT_REACQUIRE_EXHAUSTED) */
  reacquired: number
  lastKnown: Vec3Json
}): string {
  return (
    `HUNT_TARGET_LOST actionId=${input.actionId} entity=e${input.entityId} target=${input.targetName ?? 'unknown'} ` +
    `for=${input.goalDrop} swings=${input.swings} hits=${input.hits} reacquired=${input.reacquired} ` +
    `lastKnown=${input.lastKnown.x},${input.lastKnown.y},${input.lastKnown.z} -> typed non-completion, not a silent end`
  )
}

/**
 * #391: how a swung lease proves it CONNECTED. Issuing `bot.attack()` is an
 * execution attempt, not a hit. The evidence is a server-observed damage event
 * on the target entity (`entityHurt`):
 *
 *   - the 1.20+ `damage_event` packet carries the causing entity, so a hurt
 *     whose source is this body is direct attribution, whatever the timing;
 *   - a server/version that only broadcasts the hurt animation carries no
 *     source, so the hurt is accepted only inside this short window after one
 *     of our swings. Fail closed: a real hit delayed beyond the window is
 *     reported as `no-hit`, never the reverse.
 *
 * A hurt attributed to anything else belongs to that other attacker. The
 * target's own death during the lease (`entityDead`) is terminal evidence that
 * a hit landed, and is kept as a separate typed field.
 */
export const ATTACK_HIT_CORRELATION_MS = 250

/** Mob health is not in the 1.21 entity metadata; only read it when exposed. */
function readEntityHealth(entity: { health?: unknown } | undefined): number | null {
  const health = entity?.health
  return typeof health === 'number' && Number.isFinite(health) ? health : null
}

/**
 * Stations are durable world resources, not route terrain. A route-opening or
 * staircase action may dig the live block at its selected cell, so the final
 * dig boundary rejects stations even if an earlier sensor snapshot classified
 * that cell as generic terrain. There is no semantic station-removal
 * candidate; this is a hard world-preservation invariant, not a policy rank.
 */
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
  /**
   * issue #436 section 5: the executor's effect-envelope check, injected because
   * this runner is a free function. Every GUI slot transfer/collection goes
   * through it, so a smelt step outside the selected recipe/station fails closed.
   */
  assertEffect?(effect: Effect): void
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
 * The `CONTAINER_READY source=placed` line a verified container placement must
 * emit, or null when nothing was proven. Mirrors `placedStationReadyLine`: a
 * shulker box (or chest/barrel) the body placed must be a durable world fact, so
 * re-visiting the cell OPENS the container standing there instead of re-planning
 * a placement of an item that is no longer in the inventory. Gated by the same
 * strict placement post-condition, so an unverified/failed placement never
 * records a container.
 */
export function placedContainerReadyLine(itemName: string, placedName: string | null, at: Vec3Json): string | null {
  if (!isContainerBlockName(itemName)) return null
  if (!isPlacePostconditionMet(placedName, itemName)) return null
  return formatContainerReady(itemName, at)
}

/** The items whose verified per-cell placement is a nether-portal frame block. */
export const FRAME_PLACE_ITEMS: ReadonlySet<string> = new Set([OBSIDIAN])

/**
 * The durable per-cell marker for a verified frame placement, or null when the
 * REAL placement post-condition is unmet. Mirrors `placedStationReadyLine`: an
 * unverified/failed placement never records a frame cell.
 */
export function placedFrameCellLine(itemName: string, placedName: string | null, at: Vec3Json): string | null {
  if (!FRAME_PLACE_ITEMS.has(itemName)) return null
  if (!isPlacePostconditionMet(placedName, itemName)) return null
  return formatPortalBlockPlaced(at)
}

/** The frame-ready marker, or null when `validatePortalFrame` rejects the cells. */
export function frameReadyLine(cells: readonly Vec3Json[], widthAxis: 'x' | 'z' = 'x'): string | null {
  const validation = validatePortalFrame({ blocks: [...cells], widthAxis })
  return validation.shape === 'ok' ? formatPortalFrameReady(validation) : null
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
        deps.assertEffect?.({
          type: 'transfer',
          itemName: params.inputItem,
          count: inputToPlace,
          container: 'furnace_input',
        })
        await furnace.putInput(input!.type, null, inputToPlace)
        inputTransferred = true
      }
      if (fuelToPlace > 0) {
        deps.assertEffect?.({
          type: 'transfer',
          itemName: params.fuelItem,
          count: fuelToPlace,
          container: 'furnace_fuel',
        })
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
        deps.assertEffect?.({ type: 'transfer', itemName: params.outputItem, count: null, container: 'furnace_output' })
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
        deps.assertEffect?.({ type: 'transfer', itemName: params.outputItem, count: null, container: 'furnace_output' })
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
/** What one bounded direct walk into the portal interior did, and why not. */
interface PortalWalkInOutcome {
  attempted: boolean
  inside: boolean
  transferred: boolean
  fromD: number
  toD: number
  refusal: PortalWalkInRefusal | null
}

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
  /** issue #436 section 4: the commitment of the running action, or null */
  private activeCommitment: SkillCommitment | null = null
  /**
   * issue #436 section 17: mechanical-step evidence is aggregated per step kind,
   * so a walk that toggles controls every physics tick cannot flood the log while
   * still proving that code performed mechanical continuation.
   */
  private stepLog = new Map<string, { count: number; lastEmitMs: number }>()
  private pathStatus: PathStatus = 'idle'
  /** the last dig's mechanism schedule/budget, for the typed `DIG_FAILED` marker */
  private lastDigPlan: DigTimePlan | null = null
  private digStartedAt = 0
  /**
   * Why the last executed vertical leg produced no durable step
   * (`no_rise`/`apex_missed`/`no_footing`/`unsafe_column`/`dig_no_tool`/...).
   * Naming the obstruction lets the entry route fail with a typed detail
   * instead of a generic path error. Cleared whenever a vertical contract runs.
   */
  private lastVerticalFailureReason: string | null = null
  /**
   * What an OPEN action OBSERVED inside a container, keyed by the truthful
   * `name@x,y,z` reference. A container with no entry here is UNKNOWN, never
   * EMPTY: the client cannot read a container before a window is open, so the
   * absence of an observation is the absence of knowledge. Cleared with the
   * Executor instance (a new generation re-observes; it never inherits a claim).
   */
  private readonly containerObservations = new Map<string, ContainerObservation>()
  /** Dedupe for the mirrored typed container refusals (one line per distinct fact). */
  private readonly containerRefusalLogged = new Set<string>()

  constructor(bot: Bot, logger: EventLogger, options: ExecutorOptions = defaultExecutorOptions) {
    this.bot = bot
    this.logger = logger
    this.options = options
    // The dig mechanism reads its break speed from `registry.materials`. On 1.21
    // the `incorrect_for_wooden_tool` entries name only the wooden tools, so the
    // client prices obsidian at 75000ms instead of 9375ms and every dig is
    // cancelled by the (now schedule-derived) budget. Repair the data once per
    // Executor; the marker makes the repair visible in the mirrored log.
    const repaired = correctDigSpeedMaterials(this.bot.registry)
    if (repaired > 0) {
      this.logger.info('executor', formatDigSpeedRepaired(repaired))
    }
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

  /**
   * The contents this body has OBSERVED, for the controller to inject into the
   * next sensor tick (`SensorInput.containerContents`). Containers nobody opened
   * are absent - the candidate layer reads absence as UNKNOWN.
   */
  containerContents(): ContainerObservation[] {
    return [...this.containerObservations.values()].map((entry) => ({
      ...entry,
      position: { ...entry.position },
      items: entry.items.map((stack) => ({ ...stack })),
    }))
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

    // issue #436 section 4: a Jev selection becomes a first-class commitment for
    // the whole bounded lifetime of the action - identity, target, declared
    // postconditions, effect envelope, budget, interrupt policy, and the
    // provenance (who selected it, at which state fingerprint).
    const commitment = this.buildCommitment(candidate)
    const action: CurrentAction = {
      id: candidate.id,
      kind: candidate.kind,
      epoch,
      startedAt,
      phase: 'starting',
      status: 'running',
      detail: '',
      completion,
      commitment,
    }
    this.action = action
    this.activeCommitment = commitment
    this.stepLog.clear()
    // NOTE (§17 single owner): `SKILL_COMMIT` is NOT emitted here. The controller
    // owns it, because section 3 makes the ACTIVE decision epoch the thing that
    // authorizes a commitment; it reads this commitment's id + contract hashes
    // from `executor.current.commitment` at the authorize site, so one line
    // carries both the epoch and the envelope identity.
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
    // The commitment dies with its action: a late/stale completion can never
    // resurrect it (section 25), and the next selection builds a new one.
    this.activeCommitment = null
    this.stepLog.clear()
  }

  private ensureOwned(epoch: number, signal: AbortSignal): void {
    if (signal.aborted) throw new ActionCancelled(`action#${epoch} aborted`)
    if (epoch !== this.activeEpoch) {
      throw new ActionCancelled(`action#${epoch} superseded by action#${this.activeEpoch}`)
    }
  }

  // -------------------------------------------------------------------------
  // issue #436: SkillCommitment construction, evidence, effect envelope
  // -------------------------------------------------------------------------

  /**
   * The equipment a SELECTED candidate authorizes putting in hand. This is the
   * grounded input to the effect envelope; it never ranks items (section 11).
   *
   *   - a PLACE/IGNITE/HOLD_ITEM/EQUIP/EAT selection names its exact item;
   *   - a dig-ish selection names a tool FAMILY (`toolName`), and the physical
   *     instances of that family already in the inventory are the mechanically
   *     equivalent way to satisfy it;
   *   - an ATTACK may put a carried weapon in hand because the fight's damage is
   *     the held item's - the exact list is the carried weapons, and Phase 4
   *     narrows it to one weapon or a policy boundary per section 11.
   */
  private groundedEquipItems(candidate: Candidate): string[] {
    const carried = Object.keys(this.inventoryCounts()).filter((name) => (this.inventoryCounts()[name] ?? 0) > 0)
    switch (candidate.kind) {
      case 'PLACE': {
        if (candidate.itemName === null) return []
        const items = [candidate.itemName]
        // A multi-cell FRAME build also places its verified support/scaffold
        // block, so the carried scaffold materials are admissible.
        if ((candidate.placementCells ?? []).length > 0) {
          items.push(...carried.filter((name) => PILLAR_PLACE_PRIORITY.includes(name)))
          items.push(...carried.filter((name) => ROUTE_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix))))
        }
        return [...new Set(items)]
      }
      case 'IGNITE':
      case 'EQUIP':
      case 'EAT':
        return candidate.itemName === null ? [] : [candidate.itemName]
      case 'MINE': {
        if (candidate.toolName === null) return []
        const suffix = `_${candidate.toolName}`
        return carried.filter((name) => name.endsWith(suffix))
      }
      case 'DESCEND':
      case 'STEP':
      case 'MOVE':
      // Walking onto a dropped item equips nothing: the hand is irrelevant to the
      // server's pickup, so no carried item is authorized by a PICKUP selection.
      case 'PICKUP':
      case 'RETRIEVE': {
        // A BRIDGE MOVE declares the ONE block its own placing route consumes
        // (`meta.bridgeBlock`), so that block - and only it - is authorized. The
        // selection grounds the item; this never ranks one.
        const bridgeBlock = isBridgeMove(candidate) && typeof candidate.meta[BRIDGE_BLOCK_META] === 'string'
          ? (candidate.meta[BRIDGE_BLOCK_META] as string)
          : null
        if (bridgeBlock !== null) return carried.filter((name) => name === bridgeBlock)
        // A route-opening locomotion candidate may clear the cells its OWN
        // grounded route names, so the carried instances of the tool families
        // that route can require are the mechanically equivalent way to satisfy
        // it. A plain walk with no declared route still authorizes no equip.
        const routeOpening = candidate.meta.digRoute === true || candidate.meta.vertical !== undefined
        if (routeOpening) {
          // ...and when the route's own placement step declared a block it
          // consumes (a VERTICAL PILLAR route's `meta.pillarPlaceName` /
          // `meta.fallbackPillarPlaceName`, the very keys `runVerticalLeg` reads
          // before `pillarUp` equips), that declared block is authorized too -
          // otherwise the route's PLACE is admitted by `mayPlaceGroundedRoute`
          // while the EQUIP of the block it is about to place is refused
          // `equip_item_not_declared` (measured live defect at main cd7b38b:
          // `RETRIEVE:known:blaze_rod:b35_60_-22` equipping cobblestone). The
          // declared set is exactly what the candidate grounded: an undeclared
          // block is still refused, and no carried placeable block is admitted
          // just for being placeable.
          const declared = declaredRoutePlaceBlocks(candidate)
          return [
            ...new Set([
              ...carried.filter((name) => ROUTE_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix))),
              ...carried.filter((name) => declared.includes(name)),
            ]),
          ]
        }
        if (candidate.toolName === null) return []
        const suffix = `_${candidate.toolName}`
        return carried.filter((name) => name.endsWith(suffix))
      }
      case 'ENTER_PORTAL': {
        // The portal-entry contract owns its grounded approach route (dig the
        // remaining cells, place the footing), so the carried route tools are
        // admissible. No station, no transfer, no attack.
        const routeOpening = candidate.meta.digRoute === true || candidate.meta.vertical !== undefined
        if (!routeOpening) return []
        // The entry candidate carries the same `verticalPlanMeta` a MOVE does, so
        // its own declared pillar block is admissible by the same rule.
        const declared = declaredRoutePlaceBlocks(candidate)
        return [
          ...new Set([
            ...carried.filter((name) => ROUTE_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix))),
            ...carried.filter((name) => declared.includes(name)),
          ]),
        ]
      }
      case 'ATTACK':
        return carried.filter((name) => WEAPON_ITEM_SUFFIXES.some((suffix) => name.endsWith(suffix)))
      case 'CRAFT':
      case 'SMELT':
      // A container interaction equips nothing: the window transfer moves the
      // items, the hand stays free (a held tool is irrelevant to opening a box).
      case 'CONTAINER':
      case 'RETREAT':
      case 'WAIT':
      case 'ESCALATE':
        return []
    }
  }

  /**
   * The exact inventory transfers a selected candidate authorizes. Only the
   * already-selected SMELT recipe/station has any: its input, its fuel, and the
   * collection of its own output item (issue #436 section 12).
   */
  private groundedTransfers(candidate: Candidate): InventoryTransferSpec[] {
    if (candidate.kind === 'CONTAINER') {
      // A WITHDRAW declares exactly the item the candidate's OWN observation saw
      // and no more than that observed count (the transfer effect's `container`
      // is the truthful `name@x,y,z` here, so an envelope for one chest can
      // never authorize a move out of another). An OPEN/inspect selection
      // declares NOTHING: it may read the container and must fail closed on any
      // attempt to move an item out of it.
      if (readMetaString(candidate, 'containerAction') !== 'withdraw') return []
      const item = readMetaString(candidate, 'containerItem')
      const ref = readMetaString(candidate, 'containerRef')
      if (item === null || ref === null) return []
      const count = readMetaNumber(candidate, 'containerCount', 0)
      return [{ itemName: item, count: Number.isFinite(count) && count > 0 ? Math.floor(count) : null, container: ref }]
    }
    if (candidate.kind !== 'SMELT') return []
    const inputItem = readMetaString(candidate, 'inputItem')
    const fuelItem = readMetaString(candidate, 'fuelItem')
    const transfers: InventoryTransferSpec[] = []
    if (inputItem !== null) transfers.push({ itemName: inputItem, count: null, container: 'furnace_input' })
    if (fuelItem !== null) transfers.push({ itemName: fuelItem, count: null, container: 'furnace_fuel' })
    if (candidate.itemName !== null) {
      transfers.push({ itemName: candidate.itemName, count: null, container: 'furnace_output' })
    }
    return transfers
  }

  /** The exact stations a selected candidate authorizes opening. */
  private groundedStations(candidate: Candidate): string[] {
    switch (candidate.kind) {
      case 'CRAFT':
        return ['crafting_table']
      case 'SMELT':
        return ['furnace', 'blast_furnace', 'smoker']
      case 'CONTAINER': {
        // Opening a container is a STATION use, so the envelope names the exact
        // block the selection declared - and nothing else. The live block is
        // re-read before the open, and a different container there is refused.
        const block = readMetaString(candidate, 'containerBlock')
        return block !== null && isContainerBlockName(block) ? [block] : []
      }
      default:
        return []
    }
  }

  /** The declared wall-clock budget of the selection, when the runner has one. */
  private budgetMsFor(candidate: Candidate): number | null {
    switch (candidate.kind) {
      case 'ATTACK':
        return readMetaString(candidate, 'goalDrop') === null ? ATTACK_LEASE_MS : GOAL_HUNT_LEASE_MS
      case 'MINE':
      case 'DESCEND':
      case 'STEP':
        return this.options.digTimeoutMs
      case 'MOVE':
      case 'RETREAT':
      case 'RETRIEVE':
        return this.options.pathTimeoutMs
      case 'SMELT':
        return this.options.smeltTimeoutMs
      case 'CONTAINER':
        return this.options.pathTimeoutMs + (this.options.containerOpenTimeoutMs ?? CONTAINER_OPEN_TIMEOUT_MS)
      default:
        return null
    }
  }

  /** Build the first-class commitment for one policy-selected candidate. */
  private buildCommitment(candidate: Candidate): SkillCommitment {
    const dimension = this.observedDimension()
    const worldEpoch = readMetaNumber(candidate, 'worldEpoch', 0)
    const selectedBy = readMetaString(candidate, 'selectedBy')
    // #436 section 5/17: the block(s) this locomotion route's own placement step
    // declared at candidate time are what authorizes the equip below, so the
    // declaration itself is run-scoped evidence - otherwise the only visible
    // change after the fix is a different `SKILL_COMMIT effectEnvelopeHash=` with
    // no named cause. Emitted once per commitment, before the action runs.
    const declaredPlacements = declaredRoutePlacements(candidate)
    if (declaredPlacements.length > 0) {
      const held = this.inventoryCounts()
      this.logger.info(
        'agent',
        formatRoutePlaceDeclared({
          actionId: candidate.id,
          skillKind: candidate.kind,
          declarations: declaredPlacements,
          held,
        }),
        {
          actionId: candidate.id,
          kind: candidate.kind,
          blocks: declaredPlacements.map((entry) => entry.block),
          sources: declaredPlacements.map((entry) => entry.source),
          carried: declaredPlacements
            .filter((entry) => (held[entry.block] ?? 0) > 0)
            .map((entry) => entry.block),
        },
      )
    }
    return createSkillCommitment({
      decisionEpoch: Math.floor(readMetaNumber(candidate, 'decisionEpoch', 0)),
      optionInstanceId: readMetaString(candidate, 'optionInstanceId'),
      decisionId: readMetaString(candidate, 'decisionId'),
      candidate,
      target: targetIdentityOf(candidate, { dimension, worldEpoch }),
      expectedPostconditions: declaredPostconditions(candidate),
      allowedEffects: envelopeForCandidate(candidate, {
        equipItems: this.groundedEquipItems(candidate),
        stations: this.groundedStations(candidate),
        transfers: this.groundedTransfers(candidate),
      }),
      budget: { ms: this.budgetMsFor(candidate), steps: null, retries: 0 },
      selectedBy: selectedBy === 'hard_safety' ? 'hard_safety' : 'jev_pi',
      selectedAtStateFingerprint: readMetaString(candidate, 'stateFingerprint'),
      params: {
        candidateId: candidate.id,
        targetName: candidate.targetName,
        itemName: candidate.itemName,
        toolName: candidate.toolName,
        goalDrop: readMetaString(candidate, 'goalDrop'),
      },
    })
  }

  /**
   * Section 14/23: revalidate the live commitment against the world it was
   * grounded in before any further mutation. This is fail-closed truth, never a
   * recovery: a commitment whose dimension/worldEpoch changed cannot be
   * mechanically repaired, and code may not substitute a new target for it
   * (section 14/16). Called from every mutation choke point via `assertEffect`.
   *
   * `enter_portal` is the deliberate exception: its declared postcondition IS
   * the dimension change, so it carries its own bounded transfer verification.
   */
  private assertCommitmentValid(): void {
    const commitment = this.activeCommitment
    if (commitment === null) return
    const observedDimension = this.observedDimension()
    const observedWorldEpoch = this.options.observedWorldEpoch?.() ?? null
    const reason = commitmentInvalidation({
      commitment,
      observedDimension,
      // With no live epoch provider the committed epoch is what is observed, so
      // only the observable dimension is revalidated (never a false verdict).
      observedWorldEpoch: observedWorldEpoch ?? committedWorldEpoch(commitment),
      // The lease is the HOST's: a revoked lease aborts this action through
      // `ensureOwned`, which settles it LEASE_REVOKED. Not re-derived here.
      leaseHeld: true,
    })
    if (reason === null) return
    this.logger.error(
      'executor',
      formatSkillInvalidated({
        commitmentId: commitment.commitmentId,
        decisionEpoch: commitment.decisionEpoch,
        skillKind: commitment.skillKind,
        candidateId: commitment.candidateId,
        reason,
        targetKey: targetIdentityKey(commitment.target),
        observedDimension,
        observedWorldEpoch: observedWorldEpoch ?? committedWorldEpoch(commitment),
        detail: `live revalidation at a mutation choke point (${reason})`,
      }),
      {
        actionId: commitment.candidateId,
        commitmentId: commitment.commitmentId,
        reason,
        observedDimension,
      },
    )
    throw new ExecutorError(
      reason === 'LEASE_REVOKED' ? 'cancelled' : 'world_changed',
      `commitment ${commitment.commitmentId} is invalid (${reason}); failing closed`,
    )
  }

  /** The live dimension the body is in, or 'unknown' when the game state is absent. */
  private observedDimension(): string {
    const dimension = (this.bot.game as { dimension?: unknown } | undefined)?.dimension
    return typeof dimension === 'string' ? dimension : 'unknown'
  }

  /**
   * Section 5/27: every mechanical step goes through here while a commitment is
   * active. A step outside the declared envelope FAILS CLOSED - it is never a
   * reason to widen the envelope (section 16).
   */
  private assertEffect(effect: Effect): void {
    const commitment = this.activeCommitment
    if (commitment === null) return
    this.assertCommitmentValid()
    const envelope = this.options.effectEnvelopeOverride ?? commitment.allowedEffects
    const violation = effectViolation(envelope, effect)
    if (violation !== null) {
      this.logger.error(
        'executor',
        `SKILL_ENVELOPE_VIOLATION commitmentId=${commitment.commitmentId} skillKind=${commitment.skillKind} ` +
          `effect=${effect.type} reason=${violation} candidateId=${commitment.candidateId}`,
        { actionId: commitment.candidateId, commitmentId: commitment.commitmentId, effect, violation },
      )
      throw new ExecutorError(
        'effect_envelope_violation',
        `${effect.type} is outside the ${commitment.skillKind} effect envelope (${violation}); failing closed`,
      )
    }
    this.noteMechanicalStep(commitment, effect)
  }

  /**
   * Section 17: the aggregated MECHANICAL_CONTINUATION evidence for a step that
   * realizes the committed selection. Aggregated because a walk toggles controls
   * every physics tick; the count still proves the mechanical work happened.
   */
  private noteMechanicalStep(commitment: SkillCommitment, effect: Effect): void {
    const now = Date.now()
    const entry = this.stepLog.get(effect.type)
    const count = (entry?.count ?? 0) + 1
    const alwaysReport =
      effect.type === 'attack' ||
      effect.type === 'dig' ||
      effect.type === 'place' ||
      effect.type === 'equip' ||
      effect.type === 'station' ||
      effect.type === 'transfer'
    const due = entry === undefined || alwaysReport || now - entry.lastEmitMs >= SKILL_STEP_REPORT_MS
    this.stepLog.set(effect.type, { count, lastEmitMs: due ? now : entry?.lastEmitMs ?? now })
    if (!due) return
    this.logger.info(
      'executor',
      formatCommittedStep({
        commitmentId: commitment.commitmentId,
        decisionEpoch: commitment.decisionEpoch,
        skillKind: commitment.skillKind,
        stepKind: effect.type,
        authority: 'MECHANICAL_CONTINUATION',
        evidence: describeEffect(effect),
        worldDelta: this.bodyDelta(),
        count,
      }),
      { actionId: commitment.candidateId, commitmentId: commitment.commitmentId, stepKind: effect.type, count },
    )
  }

  /**
   * Section 17: let a prerequisite-closure or safety-reflex layer record its own
   * authority step against the active commitment. The layer that performs the
   * step owns the claim; this only formats it into the shared evidence channel.
   */
  noteAuthorityStep(stepKind: string, authority: StepAuthority, evidence: string): void {
    const commitment = this.activeCommitment
    if (commitment === null) return
    this.logger.info(
      'executor',
      formatCommittedStep({
        commitmentId: commitment.commitmentId,
        decisionEpoch: commitment.decisionEpoch,
        skillKind: commitment.skillKind,
        stepKind,
        authority,
        evidence,
        worldDelta: this.bodyDelta(),
      }),
      { actionId: commitment.candidateId, commitmentId: commitment.commitmentId, stepKind, authority },
    )
  }

  private bodyDelta(): string {
    const position = this.bot.entity?.position
    const health = this.bot.health
    const where =
      position === undefined
        ? 'pos=unknown'
        : `pos=${Math.round(position.x * 10) / 10},${Math.round(position.y * 10) / 10},${Math.round(position.z * 10) / 10}`
    return `${where} health=${typeof health === 'number' ? health : 'unknown'}`
  }

  /**
   * All direct control-state writes go through here so `move`/`jump`/`sprint`
   * are inside the envelope check (section 5). The stock pathfinder drives the
   * body through the movement entry points, which assert `move` themselves.
   */
  private setControlState(state: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak', value: boolean): void {
    if (value) {
      if (state === 'jump') this.assertEffect({ type: 'jump' })
      else if (state === 'sprint') this.assertEffect({ type: 'sprint' })
      else this.assertEffect({ type: 'move' })
    }
    this.bot.setControlState(state, value)
  }

  /** Section 6/17: close the commitment evidence with its typed outcome. */
  private logSkillEnd(
    commitment: SkillCommitment | null,
    result: ExecutionResult,
    thrown: { failure: string | null; status: string } | null,
  ): void {
    if (commitment === null) return
    const taxonomy = classifyActionOutcome({
      kind: result.kind,
      status: result.status,
      verified: result.verified,
      itemsGained: result.itemsGained,
      blockRemoved: result.blockRemoved,
      progressed: result.progressed,
      entityDefeated: result.entityDefeated,
      damageObserved: result.damageObserved,
      failureCode: result.failure,
    })
    const failure = result.failure ?? thrown?.failure ?? null
    const outcome = skillOutcomeForFailure(failure, result.status)
    const evidence: SkillEndEvidence = {
      commitmentId: commitment.commitmentId,
      decisionEpoch: commitment.decisionEpoch,
      skillKind: commitment.skillKind,
      candidateId: commitment.candidateId,
      execution: taxonomy.execution,
      verification: taxonomy.verification,
      progress: taxonomy.progress,
      failureCode: failure,
      outcome,
      targetIdentityKey: targetIdentityKey(commitment.target),
      ms: Date.now() - (this.action?.startedAt ?? Date.now()),
    }
    this.logger.info('executor', formatCommittedEnd(evidence), {
      actionId: commitment.candidateId,
      commitmentId: commitment.commitmentId,
      outcome,
      failure,
      policyBoundary: isPolicyBoundaryOutcome(outcome),
    })
  }

  // -------------------------------------------------------------------------
  // action runners
  // -------------------------------------------------------------------------

  /**
   * issue #436 section 17: the evidence wrapper for every action. It adds the
   * commitmentId + typed lifecycle outcome to the settled result and closes the
   * commitment evidence with SKILL_END. It never changes execution: the body is
   * byte-for-byte the existing runner dispatch.
   */
  private async runAction(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const commitment = this.activeCommitment
    const result = await this.runActionBody(candidate, epoch, signal, startedAt)
    if (commitment !== null) {
      // issue #436 section 6 + #437 section 2: the settled action carries the
      // identity of the commitment it closes and the §6 lifecycle outcome. The
      // #437 handoff PACKET is built by the controller (`jevSemanticProjection`),
      // which owns the decision epoch; it reads this commitment's real
      // `commitmentId` + `CausalTargetIdentity` instead of re-deriving them.
      const outcome = skillOutcomeForFailure(result.failure, result.status)
      result.commitmentId = commitment.commitmentId
      result.skillOutcome = outcome
      result.skillTargetIdentityKey = targetIdentityKey(commitment.target)
      result.skillTerminalReason = skillTerminalReasonFor(outcome)
      this.logSkillEnd(commitment, result, null)
    }
    return result
  }

  private async runActionBody(
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
        case 'CONTAINER':
          return await this.runContainer(candidate, epoch, signal, startedAt)
        case 'DESCEND':
          return await this.runDescend(candidate, epoch, signal, startedAt)
        case 'STEP':
          return await this.runStep(candidate, epoch, signal, startedAt)
        case 'RETRIEVE':
          return await this.runRetrieve(candidate, epoch, signal, startedAt)
        case 'PICKUP':
          return await this.runPickup(candidate, epoch, signal, startedAt)
        case 'PLACE':
          return await this.runPlace(candidate, epoch, signal, startedAt)
        case 'IGNITE':
          return await this.runIgnite(candidate, epoch, signal, startedAt)
        case 'ENTER_PORTAL':
          try {
            return await this.runEnterPortal(candidate, epoch, signal, startedAt)
          } catch (error) {
            const code = error instanceof ExecutorError ? error.code : 'unknown_event'
            this.logger.warn('agent', formatSkillInterrupt(PORTAL_ENTER_SKILL, code), {
              actionId: candidate.id,
              failure: code,
            })
            this.logger.warn(
              'agent',
              `${formatSkillEnd(PORTAL_ENTER_SKILL, 'failed', 'unverified', code, code)} progress=none failureCode=${code} commitmentId=${candidate.id}#${epoch} targetIdentity=${this.portalTargetIdentity(this.portalEntryCellOf(candidate), this.portalEntryDimensionOf(candidate))}`,
              { actionId: candidate.id, failure: code },
            )
            throw error
          }
        case 'EAT':
          return await this.runEat(candidate, epoch, signal, startedAt)
        case 'EQUIP':
          return await this.runEquip(candidate, epoch, signal, startedAt)
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

    // Owner vertical-safety rule, shared with the candidate generator: a MINE
    // must never remove the block the bot is standing on. `mineCandidates` no
    // longer offers that cell; this is the execution-time truth for any stale or
    // foreign MINE, and it emits the greppable DIG_DOWN_REFUSED marker instead of
    // silently dropping the bot. Checked before the phase is set to `digging` so
    // a refused dig is never logged as an active dig.
    const digDown = digsBotSupport(this.bot.entity.position, target)
    if (digDown !== null) {
      throw new ExecutorError('dig_down_refused', formatDigDownRefused(digDown))
    }

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

    const yieldItem = readMetaString(candidate, 'yieldItem') ?? candidate.targetName
    const clearance = candidate.meta.clearance === true
    const beforeCount = this.countItem(yieldItem)
    // Every failure on the dig path is mirrored as a typed DIG_FAILED line: the
    // measured M3 stall had no cause in the mirrored stream at all, only
    // `verified=false status=failed progressDelta=0`.
    this.lastDigPlan = null
    this.digStartedAt = Date.now()
    try {
      if (this.distanceToEyes(target) > this.options.reach) {
        // pathing claimed to finish but we are still too far to legally mine
        throw new ExecutorError(
          'out_of_reach',
          `target is ${round2(this.distanceToEyes(target))}m from the eyes (reach ${this.options.reach})`,
        )
      }
      await this.equipTool(candidate, epoch, signal)
      await this.digBlock(block, epoch, signal)
    } catch (error) {
      // A supersede/dispose is a cancellation, not a dig failure.
      if (error instanceof ActionCancelled) throw error
      this.logDigFailed(candidate, block, target, error)
      throw error
    } finally {
      this.digStartedAt = 0
    }
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

    // A collect MINE is complete only when the drop landed in the inventory; a
    // pure dig (clearance / non-collect goal) is complete on removal because its
    // drop may be legitimately transformed or lost. The drop was already
    // actively collected by `collectDrop` above, bounded by pickupPathTimeoutMs.
    const requiresPickup = candidate.meta.requiresPickup === true
    const verified = isMinePostconditionMet({
      requiresPickup,
      blockRemoved: report.removed,
      dropObserved: report.dropObserved,
      itemsGained: report.itemsGained,
    })
    if (!verified) {
      const detail = `blockRemoved=${report.removed} dropObserved=${report.dropObserved} itemsGained=${report.itemsGained} after ${report.settledMs}ms`
      this.logger.warn('verify', `MINE_PICKUP_UNMET ${candidate.id} ${detail}`, { target, actionId: candidate.id })
      return this.buildResult(
        candidate,
        epoch,
        startedAt,
        'failed',
        requiresPickup ? 'uncollected' : 'unverified',
        detail,
        requiresPickup ? 'pickup_failed' : 'verify_failed',
        {
          verified: false,
          blockRemoved: report.removed,
          dropObserved: report.dropObserved,
          itemsGained: report.itemsGained,
          goalItemCount: report.goalItemCount,
        },
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

  /**
   * issue #436 section 3 / OPERATOR DIRECTIVE 2026-09-23:
   *
   *   "A Jev selection is a commitment to one grounded semantic action, not
   *    permission for one primitive Mineflayer call."
   *
   * The committed MOVE/RETREAT walks to its selected destination inside ONE
   * bounded, closed-loop harness-layer Skill: ordinary replanning of the SAME
   * target, the existing bump-and-jump, and continuation after a leg that merely
   * failed mechanically are all MECHANICAL_CONTINUATION of the one decision.
   * Policy is re-entered only at a semantic boundary (`walkSkill.ts`).
   *
   * A BRIDGE leg is its own route, exactly like a generated vertical plan: the
   * stock `canDig=false` pathfinder cannot express "place a block and step onto
   * it". It owns its own bounded place-then-advance loop, so it is dispatched
   * BEFORE the walk loop and never wrapped by it.
   */
  private async runMove(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    if (isBridgeMove(candidate)) return await this.runBridge(candidate, epoch, signal, startedAt)
    return await this.runWalkSkill(candidate, epoch, signal, startedAt, (legSignal, strict, remainingMs) =>
      this.runMoveLeg(candidate, epoch, legSignal, startedAt, strict, remainingMs),
    )
  }

  /**
   * THE WALK-TO SKILL LOOP (issue #436 section 3; OPERATOR DIRECTIVE 2026-09-23).
   *
   * ONE Jev selection owns the whole traversal. While the commitment is inside its
   * declared `EffectEnvelope` and budget, this loop keeps making bounded mechanical
   * progress toward the SAME committed target - replanning that target with the
   * ordinary mechanics, bumping and jumping the ordinary way, and continuing after
   * a leg that merely failed mechanically. It does NOT re-decide anything:
   *
   *   * the target is the committed target (never a retarget, never a substitute);
   *   * every step still goes through `assertEffect` (the envelope can never widen);
   *   * `assertCommitmentValid` revalidates world/epoch/dimension between legs, and
   *     the per-step landing guard + env-hazard abort stay live per step, so a
   *     lethal step or a revoked lease stops the loop mid-leg, not at the end;
   *   * the boundary decision is the pure `walkBoundaryAfterLeg` - arrival, typed
   *     safety/invalidation, budget, or "no authorised mechanical continuation"
   *     (which is the section 7 U3 / section 22 policy boundary, with NO choice
   *     made between remedy classes).
   *
   * Evidence: ONE `SKILL_START` (the commitment), one `SKILL_STEP
   * authority=MECHANICAL_CONTINUATION step=walk_leg count=<leg>` per mechanical
   * leg, one `SKILL_END` with the verified outcome (emitted by `runAction`), and
   * `SKILL_POLICY_BOUNDARY` at a semantic stop. `actionsPerDecision` is therefore
   * > 1 by construction for any traversal that needs more than one leg.
   */
  private async runWalkSkill(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
    runLeg: (signal: AbortSignal, strictArrival: boolean, remainingMs: number) => Promise<WalkLegExecution>,
  ): Promise<ExecutionResult> {
    const target = walkTargetOf(candidate)
    const skill = walkSkillIdFor(candidate.kind)
    const commitment = this.activeCommitment
    // No commitment / no destination / not a locomotion kind: keep exactly the
    // pre-loop behaviour (ONE bounded leg) instead of inventing a loop owner.
    const declaredBudget = walkSkillBudget(commitment?.budget.ms ?? null)
    if (target === null || skill === null || commitment === null || !isWalkSkillKind(candidate.kind)) {
      return (await runLeg(signal, false, declaredBudget.ms)).result
    }
    const budget = declaredBudget
    const deadlineAt = startedAt + budget.ms
    let legs = 0
    let stalledLegs = 0
    let remaining = this.distanceToFeet(target)
    const startDistance = remaining
    this.logger.info(
      'executor',
      formatWalkSkillStart({ skill, commitment, budget, target, envelope: commitment.allowedEffects }),
      {
        actionId: candidate.id,
        commitmentId: commitment.commitmentId,
        decisionEpoch: commitment.decisionEpoch,
        stepCap: budget.steps,
        msBudget: budget.ms,
      },
    )
    for (;;) {
      // Budget is checked BEFORE another leg starts, so a spent commitment can
      // never begin mechanical work it cannot bound.
      const pre = walkBoundaryAfterLeg({
        legs,
        stalledLegs,
        elapsedMs: Date.now() - startedAt,
        budget,
        arrived: false,
        failure: null,
        invalidated: null,
      })
      if (pre.stop) {
        return this.settleWalkSkill(
          candidate,
          epoch,
          skill,
          commitment,
          pre,
          legs,
          stalledLegs,
          remaining,
          target,
          null,
          startedAt,
          startDistance - remaining,
        )
      }
      // §14/23 per-LEG revalidation: the world/epoch/dimension this commitment was
      // grounded in can change between legs (a portalled body, an epoch bump). It
      // fails closed with the typed SKILL_INVALIDATED event and never re-plans into
      // the new world - the replacement target belongs to policy.
      this.assertCommitmentValid()
      const bound = this.boundWalkLeg(signal, deadlineAt)
      const before = remaining
      let arrived = false
      let settled: ExecutionResult | null = null
      let thrown: unknown = null
      let legFailure: WalkLegFailure | null = null
      let phase = 'pathing'
      legs += 1
      try {
        // The FIRST leg keeps the exact pre-loop physical path; every retry of the
        // SAME committed target tightens arrival to the committed cell.
        const leg = await runLeg(bound.signal, legs > 0, Math.max(1, deadlineAt - Date.now()))
        arrived = leg.arrived
        settled = leg.result
        phase = leg.result.phase
      } catch (error) {
        thrown = error
        legFailure = this.walkLegFailureOf(error, bound.timedOut())
      } finally {
        bound.cleanup()
      }
      // A fail-closed envelope refusal is a statement about the COMMITMENT, not a
      // transient leg failure: the commitment cannot perform a step it needs, so
      // re-running the identical leg can only repeat the identical refusal. Measured
      // live before this guard: ONE CRAFT commitment re-attempted the same refused
      // move 44,617 times inside five seconds (~8,900/s) - a spin loop that burned CPU,
      // wrote 44k log lines and could never succeed. Stop with the typed capability
      // boundary and hand the decision back to policy instead.
      if (legFailure !== null && legFailure.code === 'effect_envelope_violation') {
        return this.settleWalkSkill(
          candidate,
          epoch,
          skill,
          commitment,
          {
            stop: true,
            reason: 'capability',
            outcome: 'MECHANICALLY_BLOCKED',
            failureCode: legFailure.code,
            policyBoundary: true,
          },
          legs,
          stalledLegs,
          remaining,
          target,
          thrown,
          startedAt,
          startDistance - remaining,
        )
      }
      const after = this.distanceToFeet(target)
      remaining = after
      // Durable mechanical progress: distance actually closed toward the committed
      // target. A leg that failed mechanically but still closed distance is
      // progress (section 5: body motion is progress, never completion).
      stalledLegs = before - after >= WALK_SKILL_MIN_PROGRESS ? 0 : stalledLegs + 1
      this.logger.info(
        'executor',
        formatWalkLeg({
          skill,
          commitment,
          leg: legs,
          evidence: walkLegEvidence({ leg: legs, from: before, to: after, failureCode: legFailure?.code ?? null, phase }),
          worldDelta: this.bodyDelta(),
          failure: legFailure?.code ?? null,
        }),
        {
          actionId: candidate.id,
          commitmentId: commitment.commitmentId,
          leg: legs,
          failure: legFailure?.code ?? null,
          remaining: round2(after),
        },
      )
      const decision = walkBoundaryAfterLeg({
        legs,
        stalledLegs,
        elapsedMs: Date.now() - startedAt,
        budget,
        arrived,
        failure: legFailure,
        invalidated: null,
      })
      if (!decision.stop) continue
      if (decision.reason === 'arrived' && settled !== null) return settled
      return this.settleWalkSkill(
        candidate,
        epoch,
        skill,
        commitment,
        decision,
        legs,
        stalledLegs,
        remaining,
        target,
        thrown,
        startedAt,
        startDistance - remaining,
      )
    }
  }

  /**
   * Stop the committed walk at a SEMANTIC boundary and hand control back to
   * policy with the typed reason.
   *
   * A stop the loop itself decided (its own budget/stall bound) settles with a
   * `failed` result carrying the TYPED code and the durable body progress it did
   * make, so the controller still sees `progressed`/`distanceClosed` for a walk
   * that closed real distance without reaching the target (the #352 signal) -
   * a "typed end" is never a silent stop and never a fake arrival. A stop caused
   * by a leg failure rethrows that failure unchanged, so safety, invalidation and
   * ordinary mechanical failures keep their own code, message and semantics.
   */
  private settleWalkSkill(
    candidate: Candidate,
    epoch: number,
    skill: WalkSkillId,
    commitment: SkillCommitment,
    stop: WalkStop,
    legs: number,
    stalledLegs: number,
    remaining: number,
    target: Vec3Json,
    thrown: unknown,
    startedAt: number,
    closed: number,
  ): ExecutionResult {
    const boundary = formatWalkBoundary({ skill, commitment, stop, legs, remaining, target, stalledLegs })
    const detail = {
      actionId: candidate.id,
      commitmentId: commitment.commitmentId,
      reason: stop.reason,
      outcome: stop.outcome,
      legs,
      stalledLegs,
      remaining: round2(remaining),
      closed: round2(closed),
    }
    // §17 single owner per marker: only a stop where code reached a decision it
    // must NOT make states the policy boundary (the grounded remedy list stays
    // policy's, so `alternatives=[]` here); a safety/lease/capability end is an
    // INTERRUPT with its own typed end, so the boundary counter keeps meaning.
    if (stop.policyBoundary) this.logger.warn('agent', boundary, detail)
    else this.logger.warn('agent', formatSkillInterrupt(skill, stop.reason), detail)
    if (thrown !== null && !(thrown instanceof ActionCancelled && stop.failureCode === 'path_timeout')) throw thrown
    const code = (stop.failureCode ?? 'path_stuck') as FailureCode
    return this.buildResult(
      candidate,
      epoch,
      startedAt,
      'failed',
      stop.reason === 'budget_exhausted' ? 'walk_budget_exhausted' : 'walk_blocked',
      `${skill} ${candidate.id} stopped at a policy boundary reason=${stop.reason} after ${legs} mechanical leg(s) ` +
        `(${round2(remaining)}m from (${target.x},${target.y},${target.z})), closed=${round2(closed)}m, ` +
        `elapsed=${Date.now() - startedAt}ms`,
      code,
      {
        verified: false,
        blockRemoved: false,
        dropObserved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
        // Durable mechanical progress is NOT completion (#436 section 5) and is
        // NOT thrown away either: the same bounded-progress signal the travel leg
        // already reports (#352) travels on the typed stop.
        progressed: closed >= WALK_SKILL_MIN_PROGRESS,
        distanceClosed: closed >= WALK_SKILL_MIN_PROGRESS,
      },
    )
  }

  /** The leg's typed failure, in the loop's vocabulary (never a silent retry). */
  private walkLegFailureOf(error: unknown, timedOut: boolean): WalkLegFailure {
    if (error instanceof ActionCancelled) {
      // Our own wall-clock bound reads as a spent budget; any other abort is the
      // caller/lease and keeps its own lifecycle outcome.
      return timedOut
        ? { code: 'path_timeout', outcome: 'BUDGET_EXHAUSTED' }
        : { code: 'cancelled', outcome: 'LEASE_REVOKED' }
    }
    const code = error instanceof ExecutorError ? error.code : 'unknown_event'
    return { code, outcome: skillOutcomeForFailure(code, 'failed') }
  }

  /**
   * Bound ONE leg by the commitment's wall-clock deadline: the child signal is
   * aborted either by the caller (lease/reflex) or by the deadline, and the loop
   * distinguishes the two (`timedOut`) so a spent budget is `BUDGET_EXHAUSTED`
   * while a revoked lease stays `LEASE_REVOKED`.
   */
  private boundWalkLeg(
    signal: AbortSignal,
    deadlineAt: number,
  ): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
    const controller = new AbortController()
    let timedOut = false
    const onParentAbort = (): void => controller.abort(signal.reason)
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(
      () => {
        timedOut = true
        controller.abort(new Error('walk skill commitment budget exhausted'))
      },
      Math.max(0, deadlineAt - Date.now()),
    )
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      cleanup: () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onParentAbort)
      },
    }
  }

  /**
   * ONE bounded mechanical leg of a committed walk: exactly the behaviour
   * `runMove` had before the loop existed (vertical contract chunk -> stock
   * pathfinder -> travel leg -> control-walk/packet fallback -> arrival
   * classification). It reports whether THIS leg verified the committed arrival
   * and otherwise throws its own typed failure, which the loop classifies.
   */
  private async runMoveLeg(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
    strictArrival = false,
    remainingMs?: number,
  ): Promise<WalkLegExecution> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', `${candidate.kind} candidate has no coordinates`)
    // The committed budget is the WHOLE commitment's bound, so the first stage of
    // this leg gets at most what is left - and, when a committed travel leg is the
    // designed next stage for a far target (#352), at most half of it, so the
    // travel leg can still run inside the same declared budget.
    const stageMs = walkStageBudgetMs(
      remainingMs ?? this.options.pathTimeoutMs,
      classifyTravelLeg({ remainingBefore: this.distanceToFeet(target), remainingAfter: this.distanceToFeet(target) })
        .warranted,
    )
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
    const { activeVertical, verticalStep } = await this.runVerticalContract(candidate, epoch, signal, target, startY)
    if (activeVertical !== 'none') {
      this.ensureOwned(epoch, signal)
      if (
        shouldAbortUnproductivePillar({
          vertical: activeVertical,
          verticalStep,
          startY,
          currentY: this.bot.entity.position.y,
          targetY: target.y,
        })
      ) {
        throw new ExecutorError(
          'path_stuck',
          `${candidate.id} pillar ascent made no durable height toward y=${target.y}`,
        )
      }
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
      // Preserve bounded ascent as durable MOVE progress. The committed walk's
      // OWN loop now re-plans the next vertical chunk from the new Y (the same
      // target, no new decision); if the loop's budget ends here the chunk is
      // still durable progress evidence on the settled result.
      if (
        shouldReplanAfterVerticalChunk({
          verticalStep,
          startY,
          currentY: this.bot.entity.position.y,
          targetY: target.y,
        })
      ) {
        const direction = climbedTo > startFloorY ? 'climbed' : 'descended'
        return {
          // A bounded vertical chunk is NOT the committed arrival: the MOVE's own
          // contract is the destination cell, so the loop keeps the commitment and
          // re-plans the SAME target. `verified: true` stays as the existing
          // durable-progress evidence on the result.
          arrived: false,
          result: this.buildResult(
            candidate,
            epoch,
            startedAt,
            'done',
            'arrived',
            `${direction} from y=${startFloorY} to y=${climbedTo} toward y=${target.y} (bounded vertical chunk of the committed walk)`,
            null,
            {
              verified: true,
              blockRemoved: dugVertical && verticalStep,
              dropObserved: false,
              itemsGained: 0,
              goalItemCount: this.countGoalItem(),
              progressed: true,
            },
          ),
        }
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
      await this.pathTo(target, epoch, signal, 'GoalBlock', {
        anchor,
        requireLevel: true,
        budgetMs: stageMs,
        // A RETRY of the SAME committed target (the first leg is byte-identical
        // to the pre-loop behaviour) tightens arrival to the committed cell.
        ...(strictArrival
          ? { range: WALK_STRICT_ARRIVAL_RANGE, tolerance: WALK_STRICT_ARRIVAL_TOLERANCE }
          : {}),
      })
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      this.ensureOwned(epoch, signal)
      pathError = error
    }
    // LEG TRAVEL (#352): a MOVE to a far target fails the same way a far
    // RETRIEVE does - the exact destination cell may be unpathable while its
    // neighbourhood is reachable, so a direct `GoalBlock` path is refused and
    // the body never closes the distance. Retry the SAME target with ONE
    // committed leg at `LEG_TRAVEL_RADIUS`. A leg is body progress and NEVER
    // arrival: `verified` below stays false unless `classifyMoveArrival` proves
    // the destination, so the goal remains open for the next decision. A leg
    // that closes less than `LEG_TRAVEL_MIN_PROGRESS` keeps the original typed
    // failure (no false progress, bounded by the move-failure memory).
    let legProgressed = false
    if (pathError !== null) {
      const leg = await this.runTravelLeg(
        candidate,
        target,
        epoch,
        signal,
        Math.max(1, (remainingMs ?? this.options.pathTimeoutMs) - stageMs),
      )
      if (leg.decision.progressed) {
        legProgressed = true
        pathError = null
      } else if (leg.error !== null) {
        pathError = leg.error
      }
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
    return {
      arrived: verified,
      result: this.buildResult(
        candidate,
        epoch,
        startedAt,
        'done',
        legProgressed && !verified ? 'leg' : 'arrived',
        legProgressed && !verified
          ? `travel leg toward (${target.x},${target.y},${target.z}); target not reached (goal stays open)`
          : `moved from ${round2(before)}m to ${round2(after)}m`,
        null,
        {
          verified,
          blockRemoved: false,
          dropObserved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
          progressed: legProgressed,
        },
      ),
    }
  }

  /**
   * The bounded BRIDGE/scaffold leg (operator proposal 2026-09-23, adopted as a
   * general MOVE mechanic; `bridgeRoute.ts` owns the grounding rule).
   *
   * The motor recipe, one placement per iteration, is deliberately the SIMPLEST
   * shape the existing motor layer supports - no packet tricks, no client mod, no
   * physics bypass; every step is ordinary `bot.placeBlock` + ordinary walk, so the
   * server validates all of it:
   *
   *   1. stand on the last VERIFIED cell (the body's own footing is the placement
   *      reference - the human "place against the block you are standing on"
   *      scaffold gesture, a legal vanilla side-face placement);
   *   2. re-probe the SAME direction live (`probeBridgeDirection`) and re-run the
   *      SAME rule (`planBridgeSpan`) the offer used: the landing column must be
   *      open, the placement cell replaceable air, the column hazard-free, and a
   *      verified stand must bound the span. Nothing is placed on faith;
   *   3. equip the declared block and place it into the landing's floor cell;
   *   4. verify the block is REALLY there (`waitForPlacedBlock` + postcondition);
   *   5. only then advance onto it, and require the body to actually occupy the
   *      landing cell and the distance to the leg target to strictly shrink.
   *
   * SAFETY (the "never strand the body" half): a placement is never followed by a
   * step into an unverified cell, so the body only ever stands on a cell whose
   * support was read from the live world. Any interruption (lease lost, epoch
   * change, abort, failed advance) leaves the body standing on the previous
   * verified cell and emits the typed `BRIDGE_END ... verified=false reason=...`,
   * never a half-bridge the body then walks off. Lava/fire/water is refused at the
   * placement cell and anywhere in the probed column.
   *
   * The budget is the offer's own verified span, hard-capped by `BRIDGE_STEP_CAP`.
   */
  private async runBridge(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', 'BRIDGE candidate has no coordinates')
    const dirMeta = readMetaString(candidate, BRIDGE_DIR_META)
    const block = readMetaString(candidate, BRIDGE_BLOCK_META)
    if (!isBridgeDir(dirMeta) || block === null) {
      throw new ExecutorError(
        'target_gone',
        `${candidate.id} carries no grounded bridge contract (dir=${dirMeta ?? 'none'} block=${block ?? 'none'})`,
      )
    }
    const dir = dirMeta
    const declaredSpan = Math.floor(readMetaNumber(candidate, BRIDGE_SPAN_META, 1))
    const budget = Math.max(1, Math.min(declaredSpan, BRIDGE_STEP_CAP))
    const from = this.distanceToFeet(target)
    const firstLanding = this.bridgeCell(feetCellOf(this.bot), dir, 0)
    let placed = 0
    let reason = 'reached'
    // The typed `no_block` refusal at execution time: the item the offer declared
    // may have left the inventory between the decision and the lease (a death, a
    // drop, another placement). No block means no bridge, and it says so.
    if (this.countHeld(block) < 1) {
      const refusal: BridgeRefusal = {
        reason: 'no_block',
        cell: firstLanding,
        target,
        block,
        detail: `${block} is no longer in the inventory (held=0)`,
      }
      this.logBridgeRefused(candidate, refusal)
      this.logBridgeEnd(candidate, 0, false, 'no_block')
      return this.buildResult(
        candidate,
        epoch,
        startedAt,
        'failed',
        'bridging',
        `bridge ${dir} refused: ${refusal.detail}`,
        'target_gone',
        {
          verified: false,
          blockRemoved: false,
          dropObserved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
          progressed: false,
        },
      )
    }
    this.setPhase(candidate, epoch, 'bridging')
    this.logger.info(
      'agent',
      formatBridgeStart({
        cell: firstLanding,
        block,
        span: budget,
        remaining: Math.max(0, this.countHeld(block) - budget),
      }),
      {
        actionId: candidate.id,
        target,
        dir,
        span: budget,
        held: this.countHeld(block),
        // #436 section 5: the declared effect travels with the marker, so a
        // reviewer reads "this leg places blocks and consumes this item".
        mayPlaceBlocks: true,
        consumes: block,
      },
    )
    try {
      // `budget + 1` iterations: the placements are still bounded by `budget`
      // (checked below), and the extra iteration is what lets the crossing FINISH
      // with the ordinary adjacent walk onto an already-verified far side instead
      // of stopping one cell short and re-deciding.
      for (let step = 0; step < budget + 1; step += 1) {
        this.ensureOwned(epoch, signal)
        const here = feetCellOf(this.bot)
        if (sameCell(here, target)) {
          reason = 'reached'
          break
        }
        const probe = probeBridgeDirection(this.bot, here, dir, BRIDGE_PROBE_DEPTH)
        const decision = planBridgeSpan({ probe, selfFeet: here, target })
        if (decision.kind === 'not_a_gap') {
          // The next cell in this direction is ALREADY a verified stand (the far
          // side the span was planned against, or ordinary ground). When it is the
          // leg's own target, the crossing finishes with an ordinary adjacent walk -
          // no placement, so nothing is created on faith. Otherwise the gap is
          // closed and the ordinary walk arms own the rest of the route from the
          // next decision.
          const next = probe.cells[0]
          if (next !== undefined && next.standable && sameCell(next.cell, target)) {
            this.setPhase(candidate, epoch, 'pathing')
            try {
              await this.pathTo(target, epoch, signal, 'GoalBlock', { requireLevel: true })
            } catch (error) {
              if (error instanceof ActionCancelled) throw error
              reason = 'advance_failed'
              break
            }
            this.ensureOwned(epoch, signal)
            if (!sameCell(feetCellOf(this.bot), target)) {
              reason = 'advance_failed'
              break
            }
            reason = 'reached'
            break
          }
          reason = 'gap_closed'
          break
        }
        if (decision.kind === 'refuse') {
          reason = decision.refusal.reason
          this.logBridgeRefused(candidate, decision.refusal)
          break
        }
        const span = decision.span
        if (span.span > budget - placed) {
          reason = 'budget'
          this.logBridgeRefused(candidate, {
            reason: 'budget',
            cell: span.landing,
            target,
            block: null,
            detail: `the live verified span (${span.span}) exceeds this leg's remaining budget (${budget - placed})`,
          })
          break
        }
        if (this.placementCellOverlapsBody(span.place)) {
          reason = 'no_verified_landing'
          this.logBridgeRefused(candidate, {
            reason: 'no_verified_landing',
            cell: span.place,
            target,
            block: null,
            detail: `the placement cell (${span.place.x},${span.place.y},${span.place.z}) is inside the body`,
          })
          break
        }
        // SAFE, immediately before the side effect (the same stop a station
        // placement takes): a body out of breath does not keep building.
        this.requireBreath(candidate, span.place, 'placing a bridge block')
        const reference = this.bridgeReference(here, dir, span.place)
        if (reference === null) {
          reason = 'no_verified_landing'
          this.logBridgeRefused(candidate, {
            reason: 'no_verified_landing',
            cell: span.place,
            target,
            block: null,
            detail: `no solid adjacent face to place against at (${span.place.x},${span.place.y},${span.place.z})`,
          })
          break
        }
        await this.equipPlacementItem(candidate, block, epoch, signal)
        this.setPhase(candidate, epoch, 'placing')
        // issue #436 section 5/27: the placement goes through the SAME
        // effect-envelope gate (and section 17 step evidence) as every other
        // mechanical step, so a bridge cell outside its declared span fails
        // closed instead of silently widening the envelope.
        this.assertEffect({ type: 'place', position: span.place, itemName: block })
        try {
          await this.bot.placeBlock(reference.block, reference.face)
        } catch (error) {
          if (error instanceof ActionCancelled || error instanceof ExecutorError) throw error
          const observed = this.currentBlockAt(span.place)?.name ?? null
          const message = error instanceof Error ? error.message : String(error)
          throw new ExecutorError(
            'place_refused',
            `bridge placement of ${block} at (${span.place.x},${span.place.y},${span.place.z}) was rejected; observed block is ${observed ?? 'unknown'} (${message})`,
          )
        }
        this.ensureOwned(epoch, signal)
        const placedName = await this.waitForPlacedBlock(span.place, block, epoch, signal)
        if (!isPlacePostconditionMet(placedName, block)) {
          reason = 'unverified_place'
          this.logBridgeRefused(candidate, {
            reason: 'no_verified_landing',
            cell: span.place,
            target,
            block,
            detail: `placeBlock did not create ${block} at (${span.place.x},${span.place.y},${span.place.z}) (found ${placedName ?? 'air'})`,
          })
          break
        }
        const before = this.distanceToFeet(target)
        this.setPhase(candidate, epoch, 'pathing')
        try {
          // The landing is one level step away over a block that is NOW there: an
          // ordinary adjacent walk, never a jump and never a step into a hole.
          await this.pathTo(span.landing, epoch, signal, 'GoalBlock', { requireLevel: true })
        } catch (error) {
          if (error instanceof ActionCancelled) throw error
          // The block IS placed and the body is still standing on the previous
          // verified cell: a typed partial leg, never a half-bridge it walks off.
          reason = 'advance_failed'
          break
        }
        this.ensureOwned(epoch, signal)
        const landed = feetCellOf(this.bot)
        if (!sameCell(landed, span.landing)) {
          reason = 'advance_failed'
          break
        }
        const after = this.distanceToFeet(target)
        if (!(after < before)) {
          reason = 'no_progress'
          break
        }
        placed += 1
        this.logger.info('agent', formatBridgeStep({ from: here, to: landed, block }), {
          actionId: candidate.id,
          target,
          dir,
          block,
          mayPlaceBlocks: true,
          placed,
        })
      }
    } catch (error) {
      // Interruption: the body stands on the last VERIFIED cell by construction.
      this.logBridgeEnd(candidate, placed, false, error instanceof ActionCancelled ? 'interrupted' : 'aborted')
      throw error
    }
    const arrived = sameCell(feetCellOf(this.bot), target)
    const remaining = this.distanceToFeet(target)
    const verified = arrived || (placed > 0 && remaining <= from - BRIDGE_MIN_ADVANCE)
    this.logBridgeEnd(candidate, placed, verified, reason)
    const detail =
      `bridge ${dir}: placed=${placed} from_d=${round2(from)} to_d=${round2(remaining)} ` +
      `reason=${reason} verified=${verified}`
    // Observable change: a real placement, or a real measured distance gain. A
    // stale candidate that was already standing on its target claims neither.
    const closedDistance = remaining <= from - BRIDGE_MIN_ADVANCE
    if (placed > 0 || arrived || closedDistance) {
      return this.buildResult(candidate, epoch, startedAt, 'done', arrived ? 'arrived' : 'leg', detail, null, {
        verified,
        blockRemoved: false,
        dropObserved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
        // A bridge that really placed a block and advanced is observable progress
        // even when the declared far side was not reached in this leg.
        progressed: placed > 0 || closedDistance,
      })
    }
    return this.buildResult(candidate, epoch, startedAt, 'failed', 'bridging', detail, bridgeFailureCode(reason), {
      verified: false,
      blockRemoved: false,
      dropObserved: false,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
      progressed: false,
    })
  }

  /** The block the bridge body is standing on: the face it places against. */
  private bridgeReference(
    feet: Vec3Json,
    dir: BridgeDir,
    place: Vec3Json,
  ): { block: Block; face: ReturnType<Bot['entity']['position']['clone']> } | null {
    const { dx, dz } = bridgeDirOffset(dir)
    const footing = this.currentBlockAt({ x: feet.x, y: feet.y - 1, z: feet.z })
    if (footing !== null && isUsableGroundSupport(footing)) {
      // The human scaffold gesture: the block currently under the feet, its side
      // face in the direction of travel. Legal vanilla placement, always in reach.
      return { block: footing, face: this.bot.entity.position.clone().set(dx, 0, dz) }
    }
    // Fallback: any solid adjacent face of the placement cell.
    return this.findPlaceReference(place)
  }

  /**
   * The LANDING cell `offset + 1` columns ahead of `feet` in `dir` (offset 0 = the
   * first landing the first placement creates). Used only for the `BRIDGE_START`
   * line's `cell=`, which names the first cell the body will stand on.
   */
  private bridgeCell(feet: Vec3Json, dir: BridgeDir, landingOffset: number): Vec3Json {
    const { dx, dz } = bridgeDirOffset(dir)
    const step = landingOffset + 1
    return { x: feet.x + dx * step, y: feet.y, z: feet.z + dz * step }
  }

  private countHeld(itemName: string): number {
    let total = 0
    for (const item of this.bot.inventory.items()) if (item.name === itemName) total += item.count
    return total
  }

  private logBridgeRefused(candidate: Candidate, refusal: BridgeRefusal): void {
    this.logger.warn('agent', formatBridgeRefused(refusal), {
      actionId: candidate.id,
      reason: refusal.reason,
      cell: refusal.cell,
      block: refusal.block,
      target: refusal.target,
    })
  }

  private logBridgeEnd(candidate: Candidate, placed: number, verified: boolean, reason: string): void {
    this.logger.info('agent', formatBridgeEnd({ placed, verified, reason }), {
      actionId: candidate.id,
      placed,
      verified,
      reason,
    })
  }

  /**
   * The committed RETRIEVE walks to its remembered resource inside ONE bounded,
   * closed-loop harness-layer Skill (issue #436 section 3 / OPERATOR DIRECTIVE
   * 2026-09-23): the vertical contract chunk, the horizontal approach, the travel
   * leg, a mechanically blocked step and the retry from the new position are all
   * MECHANICAL_CONTINUATION of the one selection - never a new Jev decision per
   * leg. Policy is re-entered only at a semantic boundary (`walkSkill.ts`).
   */
  private async runRetrieve(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    return await this.runWalkSkill(candidate, epoch, signal, startedAt, (legSignal, strict, remainingMs) =>
      this.runRetrieveLeg(candidate, epoch, legSignal, startedAt, strict, remainingMs),
    )
  }

  /**
   * The PICKUP runner: walk onto a SENSED DROPPED ITEM ENTITY and prove the item
   * reached the inventory.
   *
   * A dropped item is an entity, and pickup is the SERVER's: Mineflayer sends
   * nothing and only observes the inbound `collect` packet (mineflayer 4.39.0
   * `lib/plugins/entities.js`). The body's whole job is therefore to get inside
   * the item's pickup volume, which is exactly what the existing bounded
   * `collectDrop` loop does (stock `collectBlock`, then the direct control nudge,
   * re-locating the item entity by name each poll because a drop keeps falling
   * for a few ticks).
   *
   * This runner exists so that walk is reachable from a DECISION, not only from
   * inside another action's tail. Its post-condition is the INVENTORY DELTA -
   * arrival at the drop's cell proves nothing (the item is not a destination, it
   * is a thing to acquire), so a walk that ends next to an uncollected drop is a
   * typed `pickup_failed`, never a success.
   */
  private async runPickup(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const itemName = readMetaString(candidate, 'pickupItem') ?? candidate.itemName
    if (itemName === null) throw new ExecutorError('pickup_failed', 'PICKUP candidate names no item')
    const target = candidate.target
    if (target === null) throw new ExecutorError('pickup_failed', `PICKUP candidate for ${itemName} has no position`)
    const before = this.countItem(itemName)
    this.setPhase(candidate, epoch, `pickup-${itemName}`)
    const report = await this.collectDrop(target, itemName, before, false, epoch, signal)
    const gained = report.itemsGained
    if (gained <= 0) {
      // The drop is a WORLD fact, not a route: the honest outcome names the item,
      // the entity it was last seen at, and whether the entity was still visible
      // - so "the item was never there" and "the body could not reach it" cannot
      // be read as the same event.
      this.logger.warn(
        'executor',
        `PICKUP_NOT_ACQUIRED actionId=${candidate.id} item=${itemName} entity=e${candidate.targetEntityId ?? 'unknown'} ` +
          `dropObserved=${report.dropObserved} goalItemCount=${report.goalItemCount} ms=${report.settledMs} ` +
          `-> the item did not reach the inventory`,
        { actionId: candidate.id, item: itemName, target, itemsGained: 0 },
      )
      throw new ExecutorError(
        'pickup_failed',
        report.dropObserved
          ? `dropped ${itemName} was located but did not reach the inventory`
          : `no dropped ${itemName} entity found near (${target.x},${target.y},${target.z})`,
      )
    }
    this.logger.info(
      'executor',
      `PICKUP_ACQUIRED actionId=${candidate.id} item=${itemName} entity=e${candidate.targetEntityId ?? 'unknown'} ` +
        `gained=${gained} ${itemName}_in_inventory=${report.goalItemCount} ms=${report.settledMs}`,
      { actionId: candidate.id, item: itemName, target, itemsGained: gained },
    )
    const result = this.buildResult(
      candidate,
      epoch,
      startedAt,
      'done',
      'picked-up',
      `picked up ${gained}x ${itemName} from the dropped item entity`,
      null,
      {
        verified: true,
        dropObserved: report.dropObserved,
        blockRemoved: false,
        itemsGained: gained,
        goalItemCount: report.goalItemCount,
      },
    )
    result.yieldItem = itemName
    return result
  }

  /** ONE bounded mechanical leg of a committed RETRIEVE (the pre-loop behaviour). */
  private async runRetrieveLeg(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
    strictArrival = false,
    remainingMs?: number,
  ): Promise<WalkLegExecution> {
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
    if (
      shouldAbortUnproductivePillar({
        vertical: activeVertical,
        verticalStep,
        startY,
        currentY: this.bot.entity.position.y,
        targetY: target.y,
      })
    ) {
      throw new ExecutorError(
        'path_stuck',
        `${candidate.id} pillar ascent made no durable height toward y=${target.y}`,
      )
    }
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
      return {
        arrived: false,
        result: this.buildResult(
          candidate,
          epoch,
          startedAt,
          'done',
          'retrieved',
          `${direction} from y=${startFloorY} to y=${climbedTo} toward y=${target.y} (bounded vertical chunk of the committed retrieval)`,
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
        ),
      }
    }
    this.setPhase(candidate, epoch, 'approaching')
    let approachError: ExecutorError | null = null
    try {
      await this.pathToNear(target, strictArrival ? WALK_STRICT_ARRIVAL_RANGE : RETRIEVE_ARRIVAL_RADIUS, epoch, signal, {
        budgetMs: walkStageBudgetMs(
          remainingMs ?? this.options.pickupPathTimeoutMs,
          classifyTravelLeg({ remainingBefore: this.distanceToFeet(target), remainingAfter: this.distanceToFeet(target) })
            .warranted,
        ),
      })
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
    // LEG TRAVEL (#352): a direct arrival path to a target beyond the path
    // probe's range rarely exists, and failing outright leaves a far goal
    // unreachable forever. Live: `RETRIEVE:known:obsidian:b28_67_9` was chosen
    // every tick from (195.6, 68, -14.5) with all seven remembered obsidian cells
    // 169-172m away, the body never moved and `obsidian=0`, so the M2 portal frame
    // could never be built. When the arrival approach failed and the target is
    // still far, walk ONE committed leg with a wider radius toward it and let the
    // next tick re-plan from the new position. The leg is progress, never arrival:
    // the arrival post-condition stays owned by later ticks, and a leg that does
    // not close distance keeps the original typed failure (no false progress).
    if (approachError !== null) {
      const leg = await this.runTravelLeg(candidate, target, epoch, signal)
      if (leg.decision.progressed) {
        // A leg is BODY progress only. Clear the typed approach failure so the
        // classifier below reports `progressed` (never arrival) and the final
        // "target reached" post-condition stays owned by the next decision from
        // the new position.
        approachError = null
      } else if (leg.error !== null) {
        // No positional progress: keep the typed failure so the move-failure
        // memory bounds the target (no infinite leg loop).
        approachError = leg.error
      }
    }
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
    // A vertical leg is only a bounded continuation when the horizontal
    // approach itself did not fail.  If pathToNear raised a typed failure and
    // the target is still outside the arrival radius, returning a soft
    // progressed/done result hides the error and lets the same RETRIEVE reset
    // its failure memory forever.  Preserve the original mechanical failure;
    // the controller's bounded retry/retirement path must see it.
    if (approachError !== null && !approach.arrived) {
      throw approachError
    }
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
    return {
      arrived: verified,
      result: this.buildResult(candidate, epoch, startedAt, 'done', 'retrieved', `approached remembered resource from ${round2(before)}m to ${round2(after)}m (${approach.outcome})`, null, {
        verified,
        blockRemoved: dugVertical && verticalStep,
        dropObserved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
        progressed: outcome.progressed,
        distanceClosed: approach.closed,
      }),
    }
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
        await this.pathTo(step, epoch, signal, goalKind, { requireLevel: true })
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        throw error instanceof ExecutorError
          ? error
          : new ExecutorError('path_stuck', `vertical step failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!isAtRequiredLevel(this.bot.entity.position, step)) {
        throw new ExecutorError(
          'path_stuck',
          `vertical step did not reach (${step.x},${step.y},${step.z}) from (${round2(this.bot.entity.position.x)},${round2(this.bot.entity.position.y)},${round2(this.bot.entity.position.z)})`,
        )
      }
      return false
    }
    this.setPhase(candidate, epoch, 'digging')
    const live = this.resolveLiveDigTool(block)
    if (!live.ok) {
      this.lastVerticalFailureReason = `dig_refused:${live.reason}`
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
      this.lastVerticalFailureReason = 'dig_failed'
      this.logger.warn('executor', `RETRIEVE staircase dig failed: ${error instanceof Error ? error.message : String(error)}`, {
        actionId: candidate.id,
      })
      return false
    }
    this.ensureOwned(epoch, signal)
    this.setPhase(candidate, epoch, 'stepping')
    try {
      await this.pathTo(step, epoch, signal, goalKind, { requireLevel: true })
    } catch (error) {
      if (error instanceof ActionCancelled) throw error
      throw error instanceof ExecutorError
        ? error
        : new ExecutorError('path_stuck', `vertical step failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isAtRequiredLevel(this.bot.entity.position, step)) {
      throw new ExecutorError(
        'path_stuck',
        `vertical step did not reach (${step.x},${step.y},${step.z}) from (${round2(this.bot.entity.position.x)},${round2(this.bot.entity.position.y)},${round2(this.bot.entity.position.z)})`,
      )
    }
    return true
  }

  /**
   * Execute the candidate's grounded vertical contract ONCE - the same
   * `vertical=reuse|staircase|staircase-up|pillar` meta every other
   * "get to a cell" candidate (MINE/MOVE/RETRIEVE) carries. Returns the active
   * leg name and whether it produced a durable step. Shared by `runMove` and
   * `runEnterPortal`, so the portal entry approach can never drift back into a
   * bare `pathTo` walk with no dig/vertical route.
   */
  private async runVerticalContract(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    target: Vec3Json,
    startY: number,
  ): Promise<{ activeVertical: string; verticalStep: boolean }> {
    const vertical = readMetaString(candidate, 'vertical') ?? 'none'
    let activeVertical = vertical
    let verticalStep = false
    this.lastVerticalFailureReason = null
    if (vertical === 'none') return { activeVertical, verticalStep }
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
    return { activeVertical, verticalStep }
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
      await this.pathToNear(tunnel, 1, epoch, signal, { requireLevel: true })
      if (!isAtRequiredLevel(this.bot.entity.position, tunnel)) {
        throw new ExecutorError(
          'path_stuck',
          `tunnel entry did not reach (${tunnel.x},${tunnel.y},${tunnel.z}) from (${round2(this.bot.entity.position.x)},${round2(this.bot.entity.position.y)},${round2(this.bot.entity.position.z)})`,
        )
      }
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
          await this.pathToNear(tunnel, 1, epoch, signal, { requireLevel: true })
          if (!isAtRequiredLevel(this.bot.entity.position, tunnel)) {
            throw new ExecutorError(
              'path_stuck',
              `tunnel entry did not reach (${tunnel.x},${tunnel.y},${tunnel.z}) after clearance`,
            )
          }
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
      this.lastVerticalFailureReason = 'no_place_item'
      this.logger.warn('executor', `PILLAR_UP refused: ${placeName} is not in the inventory`, { actionId: candidate.id })
      return false
    }
    if (this.pillarColumnUnsafe()) {
      this.lastVerticalFailureReason = 'unsafe_column'
      this.logger.warn('executor', 'PILLAR_UP refused: liquid or hazard in the bot column', { actionId: candidate.id })
      return false
    }
    this.logger.info('agent', formatPillarSearch(decidePillarPlaceBlock(this.inventoryCounts(), PILLAR_SEARCH_POLICY)), {
      actionId: candidate.id,
    })
    const budget = decidePillarStepBudget(toY - Math.floor(this.bot.entity.position.y), PILLAR_SEARCH_POLICY)
    this.logger.info('agent', formatPillarSearch(budget), { actionId: candidate.id })
    this.setPhase(candidate, epoch, 'equipping')
    this.assertEffect({ type: 'equip', itemName: item.name, destination: 'hand' })
    await this.bot.equip(item, 'hand')
    this.ensureOwned(epoch, signal)
    const solidAt: SolidAt = (x, y, z) => this.solidSupportAt(x, y, z)
    // Physics on, and the stale onGround flag patched from the block grid -
    // but ONLY while the body is settled. Re-grounding a body that is mid-jump
    // freezes it at the launch height (see `installClimbGroundCorrection`), so
    // the correction is suppressed for the whole flight of each pillar step.
    // The step's own `jumpWithGroundCorrection` still grounds the launch.
    let jumping = false
    const savedPhysics = this.bot.physicsEnabled
    const uninstallGroundCorrection = installClimbGroundCorrection(this.bot, solidAt, () => jumping)
    this.bot.physicsEnabled = true
    try {
      let climbed = 0
      let relocations = 0
      let attemptSequence = 0
      // Per vertical step/column. A server-refused place that left the target
      // cell empty gets one bounded retry inside this Skill; it never escapes as
      // a fresh route decision unless that retry also fails.
      let sameColumnPlaceRetries = 0
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
            this.lastVerticalFailureReason = 'no_footing'
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
            this.lastVerticalFailureReason = placeStack === undefined ? 'no_placeable' : 'no_footing'
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
        // The block this step places rests on the live footing, so the footing is
        // read before the pure gate: a leaf canopy is solid enough for the server
        // to accept the placement, but it is not ground. The operator photographed
        // exactly that (run-mubobiq6-12onv: a cobblestone block on a treetop while
        // the body climbed a canopy it had no reason to be in), so the pillar
        // refuses with the typed `canopy_footing` instead of building there.
        const footing = this.currentBlockAt({ x: feet.x, y: pose.footingY, z: feet.z })
        const step = evaluatePillarStep({
          placeableCount: placeStack.count,
          columnSafe,
          remaining: maxSteps - climbed,
          footingSolid: footing !== null && footing.boundingBox === 'block',
          footingUsable: footing !== null && isUsableGroundSupport(footing),
          headroomClear: headroom !== null && headroom.cleared,
        })
        if (!step.ok) {
          const blocked = headroom !== null && !headroom.cleared ? headroom : null
          if (step.reason !== 'reached') {
            this.lastVerticalFailureReason = step.reason
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
          this.assertEffect({ type: 'equip', itemName: held.name, destination: 'hand' })
          await this.bot.equip(held, 'hand')
          this.ensureOwned(epoch, signal)
        }
        // Re-read immediately before the placement: the gate above answered from
        // the footing read a few steps (and one headroom dig/equip) earlier, and a
        // canopy footing must never reach `placeBlock` even if the world changed
        // between the two reads.
        const liveFooting = this.currentBlockAt({ x: feet.x, y: pose.footingY, z: feet.z })
        if (liveFooting === null || liveFooting.boundingBox !== 'block') break
        if (!isUsableGroundSupport(liveFooting)) {
          this.lastVerticalFailureReason = 'canopy_footing'
          this.logger.warn(
            'executor',
            formatPillarRefused({ reason: 'canopy_footing', cell: feet, obstacle: null }),
            { actionId: candidate.id, ...feet, footing: liveFooting.name },
          )
          break
        }
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
        // Suppress the persistent climb grounding for the whole flight: the
        // takeoff's own correction handles the launch, and re-grounding the
        // airborne body would freeze the arc at the launch height.
        jumping = true
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
            place: (face) => {
              this.assertEffect({ type: 'place', position: face, itemName: placeName })
              return this.bot.placeBlock(liveFooting, toVec3(this.bot, face))
            },
            blockPlaced: () => this.currentBlockAt(placeCell)?.boundingBox === 'block',
          },
          { feetCell: feet, placeCell, support: liveFooting.position },
        )
        jumping = false
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
          this.lastVerticalFailureReason = climb.fail.reason ?? climb.fail.step
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
            supportName: liveFooting.name,
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
          const blockPlaced = this.currentBlockAt(placeCell)?.boundingBox === 'block'
          const recovery = decidePillarFailureRecovery(
            climb.fail,
            refusalEvidence,
            blockPlaced,
            sameColumnPlaceRetries,
          )
          if (isPillarRefusalUnsatisfiable(climb.fail, refusalEvidence)) {
            this.logger.warn('executor', formatPillarRetire(feet, refusalEvidence), {
              actionId: candidate.id,
              step: climb.fail.step,
              reason: climb.fail.reason,
              required: requiredColumnClearance(feet.y, pose.placeY),
              achievable: refusalEvidence.achievableRise,
            })
          }
          if (recovery === 'retry_same_column') {
            sameColumnPlaceRetries += 1
            this.logger.info(
              'agent',
              `PILLAR_RETRY cell=${feet.x},${feet.y},${feet.z} reason=place_refused attempt=${sameColumnPlaceRetries}/1`,
              { actionId: candidate.id, placeCell, blockPlaced },
            )
            // `pillarStepUp` returns immediately when the placement packet is
            // refused, so the body can still be descending. Retry only after the
            // same support cell is authoritatively grounded again.
            if (await this.waitForPillarRetrySettle(feet, epoch, signal)) continue
            this.logger.warn('executor', `PILLAR_RETRY refused: body did not settle back in (${feet.x},${feet.y},${feet.z})`, {
              actionId: candidate.id,
            })
            break
          }
          if (recovery === 'relocate') {
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
              sameColumnPlaceRetries = 0
              continue
            }
          }
          break
        }
        climbed += 1
        sameColumnPlaceRetries = 0
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
      this.setControlState('jump', false)
    }
  }

  /**
   * After a side-effect-free server refusal, wait boundedly for the body to
   * return to the same grounded feet cell before sending the one retry.
   */
  private async waitForPillarRetrySettle(
    expectedFeet: Vec3Json,
    epoch: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + PILLAR_LANDING_BUDGET_MS
    while (Date.now() < deadline) {
      this.ensureOwned(epoch, signal)
      const position = this.bot.entity.position
      const feet = {
        x: Math.floor(position.x),
        y: Math.floor(position.y + 1e-4),
        z: Math.floor(position.z),
      }
      if (
        feet.x === expectedFeet.x &&
        feet.y === expectedFeet.y &&
        feet.z === expectedFeet.z &&
        this.bot.entity.onGround &&
        this.solidSupportAt(feet.x, feet.y - 1, feet.z)
      ) {
        return true
      }
      await delay(PILLAR_TAKEOFF_POLL_MS, signal)
    }
    return false
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
   * The bounded landing window: the movement policy's OWN `maxDropDown`, so this
   * guard refuses exactly the steps the `canDig=false` planner would never have
   * planned and leaves every legal drop untouched.
   */
  private moveStepLandingWindow(): number {
    const movements = (
      this.bot.pathfinder as unknown as { movements?: { maxDropDown?: number } } | undefined
    )?.movements
    const configured = movements?.maxDropDown
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1) {
      return Math.min(Math.floor(configured), MOVE_STEP_LANDING_WINDOW_MAX)
    }
    return MOVE_STEP_LANDING_WINDOW_DEFAULT
  }

  /** Read the landing cell, its head cell and the bounded column under it. */
  private readStepLanding(landing: Vec3Json): StepLandingReads {
    const at = (y: number): StepLandingBlock | null => {
      const block = this.currentBlockAt({ x: landing.x, y, z: landing.z })
      return block === null ? null : { name: block.name, boundingBox: block.boundingBox }
    }
    const below: Array<StepLandingBlock | null> = []
    for (let depth = 1; depth <= this.moveStepLandingWindow(); depth += 1) below.push(at(landing.y - depth))
    return { landing: at(landing.y), head: at(landing.y + 1), below }
  }

  /**
   * THE PER-STEP LANDING GUARD (measured defect run-mucdemk5-1kg6b).
   *
   * Asked once per step, BEFORE the body is actuated: does the step's landing
   * column hold real ground within the movement policy's own drop bound, and is
   * the landing cell itself free of a hazard? Reads only already-sensed cells
   * (`bot.blockAt`), runs no A*, and never re-plans: a refusal logs the typed
   * `MOVE_LEG_STOPPED` line, throws the same typed `ExecutorError`, and leaves
   * the body standing exactly where it is, so the decision returns to the policy
   * layer that owns WHICH destination/action comes next (#436).
   */
  private guardStepLanding(target: Vec3Json, landing: Vec3Json): void {
    const feet = this.bot.entity.position
    const from = {
      x: Math.floor(feet.x),
      y: Math.floor(feet.y + 0.1),
      z: Math.floor(feet.z),
    }
    // A probe that resolves to the body's own column is not a step (a near-zero
    // or backward heading): the body's own support is not this guard's question.
    if (from.x === landing.x && from.z === landing.z && from.y === landing.y) return
    const verdict = classifyStepLanding(this.readStepLanding(landing))
    if (verdict.reason === null) return
    const detail = {
      actionId: this.action?.id ?? 'unknown',
      target,
      reason: verdict.reason,
      from,
      to: landing,
      block: verdict.block ?? STEP_SUPPORT_UNKNOWN,
      support: verdict.support,
    }
    this.logger.warn(
      'executor',
      formatMoveLegStopped({
        reason: verdict.reason,
        from,
        to: landing,
        block: verdict.block,
        support: verdict.support,
      }),
      detail,
    )
    throw new ExecutorError(
      verdict.reason,
      `${verdict.reason} before the step to (${landing.x},${landing.y},${landing.z}): block=${
        verdict.block ?? STEP_SUPPORT_UNKNOWN
      } support=${verdict.support}`,
    )
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
    // issue #436 section 5: this control-walk is locomotion toward the SELECTED
    // destination; it is inside `mayMove` for any Skill that declares it.
    this.assertEffect({ type: 'move' })
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
        return isAtRequiredLevel(position, target, tolerance)
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
          this.setControlState('forward', false)
          this.setControlState('jump', false)
          this.setControlState('back', true)
          await delay(50, signal)
          continue
        }
        this.setControlState('back', false)

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
          this.assertEffect({ type: 'look' })
          await this.bot.lookAt(this.bot.entity.position.offset(dx, 0, dz), true).catch(() => undefined)
          // PER-WAYPOINT PRE-STEP GUARD (measured defect run-mucecx3h-1ljqz /
          // run-mucdemk5-1kg6b): the committed leg's own next step is validated
          // BEFORE any control state is set. `noPath` from the canDig=false
          // pathfinder routinely hands the leg to this control walker, which then
          // held `forward` with physics on and walked the body off a fortress
          // walkway into the lava lake below; `policy.guardMove` had only
          // validated the FINAL target cell and this walker only headroom. A
          // refusal stops the leg where the body stands (the `finally` below
          // releases every control state) and returns the typed reason to the
          // policy - the guard never re-plans a route, pillars or digs (that is
          // Jev's WHICH).
          this.guardStepLanding(target, {
            x: Math.floor(position.x + ux * MOVE_STEP_PROBE_DISTANCE),
            y: Math.floor(position.y + 0.1),
            z: Math.floor(position.z + uz * MOVE_STEP_PROBE_DISTANCE),
          })
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
          this.setControlState('back', false)
          this.setControlState('forward', true)
          this.setControlState('jump', true)
          const beforeJump = this.bot.entity.position.clone()
          await delay(110, signal)
          this.setControlState('jump', false)
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
          this.setControlState('forward', hopPlan.holdForward)
          this.setControlState('jump', true)
          await delay(hopPlan.riseMs, signal)
          this.setControlState('jump', false)
          this.setControlState('forward', true)
          await delay(hopPlan.pushMs, signal)
          this.setControlState('forward', false)
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
            this.setControlState('back', true)
            backUntil = Date.now() + (depressionEscape ? 450 : 300)
          }
          lastPosition = this.bot.entity.position.clone()
          lastProgressAt = Date.now() - 300
          continue
        } else {
          this.setControlState('forward', true)
          this.setControlState('jump', false)
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
      this.setControlState('forward', false)
      this.setControlState('jump', false)
      this.setControlState('back', false)
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
    this.assertEffect({ type: 'equip', itemName: item.name, destination: 'hand' })
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

  /**
   * Armor-equip action: put a carried armor piece on its slot destination and
   * require the live armor slot to name it. The post-condition is asserted here
   * and surfaced as the greppable `EQUIP_ARMOR ...` marker; an equip that did
   * not stick is a `verify_failed`, never a silent success.
   */
  private async runEquip(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const itemName = candidate.itemName
    if (itemName === null) throw new ExecutorError('target_gone', 'EQUIP candidate has no item')
    const slot = readMetaString(candidate, 'slot')
    if (slot !== 'head' && slot !== 'torso' && slot !== 'legs' && slot !== 'feet') {
      throw new ExecutorError('target_gone', `EQUIP candidate names no valid armor slot (${slot ?? 'none'})`)
    }
    const armorSlot: ArmorSlot = slot
    const replaced = readMetaString(candidate, 'replaced')
    let observed = this.wornArmorName(armorSlot)
    for (let attempt = 1; attempt <= PLACE_EQUIP_RETRIES; attempt += 1) {
      const item = this.bot.inventory.items().find((entry) => entry.name === itemName)
      // issue #436 section 11 / fixture 11: ITEM_UNAVAILABLE, and NO substitute is
      // chosen. The selected item is the target identity; a different chestplate
      // would be a new WHICH decision, so this is a typed capability loss.
      if (item === undefined) {
        throw new ExecutorError('item_unavailable', `${itemName} is not in the inventory (no substitute is chosen)`)
      }
      if (observed !== itemName) {
        this.setPhase(candidate, epoch, 'equipping')
        await this.equipItemTo(item, ARMOR_DESTINATION[armorSlot], epoch, signal)
      }
      observed = this.wornArmorName(armorSlot)
      if (observed === itemName) {
        this.logger.info('executor', formatArmorEquip({ slot: armorSlot, itemName, replaced }), {
          actionId: candidate.id,
          slot: armorSlot,
          itemName,
          replaced,
          attempt,
        })
        return this.buildResult(candidate, epoch, startedAt, 'done', 'equipped', `wore ${itemName} on ${armorSlot}`, null, {
          verified: true,
          dropObserved: false,
          blockRemoved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
        })
      }
      if (attempt < PLACE_EQUIP_RETRIES) await delay(PLACE_EQUIP_SETTLE_MS, signal)
    }
    throw new ExecutorError(
      'verify_failed',
      `equip ${itemName} was not reflected in the ${armorSlot} armor slot (found ${observed ?? 'empty'})`,
    )
  }

  /**
   * The worn item name in one armor destination, read from the live player
   * window (slot 5=head .. 8=feet). `null` when the slot is empty.
   */
  private wornArmorName(slot: ArmorSlot): string | null {
    const slots = (this.bot.inventory as { slots?: ReadonlyArray<{ name?: string } | null> }).slots
    const item = slots?.[ARMOR_SLOT_INDEX[slot]]
    return item !== undefined && item !== null && typeof item.name === 'string' ? item.name : null
  }

  /**
   * Weapon-in-hand condition for combat (issue #436 section 11). An ATTACK is a
   * real melee lease: the damage actually dealt is the HELD item's, so the exact
   * item in hand is part of the Skill's mechanics - but WHICH carried weapon to
   * use is policy-visible as soon as the alternatives are strategically distinct.
   *
   * The rule (see `gearPlan.ts` for why a weapon CLASS is the semantic unit here;
   * there is no durability/repair economy, so same-class instances differ only by
   * base damage):
   *
   *   the hand already holds a carried weapon -> change nothing. The no-op is not
   *       a choice, and Jev's `HOLD_ITEM` (or an earlier unique-class equip)
   *       already decided; the lease proceeds.
   *   exactly ONE weapon class carried -> equip the best instance of that class
   *       through the same leased equip path as every other equip. Mechanical.
   *   TWO OR MORE classes carried -> SKILL_POLICY_BOUNDARY: code refuses to rank
   *       a sword against an axe and stops the lease with the typed
   *       `weapon_choice_required`, exposing the grounded `HOLD_ITEM`
   *       alternatives for Jev. No swing happens, so nothing is silently chosen.
   *   no weapon carried -> proceed with whatever is in hand (an empty hand is a
   *       legitimate fight); the honest refusal marker is emitted.
   */
  private async equipCombatWeapon(candidate: Candidate, epoch: number, signal: AbortSignal): Promise<void> {
    const held = this.bot.heldItem?.name ?? null
    const counts = this.inventoryCounts()
    if (holdsCarriedWeapon(held, counts)) {
      this.logger.info('executor', formatWeaponRefusal(held), { actionId: candidate.id, heldItem: held, reason: 'already_holding_carried_weapon' })
      return
    }
    const classes = carriedWeaponClasses(counts)
    if (classes.length > 1) {
      const alternatives = weaponHoldAlternatives(counts)
      this.logger.warn(
        'executor',
        formatWeaponChoiceRequired(alternatives),
        { actionId: candidate.id, heldItem: held, classes, alternatives },
      )
      throw new ExecutorError(
        'weapon_choice_required',
        `the body carries ${classes.join('+')}: which weapon to hold is Jev's choice, not a mechanical ranking`,
      )
    }
    if (classes.length === 0) {
      this.logger.info('executor', formatWeaponRefusal(held), { actionId: candidate.id, heldItem: held, reason: 'no_weapon_carried' })
      return
    }
    const offer = bestWeaponOfferInClass(held, counts, classes[0] as 'sword' | 'axe')
    if (offer === null) {
      this.logger.info('executor', formatWeaponRefusal(held), { actionId: candidate.id, heldItem: held })
      return
    }
    const item = this.bot.inventory.items().find((entry) => entry.name === offer.itemName)
    if (item === undefined) {
      this.logger.warn('executor', formatWeaponRefusal(held), {
        actionId: candidate.id,
        heldItem: held,
        missing: offer.itemName,
      })
      return
    }
    this.setPhase(candidate, epoch, 'equipping')
    // issue #436 section 11 / fixture 10: equip the EXACT selected item and VERIFY
    // the live main hand. The bounded retry is same-item and side-effect-free
    // (an equip either happened or did not), and it never selects a substitute.
    let observed = this.bot.heldItem?.name ?? null
    for (let attempt = 1; attempt <= PLACE_EQUIP_RETRIES; attempt += 1) {
      if (observed !== offer.itemName) await this.equipItemTo(item, 'hand', epoch, signal)
      observed = this.bot.heldItem?.name ?? null
      if (observed === offer.itemName) break
      if (attempt < PLACE_EQUIP_RETRIES) await delay(PLACE_EQUIP_SETTLE_MS, signal)
    }
    if (observed !== offer.itemName) {
      throw new ExecutorError(
        'verify_failed',
        `equip ${offer.itemName} was not reflected in the live held item (found ${observed ?? 'empty'})`,
      )
    }
    this.logger.info('executor', formatWeaponEquip(offer), {
      actionId: candidate.id,
      itemName: offer.itemName,
      replaced: held,
      damage: offer.damage,
      heldItem: observed,
    })
  }

  /**
   * issue #436 section 9: the bounded combat commitment against ONE causal entity
   * identity.
   *
   * Jev selected `KILL(entityId=E)` (or `HUNT_DROP(E,item)`). Once selected, the
   * Skill owns bounded execution against THAT entity id:
   *
   *   track/reacquire E          - the SAME id, never the nearest mob of the same
   *                                type (section 9: "Do not automatically attack
   *                                the nearest entity F, even if F has the same
   *                                mob type" - that would be a new WHICH);
   *   approach E within budget   - stock GoalFollow / bounded re-approach of E's
   *                                own last observed position;
   *   face E;
   *   attack E at a mechanical cadence - no Jev call per swing.
   *
   * A hunt (`goalDrop`) adds nothing semantic: it only widens the lease and adds
   * the drop half of the postcondition. It does NOT become a licence to adopt
   * another producer.
   *
   * Honest outcomes only (`combatClosure.ts`): a vanished entity is
   * TARGET_DESPAWNED/TARGET_LOST, never a kill. `KILL_VERIFIED` requires the
   * server `entityDead` event for the committed id.
   */
  private async runAttack(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const entityId = candidate.targetEntityId
    if (entityId === null) throw new ExecutorError('target_gone', 'ATTACK candidate has no entity id')
    // section 11: may throw `weapon_choice_required` BEFORE any swing when the
    // carried weapons are strategically distinct.
    await this.equipCombatWeapon(candidate, epoch, signal)
    // A `goalDrop` ATTACK is a goal-directed hunt: its mechanical completion is
    // the server `entityDead` event for the committed id; the drop reaching the
    // inventory is the second, separately-reported half of its declared
    // postcondition. An ordinary ATTACK (local safety / food) keeps the
    // historical bounded melee lease and `attacked` result.
    const goalDrop = readMetaString(candidate, 'goalDrop')
    const beforeDropCount = this.countItem(goalDrop)
    const leaseMs = goalDrop === null ? ATTACK_LEASE_MS : GOAL_HUNT_LEASE_MS
    let attacks = 0
    let following = false
    let followBestDistance = Number.POSITIVE_INFINITY
    let followClosingAt = Date.now()
    let entityDefeated = false
    // #391: hits are observed, never assumed. `hits` counts damage events on
    // THIS target attributable to THIS lease; `lastSwingAt` is the fail-closed
    // correlation window for servers whose hurt event carries no source.
    let hits = 0
    let lastSwingAt = 0
    let healthBefore: number | null = null
    let healthLast: number | null = null
    let lastTarget = candidate.target ?? { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z }
    /**
     * section 9: how many times the SAME identity was restored after leaving the
     * tracked set. Never a different entity - the id is invariant for the whole
     * commitment, so this is a re-acquire COUNT, not a retarget count.
     */
    let reacquires = 0
    /** the bounded same-identity window ran out with the id still untracked */
    let reacquireExhausted = false
    /** a safety/lease preemption ended the commitment */
    let interrupted = false
    /**
     * The closing phase PROVED no grounded remedy could bring melee contact onto
     * the committed id: either the geometry alone rules it out (the target sits
     * more than `MELEE_ATTACK_RANGE` above the body and a walk cannot change the
     * body's level) or a bounded approach produced zero closure. The lease ends on
     * that proof with the typed `unreachable` reason instead of polling to its
     * deadline - the honest difference between a failed approach and a target the
     * body cannot reach from here.
     */
    let unreachable = false
    const onEntityDead = (entity: Entity): void => {
      if (entity.id !== entityId) return
      entityDefeated = true
      lastTarget = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
      this.logger.info('executor', `ATTACK_TARGET_DEAD action#${epoch} entity=${entityId}`, {
        actionId: candidate.id,
        targetEntityId: entityId,
        goalDrop: goalDrop ?? 'none',
      })
    }
    const onTargetHurt = (entity: Entity, source?: Entity): void => {
      if (entity.id !== entityId) return
      const health = readEntityHealth(entity)
      if (health !== null) healthLast = health
      // The server attributes the cause: `source` is the entity that dealt the
      // damage (undefined when the server only sent the hurt animation). A hurt
      // sourced to another entity is that entity's hit, not ours.
      const sourced = source !== undefined && source !== null
      const sourcedToSelf = sourced && this.bot.entity !== undefined && source.id === this.bot.entity.id
      if (sourced && !sourcedToSelf) return
      if (!sourced && (lastSwingAt === 0 || Date.now() - lastSwingAt > ATTACK_HIT_CORRELATION_MS)) return
      hits += 1
      this.logger.info(
        'executor',
        `ATTACK_HIT action#${epoch} entity=${entityId} hits=${hits} attribution=${sourcedToSelf ? 'source' : 'swing-window'} targetHealth=${health ?? 'unknown'}`,
        {
          actionId: candidate.id,
          targetEntityId: entityId,
          hits,
          attribution: sourcedToSelf ? 'source' : 'swing-window',
          targetHealth: health,
        },
      )
    }
    this.bot.on('entityDead', onEntityDead)
    this.bot.on('entityHurt', onTargetHurt)
    const deadline = Date.now() + leaseMs
    const stopFollowing = (): void => {
      if (!following) return
      this.bot.pathfinder?.setGoal(null)
      following = false
    }
    try {
      while (Date.now() < deadline && !entityDefeated) {
        this.ensureOwned(epoch, signal)
        const entity = this.bot.entities[entityId]
        if (entity === undefined) {
          // The committed entity left the client's tracked set. section 9: track /
          // reacquire THAT identity - the mob name is NOT a licence to adopt
          // another instance (live `ATTACK:e16002` / `HUNT_RETARGET` adopted a
          // different blaze). Bounded re-approach of its own last observed
          // position, then a typed non-kill outcome.
          stopFollowing()
          this.setPhase(candidate, epoch, 'reacquiring-target')
          const restored = await this.reacquireSameEntity({
            candidate,
            epoch,
            signal,
            deadline,
            lastKnown: lastTarget,
            entityId,
            attempt: reacquires + 1,
          })
          if (!restored) {
            reacquireExhausted = true
            break
          }
          reacquires += 1
          continue
        }
        lastTarget = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
        // SAFE: an ATTACK lease is a body-holding action. Following a target into
        // water is how the measured death happened (2026-09-21T16:59:34.792Z:
        // `ATTACK:e4698 phase=closing-to-melee-range` chased a salmon down from
        // y=62 to y=57 and the body drowned at (67.5,58.3,28.5)). Once the breath
        // is at/below the SAFE threshold the lease stops with a typed
        // `submerged` outcome; whether to resurface or escalate stays Jev's.
        this.requireBreath(candidate, lastTarget, 'attacking')
        if (healthBefore === null) {
          healthBefore = readEntityHealth(entity)
          if (healthBefore !== null) healthLast = healthBefore
        }
        const distanceToTarget = Math.hypot(
          entity.position.x - this.bot.entity.position.x,
          entity.position.y - this.bot.entity.position.y,
          entity.position.z - this.bot.entity.position.z,
        )
        if (distanceToTarget > MELEE_ATTACK_RANGE) {
          // The closing path itself stays allocation-free: the geometry facts the
          // unreachable proof needs are read only when the proof is about to fire.
          const gapY = Math.floor(entity.position.y) - Math.floor(this.bot.entity.position.y)
          // THE GEOMETRY PROOF, before any attempt. A walk cannot change the body's
          // LEVEL, and the 3-D distance is at least the vertical component of the
          // gap, so a target more than `MELEE_ATTACK_RANGE` above the body is out of
          // melee reach from EVERY horizontal position: `GoalFollow` provably cannot
          // close it. The lease therefore ends HERE instead of polling to its
          // deadline and reporting `out_of_range swings=0` - the measured shape of 9
          // of the 17 live blaze hunts (lease-start gapY 4,4,4,4,9,9,9,9,5), which
          // read as failed attempts rather than targets no remedy reaches. Integer
          // levels make this verdict identical to the candidate gate's
          // (`contactGeometryFor` uses the same bound).
          //
          // This is deliberately the ONLY proof promoted to `unreachable`. A bounded
          // stall with no closure is NOT: `test-pearl-route.mts` (b4) pins a hunt
          // whose target never enters melee as the typed `out_of_range`, and a stall
          // is an observation about the body's progress, not a proof that no route
          // exists. Code claims only what it can prove.
          if (gapY > MELEE_ATTACK_RANGE) {
            stopFollowing()
            unreachable = true
            const placeable = selectPlaceableBlock(this.inventoryCounts())
            const placeableBlock = placeable === null ? null : placeable.name
            const horizontal = Math.hypot(
              entity.position.x - this.bot.entity.position.x,
              entity.position.z - this.bot.entity.position.z,
            )
            this.logger.warn(
              'executor',
              formatContactUnreachable({
                actionId: candidate.id,
                entityId,
                targetName: candidate.targetName,
                evidence: 'vertical_gap',
                approach: classifyContactApproach({
                  distance: distanceToTarget,
                  meleeReach: MELEE_ATTACK_RANGE,
                  gapY,
                  walkGap: MELEE_ATTACK_RANGE,
                  ascentRefused: placeable === null,
                }),
                distance: distanceToTarget,
                gapY,
                horizontal,
                meleeReach: MELEE_ATTACK_RANGE,
                walkGap: MELEE_ATTACK_RANGE,
                ascentRefusal: placeable === null ? 'no_placeable' : null,
                placeable: placeableBlock,
              }),
              { actionId: candidate.id, targetEntityId: entityId, gapY, horizontal },
            )
            break
          }
          // Close on THIS entity only. Stock `GoalFollow(entity)` follows the
          // exact committed id, so a teleporting producer keeps its target.
          if (!following && this.bot.pathfinder !== undefined) {
            this.setPhase(candidate, epoch, 'closing-to-melee-range')
            this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, MELEE_ATTACK_RANGE - 0.2), true)
            following = true
            followBestDistance = distanceToTarget
            followClosingAt = Date.now()
          } else if (following) {
            // A stock `GoalFollow` that hit `path_reset stuck` leaves the body
            // standing while the distance never changes. Re-issue the follow goal
            // after a bounded stall; the lease deadline still bounds the loop.
            if (distanceToTarget < followBestDistance - 0.5) {
              followBestDistance = distanceToTarget
              followClosingAt = Date.now()
            } else if (Date.now() - followClosingAt > HUNT_FOLLOW_STALL_MS) {
              this.bot.pathfinder?.setGoal(null)
              this.bot.pathfinder?.setGoal(new goals.GoalFollow(entity, MELEE_ATTACK_RANGE - 0.2), true)
              followClosingAt = Date.now()
            }
          }
          await delay(100, signal)
          continue
        }

        stopFollowing()
        this.setPhase(candidate, epoch, goalDrop === null ? 'attacking' : `hunting-for-${goalDrop}`)
        this.assertEffect({ type: 'look' })
        await this.bot.lookAt(entity.position.offset(0, entity.height * 0.5, 0), true)
        this.ensureOwned(epoch, signal)
        this.assertEffect({ type: 'attack', entityId: entity.id, mobType: entity.name ?? null })
        this.bot.attack(entity)
        attacks += 1
        lastSwingAt = Date.now()
        this.logger.info('executor', `ATTACK_LEASE action#${epoch} attempt=${attacks} hits=${hits} distance=${Math.round(distanceToTarget * 100) / 100}m`, {
          actionId: candidate.id,
          targetEntityId: entityId,
          distance: distanceToTarget,
          attempt: attacks,
          hits,
          goalDrop: goalDrop ?? 'none',
        })
        await delay(Math.min(ATTACK_COOLDOWN_MS, Math.max(1, deadline - Date.now())), signal)
      }
    } catch (error) {
      // A hard-safety stop (`submerged`) or a revoked lease ends the commitment
      // with COMBAT_INTERRUPTED evidence before the typed failure travels on.
      interrupted = true
      this.logCombatOutcome({
        candidate,
        epoch,
        startedAt,
        entityId,
        targetName: candidate.targetName,
        outcome: 'COMBAT_INTERRUPTED',
        swings: attacks,
        hits,
        reacquires,
        lastTarget,
        goalDrop,
      })
      throw error
    } finally {
      this.bot.removeListener('entityDead', onEntityDead)
      this.bot.removeListener('entityHurt', onTargetHurt)
      stopFollowing()
    }

    // section 9: the ONE classification, from the facts the loop actually acted
    // on. `entityDefeated` is the server's own death event for the committed id;
    // nothing weaker produces KILL_VERIFIED.
    const outcome: CombatOutcome = classifyCombatOutcome({
      entityDefeated,
      tracked: this.bot.entities[entityId] !== undefined,
      reacquireExhausted,
      invalidated: false,
      interrupted: false,
      unreachable,
      hits,
    })

    // Typed lease evidence (#391). `entityDead` inside the lease is terminal
    // proof that a damaging blow landed; the attributable hurt count is the
    // direct hit evidence; a target health drop corroborates it when the
    // entity actually exposes health.
    const targetHealthDelta =
      healthBefore !== null && healthLast !== null ? Math.max(0, Math.round((healthBefore - healthLast) * 100) / 100) : 0
    const damageObserved = hits > 0 || entityDefeated || targetHealthDelta > 0
    const attackEvidence = { attackHits: hits, damageObserved, targetHealthDelta }

    if (goalDrop !== null && !entityDefeated) {
      // The committed producer was never verified dead: a typed non-completion.
      // section 9 explicitly forbids reading "the entity disappeared" as a kill.
      this.logger.warn(
        'executor',
        formatHuntTargetLost({
          actionId: candidate.id,
          targetName: candidate.targetName,
          goalDrop,
          entityId,
          swings: attacks,
          hits,
          reacquired: reacquires,
          lastKnown: lastTarget,
        }),
        {
          actionId: candidate.id,
          target: candidate.targetName ?? 'unknown',
          goalDrop,
          entityId,
          swings: attacks,
          hits,
          reacquired: reacquires,
          lastKnown: { x: lastTarget.x, y: lastTarget.y, z: lastTarget.z },
        },
      )
    }
    this.logCombatOutcome({
      candidate,
      epoch,
      startedAt,
      entityId,
      targetName: candidate.targetName,
      outcome,
      swings: attacks,
      hits,
      reacquires,
      lastTarget,
      goalDrop,
    })
    // Computed from the same facts the loop acted on, so the marker can never
    // disagree with the outcome: a vanished id is `untracked`/`target_lost`, a
    // tracked id that never came into range is `out_of_range`, and a survived
    // target the lease ran out on is `lease_expired`. NONE of them is a kill.
    const trackedAtEnd = this.bot.entities[entityId] !== undefined
    const huntEnd: HuntEndReason | null =
      goalDrop === null
        ? null
        : entityDefeated
          ? 'killed'
          : reacquireExhausted
            ? 'target_lost'
            : unreachable
              ? 'unreachable'
              : trackedAtEnd
                ? attacks === 0
                  ? 'out_of_range'
                  : 'lease_expired'
                : 'untracked'
    if (goalDrop !== null && huntEnd !== null) {
      this.logger.info(
        'executor',
        formatHuntEnd({
          actionId: candidate.id,
          targetName: candidate.targetName,
          goalDrop,
          reason: huntEnd,
          swings: attacks,
          hits,
          reacquired: reacquires,
          lastKnown: lastTarget,
          ms: Date.now() - startedAt,
        }),
        {
          actionId: candidate.id,
          target: candidate.targetName ?? 'unknown',
          goalDrop,
          reason: huntEnd,
          swings: attacks,
          hits,
          reacquired: reacquires,
        },
      )
    }

    // A plain ATTACK that never reached its target keeps the historical typed
    // `out_of_reach` error. A HUNT does not: its contract is the kill, so failing
    // to defeat the producer is the same typed non-completion as any other unmet
    // hunt post-condition, carrying the honest combat outcome as the cause.
    if (goalDrop === null && attacks === 0) {
      throw new ExecutorError(
        outcome === 'TARGET_DESPAWNED' || outcome === 'TARGET_LOST' ? 'target_gone' : 'out_of_reach',
        `could not reach ${candidate.targetName ?? entityId} during ATTACK lease (${outcome})`,
      )
    }

    if (goalDrop !== null) {
      if (!isMobHuntPostconditionMet(entityDefeated)) {
        return this.buildResult(
          candidate,
          epoch,
          startedAt,
          'failed',
          'target-not-defeated',
          `hunt for ${goalDrop} ended outcome=${outcome}: attacked ${candidate.targetName ?? entityId} ${attacks} time(s) with ${hits} hit(s), no entityDead event observed, reacquires=${reacquires}`,
          'verify_failed',
          {
            verified: false,
            dropObserved: false,
            blockRemoved: false,
            itemsGained: 0,
            goalItemCount: this.countItem(goalDrop),
            entityDefeated: false,
            combatOutcome: outcome,
            ...attackEvidence,
            ...huntEvidence(goalDrop, huntEnd, reacquires, lastTarget),
          },
        )
      }
      // The kill half of the declared postcondition is PROVEN. Now the drop half:
      // the wanted item must reach the inventory (verified delta), which is what
      // section 9 means by "HUNT_DROP verifies target+drop".
      this.setPhase(candidate, epoch, `collecting-${goalDrop}`)
      const report = await this.collectDrop(lastTarget, goalDrop, beforeDropCount, false, epoch, signal)
      const dropAcquired = report.itemsGained > 0
      const finalOutcome: CombatOutcome = dropAcquired ? 'KILL_VERIFIED' : 'DROP_NOT_ACQUIRED'
      this.logCombatOutcome({
        candidate,
        epoch,
        startedAt,
        entityId,
        targetName: candidate.targetName,
        outcome: finalOutcome,
        swings: attacks,
        hits,
        reacquires,
        lastTarget,
        goalDrop,
        dropAcquired,
      })
      if (!dropAcquired) {
        // The exact target IS dead (the kill half is verified), but the declared
        // drop objective is NOT met - so this must never read as a banked item.
        this.logger.warn(
          'executor',
          `HUNT_DROP_NOT_ACQUIRED actionId=${candidate.id} entity=e${entityId} for=${goalDrop} swings=${attacks} hits=${hits} ` +
            `dropObserved=${report.dropObserved} goalItemCount=${report.goalItemCount} -> kill verified, drop NOT in the inventory`,
          { actionId: candidate.id, targetEntityId: entityId, goalDrop, itemsGained: 0 },
        )
      }
      const result = this.buildResult(
        candidate,
        epoch,
        startedAt,
        'done',
        dropAcquired ? 'drop-acquired' : 'target-defeated',
        dropAcquired
          ? `defeated ${candidate.targetName ?? entityId} and acquired ${report.itemsGained} x ${goalDrop}`
          : `defeated ${candidate.targetName ?? entityId}; no ${goalDrop} acquired from this kill`,
        null,
        {
          verified: true,
          dropObserved: report.dropObserved,
          blockRemoved: false,
          itemsGained: report.itemsGained,
          goalItemCount: report.goalItemCount,
          entityDefeated: true,
          dropAcquired,
          combatOutcome: finalOutcome,
          ...attackEvidence,
          ...huntEvidence(goalDrop, huntEnd, reacquires, lastTarget),
        },
      )
      result.yieldItem = goalDrop
      return result
    }

    // A plain ATTACK (self-defence / food) is complete on a HIT, never on a
    // kill and never on the swing count. Zero observed hits is a typed
    // non-success so the candidate filter, the failure memory and the beta
    // boundary can see that this attack is not working - the live
    // `ATTACK:e4698` lease kept reporting `done/verified=true` while the target
    // was never damaged (issue #391).
    if (!damageObserved) {
      this.logger.warn(
        'executor',
        `ATTACK_NO_HIT action#${epoch} entity=${entityId} swings=${attacks} hits=0 damageObserved=false targetHealthDelta=${targetHealthDelta}`,
        {
          actionId: candidate.id,
          targetEntityId: entityId,
          swings: attacks,
          hits: 0,
          damageObserved: false,
          targetHealthDelta,
        },
      )
      return this.buildResult(
        candidate,
        epoch,
        startedAt,
        'failed',
        'no-hit',
        `attacked ${candidate.targetName ?? entityId} ${attacks} time(s) but no hit or damage on the target was observed`,
        'verify_failed',
        {
          verified: false,
          dropObserved: false,
          blockRemoved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
          entityDefeated,
          combatOutcome: outcome,
          ...attackEvidence,
        },
      )
    }

    return this.buildResult(
      candidate,
      epoch,
      startedAt,
      'done',
      'attacked',
      `attacked ${candidate.targetName ?? entityId} ${attacks} time(s), ${hits} hit(s) observed during ${leaseMs}ms lease`,
      null,
      {
        verified: true,
        dropObserved: false,
        blockRemoved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
        entityDefeated,
        combatOutcome: outcome,
        ...attackEvidence,
      },
    )
  }

  /** The `HUNT_END`-adjacent evidence fields shared by both hunt results. */
  private logCombatOutcome(input: {
    candidate: Candidate
    epoch: number
    startedAt: number
    entityId: number
    targetName: string | null
    outcome: CombatOutcome
    swings: number
    hits: number
    reacquires: number
    lastTarget: Vec3Json
    goalDrop: string | null
    dropAcquired?: boolean
  }): void {
    this.logger.warn(
      'executor',
      formatCombatOutcome({
        outcome: input.outcome,
        actionId: input.candidate.id,
        entityId: input.entityId,
        targetName: input.targetName,
        swings: input.swings,
        hits: input.hits,
        reacquires: input.reacquires,
        lastKnown: input.lastTarget,
        ms: Date.now() - input.startedAt,
        goalDrop: input.goalDrop,
        dropAcquired: input.dropAcquired,
      }),
      {
        actionId: input.candidate.id,
        targetEntityId: input.entityId,
        outcome: input.outcome,
        swings: input.swings,
        hits: input.hits,
        reacquires: input.reacquires,
        goalDrop: input.goalDrop ?? null,
      },
    )
  }

  /**
   * section 9: bounded re-acquisition of the SAME causal entity identity.
   *
   * The committed id is the invariant. The body re-approaches the id's own last
   * observed position and re-scans for THAT id; it never adopts the nearest
   * entity of the same mob type, because that would be a new WHICH decision
   * ("zombie A disappears; attack skeleton B instead -> Jev pi"). A teleporting
   * enderman keeps its id across a blink, so waiting for the id is exactly the
   * mechanical recovery section 9 asks for.
   */
  private async reacquireSameEntity(input: {
    candidate: Candidate
    epoch: number
    signal: AbortSignal
    deadline: number
    lastKnown: Vec3Json
    entityId: number
    attempt: number
  }): Promise<boolean> {
    const budgetMs = this.options.huntReacquireMs ?? HUNT_REACQUIRE_MS
    const windowEnd = Math.min(input.deadline, Date.now() + Math.max(0, budgetMs))
    let approachIssued = false
    let polls = 0
    try {
      while (Date.now() < windowEnd) {
        this.ensureOwned(input.epoch, input.signal)
        const entity = this.bot.entities[input.entityId]
        if (entity !== undefined) {
          this.logger.info(
            'executor',
            `HUNT_REACQUIRE_SAME_IDENTITY actionId=${input.candidate.id} entity=e${input.entityId} ` +
              `attempt=${input.attempt} polls=${polls} -> the committed id is tracked again`,
            { actionId: input.candidate.id, targetEntityId: input.entityId, attempt: input.attempt, polls },
          )
          return true
        }
        if (!approachIssued && this.bot.pathfinder !== undefined) {
          // Re-approach the last observed position: bounded by construction, and
          // cleared in the `finally` so an aborted/submerged re-acquire can never
          // leave the body walking after the skill has ended.
          this.setPhase(input.candidate, input.epoch, 're-approaching-last-known')
          this.bot.pathfinder.setGoal(
            new goals.GoalNear(input.lastKnown.x, input.lastKnown.y, input.lastKnown.z, 2),
            false,
          )
          approachIssued = true
        }
        // SAFE: the re-approach is a body-holding walk, so it obeys the same
        // breath boundary as the melee chase (the measured drowning death).
        this.requireBreath(input.candidate, input.lastKnown, 're-acquiring the selected target')
        polls += 1
        await delay(HUNT_REACQUIRE_POLL_MS, input.signal)
      }
    } finally {
      if (approachIssued) this.bot.pathfinder?.setGoal(null)
    }
    this.logger.info(
      'executor',
      `HUNT_REACQUIRE_EXHAUSTED actionId=${input.candidate.id} entity=e${input.entityId} polls=${polls} ` +
        `lastKnown=${input.lastKnown.x},${input.lastKnown.y},${input.lastKnown.z} -> typed non-kill, no substitute target`,
      {
        actionId: input.candidate.id,
        targetEntityId: input.entityId,
        polls,
        lastKnown: { x: input.lastKnown.x, y: input.lastKnown.y, z: input.lastKnown.z },
      },
    )
    return false
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
    let tableTarget: Vec3Json | null = null
    if (candidate.meta.requiresTable === true) {
      const target = candidate.target
      if (target === null) {
        throw new ExecutorError('craft_error', 'recipe needs a crafting_table but no station position was supplied')
      }
      // The sensor may see a table far outside interaction reach; the executor
      // must first stand on a real interaction face (never merely be near it), or
      // this fails loud with a typed reason.
      this.setPhase(candidate, epoch, 'pathing-to-table')
      await this.approachPlacedBlock(target, 'crafting_table', epoch, signal)
      this.ensureOwned(epoch, signal)
      const block = this.currentBlockAt(target)
      if (block === null || block.name !== 'crafting_table') {
        throw new ExecutorError('target_gone', `no crafting_table at (${target.x},${target.y},${target.z})`)
      }
      table = block
      tableTarget = target
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
      // path still uses bot.craft. On a Leaf live run, a timed-out player-grid
      // craft can leave `currentWindow` as minecraft:crafting even though the
      // action rejected. If that stale window is carried into the next retry,
      // bot.craft keeps operating on the dead session and every retry can
      // reproduce the same zero-gain/updateSlot timeout. Close only this
      // abandoned crafting window after each player-grid attempt; a successful
      // stock craft normally leaves no current window, so this is a no-op on
      // the healthy path.
      if (table === null) {
        try {
          this.assertEffect({ type: 'station', station: 'inventory_crafting_grid' })
          await this.bot.craft(recipe, craftCount)
        } finally {
          await this.closeAbandonedCraftWindow()
        }
      } else {
        const station = tableTarget
        if (station === null) {
          throw new ExecutorError('craft_error', 'crafting_table station position was lost before the open')
        }
        // Re-assert the stand immediately before EVERY open (a cheap no-op when
        // already standing correctly) and derive the geometric face the body
        // interacts with, so openBlock never runs offset/below with no face.
        const stand = await this.approachPlacedBlock(station, 'crafting_table', epoch, signal)
        this.ensureOwned(epoch, signal)
        const face = deriveInteractionFace(stand, station)
        const faceVec = this.bot.entity.position.clone().set(face.x, face.y, face.z)
        this.assertEffect({ type: 'station', station: 'crafting_table' })
        await craftAtTable(this.bot, table, recipe as unknown as CraftRecipeLike, faceVec)
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

  /**
   * A failed stock 2x2 craft may leave Mineflayer's temporary crafting window
   * installed after its promise rejects. Treat that window as executor-owned
   * transient state: close it before the controller retries or replans, while
   * leaving unrelated container windows untouched.
   */
  private async closeAbandonedCraftWindow(): Promise<void> {
    const window = this.bot.currentWindow
    if (window === null || typeof window.type !== 'string' || !window.type.startsWith('minecraft:crafting')) return
    try {
      await this.bot.closeWindow(window)
    } catch (error) {
      this.logger.warn('executor', `crafting window cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The CONTAINER runner: approach the container through the EXISTING
   * `approachPlacedBlock` station path, prove the block is still there and not
   * occluded, open it with the geometric face the body actually stands on, and
   * READ its live contents.
   *
   * Two actions share this runner (`meta.containerAction`):
   *   * `open`     - the inspect/sense step. It moves NO item: the effect
   *                  envelope for an open selection declares no transfer at all,
   *                  so any attempt to take something is a fail-closed
   *                  `transfer_not_declared` violation. Its evidence is the
   *                  `CONTAINER_OPEN` observation (with the typed
   *                  `CONTAINER_EMPTY` line when the container is empty).
   *   * `withdraw` - take the ONE item the candidate declared, up to the count
   *                  its own observation declared. Every move asserts
   *                  `{type:'transfer', itemName, count, container: <ref>}`
   *                  against the envelope before the side effect, and the
   *                  verified amount is the INVENTORY DELTA - never the intent.
   *                  `CONTAINER_TRANSFER` names what was taken and what remains.
   *
   * Contents are UNKNOWN before the window opens (the client has no other
   * surface - see `containerAccess.ts`), so this is the only honest order:
   * open, observe, then transfer what an observation grounded.
   */
  private async runContainer(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('container_error', 'CONTAINER candidate has no container position')
    const ref = readMetaString(candidate, 'containerRef')
    if (ref === null || parseContainerRef(ref) === null) {
      throw new ExecutorError('container_error', 'CONTAINER candidate has no truthful container reference (name@x,y,z)')
    }
    const action = readMetaString(candidate, 'containerAction') ?? 'open'
    if (action !== 'open' && action !== 'withdraw') {
      throw new ExecutorError('container_error', `CONTAINER candidate has an unknown action "${action}"`)
    }
    this.setPhase(candidate, epoch, 'pathing-to-container')
    // The EXISTING station approach (never a forked approach): a real
    // interaction stand or a typed path_stuck, no blind interaction.
    const stand = await this.approachPlacedBlock(target, 'container', epoch, signal)
    this.ensureOwned(epoch, signal)
    const block = this.currentBlockAt(target)
    if (block === null || !isContainerBlockName(block.name)) {
      this.logContainerRefusal({
        reason: 'unreachable',
        container: ref,
        block: readMetaString(candidate, 'containerBlock') ?? 'container',
        position: { x: target.x, y: target.y, z: target.z },
        detail: block === null ? 'block_unloaded' : 'block_missing',
      })
      throw new ExecutorError('target_gone', `no container at (${target.x},${target.y},${target.z}) (found ${block?.name ?? 'unloaded'})`)
    }
    const liveRef = containerRef(block.name, target)
    // Occlusion is a real geometric fact (`bot.canSeeBlock` casts the eye->block
    // ray and requires this block to be the first hit), so an occluded container
    // is refused with its own reason instead of surfacing as a generic timeout.
    if (this.containerOccluded(block)) {
      this.logContainerRefusal({
        reason: 'occluded',
        container: liveRef,
        block: block.name,
        position: { x: target.x, y: target.y, z: target.z },
        detail: 'line_of_sight_blocked',
      })
      throw new ExecutorError('container_occluded', `line of sight to ${liveRef} is blocked`)
    }
    this.setPhase(candidate, epoch, 'opening')
    const face = deriveInteractionFace(stand, target)
    const handle = await this.openContainerWindow(block, face, candidate, epoch, signal)
    let closed = false
    const closeOnce = (): void => {
      if (closed) return
      closed = true
      try {
        handle.close()
      } catch {
        // the server already closed the window
      }
    }
    try {
      const stacks = handle.containerItems()
      const observation = this.recordContainerObservation(liveRef, block.name, target, stacks)
      const observed = observation.items
      this.logger.info('agent', formatContainerOpen(liveRef, observed), {
        actionId: candidate.id,
        container: liveRef,
        block: block.name,
        at: `${target.x},${target.y},${target.z}`,
        contents: observed.length === 0 ? 'empty' : 'known',
        items: observed,
        source: readMetaString(candidate, 'containerSource') ?? 'live',
      })
      if (action === 'open') {
        if (observed.length === 0) {
          // A typed EMPTY result, never a silent success: the container WAS
          // opened and observed, and that observation is the evidence.
          this.logger.info('agent', formatContainerEmpty(liveRef), {
            actionId: candidate.id,
            container: liveRef,
            at: `${target.x},${target.y},${target.z}`,
          })
        }
        return this.buildResult(candidate, epoch, startedAt, 'done', 'observed', `opened ${liveRef} (${observed.length} stacks)`, null, {
          verified: true,
          dropObserved: false,
          blockRemoved: false,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
        })
      }
      return await this.withdrawFromContainer(candidate, liveRef, block.name, target, handle, epoch, signal, startedAt)
    } finally {
      closeOnce()
    }
  }

  /**
   * The transfer half: take exactly the declared item, bounded by the count the
   * candidate's own observation declared. The envelope is re-checked before
   * EVERY move (`assertEffect`), so a container that grew under us cannot be
   * emptied silently: the declared amount is the budget, and `remaining` is
   * re-read and reported.
   */
  private async withdrawFromContainer(
    candidate: Candidate,
    liveRef: string,
    blockName: string,
    target: Vec3Json,
    handle: ContainerWindowHandle,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const item = readMetaString(candidate, 'containerItem')
    if (item === null) throw new ExecutorError('container_error', 'CONTAINER withdraw candidate has no item')
    const declared = readMetaNumber(candidate, 'containerCount', 0)
    const budget = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : null
    const before = this.countItem(item)
    let moved = 0
    for (let step = 0; step < CONTAINER_TRANSFER_STACK_LIMIT; step += 1) {
      const stack = findContainerStack(handle.containerItems(), item)
      if (stack === null) break
      const remainingBudget = budget === null ? stack.count : budget - moved
      if (remainingBudget <= 0) break
      const move = Math.max(1, Math.min(Math.floor(stack.count), Math.floor(remainingBudget)))
      // Envelope BEFORE the side effect: the truthful container reference and
      // the exact count being moved.
      this.assertEffect({ type: 'transfer', itemName: item, count: move, container: liveRef })
      this.ensureOwned(epoch, signal)
      try {
        await handle.withdraw(item, move)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logContainerRefusal({
          reason: /inventory is full|destination full/i.test(message) ? 'no_room' : 'contents_changed',
          container: liveRef,
          block: blockName,
          position: { x: target.x, y: target.y, z: target.z },
          item,
          detail: 'withdraw_refused',
        })
        throw new ExecutorError('container_error', `withdraw ${item} from ${liveRef} failed: ${message}`)
      }
      moved += move
      this.ensureOwned(epoch, signal)
    }
    const taken = Math.max(0, this.countItem(item) - before)
    // Re-observing the LIVE window after the transfer is what makes the next
    // tick honest: the ledger must show what actually REMAINS, or the candidate
    // layer would re-offer a stack that is already in the inventory and the body
    // would walk back to open an empty slot.
    const after = this.recordContainerObservation(liveRef, blockName, target, handle.containerItems())
    const remaining = after.items.filter((stack) => stack.name === item).reduce((sum, stack) => sum + Math.max(0, stack.count), 0)
    if (taken === 0) {
      this.logContainerRefusal({
        reason: moved === 0 ? 'contents_changed' : 'no_room',
        container: liveRef,
        block: blockName,
        position: { x: target.x, y: target.y, z: target.z },
        item,
        detail: moved === 0 ? 'item_not_in_container' : 'inventory_delta_zero',
      })
      throw new ExecutorError('container_error', `${item} was not transferred out of ${liveRef}`)
    }
    // The marker names what was TAKEN (the verified inventory delta) and what
    // REMAINED (a live re-read), so a partial transfer can never be reported as
    // a complete one.
    this.logger.info('agent', formatContainerTransfer(liveRef, item, taken, remaining), {
      actionId: candidate.id,
      container: liveRef,
      block: blockName,
      at: `${target.x},${target.y},${target.z}`,
      item,
      taken,
      remaining,
    })
    return this.buildResult(candidate, epoch, startedAt, 'done', 'withdrew', `took ${taken}x ${item} from ${liveRef} (${remaining} left)`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: taken,
      goalItemCount: this.countGoalItem(),
    })
  }

  /**
   * Open the container with the geometric face the body stands on, bounded by
   * `containerOpenTimeoutMs`. Mineflayer's own 20 s `once('windowOpen')` timeout
   * is swallowed here: a late window is CLOSED rather than left open, because
   * `clickWindow` silently retargets to the player inventory when
   * `bot.currentWindow` is null (mineflayer inventory.js:581).
   */
  private async openContainerWindow(
    block: Block,
    face: Vec3Json,
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
  ): Promise<ContainerWindowHandle> {
    const timeoutMs = this.options.containerOpenTimeoutMs ?? CONTAINER_OPEN_TIMEOUT_MS
    // A stale window from an earlier action would make the transfer clicks land
    // in the wrong window; close it first (the container path owns its window).
    await this.closeStaleWindow()
    this.assertEffect({ type: 'station', station: block.name })
    const port = this.options.actuationPort
    const opening: Promise<unknown> =
      port !== undefined
        ? port.openContainer(block, toVec3(this.bot, face))
        : this.bot.openContainer(block, toVec3(this.bot, face))
    // The open is raced against a bounded wait; a rejected open is kept from
    // becoming an unhandled rejection when the timeout wins.
    let settled = false
    const bounded = opening.then(
      (window) => {
        settled = true
        return window
      },
      (error: unknown) => {
        settled = true
        throw error
      },
    )
    bounded.catch(() => undefined)
    const opened = await Promise.race([
      bounded.then((window) => ({ kind: 'opened' as const, window })),
      delay(timeoutMs, signal).then(() => ({ kind: 'timeout' as const })),
    ]).catch((error: unknown) => {
      if (error instanceof ActionCancelled) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.logContainerRefusal({
        reason: 'open_timeout',
        container: containerRef(block.name, { x: block.position.x, y: block.position.y, z: block.position.z }),
        block: block.name,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        detail: 'open_threw',
      })
      throw new ExecutorError('container_unreachable', `opening ${block.name} failed: ${message}`)
    })
    if (opened.kind === 'timeout') {
      // A window that arrives after the bound must not leak: close it.
      if (!settled) {
        bounded.then((late) => this.closeWindowQuietly(late)).catch(() => undefined)
      }
      this.logContainerRefusal({
        reason: 'open_timeout',
        container: containerRef(block.name, { x: block.position.x, y: block.position.y, z: block.position.z }),
        block: block.name,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        detail: 'no_window_within_bound',
      })
      throw new ExecutorError(
        'container_unreachable',
        `no container window opened for ${block.name} at (${block.position.x},${block.position.y},${block.position.z}) within ${timeoutMs}ms`,
      )
    }
    this.ensureOwned(epoch, signal)
    return this.containerHandleFor(opened.window, block)
  }

  /**
   * Adapt the live Mineflayer window to the narrow handle: the container's own
   * slots (`itemsRange(0, inventoryStart)`) and a `withdraw` that resolves the
   * NUMERIC item id from the observed stack itself (mineflayer's `withdraw`
   * takes an item id, never a slot - inventory.js:275-305).
   */
  private containerHandleFor(raw: unknown, block: Block): ContainerWindowHandle {
    const window = raw as
      | {
          inventoryStart?: number
          itemsRange?: (start: number, end: number) => Array<{ name: string; type: number; count: number }>
          containerItems?: () => Array<{ name: string; type: number; count: number }>
          withdraw?: (itemType: number, metadata: number | null, count: number) => Promise<unknown>
          close?: () => unknown
        }
      | null
      | undefined
    if (window === null || window === undefined || typeof window !== 'object') {
      throw new ExecutorError('container_error', `opening ${block.name} returned no window`)
    }
    const containerItems = (): ContainerWindowStack[] => {
      const raw =
        typeof window.containerItems === 'function'
          ? window.containerItems()
          : typeof window.itemsRange === 'function' && typeof window.inventoryStart === 'number'
            ? window.itemsRange(0, window.inventoryStart)
            : null
      if (raw === null) throw new ExecutorError('container_error', 'the container window exposes no container slots')
      return raw.map((entry) => ({ name: entry.name, type: entry.type, count: entry.count }))
    }
    const withdraw = window.withdraw
    if (typeof withdraw !== 'function') {
      throw new ExecutorError('container_error', 'the container window exposes no withdraw')
    }
    return {
      containerItems,
      withdraw: async (itemName, count) => {
        const stack = findContainerStack(containerItems(), itemName)
        if (stack === null) throw new Error(`${itemName} is not in the container any more`)
        return withdraw.call(window, stack.type, null, count)
      },
      close: () => {
        try {
          void window.close?.()
        } catch {
          // the server already closed the window
        }
      },
    }
  }

  /** True when a real line-of-sight read says the container cell is blocked. */
  private containerOccluded(block: Block): boolean {
    const canSee = (this.bot as unknown as { canSeeBlock?: (block: unknown) => boolean }).canSeeBlock
    if (typeof canSee !== 'function') return false
    try {
      return canSee.call(this.bot, block) === false
    } catch {
      // A structural double without a world raycast answers nothing; absence of
      // the fact is not occlusion.
      return false
    }
  }

  /** Close any window left open by an earlier action, before opening our own. */
  private async closeStaleWindow(): Promise<void> {
    const current = (this.bot as unknown as { currentWindow?: unknown }).currentWindow
    if (current === null || current === undefined) return
    await this.closeWindowQuietly(current)
  }

  private async closeWindowQuietly(window: unknown): Promise<void> {
    try {
      const close = (window as { close?: () => unknown }).close
      if (typeof close === 'function') {
        await close.call(window)
        return
      }
      await this.bot.closeWindow(window as never)
    } catch {
      // the server already closed it
    }
  }

  /** Record what an open OBSERVED; absence of an entry is UNKNOWN, never empty. */
  private recordContainerObservation(
    ref: string,
    blockName: string,
    position: Vec3Json,
    stacks: readonly ContainerWindowStack[],
  ): ContainerObservation {
    const observation: ContainerObservation = {
      container: ref,
      block: blockName,
      position: { x: position.x, y: position.y, z: position.z },
      items: rollupContainerItems(containerItemStacks(stacks)),
      observedAt: Date.now(),
    }
    this.containerObservations.set(ref, observation)
    return observation
  }

  /** The mirrored typed container refusal (deduped per distinct fact). */
  private logContainerRefusal(refusal: ContainerRefusal): void {
    const key = formatContainerRefusal(refusal)
    if (this.containerRefusalLogged.has(key)) return
    this.containerRefusalLogged.add(key)
    this.logger.warn('agent', key, {
      reason: refusal.reason,
      container: refusal.container,
      block: refusal.block,
      at: `${refusal.position.x},${refusal.position.y},${refusal.position.z}`,
      ...(refusal.item === undefined || refusal.item === null ? {} : { item: refusal.item }),
      ...(refusal.detail === undefined || refusal.detail === null ? {} : { detail: refusal.detail }),
    })
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
    this.assertEffect({ type: 'station', station: block.name })
    const outcome = await executeFurnaceSmelt(
      {
        openFurnace: () => this.bot.openFurnace(block),
        assertEffect: (effect) => this.assertEffect(effect),
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
    // The step is a 1x2 PROFILE, not one block: a staircase step down needs the
    // front cell at the current feet level (the body's upper half standing in the
    // landing cell) as well as the floor, and a level step needs front + head.
    // Digging only the primary left the landing cell un-enterable, so every
    // offered step ended in `PATH_CALLBACK outcome=noPath|stuck` and the descent
    // fell through to a new heading - the measured live bowl. The passage cells
    // are dug first and the primary/landing cell last, so a dig can never open a
    // drop the body cannot leave.
    const cells = descentDigCellsFromMeta(candidate, target)
    if (this.distanceToEyes(target) > this.options.reach) {
      this.setPhase(candidate, epoch, 'pathing')
      await this.pathToNear(target, 2, epoch, signal)
      this.ensureOwned(epoch, signal)
    }
    this.setPhase(candidate, epoch, 'digging')
    let dug = 0
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index]
      if (cell === undefined) continue
      const block = this.currentBlockAt(cell)
      if (block === null || block.boundingBox === 'empty') continue
      const live = this.resolveLiveDigTool(block)
      if (!live.ok) {
        throw new ExecutorError('dig_error', `cannot dig ${block.name} at (${cell.x},${cell.y},${cell.z}): ${live.reason}`)
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
      this.logger.info('agent', `DESCEND_DIG cell=${cell.x},${cell.y},${cell.z} block=${block.name} n=${index + 1}/${cells.length}`, {
        actionId: candidate.id,
        cell,
        block: block.name,
      })
      await this.digBlock(block, epoch, signal)
      this.ensureOwned(epoch, signal)
      dug += 1
    }
    if (dug === 0) {
      throw new ExecutorError(
        'target_gone',
        `every cell of the descent step at (${target.x},${target.y},${target.z}) is already open`,
      )
    }

    const step = {
      x: readMetaNumber(candidate, 'stepX', Number.NaN),
      y: readMetaNumber(candidate, 'stepY', Number.NaN),
      z: readMetaNumber(candidate, 'stepZ', Number.NaN),
    }
    const hasStep = Number.isFinite(step.x) && Number.isFinite(step.y) && Number.isFinite(step.z)
    if (hasStep) {
      this.setPhase(candidate, epoch, 'stepping')
      try {
        await this.pathTo(step, epoch, signal, 'GoalBlock', { requireLevel: true })
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        throw error instanceof ExecutorError
          ? error
          : new ExecutorError('path_stuck', `descent step failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!isAtRequiredLevel(this.bot.entity.position, step)) {
        throw new ExecutorError(
          'path_stuck',
          `descent step did not reach (${step.x},${step.y},${step.z}) from (${round2(this.bot.entity.position.x)},${round2(this.bot.entity.position.y)},${round2(this.bot.entity.position.z)})`,
        )
      }
    }
    return this.buildResult(candidate, epoch, startedAt, 'done', 'descended', `descended via (${target.x},${target.y},${target.z})`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: true,
      // A completed staircase DESCEND that reached its step changed the body
      // state as well as the explored frontier. Preserve that axis explicitly
      // so System2 never sees a real y-step as zero/bodyless progress.
      progressed: hasStep,
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
    const sequence = candidate.placementCells
    if (sequence !== undefined && sequence.length > 0) {
      return this.runPlaceCells(candidate, sequence, itemName, epoch, signal, startedAt)
    }
    const target = candidate.target
    if (target === null) throw new ExecutorError('place_error', 'PLACE candidate has no coordinates')
    const placedName = await this.placeOneCell(candidate, target, itemName, epoch, signal)
    const readyLine = placedStationReadyLine(itemName, placedName, target)
    if (readyLine !== null) {
      this.logger.info('agent', readyLine, {
        source: 'placed',
        at: `${target.x},${target.y},${target.z}`,
        target,
        actionId: candidate.id,
      })
    }
    // A verified container placement is a durable world fact (see
    // `placedContainerReadyLine`): the host records the cell, so the body opens
    // the box standing there instead of re-planning a placement.
    const containerLine = placedContainerReadyLine(itemName, placedName, target)
    if (containerLine !== null) {
      this.logger.info('agent', containerLine, {
        source: 'placed',
        block: itemName,
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
   * The single equip mechanism. The leased allowlist port (#38) owns the side
   * effect when the resident provides one; standalone runs fall back to the
   * raw bot. Every equip (placement, armor, combat weapon) goes through here so
   * the lease assertion and destination spelling live in exactly one place.
   */
  private async equipItemTo(
    item: Item,
    destination: EquipmentDestination,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertEffect({ type: 'equip', itemName: item.name, destination })
    if (this.options.actuationPort !== undefined) {
      await this.options.actuationPort.equip(item, destination)
    } else {
      await this.bot.equip(item, destination)
    }
    this.ensureOwned(epoch, signal)
  }

  /** One post-condition-gated placement at an already-near cell. */
  private async equipPlacementItem(
    candidate: Candidate,
    itemName: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    let observed: string | null = this.bot.heldItem?.name ?? null
    for (let attempt = 1; attempt <= PLACE_EQUIP_RETRIES; attempt += 1) {
      const item = this.bot.inventory.items().find((entry) => entry.name === itemName)
      if (item === undefined) throw new ExecutorError('target_gone', `${itemName} left the inventory`)
      if (observed !== itemName) {
        await this.equipItemTo(item, 'hand', epoch, signal)
      }
      observed = this.bot.heldItem?.name ?? null
      if (observed === itemName) {
        this.logger.info('executor', `PLACE_EQUIP_READY item=${itemName} attempt=${attempt}`, {
          actionId: candidate.id,
          itemName,
          attempt,
        })
        return
      }
      if (attempt < PLACE_EQUIP_RETRIES) await delay(PLACE_EQUIP_SETTLE_MS, signal)
    }
    throw new ExecutorError(
      'place_error',
      `equip ${itemName} was not reflected in the live held item (found ${observed ?? 'empty'})`,
    )
  }

  private async placeOneCell(
    candidate: Candidate,
    target: Vec3Json,
    itemName: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    // SAFE, checked against the LIVE body immediately before the side effect:
    // a station is not placed by a body that is out of breath. The candidate
    // layer withholds submerged/dry-alternative spots and the guard refuses
    // stale ones, so this is the execution-time truth for the action that was
    // actually selected - the body must surface (Jev's choice of route), never
    // keep placing while the breath runs out.
    this.requireBreath(candidate, target, 'placing')
    const reference = this.findPlaceReference(target)
    if (reference === null) {
      throw new ExecutorError('place_error', `no supporting block adjacent to (${target.x},${target.y},${target.z})`)
    }
    this.setPhase(candidate, epoch, 'equipping')
    await this.equipPlacementItem(candidate, itemName, epoch, signal)
    this.setPhase(candidate, epoch, 'placing')
    try {
      this.assertEffect({
        type: 'place',
        position: { x: target.x, y: target.y, z: target.z },
        itemName,
      })
      await this.bot.placeBlock(reference.block, reference.face)
    } catch (error) {
      // The placement mechanism's own rejection was previously an untyped
      // `unknown_event`: mineflayer's `placeBlock` throws a plain `Error`
      // ("Server refused to place furnace at (57, 59, -3): the block is still
      // air", `lib/plugins/place_block.js`), which the runAction catch maps to
      // `unknown_event` because it is not an `ExecutorError`. Measured live
      // 2026-09-21T16:29:56.736Z: the whole `PLACE:furnace:p57_59_-3` retry run
      // was `reason=unknown_event` and no layer could tell a server refusal from
      // a crash. The verdict is read from world truth, not from the message.
      if (error instanceof ActionCancelled || error instanceof ExecutorError) throw error
      const observed = this.currentBlockAt(target)?.name ?? null
      const message = error instanceof Error ? error.message : String(error)
      throw new ExecutorError(
        'place_refused',
        `placement mechanism rejected ${itemName} at (${target.x},${target.y},${target.z}); observed block is ${observed ?? 'unknown'} (${message})`,
      )
    }
    this.ensureOwned(epoch, signal)
    const placedName = await this.waitForPlacedBlock(target, itemName, epoch, signal)
    if (!isPlacePostconditionMet(placedName, itemName)) {
      throw new ExecutorError(
        'verify_failed',
        `placeBlock did not create ${itemName} at (${target.x},${target.y},${target.z}) (found ${placedName ?? 'air'})`,
      )
    }
    return placedName
  }

  /**
   * The live body's breath/water facts. Read at the moment of the mechanical
   * side effect, so a stale candidate snapshot cannot authorize working under
   * water. `bot.oxygenLevel` is the server's `air_supply` metadata.
   *
   * Air is the SAFE trigger, so a body with breath to spare returns without any
   * block lookup and the two fluid cells are read only when the reading is
   * actually about to be reported - which keeps the common path free of extra
   * world reads. The full water facts for the semantic layer live on
   * `SelfState` (`buildSelf`), not here.
   */
  private liveSubmersion(): BodySubmersion {
    const air = (this.bot as { oxygenLevel?: number }).oxygenLevel
    if (typeof air !== 'number' || !Number.isFinite(air) || air > LOW_AIR_LEVEL) {
      return { air: typeof air === 'number' && Number.isFinite(air) ? air : MAX_AIR, feetInWater: false, eyesInWater: false, state: 'dry' }
    }
    const position = this.bot.entity.position
    const feet = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
    const eyes = { x: Math.floor(position.x), y: Math.floor(position.y + 1.62), z: Math.floor(position.z) }
    return bodySubmersion({
      air,
      feetInWater: this.fluidCell(feet),
      eyesInWater: this.fluidCell(eyes),
    })
  }

  private fluidCell(cell: Vec3Json): boolean {
    const block = this.bot.blockAt(toVec3(this.bot, cell))
    return block !== null && PROBE_FLUIDS.has(block.name)
  }

  /**
   * The SAFE stop for any mechanical action that would keep working under
   * water: emit the typed `BODY_SUBMERGED` survival fact once and fail the
   * action with `submerged`, which is what makes a low-air retry impossible
   * instead of silent.
   */
  private requireBreath(candidate: Candidate, at: Vec3Json, doing: string): void {
    const submersion = this.liveSubmersion()
    if (submersion.state !== 'out_of_air') return
    this.logger.warn('executor', formatBodySubmerged(submersion, at), {
      actionId: candidate.id,
      air: submersion.air,
      threshold: LOW_AIR_LEVEL,
      maxAir: MAX_AIR,
      doing,
      feetInWater: submersion.feetInWater,
      eyesInWater: submersion.eyesInWater,
    })
    throw new ExecutorError(
      'submerged',
      `breath at ${submersion.air}/${MAX_AIR} while ${doing} at (${at.x},${at.y},${at.z}); surface before continuing`,
    )
  }

  /**
   * The generic multi-cell PLACE run: walk to each ordered cell, place one block,
   * and emit the durable per-cell marker only after the post-condition holds. When
   * the item is a frame block the completed cell set must also pass
   * `validatePortalFrame` before PORTAL_FRAME_READY is emitted.
   */
  private async runPlaceCells(
    candidate: Candidate,
    cells: readonly Vec3Json[],
    itemName: string,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const placedCells: Vec3Json[] = []
    for (const cell of cells) {
      const existing = this.currentBlockAt(cell)?.name ?? null
      if (isPlacePostconditionMet(existing, itemName)) {
        placedCells.push(cell)
        this.emitFrameCell(candidate, itemName, existing, cell)
        continue
      }
      if (FRAME_PLACE_ITEMS.has(itemName)) {
        // A frame edge can be occupied by a leftover placement-scaffold block
        // (the live 2026-09-21 rebuild left cobblestone in the left-edge cells).
        // Placing obsidian there is impossible until it is cleared, so clear it
        // first; a non-scaffold obstruction is a typed terminal refusal.
        await this.clearFrameCellIfObstructed(candidate, cell, itemName, epoch, signal)
      }
      const reference = this.findPlaceReference(cell)
      const targetInReach = this.distanceToEyes(cell) <= this.options.reach
      const referenceInReach = reference !== null && this.distanceToEyes(reference.block.position) <= this.options.reach
      const placementInReach = reference === null ? targetInReach : referenceInReach
      if (!placementInReach || this.placementCellOverlapsBody(cell)) {
        this.setPhase(candidate, epoch, 'pathing')
        if (this.placementCellOverlapsBody(cell)) {
          const stand = this.findPlacementStand(cell)
          if (stand === null) {
            throw new ExecutorError('path_stuck', `no safe standing cell beside placement (${cell.x},${cell.y},${cell.z})`)
          }
          await this.pathToNear(stand, 0.75, epoch, signal)
        } else {
          const stand = reference === null ? null : this.findPlacementStandForReference(reference.block.position, cell)
          this.logger.info('executor', `PLACE_APPROACH target=${cell.x},${cell.y},${cell.z} reference=${reference === null ? 'none' : `${reference.block.position.x},${reference.block.position.y},${reference.block.position.z}`} stand=${stand === null ? 'target' : `${stand.x},${stand.y},${stand.z}`}`, {
            actionId: candidate.id,
            target: cell,
            reference: reference?.block.position ?? null,
            stand,
          })
          await this.pathToNear(stand ?? cell, stand === null ? 2 : 0.75, epoch, signal)
        }
        this.ensureOwned(epoch, signal)
      }
      if (this.placementCellOverlapsBody(cell)) {
        throw new ExecutorError('path_stuck', `placement cell remains inside bot body at (${cell.x},${cell.y},${cell.z})`)
      }
      if (FRAME_PLACE_ITEMS.has(itemName)) {
        await this.ensurePortalFrameSupport(candidate, cells, cell, epoch, signal)
      }
      const placedName = await this.placeOneCell(candidate, cell, itemName, epoch, signal)
      placedCells.push(cell)
      this.emitFrameCell(candidate, itemName, placedName, cell)
    }
    if (FRAME_PLACE_ITEMS.has(itemName)) {
      // `cells` is normally only the missing suffix of a sensed partial
      // frame. Validating that suffix alone can never prove a 10-edge frame,
      // so include the live obsidian edges that preceded this action.
      const widthAxis = candidate.placementAxis ?? 'x'
      const validation = this.portalFramePlacementValidation(cells, widthAxis)
      if (validation === null || validation.shape !== 'ok') {
        // This is a TYPED terminal cause, not a generic `verify_failed` retry.
        // The live M2 defect placed 152 obsidian cells and emitted zero
        // PORTAL_FRAME_READY because every batch ended in the untyped retry
        // loop. Name the layout that is still short and the cells still missing.
        const layout =
          validation !== null && validation.origin !== null
            ? portalFrameLayout(validation.origin, validation.widthAxis)
            : partialPortalFrameLayout(cells, widthAxis, (position) => this.currentBlockAt(position)?.name === OBSIDIAN)
        if (layout === null) {
          const line = formatFrameBuildUngrounded(cells.length, candidate.id)
          this.logger.warn('agent', line, { actionId: candidate.id, planned: cells.length })
          throw new ExecutorError('frame_build_ungrounded', line)
        }
        const planned = new Set(cells.map(portalCellKey))
        const missing = layout.frame.filter(
          (frameCell) => !planned.has(portalCellKey(frameCell)) && this.currentBlockAt(frameCell)?.name !== OBSIDIAN,
        )
        const line = formatFrameBuildIncomplete({
          planned: cells.length,
          placed: placedCells.length,
          missing,
          actionId: candidate.id,
        })
        this.logger.warn('agent', line, {
          actionId: candidate.id,
          planned: cells.length,
          placed: placedCells.length,
          missing: missing.length,
        })
        throw new ExecutorError('frame_build_incomplete', line)
      }
      const ready = formatPortalFrameReady(validation)
      this.logger.info('agent', ready, {
        source: 'placed',
        at: `${candidate.target?.x ?? 0},${candidate.target?.y ?? 0},${candidate.target?.z ?? 0}`,
        actionId: candidate.id,
        // Preserve the code-verified postcondition as structured evidence. The
        // human-readable marker is useful for diagnostics, but the run-scoped
        // M2 recorder must not have to parse it back into semantics.
        blocks: validation.blocks,
        shape: validation.shape,
      })
    }
    return this.buildResult(candidate, epoch, startedAt, 'done', 'placed', `placed ${itemName} at ${placedCells.length} cells`, null, {
      verified: true,
      dropObserved: false,
      blockRemoved: false,
      itemsGained: 0,
      goalItemCount: this.countItem(itemName),
    })
  }

  /**
   * Reconstruct the selected portal footprint from live obsidian plus the
   * already-selected placement suffix. The candidate remains the semantic
   * choice; this helper only recovers code-owned frame geometry needed for
   * placement support and the final post-condition.
   */
  private portalFramePlacementValidation(
    plannedCells: readonly Vec3Json[],
    widthAxis: 'x' | 'z',
  ): ReturnType<typeof validatePortalFrame> | null {
    if (plannedCells.length === 0) return null
    const planned = new Set(plannedCells.map(portalCellKey))
    const possibilities: Array<{
      validation: ReturnType<typeof validatePortalFrame>
      existing: number
      distance: number
    }> = []
    const seenOrigins = new Set<string>()
    for (const cell of plannedCells) {
      const width = widthAxis === 'x' ? cell.x : cell.z
      const normal = widthAxis === 'x' ? cell.z : cell.x
      for (let originWidth = width - 3; originWidth <= width; originWidth += 1) {
        for (let originY = cell.y - 4; originY <= cell.y; originY += 1) {
          const origin =
            widthAxis === 'x'
              ? { x: originWidth, y: originY, z: normal }
              : { x: normal, y: originY, z: originWidth }
          const originKey = portalCellKey(origin)
          if (seenOrigins.has(originKey)) continue
          seenOrigins.add(originKey)
          const layout = portalFrameLayout(origin, widthAxis)
          const frame = new Set(layout.frame.map(portalCellKey))
          if (plannedCells.some((plannedCell) => !frame.has(portalCellKey(plannedCell)))) continue
          const blocks = layout.frame.filter(
            (frameCell) =>
              planned.has(portalCellKey(frameCell)) || this.currentBlockAt(frameCell)?.name === OBSIDIAN,
          )
          if (blocks.length !== layout.frame.length) continue
          const validation = validatePortalFrame({ blocks, widthAxis })
          if (validation.shape !== 'ok') continue
          const existing = blocks.filter((block) => !planned.has(portalCellKey(block))).length
          const distance = this.distanceToEyes(origin)
          possibilities.push({ validation, existing, distance })
        }
      }
    }
    possibilities.sort((a, b) => {
      if (a.existing !== b.existing) return b.existing - a.existing
      if (a.distance !== b.distance) return a.distance - b.distance
      const ao = a.validation.origin
      const bo = b.validation.origin
      if (ao === null || bo === null) return 0
      return ao.y - bo.y || ao.x - bo.x || ao.z - bo.z
    })
    return possibilities[0]?.validation ?? null
  }

  /** A player must not occupy the target cell while the server processes placement. */
  private placementCellOverlapsBody(cell: Vec3Json): boolean {
    const entity = this.bot.entity as unknown as { position: { x: number; y: number; z: number }; width?: number; height?: number }
    const halfWidth = (entity.width ?? 0.6) / 2
    const height = entity.height ?? 1.8
    const bodyMinX = entity.position.x - halfWidth
    const bodyMaxX = entity.position.x + halfWidth
    const bodyMinZ = entity.position.z - halfWidth
    const bodyMaxZ = entity.position.z + halfWidth
    return (
      bodyMaxX > cell.x &&
      bodyMinX < cell.x + 1 &&
      bodyMaxZ > cell.z &&
      bodyMinZ < cell.z + 1 &&
      entity.position.y + height > cell.y &&
      entity.position.y < cell.y + 1
    )
  }

  /** Find a real supported feet cell that is adjacent enough to place `target`. */
  private findPlacementStand(target: Vec3Json): Vec3Json | null {
    return this.findPlacementStandAtLevel(target, target.y, target)
  }

  /**
   * Find a supported feet cell beside a real placement reference.  A target
   * above an existing frame edge can be out of reach even though its support
   * block is reachable from the lower level.  Walking to that lower adjacent
   * cell is executor geometry, not a replacement for the selected placement
   * candidate.
   */
  private findPlacementStandForReference(reference: Vec3Json, target: Vec3Json): Vec3Json | null {
    for (const feetY of [reference.y - 2, reference.y - 1, reference.y, reference.y + 1]) {
      const stand = this.findPlacementStandAtLevel(reference, feetY, target)
      if (stand !== null) return stand
    }
    return null
  }

  private findPlacementStandAtLevel(target: Vec3Json, feetY: number, avoidCell: Vec3Json | null): Vec3Json | null {
    const offsets = [
      { x: -1, z: 0 },
      { x: 1, z: 0 },
      { x: 0, z: -1 },
      { x: 0, z: 1 },
      { x: -1, z: -1 },
      { x: -1, z: 1 },
      { x: 1, z: -1 },
      { x: 1, z: 1 },
    ]
    for (const offset of offsets) {
      const feet = { x: target.x + offset.x, y: feetY, z: target.z + offset.z }
      const feetBlock = this.currentBlockAt(feet)
      const headBlock = this.currentBlockAt({ x: feet.x, y: feet.y + 1, z: feet.z })
      const belowBlock = this.currentBlockAt({ x: feet.x, y: feet.y - 1, z: feet.z })
      if (feetBlock?.boundingBox !== 'empty' || headBlock?.boundingBox !== 'empty') continue
      if (belowBlock?.boundingBox !== 'block') continue
      if (avoidCell !== null && feet.x === avoidCell.x && feet.z === avoidCell.z && feet.y <= avoidCell.y && feet.y + 1.8 > avoidCell.y) continue
      return feet
    }
    return null
  }

  /**
   * Clear a placement-scaffold block that occupies a frame cell, so the
   * obsidian can go in. The clear is a mechanically necessary prerequisite
   * (buddy-driver AGENTS §2): no semantic choice exists once the frame geometry
   * is selected. It reuses the real dig path (`equipTool`/`digBlock`), so the
   * `isProtectedStationBlock` refusal and the dig budget still own safety. Any
   * block that is not a known placement scaffold, or that cannot be dug, is a
   * typed `FRAME_BUILD_BLOCKED` refusal instead of a silent verify loop.
   */
  private async clearFrameCellIfObstructed(
    candidate: Candidate,
    cell: Vec3Json,
    itemName: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const block = this.currentBlockAt(cell)
    if (block === null || block.boundingBox === 'empty' || block.name === itemName) return
    const pickaxe = this.bot.inventory.items().find((entry) => entry.name.endsWith('_pickaxe'))
    if (pickaxe !== undefined) await this.equipItemTo(pickaxe, 'hand', epoch, signal)
    // Only clear the exact material this build uses for its temporary support
    // (`findPortalScaffoldItem` = the first held PILLAR_PLACE_PRIORITY item).
    // That removes the agent's own scaffold without excavating natural terrain
    // that merely happens to sit in the ring; anything else is typed refused.
    const scaffoldItem = this.findPortalScaffoldItem()
    if (scaffoldItem === undefined || block.name !== scaffoldItem.name || !this.bot.canDigBlock(block)) {
      const line = formatFrameBuildBlocked({ cell, block: block.name, actionId: candidate.id })
      this.logger.warn('agent', line, { actionId: candidate.id, cell, block: block.name })
      throw new ExecutorError('frame_build_blocked', line)
    }
    this.setPhase(candidate, epoch, 'digging')
    await this.digBlock(block, epoch, signal)
    this.ensureOwned(epoch, signal)
    const after = this.currentBlockAt(cell)
    if (after !== null && after.boundingBox === 'block') {
      const line = formatFrameBuildBlocked({ cell, block: after.name, actionId: candidate.id })
      this.logger.warn('agent', line, { actionId: candidate.id, cell, block: after.name })
      throw new ExecutorError('frame_build_blocked', line)
    }
    this.logger.info('agent', `PORTAL_FRAME_CELL_CLEARED cell=${cell.x},${cell.y},${cell.z} block=${block.name}`, {
      actionId: candidate.id,
      cell,
      block: block.name,
    })
  }

  /**
   * The minimal 10-edge frame omits the corner blocks that ordinary placement
   * needs as supports.  Add only the corner scaffolds required by the already-
   * selected frame skill, then continue placing obsidian.  This remains
   * executor mechanics and never becomes a semantic candidate.
   */
  private async ensurePortalFrameSupport(
    candidate: Candidate,
    cells: readonly Vec3Json[],
    cell: Vec3Json,
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const widthAxis = candidate.placementAxis ?? 'x'
    // Support is needed ONLY when the cell has no adjacent reference; cells that
    // already have one place normally.
    if (this.findPlaceReference(cell) !== null) return
    // Support is needed precisely while the frame is INCOMPLETE. Deriving the
    // layout from the full-frame validation first (the old gate) made this step
    // unreachable for every partial frame: `PORTAL_SUPPORT_PLACED=0` with a
    // declared `temporarySupportRequired` site (live 2026-09-21). Prefer the
    // validated layout when the batch does complete a frame; otherwise fall back
    // to the partial layout that contains the planned cells.
    const validation = this.portalFramePlacementValidation(cells, widthAxis)
    const layout =
      validation !== null && validation.shape === 'ok' && validation.origin !== null
        ? portalFrameLayout(validation.origin, validation.widthAxis)
        : partialPortalFrameLayout(cells, widthAxis, (position) => this.currentBlockAt(position)?.name === OBSIDIAN)
    if (layout === null) {
      const line = formatFrameBuildUngrounded(cells.length, candidate.id)
      this.logger.warn('agent', line, { actionId: candidate.id, planned: cells.length, axis: widthAxis })
      throw new ExecutorError('frame_build_ungrounded', line)
    }
    // The minimal frame omits all four corners. Pick a corner adjacent to the
    // current target first; a merely placeable lower corner cannot support a
    // disconnected top-edge placement.
    const manhattan = (left: Vec3Json, right: Vec3Json): number =>
      Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.z - right.z)
    const scaffold = [...layout.corners]
      .sort((a, b) => manhattan(a, cell) - manhattan(b, cell))
      .find((corner) => {
        const existing = this.currentBlockAt(corner)
        return existing?.boundingBox !== 'block' && manhattan(corner, cell) === 1 && this.findPlaceReference(corner) !== null
      })
    if (scaffold === undefined) return
    const supportItem = this.findPortalScaffoldItem()
    if (supportItem === undefined) {
      throw new ExecutorError('place_error', 'no temporary support block is available for the minimal obsidian frame')
    }
    const scaffoldReference = this.findPlaceReference(scaffold)
    if (this.placementCellOverlapsBody(scaffold)) {
      // The bot can arrive inside the empty top edge while continuing a
      // sensed frame. Find a supported lower-level stand beside the existing
      // edge that supports the optional corner, rather than demanding a
      // standable block at the same empty top level.
      const stand =
        scaffoldReference === null
          ? this.findPlacementStand(scaffold)
          : this.findPlacementStandForReference(scaffoldReference.block.position, scaffold)
      if (stand === null) throw new ExecutorError('path_stuck', `no safe standing cell beside portal scaffold (${scaffold.x},${scaffold.y},${scaffold.z})`)
      this.setPhase(candidate, epoch, 'pathing')
      await this.pathToNear(stand, 0.75, epoch, signal)
      this.ensureOwned(epoch, signal)
    }
    const reference = this.findPlaceReference(scaffold)
    if (reference === null) {
      throw new ExecutorError('place_error', `no supporting block adjacent to portal scaffold (${scaffold.x},${scaffold.y},${scaffold.z})`)
    }
    this.setPhase(candidate, epoch, 'equipping')
    await this.equipPlacementItem(candidate, supportItem.name, epoch, signal)
    this.setPhase(candidate, epoch, 'placing')
    this.assertEffect({
      type: 'place',
      position: { x: scaffold.x, y: scaffold.y, z: scaffold.z },
      itemName: supportItem.name,
    })
    await this.bot.placeBlock(reference.block, reference.face)
    this.ensureOwned(epoch, signal)
    const placedName = await this.waitForPlacedBlock(scaffold, supportItem.name, epoch, signal)
    if (!isPlacePostconditionMet(placedName, supportItem.name)) {
      throw new ExecutorError('verify_failed', `portal scaffold did not appear at (${scaffold.x},${scaffold.y},${scaffold.z})`)
    }
    this.logger.info('agent', `PORTAL_SUPPORT_PLACED item=${supportItem.name} pos=${scaffold.x},${scaffold.y},${scaffold.z}`, {
      source: 'placed',
      at: `${scaffold.x},${scaffold.y},${scaffold.z}`,
      itemName: supportItem.name,
      actionId: candidate.id,
    })
  }

  private findPortalScaffoldItem(): Item | undefined {
    for (const name of PILLAR_PLACE_PRIORITY) {
      const item = this.bot.inventory.items().find((entry) => entry.name === name)
      if (item !== undefined) return item
    }
    return undefined
  }

  private emitFrameCell(candidate: Candidate, itemName: string, placedName: string | null, cell: Vec3Json): void {
    const line = placedFrameCellLine(itemName, placedName, cell)
    if (line === null) return
    this.logger.info('agent', line, {
      source: 'placed',
      at: `${cell.x},${cell.y},${cell.z}`,
      target: cell,
      actionId: candidate.id,
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

  /**
   * Live ignition: use flint_and_steel on a validated frame, then require the
   * nether_portal block at every expected interior cell before claiming success.
   * The activation goes through the leased actuation port when one is present.
   */
  private async runIgnite(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', 'IGNITE candidate has no light position')
    const expectedCells = parsePortalCells(readMetaString(candidate, 'portalCells') ?? '')
    if (expectedCells.length === 0) {
      throw new ExecutorError('place_error', 'IGNITE candidate carries no expected portal cells')
    }
    const dimension = readMetaString(candidate, 'dimension') ?? 'minecraft:overworld'

    const held = this.bot.inventory.items().find((entry) => entry.name === FLINT_AND_STEEL)
    if (held === undefined) {
      throw new ExecutorError('place_error', `${PRECONDITION_MISSING} tool=${FLINT_AND_STEEL}`)
    }

    if (!candidate.inReach && this.distanceToEyes(target) > this.options.reach) {
      this.setPhase(candidate, epoch, 'pathing')
      await this.pathTo(target, epoch, signal, 'GoalBlock')
      this.ensureOwned(epoch, signal)
    }
    if (this.distanceToEyes(target) > this.options.reach) {
      throw new ExecutorError(
        'out_of_reach',
        `light position is ${round2(this.distanceToEyes(target))}m from the eyes (reach ${this.options.reach})`,
      )
    }

    this.setPhase(candidate, epoch, 'equipping')
    this.assertEffect({ type: 'equip', itemName: held.name, destination: 'hand' })
    if (this.options.actuationPort !== undefined) {
      await this.options.actuationPort.equip(held, 'hand')
    } else {
      await this.bot.equip(held, 'hand')
    }
    this.ensureOwned(epoch, signal)

    const block = this.currentBlockAt(target)
    if (block === null) {
      throw new ExecutorError('target_gone', `no block at the light position (${target.x},${target.y},${target.z})`)
    }
    this.setPhase(candidate, epoch, 'igniting')
    if (this.options.actuationPort !== undefined) {
      await this.options.actuationPort.activateBlock(block)
    } else {
      await this.bot.activateBlock(block)
    }
    this.ensureOwned(epoch, signal)

    this.setPhase(candidate, epoch, 'verifying')
    const observed = await this.waitForPortalBlocks(expectedCells, epoch, signal)
    if (!isIgnitePostconditionMet(observed)) {
      const found = observed.map((name) => name ?? 'air').join(',')
      throw new ExecutorError(
        'verify_failed',
        `activation did not create ${NETHER_PORTAL} at every portal cell (found [${found}])`,
      )
    }

    this.logger.info('agent', formatPortalLit(target, dimension), { actionId: candidate.id, target, dimension })
    this.logger.info('agent', verifyPortal({ lit: true, portalBlockPresent: true, dimension }).line, {
      actionId: candidate.id,
      dimension,
      verified: true,
    })

    return this.buildResult(
      candidate,
      epoch,
      startedAt,
      'done',
      'ignited',
      `lit ${NETHER_PORTAL} at (${target.x},${target.y},${target.z})`,
      null,
      {
        verified: true,
        dropObserved: false,
        blockRemoved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
      },
    )
  }

  private async waitForPortalBlocks(
    cells: readonly Vec3Json[],
    epoch: number,
    signal: AbortSignal,
  ): Promise<(string | null)[]> {
    const read = (): (string | null)[] => cells.map((cell) => this.currentBlockAt(cell)?.name ?? null)
    const deadline = Date.now() + PLACE_VERIFY_SETTLE_MS
    let observed = read()
    while (!isIgnitePostconditionMet(observed) && Date.now() < deadline) {
      await delay(50, signal)
      this.ensureOwned(epoch, signal)
      observed = read()
    }
    return observed
  }

  /**
   * The lit-interior precondition, with observation separated from truth.
   * `true` = every expected cell is observed and is `nether_portal`; `false` =
   * every cell observed and at least one is not (a real refusal); `null` = at
   * least one cell could not be observed, so no claim is possible. The transfer
   * postcondition (the dimension change) stays the authority either way.
   */
  private portalInteriorLit(expectedCells: readonly Vec3Json[]): boolean | null {
    const names = expectedCells.map((cell) => this.currentBlockAt(cell)?.name ?? null)
    if (names.some((name) => name === null)) return null
    return isIgnitePostconditionMet(names)
  }

  /**
   * Dimension transfer: walk INTO the lit `nether_portal` and require the bot's
   * own dimension to become the target (`minecraft:the_nether`) before claiming
   * success. Body motion is not completion: if the dimension does not change
   * within the bounded window the action FAILS with `verify_failed`, so a lit
   * portal the server never transfers through can never look done.
   *
   * The portal must still be lit at the moment of entry (live world truth), not
   * merely lit when the candidate was generated.
   */
  private async runEnterPortal(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<ExecutionResult> {
    const target = candidate.target
    if (target === null) throw new ExecutorError('target_gone', 'ENTER_PORTAL candidate has no entry cell')
    const expectedCells = parsePortalCells(readMetaString(candidate, 'portalCells') ?? '')
    if (expectedCells.length === 0) {
      throw new ExecutorError('place_error', 'ENTER_PORTAL candidate carries no portal cells')
    }
    const dimension = readMetaString(candidate, 'dimension') ?? NETHER
    const enterCell = {
      x: readMetaNumber(candidate, 'enterX', target.x),
      y: readMetaNumber(candidate, 'enterY', target.y),
      z: readMetaNumber(candidate, 'enterZ', target.z),
    }

    // Issue #436: the entry Skill states its own boundary up front - the target
    // is the SELECTED portal site, and everything after this is code finishing
    // that choice mechanically. The commitment identity, the declared
    // postcondition and the declared effect envelope travel with it, so every
    // later SKILL_STEP/SKILL_POLICY_BOUNDARY/SKILL_END line can be tied to this
    // one Jev decision (§17). The `SKILL_COMMIT` line itself is emitted by the
    // canonical commitment module (lane task/skill-commitment-phase1), not here.
    this.logger.info(
      'agent',
      formatSkillStart(
        PORTAL_ENTER_SKILL,
        this.portalEntrySelectionSource(candidate),
        `site=${this.portalSiteOrigin(expectedCells, enterCell)} enter=${enterCell.x},${enterCell.y},${enterCell.z} dimension=${dimension}` +
          ` commitmentId=${this.portalCommitmentId(candidate, epoch)}` +
          ` targetIdentity=${this.portalTargetIdentity(enterCell, dimension)}` +
          ` postcondition=${PORTAL_ENTER_POSTCONDITION} envelope=${portalEntryEffectEnvelope(candidate)}`,
      ),
      { actionId: candidate.id, target: enterCell, dimension },
    )

    // Hard world truth at entry time: the interior must still be nether_portal.
    // An UNOBSERVED interior cell (chunks unloaded while the body is far from a
    // remembered gate) is not evidence that the portal is unlit, so the route is
    // attempted and the lit fact is re-verified on arrival - a fabricated
    // `portal=lit` refusal here would make "walk back to your remembered gate"
    // impossible. A cell that WAS observed and is not nether_portal still refuses
    // before any movement.
    if (this.portalInteriorLit(expectedCells) === false) {
      this.logger.warn('agent', formatSkillInterrupt(PORTAL_ENTER_SKILL, 'precondition_lit'), {
        actionId: candidate.id,
        target: enterCell,
      })
      throw new ExecutorError('place_error', `${PRECONDITION_MISSING} portal=lit`)
    }
    if (this.dimensionMatches(dimension)) {
      return this.enteredResult(candidate, epoch, startedAt, enterCell, dimension)
    }

    const timeoutMs = this.options.portalEnterTimeoutMs ?? PORTAL_ENTER_TIMEOUT_MS
    // The body gets in by the SAME generic locomotion move every other MOVE uses:
    // `pathTo` with an exact `GoalBlock` to the standable interior cell. When
    // that plain walk cannot reach the cell - the live case (run-mubj6ucc-si3e,
    // source 52594db) was a body ~14 blocks BELOW a lit, valid gate behind
    // diggable terrain - the candidate's grounded vertical/dig contract (the
    // SAME `vertical` meta a MOVE candidate carries) runs the ordinary vertical
    // leg here, and the walk is retried once after that chunk opens the way. The
    // dig budget / protection guards are the shared dig path's; this adds no
    // portal-specific mechanic. Standing inside a portal block is a world
    // mechanic, not a skill.
    this.setPhase(candidate, epoch, 'pathing')
    this.logPortalStep(
      candidate,
      epoch,
      'path',
      'MECHANICAL_CONTINUATION',
      `target=${enterCell.x},${enterCell.y},${enterCell.z}`,
      'none',
    )
    // Abort the generic path the moment the server transfers us, so no fallback
    // keeps steering a body that is already in the other dimension.
    const transferSignal = new AbortController()
    const onCallerAbort = (): void => transferSignal.abort()
    if (signal.aborted) transferSignal.abort()
    signal.addEventListener('abort', onCallerAbort, { once: true })
    const watchingTransfer = (async (): Promise<void> => {
      while (!transferSignal.signal.aborted) {
        if (this.dimensionMatches(dimension)) {
          transferSignal.abort()
          return
        }
        try {
          await delay(50, transferSignal.signal)
        } catch {
          return
        }
      }
    })()
    const startY = this.bot.entity.position.y
    let pathError: unknown = null
    let progressedChunk = false
    let activeVertical = 'none'
    let legObstruction: string | null = null
    let climbEvidence: string | null = null
    try {
      await this.pathTo(enterCell, epoch, transferSignal.signal, 'GoalBlock', { requireLevel: true })
    } catch (error) {
      // A transfer during the path is already the postcondition; anything else
      // (including a caller abort) is a real failure.
      if (!this.dimensionMatches(dimension)) {
        pathError = error
        let leg: {
          progressed: boolean
          error: ExecutorError | null
          activeVertical: string
          obstruction: string | null
          climbRefusal: string | null
          climbEvidence: string | null
        }
        try {
          leg = await this.runEntryRouteLeg(candidate, epoch, transferSignal.signal, enterCell, startY)
        } catch (legThrow) {
          // A transfer (or caller abort) during the route leg is not a route
          // failure: if the dimension changed, the postcondition is already met;
          // otherwise the cancellation is real and must propagate.
          if (!this.dimensionMatches(dimension)) throw legThrow
          leg = {
            progressed: false,
            error: null,
            activeVertical: 'none',
            obstruction: null,
            climbRefusal: null,
            climbEvidence: null,
          }
          pathError = null
        }
        activeVertical = leg.activeVertical
        legObstruction = leg.obstruction
        // Every composed-climb leg's own outcome travels into the terminal line's
        // `climb=` field: which climb ran, in which order, and how each ended.
        if (leg.climbEvidence !== null) climbEvidence = leg.climbEvidence
        if (leg.progressed) {
          // The chunk durably moved the body toward the cell: the same bounded
          // ONE-chunk-per-action policy MOVE uses. Retry the walk once inside
          // this action, so a single chunk that opens the way still completes
          // the entry instead of spending a decision on the climb alone.
          progressedChunk = true
          if (!this.dimensionMatches(dimension)) {
            try {
              await this.pathTo(enterCell, epoch, transferSignal.signal, 'GoalBlock', { requireLevel: true })
              pathError = null
              progressedChunk = false
            } catch (retry) {
              if (!this.dimensionMatches(dimension)) pathError = retry
            }
          }
          if (this.dimensionMatches(dimension)) {
            progressedChunk = false
            pathError = null
          }
        } else if (leg.error !== null) {
          pathError = leg.error
        }
      }
    } finally {
      transferSignal.abort()
      signal.removeEventListener('abort', onCallerAbort)
      await watchingTransfer
    }
    this.ensureOwned(epoch, signal)
    if (!this.dimensionMatches(dimension) && progressedChunk) {
      // Durable body progress, entry not reached: a bounded chunk, never DONE.
      // The goal stays open and the next decision re-plans from the new Y.
      const climbedTo = Math.floor(this.bot.entity.position.y)
      const startFloorY = Math.floor(startY)
      const descending = enterCell.y < startFloorY
      this.logger.info(
        'agent',
        descending
          ? formatDescentChunk(startFloorY, climbedTo, enterCell.y)
          : formatAscentProgress(startFloorY, climbedTo, enterCell.y),
        {
          actionId: candidate.id,
          target: enterCell,
          vertical: activeVertical,
        },
      )
      return this.buildResult(
        candidate,
        epoch,
        startedAt,
        'done',
        descending ? 'descended' : 'climbed',
        `${descending ? 'descended' : 'climbed'} from y=${startFloorY} to y=${climbedTo} toward the portal entry at (${enterCell.x},${enterCell.y},${enterCell.z}) (bounded chunk; next decision re-plans)`,
        null,
        {
          verified: false,
          blockRemoved: activeVertical === 'staircase' || activeVertical === 'staircase-up',
          dropObserved: descending,
          itemsGained: 0,
          goalItemCount: this.countGoalItem(),
          progressed: true,
        },
      )
    }
    if (!this.dimensionMatches(dimension) && pathError !== null) {
      // LAST RESORT, still inside the same action: the interior cell of a lit
      // portal is non-solid, so the stock actuator refuses to execute the plan
      // node at all (measured: `path_stuck` with the body moved zero blocks).
      // One bounded direct walk owns the last few blocks; it reports its own
      // `PORTAL_WALK_IN ... transferred=...` and never claims the postcondition.
      const walk = await this.walkIntoPortalEntry(candidate, epoch, signal, enterCell, dimension)
      if (this.dimensionMatches(dimension)) {
        return this.enteredResult(candidate, epoch, startedAt, enterCell, dimension)
      }
      if (walk.inside) {
        // The body now stands in the interior: the ordinary arrival half (lit
        // re-verification + bounded portal delay) owns the transfer wait.
        return await this.completePortalEntry(
          candidate,
          epoch,
          signal,
          startedAt,
          enterCell,
          dimension,
          expectedCells,
          timeoutMs,
        )
      }
      // The straight walk could not get in. When a frame column is what stands
      // between the body and the interior, the mechanical next step is to STAND
      // SOMEWHERE ELSE: one bounded step-aside onto an open face of the portal,
      // reported as a durable chunk so the next decision re-grounds the entry
      // from a cell that can walk in (the operator's "step one block aside").
      const leg = await this.stepOntoPortalFace(candidate, epoch, signal, enterCell, expectedCells, dimension)
      if (leg.moved) {
        return this.entryProgressResult(
          candidate,
          epoch,
          startedAt,
          `stepped aside onto the portal's open face at (${leg.cell?.x ?? '?'},${leg.cell?.y ?? '?'},${leg.cell?.z ?? '?'}) ` +
            `(bounded chunk toward the entry at (${enterCell.x},${enterCell.y},${enterCell.z}); next decision re-grounds the walk in)`,
          false,
        )
      }
      // No route, no durable body change and no step-aside: ONE typed failure
      // naming the obstruction, so the option can be abandoned instead of
      // re-arming the same unreachable walk (the live run alternated
      // `noPath`/`stuck`).
      const blocked = this.portalEntryRouteBlockedLine(candidate, enterCell, pathError, legObstruction, climbEvidence)
      this.logger.warn('agent', blocked, {
        actionId: candidate.id,
        failure: pathError instanceof ExecutorError ? pathError.code : 'unknown_event',
        target: enterCell,
        fromY: Math.floor(this.bot.entity.position.y),
        toY: enterCell.y,
      })
      const finalCode: FailureCode = pathError instanceof ExecutorError ? pathError.code : 'path_no_path'
      throw new ExecutorError(finalCode, blocked)
    }
    if (!this.dimensionMatches(dimension)) {
      // Arrival re-verification of the lit precondition: the route may have
      // targeted a REMEMBERED site whose interior was unobservable from the
      // offering position, so the world truth is read again here, where the
      // chunks are loaded. Observed-and-unlit fails typed, once.
      if (this.portalInteriorLit(expectedCells) === false) {
        this.logger.warn('agent', formatSkillInterrupt(PORTAL_ENTER_SKILL, 'precondition_lit'), {
          actionId: candidate.id,
          target: enterCell,
        })
        throw new ExecutorError('place_error', `${PRECONDITION_MISSING} portal=lit`)
      }
      // A route that reported arrival can stop one cell short of the interior
      // (the walk target is a cell, the arrival test is a tolerance): when the
      // geometry is already adjacent, ONE bounded direct walk closes the last
      // block instead of waiting out the portal delay beside the gate.
      const walk = await this.walkIntoPortalEntry(candidate, epoch, signal, enterCell, dimension)
      if (this.dimensionMatches(dimension)) {
        return this.enteredResult(candidate, epoch, startedAt, enterCell, dimension)
      }
      if (!walk.inside) {
        // Arrival one cell short behind the frame: the same bounded step-aside,
        // otherwise the body waits out the portal delay beside its own gate.
        const leg = await this.stepOntoPortalFace(candidate, epoch, signal, enterCell, expectedCells, dimension)
        if (leg.moved) {
          return this.entryProgressResult(
            candidate,
            epoch,
            startedAt,
            `stepped aside onto the portal's open face at (${leg.cell?.x ?? '?'},${leg.cell?.y ?? '?'},${leg.cell?.z ?? '?'}) ` +
              `(bounded chunk toward the entry at (${enterCell.x},${enterCell.y},${enterCell.z}); next decision re-grounds the walk in)`,
            false,
          )
        }
      }
      return await this.completePortalEntry(
        candidate,
        epoch,
        signal,
        startedAt,
        enterCell,
        dimension,
        expectedCells,
        timeoutMs,
      )
    }
    return this.enteredResult(candidate, epoch, startedAt, enterCell, dimension)
  }

  /**
   * The arrival half of the entry, shared by the ordinary route and the direct
   * walk: re-verify the lit precondition where the chunks are loaded, then wait
   * out the server-side portal delay under a bounded deadline. Standing in the
   * lit portal block is the transfer trigger because Mineflayer cannot observe
   * the server's timer - so the postcondition stays the DIMENSION change, never
   * the body motion.
   */
  private async completePortalEntry(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    startedAt: number,
    enterCell: Vec3Json,
    dimension: string,
    expectedCells: readonly Vec3Json[],
    timeoutMs: number,
  ): Promise<ExecutionResult> {
    if (!this.dimensionMatches(dimension)) {
      // Arrival re-verification of the lit precondition: the route may have
      // targeted a REMEMBERED site whose interior was unobservable from the
      // offering position, so the world truth is read again here, where the
      // chunks are loaded. Observed-and-unlit fails typed, once.
      if (this.portalInteriorLit(expectedCells) === false) {
        throw new ExecutorError('place_error', `${PRECONDITION_MISSING} portal=lit`)
      }
      // Standing in the lit portal block is the transfer trigger; wait out the
      // server-side portal delay under a bounded deadline.
      this.setPhase(candidate, epoch, 'entering')
      this.logPortalStep(
        candidate,
        epoch,
        'enter',
        'MECHANICAL_CONTINUATION',
        `cell=${enterCell.x},${enterCell.y},${enterCell.z}`,
        'none',
      )
      const deadline = Date.now() + timeoutMs
      while (!this.dimensionMatches(dimension) && Date.now() < deadline) {
        await delay(100, signal)
        this.ensureOwned(epoch, signal)
      }
    }
    if (!this.dimensionMatches(dimension)) {
      throw new ExecutorError(
        'verify_failed',
        `dimension did not become ${dimension} within ${timeoutMs}ms of entering the portal`,
      )
    }
    return this.enteredResult(candidate, epoch, startedAt, enterCell, dimension)
  }

  /**
   * Bounded DIRECT WALK into a non-solid portal interior cell - the motor of
   * last resort when every path/vertical route is spent.
   *
   * MEASURED (live run-muc9k936-1f3vb + offline replay of the real
   * `mineflayer-pathfinder@2.4.5` planner/physics on that geometry): the
   * interior cell is NOT rejected by the movement rules - `movements.getBlock`
   * reports it `safe=true physical=false`, and both `getMoveDiagonal` and
   * `getMoveJumpUp` emit it as an A* neighbour (`movements.js:439-458`). The
   * refusal is in the ACTUATOR: before it sets `forward`, the control loop asks
   * `canStraightLine`/`canSprintJump`/`canWalkJump` (`index.js:614-629`) and
   * zeroes `forward` when none confirms the next node, so the body never moves
   * and the 3.5s futility watchdog fires `path_reset('stuck')`
   * (`index.js:631-635`) -> `path_stuck`. Replaying prismarine-physics on the
   * measured stand shows why: a walk-jump toward the cell pins the body against
   * the frame's south face (z frozen at contact while the body is already
   * high enough), never entering. The SAME simulation enters in 21 ticks when
   * the body faces the cell CENTRE, holds forward and jumps pre-emptively while
   * grounded - which is the audited control-walk recipe this method runs.
   *
   * Preconditions are hard world truth read before any movement: adjacency
   * (`<= PORTAL_WALK_IN_MAX_DISTANCE`), level (one block), the destination is
   * still a non-solid portal cell, a step-up target has a floor, and no
   * lava/fire/fluid lies under the body or on the walk. A refusal is typed and
   * moves nothing. The walk is bounded by a hard budget AND a distance-progress
   * check, aborts on the observed dimension change, and reports
   * `PORTAL_WALK_IN ... transferred=...`; it never claims the postcondition.
   */
  private async walkIntoPortalEntry(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    enterCell: Vec3Json,
    dimension: string,
  ): Promise<PortalWalkInOutcome> {
    const fromD = this.portalCellDistance(enterCell)
    const feetY = Math.floor(this.bot.entity.position.y)
    const refuse = (refusal: PortalWalkInRefusal): PortalWalkInOutcome => {
      this.logger.warn('agent', formatPortalWalkInRefused(enterCell, fromD, refusal), {
        actionId: candidate.id,
        cell: enterCell,
        refusal,
      })
      return { attempted: false, inside: false, transferred: false, fromD, toD: fromD, refusal }
    }

    // Not beside the gate: nothing portal-specific to do, and no marker - the
    // ordinary route's own failure is the honest report.
    if (fromD > PORTAL_WALK_IN_MAX_DISTANCE) {
      return { attempted: false, inside: false, transferred: false, fromD, toD: fromD, refusal: null }
    }
    if (Math.abs(this.bot.entity.position.y - enterCell.y) > PORTAL_WALK_IN_LEVEL_TOLERANCE) {
      return refuse('not_level')
    }
    if (!this.portalCellTraversable(enterCell)) return refuse('cell_not_traversable')
    const hazard = this.portalWalkHazard(enterCell, feetY)
    if (hazard !== null) return refuse(hazard)
    const stepUp = enterCell.y - this.bot.entity.position.y > 0.5
    if (stepUp && !this.solidSupportAt(enterCell.x, enterCell.y - 1, enterCell.z)) return refuse('no_support')
    // A frame column between the body and the interior is an unsteppable face:
    // the straight walk can never get in, and the caller grounds the step-aside
    // leg onto an open face instead. U2: the refusal carries the EXACT blocking
    // cells, not "something is in the way".
    const blockers = this.portalApproachBlockers(enterCell, feetY)
    if (blockers.length > 0) {
      const refusal = refuse('approach_occluded')
      this.logger.warn('agent', `PORTAL_WALK_IN_BLOCKED blocker=${this.portalBlockerEvidence(blockers)}`, {
        actionId: candidate.id,
        target: enterCell,
        blocker: this.portalBlockerEvidence(blockers),
      })
      return refusal
    }
    // Already in the interior's own cell space: the server's transfer is the only
    // thing left, so do not push the body out the far side.
    if (this.portalInsideInterior(enterCell)) {
      return { attempted: false, inside: true, transferred: false, fromD, toD: fromD, refusal: null }
    }

    // REFLEX (#436): with the interior cell adjacent, level and unoccluded, the
    // continuation is the SELECTED target itself - there is no second way in to
    // rank, so code finishes the choice with one bounded control walk.
    this.logger.info(
      'agent',
      formatReflex({
        ownerSkill: PORTAL_ENTER_SKILL,
        action: 'walk_into_portal_interior',
        evidence:
          `enter=${enterCell.x},${enterCell.y},${enterCell.z} is the selected target and the only ` +
          `non-solid portal cell within ${PORTAL_WALK_IN_MAX_DISTANCE} (d=${round2(fromD)} ` +
          `dy=${round2(enterCell.y - this.bot.entity.position.y)} step_up=${stepUp} occluded=false)`,
      }),
      { actionId: candidate.id, target: enterCell },
    )
    this.logPortalStep(
      candidate,
      epoch,
      'walk_in',
      'MECHANICAL_CONTINUATION',
      `cell=${enterCell.x},${enterCell.y},${enterCell.z} from_d=${round2(fromD)} step_up=${stepUp}`,
      'none',
    )
    const savedPhysics = this.bot.physicsEnabled
    const uninstallGroundCorrection = installGroundCorrection(this.bot, (x, y, z) => this.solidSupportAt(x, y, z))
    this.bot.physicsEnabled = true
    const deadline = Date.now() + PORTAL_WALK_IN_BUDGET_MS
    let bestD = fromD
    let lastProgressAt = Date.now()
    let toD = fromD
    let hops = 0
    try {
      while (Date.now() < deadline && !this.dimensionMatches(dimension)) {
        this.ensureOwned(epoch, signal)
        const position = this.bot.entity.position
        toD = this.portalCellDistance(enterCell)
        if (toD <= bestD - PORTAL_WALK_IN_MIN_PROGRESS) {
          bestD = toD
          lastProgressAt = Date.now()
        }
        if (toD <= PORTAL_WALK_IN_INSIDE_RADIUS) {
          // Inside the interior: the server's portal delay owns the rest.
          await delay(100, signal)
          continue
        }
        if (Date.now() - lastProgressAt > PORTAL_WALK_IN_NO_PROGRESS_MS) break
        if (!this.portalCellTraversable(enterCell)) break
        this.setControlState('back', false)
        // Face the cell CENTRE (the measured recipe; the pathfinder steers at the
        // node corner and rubs the frame instead).
        await this.bot
          .lookAt(this.bot.entity.position.offset(enterCell.x + 0.5 - position.x, 0, enterCell.z + 0.5 - position.z), true)
          .catch(() => undefined)
        if (enterCell.y - this.bot.entity.position.y > 0.5) {
          // The threshold is a block above the feet: one audited hop. A pinned
          // body must release forward for the pure jump (the server rejects a
          // blocked forward push combined with a jump).
          const pinned = this.isPinned()
          const hop = planVerticalHop(pinned)
          hops += 1
          this.logger.info('agent', formatHopPlan(hop), { target: enterCell, actionId: candidate.id, pinned, hops })
          this.logPortalStep(
            candidate,
            epoch,
            'hop',
            'MECHANICAL_CONTINUATION',
            `n=${hops} cell=${enterCell.x},${enterCell.y},${enterCell.z} pinned=${pinned}`,
            'none',
          )
          this.setControlState('forward', hop.holdForward)
          this.setControlState('jump', true)
          await delay(hop.riseMs, signal)
          this.setControlState('jump', false)
          this.setControlState('forward', true)
          await delay(hop.pushMs, signal)
        } else {
          this.setControlState('forward', true)
          await delay(PORTAL_WALK_IN_STEP_MS, signal)
        }
      }
    } finally {
      uninstallGroundCorrection()
      this.setControlState('forward', false)
      this.setControlState('jump', false)
      this.setControlState('back', false)
      this.bot.physicsEnabled = savedPhysics
    }
    const transferred = this.dimensionMatches(dimension)
    toD = this.portalCellDistance(enterCell)
    const inside = transferred || this.portalInsideInterior(enterCell)
    this.logger.info('agent', formatPortalWalkIn({ cell: enterCell, fromD, toD, transferred }), {
      actionId: candidate.id,
      cell: enterCell,
      fromD: round2(fromD),
      toD: round2(toD),
      transferred,
      inside,
      hops,
    })
    return { attempted: true, inside, transferred, fromD, toD, refusal: null }
  }

  /** The SELECTED entry cell as carried by the candidate (never re-derived). */
  private portalEntryCellOf(candidate: Candidate): Vec3Json {
    const target = candidate.target ?? { x: 0, y: 0, z: 0 }
    return {
      x: readMetaNumber(candidate, 'enterX', target.x),
      y: readMetaNumber(candidate, 'enterY', target.y),
      z: readMetaNumber(candidate, 'enterZ', target.z),
    }
  }

  private portalEntryDimensionOf(candidate: Candidate): string {
    return readMetaString(candidate, 'dimension') ?? NETHER
  }

  /** The stable commitment identity of this entry attempt (issue #436 §17). */
  private portalCommitmentId(candidate: Candidate, epoch: number): string {
    return `${candidate.id}#${epoch}`
  }

  /** The selected target's identity string (never re-derived from the world). */
  private portalTargetIdentity(enterCell: Vec3Json, dimension: string): string {
    return `enter=${enterCell.x},${enterCell.y},${enterCell.z}|dimension=${dimension}`
  }

  /**
   * One `SKILL_STEP` under the commitment. `authority` separates the three
   * deterministic layers issue #436 §17 requires: ordinary realization
   * (MECHANICAL_CONTINUATION), a U1..U6-justified prerequisite
   * (MANDATORY_PREREQUISITE) and safety stabilization (HARD_SAFETY_REFLEX,
   * never used by this skill).
   */
  private logPortalStep(
    candidate: Candidate,
    epoch: number,
    stepKind: string,
    authority: SkillStepAuthority,
    evidence: string,
    worldDelta: string,
  ): void {
    this.logger.info(
      'agent',
      formatSkillStep(
        PORTAL_ENTER_SKILL,
        stepKind,
        `${formatSkillStepAuthority(authority, evidence, worldDelta)} commitmentId=${this.portalCommitmentId(candidate, epoch)}`,
      ),
      { actionId: candidate.id, stepKind, authority },
    )
  }

  /**
   * U2: the EXACT blocking cells of the straight approach, with block names -
   * "obsidian@25,67,9+25,68,9 is solid at the feet and the head", never
   * "something is in the way".
   */
  private portalBlockerEvidence(blockers: readonly Vec3Json[]): string {
    return blockers
      .map((cell) => `${this.currentBlockAt(cell)?.name ?? 'unknown'}@${cell.x},${cell.y},${cell.z}`)
      .join('+')
  }

  /**
   * The portal's own structure (U5): the interior cells and the FRAME RING - a
   * cell holding portal material (`nether_portal`/`obsidian`, the frame's own
   * blocks) one step outside an interior cell, at the interior's level or the
   * ring rows above/below it. A player-placed dirt/leaf wall next to the gate is
   * NOT the structure and may be reported as a dig alternative.
   */
  private isPortalStructureCell(cell: Vec3Json, expectedCells: readonly Vec3Json[]): boolean {
    const interiors = expectedCells.length > 0 ? expectedCells : [cell]
    if (interiors.some((other) => other.x === cell.x && other.y === cell.y && other.z === cell.z)) return true
    const block = this.currentBlockAt(cell)
    if (block === null || (block.name !== NETHER_PORTAL && block.name !== OBSIDIAN)) return false
    return interiors.some(
      (other) =>
        Math.abs(other.x - cell.x) <= 1 &&
        Math.abs(other.z - cell.z) <= 1 &&
        cell.y >= other.y - 1 &&
        cell.y <= other.y + 2,
    )
  }

  /**
   * U3/U4/U5: the grounded remedy classes OTHER than the in-envelope walk-around,
   * each named with the exact cell/block and its availability. A DIG remedy is
   * never available on the portal's own structure (protected, U5) and is only
   * "available" when the body could actually harvest it; a vertical route counts
   * only when it has not already been spent inside this commitment.
   */
  private portalRemedyAlternatives(
    enterCell: Vec3Json,
    expectedCells: readonly Vec3Json[],
    blockers: readonly Vec3Json[],
    verticalKind: string,
    verticalSpent: boolean,
  ): string[] {
    const alternatives: string[] = []
    for (const cell of blockers) {
      const block = this.currentBlockAt(cell)
      if (block === null) continue
      if (this.isPortalStructureCell(cell, expectedCells)) {
        alternatives.push(`dig@${cell.x},${cell.y},${cell.z}(${block.name},protected:portal_structure)`)
        continue
      }
      // Grounded availability from the SAME harvest truth MINE uses: a block the
      // body could actually harvest is a real alternative class (Jev's), one it
      // cannot (obsidian with bare hands) is not. `harvestTool === null` means the
      // block needs no tool at all (dirt/leaves), so it is hand-harvestable.
      const harvest = resolveBlockHarvest(this.bot, block.name)
      const tool =
        harvest.harvestTool === null
          ? 'hand'
          : (this.bot.inventory.items().find((item) => item.name.endsWith(`_${harvest.harvestTool}`))?.name ?? null)
      alternatives.push(
        tool !== null
          ? `dig@${cell.x},${cell.y},${cell.z}(${block.name},available:${tool})`
          : `dig@${cell.x},${cell.y},${cell.z}(${block.name},unavailable:no_tool)`,
      )
    }
    if (verticalKind !== 'none') {
      alternatives.push(`vertical:${verticalKind}(${verticalSpent ? 'spent' : 'grounded'})`)
    }
    return alternatives
  }

  /**
   * Who selected the target this Skill executes. The executor never ranks
   * candidates: a claim arrives here through Jev's grounded choice (or a
   * System2-derived plan that named a strategy), and the safety envelope can
   * only REMOVE candidates, never create a portal entry - so `hard-safety` is
   * not reachable for this skill and is not fabricated.
   */
  private portalEntrySelectionSource(candidate: Candidate): SkillSelectionSource {
    const strategy = candidate.meta.strategy
    return typeof strategy === 'string' && strategy.length > 0 ? 'system2-derived' : 'jev'
  }

  /** The frame origin the entry was planned from (the ring's bottom-left corner). */
  private portalSiteOrigin(expectedCells: readonly Vec3Json[], enterCell: Vec3Json): string {
    const cells = expectedCells.length > 0 ? expectedCells : [enterCell]
    const minX = Math.min(...cells.map((cell) => cell.x))
    const minY = Math.min(...cells.map((cell) => cell.y))
    const z = cells[0]?.z ?? enterCell.z
    return `${minX - 1},${minY - 1},${z}`
  }

  /** Feet distance to the CENTRE of a cell (the walk's own progress measure). */
  private portalCellDistance(cell: Vec3Json): number {
    const position = this.bot.entity.position
    return Math.hypot(position.x - (cell.x + 0.5), position.z - (cell.z + 0.5))
  }

  /** Is the body standing on this exact cell (its footprint + level)? */
  private portalInsideFace(cell: Vec3Json): boolean {
    return (
      this.portalCellDistance(cell) <= PORTAL_WALK_IN_INSIDE_RADIUS &&
      Math.abs(this.bot.entity.position.y - cell.y) <= PORTAL_OPEN_FACE_LEVEL_TOLERANCE
    )
  }

  /**
   * The bounded STEP-OVER floor for an open face the body cannot walk to.
   *
   * Measured live (run-mucbyro1-1hqhm, the M3 pocket): the unique standable open
   * face (26,67,10) sat behind the 1-block hole at (24,67,10) over (24,66,10), so
   * the direct control walk to the face failed and the skill reported
   * `PORTAL_APPROACH_REFUSED reason=unreachable`. The mechanical route is: drop
   * into the verified hole floor, then climb the ledge onto the face. The floor is
   * derived from BLOCK TRUTH here (the front cell is open with no floor at feet
   * level while the cell below it IS standable), never from the plan's wording.
   *
   * Returns the floor only when exactly ONE exists: a unique mechanical
   * prerequisite is a #436 reflex the skill may execute, while several floors are
   * several ways in - those stay policy-visible candidates the candidate layer
   * already offers, so this returns null and the skill refuses typed instead of
   * picking one.
   */
  private portalFaceStepOverVia(face: Vec3Json): Vec3Json | null {
    const position = this.bot.entity.position
    const feet = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
    const vias: Vec3Json[] = []
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const front = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
      const via = { x: front.x, y: feet.y - 1, z: front.z }
      // The body must be able to walk INTO the front column (2-high clearance)...
      if (!this.passableAt(front.x, front.y, front.z)) continue
      if (!this.passableAt(front.x, front.y + 1, front.z)) continue
      // ...it must be a HOLE at feet level (no floor), so the ordinary walk cannot
      // already own this step...
      if (this.solidSupportAt(front.x, front.y - 1, front.z)) continue
      // ...and the cell one below must be a verified stand the body drops onto.
      if (!isStandable(this.bot, via)) continue
      // The face must be one level up at most and within the bounded face range.
      if (face.y - via.y > 1) continue
      if (Math.hypot(via.x + 0.5 - (face.x + 0.5), via.z + 0.5 - (face.z + 0.5)) > PORTAL_OPEN_FACE_MAX_DISTANCE) continue
      vias.push(via)
    }
    if (vias.length > 1) {
      // #436 section 7 U3 / section 19 (28): several verified floors are several
      // non-equivalent ways in, so the skill must NOT pick one - state the
      // boundary with the grounded alternatives and let the candidate layer's
      // legs carry the choice back to Jev.
      this.logger.warn(
        'agent',
        formatSkillPolicyBoundary({
          skill: PORTAL_ENTER_SKILL,
          reason: 'multiple_non_equivalent_recoveries',
          alternatives: vias.map((cell) => `step_over:${cell.x},${cell.y},${cell.z}`),
        }),
        { alternatives: vias.length },
      )
      return null
    }
    const only = vias[0]
    return vias.length === 1 && only !== undefined ? only : null

  }

  /** Is the body's own cell space the portal interior (its footprint + level)? */
  private portalInsideInterior(cell: Vec3Json): boolean {
    return (
      this.portalCellDistance(cell) <= PORTAL_WALK_IN_INSIDE_RADIUS &&
      Math.abs(this.bot.entity.position.y - cell.y) <= PORTAL_WALK_IN_LEVEL_TOLERANCE + 0.05
    )
  }

  /** The destination must still be a non-solid portal cell (never walk into rock). */
  private portalCellTraversable(cell: Vec3Json): boolean {
    const block = this.currentBlockAt(cell)
    return block !== null && block.boundingBox === 'empty' && PORTAL_WALK_IN_CELLS.has(block.name)
  }

  /**
   * Typed hazard read for the direct walk: the body's own column, then the cells
   * the straight approach crosses (both body rows and the interior's level). A
   * hazard anywhere on that path means the walk never starts.
   */
  private portalWalkHazard(cell: Vec3Json, feetY: number): PortalWalkInRefusal | null {
    const position = this.bot.entity.position
    const bodyX = Math.floor(position.x)
    const bodyZ = Math.floor(position.z)
    if (this.hazardAt(bodyX, feetY, bodyZ) || this.hazardAt(bodyX, feetY + 1, bodyZ)) return 'hazard_at_body'
    const steps = 6
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      const x = Math.floor(position.x + (cell.x + 0.5 - position.x) * t)
      const z = Math.floor(position.z + (cell.z + 0.5 - position.z) * t)
      for (const y of [feetY, feetY + 1, cell.y]) {
        if (this.hazardAt(x, y, z)) return 'hazard_between'
      }
    }
    return null
  }

  /**
   * Is the straight approach to the interior a face the body cannot step over?
   * The vanilla step rule read from block truth: a 1-block rise is climbable (a
   * jump), a solid cell at the feet AND at the head is a wall. Sampled along the
   * same segment the walk would take, so the answer is about THIS body.
   */
  private portalApproachBlockers(cell: Vec3Json, feetY: number): Vec3Json[] {
    const position = this.bot.entity.position
    const blockers: Vec3Json[] = []
    const seen = new Set<string>()
    const steps = 6
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      const x = Math.floor(position.x + (cell.x + 0.5 - position.x) * t)
      const z = Math.floor(position.z + (cell.z + 0.5 - position.z) * t)
      if (!this.solidSupportAt(x, feetY, z) || !this.solidSupportAt(x, feetY + 1, z)) continue
      for (const y of [feetY, feetY + 1]) {
        const key = `${x},${y},${z}`
        if (seen.has(key)) continue
        seen.add(key)
        blockers.push({ x, y, z })
      }
      if (blockers.length >= 4) break
    }
    return blockers
  }

  /**
   * ONE bounded planned push onto an open face of the portal.
   *
   * WHY NOT `walkByControls`: the measured leg called that motor and it reported
   * `unreachable` for a face that WAS routable - it steers a straight bearing at
   * the target (into the frame column corner) and its 2-block-face veto fires on
   * any tall wall inside its scan cone even when the plan routes around it. The
   * face leg needs the same three things the direct walk proved: follow the
   * ordinary pathfinder plan when one exists, face the current waypoint CENTRE,
   * and push - the server's own collision resolution slides the body along a face
   * it cannot pass (the measured live body slid along the frame column). Bounded
   * by a hard budget AND a no-progress break; the hops reuse the audited
   * `planVerticalHop` recipe and the ground correction the walk uses.
   */
  private async walkToPortalFace(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    face: Vec3Json,
  ): Promise<boolean> {
    const savedPhysics = this.bot.physicsEnabled
    const uninstallGroundCorrection = installGroundCorrection(this.bot, (x, y, z) => this.solidSupportAt(x, y, z))
    this.bot.physicsEnabled = true
    const deadline = Date.now() + PORTAL_FACE_LEG_BUDGET_MS
    let plan: Vec3Json[] = []
    let lastProgressAt = Date.now()
    let hops = 0
    try {
      const pathfinder = this.bot.pathfinder
      if (pathfinder !== undefined) {
        try {
          const computed = pathfinder.getPathTo(pathfinder.movements, new goals.GoalBlock(face.x, face.y, face.z), 800)
          if (computed.status !== 'noPath') {
            plan = computed.path
              .slice(1)
              .map((node) => ({ x: Math.floor(node.x), y: node.y, z: Math.floor(node.z) }))
          }
        } catch {
          plan = []
        }
      }
      let index = 0
      let lastPosition = this.bot.entity.position.clone()
      while (Date.now() < deadline) {
        this.ensureOwned(epoch, signal)
        if (this.portalInsideFace(face)) return true
        const position = this.bot.entity.position
        while (index < plan.length) {
          const node = plan[index]
          if (node === undefined) break
          if (
            Math.hypot(node.x + 0.5 - position.x, node.z + 0.5 - position.z) <= 0.6 &&
            Math.abs(node.y - position.y) <= 0.6
          ) {
            index += 1
            continue
          }
          break
        }
        const node = plan[index] ?? face
        const dx = node.x + 0.5 - position.x
        const dz = node.z + 0.5 - position.z
        if (Math.hypot(dx, dz) > 0.05) {
          await this.bot
            .lookAt(this.bot.entity.position.offset(dx, 0, dz), true)
            .catch(() => undefined)
        }
        if (node.y - this.bot.entity.position.y > 0.5) {
          const pinned = this.isPinned()
          const hop = planVerticalHop(pinned)
          hops += 1
          this.logger.info('agent', formatHopPlan(hop), {
            target: face,
            actionId: candidate.id,
            pinned,
            hops,
            leg: 'approach_leg',
          })
          this.bot.setControlState('forward', hop.holdForward)
          this.bot.setControlState('jump', true)
          await delay(hop.riseMs, signal)
          this.bot.setControlState('jump', false)
          this.bot.setControlState('forward', true)
          await delay(hop.pushMs, signal)
        } else {
          this.bot.setControlState('back', false)
          this.bot.setControlState('forward', true)
          await delay(PORTAL_FACE_LEG_STEP_MS, signal)
        }
        const moved = this.bot.entity.position
        if (moved.distanceTo(lastPosition) > 0.03) {
          lastPosition = moved.clone()
          lastProgressAt = Date.now()
        } else if (Date.now() - lastProgressAt > PORTAL_FACE_LEG_NO_PROGRESS_MS) {
          break
        }
      }
      return this.portalInsideFace(face)
    } finally {
      uninstallGroundCorrection()
      this.bot.setControlState('forward', false)
      this.bot.setControlState('jump', false)
      this.bot.setControlState('back', false)
      this.bot.physicsEnabled = savedPhysics
    }
  }

  /**
   * The bounded step-aside leg: ground ONE ordinary locomotion move onto an OPEN
   * face of the portal (a standable cell beside an interior cell at its level,
   * derived from structure truth - never from the plan's wording), so the next
   * decision re-grounds the entry from a cell that can actually walk in. The
   * body change is durable progress, never arrival: `MOVE`-style chunk, the goal
   * stays open.
   */
  private async stepOntoPortalFace(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    enterCell: Vec3Json,
    expectedCells: readonly Vec3Json[],
    dimension: string,
  ): Promise<{ moved: boolean; cell: Vec3Json | null; fromD: number; toD: number }> {
    const fromD = this.portalCellDistance(enterCell)
    const interiors = expectedCells.length > 0 ? expectedCells : [enterCell]
    const bodyCell = {
      x: Math.floor(this.bot.entity.position.x),
      y: Math.floor(this.bot.entity.position.y),
      z: Math.floor(this.bot.entity.position.z),
    }
    const feetY = Math.floor(this.bot.entity.position.y)
    const blockers = this.portalApproachBlockers(enterCell, feetY)
    const blockerEvidence = blockers.length > 0 ? this.portalBlockerEvidence(blockers) : 'none'
    const verticalKind = readMetaString(candidate, 'vertical') ?? 'none'
    const faces = portalOpenFaceCells(
      interiors,
      enterCell.y,
      (spot) => isStandable(this.bot, spot),
      bodyCell,
      PORTAL_OPEN_FACE_MAX_DISTANCE,
    )
      // a face the body already stands on is not a step aside
      .filter((spot) => !this.portalInsideInterior(spot))
      // reachable from THIS body: at most one block up/down (a further level is a
      // climb the walk must not invent)
      .filter((spot) => Math.abs(spot.y - feetY) <= PORTAL_OPEN_FACE_LEVEL_TOLERANCE)
      // NOTE: no straight-line occlusion filter here. The measured leg walked a
      // DIRECT bearing into the frame column corner and reported `unreachable`
      // while the face itself was reachable AROUND it, so reachability is decided
      // by the planned walk below (which routes), not by a straight ray.
    const faceNames = faces.map((face) => `walk_face@${face.x},${face.y},${face.z}`)
    // U3: DETOUR (walk around the frame) is the only remedy class this Skill's
    // envelope may execute. Any OTHER genuinely available class - mining the
    // exact blocker, a vertical/place route that is still grounded - is a
    // different semantic recovery, so code must stop and surface it instead.
    // Every class that was grounded is named below, INCLUDING one that this
    // commitment already spent (the vertical leg it ran before this fallback):
    // dropping it from the evidence would hide a class a reviewer needs to see.
    const remedyClasses = this.portalRemedyAlternatives(
      enterCell,
      interiors,
      blockers,
      verticalKind,
      verticalKind !== 'none',
    )
    const otherRemedies = remedyClasses.filter((entry) => entry.includes('available:') || entry.includes('(grounded)'))
    const boundary = (reason: string, alternatives: readonly string[]): void => {
      this.logger.warn(
        'agent',
        `${formatSkillPolicyBoundary({ skill: PORTAL_ENTER_SKILL, reason, alternatives })} commitmentId=${this.portalCommitmentId(candidate, epoch)}`,
        { actionId: candidate.id, reason, target: enterCell },
      )
    }
    if (faces.length === 0) {
      this.logger.warn('agent', formatPortalApproachRefused(enterCell, fromD, 'no_open_face'), {
        actionId: candidate.id,
        target: enterCell,
        blocker: blockerEvidence,
      })
      this.logger.warn('agent', formatSkillInterrupt(PORTAL_ENTER_SKILL, 'no_open_face'), {
        actionId: candidate.id,
        target: enterCell,
      })
      boundary('no_in_envelope_remedy', remedyClasses)
      return { moved: false, cell: null, fromD, toD: fromD }
    }
    // U3 is a test over semantic REMEDY CLASSES, not over cells: every open face
    // is the same recovery (walk around the frame - a DETOUR), and which face is
    // used is a mechanical refinement like which path segment to follow. A
    // different class (mining the exact blocker, a still-grounded vertical/place
    // route) is a different recovery, so the skill stops and surfaces it. All
    // faces stay policy-visible: they are offered by the candidate layer AND
    // named in the step evidence below.
    if (otherRemedies.length > 0) {
      this.logger.warn('agent', formatPortalApproachRefused(enterCell, fromD, 'multiple_open_faces'), {
        actionId: candidate.id,
        target: enterCell,
        faces: `${faces[0]?.x ?? '?'},${faces[0]?.y ?? '?'},${faces[0]?.z ?? '?'}`,
        blocker: blockerEvidence,
        alternatives: otherRemedies.join(';'),
      })
      boundary('several_remedy_classes', [...faceNames, ...remedyClasses])
      return { moved: false, cell: null, fromD, toD: fromD }
    }
    // one class, several equivalent instances: refine by nearest reachable face,
    // bounded to two attempts, and say so in the evidence
    const attempts = faces.slice(0, PORTAL_FACE_LEG_MAX_ATTEMPTS)
    this.logPortalStep(
      candidate,
      epoch,
      'approach_leg',
      'MANDATORY_PREREQUISITE',
      `blocker=${blockerEvidence} class=DETOUR faces=[${faceNames.join(';')}] ` +
        `refined_by=nearest_reachable chosen=${attempts.map((face) => `${face.x},${face.y},${face.z}`).join(';')}`,
      'none',
    )
    for (const face of attempts) {
      if (this.dimensionMatches(dimension)) break
      // REFLEX (#436): exactly ONE standable open face exists, so stepping onto
      // it is the mechanically unique prerequisite of the selected entry.
      this.logger.info(
        'agent',
        formatReflex({
          ownerSkill: PORTAL_ENTER_SKILL,
          action: 'step_onto_open_face',
          evidence:
            `exactly one standable open face of the portal is in reach: (${face.x},${face.y},${face.z}) ` +
            `beside interior (${enterCell.x},${enterCell.y},${enterCell.z}); the straight approach is a ` +
            `2-high frame face (d=${round2(fromD)})`,
        }),
        { actionId: candidate.id, cell: face, target: enterCell },
      )
      let reached = await this.walkToPortalFace(candidate, epoch, signal, face)
      if (!reached) {
        // Same remedy class, one refinement deeper: the face may sit behind a
        // 1-block hole, and the mechanical route is drop-then-step-up. The via is
        // used only when exactly ONE verified floor exists (several are several
        // ways in, and that boundary is already emitted).
        const via = this.portalFaceStepOverVia(face)
        if (via !== null) {
          const feetCell = {
            x: Math.floor(this.bot.entity.position.x),
            y: Math.floor(this.bot.entity.position.y),
            z: Math.floor(this.bot.entity.position.z),
          }
          // §17: the prerequisite states the exact geometry it proved unique (the
          // hole floor and the face it climbs to, WITH their y), the exact blocker
          // (U2), that it never left the declared envelope (U4) and that it had
          // not changed the world yet (worldDelta - the bounded walk below is what
          // moves the body, and the face is re-observed before progress is
          // claimed, U6). The `REFLEX ... reason=unique_binding_prerequisite`
          // line above is the same fact in the pre-rewrite vocabulary, and the
          // shared `commitmentId` ties this step to the one Jev decision.
          this.logger.info(
            'agent',
            formatReflex({
              ownerSkill: PORTAL_ENTER_SKILL,
              action: 'step_over',
              evidence:
                `the only standable open face (${face.x},${face.y},${face.z}) is not walk reachable from ` +
                `(${feetCell.x},${feetCell.y},${feetCell.z}) at this stage; the bounded continuation is the ` +
                `verified hole floor (${via.x},${via.y},${via.z}) and then one step up onto the ledge (d=${round2(fromD)})`,
            }),
            { actionId: candidate.id, cell: via, target: face },
          )
          this.logger.info(
            'agent',
            formatSkillStep(
              PORTAL_ENTER_SKILL,
              'step_over',
              formatSkillStepAuthority(
                'MANDATORY_PREREQUISITE',
                `via=${via.x},${via.y},${via.z} to=${face.x},${face.y},${face.z} blocker=${blockerEvidence} ` +
                  `from_feet=${feetCell.x},${feetCell.y},${feetCell.z} envelope=${portalEntryEffectEnvelope(candidate)}`,
                'none',
              ) + ` commitmentId=${this.portalCommitmentId(candidate, epoch)}`,
            ),
            { actionId: candidate.id, cell: via, target: face },
          )
          const dropped = await this.walkToPortalFace(candidate, epoch, signal, via)
          if (dropped) reached = await this.walkToPortalFace(candidate, epoch, signal, face)
        }
      }

      if (!reached) continue
      // U6: re-observe the postcondition. The leg claims progress only if the
      // body is standing on a face that is STILL standable right now; a face that
      // vanished under the body is not assumed to have worked.
      if (!isStandable(this.bot, face) || !this.portalInsideFace(face)) {
        this.logger.warn(
          'agent',
          `${formatSkillPolicyBoundary({ skill: PORTAL_ENTER_SKILL, reason: 'face_unverified', alternatives: faceNames })} commitmentId=${this.portalCommitmentId(candidate, epoch)}`,
          { actionId: candidate.id, cell: face, target: enterCell },
        )
        this.logger.warn('agent', formatPortalApproachRefused(enterCell, fromD, 'unreachable'), {
          actionId: candidate.id,
          target: enterCell,
          detail: 'face_unverified_after_execution',
        })
        return { moved: false, cell: null, fromD, toD: this.portalCellDistance(enterCell) }
      }
      const toD = this.portalCellDistance(enterCell)
      this.logger.info(
        'agent',
        formatPortalApproachLeg({ cell: face, target: enterCell, fromD, toD }),
        { actionId: candidate.id, cell: face, target: enterCell, fromD: round2(fromD), toD: round2(toD) },
      )
      return { moved: true, cell: face, fromD, toD }
    }
    this.logger.warn('agent', formatPortalApproachRefused(enterCell, fromD, 'unreachable'), {
      actionId: candidate.id,
      target: enterCell,
      faces: faces.length,
    })
    boundary('face_unreachable', [...faceNames, ...remedyClasses])
    return { moved: false, cell: null, fromD, toD: fromD }
  }

  /**
   * The durable-progress result of one grounded entry leg (a step-aside move or
   * a bounded vertical chunk): DONE, never verified, the goal stays open and the
   * next decision re-grounds the entry from the new stand cell.
   */
  private entryProgressResult(
    candidate: Candidate,
    epoch: number,
    startedAt: number,
    detail: string,
    blockRemoved: boolean,
  ): ExecutionResult {
    // The Skill ends having changed the body but NOT having met its
    // postcondition: `progress` is the honest execution value, and the entry
    // stays open for the next decision (never a silent completion).
    this.logger.info(
      'agent',
      `${formatSkillEnd(PORTAL_ENTER_SKILL, 'progress', 'unverified', 'portal_not_entered')} progress=body_chunk failureCode=none commitmentId=${this.portalCommitmentId(candidate, epoch)} targetIdentity=${this.portalTargetIdentity(this.portalEntryCellOf(candidate), this.portalEntryDimensionOf(candidate))}`,
      { actionId: candidate.id },
    )
    return this.buildResult(candidate, epoch, startedAt, 'done', 'approaching', detail, null, {
      verified: false,
      blockRemoved,
      dropObserved: false,
      itemsGained: 0,
      goalItemCount: this.countGoalItem(),
      progressed: true,
    })
  }

  /**
   * Run the candidate's grounded vertical/dig route toward the portal entry
   * ONCE, in bounded chunks - the same `vertical=reuse|staircase|staircase-up|
   * pillar` contract `runMove` executes. Returns `progressed` only when the body
   * DURABLY climbed; a route that could not dig/step returns the typed error
   * instead, so `runEnterPortal` can fail ONCE with the obstruction rather than
   * re-arming an unreachable walk.
   *
   * THE COMPOSED CLIMB (the operator's trial, run.jsonl 2026-09-22T15:47:37Z): when
   * the portal interior is ABOVE the body beyond `PORTAL_WALK_IN_LEVEL_TOLERANCE`,
   * the entry must actually climb to the interior's LEVEL before the ordinary
   * verified walk-in can run. Both plans it needs were ALREADY grounded by the
   * offering layer through the SAME `planVerticalApproachDetailed` the other
   * ascents use (`candidates.ts#entryCandidates` compiles `verticalPlanMeta` plus
   * the `fallbackVertical*` half). What was missing was the composition: the
   * primary leg was a `reuse` plan pointing at a remembered tunnel 34 blocks away,
   * it STALLED rather than refusing typed, and `runVerticalContract` consults the
   * fallback ONLY on the typed `refused` outcome - so the grounded own-column climb
   * was never executed. This runs, in order and bounded, the primary leg then the
   * grounded fallback leg, and reports each one's own outcome.
   */
  private async runEntryRouteLeg(
    candidate: Candidate,
    epoch: number,
    signal: AbortSignal,
    enterCell: Vec3Json,
    startY: number,
  ): Promise<{
    progressed: boolean
    error: ExecutorError | null
    activeVertical: string
    obstruction: string | null
    climbRefusal: string | null
    climbEvidence: string | null
  }> {
    const primary = readMetaString(candidate, 'vertical') ?? 'none'
    const fallback = readMetaString(candidate, 'fallbackVertical') ?? 'none'
    const climbNeeded = enterCell.y - Math.floor(this.bot.entity.position.y) > PORTAL_WALK_IN_LEVEL_TOLERANCE
    const idle = {
      progressed: false,
      error: null,
      activeVertical: 'none',
      obstruction: null,
      climbRefusal: null,
      climbEvidence: null,
    }
    if (primary === 'none') {
      // No grounded vertical plan at all. When the interior is above beyond the
      // walk-in tolerance this is NOT a silent no-op: the composed climb is
      // refused typed, naming the interior's height, the (absent) climb and the
      // offering layer's own reason the plan was null.
      if (!climbNeeded) return idle
      const refusal = formatPortalEntryClimbRefused({
        cell: enterCell,
        fromY: Math.floor(this.bot.entity.position.y),
        toY: enterCell.y,
        climb: 'none',
        fallback: 'none',
        reason: 'no_grounded_climb',
        detail: readMetaString(candidate, 'entryRouteRefusal') ?? 'no_vertical_plan',
      })
      this.logger.warn('agent', refusal, { actionId: candidate.id, target: enterCell })
      return { ...idle, climbRefusal: refusal }
    }
    const legs: PortalEntryClimbLeg[] = ['primary']
    // The second grounded plan of the SAME contract is a legitimate next leg only
    // when the interior is still above beyond the walk-in tolerance and it is a
    // different plan (a `fallbackVertical` equal to the primary is the same leg).
    if (climbNeeded && fallback !== 'none' && fallback !== primary) legs.push('fallback')
    // The FIRST failing leg's obstruction is what `detail=` reports, exactly as
    // the single-leg route did before this composition existed: the primary leg is
    // the plan the candidate was OFFERED with, so its cause is the one a reviewer
    // must see. Every leg's own outcome still travels in the `climb=` summary.
    let firstObstruction: string | null = null
    let lastObstruction: string | null = null
    let lastError: ExecutorError | null = null
    const outcomes: string[] = []
    let ranAny = false
    // `runVerticalContract` runs its OWN fallback when the reuse leg refuses
    // typed (`TUNNEL_ENTRY_FALLBACK vertical=...`). When that happened the
    // fallback leg is already spent, and the line must name the climb that
    // ACTUALLY ran - never the plan kind that was merely declared.
    let contractFallbackSpent = false
    for (const leg of legs.slice(0, ENTRY_CLIMB_LEG_MAX)) {
      this.ensureOwned(epoch, signal)
      const fromY = Math.floor(this.bot.entity.position.y)
      // Still above the tolerance after the previous leg: nothing left to do.
      if (leg === 'fallback' && (!(enterCell.y - fromY > PORTAL_WALK_IN_LEVEL_TOLERANCE) || contractFallbackSpent)) break
      let kind = leg === 'primary' ? primary : fallback
      let plan = this.entryClimbPlanEvidence(candidate, leg, kind, enterCell)
      const record = (outcome: 'climbed' | 'no_rise' | 'failed', obstruction: string | null): void => {
        // One mirrored line per leg: which climb, its own bound, its outcome and
        // (when it did not rise) the executed leg's own cause.
        const line = formatPortalEntryClimb({
          cell: enterCell,
          fromY,
          toY: enterCell.y,
          leg,
          climb: kind,
          plan,
          outcome,
          detail: outcome === 'climbed' ? undefined : (obstruction ?? undefined),
        })
        this.logger[outcome === 'climbed' ? 'info' : 'warn']('agent', line, {
          actionId: candidate.id,
          target: enterCell,
          leg,
          climb: kind,
        })
        outcomes.push(`${leg}=${kind}:${outcome}${outcome === 'climbed' ? '' : `:${obstruction ?? 'unknown'}`}`)
        if (outcome !== 'climbed' && firstObstruction === null) firstObstruction = obstruction
        if (outcome !== 'climbed') lastObstruction = obstruction
      }
      try {
        this.lastVerticalFailureReason = null
        let step: boolean
        if (leg === 'primary') {
          const contract = await this.runVerticalContract(candidate, epoch, signal, enterCell, startY)
          step = contract.verticalStep
          if (contract.activeVertical !== primary) {
            contractFallbackSpent = true
            kind = contract.activeVertical
            plan = this.entryClimbPlanEvidence(candidate, 'fallback', kind, enterCell)
          }
        } else {
          step = await this.runVerticalLeg(candidate, kind, true, epoch, signal, enterCell, startY)
        }
        ranAny = true
        const nowY = Math.floor(this.bot.entity.position.y)
        const movedTowardTargetY = enterCell.y < fromY ? nowY < fromY : nowY > fromY
        const obstruction = this.lastVerticalFailureReason ?? `${kind}_no_step`
        if (step && movedTowardTargetY) {
          record('climbed', null)
          return {
            progressed: true,
            error: null,
            activeVertical: kind,
            obstruction: null,
            climbRefusal: null,
            climbEvidence: outcomes.join(','),
          }
        }
        record('no_rise', obstruction)
        // A path failure followed by an actual pillar placement refusal failed in
        // HOW, not in pathfinding. Preserve that typed final cause so #435 does
        // not spend the route as a fictitious path-stage failure.
        lastError =
          obstruction === 'refused'
            ? new ExecutorError('place_refused', `entry ${kind} placement refused after path fallback`)
            : null
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        ranAny = true
        lastError =
          error instanceof ExecutorError
            ? error
            : new ExecutorError(
                'path_stuck',
                `entry ${kind} leg failed: ${error instanceof Error ? error.message : String(error)}`,
              )
        record('failed', this.lastVerticalFailureReason ?? lastError.code)
      }
    }
    // Every grounded climb leg was run and none raised the body: the composed
    // climb is refused typed with the executed legs' own cause, so the entry can
    // never report a bare "no route" when a route existed and ran.
    const climbRefusal =
      climbNeeded && ranAny
        ? formatPortalEntryClimbRefused({
            cell: enterCell,
            fromY: Math.floor(this.bot.entity.position.y),
            toY: enterCell.y,
            climb: primary,
            fallback,
            reason: 'climb_no_rise',
            detail: lastObstruction ?? 'no_rise',
          })
        : null
    if (climbRefusal !== null) {
      this.logger.warn('agent', climbRefusal, { actionId: candidate.id, target: enterCell })
    }
    return {
      progressed: false,
      error: lastError,
      activeVertical: primary,
      obstruction: firstObstruction ?? lastObstruction,
      climbRefusal,
      climbEvidence: outcomes.length === 0 ? null : outcomes.join(','),
    }
  }

  /**
   * The plan's OWN bound, in its own vocabulary, for the `PORTAL_ENTRY_CLIMB`
   * evidence: the same meta keys each vertical leg reads before it executes
   * (`runVerticalLeg`), never a claim about the world.
   */
  private entryClimbPlanEvidence(
    candidate: Candidate,
    leg: PortalEntryClimbLeg,
    kind: string,
    enterCell: Vec3Json,
  ): string {
    const base = leg === 'fallback' ? 'fallback' : ''
    const keyBase =
      kind === 'pillar'
        ? `${base}Pillar`
        : kind === 'staircase-up'
          ? base === ''
            ? 'up'
            : 'fallbackUp'
          : kind === 'staircase'
            ? base === ''
              ? 'stair'
              : 'fallbackStair'
            : null
    if (keyBase === null) {
      const tunnel = readMetaPoint(candidate, 'tunnelX', 'tunnelY', 'tunnelZ')
      return tunnel === null ? 'kind=reuse,tunnel=unknown' : `kind=reuse,at=${tunnel.x},${tunnel.y},${tunnel.z}`
    }
    const toY = Math.floor(readMetaNumber(candidate, `${keyBase}ToY`, enterCell.y))
    if (kind === 'pillar') {
      const steps = Math.floor(readMetaNumber(candidate, `${keyBase}Steps`, 0))
      const place = readMetaString(candidate, `${keyBase}PlaceName`) ?? 'none'
      return `kind=pillar,to_y=${toY},steps=${steps},place=${place}`
    }
    const dig = readMetaPoint(candidate, `${keyBase}DigX`, `${keyBase}DigY`, `${keyBase}DigZ`)
    const digFact = dig === null ? 'unknown' : `${dig.x},${dig.y},${dig.z}`
    return `kind=${kind},to_y=${toY},dig=${digFact}`
  }

  /**
   * The typed, STABLE reason the entry approach cannot be completed. `reason` is
   * one of `no_route` / `route_blocked` / `budget_exhausted` and `detail` names
   * the obstruction: the offering layer's ascent refusal, the executed leg's own
   * failure (`no_rise`/`no_footing`/`dig_refused:...`), or the path code. A
   * stable line is what bounds the failure: the live run alternated
   * `noPath`/`stuck` and the escalation counter reset on every alternation.
   */
  private portalEntryRouteBlockedLine(
    candidate: Candidate,
    enterCell: Vec3Json,
    pathError: unknown,
    legObstruction: string | null,
    climbEvidence: string | null = null,
  ): string {
    const refusal = readMetaString(candidate, 'entryRouteRefusal')
    const vertical = readMetaString(candidate, 'vertical') ?? 'none'
    const code = pathError instanceof ExecutorError ? pathError.code : null
    const reason: PortalEntryRouteBlockedReason =
      code === 'path_timeout' ? 'budget_exhausted' : vertical !== 'none' ? 'route_blocked' : 'no_route'
    const detail = refusal ?? legObstruction ?? code
    return formatPortalEntryRouteBlocked({
      reason,
      entryCell: enterCell,
      fromY: Math.floor(this.bot.entity.position.y),
      toY: enterCell.y,
      ...(detail === null || detail.length === 0 ? {} : { detail }),
      ...(climbEvidence === null ? {} : { climb: climbEvidence }),
    })
  }

  private enteredResult(
    candidate: Candidate,
    epoch: number,
    startedAt: number,
    enterCell: Vec3Json,
    dimension: string,
  ): ExecutionResult {
    this.logger.info('agent', formatPortalEntered(enterCell, dimension), {
      actionId: candidate.id,
      target: enterCell,
      dimension,
    })
    this.logger.info(
      'agent',
      `${formatSkillEnd(PORTAL_ENTER_SKILL, 'entered', 'dimension', `portal_entered dimension=${dimension}`)} progress=portal_entered failureCode=none commitmentId=${this.portalCommitmentId(candidate, epoch)} targetIdentity=${this.portalTargetIdentity(enterCell, dimension)}`,
      { actionId: candidate.id, target: enterCell, dimension },
    )
    return this.buildResult(
      candidate,
      epoch,
      startedAt,
      'done',
      'entered',
      `transferred to ${dimension} through the portal at (${enterCell.x},${enterCell.y},${enterCell.z})`,
      null,
      {
        verified: true,
        dropObserved: false,
        blockRemoved: false,
        itemsGained: 0,
        goalItemCount: this.countGoalItem(),
      },
    )
  }

  private dimensionMatches(dimension: string): boolean {
    const current = this.bot.game?.dimension
    if (typeof current !== 'string' || current.length === 0) return false
    return normalizePortalDimension(current) === normalizePortalDimension(dimension)
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
    fallback?: {
      anchor?: Vec3Json | null
      requireLevel?: boolean
      range?: number
      tolerance?: number
      /** wall clock this stage may spend (defaults to the runner's own path timeout) */
      budgetMs?: number
    },
  ): Promise<void> {
    const budgetMs = fallback?.budgetMs ?? this.options.pathTimeoutMs
    if (this.options.actuation === 'pathfinder') {
      try {
        await this.stockPathTo(target, epoch, signal, goalKind, budgetMs)
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
        tolerance: fallback?.tolerance,
        budgetMs,
      })
      if (!controlsWorked) await this.walkByPackets(target, fallback?.range ?? 1, epoch, signal)
      this.notifyPathCompleted(target)
      return
    }
    const controlsWorked =
      goalKind === 'GoalGetToBlock' &&
      (await this.walkByControls(target, epoch, signal, {
        anchor: target,
        anchorIsGoal: true,
        budgetMs,
      }))
    if (!controlsWorked) await this.walkByPackets(target, fallback?.range ?? 1, epoch, signal)
    this.notifyPathCompleted(target)
  }

  /**
   * Walk ONE committed leg toward a far target (#352).
   *
   * The leg retries the SAME target with the wider
   * `GoalNear(target, LEG_TRAVEL_RADIUS)` so the pathfinder can reach the
   * target's reachable neighbourhood instead of its (possibly enclosed) exact
   * cell, then measures the remaining feet-distance from the BODY position.
   *
   * A leg is a body change and **never arrival**: the caller owns the final
   * "target reached" post-condition and keeps its goal open when the leg only
   * closed distance. A leg that closes less than `LEG_TRAVEL_MIN_PROGRESS`
   * returns `progressed: false` together with the original typed path error, so
   * the caller preserves that failure and the move-failure memory bounds the
   * target - there is no infinite leg loop.
   */
  private async runTravelLeg(
    candidate: Candidate,
    target: Vec3Json,
    epoch: number,
    signal: AbortSignal,
    budgetMs?: number,
  ): Promise<{ decision: TravelLegDecision; error: ExecutorError | null }> {
    const remainingBefore = this.distanceToFeet(target)
    const warranted = classifyTravelLeg({ remainingBefore, remainingAfter: remainingBefore })
    if (!warranted.warranted) return { decision: warranted, error: null }
    this.logger.info(
      'executor',
      `LEG_TRAVEL target=${target.x},${target.y},${target.z} remaining=${round2(remainingBefore)} radius=${LEG_TRAVEL_RADIUS}`,
      { target, actionId: candidate.id, radius: LEG_TRAVEL_RADIUS },
    )
    let error: ExecutorError | null = null
    try {
      await this.pathToNear(target, LEG_TRAVEL_RADIUS, epoch, signal, {
        ...(budgetMs === undefined ? {} : { budgetMs }),
      })
    } catch (thrown) {
      if (thrown instanceof ActionCancelled) throw thrown
      error =
        thrown instanceof ExecutorError
          ? thrown
          : new ExecutorError(
              'path_stuck',
              `travel leg toward (${target.x},${target.y},${target.z}) failed: ${
                thrown instanceof Error ? thrown.message : String(thrown)
              }`,
            )
    }
    this.ensureOwned(epoch, signal)
    const decision = classifyTravelLeg({ remainingBefore, remainingAfter: this.distanceToFeet(target) })
    if (decision.progressed) {
      this.logger.info(
        'executor',
        `LEG_PROGRESS target=${target.x},${target.y},${target.z} remaining=${round2(decision.remaining)} delta=${round2(decision.delta)}`,
        { target, actionId: candidate.id, remaining: round2(decision.remaining), delta: round2(decision.delta) },
      )
    } else {
      this.logger.warn(
        'executor',
        `LEG_NO_PROGRESS target=${target.x},${target.y},${target.z} remaining=${round2(decision.remaining)}`,
        { target, actionId: candidate.id, remaining: round2(decision.remaining) },
      )
    }
    return { decision, error }
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
    timeoutMs: number = this.options.pathTimeoutMs,
  ): Promise<void> {
    this.assertEffect({ type: 'move' })
    const goal =
      goalKind === 'GoalGetToBlock'
        ? new goals.GoalGetToBlock(target.x, target.y, target.z)
        : new goals.GoalBlock(target.x, target.y, target.z)
    const outcome = this.waitForGoal(epoch, signal, timeoutMs)
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
    options: { requireLevel?: boolean; budgetMs?: number } = {},
  ): Promise<void> {
    this.assertEffect({ type: 'move' })
    const budgetMs = options.budgetMs ?? this.options.pickupPathTimeoutMs
    if (this.options.actuation === 'pathfinder') {
      try {
        const goal = options.requireLevel === true
          ? new goals.GoalBlock(position.x, position.y, position.z)
          : new goals.GoalNear(position.x, position.y, position.z, range)
        const outcome = this.waitForGoal(epoch, signal, budgetMs)
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
        const goalName = options.requireLevel === true ? 'GoalBlock' : 'GoalNear'
        this.logger.warn('executor', `stock pathfinder ${goalName} failed (${message}); control-walk fallback`, {
          position,
          actionId: this.action?.id ?? 'unknown',
        })
      }
      const controlsWorked = await this.walkByControls(position, epoch, signal, {
        range,
        requireLevel: options.requireLevel,
        budgetMs,
      })
      if (!controlsWorked) await this.walkByPackets(position, range, epoch, signal)
      this.notifyPathCompleted(position)
      return
    }
    const controlsWorked = await this.walkByControls(position, epoch, signal, {
      range,
      requireLevel: options.requireLevel,
      budgetMs,
    })
    if (!controlsWorked) await this.walkByPackets(position, range, epoch, signal)
    this.notifyPathCompleted(position)
  }

  /**
   * Approach a placed station (crafting_table / furnace / chest) and return the
   * valid interaction stand the bot ends on. Stock `mineflayer-pathfinder` gets
   * a small bounded slice; when it stalls, a direct-bearing control nudge with
   * the pre-contact jump takes over in its own reserved window (the same recipe
   * that fixed drop pickup). Arrival is NOT a loose distance: the feet must
   * occupy a real `interactionStandCandidates` cell (passable, supported, face
   * in reach), so a bot below/offset from the block cannot report arrived. When
   * no such stand exists or none can be reached, this fails fast with the typed
   * `path_stuck` code so the agent re-targets instead of wedging. A blocked
   * 2-block face is opened by cutting its upper block (the sensor `stepCuts`
   * safety predicates), never by tunnelling.
   */
  private async approachPlacedBlock(
    block: Vec3Json,
    label: string,
    epoch: number,
    signal: AbortSignal,
  ): Promise<Vec3Json> {
    const stands = this.interactionStands(block)
    const alreadyAt = this.standAt(block, stands)
    if (alreadyAt !== null) return alreadyAt
    // An interaction stand is not limited to the four orthogonal neighbours the
    // search enumerates: vanilla interaction is an eye->block-AABB reach test
    // from one of the block's three stand levels, so a DIAGONAL feet cell can
    // already interact. Accepting it here is the smallest fix for the live
    // d8d53c2 SMELT wedge - the resident at (8.7,65,-9.3) held raw_iron x3 and
    // faced a real furnace at (10,65,-9): the exact-cell test rejected the
    // feet cell (8,65,-10), the stock `GoalNear` for the 0.42 m-away orthogonal
    // stand (9,65,-9) was already satisfied and reported `reached` WITHOUT
    // moving, and the control nudge pivoted on the same exact-cell predicate, so
    // the approach could only repeat `reason=stuck` (81 attempts) and never open
    // the furnace. When the live face is genuinely in reach, no path is needed.
    const liveStand = this.standAtCurrentFeet(block)
    if (liveStand !== null) {
      const eye = this.bot.entity.position.offset(0, 1.62, 0)
      this.logger.info(
        'executor',
        `approach ${label}: already in reach from (${liveStand.x},${liveStand.y},${liveStand.z}) face=${round2(faceDistanceFromEye({ x: eye.x, y: eye.y, z: eye.z }, block))}m; no path needed`,
        { block },
      )
      return liveStand
    }
    if (stands.length === 0) {
      this.notifyPathFailed(block, 'stuck')
      throw new ExecutorError(
        'path_stuck',
        `no interaction stand for ${label} at (${block.x},${block.y},${block.z}): no passable, supported standing face within ${this.options.reach}m`,
      )
    }
    const startDistance = this.horizontalToFeet(block)
    const destination = stands[0]
    if (destination === undefined) {
      this.notifyPathFailed(block, 'stuck')
      throw new ExecutorError('path_stuck', `no interaction stand for ${label} at (${block.x},${block.y},${block.z})`)
    }
    const arrivedAt = (): Vec3Json | null => this.standAt(block, stands)

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
      const reached = arrivedAt()
      if (reached !== null) {
        this.logger.info(
          'executor',
          `approach ${label} via stock pathfinder stand=(${reached.x},${reached.y},${reached.z}) horizontal=${round2(this.horizontalToFeet(block))}m face=${round2(interactionFaceDistance(reached, block))}m`,
          { block },
        )
        return reached
      }
    }

    let cuts = 0
    const deadline = Date.now() + PLACED_NUDGE_TOTAL_MS
    while (arrivedAt() === null && Date.now() < deadline) {
      try {
        await this.walkByControls(destination, epoch, signal, {
          directBearing: true,
          tolerance: PLACED_APPROACH_HORIZONTAL,
          anchor: block,
          reach: this.options.reach,
          budgetMs: PLACED_NUDGE_BUDGET_MS,
          arrivedAt: () => arrivedAt() !== null,
        })
      } catch (error) {
        if (error instanceof ActionCancelled) throw error
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn('executor', `approach ${label} nudge failed: ${message}`)
      }
      if (arrivedAt() !== null) break
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

    const reached = arrivedAt()
    if (reached !== null) {
      this.logger.info(
        'executor',
        `approach ${label} arrival stand=(${reached.x},${reached.y},${reached.z}) horizontal=${round2(startDistance)}m->${round2(this.horizontalToFeet(block))}m face=${round2(interactionFaceDistance(reached, block))}m cuts=${cuts}`,
        { block },
      )
      this.notifyPathCompleted(block)
      return reached
    }
    this.notifyPathFailed(block, 'stuck')
    throw new ExecutorError(
      'path_stuck',
      `approach to ${label} at (${block.x},${block.y},${block.z}) could not reach an interaction stand within ${this.options.reach}m`,
    )
  }

  /** The valid interaction stands for `block`, nearest-first from the bot's feet. */
  private interactionStands(block: Vec3Json): Vec3Json[] {
    const feet = this.bot.entity.position
    return interactionStandCandidates(
      block,
      { x: feet.x, y: feet.y, z: feet.z },
      {
        passable: (x, y, z) => this.passableAt(x, y, z),
        solidSupport: (x, y, z) => this.solidSupportAt(x, y, z),
      },
      this.options.reach,
    )
  }

  /** The valid stand the bot's feet currently occupy, or null when it is not on one. */
  private standAt(block: Vec3Json, stands: readonly Vec3Json[]): Vec3Json | null {
    const position = this.bot.entity.position
    const feet = { x: position.x, y: position.y, z: position.z }
    for (const stand of stands) {
      if (sameBlockCell(feet, stand)) return stand
    }
    return null
  }

  /**
   * The block's face as seen from the body's LIVE position, when the feet
   * already sit on a valid interaction stance that is not one of the orthogonal
   * `interactionStandCandidates` cells: the feet cell is at one of the block's
   * `INTERACTION_STAND_DY` levels, passable with a passable head cell and solid
   * support, and the live eyes are within `reach` of the block AABB. Returns
   * that feet cell, or null when the body must still move to a stand.
   *
   * This is the same geometry the stand search uses, evaluated from where the
   * body actually is instead of from the four enumerated neighbours, so a
   * diagonal-but-interactable station needs no path at all.
   */
  private standAtCurrentFeet(block: Vec3Json): Vec3Json | null {
    const position = this.bot.entity.position
    const cell = {
      x: Math.floor(position.x + 1e-3),
      y: Math.floor(position.y + 1e-3),
      z: Math.floor(position.z + 1e-3),
    }
    if (!INTERACTION_STAND_DY.includes(cell.y - block.y)) return null
    if (!this.passableAt(cell.x, cell.y, cell.z)) return null
    if (!this.passableAt(cell.x, cell.y + 1, cell.z)) return null
    if (!this.solidSupportAt(cell.x, cell.y - 1, cell.z)) return null
    const eye = position.offset(0, 1.62, 0)
    if (faceDistanceFromEye({ x: eye.x, y: eye.y, z: eye.z }, block) > this.options.reach) return null
    return cell
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
        this.assertEffect({ type: 'equip', itemName: tool.name, destination: 'hand' })
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
      // mineflayer-pathfinder exposes waypoint centers (x/z + 0.5), while
      // the packet stepper accepts block origins and adds that half-block
      // offset itself.  Normalize here so a climb or diagonal cannot drift
      // into the neighboring cell before the first step.
      return plan.path.slice(1).map((node) => ({ x: Math.floor(node.x), y: node.y, z: Math.floor(node.z) }))
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
        // The same per-step landing guard the control walker uses. `chooseStep`
        // already proves SOLID support for its own step levels, so this cannot
        // refuse ordinary packet terrain; what it adds is the HAZARD landing cell
        // the stepper was blind to (a fire block over netherrack is passable over
        // solid support, so it was a legal packet step). A refusal stops the leg
        // here, before the pose is written.
        this.guardStepLanding(target, {
          x: Math.floor(next.x),
          y: Math.floor(next.y + 0.1),
          z: Math.floor(next.z),
        })
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
    // #382: delegate to the sensor's fail-closed rule instead of keeping a second,
    // opposite one. `null` (unloaded/unknown) must not be passable.
    const block = this.bot.blockAt(this.bot.entity.position.clone().set(x, y, z)) as { boundingBox: string } | null
    return isPassable(block)
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
    if (isProtectedStationBlock(block.name)) {
      throw new ExecutorError(
        'protected_station',
        `refusing to break protected station ${block.name} at (${block.position.x},${block.position.y},${block.position.z})`,
      )
    }
    if (!this.bot.canDigBlock(block)) {
      throw new ExecutorError('dig_error', `canDigBlock() returned false for ${block.name}`)
    }
    // CAN / LEGALITY (operator report: "stone being mined with the sword").
    // Mineflayer's own `canDigBlock` checks only diggable + distance, and its
    // `digTime` reads whatever is in hand, so nothing below this line stops the
    // body from mining a block with an item that is not a harvest tool for it -
    // stone mined with a sword yields no drop and burns the dig budget. The
    // block's own `harvestTools` map (minecraft-data, the same authority
    // `cutApproachStep` already uses) is the legality contract: an inadmissible
    // held item is replaced by a carried admissible tool, and when none exists the
    // dig FAILS CLOSED with the typed `dig_no_tool` instead of proceeding.
    await this.requireHarvestTool(block, epoch, signal)
    this.assertEffect({
      type: 'dig',
      position: { x: block.position.x, y: block.position.y, z: block.position.z },
      blockName: block.name,
    })
    this.assertEffect({ type: 'look' })
    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
    this.ensureOwned(epoch, signal)

    // Break speed reads the same stale `onGround` parity quirk the pillar path
    // corrects for its jump gate: this server reports false while a solid block
    // is underfoot, so the outgoing packet advertises an airborne body and the
    // server charges the vanilla /5 penalty. Obsidian is ~9.4s grounded but
    // ~46.9s airborne. `withDigGroundCorrection` keeps the flag corrected from
    // the block grid for the whole dig and names the corrected dig.
    //
    // The budget is then sized from the mechanism's OWN schedule (`bot.digTime`,
    // already repaired at construction) instead of the flat number: a dig the
    // mechanism prices longer than `digTimeoutMs` gets its schedule + slack, so a
    // legitimately slow block can never be charged as a stall. The typed
    // `DIG_BUDGET` marker records any extension.
    const mechanism: DigMechanism = {
      digTime: () => this.bot.digTime(block),
      dig: () => this.bot.dig(block, 'ignore'),
      stopDigging: () => this.bot.stopDigging(),
    }
    this.digStartedAt = Date.now()
    await withDigGroundCorrection(
      this.bot,
      (x, y, z) => this.solidSupportAt(x, y, z),
      async () => {
        // A malformed target (no `digTime`) is an unbounded schedule, never an
        // escape: the floor stays and the mechanism's own rejection is typed.
        let libraryMs: number
        try {
          libraryMs = this.bot.digTime(block)
        } catch {
          libraryMs = Number.POSITIVE_INFINITY
        }
        const plan = planDigTime(libraryMs, this.options.digTimeoutMs)
        this.lastDigPlan = plan
        if (plan.extended) {
          this.logger.info('executor', formatDigBudget(plan), {
            actionId: this.action?.id ?? 'unknown',
            block: block.name,
            position: block.position,
          })
        }
        const race = await runBoundedDig(mechanism, plan.budgetMs)
        if (race.outcome === 'timeout') {
          throw new ExecutorError(
            'dig_timeout',
            `dig timed out after ${plan.budgetMs}ms (client schedule ${plan.libraryMs}ms)`,
          )
        }
        if (race.outcome === 'error') {
          throw new ExecutorError('dig_error', race.error ?? `dig failed for ${block.name}`)
        }
      },
      () => {
        this.logger.info('executor', formatDigGroundCorrected(block), {
          actionId: this.action?.id ?? 'unknown',
          block: block.name,
          position: block.position,
        })
      },
    )
  }

  /**
   * The typed, mirrored dig failure. Every failure on the dig path (no tool,
   * out of reach, abort/timeout) is named here with the block, the live held
   * tool and tier, and the mechanism's own schedule, so a resource the plan
   * depends on can never again fail every cycle without a diagnosable cause.
   */
  private logDigFailed(candidate: Candidate, block: Block, target: Vec3Json, error: unknown): void {
    const code = error instanceof ExecutorError ? error.code : 'unknown_event'
    const plan = this.lastDigPlan
    const elapsed = this.digStartedAt === 0 ? 0 : Date.now() - this.digStartedAt
    this.logger.warn(
      'executor',
      formatDigFailed({
        reason: code,
        tool: this.bot.heldItem?.name ?? null,
        tier: candidate.toolTier ?? null,
        block: target,
        expectedMs: plan === null ? null : plan.libraryMs,
        elapsedMs: elapsed,
      }),
      {
        actionId: candidate.id,
        block: block.name,
        position: target,
        code,
        detail: error instanceof Error ? error.message : String(error),
      },
    )
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
    const pickupWindowMs = Math.min(this.options.pickupPathTimeoutMs, this.options.verifyTimeoutMs)
    const settleDeadline = startedAt + pickupWindowMs
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
      entityDefeated?: boolean
      distanceClosed?: boolean
      attackHits?: number
      damageObserved?: boolean
      targetHealthDelta?: number
      huntEnd?: HuntEndReason
      huntReacquired?: number
      huntLastKnown?: Vec3Json
      /** issue #436 section 9: the honest combat outcome of an ATTACK lease */
      combatOutcome?: CombatOutcome
      /** issue #436 section 9: the declared HUNT_DROP item reached the inventory */
      dropAcquired?: boolean
      huntGoalDrop?: string
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
      progressed: result.progressed,
      entityDefeated: result.entityDefeated,
      damageObserved: result.damageObserved,
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

  /**
   * issue #436 section 9 / CAN legality: a dig is mechanically legal only with an
   * item the block itself declares as a harvest tool.
   *
   * Returns immediately for a block with no `harvestTools` contract (dirt, sand,
   * leaves: any item, including the hand, breaks it). Otherwise the hand must hold
   * an admissible item; a carried admissible tool is equipped through the ordinary
   * leased equip path, and if the body carries none the dig is refused with the
   * typed `dig_no_tool`. It never selects a tool family by preference - only the
   * block's own declared set is consulted - and it never mutates the world.
   */
  private async requireHarvestTool(block: Block, epoch: number, signal: AbortSignal): Promise<void> {
    const harvestTools = (block as { harvestTools?: Record<string, boolean> }).harvestTools
    if (harvestTools === undefined) return
    const admissible = new Set(
      Object.entries(harvestTools)
        .filter(([, ok]) => ok)
        .map(([id]) => Number(id)),
    )
    if (admissible.size === 0) return
    const held = this.bot.heldItem
    if (held !== null && held !== undefined && admissible.has(held.type)) return
    const tool = this.bot.inventory.items().find((item) => admissible.has(item.type))
    if (tool === undefined) {
      throw new ExecutorError(
        'dig_no_tool',
        `no harvest tool for ${block.name} in the inventory (held ${held?.name ?? 'nothing'} is not admissible); refusing to dig with a non-harvesting item`,
      )
    }
    this.logger.warn(
      'executor',
      `DIG_TOOL_LEGALITY block=${block.name} at=${block.position.x},${block.position.y},${block.position.z} ` +
        `held=${held?.name ?? 'none'} -> equip=${tool.name} reason=non_harvesting_held_item`,
      { block: block.name, held: held?.name ?? null, equipped: tool.name },
    )
    this.assertEffect({ type: 'equip', itemName: tool.name, destination: 'hand' })
    await this.equipItemTo(tool, 'hand', epoch, signal)
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
          throw new ExecutorError('dig_no_tool', `no ${toolName} in the inventory`)
        }
      } else {
        this.assertEffect({ type: 'equip', itemName: tool.name, destination: 'hand' })
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

/** The floored feet cell of a live body. */
function feetCellOf(bot: Bot): Vec3Json {
  const position = bot.entity.position
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
}

function sameCell(a: Vec3Json, b: Vec3Json): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

/**
 * The bridge refusal's executor-visible failure code. The bridge's own typed
 * reason stays in the `BRIDGE_REFUSED` marker; this only tells the existing
 * failure memory / zero-progress ledger which bounded bucket the failed leg
 * belongs to, so a bridge that cannot proceed is spent like any other MOVE
 * instead of being re-offered forever.
 */
function bridgeFailureCode(reason: string): FailureCode {
  switch (reason) {
    case 'no_block':
      return 'target_gone'
    case 'unverified_place':
      return 'verify_failed'
    case 'hazard':
    case 'protected':
      return 'place_refused'
    default:
      return 'path_stuck'
  }
}

/**
 * issue #436 section 17: how often an aggregated mechanical step of the same kind
 * is reported again (attack/dig/place/equip/station/transfer always report).
 */
const SKILL_STEP_REPORT_MS = 1_000

/** Carried item families a fight may put in hand (the damage is the held item's). */
const WEAPON_ITEM_SUFFIXES: readonly string[] = ['_sword', '_axe']

/**
 * The world epoch a commitment's target identity was grounded in, or 0 when the
 * target kind carries none (item/none). Used only to revalidate the LIVE epoch
 * when the host injects one (`ExecutorOptions.observedWorldEpoch`).
 */
function committedWorldEpoch(commitment: SkillCommitment): number {
  const target = commitment.target
  return target.kind === 'item' || target.kind === 'none' ? 0 : target.worldEpoch
}

/** Carried tool families a grounded route-opening contract may require. */
const ROUTE_TOOL_SUFFIXES: readonly string[] = ['_pickaxe', '_axe', '_shovel']

/** Plain, greppable description of one mechanical effect for the SKILL_STEP line. */
function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case 'move':
    case 'look':
    case 'jump':
    case 'sprint':
      return effect.type
    case 'attack':
      return `attack=e${effect.entityId}`
    case 'dig':
      return `dig=${effect.position.x},${effect.position.y},${effect.position.z} block=${effect.blockName ?? 'unknown'}`
    case 'place':
      return `place=${effect.position.x},${effect.position.y},${effect.position.z} item=${effect.itemName}`
    case 'equip':
      return `equip=${effect.itemName} destination=${effect.destination}`
    case 'station':
      return `station=${effect.station}`
    case 'transfer':
      return `transfer=${effect.itemName} count=${effect.count ?? 'any'} container=${effect.container}`
  }
}

/**
 * issue #436 section 9: the hunt telemetry shared by both hunt results. Honest on
 * every outcome: why it ended, how often the SAME identity had to be re-acquired,
 * and where that identity was last observed. Never a substitute for
 * `entityDefeated` (the only kill proof) or for `dropAcquired`.
 */
function huntEvidence(
  goalDrop: string,
  huntEnd: HuntEndReason | null,
  reacquires: number,
  lastTarget: Vec3Json,
): Record<string, unknown> {
  return {
    huntEnd: huntEnd ?? 'untracked',
    huntReacquired: reacquires,
    huntLastKnown: { x: lastTarget.x, y: lastTarget.y, z: lastTarget.z },
    huntGoalDrop: goalDrop,
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

/**
 * The descent step's dig sequence from the candidate's own profile meta
 * (`digCells`, `"x,y,z;x,y,z"`, passage cells first / primary last). The meta is
 * written by the same pure `descentDigPlan` the guard and the offer use, so the
 * executed shape cannot drift from the offered one. A legacy/hand-built
 * candidate without the meta keeps the historical single-primary dig.
 */
function descentDigCellsFromMeta(candidate: Candidate, target: Vec3Json): Vec3Json[] {
  const raw = candidate.meta.digCells
  if (typeof raw === 'string' && raw.length > 0) {
    const cells: Vec3Json[] = []
    for (const part of raw.split(';')) {
      const [x, y, z] = part.split(',').map((value) => Number(value))
      if (x === undefined || y === undefined || z === undefined) continue
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      cells.push({ x, y, z })
    }
    if (cells.length > 0) return cells
  }
  return [target]
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
