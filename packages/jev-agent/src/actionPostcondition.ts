// actionPostcondition.ts - Issue #79: an action is only DONE when its
// post-condition holds.
//
// Measured 2026-09-18 10:20 JST: `status=done verified=false resource=null
// progressDelta=0` for a smelt plan was treated as success, so the same plan was
// re-queued forever and every downstream gate (rung supply, SMELT_DONE) saw a
// false positive. An action that finishes `done` with an unmet post-condition and
// ZERO observable change (no item gained, no block removed) is a FAILURE.
//
// This module is pure and bot-free so the post-condition catalog, the
// classification and the abandon budget are unit-testable with no Mineflayer
// connection. The executor uses `isUnverifiedOutcome` to downgrade the result to
// `failed`; the controller uses `decideActionOutcome` / `evaluateUnverifiedBudget`
// to log ACTION_UNVERIFIED and to stop retrying one strategy forever.

/**
 * How many unverified attempts the same planId + strategy gets before the
 * controller abandons it (`ABANDON_REASON=action_unverified`) and selects the
 * next option. Small on purpose: the plan has already produced zero progress.
 */
export const UNVERIFIED_ACTION_LIMIT = 2

/** The executor outcome fields a post-condition check needs. */
export interface ActionOutcomeInput {
  /** `CandidateKind` (`MINE`, `SMELT`, `PLACE`, `CRAFT`, `RETRIEVE`, ...) */
  kind: string
  /** `ExecutionResult['status']` */
  status: string
  verified: boolean
  itemsGained: number
  blockRemoved?: boolean
  /** deterministic body change with no block/item evidence (altitude gained), when known */
  progressed?: boolean
  /** a target entity emitted Mineflayer's entityDead event during this action */
  entityDefeated?: boolean
  /**
   * #391: an ATTACK lease observed server-side damage on its target (an
   * `entityHurt` attributable to this lease, or the target's death during the
   * lease). Issuing `bot.attack()` calls is an execution attempt and never sets
   * this. It is the post-condition evidence for a non-hunt ATTACK: a hit is the
   * bar, a kill is not.
   */
  damageObserved?: boolean
  /**
   * True when this action must end with its drop in the inventory (a collect
   * goal). A collect MINE is complete only on `itemsGained > 0`; a removed block
   * and an observed drop are the DIG, not the acquisition.
   */
  requiresPickup?: boolean
  /** local plan revision (GoalQueue row id), when the caller knows it */
  planId?: string | null
  /** executor action id, when the caller knows it */
  actionId?: string | null
  /** high-level strategy label (`llm:smelt`, ...), when known */
  strategy?: string | null
  /** unverified attempts recorded for this planId INCLUDING this one, when known */
  attempts?: number | null
  /** executor failure code, when execution failed; used only to classify invalidity evidence */
  failureCode?: string | null
}

/** Execution and progress are separate axes; `verified` alone is not a taxonomy. */
export type ExecutionOutcome = 'success' | 'failure' | 'cancelled' | 'control'
export type VerificationOutcome = 'verified' | 'unverified' | 'not_applicable'
export type ProgressKind = 'goal' | 'body' | 'search' | 'none'

export interface ActionOutcomeTaxonomy {
  execution: ExecutionOutcome
  verification: VerificationOutcome
  /** Primary progress class; see progressKinds for simultaneous body+search evidence. */
  progress: ProgressKind
  progressKinds: ProgressKind[]
  /** Control-plane actions are neither physical failures nor productive work. */
  control: 'none' | 'wait' | 'escalate'
  invalidity: 'none' | 'deterministic'
  semantic: 'none' | 'goal' | 'abandon'
}

/**
 * Only failures that prove the candidate contradicts the CURRENT world facts are
 * deterministic invalidity. Timeouts, stuck paths, pickup misses and generic
 * executor errors are observations of an attempt, not proof that the same
 * candidate is impossible under an unchanged relevant state.
 */
