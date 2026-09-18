// test-replan-throttle.mts - deterministic proof of the #44 replan throttle,
// new-information gate and body-delta requirement. No bot, no network, injected
// clock: the whole policy is exercised as pure functions.
import {
  DEFAULT_CAPABILITY_GAP_POLICY,
  evaluateCapabilityGap,
  formatCapabilityGap,
  formatCapabilityGapPolicy,
  formatReplanThrottled,
  hasBodyDelta,
  hashReplanInputs,
  parseCapabilityGap,
  ReplanThrottle,
  REPLAN_THROTTLE_WINDOW_MS_DEFAULT,
  replanInputsChanged,
  resolveReplanPositionDelta,
  resolveReplanThrottleMs,
} from './src/replanThrottle.ts'
import type { CapabilityGapState, ReplanInputs } from './src/replanThrottle.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const inputs = (over: Partial<ReplanInputs> = {}): ReplanInputs => ({
  inventory: { oak_log: 2, cobblestone: 27 },
  position: { x: 29, y: 60, z: 34 },
  knownResources: 128,
  failureSignature: 'WAIT:no_progress',
  capabilityGap: null,
  ...over,
})

addCase('a first replan for a reason is allowed (fresh)', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  const decision = throttle.tryReplan('no_progress', inputs(), 1_000)
  return {
    pass: decision.allow && decision.kind === 'fresh' && decision.ageMs === 0,
    detail: JSON.stringify(decision),
  }
})

addCase('an identical replan inside the window is refused with no_new_info', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const decision = throttle.tryReplan('no_progress', inputs(), 4_000)
  return {
    pass: !decision.allow && decision.kind === 'no_new_info' && decision.ageMs === 3_000,
    detail: JSON.stringify(decision),
  }
})

addCase('new information inside the window is still refused (window bound)', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const changed = inputs({ inventory: { oak_log: 3, cobblestone: 27 } })
  const decision = throttle.tryReplan('no_progress', changed, 5_000)
  return {
    pass: !decision.allow && decision.kind === 'window' && decision.ageMs === 4_000,
    detail: JSON.stringify(decision),
  }
})

addCase('new information after the window is allowed and recorded', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const changed = inputs({ inventory: { oak_log: 3, cobblestone: 27 } })
  const decision = throttle.tryReplan('no_progress', changed, 12_000)
  const next = throttle.check('no_progress', changed, 12_001)
  return {
    pass: decision.allow && decision.kind === 'new_info' && decision.ageMs === 11_000 && next.kind === 'no_new_info',
    detail: `${JSON.stringify(decision)} then ${JSON.stringify(next)}`,
  }
})

addCase('a sub-threshold position change is not new information', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const nudged = inputs({ position: { x: 30, y: 60, z: 34 } })
  const decision = throttle.tryReplan('no_progress', nudged, 20_000)
  return {
    pass: !decision.allow && decision.kind === 'no_new_info',
    detail: JSON.stringify(decision),
  }
})

addCase('a position change beyond the threshold is new information', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const moved = inputs({ position: { x: 34, y: 60, z: 34 } })
  const decision = throttle.tryReplan('no_progress', moved, 20_000)
  return {
    pass: decision.allow && decision.kind === 'new_info',
    detail: JSON.stringify(decision),
  }
})

addCase('a new known resource and a different failure signature are new information', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const resource = throttle.tryReplan('no_progress', inputs({ knownResources: 129 }), 20_000)
  throttle.tryReplan('no_progress', inputs(), 40_000)
  const failure = throttle.tryReplan('no_progress', inputs({ failureSignature: 'MINE:path_no_path' }), 60_000)
  return {
    pass: resource.allow && resource.kind === 'new_info' && failure.allow && failure.kind === 'new_info',
    detail: `${JSON.stringify(resource)} ${JSON.stringify(failure)}`,
  }
})

addCase('reasons are isolated: a different reason starts fresh', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const decision = throttle.tryReplan('action_impossible', inputs(), 2_000)
  return {
    pass: decision.allow && decision.kind === 'fresh',
    detail: JSON.stringify(decision),
  }
})

