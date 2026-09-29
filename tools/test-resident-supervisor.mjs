#!/usr/bin/env bun
// Offline fixture for tools/resident-supervisor.mjs.
//
// No live server, no network, no real resident. A fake child command writes
// FATAL-style marker lines and exits with a chosen code, so the supervisor's
// exit classification, backoff, consecutive-failure stop, two-hosts refusal and
// failure-record writing are exercised deterministically.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeActiveRunRegistry } from './capability-run.mjs'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TOOL = join(HERE, 'resident-supervisor.mjs')

const {
  backoffDelayMs,
  classifyExit,
  extractTerminatingMarkers,
  isHealthyRun,
  parseArgs,
  parseGenerationReadyLine,
  parseResidentProcessLines,
  preflight,
  syncActiveRunRegistryOnReady,
} = await import('./resident-supervisor.mjs')

const tmp = mkdtempSync(join(tmpdir(), 'resident-supervisor-'))
let checks = 0

// The fake resident: counts its own invocations, then fails or succeeds.
const FAKE_CHILD = `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const counterPath = process.env.FAKE_RESIDENT_COUNTER
let n = 0
if (existsSync(counterPath)) n = Number.parseInt(readFileSync(counterPath, 'utf8'), 10) || 0
n += 1
writeFileSync(counterPath, String(n))
const mode = process.env.FAKE_RESIDENT_MODE ?? 'fail-twice'
const failTimes = Number.parseInt(process.env.FAKE_RESIDENT_FAIL_TIMES ?? '0', 10)
const ts = new Date().toISOString()
if (mode === 'host-lock') {
  process.stdout.write('[' + ts + '] BOOT_REFUSED reason=host-lock-held path=/tmp/host.lock\\n')
  process.exit(1)
}
if (mode === 'signal-term') {
  process.stdout.write('[' + ts + '] SHUTDOWN reason=SIGTERM\\n')
  process.exit(143)
}
if (mode === 'always-crash') process.exit(1)
if (mode === 'always-fail' || n <= failTimes) {
  process.stdout.write('[' + ts + '] FATAL code=MODEL_UNAVAILABLE context=planner-authority attempts=3 error=GatewayInternalServerError: Service Unavailable\\n')
  process.stdout.write('[' + ts + '] ERROR code=MODEL_UNAVAILABLE action=terminate-resident pid=' + process.pid + ' exitCode=1\\n')
  process.exit(1)
}
process.stdout.write('[' + ts + '] FAKE_RESIDENT healthy n=' + n + '\\n')
process.exit(0)
`

const fakeChild = join(tmp, 'fake-resident.mjs')
writeFileSync(fakeChild, FAKE_CHILD, 'utf8')

function makeRoot(name) {
  const root = join(tmp, name)
  mkdirSync(join(root, 'packages/buddy-driver'), { recursive: true })
  return root
}

function runSupervisor(args, env = {}) {
  return startSupervisor(args, env).done
}

function startSupervisor(args, env = {}) {
  const child = Bun.spawn([process.execPath, TOOL, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const done = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { status: await child.exited, stdout, stderr }
  })()
  return { child, done }
}

