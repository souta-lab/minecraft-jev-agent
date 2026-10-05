// candidateCommitment.ts - anti-thrash commitment (#11 v2 section 7).
//
// Measured on main 444d387: the controller re-selected a different RETRIEVE
// every ~1.5 s while HEARTBEAT pos stayed (31.2,40.0,37.2) and no action made
// progress:
//
//   ACTION n=4953 id=RETRIEVE:known:station:crafting_table:b-10_67_11
//   ACTION n=4954 id=RETRIEVE:known:station:crafting_table:b-11_71_-9
//   ACTION n=4955 id=RETRIEVE:known:station:crafting_table:b40_29_35
//   ...
//
// A choice that changes on consecutive ticks with zero verified progress and an
// unchanged state fingerprint is thrashing. The controller may temporally commit
// to a candidate that JEV ACTUALLY CHOSE, so an action has time to settle. It may
// not convert flap detection into a second semantic selector. In particular,
// path/resource cost is useful affordance metadata but code must not use argmin
// cost to replace Jev's WHICH decision.
//
// Commitment ends when the selected candidate completes/progresses, becomes
// deterministically invalid, vanishes from the grounded set, or the relevant
// state fingerprint changes. After release the raw Jev choice is returned; code
// does not choose a replacement semantic action. Pure, clock-free.

/** Consecutive changed ticks before a commitment arms (5-tick flap window). */
export const CANDIDATE_FLAP_TICKS_DEFAULT = 4

/** `BUDDY_CANDIDATE_FLAP_TICKS` overrides the window; invalid values fall back. */
export function resolveCandidateFlapTicks(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_CANDIDATE_FLAP_TICKS ?? CANDIDATE_FLAP_TICKS_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : CANDIDATE_FLAP_TICKS_DEFAULT
}

/** Mirrored markers for the commitment lifecycle. */
export const CANDIDATE_FLAP = 'CANDIDATE_FLAP'
export const CANDIDATE_COMMIT_RELEASED = 'CANDIDATE_COMMIT_RELEASED'

export function formatCandidateFlap(from: string, to: string, ticks: number, commit: string): string {
  return `${CANDIDATE_FLAP} from=${from} to=${to} ticks=${ticks} commit=${commit}`
}

export function formatCommitReleased(candidate: string, reason: string, next: string): string {
  return `${CANDIDATE_COMMIT_RELEASED} candidate=${candidate} reason=${reason} next=${next}`
}

/** WAIT/ESCALATE are not thrash targets: their selection is not a body change. */
const COMMIT_EXEMPT_IDS: ReadonlySet<string> = new Set(['WAIT', 'ESCALATE'])

export interface FlapCandidate {
  readonly id: string
  /** Mechanical/path/resource cost fact. Never semantic authority in real-Jev commitment. */
  readonly cost: number
}

export interface CandidateFlapState {
  readonly fingerprint: string
  /** the policy's own last choice, before any commitment hold. */
  readonly lastChosenId: string
  /** consecutive changed ticks inside the current fingerprint window. */
  readonly switches: number
  /** one Jev-selected candidate temporarily held for execution stability. */
  readonly committedId: string | null
  /** candidates deterministic feasibility rejected under this fingerprint. */
  readonly invalid: ReadonlySet<string>
}

export interface CandidateFlapInput {
  readonly previous: CandidateFlapState | null
  /** Jev's raw choice for this tick. */
  readonly chosenId: string
  readonly fingerprint: string
  /** true when verified progress happened since the previous tick. */
  readonly progressed: boolean
  /** current grounded candidates. Cost is observation metadata only here. */
  readonly candidates: readonly FlapCandidate[]
  /** candidates rejected by deterministic facts on this tick. */
  readonly invalid: ReadonlySet<string>
  readonly flapTicks?: number
}

export interface CandidateFlapDecision {
  readonly state: CandidateFlapState
  /** Jev's choice, or a still-valid prior Jev choice held as temporal commitment. */
  readonly chosenId: string
  readonly committed: boolean
  /** the `CANDIDATE_FLAP ...` line when a flap is detected, else null. */
  readonly line: string | null
  /** the release line when deterministic invalidation freed the commitment. */
  readonly releaseLine: string | null
}

