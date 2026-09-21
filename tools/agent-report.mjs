#!/usr/bin/env bun
// agent-report.mjs - read-only observability report for the resident AI_Buddy agent.
//
// Combines the live control socket (`report` command only) with the structured
// buddy.log to answer, WITHOUT joining the world:
//   who is connected, what mission/rung, what action is running, what is
//   blocking it, whether it looks stuck, what the world/inventory looks like,
//   and what the recent decisions were.
//
// Read-only: it only ever sends the `report` control command (a pure query) and
// reads files. It never writes to the tree/host, never sends mutating commands,
// makes no LLM calls and no network traffic beyond the local unix socket.
//
// Usage:
//   bun tools/agent-report.mjs [--json] [--watch [sec]] [--since <min>]
//                               [--full] [--why] [--log <path>]
//                               [--report <json>] [--no-socket]
//
// Exit code: 0 normally (including agent down / disconnected);
//            2 only on unrecoverable parse failure (e.g. --log path unusable).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BASE = process.env.MC_AI_DIR || '/home/s0u7a/mc-ai'
const BUDDY_DIR = path.join(BASE, 'buddy-driver')
export const DEFAULT_LOG = path.join(BUDDY_DIR, 'buddy.log')
export const DEFAULT_SOCK = path.join(BUDDY_DIR, 'data/resident/control.sock')
const DEFAULT_STATE = path.join(BUDDY_DIR, 'buddy-state.json')

// Stuck heuristics; tunable, documented in the report header.
export const STUCK = {
  windowMin: 30, // default lookback for the stuck heuristics
  moveBlocks: 5, // < this many blocks of bbox movement in the window = pinned
  repeatCount: 8, // current action repeated >= this many times in window
  invChangeMin: 10, // no inventory change for >= this many minutes
  abandonMin: 3, // >= this many abandons in window
}
export const MAX_LINES = 120

const tsRe = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]\s*/
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

export function parseArgs(argv) {
  const o = {
    json: false,
    full: false,
    why: false,
    watch: false,
    watchSec: 5,
    sinceMin: null,
    log: DEFAULT_LOG,
    sock: DEFAULT_SOCK,
    reportFile: null,
    noSocket: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--full') o.full = true
    else if (a === '--why') o.why = true
    else if (a === '--no-socket') o.noSocket = true
    else if (a === '--log') o.log = argv[++i] || o.log
    else if (a.startsWith('--log=')) o.log = a.slice(6)
    else if (a === '--report') o.reportFile = argv[++i] || null
    else if (a.startsWith('--report=')) o.reportFile = a.slice(9)
    else if (a === '--since') o.sinceMin = num(argv[++i])
    else if (a.startsWith('--since=')) o.sinceMin = num(a.slice(8))
    else if (a === '--watch') {
      o.watch = true
      const n = Number(argv[i + 1])
      if (argv[i + 1] && !argv[i + 1].startsWith('--') && Number.isFinite(n)) {
        o.watchSec = n
        i++
      }
    } else if (a.startsWith('--watch=')) {
      o.watch = true
      o.watchSec = num(a.slice(8)) ?? 5
    } else if (a === '--help' || a === '-h') o.help = true
  }
  if (o.sinceMin !== null && o.sinceMin <= 0) o.sinceMin = null
  if (o.watchSec <= 0) o.watchSec = 5
  return o
}

// ── control socket (query-only) ────────────────────────────────────────────
export function socketReport(sockPath, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!sockPath || !existsSync(sockPath)) return resolve({ ok: false, error: 'socket-missing' })
    let s
    try {
      s = net.createConnection(sockPath)
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e) })
    }
    let buf = ''
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      try {
        s.destroy()
      } catch {}
      resolve(v)
    }
    s.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }))
    s.on('error', (e) => finish({ ok: false, error: String(e.message || e) }))
    s.on('data', (d) => {
      buf += d.toString('utf8')
      const i = buf.indexOf('\n')
      if (i < 0) return
      try {
        const j = JSON.parse(buf.slice(0, i))
        finish({ ok: j.ok !== false, data: j.data ?? j, error: j.ok === false ? j.error ?? 'not-ok' : null })
      } catch (e) {
        finish({ ok: false, error: 'bad-json:' + String(e.message || e) })
      }
    })
    s.on('connect', () => {
      try {
        s.write(JSON.stringify({ id: Date.now() % 100000, cmd: 'report', args: {} }) + '\n')
      } catch (e) {
        finish({ ok: false, error: String(e.message || e) })
      }
    })
  })
}

// ── bounded event aggregation ──────────────────────────────────────────────
class Blocker {
  constructor() {
    this.count = 0
    this.firstTs = null
    this.lastTs = null
    this.examples = []
  }
  add(ts, text, meta = {}) {
    this.count++
    if (this.firstTs === null) this.firstTs = ts
    this.lastTs = ts
    this.examples.push({ ts, text, ...meta })
    if (this.examples.length > 10) this.examples.shift()
  }
  toJSON() {
    return { count: this.count, firstTs: this.firstTs, lastTs: this.lastTs, examples: this.examples }
  }
}

function pushRing(arr, v, cap) {
  arr.push(v)
  if (arr.length > cap) arr.shift()
}

function pushDecision(out, kind, t, text) {
  const rec = { t, kind, text }
  pushRing(out.decisions, rec, 200)
  const ring = out.decisionRings[kind]
  if (ring) pushRing(ring, rec, 10)
}

