// grounded-evidence.ts — legacy grounded-candidate evidence mirroring plane.
//
// Extracted from `controller-legacy.ts`. These functions translate the
// candidate generator's typed refusals, source/station/kit gaps, prereq
// pictures and guard roll-ups into deduplicated log lines plus per-tick latch
// state on the host. They own no authority: they never choose an action and
// only mutate their own dedup/this-tick evidence cells. Seam-bound calls
// (unreachableStationKeys / blacklistedMoveTargets) go through host.* so the
// controller.ts internals seam keeps wrapping the real implementation.

import type { Bot } from 'mineflayer'
import {
  altitudeRouteOnOffer,
  blockId,
  craftIngredientPrereq,
  craftStationGap,
  formatColumnDescentRefused,
  formatCraftIngredientPrereq,
  formatCraftStationGap,
  formatExploreRouteBlocked,
  formatFoodHabitatRefused,
  formatFuelSatisfied,
  formatMobDropSourceGap,
  formatMobSpawnContext,
  formatPlaceRefusal,
  formatProspectRefused,
  formatResourceSourceExclusion,
  formatResourceSourceGap,
  formatSmeltInputPrereq,
  formatSmeltRouteGap,
  formatSmeltStationRetry,
  formatSurfaceAscentRefused,
  fuelSatisfaction,
  goalWantsFuel,
  smeltInputPrereq,
  smeltRouteGap,
  smeltStationRetry,
  surfaceAscentRouteless,
} from './candidates.ts'
import type {
  Candidate,
  CandidateOptions,
  ColumnDescentRefusal,
  CombatKitGapEvidence,
  ContactRefusal,
  ExploreRouteBlocked,
  IgnitionRefusal,
  MobDropSourceGap,
  PlaceRefusal,
  ProspectRefusal,
  ReachabilityGateOptions,
  ResourceSourceExclusion,
  ResourceSourceGap,
  SmeltRouteGap,
  SurfaceAscentRefusal,
} from './candidates.ts'
import { formatContactUnreachable } from './combatClosure.ts'
import { candidateOptions, sensorOptions } from './controller-shared.ts'
import type { JevAgentOptions } from './controller-shared.ts'
import { formatContainerRefusal } from './containerAccess.ts'
import type { ContainerRefusal } from './containerAccess.ts'
import type { RecipeIndex } from './crafting.ts'
import { formatFoodSourceGap } from './foodSources.ts'
import type { FoodSourceGap } from './foodSources.ts'
import { formatArmorCraft, formatArmorCraftRefusal, formatArmorRefusal, formatCombatKitGap } from './gearPlan.ts'
import type { ArmorCraftOffer, ArmorCraftRefusal, ArmorRefusal } from './gearPlan.ts'
import type { GoalQueue } from './goalQueue.ts'
import type { EventLogger } from './jev.ts'
import type { MoveFailMemory } from './moveFailMemory.ts'
import { formatPortalFrameSiteRejected } from './netherPortalPlan.ts'
import { explainNearestPortalFrameRejection } from './state.ts'
import type { WorldState } from './state.ts'
import { GUARD_REJECTIONS, MELEE_THREAT_REACH } from './threat.ts'