/**
 * Explicit deterministic-baseline helper retained for offline/A-B callers only.
 * Real-Jev anti-flap commitment MUST NOT call this helper: choosing the cheapest
 * semantic candidate would seize Jev's WHICH authority. Lower mechanical cost
 * remains useful metadata and can be exposed to Jev.
 */
export function selectCommitCandidate(
  candidates: readonly FlapCandidate[],
  invalid: ReadonlySet<string>,
): string | null {
  let best: FlapCandidate | null = null
  for (const candidate of candidates) {
    if (invalid.has(candidate.id)) continue
    if (
      best === null ||
      candidate.cost < best.cost ||
      (candidate.cost === best.cost && candidate.id < best.id)
    ) {
      best = candidate
    }
  }
  return best?.id ?? null
}

function jevChoiceIsCommittable(
  chosenId: string,
  offered: ReadonlySet<string>,
  invalid: ReadonlySet<string>,
): boolean {
  return !COMMIT_EXEMPT_IDS.has(chosenId) && offered.has(chosenId) && !invalid.has(chosenId)
}

/**
 * Anti-thrash temporal commitment for the REAL Jev policy.
 *
 * A state change or verified progress clears commitment. Otherwise consecutive
 * changing Jev choices may arm a hold on the CURRENT Jev-selected candidate.
 * Code never substitutes a cheaper alternative. A held candidate is released
 * only when deterministic feasibility rejects it or it vanishes from the
 * offered set; release returns the current raw Jev choice without auto-committing
 * a replacement, so the next semantic WHICH remains model-owned.
 */
export function evaluateCandidateFlap(input: CandidateFlapInput): CandidateFlapDecision {
  const flapTicks = input.flapTicks ?? CANDIDATE_FLAP_TICKS_DEFAULT
  const invalid = new Set(input.invalid)
  const offered = new Set(input.candidates.map((candidate) => candidate.id))
  const previous = input.previous

  if (previous === null || previous.fingerprint !== input.fingerprint || input.progressed) {
    const state: CandidateFlapState = {
      fingerprint: input.fingerprint,
      lastChosenId: input.chosenId,
      switches: 0,
      committedId: null,
      invalid: new Set<string>(),
    }
    return { state, chosenId: input.chosenId, committed: false, line: null, releaseLine: null }
  }

  for (const id of previous.invalid) invalid.add(id)

  if (previous.committedId !== null) {
    const committedId = previous.committedId
    const rejectedByFacts = invalid.has(committedId)
    const vanished = !offered.has(committedId)
    if (!rejectedByFacts && !vanished) {
      return {
        state: { ...previous, invalid, lastChosenId: input.chosenId },
        chosenId: committedId,
        committed: true,
        line: null,
        releaseLine: null,
      }
    }

    invalid.add(committedId)
    return {
      state: {
        fingerprint: previous.fingerprint,
        lastChosenId: input.chosenId,
        switches: 0,
        committedId: null,
        invalid,
      },
      chosenId: input.chosenId,
      committed: false,
      line: null,
      releaseLine: formatCommitReleased(
        committedId,
        rejectedByFacts ? 'deterministically_invalid' : 'no_longer_offered',
        input.chosenId,
      ),
    }
  }

  const committableTransition =
    !COMMIT_EXEMPT_IDS.has(input.chosenId) && !COMMIT_EXEMPT_IDS.has(previous.lastChosenId)
  const changed = input.chosenId !== previous.lastChosenId && committableTransition
  const switches = changed ? previous.switches + 1 : 0
  if (switches < flapTicks) {
    return {
      state: { ...previous, lastChosenId: input.chosenId, switches, invalid },
      chosenId: input.chosenId,
      committed: false,
      line: null,
      releaseLine: null,
    }
  }

  // Crucial authority invariant: commit only to Jev's current raw choice. If
  // that choice is no longer grounded/valid, do not manufacture another choice.
  if (!jevChoiceIsCommittable(input.chosenId, offered, invalid)) {
    return {
      state: { ...previous, lastChosenId: input.chosenId, switches, invalid, committedId: null },
      chosenId: input.chosenId,
      committed: false,
      line: null,
      releaseLine: null,
    }
  }

  const commit = input.chosenId
  return {
    state: {
      fingerprint: previous.fingerprint,
      lastChosenId: input.chosenId,
      switches,
      committedId: commit,
      invalid,
    },
    chosenId: commit,
    committed: true,
    line: formatCandidateFlap(previous.lastChosenId, input.chosenId, switches + 1, commit),
    releaseLine: null,
  }
}

