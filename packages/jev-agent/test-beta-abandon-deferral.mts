// test-beta-abandon-deferral.mts - bound the beta-abandon deferral on a control
// action so a starved plan cannot suppress its own abandon forever.
//
// Live freeze (source d428d1c, m3-live):
//
//   planId=g3:collect:flint   (stable; the body is frozen at one position)
//   BETA_DEFERRED optionId=front_nether_portal planId=g3:collect:flint beta=0.52
//                 reason=control_action action=WAIT
//   BETA_SHADOW   optionId=front_nether_portal beta=0.52 threshold=0.5
//                 would=abandon actual=continue agree=false mode=authority
//   JEV_HEADS     action=WAIT abandon=0.53 decision=continue abandonRequested=true
//                 betaAuthority=true betaShadowed=false abandonEnforced=false
//                 abandonSuppressed=true attempts=74
//   ACTION        n=746..748 id=WAIT kind=WAIT phase=waiting
//
// `evaluateBetaTerminationBoundary` refuses to cross the lifecycle boundary for
// `decisionActionId` WAIT/ESCALATE (reason=control_action) and for a control
// `latestOutcome` (reason=control_outcome). That is correct for ONE decision:
// do not yank a running action. It is circular when the plan is starved
// (`presented=1 productive=0 blockedBy=no_productive_action`): WAIT suppresses
// the abandon, and suppressing the abandon keeps WAIT. The #343
// WAIT_STREAK/WAIT_EXHAUSTED counters cannot see the shape either, because they
// only count while `actionable > 0`.
//
// These cases are pure/isolated. The counter bounds the DEFERRAL of beta's own
// vote; it never selects an Option or ranks candidates.
import { readFileSync } from 'node:fs'
import {
  BETA_ABANDON_DEFER_CYCLES_DEFAULT,
  BETA_ABANDON_DEFERRED_MARKER,
  BETA_ABANDON_RELEASED_MARKER,
  BetaAbandonDeferral,
  formatBetaAbandonDeferred,
  formatBetaAbandonReleased,
  resolveBetaAbandonDeferCycles,
} from './src/replanThrottle.ts'
import { evaluateBetaTerminationBoundary } from './src/system2/escalation.ts'
import { JevController, MIRRORED_MARKERS } from './src/controller.ts'
import { actionDeclined, decisionIdFrom } from './src/jev.ts'
import type { JevResult } from './src/jev.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const GOAL = 'g3:collect:flint'
const OPTION = 'front_nether_portal'
const ACTION = 'WAIT'

/** Minimal legacy-beta JevResult: beta crosses the default 0.5 threshold. */
function decision(action: string, beta: number): JevResult {
  return {
    callId: `call-${action}`,
    policy: 'typesafe',
    source: 'jev',
    model: 'test',
    latencyMs: 0,
    usage: null,
    answers: {
      action: {
        name: 'action',
        type: 'choice',
        value: action,
        probability: 1,
        confidence: 1,
        probabilities: { [action]: 1 },
        legend: [action],
        note: null,
      },
      abandon_option: {
        name: 'abandon_option',
        type: 'boolean',
        value: 1,
        probability: beta,
        confidence: null,
        probabilities: null,
        legend: null,
        note: null,
      },
    },
  } as unknown as JevResult
}

const productiveOutcome = {
  execution: 'success',
  verification: 'verified',
  progress: 'body',
  progressKinds: ['body'],
  control: 'none',
  failure: null,
}
const noProgressOutcome = {
  execution: 'failure',
  verification: 'unverified',
  progress: 'none',
  progressKinds: ['none'],
  control: 'none',
  failure: 'path_stuck',
}

interface Boundary {
  adopt: boolean
  wake: boolean
  reason: string
}

type BoundaryMethod = (this: unknown, decision: JevResult, optionId: string | null) => Boundary

