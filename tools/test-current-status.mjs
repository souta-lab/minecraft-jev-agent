import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveStatus, main } from './current-status.mjs'
import { FAIL, INFRA_UNKNOWN } from './ci-classify.mjs'

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

// 1b. A runtime-root override must target the selected worktree, not a magic
// shared checkout path.
{
  const runtimeRoot = '/tmp/m3-live-runtime'
  let observedSocket = null
  const { commands } = await deriveStatus({
    run: makeRunner(),
    runtimeRoot,
    readResident: async (socket) => {
      observedSocket = socket
      return null
    },
  })
  const expectedSocket = join(runtimeRoot, 'buddy-driver', 'data', 'resident', 'control.sock')
  assert.equal(observedSocket, expectedSocket)
  assert.ok(commands.includes(`socket ${expectedSocket} <- {"cmd":"report"} (2000ms timeout)`))
  ok('runtime-root override reads the selected resident socket')
}

// 1c. The CLI accepts the same explicit runtime-root override.
{
  const runtimeRoot = '/tmp/m3-live-cli-runtime'
  let observedSocket = null
  await main(['--runtime-root', runtimeRoot], {
    run: makeRunner(),
    readResident: async (socket) => {
      observedSocket = socket
      return null
    },
  })
  assert.equal(observedSocket, join(runtimeRoot, 'buddy-driver', 'data', 'resident', 'control.sock'))
  ok('CLI runtime-root override reaches the injected resident reader')
}

// 1d. --no-resident must guarantee that NO control-socket command is issued, and must
// say the snapshot was not collected instead of leaving a superseded run id standing.
{
  let readerCalls = 0
  const { markdown } = await main(['--no-resident'], {
    run: makeRunner(),
    readResident: async () => {
      readerCalls += 1
      return { data: { runId: 'run-should-not-be-read' } }
    },
  })
  assert.equal(readerCalls, 0)
  assert.match(markdown, /## Resident snapshot — UNKNOWN/)
  assert.match(markdown, /not collected: --no-resident was set, so this run issued no control-socket command/)
  assert.doesNotMatch(markdown, /run-should-not-be-read/)
  assert.doesNotMatch(markdown, /live: report received/)

  const derived = await deriveStatus({ run: makeRunner(), readResident: false })
  assert.match(derived.markdown, /the previous snapshot is superseded and is NOT current runtime state/)
  assert.ok(!derived.commands.some((command) => command.startsWith('socket ')), 'no socket command may be recorded')
  ok('--no-resident issues no control-socket command and reports the snapshot as not collected')
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

  // The CI section must be present and must NOT claim a code verdict when the
  // workflow run cannot be read at all (issue #299: no silent CI).
  assert.match(markdown, /## CI gate \(repo-invariants\) — UNKNOWN/)
  assert.match(markdown, /- verdict: INFRA_UNKNOWN/)
  assert.match(markdown, /no GitHub Actions result was read, so this snapshot makes NO CI claim/)
  assert.doesNotMatch(markdown, /- verdict: FAIL/)
  ok('unreadable CI is an explicit INFRA_UNKNOWN section, never silent and never FAIL')
}

// 2b. THE regression fixture: the REAL billing run (5 jobs, steps=[], raw
//     conclusion=failure) renders as INFRA_UNKNOWN, not FAIL.
{
  const realBilling = {
    ok: true,
    runId: '35719569221',
    headSha: 'cd7b38b70da61c2883b9a1dc14b34a70a732a88a',
    verdict: INFRA_UNKNOWN,
    reason: 'no job executed a single step (5/5 never started)',
    executedJobs: 0,
    totalJobs: 5,
    jobs: [
      { name: 'system2-harness', verdict: INFRA_UNKNOWN, steps: 0, executedSteps: 0, conclusion: 'failure', reason: 'not started' },
      { name: 'jev-harness', verdict: INFRA_UNKNOWN, steps: 0, executedSteps: 0, conclusion: 'failure', reason: 'not started' },
      { name: 'authority-contract', verdict: INFRA_UNKNOWN, steps: 0, executedSteps: 0, conclusion: 'failure', reason: 'not started' },
      { name: 'convergence', verdict: INFRA_UNKNOWN, steps: 0, executedSteps: 0, conclusion: 'failure', reason: 'not started' },
      { name: 'core-deterministic', verdict: INFRA_UNKNOWN, steps: 0, executedSteps: 0, conclusion: 'failure', reason: 'not started' },
    ],
  }
  const { markdown } = await deriveStatus({
    run: makeRunner(),
    readResident: offlineResident,
    readCi: async () => realBilling,
  })
  assert.match(markdown, /## CI gate \(repo-invariants\) — EVIDENCE/)
  assert.match(markdown, /- verdict: INFRA_UNKNOWN/)
  assert.match(markdown, /- run: 35719569221/)
  assert.match(markdown, /- jobs: 0\/5 executed at least one step/)
  assert.match(markdown, /- job convergence: INFRA_UNKNOWN \(0\/0 executed steps, raw conclusion=failure\)/)
  assert.match(markdown, /This run is NOT a code verdict \(issue #299\)/)
  assert.doesNotMatch(markdown, /- verdict: FAIL/)
  ok('the real billing run renders INFRA_UNKNOWN with the raw conclusion still visible')

  // An executed FAIL must still render as FAIL — the fixture above must not have
  // turned the section into a blanket excuse.
  const { markdown: redMarkdown } = await deriveStatus({
    run: makeRunner(),
    readResident: offlineResident,
    readCi: async () => ({ ...realBilling, verdict: FAIL, reason: '1/5 job(s) executed and failed: convergence' }),
  })
  assert.match(redMarkdown, /- verdict: FAIL/)
  assert.match(redMarkdown, /This IS a code verdict/)
  ok('an executed CI failure still renders FAIL')
}

// 2c. `readCi: false` removes the section entirely (explicit opt-out, not silence by default).
{
  const { markdown } = await deriveStatus({ run: makeRunner(), readResident: offlineResident, readCi: false })
  assert.doesNotMatch(markdown, /## CI gate/)
  ok('readCi:false omits the CI section on explicit opt-out')
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
