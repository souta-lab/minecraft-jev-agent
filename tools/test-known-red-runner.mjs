// Contract tests for the deterministic known-red result runner.

import assert from 'node:assert/strict'
import { normalizeCurrent } from './known-red.mjs'
import { RESULT_SCHEMA_VERSION, SUITES, classifyOutcome, runSuite } from './known-red-runner.mjs'

const allEntries = Object.values(SUITES).flat()
const ids = allEntries.map((entry) => entry.id)
assert.equal(new Set(ids).size, ids.length)
assert.equal(ids.length, 29)
assert.deepEqual(SUITES['core-deterministic'][0].args, ['ci'])
assert.deepEqual(SUITES['core-deterministic'][1].args, ['-sfn', '../jev-agent/node_modules', 'buddy-driver/node_modules'])
assert.equal(classifyOutcome({ status: 0, signal: null }).status, 'PASS')
assert.equal(classifyOutcome({ status: 7, signal: null }).status, 'FAIL')
assert.equal(classifyOutcome({ status: null, signal: 'SIGTERM' }).status, 'UNKNOWN')
assert.equal(classifyOutcome({ error: new Error('runner unavailable') }).status, 'UNKNOWN')

const artifact = runSuite('convergence', {
  commit: 'fixture-commit',
  now: () => new Date('2026-09-19T00:00:00.000Z'),
  execute: (entry) => {
    if (entry.id.endsWith('issue-state-test')) return { status: 3, signal: null }
    if (entry.id.endsWith('lane-guard-test')) return { status: null, signal: 'SIGTERM' }
    return { status: 0, signal: null }
  },
})

assert.equal(artifact.schemaVersion, RESULT_SCHEMA_VERSION)
assert.equal(artifact.commit, 'fixture-commit')
assert.equal(artifact.results.length, 13)
assert.equal(artifact.results.filter((entry) => entry.status === 'PASS').length, 11)
assert.equal(artifact.results.filter((entry) => entry.status === 'FAIL').length, 1)
assert.equal(artifact.results.filter((entry) => entry.status === 'UNKNOWN').length, 1)
assert.deepEqual(normalizeCurrent(artifact), {
  schemaVersion: 1,
  commit: 'fixture-commit',
  results: artifact.results.map(({ id, status, detail }) => ({ id, status, detail })),
})

process.stdout.write('known-red runner: 4/4 checks passed\n')
