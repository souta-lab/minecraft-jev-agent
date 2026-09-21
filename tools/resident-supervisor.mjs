#!/usr/bin/env bun
// tools/resident-supervisor.mjs — operations-layer availability supervisor for the
// resident host (buddy-driver/agent-runner.mts).
//
// WHY THIS EXISTS
// The resident host is fail-loud on purpose (#226). When the planner/System2 model
// stays unavailable after its bounded retries, the generation logs
//
//   FATAL code=MODEL_UNAVAILABLE context=planner-authority attempts=3 error=...
//   ERROR code=MODEL_UNAVAILABLE action=terminate-resident pid=... exitCode=1
//
// and the host process exits non-zero. That behaviour is CORRECT and must stay: a
// model failure must never silently degrade into deterministic semantic authority.
//
// The price is availability. A transient Vercel AI Gateway 503 kills the whole
// resident, the bot leaves the server, and M3 progress stops until a human
// restarts it. This tool pays that price down without touching the contract.
//
// WHAT THIS TOOL IS
// An AVAILABILITY RETRY, NOT A SEMANTIC FALLBACK.
//   * It launches the SAME unchanged host, with the SAME environment.
//   * It never selects a policy, never sets deterministic-baseline mode, and never
//     substitutes a decision for the model.
//   * It never hides a failure: every observed exit is written to a run-scoped
//     artifact and echoed, including the terminating marker lines.
//   * It refuses to start when a resident is already running (HOST lock and a
//     cwd-scoped process check), so two live hosts are never possible.
//   * It stops after a configurable consecutive-failure budget and exits non-zero
//     instead of spinning forever.
//
// The fail-loud authority contract in buddy-driver/AGENTS.md §3 is deliberately
// untouched: this is an ops process wrapper, not an authority layer.
//
// Usage:
//   bun tools/resident-supervisor.mjs [options]
//   bun tools/resident-supervisor.mjs --status [--json]
//   bun tools/resident-supervisor.mjs --help
//
// Run-scoped artifact (always written unless --dry-run):
//   <artifact-dir>/supervisor-<iso>-<pid>.jsonl          one JSON record per event
//   <artifact-dir>/supervisor-<iso>-<pid>.summary.json   final counts + failures
//
// Exit codes:
//   0  child exited cleanly (code 0), --help, --status, or --dry-run
//   1  refused to start (another resident is live) or usage error
//   2  consecutive-failure budget exhausted (max-restarts reached)
//   3  hard-stop exit that must not be auto-retried (e.g. host lock held)
//   130/143  supervisor received SIGINT/SIGTERM and forwarded it to the child
//
// This file is intentionally dependency-free and Bun-only.

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const SCHEMA_VERSION = 1

export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_BUDGET_EXHAUSTED = 2
export const EXIT_HARD_STOP = 3
export const EXIT_USAGE = 1 // kept equal to REFUSED: both are "I did not run the host"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')

// Runtime state belongs to the shared tree the resident actually writes to. A
// lane worktree may contain this tool but must not be treated as the live root.
export const MC_AI_ROOT =
  process.env.MC_AI_ROOT || (existsSync('/home/s0u7a/mc-ai') ? '/home/s0u7a/mc-ai' : REPO_ROOT)

export const DEFAULTS = {
  root: MC_AI_ROOT,
  driverDir: null, // <root>/buddy-driver
  childScript: null, // <driverDir>/agent-runner.mts
  artifactDir: null, // <driverDir>/data/supervisor
  log: null, // explicit supervisor lifecycle log; default none (stderr only)
  maxRestarts: 5,
  baseDelayMs: 2000,
  maxDelayMs: 60_000,
  // Budget exhaustion needs the hourly window to refill, not a 60s retry.
  budgetDelayMs: 1_800_000,
  resetAfterMs: 60_000,
  preflight: true,
  json: false,
  dryRun: false,
  status: false,
  help: false,
}

