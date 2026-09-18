#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROUTING_PATH = resolve('ISSUE-ROUTING.json')
export const GH_ARGS = ['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,url']

export function defaultIssueReader() {
  return JSON.parse(execFileSync('gh', GH_ARGS, { encoding: 'utf8' }))
}

export function loadRouting(path = ROUTING_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function uniqueNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter(Number.isInteger))]
}

export function classify(issues, routing) {
  const open = new Map((Array.isArray(issues) ? issues : []).map((issue) => [Number(issue.number), issue]))
  const categories = {
    NOW: uniqueNumbers(routing.now),
    NEXT: uniqueNumbers(routing.next),
    WAITING_LIVE: uniqueNumbers(routing.waitingLive),
    RESEARCH: uniqueNumbers(routing.research),
    FUTURE: uniqueNumbers(routing.future),
    REFERENCE_ONLY: uniqueNumbers(routing.referenceOnly),
  }
  const errors = []
  const warnings = []
  const seen = new Map()
  const wipLimit = Number(routing?.policy?.wipLimit ?? 3)

  if (categories.NOW.length > wipLimit) {
    errors.push(`NOW has ${categories.NOW.length} items; WIP limit is ${wipLimit}`)
  }

  for (const [category, numbers] of Object.entries(categories)) {
    for (const number of numbers) {
      const previous = seen.get(number)
      if (previous) errors.push(`#${number} appears in both ${previous} and ${category}`)
      else seen.set(number, category)
      if (!open.has(number)) warnings.push(`#${number} is routed as ${category} but is not currently open`)
    }
  }

  const unclassified = []
  const priorityUnclassified = []
  for (const issue of open.values()) {
    if (seen.has(Number(issue.number))) continue
    unclassified.push(issue)
    if (/^P[01](?:\s|:|-)/i.test(issue.title ?? '')) priorityUnclassified.push(issue)
  }
  if (priorityUnclassified.length > 0) {
    errors.push(`unclassified P0/P1 issues: ${priorityUnclassified.map((issue) => `#${issue.number}`).join(', ')}`)
  }

  return { open, categories, unclassified, errors, warnings, wipLimit }
}

function issueLine(number, open, routing) {
  const issue = open.get(number)
  const title = issue?.title ?? 'CLOSED / missing from open set'
  const note = routing?.notes?.[String(number)]
  return `- #${number} ${title}${note ? ` — ${note}` : ''}`
}

export function render(issues, routing) {
  const result = classify(issues, routing)
  const lines = []
  lines.push('# Execution Frontier')
  lines.push('')
  lines.push('This is a routing view, not a second issue tracker. CURRENT-STATUS owns observed runtime state; GitHub issues own acceptance/history; ISSUE-ROUTING.json only decides what an autonomous worker is allowed to pick next.')
  lines.push('')
  lines.push(`WIP limit: ${result.wipLimit}. Unclassified open issues default to BACKLOG and are not normal work.`)
  lines.push('')
  lines.push('## NOW — executable')
  if (result.categories.NOW.length === 0) lines.push('- none')
  else for (const number of result.categories.NOW) lines.push(issueLine(number, result.open, routing))
  lines.push('')
  lines.push('Rule: pick from NOW only. Do not start NEXT just because another lane is inconvenient; first prove the NOW item is blocked, landed, or awaiting external/live evidence.')
  lines.push('')
  for (const category of ['NEXT', 'WAITING_LIVE', 'RESEARCH', 'FUTURE', 'REFERENCE_ONLY']) {
    lines.push(`## ${category.replace('_', ' ')} — not normal coding work`)
    const entries = result.categories[category]
    if (entries.length === 0) lines.push('- none')
    else for (const number of entries) lines.push(issueLine(number, result.open, routing))
    lines.push('')
  }
  lines.push('## BACKLOG')
  lines.push(`- ${result.unclassified.length} other open issues are deliberately hidden from the execution frontier.`)
  lines.push('- Do not enumerate or evaluate them during normal ORIENT. Search them only when a NOW issue references them or when promoting NEXT work.')
  lines.push('')
  lines.push('## Issue creation rule')
  lines.push(`- ${routing?.policy?.newIssueRule ?? 'Search for overlap before creating a new issue.'}`)
  lines.push('- A newly observed failure should normally become: evidence/comment on the active issue -> regression fixture -> only then a new issue if its acceptance boundary is genuinely independent.')
  lines.push('')
  if (result.errors.length || result.warnings.length) {
    lines.push('## Routing diagnostics')
    for (const error of result.errors) lines.push(`- ERROR: ${error}`)
    for (const warning of result.warnings) lines.push(`- WARN: ${warning}`)
    lines.push('')
  }
  return { markdown: `${lines.join('\n')}\n`, ...result }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const readIssues = deps.readIssues ?? defaultIssueReader
  const routing = deps.routing ?? loadRouting(deps.routingPath ?? ROUTING_PATH)
  let issues
  try {
    issues = readIssues()
  } catch (error) {
    process.stderr.write(`frontier: failed to read GitHub issues: ${error?.message ?? String(error)}\n`)
    return 2
  }
  const report = render(issues, routing)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: routing.schemaVersion,
      now: report.categories.NOW,
      next: report.categories.NEXT,
      waitingLive: report.categories.WAITING_LIVE,
      research: report.categories.RESEARCH,
      future: report.categories.FUTURE,
      referenceOnly: report.categories.REFERENCE_ONLY,
      backlogCount: report.unclassified.length,
      errors: report.errors,
      warnings: report.warnings,
    }, null, 2)}\n`)
  } else {
    process.stdout.write(report.markdown)
  }
  if (argv.includes('--write')) writeFileSync('FRONTIER.md', report.markdown)
  if (argv.includes('--check') && report.errors.length > 0) return 1
  return 0
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) process.exitCode = main()
