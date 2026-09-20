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
