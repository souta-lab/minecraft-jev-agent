#!/usr/bin/env bun
// Offline fixture for tools/resident-watchdog.mjs.
//
// No live server, no network, no resident, no control socket. Synthetic log
// text drives every verdict class, and a temp "resident tree" proves the tool
// never writes to the tree it observes.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TOOL = join(HERE, 'resident-watchdog.mjs')

const { EXIT_DEAD, EXIT_FROZEN, EXIT_OK, EXIT_USAGE, parseArgs, parseHeartbeat, parseLog, parseTimestampMs } =
  await import('./resident-watchdog.mjs')

const tmp = mkdtempSync(join(tmpdir(), 'resident-watchdog-'))
let checks = 0

// Wall clock the fixtures are generated against. `--now` pins the detector to
// the same instant, so age/threshold math is deterministic without touching the
// resident.
const BASE = Date.now()

function logText(entries) {
  return entries.map(([offsetSec, text]) => `[${new Date(BASE + offsetSec * 1000).toISOString()}] ${text}`).join('\n') + '\n'
}

function writeLog(dir, name, text, { mtimeMs } = {}) {
  const path = join(dir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000
    utimesSync(path, seconds, seconds)
  }
  return path
}

function runWatchdog(args, { cwd = ROOT } = {}) {
  const child = Bun.spawn([process.execPath, TOOL, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { status: await child.exited, stdout, stderr }
  })()
}

function summaryOf(stdout) {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('WATCHDOG '))
  assert.ok(line, `no WATCHDOG summary line in:\n${stdout}`)
  return Object.fromEntries(
    line
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((field) => {
        const index = field.indexOf('=')
        return [field.slice(0, index), field.slice(index + 1)]
      }),
  )
}

function snapshotTree(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        const st = statSync(path)
        const sha = createHash('sha256').update(readFileSync(path)).digest('hex')
        out.push(`${path} size=${st.size} mtime=${st.mtimeMs} sha=${sha}`)
      }
    }
  }
  walk(root)
  return out
}

// The exact live lines quoted in the incident report.
const LIVE_HEARTBEAT =
  'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=idle'
const LIVE_SMELT = 'SMELT:iron_ingot key=overworld:10,65,-9 attempts=81 reason=stuck kind=SMELT'
const LIVE_STALL = 'LOCAL_PROGRESS_STALL stalledMs=73354 goal=smelt:iron_ingot:1 boundary=local_recovery'

