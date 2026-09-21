// test-pillar-takeoff-instrumentation.mts
//
// Instrumentation-only evidence test for the classified PILLAR takeoff failure
// (`PILLAR_FAIL step=takeoff reason=no_rise`).
//
// PRIMARY (real data): this test calls the helper in src/pillarTakeoffTelemetry.ts
// with simulated pillar takeoff attempts - one leaky (horizontal velocity and/or
// forward control present at takeoff) and one clean - and asserts every field of
// the produced record, the horizontalLeak classification, and the uniqueness of
// makePillarAttemptId across relocation/retry attempts under the same
// candidate.id + epoch.
//
// SECONDARY (wiring guard): the executor/controller sources are checked so the
// record actually reaches the run-scoped host log (mirrored marker) and the
// helper is really connected. It fails if the connection is removed.
//
// No behaviour change is asserted or introduced.
//
// Run: bun run pillar-takeoff-instrumentation-test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HORIZONTAL_VELOCITY_EPSILON,
  MAX_TRACE_COMPACT_CHARS,
  buildPillarTakeoffTelemetry,
  formatPillarTakeoffTelemetry,
  makePillarAttemptId,
  readControlState,
  type PillarTakeoffTelemetryInput,
} from './src/pillarTakeoffTelemetry.ts'
import type { PillarJumpTraceSample } from './src/pillarJump.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'

let checks = 0
const dir = import.meta.dirname
const ok = (label: string): void => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

// ---------------------------------------------------------------- simulated attempts

const candidateId = 'RETRIEVE:known:log:b33_69_27'
const epoch = 7

/** A takeoff attempt whose launch state is clean unless overridden. */
const attempt = (overrides: Partial<PillarTakeoffTelemetryInput>): PillarTakeoffTelemetryInput => ({
  attemptId: makePillarAttemptId(candidateId, epoch, 1),
  launchVelocity: { x: 0, y: 0.42, z: 0 },
  endVelocity: { x: 0, y: -0.155, z: 0 },
  launchControls: { forward: false, jump: true },
  endControls: { forward: false, jump: false },
  launchPosition: { x: 39, y: 11, z: 32.31 },
  endPosition: { x: 39, y: 11, z: 32.31 },
  forcedRepositions: 0,
  peakRise: 0,
  failureStep: 'takeoff',
  failureReason: 'no_rise',
  ...overrides,
})

// The classified live failure: no vertical rise, so if any horizontal residue or
// forward control is present at the launch instant it must be reported.
const leaky = buildPillarTakeoffTelemetry(
  attempt({
    attemptId: makePillarAttemptId(candidateId, epoch, 2),
    // Launch carries leftover horizontal velocity plus an active forward push.
    launchVelocity: { x: 0.18, y: 0.42, z: -0.14 },
    launchControls: { forward: true, jump: true },
  }),
)
const clean = buildPillarTakeoffTelemetry(
  attempt({
    launchVelocity: { x: 0, y: 0.42, z: 0 },
    launchControls: { forward: false, jump: true },
    endVelocity: { x: 0, y: -0.155, z: 0 },
    endControls: { forward: false, jump: false },
  }),
)
const endOnlyLeak = buildPillarTakeoffTelemetry(
  attempt({
    attemptId: makePillarAttemptId(candidateId, epoch, 3),
    launchVelocity: { x: 0, y: 0.42, z: 0 },
    launchControls: { forward: false, jump: true },
    endVelocity: { x: 0.05, y: -0.155, z: 0 },
  }),
)
// Control leakage that only appears at the END of the attempt must also be
// classified, otherwise the flag would contradict the emitted endForwardState.
const endForwardLeak = buildPillarTakeoffTelemetry(
  attempt({
    attemptId: makePillarAttemptId(candidateId, epoch, 4),
    launchVelocity: { x: 0, y: 0.42, z: 0 },
    launchControls: { forward: false, jump: true },
    endVelocity: { x: 0, y: -0.155, z: 0 },
    endControls: { forward: true, jump: false },
  }),
)

