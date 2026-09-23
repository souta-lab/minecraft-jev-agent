#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_PATH = resolve('ISSUE-STATE.json')
const ROUTING_PATH = resolve('ISSUE-ROUTING.json')

export function defaultIssueReader() {
  return JSON.parse(execFileSync('gh', ['issue', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,title,state'], { encoding: 'utf8' }))
}

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const LIVE_CLASSES = /live|soak|closed-loop|resident/i
// A closed row is either verified-complete or explicitly recorded as superseded by a
// fold. Without the second disposition a tracking fold can only be written as
// compliance=pass, which would be false evidence (the defect was not fixed).
const DISPOSITIONS = new Set(['active', 'superseded'])

export function validateIssueState(issues, manifest, routing) {
  const errors = []
  const warnings = []
  const byNumber = new Map((Array.isArray(issues) ? issues : []).map((issue) => [Number(issue.number), issue]))
  const records = manifest?.issues ?? {}
  const dimensions = manifest?.dimensions ?? {}
  const allowed = Object.fromEntries(Object.entries(dimensions).map(([key, values]) => [key, new Set(values)]))
  const configuredDispositions = allowed.disposition ?? DISPOSITIONS

  const required = new Set()
  for (const key of ['now', 'next', 'waitingLive', 'research']) {
    for (const number of routing?.[key] ?? []) required.add(Number(number))
  }
  for (const issue of byNumber.values()) {
    if (issue.state === 'OPEN' && /^P[01](?:\s|:|-)/i.test(issue.title ?? '')) required.add(Number(issue.number))
  }

  for (const number of required) {
    const record = records[String(number)]
    if (!record) errors.push(`#${number} is active/significant but missing from ISSUE-STATE.json`)
    else if (record.disposition === 'superseded') errors.push(`#${number} is routed as active work but its ISSUE-STATE.json record is superseded`)
  }

  for (const [rawNumber, record] of Object.entries(records)) {
    const number = Number(rawNumber)
    if (!Number.isInteger(number)) {
      errors.push(`invalid issue key ${rawNumber}`)
      continue
    }
    const issue = byNumber.get(number)
    if (!issue) {
      warnings.push(`#${number} is in ISSUE-STATE.json but was not returned by gh issue list`)
      continue
    }
    for (const key of ['policy', 'implementation', 'verification', 'observation', 'compliance']) {
      if (!allowed[key]?.has(record[key])) errors.push(`#${number} invalid ${key}=${String(record[key])}`)
    }
    const disposition = record.disposition ?? 'active'
    if (!configuredDispositions.has(disposition)) {
      errors.push(`#${number} invalid disposition=${String(record.disposition)}`)
    }
    if (record.implementation === 'none' && record.compliance === 'pass') {
      errors.push(`#${number} cannot be compliance=pass with implementation=none`)
    }
    if (record.observation === 'fail' && record.compliance === 'pass') {
      errors.push(`#${number} cannot be compliance=pass with observation=fail`)
    }
    if (record.compliance === 'pass' && LIVE_CLASSES.test(record.acceptanceClass ?? '')) {
      if (record.observation !== 'pass' || record.verification !== 'live') {
        errors.push(`#${number} live/soak/closed-loop compliance=pass requires verification=live and observation=pass`)
      }
    }
    if (issue.state === 'CLOSED' && disposition === 'superseded') {
      // A fold is not a fix: the row may not claim compliance, and it must name the
      // open umbrella that now carries its acceptance.
      if (record.compliance === 'pass') {
        errors.push(`#${number} is superseded (folded, not fixed) and cannot be compliance=pass`)
      }
      const absorber = Number(record.supersededBy)
      if (!Number.isInteger(absorber)) {
        errors.push(`#${number} is superseded but does not name supersededBy`)
      } else if (!byNumber.has(absorber)) {
        errors.push(`#${number} is superseded by #${absorber}, which does not exist in the GitHub issue set`)
      } else if (byNumber.get(absorber).state !== 'OPEN') {
        errors.push(`#${number} is superseded by #${absorber}, which is not open`)
      }
    }
    if (issue.state === 'OPEN' && disposition === 'superseded') {
      errors.push(`#${number} is marked superseded but is still open`)
    }
    if (issue.state === 'CLOSED' && disposition !== 'superseded' && record.compliance !== 'pass') {
      errors.push(`#${number} is closed while machine-readable compliance=${record.compliance}`)
    }
    if (issue.state === 'OPEN' && record.compliance === 'pass') {
      errors.push(`#${number} is still open although machine-readable compliance=pass`)
    }
  }

  return { errors, warnings, byNumber, records, required: [...required].sort((a, b) => a - b) }
}

export function renderIssueState(issues, manifest, routing) {
  const result = validateIssueState(issues, manifest, routing)
  const lines = ['# Issue Evidence State', '', '| Issue | Implementation | Verification | Observation | Compliance | Class |', '| --- | --- | --- | --- | --- | --- |']
  for (const number of result.required) {
    const record = result.records[String(number)]
    const issue = result.byNumber.get(number)
    if (!record) {
      lines.push(`| #${number} ${issue?.title ?? ''} | MISSING | MISSING | MISSING | MISSING | MISSING |`)
      continue
    }
    lines.push(`| #${number} ${issue?.title ?? ''} | ${record.implementation} | ${record.verification} | ${record.observation} | ${record.compliance} | ${record.acceptanceClass} |`)
  }
  const superseded = Object.entries(result.records)
    .filter(([, record]) => record.disposition === 'superseded')
    .map(([rawNumber]) => Number(rawNumber))
    .sort((a, b) => a - b)
  if (superseded.length > 0) {
    lines.push('', '## Superseded (closed as folds — acceptance carried by the named umbrella, not fixed)', '', '| Issue | Superseded by | Implementation | Verification | Observation | Compliance |', '| --- | --- | --- | --- | --- | --- |')
    for (const number of superseded) {
      const record = result.records[String(number)]
      const issue = result.byNumber.get(number)
      lines.push(`| #${number} ${issue?.title ?? ''} | #${record.supersededBy} | ${record.implementation} | ${record.verification} | ${record.observation} | ${record.compliance} |`)
    }
  }
  if (result.errors.length || result.warnings.length) {
    lines.push('', '## Diagnostics')
    for (const error of result.errors) lines.push(`- ERROR: ${error}`)
    for (const warning of result.warnings) lines.push(`- WARN: ${warning}`)
  }
  return { ...result, markdown: `${lines.join('\n')}\n` }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  let issues
  try {
    issues = (deps.readIssues ?? defaultIssueReader)()
  } catch (error) {
    process.stderr.write(`issue-state: failed to read GitHub issues: ${error?.message ?? String(error)}\n`)
    return 2
  }
  const manifest = deps.manifest ?? loadJson(deps.statePath ?? STATE_PATH)
  const routing = deps.routing ?? loadJson(deps.routingPath ?? ROUTING_PATH)
  const result = renderIssueState(issues, manifest, routing)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ required: result.required, errors: result.errors, warnings: result.warnings }, null, 2)}\n`)
  } else {
    process.stdout.write(result.markdown)
  }
  return argv.includes('--check') && result.errors.length > 0 ? 1 : 0
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) process.exitCode = main()