// The real production method (inherited from controller.ts). We invoke it
// with an isolated `this` so the bounded deferral is exercised behaviourally,
// not by matching source text.
const realBoundary = (JevController.prototype as unknown as { betaTerminationBoundary: BoundaryMethod })
  .betaTerminationBoundary

interface Harness {
  readonly lines: string[]
  plan(id: string | null): void
  call(decision: JevResult, outcome?: unknown): Boundary
}

function makeHarness(planId: string | null, limit: number): Harness {
  const lines: string[] = []
  const fake = Object.assign(Object.create(JevController.prototype) as Record<string, unknown>, {
    recentOutcomes: [] as unknown[],
    logger: {
      info: (_channel: string, message: string): void => {
        lines.push(message)
      },
      warn: (_channel: string, message: string): void => {
        lines.push(message)
      },
      error: (): void => {},
    },
    options: { betaAuthority: true },
    betaAbandonDeferral: new BetaAbandonDeferral(limit),
    betaAbandonPlanId: planId,
    lastBetaAbandonProgressOutcome: null,
    // This fixture's productive body outcomes represent observed efficient
    // locomotion. Idle/unobserved body evidence is covered in
    // test-locomotion-progress.mts and does not hold the beta deferral open.
    lastLocomotionObservation: { kind: 'moving', samples: 40, traveled: 10, net: 10, efficiency: 100 } as const,
    signals: {},
    strategicStall: { acknowledgeExhaustion: () => ({}) },
    currentGoalKey: () => GOAL,
  })
  // Own data property so the prototype's tickCounter accessor (which reads
  // reachVtrCells on a real controller) is shadowed on this bare fixture.
  Object.defineProperty(fake, 'tickCounter', { value: 0, writable: true, configurable: true })
  return {
    lines,
    plan(id: string | null): void {
      fake.betaAbandonPlanId = id
    },
    call(decisionResult: JevResult, outcome: unknown = null): Boundary {
      fake.recentOutcomes = outcome === null ? [] : [outcome]
      return realBoundary.call(fake, decisionResult, OPTION)
    },
  }
}

const countOf = (lines: readonly string[], marker: string): number =>
  lines.filter((line) => line.startsWith(marker)).length

// --- the live defect, at the pure boundary layer ------------------------------

addCase('defect: the pure boundary defers a WAIT abandon unconditionally', () => {
  const votes = Array.from({ length: 50 }, () =>
    evaluateBetaTerminationBoundary({
      optionId: OPTION,
      requested: true,
      decisionActionId: 'WAIT',
      latestOutcome: null,
      semanticExhausted: false,
      semanticInvalid: false,
    }),
  )
  return {
    pass: votes.every((vote) => !vote.adopt && !vote.wake && vote.reason === 'control_action'),
    detail: `50/50 WAIT votes reason=control_action adopt=false -> the bound must live above this pure gate`,
  }
})

// --- (a) WAIT-only deferral releases at N, then restarts (no hot-loop) ---------

addCase('(a) WAIT-only abandon is deferred at most N times and then released', () => {
  const harness = makeHarness(GOAL, 3)
  const one = harness.call(decision(ACTION, 0.52))
  const two = harness.call(decision(ACTION, 0.52))
  const three = harness.call(decision(ACTION, 0.52))
  const deferred = harness.lines.filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
  return {
    pass:
      !one.adopt &&
      !two.adopt &&
      three.adopt === true &&
      three.wake === true &&
      three.reason === 'semantic_abandon' &&
      deferred.length === 2 &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 1,
    detail: `counts=${deferred.join(' | ')} release=${harness.lines.find((line) => line.startsWith(BETA_ABANDON_RELEASED_MARKER)) ?? 'MISSING'}`,
  }
})