// ---------------------------------------------------------------------------
// In-flight ACTION commitment (action lifecycle, not preference)
// ---------------------------------------------------------------------------
//
// Measured live on `449cedd` (m3-live, planId=g3:collect:flint):
//
//   RETRIEVE:known:obsidian:b28_67_9 x2, DESCEND:level:W:b125_66_-10 x2, WAIT x4
//   PATH_CALLBACK phase=failed actionId=DESCEND:level:W:b125_66_-10
//   position ~125,66; net movement ~0 over many minutes
//
// `Executor.claim(candidate)` cancels any *different* in-flight action first
// (`cancelCurrent`, executor.ts). Nothing in the controller bounded that
// switch: `evaluateCandidateFlap` above only arms after N consecutive changed
// ticks under an UNCHANGED semantic fingerprint, and the fingerprint includes
// rounded position + inventory, so any action that actually moves the body (or
// digs junk) resets the flap window before it can hold. A newly chosen
// candidate therefore replaced the running action whenever a decision happened
// to be produced, and the body never finished either alternative.
//
// This is the SAME mechanism as the flap commitment - hold a candidate JEV
// ACTUALLY CHOSE long enough for it to settle, never substitute a different
// semantic choice - but keyed on the live in-flight ACTION INSTANCE and bounded
// by a completion window. It is deliberately NOT a preference: it can only keep
// the action the executor is already running, or release to whatever the raw
// choice is (`chosenId`). Code never picks a replacement.
//
// Release is immediate and unconditional when:
//   - nothing is in flight (the action completed, failed or was cancelled);
//   - the plan/goal identity changed (a different goal resets the commitment);
//   - the held candidate vanished from the grounded set;
//   - deterministic feasibility rejected the held candidate; or
//   - the bounded window (`windowMs`) / decision budget (`maxHolds`) elapsed.
// The last two are the anti-infinite-commitment guard: after the bound the raw
// choice wins, so a genuinely stuck action cannot freeze the controller (#327).

/** Bounded completion window an in-flight chosen action gets before replacement. */
export const ACTION_COMMIT_MS_DEFAULT = 8000

/** `BUDDY_ACTION_COMMIT_MS` overrides the window; invalid values fall back. */
export function resolveActionCommitMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_ACTION_COMMIT_MS ?? ACTION_COMMIT_MS_DEFAULT)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : ACTION_COMMIT_MS_DEFAULT
}

/** Decisions a single in-flight action may be held through before the raw choice wins. */
export const ACTION_COMMIT_HOLDS_DEFAULT = 8

/** `BUDDY_ACTION_COMMIT_HOLDS` overrides the decision budget; invalid values fall back. */
export function resolveActionCommitHolds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_ACTION_COMMIT_HOLDS ?? ACTION_COMMIT_HOLDS_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : ACTION_COMMIT_HOLDS_DEFAULT
}

/** Mirrored markers for the in-flight action lifecycle. */
export const ACTION_COMMIT = 'ACTION_COMMIT'
export const ACTION_PREEMPT = 'ACTION_PREEMPT'

export function formatActionCommit(plan: string, action: string, remainingMs: number): string {
  return `${ACTION_COMMIT} plan=${plan} action=${action} remainingMs=${remainingMs}`
}

