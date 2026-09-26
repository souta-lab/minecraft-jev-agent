// test-strategic-stall.mts - issue #360 §11: the semantic-exhaustion boundary.
//
// Measured live (m3-live `run.jsonl`, 2026-09-21T12:46:21.695Z ->
// 2026-09-21T13:34:50.960Z, 48.5 min): 1888 verified MOVE arrivals, 1533 blocks
// travelled, 0.815 blocks net displacement, `goal`/`search` progress 0, 401
// `OSCILLATION_DETECTED`, and `system2:recover_vertical_access` (plan
// `g2:surface:log`) authoritative the whole window with
// SYSTEM2_AUTHORITY_INPUT=0. Every deterministic counter was quiet because a
// verified MOVE is `execution=success progress=body`, which resets
// `lastProgressAt` and the action-failure streak.
//
// These cases are pure/isolated (no bot, no clock, no model):
//   (a) an A<->B / A<->B<->C body-only recurrence exhausts on a full window;
//   (b) successful body movement alone cannot clear it, and goal/search progress
//       inside the window can;
//   (c) a spread-out route or a WAIT/failure-only stall is NOT this evidence;
//   (d) a fired boundary re-arms with a longer window (bounded, no hot loop);
//   (e) the code-owned exhaustion crosses the beta lifecycle boundary even when
//       beta's own vote stayed below threshold.
import { readFileSync } from 'node:fs'
import {
  formatStrategicNonProgressEvidence,
  formatStrategicNonProgressExhausted,
  resolveStrategicStallHorizon,
  resolveStrategicStallMaxDistinctStates,
  resolveStrategicStallMinBodyProgress,
  STRATEGIC_NON_PROGRESS_EXHAUSTED_MARKER,
  STRATEGIC_NON_PROGRESS_MARKER,
  STRATEGIC_STALL_HORIZON_DEFAULT,
  STRATEGIC_STALL_MAX_BACKOFF_EXPONENT,
  STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT,
  STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT,
  StrategicStallTracker,
  strategicStallRequiredWindow,
  strategicStateKey,
} from './src/strategicStall.ts'
import { evaluateBetaTerminationBoundary } from './src/system2Escalation.ts'
import { JevController } from './src/controller.ts'
import type { JevResult } from './src/jev.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const OPTION = 'g2:surface:log'
const BODY = ['body'] as const
const WAIT_NONE = ['none'] as const
const GOAL = ['goal'] as const
const SEARCH = ['search'] as const
const BODY_SEARCH = ['body', 'search'] as const

/** The measured live endpoints: p3_67_17 <-> p3_67_18 <-> p2_67_18. */
const P17 = '3.5,67,17.7'
const P18 = '3.5,67,18.5'
const P2 = '2.7,67,18.5'

const observe = (
  tracker: StrategicStallTracker,
  stateKey: string,
  progressKinds: readonly string[] = BODY,
  optionInstanceId: string = OPTION,
) => tracker.note({ optionInstanceId, stateKey, progressKinds: progressKinds as never })

/** Replay the live loop: alternating A<->B body-only moves. */
function replayPocket(tracker: StrategicStallTracker, moves: number, states: readonly string[] = [P17, P18]): void {
  for (let index = 0; index < moves; index += 1) observe(tracker, states[index % states.length] as string)
}

// --- (a) the state-recurring body-only loop exhausts on a full window --------

addCase('(a) A<->B verified body-only MOVEs exhaust the recurrence window', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  replayPocket(tracker, 23)
  const beforeFull = tracker.evidence()
  replayPocket(tracker, 1)
  const full = tracker.evidence()
  return {
    pass:
      !beforeFull.exhausted &&
      full.exhausted === true &&
      full.distinctStates === 2 &&
      full.semanticProgressDecisions === 0 &&
      full.bodyProgressDecisions === 24 &&
      full.windowSize === 24,
    detail: `23=${beforeFull.exhausted} full=${JSON.stringify(full)}`,
  }
})

addCase('(a) the measured A<->B<->C shape (3 distinct cells) also exhausts', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  replayPocket(tracker, 48, [P17, P18, P2])
  const evidence = tracker.evidence()
  return {
    pass: evidence.exhausted === true && evidence.distinctStates === 3,
    detail: JSON.stringify(evidence),
  }
})
addCase('(a) fractional motion in one pocket collapses to block-cell recurrence', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  const positions = [
    { x: 2.5, y: 67, z: 18.5 },
    { x: 2.5, y: 67, z: 17.9 },
    { x: 1.7, y: 67, z: 18.5 },
    { x: 1.2, y: 67, z: 18.9 },
  ]
  for (let index = 0; index < 24; index += 1) {
    const position = positions[index % positions.length]!
    observe(tracker, strategicStateKey(position))
  }
  const evidence = tracker.evidence()
  return {
    pass: evidence.exhausted === true && evidence.distinctStates === 3,
    detail: JSON.stringify(evidence),
  }
})
addCase('(a) the four-cell respawn pocket exhausts under the default bound', () => {
  const tracker = new StrategicStallTracker()
  const cells = ['1,67,17', '1,67,18', '2,67,17', '2,67,18']
  for (let index = 0; index < STRATEGIC_STALL_HORIZON_DEFAULT; index += 1) {
    observe(tracker, cells[index % cells.length]!)
  }
  const evidence = tracker.evidence()
  return {
    pass:
      evidence.exhausted === true &&
      evidence.distinctStates === STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT &&
      evidence.maxDistinctStates === STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT,
    detail: JSON.stringify(evidence),
  }
})