addCase('(a) release clears the streak, so the next abandon needs N fresh deferrals', () => {
  const harness = makeHarness(GOAL, 2)
  const one = harness.call(decision(ACTION, 0.52))
  const released = harness.call(decision(ACTION, 0.52))
  const after = harness.call(decision(ACTION, 0.52))
  const afterAgain = harness.call(decision(ACTION, 0.52))
  const deferred = harness.lines.filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
  return {
    pass:
      !one.adopt &&
      released.adopt === true &&
      after.adopt === false &&
      afterAgain.adopt === true &&
      deferred.length === 2 &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 2,
    detail: `released=${released.adopt} then=${after.adopt},${afterAgain.adopt} deferrals=${deferred.length} releases=${countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER)}`,
  }
})

addCase('(a) no abandon request is not a deferred streak', () => {
  const harness = makeHarness(GOAL, 2)
  const one = harness.call(decision(ACTION, 0.1))
  const two = harness.call(decision(ACTION, 0.2))
  return {
    pass: !one.adopt && !two.adopt && harness.lines.length === 0,
    detail: `lines=${harness.lines.length} (below threshold emits no counter marker)`,
  }
})

// --- (b) a genuinely productive in-flight action keeps its deferral ------------

addCase('(b) each fresh verified body outcome grants one deferral', () => {
  const harness = makeHarness(GOAL, 3)
  const votes = Array.from({ length: 10 }, (_, index) =>
    harness.call(decision(ACTION, 0.52), { ...productiveOutcome, actionId: `MOVE:${index}` }),
  )
  const deferredCounts = harness.lines
    .filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
    .map((line) => line.split(' ')[1])
  return {
    pass:
      votes.every((vote) => !vote.adopt) &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 0 &&
      deferredCounts.every((field) => field === 'count=0/3'),
    detail: `fresh outcomes=${votes.length}, released=${countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER)}, counts=[${deferredCounts.join(',')}]`,
  }
})

addCase('(b) the same cached search outcome cannot defer DECLINE forever', () => {
  const harness = makeHarness(GOAL, 3)
  const searchOutcome = {
    actionId: 'MINE:ceiling',
    status: 'success',
    failure: null,
    verified: true,
    detail: 'cleared one route block',
    execution: 'success',
    verification: 'verified',
    progress: 'search',
    progressKinds: ['search'],
    control: 'none',
  }
  const first = harness.call(declineDecision(0.6), searchOutcome)
  const second = harness.call(declineDecision(0.6), searchOutcome)
  const third = harness.call(declineDecision(0.6), searchOutcome)
  const released = harness.call(declineDecision(0.6), searchOutcome)
  const deferredCounts = harness.lines
    .filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
    .map((line) => line.split(' ')[1])
  return {
    pass:
      [first, second, third].every((vote) => !vote.adopt && vote.reason === 'body_or_search_progress') &&
      released.adopt === true && released.wake === true && released.reason === 'semantic_abandon' &&
      deferredCounts.join(',') === 'count=0/3,count=1/3,count=2/3' &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 1,
    detail: `same outcome counts=[${deferredCounts.join(',')}] release=${released.adopt}/${released.reason}`,
  }
})