export interface GroundedEvidenceHost {
  readonly bot: Bot
  options: JevAgentOptions
  logger: EventLogger
  tickCounter: number
  queue: GoalQueue
  lastWorldState: WorldState | null
  recipeIndex: RecipeIndex
  readonly searchedSurfaceTargets: Set<string>
  moveFailMemory: MoveFailMemory
  guardRejections: number
  survivalRegrounds: number
  // Mutable dedup keys / per-tick evidence cells owned by this plane.
  ascendRefusedSinceObservation: boolean
  lastSurfaceAscentRefusal: SurfaceAscentRefusal | null
  lastSurfaceAscentRouteless: boolean
  surfaceAscentRefusalStreakKey: string | null
  surfaceAscentRefusalStreak: number
  lastSurfaceAscentRefusalKey: string | null
  lastColumnDigKey: string | null
  lastFoodHabitatRefusalKey: string | null
  lastContainerRefusalKey: string | null
  lastPlacementRefusalKey: string | null
  lastArmorRefusalKey: string | null
  lastArmorCraftKey: string | null
  lastSourceExclusionKey: string | null
  lastPortalFrameRejectionKey: string | null
  exploreRouteBlockedThisTick: ExploreRouteBlocked | null
  lastExploreRouteBlockedKey: string | null
  columnDescentRefusalThisTick: ColumnDescentRefusal | null
  lastColumnDescentRefusalKey: string | null
  lastContactRefusalKey: string | null
  prospectRefusalThisTick: ProspectRefusal | null
  lastProspectRefusalKey: string | null
  lastSourceGapKey: string | null
  lastCombatKitGapLine: string | null
  lastFoodSourceGapKey: string | null
  lastMobDropGapKey: string | null
  lastMobSpawnContextKey: string | null
  lastIgnitionRefusalKey: string | null
  lastSmeltInputPrereqLine: string | null
  lastCraftIngredientPrereqLine: string | null
  lastCraftStationGapLine: string | null
  smeltRouteGapThisTick: SmeltRouteGap | null
  lastSmeltRouteGapLine: string | null
  lastSmeltStationRetryLine: string | null
  fuelSatisfiedKey: string | null
  lastGuardRollupAt: number
  // Controller-owned helpers (unreachableStationKeys / blacklistedMoveTargets
  // are bound through the controller.ts internals seam — always via host.*).
  currentGoalKey(): string
  currentDimension(): string
  reachabilityGateOptions(): ReachabilityGateOptions
  unreachableStationKeys(state: WorldState): ReadonlySet<string>
  blacklistedMoveTargets(state: WorldState): ReadonlySet<string>
}


/**
 * Surface the generator's typed ascent refusal (`SURFACE_ASCENT_REFUSED
 * reason=no_placeable|unsafe_column goal=... from_y=... to_y=...`) once per
 * distinct refusal, and retain the two facts the queue-sync `surface` branch
 * needs. The measured 48-minute loop ran with no route enumerated AND nothing
 * saying why; this makes the dead end explicit and feeds the existing
 * capability-gap latch so the planner re-plans instead of the body pacing
 * inside the level-move set. The refusal is a deterministic plan fact, not a
 * semantic preference.
 */
export function noteSurfaceAscent(host: GroundedEvidenceHost, refusal: SurfaceAscentRefusal | null, candidates: readonly Candidate[]): void {
  host.lastSurfaceAscentRefusal = refusal
  // Pure candidate fact: is any body-changing route on offer at all? A single
  // refused pillar must never erase a real level/mine/step alternative.
  // For an ALTITUDE goal a level MOVE is not a route: an offer only clears the
  // dead end when it can actually raise the body toward `targetY`. Otherwise a
  // pocket with level moves paced forever (LIVE: LOCAL_CAPABILITY_GAP
  // attempts>131) because every body-changing candidate masked the dead end.
  const current = host.queue.current
  const surfaceTargetY =
    current?.kind === 'surface' && typeof current.targetY === 'number' && Number.isFinite(current.targetY)
      ? current.targetY
      : null
  const feetY = host.bot.entity?.position?.y
  const altitudeless =
    surfaceTargetY !== null &&
    typeof feetY === 'number' &&
    !altitudeRouteOnOffer(candidates, Math.floor(feetY), surfaceTargetY)
  host.lastSurfaceAscentRouteless = surfaceAscentRouteless(candidates) || altitudeless
  if (refusal !== null) host.ascendRefusedSinceObservation = true
  const key = refusal === null ? null : formatSurfaceAscentRefused(refusal)
  if (key === null || key !== host.surfaceAscentRefusalStreakKey) {
    host.surfaceAscentRefusalStreakKey = key
    host.surfaceAscentRefusalStreak = key === null ? 0 : 1
  } else {
    host.surfaceAscentRefusalStreak += 1
  }
  if (key === host.lastSurfaceAscentRefusalKey) return
  host.lastSurfaceAscentRefusalKey = key
  if (refusal === null) return
  host.logger.warn(
    'agent',
    formatSurfaceAscentRefused(refusal),
    { ...refusal, goal: host.currentGoalKey() },
    host.tickCounter,
  )
}

/**
 * Surface the generator's column-dig route (`COLUMN_DIG target=x,y,z top_y=n`)
 * once per distinct base cell. This is the "obtain a resource whose supporting
 * column is reachable" capability: the body mines the column from its
 * reachable base and the drop falls into pickup range, so a floating trunk /
 * pillar cap / wall resource is obtainable with no kit. Observability only -
 * the CHOICE of whether to take it stays with Jev.
 */