export function isDeterministicInvalidityFailure(failureCode: string | null | undefined): boolean {
  return (
    failureCode === 'target_gone' ||
    failureCode === 'protected_station' ||
    failureCode === 'live_structure_member' ||
    failureCode === 'tunnel_entry_refused'
  )
}

export interface ActionOutcomeTaxonomyInput extends ActionOutcomeInput {
  arrived?: boolean
  distanceClosed?: boolean
  /** reached a bounded search waypoint without acquiring the semantic target */
  searchArrived?: boolean
  /** The controller may mark a verified goal-predicate change after re-sensing. */
  semanticProgress?: boolean
  semanticAbandon?: boolean
  /**
   * The settled candidate is an UNGROUNDED descent - the stranded-column
   * escape step (`meta.columnDescent`), which names no search anchor: no focus
   * item, no `descend_to` predicate, no sensed/tunnel target. Its verified
   * step is body motion only; crediting `search` laundered 88 pocket digs
   * into semantic progress (portal-p24 gen-muul1u2o: `explore:cave`/
   * `explore:surface` ratcheted y12 -> y-60 while every leg reset the
   * no-progress bounds). A grounded `descendCandidates` leg (focus /
   * `descend_to` / tunnel target / food route) keeps its `search` claim.
   */
  ungroundedDescent?: boolean
}

/**
 * Classify one settled action without collapsing physical, search, and semantic
 * progress.  This is descriptive evidence only; it does not select a next
 * action or grant System2 authority.
 */
export function classifyActionOutcome(input: ActionOutcomeTaxonomyInput): ActionOutcomeTaxonomy {
  const control = input.kind === 'ESCALATE' ? 'escalate' : input.kind === 'WAIT' ? 'wait' : 'none'
  const execution: ExecutionOutcome =
    control !== 'none'
      ? 'control'
      : input.status === 'cancelled' || input.status === 'canceled'
        ? 'cancelled'
        : input.status === 'failed'
          ? 'failure'
          : 'success'
  const verification: VerificationOutcome =
    input.kind === 'WAIT' || input.kind === 'ESCALATE'
      ? 'not_applicable'
      : input.verified
        ? 'verified'
        : 'unverified'
  const semantic = input.semanticAbandon === true ? 'abandon' : input.semanticProgress === true ? 'goal' : 'none'
  const kinds: ProgressKind[] = []
  if (semantic === 'goal') kinds.push('goal')
  const body =
    input.progressed === true ||
    input.arrived === true ||
    (input.kind === 'RETRIEVE' && input.distanceClosed === true)
  const search =
    input.entityDefeated === true ||
    input.damageObserved === true ||
    (input.blockRemoved === true && input.ungroundedDescent !== true) ||
    (input.kind === 'DESCEND' && input.progressed === true && input.ungroundedDescent !== true) ||
    (input.kind === 'RETRIEVE' &&
      (input.progressed === true || input.distanceClosed === true || input.searchArrived === true))
  if (body) kinds.push('body')
  if (search) kinds.push('search')
  if (kinds.length === 0) kinds.push('none')
  const progress = kinds.includes('goal') ? 'goal' : kinds.includes('search') ? 'search' : kinds.includes('body') ? 'body' : 'none'
  const invalidity =
    execution === 'failure' && isDeterministicInvalidityFailure(input.failureCode) ? 'deterministic' : 'none'
  return { execution, verification, progress, progressKinds: kinds, control, invalidity, semantic }
}

/** Everything a strict SMELT post-condition needs to know about one run. */
export interface SmeltPostconditionEvidence {
  /** output items the run added to the inventory (0 when nothing landed) */
  gained: number
  /** input items the run moved out of the inventory into the furnace */
  placedInput: number
  /** fuel items the run moved out of the inventory into the furnace */
  placedFuel: number
  /** the furnace input slot no longer holds the full placed stack */
  consumedInput: boolean
  /** the furnace fuel slot no longer holds the full placed stack */
  consumedFuel: boolean
}