console.log(`  leaky  horizontalLeak=${leaky.horizontalLeak} launchHorizontalSpeed=${leaky.launchHorizontalSpeed}`)
console.log(`  clean  horizontalLeak=${clean.horizontalLeak} launchHorizontalSpeed=${clean.launchHorizontalSpeed}`)
console.log(`  endOnly horizontalLeak=${endOnlyLeak.horizontalLeak} endHorizontalSpeed=${endOnlyLeak.endHorizontalSpeed}`)
console.log(`  endForward horizontalLeak=${endForwardLeak.horizontalLeak} endForwardState=${endForwardLeak.endForwardState}`)

assert.equal(leaky.horizontalLeak, true, 'horizontal velocity + forward control at launch must classify as a leak')
ok('horizontalLeak=true for the leaky simulated takeoff attempt')
assert.ok(leaky.launchHorizontalSpeed > HORIZONTAL_VELOCITY_EPSILON, 'leaky launch speed must exceed the epsilon')
assert.ok(
  Math.abs(leaky.launchHorizontalSpeed - Math.hypot(0.18, -0.14)) < 1e-9,
  'leaky launchHorizontalSpeed must be hypot(x, z)',
)
ok('leaky launchHorizontalSpeed is the measured hypot(x, z)')

assert.equal(clean.horizontalLeak, false, 'zero horizontal velocity with no forward control must not classify as a leak')
ok('horizontalLeak=false for the clean simulated takeoff attempt')
assert.equal(clean.launchHorizontalSpeed, 0, 'clean launch speed must be exactly zero')
assert.equal(clean.endHorizontalSpeed, 0, 'clean end speed must be exactly zero')

assert.equal(endOnlyLeak.horizontalLeak, true, 'residual end horizontal velocity must classify as a leak')
ok('horizontalLeak=true when only the END velocity leaks horizontally')
assert.equal(endForwardLeak.horizontalLeak, true, 'an active forward control at the end must classify as a leak')
assert.equal(endForwardLeak.endForwardState, true, 'endForwardState must be reported alongside the flag')
ok('horizontalLeak=true when the forward control only leaks at the END of the attempt')

// ---------------------------------------------------------------- every output field

type FieldKind = 'number' | 'boolean' | 'string' | 'string|null'
const expectedFields: ReadonlyArray<readonly [string, FieldKind]> = [
  ['attemptId', 'string'],
  ['launchVelocityX', 'number'],
  ['launchVelocityY', 'number'],
  ['launchVelocityZ', 'number'],
  ['endVelocityX', 'number'],
  ['endVelocityY', 'number'],
  ['endVelocityZ', 'number'],
  ['forwardState', 'boolean'],
  ['jumpState', 'boolean'],
  ['endForwardState', 'boolean'],
  ['endJumpState', 'boolean'],
  ['forcedRepositions', 'number'],
  ['peakRise', 'number'],
  ['failureStep', 'string|null'],
  ['failureReason', 'string|null'],
  ['launchHorizontalSpeed', 'number'],
  ['endHorizontalSpeed', 'number'],
  ['horizontalLeak', 'boolean'],
]
for (const [field, kind] of expectedFields) {
  const value = (leaky as unknown as Record<string, unknown>)[field]
  if (kind === 'number') assert.equal(typeof value, 'number', `${field} must be a number`)
  else if (kind === 'boolean') assert.equal(typeof value, 'boolean', `${field} must be a boolean`)
  else if (kind === 'string') assert.equal(typeof value, 'string', `${field} must be a string`)
  else assert.ok(value === null || typeof value === 'string', `${field} must be string|null`)
}
ok(`all ${expectedFields.length} telemetry fields are present with the expected types (leaky attempt)`)

// Values must be the inputs verbatim, not recomputed differently.
assert.equal(leaky.attemptId, makePillarAttemptId(candidateId, epoch, 2), 'attemptId must round-trip')
assert.equal(leaky.launchVelocityX, 0.18)
assert.equal(leaky.launchVelocityY, 0.42)
assert.equal(leaky.launchVelocityZ, -0.14)
assert.equal(leaky.endVelocityY, -0.155)
assert.equal(leaky.forwardState, true)
assert.equal(leaky.jumpState, true)
assert.equal(leaky.endForwardState, false)
assert.equal(leaky.endJumpState, false)
assert.equal(leaky.forcedRepositions, 0)
assert.equal(leaky.peakRise, 0)
assert.equal(leaky.failureStep, 'takeoff')
assert.equal(leaky.failureReason, 'no_rise')
ok('leaky attempt values round-trip verbatim (velocity, controls, forcedRepositions, failure)')