export function noteColumnDig(host: GroundedEvidenceHost, candidates: readonly Candidate[]): void {
  const dig = candidates.find((candidate) => candidate.meta.columnDig === true && candidate.target !== null)
  const key = dig === undefined || dig.target === null
    ? null
    : `${blockId('b', dig.target)}|${String(dig.meta.columnTopY ?? '')}`
  if (key === host.lastColumnDigKey) return
  host.lastColumnDigKey = key
  if (key === null || dig === undefined || dig.target === null) return
  host.logger.warn(
    'agent',
    `COLUMN_DIG target=${dig.target.x},${dig.target.y},${dig.target.z} top_y=${String(dig.meta.columnTopY ?? '')}`,
    { actionId: dig.id },
    host.tickCounter,
  )
}

/**
 * Surface the hungry hunt's typed vertical-route refusal
 * (`FOOD_HABITAT_REFUSED reason=... -> no grounded route to animal habitat`)
 * once per distinct refusal. Measured `run-mubj6ucc-si3e`: a health-1 body
 * underground with no sensed animal and `collect:food 0/3` produced an
 * unbounded `WAIT/DESCEND` hunt; with no route up, the dead end must be an
 * explicit fact the semantic layer can re-plan on instead of silence.
 */
export function noteFoodHabitat(host: GroundedEvidenceHost, refusal: SurfaceAscentRefusal | null): void {
  const key = refusal === null ? null : formatFoodHabitatRefused(refusal)
  if (key === host.lastFoodHabitatRefusalKey) return
  host.lastFoodHabitatRefusalKey = key
  if (refusal === null) return
  host.logger.warn('agent', formatFoodHabitatRefused(refusal), { ...refusal, goal: host.currentGoalKey() }, host.tickCounter)
}

/**
 * Surface every typed container refusal (`CONTAINER_REFUSED reason=...`) once
 * per distinct fact, so an unreachable/unloaded container, a container that
 * was opened and observed EMPTY, and a transfer refused by the destination are
 * all explicit facts instead of the silence that would let "could not open it"
 * look like "nothing was there".
 */
export function logContainerRefusals(host: GroundedEvidenceHost, refusals: readonly ContainerRefusal[]): void {
  const key = refusals.length === 0 ? null : refusals.map(formatContainerRefusal).join('|')
  if (key === host.lastContainerRefusalKey) return
  host.lastContainerRefusalKey = key
  for (const refusal of refusals) {
    host.logger.warn(
      'agent',
      formatContainerRefusal(refusal),
      {
        reason: refusal.reason,
        container: refusal.container,
        block: refusal.block,
        at: `${refusal.position.x},${refusal.position.y},${refusal.position.z}`,
        ...(refusal.item === undefined || refusal.item === null ? {} : { item: refusal.item }),
        ...(refusal.detail === undefined || refusal.detail === null ? {} : { detail: refusal.detail }),
      },
      host.tickCounter,
    )
  }
}

/**
 * Surface the generator's typed placement refusal (`PLACE_REFUSED
 * reason=no_support|no_clearance|out_of_reach cell=x,y,z item=...`) once per
 * distinct refusal, so a geometry dead end is an explicit fact instead of the
 * silence that let a held station stall the craft goal.
 */
export function logPlacementRefusal(host: GroundedEvidenceHost, refusal: PlaceRefusal | null): void {
  const key =
    refusal === null ? null : `${refusal.reason}|${blockId('p', refusal.cell)}|${refusal.item}`
  if (key === host.lastPlacementRefusalKey) return
  host.lastPlacementRefusalKey = key
  if (refusal === null) return
  host.logger.warn(
    'agent',
    formatPlaceRefusal(refusal),
    { reason: refusal.reason, cell: refusal.cell, item: refusal.item },
    host.tickCounter,
  )
}

/**
 * Surface every carried armor piece that was NOT offered because it is not
 * strictly better than what is worn (`EQUIP_ARMOR_REFUSED slot=... item=...
 * worn=... reason=not_better`), once per distinct refusal set. This is the
 * explicit "nothing better is held" fact, never a silent churn.
 */
export function logArmorRefusal(host: GroundedEvidenceHost, refusals: readonly ArmorRefusal[]): void {
  const key = refusals.length === 0 ? null : refusals.map(formatArmorRefusal).join('|')
  if (key === host.lastArmorRefusalKey) return
  host.lastArmorRefusalKey = key
  for (const refusal of refusals) {
    host.logger.warn('agent', formatArmorRefusal(refusal), { ...refusal }, host.tickCounter)
  }
}

