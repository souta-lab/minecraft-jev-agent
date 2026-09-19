import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateMilestone, validateContract } from './milestone-status.mjs'

const contract = JSON.parse(readFileSync(new URL('../MILESTONE-CONTRACT.json', import.meta.url), 'utf8'))
assert.deepEqual(validateContract(contract), [])

const noScope = evaluateMilestone(contract, 'M2', { runCommand: () => { throw new Error('must not run') } })
assert.equal(noScope.status, 'UNKNOWN')
assert.equal(noScope.reason, 'exact_run_scope_required')

let delegatedArgs = null
const pass = evaluateMilestone(contract, 'M2', {
  runId: 'run-fixture',
  runCommand: (args) => {
    delegatedArgs = args
    return { stdout: 'noise\nM2_LIVE_RESULT status=PASS reason=closed_loop\n', stderr: '', status: 0 }
  },
})
assert.equal(pass.status, 'PASS')
assert.deepEqual(delegatedArgs.slice(-2), ['--run', 'run-fixture'])

const fail = evaluateMilestone(contract, 'M2', {
  runId: 'run-fixture',
  runCommand: () => ({ stdout: 'M2_LIVE_RESULT status=FAIL reason=terminal_state_incomplete\n', stderr: '', status: 1 }),
})
assert.equal(fail.status, 'FAIL')

const timestampOnly = evaluateMilestone(contract, 'M2', {
  since: '2026-09-18T15:00:00Z',
  runCommand: () => { throw new Error('timestamp-only must not run exact-run M2 gate') },
})
assert.equal(timestampOnly.status, 'UNKNOWN')
assert.equal(timestampOnly.reason, 'exact_run_scope_required')

const noMachineStatus = evaluateMilestone(contract, 'M2', {
  runId: 'run-fixture',
  runCommand: () => ({ stdout: 'human prose only\n', stderr: '', status: 0 }),
})
assert.equal(noMachineStatus.status, 'UNKNOWN')

const m3 = evaluateMilestone(contract, 'M3')
assert.equal(m3.status, 'UNKNOWN')
assert.match(m3.reason, /run-scoped executable gate/)

process.stdout.write('milestone-status-test 7/7 PASS\n')