// Parse buddy.log into aggregates. Bounded memory: only the tail of each
// stream is retained (counts are exact, examples bounded).
export function parseLog(text, { sinceMin = null, logPath = null } = {}) {
  const lines = text.split('\n')
  // anchor windows on the latest timestamp in the file so results are
  // deterministic for fixtures and honest for a stale log.
  let anchorMs = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = tsRe.exec(lines[i])
    if (m) {
      anchorMs = Date.parse(m[1])
      break
    }
  }
  if (anchorMs === null) anchorMs = Date.now()
  const cutoff = sinceMin ? anchorMs - sinceMin * 60000 : -Infinity

  const out = {
    logPath,
    anchorMs,
    sinceMin,
    totalLines: lines.length,
    parsedLines: 0,
    lastTs: null,
    blockers: {
      abandoned: new Map(), // action -> Blocker
      replanThrottled: new Blocker(),
      replanRejected: new Blocker(),
      waitLimit: new Blocker(),
      preconditionMissing: new Blocker(),
      ladderPrereq: new Blocker(),
      moveUnreachable: new Blocker(),
      retrieveStalled: new Blocker(),
      descendStalled: new Blocker(),
      digOscillate: new Blocker(),
      moveOscillate: new Blocker(),
      ladderReset: new Blocker(),
      ladderResume: new Blocker(),
    },
    reload: { total: 0, failures: 0, successes: 0, last: null, lastFailure: null, examples: [] },
    furnaceReady: 0,
    milestones: [],
    actions: [], // last N ACTION records
    positions: [], // last N {t,x,y,z} from ACTION+HEARTBEAT
    inventory: [], // last N {t, hash, items}
    decisions: [], // merged, newest last (filled by pushDecision)
    decisionRings: { PLAN: [], ADVISOR: [], JEV_HEADS: [], BETA_SHADOW: [], CAUSAL: [] },
    knownResources: new Map(), // item -> latest {kind, at|target, dist, t}
    errors: [],
  }
  const ABANDON_CAP = 4000
  let abstained = 0

  for (const raw of lines) {
    if (!raw) continue
    const m = tsRe.exec(raw)
    const ts = m ? Date.parse(m[1]) : out.lastTs
    const body = (m ? raw.slice(m[0].length) : raw).trim()
    if (!body) continue
    if (ts !== null) out.lastTs = ts
    if (ts !== null && ts < cutoff) continue
    out.parsedLines++
    let g
    if ((g = /^ACTION n=(\d+) id=(\S+) kind=(\S+) phase=(\S+) pos=([-\d.]+),([-\d.]+),([-\d.]+) rung=(\S+)/.exec(body))) {
      const rec = {
        t: ts,
        n: Number(g[1]),
        id: g[2],
        kind: g[3],
        phase: g[4],
        x: Number(g[5]),
        y: Number(g[6]),
        z: Number(g[7]),
        rung: g[8],
      }
      pushRing(out.actions, rec, ABANDON_CAP)
      pushRing(out.positions, { t: ts, x: rec.x, y: rec.y, z: rec.z }, ABANDON_CAP)
    } else if ((g = /^HEARTBEAT pos=([-\d.]+),([-\d.]+),([-\d.]+) health=(\d+) running=(\w+) rung=(\S+) queue=(.*) depth=(\d+) done=(\d+) action=(\S+) inv=(\{.*\})$/.exec(body))) {
      pushRing(out.positions, { t: ts, x: Number(g[1]), y: Number(g[2]), z: Number(g[3]) }, ABANDON_CAP)
      pushRing(out.inventory, { t: ts, hash: hashItems(g[11]), items: g[11] }, 2000)
    } else if ((g = /^INVENTORY items=(\{.*\}) pos=([-\d.]+),([-\d.]+),([-\d.]+)/.exec(body))) {
      pushRing(out.inventory, { t: ts, hash: hashItems(g[1]), items: g[1] }, 2000)
    } else if ((g = /^JEV_HEADS action=(\S+) abandon=(\d+) decision=(\S+)/.exec(body))) {
      const [action, abandon, decision] = [g[1], g[2], g[3]]
      if (abandon === '1') {
        let b = out.blockers.abandoned.get(action)
        if (!b) {
          b = new Blocker()
          out.blockers.abandoned.set(action, b)
        }
        b.add(ts, body)
        abstained++
      }
      pushDecision(out, 'JEV_HEADS', ts, `action=${action} abandon=${abandon} decision=${decision}`)
    } else if ((g = /^REPLAN_THROTTLED reason=(\S+) ageMs=(\d+) stateHash=(\S+) because=(\S+)/.exec(body))) {
      out.blockers.replanThrottled.add(ts, body, { reason: g[1], because: g[4] })
    } else if ((g = /^REPLAN_REJECTED reason=(\S+) requested=(\S+) current=(\S+)/.exec(body))) {
      out.blockers.replanRejected.add(ts, body, { reason: g[1], requested: g[2], current: g[3] })
    } else if ((g = /^WAIT_LIMIT n=(\d+) strategy=(\S+)/.exec(body))) {
      out.blockers.waitLimit.add(ts, body, { n: Number(g[1]), strategy: g[2] })
    } else if ((g = /^PRECONDITION_MISSING goal=(.*?) need=(.*?) rungId=(\S+)/.exec(body))) {
      out.blockers.preconditionMissing.add(ts, body, { goal: g[1], need: g[2], rungId: g[3] })
    } else if ((g = /^LADDER_PREREQ goal=(.*?) need=(.*?) rungId=(\S+)/.exec(body))) {
      out.blockers.ladderPrereq.add(ts, body, { goal: g[1], need: g[2], rungId: g[3] })
    } else if (/^MOVE_UNREACHABLE\b/.test(body)) {
      out.blockers.moveUnreachable.add(ts, body)
    } else if ((g = /^RETRIEVE_STALLED target=(\{[^}]*\}) dist=(\d+) ticks=(\d+)/.exec(body))) {
      out.blockers.retrieveStalled.add(ts, body, { target: g[1], dist: Number(g[2]), ticks: Number(g[3]) })
    } else if ((g = /^DESCEND_STALLED y=([-\d.]+) targetY=([-\d.]+) stallTicks=(\d+) hasDescendCandidate=(\w+)/.exec(body))) {
      out.blockers.descendStalled.add(ts, body, { y: Number(g[1]), targetY: Number(g[2]) })
    } else if (/^DIG_OSCILLATE\b/.test(body)) {
      out.blockers.digOscillate.add(ts, body)
    } else if ((g = /^MOVE_OSCILLATE actionId=(\S+) region=(\S+)/.exec(body))) {
      out.blockers.moveOscillate.add(ts, body, { actionId: g[1], region: g[2] })
    } else if ((g = /^RELOAD ok=(\w+) trigger=(\S+) ms=(\d+) ?(.*)$/.exec(body))) {
      const ok = g[1] === 'true'
      const tail = g[4] || ''
      const rec = {
        t: ts,
        ok,
        trigger: g[2],
        ms: Number(g[3]),
        hash: (/hash=(\S+)/.exec(tail) || [])[1] || null,
        id: (/id=(\S+)/.exec(tail) || [])[1] || null,
        generations: num((/generations=(\d+)/.exec(tail) || [])[1]),
        message: (/message=(.*)$/.exec(tail) || [])[1] || null,
      }
      out.reload.total++
      if (ok) out.reload.successes++
      else {
        out.reload.failures++
        out.reload.lastFailure = { t: ts, message: rec.message }
      }
      out.reload.last = { t: ts, ok, hash: rec.hash, id: rec.id, message: rec.message }
      pushRing(out.reload.examples, rec, 20)
    } else if ((g = /^LADDER_RESET reason=(\S+)(.*)$/.exec(body))) {
      const rung = (/rungId=(\S+)/.exec(g[2]) || [])[1] || null
      out.blockers.ladderReset.add(ts, body, { reason: g[1], rung })
    } else if ((g = /^LADDER_RESUME rung=(\S+) rungIndex=(\d+) reason=(\S+)/.exec(body))) {
      out.blockers.ladderResume.add(ts, body, { rung: g[1], rungIndex: Number(g[2]), reason: g[3] })
    } else if ((g = /^PLAN source=(\S+) goals=(\[.*?\]) cost=(\d+) ms=(\d+) reason=(\S+) rung=(\S+)/.exec(body))) {
      pushDecision(out, 'PLAN', ts, `source=${g[1]} reason=${g[5]} rung=${g[6]} goals=${g[2]}`)
    } else if ((g = /^ADVISOR source=(\S+) reason=(\S+) strategy=(\S+)/.exec(body))) {
      pushDecision(out, 'ADVISOR', ts, `source=${g[1]} reason=${g[2]} strategy=${g[3]}`)
    } else if ((g = /^BETA_SHADOW optionId=(\S+) beta=([\d.]+) threshold=([\d.]+) would=(\S+) actual=(\S+) agree=(\w+)/.exec(body))) {
      pushDecision(out, 'BETA_SHADOW', ts, `optionId=${g[1]} beta=${g[2]} would=${g[4]} actual=${g[5]} agree=${g[6]}`)
    } else if ((g = /^CAUSAL record=causal chainId=(\S+) optionId=(\S+) planId=(\S+) strategy=(\S+) candidateId=(\S+) actionId=(\S+) verified=(\w+) status=(\S+) resource=(\S+) progressDelta=([-\d.]+)/.exec(body))) {
      pushDecision(out, 'CAUSAL', ts, `optionId=${g[2]} candidateId=${g[5]} verified=${g[7]} status=${g[8]} progressDelta=${g[10]}`)
    } else if ((g = /^KNOWN_RESOURCE item=(\S+) name=(\S+) target=([-\d.]+),([-\d.]+),([-\d.]+) dist=(\d+)/.exec(body))) {
      upsertResource(out.knownResources, g[1], { kind: classifyResource(g[1]), name: g[2], target: `${g[3]},${g[4]},${g[5]}`, dist: Number(g[6]), t: ts })
    } else if ((g = /^RETURN_TO_KNOWN_RESOURCE item=(\S+) name=(\S+) target=([-\d.]+),([-\d.]+),([-\d.]+) dist=(\d+)/.exec(body))) {
      upsertResource(out.knownResources, g[1], { kind: classifyResource(g[1]), name: g[2], target: `${g[3]},${g[4]},${g[5]}`, dist: Number(g[6]), t: ts })
    } else if ((g = /^KNOWN_RESOURCE item=(\S+) kind=(\S+) at=([-\d.]+),([-\d.]+),([-\d.]+)/.exec(body))) {
      upsertResource(out.knownResources, g[1], { kind: g[2] === 'ore' || /ore$/i.test(g[1]) ? 'ore' : 'resource', name: g[1], target: `${g[3]},${g[4]},${g[5]}`, dist: null, t: ts })
    } else if ((g = /^MILESTONE name=(\S+) done=(\w+)/.exec(body))) {
      pushRing(out.milestones, { t: ts, name: g[1], done: g[2] === 'true' }, 40)
    }
    if (body.includes('FURNACE_READY')) out.furnaceReady++
    if (/^ERROR\b/.test(body)) pushRing(out.errors, { t: ts, text: body }, 20)
  }

  out.abstainedDecisions = abstained
  return out
}

