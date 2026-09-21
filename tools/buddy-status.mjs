#!/usr/bin/env bun
// buddy-status: one-shot health dashboard for the resident AI_Buddy agent.
// Usage: bun tools/buddy-status.mjs [--json]
// Reads: process table, control socket (report), buddy.log markers, git log.
// Read-only. Safe to run anytime. No secrets are printed.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'

const DIR = '/home/s0u7a/mc-ai/buddy-driver'
const LOG = `${DIR}/buddy.log`
const SOCK = `${DIR}/data/resident/control.sock`
const JSON_OUT = process.argv.includes('--json')

const sh = (c) => {
  try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

function hosts() {
  const out = sh("pgrep -af 'bun agent-runner.mts'")
  if (!out) return []
  // Only real Bun processes: exclude bash -c wrappers whose command line merely
  // contains the pgrep pattern (a known false-positive trap).
  return out.split('\n')
    .filter((l) => /\d+\s+\S*bun\s+agent-runner\.mts/.test(l) && !/\bbash\b|\/bin\/sh\b/.test(l))
    .map((l) => l.trim().split(/\s+/)[0])
}

function callSock(cmd, args = {}) {
  return new Promise((resolve) => {
    if (!existsSync(SOCK)) return resolve(null)
    const s = net.createConnection(SOCK)
    let buf = ''
    const done = (v) => { try { s.destroy() } catch {} ; resolve(v) }
    s.setTimeout(6000, () => done(null))
    s.on('error', () => done(null))
    s.on('data', (d) => {
      buf += d.toString('utf8')
      if (buf.includes('\n')) {
        try { done(JSON.parse(buf.split('\n')[0])) } catch { done(null) }
      }
    })
    s.on('connect', () => s.write(JSON.stringify({ id: Date.now() % 100000, cmd, args }) + '\n'))
  })
}

const MARKERS = ['LADDER_PREREQ', 'PRECONDITION_MISSING', 'JEV_HEADS', 'ADVISOR source=mercury',
  'ADVISOR source=llm', 'ADVISOR source=fallback', 'TOOL_CHOICE', 'JUMP_ATTEMPT', 'DIG_PATH',
  'STAIRCASE', 'REUSE_TUNNEL', 'DIG_OSCILLATE', 'DESCEND_LIMIT', 'MOVE_OSCILLATE', 'DEATH', 'LADDER_RESET',
  'RECONNECT', 'RECONNECT_SUCCESS', 'LEASE_ACQUIRED', 'LEASE_REVOKED', 'DISCONNECT', 'HOST_LOCK']

function markerCounts() {
  if (!existsSync(LOG)) return {}
  const txt = readFileSync(LOG, 'utf8')
  const c = {}
  for (const m of MARKERS) c[m] = txt.split(m).length - 1
  return c
}

function lastLines(n = 4) {
  if (!existsSync(LOG)) return []
  const lines = readFileSync(LOG, 'utf8').trim().split('\n')
  return lines.slice(-n)
}

const report = await callSock('report')
const d = report?.ok ? report.data : null
const ps = hosts()
const counts = markerCounts()
const acceptance = existsSync(`${DIR}/data/resident`)
  ? sh(`ls -t ${DIR}/data/resident/acceptance-run-*.json 2>/dev/null | head -1`)
  : ''
const freezes = sh(`ls -t ${DIR}/logs/resident/freeze-*.json 2>/dev/null | head -1`)
const lastCommit = sh('cd /home/s0u7a/mc-ai && git log --oneline -1')
const logAge = existsSync(LOG) ? Math.round((Date.now() - statSync(LOG).mtimeMs) / 1000) : null

const summary = {
  hosts: ps,
  hostCount: ps.length,
  singleInstanceOk: ps.length === 1,
  connected: d?.connected ?? null,
  frozen: d?.frozen ?? null,
  generations: d?.generations ?? null,
  reloads: d?.stats?.reloadsChangedHash ?? null,
  reloadsFailed: d?.stats?.reloadsFailed ?? null,
  recoveries: d?.recoveries ?? null,
  reconnects: d?.stats?.reconnects ?? null,
  reconnectsLastHour: d?.stats?.reconnectsLastHour ?? d?.reconnect?.reconnectsLastHour ?? null,
  leaseActiveId: d?.lease?.activeId ?? d?.generationId ?? null,
  hostLock: d?.hostLock ?? null,
  wedge: d?.stats?.wedge ?? null,
  goalComplete: d?.stats?.goalComplete ?? null,
  listenerLeak: d?.listenerLeak ?? null,
  milestone: d?.milestone ?? null,
  ores: d?.worldMemory?.discoveredOres ?? null,
  craftingTables: d?.worldMemory?.craftingTables ?? null,
  policyKind: d?.status?.policyKind ?? null,
  logAgeSec: logAge,
  acceptance,
  lastFreeze: freezes,
  lastCommit,
  markers: counts,
}

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  const row = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`)
  console.log('== AI_Buddy resident status ==')
  row('hosts', `${ps.length}${ps.length === 1 ? ' (ok)' : ' (!! expected 1)'}  ${ps.join(',')}`)
  row('connected', d ? `${d.connected}  frozen=${d.frozen}` : 'NO CONTROL SOCKET')
  row('milestone', `${d?.milestone}  policy=${d?.status?.policyKind}`)
  row('generations', `${d?.generations}  reloads(hash)=${d?.stats?.reloadsChangedHash} failed=${d?.stats?.reloadsFailed}`)
  row('recoveries', `${d?.recoveries}  reconnects=${d?.stats?.reconnects} lastHour=${d?.stats?.reconnectsLastHour} wedge=${d?.stats?.wedge}`)
  row('lease', `${d?.lease?.activeId || '(none)'}  lock=${d?.hostLock?.present ? `held pid=${d?.hostLock?.filePid}` : 'MISSING'}`)
  row('listenerLeak', `${d?.listenerLeak}${d?.listenerLeak ? '  (!! fix pending)' : ''}`)
  row('ores', JSON.stringify(d?.worldMemory?.discoveredOres ?? []))
  row('craftTables', d?.worldMemory?.craftingTables)
  row('logAge', logAge === null ? 'n/a' : `${logAge}s ago`)
  row('acceptance', acceptance || '(none)')
  row('lastFreeze', freezes || '(none)')
  row('lastCommit', lastCommit)
  console.log('  markers:')
  for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(22)} ${v}`)
  console.log('  last log lines:')
  for (const l of lastLines()) console.log(`    ${l.slice(0, 150)}`)
}
