// test-action-commitment.mts - action-lifecycle commitment (the flip-flop bound).
//
// Live defect (source 449cedd / m3-live, planId=g3:collect:flint):
//
//   RETRIEVE:known:obsidian:b28_67_9 x2, DESCEND:level:W:b125_66_-10 x2, WAIT x4
//   PATH_CALLBACK phase=failed actionId=DESCEND:level:W:b125_66_-10
//   position ~125,66; net movement ~0 over many minutes
//
// `Executor.claim(candidate)` cancels any DIFFERENT in-flight action first, and
// nothing bounded how often a new decision could do that. The existing flap
// commitment only arms after N changed ticks under an UNCHANGED fingerprint and
// the fingerprint includes position/inventory, so any action that moves or digs
// resets it. These cases are pure (no bot, no clock): the in-flight instance and
// `now` are injected.
//
// Authority invariant: the bound may only keep the action Jev already chose, or
// release to the raw choice. Code never substitutes a different candidate.
import { readFileSync } from 'node:fs'
import {
  ACTION_COMMIT,
  ACTION_COMMIT_HOLDS_DEFAULT,
  ACTION_COMMIT_MS_DEFAULT,
  ACTION_PREEMPT,
  evaluateActionCommitment,
  formatActionCommit,
  formatActionPreempt,
  resolveActionCommitHolds,
  resolveActionCommitMs,
} from './src/candidateCommitment.ts'
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

const PLAN = 'collect:flint:1|plan=g3:collect:flint|rev=12'
const PLAN_B = 'collect:obsidian:1|plan=g4:collect:obsidian|rev=13'
const RETRIEVE = 'RETRIEVE:known:obsidian:b28_67_9'
const DESCEND = 'DESCEND:level:W:b125_66_-10'
const WAIT = 'WAIT'
const WINDOW = 8000

const inFlight = (id: string, epoch: number, startedAtMs: number) => ({ id, epoch, startedAtMs })

function step(
  previous: ReturnType<typeof evaluateActionCommitment>['state'],
  chosenId: string,
  overrides: Partial<Parameters<typeof evaluateActionCommitment>[0]> = {},
): ReturnType<typeof evaluateActionCommitment> {
  return evaluateActionCommitment({
    previous,
    inFlight: inFlight(DESCEND, 7, 0),
    chosenId,
    planKey: PLAN,
    nowMs: 1_000,
    windowMs: WINDOW,
    inFlightInvalid: false,
    inFlightOffered: true,
    ...overrides,
  })
}

// --- (a) the chosen action is not replaced before its bounded window ---------

addCase('(a) a different choice inside the window is held with ACTION_COMMIT', () => {
  const first = step(null, RETRIEVE)
  const expected = formatActionCommit(PLAN, DESCEND, WINDOW - 1_000)
  const pass =
    first.committed &&
    first.chosenId === DESCEND &&
    first.state?.actionId === DESCEND &&
    first.state?.holds === 1 &&
    first.releaseLine === null &&
    first.line === expected &&
    first.line === `ACTION_COMMIT plan=${PLAN} action=${DESCEND} remainingMs=7000`
  return { pass, detail: `line="${first.line ?? 'none'}" chosen=${first.chosenId} holds=${first.state?.holds ?? -1}` }
})

addCase('(a) the hold persists across changing choices inside the window', () => {
  let state = null as ReturnType<typeof evaluateActionCommitment>['state']
  const choices = [RETRIEVE, WAIT, 'RETRIEVE:known:raw_iron:b9_54_-10', 'MINE:stone:b130_65_-10']
  const decisions = choices.map((chosenId, index) => {
    const decision = step(state, chosenId, { nowMs: 1_000 + index * 500 })
    state = decision.state
    return decision
  })
  const pass =
    decisions.every((decision) => decision.state?.actionId === DESCEND && decision.chosenId === DESCEND) &&
    decisions[0]?.line?.startsWith(ACTION_COMMIT) === true &&
    decisions[0]?.line === formatActionCommit(PLAN, DESCEND, 7000) &&
    decisions[3]?.line === formatActionCommit(PLAN, DESCEND, 5500) &&
    decisions.every((decision) => decision.releaseLine === null)
  return {
    pass,
    detail: `chosen=[${decisions.map((decision) => decision.chosenId).join(',')}] lines=${decisions.filter((decision) => decision.line !== null).length}`,
  }
})

