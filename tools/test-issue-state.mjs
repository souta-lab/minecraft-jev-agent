#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { validateIssueState } from './issue-state.mjs'

const dimensions = {
  policy: ['missing', 'defined'],
  implementation: ['none', 'partial', 'landed'],
  verification: ['none', 'offline', 'integration', 'live'],
  observation: ['not-run', 'pass', 'fail', 'unknown'],
  compliance: ['pass', 'fail', 'unknown'],
}

const issues = [
  { number: 1, title: 'P1: live thing', state: 'OPEN' },
  { number: 2, title: 'Architecture thing', state: 'OPEN' },
  { number: 3, title: 'Closed thing', state: 'CLOSED' },
]
const routing = { now: [1], next: [2], waitingLive: [], research: [] }
const base = {
  dimensions,
  issues: {
    '1': { acceptanceClass: 'resident-live', policy: 'defined', implementation: 'landed', verification: 'integration', observation: 'not-run', compliance: 'unknown' },
    '2': { acceptanceClass: 'architecture', policy: 'defined', implementation: 'partial', verification: 'offline', observation: 'not-run', compliance: 'unknown' },
  },
}

{
  const result = validateIssueState(issues, base, routing)
  assert.deepEqual(result.errors, [])
}
{
  const manifest = structuredClone(base)
  delete manifest.issues['1']
  const result = validateIssueState(issues, manifest, routing)
  assert.match(result.errors.join('\n'), /#1 is active\/significant but missing/)
}
{
  const manifest = structuredClone(base)
  manifest.issues['1'].compliance = 'pass'
  const result = validateIssueState(issues, manifest, routing)
  assert.match(result.errors.join('\n'), /requires verification=live and observation=pass/)
}
{
  const manifest = structuredClone(base)
  manifest.issues['2'].implementation = 'none'
  manifest.issues['2'].compliance = 'pass'
  const result = validateIssueState(issues, manifest, routing)
  assert.match(result.errors.join('\n'), /cannot be compliance=pass with implementation=none/)
}
{
  const manifest = structuredClone(base)
  manifest.issues['3'] = { acceptanceClass: 'architecture', policy: 'defined', implementation: 'landed', verification: 'offline', observation: 'unknown', compliance: 'unknown' }
  const result = validateIssueState(issues, manifest, routing)
  assert.match(result.errors.join('\n'), /#3 is closed while machine-readable compliance=unknown/)
}

process.stdout.write('issue-state tests: 5/5\n')