async function waitForRecord(dir, type, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(dir)) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      continue
    }
    const file = readdirSync(dir).find((name) => name.endsWith('.jsonl'))
    if (file) {
      const records = readFileSync(join(dir, file), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      if (records.some((record) => record.type === type)) return records
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for supervisor artifact record ${type}`)
}

function readArtifact(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  assert.equal(files.length, 1, `expected exactly one run artifact, got ${files.join(',')}`)
  const artifactPath = join(dir, files[0])
  const records = readFileSync(artifactPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const summaryPath = join(dir, files[0].replace(/\.jsonl$/, '.summary.json'))
  return { artifactPath, records, summary: JSON.parse(readFileSync(summaryPath, 'utf8')) }
}

try {
  // ---- pure exit classification -------------------------------------------
  const fatalMarkers = extractTerminatingMarkers([
    '[t] BOOT pid=1 runId=run-x',
    '[t] SYSTEM2_AUTHORITY_RETRY attempt=2 nextAttempt=3 error=GatewayInternalServerError: Service Unavailable',
    '[t] FATAL code=MODEL_UNAVAILABLE context=planner-authority attempts=3 error=GatewayInternalServerError: Service Unavailable',
    '[t] ERROR code=MODEL_UNAVAILABLE action=terminate-resident pid=9 exitCode=1',
  ])
  assert.equal(fatalMarkers.length, 2, 'only FATAL/terminate-resident/ERROR-code lines are markers')
  assert.match(fatalMarkers[0], /FATAL code=MODEL_UNAVAILABLE/)
  assert.match(fatalMarkers[1], /action=terminate-resident/)
  checks++

  assert.deepEqual(classifyExit({ code: 1, markers: fatalMarkers }), {
    classification: 'transient',
    reason: 'model-unavailable',
  })
  assert.deepEqual(classifyExit({ code: 0, markers: [] }), { classification: 'clean', reason: 'exit-0' })
  assert.deepEqual(classifyExit({ code: 1, markers: [] }), { classification: 'transient', reason: 'nonzero-exit' })
  assert.deepEqual(classifyExit({ code: null, signalCode: 'SIGKILL', markers: [] }), {
    classification: 'transient',
    reason: 'signal-SIGKILL',
  })
  assert.deepEqual(classifyExit({ code: 143, markers: ['[t] SHUTDOWN reason=SIGTERM'] }), {
    classification: 'transient',
    reason: 'signal-SIGTERM',
  }, 'the host signal handler exits normally after logging, so the supervisor must classify its marker')
  const controlQuitMarkers = extractTerminatingMarkers(['[t] SHUTDOWN reason=control-quit'])
  assert.equal(controlQuitMarkers.length, 0, 'an explicit control quit is not classified as an OS signal')
  assert.deepEqual(classifyExit({ code: 0, markers: controlQuitMarkers }), {
    classification: 'clean',
    reason: 'exit-0',
  }, 'an explicit control-quit has no OS signal marker and remains clean')
  assert.deepEqual(classifyExit({ code: 1, markers: ['[t] BOOT_REFUSED reason=host-lock-held'] }), {
    classification: 'hard-stop',
    reason: 'host-lock-held',
  })
  checks++

  // ---- bounded exponential backoff ----------------------------------------
  assert.equal(backoffDelayMs(1, 100, 10_000), 100)
  assert.equal(backoffDelayMs(2, 100, 10_000), 200)
  assert.equal(backoffDelayMs(3, 100, 10_000), 400)
  assert.equal(backoffDelayMs(10, 100, 1_000), 1_000, 'backoff must be capped')
  assert.equal(isHealthyRun(59_999, 60_000), false)
  assert.equal(isHealthyRun(60_000, 60_000), true)
  checks++

  // ---- process-table parsing + arg parsing --------------------------------
  const parsed = parseResidentProcessLines(
    [
      '111 /home/s0u7a/.bun/bin/bun agent-runner.mts',
      '222 /bin/bash -c pgrep -af bun agent-runner.mts',
      '333 /usr/bin/other --flag',
    ].join('\n'),
  )
  assert.deepEqual(parsed.map((p) => p.pid), [111], 'bash wrapper false-positive must be excluded')
  const args = parseArgs(['--max-restarts', '7', '--base-delay-ms', '5', '--root', '/x'])
  assert.equal(args.maxRestarts, 7)
  assert.equal(args.baseDelayMs, 5)
  assert.equal(args.driverDir, join('/x', 'packages/buddy-driver'))
  assert.equal(args.childScript, join('/x', 'packages/buddy-driver', 'agent-runner.mts'))
  assert.equal(args.registryPath, join('/x', 'runs', 'capability-campaign', 'active-run.json'))
  checks++

  // ---- GENERATION_READY atomically transfers active-run ownership ---------
  const rootRegistry = makeRoot('root-registry')
  const driverRegistry = join(rootRegistry, 'packages/buddy-driver')
  const registryDir = join(rootRegistry, 'runs', 'capability-campaign')
  mkdirSync(registryDir, { recursive: true })
  const registryPath = join(registryDir, 'active-run.json')
  const sourceSha = 'a'.repeat(40)
  writeActiveRunRegistry({
    record: 'capability-active-run', schemaVersion: 1, status: 'active',
    runId: 'portal-test', runDir: join(registryDir, 'runs/portal-test'),
    claimToken: 'portal-test#old', activeMinor: 'portal-test.9', segmentId: 'portal-test.9',
    runtimeDir: driverRegistry, runnerPid: 10, residentPid: 20,
    internalRunId: 'run-old', activeGenerationId: 'gen-old',
    sha: sourceSha, generationSourceSha: sourceSha, hostBootSha: sourceSha,
  }, registryPath)
  const ready = parseGenerationReadyLine(`[t] GENERATION_READY runId=run-new id=gen-new sourceSha=${sourceSha} buildHash=abc`)
  assert.deepEqual(ready, { runId: 'run-new', generationId: 'gen-new', sourceSha })
  const synced = syncActiveRunRegistryOnReady({
    registryPath, driverDir: driverRegistry, childPid: 222, supervisorPid: 111, ready,
  })
  assert.equal(synced.status, 'updated')
  assert.equal(synced.residentRestart, true)
  const storedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'))
  assert.equal(storedRegistry.runnerPid, 111)
  assert.equal(storedRegistry.supervisorPid, 111)
  assert.equal(storedRegistry.residentPid, 222)
  assert.equal(storedRegistry.internalRunId, 'run-new')
  assert.equal(storedRegistry.activeGenerationId, 'gen-new')
  assert.equal(storedRegistry.boundary, 'resident-restart')
  assert.equal(storedRegistry.activeMinor, 'portal-test.9', 'minor identity must survive supervisor restart')
  const mismatch = syncActiveRunRegistryOnReady({
    registryPath, driverDir: driverRegistry, childPid: 333, supervisorPid: 111,
    ready: { runId: 'run-wrong', generationId: 'gen-wrong', sourceSha: 'b'.repeat(40) },
  })
  assert.deepEqual(mismatch, { status: 'skipped', reason: 'source-sha-mismatch' })
  assert.equal(JSON.parse(readFileSync(registryPath, 'utf8')).residentPid, 222, 'mismatched generation must not rewrite registry')
  checks++

  // ---- restart on transient exit, then clean stop -------------------------
  const rootA = makeRoot('root-a')
  const artA = join(tmp, 'art-a')
  const resA = await runSupervisor(
    ['--root', rootA, '--child-script', fakeChild, '--artifact-dir', artA, '--max-restarts', '5', '--base-delay-ms', '10'],
    { FAKE_RESIDENT_COUNTER: join(tmp, 'counter-a'), FAKE_RESIDENT_MODE: 'fail-twice', FAKE_RESIDENT_FAIL_TIMES: '2' },
  )
  assert.equal(resA.status, 0, `clean exit expected 0, got ${resA.status}\n${resA.stderr}`)
  const a = readArtifact(artA)
  const aStarts = a.records.filter((r) => r.type === 'child_start')
  const aRetries = a.records.filter((r) => r.type === 'restart_scheduled')
  assert.equal(aStarts.length, 3, 'two transient failures must produce three child attempts')
  assert.deepEqual(aRetries.map((r) => r.delayMs), [10, 20], 'backoff must double: 10 then 20')
  assert.equal(a.summary.reason, 'clean-exit')
  assert.equal(a.summary.attempts, 3)
  checks++

  // ---- failure record written, markers + exit code captured ---------------
  const aFailures = a.records.filter((r) => r.type === 'child_exit')
  assert.equal(aFailures.length, 3)
  const first = aFailures[0]
  assert.equal(first.exitCode, 1)
  assert.equal(first.classification, 'transient')
  assert.equal(first.reason, 'model-unavailable')
  assert.match(first.markers.join('\n'), /FATAL code=MODEL_UNAVAILABLE context=planner-authority/)
  assert.match(first.markers.join('\n'), /action=terminate-resident pid=\d+ exitCode=1/)
  assert.ok(typeof first.at === 'string' && first.at.length > 0, 'failure record must carry a timestamp')
  // failures are surfaced, not hidden: echoed to stderr and child output passed through
  assert.match(resA.stderr, /SUPERVISOR_FAILURE attempt=1 exitCode=1 .*classification=transient/)
  assert.match(resA.stderr, /SUPERVISOR_RETRY nextAttempt=2 inMs=10/)
  assert.match(resA.stderr, /SUPERVISOR_FAILURES \(every retried failure is listed; none were hidden\)/)
  assert.match(resA.stdout, /FATAL code=MODEL_UNAVAILABLE/)
  checks++

  // ---- stop after the consecutive-failure limit ---------------------------
  const rootB = makeRoot('root-b')
  const artB = join(tmp, 'art-b')
  const resB = await runSupervisor(
    ['--root', rootB, '--child-script', fakeChild, '--artifact-dir', artB, '--max-restarts', '2', '--base-delay-ms', '10'],
    { FAKE_RESIDENT_COUNTER: join(tmp, 'counter-b'), FAKE_RESIDENT_MODE: 'always-crash' },
  )
  assert.equal(resB.status, 2, `budget exhaustion expected exit 2, got ${resB.status}\n${resB.stderr}`)
  const b = readArtifact(artB)
  assert.equal(b.records.filter((r) => r.type === 'child_start').length, 3, 'host runs maxRestarts+1 times then stops')
  assert.equal(b.records.filter((r) => r.type === 'restart_scheduled').length, 2)
  assert.equal(b.summary.reason, 'max-restarts-exhausted')
  assert.equal(b.summary.failures.length, 3, 'every failure is retained in the summary')
  assert.match(resB.stderr, /SUPERVISOR_SUMMARY reason=max-restarts-exhausted exitCode=2/)
  checks++

  // ---- a resident-handled SIGTERM is not an intentional exit-0 ------------
  const rootSignal = makeRoot('root-signal')
  const artSignal = join(tmp, 'art-signal')
  const signalRun = await runSupervisor(
    ['--root', rootSignal, '--child-script', fakeChild, '--artifact-dir', artSignal, '--max-restarts', '1', '--base-delay-ms', '10'],
    { FAKE_RESIDENT_COUNTER: join(tmp, 'counter-signal'), FAKE_RESIDENT_MODE: 'signal-term' },
  )
  assert.equal(signalRun.status, 2, `a handled signal must be retryable, then bounded: ${signalRun.status}\n${signalRun.stderr}`)
  const signalArtifact = readArtifact(artSignal)
  assert.equal(signalArtifact.records.filter((r) => r.type === 'child_start').length, 2)
  assert.equal(signalArtifact.records.filter((r) => r.type === 'child_exit')[0].classification, 'transient')
  assert.match(signalArtifact.records.filter((r) => r.type === 'child_exit')[0].markers.join('\n'), /SHUTDOWN reason=SIGTERM/)
  assert.equal(signalArtifact.summary.reason, 'max-restarts-exhausted')
  checks++

  // ---- a supervisor signal interrupts backoff before another child starts -
  const rootBackoffSignal = makeRoot('root-backoff-signal')
  const artBackoffSignal = join(tmp, 'art-backoff-signal')
  const backoffSignal = startSupervisor(
    ['--root', rootBackoffSignal, '--child-script', fakeChild, '--artifact-dir', artBackoffSignal, '--max-restarts', '5', '--base-delay-ms', '2000'],
    { FAKE_RESIDENT_COUNTER: join(tmp, 'counter-backoff-signal'), FAKE_RESIDENT_MODE: 'always-crash' },
  )
  await waitForRecord(artBackoffSignal, 'restart_scheduled')
  backoffSignal.child.kill('SIGTERM')
  const backoffSignalResult = await backoffSignal.done
  assert.equal(backoffSignalResult.status, 143, `SIGTERM during backoff must exit 143: ${backoffSignalResult.status}\n${backoffSignalResult.stderr}`)
  const backoffSignalArtifact = readArtifact(artBackoffSignal)
  assert.equal(backoffSignalArtifact.records.filter((r) => r.type === 'child_start').length, 1, 'backoff signal must not start another resident')
  assert.equal(backoffSignalArtifact.records.filter((r) => r.type === 'backoff_interrupted').length, 1)
  assert.equal(backoffSignalArtifact.records.find((r) => r.type === 'backoff_interrupted').signal, 'SIGTERM')
  assert.equal(backoffSignalArtifact.records.at(-1).type, 'supervisor_stop', 'stop evidence is flushed after interrupting backoff')
  assert.equal(backoffSignalArtifact.summary.reason, 'supervisor-signal-SIGTERM')
  assert.equal(backoffSignalArtifact.summary.exitCode, 143)
  checks++

  // ---- a clean first run is not retried -----------------------------------
  const rootC = makeRoot('root-c')
  const artC = join(tmp, 'art-c')
  const resC = await runSupervisor(
    ['--root', rootC, '--child-script', fakeChild, '--artifact-dir', artC, '--max-restarts', '5'],
    { FAKE_RESIDENT_COUNTER: join(tmp, 'counter-c'), FAKE_RESIDENT_MODE: 'healthy' },
  )
  assert.equal(resC.status, 0)
  const c = readArtifact(artC)
  assert.equal(c.summary.attempts, 1)
  assert.equal(c.summary.restarts, 0)
  assert.equal(c.summary.reason, 'clean-exit')
  checks++

  // ---- a host-lock exit is a hard stop, never an auto-retry ---------------
  const rootD = makeRoot('root-d')
  const artD = join(tmp, 'art-d')
  const resD = await runSupervisor(
    ['--root', rootD, '--child-script', fakeChild, '--artifact-dir', artD, '--max-restarts', '5'],
    { FAKE_RESIDENT_COUNTER: join(tmp, 'counter-d'), FAKE_RESIDENT_MODE: 'host-lock' },
  )
  assert.equal(resD.status, 3, `hard-stop expected exit 3, got ${resD.status}\n${resD.stderr}`)
  const d = readArtifact(artD)
  assert.equal(d.summary.reason, 'hard-stop')
  assert.equal(d.summary.attempts, 1)
  assert.equal(d.summary.restarts, 0)
  checks++

  // ---- preflight refuses to start a second host ---------------------------
  const rootE = makeRoot('root-e')
  mkdirSync(join(rootE, 'packages/buddy-driver', 'data', 'resident'), { recursive: true })
  writeFileSync(join(rootE, 'packages/buddy-driver', 'data', 'resident', 'host.lock'), `${process.pid}\n`, 'utf8')
  const pre = preflight({ driverDir: join(rootE, 'packages/buddy-driver'), checkProcesses: false })
  assert.equal(pre.ok, false)
  assert.match(pre.blockers.join('\n'), /host lock held by live pid=/)
  const artE = join(tmp, 'art-e')
  const resE = await runSupervisor(['--root', rootE, '--child-script', fakeChild, '--artifact-dir', artE], {
    FAKE_RESIDENT_COUNTER: join(tmp, 'counter-e'),
    FAKE_RESIDENT_MODE: 'healthy',
  })
  assert.equal(resE.status, 1, `refusal expected exit 1, got ${resE.status}`)
  assert.match(resE.stderr, /REFUSING TO START/)
  assert.match(resE.stderr, /Never run two live hosts/)
  checks++

  // ---- status + dry-run + help --------------------------------------------
  const status = await runSupervisor(['--root', rootE, '--status', '--json'])
  assert.equal(status.status, 0)
  const statusJson = JSON.parse(status.stdout)
  assert.equal(statusJson.running, true)
  checks++

  const artF = join(tmp, 'art-f')
  const dry = await runSupervisor([
    '--root', makeRoot('root-f'),
    '--child-script', fakeChild,
    '--artifact-dir', artF,
    '--dry-run',
  ])
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /availability-retry \(NOT semantic fallback\)/)
  assert.equal(readdirSync(tmp).includes('art-f'), false, 'dry-run must not create the artifact dir')
  checks++

  const help = await runSupervisor(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /This is NOT a semantic fallback/)
  assert.match(help.stdout, /--max-restarts/)
  assert.match(help.stdout, /--base-delay-ms/)
  assert.match(help.stdout, /--log/)
  checks++

  console.log(`resident-supervisor: ${checks}/${checks} checks passed`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