/**
 * #79 STRICT smelt post-condition. A smelt is verified only with world evidence:
 * the output item count increased, OR the furnace actually consumed the placed
 * input+fuel (the burn progressed even though no output landed in the inventory
 * yet). Placing items into the furnace is not enough - a run that moved items in
 * and then produced/consumed nothing is unverified, never `done`.
 */
export function isSmeltPostconditionMet(evidence: SmeltPostconditionEvidence): boolean {
  if (evidence.gained > 0) return true
  return evidence.placedInput > 0 && evidence.consumedInput && evidence.placedFuel > 0 && evidence.consumedFuel
}

/**
 * #79 STRICT place post-condition. A placement is verified only when the wanted
 * block exists at the target right now; a null/different block is unverified.
 */
export function isPlacePostconditionMet(blockNameAtTarget: string | null, itemName: string): boolean {
  return blockNameAtTarget === itemName
}

/**
 * #79 STRICT ignition post-condition. A nether portal is lit only when the
 * `nether_portal` block exists at EVERY expected interior cell; a single air
 * cell means the frame was not lit and the action is unverified.
 */
export function isIgnitePostconditionMet(
  blockNamesAtCells: readonly (string | null)[],
  itemName: string = 'nether_portal',
): boolean {
  return blockNamesAtCells.length > 0 && blockNamesAtCells.every((name) => isPlacePostconditionMet(name, itemName))
}

/** Everything a strict MINE post-condition needs to distinguish a collect from a pure dig. */
export interface MinePostconditionEvidence {
  /** true when the active goal must end with the drop in the inventory (a collect goal) */
  requiresPickup: boolean
  /** the target block is gone */
  blockRemoved: boolean
  /** a dropped-item entity for this yield was observed in the world */
  dropObserved: boolean
  /** the yield item count increased */
  itemsGained: number
}

/**
 * #79 STRICT MINE post-condition. A pure dig (`requiresPickup=false`, a headroom
 * clearance cut or a non-collect goal) is verified by the block being gone: its
 * drop may be legitimately transformed or lost. A collect MINE
 * (`requiresPickup=true`) is verified only when the drop actually landed in the
 * inventory - a removed block plus an observed-but-uncollected drop is not
 * acquisition.
 */
export function isMinePostconditionMet(evidence: MinePostconditionEvidence): boolean {
  if (!evidence.blockRemoved) return false
  if (evidence.requiresPickup) return evidence.itemsGained > 0
  return true
}

/** A goal-directed mob hunt is mechanically complete only on the server death event. */
export function isMobHuntPostconditionMet(entityDefeated: boolean): boolean {
  return entityDefeated
}

/**
 * The per-action post-condition the executor is checking, in words, so the
 * ACTION_UNVERIFIED line names what was expected (issue #79 acceptance).
 */
export function describeActionPostcondition(kind: string): string {
  switch (kind) {
    case 'SMELT':
      return 'target item count increased OR (furnace block at target AND input+fuel consumed)'
    case 'CONTAINER':
      return 'the container was OPENED and its live window contents observed (an inspect verifies on the observation itself; a withdraw additionally requires the inventory count of the selected item to rise by the taken amount, and a container observed EMPTY is a typed empty result, never a silent success)'
    case 'PLACE':
      return 'block exists at the target'
    case 'IGNITE':
      return 'the nether_portal block exists at every expected portal cell after flint_and_steel activation'
    case 'ENTER_PORTAL':
      return "the bot's own dimension equals the target dimension after walking into the lit portal"
    case 'CRAFT':
      return 'output item count increased'
    case 'MINE':
      return 'target block removed AND (for a collect goal the drop acquired: itemsGained > 0; a pure dig is complete on removal)'
    case 'RETRIEVE':
      return 'remembered resource reached (remaining distance to the target decreased) or item count increased'
    case 'PICKUP':
      return 'the dropped item entity reached the inventory (itemsGained > 0); standing next to an uncollected drop is NOT acquisition'
    case 'DESCEND':
      return 'target block removed and the descend step is reachable'
    case 'STEP':
      return 'the face block was removed'
    case 'EQUIP':
      return 'the armor piece is worn in its slot (the live armor slot names it)'
    case 'ATTACK':
      return 'a server-observed hit on the target attributable to this lease (`entityHurt` / damage with this body as the cause, or the target dying during the lease); a `goalDrop` hunt additionally requires the server entityDead event'
    case 'ESCALATE':
      return 'control-plane hand-off to System 2 (no physical post-condition)'
    case 'WAIT':
      return 'control wait elapsed (not goal progress)'
    default:
      return 'action produced a verified change'
  }
}

