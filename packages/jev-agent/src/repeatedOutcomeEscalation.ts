// repeatedOutcomeEscalation.ts - the CROSS-action bound on one action's own
// bounded outcome repeating identically at the same target.
//
// THE MEASURED CLASS (live `m3-live` record, 1.34M lines, read-only):
//
//   ASCEND:habitat:p3_68_22  184 typed failures / 161 attempts, 24m38s, ONE cell.
//   PILLAR_FAIL step=apex reason=apex_missed 160, step=place reason=refused 23,
//   step=apex reason=apex_timeout 1 - interleaved with PILLAR_UP_STEP successes.
//   ACTION_FAILURE_REPEAT=0, ACTION_FAILURE_EXHAUSTED=0, LOCAL_RECOVERY_EXHAUSTED=0,
//   LOCAL_OSCILLATION_BOUNDARY=0, PLACE_RETRIES_EXHAUSTED=1, PILLAR_RETIRE=0,
//   PILLAR_RELOCATE=0. No cross-action escalation was ever emitted.
//
// Two EXISTING facts were computed and then erased before they could accumulate:
//
//   1. `controller.ts` resets the typed-action-failure streak on
//      `progressKinds` containing `body`. A pillar STEP that rises and falls back
//      reports `CAUSAL ... status=done progress=body`, so the identical
//      `apex_missed` failure was charged as count=1 every time.
//   2. The durable coordinate failure memory (`moveFailMemory`) is reset by
//      `recordMoveSuccess` on the same body-motion success, so its `attempts`
//      restarted at 1 (34 `MOVE_FAILMEM_RESET` at that one key).
//
// Body motion within a failing action's own bounded attempt cycle is NOT a new
// fact about whether the action is grounded at that cell. Per `buddy-driver/AGENTS.md`
// section 5, movement "may be progress" - it is never completion and never proof
// that a target's grounding facts changed.
//
// WHAT THIS MODULE OWNS: the conjunction nobody owned. Given
//   (action shape, target cell, typed outcome)
// repeated with an UNCHANGED grounding fact signature, the action is mechanically
// not grounded here and its standing is reduced: the target is retired for that
// action shape, which forces the offer onto a different target (a bounded
// relocation) without choosing the replacement WHAT.
//
// AUTHORITY: this is code-owned mechanical invalidity, exactly like the
// coordinate failure memory's blacklist - it removes a target proven unable to
// progress, and it never ranks or substitutes a semantic alternative. Jev pi
// still picks WHICH among what remains.
//
// GENERICITY: nothing here names a pillar, an ascent, a milestone or a
// coordinate. Any action whose outcome is typed and repeatable participates.
//
// RESET: any change to the grounding fact signature restarts the streak AND
// lifts the retirement, because a changed fact is exactly the evidence that the
// mechanical invalidity no longer holds.

import { moveFailureKey } from './moveFailMemory.ts'
import type { Vec3Like } from './moveFailMemory.ts'

/**
 * THE BOUND. Stated once, here, and consumed by the controller and the
 * fixtures - never re-derived at a call site. `BUDDY_REPEATED_OUTCOME_LIMIT`
 * overrides it.
 *
 * 6 is the same bounded-escalation shape as the sibling counters this module
 * replaces for this question (`ACTION_FAILURE_ESCALATE_CYCLES_DEFAULT`,
 * `REPLAN_NO_INFO_ESCALATE_CYCLES_DEFAULT`, `WAIT_STREAK_ESCALATE_CYCLES_DEFAULT`
 * are all 6): enough consecutive identical mechanically-failed attempts that
 * chance is excluded, small enough that a 24-minute runaway becomes ~6 tries.
 */
export const REPEATED_OUTCOME_LIMIT_DEFAULT = 6

/** `BUDDY_REPEATED_OUTCOME_LIMIT` overrides N; invalid values fall back to the pinned bound. */
export function resolveRepeatedOutcomeLimit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_REPEATED_OUTCOME_LIMIT ?? REPEATED_OUTCOME_LIMIT_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : REPEATED_OUTCOME_LIMIT_DEFAULT
}

