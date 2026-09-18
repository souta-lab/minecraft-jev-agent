// test-beta-hysteresis.mts - issue #24: hysteresis for the beta termination
// controller. Pure: no bot, no network, no model, no clock.
//
//   (a) K consecutive abandon requests flip observe -> armed -> abandoned and
//       emit `BETA_HYSTERESIS ... state=abandoned streak=K dwell=D decision=abandon`
//   (b) a single contradictory observation does not flip a committed decision
//   (c) the dwell period keeps the decision stable (anti-flapping)
//   (d) genuine progress (verified/inventory change) resets to observe
//   (e) the pure machine is deterministic for a given input sequence and has no
//       time dependence (no Date / Math.random)
//
// Extra: the unproductive-attempt corroboration trigger and the env resolver.
import { readFileSync } from 'node:fs'
import {
  BETA_COMMIT_STREAK_DEFAULT,
  BETA_DWELL_CYCLES_DEFAULT,
  BETA_UNPRODUCTIVE_LIMIT_DEFAULT,
  formatBetaHysteresis,
  initialBetaHysteresis,
  resolveBetaHysteresisConfig,
  stepBetaHysteresis,
} from './src/betaHysteresis.ts'
import type { BetaHysteresisConfig, BetaHysteresisMachineState, BetaHysteresisObservation } from './src/betaHysteresis.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const OPTION = 'smelt:iron_ingot'
const DEFAULT: BetaHysteresisConfig = resolveBetaHysteresisConfig({})
const K = DEFAULT.commitStreak
const D = DEFAULT.dwellCycles

const request = (overrides: Partial<BetaHysteresisObservation> = {}): BetaHysteresisObservation => ({
  optionId: OPTION,
  abandonRequested: true,
  progress: false,
  unproductiveAttempts: 0,
  ...overrides,
})

const contradiction = (unproductiveAttempts = 0): BetaHysteresisObservation =>
  request({ abandonRequested: false, unproductiveAttempts })

/** Drive the machine through a sequence from a fresh start. */
function runSequence(
  observations: readonly BetaHysteresisObservation[],
  config: BetaHysteresisConfig = DEFAULT,
): BetaHysteresisMachineState[] {
  const states: BetaHysteresisMachineState[] = []
  let state: BetaHysteresisMachineState | null = initialBetaHysteresis(OPTION)
  for (const observation of observations) {
    state = stepBetaHysteresis(state, observation, config)
    states.push(state)
  }
  return states
}

/** Commit an abandon with K requests and return the committed state. */
function commitState(config: BetaHysteresisConfig = DEFAULT): BetaHysteresisMachineState {
  const states = runSequence(
    Array.from({ length: config.commitStreak }, () => request()),
    config,
  )
  const last = states[states.length - 1]
  if (last === undefined) throw new Error('commitState: empty sequence')
  return last
}

addCase(`(a) #24: K=${K} consecutive requests flip to abandoned with the audit line`, () => {
  const states = runSequence([request(), request(), request()])
  const [first, second, third] = states
  if (first === undefined || second === undefined || third === undefined) {
    return { pass: false, detail: 'missing intermediate states' }
  }
  const expected =
    `BETA_HYSTERESIS optionId=${OPTION} state=abandoned streak=${K} dwell=${D} decision=abandon`
  const line = formatBetaHysteresis(third)
  const pass =
    first.state === 'armed' &&
    first.decision === 'continue' &&
    first.streak === 1 &&
    second.state === 'armed' &&
    second.decision === 'continue' &&
    second.streak === 2 &&
    third.state === 'abandoned' &&
    third.decision === 'abandon' &&
    third.streak === K &&
    third.dwell === D &&
    line === expected
  return {
    pass,
    detail: `${first.state}/${first.streak} -> ${second.state}/${second.streak} -> ${third.state}/${third.streak} | ${line}`,
  }
})

addCase('(b) #24: a single contradictory observation cannot flip a committed decision', () => {
  // dwellCycles=0 so the dwell is NOT what protects it here: the contradiction
  // counter alone must keep the commit.
  const config: BetaHysteresisConfig = { ...DEFAULT, dwellCycles: 0 }
  const committed = commitState(config)
  const afterOne = stepBetaHysteresis(committed, contradiction(), config)
  const pass =
    committed.state === 'abandoned' &&
    afterOne.state === 'abandoned' &&
    afterOne.decision === 'abandon' &&
    afterOne.contradictions === 1
  return {
    pass,
    detail: `committed=${committed.state} after1Contradiction=${afterOne.state} decision=${afterOne.decision} contradictions=${afterOne.contradictions}`,
  }
})

