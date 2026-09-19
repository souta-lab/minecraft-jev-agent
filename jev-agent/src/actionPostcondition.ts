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
  /** local plan revision (GoalQueue row id), when the caller knows it */
  planId?: string | null
  /** executor action id, when the caller knows it */
  actionId?: string | null
  /** high-level strategy label (`llm:smelt`, ...), when known */
  strategy?: string | null
  /** unverified attempts recorded for this planId INCLUDING this one, when known */
  attempts?: number | null
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
 * The per-action post-condition the executor is checking, in words, so the
 * ACTION_UNVERIFIED line names what was expected (issue #79 acceptance).
 */
export function describeActionPostcondition(kind: string): string {
  switch (kind) {
    case 'SMELT':
      return 'target item count increased OR (furnace block at target AND input+fuel consumed)'
    case 'PLACE':
      return 'block exists at the target'
    case 'CRAFT':
      return 'output item count increased'
    case 'MINE':
      return 'target block removed AND (drop collected OR observed)'
    case 'RETRIEVE':
      return 'remembered resource reached (distance closed / staircase step) or item count increased'
    case 'DESCEND':
      return 'target block removed and the descend step is reachable'
    case 'STEP':
      return 'the face block was removed'
    case 'ESCALATE':
      return 'System 2 accepted the hand-off (no world effect expected)'
    case 'WAIT':
      return 'a bounded wait elapsed'
    default:
      return 'action produced a verified change'
  }
}

/**
 * Observable progress: an item gained, a block removed, or a deterministic
 * body change (a verified climb chunk that gained altitude). `progressed` is
 * evidence of change only - it never makes an unverified action verified.
 */
export function hasObservableProgress(
  input: Pick<ActionOutcomeInput, 'itemsGained' | 'blockRemoved' | 'progressed'>,
): boolean {
  return input.itemsGained > 0 || input.blockRemoved === true || input.progressed === true
}

/** Zero observable change: nothing was gained, no block was removed, no body change proven. */
export function isZeroProgressOutcome(
  input: Pick<ActionOutcomeInput, 'itemsGained' | 'blockRemoved' | 'progressed'>,
): boolean {
  return !hasObservableProgress(input)
}

/**
 * True when a `done` action must be reclassified as FAILURE: its post-condition
 * was unmet (`verified=false`) and it produced no observable change.
 */
export function isUnverifiedOutcome(input: ActionOutcomeInput): boolean {
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
 */
const SELF_EVIDENT_VERIFIED_KINDS: ReadonlySet<string> = new Set([
  'MINE',
  'CRAFT',
  'SMELT',
  'PLACE',
  'DESCEND',
  'STEP',
  'EAT',
  'ATTACK',
  'WAIT',
  'ESCALATE',
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
  /**
   * Live movement arrival from the controller (`classifyMoveOutcome`). Only
   * counted for the kinds whose post-condition is arrival; never inferred from
   * the executor's lenient `verified` flag.
   */
  arrived?: boolean
}

export interface TruthfulOutcome {
  /** the verified flag a truthful record may carry */
  verified: boolean
  /** the status a truthful record may carry (`zero_progress` when a claimed success is rejected) */
  status: string
  /** true when this action left observable evidence of a world/body change */
  observableProgress: boolean
  /** true when the raw executor claimed `done`+`verified` but the truth layer rejects it */
  downgraded: boolean
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
 * The executor's RETRIEVE sets `verified=true` from a lenient `closed` signal, so
 * a stuck hop toward an unreachable remembered resource was recorded as a
 * verified success with zero observable progress. Zero-observable-progress
 * outcomes are failures that keep the failure memory charged; they are never
 * reset by this gate.
 */
export function truthfulActionOutcome(input: TruthfulOutcomeInput): TruthfulOutcome {
  const directProgress =
    hasObservableProgress(input) || (input.arrived === true && ARRIVAL_EVIDENCE_KINDS.has(input.kind))
  if (input.status !== 'done' || !input.verified) {
    return { verified: input.verified, status: input.status, observableProgress: directProgress, downgraded: false }
  }
  // A strict-post-condition kind already proved a world change; its `verified`
  // flag is the evidence. Nothing else may be promoted to success on a lenient
  // movement signal alone.
  if (directProgress || SELF_EVIDENT_VERIFIED_KINDS.has(input.kind)) {
    return { verified: true, status: 'done', observableProgress: true, downgraded: false }
  }
  return { verified: false, status: 'zero_progress', observableProgress: false, downgraded: true }
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
