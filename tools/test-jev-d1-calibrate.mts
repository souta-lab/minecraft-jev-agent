import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDirectDecisionDiagnostics } from '../packages/jev-harness/providers/systemone-direct.ts'
import { calibrationOptions, calibrationSample, calibrate } from './jev-d1-calibrate.mts'

const opts = calibrationOptions(['corpus.jsonl', '--sample', '3', '--threat-sample', '2'])
assert.equal(opts.profileId, 'liquid-direct-d1-free')
assert.equal(opts.model, 'd1:free')
assert.throws(() => calibrationOptions(['x', '--profile', 'liquid-direct-d1-free', '--model', 'd1']), /does not match/)
assert.throws(() => calibrationOptions(['x', '--profile', 'typesafe-gateway-jev']), /not a direct/)
for (const bad of ['-1', 'NaN', '1.5', '129']) {
  assert.throws(() => calibrationOptions(['x', '--sample', bad]), /integer calls/)
}
assert.throws(() => calibrationOptions(['x', '--split', 'test']), /invalid split/)
assert.throws(() => calibrationOptions(['x', '--budget-ms', '0']), /budget-ms/)
assert.deepEqual(
  readDirectDecisionDiagnostics({
    providerMetadata: {
      systemone: {
        confidence: { action: 0.71, danger: 0.44, bogus: 'x' },
        reportedModel: 'd1:free',
        requestId: 'req-cal-fixture',
      },
    },
  }),
  {
    confidence: { action: 0.71, danger: 0.44 },
    reportedModel: 'd1:free',
    requestId: 'req-cal-fixture',
  },
)
const records = Array.from({ length: 40 }, (_, ordinal) => ({ ordinal, questions: ordinal % 3 === 0 ? { danger: {} } : { action: {} } }))
const dev = calibrationSample(records, { ...opts, split: 'dev' })
const holdout = calibrationSample(records, { ...opts, split: 'holdout' })
assert.equal(dev.length, 5)
assert.equal(holdout.length, 5)
assert.ok(dev.every((r) => r.ordinal < 30))
assert.ok(holdout.every((r) => r.ordinal >= 30))
assert.equal(dev.filter((r) => 'danger' in r.questions).length, 2)
assert.equal(holdout.filter((r) => 'danger' in r.questions).length, 2)
assert.deepEqual(calibrationSample(records, { ...opts, split: 'holdout' }), holdout)
assert.equal(calibrationSample(records, { ...opts, sample: 0 }).every((r) => 'danger' in r.questions), true)

const dir = mkdtempSync(join(tmpdir(), 'd1-free-calibration-'))
try {
  const corpus = join(dir, 'corpus.jsonl')
  writeFileSync(corpus, '{}\n')
  await assert.rejects(calibrate([corpus, '--corpus-sha256', '0'.repeat(64)]), /sealed corpus hash mismatch/)
  const out = join(dir, 'sealed.json')
  writeFileSync(out, '{}')
  await assert.rejects(calibrate([corpus, '--json', out]), /evidence is immutable/)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('d1 calibration: free identity, sealed split, call/budget bounds and immutable evidence PASS')