/**
 * Observable progress: an item gained, a block removed, a deterministic body
 * change (a verified climb chunk that gained altitude), a server-confirmed
 * entity death, or a server-observed damage event on the action's target
 * (#391: a connected ATTACK is real world evidence even without a kill).
 * `progressed`, `entityDefeated` and `damageObserved` are evidence of change
 * only - they never make an unverified action verified on their own.
 */
export function hasObservableProgress(
  input: Pick<ActionOutcomeInput, 'itemsGained' | 'blockRemoved' | 'progressed' | 'entityDefeated' | 'damageObserved'>,
): boolean {
  return (
    input.itemsGained > 0 ||
    input.blockRemoved === true ||
    input.progressed === true ||
    input.entityDefeated === true ||
    input.damageObserved === true
  )
}

/** Zero observable change: no item/block/body/entity change was proven. */
export function isZeroProgressOutcome(
  input: Pick<ActionOutcomeInput, 'itemsGained' | 'blockRemoved' | 'progressed' | 'entityDefeated' | 'damageObserved'>,
): boolean {
  return !hasObservableProgress(input)
}

/**
 * A collect action (a MINE whose drop must land in the inventory) is not
 * complete until `itemsGained > 0`. `blockRemoved` / `dropObserved` prove the
 * dig happened, never that the drop was acquired.
 */
export function isCollectAcquisitionUnmet(
  input: Pick<ActionOutcomeInput, 'kind' | 'itemsGained' | 'requiresPickup'>,
): boolean {
  return input.kind === 'MINE' && input.requiresPickup === true && input.itemsGained <= 0
}

/**
 * True when a `done` action must be reclassified as FAILURE: its post-condition
 * was unmet (`verified=false`) and it produced no observable change.
 */
export function isUnverifiedOutcome(input: ActionOutcomeInput): boolean {
  if (input.kind === 'WAIT' || input.kind === 'ESCALATE') return false
  return input.status === 'done' && !input.verified && isZeroProgressOutcome(input)
}

/**
 * Kinds whose executor `verified=true` is accepted as a truthful success on its
 * own: the executor gates each of them on a STRICT world post-condition that is
 * itself observable evidence (a dug block/drop, an increased item count, a block
 * existing at the target, a removed face block, or the action's own defined
 * effect). Every other kind is a lenient-movement kind, whose `verified` flag can
 * be set by a partial signal (a >0.01 m distance decrease) without the remembered
 * target ever being reached - see `truthfulActionOutcome`.
 *
 * ATTACK is deliberately NOT here (#391): the executor used to set
 * `verified=true` after issuing swings, so a lease that never damaged anything
 * was recorded as a strict success. Its evidence now travels as
 * `damageObserved` (an attributable `entityHurt`, or the target dying during
 * the lease) and is accepted through `hasObservableProgress`, never through the
 * executor's flag.
 */
const SELF_EVIDENT_VERIFIED_KINDS: ReadonlySet<string> = new Set([
  'MINE',
  'CRAFT',
  'SMELT',
  'PLACE',
  'IGNITE',
  'ENTER_PORTAL',
  'DESCEND',
  'STEP',
  'EAT',
  'EQUIP',
])