const STATION_RE = /(furnace|crafting_table|chest|barrel|smithing_table|anvil|blast_furnace|smoker|torch|bed|door|trapdoor)/i
export function classifyResource(item) {
  if (/ore$/i.test(item)) return 'ore'
  if (STATION_RE.test(item)) return 'station'
  return 'resource'
}

function upsertResource(map, item, rec) {
  const prev = map.get(item)
  // prefer latest timestamp; keep ore coordinates fresh, keep stations too
  if (!prev || (rec.t ?? 0) >= (prev.t ?? 0)) map.set(item, { item, ...rec })
}

export function hashItems(json) {
  // order-insensitive small hash of an inventory object literal
  try {
    const o = JSON.parse(json)
    const keys = Object.keys(o).sort()
    return keys.map((k) => `${k}:${o[k]}`).join('|')
  } catch {
    return String(json)
  }
}

// ── stuck heuristics ───────────────────────────────────────────────────────
export function analyzeStuck(parsed, { windowMin = STUCK.windowMin, reportData = null, thresholds = STUCK } = {}) {
  const anchor = parsed.anchorMs
  const cut = anchor - windowMin * 60000
  const positions = parsed.positions.filter((p) => p.t !== null && p.t >= cut)
  let bbox = null
  if (positions.length >= 2) {
    const xs = positions.map((p) => p.x)
    const ys = positions.map((p) => p.y)
    const zs = positions.map((p) => p.z)
    const dx = Math.max(...xs) - Math.min(...xs)
    const dy = Math.max(...ys) - Math.min(...ys)
    const dz = Math.max(...zs) - Math.min(...zs)
    bbox = { samples: positions.length, dx, dy, dz, span: Math.sqrt(dx * dx + dy * dy + dz * dz), last: positions[positions.length - 1] }
  }

  const currentId = reportData?.status?.currentAction?.id ?? null
  const actionsInWindow = parsed.actions.filter((a) => a.t !== null && a.t >= cut)
  const counts = new Map()
  for (const a of actionsInWindow) counts.set(a.id, (counts.get(a.id) || 0) + 1)
  let repeatedId = currentId
  let repeatedCount = currentId ? counts.get(currentId) || 0 : 0
  if (!currentId) {
    for (const [id, c] of counts) if (c > repeatedCount) ((repeatedId = id), (repeatedCount = c))
  }

  // abandoned decisions in window
  let abandonTotal = 0
  const abandonByAction = new Map()
  for (const [action, b] of parsed.blockers.abandoned) {
    let c = 0
    let last = null
    for (const ex of b.examples) {
      if (ex.ts !== null && ex.ts >= cut) {
        c++
        last = ex.ts
      }
    }
    // examples only retain the last 10; fall back to recomputing precisely is
    // not possible from a bounded buffer, so use retained window samples.
    if (c > 0) {
      abandonTotal += c
      abandonByAction.set(action, { count: c, last })
    }
  }
  let topAbandon = null
  for (const [action, v] of abandonByAction) if (!topAbandon || v.count > topAbandon.count) topAbandon = { action, ...v }
  // live counters are exact for the whole log, so prefer them when larger
  const allAbandonTotal = parsed.abstainedDecisions

  // last inventory change
  const inv = parsed.inventory
  let invInfo = null
  if (inv.length) {
    const cur = inv[inv.length - 1]
    let changeTs = inv[0].t
    for (let i = inv.length - 2; i >= 0; i--) {
      if (inv[i].hash !== cur.hash) {
        changeTs = inv[i + 1].t
        break
      }
    }
    const unchangedSec = cur.t !== null && changeTs !== null ? Math.max(0, Math.round((cur.t - changeTs) / 1000)) : null
    let itemCount = 0
    try {
      itemCount = Object.keys(JSON.parse(cur.items)).length
    } catch {}
    invInfo = { itemCount, unchangedSec, lastChangeTs: changeTs, hash: cur.hash }
  }

  const pinned = bbox ? bbox.span < thresholds.moveBlocks : null
  const repeated = repeatedCount >= thresholds.repeatCount
  const staleInv = invInfo !== null && invInfo.unchangedSec !== null && invInfo.unchangedSec >= thresholds.invChangeMin * 60
  const abandoning = abandonTotal >= thresholds.abandonMin || (!!topAbandon && topAbandon.count >= thresholds.abandonMin)

  const signals = []
  if (pinned) signals.push(`position pinned (${bbox.span.toFixed(1)} blocks span in ${windowMin}m)`)
  if (repeated) signals.push(`same action repeated ${repeatedCount}x`)
  if (staleInv) signals.push(`no inventory change ${fmtDur(invInfo.unchangedSec)}`)
  if (abandoning) signals.push(`abandoned decisions (${abandonTotal} in window; total ${allAbandonTotal})`)

  const stuck = signals.length >= 2 || (pinned && repeated)
  let verdict
  if (stuck) {
    const focus = currentId || repeatedId || topAbandon?.action || 'unknown action'
    const bits = []
    if (repeated) bits.push(`repeated ${repeatedCount}x`)
    if (pinned) bits.push(`moved ${bbox.span.toFixed(1)} blocks in ${windowMin}m`)
    if (staleInv) bits.push(`no inventory change ${fmtDur(invInfo.unchangedSec)}`)
    if (abandonTotal > 0) bits.push(`${topAbandon ? topAbandon.action : 'action'} abandoned ${topAbandon ? topAbandon.count : abandonTotal}x in window`)
    verdict = `VERDICT: stuck at ${focus} (${bits.join(', ') || 'blocked with no progress'})`
  } else {
    const bits = []
    if (bbox) bits.push(`moved ${bbox.span.toFixed(1)} blocks in ${windowMin}m`)
    if (invInfo !== null && invInfo.unchangedSec !== null) bits.push(`inventory unchanged ${fmtDur(invInfo.unchangedSec)}`)
    bits.push(`${allAbandonTotal} abandons total`)
    verdict = `VERDICT: ${bbox && bbox.span >= thresholds.moveBlocks ? 'making progress' : 'no strong stuck signal'} (${bits.join(', ')})`
  }

  return {
    windowMin,
    thresholds: { moveBlocks: thresholds.moveBlocks, repeatCount: thresholds.repeatCount, invChangeMin: thresholds.invChangeMin, abandonMin: thresholds.abandonMin },
    bbox,
    repeatedAction: { id: repeatedId, count: repeatedCount },
    abandonInWindow: { total: abandonTotal, top: topAbandon, allTimeTotal: allAbandonTotal },
    inventory: invInfo,
    pinned,
    repeated,
    staleInv,
    abandoning,
    stuck,
    signals,
    verdict,
  }
}