/**
 * Surface the armour PRODUCER picture: every grounded armour craft on offer
 * (`ARMOR_CRAFT slot=... item=... material=... need=... have=... candidate=...`)
 * and every piece the carried material cannot afford
 * (`ARMOR_CRAFT_REFUSED slot=... item=... material=iron_ingot need=8 have=2
 * shortfall=6 reason=insufficient_material`), once per distinct set.
 *
 * The equip markers next door can only report armour that exists; measured
 * live (the fatal window at 33.3 h) `armor=0/4` held for a whole run and
 * `COMBAT_KIT_GAP ... missing=[armor] prerequisite=none` named the gap with no
 * route and no reason. These two lines are the missing half: whether a craft
 * was offered, and - when none was - exactly which material and how many of it
 * were short. Both planes must carry it, or a post-mortem cannot tell "nothing
 * was craftable from what the body carried" from "the route was never offered".
 */
export function logArmorCraft(host: GroundedEvidenceHost, offers: readonly ArmorCraftOffer[], refusals: readonly ArmorCraftRefusal[]): void {
  const lines = [
    ...offers.map(formatArmorCraft),
    ...refusals.map(formatArmorCraftRefusal),
  ]
  const key = lines.length === 0 ? null : lines.join('|')
  if (key === host.lastArmorCraftKey) return
  host.lastArmorCraftKey = key
  for (const offer of offers) host.logger.info('agent', formatArmorCraft(offer), { ...offer }, host.tickCounter)
  for (const refusal of refusals) {
    host.logger.warn('agent', formatArmorCraftRefusal(refusal), { ...refusal }, host.tickCounter)
  }
}

/**
 * Surface every collect-source cell refused because it is a member of a live
 * structure (`RESOURCE_SOURCE_EXCLUDED item=... cell=... reason=live_structure`),
 * once per distinct set. This is the explicit fact that the bot is NOT
 * dismantling infrastructure it depends on: the plan must source the item
 * elsewhere instead.
 */
export function logSourceExclusions(host: GroundedEvidenceHost, exclusions: readonly ResourceSourceExclusion[]): void {
  const key = exclusions.length === 0 ? null : exclusions.map(formatResourceSourceExclusion).join('|')
  if (key === host.lastSourceExclusionKey) return
  host.lastSourceExclusionKey = key
  for (const exclusion of exclusions) {
    host.logger.warn('agent', formatResourceSourceExclusion(exclusion), { ...exclusion }, host.tickCounter)
  }
}

/**
 * Name WHY the frame scan grounded no site, once per distinct rejection. The
 * explainer shares the sensor's acceptance rule, so the line is the actual
 * failing rule (origin/axis/rule/cell/block) rather than a bare
 * `portal_frame_site:none`. Measured live 2026-09-21: the four-edge frame was
 * rejected because leftover cobblestone scaffolds occupied left-edge cells.
 */
export function logPortalFrameSiteRejection(host: GroundedEvidenceHost, state: WorldState): void {
  const rejection = explainNearestPortalFrameRejection(host.bot, sensorOptions(host.options), state.self)
  if (rejection === null) return
  const line = formatPortalFrameSiteRejected(rejection)
  if (line === host.lastPortalFrameRejectionKey) return
  host.lastPortalFrameRejectionKey = line
  host.logger.warn(
    'agent',
    line,
    {
      origin: rejection.origin,
      axis: rejection.widthAxis,
      rule: rejection.rule,
      cell: rejection.cell,
      block: rejection.block,
      existing: rejection.existing,
    },
    host.tickCounter,
  )
}

/**
 * Surface the generator's typed explore dead end
 * (`EXPLORE_ROUTE_BLOCKED goal=... item=... reason=no_frontier|unreachable|exhausted`)
 * once per distinct line. When the active collect goal's item has a declared
 * producer (a name-scanned block source or a mob drop) but the tick offers no
 * grounded route - not even a generic exploration frontier - the stall must be
 * an explicit typed fact instead of silent WAIT / a blind non-advancing dig.
 * The marker is deterministic CAN truth about the OFFERED set, never a
 * preference; the same fact is fed into the starvation `missing` evidence so a
 * persistent dead end reaches the existing capability-gap boundary.
 */