/**
 * Kinds whose post-condition IS arrival, so a live arrival is observable
 * progress. RETRIEVE is deliberately NOT here: the controller only counts a
 * retrieved resource as progress on an item / removed block / body change
 * (`knownRetrieveMadeProgress`, `shouldClearActiveRetrieval`), and arrival alone
 * must not clear the retrieval-stall track or retire the active target.
 */
const ARRIVAL_EVIDENCE_KINDS: ReadonlySet<string> = new Set(['MOVE', 'RETREAT'])

export interface TruthfulOutcomeInput {
  kind: string
  status: string
  verified: boolean
  itemsGained: number
  blockRemoved: boolean
  /** deterministic body change with no item/block evidence (a climb chunk) */
  progressed?: boolean
  /** server `entityDead` event proved that an ATTACK target died during this action */
  entityDefeated?: boolean
  /**
   * #391: the ATTACK lease observed server-side damage on its target (an
   * `entityHurt` attributable to this lease). This is the hit evidence a
   * non-hunt ATTACK succeeds on; a kill is not required.
   */
  damageObserved?: boolean
  /**
   * Live movement arrival from the controller (`classifyMoveOutcome`). Only
   * counted for the kinds whose post-condition is arrival; never inferred from
   * the executor's lenient `verified` flag.
   */
  arrived?: boolean
  /**
   * RETRIEVE completion evidence: the executor measured that the remaining
   * feet-distance to the remembered target actually shrank. A vertical chunk
   * step (`progressed`) can never set this.
   */
  distanceClosed?: boolean
  /**
   * A surface RETRIEVE reached its search waypoint. This verifies a local
   * search observation, not acquisition of the semantic resource, so it must
   * produce search progress without completing/resetting the resource route.
   */
  searchArrived?: boolean
  /**
   * The candidate is a collect action: its MINE is complete only once the drop
   * is in the inventory (`itemsGained > 0`). A pure dig (clearance / non-collect
   * goal) leaves this false and stays valid on `blockRemoved` alone.
   */
  requiresPickup?: boolean
}

export interface TruthfulOutcome {
  /** the verified flag a truthful record may carry */
  verified: boolean
  /** the status a truthful record may carry (`zero_progress` / `unreached` when a claim is rejected) */
  status: string
  /** true when this action left observable evidence of a world/body change */
  observableProgress: boolean
  /** true when the raw executor claimed `done`+`verified` but the truth layer rejects it */
  downgraded: boolean
  /** true only when this outcome completed; the sole gate for a MOVE_FAILMEM reset */
  resetsFailureMemory: boolean
  /** true when a bounded body change happened without completion (replan, never reset) */
  replanProgress: boolean
}

/**
 * Truthful success/failure for ANY action. A `done` action may only be recorded
 * as `verified=true status=done` when there is observable progress: an item
 * gained, a block removed, a deterministic body change (`progressed`), a live
 * arrival, or a strict-post-condition kind whose `verified` IS the world
 * evidence. The live defect this closes (run-mu8l9a1j-uugz):
 *
 *   `RETRIEVE:known:raw_iron:b36_56_41 timeout` ... `PATH_CALLBACK outcome=stuck`
 *   ... `CAUSAL verified=true status=done progressDelta=0`
 *
 * A RETRIEVE is special: `progressed` (a bounded vertical chunk) is durable
 * body evidence but NOT completion, so a retrieve is a truthful success only on
 * arrival, a measured distance closure, or concrete item/block evidence.
 * Everything else is `unreached` (bounded progress, never resets the failure
 * memory) or `zero_progress` (nothing changed at all).
 *
 * ATTACK is evidence-gated the same way (#391): the executor `verified` flag is
 * no longer self-evident, so a lease with no server-observed damage is
 * `zero_progress` here even if the raw result claimed `done`/`verified=true`.
 */