addCase('(c) #24: the dwell period holds the decision stable', () => {
  const config: BetaHysteresisConfig = { ...DEFAULT, dwellCycles: 4 }
  const committed = commitState(config)
  // Fold sequentially: each contradiction must build on the previous cycle.
  let state = committed
  const duringDwell: BetaHysteresisMachineState[] = []
  for (let index = 0; index < 4; index += 1) {
    state = stepBetaHysteresis(state, contradiction(), config)
    duringDwell.push(state)
  }
  const dwell = [committed.dwell, ...duringDwell.map((held) => held.dwell)]
  // Two more contradictions after the dwell: still committed (needs K=3).
  const postDwell: BetaHysteresisMachineState[] = []
  for (let index = 0; index < 2; index += 1) {
    state = stepBetaHysteresis(state, contradiction(), config)
    postDwell.push(state)
  }
  const stable = [...duringDwell, ...postDwell].every((state) => state.state === 'abandoned' && state.decision === 'abandon')
  const pass =
    dwell.join(',') === '4,3,2,1,0' &&
    stable &&
    postDwell[0]?.contradictions === 1 &&
    postDwell[1]?.contradictions === 2
  return { pass, detail: `dwell=${dwell.join(',')} stable=${stable} postDwellContradictions=${postDwell[0]?.contradictions},${postDwell[1]?.contradictions}` }
})

addCase('(d) #24: genuine progress resets to observe from committed and armed', () => {
  const committed = commitState()
  const afterProgress = stepBetaHysteresis(committed, request({ abandonRequested: false, progress: true }), DEFAULT)
  const armed = runSequence([request()], DEFAULT)[0]
  if (armed === undefined) return { pass: false, detail: 'missing armed state' }
  const armedAfterProgress = stepBetaHysteresis(armed, request({ abandonRequested: false, progress: true }), DEFAULT)
  const resetLine = formatBetaHysteresis(afterProgress)
  const expected =
    `BETA_HYSTERESIS optionId=${OPTION} state=observe streak=0 dwell=0 decision=continue`
  const pass =
    afterProgress.state === 'observe' &&
    afterProgress.decision === 'continue' &&
    afterProgress.streak === 0 &&
    afterProgress.dwell === 0 &&
    armedAfterProgress.state === 'observe' &&
    resetLine === expected
  return { pass, detail: `committed->${afterProgress.state} armed->${armedAfterProgress.state} | ${resetLine}` }
})

addCase('(e) #24: the pure machine is deterministic and has no time dependence', () => {
  const sequence: BetaHysteresisObservation[] = [
    request(),
    contradiction(),
    request(),
    request(),
    request(),
    contradiction(),
    contradiction(),
    contradiction(),
    request({ abandonRequested: false, progress: true }),
    request(),
  ]
  const first = runSequence(sequence).map(formatBetaHysteresis)
  const second = runSequence(sequence).map(formatBetaHysteresis)
  const source = readFileSync(new URL('./src/betaHysteresis.ts', import.meta.url), 'utf8')
  const timeFree = !source.includes('Date.now') && !source.includes('Math.random') && !source.includes('new Date')
  const pass = JSON.stringify(first) === JSON.stringify(second) && timeFree && first.length === sequence.length
  return { pass, detail: `identicalRuns=${JSON.stringify(first) === JSON.stringify(second)} timeFree=${timeFree} cycles=${first.length}` }
})

addCase('#24: an unproductive-attempt count corroborates a single request', () => {
  const corroborated = stepBetaHysteresis(
    initialBetaHysteresis(OPTION),
    request({ unproductiveAttempts: BETA_UNPRODUCTIVE_LIMIT_DEFAULT }),
    DEFAULT,
  )
  const notYet = stepBetaHysteresis(
    initialBetaHysteresis(OPTION),
    request({ unproductiveAttempts: BETA_UNPRODUCTIVE_LIMIT_DEFAULT - 1 }),
    DEFAULT,
  )
  const pass =
    corroborated.state === 'abandoned' &&
    corroborated.decision === 'abandon' &&
    corroborated.streak === 1 &&
    notYet.state === 'armed' &&
    notYet.decision === 'continue'
  return { pass, detail: `corroborated=${corroborated.state}/${corroborated.decision} notYet=${notYet.state}/${notYet.decision}` }
})

addCase('#24: config defaults are explicit and env-overridable', () => {
  const defaults = resolveBetaHysteresisConfig({})
  const overridden = resolveBetaHysteresisConfig({
    BUDDY_BETA_COMMIT_STREAK: '5',
    BUDDY_BETA_DWELL_CYCLES: '2',
    BUDDY_UNPRODUCTIVE_ATTEMPT_LIMIT: '4',
  })
  const invalid = resolveBetaHysteresisConfig({ BUDDY_BETA_COMMIT_STREAK: '0', BUDDY_BETA_DWELL_CYCLES: 'x' })
  const pass =
    defaults.commitStreak === BETA_COMMIT_STREAK_DEFAULT &&
    defaults.dwellCycles === BETA_DWELL_CYCLES_DEFAULT &&
    defaults.unproductiveLimit === BETA_UNPRODUCTIVE_LIMIT_DEFAULT &&
    overridden.commitStreak === 5 &&
    overridden.dwellCycles === 2 &&
    overridden.unproductiveLimit === 4 &&
    invalid.commitStreak === BETA_COMMIT_STREAK_DEFAULT &&
    invalid.dwellCycles === BETA_DWELL_CYCLES_DEFAULT
  return { pass, detail: `defaults=${JSON.stringify(defaults)} overridden=${JSON.stringify(overridden)}` }
})

let failures = 0
process.stdout.write('#24 beta hysteresis: no-flap, deterministic, auditable\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} beta-hysteresis cases passed\n`)
if (failures > 0) process.exit(1)