export function logExploreRouteBlocked(host: GroundedEvidenceHost, blocked: ExploreRouteBlocked | null): void {
  host.exploreRouteBlockedThisTick = blocked
  const key = blocked === null ? null : formatExploreRouteBlocked(blocked)
  if (key === host.lastExploreRouteBlockedKey) return
  host.lastExploreRouteBlockedKey = key
  if (blocked === null) return
  host.logger.warn(
    'agent',
    formatExploreRouteBlocked(blocked),
    { goal: blocked.goal, item: blocked.item, reason: blocked.reason },
    host.tickCounter,
  )
}

/**
 * Surface the generator's typed no-safe-descent fact
 * (`COLUMN_DESCENT_REFUSED reason=no_safe_step|no_tool|exhausted cell=x,y,z`)
 * once per distinct line. A body with no standable frontier beyond its own cell
 * has no walking route at all; when even the bounded, damage-free vertical step
 * down its own support column is unavailable, the dead end must be an explicit
 * fact instead of a bare WAIT. Deterministic SAFE truth about the OFFERED set,
 * never a preference; the token also rides the starvation `missing` evidence so
 * the cause reaches the capability-gap boundary.
 */
export function logColumnDescentRefusal(host: GroundedEvidenceHost, refusal: ColumnDescentRefusal | null): void {
  host.columnDescentRefusalThisTick = refusal
  const key = refusal === null ? null : formatColumnDescentRefused(refusal)
  if (key === host.lastColumnDescentRefusalKey) return
  host.lastColumnDescentRefusalKey = key
  if (refusal === null) return
  host.logger.warn(
    'agent',
    formatColumnDescentRefused(refusal),
    { ...refusal, goal: host.currentGoalKey() },
    host.tickCounter,
  )
}

/**
 * Typed `HUNT_CONTACT_UNREACHABLE` evidence: a sensed fight target that sits
 * above the body's walk envelope and for which the ONE vertical planner grounds
 * no route to its level. Code withholds the ATTACK for it BY CAN (the candidate
 * gate reports `needs_ascend` + `ascend_plan`), so the target is never leased as
 * a 0-swing `out_of_range` attempt; this line names the geometry and the
 * planner's own refusal. Deduplicated on the exact line so a stationary hover
 * does not repeat every tick.
 */
export function logContactRefusals(host: GroundedEvidenceHost, refusals: readonly ContactRefusal[]): void {
  const lines = refusals.map((refusal) =>
    formatContactUnreachable({
      actionId: `ATTACK:e${refusal.entityId}`,
      entityId: refusal.entityId,
      targetName: refusal.targetName,
      // A candidate-side refusal is always the GATE's proof: the contact geometry
      // alone ruled the melee envelope out before any lease existed.
      evidence: 'vertical_gap' as const,
      approach: refusal.approach,
      distance: refusal.distance,
      gapY: refusal.gapY,
      meleeReach: MELEE_THREAT_REACH,
      walkGap: MELEE_THREAT_REACH,
      ascentRefusal: refusal.reason,
      placeable: refusal.placeable,
    }),
  )
  const key = lines.join('|')
  if (key === host.lastContactRefusalKey) return
  host.lastContactRefusalKey = key
  for (let index = 0; index < refusals.length; index += 1) {
    const refusal = refusals[index]
    const line = lines[index]
    if (line === undefined) continue
    host.logger.warn(
      'agent',
      line,
      { ...refusal, goal: host.currentGoalKey() },
      host.tickCounter,
    )
  }
}

/**
 * The typed `PROSPECT_REFUSED` fact: the active descend/travel-to-acquire row
 * passed a sensed producer of its focus and the exposure dig that would have
 * offered it en route was refused by the world (hazard, unbreakable wall, no
 * support, missing harvest tool). Deduped like the column-descent refusal so a
 * blocked exposure is one line, and carried into the starvation `missing`
 * evidence so the descend step can never be the only thing on offer without its
 * stated mechanical cause.
 */
export function logProspectRefusal(host: GroundedEvidenceHost, refusal: ProspectRefusal | null): void {
  host.prospectRefusalThisTick = refusal
  const key = refusal === null ? null : formatProspectRefused(refusal)
  if (key === host.lastProspectRefusalKey) return
  host.lastProspectRefusalKey = key
  if (refusal === null) return
  host.logger.warn(
    'agent',
    formatProspectRefused(refusal),
    { ...refusal, goal: host.currentGoalKey() },
    host.tickCounter,
  )
}

