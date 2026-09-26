#!/usr/bin/env bun
// validate-experiment-result.mjs — structural validator for bounded-experiment
// result records (docs/development/experiment-result.schema.json).
// Read-only: validates a record file and exits; never mutates the record.
//
// Usage: bun tools/validate-experiment-result.mjs <record.json>
// Exit: 0 = valid, 1 = invalid (violations printed), 64 = usage.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 64 })
const SHA_RE = /^[0-9a-f]{40}$/i
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,80}$/
const STATUS = new Set(['PASS', 'FAIL', 'UNKNOWN', 'ERROR'])
const FAILURE_CLASS = new Set([
  'none',
  'GROUNDING_REFUSAL',
  'VERIFY_FAIL',
  'LEASE_DENY',
  'STALE_FENCE',
  'BUDGET_EXHAUST',
  'MODEL_UNAVAILABLE',
  'MECHANICAL_FAIL',
  'NO_PROGRESS',
  'AUTHORITY_VIOLATION',
  'INFRA',
])
const VERDICT = new Set(['KEEP', 'REVERT', 'ESCALATE'])

function validate(record) {
  const violations = []
  const need = (ok, message) => { if (!ok) violations.push(message) }

  need(record !== null && typeof record === 'object' && !Array.isArray(record), 'record must be a JSON object')
  if (violations.length > 0) return violations

  need(record.schemaVersion === 1, `schemaVersion must be 1 (observed=${String(record.schemaVersion)})`)
  need(typeof record.experimentId === 'string' && ID_RE.test(record.experimentId), 'experimentId must match ^[a-z0-9][a-z0-9._-]{2,80}$')
  need(typeof record.baseSha === 'string' && SHA_RE.test(record.baseSha), 'baseSha must be a 40-hex commit')
  need(typeof record.candidateSha === 'string' && SHA_RE.test(record.candidateSha), 'candidateSha must be a 40-hex commit')
  need(typeof record.scenario === 'string' && record.scenario.length > 0, 'scenario must name a registry entry or command')
  need(typeof record.command === 'string' && record.command.length > 0, 'command must be the exact re-runnable invocation')
  need(STATUS.has(record.status), `status must be one of ${[...STATUS].join('|')}`)
  need(FAILURE_CLASS.has(record.failureClass), `failureClass must be a canonical class (${[...FAILURE_CLASS].join('|')})`)
  need(VERDICT.has(record.verdict), `verdict must be one of ${[...VERDICT].join('|')}`)
  need(typeof record.frozenZoneTouched === 'boolean', 'frozenZoneTouched must be a boolean')
  need(record.metrics === null || (typeof record.metrics === 'object' && !Array.isArray(record.metrics) &&
    Object.values(record.metrics).every((value) => typeof value === 'number' && Number.isFinite(value))),
    'metrics values must all be finite numbers')
  need(Array.isArray(record.evidence) && record.evidence.every((entry) => typeof entry === 'string' && entry.length > 0),
    'evidence must be a list of repo-relative artifact paths')

  // Cross-field contract (the comparator's hard rules, mirrored so a malformed
  // record fails validation instead of producing a misleading verdict).
  if (record.status === 'PASS') need(record.failureClass === 'none', 'status=PASS requires failureClass=none')
  if (record.status === 'FAIL') need(record.failureClass !== 'none' && FAILURE_CLASS.has(record.failureClass), 'status=FAIL requires a non-none failureClass')
  if (record.frozenZoneTouched === true) need(record.verdict === 'ESCALATE', 'frozenZoneTouched forces verdict=ESCALATE')

  const ALLOWED = new Set([
    'schemaVersion', 'experimentId', 'baseSha', 'candidateSha', 'scenario', 'command',
    'status', 'failureClass', 'metrics', 'evidence', 'verdict', 'frozenZoneTouched', 'notes',
  ])
  for (const key of Object.keys(record)) need(ALLOWED.has(key), `unknown field ${key}`)
  return violations
}

const arg = process.argv[2]
if (arg === undefined || process.argv.length > 3) {
  process.stderr.write(`usage: bun tools/validate-experiment-result.mjs <record.json>\n`)
  process.exit(EXIT.USAGE)
}
let record
try {
  record = JSON.parse(readFileSync(arg, 'utf8'))
} catch (error) {
  process.stderr.write(`EXPERIMENT_RESULT status=ERROR file=${basename(arg)} reason=unreadable_or_invalid_json\n`)
  process.exit(EXIT.FAIL)
}
const violations = validate(record)
if (violations.length === 0) {
  process.stdout.write(`EXPERIMENT_RESULT status=PASS file=${basename(arg)} verdict=${record.verdict} scenario=${record.scenario}\n`)
  process.exit(EXIT.PASS)
}
for (const violation of violations) process.stdout.write(`EXPERIMENT_RESULT status=FAIL file=${basename(arg)} violation=${violation}\n`)
process.exit(EXIT.FAIL)