assert.equal(clean.failureStep, 'takeoff')
assert.equal(clean.failureReason, 'no_rise')
ok('clean attempt carries the same failure classification (only the leak differs)')

// ---------------------------------------------------------------- attemptId isolation

const ids = [1, 2, 3, 4].map((seq) => makePillarAttemptId(candidateId, epoch, seq))
assert.equal(new Set(ids).size, ids.length, 'each attempt sequence must yield a distinct attemptId')
ok('makePillarAttemptId isolates relocation/retry attempts under the same candidateId+epoch')
assert.ok(!ids.includes(`${candidateId}#${epoch}`), 'the ambiguous candidateId#epoch id must not be produced')
for (const [i, id] of ids.entries()) {
  assert.equal(id, `${candidateId}#${epoch}#${i + 1}`, 'attemptId shape must be candidateId#epoch#sequence')
}
ok('attemptId shape is candidateId#epoch#sequence')

// A relocation/retry loop re-uses candidate.id + epoch; the sequence is what separates them.
const retryIds = new Set(
  [1, 2, 3].map((seq) => buildPillarTakeoffTelemetry(attempt({ attemptId: ids[seq - 1] })).attemptId),
)
assert.equal(retryIds.size, 3, 'telemetry built for retry attempts must keep distinct ids')
ok('telemetry from three simulated retry attempts keeps three distinct attemptIds')

// ---------------------------------------------------------------- read-only observation API

const observed = readControlState({ controlState: { forward: true, jump: false } })
assert.deepEqual(observed, { forward: true, jump: false }, 'readControlState must observe a structural bot')
ok('readControlState reads a structural control-state object (type boundary, no cast)')

const missing = readControlState({})
assert.deepEqual(missing, { forward: null, jump: null }, 'a bot without controlState must degrade to nulls')
ok('readControlState degrades to nulls when controlState is absent')

const partial = readControlState({ controlState: { forward: true } })
assert.deepEqual(partial, { forward: true, jump: null }, 'a partial controlState must not throw')
ok('readControlState tolerates a partial controlState')

// A mineflayer-shaped object (all keys present, plus extras) must also satisfy the API.
const mineflayerLike = readControlState({
  controlState: {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: true,
    sprint: false,
    sneak: false,
  },
})
assert.deepEqual(mineflayerLike, { forward: false, jump: true }, 'a full mineflayer controlState must be accepted')
ok('readControlState accepts the full mineflayer controlState shape')

// ---------------------------------------------------------------- mirrorable record

const leakyLine = formatPillarTakeoffTelemetry(leaky)
const cleanLine = formatPillarTakeoffTelemetry(clean)
assert.ok(leakyLine.startsWith('PILLAR_TAKEOFF '), `formatted record must lead with PILLAR_TAKEOFF (got: ${leakyLine})`)
assert.equal(leakyLine.split('\n').length, 1, 'formatted record must be a single line')
assert.ok(leakyLine.includes('horizontalLeak=true'), 'leaky formatted record must print horizontalLeak=true')
assert.ok(cleanLine.includes('horizontalLeak=false'), 'clean formatted record must print horizontalLeak=false')
assert.ok(leakyLine.includes(`attemptId=${leaky.attemptId}`), 'formatted record must carry the attemptId')
ok('formatPillarTakeoffTelemetry emits a single mirrorable line with horizontalLeak')

// The pre-existing prefix must be byte-for-byte unchanged when the additive
// trace summary is appended; only the tail may grow.
const leakyPrefix =
  `PILLAR_TAKEOFF attemptId=${leaky.attemptId} launchVel=0.18,0.42,-0.14 endVel=0,-0.155,0` +
  ` forward=true jump=true forcedRepositions=0 peakRise=0 horizontalLeak=true`