/** Hard cap on tracked (shape, cell) streaks; oldest evicted first. */
export const REPEATED_OUTCOME_MAX_ENTRIES_DEFAULT = 256

/** Per-attempt counter line: proof the same action+cell+outcome is being re-offered. */
export const ACTION_REPEAT_MARKER = 'ACTION_REPEAT'
/** Escalation line: N identical outcomes exhausted the action's standing at this cell. */
export const ACTION_REPEAT_EXHAUSTED_MARKER = 'ACTION_REPEAT_EXHAUSTED'
/** The consequence: the retired (shape, cell) is no longer offered. */
export const ACTION_TARGET_RETIRED_MARKER = 'ACTION_TARGET_RETIRED'

/**
 * Candidate kinds that are not "an action whose outcome is typed and
 * repeatable": WAIT/ESCALATE are control outcomes with their own bounded
 * machinery (`WAIT_EXHAUSTED`), and counting them here would make this counter
 * a second owner of the same question.
 */
const CONTROL_KINDS = new Set(['WAIT', 'ESCALATE'])

export function isRepeatTrackedKind(kind: string): boolean {
  return !CONTROL_KINDS.has(kind)
}

/**
 * The action SHAPE: an action id with its numeric/coordinate suffixes collapsed
 * to `*`. Two ids that differ only by the coordinate they encode are the same
 * action at a different place, and the place is the key's other half:
 *
 *   `ASCEND:habitat:p3_68_22` -> `ASCEND:habitat:p*`
 *   `MOVE:p-7_69_-7`          -> `MOVE:p*`
 *   `PLACE:obsidian:build:4@p26_66_9` -> `PLACE:obsidian:build:*@p*`
 *
 * Collapsing is what makes the ledger immune to a candidate that re-encodes the
 * same target with a different ordinal (`#1#1` -> `#2#2`), which is how the
 * measured runaway kept looking like a fresh action.
 */
export function actionShapeOf(actionId: string): string {
  // One maximal digit/separator run becomes ONE `*`, so an encoded coordinate
  // collapses as a unit: `p3_68_22` -> `p*`, not `p*_*_*`. A run must start with
  // a digit so a leading `-` belongs to it (`p-7_69_-7` -> `p*`).
  return actionId.replace(/-?\d[\d_-]*/g, '*')
}

/**
 * The CELL half of the key. Reuses the sibling failure memory's canonical
 * dimension-scoped block-cell convention (`<dimension>:<x>,<y>,<z>`) rather than
 * re-deriving one, so a target the two planes agree on produces the same key.
 *
 * A targetless action is tracked at the body's own cell: "same target" for an
 * action with no target is the cell the body did not leave.
 */
export function repeatedOutcomeCell(
  dimension: string,
  target: Vec3Like | null,
  bodyPosition: Vec3Like,
): string {
  return moveFailureKey(dimension, target ?? bodyPosition)
}

/** Stable identity of one (action shape, target cell) streak. */
export function repeatedOutcomeKey(actionShape: string, cell: string): string {
  return `${actionShape}@${cell}`
}

/**
 * The typed outcome token, for evidence. Deliberately excludes `progressKinds`:
 * a token that moved with the body would launder the streak, which is the
 * measured defect. The token says only WHAT the action's bounded execution
 * concluded.
 */
export function repeatedOutcomeToken(input: {
  failure: string | null
  status: string
  verified: boolean
}): string {
  if (input.failure !== null && input.failure.length > 0) return `failure:${input.failure}`
  return `status:${input.status}:${input.verified ? 'verified' : 'unverified'}`
}

