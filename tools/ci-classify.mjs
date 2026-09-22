#!/usr/bin/env bun
// tools/ci-classify.mjs — classify a GitHub Actions workflow run HONESTLY.
//
// Issue #299 (in-repo half) / #424 blocker: `repo-invariants` jobs can conclude
// `failure` WITHOUT EVER STARTING. GitHub reports the annotation
//
//   The job was not started because recent account payments have failed or your
//   spending limit needs to be increased. Please check the 'Billing & plans'
//   section in your settings
//
// and the job payload carries `steps: []`, `runner_id: 0`. Acceptance and
// reconciliation tooling must never read that as a repository regression: a job
// that never executed a single step produced NO code verdict at all, so the
// honest classification is INFRA_UNKNOWN.
//
// The three verdicts are deliberately separated the way ISSUE #63 separates
// POLICY / IMPLEMENTED / OBSERVED / COMPLIANCE:
//
//   PASS          = every job executed at least one step and concluded success
//   FAIL          = at least one job EXECUTED steps and did not succeed
//   INFRA_UNKNOWN = no job executed any step (billing / runner / bootstrap),
//                   or the run could not be read at all
//
// FAIL only ever describes an executed job. A never-started job can never make
// the verdict FAIL — that is the invariant the fixture pins.
//
// Commands:
//   classify --run <runId>            classify one run (default: newest run)
//   classify --latest                 classify the newest run of the workflow
//   jobs                              list the jobs of the newest run and their verdicts
//   gates                             list the local gates each workflow job would run
//   --workflow <file>                 workflow file (default .github/workflows/repo-invariants.yml)
//   --repo <owner/name>               repository (default: derived from `gh repo view`)
//   --json                            machine-readable output
//
// Exit: 0 = PASS, 1 = FAIL (a real executed code failure), 2 = INFRA_UNKNOWN.
// Read-only. Never prints secrets.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

export const PASS = 'PASS'
export const FAIL = 'FAIL'
export const INFRA_UNKNOWN = 'INFRA_UNKNOWN'

export const DEFAULT_WORKFLOW = '.github/workflows/repo-invariants.yml'
export const DEFAULT_WORKFLOW_NAME = 'repo-invariants.yml'
export const DEFAULT_REPO = 'souta-lab/minecraft-jev-agent'

/**
 * The verbatim GitHub annotation for a job that never started. Kept as data so
 * the fixture can assert on the exact production string rather than a paraphrase.
 */
export const NOT_STARTED_ANNOTATION =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings"

/** Substrings that identify an infrastructure refusal rather than a code failure. */
export const INFRA_ANNOTATION_PATTERNS = [
  /was not started because recent account payments have failed/i,
  /spending limit needs to be increased/i,
  /no runner matching the specified labels/i,
  /this job was cancelled because the workflow was not started/i,
  /runner group .* is not allowed/i,
  /the workflow was not started/i,
]