addCase('the throttle message is exactly REPLAN_THROTTLED reason=<r> ageMs=<n> -> reuse plan', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.tryReplan('no_progress', inputs(), 1_000)
  const decision = throttle.tryReplan('no_progress', inputs(), 7_500)
  const line = formatReplanThrottled('no_progress', decision)
  return {
    pass: line === 'REPLAN_THROTTLED reason=no_progress ageMs=6500 -> reuse plan',
    detail: line,
  }
})

addCase('the stateHash is stable across calls and keyed by the inputs', () => {
  const a = hashReplanInputs(inputs())
  const b = hashReplanInputs(inputs())
  const c = hashReplanInputs(inputs({ knownResources: 129 }))
  const orderA = hashReplanInputs(inputs({ inventory: { cobblestone: 27, oak_log: 2 } }))
  return {
    pass: a === b && a !== c && a === orderA,
    detail: `a=${a} b=${b} c=${c} orderA=${orderA}`,
  }
})

addCase('replanInputsChanged ignores count-zero churn and non-changes', () => {
  const same = replanInputsChanged(inputs(), inputs({ inventory: { oak_log: 2, cobblestone: 27, dirt: 0 } }), 2)
  const changed = replanInputsChanged(inputs(), inputs({ inventory: { oak_log: 2, cobblestone: 26 } }), 2)
  return { pass: !same && changed, detail: `same=${same} changed=${changed}` }
})

addCase('hasBodyDelta rejects a stationary smelt of the blocked target', () => {
  const current = { kind: 'smelt', targetItem: 'charcoal' }
  const stationary = [{ kind: 'smelt', targetItem: 'charcoal', requiredCount: 1 }]
  const descent = [{ kind: 'collect', targetItem: 'cobblestone', requiredCount: 35 }]
  const ore = [{ kind: 'collect', targetItem: 'raw_iron', requiredCount: 3 }]
  const explore = [{ kind: 'explore', targetItem: null, requiredCount: 1 }]
  return {
    pass:
      !hasBodyDelta(stationary, current) &&
      hasBodyDelta(descent, current) &&
      hasBodyDelta(ore, current) &&
      hasBodyDelta(explore, current),
    detail: `stationary=${hasBodyDelta(stationary, current)} descent=${hasBodyDelta(descent, current)} ore=${hasBodyDelta(ore, current)} explore=${hasBodyDelta(explore, current)}`,
  }
})

addCase('hasBodyDelta allows anything when there is no blocked goal, rejects an empty plan', () => {
  const plan = [{ kind: 'collect', targetItem: 'oak_log', requiredCount: 3 }]
  return {
    pass: hasBodyDelta(plan, null) && hasBodyDelta([], null) === false,
    detail: `noCurrent=${hasBodyDelta(plan, null)} empty=${hasBodyDelta([], null)}`,
  }
})

addCase('the window and position threshold resolve from env with safe defaults', () => {
  const defaults = resolveReplanThrottleMs({}) === REPLAN_THROTTLE_WINDOW_MS_DEFAULT && resolveReplanPositionDelta({}) === 2
  const override = resolveReplanThrottleMs({ BUDDY_REPLAN_THROTTLE_MS: '2500' }) === 2500
  const invalid = resolveReplanThrottleMs({ BUDDY_REPLAN_THROTTLE_MS: 'nope' }) === REPLAN_THROTTLE_WINDOW_MS_DEFAULT
  const negative = resolveReplanPositionDelta({ BUDDY_REPLAN_POSITION_DELTA: '-1' }) === 2
  return { pass: defaults && override && invalid && negative, detail: `defaults=${defaults} override=${override} invalid=${invalid} negative=${negative}` }
})