// ── assemble full report ───────────────────────────────────────────────────
export function buildReport(parsed, socketRes, opts, extras = {}) {
  const d = socketRes?.ok ? socketRes.data : null
  const state = extras.state || null
  const reload = parsed.reload
  const abandonedList = [...parsed.blockers.abandoned.entries()]
    .map(([action, b]) => ({ action, count: b.count, lastTs: b.lastTs, examples: b.examples.slice(-3) }))
    .sort((a, b) => b.count - a.count)

  const identity = {
    runId: d?.runId ?? null,
    pids: extras.pids || [],
    hostLockPid: d?.hostLock?.filePid ?? null,
    singleInstance: d?.hostLock?.singleInstance ?? null,
    connected: d?.connected ?? null,
    frozen: d?.frozen ?? null,
    username: d?.username ?? state?.bot ?? null,
    serverId: d?.worldKey?.serverId ?? state?.serverId ?? null,
    dimension: d?.worldKey?.dimension ?? state?.dimension ?? null,
    worldEpoch: d?.worldKey?.worldEpoch ?? state?.worldEpoch ?? null,
    generationId: d?.generationId ?? state?.lastGenerationId ?? null,
    generationHash: d?.generationHash ?? null,
    contractVersion: d?.contractVersion ?? null,
    generations: d?.generations ?? state?.generations ?? null,
    reloads: d?.reloads ?? state?.reloads ?? null,
    reloadsChangedHash: d?.stats?.reloadsChangedHash ?? null,
    reloadsFailed: d?.stats?.reloadsFailed ?? null,
    recoveries: d?.recoveries ?? state?.recoveries ?? null,
    reconnects: d?.stats?.reconnects ?? d?.reconnect?.reconnects ?? null,
    reconnectsLastHour: d?.stats?.reconnectsLastHour ?? d?.reconnect?.reconnectsLastHour ?? null,
    reconnectReasons: d?.stats?.reconnectReasons ?? d?.reconnect?.reconnectReasons ?? null,
    wedge: d?.stats?.wedge ?? null,
    goalComplete: d?.stats?.goalComplete ?? null,
    lease: d?.lease ?? null,
    listenerLeak: d?.listenerLeak ?? null,
    policyKind: d?.status?.policyKind ?? null,
    policyModel: d?.status?.policyModel ?? null,
    system2Model: d?.status?.system2Model ?? null,
  }

  let rungTime = null
  const acts = parsed.actions
  if (acts.length) {
    const lastRung = acts[acts.length - 1].rung
    let start = acts[acts.length - 1].t
    for (let i = acts.length - 1; i >= 0; i--) {
      if (acts[i].rung !== lastRung) break
      start = acts[i].t
    }
    if (start !== null && acts[acts.length - 1].t !== null) rungTime = { rung: lastRung, sec: Math.round((acts[acts.length - 1].t - start) / 1000) }
  }

  const q = d?.status?.queue
  const mission = {
    milestone: d?.milestone ?? state?.milestone ?? null,
    milestoneIndex: state?.milestoneIndex ?? null,
    rungId: d?.status?.rungId ?? null,
    rungIndex: d?.status?.rungIndex ?? null,
    ledgerDepth: q?.depth ?? null,
    subgoalsDone: q?.done ?? null,
    plannedGoals: d?.status?.plannedGoals ?? null,
    ready: d?.status?.ready ?? null,
    queueEmpty: q?.empty ?? null,
    hasImpossible: q?.hasImpossible ?? null,
    currentGoal: q?.current ?? null,
    nextGoals: (q?.goals || []).filter((x) => x.status !== 'active').slice(0, 6).map((x) => ({ id: x.id, description: x.description, status: x.status, origin: x.origin })),
    goals: q?.goals ?? [],
    timeInRung: rungTime,
  }

  const truth = d?.status?.truth
  const recentActions = dedupeRuns(acts, 10)
  const liveCurrent = d?.status?.currentAction
  const lastRun = recentActions[0] || null
  const action = {
    current: liveCurrent
      ? { ...liveCurrent, pos: truth?.position ?? parsed.positions.at(-1) ?? null, derived: false }
      : lastRun
        ? { id: lastRun.id, kind: lastRun.kind, phase: lastRun.phase, startedAt: lastRun.firstTs, pos: lastRun.pos, derived: true }
        : null,
    position: truth?.position ?? parsed.positions.at(-1) ?? null,
    health: truth?.health ?? null,
    food: truth?.food ?? null,
    onGround: truth?.onGround ?? null,
    recent: recentActions,
  }

  const blockers = {
    abandoned: { total: parsed.abstainedDecisions, byAction: abandonedList },
    replanThrottled: parsed.blockers.replanThrottled.toJSON(),
    replanRejected: parsed.blockers.replanRejected.toJSON(),
    waitLimit: parsed.blockers.waitLimit.toJSON(),
    preconditionMissing: parsed.blockers.preconditionMissing.toJSON(),
    ladderPrereq: parsed.blockers.ladderPrereq.toJSON(),
    moveUnreachable: parsed.blockers.moveUnreachable.toJSON(),
    retrieveStalled: parsed.blockers.retrieveStalled.toJSON(),
    descendStalled: parsed.blockers.descendStalled.toJSON(),
    digOscillate: parsed.blockers.digOscillate.toJSON(),
    moveOscillate: parsed.blockers.moveOscillate.toJSON(),
    ladderReset: parsed.blockers.ladderReset.toJSON(),
    ladderResume: parsed.blockers.ladderResume.toJSON(),
    reload: {
      total: reload.total,
      successes: reload.successes,
      failures: reload.failures,
      last: reload.last,
      lastFailure: reload.lastFailure,
      lastOk: reload.last ? reload.last.ok : null,
    },
    furnaceReady: { markerCount: parsed.furnaceReady, ready: parsed.furnaceReady > 0 ? true : parsed.furnaceReady === 0 ? false : null },
  }

  const stuck = analyzeStuck(parsed, { windowMin: opts.sinceMin ?? STUCK.windowMin, reportData: d, thresholds: STUCK })

  const inv = truth?.inventory ? Object.entries(truth.inventory) : []
  const stations = {
    furnaces: d?.worldMemory?.furnaces ?? null,
    craftingTables: d?.worldMemory?.craftingTables ?? null,
    furnaceStations: [],
  }
  const knownResources = [...parsed.knownResources.values()]
    .filter((r) => r.kind === 'ore' || r.kind === 'station')
    .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
    .slice(0, opts.full || opts.json ? 999 : 24)

  const resources = {
    inventory: truth?.inventory ?? null,
    inventoryList: inv.map(([item, count]) => ({ item, count })),
    highlights: inventoryHighlights(truth?.inventory),
    worldMemory: d?.worldMemory ?? null,
    knownResources,
  }

  const perKind = Object.values(parsed.decisionRings).flat().sort((x, y) => (x.t ?? 0) - (y.t ?? 0))
  const decisions = perKind.slice(opts.full || opts.json ? -50 : -12)

  return {
    generatedAt: new Date().toISOString(),
    anchorAt: new Date(parsed.anchorMs).toISOString(),
    source: {
      logPath: parsed.logPath,
      logLines: parsed.totalLines,
      parsedLines: parsed.parsedLines,
      logAgeSec: extras.logAgeSec ?? null,
      socketPath: opts.noSocket ? null : opts.sock,
      socketOk: !!socketRes?.ok,
      socketError: socketRes?.ok ? null : socketRes?.error ?? null,
      reportFile: opts.reportFile ?? null,
      sinceMin: opts.sinceMin,
    },
    identity,
    mission,
    action,
    blockers,
    stuck,
    resources,
    decisions: {
      recent: decisions,
    },
    milestones: parsed.milestones.slice(-8),
    errors: parsed.errors.slice(-5),
  }
}