addCase('low-probability singleton DECLINE with stale search progress hands off within nine epochs', () => {
  const harness = makeHarness(GOAL, BETA_ABANDON_DEFER_CYCLES_DEFAULT)
  const refusal = declineDecision(0.060086646807761206)
  const searchOutcome = {
    actionId: 'MINE:ceiling',
    status: 'success',
    failure: null,
    verified: true,
    detail: 'cleared one route block',
    execution: 'success',
    verification: 'verified',
    progress: 'search',
    progressKinds: ['search'],
    control: 'none',
  }
  const votes = Array.from({ length: 9 }, () => harness.call(refusal, searchOutcome))
  const released = votes.findIndex((vote) => vote.adopt && vote.wake && vote.reason === 'semantic_abandon')
  const releaseCount = votes.filter((vote) => vote.adopt || vote.wake).length
  const deferredCounts = harness.lines
    .filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
    .map((line) => line.split(' ')[1])
  const expectedBeforeRelease = [
    `count=0/${BETA_ABANDON_DEFER_CYCLES_DEFAULT}`,
    ...Array.from({ length: BETA_ABANDON_DEFER_CYCLES_DEFAULT - 1 }, (_, index) =>
      `count=${index + 1}/${BETA_ABANDON_DEFER_CYCLES_DEFAULT}`),
  ]
  return {
    pass:
      refusal.answers.action?.value === 'DECLINE' &&
      refusal.answers.abandon_option?.probability === 0.060086646807761206 &&
      actionDeclined(refusal) &&
      decisionIdFrom(refusal) === null &&
      released >= 0 && released < 9 &&
      releaseCount === 1 &&
      votes.every((vote, index) => index === released || (!vote.adopt && !vote.wake)) &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 1 &&
      deferredCounts.slice(0, released).join(',') === expectedBeforeRelease.join(','),
    detail: `p=${refusal.answers.abandon_option?.probability} decline=${actionDeclined(refusal)} actuationId=${decisionIdFrom(refusal)} releaseEpoch=${released < 0 ? 'none' : released + 1}/9 deferred=[${deferredCounts.join(',')}]`,
  }
})

addCase('(b) a control outcome that still made progress resets the streak', () => {
  const harness = makeHarness(GOAL, 3)
  harness.call(decision('MINE:oak_log', 0.52), noProgressOutcome)
  harness.call(decision('MINE:oak_log', 0.52), noProgressOutcome)
  const progressed = harness.call(decision('MINE:oak_log', 0.52), { ...productiveOutcome, control: 'wait' })
  const resumed = harness.call(decision('MINE:oak_log', 0.52), noProgressOutcome)
  const counts = harness.lines
    .filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
    .map((line) => line.split(' ')[1])
  return {
    pass:
      !progressed.adopt &&
      progressed.reason === 'control_outcome' &&
      !resumed.adopt &&
      counts.join(',') === 'count=1/3,count=2/3,count=0/3,count=1/3' &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 0,
    detail: `progressed=${progressed.reason} counts=[${counts.join(',')}] releases=${countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER)}`,
  }
})

// --- (c) progress / plan change resets the counter -----------------------------

addCase('(c) verified progress resets the deferral counter', () => {
  const harness = makeHarness(GOAL, 3)
  harness.call(decision(ACTION, 0.52), noProgressOutcome)
  harness.call(decision(ACTION, 0.52), noProgressOutcome)
  const progressed = harness.call(decision(ACTION, 0.52), productiveOutcome)
  const resumed = harness.call(decision(ACTION, 0.52), noProgressOutcome)
  const counts = harness.lines
    .filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
    .map((line) => line.split(' ')[1])
  return {
    pass: !progressed.adopt && !resumed.adopt && counts.join(',') === 'count=1/3,count=2/3,count=0/3,count=1/3',
    detail: `counts=[${counts.join(',')}]`,
  }
})

addCase('(c) a different plan restarts the streak instead of carrying it over', () => {
  const harness = makeHarness(GOAL, 4)
  harness.call(decision(ACTION, 0.52))
  harness.call(decision(ACTION, 0.52))
  harness.plan('g3:collect:obsidian')
  const newPlanOne = harness.call(decision(ACTION, 0.52))
  const newPlanTwo = harness.call(decision(ACTION, 0.52))
  const counts = harness.lines
    .filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
    .map((line) => line.split(' ')[1])
  return {
    pass:
      !newPlanOne.adopt &&
      !newPlanTwo.adopt &&
      counts.join(',') === 'count=1/4,count=2/4,count=1/4,count=2/4' &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 0,
    detail: `counts=[${counts.join(',')}]`,
  }
})