/**
 * Did this outcome carry SEMANTIC progress?
 *
 * `goal` and `search` are the decision taxonomy's semantic progress kinds;
 * `body` is mechanical motion and is deliberately NOT one. This is the repo's
 * own doctrine, not a new rule: `strategicStall.ts` keeps its window open across
 * body progress ("a successful MOVE is not semantic progress"), and
 * `buddy-driver/AGENTS.md` section 5 requires that "mechanical movement / distance
 * closure -> may be progress" never be read as completion.
 *
 * It matters because of the measured shape. At `ASCEND:habitat:p3_68_22` the
 * settled outcomes strictly ALTERNATED `failed/unverified/none` (184) with
 * `done/verified/body` (200) for 24m38s, and BOTH carried `progressDelta=0`: the
 * `done` is the rise half of the same attempt whose placement the server refused.
 * Neither half changes any fact about whether the action is grounded at that
 * cell, so neither half is new information.
 */
export function repeatedOutcomeSemanticProgress(input: {
  progressKinds: readonly string[]
  itemsGained: number
  blockRemoved: boolean
}): boolean {
  return (
    input.progressKinds.some((kind) => kind === 'goal' || kind === 'search') ||
    input.itemsGained > 0 ||
    input.blockRemoved
  )
}

/**
 * The "no observable state change" signature.
 *
 * It is built from the affordance plane's OWN fingerprint
 * (`reachability.ts#reachabilityFingerprint`), which already states the contract
 * this module needs: it covers the facts that could re-open a target (cell,
 * verdict, missing capabilities, coarse vertical-gap bucket, placeable block,
 * every missing tool family, hazard, approach, headroom, footing) and it
 * deliberately EXCLUDES wall clock and fine body position, "so a 1-block shuffle
 * does not reset the proof".
 *
 * Reusing that fingerprint - rather than re-deriving a second state digest - is
 * the point: the affordance plane already computes this fact for every grounded
 * candidate on every tick, and for every candidate that PASSES the gate it was
 * discarded. A candidate the gate did not withhold is one whose grounding facts
 * did not change; nothing acted on the conjunction of that with a repeated
 * identical outcome.
 *
 * `planIdentity` and `worldKey` are added because the same action at the same
 * cell under a different objective or in a different world is a different
 * question. The signature never contains the body position or a timestamp.
 */
export function repeatedOutcomeFactSignature(input: {
  affordanceFingerprint: string
  planIdentity: string | null
  worldKey: string
}): string {
  return [input.affordanceFingerprint, `plan=${input.planIdentity ?? 'none'}`, `world=${input.worldKey}`].join('|')
}

/**
 * The durable record. Plain JSON data only: it is written into the class-A
 * world memory and re-seeded into every later generation, so a hot reload
 * cannot launder the streak by resetting a controller-scoped counter - the
 * measured `ACTION_FAILURE_REPEAT` counter lived only in the generation.
 */
export interface RepeatedOutcomeEntryJson {
  /** `${actionShape}@${cell}` */
  key: string
  actionShape: string
  /** dimension-scoped block cell (`<dimension>:<x>,<y>,<z>`) */
  cell: string
  /** typed outcome token, `repeatedOutcomeToken(...)` */
  outcome: string
  /** typed failure code when the last outcome was a failure, else null */
  failureCode: string | null
  /** consecutive attempts (settled outcomes) at this target with no state change */
  count: number
  firstAt: number
  lastAt: number
  /** the grounding fact signature in force at the latest attempt */
  factSignature: string
  /** true once the bound fired: this action is not grounded here while these facts hold */
  retired: boolean
  retiredAt: number | null
}

export interface RepeatedOutcomeObservation {
  actionId: string
  actionShape: string
  cell: string
  /** typed outcome token for the evidence line */
  outcome: string
  /** the typed failure code when this outcome was a failure, else null */
  failureCode: string | null
  /** true when the outcome carried semantic progress (`repeatedOutcomeSemanticProgress`) */
  semanticProgress: boolean
  factSignature: string
  now: number
}

/** Why a streak restarted instead of advancing. */
export type RepeatedOutcomeRestart = 'new_fact' | 'different_outcome'

