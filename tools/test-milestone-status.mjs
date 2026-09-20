import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateMilestone, validateContract } from './milestone-status.mjs'

const contract = JSON.parse(readFileSync(new URL('../MILESTONE-CONTRACT.json', import.meta.url), 'utf8'))
assert.deepEqual(validateContract(contract), [])

// M2 delegates the diamond-to-Nether-gate stages to the run-scoped command gate
// (tools/m2-gate.mjs, scopeArg --run). Without an exact runId the contract is
// UNKNOWN; with one it parses the gate's M2_RUN_RESULT line.
const m2NoScope = evaluateMilestone(contract, 'M2', { runCommand: () => { throw new Error('M2 gate must not run without --run') } })
assert.equal(m2NoScope.status, 'UNKNOWN')
assert.equal(m2NoScope.reason, 'run_scope_required')

const m2Pass = evaluateMilestone(contract, 'M2', {
  runId: 'run-m2-a',
  runCommand: (argv) => {
    assert.deepEqual(argv.slice(1), ['--run', 'run-m2-a'])
    return { stdout: 'noise\nM2_RUN_RESULT status=PASS reason=diamond_to_nether_gate_verified runId=run-m2-a\n', stderr: '', status: 0 }
  },
})
assert.equal(m2Pass.status, 'PASS')

const m2Fail = evaluateMilestone(contract, 'M2', {
  runId: 'run-m2-a',
  runCommand: () => ({ stdout: 'M2_RUN_RESULT status=FAIL reason=portal_not_verified runId=run-m2-a\n', stderr: '', status: 1 }),
})
assert.equal(m2Fail.status, 'FAIL')

const m2Unknown = evaluateMilestone(contract, 'M2', {
  runId: 'run-m2-a',
  runCommand: () => ({ stdout: 'M2_RUN_RESULT status=UNKNOWN reason=m2_stages_incomplete:diamond_ready runId=run-m2-a\n', stderr: '', status: 2 }),
})
assert.equal(m2Unknown.status, 'UNKNOWN')

const m2NoMachineStatus = evaluateMilestone(contract, 'M2', {
  runId: 'run-m2-a',
  runCommand: () => ({ stdout: 'human prose only\n', stderr: '', status: 0 }),
})
assert.equal(m2NoMachineStatus.status, 'UNKNOWN')
assert.equal(m2NoMachineStatus.reason, 'gate_emitted_no_machine_status')

// M3 remains manual until its own run-scoped gate is wired.
const m3 = evaluateMilestone(contract, 'M3')
assert.equal(m3.status, 'UNKNOWN')
assert.match(m3.reason, /run-scoped executable gate/)

process.stdout.write('milestone-status-test 6/6 PASS\n')