// Terminating / diagnostic marker lines we must never lose. `FATAL` and the
// terminate-resident ERROR carry the authority failure; BOOT_REFUSED / HOST_LOCK
// carry the two-hosts refusal. Everything is recorded verbatim.
const MARKER_PATTERNS = [
  /\bFATAL\b/,
  /code=MODEL_UNAVAILABLE/,
  /action=terminate-resident/,
  /\bBOOT_REFUSED\b/,
  /HOST_LOCK\s+held-by/,
  /\bERROR\b\s+code=/,
]
const HARD_STOP_RE = /\bBOOT_REFUSED\b|HOST_LOCK\s+held-by/
const MODEL_UNAVAILABLE_RE = /MODEL_UNAVAILABLE/
// A self-imposed hourly MODEL budget is NOT a transient gateway blip: the
// call-time budget is persisted, so an immediate retry restarts into the same
// exhausted budget (observed: 9 consecutive 60s restarts, all dying on
// `FATAL ... error=budget_exhausted`).
const MODEL_BUDGET_EXHAUSTED_RE = /budget_exhausted|hourly budget exhausted/i
const MAX_MARKERS = 20
const MAX_CAPTURED_LINES = 2000

// ---------------------------------------------------------------------------
// pure logic (exported for the offline fixture)
// ---------------------------------------------------------------------------

/** Does this output line carry a terminating/diagnostic marker we must record? */
export function isMarkerLine(line) {
  return typeof line === 'string' && MARKER_PATTERNS.some((re) => re.test(line))
}

/** Last N marker lines from a stream of lines, in original order. */
export function extractTerminatingMarkers(lines, limit = MAX_MARKERS) {
  const hits = []
  for (const line of lines) if (isMarkerLine(line)) hits.push(line)
  return hits.slice(-limit)
}

/**
 * Classify a child exit.
 *   clean      -> exit 0; the supervisor stops (intentional shutdown, e.g. `quit`)
 *   transient  -> restartable with backoff (model/gateway blip, crash, signal)
 *   hard-stop  -> must NOT be auto-retried (a live host already holds the lock)
 */
export function classifyExit({ code, signalCode = null, markers = [] } = {}) {
  const joined = markers.join('\n')
  if (HARD_STOP_RE.test(joined)) {
    return { classification: 'hard-stop', reason: 'host-lock-held' }
  }
  if (code === 0 && signalCode === null) {
    return { classification: 'clean', reason: 'exit-0' }
  }
  if (MODEL_BUDGET_EXHAUSTED_RE.test(joined)) {
    return { classification: 'budget', reason: 'model-budget-exhausted' }
  }
  if (MODEL_UNAVAILABLE_RE.test(joined)) {
    return { classification: 'transient', reason: 'model-unavailable' }
  }
  if (signalCode !== null) {
    return { classification: 'transient', reason: `signal-${signalCode}` }
  }
  return { classification: 'transient', reason: 'nonzero-exit' }
}

/** Bounded exponential backoff: base * 2^(n-1), capped at maxDelayMs. */
export function backoffDelayMs(consecutiveFailures, baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs) {
  const n = Math.max(1, Math.floor(consecutiveFailures))
  const raw = baseDelayMs * 2 ** (n - 1)
  return Math.min(raw, maxDelayMs)
}

/** A run that stayed alive at least this long is "healthy": reset the budget. */
export function isHealthyRun(uptimeMs, resetAfterMs = DEFAULTS.resetAfterMs) {
  return Number.isFinite(uptimeMs) && uptimeMs >= resetAfterMs
}

/** PID liveness without signalling anything. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Parse `pgrep -af 'bun agent-runner.mts'` output, excluding bash wrappers. */
export function parseResidentProcessLines(output) {
  return String(output || '')
    .split('\n')
    .filter((line) => /\d+\s+\S*bun\s+agent-runner\.mts/.test(line) && !/\bbash\b|\/bin\/sh\b/.test(line))
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      return m ? { pid: Number(m[1]), command: m[2] } : null
    })
    .filter(Boolean)
}

/** Read the host lock the resident itself uses for single-instance. */
export function readHostLock(driverDir) {
  const lockPath = path.join(driverDir, 'data', 'resident', 'host.lock')
  const state = { path: lockPath, present: false, pid: null, alive: false }
  if (!existsSync(lockPath)) return state
  state.present = true
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    state.pid = Number.isInteger(parsed) ? parsed : null
    state.alive = pidAlive(state.pid)
  } catch {
    state.pid = null
    state.alive = false
  }
  return state
}

