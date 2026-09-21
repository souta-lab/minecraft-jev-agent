// test-anti-flap.mts - issue #11 v2 section 6/7 acceptance: state-conditioned
// validity (protection and abandonment are mutually exclusive under an
// unchanged fingerprint) and anti-thrash commitment (no candidate flap).
//
// Measured on main 444d387:
//
//   (A) the same option was abandoned and protected in the same window:
//       PRECONDITION_PROTECTED option=CRAFT:furnace ... reason=action_impossible
//       JEV_HEADS action=CRAFT:furnace abandon=1 ... attempts=3
//       ABANDON_REASON option=CRAFT:furnace reason=unreachable beta=1
//       PRECONDITION_PROTECTED option=CRAFT:furnace ... reason=no_progress
//
//   (B) the controller re-selected a different RETRIEVE every ~1.5 s while
//       HEARTBEAT pos stayed (31.2,40.0,37.2):
//       RETRIEVE:known:station:crafting_table:b-10_67_11
//       RETRIEVE:known:station:crafting_table:b-11_71_-9
//       RETRIEVE:known:station:crafting_table:b40_29_35 ...
//
// Authority invariant: anti-thrash may HOLD a candidate Jev selected long enough
// to settle, but it may not choose a cheaper/different semantic candidate on
// Jev's behalf. Pure: no bot, no network, no model. Run: bun test-anti-flap.mts
import { readFileSync } from 'node:fs'
import {
  AbandonmentLedger,
  formatProtectionAbandonConflict,
  PROTECTION_ABANDON_CONFLICT,
  reconcileProtection,
} from './src/protectionConflict.ts'
import {
  CANDIDATE_COMMIT_RELEASED,
  CANDIDATE_FLAP,
  CANDIDATE_FLAP_TICKS_DEFAULT,
  evaluateCandidateFlap,
  formatCandidateFlap,
  resolveCandidateFlapTicks,
  selectCommitCandidate,
} from './src/candidateCommitment.ts'
import type { CandidateFlapState, FlapCandidate } from './src/candidateCommitment.ts'
import { prerequisiteProtection } from './src/placementGuard.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const OPTION = 'CRAFT:furnace'
const SMELT = [{ kind: 'smelt', targetItem: 'iron_ingot' }] as const
const FP1 = 'fp1|pos=31,40,37|inv=cobblestone=67|stations=furnace@29,61,35'
const FP2 = 'fp1|pos=32,40,37|inv=cobblestone=67|stations=furnace@29,61,35'

// The measured live candidate set (#11 v2): multiple reachable remembered
// stations, no held table, cobblestone 67, charcoal smelt. Cost is an affordance
// FACT exposed by the caller; real-Jev commitment must not turn it into WHICH.
const CRAFTING_A = 'RETRIEVE:known:station:crafting_table:b-10_67_11'
const CRAFTING_B = 'RETRIEVE:known:station:crafting_table:b-11_71_-9'
const CRAFTING_C = 'RETRIEVE:known:station:crafting_table:b40_29_35'
const FURNACE_A = 'RETRIEVE:known:station:furnace:b29_61_35'
const FURNACE_B = 'RETRIEVE:known:station:furnace:b8_65_24'

const LIVE_CANDIDATES: readonly FlapCandidate[] = [
  { id: FURNACE_A, cost: 7.4 },
  { id: CRAFTING_C, cost: 8.2 },
  { id: CRAFTING_A, cost: 9.6 },
  { id: CRAFTING_B, cost: 12.1 },
  { id: FURNACE_B, cost: 15.3 },
]

function protection(): ReturnType<typeof prerequisiteProtection> {
  return prerequisiteProtection({ actionId: OPTION, goals: SMELT, placedFurnaceCount: 0 })
}

function step(
  previous: CandidateFlapState | null,
  chosenId: string,
  fingerprint: string,
  overrides: Partial<Parameters<typeof evaluateCandidateFlap>[0]> = {},
): ReturnType<typeof evaluateCandidateFlap> {
  return evaluateCandidateFlap({
    previous,
    chosenId,
    fingerprint,
    progressed: false,
    candidates: LIVE_CANDIDATES,
    invalid: new Set<string>(),
    ...overrides,
  })
}

// --- (1) abandoned-then-protected: conflict marker, no re-protection ---------