export function truthfulActionOutcome(input: TruthfulOutcomeInput): TruthfulOutcome {
  // WAIT and ESCALATE are control-plane outcomes.  Preserve their completion
  // for scheduling, but never present them as verified physical progress or as
  // mechanical failures.
  if (input.kind === 'WAIT') {
    return {
      verified: false,
      status: input.status === 'failed' ? input.status : 'waited',
      observableProgress: false,
      downgraded: false,
      resetsFailureMemory: false,
      replanProgress: false,
    }
  }
  if (input.kind === 'ESCALATE') {
    return {
      verified: false,
      status: input.status === 'failed' ? input.status : 'control_transfer',
      observableProgress: false,
      downgraded: false,
      resetsFailureMemory: false,
      replanProgress: false,
    }
  }
  const itemOrBlock = input.itemsGained > 0 || input.blockRemoved === true
  const bodyProgress = input.progressed === true
  if (input.kind === 'RETRIEVE') {
    const claimed = input.status === 'done'
    if (claimed && input.searchArrived === true) {
      return {
        verified: true,
        status: 'done',
        observableProgress: true,
        downgraded: false,
        resetsFailureMemory: false,
        replanProgress: true,
      }
    }
    const completed = claimed && input.verified && (input.arrived === true || input.distanceClosed === true || itemOrBlock)
    if (completed) {
      return {
        verified: true,
        status: 'done',
        observableProgress: true,
        downgraded: false,
        resetsFailureMemory: true,
        replanProgress: false,
      }
    }
    const replanProgress = bodyProgress || itemOrBlock
    if (replanProgress) {
      return {
        verified: false,
        status: 'unreached',
        observableProgress: false,
        downgraded: claimed && input.verified,
        resetsFailureMemory: false,
        replanProgress: true,
      }
    }
    if (claimed && input.verified) {
      return {
        verified: false,
        status: 'zero_progress',
        observableProgress: false,
        downgraded: true,
        resetsFailureMemory: false,
        replanProgress: false,
      }
    }
    return {
      verified: false,
      status: input.status,
      observableProgress: false,
      downgraded: false,
      resetsFailureMemory: false,
      replanProgress: false,
    }
  }
  const directProgress =
    hasObservableProgress(input) || (input.arrived === true && ARRIVAL_EVIDENCE_KINDS.has(input.kind))
  if (input.status !== 'done' || !input.verified) {
    return {
      verified: input.verified,
      status: input.status,
      observableProgress: directProgress,
      downgraded: false,
      resetsFailureMemory: false,
      replanProgress: !input.verified && directProgress,
    }
  }
  // A collect MINE whose drop did not land in the inventory is not a completed
  // collect, however clearly the dig is proven.
  if (isCollectAcquisitionUnmet(input)) {
    return {
      verified: false,
      status: 'zero_progress',
      observableProgress: directProgress,
      downgraded: true,
      resetsFailureMemory: false,
      replanProgress: directProgress,
    }
  }
  // A DESCEND step is successful only when the step changed the world/body.
  // The old `SELF_EVIDENT_VERIFIED_KINDS` rule treated an executor `verified`
  // flag as enough and produced `DESCEND done/0` while Y was changing in the
  // live run.  Keep the step descriptive and fail closed when no evidence is
  // present; body/search progress with `blockRemoved` or `progressed` remains
  // visible through the taxonomy.
  if (input.kind === 'DESCEND' && !directProgress) {
    return {
      verified: false,
      status: 'zero_progress',
      observableProgress: false,
      downgraded: true,
      resetsFailureMemory: false,
      replanProgress: false,
    }
  }
  // A strict-post-condition kind already proved a world change; its `verified`
  // flag is the evidence. Nothing else may be promoted to success on a lenient
  // movement signal alone.
  if (directProgress || SELF_EVIDENT_VERIFIED_KINDS.has(input.kind)) {
    return {
      verified: true,
      status: 'done',
      observableProgress: true,
      downgraded: false,
      resetsFailureMemory: true,
      replanProgress: false,
    }
  }
  return {
    verified: false,
    status: 'zero_progress',
    observableProgress: false,
    downgraded: true,
    resetsFailureMemory: false,
    replanProgress: false,
  }
}