// --- (d) the live phase-alternation defect -------------------------------------
//
// Live fingerprint (run-muvh4ofl / gen-muvip6au, 2026-10-05T17:37Z): a starved
// `explore:surface` offer kept electing WAIT while beta held >0.5 for ~30
// epochs. The deferral alternated `control_action` (the model picked WAIT) and
// `control_outcome` (the model declined / no actionId, and the settled outcome
// was a control WAIT) — both reported `action=WAIT`, plan stable — so the
// raw-reason streak key reset at every flip and the count never exceeded 2/6.
// The suppression loop the bound exists to break could never reach the limit.

const waitControlOutcome = {
  execution: 'success',
  verification: 'not_applicable',
  progress: 'none',
  progressKinds: ['none'],
  control: 'wait',
  failure: null,
}

/** A decision whose action answer is the decline label -> decisionIdFrom null. */
function declineDecision(beta: number): JevResult {
  return {
    callId: 'call-decline',
    policy: 'typesafe',
    source: 'jev',
    model: 'test',
    latencyMs: 0,
    usage: null,
    answers: {
      action: {
        name: 'action',
        type: 'choice',
        value: 'DECLINE',
        probability: 1,
        confidence: 1,
        probabilities: { DECLINE: 1 },
        legend: ['DECLINE'],
        note: null,
      },
      abandon_option: {
        name: 'abandon_option',
        type: 'boolean',
        value: beta,
        probability: beta,
        confidence: null,
        probabilities: null,
        legend: null,
        note: null,
      },
    },
  } as unknown as JevResult
}

addCase('(d) alternating control_action/control_outcome is ONE control suppression and releases at N', () => {
  const harness = makeHarness(GOAL, 3)
  const one = harness.call(decision(ACTION, 0.6), null) // control_action
  const two = harness.call(declineDecision(0.6), waitControlOutcome) // control_outcome, action=WAIT
  const three = harness.call(decision(ACTION, 0.6), null) // control_action -> released
  const deferred = harness.lines.filter((line) => line.startsWith(BETA_ABANDON_DEFERRED_MARKER))
  return {
    pass:
      !one.adopt &&
      !two.adopt &&
      three.adopt === true &&
      three.wake === true &&
      three.reason === 'semantic_abandon' &&
      deferred.length === 2 &&
      countOf(harness.lines, BETA_ABANDON_RELEASED_MARKER) === 1,
    detail: `deferred=[${deferred.join(' | ')}] release=${harness.lines.find((line) => line.startsWith(BETA_ABANDON_RELEASED_MARKER)) ?? 'MISSING'}`,
  }
})

addCase('(d) the counter accumulates the control family under both phase labels', () => {
  const counter = new BetaAbandonDeferral(4)
  const counts = [
    counter.note({ plan: GOAL, action: ACTION, reason: 'control_action' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'control_outcome' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'control_action' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'control_outcome' }),
  ]
  return {
    pass:
      counts[0]!.count === 1 &&
      counts[1]!.count === 2 &&
      counts[2]!.count === 3 &&
      counts[3]!.released === true &&
      counts[3]!.reason === 'control_outcome',
    detail: `counts=[${counts.map((d) => `${d.count}${d.released ? ':released' : ''}`).join(',')}]`,
  }
})

addCase('(d) a genuinely different deferral cause still resets the streak', () => {
  const counter = new BetaAbandonDeferral(4)
  const counts = [
    counter.note({ plan: GOAL, action: ACTION, reason: 'control_action' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'control_action' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'local_recovery' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'local_recovery' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'local_recovery' }),
    counter.note({ plan: GOAL, action: ACTION, reason: 'local_recovery' }),
  ]
  return {
    pass:
      counts[1]!.count === 2 &&
      counts[2]!.count === 1 &&
      counts[5]!.released === true &&
      counts[5]!.reason === 'local_recovery',
    detail: `counts=[${counts.map((d) => `${d.reason}=${d.count}${d.released ? ':released' : ''}`).join(',')}]`,
  }
})

