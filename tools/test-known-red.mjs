// Offline contract tests for the pinned known-red baseline comparator.

import assert from 'node:assert/strict'
import { evaluateNoNewRegression, normalizeBaseline, normalizeCurrent } from './known-red.mjs'

const baseline = (knownRed = []) => ({
  schemaVersion: 1,
  baselineId: 'fixture-baseline',
  baseCommit: 'base-commit',
  knownRed,
})

const current = (results, commit = 'head-commit') => ({ schemaVersion: 1, commit, results })

const cases = [
  ['all green is PASS', () => assert.equal(evaluateNoNewRegression(baseline(), current([{ id: 'typecheck', status: 'PASS' }])).status, 'PASS')],
  ['a pinned failure is PASS_WITH_WAIVER', () => {
    const report = evaluateNoNewRegression(
      baseline([{ id: 'known-test', reason: 'pinned fixture failure', introducedCommit: 'old-commit' }]),
      current([{ id: 'known-test', status: 'FAIL' }]),
    )
    assert.equal(report.status, 'PASS_WITH_WAIVER')
    assert.equal(report.waivedFailures.length, 1)
  }],
  ['a new failure is FAIL', () => {
    const report = evaluateNoNewRegression(baseline(), current([{ id: 'new-test', status: 'FAIL' }]))
    assert.equal(report.status, 'FAIL')
    assert.deepEqual(report.newFailures.map((entry) => entry.id), ['new-test'])
  }],
  ['an unknown result is UNKNOWN', () => {
    const report = evaluateNoNewRegression(baseline(), current([{ id: 'runner', status: 'UNKNOWN' }]))
    assert.equal(report.status, 'UNKNOWN')
  }],
  ['an unobserved baseline item is UNKNOWN', () => {
    const report = evaluateNoNewRegression(
      baseline([{ id: 'known-test', reason: 'pinned fixture failure', introducedCommit: 'old-commit' }]),
      current([{ id: 'other-test', status: 'PASS' }]),
    )
    assert.equal(report.status, 'UNKNOWN')
    assert.deepEqual(report.unobservedBaseline.map((entry) => entry.id), ['known-test'])
  }],
  ['duplicate and malformed entries fail closed', () => {
    assert.throws(() => normalizeBaseline(baseline([
      { id: 'dup', reason: 'one', introducedCommit: 'c1' },
      { id: 'dup', reason: 'two', introducedCommit: 'c2' },
    ])), /duplicate id/)
    assert.throws(() => normalizeCurrent(current([{ id: 'bad', status: 'MAYBE' }])), /PASS, FAIL, or UNKNOWN/)
  }],
]

let failures = 0
for (const [name, run] of cases) {
  try {
    run()
    process.stdout.write(`PASS ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
process.stdout.write(`known-red baseline fixtures: ${cases.length - failures}/${cases.length} passed\n`)
if (failures > 0) process.exitCode = 1