/** Process-table scan scoped to one driver dir via /proc/<pid>/cwd. */
export function findResidentProcesses(driverDir) {
  let output = ''
  try {
    output = execFileSync('pgrep', ['-af', 'bun agent-runner.mts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return []
  }
  let want = null
  try {
    want = realpathSync(driverDir)
  } catch {
    want = path.resolve(driverDir)
  }
  const found = []
  for (const entry of parseResidentProcessLines(output)) {
    let cwd = null
    try {
      cwd = realpathSync(`/proc/${entry.pid}/cwd`)
    } catch {
      cwd = null
    }
    // A resident whose cwd we cannot read is treated as matching (conservative:
    // refuse rather than risk a second live host).
    if (cwd === null || cwd === want) found.push({ ...entry, cwd })
  }
  return found
}

/** Preflight: refuse when any resident already owns this driver dir. */
export function preflight({ driverDir, checkProcesses = true } = {}) {
  const lock = readHostLock(driverDir)
  const pids = checkProcesses ? findResidentProcesses(driverDir) : []
  const blockers = []
  if (lock.present && lock.alive) blockers.push(`host lock held by live pid=${lock.pid} (${lock.path})`)
  for (const p of pids) blockers.push(`live agent-runner pid=${p.pid} in ${p.cwd ?? 'unknown-cwd'}`)
  // A present-but-dead lock is stale; the host reclaims it on boot, so it is not a blocker.
  return { ok: blockers.length === 0, blockers, lock, pids }
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

export function usage() {
  return `resident-supervisor — availability retry for the fail-loud resident host

This is NOT a semantic fallback. It relaunches the same host; it never selects
deterministic authority and never hides a failure. Every exit is recorded in the
run-scoped artifact and printed, then retried with bounded exponential backoff
until --max-restarts consecutive failures, at which point it stops non-zero.

Usage:
  bun tools/resident-supervisor.mjs [options]
  bun tools/resident-supervisor.mjs --status [--json]
  bun tools/resident-supervisor.mjs --help

Options:
  --max-restarts N      restarts allowed after consecutive failures (default ${DEFAULTS.maxRestarts};
                        the host runs at most N+1 times. 0 = single run, no retry)
  --base-delay-ms N     first backoff delay (default ${DEFAULTS.baseDelayMs})
  --max-delay-ms N      backoff ceiling (default ${DEFAULTS.maxDelayMs})
  --reset-after-ms N    a run alive at least this long resets the failure streak
  --budget-delay-ms <ms>  backoff for a model-budget exit (default 1800000)
                        (default ${DEFAULTS.resetAfterMs})
  --root PATH           shared tree root (default ${MC_AI_ROOT})
  --driver-dir PATH     directory the host runs from (default <root>/buddy-driver)
  --child-script PATH   script Bun runs (default <driver-dir>/agent-runner.mts;
                        advanced/testing only: the default is the real resident)
  --artifact-dir PATH   where run-scoped artifacts go (default <driver-dir>/data/supervisor)
  --log PATH            also append supervisor lifecycle lines to PATH
  --no-preflight        skip the "resident already running" guard (UNSAFE; tests only)
  --status              read-only: report whether a resident is running, then exit
  --dry-run             run preflight, print the plan, spawn nothing
  --json                machine-readable lifecycle records on stdout
  -h, --help            print this help

Exit codes: 0 clean/help/status, 1 refused/usage, 2 budget exhausted,
            3 hard-stop (e.g. host lock held), 130/143 forwarded signal.
`
}

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, _: [] }
  const num = (name, value) => {
    const n = Number.parseInt(value, 10)
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} expects a non-negative integer, got ${value}`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} expects a value`)
      return v
    }
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--status') opts.status = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--json') opts.json = true
    else if (a === '--no-preflight') opts.preflight = false
    else if (a === '--max-restarts') opts.maxRestarts = num(a, next())
    else if (a === '--base-delay-ms') opts.baseDelayMs = num(a, next())
    else if (a === '--max-delay-ms') opts.maxDelayMs = num(a, next())
    else if (a === '--reset-after-ms') opts.resetAfterMs = num(a, next())
    else if (a === '--budget-delay-ms') opts.budgetDelayMs = num(a, next())
    else if (a === '--root') opts.root = next()
    else if (a === '--driver-dir') opts.driverDir = next()
    else if (a === '--child-script') opts.childScript = next()
    else if (a === '--artifact-dir') opts.artifactDir = next()
    else if (a === '--log') opts.log = next()
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`)
    else opts._.push(a)
  }
  opts.driverDir = opts.driverDir ?? path.join(opts.root, 'buddy-driver')
  opts.childScript = opts.childScript ?? path.join(opts.driverDir, 'agent-runner.mts')
  opts.artifactDir = opts.artifactDir ?? path.join(opts.driverDir, 'data', 'supervisor')
  if (opts.maxDelayMs < opts.baseDelayMs) opts.maxDelayMs = opts.baseDelayMs
  return opts
}

// ---------------------------------------------------------------------------
// supervisor loop
// ---------------------------------------------------------------------------

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function readLogTailMarkers(logPath, lines = 200) {
  try {
    if (!existsSync(logPath)) return []
    const all = readFileSync(logPath, 'utf8').split('\n')
    return extractTerminatingMarkers(all.slice(-lines))
  } catch {
    return []
  }
}

function appendJsonl(file, record) {
  appendFileSync(file, `${JSON.stringify(record)}\n`)
}

function humanize(record) {
  switch (record.type) {
    case 'supervisor_start':
      return `SUPERVISOR_START runId=${record.runId} root=${record.root} driverDir=${record.driverDir} maxRestarts=${record.policy.maxRestarts}`
    case 'child_start':
      return `SUPERVISOR_CHILD_START attempt=${record.attempt} pid=${record.pid} cmd=${record.command.join(' ')}`
    case 'child_exit':
      // A clean exit is not a failure; only restartable/hard-stop exits are.
      return record.classification === 'clean'
        ? `SUPERVISOR_CHILD_EXIT attempt=${record.attempt} exitCode=${record.exitCode} uptimeMs=${record.uptimeMs} classification=clean`
        : `SUPERVISOR_FAILURE attempt=${record.attempt} exitCode=${record.exitCode} signal=${record.signal} uptimeMs=${record.uptimeMs} classification=${record.classification} reason=${record.reason} markers=${record.markers.length}`
    case 'restart_scheduled':
      return `SUPERVISOR_RETRY nextAttempt=${record.nextAttempt} inMs=${record.delayMs} consecutiveFailures=${record.consecutiveFailures}`
    case 'supervisor_stop':
      return `SUPERVISOR_STOP reason=${record.reason} exitCode=${record.exitCode} restarts=${record.restarts} failures=${record.failures}`
    default:
      return `${record.type} ${JSON.stringify(record)}`
  }
}

function pump(stream, onLine, sink) {
  const decoder = new TextDecoder()
  let carry = ''
  let ended = false
  const reader = stream.getReader()
  const loop = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        sink?.write(text)
        carry += text
        const parts = carry.split('\n')
        carry = parts.pop() ?? ''
        for (const line of parts) onLine(line)
      }
    } catch {
      // child pipes close on exit; nothing to do
    } finally {
      if (!ended) {
        ended = true
        if (carry.length > 0) onLine(carry)
      }
    }
  })()
  return loop
}

/**
 * Run the supervisor loop. Dependencies are injectable so the offline fixture can
 * drive the exact production path with a fake child command.
 */
export async function supervise(options, deps = {}) {
  const spawn = deps.spawn ?? ((cmd, cfg) => Bun.spawn(cmd, cfg))
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const out = deps.out ?? process.stdout
  const err = deps.err ?? process.stderr
  const command = [process.execPath, options.childScript]

  mkdirSync(options.artifactDir, { recursive: true })
  const base = `supervisor-${isoStamp()}-${process.pid}`
  const artifactPath = path.join(options.artifactDir, `${base}.jsonl`)
  const summaryPath = path.join(options.artifactDir, `${base}.summary.json`)
  writeFileSync(artifactPath, '')

  const emit = (record) => {
    appendJsonl(artifactPath, record)
    if (options.log) {
      try {
        appendFileSync(options.log, `[${record.at ?? new Date().toISOString()}] ${humanize(record)}\n`)
      } catch {
        // logging must never take the supervisor down
      }
    }
    err.write(`${humanize(record)}\n`)
    if (options.json) out.write(`${JSON.stringify(record)}\n`)
  }

  const failures = []
  let restarts = 0
  let attempts = 0
  let consecutiveFailures = 0
  let reason = 'unknown'
  let exitCode = EXIT_OK

  emit({
    type: 'supervisor_start',
    schemaVersion: SCHEMA_VERSION,
    at: new Date().toISOString(),
    runId: base,
    pid: process.pid,
    root: options.root,
    driverDir: options.driverDir,
    command,
    artifactPath,
    policy: {
      mode: 'availability-retry',
      semanticFallback: false,
      maxRestarts: options.maxRestarts,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      resetAfterMs: options.resetAfterMs,
    },
  })

  let currentChild = null
  let forwardedSignal = null
  const onSignal = (sig) => {
    forwardedSignal = sig
    try {
      currentChild?.kill(sig)
    } catch {
      // child already gone
    }
  }
  const sigint = () => onSignal('SIGINT')
  const sigterm = () => onSignal('SIGTERM')
  process.on('SIGINT', sigint)
  process.on('SIGTERM', sigterm)

  try {
    let attempt = 0
    for (;;) {
      attempt += 1
      attempts = attempt
      const startedAt = now()
      const child = spawn(command, {
        cwd: options.driverDir,
        env: { ...process.env, BUDDY_SUPERVISOR: '1', BUDDY_SUPERVISOR_RUN: base },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      currentChild = child
      emit({
        type: 'child_start',
        at: new Date().toISOString(),
        attempt,
        pid: child.pid,
        command,
        cwd: options.driverDir,
      })

      // Preserve the resident's own logs on the supervisor's streams while keeping
      // a bounded ring of lines for marker extraction.
      const captured = []
      const onLine = (line) => {
        captured.push(line)
        if (captured.length > MAX_CAPTURED_LINES) captured.shift()
      }
      const pumps = [
        pump(child.stdout, onLine, out),
        pump(child.stderr, onLine, err),
      ]

      const code = await child.exited
      await Promise.all(pumps)
      currentChild = null
      const uptimeMs = Math.max(0, now() - startedAt)
      const signalCode = child.signalCode ?? null

      let markers = extractTerminatingMarkers(captured)
      if (markers.length === 0) {
        // Output may have been lost/redirected; the host always appends to
        // buddy.log, so fall back to its tail rather than recording no marker.
        markers = readLogTailMarkers(path.join(options.driverDir, 'buddy.log'))
      }
      const verdict = classifyExit({ code, signalCode, markers })
      const record = {
        type: 'child_exit',
        at: new Date().toISOString(),
        attempt,
        exitCode: code,
        signal: signalCode,
        uptimeMs,
        classification: verdict.classification,
        reason: verdict.reason,
        markers,
      }
      emit(record)

      if (forwardedSignal !== null) {
        reason = `supervisor-signal-${forwardedSignal}`
        exitCode = forwardedSignal === 'SIGINT' ? 130 : 143
        break
      }

      if (verdict.classification === 'clean') {
        reason = 'clean-exit'
        exitCode = EXIT_OK
        break
      }

      failures.push({ attempt, exitCode: code, signal: signalCode, uptimeMs, reason: verdict.reason, markers })

      if (verdict.classification === 'hard-stop') {
        reason = 'hard-stop'
        exitCode = EXIT_HARD_STOP
        break
      }

      if (isHealthyRun(uptimeMs, options.resetAfterMs)) consecutiveFailures = 0
      consecutiveFailures += 1

      if (restarts >= options.maxRestarts) {
        reason = 'max-restarts-exhausted'
        exitCode = EXIT_BUDGET_EXHAUSTED
        break
      }

      // 'budget' is retryable but only after the hourly window can refill;
      // everything else keeps the bounded exponential backoff.
      const delayMs =
        verdict.classification === 'budget'
          ? Math.max(options.budgetDelayMs, backoffDelayMs(consecutiveFailures, options.baseDelayMs, options.maxDelayMs))
          : backoffDelayMs(consecutiveFailures, options.baseDelayMs, options.maxDelayMs)
      restarts += 1
      emit({
        type: 'restart_scheduled',
        at: new Date().toISOString(),
        nextAttempt: attempt + 1,
        delayMs,
        consecutiveFailures,
      })
      await sleep(delayMs)
    }
  } finally {
    process.removeListener('SIGINT', sigint)
    process.removeListener('SIGTERM', sigterm)
    // Close the JSONL run-scoped artifact so a reader can see start .. stop.
    emit({
      type: 'supervisor_stop',
      at: new Date().toISOString(),
      runId: base,
      reason,
      exitCode,
      restarts,
      attempts,
      failures: failures.length,
      artifactPath,
    })
    const summary = {
      schemaVersion: SCHEMA_VERSION,
      type: 'supervisor_summary',
      at: new Date().toISOString(),
      runId: base,
      artifactPath,
      reason,
      exitCode,
      restarts,
      attempts,
      failures,
      semanticFallback: false,
    }
    try {
      writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
    } catch {
      // summary is best-effort; the JSONL is the authoritative record
    }
    err.write(`SUPERVISOR_SUMMARY reason=${reason} exitCode=${exitCode} restarts=${restarts} failures=${failures.length} summary=${summaryPath}\n`)
    if (failures.length > 0) {
      err.write('SUPERVISOR_FAILURES (every retried failure is listed; none were hidden):\n')
      for (const f of failures) {
        err.write(`  attempt=${f.attempt} exitCode=${f.exitCode} signal=${f.signal} reason=${f.reason} uptimeMs=${f.uptimeMs}\n`)
        for (const marker of f.markers) err.write(`    ${marker}\n`)
      }
    }
  }

  return { reason, exitCode, restarts, failures, artifactPath, summaryPath }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printStatus(opts) {
  const pre = preflight({ driverDir: opts.driverDir })
  const artifacts = existsSync(opts.artifactDir)
    ? execFileSyncSafe('ls', ['-t', opts.artifactDir])
        .split('\n')
        .filter((f) => f.endsWith('.summary.json'))
        .slice(0, 5)
    : []
  const report = {
    running: !pre.ok,
    blockers: pre.blockers,
    hostLock: pre.lock,
    residentProcesses: pre.pids,
    driverDir: opts.driverDir,
    artifactDir: opts.artifactDir,
    recentSummaries: artifacts,
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return EXIT_OK
  }
  process.stdout.write(`resident-supervisor status\n`)
  process.stdout.write(`  driverDir       ${opts.driverDir}\n`)
  process.stdout.write(`  resident        ${pre.ok ? 'not running' : `RUNNING (${pre.blockers.join('; ')})`}\n`)
  process.stdout.write(`  hostLock        ${pre.lock.present ? `present pid=${pre.lock.pid} alive=${pre.lock.alive}` : 'absent'}\n`)
  process.stdout.write(`  artifactDir     ${opts.artifactDir}\n`)
  process.stdout.write(`  recentSummaries ${artifacts.length > 0 ? artifacts.join(', ') : '(none)'}\n`)
  return EXIT_OK
}

function execFileSyncSafe(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`resident-supervisor: ${error.message}\n\n${usage()}`)
    return EXIT_USAGE
  }

  if (opts.help) {
    process.stdout.write(usage())
    return EXIT_OK
  }
  if (opts.status) return printStatus(opts)

  if (!existsSync(opts.childScript)) {
    process.stderr.write(`resident-supervisor: child script not found: ${opts.childScript}\n`)
    return EXIT_USAGE
  }

  if (opts.preflight) {
    const pre = preflight({ driverDir: opts.driverDir })
    if (!pre.ok) {
      process.stderr.write(
        `resident-supervisor: REFUSING TO START — a resident is already running:\n${pre.blockers.map((b) => `  - ${b}`).join('\n')}\n` +
          `Never run two live hosts. Use --status to inspect, or stop the existing host first.\n`,
      )
      return EXIT_REFUSED
    }
  }

  if (opts.dryRun) {
    process.stdout.write(
      `resident-supervisor dry-run\n  command   ${process.execPath} ${opts.childScript}\n  cwd       ${opts.driverDir}\n` +
        `  policy    availability-retry (NOT semantic fallback), maxRestarts=${opts.maxRestarts}, baseDelayMs=${opts.baseDelayMs}, maxDelayMs=${opts.maxDelayMs}, resetAfterMs=${opts.resetAfterMs}\n` +
        `  artifact  ${opts.artifactDir}\n`,
    )
    return EXIT_OK
  }

  const result = await supervise(opts)
  return result.exitCode
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`resident-supervisor: ${error?.stack ?? error}\n`)
      process.exit(EXIT_REFUSED)
    })
}