addCase('the live charcoal spin is refused: front plan stationary, body-change accepted', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  const current = { kind: 'smelt', targetItem: 'charcoal' }
  const front = [{ kind: 'smelt', targetItem: 'charcoal', requiredCount: 1 }]
  const bodyChange = [
    { kind: 'collect', targetItem: 'cobblestone', requiredCount: 35 },
    { kind: 'collect', targetItem: 'raw_iron', requiredCount: 3 },
    { kind: 'smelt', targetItem: 'charcoal', requiredCount: 1 },
  ]
  throttle.record('no_progress', inputs(), 1_000)
  const refused = throttle.check('no_progress', inputs(), 30_000)
  return {
    pass: !refused.allow && !hasBodyDelta(front, current) && hasBodyDelta(bodyChange, current),
    detail: `refused=${refused.kind} front=${hasBodyDelta(front, current)} bodyChange=${hasBodyDelta(bodyChange, current)}`,
  }
})

addCase('the capability-gap predicate fires on the live ascend-blocked shape', () => {
  const targetKey = 'raw_iron@37,67,33'
  const first = evaluateCapabilityGap(null, { y: 10.75, targetY: 67, targetKey, ascendRefused: true })
  let decision = first
  for (let tick = 1; tick < DEFAULT_CAPABILITY_GAP_POLICY.windowTicks; tick += 1) {
    decision = evaluateCapabilityGap(decision.state, { y: 10.75, targetY: 67, targetKey, ascendRefused: true })
  }
  const line = formatCapabilityGap(decision)
  return {
    pass:
      first.gap === false &&
      decision.gap &&
      decision.reason === 'ascend_blocked' &&
      decision.attempts === DEFAULT_CAPABILITY_GAP_POLICY.windowTicks &&
      decision.targetY === 67 &&
      line === 'CAPABILITY_GAP reason=ascend_blocked attempts=40 target_y=67',
    detail: `beforeWindow=${first.gap} line=${line}`,
  }
})

addCase('normal movement and real altitude gain never fire the capability gap', () => {
  const targetKey = 'raw_iron@37,67,33'
  const tooClose = evaluateCapabilityGap(null, { y: 64, targetY: 66, targetKey, ascendRefused: true })
  let decision = evaluateCapabilityGap(null, { y: 10, targetY: 67, targetKey, ascendRefused: true })
  for (let step = 0; step < DEFAULT_CAPABILITY_GAP_POLICY.windowTicks; step += 1) {
    decision = evaluateCapabilityGap(decision.state, { y: 10 + step, targetY: 67, targetKey, ascendRefused: true })
  }
  return {
    pass: tooClose.gap === false && tooClose.state === null && decision.gap === false,
    detail: `tooClose=${tooClose.gap} climbing=${decision.gap}`,
  }
})

// The live 2026-09-18 altitude trace (buddy.log): the body repeatedly climbs
// to ~13-14 and falls back to ~8.8-9.5, never net-advancing. A transient peak
// must not look like progress, so the gap has to fire inside this window.
const LIVE_ALTITUDE_SAWTOOTH = [
  11.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0, 11.0,
  10.5,
  11.0, 11.0, 11.0, 11.0,
  11.8, 8.8, 13.0, 8.8, 9.5, 14.0, 12.0, 14.0,
] as const

const sawtoothAt = (tick: number): number => LIVE_ALTITUDE_SAWTOOTH[tick % LIVE_ALTITUDE_SAWTOOTH.length] ?? 0

addCase('the live altitude sawtooth is never progress and fires the gap as oscillation', () => {
  const targetKey = 'known:raw_iron@37,67,33'
  let decision = evaluateCapabilityGap(null, { y: sawtoothAt(0), targetY: 67, targetKey, ascendRefused: true })
  for (let tick = 1; tick < DEFAULT_CAPABILITY_GAP_POLICY.windowTicks; tick += 1) {
    decision = evaluateCapabilityGap(decision.state, {
      y: sawtoothAt(tick),
      targetY: 67,
      targetKey,
      ascendRefused: true,
    })
  }
  const line = formatCapabilityGap(decision)
  const policyLine = formatCapabilityGapPolicy(decision)
  return {
    pass:
      decision.gap &&
      decision.reason === 'ascend_blocked' &&
      decision.attempts === DEFAULT_CAPABILITY_GAP_POLICY.windowTicks &&
      decision.heuristic.chosen === 'escalate' &&
      decision.heuristic.reason === 'oscillation' &&
      decision.heuristic.alternatives.includes('keep_climbing') &&
      line === 'CAPABILITY_GAP reason=ascend_blocked attempts=40 target_y=67' &&
      policyLine === 'CAPABILITY_GAP_POLICY chosen=escalate score=3 alternatives=[keep_climbing] reason=oscillation',
    detail: `line=${line} policy=${policyLine}`,
  }
})