// --- (b) successful body motion cannot reset; goal/search can ----------------

addCase('(b) 240 more successful body MOVEs never clear strategic non-progress', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  replayPocket(tracker, 24)
  for (let round = 0; round < 10; round += 1) {
    const evidence = observe(tracker, round % 2 === 0 ? P18 : P17)
    if (!evidence.exhausted) {
      return { pass: false, detail: `exhaustion lost at round ${round}: ${JSON.stringify(evidence)}` }
    }
  }
  const evidence = tracker.evidence()
  return {
    pass: evidence.exhausted && evidence.windowSize === 24 && evidence.bodyProgressDecisions === 24,
    detail: JSON.stringify(evidence),
  }
})

addCase('(b) one goal or search progress decision inside the window prevents exhaustion', () => {
  const goalTracker = new StrategicStallTracker(24, 3, 6)
  replayPocket(goalTracker, 23)
  observe(goalTracker, P18, GOAL)
  const goal = goalTracker.evidence()
  const searchTracker = new StrategicStallTracker(24, 3, 6)
  replayPocket(searchTracker, 23)
  observe(searchTracker, P18, BODY_SEARCH)
  const search = searchTracker.evidence()
  return {
    pass:
      !goal.exhausted &&
      goal.semanticProgressDecisions === 1 &&
      !search.exhausted &&
      search.semanticProgressDecisions === 1,
    detail: `goal=${JSON.stringify(goal)} search=${JSON.stringify(search)}`,
  }
})

// --- (c) the evidence does not claim other stall shapes ----------------------

addCase('(c) a route through more than 3 distinct states is not one pocket', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  for (let index = 0; index < 24; index += 1) observe(tracker, `p${index}`)
  const evidence = tracker.evidence()
  return {
    pass: evidence.exhausted === false && evidence.distinctStates === 24,
    detail: JSON.stringify(evidence),
  }
})

addCase('(c) a WAIT/failure-only stall (no body progress) is not this evidence', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  for (let index = 0; index < 24; index += 1) observe(tracker, index % 2 === 0 ? P17 : P18, WAIT_NONE)
  const evidence = tracker.evidence()
  return {
    pass: evidence.exhausted === false && evidence.bodyProgressDecisions === 0,
    detail: JSON.stringify(evidence),
  }
})

addCase('(c) a different Option instance re-arms the window', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  replayPocket(tracker, 24)
  const exhausted = tracker.evidence()
  observe(tracker, P17, BODY, 'g3:collect:flint')
  const rearmed = tracker.evidence()
  return {
    pass: exhausted.exhausted === true && rearmed.exhausted === false && rearmed.windowSize === 1,
    detail: `before=${exhausted.exhausted} after=${JSON.stringify(rearmed)}`,
  }
})

// --- (d) a fired boundary is bounded, not a hot loop -------------------------

addCase('(d) an acknowledged boundary doubles the required window, bounded by 2^N', () => {
  const tracker = new StrategicStallTracker(24, 3, 6)
  replayPocket(tracker, 24)
  const first = tracker.evidence()
  const acknowledged = tracker.acknowledgeExhaustion()
  replayPocket(tracker, 24)
  const notYet = tracker.evidence()
  replayPocket(tracker, 24)
  const second = tracker.evidence()
  return {
    pass:
      first.exhausted &&
      first.horizon === 24 &&
      acknowledged.exhaustedRepeats === 1 &&
      acknowledged.exhausted === false &&
      notYet.exhausted === false &&
      notYet.horizon === 48 &&
      second.exhausted === true &&
      second.exhaustedRepeats === 1 &&
      strategicStallRequiredWindow(24, 99) === 24 * 2 ** STRATEGIC_STALL_MAX_BACKOFF_EXPONENT,
    detail: `first=${first.horizon} afterAck=${notYet.horizon}/${notYet.exhausted} second=${second.exhausted}`,
  }
})

// --- (e) code-owned exhaustion crosses the beta boundary ---------------------

