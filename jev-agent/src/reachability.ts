// reachability.ts - the deterministic affordance gate (#11 v2, owner's root
// cause: "AIBuddy tries to go to places it cannot reach").
//
// A locomotion target is an affordance, not a wish. This module decides, from
// FACTS (pathfinder probe result, vertical gap + whether an ascend/descend plan
// is mechanically available, required tool tier for any block that must be
// broken, standable approach cells, hazard flags), whether a candidate target is
// mechanically reachable right now:
//
//   reachable    -> evaluateReachability(...).reachable === true
//   unreachable  -> a typed reason + the capabilities that would make it
//                   reachable (obtain a tool, gain a placeable block, clear
//                   headroom, ...). Never a silent retry.
//
// Live evidence for the bug this gates (run-mu5qd4ah-3xdh / buddy-driver
// logs/jev/run.jsonl, main d8a7a72): the bot at y=9-14 was presented
// `RETRIEVE:known:station:furnace:b29_61_35` (dy=52) 245x, plus 1982x
// `packet locomotion blocked before (29,61,35)`, 509x `no jump headroom at
// (39,11,34)`, and `PILLAR_REFUSED reason=no_footing|no_headroom cause=needs_tool`
// while holding no pickaxe - the ascend plan could never execute, yet the target
// was re-offered every tick.
//
// Pure: no bot, no clock, no model. Same facts in -> same verdict out.
import type { HarvestTool, Vec3Json } from './state.ts'
import { PICKAXE_RANKS, distance } from './state.ts'
import { ENV_LAVA_PROXIMITY } from './envHazard.ts'

export type ReachabilityReason =
  | 'reachable'
  | 'no_path'
  | 'needs_ascend'
  | 'needs_descend'
  | 'missing_tool'
  | 'no_standable_approach'
  | 'out_of_reach'
  | 'hazard_blocked'
  /**
   * issue #436 section 9: a goal-directed producer/food hunt whose target is
   * beyond the distance one bounded hunt lease can close AND has no positive route
   * proof. The kill is not groundable yet; the ordinary route candidates advance
   * the body and the ATTACK is offered once the target is inside the budget.
   */
  | 'hunt_approach_budget'
  /**
   * SAFE/CAN: an ATTACK whose target no STANCE can hit. A path to some adjacent
   * cell is not a position from which a swing lands: the offer is grounded on a
   * cell that is standable, hazard-free, inside the melee envelope AND has line
   * of sight to the entity. When no such cell exists - a mob embedded in
   * geometry (the operator's Nether screenshot: line of sight fails from every
   * stance) or a mob no stance within melee reach can be walked to (the measured
   * enderman at 6.11 m, `pathfinder goal WAS set 5x`, distance frozen for ~47 s,
   * ZERO swings) - the ATTACK is withheld with this typed reason instead of
   * being leased into `out_of_reach`/`verify_failed`. The entity, the melee
   * constant and the nearest refused stance are mirrored as `NO_ATTACK_STAND`.
   */
  | 'no_attack_stand'
  /**
   * SAFE/CAN: a mechanical locomotion leg whose realization would stand the body
   * in a dimension-transfer cell (a lit portal block) - either as its
   * destination or along the route it would walk.
   *
   * Measured live (`run-mucgir1z-1p7oh`): a skeleton engaged the body at ~9 m
   * inside the Nether portal room, every grounded keep-distance destination was
   * a cell of the portal itself, and "move away from the threat" was realized as
   * a dimension change - `the_nether -> overworld -> the_nether` 186 times, 30-90 s
   * apart, each re-entry walking straight back to the same skeleton.
   *
   * Crossing a dimension is not locomotion: it abandons the whole objective, and
   * in this geometry it guarantees a re-entry loop. It is a semantic disengage
   * that belongs to Jev/System2 as an explicit choice, which is exactly what the
   * `ENTER_PORTAL` candidate is. Code owns only the fact, so it refuses to
   * realize one through a MOVE/RETRIEVE/RETREAT leg.
   */
  | 'crosses_dimension'