export function formatActionPreempt(plan: string, from: string, to: string, reason: string): string {
  return `${ACTION_PREEMPT} plan=${plan} from=${from} to=${to} reason=${reason}`
}

/** Why a held in-flight action was allowed to be replaced. */
export type ActionCommitReleaseReason =
  | 'plan_changed'
  | 'no_longer_offered'
  | 'deterministically_invalid'
  | 'window_elapsed'
  | 'decision_budget_exhausted'
  /**
   * SAFE: a hostile is inside melee reach and the CURRENT choice is a grounded
   * threat response (ATTACK/RETREAT/ESCALATE). The hold exists to stop thrash
   * between equivalent candidates, never to keep the body inside a hit window:
   * measured live (2026-09-21T22:19:39-42), Jev chose ATTACK:e33467 against a
   * zombie at 0.78 m three decisions in a row and the commitment held the
   * in-flight RETREAT each time, so the body never swung and died 5 s later.
   * The newer model choice wins while the body is in contact.
   */
  | 'contact_threat'

export interface ActionCommitmentState {
  /** the held action instance identity: candidate id + executor epoch */
  readonly actionId: string
  readonly epoch: number
  readonly planKey: string
  /** decisions taken while holding this action against a different choice */
  readonly holds: number
}

export interface ActionCommitmentInput {
  readonly previous: ActionCommitmentState | null
  /** the executor's in-flight action instance, or null when nothing is running. */
  readonly inFlight: {
    readonly id: string
    readonly epoch: number
    readonly startedAtMs: number
  } | null
  /** the raw (after flap commitment) policy choice for this decision. */
  readonly chosenId: string
  /** plan/goal identity; a change resets the commitment. */
  readonly planKey: string
  readonly nowMs: number
  readonly windowMs?: number
  readonly maxHolds?: number
  /** deterministic feasibility rejected the in-flight candidate. */
  readonly inFlightInvalid: boolean
  /** the in-flight candidate is still in the grounded candidate set. */
  readonly inFlightOffered: boolean
  /**
   * SAFE: a hostile is inside melee reach AND the current choice is a grounded
   * threat response. Code owns only the contact fact; the choice is still Jev's
   * (the newer one). Optional: absent means "no contact threat", which keeps
   * every pre-existing caller and fixture unchanged.
   */
  readonly contactThreatResponse?: boolean
}

export interface ActionCommitmentDecision {
  /** null once nothing is held (in flight settled, or commitment released). */
  readonly state: ActionCommitmentState | null
  /** the action the controller may claim: the held action, or the new choice. */
  readonly chosenId: string
  /** true when a different choice was suppressed for the held in-flight action. */
  readonly committed: boolean
  /** the `ACTION_COMMIT ...` line when a switch was suppressed, else null. */
  readonly line: string | null
  /** the `ACTION_PREEMPT ...` line when the held action was released, else null. */
  readonly releaseLine: string | null
}

/**
 * Hold a Jev-chosen in-flight action for a bounded window instead of letting
 * the next decision replace it. Pure: `now`, the in-flight instance and the
 * grounded set are all injected, so the lifecycle is unit-testable without a
 * bot. See the block comment above for the authority invariant and release set.
 */