addCase('(e) semanticExhausted outranks body progress at the beta boundary', () => {
  const bodyOutcome = { execution: 'success', verification: 'verified', progress: 'body', progressKinds: ['body'], control: 'none', failure: null }
  const exhausted = evaluateBetaTerminationBoundary({
    optionId: OPTION,
    requested: false,
    decisionActionId: 'MOVE:p3_67_17',
    latestOutcome: bodyOutcome as never,
    semanticExhausted: true,
    semanticInvalid: false,
  })
  const notExhausted = evaluateBetaTerminationBoundary({
    optionId: OPTION,
    requested: false,
    decisionActionId: 'MOVE:p3_67_17',
    latestOutcome: bodyOutcome as never,
    semanticExhausted: false,
    semanticInvalid: false,
  })
  return {
    pass:
      exhausted.adopt === true &&
      exhausted.wake === true &&
      exhausted.reason === 'semantic_boundary' &&
      notExhausted.adopt === false &&
      notExhausted.wake === false,
    detail: `exhausted=${JSON.stringify(exhausted)} normal=${JSON.stringify(notExhausted)}`,
  }
})

// --- markers / env / wiring --------------------------------------------------

addCase('the evidence and boundary markers carry the measured fields', () => {
  const tracker = new StrategicStallTracker(4, 3, 2)
  replayPocket(tracker, 4)
  const evidence = tracker.evidence()
  const counter = formatStrategicNonProgressEvidence('g2:surface:log', evidence)
  const boundary = formatStrategicNonProgressExhausted('g2:surface:log', evidence)
  return {
    pass:
      STRATEGIC_NON_PROGRESS_MARKER === 'STRATEGIC_NON_PROGRESS' &&
      STRATEGIC_NON_PROGRESS_EXHAUSTED_MARKER === 'STRATEGIC_NON_PROGRESS_EXHAUSTED' &&
      counter === 'STRATEGIC_NON_PROGRESS goal=g2:surface:log window=4/4 distinct=2/3 body=4 goal_or_search=0' &&
      boundary ===
        'STRATEGIC_NON_PROGRESS_EXHAUSTED goal=g2:surface:log repeats=0 window=4/4 distinct=2/3 body=4 -> wake System2',
    detail: `${counter} | ${boundary}`,
  }
})

addCase('the bounds resolve from env with safe defaults', () => {
  const defaults =
    resolveStrategicStallHorizon({}) === STRATEGIC_STALL_HORIZON_DEFAULT &&
    resolveStrategicStallMaxDistinctStates({}) === STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT &&
    resolveStrategicStallMinBodyProgress({}) === STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT
  const override =
    resolveStrategicStallHorizon({ BUDDY_STRATEGIC_STALL_HORIZON: '12' }) === 12 &&
    resolveStrategicStallMaxDistinctStates({ BUDDY_STRATEGIC_STALL_MAX_DISTINCT: '2' }) === 2 &&
    resolveStrategicStallMinBodyProgress({ BUDDY_STRATEGIC_STALL_MIN_BODY: '1' }) === 1
  const invalid =
    resolveStrategicStallHorizon({ BUDDY_STRATEGIC_STALL_HORIZON: '0' }) === STRATEGIC_STALL_HORIZON_DEFAULT &&
    resolveStrategicStallMaxDistinctStates({ BUDDY_STRATEGIC_STALL_MAX_DISTINCT: 'nope' }) ===
      STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT &&
    resolveStrategicStallMinBodyProgress({ BUDDY_STRATEGIC_STALL_MIN_BODY: '-1' }) ===
      STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT
  return { pass: defaults && override && invalid, detail: `defaults=${defaults} override=${override} invalid=${invalid}` }
})

addCase('wiring: the controller reads the evidence at the beta boundary', () => {
  const text =
    readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/legacy/outcome-accounting.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/legacy/abandon-lifecycle.ts', import.meta.url), 'utf8').replace(/\bhost\./g, 'this.')
  const missing = [
    'StrategicStallTracker(',
    'host.strategicStall.note(',
    'this.strategicStall.acknowledgeExhaustion()',
    'formatStrategicNonProgressExhausted(',
    'semanticExhausted,',
  ].filter((needle) => !text.includes(needle))
  const facade = readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')
  const facadeMissing = ['strategicNonProgress?.exhausted === true', 'abandonRequested(decision) || semanticExhausted'].filter(
    (needle) => !facade.includes(needle),
  )
  return {
    pass: missing.length === 0 && facadeMissing.length === 0,
    detail: missing.length === 0 && facadeMissing.length === 0 ? 'controller+facade wired' : `missing ${[...missing, ...facadeMissing].join(', ')}`,
  }
})

