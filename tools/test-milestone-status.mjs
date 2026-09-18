import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateMilestone, validateContract } from './milestone-status.mjs'

const contract = JSON.parse(readFileSync(new URL('../MILESTONE-CONTRACT.json', import.meta.url), 'utf8'))
assert.deepEqual(validateContract(contract), [])

const noScope = evaluateMilestone(contract, 'M2', { runCommand: () => { throw new Error('must not run') } })
assert.equal(noScope.status, 'UNKNOWN')
assert.equal(noScope.reason, 'run_scope_required')

const pass = evaluateMilestone(contract, 'M2', {
  since: '2026-09-18T15:00:00Z',
  runCommand: () => ({ stdout: 'noise\nM2_LIVE_RESULT status=PASS reason=closed_loop\n', stderr: '', status: 0 }),
})
assert.equal(pass.status, 'PASS')

const fail = evaluateMilestone(contract, 'M2', {
  since: '2026-09-18T15:00:00Z',
  runCommand: () => ({ stdout: 'M2_LIVE_RESULT status=FAIL reason=inventory\n', stderr: '', status: 1 }),
})
assert.equal(fail.status, 'FAIL')

const noMachineStatus = evaluateMilestone(contract, 'M2', {
  since: '2026-09-18T15:00:00Z',
  runCommand: () => ({ stdout: 'human prose only\n', stderr: '', status: 0 }),
})
assert.equal(noMachineStatus.status, 'UNKNOWN')

const m3 = evaluateMilestone(contract, 'M3')
assert.equal(m3.status, 'UNKNOWN')
assert.match(m3.reason, /run-scoped executable gate/)

process.stdout.write('milestone-status-test 6/6 PASS\n')