/**
 * The route-side verdict for the dimension-transfer invariant: does the body's
 * own route to a destination stand it in a transfer cell? `'unknown'` means no
 * route planner (or no verdict) and never refuses anything by itself.
 */
export type DimensionTransferRoute = 'crosses' | 'clear' | 'unknown'

/** Vertical gap (blocks) a `canDig=false` body change can walk without a plan. */
export const ASCEND_GAP_LIMIT = 4
export const DESCEND_GAP_LIMIT = 4
/** A hazard this close to the destination blocks it (one number: `envHazard.ts`). */
export const HAZARD_PROXIMITY = ENV_LAVA_PROXIMITY

/**
 * Horizontal range (blocks) within which a vertical gap is a LOCAL affordance
 * question: the body is at (or beside) the destination column, so "can I get up
 * or down from HERE" is the binding mechanical fact.
 *
 * Beyond it the vertical leg is a TRAVEL leg. `state.descent` is computed from
 * the body's own four cardinal cells, so it says nothing about the terrain 90
 * blocks away; refusing a far target because the body's current cell has no safe
 * dig-down step is exactly the "the body is not standing on the spot yet"
 * refusal the reachability layer must never make. This is the same range the
 * far-leg `no_path` relaxation uses (candidates.ts FAR_LEG_PROBE_RADIUS): a
 * probe of the body's neighbourhood is not evidence about a far destination.
 *
 * The relaxation is DELIBERATELY one-sided. An ascent needs a specific structure
 * (a placeable block plus a safe column, or a clearable step) and arriving closer
 * does not create it, so a far upward gap stays a typed `needs_ascend` refusal -
 * that is the measured run-mu5qd4ah-3xdh defect this gate exists for. A descent
 * needs only lower ground, which the ordinary walk (and the same vertical plan
 * re-derived from fresh state on arrival) can take, so a far downward gap is a
 * route to travel, not a capability the body must already hold.
 */
export const LOCAL_VERTICAL_LEG_RADIUS = 24