addCase('a repeated 13->8.8->14->9.5 sawtooth is no progress even at its peaks', () => {
  const targetKey = 'known:raw_iron@37,67,33'
  const pattern = [13.0, 8.8, 14.0, 9.5] as const
  const at = (tick: number): number => pattern[tick % pattern.length] ?? 0
  let decision = evaluateCapabilityGap(null, { y: at(0), targetY: 67, targetKey, ascendRefused: true })
  for (let tick = 1; tick < DEFAULT_CAPABILITY_GAP_POLICY.windowTicks; tick += 1) {
    decision = evaluateCapabilityGap(decision.state, { y: at(tick), targetY: 67, targetKey, ascendRefused: true })
  }
  return {
    pass: decision.gap && decision.heuristic.reason === 'oscillation',
    detail: `gap=${decision.gap} heuristic=${JSON.stringify(decision.heuristic)}`,
  }
})

addCase('genuine monotonic climbing is net progress and re-anchors the window upward', () => {
  const targetKey = 'known:raw_iron@37,67,33'
  let decision = evaluateCapabilityGap(null, { y: 10, targetY: 67, targetKey, ascendRefused: false })
  for (let tick = 1; tick < DEFAULT_CAPABILITY_GAP_POLICY.windowTicks; tick += 1) {
    decision = evaluateCapabilityGap(decision.state, { y: 10 + tick, targetY: 67, targetKey, ascendRefused: false })
  }
  const policyLine = formatCapabilityGapPolicy(decision)
  return {
    pass:
      decision.gap === false &&
      decision.heuristic.chosen === 'keep_climbing' &&
      decision.heuristic.reason === 'progress' &&
      decision.state?.ticks === 0 &&
      decision.state?.startY === 49 &&
      policyLine === 'CAPABILITY_GAP_POLICY chosen=keep_climbing score=39 alternatives=[escalate] reason=progress',
    detail: `policy=${policyLine} state=${JSON.stringify(decision.state)}`,
  }
})

addCase('a climb that falls back to a previously held altitude is not progress', () => {
  const targetKey = 'known:raw_iron@37,67,33'
  let decision = evaluateCapabilityGap(null, { y: 11, targetY: 67, targetKey, ascendRefused: true })
  decision = evaluateCapabilityGap(decision.state, { y: 12.5, targetY: 67, targetKey, ascendRefused: true })
  for (let tick = 2; tick < DEFAULT_CAPABILITY_GAP_POLICY.windowTicks; tick += 1) {
    decision = evaluateCapabilityGap(decision.state, { y: 11, targetY: 67, targetKey, ascendRefused: true })
  }
  return {
    pass:
      decision.gap &&
      decision.heuristic.reason === 'no_net_progress' &&
      formatCapabilityGap(decision) === 'CAPABILITY_GAP reason=ascend_blocked attempts=40 target_y=67',
    detail: `heuristic=${JSON.stringify(decision.heuristic)}`,
  }
})

