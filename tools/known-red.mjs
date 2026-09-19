// known-red.mjs - compare a deterministic test-result artifact with the
// repository's pinned known-red baseline.
//
// A known failure may be waived only when it is explicitly listed in the
// baseline. New failures are never silently folded into that baseline. An
// UNKNOWN result (or an expected baseline item that was not observed) keeps the
// evidence UNKNOWN rather than manufacturing a PASS.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const KNOWN_RED_SCHEMA_VERSION = 1

const VALID_STATUSES = new Set(['PASS', 'FAIL', 'UNKNOWN'])

function asRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function asNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function validateSchema(raw, label) {
  const record = asRecord(raw, label)
  if (record.schemaVersion !== KNOWN_RED_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${KNOWN_RED_SCHEMA_VERSION}`)
  }
  return record
}

export function normalizeBaseline(raw) {
  const record = validateSchema(raw, 'baseline')
  const baselineId = asNonEmptyString(record.baselineId, 'baseline.baselineId')
  const baseCommit = asNonEmptyString(record.baseCommit, 'baseline.baseCommit')
  if (!Array.isArray(record.knownRed)) throw new Error('baseline.knownRed must be an array')
  const seen = new Set()
  const knownRed = record.knownRed.map((entry, index) => {
    const item = asRecord(entry, `baseline.knownRed[${index}]`)
    const id = asNonEmptyString(item.id, `baseline.knownRed[${index}].id`)
    if (seen.has(id)) throw new Error(`baseline.knownRed contains duplicate id ${id}`)
    seen.add(id)
    return {
      id,
      reason: asNonEmptyString(item.reason, `baseline.knownRed[${index}].reason`),
      introducedCommit: asNonEmptyString(item.introducedCommit, `baseline.knownRed[${index}].introducedCommit`),
      ...(item.expiresAt === undefined ? {} : { expiresAt: asNonEmptyString(item.expiresAt, `baseline.knownRed[${index}].expiresAt`) }),
    }
  })
  return { schemaVersion: KNOWN_RED_SCHEMA_VERSION, baselineId, baseCommit, knownRed }
}

export function normalizeCurrent(raw) {
  const record = validateSchema(raw, 'current')
  const commit = asNonEmptyString(record.commit, 'current.commit')
  if (!Array.isArray(record.results)) throw new Error('current.results must be an array')
  const seen = new Set()
  const results = record.results.map((entry, index) => {
    const item = asRecord(entry, `current.results[${index}]`)
    const id = asNonEmptyString(item.id, `current.results[${index}].id`)
    if (seen.has(id)) throw new Error(`current.results contains duplicate id ${id}`)
    seen.add(id)
    const status = asNonEmptyString(item.status, `current.results[${index}].status`).toUpperCase()
    if (!VALID_STATUSES.has(status)) throw new Error(`current.results[${index}].status must be PASS, FAIL, or UNKNOWN`)
    return { id, status, ...(item.detail === undefined ? {} : { detail: String(item.detail) }) }
  })
  return { schemaVersion: KNOWN_RED_SCHEMA_VERSION, commit, results }
}

export function evaluateNoNewRegression(baselineRaw, currentRaw) {
  const baseline = normalizeBaseline(baselineRaw)
  const current = normalizeCurrent(currentRaw)
  const baselineById = new Map(baseline.knownRed.map((entry) => [entry.id, entry]))
  const newFailures = current.results.filter((entry) => entry.status === 'FAIL' && !baselineById.has(entry.id))
  const waivedFailures = current.results
    .filter((entry) => entry.status === 'FAIL' && baselineById.has(entry.id))
    .map((entry) => ({ ...entry, waiver: baselineById.get(entry.id) }))
  const unknownResults = current.results.filter((entry) => entry.status === 'UNKNOWN')
  const observed = new Set(current.results.map((entry) => entry.id))
  const unobservedBaseline = baseline.knownRed.filter((entry) => !observed.has(entry.id))
  const status = newFailures.length > 0
    ? 'FAIL'
    : unknownResults.length > 0 || unobservedBaseline.length > 0
      ? 'UNKNOWN'
      : waivedFailures.length > 0
        ? 'PASS_WITH_WAIVER'
        : 'PASS'
  return {
    status,
    baselineId: baseline.baselineId,
    baseCommit: baseline.baseCommit,
    currentCommit: current.commit,
    newFailures,
    waivedFailures,
    unknownResults,
    unobservedBaseline,
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--baseline' || arg === '--current') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a path`)
      args[arg.slice(2)] = value
      index += 1
    } else if (arg === '--json') {
      args.json = true
    } else {
      throw new Error(`unknown argument ${arg}`)
    }
  }
  if (args.baseline === undefined || args.current === undefined) {
    throw new Error('usage: node tools/known-red.mjs --baseline <path> --current <path> [--json]')
  }
  return args
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const report = evaluateNoNewRegression(
    readJson(args.baseline, 'baseline'),
    readJson(args.current, 'current'),
  )
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    process.stdout.write(`KNOWN_RED baseline=${report.baselineId} baseCommit=${report.baseCommit} currentCommit=${report.currentCommit}\n`)
    process.stdout.write(`NO_NEW_REGRESSION status=${report.status} newFailures=${report.newFailures.length} waived=${report.waivedFailures.length} unknown=${report.unknownResults.length} unobservedBaseline=${report.unobservedBaseline.length}\n`)
    if (report.newFailures.length > 0) process.stdout.write(`NEW_FAILURES ${report.newFailures.map((entry) => entry.id).join(',')}\n`)
    if (report.waivedFailures.length > 0) process.stdout.write(`WAIVED_FAILURES ${report.waivedFailures.map((entry) => entry.id).join(',')}\n`)
    if (report.unknownResults.length > 0) process.stdout.write(`UNKNOWN_RESULTS ${report.unknownResults.map((entry) => entry.id).join(',')}\n`)
    if (report.unobservedBaseline.length > 0) process.stdout.write(`UNOBSERVED_BASELINE ${report.unobservedBaseline.map((entry) => entry.id).join(',')}\n`)
  }
  if (report.status === 'FAIL') process.exitCode = 1
  else if (report.status === 'UNKNOWN') process.exitCode = 2
  return report
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
