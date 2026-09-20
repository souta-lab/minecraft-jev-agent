// test-abandon-enforce.mts - issue #79 explicit legacy/shadow baseline:
// a demonstrably unproductive option may be retired by the historical attempt
// budget while a speculative one remains protected. The normal #11 resident
// path is beta-authoritative and controller.ts strangles this semantic override;
// this file keeps the old mechanism covered as an explicit A/B baseline.
//
// Pure: no bot, no network, no model.
import { readFileSync } from 'node:fs'
import {
  classifyAbandonRequest,
  formatAbandonEnforced,
  formatAbandonSuppressed,
  OptionAttemptTracker,
  selectLadderOption,
  UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT,
} from './src/abandonPolicy.ts'
import { planPrereqOptions } from './src/prereqOption.ts'
import type { PrereqInput } from './src/prereqOption.ts'
import { betaAuthorityDecision } from './src/betaAuthority.ts'
import type { GoalLike } from './src/placementGuard.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const runtimeControllerSource = (): string =>
  `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`

const OPTION = 'smelt:iron_ingot'
const PLAN = 'g41:smelt:iron_ingot'
const LIMIT = UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT

function unproductive(tracker: OptionAttemptTracker, count: number, now = 1_000): void {
  for (let index = 0; index < count; index += 1) {
    tracker.noteOutcome({ optionId: OPTION, planId: PLAN, verified: false, progressDelta: 0 }, now + index)
  }
}

function classify(
  tracker: OptionAttemptTracker,
  overrides: Partial<Parameters<typeof classifyAbandonRequest>[0]> = {},
): ReturnType<typeof classifyAbandonRequest> {
  const state = tracker.stateFor(OPTION, PLAN)
  return classifyAbandonRequest({
    abandonRequested: true,
    betaAuthority: false,
    attempts: state.attempts,
    lastVerified: state.verified,
    lastProgressDelta: state.progressDelta,
    attemptLimit: LIMIT,
    alreadyAbandoned: false,
    ...overrides,
  })
}

addCase('(a) #79 baseline: a speculative (0-attempt) request is suppressed in explicit shadow mode', () => {
  const tracker = new OptionAttemptTracker()
  const classification = classify(tracker)
  const line = formatAbandonSuppressed({ optionId: OPTION, reason: 'speculative', attempts: classification.attempts })
  const expected = `ABANDON_SUPPRESSED optionId=${OPTION} reason=speculative attempts=0 mode=shadow action=continue`
  const pass =
    classification.action === 'continue' &&
    classification.suppressed === true &&
    classification.enforced === false &&
    classification.reason === 'speculative' &&
    line === expected
  return { pass, detail: `${line} | action=${classification.action} reason=${classification.reason}` }
})

addCase('(b) #79 baseline: after N unverified zero-progress attempts the shadow baseline enforces abandon', () => {
  const tracker = new OptionAttemptTracker()
  unproductive(tracker, LIMIT)
  const state = tracker.stateFor(OPTION, PLAN)
  const classification = classify(tracker)
  const line = formatAbandonEnforced({
    optionId: OPTION,
    attempts: classification.attempts,
    verified: classification.verified,
    progressDelta: classification.progressDelta,
    betaAuthority: false,
    betaShadowed: true,
    abandonRequested: true,
  })
  const expected =
    `ABANDON_ENFORCED optionId=${OPTION} reason=unproductive attempts=${LIMIT} verified=false progress=0 ` +
    `betaAuthority=false betaShadowed=true abandonRequested=true action=abandon`
  const pass =
    state.attempts === LIMIT &&
    classification.action === 'abandon' &&
    classification.enforced === true &&
    classification.reason === 'unproductive' &&
    line === expected
  return { pass, detail: `${line} | attempts=${state.attempts}` }
})