// --- pure counter + markers + env ---------------------------------------------

addCase('the counter releases at exactly N for the same (plan, action, reason)', () => {
  const counter = new BetaAbandonDeferral(6)
  const first = counter.note({ plan: GOAL, action: ACTION, reason: 'control_action' })
  const sixth = Array.from({ length: 5 }, () => counter.note({ plan: GOAL, action: ACTION, reason: 'control_action' })).at(-1)
  const cleared = counter.count()
  const ninth = counter.note({ plan: GOAL, action: ACTION, reason: 'control_action' })
  return {
    pass:
      first.count === 1 &&
      first.defer &&
      sixth?.count === 6 &&
      sixth?.defer === false &&
      sixth?.released === true &&
      cleared === 0 &&
      ninth.count === 1,
    detail: `first=${first.count} sixth=${sixth?.count}/${sixth?.limit} released=${sixth?.released} afterRelease=${ninth.count}`,
  }
})

addCase('the beta-abandon markers carry the documented fields', () => {
  const deferred = formatBetaAbandonDeferred({
    defer: true,
    count: 3,
    limit: 6,
    plan: GOAL,
    action: ACTION,
    reason: 'control_action',
    released: false,
  })
  const released = formatBetaAbandonReleased(GOAL, ACTION, 'control_action', 0.52)
  return {
    pass:
      BETA_ABANDON_DEFERRED_MARKER === 'BETA_ABANDON_DEFERRED' &&
      BETA_ABANDON_RELEASED_MARKER === 'BETA_ABANDON_RELEASED' &&
      deferred === `BETA_ABANDON_DEFERRED count=3/6 plan=${GOAL} action=${ACTION} reason=control_action` &&
      released === `BETA_ABANDON_RELEASED plan=${GOAL} action=${ACTION} beta=0.52 reason=control_action`,
    detail: `${deferred} | ${released}`,
  }
})

addCase('the deferral bound resolves from env with safe defaults', () => {
  const defaults = resolveBetaAbandonDeferCycles({}) === BETA_ABANDON_DEFER_CYCLES_DEFAULT
  const override = resolveBetaAbandonDeferCycles({ BUDDY_BETA_ABANDON_DEFER_CYCLES: '3' }) === 3
  const invalid = resolveBetaAbandonDeferCycles({ BUDDY_BETA_ABANDON_DEFER_CYCLES: 'nope' }) === BETA_ABANDON_DEFER_CYCLES_DEFAULT
  const zero = resolveBetaAbandonDeferCycles({ BUDDY_BETA_ABANDON_DEFER_CYCLES: '0' }) === BETA_ABANDON_DEFER_CYCLES_DEFAULT
  return { pass: defaults && override && invalid && zero, detail: `defaults=${defaults} override=${override} invalid=${invalid} zero=${zero}` }
})

addCase('wiring: the controller owns the bound and mirrors the markers', () => {
  const text =
    readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/abandon-lifecycle.ts', import.meta.url), 'utf8').replace(/\bhost\./g, 'this.')
  const missing = [
    'new BetaAbandonDeferral(',
    'betaAbandonDeferral.note(',
    'formatBetaAbandonDeferred(',
    'formatBetaAbandonReleased(',
    "reason: 'semantic_abandon'",
  ].filter((needle) => !text.includes(needle))
  const mirrored =
    MIRRORED_MARKERS.has(BETA_ABANDON_DEFERRED_MARKER) && MIRRORED_MARKERS.has(BETA_ABANDON_RELEASED_MARKER)
  return {
    pass: missing.length === 0 && mirrored,
    detail: missing.length === 0 ? `mirrored=${mirrored}` : `missing ${missing.join(', ')}`,
  }
})

let failures = 0
process.stdout.write('beta-abandon deferral bound (control-action circular suppression)\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} beta-abandon-deferral cases passed\n`)

if (failures > 0) process.exit(1)