addCase('(a) the window is measured from action start, not from the first switch', () => {
  const call = step(null, RETRIEVE, { nowMs: 7_999 })
  const expired = step(null, RETRIEVE, { nowMs: 8_000 })
  return {
    pass:
      call.committed === true &&
      call.state?.holds === 1 &&
      expired.committed === false &&
      expired.chosenId === RETRIEVE &&
      expired.state === null &&
      expired.releaseLine === formatActionPreempt(PLAN, DESCEND, RETRIEVE, 'window_elapsed'),
    detail: `inside=${call.committed} remaining=${call.line?.split('remainingMs=')[1] ?? 'none'} outside=${expired.releaseLine ?? 'none'}`,
  }
})

// --- (b) a settled action releases immediately ------------------------------

addCase('(b) no in-flight action releases the commitment and honors the new choice', () => {
  const held = step(null, RETRIEVE)
  const settled = evaluateActionCommitment({
    previous: held.state,
    inFlight: null,
    chosenId: WAIT,
    planKey: PLAN,
    nowMs: 2_000,
    windowMs: WINDOW,
    inFlightInvalid: false,
    inFlightOffered: true,
  })
  const pass =
    settled.state === null && settled.committed === false && settled.chosenId === WAIT && settled.line === null && settled.releaseLine === null
  return { pass, detail: `state=${settled.state} chosen=${settled.chosenId} lines=${settled.line ?? 'none'}` }
})

addCase('(b) re-selecting the running action never arms a switch or a release', () => {
  const held = step(null, RETRIEVE)
  const again = evaluateActionCommitment({
    previous: held.state,
    inFlight: inFlight(DESCEND, 7, 0),
    chosenId: DESCEND,
    planKey: PLAN,
    nowMs: 5_000,
    windowMs: WINDOW,
    inFlightInvalid: false,
    inFlightOffered: true,
  })
  return {
    pass:
      again.committed === false &&
      again.chosenId === DESCEND &&
      again.line === null &&
      again.releaseLine === null &&
      again.state?.holds === 1,
    detail: `holds=${again.state?.holds ?? -1} line=${again.line ?? 'none'}`,
  }
})

addCase('(b) a new action instance re-arms the hold instead of inheriting the old budget', () => {
  const held = step(null, RETRIEVE)
  const restarted = step(held.state, RETRIEVE, { inFlight: inFlight(DESCEND, 8, 7_000), nowMs: 7_100 })
  return {
    pass:
      restarted.committed === true &&
      restarted.state?.epoch === 8 &&
      restarted.state?.holds === 1 &&
      restarted.line === formatActionCommit(PLAN, DESCEND, 7_900),
    detail: `epoch=${restarted.state?.epoch ?? -1} holds=${restarted.state?.holds ?? -1}`,
  }
})

// --- (c) a different plan/goal resets the commitment -------------------------

addCase('(c) a plan/goal change releases with ACTION_PREEMPT reason=plan_changed', () => {
  const held = step(null, RETRIEVE)
  const changed = step(held.state, RETRIEVE, { planKey: PLAN_B })
  const pass =
    changed.committed === false &&
    changed.chosenId === RETRIEVE &&
    changed.state === null &&
    changed.releaseLine === formatActionPreempt(PLAN_B, DESCEND, RETRIEVE, 'plan_changed') &&
    changed.releaseLine?.startsWith(ACTION_PREEMPT) === true
  return { pass, detail: `release="${changed.releaseLine ?? 'none'}" chosen=${changed.chosenId}` }
})

// --- (d) no unbounded commitment: invalidation + hard bounds ------------------

addCase('(d) deterministic invalidity and vanishing release immediately', () => {
  const invalid = step(null, RETRIEVE, { inFlightInvalid: true })
  const vanished = step(null, RETRIEVE, { inFlightOffered: false })
  return {
    pass:
      invalid.releaseLine === formatActionPreempt(PLAN, DESCEND, RETRIEVE, 'deterministically_invalid') &&
      vanished.releaseLine === formatActionPreempt(PLAN, DESCEND, RETRIEVE, 'no_longer_offered') &&
      invalid.state === null &&
      vanished.state === null,
    detail: `invalid="${invalid.releaseLine ?? 'none'}" vanished="${vanished.releaseLine ?? 'none'}"`,
  }
})

