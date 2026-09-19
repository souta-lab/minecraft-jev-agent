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
// Run: npm run pillar-takeoff-instrumentation-test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HORIZONTAL_VELOCITY_EPSILON,
  buildPillarTakeoffTelemetry,
  formatPillarTakeoffTelemetry,
  makePillarAttemptId,
  readControlState,
  type PillarTakeoffTelemetryInput,
} from './src/pillarTakeoffTelemetry.ts'
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