addCase('(1) an abandoned option is not re-protected under the unchanged fingerprint', () => {
  const ledger = new AbandonmentLedger()
  const probe = protection()
  const before = reconcileProtection({ protection: probe, abandonedReason: ledger.reasonUnder(OPTION, FP1) })
  ledger.markAbandoned(OPTION, FP1, 'unreachable')
  const after = reconcileProtection({ protection: probe, abandonedReason: ledger.reasonUnder(OPTION, FP1) })
  const expected =
    'PROTECTION_ABANDON_CONFLICT option=CRAFT:furnace action=abandoned reason=unreachable'
  const pass =
    probe.protect === true &&
    before.protect === true &&
    before.conflictLine === null &&
    after.protect === false &&
    after.conflictLine === expected &&
    after.conflictLine === formatProtectionAbandonConflict(OPTION, 'abandoned', 'unreachable')
  return { pass, detail: `before=${before.protect} after=${after.protect} line="${after.conflictLine ?? 'none'}"` }
})

addCase('(1) a state change clears the abandonment and protection applies again', () => {
  const ledger = new AbandonmentLedger()
  ledger.markAbandoned(OPTION, FP1, 'unreachable')
  const sameFingerprint = reconcileProtection({
    protection: protection(),
    abandonedReason: ledger.reasonUnder(OPTION, FP1),
  })
  const changed = reconcileProtection({
    protection: protection(),
    abandonedReason: ledger.reasonUnder(OPTION, FP2),
  })
  const conflictFirst = ledger.claimConflict(OPTION, FP1)
  const conflictRepeat = ledger.claimConflict(OPTION, FP1)
  const pass =
    sameFingerprint.protect === false &&
    changed.protect === true &&
    changed.conflictLine === null &&
    conflictFirst === true &&
    conflictRepeat === false
  return { pass, detail: `same=${sameFingerprint.protect} changed=${changed.protect} first=${conflictFirst} repeat=${conflictRepeat}` }
})

// --- (2) five alternating ticks -> commit the CURRENT Jev choice -------------

addCase('(2) 5 alternating ticks fire CANDIDATE_FLAP and commit Jev current choice', () => {
  let state: CandidateFlapState | null = null
  const choices = [CRAFTING_A, CRAFTING_B, CRAFTING_A, CRAFTING_B, CRAFTING_A]
  const decisions = choices.map((chosenId) => {
    const decision = step(state, chosenId, FP1)
    state = decision.state
    return decision
  })
  const fifth = decisions[4]
  if (fifth === undefined) return { pass: false, detail: 'no fifth decision' }
  const expected =
    `CANDIDATE_FLAP from=${CRAFTING_B} to=${CRAFTING_A} ticks=5 commit=${CRAFTING_A}`
  const pass =
    decisions.slice(0, 4).every((decision) => decision.line === null && !decision.committed) &&
    fifth.line === expected &&
    fifth.committed === true &&
    fifth.chosenId === CRAFTING_A &&
    fifth.line === formatCandidateFlap(CRAFTING_B, CRAFTING_A, 5, CRAFTING_A)
  return { pass, detail: `line="${fifth.line ?? 'none'}" chosen=${fifth.chosenId}` }
})

addCase('(2) the Jev-owned commitment holds across subsequent changing ticks', () => {
  let state: CandidateFlapState | null = null
  for (const chosenId of [CRAFTING_A, CRAFTING_B, CRAFTING_A, CRAFTING_B, CRAFTING_A]) {
    state = step(state, chosenId, FP1).state
  }
  const follow = [CRAFTING_B, CRAFTING_A, FURNACE_B, CRAFTING_C, CRAFTING_A].map((chosenId) => {
    const decision = step(state, chosenId, FP1)
    state = decision.state
    return decision
  })
  const pass =
    follow.every((decision) => decision.committed === true && decision.chosenId === CRAFTING_A) &&
    follow.every((decision) => decision.line === null) &&
    state?.committedId === CRAFTING_A
  return { pass, detail: `chosen=[${follow.map((decision) => decision.chosenId).join(',')}]` }
})

addCase('(2) verified progress clears the flap window instead of committing', () => {
  let state: CandidateFlapState | null = null
  for (const chosenId of [CRAFTING_A, CRAFTING_B, CRAFTING_A, CRAFTING_B]) {
    state = step(state, chosenId, FP1).state
  }
  const progress = step(state, CRAFTING_A, FP1, { progressed: true })
  const after = step(progress.state, FURNACE_B, FP1)
  const pass =
    progress.committed === false &&
    progress.state.switches === 0 &&
    progress.state.committedId === null &&
    after.line === null &&
    after.committed === false
  return { pass, detail: `progressCommitted=${progress.committed} after="${after.line ?? 'none'}"` }
})