/**
 * The typed "this collect focus has no available source" fact (SOURCE-side,
 * orthogonal to the MOVEMENT-side `EXPLORE_ROUTE_BLOCKED`). Emitted once per
 * distinct gap (deduped like the live-structure exclusions) so the semantic
 * layer sees WHY no route exists instead of the plan silently re-targeting a
 * stale remembered cell.
 */
export function logResourceSourceGap(host: GroundedEvidenceHost, gap: ResourceSourceGap | null): void {
  const key = gap === null ? null : formatResourceSourceGap(gap)
  if (key === host.lastSourceGapKey) return
  host.lastSourceGapKey = key
  if (gap === null) return
  host.logger.warn('agent', formatResourceSourceGap(gap), { ...gap }, host.tickCounter)
}

/**
 * Mirror the combat-kit prerequisite gap once per distinct line.
 *
 * M3's remaining items are mob drops, and the measured Nether arrival body
 * had no armour and no sword: the tick offered `hunt blaze ... with bare
 * fists` and nothing said the fight was unwinnable. This marker names the
 * target, the swing damage, the worn-armour count, what is missing, and
 * whichever grounded prerequisite route (sword craft / armour equip) the tick
 * actually offers - so a post-mortem can tell "walked into a fight it could
 * not win" apart from "had a route and lost".
 */
export function logCombatKitGap(host: GroundedEvidenceHost, gap: CombatKitGapEvidence | null): void {
  const line =
    gap === null
      ? null
      : formatCombatKitGap({
          focus: gap.focus,
          target: gap.target,
          distance: gap.distance,
          assessment: gap.assessment,
          heldItem: gap.heldItem,
          prerequisite: gap.prerequisite,
        })
  if (line === host.lastCombatKitGapLine) return
  host.lastCombatKitGapLine = line
  if (line === null || gap === null) return
  host.logger.warn(
    'agent',
    line,
    {
      focus: gap.focus,
      target: gap.target,
      distance: gap.distance,
      held: gap.heldItem,
      swingDamage: gap.assessment.swingDamage,
      armor: gap.assessment.wornArmorCount,
      missing: gap.assessment.missing.join(','),
      regenerating: gap.assessment.regenerating,
      prerequisite: gap.prerequisite,
      goal: host.currentGoalKey(),
    },
    host.tickCounter,
  )
}

/**
 * The typed "a hungry body has NO grounded route to food" fact
 * (`FOOD_SOURCE_NONE item=food reason=no_source_sensed|source_withheld ...`).
 *
 * Bounded and descriptive: it names which affordances are missing (no edible
 * item held, no food animal sensed, no edible/ingredient block sensed, no
 * cookable recipe) and what the world still affords (`next=explore|escalate`).
 * Deduped per distinct line, so a stable dead end is one auditable fact, and
 * an escalating one (`starving=true`) is visible as the body reaches the
 * code-owned starvation floor. It never selects an action.
 */
export function logFoodSourceGap(host: GroundedEvidenceHost, gap: FoodSourceGap | null): void {
  const key = gap === null ? null : formatFoodSourceGap(gap)
  if (key === host.lastFoodSourceGapKey) return
  host.lastFoodSourceGapKey = key
  if (gap === null) return
  host.logger.warn('agent', formatFoodSourceGap(gap), { ...gap, goal: host.currentGoalKey() }, host.tickCounter)
}

/**
 * The typed "the active collect goal needs a MOB DROP and no producer route is
 * on offer" fact
 * (`MOB_DROP_SOURCE_NONE item=ender_pearl reason=no_producer_sensed producers=["enderman"] sensed=0 offered=["explore"] next=explore`).
 *
 * This is the producer-side half of the M3 pearl gap: the run log had no line
 * that said the pearl need existed, that its producer is an enderman, that no
 * enderman was sensed, and that the tick was offering the generic exploration
 * arm instead. Descriptive only - it names the missing affordance and the
 * grounded next step, never a chosen action. Deduped per distinct line.
 */
export function logMobDropSourceGap(host: GroundedEvidenceHost, gap: MobDropSourceGap | null): void {
  const key = gap === null ? null : formatMobDropSourceGap(gap)
  if (key === host.lastMobDropGapKey) return
  host.lastMobDropGapKey = key
  if (gap === null) return
  host.logger.warn('agent', formatMobDropSourceGap(gap), { ...gap, goal: host.currentGoalKey() }, host.tickCounter)
}