function dedupeRuns(actions, max) {
  const out = []
  for (let i = actions.length - 1; i >= 0 && out.length < max; i--) {
    const a = actions[i]
    const prev = out[out.length - 1]
    if (prev && prev.id === a.id) {
      prev.count++
      prev.firstTs = a.t
      continue
    }
    out.push({ id: a.id, kind: a.kind, phase: a.phase, rung: a.rung, pos: `${a.x},${a.y},${a.z}`, lastTs: a.t, firstTs: a.t, count: 1 })
  }
  return out
}

function inventoryHighlights(inventory) {
  if (!inventory) return null
  const pick = (re) => Object.entries(inventory).filter(([k]) => re.test(k)).map(([k, v]) => `${k}=${v}`)
  return {
    tools: pick(/(pickaxe|axe|shovel|sword|hoe)$/),
    ores: pick(/(raw_iron|raw_copper|raw_gold|iron_ingot|coal|diamond|redstone|lapis|gold_ingot|copper_ingot)$/),
    fuel: pick(/^(coal|charcoal|oak_planks|stick|birch_planks|oak_log|birch_log|blaze_rod)$/),
    stations: pick(/(furnace|crafting_table|chest|torch)$/),
    food: pick(/(bread|apple|beef|porkchop|chicken|cod|salmon|carrot|potato)$/),
    blocks: pick(/(cobblestone|dirt|stone|andesite|diorite|granite|oak_planks)$/),
  }
}

// ── formatting ─────────────────────────────────────────────────────────────
export function fmtDur(sec) {
  if (sec === null || sec === undefined) return 'n/a'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return `${h}h${m}m`
}

function fmtClock(ms) {
  if (ms === null || ms === undefined) return '--:--:--'
  try {
    return new Date(ms).toISOString().slice(11, 19)
  } catch {
    return '--:--:--'
  }
}

const trunc = (s, n = 100) => {
  const x = String(s ?? '')
  return x.length > n ? x.slice(0, n - 1) + '…' : x
}

class Budget {
  constructor(max, full) {
    this.max = max
    this.full = full
    this.lines = []
    this.suppressed = 0
  }
  push(s) {
    if (this.full || this.lines.length < this.max) this.lines.push(s)
    else this.suppressed++
  }
  pushAll(arr) {
    for (const l of arr) this.push(l)
  }
  render() {
    if (this.suppressed > 0) this.lines.push(`... (${this.suppressed} more lines suppressed; use --full)`)
    return this.lines.join('\n')
  }
}

function blockerLine(name, b, extra = '') {
  if (!b || b.count === 0) return `  ${name.padEnd(20)} 0  (not observed)`
  const ex = b.examples?.[b.examples.length - 1]?.text
  return `  ${name.padEnd(20)} ${String(b.count).padEnd(7)} last ${fmtClock(b.lastTs)}${extra ? '  ' + extra : ''}${ex ? `\n      e.g. ${trunc(ex, 130)}` : ''}`
}