addCase('(2) WAIT/ESCALATE choices are not thrash and never arm a commitment', () => {
  let state: CandidateFlapState | null = null
  for (const chosenId of ['WAIT', CRAFTING_A, 'WAIT', CRAFTING_B, 'WAIT', CRAFTING_A, 'WAIT', CRAFTING_B, 'WAIT', CRAFTING_A]) {
    state = step(state, chosenId, FP1).state
  }
  const pass = state !== null && state.committedId === null && state.switches <= 1
  return { pass, detail: `committed=${state?.committedId ?? 'none'} switches=${state?.switches ?? -1}` }
})

// --- (3) deterministic invalidation RELEASES; code picks no replacement -------

addCase('(3) deterministic invalidation releases to the current Jev choice without auto-commit', () => {
  let state: CandidateFlapState | null = null
  for (const chosenId of [CRAFTING_A, CRAFTING_B, CRAFTING_A, CRAFTING_B, CRAFTING_A]) {
    state = step(state, chosenId, FP1).state
  }
  const release = step(state, CRAFTING_C, FP1, { invalid: new Set([CRAFTING_A]) })
  const after = step(release.state, CRAFTING_B, FP1)
  const pass =
    release.committed === false &&
    release.chosenId === CRAFTING_C &&
    release.releaseLine ===
      `CANDIDATE_COMMIT_RELEASED candidate=${CRAFTING_A} reason=deterministically_invalid next=${CRAFTING_C}` &&
    release.releaseLine?.startsWith(CANDIDATE_COMMIT_RELEASED) === true &&
    release.state.committedId === null &&
    after.chosenId === CRAFTING_B &&
    after.committed === false
  return { pass, detail: `release="${release.releaseLine ?? 'none'}" after=${after.chosenId}` }
})

addCase('(3) a vanished committed candidate releases and current Jev choice remains authoritative', () => {
  let state: CandidateFlapState | null = null
  for (const chosenId of [CRAFTING_A, CRAFTING_B, CRAFTING_A, CRAFTING_B, CRAFTING_A]) {
    state = step(state, chosenId, FP1).state
  }
  const offered = LIVE_CANDIDATES.filter((candidate) => candidate.id !== CRAFTING_A)
  const release = step(state, CRAFTING_B, FP1, { candidates: offered })
  const again = step(release.state, CRAFTING_C, FP1, { candidates: offered })
  const pass =
    release.releaseLine?.includes(`candidate=${CRAFTING_A}`) === true &&
    release.releaseLine?.includes('reason=no_longer_offered') === true &&
    release.chosenId === CRAFTING_B &&
    release.committed === false &&
    again.chosenId === CRAFTING_C &&
    again.committed === false &&
    again.state.invalid.has(CRAFTING_A)
  return { pass, detail: `release="${release.releaseLine ?? 'none'}" next=${release.chosenId}` }
})

addCase('(3) deterministic cheapest selector remains an explicit baseline helper only', () => {
  const tied: readonly FlapCandidate[] = [
    { id: 'b', cost: 3 },
    { id: 'a', cost: 3 },
    { id: 'c', cost: 1 },
  ]
  const pick = selectCommitCandidate(tied, new Set<string>())
  const skipped = selectCommitCandidate(tied, new Set(['c', 'a']))
  const none = selectCommitCandidate(tied, new Set(['a', 'b', 'c']))
  return { pass: pick === 'c' && skipped === 'b' && none === null, detail: `baselinePick=${pick} skipped=${skipped} none=${none}` }
})

// --- (4) live shape stays stable without cost taking authority ----------------

addCase('(4) the live smelt-charcoal shape holds one Jev-selected candidate for 10 ticks', () => {
  let state: CandidateFlapState | null = null
  const live = [CRAFTING_A, CRAFTING_B, CRAFTING_C, FURNACE_A, FURNACE_B, CRAFTING_C]
  for (const chosenId of live) state = step(state, chosenId, FP1).state
  const committed = state?.committedId ?? null
  const follow: string[] = []
  for (let tick = 0; tick < 10; tick += 1) {
    const chosenId = live[tick % live.length] ?? CRAFTING_A
    const decision = step(state, chosenId, FP1)
    state = decision.state
    follow.push(decision.chosenId)
  }
  const pass =
    committed === FURNACE_B &&
    follow.every((chosenId) => chosenId === FURNACE_B) &&
    new Set(follow).size === 1
  return { pass, detail: `commit=${committed ?? 'none'} ticks=[${follow.join(',')}]` }
})

