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
// unchanged state fingerprint is thrashing. The controller commits to one
// candidate - the cheapest feasible by the existing cost policy, ties broken
// deterministically by candidate id - until it completes, fails deterministically
// under the same fingerprint, or the fingerprint changes. This is validity and
// commitment logic only: no new ranking is introduced. Pure, clock-free.

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
  /** cost under the caller's existing policy; lower is cheaper. */
  readonly cost: number
}

export interface CandidateFlapState {
  readonly fingerprint: string
  /** the policy's own last choice, before any commitment override. */
  readonly lastChosenId: string
  /** consecutive changed ticks inside the current fingerprint window. */
  readonly switches: number
  readonly committedId: string | null
  /** candidates deterministic feasibility rejected under this fingerprint. */
  readonly invalid: ReadonlySet<string>
}

export interface CandidateFlapInput {
  readonly previous: CandidateFlapState | null
  /** the policy's raw choice for this tick. */
  readonly chosenId: string
  readonly fingerprint: string
  /** true when verified progress happened since the previous tick. */
  readonly progressed: boolean
  /** current candidates with their existing-policy cost. */
  readonly candidates: readonly FlapCandidate[]
  /** candidates rejected by deterministic facts on this tick. */
  readonly invalid: ReadonlySet<string>
  readonly flapTicks?: number
}

export interface CandidateFlapDecision {
  readonly state: CandidateFlapState
  /** the id the controller must execute (the commitment while one is armed). */
  readonly chosenId: string
  readonly committed: boolean
  /** the `CANDIDATE_FLAP ...` line when a flap is detected, else null. */
  readonly line: string | null
  /** the release line when a deterministic invalidation freed the commitment. */
  readonly releaseLine: string | null
}

/** The cheapest feasible candidate, ties broken deterministically by id. */
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

/**
 * The anti-thrash commitment state machine. A state change or verified progress
 * clears every fact; otherwise consecutive changed choices with no progress arm
 * a commitment to the cheapest feasible candidate. The commitment is released
 * only when deterministic feasibility rejects it (reachability/blacklist proof)
 * or it vanishes from the offered set - never by a preference.
 */
export function evaluateCandidateFlap(input: CandidateFlapInput): CandidateFlapDecision {
  const flapTicks = input.flapTicks ?? CANDIDATE_FLAP_TICKS_DEFAULT
  const invalid = new Set(input.invalid)
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
  const offered = new Set(input.candidates.map((candidate) => candidate.id))

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
    const next = selectCommitCandidate(input.candidates, invalid)
    return {
      state: {
        fingerprint: previous.fingerprint,
        lastChosenId: input.chosenId,
        switches: 0,
        committedId: next,
        invalid,
      },
      chosenId: next ?? input.chosenId,
      committed: next !== null,
      line: null,
      releaseLine: formatCommitReleased(
        committedId,
        rejectedByFacts ? 'deterministically_invalid' : 'no_longer_offered',
        next ?? 'none',
      ),
    }
  }

  const committable =
    !COMMIT_EXEMPT_IDS.has(input.chosenId) && !COMMIT_EXEMPT_IDS.has(previous.lastChosenId)
  const changed = input.chosenId !== previous.lastChosenId && committable
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
  const commit = selectCommitCandidate(input.candidates, invalid)
  if (commit === null) {
    return {
      state: { ...previous, lastChosenId: input.chosenId, switches, invalid },
      chosenId: input.chosenId,
      committed: false,
      line: null,
      releaseLine: null,
    }
  }
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