addCase('returns below the best are tolerated up to the policy limit while the best is held', () => {
  const targetKey = 'known:raw_iron@37,67,33'
  let decision = evaluateCapabilityGap(null, { y: 11, targetY: 67, targetKey, ascendRefused: true })
  decision = evaluateCapabilityGap(decision.state, { y: 10, targetY: 67, targetKey, ascendRefused: true })
  decision = evaluateCapabilityGap(decision.state, { y: 12.5, targetY: 67, targetKey, ascendRefused: true })
  decision = evaluateCapabilityGap(decision.state, { y: 11.5, targetY: 67, targetKey, ascendRefused: true })
  for (let tick = 4; tick < DEFAULT_CAPABILITY_GAP_POLICY.windowTicks; tick += 1) {
    decision = evaluateCapabilityGap(decision.state, { y: 12.5, targetY: 67, targetKey, ascendRefused: true })
  }
  return {
    pass:
      decision.gap === false &&
      decision.heuristic.reason === 'progress' &&
      decision.state?.returnsBelowBest === 0,
    detail: `gap=${decision.gap} heuristic=${JSON.stringify(decision.heuristic)}`,
  }
})

addCase('reaching the target clears the window and its stored state', () => {
  const targetKey = 'known:raw_iron@37,67,33'
  let decision = evaluateCapabilityGap(null, { y: 10, targetY: 67, targetKey, ascendRefused: true })
  for (let tick = 1; tick < 20; tick += 1) {
    decision = evaluateCapabilityGap(decision.state, { y: 10, targetY: 67, targetKey, ascendRefused: true })
  }
  const midway = decision.state
  decision = evaluateCapabilityGap(midway, { y: 67.2, targetY: 67, targetKey, ascendRefused: true })
  return {
    pass:
      midway !== null &&
      midway.ticks === 20 &&
      decision.gap === false &&
      decision.state === null &&
      decision.heuristic.reason === 'target_reached',
    detail: `midwayTicks=${midway?.ticks} state=${decision.state} reason=${decision.heuristic.reason}`,
  }
})

addCase('an active capability gap defeats no_new_info and stays window-bounded', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.record('no_progress', inputs(), 1_000)
  const gapInputs = inputs({ capabilityGap: 'ascend_blocked:67' })
  const insideWindow = throttle.check('no_progress', gapInputs, 4_000)
  const afterWindow = throttle.check('no_progress', gapInputs, 12_000)
  return {
    pass: insideWindow.allow === false && insideWindow.kind === 'window' && afterWindow.allow && afterWindow.kind === 'new_info',
    detail: `${JSON.stringify(insideWindow)} ${JSON.stringify(afterWindow)}`,
  }
})

addCase('clearing a capability gap is new information too', () => {
  const throttle = new ReplanThrottle(10_000, 2)
  throttle.record('no_progress', inputs({ capabilityGap: 'ascend_blocked:67' }), 1_000)
  const decision = throttle.check('no_progress', inputs(), 12_000)
  return { pass: decision.allow && decision.kind === 'new_info', detail: JSON.stringify(decision) }
})

addCase('parseCapabilityGap reads the newest marker and ignores noise', () => {
  const parsed = parseCapabilityGap(['dug x', 'CAPABILITY_GAP reason=ascend_blocked attempts=3 target_y=67', 'dug y'])
  const latest = parseCapabilityGap([
    'CAPABILITY_GAP reason=ascend_blocked attempts=3 target_y=67',
    'CAPABILITY_GAP reason=ascend_blocked attempts=41 target_y=67',
  ])
  const missing = parseCapabilityGap(['REPLAN_THROTTLED reason=no_progress ageMs=1 -> reuse plan'])
  return {
    pass: parsed?.attempts === 3 && parsed.targetY === 67 && latest?.attempts === 41 && missing === null,
    detail: `${JSON.stringify(parsed)} ${JSON.stringify(latest)} missing=${missing === null}`,
  }
})

addCase('hasBodyDelta accepts the surface-return goal as a body change', () => {
  const current = { kind: 'collect', targetItem: 'raw_iron' }
  const surface = [{ kind: 'surface', targetItem: 'log', requiredCount: 1 }]
  return { pass: hasBodyDelta(surface, current), detail: `surface=${hasBodyDelta(surface, current)}` }
})

let failures = 0
process.stdout.write('replan throttle + new-information + body-delta (#44)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} replan-throttle cases passed\n`)
if (failures > 0) process.exit(1)