addCase('(4) lower cost cannot replace the Jev choice at commitment', () => {
  const inverted: readonly FlapCandidate[] = [
    { id: CRAFTING_A, cost: 1 },
    { id: FURNACE_A, cost: 2 },
    { id: CRAFTING_B, cost: 99 },
  ]
  let state: CandidateFlapState | null = null
  for (const chosenId of [CRAFTING_B, FURNACE_A, CRAFTING_B, FURNACE_A, CRAFTING_B]) {
    state = evaluateCandidateFlap({
      previous: state,
      chosenId,
      fingerprint: FP1,
      progressed: false,
      candidates: inverted,
      invalid: new Set<string>(),
    }).state
  }
  return {
    pass: state?.committedId === CRAFTING_B && String(state.committedId) !== String(CRAFTING_A),
    detail: `jevCommit=${state?.committedId ?? 'none'} cheapest=${CRAFTING_A}`,
  }
})

// --- env + wiring -------------------------------------------------------------

addCase('the flap window resolves from env with a safe default', () => {
  const defaults = resolveCandidateFlapTicks({}) === CANDIDATE_FLAP_TICKS_DEFAULT
  const override = resolveCandidateFlapTicks({ BUDDY_CANDIDATE_FLAP_TICKS: '2' }) === 2
  const invalid = resolveCandidateFlapTicks({ BUDDY_CANDIDATE_FLAP_TICKS: 'nope' }) === CANDIDATE_FLAP_TICKS_DEFAULT
  const zero = resolveCandidateFlapTicks({ BUDDY_CANDIDATE_FLAP_TICKS: '0' }) === CANDIDATE_FLAP_TICKS_DEFAULT
  return { pass: defaults && override && invalid && zero, detail: `defaults=${defaults} override=${override} invalid=${invalid} zero=${zero}` }
})

addCase('wiring: the controller reconciles protection with the abandonment ledger', () => {
  const text = source('./src/controller-legacy.ts')
  const missing = [
    'new AbandonmentLedger()',
    'reconcileProtection({',
    'markOptionAbandoned(',
  ].filter((needle) => !text.includes(needle))
  const mirrored = MIRRORED_MARKERS.has(PROTECTION_ABANDON_CONFLICT)
  const pass = missing.length === 0 && mirrored
  return {
    pass,
    detail: missing.length === 0 ? `mirrored=${mirrored}` : `missing ${missing.join(', ')}`,
  }
})

addCase('wiring: the controller commits to one Jev-selected candidate when the choice flaps', () => {
  const text = source('./src/controller-legacy.ts')
  const missing = [
    'evaluateCandidateFlap({',
    'applyCandidateCommitment(',
    'deterministicInvalid(',
  ].filter((needle) => !text.includes(needle))
  const mirrored =
    MIRRORED_MARKERS.has(CANDIDATE_FLAP) && MIRRORED_MARKERS.has(CANDIDATE_COMMIT_RELEASED)
  const pass = missing.length === 0 && mirrored
  return {
    pass,
    detail: missing.length === 0 ? `mirrored=${mirrored}` : `missing ${missing.join(', ')}`,
  }
})

addCase('wiring: tunnel entry refusal and local clearance are mirrored markers', () => {
  const executor = source('./src/executor.ts')
  const markers = ['tunnel_entry_refused', 'formatTunnelEntryRefused', 'formatLocalClear', 'planReuseLeg']
  const missing = markers.filter((needle) => !executor.includes(needle))
  const mirrored = MIRRORED_MARKERS.has('TUNNEL_ENTRY_REFUSED') && MIRRORED_MARKERS.has('LOCAL_CLEAR')
  const pass = missing.length === 0 && mirrored
  return {
    pass,
    detail: missing.length === 0 ? `mirrored=${mirrored}` : `missing ${missing.join(', ')}`,
  }
})

let failures = 0
process.stdout.write('#11 v2 - state-conditioned validity + Jev-owned anti-thrash commitment\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} anti-flap cases passed\n`)

if (failures > 0) process.exit(1)