/**
 * The typed "where this producer can exist, and whether the live context was
 * actually read" fact (`MOB_SPAWN_CONTEXT item=ender_pearl ... reason=met|context_unknown|light_unmet|dimension_unmet ... searchGrounded=true`).
 *
 * Emitted whenever the producer search is live and its spawn context could NOT
 * be positively confirmed, so the three shapes that all looked like
 * `MOB_DROP_SOURCE_NONE ... sensed=0` in the measured M3 run are now
 * distinguishable: a valid spawn context ahead, a context nobody could
 * measure, and a dimension that can never host the producer. A `met` verdict
 * is already carried on the offered search MOVE, so it is not mirrored again
 * here. Deduped per distinct line; descriptive only.
 */
export function logMobSpawnContext(host: GroundedEvidenceHost, gap: MobDropSourceGap | null): void {
  if (gap === null) {
    host.lastMobSpawnContextKey = null
    return
  }
  const context = gap.spawnContext
  if (context !== null && context.reason === 'met') return
  const line = formatMobSpawnContext(gap.item, gap.producers, context)
  if (line === host.lastMobSpawnContextKey) return
  host.lastMobSpawnContextKey = line
  host.logger.warn('agent', line, { item: gap.item, producers: gap.producers, spawnContext: context, goal: host.currentGoalKey() }, host.tickCounter)
}

/** Mirror an ignition refusal once per distinct line: malformed frame or no flint_and_steel. */
export function logIgnitionRefusal(host: GroundedEvidenceHost, refusal: IgnitionRefusal | null): void {
  const key = refusal === null ? null : refusal.line
  if (key === host.lastIgnitionRefusalKey) return
  host.lastIgnitionRefusalKey = key
  if (refusal === null) return
  host.logger.warn('agent', refusal.line, { reason: refusal.reason, frameShape: refusal.frameShape }, host.tickCounter)
}

/**
 * Mirror the smelt input prerequisite once per distinct line: which concrete
 * input the current smelt goal needs, whether it is held, and whether the
 * deterministic collect route was offered. Data-driven input (a `*_log` for
 * charcoal, raw_iron for iron_ingot), so the marker names the item the bot
 * must collect instead of letting the goal starve silently.
 */
export function logSmeltInputPrereq(host: GroundedEvidenceHost, state: WorldState, options: CandidateOptions): void {
  const entry = smeltInputPrereq(state, options)
  const line = entry === null ? null : formatSmeltInputPrereq(entry)
  if (line === host.lastSmeltInputPrereqLine) return
  host.lastSmeltInputPrereqLine = line
  if (entry === null || line === null) return
  host.logger.warn('agent', line, { ...entry }, host.tickCounter)
}

/**
 * Mirror the craft ingredient prerequisite once per distinct line: which
 * ingredient the current craft goal is missing and which producer the
 * candidate generator offers for it (`collect log` for the live wooden_pickaxe
 * shape, `craft oak_planks` when the plan already has an executable step).
 */
export function logCraftIngredientPrereq(host: GroundedEvidenceHost, state: WorldState, options: CandidateOptions): void {
  const entry = craftIngredientPrereq(state, options)
  const line = entry === null ? null : formatCraftIngredientPrereq(entry)
  if (line === host.lastCraftIngredientPrereqLine) return
  host.lastCraftIngredientPrereqLine = line
  if (entry === null || line === null) return
  host.logger.warn('agent', line, { ...entry }, host.tickCounter)
}

/**
 * Mirror the typed station fact for a station-requiring CRAFT goal once per
 * distinct line. OPERATOR RULE (station-use-before-craft; measured live
 * 2026-09-21): while 26 crafting tables and 17 furnaces were known, the queue
 * crafted a table and then a furnace. A station craft is withheld whenever the
 * world model already holds that station, so the state must SAY why the craft
 * disappeared: `CRAFT_STATION_ALREADY_KNOWN ... reason=... next=...` names the
 * known cells, the retired ones, and the route the generator offered instead
 * (`use_known_station` / `place_held` / the typed `capability_gap`).
 */
export function logCraftStationGap(host: GroundedEvidenceHost, state: WorldState, options: CandidateOptions): void {
  const gap = craftStationGap(state, options)
  const line = gap === null ? null : formatCraftStationGap(gap)
  if (line === host.lastCraftStationGapLine) return
  host.lastCraftStationGapLine = line
  if (gap === null || line === null) return
  host.logger.warn('agent', line, { ...gap }, host.tickCounter)
}

