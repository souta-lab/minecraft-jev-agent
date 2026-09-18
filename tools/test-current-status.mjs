import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveStatus, main } from './current-status.mjs'

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const GIT_STDOUT = [
  'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  'Fix the thing',
  '2026-09-18T10:00:00+00:00',
  '',
].join('\n')
const PR_STDOUT = JSON.stringify([
  { number: 41, title: 'Add status tool', headRefName: 'task/status-tool' },
  { number: 42, title: 'Docs debloat', headRefName: 'task/docs-debloat' },
])
const ISSUE_STDOUT = JSON.stringify([
  { number: 7, title: 'Crash on startup', labels: [{ name: 'P0' }, { name: 'bug' }] },
  { number: 8, title: 'Slow path', labels: [{ name: 'P1' }] },
  { number: 9, title: 'Nice to have', labels: [] },
  // The live repo carries almost no labels, so a titled priority must still count.
  { number: 10, title: 'P1: unlabelled but titled priority', labels: [] },
])

function makeRunner({ ghOk = true } = {}) {
  return async (command, args) => {
    if (command === 'git') return { ok: true, code: 0, stdout: GIT_STDOUT, stderr: '' }
    if (command === 'gh' && args[0] === 'pr') {
      if (!ghOk) return { ok: false, code: 1, stdout: '', stderr: 'gh: not authenticated' }
      return { ok: true, code: 0, stdout: PR_STDOUT, stderr: '' }
    }
    if (command === 'gh' && args[0] === 'issue') {
      if (!ghOk) return { ok: false, code: 1, stdout: '', stderr: 'gh: not authenticated' }
      return { ok: true, code: 0, stdout: ISSUE_STDOUT, stderr: '' }
    }
    return { ok: false, code: 127, stdout: '', stderr: `unexpected command: ${command}` }
  }
}

const offlineResident = async () => null

// 1. Happy path: every value comes from the injected output.
{
  const { markdown, commands } = await deriveStatus({ run: makeRunner(), readResident: offlineResident })
  assert.match(markdown, /## Base commit \(origin\/main\) — EVIDENCE/)
  assert.match(markdown, /a1b2c3d4e5f60718293a4b5c6d7e8f9012345678/)
  assert.match(markdown, /- subject: Fix the thing/)
  ok('base commit values come from injected git output')

  assert.match(markdown, /## Open pull requests — EVIDENCE/)
  assert.match(markdown, /- count: 2/)
  assert.match(markdown, /#41 Add status tool \(head: task\/status-tool\)/)
  ok('pull request values come from injected gh output')

  assert.match(markdown, /## Open issues — EVIDENCE/)
  assert.match(markdown, /- count: 4/)
  assert.match(markdown, /- P0: 1/)
  assert.match(markdown, /- P1: 2/)
  assert.match(markdown, /- #9 Nice to have — no labels/)
  assert.match(markdown, /- priority source: labels first, then title prefix \(1 counted from title only\)/)
  ok('issue counts and P0\/P1 derived from labels AND title prefix, empty labels reported as "no labels"')

  assert.match(markdown, /## Resident snapshot — UNKNOWN/)
  assert.match(markdown, /live: unavailable/)
  ok('missing resident socket is UNKNOWN, not fabricated')

  assert.ok(commands.includes('gh pr list --state open --limit 1000 --json number,title,headRefName'))
  assert.match(markdown, /## Evidence commands — EVIDENCE/)
  assert.match(markdown, /gh issue list --state open --limit 1000 --json number,title,labels/)
  ok('exact evidence commands are printed')
}

// 2. Failing gh -> UNKNOWN, no crash, no fabricated zero.
{
  const { markdown } = await deriveStatus({ run: makeRunner({ ghOk: false }), readResident: offlineResident })
  assert.match(markdown, /## Open pull requests — UNKNOWN/)
  assert.match(markdown, /## Open issues — UNKNOWN/)
  assert.match(markdown, /gh: not authenticated/)
  assert.doesNotMatch(markdown, /- count: 0/)
  assert.doesNotMatch(markdown, /- P0: 0/)
  assert.doesNotMatch(markdown, /- P1: 0/)
  ok('failing gh degrades to UNKNOWN with no fabricated zero')
}

// 3. --write writes CURRENT-STATUS.md including the evidence-commands section.
{
  const dir = mkdtempSync(join(tmpdir(), 'current-status-'))
  try {
    const { written } = await main(['--write'], {
      cwd: dir,
      run: makeRunner(),
      readResident: offlineResident,
    })
    assert.equal(written, join(dir, 'CURRENT-STATUS.md'))
    const file = readFileSync(join(dir, 'CURRENT-STATUS.md'), 'utf8')
    assert.match(file, /## Evidence commands — EVIDENCE/)
    assert.match(file, /git log -1 --format=%H%n%s%n%cI origin\/main/)
    assert.match(file, /gh pr list --state open --limit 1000 --json number,title,headRefName/)
    ok('--write output includes the evidence-commands section')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`current-status: ${checks}/${checks} checks passed`)