try {
  // ---- pure parsing --------------------------------------------------------
  assert.equal(parseTimestampMs('[2026-09-21T08:18:37.532Z] HEARTBEAT pos=1,2,3'), Date.parse('2026-09-21T08:18:37.532Z'))
  assert.equal(parseTimestampMs('no timestamp here'), null)
  const parsedHeartbeat = parseHeartbeat({
    text: `[t] ${LIVE_HEARTBEAT}`,
    index: 0,
    tsMs: 1,
  })
  assert.deepEqual(parsedHeartbeat.pos, { x: 8.7, y: 65, z: -9.3, raw: '8.7,65.0,-9.3' })
  assert.equal(parsedHeartbeat.goal, 'smelt 1 x iron_ingot')
  assert.equal(parsedHeartbeat.action, 'idle')
  const parsed = parseLog(logText([
    [0, LIVE_HEARTBEAT],
    [1, LIVE_SMELT],
    [2, LIVE_STALL],
    [3, 'REPLAN_THROTTLED reason=no_progress ageMs=337177 stateHash=abc because=no_new_info'],
    [4, 'LOCAL_RECOVERY_ENTER boundary=local_recovery'],
    [5, 'CAUSAL record=causal candidateId=WAIT actionId=WAIT verified=false progressDelta=0'],
    [6, 'CAUSAL record=causal candidateId=RETRIEVE verified=true status=done progressDelta=1'],
  ]).split('\n').filter(Boolean))
  assert.equal(parsed.heartbeats.length, 1)
  assert.equal(parsed.stalls.length, 1)
  assert.equal(parsed.replans.length, 1)
  assert.equal(parsed.recoveries.length, 1)
  assert.equal(parsed.completions.length, 1, 'verified=false must not count as completion')
  assert.equal(parsed.actions.length, 2, 'leading action token and actionId= lines are action events')
  checks++

  // ---- argument parsing ----------------------------------------------------
  const args = parseArgs(['--log', '/x/buddy.log', '--stall-minutes', '5', '--repeat-threshold', '7', '--json'])
  assert.equal(args.log, '/x/buddy.log')
  assert.equal(args.stallMinutes, 5)
  assert.equal(args.repeatThreshold, 7)
  assert.equal(args.json, true)
  assert.equal(args.follow, false)
  checks++

  // ---- 1. healthy progress -> OK ------------------------------------------
  const healthyDir = join(tmp, 'healthy')
  const healthyLog = writeLog(healthyDir, 'buddy-driver/buddy.log', logText([
    [-70, 'BOOT pid=1201 runId=run-fixture-healthy'],
    [-55, 'HEARTBEAT pos=1.0,64.0,1.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=0 action=SMELT'],
    [-45, 'ACTION n=1 id=SMELT:iron_ingot kind=SMELT phase=pathing-to-furnace pos=1.0,64.0,1.0 rung=nether_portal'],
    [-35, 'HEARTBEAT pos=2.5,64.0,1.4 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=0 action=SMELT'],
    [-25, 'ACTION n=2 id=SMELT:iron_ingot kind=SMELT phase=smelting pos=2.5,64.0,1.4 rung=nether_portal'],
    [-12, 'HEARTBEAT pos=4.0,64.0,2.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=0 action=SMELT'],
    [-5, 'CAUSAL record=causal candidateId=SMELT:iron_ingot actionId=SMELT:iron_ingot verified=true status=done progressDelta=1'],
  ]))
  const healthy = await runWatchdog(['--log', healthyLog, '--now', String(BASE)])
  assert.equal(healthy.status, EXIT_OK, `healthy expected exit 0\n${healthy.stdout}\n${healthy.stderr}`)
  const healthySummary = summaryOf(healthy.stdout)
  assert.equal(healthySummary.status, 'OK')
  assert.equal(healthySummary.reason, 'progressing')
  assert.equal(healthySummary.pos, '4.0,64.0,2.0')
  assert.equal(healthySummary.exit, '0')
  assert.ok(Number(healthySummary.stalledMs) < 180_000, 'healthy resident must not look stalled')
  checks++

  // ---- 2. identical heartbeats past the threshold -> FROZEN ---------------
  const frozenDir = join(tmp, 'frozen-pos')
  const frozenLog = writeLog(frozenDir, 'buddy-driver/buddy.log', logText([
    [-250, 'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
    [-190, 'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
    [-120, 'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
    [-60, 'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
    [-15, 'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
  ]))
  const frozen = await runWatchdog(['--log', frozenLog, '--now', String(BASE)])
  assert.equal(frozen.status, EXIT_FROZEN, `frozen expected exit 1\n${frozen.stdout}\n${frozen.stderr}`)
  const frozenSummary = summaryOf(frozen.stdout)
  assert.equal(frozenSummary.status, 'FROZEN')
  assert.equal(frozenSummary.reason, 'pos-stall')
  assert.equal(frozenSummary.liveness, 'alive-frozen')
  assert.equal(frozenSummary.exit, '1')
  assert.ok(Number(frozenSummary.stalledMs) >= 180_000, `stalledMs must clear the default threshold, got ${frozenSummary.stalledMs}`)
  assert.match(frozen.stdout, /WATCHDOG_EVIDENCE kind=line/)
  checks++

  // ---- 3. exact live incident lines -> FROZEN local-progress-stall --------
  const liveDir = join(tmp, 'live-shape')
  const liveText = logText([
    [-200, LIVE_HEARTBEAT],
    [-150, LIVE_SMELT],
    [-145, LIVE_SMELT],
    [-100, LIVE_HEARTBEAT],
    [-60, LIVE_STALL],
    [-40, 'LOCAL_PROGRESS_STALL stalledMs=140000 goal=smelt:iron_ingot:1 boundary=local_recovery'],
    [-15, 'LOCAL_PROGRESS_STALL stalledMs=151000 goal=smelt:iron_ingot:1 boundary=local_recovery'],
    [-10, LIVE_HEARTBEAT],
    [-8, LIVE_SMELT],
  ])
  const liveLog = writeLog(liveDir, 'buddy-driver/buddy.log', liveText)
  for (const exact of [LIVE_HEARTBEAT, LIVE_SMELT, LIVE_STALL]) {
    assert.ok(liveText.includes(exact), `fixture must contain the exact live line: ${exact}`)
  }
  const live = await runWatchdog(['--log', liveLog, '--now', String(BASE)])
  assert.equal(live.status, EXIT_FROZEN, `live shape expected exit 1\n${live.stdout}\n${live.stderr}`)
  const liveSummary = summaryOf(live.stdout)
  assert.equal(liveSummary.status, 'FROZEN')
  assert.equal(liveSummary.reason, 'local-progress-stall')
  assert.equal(liveSummary.pos, '8.7,65.0,-9.3')
  assert.equal(liveSummary.goal, 'smelt:iron_ingot:1')
  assert.equal(liveSummary.lpStall, '3')
  assert.ok(liveSummary.reasons.includes('pos-stall'), `expected pos-stall in reasons, got ${liveSummary.reasons}`)
  assert.ok(Number(liveSummary.stalledMs) >= 180_000, `stalledMs must reflect the stall, got ${liveSummary.stalledMs}`)
  checks++

  // ---- exact live lines via --json: one JSON object, evidence retained -----
  const liveJson = await runWatchdog(['--log', liveLog, '--now', String(BASE), '--json'])
  assert.equal(liveJson.status, EXIT_FROZEN)
  assert.equal(liveJson.stdout.trim().split('\n').length, 1, '--json must emit exactly one line')
  const liveObject = JSON.parse(liveJson.stdout)
  assert.equal(liveObject.status, 'FROZEN')
  assert.equal(liveObject.reason, 'local-progress-stall')
  assert.equal(liveObject.exitCode, 1)
  assert.equal(liveObject.pos, '8.7,65.0,-9.3')
  assert.equal(liveObject.counters.lpStall, 3)
  assert.ok(Array.isArray(liveObject.evidence) && liveObject.evidence.length > 0)
  assert.ok(liveObject.evidence.every((item) => item.kind === 'line' || item.kind === 'fact'))
  assert.match(JSON.stringify(liveObject.evidence), /LOCAL_PROGRESS_STALL stalledMs=73354/)
  checks++

  // ---- 4. repeated WAIT action with moving body -> FROZEN wait-loop -------
  const waitDir = join(tmp, 'wait-loop')
  const waitLog = writeLog(waitDir, 'buddy-driver/buddy.log', logText([
    [-60, 'HEARTBEAT pos=1.0,64.0,1.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=WAIT'],
    [-50, 'ACTION n=1 id=WAIT kind=WAIT phase=waiting 300ms pos=1.0,64.0,1.0 rung=nether_portal'],
    [-40, 'HEARTBEAT pos=1.1,64.0,1.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=WAIT'],
    [-30, 'ACTION n=2 id=WAIT kind=WAIT phase=waiting 300ms pos=1.1,64.0,1.0 rung=nether_portal'],
    [-20, 'HEARTBEAT pos=1.2,64.0,1.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=WAIT'],
    [-10, 'ACTION n=3 id=WAIT kind=WAIT phase=waiting 300ms pos=1.2,64.0,1.0 rung=nether_portal'],
  ]))
  const wait = await runWatchdog(['--log', waitLog, '--now', String(BASE)])
  assert.equal(wait.status, EXIT_FROZEN, `wait loop expected exit 1\n${wait.stdout}\n${wait.stderr}`)
  const waitSummary = summaryOf(wait.stdout)
  assert.equal(waitSummary.reason, 'wait-loop')
  assert.equal(waitSummary.dominantAction, 'WAIT')
  assert.ok(Number(waitSummary.actionRepeats) >= 3)
  checks++

  // ---- 5. throttled replans + repeated local recovery -> FROZEN -----------
  const replanDir = join(tmp, 'replan')
  const replanLog = writeLog(replanDir, 'buddy-driver/buddy.log', logText([
    [-60, 'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=idle'],
    [-50, 'REPLAN_THROTTLED reason=no_progress ageMs=337177 stateHash=61a04d6271b97fc3 because=no_new_info'],
    [-45, 'LOCAL_RECOVERY_ENTER boundary=local_recovery'],
    [-40, 'REPLAN_THROTTLED reason=no_progress ageMs=414713 stateHash=61a04d6271b97fc3 because=no_new_info'],
    [-35, 'LOCAL_RECOVERY_ENTER boundary=local_recovery'],
    [-30, 'REPLAN_THROTTLED reason=no_progress ageMs=452718 stateHash=61a04d6271b97fc3 because=no_new_info'],
    [-25, 'LOCAL_RECOVERY_ENTER boundary=local_recovery'],
    [-20, 'HEARTBEAT pos=8.7,65.0,-9.3 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=idle'],
  ]))
  const replan = await runWatchdog(['--log', replanLog, '--now', String(BASE)])
  assert.equal(replan.status, EXIT_FROZEN, `replan expected exit 1\n${replan.stdout}\n${replan.stderr}`)
  const replanSummary = summaryOf(replan.stdout)
  assert.equal(replanSummary.reason, 'replan-throttled')
  assert.ok(replanSummary.reasons.includes('local-recovery-loop'), `got ${replanSummary.reasons}`)
  assert.equal(replanSummary.replanThrottled, '3')
  assert.equal(replanSummary.localRecovery, '3')
  checks++

  // ---- 6. stale log -> DEAD ----------------------------------------------
  const staleDir = join(tmp, 'stale')
  const staleLog = writeLog(staleDir, 'buddy-driver/buddy.log', logText([
    [-600, 'HEARTBEAT pos=1.0,64.0,1.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
  ]), { mtimeMs: BASE - 600_000 })
  const stale = await runWatchdog(['--log', staleLog, '--now', String(BASE)])
  assert.equal(stale.status, EXIT_DEAD, `stale expected exit 2\n${stale.stdout}\n${stale.stderr}`)
  const staleSummary = summaryOf(stale.stdout)
  assert.equal(staleSummary.status, 'DEAD')
  assert.equal(staleSummary.reason, 'log-stale')
  assert.equal(staleSummary.liveness, 'dead')
  assert.equal(staleSummary.exit, '2')
  assert.ok(Number(staleSummary.logAgeMs) > 120_000)
  checks++

  // ---- 7. dead pid -> DEAD -----------------------------------------------
  const deadDir = join(tmp, 'dead-pid')
  const deadLog = writeLog(deadDir, 'buddy-driver/buddy.log', logText([
    [-20, 'HEARTBEAT pos=1.0,64.0,1.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
  ]))
  const exitChild = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' })
  await exitChild.exited
  const deadPid = exitChild.pid
  const dead = await runWatchdog(['--log', deadLog, '--pid', String(deadPid), '--now', String(BASE)])
  assert.equal(dead.status, EXIT_DEAD, `dead pid expected exit 2\n${dead.stdout}\n${dead.stderr}`)
  const deadSummary = summaryOf(dead.stdout)
  assert.equal(deadSummary.reason, 'pid-dead')
  assert.equal(deadSummary.pidSource, 'flag')
  assert.equal(deadSummary.pidAlive, 'false')
  checks++

  // ---- 8. host.lock pid is read (not written) and drives DEAD -------------
  const lockDir = join(tmp, 'lock-tree')
  const lockLog = writeLog(lockDir, 'buddy-driver/buddy.log', logText([
    [-20, 'HEARTBEAT pos=1.0,64.0,1.0 health=20 running=true rung=nether_portal queue=smelt 1 x iron_ingot depth=6 done=1 action=SMELT'],
  ]))
  mkdirSync(join(lockDir, 'buddy-driver/data/resident'), { recursive: true })
  writeFileSync(join(lockDir, 'buddy-driver/data/resident/host.lock'), `${deadPid}\n`, 'utf8')
  const lockRun = await runWatchdog(['--root', lockDir, '--now', String(BASE)])
  assert.equal(lockRun.status, EXIT_DEAD)
  const lockSummary = summaryOf(lockRun.stdout)
  assert.equal(lockSummary.reason, 'pid-dead')
  assert.equal(lockSummary.pidSource, 'host-lock')
  assert.equal(lockSummary.pid, String(deadPid))
  checks++

  // ---- 9. missing log -> DEAD --------------------------------------------
  const missing = await runWatchdog(['--log', join(tmp, 'does-not-exist.log'), '--now', String(BASE)])
  assert.equal(missing.status, EXIT_DEAD)
  assert.equal(summaryOf(missing.stdout).reason, 'log-missing')
  checks++

  // ---- 10. --follow exits on the first FROZEN observation -----------------
  const followFrozen = await runWatchdog([
    '--log', frozenLog, '--now', String(BASE), '--follow', '--interval-ms', '100', '--timeout-ms', '5000',
  ])
  assert.equal(followFrozen.status, EXIT_FROZEN, `follow frozen expected exit 1\n${followFrozen.stdout}`)
  assert.equal(summaryOf(followFrozen.stdout).status, 'FROZEN')
  checks++

  // ---- 11. --follow keeps polling a healthy log until the timeout ---------
  const followHealthy = await runWatchdog([
    '--log', healthyLog, '--now', String(BASE), '--follow', '--interval-ms', '50', '--timeout-ms', '300',
  ])
  assert.equal(followHealthy.status, EXIT_OK)
  assert.equal(summaryOf(followHealthy.stdout).status, 'OK')
  checks++

  // ---- 12. strictly read-only over a resident-like tree -------------------
  const roDir = join(tmp, 'read-only-tree')
  const roLog = writeLog(roDir, 'buddy-driver/buddy.log', logText([
    [-200, LIVE_HEARTBEAT],
    [-100, LIVE_HEARTBEAT],
    [-60, LIVE_STALL],
    [-15, LIVE_STALL],
  ]))
  mkdirSync(join(roDir, 'buddy-driver/data/resident'), { recursive: true })
  writeFileSync(join(roDir, 'buddy-driver/data/resident/host.lock'), '999999999\n', 'utf8')
  const before = snapshotTree(roDir)
  await runWatchdog(['--root', roDir, '--now', String(BASE)])
  await runWatchdog(['--root', roDir, '--now', String(BASE), '--json'])
  await runWatchdog(['--root', roDir, '--now', String(BASE), '--follow', '--interval-ms', '30', '--timeout-ms', '150'])
  const after = snapshotTree(roDir)
  assert.deepEqual(after, before, 'watchdog must not create, delete or modify anything under the observed tree')
  assert.ok(before.some((entry) => entry.includes('host.lock')), 'fixture must include a host lock to prove it is not touched')
  checks++

  // ---- 13. --help states the observe-only contract ------------------------
  const help = await runWatchdog(['--help'])
  assert.equal(help.status, EXIT_OK)
  assert.match(help.stdout, /ONLY OBSERVES/)
  assert.match(help.stdout, /NOT a recovery mechanism/)
  assert.match(help.stdout, /control socket/)
  assert.match(help.stdout, /--stall-minutes/)
  assert.equal(help.stdout.includes('\u001b'), false, 'help must be plain text')
  checks++

  // ---- 14. usage errors never masquerade as a health status ---------------
  const bad = await runWatchdog(['--nope'])
  assert.equal(bad.status, EXIT_USAGE)
  assert.equal(/^WATCHDOG /m.test(bad.stdout), false, 'usage error must not emit a health status')
  assert.match(bad.stderr, /unknown argument/)
  checks++

  console.log(`resident-watchdog: ${checks}/${checks} checks passed`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