assert.ok(
  leakyLine.startsWith(leakyPrefix),
  `existing field order/meaning must be preserved (got: ${leakyLine})`,
)
ok('the pre-existing PILLAR_TAKEOFF prefix is unchanged; trace summary is append-only')

// ---------------------------------------------------------------- trace summary + discriminator

const traceSample = (overrides: Partial<PillarJumpTraceSample>): PillarJumpTraceSample => ({
  atMs: 0,
  event: 'poll',
  onGroundBefore: true,
  onGroundAfter: true,
  grounded: true,
  positionY: 11,
  velocityY: 0,
  rise: 0,
  airborne: false,
  ticks: 0,
  impulses: 0,
  ...overrides,
})

// (c) missing trace -> no_trace (the existing leaky/clean attempts supply none).
assert.equal(leaky.takeoffDiscriminator, 'no_trace', 'an absent trace must classify as no_trace')
assert.equal(leaky.traceTicks, null, 'an absent trace must not report a tick count')
assert.equal(leaky.traceGateFires, null, 'an absent trace must not report gate fires')
assert.equal(leaky.traceMaxRise, null, 'an absent trace must not report a max rise')
assert.equal(leaky.traceTruncated, false, 'an absent trace is not truncated')
assert.equal(leaky.traceCompact, 'none', 'an absent trace must print the none marker')
assert.equal(clean.takeoffDiscriminator, 'no_trace', 'a clean attempt without a trace is still no_trace')
ok('missing trace -> no_trace with null measurements and a bounded `none` string')

// (a) the gate fired (positive velocity / explicit impulse) yet the body never
// rose: rise stays <= 0 and no sample is airborne -> move clamped.
const gateFiredNoRise = buildPillarTakeoffTelemetry(
  attempt({
    attemptId: makePillarAttemptId(candidateId, epoch, 5),
    jumpTrace: {
      truncated: false,
      samples: [
        traceSample({ atMs: 0, event: 'initial', velocityY: 0 }),
        traceSample({ atMs: 5, event: 'control', velocityY: 0 }),
        traceSample({ atMs: 10, event: 'physicsTick', velocityY: 0.34, ticks: 1 }),
        traceSample({
          atMs: 120,
          event: 'impulse',
          velocityY: 0.42,
          velocityYBefore: -0.0784,
          ticks: 2,
          impulses: 1,
        }),
        traceSample({ atMs: 135, event: 'forcedMove', velocityY: -0.0784, ticks: 2, impulses: 1 }),
        traceSample({ atMs: 150, event: 'poll', velocityY: -0.0784, ticks: 2, impulses: 1 }),
      ],
    },
  }),
)
assert.equal(
  gateFiredNoRise.takeoffDiscriminator,
  'gate_fired_move_clamped',
  'a gate fire with no rise must classify as gate_fired_move_clamped',
)
assert.equal(gateFiredNoRise.traceGateFires, 2, 'the physicsTick rise and the impulse must both count as gate fires')
assert.equal(gateFiredNoRise.traceTicks, 1, 'exactly one physicsTick sample must be counted')
assert.equal(gateFiredNoRise.traceMaxRise, 0, 'no sample rose above the launch point')
assert.equal(gateFiredNoRise.traceTruncated, false, 'a short trace is not truncated')
ok('gate fired + zero rise -> gate_fired_move_clamped (gate fires and ticks summarised)')

// (b) no sample shows any launch actuation: all velocities are <= 0 and there is
// no impulse observation -> the gate never fired.
const gateNeverFired = buildPillarTakeoffTelemetry(
  attempt({
    attemptId: makePillarAttemptId(candidateId, epoch, 6),
    jumpTrace: {
      truncated: false,
      samples: [
        traceSample({ atMs: 0, event: 'initial', velocityY: -0.0784 }),
        traceSample({ atMs: 10, event: 'control', velocityY: -0.0784 }),
        traceSample({ atMs: 20, event: 'physicsTick', velocityY: -0.0784, ticks: 1 }),
        traceSample({ atMs: 40, event: 'poll', velocityY: -0.155, ticks: 1 }),
        traceSample({ atMs: 60, event: 'forcedMove', velocityY: -0.155, ticks: 1 }),
      ],
    },
  }),
)
assert.equal(
  gateNeverFired.takeoffDiscriminator,
  'gate_never_fired',
  'no observed launch actuation must classify as gate_never_fired',
)
assert.equal(gateNeverFired.traceGateFires, 0, 'no sample may count as a gate fire')
assert.equal(gateNeverFired.traceTicks, 1, 'the single physicsTick sample must still be counted')
assert.equal(typeof gateNeverFired.traceMaxRise, 'number', 'a present trace must report a numeric max rise')
assert.ok((gateNeverFired.traceMaxRise ?? 1) <= 0, 'the body never rose')
ok('no observed gate fire -> gate_never_fired')