export interface ActionUnverifiedFields {
  planId: string | null
  actionId: string | null
  strategy: string | null
  /** per-plan unverified attempt count INCLUDING this one, when the caller knows it */
  attempts?: number | null
  postcondition: string
}

/** Exact log line: `ACTION_UNVERIFIED planId=... actionId=... strategy=... [attempts=N] postcondition=...`. */
export function formatActionUnverified(fields: ActionUnverifiedFields): string {
  const attempts =
    fields.attempts === undefined || fields.attempts === null ? '' : ` attempts=${fields.attempts}`
  return (
    `ACTION_UNVERIFIED planId=${fields.planId ?? 'null'} actionId=${fields.actionId ?? 'null'} ` +
    `strategy=${fields.strategy ?? 'null'}${attempts} postcondition=${fields.postcondition}`
  )
}

export type ActionOutcomeVerdict = 'verified' | 'unverified' | 'failed' | 'cancelled' | 'inconclusive'

export interface ActionOutcomeDecision {
  verdict: ActionOutcomeVerdict
  /** true only when this result may advance the ladder/rung */
  advances: boolean
  postcondition: string
  /** the ACTION_UNVERIFIED line, or null when this is not an unverified outcome */
  unverifiedLine: string | null
}

/**
 * The one place that decides whether an executor result counts as progress.
 * `advances` is false for everything except a `done` + `verified` action, so the
 * ladder can never advance on an unverified action (#79).
 */
export function decideActionOutcome(input: ActionOutcomeInput): ActionOutcomeDecision {
  const postcondition = describeActionPostcondition(input.kind)
  if (input.status === 'cancelled') {
    return { verdict: 'cancelled', advances: false, postcondition, unverifiedLine: null }
  }
  if (input.status === 'failed') {
    return { verdict: 'failed', advances: false, postcondition, unverifiedLine: null }
  }
  if (input.status === 'done' && input.verified) {
    if (isCollectAcquisitionUnmet(input)) {
      return {
        verdict: 'unverified',
        advances: false,
        postcondition,
        unverifiedLine: formatActionUnverified({
          planId: input.planId ?? null,
          actionId: input.actionId ?? null,
          strategy: input.strategy ?? null,
          attempts: input.attempts ?? null,
          postcondition,
        }),
      }
    }
    return { verdict: 'verified', advances: true, postcondition, unverifiedLine: null }
  }
  if (isUnverifiedOutcome(input)) {
    return {
      verdict: 'unverified',
      advances: false,
      postcondition,
      unverifiedLine: formatActionUnverified({
        planId: input.planId ?? null,
        actionId: input.actionId ?? null,
        strategy: input.strategy ?? null,
        attempts: input.attempts ?? null,
        postcondition,
      }),
    }
  }
  return { verdict: 'inconclusive', advances: false, postcondition, unverifiedLine: null }
}

export interface UnverifiedBudgetInput {
  /** attempts recorded so far for this planId, INCLUDING the current one */
  attempts: number
  limit: number
  planId: string
  strategy: string | null
}

export interface UnverifiedBudgetDecision {
  attempts: number
  /** true once the same planId+strategy must not be retried again */
  abandon: boolean
  /** the ABANDON_REASON line when abandoning, else null */
  line: string | null
}

/** Deterministic abandon budget: the same strategy is not retried forever. */
export function evaluateUnverifiedBudget(input: UnverifiedBudgetInput): UnverifiedBudgetDecision {
  const limit = Math.max(1, Math.floor(input.limit))
  const attempts = Math.max(1, Math.floor(input.attempts))
  const abandon = attempts >= limit
  return {
    attempts,
    abandon,
    line: abandon
      ? `ABANDON_REASON=action_unverified planId=${input.planId} attempts=${attempts} strategy=${input.strategy ?? 'null'}`
      : null,
  }
}
