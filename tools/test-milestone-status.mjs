import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateMilestone, validateContract } from './milestone-status.mjs'

const contract = JSON.parse(readFileSync(new URL('../MILESTONE-CONTRACT.json', import.meta.url), 'utf8'))
assert.deepEqual(validateContract(contract), [])

const m2 = evaluateMilestone(contract, 'M2', { runCommand: () => { throw new Error('manual M2 gate must not run') } })
assert.equal(m2.status, 'UNKNOWN')
assert.match(m2.reason, /current M2|portal/i)

const m3 = evaluateMilestone(contract, 'M3')
assert.equal(m3.status, 'UNKNOWN')
assert.match(m3.reason, /run-scoped executable gate/)

process.stdout.write('milestone-status-test 3/3 PASS\n')