// The remaining state: a launch that did rise is not a no_rise case.
const gateFiredAndRose = buildPillarTakeoffTelemetry(
  attempt({
    attemptId: makePillarAttemptId(candidateId, epoch, 7),
    jumpTrace: {
      truncated: false,
      samples: [
        traceSample({ atMs: 5, event: 'physicsTick', velocityY: 0.34, rise: 0.005, positionY: 11.005, ticks: 1 }),
        traceSample({
          atMs: 20,
          event: 'physicsTick',
          velocityY: 0.26,
          rise: 0.34,
          positionY: 11.34,
          airborne: true,
          ticks: 2,
        }),
      ],
    },
  }),
)
assert.equal(
  gateFiredAndRose.takeoffDiscriminator,
  'gate_fired_and_rose',
  'a launch with real rise must not be classified as a no_rise cause',
)
ok('gate fired + a real rise -> gate_fired_and_rose (closed union, no implicit undefined)')

// (d) the compact string is single-line and hard-capped, with truncation marked.
const manySamples: PillarJumpTraceSample[] = Array.from({ length: 400 }, (_, i) =>
  traceSample({
    atMs: i * 7,
    event: i % 3 === 0 ? 'physicsTick' : i % 3 === 1 ? 'poll' : 'forcedMove',
    velocityY: i % 2 === 0 ? 0.34 : -0.0784,
    rise: i * 0.00123,
    positionY: 11 + i * 0.00123,
    airborne: i * 0.00123 > 0.02,
    ticks: i,
    onGroundBefore: i % 2 === 0,
    onGroundAfter: i % 3 !== 0,
  }),
)
const huge = buildPillarTakeoffTelemetry(
  attempt({ attemptId: makePillarAttemptId(candidateId, epoch, 8), jumpTrace: { truncated: false, samples: manySamples } }),
)
assert.ok(huge.traceCompact.length <= MAX_TRACE_COMPACT_CHARS, `compact trace must be capped at ${MAX_TRACE_COMPACT_CHARS} chars`)
assert.equal(huge.traceCompact.split('\n').length, 1, 'compact trace must be a single line')
assert.notEqual(huge.traceCompact, 'none', 'a present trace must not print the none marker')
assert.ok(huge.traceCompact.endsWith('~'), 'a capped compact trace must mark its truncation in-band')
assert.equal(huge.traceTruncated, true, 'a capped compact trace must set traceTruncated')
ok(`compact trace is single-line, <= ${MAX_TRACE_COMPACT_CHARS} chars, and marks truncation`)

// A source trace that already dropped samples must also report truncation.
const sourceTruncated = buildPillarTakeoffTelemetry(
  attempt({
    attemptId: makePillarAttemptId(candidateId, epoch, 9),
    jumpTrace: { truncated: true, samples: [traceSample({ event: 'physicsTick', velocityY: 0.34, ticks: 1 })] },
  }),
)
assert.equal(sourceTruncated.traceTruncated, true, 'a truncated source trace must propagate traceTruncated')
assert.ok(sourceTruncated.traceCompact.endsWith('~'), 'a truncated source trace must mark truncation in-band')
ok('source-trace truncation propagates to the record and the compact string')

