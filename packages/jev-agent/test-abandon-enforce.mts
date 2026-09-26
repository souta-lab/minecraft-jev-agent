// test-abandon-enforce.mts - issue #79: shadow mode must honor an abandon for a
// DEMONSTRABLY UNPRODUCTIVE option while still suppressing a SPECULATIVE one.
//
// Measured live: `JEV_HEADS action=ESCALATE abandon=1 decision=continue
// abandonRequested=true betaAuthority=false betaShadowed=true` repeated forever
// while `CAUSAL ... optionId=smelt:iron_ingot ... verified=false progressDelta=0`.
// This suite locks the distinction:
//
//   (a) 0 attempts in shadow mode -> ABANDON_SUPPRESSED ... action=continue
//   (b) N unverified zero-progress attempts -> ABANDON_ENFORCED even with
//       betaAuthority=false
//   (c) the next ladder rung is selected and the abandoned one is not retried
//   (d) the per-option counter resets after verified progress
//   (e) a never-attempted smoke option stays protected before its prereq runs
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
    attempts: state.attempts,
    lastVerified: state.verified,
    lastProgressDelta: state.progressDelta,
    attemptLimit: LIMIT,
    alreadyAbandoned: false,
    ...overrides,
  })
}

addCase('(a) #79: a first-attempt abandon vote stands; only cooldown suppresses it', () => {
  const tracker = new OptionAttemptTracker()
  const classification = classify(tracker)
  const cooling = classify(tracker, { alreadyAbandoned: true })
  const line = formatAbandonSuppressed({ optionId: OPTION, reason: 'cooldown', attempts: cooling.attempts })
  const expected = `ABANDON_SUPPRESSED optionId=${OPTION} reason=cooldown attempts=0 action=continue`
  const pass =
    classification.action === 'abandon' &&
    classification.enforced === false &&
    classification.reason === 'authority' &&
    cooling.action === 'continue' &&
    cooling.reason === 'cooldown' &&
    line === expected
  return { pass, detail: `${line} | first=${classification.action}/${classification.reason}` }
})

addCase('(b) #79: after N unverified zero-progress attempts the Option is recorded as demonstrably unproductive', () => {
  const tracker = new OptionAttemptTracker()
  unproductive(tracker, LIMIT)
  const state = tracker.stateFor(OPTION, PLAN)
  const classification = classify(tracker)
  const line = formatAbandonEnforced({
    optionId: OPTION,
    attempts: classification.attempts,
    verified: classification.verified,
    progressDelta: classification.progressDelta,
    abandonRequested: true,
  })
  const expected =
    `ABANDON_ENFORCED optionId=${OPTION} reason=unproductive attempts=${LIMIT} verified=false progress=0 ` +
    `abandonRequested=true action=abandon`
  const pass =
    state.attempts === LIMIT &&
    classification.action === 'abandon' &&
    classification.enforced === true &&
    classification.reason === 'unproductive' &&
    line === expected
  return { pass, detail: `${line} | attempts=${state.attempts}` }
})

addCase('(c) #79: the next ladder rung is selected; the abandoned one is not retried', () => {
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

addCase('(d) #79: the counter resets after verified progress', () => {
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
    resetClassification.enforced === false &&
    resetClassification.reason === 'authority' &&
    progressOnly.attemptsFor(OPTION, PLAN) === 0
  return {
    pass,
    detail: `before=${before} afterVerified=${afterVerified.attempts} afterProgressOnly=${progressOnly.attemptsFor(OPTION, PLAN)}`,
  }
})

addCase('(e) #79: a never-attempted smelt option stays protected before its prereq runs', () => {
  const smeltGoal: GoalLike = { kind: 'smelt', targetItem: 'iron_ingot' }
  const vote = betaAuthorityDecision({
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
    classification.enforced === false &&
    classification.attempts === 0
  return { pass, detail: `protect=${vote.protection.protect} adopt=${vote.adopt} enforced=${classification.enforced}` }
})

addCase('#79 wiring: the authority facade preserves the legacy attempt/enforcement mechanics', () => {
  const facade = source('./src/controller.ts')
  const mechanics =
    source('./src/controller.ts') +
    source('./src/decision-epochs.ts').replace(/\bhost\./g, 'this.') +
    source('./src/outcome-accounting.ts').replace(/\bhost\./g, 'this.') +
    source('./src/abandon-lifecycle.ts').replace(/\bhost\./g, 'this.')
  const missing = [
    'classifyAbandonRequest({',
    'optionAttempts.noteOutcome(',
    'formatAbandonEnforced(',
    'formatAbandonSuppressed(',
    'enforceUnproductiveAbandon(',
  ].filter((needle) => !mechanics.includes(needle))
  const controllerOwnsAuthority =
    facade.includes('abandonVerdict(decision: JevResult') &&
    facade.includes('this.betaTerminationBoundary(decision, optionId)')
  return {
    pass: missing.length === 0 && controllerOwnsAuthority,
    detail: missing.length === 0 && controllerOwnsAuthority
      ? 'legacy attempt/enforcement mechanics + controller authority seam wired'
      : `missing ${[...missing, ...(controllerOwnsAuthority ? [] : ['controller abandonVerdict seam'])].join(', ')}`,
  }
})

let failures = 0
process.stdout.write('#79 abandon enforcement: unproductive evidence + guarded vote\n')
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