/**
 * Mirror the typed smelt route gap once per distinct line. A smelt goal whose
 * station/input/fuel precondition has no grounded route must SAY so instead of
 * presenting a bare `[WAIT]` set: `SMELT_STATION_MISSING` names what is
 * missing, how many stations are held/placed, and where the known ones are, so
 * the same starvation/escalation evidence that wakes System2 carries a typed
 * reason. The value is also kept for this tick's `CANDIDATE_STARVATION`.
 */
export function logSmeltRouteGap(host: GroundedEvidenceHost, state: WorldState, options: CandidateOptions): void {
  const gap = smeltRouteGap(state, options)
  host.smeltRouteGapThisTick = gap
  const line = gap === null ? null : formatSmeltRouteGap(gap)
  if (line === host.lastSmeltRouteGapLine) return
  host.lastSmeltRouteGapLine = line
  if (gap === null || line === null) return
  host.logger.warn('agent', line, { ...gap }, host.tickCounter)
}

/**
 * A `SMELT` candidate the guard refuses at a station the active smelt goal
 * keeps naming must SAY which station, how many attempts it has taken there,
 * and which grounded route the ladder offers instead. `NO_PATH` alone repeated
 * 200+ times is evidence without a typed outcome - the silent strategic-stall
 * family this lane closes. `next=travel` is the generic locomotion route
 * (a remembered/registered station), `next=place` a held furnace, and
 * `next=capability_gap` the typed no-route case.
 */
export function logSmeltStationRetry(host: GroundedEvidenceHost, candidate: Candidate): void {
  if (candidate.kind !== 'SMELT' || candidate.target === null) return
  const state = host.lastWorldState
  if (state === null) return
  const entry = smeltStationRetry(
    state,
    candidateOptions(
      host.options,
      host.recipeIndex,
      host.unreachableStationKeys(state),
      host.reachabilityGateOptions(),
      host.blacklistedMoveTargets(state),
      null,
      host.searchedSurfaceTargets,
    ),
  )
  if (entry === null) return
  const target = candidate.target
  if (target.x !== entry.station.x || target.y !== entry.station.y || target.z !== entry.station.z) return
  const attempts = host.moveFailMemory.check(host.currentDimension(), target).attempts
  const line = formatSmeltStationRetry(entry, attempts)
  if (line === host.lastSmeltStationRetryLine) return
  host.lastSmeltStationRetryLine = line
  host.logger.warn('agent', line, { station: entry.station, attempts, next: entry.next }, host.tickCounter)
}

/**
 * Issue #43: the fuel subgoal is inventory-first. When the live inventory
 * already holds a valid fuel item the plan must not obtain another one, so the
 * skip is logged once per goal+item and retrieval is suppressed downstream.
 */
export function logFuelSatisfaction(host: GroundedEvidenceHost, state: WorldState): void {
  const current = host.queue.current
  if (!goalWantsFuel(current)) return
  const satisfaction = fuelSatisfaction(state)
  if (satisfaction === null) return
  const key = `${current?.id ?? 'none'}:${satisfaction.item}:${satisfaction.count}`
  if (host.fuelSatisfiedKey === key) return
  host.fuelSatisfiedKey = key
  host.logger.warn(
    'agent',
    formatFuelSatisfied(satisfaction.item, satisfaction.count),
    { item: satisfaction.item, have: satisfaction.count, goal: current?.description ?? null, action: 'skip' },
    host.tickCounter,
  )
}

/**
 * Bounded roll-up of the revalidation-guard counters.
 *
 * Measured live (`run-muc3qbug-18vg3`): 630 `chosen candidate ... vanished
 * between the Jev answer and execution` drops, five of them inside the 18 s
 * Nether death window, and the run log carried no aggregate anywhere - so a
 * post-mortem reading buddy.log could not see that the body had spent the
 * whole death window dropping every survival choice it made. Emitted on
 * doubling milestones so the total is visible without one line per drop.
 */
export function logGuardRejections(host: GroundedEvidenceHost): void {
  const total = host.guardRejections + host.survivalRegrounds
  if (total < 1 || total < host.lastGuardRollupAt * 2) return
  host.lastGuardRollupAt = total
  host.logger.warn(
    'guard',
    `${GUARD_REJECTIONS} total=${total} dropped=${host.guardRejections} regrounded=${host.survivalRegrounds} ` +
      `-> chosen candidates revalidated against the fresh offer (dropped = tick ended without that action)`,
    { total, dropped: host.guardRejections, regrounded: host.survivalRegrounds },
    host.tickCounter,
  )
}