addCase('(c) #79 baseline: the next ladder rung is selected; the abandoned one is not retried', () => {
  const input: PrereqInput = {
    goal: { kind: 'smelt', targetItem: 'iron_ingot' },
    heldCount: 1,
    placedCount: 0,
    stoneCount: 112,
    tableAvailable: false,
    placementSpot: { x: 30, y: 61, z: 35 },
    knownStation: { name: 'furnace', position: { x: 22, y: 66, z: 29 } },
    self: { x: 29, y: 61, z: 35 },
  }
  const decision = planPrereqOptions(input)
  const base = selectLadderOption(decision.options, new Set<string>())
  const next = selectLadderOption(decision.options, new Set<string>(['place_held']))
  const escalate = selectLadderOption(
    decision.options,
    new Set<string>(['place_held', 'use_known_station', 'craft_and_place']),
  )
  const baseIsChosen = base === 'place_held'
  const nextIsSecond = next === 'use_known_station'
  const nextDiffers = next !== base
  const pass =
    decision.chosen === 'place_held' && baseIsChosen && nextIsSecond && nextDiffers && escalate === null
  return { pass, detail: `chosen=${decision.chosen} base=${base} afterAbandon=${next} allAbandoned=${escalate}` }
})

addCase('(d) #79 baseline: the counter resets after verified progress', () => {
  const tracker = new OptionAttemptTracker()
  unproductive(tracker, LIMIT)
  const before = tracker.attemptsFor(OPTION, PLAN)
  tracker.noteOutcome({ optionId: OPTION, planId: PLAN, verified: true, progressDelta: 1 }, 2_000)
  const afterVerified = tracker.stateFor(OPTION, PLAN)
  const resetClassification = classify(tracker)
  const progressOnly = new OptionAttemptTracker()
  unproductive(progressOnly, 2, 5_000)
  progressOnly.noteOutcome({ optionId: OPTION, planId: PLAN, verified: false, progressDelta: 2 }, 6_000)
  const pass =
    before === LIMIT &&
    afterVerified.attempts === 0 &&
    afterVerified.abandonedAtMs === null &&
    resetClassification.action === 'continue' &&
    resetClassification.reason === 'speculative' &&
    progressOnly.attemptsFor(OPTION, PLAN) === 0
  return {
    pass,
    detail: `before=${before} afterVerified=${afterVerified.attempts} afterProgressOnly=${progressOnly.attemptsFor(OPTION, PLAN)}`,
  }
})

addCase('(e) #79 baseline: a never-attempted smelt option stays protected before its prereq runs', () => {
  const smeltGoal: GoalLike = { kind: 'smelt', targetItem: 'iron_ingot' }
  const vote = betaAuthorityDecision({
    betaAuthority: false,
    abandonRequested: true,
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  const tracker = new OptionAttemptTracker()
  const classification = classify(tracker)
  const pass =
    vote.protection.protect === true &&
    vote.adopt === false &&
    vote.shadowed === true &&
    classification.action === 'continue' &&
    classification.enforced === false &&
    classification.attempts === 0
  return { pass, detail: `protect=${vote.protection.protect} adopt=${vote.adopt} enforced=${classification.enforced}` }
})

addCase('#295 wiring: the runtime composition records legacy attempts/markers and the facade owns the real-beta verdict', () => {
  const text = runtimeControllerSource()
  const missing = [
    'classifyAbandonRequest({',
    'optionAttempts.noteOutcome(',
    'formatAbandonEnforced(',
    'formatAbandonSuppressed(',
    'enforceUnproductiveAbandon(',
    'internals.abandonVerdict = (decision, optionId, planId) => {',
    'const adopt = abandonRequested(decision)',
  ].filter((needle) => !text.includes(needle))
  return {
    pass: missing.length === 0,
    detail: missing.length === 0 ? 'legacy baseline + authority facade both wired' : `missing ${missing.join(', ')}`,
  }
})

let failures = 0
process.stdout.write('#79/#295 abandon baseline + authority-facade wiring\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} abandon-enforce cases passed\n`)

if (failures > 0) process.exit(1)