export function formatWhy(report) {
  const b = new Budget(MAX_LINES, false)
  const s = report.stuck
  const bl = report.blockers
  b.push('== BLOCKERS / VERDICT ==')
  b.push('-- Blockers --')
  const ab = bl.abandoned
  if (ab.total > 0) {
    b.push(`   abandoned options (JEV_HEADS abandon=1 decision=replan): ${ab.total} total, ${ab.byAction.length} distinct actions`)
    for (const a of ab.byAction.slice(0, 6)) b.push(`   ${String(a.count).padEnd(7)} ${a.action}  last ${fmtClock(a.lastTs)}`)
  } else b.push('   abandoned options: 0 (not observed)')
  b.push(blockerLine('REPLAN_THROTTLED', bl.replanThrottled, bl.replanThrottled.count ? `reason=${bl.replanThrottled.examples.at(-1)?.reason ?? '?'} because=${bl.replanThrottled.examples.at(-1)?.because ?? '?'}` : ''))
  b.push(blockerLine('REPLAN_REJECTED', bl.replanRejected, bl.replanRejected.count ? `reason=${bl.replanRejected.examples.at(-1)?.reason ?? '?'}` : ''))
  b.push(blockerLine('WAIT_LIMIT', bl.waitLimit, bl.waitLimit.count ? `n=${bl.waitLimit.examples.at(-1)?.n ?? '?'} strategy=${bl.waitLimit.examples.at(-1)?.strategy ?? '?'}` : ''))
  b.push(blockerLine('PRECONDITION_MISSING', bl.preconditionMissing, bl.preconditionMissing.count ? `need=${bl.preconditionMissing.examples.at(-1)?.need ?? '?'}` : ''))
  b.push(blockerLine('LADDER_PREREQ', bl.ladderPrereq, bl.ladderPrereq.count ? `need=${bl.ladderPrereq.examples.at(-1)?.need ?? '?'}` : ''))
  b.push(blockerLine('MOVE_UNREACHABLE', bl.moveUnreachable))
  b.push(blockerLine('RETRIEVE_STALLED', bl.retrieveStalled, bl.retrieveStalled.count ? `dist=${bl.retrieveStalled.examples.at(-1)?.dist ?? '?'}` : ''))
  b.push(blockerLine('DESCEND_STALLED', bl.descendStalled, bl.descendStalled.count ? `targetY=${bl.descendStalled.examples.at(-1)?.targetY ?? '?'}` : ''))
  b.push(blockerLine('DIG_OSCILLATE', bl.digOscillate))
  b.push(blockerLine('MOVE_OSCILLATE', bl.moveOscillate, bl.moveOscillate.count ? `actionId=${bl.moveOscillate.examples.at(-1)?.actionId ?? '?'}` : ''))
  b.push(`  ${'RELOAD'.padEnd(20)} last ok=${bl.reload.lastOk} hash=${bl.reload.last?.hash ?? '?'} failures=${bl.reload.failures}/${bl.reload.total}${bl.reload.lastFailure ? ` lastFail="${trunc(bl.reload.lastFailure.message, 60)}"` : ''}`)
  b.push(blockerLine('LADDER_RESET', bl.ladderReset, bl.ladderReset.count ? `reason=${bl.ladderReset.examples.at(-1)?.reason ?? '?'} rung=${bl.ladderReset.examples.at(-1)?.rung ?? '-'}` : ''))
  b.push(blockerLine('LADDER_RESUME', bl.ladderResume, bl.ladderResume.count ? `rung=${bl.ladderResume.examples.at(-1)?.rung ?? '?'}` : ''))
  b.push(`  ${'FURNACE_READY'.padEnd(20)} ${bl.furnaceReady.markerCount}${bl.furnaceReady.markerCount === 0 ? '  (not observed)' : ''}   worldMemory.furnaces=${report.resources.worldMemory?.furnaces ?? '?'}`)
  b.push('-- Stuck heuristics --')
  b.push(`   window=${s.windowMin}m  position span=${s.bbox ? s.bbox.span.toFixed(2) + ' blocks' : 'n/a'} (threshold ${s.thresholds.moveBlocks})  pinned=${s.pinned}`)
  b.push(`   repeated=${s.repeatedAction.id ?? 'n/a'} x${s.repeatedAction.count}  abandonInWindow=${s.abandonInWindow.total} top=${s.abandonInWindow.top?.action ?? 'n/a'}x${s.abandonInWindow.top?.count ?? 0}`)
  b.push(`   inventory unchanged=${fmtDur(s.inventory?.unchangedSec)}  invItems=${s.inventory?.itemCount ?? '?'}`)
  b.push(`   signals=[${s.signals.join('; ')}]`)
  b.push('')
  b.push('  ' + s.verdict)
  return b.render()
}

