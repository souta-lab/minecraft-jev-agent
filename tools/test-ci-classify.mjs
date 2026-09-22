#!/usr/bin/env bun
// tools/test-ci-classify.mjs — offline fixtures for tools/ci-classify.mjs (issue #299).
//
// The decisive fixture is the REAL payload GitHub returned for run 35719569221
// (main @ cd7b38b): five jobs, every one `conclusion=failure`, every one
// `steps: []`, `runner_id: 0`, plus the billing annotation. The classifier MUST
// return INFRA_UNKNOWN for it and MUST NOT return FAIL. That is the invariant
// that stops the ledger from reading a never-started job as a code regression.
import assert from 'node:assert/strict'
import {
  FAIL,
  INFRA_UNKNOWN,
  NOT_STARTED_ANNOTATION,
  PASS,
  classifyJob,
  classifyRun,
  exitCodeFor,
  formatCiLine,
  parseWorkflowJobs,
  readCiStatus,
  readWorkflowJobs,
  stepExecuted,
} from './ci-classify.mjs'

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

// ---------------------------------------------------------------------------
// REAL captured payload: repo-invariants run 35719569221 (main @ cd7b38b).
// Nothing here is invented; it is the verbatim REST shape GitHub served.
// ---------------------------------------------------------------------------
const REAL_BILLING_RUN_ID = '35719569221'
const REAL_BILLING_HEAD = 'cd7b38b70da61c2883b9a1dc14b34a70a732a88a'
const REAL_BILLING_JOBS = [
  { id: 106719017564, name: 'system2-harness', status: 'completed', conclusion: 'failure', started_at: '2026-09-22T11:05:59Z', completed_at: '2026-09-22T11:06:02Z', runner_id: 0, runner_name: '', steps: [] },
  { id: 106719017828, name: 'jev-harness', status: 'completed', conclusion: 'failure', started_at: '2026-09-22T11:05:59Z', completed_at: '2026-09-22T11:06:02Z', runner_id: 0, runner_name: '', steps: [] },
  { id: 106719017893, name: 'authority-contract', status: 'completed', conclusion: 'failure', started_at: '2026-09-22T11:05:59Z', completed_at: '2026-09-22T11:06:02Z', runner_id: 0, runner_name: '', steps: [] },
  { id: 106719017961, name: 'convergence', status: 'completed', conclusion: 'failure', started_at: '2026-09-22T11:05:59Z', completed_at: '2026-09-22T11:06:03Z', runner_id: 0, runner_name: '', steps: [] },
  { id: 106719018001, name: 'core-deterministic', status: 'completed', conclusion: 'failure', started_at: '2026-09-22T11:05:59Z', completed_at: '2026-09-22T11:06:02Z', runner_id: 0, runner_name: '', steps: [] },
]
const realAnnotations = () => ({
  '106719017564': [{ annotation_level: 'failure', path: '.github', message: NOT_STARTED_ANNOTATION }],
  '106719017828': [{ annotation_level: 'failure', path: '.github', message: NOT_STARTED_ANNOTATION }],
  '106719017893': [{ annotation_level: 'failure', path: '.github', message: NOT_STARTED_ANNOTATION }],
  '106719017961': [{ annotation_level: 'failure', path: '.github', message: NOT_STARTED_ANNOTATION }],
  '106719018001': [{ annotation_level: 'failure', path: '.github', message: NOT_STARTED_ANNOTATION }],
})

// 1. THE invariant: a never-started job is INFRA_UNKNOWN, never FAIL.
{
  const result = classifyRun({ jobs: REAL_BILLING_JOBS, annotationsByJob: realAnnotations() })
  assert.equal(result.verdict, INFRA_UNKNOWN)
  assert.notEqual(result.verdict, FAIL)
  assert.equal(result.executedJobs, 0)
  assert.equal(result.jobs.length, 5)
  assert.ok(result.jobs.every((job) => job.verdict === INFRA_UNKNOWN))
  ok('REAL billing run (5 jobs, steps=[], conclusion=failure) classifies INFRA_UNKNOWN, never FAIL')

  // The verbatim annotation is carried through, not paraphrased.
  assert.ok(result.jobs.every((job) => job.reason === NOT_STARTED_ANNOTATION))
  assert.match(result.jobs[0].reason, /recent account payments have failed/)
  assert.match(result.jobs[0].reason, /spending limit needs to be increased/)
  ok('the exact GitHub billing annotation is preserved verbatim as the job reason')

  // The raw GitHub conclusion is still reported honestly - we do not hide it.
  assert.ok(result.jobs.every((job) => job.conclusion === 'failure'))
  assert.match(result.reason, /no job executed a single step \(5\/5 never started\)/)
  ok('the raw GitHub conclusion stays visible while the verdict stays INFRA_UNKNOWN')

  assert.equal(exitCodeFor(result.verdict), 2)
  ok('INFRA_UNKNOWN exits 2 (neither 0 PASS nor 1 code-FAIL)')
}