export function evaluateActionCommitment(input: ActionCommitmentInput): ActionCommitmentDecision {
  const windowMs = input.windowMs ?? ACTION_COMMIT_MS_DEFAULT
  const maxHolds = input.maxHolds ?? ACTION_COMMIT_HOLDS_DEFAULT
  const inFlight = input.inFlight

  // (b) no action is in flight: a completed/failed/cancelled action releases the
  // commitment immediately, so the raw choice is honored on this decision.
  if (inFlight === null) {
    return { state: null, chosenId: input.chosenId, committed: false, line: null, releaseLine: null }
  }

  const previous = input.previous
  const sameInstance =
    previous !== null &&
    previous.actionId === inFlight.id &&
    previous.epoch === inFlight.epoch &&
    previous.planKey === input.planKey

  // Jev re-selected the running action: keep the commitment anchored, no switch.
  if (input.chosenId === inFlight.id) {
    return {
      state: {
        actionId: inFlight.id,
        epoch: inFlight.epoch,
        planKey: input.planKey,
        holds: previous !== null && sameInstance ? previous.holds : 0,
      },
      chosenId: input.chosenId,
      committed: false,
      line: null,
      releaseLine: null,
    }
  }

  const elapsedMs = Number.isFinite(inFlight.startedAtMs) ? input.nowMs - inFlight.startedAtMs : windowMs
  const remainingMs = Math.max(0, Math.floor(windowMs - elapsedMs))
  const holds = previous !== null && sameInstance ? previous.holds : 0

  // (c) plan/goal change, (d) deterministic infeasibility/vanishing and the
  // bounded window/budget all release; everything else holds.
  let reason: ActionCommitReleaseReason | null = null
  // SAFE: a same-kind RETREAT retarget while a retreat is already in flight
  // restarts the escape leg and discards its closed distance. Measured
  // gen-mutoyo8o (2026-10-04T10:44:0x): three successive RETREAT picks each
  // released the last via contact_threat, every walk leg restarted
  // (`closed=0.01m`), and the drowned killed the body at 3.17hp while valid
  // escapes stayed offered the whole time. The contact release exists for
  // KIND switches (ATTACK over a held RETREAT); a held retreat already IS the
  // grounded threat answer and an offered retreat cell remains
  // escape-scan-endorsed, so the newer cell is only a marginal retarget.
  //
  // The carve-out is not contact-scoped, and it is not defeated by the volatile
  // cell identity: escape cells are recomputed inside a radius-16 box anchored
  // on the body's CURRENT block (`state.ts#buildEscapeCells`), so knockback or
  // a single walked block re-anchors the box and rewrites every boundary-cell
  // id - a held retreat leaves the offer without the escape answer changing.
  // Measured portal-p24 (2026-10-05, bow skeletons id=36/id=587, contact=false,
  // los=true): every critical-health hit preempted the in-flight RETREAT, the
  // fresh pick was a same-kind retarget 1-20 cells away, and the release came
  // through `no_longer_offered`/`window_elapsed` - each walk leg restarted at
  // `closed=0m` while arrows kept landing, death at (29.6,103,4.7) and again
  // at (14.9,95,-12.5) on the same fingerprint. Releasing only for a genuinely
  // different answer - a plan move or a deterministically invalid held cell -
  // keeps Jev's own repeated choice ("keep escaping") executing inside the
  // bounded walk lease, which still ends on its own stepCap/msBudget.
  const sameRetreatRetarget =
    inFlight.id.startsWith('RETREAT:') &&
    input.chosenId.startsWith('RETREAT:')
  if (input.contactThreatResponse === true && !sameRetreatRetarget) {
    // In contact, the body answers now: a newer threat response is never held
    // behind the previous action lease.
    reason = 'contact_threat'
  } else if (!sameInstance && previous !== null && previous.planKey !== input.planKey) {
    reason = 'plan_changed'
  } else if (input.inFlightInvalid) {
    reason = 'deterministically_invalid'
  } else if (!sameRetreatRetarget && !input.inFlightOffered) {
    reason = 'no_longer_offered'
  } else if (!sameRetreatRetarget && elapsedMs >= windowMs) {
    reason = 'window_elapsed'
  } else if (!sameRetreatRetarget && holds >= maxHolds) {
    reason = 'decision_budget_exhausted'
  }

  if (reason === null) {
    // (a) hold: suppress the different choice for the bounded window.
    return {
      state: { actionId: inFlight.id, epoch: inFlight.epoch, planKey: input.planKey, holds: holds + 1 },
      chosenId: inFlight.id,
      committed: true,
      line: formatActionCommit(input.planKey, inFlight.id, remainingMs),
      releaseLine: null,
    }
  }

  return {
    state: null,
    chosenId: input.chosenId,
    committed: false,
    line: null,
    releaseLine: formatActionPreempt(input.planKey, inFlight.id, input.chosenId, reason),
  }
}