export function formatHuman(report, { full = false } = {}) {
  const b = new Budget(MAX_LINES, full)
  const id = report.identity
  const m = report.mission
  const a = report.action
  const bl = report.blockers
  const s = report.stuck
  const r = report.resources

  b.push(`== AI_Buddy agent report  ${report.generatedAt} ==`)
  b.push(`   source: log=${report.source.logPath} (${report.source.logLines} lines, age ${fmtDur(report.source.logAgeSec)})  socket=${report.source.socketOk ? 'ok' : 'DOWN(' + (report.source.socketError || '?') + ')'}${report.source.reportFile ? '  reportFile=' + report.source.reportFile : ''}${report.source.sinceMin ? '  since=' + report.source.sinceMin + 'm' : ''}`)
  b.push(`   anchor=${report.anchorAt}  (stuck heuristics window = ${s.windowMin}m)`)
  b.push('')
  b.push('-- 1. Identity / connection --')
  b.push(`   runId         ${id.runId ?? '(none)'}`)
  b.push(`   pids          ${id.pids.length ? id.pids.join(',') : '(none found)'}  hostLockPid=${id.hostLockPid ?? '?'} singleInstance=${id.singleInstance}`)
  b.push(`   connected     ${id.connected}  frozen=${id.frozen}  wedge=${id.wedge}  goalComplete=${id.goalComplete}`)
  b.push(`   username      ${id.username ?? '(unknown)'}`)
  b.push(`   world         ${id.serverId ?? '?'}  ${id.dimension ?? '?'}  worldEpoch=${id.worldEpoch ?? '?'}`)
  b.push(`   generation    ${id.generationId ?? '(none)'}  hash=${id.generationHash ?? '?'}  contract=v${id.contractVersion ?? '?'}`)
  b.push(`   counts        generations=${id.generations} reloads=${id.reloads} (hashChanged=${id.reloadsChangedHash} failed=${id.reloadsFailed}) recoveries=${id.recoveries} reconnects=${id.reconnects} (lastHour=${id.reconnectsLastHour})`)
  b.push(`   lease         active=${id.lease?.activeId || '(none)'} acq=${id.lease?.acquisitions ?? '?'} rev=${id.lease?.revocations ?? '?'}`)
  b.push(`   listenerLeak  ${id.listenerLeak}${id.listenerLeak ? '  (!!)' : ''}   policy=${id.policyKind ?? '?'}`)
  b.push('')
  b.push('-- 2. Mission / progress --')
  b.push(`   milestone     ${m.milestone ?? '(none)'}${m.milestoneIndex !== null ? ` (index ${m.milestoneIndex})` : ''}`)
  b.push(`   rung          ${m.rungId ?? '(none)'}${m.rungIndex !== null ? ` (rungIndex ${m.rungIndex})` : ''}   time in rung=${fmtDur(m.timeInRung?.sec)}`)
  b.push(`   ledger        depth=${m.ledgerDepth} done=${m.subgoalsDone} plannedGoals=${m.plannedGoals} ready=${m.ready} hasImpossible=${m.hasImpossible}`)
  b.push(`   queue head    ${m.currentGoal ? trunc(m.currentGoal.description, 70) + ' [' + m.currentGoal.status + ']' : '(empty)'}`)
  if (m.nextGoals.length) b.push(`   next goals    ${m.nextGoals.map((g) => trunc(g.description, 34)).join(' | ')}`)
  b.push('')
  b.push('-- 3. Current action --')
  if (a.current) b.push(`   now           ${a.current.id} kind=${a.current.kind} phase=${a.current.phase}`)
  else b.push('   now           (no current action reported)')
  if (a.position) b.push(`   position      ${a.position.x.toFixed(2)},${a.position.y.toFixed(2)},${a.position.z.toFixed(2)}  health=${a.health} food=${a.food} onGround=${a.onGround}`)
  b.push('   recent ACTION runs (deduped):')
  if (!a.recent.length) b.push('     (none in window)')
  for (const run of a.recent) b.push(`     x${String(run.count).padEnd(4)} ${trunc(run.id, 46).padEnd(46)} ${run.phase.padEnd(12)} ${fmtClock(run.lastTs)}`)
  b.push('')
  b.push('-- 4. Blockers --')
  if (bl.abandoned.total > 0) {
    b.push(`   abandoned options: ${bl.abandoned.total} total across ${bl.abandoned.byAction.length} actions`)
    for (const x of bl.abandoned.byAction.slice(0, full ? 50 : 6)) b.push(`     ${String(x.count).padEnd(7)} ${trunc(x.action, 46)}  last ${fmtClock(x.lastTs)}`)
  } else b.push('   abandoned options: 0 (not observed)')
  b.push(blockerLine('REPLAN_THROTTLED', bl.replanThrottled, bl.replanThrottled.count ? `reason=${bl.replanThrottled.examples.at(-1)?.reason} because=${bl.replanThrottled.examples.at(-1)?.because}` : ''))
  b.push(blockerLine('REPLAN_REJECTED', bl.replanRejected, bl.replanRejected.count ? `reason=${bl.replanRejected.examples.at(-1)?.reason} requested=${bl.replanRejected.examples.at(-1)?.requested} current=${bl.replanRejected.examples.at(-1)?.current}` : ''))
  b.push(blockerLine('WAIT_LIMIT', bl.waitLimit, bl.waitLimit.count ? `n=${bl.waitLimit.examples.at(-1)?.n} strategy=${bl.waitLimit.examples.at(-1)?.strategy}` : ''))
  b.push(blockerLine('PRECONDITION_MISSING', bl.preconditionMissing, bl.preconditionMissing.count ? `need=${bl.preconditionMissing.examples.at(-1)?.need}` : ''))
  b.push(blockerLine('LADDER_PREREQ', bl.ladderPrereq, bl.ladderPrereq.count ? `need=${bl.ladderPrereq.examples.at(-1)?.need}` : ''))
  b.push(blockerLine('MOVE_UNREACHABLE', bl.moveUnreachable))
  b.push(blockerLine('RETRIEVE_STALLED', bl.retrieveStalled, bl.retrieveStalled.count ? `target=${bl.retrieveStalled.examples.at(-1)?.target} dist=${bl.retrieveStalled.examples.at(-1)?.dist}` : ''))
  b.push(blockerLine('DESCEND_STALLED', bl.descendStalled, bl.descendStalled.count ? `y=${bl.descendStalled.examples.at(-1)?.y} targetY=${bl.descendStalled.examples.at(-1)?.targetY}` : ''))
  b.push(blockerLine('DIG_OSCILLATE', bl.digOscillate))
  b.push(blockerLine('MOVE_OSCILLATE', bl.moveOscillate, bl.moveOscillate.count ? `actionId=${bl.moveOscillate.examples.at(-1)?.actionId} region=${bl.moveOscillate.examples.at(-1)?.region}` : ''))
  b.push(`   ${'RELOAD'.padEnd(20)} last ok=${bl.reload.lastOk} hash=${bl.reload.last?.hash ?? '?'} gen=${bl.reload.last?.id ?? '?'} failures=${bl.reload.failures}/${bl.reload.total}${bl.reload.lastFailure ? `  lastFail@${fmtClock(bl.reload.lastFailure.t)} "${trunc(bl.reload.lastFailure.message, 70)}"` : ''}`)
  b.push(blockerLine('LADDER_RESET', bl.ladderReset, bl.ladderReset.count ? `reason=${bl.ladderReset.examples.at(-1)?.reason} rung=${bl.ladderReset.examples.at(-1)?.rung ?? '-'}` : ''))
  b.push(blockerLine('LADDER_RESUME', bl.ladderResume, bl.ladderResume.count ? `rung=${bl.ladderResume.examples.at(-1)?.rung} reason=${bl.ladderResume.examples.at(-1)?.reason}` : ''))
  b.push(`   ${'FURNACE_READY'.padEnd(20)} ${bl.furnaceReady.markerCount}${bl.furnaceReady.markerCount === 0 ? '  (marker not observed)' : ''}   worldMemory.furnaces=${r.worldMemory?.furnaces ?? '?'}`)
  if (bl.reload.lastFailure && full) b.push(`     reload failure e.g. ${trunc(bl.reload.lastFailure.message, 110)}`)
  b.push('')
  b.push('-- 5. Stuck heuristics --')
  b.push(`   window        ${s.windowMin}m`)
  b.push(`   position      ${s.bbox ? `span=${s.bbox.span.toFixed(2)} blocks (dx=${s.bbox.dx.toFixed(1)} dy=${s.bbox.dy.toFixed(1)} dz=${s.bbox.dz.toFixed(1)}, ${s.bbox.samples} samples)` : 'insufficient samples'}  threshold<${s.thresholds.moveBlocks} pinned=${s.pinned}`)
  b.push(`   repeated      ${s.repeatedAction.id ?? '(none)'} x${s.repeatedAction.count} (threshold ${s.thresholds.repeatCount}) repeated=${s.repeated}`)
  b.push(`   abandons      inWindow=${s.abandonInWindow.total} top=${s.abandonInWindow.top?.action ?? '(none)'} x${s.abandonInWindow.top?.count ?? 0}  allTime=${s.abandonInWindow.allTimeTotal}`)
  b.push(`   inventory     unchanged=${fmtDur(s.inventory?.unchangedSec)} items=${s.inventory?.itemCount ?? '?'} (threshold ${s.thresholds.invChangeMin}m) stale=${s.staleInv}`)
  b.push(`   signals       ${s.signals.length ? s.signals.join('; ') : '(none)'}`)
  b.push('')
  b.push('   ' + s.verdict)
  b.push('')
  b.push('-- 6. Resources / world --')
  b.push(`   inventory     ${r.inventoryList.length ? r.inventoryList.map((x) => `${x.item}=${x.count}`).join(' ') : '(empty/unknown)'}`)
  if (r.highlights) {
    for (const [k, v] of Object.entries(r.highlights)) if (v.length) b.push(`   ${k.padEnd(13)} ${v.join(' ')}`)
  }
  const wm = r.worldMemory
  if (wm) b.push(`   worldMemory   craftingTables=${wm.craftingTables} furnaces=${wm.furnaces} ores=[${(wm.discoveredOres || []).join(',')}] hazards=${wm.hazards}/${wm.hardHazards} traversalFailures=${wm.traversalFailures}`)
  const oreRes = r.knownResources.filter((x) => x.kind === 'ore')
  const stRes = r.knownResources.filter((x) => x.kind === 'station')
  if (oreRes.length) {
    b.push('   ore coords (latest from log):')
    for (const o of oreRes.slice(0, full ? 50 : 8)) b.push(`     ${o.item.padEnd(22)} @${o.target}  ${fmtClock(o.t)}`)
  }
  if (stRes.length) {
    b.push('   stations (latest from log):')
    for (const o of stRes.slice(0, full ? 50 : 6)) b.push(`     ${(o.name || o.item).padEnd(22)} @${o.target}${o.dist !== null ? ` dist=${o.dist}` : ''}  ${fmtClock(o.t)}`)
  }
  b.push('')
  b.push('-- 7. Recent decisions --')
  if (!report.decisions.recent.length) b.push('   (none in window)')
  for (const dec of report.decisions.recent) b.push(`   ${fmtClock(dec.t)} ${dec.kind.padEnd(11)} ${trunc(dec.text, 120)}`)
  return b.render()
}