export interface RepeatedOutcomeDecision {
  key: string
  actionShape: string
  cell: string
  outcome: string
  failureCode: string | null
  count: number
  limit: number
  /** true on exactly the attempt that reaches the bound and retires the target */
  escalate: boolean
  /** true while the target is retired for this action shape */
  retired: boolean
  /** non-null when this observation restarted a streak rather than advancing it */
  restarted: RepeatedOutcomeRestart | null
  /** the ready-to-log typed line: the counter, or the escalation on the bound */
  line: string
}

/** Counter line: the `count`-th consecutive identical outcome for this (shape, cell). */
export function formatActionRepeat(decision: RepeatedOutcomeDecision): string {
  return (
    `${ACTION_REPEAT_MARKER} count=${decision.count}/${decision.limit} ` +
    `shape=${decision.actionShape} cell=${decision.cell} outcome=${decision.outcome} ` +
    `failure=${decision.failureCode ?? 'none'}` +
    (decision.restarted === null ? '' : ` restarted=${decision.restarted}`)
  )
}

/**
 * Escalation line: names the action shape, the cell, the repeated outcome, the
 * count, the bound, and what the escalation DID.
 */
export function formatActionRepeatExhausted(decision: RepeatedOutcomeDecision, actionId: string): string {
  return (
    `${ACTION_REPEAT_EXHAUSTED_MARKER} count=${decision.count}/${decision.limit} ` +
    `action=${actionId} shape=${decision.actionShape} cell=${decision.cell} ` +
    `outcome=${decision.outcome} failure=${decision.failureCode ?? 'none'} ` +
    `bound=${decision.limit} -> retire target for this action`
  )
}

/** The consequence line: the retired (shape, cell) leaves the offered set. */
export function formatActionTargetRetired(input: {
  actionId: string
  actionShape: string
  cell: string
  outcome: string
  count: number
  limit: number
}): string {
  return (
    `${ACTION_TARGET_RETIRED_MARKER} action=${input.actionId} shape=${input.actionShape} ` +
    `cell=${input.cell} outcome=${input.outcome} count=${input.count}/${input.limit} ` +
    `reason=repeated_identical_outcome`
  )
}

/** Rehydrate one durable entry, or null when it is not shaped like one. */
export function restoreRepeatedOutcomeEntry(value: unknown): RepeatedOutcomeEntryJson | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const text = (raw: unknown): string | null =>
    typeof raw === 'string' && raw.length > 0 ? raw : null
  const actionShape = text(source.actionShape)
  const cell = text(source.cell)
  const outcome = text(source.outcome)
  const factSignature = text(source.factSignature)
  if (actionShape === null || cell === null || outcome === null || factSignature === null) return null
  const failureCode = text(source.failureCode)
  const number = (raw: unknown, fallback: number): number =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
  const count = number(source.count, 0)
  const firstAt = number(source.firstAt, 0)
  const lastAt = number(source.lastAt, firstAt)
  const retired = source.retired === true
  return {
    key: repeatedOutcomeKey(actionShape, cell),
    actionShape,
    cell,
    outcome,
    failureCode,
    count,
    firstAt,
    lastAt,
    factSignature,
    retired,
    retiredAt: retired ? number(source.retiredAt, lastAt) : null,
  }
}

export interface RepeatedOutcomeEscalationOptions {
  limit?: number
  maxEntries?: number
  /** entries restored from HOST-owned class-A world memory */
  initialEntries?: readonly unknown[]
}

/**
 * Durable counter for repeated identical typed outcomes at one target.
 *
 * Semantics:
 *   - one entry per `(actionShape, cell)`;
 *   - an observation advances the count when the grounding fact signature is
 *     unchanged, no semantic progress occurred, and the mechanical diagnosis did
 *     not change. A mechanical body-only success and a mechanical failure are the
 *     two halves of one zero-progress attempt at this target, so their
 *     alternation ADVANCES the count instead of restarting it - see the measured
 *     `ASCEND:habitat:p3_68_22` record in `repeatedOutcomeSemanticProgress`;
 *   - semantic progress restarts at 1 (`restarted=new_fact`);
 *   - a different fact signature restarts at 1 AND lifts any retirement
 *     (`restarted=new_fact`) - a changed fact is the evidence that the
 *     mechanical invalidity no longer holds;
 *   - a different failure CODE restarts at 1 (`restarted=different_outcome`):
 *     another mechanical diagnosis is new information;
 *   - on exactly the Nth identical outcome the decision escalates once and the
 *     entry is marked retired; it cannot escalate again without a fresh fact
 *     resetting it, so it cannot hot-loop;
 *   - `isRetired` is the pruning predicate the offer consults.
 *
 * Pure: no clock, no bot, no controller import. `now` is injected.
 */