// 2. Same payload WITHOUT annotations is still INFRA_UNKNOWN (zero steps alone decides).
{
  const result = classifyRun({ jobs: REAL_BILLING_JOBS })
  assert.equal(result.verdict, INFRA_UNKNOWN)
  assert.match(result.jobs[0].reason, /zero executed steps/)
  ok('zero executed steps alone is sufficient for INFRA_UNKNOWN (annotations are corroboration)')
}

// 3. A genuinely executed, green run is PASS.
{
  const green = [
    {
      id: 1,
      name: 'convergence',
      conclusion: 'success',
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Run bun run issue-state:check', status: 'completed', conclusion: 'success' },
      ],
    },
    {
      id: 2,
      name: 'core-deterministic',
      conclusion: 'success',
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Typecheck', status: 'completed', conclusion: 'success' },
      ],
    },
  ]
  const result = classifyRun({ jobs: green })
  assert.equal(result.verdict, PASS)
  assert.equal(result.executedJobs, 2)
  assert.equal(exitCodeFor(PASS), 0)
  ok('an executed, green run is PASS (exit 0)')
}

// 4. A genuinely executed failure is FAIL - the classifier must not become a
//    blanket excuse that launders real redness.
{
  const red = [
    {
      id: 3,
      name: 'convergence',
      conclusion: 'failure',
      steps: [
        { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
        { number: 2, name: 'Live issue-state invariant', status: 'completed', conclusion: 'failure' },
      ],
    },
  ]
  const result = classifyRun({ jobs: red })
  assert.equal(result.verdict, FAIL)
  assert.equal(exitCodeFor(FAIL), 1)
  assert.match(result.jobs[0].reason, /Live issue-state invariant/)
  ok('an executed failing step is FAIL (exit 1) with the failing step named')
}

// 5. Code FAIL dominates a sibling never-started job: real redness is never hidden.
{
  const mixed = [
    {
      id: 4,
      name: 'convergence',
      conclusion: 'failure',
      steps: [{ number: 1, name: 'Frontier fixtures', status: 'completed', conclusion: 'failure' }],
    },
    { id: 5, name: 'system2-harness', conclusion: 'failure', runner_id: 0, steps: [] },
  ]
  const result = classifyRun({ jobs: mixed, annotationsByJob: realAnnotations() })
  assert.equal(result.verdict, FAIL)
  assert.equal(result.executedJobs, 1)
  ok('an executed FAIL dominates a never-started sibling (redness is not laundered)')
}

// 6. An empty run is INFRA_UNKNOWN, not a vacuous PASS.
{
  const result = classifyRun({ jobs: [] })
  assert.equal(result.verdict, INFRA_UNKNOWN)
  assert.equal(exitCodeFor(INFRA_UNKNOWN), 2)
  ok('a run with no jobs is INFRA_UNKNOWN, never a vacuous PASS')
}

// 7. Partial execution: some jobs ran green, others never started -> INFRA_UNKNOWN
//    (the run cannot be called PASS when part of the gate set did not execute).
{
  const partial = [
    {
      id: 6,
      name: 'convergence',
      conclusion: 'success',
      steps: [{ number: 1, name: 'Frontier fixtures', status: 'completed', conclusion: 'success' }],
    },
    { id: 7, name: 'system2-harness', conclusion: 'failure', runner_id: 0, steps: [] },
  ]
  const result = classifyRun({ jobs: partial })
  assert.equal(result.verdict, INFRA_UNKNOWN)
  assert.equal(result.executedJobs, 1)
  assert.match(result.reason, /1\/2 job\(s\) never started/)
  ok('partially executed gate set is INFRA_UNKNOWN, not PASS')
}

// 8. Skipped steps still count as an executed verdict slot; a cancelled job that
//    ran steps is FAIL, not INFRA_UNKNOWN.
{
  assert.equal(stepExecuted({ number: 1, name: 'x', status: 'completed', conclusion: 'skipped' }), true)
  assert.equal(stepExecuted({}), false)
  assert.equal(stepExecuted(null), false)
  const cancelled = classifyJob({
    name: 'convergence',
    conclusion: 'cancelled',
    steps: [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' }],
  })
  assert.equal(cancelled.verdict, FAIL)
  assert.equal(cancelled.executedSteps, 1)
  ok('executed-but-cancelled is FAIL; only zero executed steps is INFRA_UNKNOWN')
}

// 9. readCiStatus end-to-end against an injected runner that replays the REAL
//    payload, including the annotation endpoint.
{
  const seen = []
  const runner = async (command, args) => {
    seen.push([command, ...args].join(' '))
    if (command !== 'gh') return { ok: false, code: 127, stdout: '', stderr: `unexpected ${command}` }
    const joined = args.join(' ')
    if (joined.startsWith('api repos/souta-lab/minecraft-jev-agent/actions/runs/35719569221/jobs')) {
      return { ok: true, code: 0, stdout: JSON.stringify({ total_count: 5, jobs: REAL_BILLING_JOBS }), stderr: '' }
    }
    if (joined.startsWith('api repos/souta-lab/minecraft-jev-agent/actions/runs/35719569221')) {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify({ head_sha: REAL_BILLING_HEAD, created_at: '2026-09-22T11:05:58Z', name: 'repo-invariants' }),
        stderr: '',
      }
    }
    const annotation = joined.match(/check-runs\/(\d+)\/annotations/)
    if (annotation) {
      return {
        ok: true,
        code: 0,
        stdout: JSON.stringify([{ annotation_level: 'failure', path: '.github', message: NOT_STARTED_ANNOTATION }]),
        stderr: '',
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: `unexpected gh args: ${joined}` }
  }
  const status = await readCiStatus(runner, { runId: REAL_BILLING_RUN_ID })
  assert.equal(status.ok, true)
  assert.equal(status.verdict, INFRA_UNKNOWN)
  assert.equal(status.totalJobs, 5)
  assert.equal(status.executedJobs, 0)
  assert.equal(status.runId, REAL_BILLING_RUN_ID)
  assert.equal(status.headSha, REAL_BILLING_HEAD)
  assert.ok(status.jobs.every((job) => job.verdict === INFRA_UNKNOWN))
  assert.ok(seen.some((line) => line.includes('/actions/runs/35719569221/jobs')))
  ok('readCiStatus replays the real billing run end-to-end and reports INFRA_UNKNOWN')

  const line = formatCiLine(status)
  assert.match(line, /CI run 35719569221 @ cd7b38b7: INFRA_UNKNOWN/)
  ok('formatCiLine renders a one-line ledger-safe summary')
}

// 10. An unreadable GitHub is INFRA_UNKNOWN, never FAIL and never PASS.
{
  const failing = async () => ({ ok: false, code: 1, stdout: '', stderr: 'gh: not authenticated' })
  const status = await readCiStatus(failing, { runId: '1' })
  assert.equal(status.ok, false)
  assert.equal(status.verdict, INFRA_UNKNOWN)
  assert.match(formatCiLine(status), /unreadable: gh: not authenticated/)
  ok('an unreadable CI source degrades to INFRA_UNKNOWN with the reason shown')
}

// 11. The gate inventory is DERIVED from the real workflow file, and the local
//     gate battery in the task maps onto real job steps.
{
  const read = readWorkflowJobs()
  assert.equal(read.ok, true)
  const jobs = read.jobs
  assert.deepEqual(Object.keys(jobs).sort(), [
    'authority-contract',
    'convergence',
    'core-deterministic',
    'jev-harness',
    'system2-harness',
  ])
  assert.ok(jobs.convergence.commands.includes('bun run bun-residue-check'))
  assert.ok(jobs.convergence.commands.includes('bun run frontier:check'))
  assert.ok(jobs.convergence.commands.includes('bun run issue-state:check'))
  ok('workflow job/gate inventory is derived from .github/workflows/repo-invariants.yml')

  // The listed commands are exactly the ones the file contains - no invention.
  const raw = parseWorkflowJobs(read.jobs ? '' : '')
  assert.deepEqual(raw, {})
  ok('parseWorkflowJobs does not invent jobs for empty input')
}

// 12. The classifier's own verdict vocabulary is stable (callers switch on it).
{
  assert.deepEqual([PASS, FAIL, INFRA_UNKNOWN], ['PASS', 'FAIL', 'INFRA_UNKNOWN'])
  ok('verdict vocabulary is stable: PASS / FAIL / INFRA_UNKNOWN')
}

console.log(`ci-classify: ${checks}/${checks} checks passed`)
