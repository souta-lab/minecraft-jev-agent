#!/usr/bin/env bun
// verify-issue13: listener-leak acceptance check.
// Samples the resident control socket several times and asserts that no event's
// listener count exceeds the ownership-aware expected count. Generation-owned
// temporary listeners (for example physicsTick during a control walk) are
// expected while active; an untracked listener still exceeds this count.
//
// The resident report carries a runId. The verifier binds the socket samples
// and callback-log window to that same run; a missing/mismatched scope is
// UNKNOWN, never a false PASS from an all-time append-only log.
// Usage: bun tools/verify-issue13.mjs [--json] [--samples 3] [--gap 8000] [--run <runId>]
import net from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { inspectGenerationCallbackLog } from './issue13-evidence.mjs'

const SOCK = process.env.BUDDY_CONTROL_SOCKET || '/home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock'
const LOG_PATH = process.env.BUDDY_LOG_PATH || 'buddy-driver/buddy.log'
const args = process.argv.slice(2)

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] ?? null : null
}

function num(flag, d) {
  const value = valueAfter(flag)
  const parsed = value === null ? Number.NaN : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : d
}

const HELP = args.includes('--help') || args.includes('-h')
const SAMPLES = num('--samples', 3)
const GAP = num('--gap', 8000)
const JSON_OUT = args.includes('--json')
const REQUESTED_RUN_ID = valueAfter('--run')

if (HELP) {
  process.stdout.write('usage: bun tools/verify-issue13.mjs [--json] [--samples 3] [--gap 8000] [--run <runId>]\n')
  process.exit(0)
}

function report() {
  return new Promise((resolve) => {
    if (!existsSync(SOCK)) return resolve(null)
    const socket = net.createConnection(SOCK)
    let buf = ''
    const done = (value) => {
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.setTimeout(6000, () => done(null))
    socket.on('error', () => done(null))
    socket.on('data', (data) => {
      buf += data.toString('utf8')
      if (buf.includes('\n')) {
        try { done(JSON.parse(buf.split('\n')[0])) } catch { done(null) }
      }
    })
    socket.on('connect', () => socket.write(JSON.stringify({ id: Date.now() % 100000, cmd: 'report' }) + '\n'))
  })
}

const samples = []
let samplingComplete = true
for (let index = 0; index < SAMPLES; index += 1) {
  const reply = await report()
  if (!reply?.ok) {
    process.stdout.write('control socket unavailable\n')
    process.exitCode = 2
    samplingComplete = false
    break
  }
  const data = reply.data ?? {}
  samples.push({
    at: new Date().toISOString(),
    runId: typeof data.runId === 'string' ? data.runId : null,
    generations: data.generations,
    listenerLeak: data.listenerLeak,
    listeners: data.listeners,
    baseline: data.listenerBaseline,
    expected: data.listenerExpected || data.listenerBaseline,
  })
  if (index < SAMPLES - 1) await new Promise((resolve) => setTimeout(resolve, GAP))
}

if (samples.length === 0) process.exit(2)

const observedRunIds = [...new Set(samples.map((sample) => sample.runId))]
const selectedRunId = REQUESTED_RUN_ID ?? samples[0].runId
const runScopeStable = samplingComplete && selectedRunId !== null && samples.length === SAMPLES && samples.every((sample) => sample.runId === selectedRunId)

const violations = []
for (const [index, sample] of samples.entries()) {
  for (const [event, count] of Object.entries(sample.listeners || {})) {
    const expected = sample.expected?.[event] ?? sample.baseline?.[event] ?? 0
    if (count > expected) violations.push({ sample: index, event, count, expected })
  }
}
const leakFlags = samples.map((sample) => sample.listenerLeak)
const genGrowth = samples.length > 1 ? samples[samples.length - 1].generations - samples[0].generations : 0
const callbackEvidence = inspectGenerationCallbackLog(
  existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8') : '',
  { runId: selectedRunId },
)

const check = (id, status, detail) => ({ id, status, pass: status === 'PASS', detail })
const checks = [
  check('sampling_complete', samplingComplete ? 'PASS' : 'UNKNOWN', JSON.stringify({ requested: SAMPLES, observed: samples.length })),
  check('run_scope_stable', runScopeStable ? 'PASS' : 'UNKNOWN', JSON.stringify({ requested: REQUESTED_RUN_ID, observed: observedRunIds })),
  check('no_event_over_expected', violations.length === 0 ? 'PASS' : 'FAIL', JSON.stringify(violations)),
  check('leak_flag_false_in_all_samples', leakFlags.every((flag) => flag === false) ? 'PASS' : 'FAIL', JSON.stringify(leakFlags)),
  check(
    'generation_callback_observability_ready',
    runScopeStable && callbackEvidence.observabilityReady ? 'PASS' : 'UNKNOWN',
    JSON.stringify({
      runId: callbackEvidence.runId,
      scopeSource: callbackEvidence.scopeSource,
      scopeMatched: callbackEvidence.scopeMatched,
      actionLogs: callbackEvidence.actionLogs,
      taggedActions: callbackEvidence.taggedActions,
      pathCallbacks: callbackEvidence.pathCallbacks,
      untaggedPathCallbacks: callbackEvidence.untaggedPathCallbacks,
    }),
  ),
  check(
    'no_disposed_generation_callbacks',
    !runScopeStable || !callbackEvidence.scopeMatched
      ? 'UNKNOWN'
      : callbackEvidence.noDisposedGenerationCallbacks ? 'PASS' : 'FAIL',
    JSON.stringify(callbackEvidence.staleCallbackViolations),
  ),
]
const passCount = checks.filter((item) => item.status === 'PASS').length
const unknownCount = checks.filter((item) => item.status === 'UNKNOWN').length
const failCount = checks.filter((item) => item.status === 'FAIL').length
const verdict = failCount > 0 ? 'FAIL' : unknownCount > 0 ? 'UNKNOWN' : 'PASS'
const out = {
  issue: 13,
  verdict,
  passCount,
  unknownCount,
  failCount,
  total: checks.length,
  samplingComplete,
  runId: selectedRunId,
  observedRunIds,
  samples,
  generationGrowth: genGrowth,
  checks,
  callbackEvidence,
}

if (JSON_OUT) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
else {
  console.log(`== issue #13 acceptance: ${out.verdict} (${passCount}/${out.total}; unknown=${unknownCount}) ==`)
  for (const item of checks) console.log(`  [${item.status}] ${item.id.padEnd(34)} ${item.detail}`)
  console.log(`  runId=${selectedRunId ?? 'unknown'} observedRunIds=${JSON.stringify(observedRunIds)}`)
  console.log(`  generations over sampling window: ${genGrowth}`)
  for (const sample of samples) console.log(`  sample ${sample.at} leak=${sample.listenerLeak} listeners=${JSON.stringify(sample.listeners)}`)
}

if (verdict === 'FAIL') process.exitCode = 1
else if (verdict === 'UNKNOWN') process.exitCode = 2