export class RepeatedOutcomeEscalation {
  private readonly entries = new Map<string, RepeatedOutcomeEntryJson>()
  readonly limit: number
  readonly maxEntries: number

  constructor(options: RepeatedOutcomeEscalationOptions = {}) {
    this.limit = Number.isInteger(options.limit) && (options.limit ?? 0) >= 1
      ? (options.limit as number)
      : REPEATED_OUTCOME_LIMIT_DEFAULT
    this.maxEntries =
      Number.isInteger(options.maxEntries) && (options.maxEntries ?? 0) >= 1
        ? (options.maxEntries as number)
        : REPEATED_OUTCOME_MAX_ENTRIES_DEFAULT
    if (options.initialEntries !== undefined) this.restore(options.initialEntries)
  }

  /** Record one settled outcome and return the bounded decision. */
  note(observation: RepeatedOutcomeObservation): RepeatedOutcomeDecision {
    const key = repeatedOutcomeKey(observation.actionShape, observation.cell)
    const previous = this.entries.get(key)
    let restarted: RepeatedOutcomeRestart | null = null
    let count: number
    let firstAt: number
    let retired = false
    let retiredAt: number | null = null
    let escalate = false

    if (previous === undefined) {
      count = 1
      firstAt = observation.now
    } else if (observation.semanticProgress) {
      // Semantic progress: the objective or the world actually advanced.
      restarted = 'new_fact'
      count = 1
      firstAt = observation.now
    } else if (previous.factSignature !== observation.factSignature) {
      // A changed grounding fact: the streak restarts and the retirement lifts.
      restarted = 'new_fact'
      count = 1
      firstAt = observation.now
    } else if (
      previous.failureCode !== null &&
      observation.failureCode !== null &&
      previous.failureCode !== observation.failureCode
    ) {
      // A DIFFERENT mechanical diagnosis is new information: the action is
      // failing for another reason here, so it has not been proven unable to
      // work - only unable to work one particular way.
      restarted = 'different_outcome'
      count = 1
      firstAt = observation.now
    } else {
      // Same target, same grounding facts, no semantic progress. Whether this
      // settle is the mechanical rise half or the refusal half of the same
      // attempt, it carries the same information: nothing changed here. The
      // measured runaway alternated the two halves for 24m38s; treating the
      // alternation as "a different outcome" is exactly the laundering this
      // ledger exists to stop.
      count = previous.count + 1
      firstAt = previous.firstAt
      retired = previous.retired
      retiredAt = previous.retiredAt
      // Retire on exactly the bound; an already-retired entry stays retired and
      // does not re-escalate, so the escalation is emitted once per fact-set.
      if (count >= this.limit && !previous.retired) {
        escalate = true
        retired = true
        retiredAt = observation.now
      }
    }

    const entry: RepeatedOutcomeEntryJson = {
      key,
      actionShape: observation.actionShape,
      cell: observation.cell,
      outcome: observation.outcome,
      // STICKY: the most recent typed FAILURE at this target, so the escalation
      // line can name the diagnosis even when the bound is reached on the
      // mechanical rise half of an attempt (the measured alternation).
      failureCode: observation.failureCode ?? previous?.failureCode ?? null,
      count,
      firstAt,
      lastAt: observation.now,
      factSignature: observation.factSignature,
      retired,
      retiredAt,
    }
    this.entries.set(key, entry)
    this.evictIfNeeded()

    const decision: RepeatedOutcomeDecision = {
      key,
      actionShape: observation.actionShape,
      cell: observation.cell,
      outcome: observation.outcome,
      failureCode: observation.failureCode ?? previous?.failureCode ?? null,
      count,
      limit: this.limit,
      escalate,
      retired,
      restarted,
      line: '',
    }
    decision.line = escalate ? formatActionRepeatExhausted(decision, observation.actionId) : formatActionRepeat(decision)
    return decision
  }

