#!/usr/bin/env bun
// tools/lane-guard.mjs — duplicate-lane detector for issue claims.
//
// A "lane" is a concurrent work claim on the same issue: a branch, an open PR,
// or a git worktree naming an issue number. Two people (or two agents) working
// the same issue in parallel is a bug factory, so this tool surfaces it.
//
// All gh/git output is injected through a runner function so the logic is fully
// offline-testable. The real CLI runner shells out; tests pass fixtures.
//
// Exit 1 + `DUPLICATE_LANE` when 2+ open PRs or 2+ worktrees claim one issue.
// Exit 0 + `NO_DUPLICATES` otherwise. Unreadable sources are marked `UNKNOWN`.
//
// Usage: bun tools/lane-guard.mjs

import { execFile } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const DUPLICATE = 'DUPLICATE_LANE'
export const CLEAN = 'NO_DUPLICATES'
export const UNKNOWN = 'UNKNOWN'

export const GIT_BRANCHES = ['git', 'branch', '--format=%(refname:short)']
export const GIT_WORKTREES = ['git', 'worktree', 'list', '--porcelain']
export const GH_PRS = [
  'gh', 'pr', 'list',
  '--state', 'open',
  '--json', 'number,title,body,headRefName,url,state',
]

const KEYWORD = /\b(?:issue|task|feature|feat|fix|bug|chore|integrate|refs?|closes?|fixes?|resolves?)[\s:_/-]*(\d+)/gi

// Extract issue numbers from free text (PR titles/bodies, branch names).
// `allowBare` also accepts `45-foo` / `foo/45` styles used by branch names.
export function extractIssueRefs(text, { allowBare = false } = {}) {
  if (!text) return []
  const refs = new Set()
  const value = String(text)
  for (const m of value.matchAll(/#(\d+)/g)) refs.add(Number(m[1]))
  for (const m of value.matchAll(KEYWORD)) refs.add(Number(m[1]))
  if (allowBare) {
    // Branch refs look like `task/45-fix` or `45-fix`: a leading number in a
    // path segment. Only the segment head counts, so dates in `release/2026-09`
    // are not mistaken for issues.
    for (const segment of value.split('/')) {
      const m = /^(\d+)(?:[-_]|$)/.exec(segment)
      if (!m) continue
      const n = Number(m[1])
      // Skip bare four-digit years so `release/2026-09` is not read as issue 2026.
      if (m[1].length === 4 && n >= 1900 && n <= 2100) continue
      refs.add(n)
    }
  }
  return [...refs].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
}

export function parseBranches(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('('))
}

export function parseWorktrees(porcelain) {
  const text = String(porcelain ?? '')
  const entries = []
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length).trim(), branch: null, detached: false }
    } else if (!current) {
      continue
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line.startsWith('detached')) {
      current.detached = true
    }
  }
  if (current) entries.push(current)
  return entries
}

export function parsePrs(json) {
  let value = json
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json)
    } catch {
      throw new Error('gh pr list returned non-JSON output')
    }
  }
  if (!Array.isArray(value)) throw new Error('gh pr list JSON is not an array')
  return value
}

function makeExecRunner(cwd) {
  return (argv) =>
    new Promise((resolve, reject) => {
      execFile(argv[0], argv.slice(1), { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${argv[0]} failed: ${(stderr || error.message || '').trim().split('\n')[0]}`))
          return
        }
        resolve(stdout)
      })
    })
}

// Core audit. Returns { exitCode, verdict, issues, sources, output } without
// touching the process, so tests can assert on it.
export async function laneGuard({ runner, cwd } = {}) {
  const run = runner ?? makeExecRunner(cwd)
  const sources = {
    branches: { argv: GIT_BRANCHES, ok: false, error: null, count: 0 },
    worktrees: { argv: GIT_WORKTREES, ok: false, error: null, count: 0 },
    prs: { argv: GH_PRS, ok: false, error: null, count: 0 },
  }

  for (const source of Object.values(sources)) {
    try {
      source.raw = await run(source.argv)
      source.ok = true
    } catch (error) {
      source.error = error && error.message ? error.message : String(error)
    }
  }

  const issues = new Map()
  const add = (issue, kind, label) => {
    if (!issues.has(issue)) {
      issues.set(issue, { issue, branches: [], prs: [], worktrees: [] })
    }
    const entry = issues.get(issue)
    if (!entry[kind].includes(label)) entry[kind].push(label)
  }

  if (sources.branches.ok) {
    const branches = parseBranches(sources.branches.raw)
    sources.branches.count = branches.length
    for (const branch of branches) {
      for (const issue of extractIssueRefs(branch, { allowBare: true })) add(issue, 'branches', branch)
    }
  }

  if (sources.worktrees.ok) {
    const worktrees = parseWorktrees(sources.worktrees.raw)
    sources.worktrees.count = worktrees.length
    for (const wt of worktrees) {
      const label = wt.detached ? `detached @ ${wt.path}` : `${wt.branch} @ ${wt.path}`
      for (const issue of extractIssueRefs(wt.branch ?? '', { allowBare: true })) add(issue, 'worktrees', label)
    }
  }

  if (sources.prs.ok) {
    let prs
    try {
      prs = parsePrs(sources.prs.raw)
      sources.prs.count = prs.length
    } catch (error) {
      sources.prs.ok = false
      sources.prs.error = error.message
      prs = []
    }
    for (const pr of prs) {
      if (pr.state && pr.state !== 'OPEN' && String(pr.state).toLowerCase() !== 'open') continue
      const haystack = [pr.title, pr.body, pr.headRefName].filter(Boolean).join('\n')
      for (const issue of extractIssueRefs(haystack)) add(issue, 'prs', `#${pr.number}`)
    }
  }

  let duplicate = false
  for (const entry of issues.values()) {
    entry.duplicate = entry.prs.length >= 2 || entry.worktrees.length >= 2
    if (entry.duplicate) duplicate = true
  }

  const anyReadable = Object.values(sources).some((s) => s.ok)
  const verdict = duplicate ? DUPLICATE : anyReadable ? CLEAN : UNKNOWN
  return { exitCode: duplicate ? 1 : 0, verdict, duplicate, issues, sources }
}

export function formatLaneReport(result) {
  const lines = []
  lines.push('lane-guard: issue lane claim audit')
  lines.push('commands:')
  for (const [name, source] of Object.entries(result.sources)) {
    const command = source.argv.join(' ')
    if (source.ok) {
      lines.push(`  [${name}] ${command} -> ok (${source.count} rows)`)
    } else {
      lines.push(`  [${name}] ${command} -> ${UNKNOWN} (${source.error})`)
    }
  }
  lines.push('issues:')
  const entries = [...result.issues.values()].sort((a, b) => a.issue - b.issue)
  if (entries.length === 0) {
    lines.push('  (none)')
  }
  for (const entry of entries) {
    lines.push(`  #${entry.issue}${entry.duplicate ? ' [DUPLICATE]' : ''}`)
    lines.push(`    branches(${entry.branches.length})=[${entry.branches.join(', ')}]`)
    lines.push(`    prs(${entry.prs.length})=[${entry.prs.join(', ')}]`)
    lines.push(`    worktrees(${entry.worktrees.length})=[${entry.worktrees.join(', ')}]`)
  }
  lines.push(`result: ${result.verdict}`)
  return lines.join('\n')
}

async function main() {
  const result = await laneGuard({ cwd: process.cwd() })
  process.stdout.write(`${formatLaneReport(result)}\n`)
  process.exitCode = result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