export const CI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function formatCommand(command, args = []) {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

/** Default runner: never throws; mirrors tools/current-status.mjs. */
export function runCommand(command, args = []) {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({
            ok: false,
            code: typeof error.code === 'number' ? error.code : 1,
            stdout: stdout ?? '',
            stderr: stderr ?? String(error.message ?? error),
          })
          return
        }
        resolvePromise({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

/** A step "executed" when GitHub recorded any outcome for it. */
export function stepExecuted(step) {
  if (step === null || typeof step !== 'object') return false
  const status = typeof step.status === 'string' ? step.status : ''
  const conclusion = typeof step.conclusion === 'string' ? step.conclusion : ''
  // A skipped step was evaluated but deliberately not run; it is still an
  // executed-step verdict slot, so count it. `steps: []` is the zero-step signal.
  return status.length > 0 || conclusion.length > 0 || typeof step.number === 'number'
}

export function executedStepCount(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  return steps.filter(stepExecuted).length
}

/** True when the job produced no code verdict at all because it never ran. */
export function jobNeverStarted(job) {
  return executedStepCount(job) === 0
}

function infraAnnotation(annotations = []) {
  for (const annotation of annotations) {
    const message = typeof annotation?.message === 'string' ? annotation.message : ''
    if (INFRA_ANNOTATION_PATTERNS.some((pattern) => pattern.test(message))) return message
  }
  return null
}

/**
 * Classify ONE job.
 * `annotations` is optional corroborating evidence (check-run annotations).
 */
export function classifyJob(job, annotations = []) {
  const name = typeof job?.name === 'string' && job.name.length > 0 ? job.name : 'UNKNOWN'
  const steps = Array.isArray(job?.steps) ? job.steps : []
  const executed = executedStepCount(job)
  const conclusion = typeof job?.conclusion === 'string' ? job.conclusion : 'UNKNOWN'
  const annotation = infraAnnotation(annotations)

  if (executed === 0) {
    return {
      name,
      verdict: INFRA_UNKNOWN,
      conclusion,
      steps: steps.length,
      executedSteps: 0,
      reason: annotation ?? 'zero executed steps (job never started a runner)',
    }
  }
  if (conclusion === 'success') {
    return { name, verdict: PASS, conclusion, steps: steps.length, executedSteps: executed, reason: 'executed and succeeded' }
  }
  const failedStep = steps.find((step) => stepExecuted(step) && step.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped')
  return {
    name,
    verdict: FAIL,
    conclusion,
    steps: steps.length,
    executedSteps: executed,
    reason: failedStep
      ? `executed step "${failedStep.name ?? 'UNKNOWN'}" concluded ${failedStep.conclusion}`
      : `executed and concluded ${conclusion}`,
  }
}

/**
 * Classify a whole run.
 * An executed FAIL always dominates: when the workflow really did run a gate and
 * the gate failed, that must stay visible even if a sibling job never started.
 */
export function classifyRun(run) {
  const jobs = Array.isArray(run?.jobs) ? run.jobs : []
  const annotationsByJob = run?.annotationsByJob ?? {}
  const classified = jobs.map((job) =>
    classifyJob(job, annotationsByJob[String(job?.databaseId ?? job?.id ?? '')] ?? []),
  )
  if (classified.length === 0) {
    return {
      verdict: INFRA_UNKNOWN,
      jobs: classified,
      reason: 'the run has no jobs to classify',
      executedJobs: 0,
    }
  }
  const executedJobs = classified.filter((job) => job.executedSteps > 0).length
  const failed = classified.filter((job) => job.verdict === FAIL)
  if (failed.length > 0) {
    return {
      verdict: FAIL,
      jobs: classified,
      reason: `${failed.length}/${classified.length} job(s) executed and failed: ${failed.map((job) => job.name).join(', ')}`,
      executedJobs,
    }
  }
  const unknown = classified.filter((job) => job.verdict === INFRA_UNKNOWN)
  if (unknown.length > 0) {
    return {
      verdict: INFRA_UNKNOWN,
      jobs: classified,
      reason:
        executedJobs === 0
          ? `no job executed a single step (${unknown.length}/${classified.length} never started)`
          : `${unknown.length}/${classified.length} job(s) never started: ${unknown.map((job) => job.name).join(', ')}`,
      executedJobs,
    }
  }
  return {
    verdict: PASS,
    jobs: classified,
    reason: `all ${classified.length} job(s) executed and succeeded`,
    executedJobs,
  }
}

export function exitCodeFor(verdict) {
  if (verdict === PASS) return 0
  if (verdict === FAIL) return 1
  return 2
}

// ---------------------------------------------------------------------------
// workflow gate inventory (derived from the workflow file, never hand-written)
// ---------------------------------------------------------------------------

/**
 * Extract, per job, the shell commands the job would run. Line-based on purpose:
 * the workflow is small and this must never invent a gate that is not written.
 */
export function parseWorkflowJobs(yamlText) {
  const jobs = {}
  let current = null
  let inJobs = false
  for (const rawLine of String(yamlText ?? '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue
    if (/^\S/.test(line) && line.length > 0) {
      inJobs = false
      current = null
      continue
    }
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (jobMatch) {
      current = jobMatch[1]
      jobs[current] = { name: current, commands: [], names: [] }
      continue
    }
    if (current === null) continue
    const stepName = line.match(/^\s+-\s+name:\s*(.+?)\s*$/)
    if (stepName) jobs[current].names.push(stepName[1])
    const run = line.match(/^\s+run:\s*(.+?)\s*$/)
    if (run) jobs[current].commands.push(run[1])
  }
  return jobs
}

export function readWorkflowJobs(workflowPath = join(CI_ROOT, DEFAULT_WORKFLOW)) {
  try {
    return { ok: true, jobs: parseWorkflowJobs(readFileSync(workflowPath, 'utf8')), error: null }
  } catch (error) {
    return { ok: false, jobs: {}, error: `cannot read ${workflowPath}: ${error.message}` }
  }
}

// ---------------------------------------------------------------------------
// GitHub readers
// ---------------------------------------------------------------------------

function parseJson(result) {
  if (!result?.ok) {
    const reason = (result?.stderr || `exit code ${result?.code}`).trim()
    return { ok: false, error: reason || 'command failed' }
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) }
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` }
  }
}

/** Newest run of the workflow, or null. */
export async function readLatestRunId(run, { repo = DEFAULT_REPO, workflow = DEFAULT_WORKFLOW_NAME } = {}) {
  const result = await run('gh', [
    'run',
    'list',
    `--workflow=${workflow}`,
    '--limit',
    '1',
    '--json',
    'databaseId,headSha,createdAt,conclusion,headBranch',
  ])
  const parsed = parseJson(result)
  if (!parsed.ok) return { ok: false, error: parsed.error, runId: null }
  if (!Array.isArray(parsed.value) || parsed.value.length === 0) {
    return { ok: false, error: 'no runs found for the workflow', runId: null }
  }
  return { ok: true, error: null, runId: String(parsed.value[0].databaseId), run: parsed.value[0] }
}

/** Jobs of one run, via the REST API (the CLI `--json jobs` shape drops fields). */
export async function readRunJobs(run, runId, { repo = DEFAULT_REPO } = {}) {
  const result = await run('gh', ['api', `repos/${repo}/actions/runs/${runId}/jobs`])
  const parsed = parseJson(result)
  if (!parsed.ok) return { ok: false, error: parsed.error, jobs: [] }
  const jobs = Array.isArray(parsed.value?.jobs) ? parsed.value.jobs : []
  return { ok: true, error: null, jobs }
}

/** Check-run annotations per job id. Failure to read them is not fatal. */
export async function readJobAnnotations(run, jobs, { repo = DEFAULT_REPO } = {}) {
  const byJob = {}
  for (const job of jobs) {
    const id = job?.databaseId ?? job?.id
    if (id === undefined || id === null) continue
    const result = await run('gh', ['api', `repos/${repo}/check-runs/${id}/annotations`])
    const parsed = parseJson(result)
    byJob[String(id)] = parsed.ok && Array.isArray(parsed.value) ? parsed.value : []
  }
  return byJob
}

/**
 * Read + classify the newest (or a named) workflow run.
 * Shape is stable so tools/current-status.mjs can render it without guessing.
 */
export async function readCiStatus(run = runCommand, options = {}) {
  const repo = options.repo ?? DEFAULT_REPO
  const workflow = options.workflow ?? DEFAULT_WORKFLOW_NAME
  let runId = options.runId ? String(options.runId) : null
  let headSha = null
  let createdAt = null

  if (runId === null) {
    const latest = await readLatestRunId(run, { repo, workflow })
    if (!latest.ok) return { ok: false, error: latest.error, verdict: INFRA_UNKNOWN }
    runId = latest.runId
    headSha = latest.run?.headSha ?? null
    createdAt = latest.run?.createdAt ?? null
  }

  const jobsResult = await readRunJobs(run, runId, { repo })
  if (!jobsResult.ok) return { ok: false, error: jobsResult.error, verdict: INFRA_UNKNOWN, runId }

  const annotationsByJob = options.withAnnotations === false ? {} : await readJobAnnotations(run, jobsResult.jobs, { repo })

  if (headSha === null || createdAt === null) {
    const view = parseJson(await run('gh', ['api', `repos/${repo}/actions/runs/${runId}`]))
    if (view.ok) {
      headSha = view.value?.head_sha ?? null
      createdAt = view.value?.created_at ?? null
      if (view.value?.name) options = { ...options }
    }
  }

  const classified = classifyRun({ jobs: jobsResult.jobs, annotationsByJob })
  return {
    ok: true,
    error: null,
    runId,
    headSha,
    createdAt,
    repo,
    workflow,
    verdict: classified.verdict,
    reason: classified.reason,
    executedJobs: classified.executedJobs,
    totalJobs: classified.jobs.length,
    jobs: classified.jobs,
  }
}

/** One-line human summary, safe to paste into a ledger. */
export function formatCiLine(status) {
  if (!status?.ok) return `CI: ${INFRA_UNKNOWN} (unreadable: ${status?.error ?? 'unknown error'})`
  return `CI run ${status.runId} @ ${String(status.headSha ?? 'UNKNOWN').slice(0, 8)}: ${status.verdict} — ${status.reason}`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] ?? null
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const run = options.run ?? runCommand
  const json = argv.includes('--json')
  const workflowFile = optionValue(argv, '--workflow') ?? join(CI_ROOT, DEFAULT_WORKFLOW)
  const workflowName = workflowFile.split('/').pop()
  const repo = optionValue(argv, '--repo') ?? DEFAULT_REPO

  if (argv.includes('gates')) {
    const read = readWorkflowJobs(workflowFile)
    if (!read.ok) return { exitCode: 2, output: `${INFRA_UNKNOWN}: ${read.error}` }
    const lines = [`workflow: ${workflowFile}`, '']
    for (const job of Object.values(read.jobs)) {
      lines.push(`${job.name}:`)
      for (const command of job.commands) lines.push(`  - ${command}`)
      if (job.commands.length === 0) lines.push('  - (no run: steps)')
      lines.push('')
    }
    const output = `${lines.join('\n').replace(/\n+$/, '')}\n`
    return { exitCode: 0, output, gates: read.jobs }
  }

  const runId = optionValue(argv, '--run')
  const status = await readCiStatus(run, { repo, workflow: workflowName, runId })
  const exitCode = status.ok ? exitCodeFor(status.verdict) : 2

  if (json) {
    return { exitCode, output: `${JSON.stringify(status, null, 2)}\n`, status }
  }

  const lines = []
  lines.push(`run: ${status.runId ?? 'UNKNOWN'}`)
  lines.push(`head: ${status.headSha ?? 'UNKNOWN'}`)
  lines.push(`verdict: ${status.verdict}`)
  lines.push(`reason: ${status.reason ?? status.error}`)
  if (status.ok) {
    lines.push('jobs:')
    for (const job of status.jobs) {
      lines.push(`  - ${job.name}: ${job.verdict} (${job.executedSteps}/${job.steps} executed steps, conclusion=${job.conclusion})`)
      lines.push(`      ${job.reason}`)
    }
  }
  return { exitCode, output: `${lines.join('\n')}\n`, status }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { exitCode, output } = await main()
  process.stdout.write(output)
  process.exit(exitCode)
}