addCase('(d) the decision budget releases a hung action (no infinite commitment)', () => {
  let state = null as ReturnType<typeof evaluateActionCommitment>['state']
  const choices = [WAIT, WAIT, WAIT, WAIT, WAIT, WAIT, WAIT, WAIT, WAIT]
  let last = step(state, choices[0] ?? WAIT)
  state = last.state
  for (let index = 1; index < choices.length; index += 1) {
    last = step(state, choices[index] ?? WAIT, { maxHolds: 3, nowMs: 1_000 + index * 100 })
    state = last.state
    if (last.releaseLine !== null) break
  }
  const pass =
    last.releaseLine === formatActionPreempt(PLAN, DESCEND, WAIT, 'decision_budget_exhausted') &&
    last.chosenId === WAIT &&
    last.state === null
  return { pass, detail: `release="${last.releaseLine ?? 'none'}" chosen=${last.chosenId}` }
})

addCase('(d) a released hang keeps releasing rather than re-holding forever', () => {
  const released = step(null, RETRIEVE, { nowMs: 9_000 })
  const after = step(released.state, WAIT, { nowMs: 9_100 })
  return {
    pass:
      released.releaseLine?.includes('reason=window_elapsed') === true &&
      after.committed === false &&
      after.chosenId === WAIT &&
      after.releaseLine?.includes('reason=window_elapsed') === true,
    detail: `after="${after.releaseLine ?? 'none'}"`,
  }
})

// --- resolvers + wiring -------------------------------------------------------

addCase('the commit window and hold budget resolve from env with safe defaults', () => {
  const msDefault = resolveActionCommitMs({}) === ACTION_COMMIT_MS_DEFAULT
  const msOverride = resolveActionCommitMs({ BUDDY_ACTION_COMMIT_MS: '2500' }) === 2500
  const msInvalid = resolveActionCommitMs({ BUDDY_ACTION_COMMIT_MS: 'nope' }) === ACTION_COMMIT_MS_DEFAULT
  const msZero = resolveActionCommitMs({ BUDDY_ACTION_COMMIT_MS: '0' }) === ACTION_COMMIT_MS_DEFAULT
  const holdsDefault = resolveActionCommitHolds({}) === ACTION_COMMIT_HOLDS_DEFAULT
  const holdsOverride = resolveActionCommitHolds({ BUDDY_ACTION_COMMIT_HOLDS: '2' }) === 2
  const holdsInvalid = resolveActionCommitHolds({ BUDDY_ACTION_COMMIT_HOLDS: '0' }) === ACTION_COMMIT_HOLDS_DEFAULT
  return {
    pass: msDefault && msOverride && msInvalid && msZero && holdsDefault && holdsOverride && holdsInvalid,
    detail: `ms=${msDefault}/${msOverride}/${msInvalid}/${msZero} holds=${holdsDefault}/${holdsOverride}/${holdsInvalid}`,
  }
})

addCase('the markers are exactly ACTION_COMMIT / ACTION_PREEMPT with the documented fields', () => {
  const commit = formatActionCommit('p1', 'DESCEND:x', 4321)
  const preempt = formatActionPreempt('p1', 'DESCEND:x', 'RETRIEVE:y', 'window_elapsed')
  return {
    pass:
      ACTION_COMMIT === 'ACTION_COMMIT' &&
      ACTION_PREEMPT === 'ACTION_PREEMPT' &&
      commit === 'ACTION_COMMIT plan=p1 action=DESCEND:x remainingMs=4321' &&
      preempt === 'ACTION_PREEMPT plan=p1 from=DESCEND:x to=RETRIEVE:y reason=window_elapsed',
    detail: `${commit} | ${preempt}`,
  }
})

addCase('wiring: the controller holds the in-flight action and mirrors both markers', () => {
  const text = source('./src/controller-legacy.ts')
  const missing = ['evaluateActionCommitment({', 'applyActionCommitment(', 'actionCommitmentPlanKey('].filter(
    (needle) => !text.includes(needle),
  )
  const mirrored = MIRRORED_MARKERS.has(ACTION_COMMIT) && MIRRORED_MARKERS.has(ACTION_PREEMPT)
  return {
    pass: missing.length === 0 && mirrored,
    detail: missing.length === 0 ? `mirrored=${mirrored}` : `missing ${missing.join(', ')}`,
  }
})

let failures = 0
process.stdout.write('action-lifecycle commitment: bounded completion window (#action-commitment)\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} action-commitment cases passed\n`)

if (failures > 0) process.exit(1)
