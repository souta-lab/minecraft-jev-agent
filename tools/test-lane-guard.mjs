#!/usr/bin/env bun
// tools/test-lane-guard.mjs — offline fixtures for tools/lane-guard.mjs.
//
// No network, no real gh/git: every source is injected through a fake runner.
// Verifies the four acceptance cases: duplicate worktrees, a single lane, a
// branch with no issue ref, and unreadable gh output.
//
// Usage: bun tools/test-lane-guard.mjs

import assert from 'node:assert/strict'
import process from 'node:process'
import {
  DUPLICATE,
  CLEAN,
  UNKNOWN,
  laneGuard,
  formatLaneReport,
  extractIssueRefs,
  parseWorktrees,
} from './lane-guard.mjs'

let checks = 0
let passed = 0
async function check(name, fn) {
  checks++
  try {
    await fn()
    passed++
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error && error.stack ? error.stack : String(error)}\n`)
    throw error
  }
}

const key = (argv) => argv.join(' ')
const BRANCHES = key(['git', 'branch', '--format=%(refname:short)'])
const WORKTREES = key(['git', 'worktree', 'list', '--porcelain'])
const PRS = key(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,body,headRefName,url,state'])

// Build a runner from { command: stdout | Error }.
function makeRunner(responses) {
  const calls = []
  const runner = async (argv) => {
    const command = key(argv)
    calls.push(command)
    const value = responses[command]
    if (value === undefined) throw new Error(`unexpected command: ${command}`)
    if (value instanceof Error) throw value
    return value
  }
  return { runner, calls }
}

function worktreePorcelain(entries) {
  const blocks = []
  for (const entry of entries) {
    blocks.push(`worktree ${entry.path}`)
    blocks.push('HEAD 0000000000000000000000000000000000000000')
    if (entry.branch) blocks.push(`branch refs/heads/${entry.branch}`)
    else blocks.push('detached')
    blocks.push('')
  }
  return `${blocks.join('\n')}\n`
}

async function main() {
  await check('extractIssueRefs handles #N, keyword, and bare branch styles', () => {
    assert.deepEqual(extractIssueRefs('Closes #45'), [45])
    assert.deepEqual(extractIssueRefs('task/45-alpha', { allowBare: true }), [45])
    assert.deepEqual(extractIssueRefs('chore/cleanup', { allowBare: true }), [])
    assert.deepEqual(extractIssueRefs('v25.9.0', { allowBare: true }), [])
    assert.deepEqual(extractIssueRefs('release/2026-09', { allowBare: true }), [])
  })

  await check('parseWorktrees reads branches and detached HEADs', () => {
    const parsed = parseWorktrees(worktreePorcelain([
      { path: '/repo', branch: 'main' },
      { path: '/repo-wt-45', branch: 'task/45-alpha' },
      { path: '/repo-detached', branch: null },
    ]))
    assert.equal(parsed.length, 3)
    assert.equal(parsed[0].branch, 'main')
    assert.equal(parsed[1].branch, 'task/45-alpha')
    assert.equal(parsed[2].detached, true)
  })

  await check('two branches on #45 -> DUPLICATE_LANE + exit 1', async () => {
    const { runner } = makeRunner({
      [BRANCHES]: 'main\ntask/45-alpha\ntask/45-beta\n',
      [WORKTREES]: worktreePorcelain([
        { path: '/repo', branch: 'main' },
        { path: '/repo-45-alpha', branch: 'task/45-alpha' },
        { path: '/repo-45-beta', branch: 'task/45-beta' },
      ]),
      [PRS]: '[]',
    })
    const result = await laneGuard({ runner })
    assert.equal(result.verdict, DUPLICATE)
    assert.equal(result.exitCode, 1)
    const text = formatLaneReport(result)
    assert.match(text, /DUPLICATE_LANE/)
    assert.match(text, /#45 \[DUPLICATE\]/)
    assert.match(text, /worktrees\(2\)=\[/)
    assert.match(text, /task\/45-alpha/)
    assert.match(text, /task\/45-beta/)
    assert.match(text, /\[branches\] git branch --format=%\(refname:short\) -> ok/)
    assert.match(text, /\[worktrees\] git worktree list --porcelain -> ok/)
    assert.match(text, /\[prs\] gh pr list --state open/)
  })

  await check('one branch on #45 -> NO_DUPLICATES + exit 0', async () => {
    const { runner } = makeRunner({
      [BRANCHES]: 'main\ntask/45-solo\n',
      [WORKTREES]: worktreePorcelain([
        { path: '/repo', branch: 'main' },
        { path: '/repo-45-solo', branch: 'task/45-solo' },
      ]),
      [PRS]: JSON.stringify([
        { number: 7, title: 'feat(#45): solo lane', body: 'Closes #45', headRefName: 'task/45-solo', state: 'OPEN' },
      ]),
    })
    const result = await laneGuard({ runner })
    assert.equal(result.verdict, CLEAN)
    assert.equal(result.exitCode, 0)
    const text = formatLaneReport(result)
    assert.match(text, /NO_DUPLICATES/)
    assert.match(text, /#45\n/)
    assert.match(text, /prs\(1\)=\[#7\]/)
  })

  await check('branch without an issue ref is ignored', async () => {
    const { runner } = makeRunner({
      [BRANCHES]: 'main\nchore/cleanup\nrelease/2026-09\n',
      [WORKTREES]: worktreePorcelain([{ path: '/repo', branch: 'main' }]),
      [PRS]: '[]',
    })
    const result = await laneGuard({ runner })
    assert.equal(result.verdict, CLEAN)
    assert.equal(result.exitCode, 0)
    assert.equal(result.issues.size, 0)
    const text = formatLaneReport(result)
    assert.match(text, /\(none\)/)
    assert.doesNotMatch(text, /DUPLICATE_LANE/)
  })

  await check('unreadable gh -> UNKNOWN with no false duplicate', async () => {
    const { runner } = makeRunner({
      [BRANCHES]: 'main\ntask/45-solo\n',
      [WORKTREES]: worktreePorcelain([
        { path: '/repo', branch: 'main' },
        { path: '/repo-45-solo', branch: 'task/45-solo' },
      ]),
      [PRS]: new Error('gh failed: not authenticated'),
    })
    const result = await laneGuard({ runner })
    assert.equal(result.verdict, CLEAN)
    assert.equal(result.exitCode, 0)
    assert.equal(result.duplicate, false)
    assert.equal(result.sources.prs.ok, false)
    const text = formatLaneReport(result)
    assert.match(text, /UNKNOWN \(gh failed: not authenticated\)/)
    assert.doesNotMatch(text, /DUPLICATE_LANE/)
  })

  await check('all sources unreadable -> UNKNOWN verdict', async () => {
    const { runner } = makeRunner({
      [BRANCHES]: new Error('git failed: not a repo'),
      [WORKTREES]: new Error('git failed: not a repo'),
      [PRS]: new Error('gh failed: not found'),
    })
    const result = await laneGuard({ runner })
    assert.equal(result.verdict, UNKNOWN)
    assert.equal(result.exitCode, 0)
    const text = formatLaneReport(result)
    assert.match(text, /result: UNKNOWN/)
  })
}

main().then(() => {
  process.stdout.write(`lane-guard fixture: ${passed}/${checks} checks passed\n`)
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