// The appended summary must be present on the formatted line.
assert.ok(leakyLine.includes('takeoffDiscriminator=no_trace'), 'formatted record must carry the discriminator')
assert.ok(leakyLine.includes('traceTicks=null'), 'formatted record must carry the null trace ticks')
assert.ok(leakyLine.includes('trace=none'), 'formatted record must carry the none trace string')
const gateFiredLine = formatPillarTakeoffTelemetry(gateFiredNoRise)
assert.ok(gateFiredLine.includes('takeoffDiscriminator=gate_fired_move_clamped'), 'formatted record must show the clamped discriminator')
assert.ok(gateFiredLine.includes('traceGateFires=2'), 'formatted record must show the gate-fire count')
assert.ok(gateFiredLine.includes('traceMaxRise=0'), 'formatted record must show the max rise')
assert.ok(gateFiredLine.includes('trace=') && !gateFiredLine.includes('\n'), 'formatted trace tail must be single-line')
ok('formatPillarTakeoffTelemetry appends the discriminator, summary and bounded trace string')

// ---------------------------------------------------------------- wiring guard (source scan)

const executorSrc = readFileSync(join(dir, 'src/executor.ts'), 'utf8')
const helperSrc = readFileSync(join(dir, 'src/pillarTakeoffTelemetry.ts'), 'utf8')

for (const symbol of [
  'buildPillarTakeoffTelemetry',
  'formatPillarTakeoffTelemetry',
  'makePillarAttemptId',
  'readControlState',
]) {
  assert.ok(
    new RegExp(`import[\\s\\S]*?\\b${symbol}\\b[\\s\\S]*?from '\\./pillarTakeoffTelemetry\\.ts'`).test(executorSrc),
    `executor.ts must import ${symbol} from the helper`,
  )
}
ok('executor.ts imports the takeoff telemetry helper')

assert.equal(
  (executorSrc.match(/const attemptId = makePillarAttemptId\(/g) ?? []).length,
  1,
  'attemptId must be generated exactly once per attempt via makePillarAttemptId',
)
assert.ok(/attemptSequence \+= 1/.test(executorSrc), 'the attempt-local monotonic sequence must increment per attempt')
assert.ok(
  /makePillarAttemptId\(candidate\.id, epoch, attemptSequence\)/.test(executorSrc),
  'the attemptId must include the attempt-local sequence',
)
ok('attemptSequence increments per attempt and feeds makePillarAttemptId')

assert.ok(/emitPillarTakeoff\(/.test(executorSrc), 'executor must emit the takeoff record')
assert.ok(/\.\.\.takeoff\b/.test(executorSrc), 'the PILLAR_FAIL detail must spread the computed telemetry')
assert.ok(/buildPillarTakeoffTelemetry\(\{ \.\.\.takeoffBase/.test(executorSrc), 'the record must be built by the helper')
assert.ok(/readControlState\(this\.bot\)/.test(executorSrc), 'executor must observe control state via the helper')
assert.ok(!/controlState as \{/.test(executorSrc), 'no direct controlState cast may remain in the executor')
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
assert.ok(!/\bas any\b/.test(stripComments(executorSrc)), 'executor must not use `as any`')
assert.ok(!/\bas any\b/.test(stripComments(helperSrc)), 'helper must not use `as any`')
ok('executor builds/emits via the helper with no casts and no `as any`')

assert.ok(!/controlState\.\w+\s*=/.test(executorSrc), 'instrumentation must not write control state')
assert.ok(!/velocity\.(x|z)\s*=\s*0/.test(executorSrc), 'no horizontal-velocity zeroing (behaviour change not authorized)')
const launchCaptureIdx = executorSrc.indexOf('const launchVelocity = {')
const jumpCallIdx = executorSrc.indexOf('await pillarStepUp(')
assert.ok(
  launchCaptureIdx > 0 && jumpCallIdx > 0 && launchCaptureIdx < jumpCallIdx,
  'launch telemetry must be captured before the takeoff actuator',
)
ok('read-only instrumentation: no control/velocity writes, launch captured before the actuator')

assert.ok(MIRRORED_MARKERS.has('PILLAR_TAKEOFF'), 'PILLAR_TAKEOFF must be mirrored to reach the run-scoped host log')
assert.ok(MIRRORED_MARKERS.has('PILLAR_FAIL'), 'PILLAR_FAIL must stay mirrored')
ok('controller mirrors PILLAR_TAKEOFF and PILLAR_FAIL')

console.log(`\n${checks} pillar takeoff instrumentation checks passed`)