// ── side inputs ────────────────────────────────────────────────────────────
function readJsonSafe(p) {
  try {
    if (!p || !existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function findHostPids() {
  try {
    const out = execFileSync('pgrep', ['-af', 'bun agent-runner.mts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out
      .split('\n')
      .filter((l) => /\d+\s+\S*bun\s+agent-runner\.mts/.test(l) && !/\bbash\b|\/bin\/sh\b/.test(l))
      .map((l) => l.trim().split(/\s+/)[0])
  } catch {
    return []
  }
}

async function collect(opts) {
  let logText = null
  let logAgeSec = null
  if (opts.log && existsSync(opts.log)) {
    logText = readFileSync(opts.log, 'utf8')
    try {
      logAgeSec = Math.round((Date.now() - statSync(opts.log).mtimeMs) / 1000)
    } catch {}
  } else if (opts.log && !opts.noSocket) {
    // default log missing: continue, socket may still work
  }
  let parsed
  try {
    parsed = parseLog(logText ?? '', { sinceMin: opts.sinceMin, logPath: opts.log })
  } catch (e) {
    const err = new Error(`unrecoverable parse failure: ${e?.message || e}`)
    err.fatal = true
    throw err
  }

  let socketRes = { ok: false, error: 'disabled' }
  let reportData = null
  if (opts.reportFile) {
    const rf = readJsonSafe(opts.reportFile)
    if (rf && rf.ok !== undefined && rf.data) {
      reportData = rf.data
      socketRes = { ok: true, data: rf.data }
    } else if (rf) {
      reportData = rf.data ?? rf
      socketRes = { ok: true, data: reportData }
    }
  } else if (!opts.noSocket) {
    socketRes = await socketReport(opts.sock)
  }
  const state = opts.reportFile ? null : readJsonSafe(DEFAULT_STATE)
  const pids = opts.noSocket ? [] : findHostPids()
  return buildReport(parsed, socketRes, opts, { state, pids, logAgeSec })
}

export async function runOnce(opts) {
  const report = await collect(opts)
  if (opts.json) return { report, output: JSON.stringify(report, null, 2), exitCode: 0 }
  if (opts.why) return { report, output: formatWhy(report), exitCode: 0 }
  const socketNote = !report.source.socketOk
    ? `\nNOTE: control socket unavailable (${report.source.socketError}). Showing log-only report.`
    : ''
  return { report, output: formatHuman(report, { full: opts.full }) + socketNote, exitCode: 0 }
}

const HELP = `agent-report.mjs - read-only observability report for the resident AI_Buddy

Usage: bun tools/agent-report.mjs [options]

Options:
  --json            emit the complete report as JSON (never truncated)
  --watch [sec]     re-render every N seconds (default 5) until Ctrl-C
  --since <min>     only consider log entries from the last N minutes
  --full            disable line/list truncation
  --why             print ONLY the blockers + verdict section
  --log <path>      override the buddy.log path
  --report <json>   read a control-report JSON file instead of the socket
  --no-socket       do not contact the control socket (offline/log-only)
  -h, --help        show this help

Read-only: only the query command \`report\` is sent; nothing is written anywhere.`

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP + '\n')
    return 0
  }
  if (opts.json && opts.why) {
    process.stderr.write('agent-report: --json and --why are mutually exclusive\n')
    return 2
  }
  if (opts.watch) {
    const interval = opts.watchSec * 1000
    let stopping = false
    process.on('SIGINT', () => {
      stopping = true
      process.stdout.write('\n')
    })
    while (!stopping) {
      try {
        const { output } = await runOnce(opts)
        process.stdout.write(`\n${output}\n`)
      } catch (e) {
        process.stderr.write(`agent-report: ${e.message}\n`)
        return 2
      }
      await sleepInterruptible(interval, () => stopping)
    }
    return 0
  }
  try {
    const { output, exitCode } = await runOnce(opts)
    process.stdout.write(output + '\n')
    return exitCode
  } catch (e) {
    process.stderr.write(`agent-report: ${e?.message || e}\n`)
    return 2
  }
}

function sleepInterruptible(ms, isStopped) {
  return new Promise((resolve) => {
    const step = 200
    let waited = 0
    const tick = () => {
      if (isStopped() || waited >= ms) return resolve()
      waited += step
      setTimeout(tick, step)
    }
    setTimeout(tick, step)
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  // Set exitCode instead of calling process.exit(): stdout to a pipe is async,
  // and process.exit() would truncate large --json output at the 64KiB pipe buffer.
  main().then((code) => {
    process.exitCode = code
  })
}