// JevController.prototype.betaTerminationBoundary is the real production method.
type BoundaryMethod = (this: unknown, decision: JevResult, optionId: string | null) => { adopt: boolean; wake: boolean; reason: string }
const realBoundary = (JevController.prototype as unknown as { betaTerminationBoundary: BoundaryMethod }).betaTerminationBoundary

function betaDecision(beta: number): JevResult {
  return {
    callId: 'call-live-loop',
    policy: 'typesafe',
    source: 'jev',
    model: 'test',
    latencyMs: 0,
    usage: null,
    answers: {
      action: {
        name: 'action',
        type: 'choice',
        value: 'MOVE:p3_67_17',
        probability: 1,
        confidence: 1,
        probabilities: { 'MOVE:p3_67_17': 1 },
        legend: ['MOVE:p3_67_17'],
        note: null,
      },
      abandon_option: {
        name: 'abandon_option',
        type: 'boolean',
        value: 0,
        probability: beta,
        confidence: null,
        probabilities: null,
        legend: null,
        note: null,
      },
    },
  } as unknown as JevResult
}

addCase('(e) the live production boundary ends the Option on code-proven exhaustion, beta=0.25', () => {
  const tracker = new StrategicStallTracker(4, 3, 2)
  replayPocket(tracker, 4)
  const evidence = tracker.evidence()
  const lines: string[] = []
  const fake = Object.assign(Object.create(JevController.prototype) as Record<string, unknown>, {
    recentOutcomes: [
      { execution: 'success', verification: 'verified', progress: 'body', progressKinds: ['body'], control: 'none', failure: null },
    ] as unknown[],
    logger: {
      info: (_channel: string, message: string): void => {
        lines.push(message)
      },
      warn: (_channel: string, message: string): void => {
        lines.push(message)
      },
      error: (): void => undefined,
    },
    options: { betaAuthority: true },
    betaAbandonDeferral: { reset: (): void => undefined, note: (): { defer: boolean } => ({ defer: true }) },
    betaAbandonPlanId: 'g2:surface:log',
    signals: { strategicNonProgress: evidence },
    strategicStall: tracker,
    currentGoalKey: (): string => 'g2:surface:log',
  })
  // Own data property: the prototype tickCounter accessor reads reachVtrCells on
  // a real controller, so it must be shadowed rather than assigned.
  Object.defineProperty(fake, 'tickCounter', { value: 1, writable: true, configurable: true })
  const boundary = realBoundary.call(fake, betaDecision(0.25), OPTION)
  return {
    pass:
      evidence.exhausted === true &&
      boundary.adopt === true &&
      boundary.wake === true &&
      boundary.reason === 'semantic_boundary' &&
      lines.some((line) => line.startsWith(STRATEGIC_NON_PROGRESS_EXHAUSTED_MARKER)),
    detail: `beta=0.25 boundary=${JSON.stringify(boundary)} line=${lines.find((line) => line.startsWith(STRATEGIC_NON_PROGRESS_EXHAUSTED_MARKER)) ?? 'MISSING'}`,
  }
})

addCase('(e) the same production boundary still defers a healthy body-progress vote', () => {
  const lines: string[] = []
  const fake = Object.assign(Object.create(JevController.prototype) as Record<string, unknown>, {
    recentOutcomes: [
      { execution: 'success', verification: 'verified', progress: 'body', progressKinds: ['body'], control: 'none', failure: null },
    ] as unknown[],
    logger: {
      info: (_channel: string, message: string): void => {
        lines.push(message)
      },
      warn: (_channel: string, message: string): void => {
        lines.push(message)
      },
      error: (): void => undefined,
    },
    options: { betaAuthority: true },
    betaAbandonDeferral: { reset: (): void => undefined, note: (): { defer: boolean; count: number; limit: number; plan: string | null; action: string; reason: string } => ({ defer: true, count: 1, limit: 6, plan: 'g2:surface:log', action: 'MOVE:p3_67_17', reason: 'body_or_search_progress' }) },
    betaAbandonPlanId: 'g2:surface:log',
    signals: { strategicNonProgress: { exhausted: false } },
    strategicStall: new StrategicStallTracker(4, 3, 2),
    currentGoalKey: (): string => 'g2:surface:log',
  })
  // Own data property: the prototype tickCounter accessor reads reachVtrCells on
  // a real controller, so it must be shadowed rather than assigned.
  Object.defineProperty(fake, 'tickCounter', { value: 1, writable: true, configurable: true })
  const boundary = realBoundary.call(fake, betaDecision(0.25), OPTION)
  return {
    pass: boundary.adopt === false && boundary.wake === false,
    detail: JSON.stringify(boundary),
  }
})

let failures = 0
process.stdout.write('strategic non-progress / semantic-exhaustion boundary (#360 §11)\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} strategic-stall cases passed\n`)
if (failures > 0) process.exit(1)