/** Horizontal (XZ) distance between two cells; the vertical leg's own range fact. */
export function horizontalDistance(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/**
 * Eye→block-AABB distance from an explicit eye position (the reach test). The
 * #244 interaction-stand geometry, shared here so the station approach
 * (executor) and the dig-access search (candidates) use ONE implementation.
 */
export function faceDistanceFromEye(eye: Vec3Json, block: Vec3Json): number {
  const x = Math.max(block.x, Math.min(eye.x, block.x + 1))
  const y = Math.max(block.y, Math.min(eye.y, block.y + 1))
  const z = Math.max(block.z, Math.min(eye.z, block.z + 1))
  return Math.hypot(eye.x - x, eye.y - y, eye.z - z)
}

/** Eye→block-AABB distance from a candidate stand's eyes (its interaction reach). */
export function interactionFaceDistance(stand: Vec3Json, block: Vec3Json): number {
  return faceDistanceFromEye({ x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }, block)
}

/** The four horizontal interaction offsets the #244 stand search examines. */
export const INTERACTION_STAND_OFFSETS: readonly Vec3Json[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/** The three stances (feet levels) the #244 stand search examines per offset. */
export const INTERACTION_STAND_DY: readonly number[] = [0, 1, -1]

/** Something the body lacks that would make a target reachable if acquired. */
export type Capability =
  | { kind: 'tool'; tool: HarvestTool; tier: number }
  | { kind: 'placeable_block' }
  | { kind: 'headroom'; cell: Vec3Json | null }
  | {
      kind: 'safe_column'
      /** no usable ascent geometry, or geometry whose blocker needs a tool */
      reason: SafeColumnRefusalReason
      /** the column cell the classification examined; null only for legacy callers */
      cell: Vec3Json | null
      /** required tool family when `reason === 'no_tool'` */
      tool: HarvestTool | null
      /** minimum rank when `tool === 'pickaxe'` */
      tier: number | null
    }
  | {
      kind: 'ascend_plan'
      /**
       * The vertical plan the column DID carry, when one was grounded but not
       * mechanically available (`pillar` / `staircase-up` / `reuse`), or null
       * when the planner grounded nothing at all.
       */
      plan?: string | null
      /**
       * Which column precondition or sensor classification stopped it, named so
       * the refusal is actionable. Mirrors `descend_plan`: the bare token is kept
       * only when no fact can be named, so existing fingerprints do not drift.
       */
      reason?: AscendPlanRefusalReason | null
      /** the body's own feet column the classification examined */
      cell?: Vec3Json | null
    }
  | {
      kind: 'descend_plan'
      /**
       * The typed mechanical fact that refused every safe descent step, when the
       * sensor pool could name one (`no_support`, `hazard`, `unbreakable`,
       * `open_floor`, `protected`). Null/absent for the bare "no plan" token, so
       * a legacy caller keeps the historical `descend_plan` key.
       */
      reason?: DescendPlanRefusalReason | null
      /** the refused step's landing cell, when the refusal has one */
      cell?: Vec3Json | null
      /** the concrete block that refused the step (`bedrock`, `lava`, ...) */
      block?: string | null
      /** required tool family when the refused dig needs one the body lacks */
      tool?: HarvestTool | null
      /** minimum tool rank when `tool === 'pickaxe'` */
      tier?: number | null
    }
  | { kind: 'open_path' }
  | { kind: 'standable_approach' }

/**
 * Why no grounded descent plan exists, as a typed fact. `no_safe_step` means the
 * sensor pool carried no down step at all to judge; the rest are the mechanical
 * preconditions of a controlled descent that were absent.
 */
export type DescendPlanRefusalReason =
  | 'no_safe_step'
  | 'no_support'
  | 'open_floor'
  | 'hazard'
  | 'unbreakable'
  | 'protected'

/**
 * Why a `safe_column` is missing, named so the marker is actionable: the
 * geometry is absent (`no_clearance`) or present without the held tool
 * (`no_tool`). A bare `safe_column` token is forbidden.
 */
export type SafeColumnRefusalReason = 'no_clearance' | 'no_tool'

/**
 * Why an upward gap has no AVAILABLE ascent, as a typed fact.
 *
 * Only ONE fact was left unnamed, and the live trial was exactly it: the operator's
 * floated gate left the body on a ledge with `place=1 hazard=0 tools=[]` and 834
 * identical `reason=needs_ascend missing=[ascend_plan]` lines - a token that can
 * only be retried, never acted on. Every other precondition in that branch is
 * already named by its own capability (`placeable_block`, `headroom` + `tool`,
 * `safe_column:no_clearance|no_tool`), so the bare token is reachable only when a
 * plan WAS grounded and its own column has no proven support:
 *
 *   `no_footing`       the live fact: a grounded pillar whose `footingSolid` is
 *                      false, so `explicitPlanAvailable` is false while the
 *                      column's placeable block, headroom and safe column are all
 *                      fine - which is what made it invisible;
 *   `plan_unavailable` defensive: any future column precondition that refuses a
 *                      grounded plan without naming itself. Never silently bare.
 */
export type AscendPlanRefusalReason = 'no_footing' | 'plan_unavailable'

/** A block that must be broken before the target is reachable, with its tool facts. */
export interface ReachabilityBarrier {
  position: Vec3Json
  name: string
  requiredTool: HarvestTool | null
  /** minimum rank on the PICKAXE_RANKS scale when `requiredTool === 'pickaxe'` */
  requiredTier: number | null
}

export interface ReachabilityTarget {
  candidateId: string
  kind: string
  /** destination cell; null means "not a locomotion target" (always feasible) */
  position: Vec3Json | null
  barrier: ReachabilityBarrier | null
}

/** World facts about the destination and the body's current column. */
export interface ReachabilityWorld {
  self: Vec3Json
  /** standable feet cell at/adjacent to the target, null when none exists */
  approach: Vec3Json | null
  /** interaction reach from the eyes (blocks) */
  reach: number
  /** a hazard cell is adjacent to the destination */
  hazardAtTarget: boolean
  /** solid support under the bot's feet (pillar/footing precondition) */
  footingSolid: boolean
  /** the bot's own column has jump headroom */
  headroomClear: boolean
  /**
   * fact: the body has at least one standable cell beyond its own column, so a
   * travel leg exists at all (`!strandedOnColumn`). Absent means "assume the
   * body can walk" - refusing on an absent fact would silently re-create the
   * "not standing on the spot yet" suppression. When false the body is confined
   * to its own column, so the local descent pool IS the binding affordance even
   * for a far target.
   */
  canTravel?: boolean
}

export interface AscendAbility {
  available: boolean
  /** every missing prerequisite (placeable block, headroom cell, safe column, plan) */
  missing: Capability[]
}

export interface DescendAbility {
  available: boolean
  missing: Capability[]
}

export interface ReachabilityAbilities {
  ascend: AscendAbility
  descend: DescendAbility
}

export type PathProbeResult = 'reachable' | 'no_path' | 'unknown'

/**
 * The station family a sensed block belongs to. A station target is not an
 * ordinary locomotion cell: it is usable only from a real interaction stand, so
 * the approach facts below are collected per family.
 */
export type StationKindName = 'furnace' | 'crafting_table' | 'container'

/**
 * The station-approach facts the sensor JSON cannot carry. The executor already
 * knows how to *open* a station (`interactionStandCandidates`, #244); the
 * controller exposes the same geometry here, before candidate selection, so an
 * unreachable sensed station is never committed to and path_stuck'd.
 *
 * `approach` is a passable, supported stand whose interaction face is within
 * reach, or null when no such stand exists. `path` is the `canDig=false`
 * pathfinder verdict for walking to that stand; null means "not probed".
 */
export interface StationApproachFact {
  approach: Vec3Json | null
  path: PathProbeResult | null
}

export type StationApproachProbe = (station: Vec3Json, kind: StationKindName) => StationApproachFact

/** The exact reason a sensed station's approach was refused. */
export type StationApproachRefusal = 'no_interaction_stand' | 'no_path_to_stand'

/**
 * The observability marker for a sensed station whose approach was refused
 * before it could be selected. Never silent: the coordinate, family and the
 * mechanical fact that refused it are all named.
 */
export function formatStationUnreachable(
  kind: StationKindName,
  station: Vec3Json,
  reason: StationApproachRefusal,
): string {
  return `STATION_UNREACHABLE kind=${kind} id=b${Math.round(station.x)}_${Math.round(station.y)}_${Math.round(station.z)} reason=${reason}`
}

/**
 * The stand geometry for a blocked DIG target, generalised from the #244
 * interaction stand: the cell from which the target becomes diggable, plus the
 * `canDig=false` path verdict for walking to it. `approach` null means no such
 * stand exists; `path: 'no_path'` means it exists but cannot be walked to.
 */
export interface DigApproachFact {
  approach: Vec3Json | null
  path: PathProbeResult | null
}

/** Live dig-access probe; the controller wires it to `interactionStandCandidates` (#244). */
export type DigApproachProbe = (block: Vec3Json) => DigApproachFact

/** The exact reason a blocked dig target has no reachable access. */
export type DigAccessRefusal = 'no_interaction_stand' | 'no_path_to_stand'

/**
 * The observability marker for a dig target retired for lack of access. Never
 * silent: the coordinate and the mechanical fact that refused it are both named.
 */
export function formatDigAccessRetired(block: Vec3Json, reason: DigAccessRefusal): string {
  return `DIG_ACCESS_RETIRED reason=${reason} target=${Math.round(block.x)},${Math.round(block.y)},${Math.round(block.z)}`
}

export interface ReachabilityResult {
  reachable: boolean
  reason: ReachabilityReason
  missingCapabilities: Capability[]
}

const REACHABLE: ReachabilityResult = { reachable: true, reason: 'reachable', missingCapabilities: [] }

function unreachable(reason: ReachabilityReason, missingCapabilities: Capability[]): ReachabilityResult {
  return { reachable: false, reason, missingCapabilities }
}

/** Best held rank for a tool family; -1 means the family is not held at all. */
export function bestToolTier(counts: Readonly<Record<string, number>>, tool: HarvestTool): number {
  let best = -1
  for (const [name, count] of Object.entries(counts)) {
    if (count <= 0) continue
    if (tool === 'pickaxe') {
      const rank = PICKAXE_RANKS[name]
      if (rank !== undefined && rank > best) best = rank
      continue
    }
    if (name.endsWith(`_${tool}`) && best < 0) best = 0
  }
  return best
}

/**
 * The `tool` capability for a barrier the inventory cannot break, or null.
 * Exported so every candidate kind attributes its tool need from its OWN
 * barrier (a MINE candidate's block, never a sibling candidate's path).
 */
export function missingToolCapability(
  barrier: ReachabilityBarrier | null,
  inventory: Readonly<Record<string, number>>,
): Capability | null {
  if (barrier === null || barrier.requiredTool === null) return null
  const required = barrier.requiredTier ?? 0
  if (bestToolTier(inventory, barrier.requiredTool) >= required) return null
  return { kind: 'tool', tool: barrier.requiredTool, tier: required }
}

function ascendCapabilities(ability: AscendAbility): Capability[] {
  if (ability.available) return []
  return ability.missing.length > 0 ? ability.missing : [{ kind: 'ascend_plan' }]
}

function descendCapabilities(ability: DescendAbility): Capability[] {
  if (ability.available) return []
  return ability.missing.length > 0 ? ability.missing : [{ kind: 'descend_plan' }]
}

/**
 * The mechanic decision. Precedence is deterministic and fact-ordered:
 * hazard > missing tool for a mandatory break > vertical gap > path > approach.
 *
 * The vertical gap is applied at the range where it is a LOCAL affordance: a
 * gap above is always local (an ascent needs structure the body must already
 * hold); a gap below is local while the body is at the destination column or
 * cannot travel at all, and a travel leg otherwise (see
 * `LOCAL_VERTICAL_LEG_RADIUS`). A far target below is therefore offered, and the
 * descent is re-derived from fresh state where the terrain actually provides it.
 */
export function evaluateReachability(
  target: ReachabilityTarget,
  world: ReachabilityWorld,
  inventory: Readonly<Record<string, number>>,
  abilities: ReachabilityAbilities,
  pathProbe: PathProbeResult,
): ReachabilityResult {
  if (target.position === null) return REACHABLE
  if (world.hazardAtTarget) return unreachable('hazard_blocked', [])

  const toolCapability = missingToolCapability(target.barrier, inventory)
  if (toolCapability !== null) return unreachable('missing_tool', [toolCapability])

  const dy = Math.round(target.position.y - world.self.y)
  if (dy > ASCEND_GAP_LIMIT) {
    if (!abilities.ascend.available) {
      return unreachable('needs_ascend', ascendCapabilities(abilities.ascend))
    }
  } else if (dy < -DESCEND_GAP_LIMIT && !abilities.descend.available) {
    const localDescent =
      world.canTravel === false || horizontalDistance(world.self, target.position) <= LOCAL_VERTICAL_LEG_RADIUS
    if (localDescent) {
      return unreachable('needs_descend', descendCapabilities(abilities.descend))
    }
  }

  if (pathProbe === 'no_path') {
    return unreachable('no_path', [{ kind: 'open_path' }])
  }
  if (world.approach === null) {
    return unreachable(pathProbe === 'reachable' ? 'out_of_reach' : 'no_standable_approach', [
      { kind: 'standable_approach' },
    ])
  }
  if (distance(world.approach, target.position) > world.reach && distance(world.self, target.position) > world.reach) {
    return unreachable('out_of_reach', [{ kind: 'standable_approach' }])
  }
  return REACHABLE
}

/** Compact serialization of one capability, used in markers and fingerprints. */
export function capabilityKey(capability: Capability): string {
  switch (capability.kind) {
    case 'tool':
      return `tool:${capability.tool}@${capability.tier}`
    case 'placeable_block':
      return 'placeable_block'
    case 'headroom':
      return capability.cell === null
        ? 'headroom'
        : `headroom@${capability.cell.x},${capability.cell.y},${capability.cell.z}`
    case 'safe_column': {
      // A bare `safe_column` was not actionable (the live starvation carried it
      // with no cell and no tool); the key always names the fact it refused.
      const at = capability.cell === null ? '' : `@${capability.cell.x},${capability.cell.y},${capability.cell.z}`
      if (capability.reason === 'no_tool') {
        return `safe_column:no_tool${at}:${capability.tool ?? 'tool'}@${capability.tier ?? 0}`
      }
      return `safe_column:no_clearance${at}`
    }
    case 'ascend_plan': {
      // A bare `ascend_plan` means "no grounded, available ascent" and nothing
      // more; the typed suffix is added only when the column classified a
      // concrete fact, exactly like `descend_plan`. A legacy caller that pushes
      // the bare token therefore keeps the historical key byte-identical.
      const plan = capability.plan ?? null
      const reason = capability.reason ?? null
      if (plan === null && reason === null) return 'ascend_plan'
      const at =
        capability.cell === undefined || capability.cell === null
          ? ''
          : `@${capability.cell.x},${capability.cell.y},${capability.cell.z}`
      return `ascend_plan:${plan ?? 'none'}:${reason ?? 'unknown'}${at}`
    }
    case 'descend_plan': {
      // A bare `descend_plan` means "no grounded descent plan" and nothing more;
      // the typed suffix is added only when the sensor pool named the binding
      // mechanical fact, so the refusal is actionable (`descend_plan:no_support@x,y,z`)
      // instead of a token that can only be retried.
      const reason = capability.reason ?? null
      if (reason === null || reason === 'no_safe_step') return 'descend_plan'
      const at =
        capability.cell === undefined || capability.cell === null
          ? ''
          : `@${capability.cell.x},${capability.cell.y},${capability.cell.z}`
      const block = capability.block === undefined || capability.block === null ? '' : `:${capability.block}`
      const tool =
        capability.tool === undefined || capability.tool === null
          ? ''
          : `:${capability.tool}@${capability.tier ?? 0}`
      return `descend_plan:${reason}${at}${block}${tool}`
    }
    case 'open_path':
      return 'open_path'
    case 'standable_approach':
      return 'standable_approach'
  }
}

export function formatMissingCapabilities(capabilities: readonly Capability[]): string {
  return `[${capabilities.map(capabilityKey).join(',')}]`
}

function targetLabel(position: Vec3Json | null): string {
  return position === null ? 'none' : `${position.x},${position.y},${position.z}`
}

/** The observability marker for one reachability evaluation. */
export function formatReachability(target: ReachabilityTarget, result: ReachabilityResult): string {
  return `REACHABILITY target=${targetLabel(target.position)} reachable=${result.reachable} reason=${result.reason} missing=${formatMissingCapabilities(result.missingCapabilities)}`
}

/** The observability marker for a candidate the affordance gate withheld. */
export function formatCandidateWithheld(candidateId: string, reason: ReachabilityReason): string {
  return `CANDIDATE_WITHHELD reason=${reason} candidate=${candidateId}`
}

/** Stable, semantic state fingerprint for a target's reachability verdict (#11 v2 §6). */
export interface ReachabilityFingerprintInput {
  target: ReachabilityTarget
  result: ReachabilityResult
  inventory: Readonly<Record<string, number>>
  world: ReachabilityWorld
  /** fact: a placeable block exists (selectPlaceableBlock(...) !== null) */
  placeableBlock: boolean
}

/**
 * Relevant facts only: target cell, verdict, missing capabilities, the vertical
 * gap BUCKET (so a 1-block shuffle does not reset the proof), the held tier of
 * every missing tool family and whether a placeable block exists. Wall clock and
 * bot position are deliberately excluded: an unchanged state keeps suppressing,
 * a genuinely changed state (new tool/block/headroom) re-opens the target.
 *
 * `includeVerticalGap: false` drops the ONE body-relative term and yields the
 * target's own grounding facts. Needed by callers asking a question that must
 * not be reset by the body's own transient motion inside a failing attempt - see
 * `reachabilityTargetSignature`. The field list stays in this ONE function, so
 * the two forms cannot drift.
 */
export function reachabilityFingerprint(
  input: ReachabilityFingerprintInput,
  options: { includeVerticalGap?: boolean } = {},
): string {
  const position = input.target.position
  const gap = position === null ? 0 : Math.round(position.y - input.world.self.y)
  const gapBucket =
    gap > ASCEND_GAP_LIMIT ? 'ascend_far' : gap < -DESCEND_GAP_LIMIT ? 'descend_far' : String(gap)
  const missing = input.result.missingCapabilities.map(capabilityKey).sort().join(',')
  const tools = input.result.missingCapabilities
    .filter((capability): capability is Extract<Capability, { kind: 'tool' }> => capability.kind === 'tool')
    .map((capability) => `${capability.tool}:${bestToolTier(input.inventory, capability.tool)}`)
    .sort()
    .join(',')
  const fields = [
    'rv1',
    targetLabel(position),
    input.result.reason,
    `missing=[${missing}]`,
    `place=${input.placeableBlock ? 1 : 0}`,
    `tools=[${tools}]`,
    `hazard=${input.world.hazardAtTarget ? 1 : 0}`,
    `approach=${input.world.approach === null ? 0 : 1}`,
    `head=${input.world.headroomClear ? 1 : 0}`,
    `foot=${input.world.footingSolid ? 1 : 0}`,
  ]
  if (options.includeVerticalGap === false) return fields.join('|')
  // The gap sits after `missing=[...]` in the pins callers already depend on.
  fields.splice(4, 0, `gap=${gapBucket}`)
  return fields.join('|')
}

/**
 * The TARGET's own grounding facts: `reachabilityFingerprint` without the single
 * body-relative term (the vertical gap).
 *
 * Why the gap must be excluded for this question. Measured live (`m3-live`,
 * `ASCEND:habitat:p3_68_22`, 2026-09-21T19:55:26 -> 20:20:04): the candidate's
 * fingerprint during the runaway alternated `gap=1` x122 / `gap=0` x115 because
 * the failing action's own step rose one block and fell back. Any counter keyed
 * on the full fingerprint therefore restarts every attempt, which is precisely
 * how 184 identical `apex_missed` outcomes at one cell produced no escalation.
 * The gap is a relationship between the BODY and the target, not a fact about
 * whether the target is grounded; every term kept here is a fact about the
 * target (cell, verdict, missing capabilities, placeable block, every missing
 * tool tier, hazard, approach, headroom, footing), so a genuinely new capability
 * still re-opens it.
 */
export function reachabilityTargetSignature(input: ReachabilityFingerprintInput): string {
  return reachabilityFingerprint(input, { includeVerticalGap: false })
}