  /** True while this action shape is retired at this cell. */
  isRetired(actionShape: string, cell: string): boolean {
    return this.entries.get(repeatedOutcomeKey(actionShape, cell))?.retired ?? false
  }

  /** The retirement record for evidence, or null. */
  retirement(actionShape: string, cell: string): RepeatedOutcomeEntryJson | null {
    const entry = this.entries.get(repeatedOutcomeKey(actionShape, cell))
    return entry !== undefined && entry.retired ? entry : null
  }

  /** Consecutive identical outcomes recorded so far for a key (0 when none). */
  countFor(actionShape: string, cell: string): number {
    return this.entries.get(repeatedOutcomeKey(actionShape, cell))?.count ?? 0
  }

  /** Plain-data snapshot for the HOST durable store. */
  snapshot(): RepeatedOutcomeEntryJson[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }))
  }

  /** Replace the ledger from durable data; malformed entries are dropped. */
  restore(entries: readonly unknown[]): void {
    this.entries.clear()
    for (const source of entries) {
      const entry = restoreRepeatedOutcomeEntry(source)
      if (entry !== null) this.entries.set(entry.key, entry)
    }
    this.evictIfNeeded()
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  /**
   * Bounded memory: evict the oldest NON-retired entry first, so a live
   * retirement is never silently dropped in favour of a mere counter.
   */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let victimKey: string | null = null
      let victimRetired = true
      let victimLastAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        const better = victimKey === null
          || (victimRetired && !entry.retired)
          || (victimRetired === entry.retired && entry.lastAt < victimLastAt)
        if (better) {
          victimKey = key
          victimRetired = entry.retired
          victimLastAt = entry.lastAt
        }
      }
      if (victimKey === null) return
      this.entries.delete(victimKey)
    }
  }
}

export interface RepeatedOutcomeTargetCandidate {
  id: string
  kind: string
  target: Vec3Like | null
}

export interface RetiredRepeatCandidate<T> {
  candidate: T
  key: string
  actionShape: string
  cell: string
  outcome: string
  count: number
  limit: number
}

export interface FilterRetiredRepeatsResult<T> {
  kept: T[]
  withheld: RetiredRepeatCandidate<T>[]
}

/**
 * Drop candidates whose `(action shape, cell)` is retired, so the offer is
 * forced onto a different target in the same cycle - the bounded relocation.
 * The predicate is mechanical: no ranking, no substitute is manufactured, and
 * every non-retired candidate keeps its relative place.
 */
export function filterRetiredRepeats<T extends RepeatedOutcomeTargetCandidate>(
  candidates: readonly T[],
  ledger: RepeatedOutcomeEscalation,
  dimension: string,
  bodyPosition: Vec3Like,
): FilterRetiredRepeatsResult<T> {
  const kept: T[] = []
  const withheld: RetiredRepeatCandidate<T>[] = []
  for (const candidate of candidates) {
    if (!isRepeatTrackedKind(candidate.kind)) {
      kept.push(candidate)
      continue
    }
    const actionShape = actionShapeOf(candidate.id)
    const cell = repeatedOutcomeCell(dimension, candidate.target, bodyPosition)
    const entry = ledger.retirement(actionShape, cell)
    if (entry === null) {
      kept.push(candidate)
      continue
    }
    withheld.push({
      candidate,
      key: entry.key,
      actionShape,
      cell,
      outcome: entry.outcome,
      count: entry.count,
      limit: ledger.limit,
    })
  }
  return { kept, withheld }
}
