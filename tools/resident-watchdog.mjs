#!/usr/bin/env bun
// tools/resident-watchdog.mjs — READ-ONLY freeze detector for the resident.
//
// WHY THIS EXISTS
// The resident can keep logging heartbeats while making no physical progress.
// Observed live: identical `HEARTBEAT pos=...` for minutes, repeated
// `SMELT:iron_ingot ... reason=stuck`, and a growing
// `LOCAL_PROGRESS_STALL stalledMs=...` — while nothing alerts an operator.
// Earlier the same shape appeared as an unbounded WAIT loop with
// `REPLAN_THROTTLED ... because=no_new_info`.
//
// WHAT THIS TOOL IS
// A pure OBSERVER of an existing log file.
//   * It reads (a bounded tail of) one log file and nothing else.
//   * It NEVER writes to the resident tree, NEVER opens or sends on the
//     control socket, and NEVER starts, stops, freezes or reloads anything.
//   * It does not repair, recover, replan or actuate. It only reports.
// The only process-level probe is `process.kill(pid, 0)` (signal 0), which
// performs no delivery and only answers "does this pid exist".
//
// Usage:
//   bun tools/resident-watchdog.mjs [options]
//   bun tools/resident-watchdog.mjs --help
//
// Exit codes (stable convention):
//   0  OK      — progress evidence is present (or insufficient-but-fresh)
//   1  FROZEN  — alive, log fresh, but no physical progress; a human is needed
//   2  DEAD    — pid gone or the log is missing/stale beyond the threshold
//   3  USAGE   — bad arguments (never a health status)
//
// This file is intentionally dependency-free and Bun-only.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_VERSION = 1

export const EXIT_OK = 0
export const EXIT_FROZEN = 1
export const EXIT_DEAD = 2
export const EXIT_USAGE = 3

// The live resident tree is the default target: the watchdog exists precisely to
// observe it. `--log`/`--root` override both the log and the derived host lock.
export const DEFAULT_ROOT = '/home/s0u7a/mc-ai-worktrees/m3-live'

export const DEFAULTS = {
  root: DEFAULT_ROOT,
  log: null,
  stallMinutes: 3,
  stallMarkerCount: 2,
  repeatThreshold: 3,
  windowMinutes: 10,
  tailLines: 4000,
  maxReadBytes: 4 * 1024 * 1024,
  maxLogAgeMs: 120_000,
  heartbeatStaleMs: 120_000,
  pid: null,
  pidFile: null,
  now: null,
  json: false,
  follow: false,
  intervalMs: 5_000,
  timeoutMs: 60_000,
  help: false,
}

// ---------------------------------------------------------------------------
// parsing helpers (pure)
// ---------------------------------------------------------------------------

const TS_RE = /^\[([^\]]+)\]/

export function parseTimestampMs(line) {
  const match = TS_RE.exec(String(line))
  if (match === null) return null
  const value = Date.parse(match[1])
  return Number.isFinite(value) ? value : null
}

function readField(text, name) {
  const match = new RegExp(`(?:^|[\\s(])${name}=("[^"]*"|'[^']*'|\\S+)`).exec(text)
  if (match === null) return null
  return match[1].replace(/^["']|["']$/g, '')
}

function readIntField(text, name) {
  const raw = readField(text, name)
  if (raw === null) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : null
}

const POS_RE = /(?:^|\s)pos=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/

function parsePos(text) {
  const match = POS_RE.exec(text)
  if (match === null) return null
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    z: Number(match[3]),
    raw: `${match[1]},${match[2]},${match[3]}`,
  }
}

// The heartbeat `queue=` value contains spaces, so it needs a lookahead-bounded
// capture rather than the generic token reader.
const QUEUE_RE = /(?:^|\s)queue=(.+?)(?=\s(?:depth|done|action|inv|health|running|rung|pos)=|$)/

export function parseHeartbeat(rec) {
  const text = rec.text
  const queue = QUEUE_RE.exec(text)
  return {
    ...rec,
    pos: parsePos(text),
    goal: readField(text, 'goal') ?? (queue === null ? null : queue[1].trim()) ?? readField(text, 'rung'),
    action: readField(text, 'action'),
    health: readField(text, 'health'),
    running: readField(text, 'running'),
    rung: readField(text, 'rung'),
  }
}

export function parseStall(rec) {
  return {
    ...rec,
    stalledMs: readIntField(rec.text, 'stalledMs'),
    goal: readField(rec.text, 'goal'),
    boundary: readField(rec.text, 'boundary'),
  }
}

export function parseReplanThrottle(rec) {
  return {
    ...rec,
    replanReason: readField(rec.text, 'reason'),
    ageMs: readIntField(rec.text, 'ageMs'),
    because: readField(rec.text, 'because'),
    stateHash: readField(rec.text, 'stateHash'),
  }
}

const LEADING_ACTION_RE = /^\[[^\]]+\]\s+([A-Za-z0-9_]+:[^\s]+)\s+key=/

export function isActionEventLine(text) {
  return /\bACTION\b/.test(text) || /\bactionId=/.test(text) || LEADING_ACTION_RE.test(text)
}

export function parseActionEvent(rec) {
  const text = rec.text
  const leading = LEADING_ACTION_RE.exec(text)
  const id = readField(text, 'id') ?? readField(text, 'actionId') ?? (leading === null ? null : leading[1])
  let kind = readField(text, 'kind')
  if (kind === null && id !== null && id.includes(':')) kind = id.split(':')[0]
  return { ...rec, actionId: id, kind }
}

const RECOVERY_RE = /(?:^|[^A-Z0-9_])(LOCAL_RECOVERY_[A-Z0-9_]+)/

export function parseRecoveryMarker(rec) {
  const match = RECOVERY_RE.exec(rec.text)
  return match === null ? null : { ...rec, marker: match[1] }
}

// Completion evidence is deliberately narrow: movement is NOT completion
// (buddy-driver/AGENTS.md §5). STATION_VERIFIED is excluded because the resident
// emits it while enumerating known stations, not when a goal completes.
const COMPLETION_PATTERNS = [
  /\b[A-Z][A-Z0-9_]*_DONE\b/,
  /(?:^|\s)DONE(?:\s|$)/,
  /\bCOMPLETED\b/,
  /\bACTION_VERIFIED\b/,
  /(?:^|\s)verified=true\b/,
  /(?:^|\s)progressDelta=[1-9]\d*(?:\s|$)/,
  /\bMILESTONE_(?:DONE|REACHED|COMPLETE)\b/,
  /\binventoryGain=/,
]

export function isCompletionLine(text) {
  return COMPLETION_PATTERNS.some((pattern) => pattern.test(text))
}

export function isBootLine(text) {
  return /\bBOOT\b(?!_)/.test(text)
}

/** Parse a bounded list of raw log lines into the record sets the detector uses. */
export function parseLog(lines) {
  const records = {
    lines: [],
    heartbeats: [],
    actions: [],
    stalls: [],
    replans: [],
    recoveries: [],
    completions: [],
    boots: [],
  }
  lines.forEach((text, index) => {
    const rec = { text, index, tsMs: parseTimestampMs(text) }
    records.lines.push(rec)
    if (/\bHEARTBEAT\b/.test(text)) records.heartbeats.push(parseHeartbeat(rec))
    if (/\bLOCAL_PROGRESS_STALL\b/.test(text)) records.stalls.push(parseStall(rec))
    if (isActionEventLine(text)) records.actions.push(parseActionEvent(rec))
    if (/\bREPLAN_THROTTLED\b/.test(text)) records.replans.push(parseReplanThrottle(rec))
    const recovery = parseRecoveryMarker(rec)
    if (recovery !== null) records.recoveries.push(recovery)
    if (isCompletionLine(text)) records.completions.push(rec)
    if (isBootLine(text)) records.boots.push(rec)
  })
  return records
}

// ---------------------------------------------------------------------------
// evaluation (pure)
// ---------------------------------------------------------------------------

const REASON_TITLE = {
  'log-missing': 'log file does not exist',
  'log-unreadable': 'log file is not readable',
  'pid-dead': 'resident pid is not alive',
  'log-stale': 'log has not been written for longer than the staleness threshold',
  'local-progress-stall': 'resident itself reports repeated LOCAL_PROGRESS_STALL',
  'heartbeat-stale': 'heartbeats stopped while the log stays fresh',
  'pos-stall': 'position has not changed while heartbeats continue',
  'wait-loop': 'identical WAIT action repeats with no completion',
  'action-repeat': 'identical action repeats with no completion',
  'replan-throttled': 'replanning is throttled repeatedly with no completion',
  'local-recovery-loop': 'local recovery repeats with no completion',
  progressing: 'position or completion evidence is moving',
  'no-heartbeat': 'no heartbeat evidence in the window (fresh log)',
  'warming-up': 'resident booted but has not heartbeated yet',
}

export function reasonTitle(slug) {
  return REASON_TITLE[slug] ?? slug
}

function inWindow(rec, windowStartMs) {
  return rec.tsMs !== null && rec.tsMs >= windowStartMs
}

function dominantActionOf(actions) {
  if (actions.length === 0) return null
  const groups = new Map()
  for (const action of actions) {
    if (action.actionId === null) continue
    const key = action.actionId
    const entry = groups.get(key) ?? { id: key, kind: action.kind, count: 0, lastTsMs: null, events: [] }
    entry.count += 1
    entry.events.push(action)
    if (action.kind !== null) entry.kind = action.kind
    if (action.tsMs !== null && (entry.lastTsMs === null || action.tsMs >= entry.lastTsMs)) entry.lastTsMs = action.tsMs
    groups.set(key, entry)
  }
  let best = null
  for (const entry of groups.values()) {
    if (best === null) {
      best = entry
      continue
    }
    if (entry.count > best.count || (entry.count === best.count && (entry.lastTsMs ?? 0) > (best.lastTsMs ?? 0))) best = entry
  }
  return best
}

function completedAfter(completions, firstTsMs) {
  if (firstTsMs === null) return completions.length > 0
  return completions.some((rec) => rec.tsMs !== null && rec.tsMs >= firstTsMs)
}

function lastPosChangeAnchor(heartbeats) {
  let lastChangedIndex = null
  for (let i = 1; i < heartbeats.length; i += 1) {
    const before = heartbeats[i - 1].pos
    const after = heartbeats[i].pos
    if (before === null || after === null) continue
    if (before.x !== after.x || before.y !== after.y || before.z !== after.z) lastChangedIndex = i
  }
  return lastChangedIndex === null ? heartbeats[0] : heartbeats[lastChangedIndex]
}

function fact(text) {
  return { kind: 'fact', text }
}

/**
 * Decide OK / FROZEN / DEAD from parsed records plus IO context.
 *
 * `context` carries: nowMs, logPath, logExists, logReadable, logAgeMs, size,
 * mtimeMs, pid, pidAlive, pidSource, truncated, poll.
 */
export function evaluate(records, opts, context) {
  const nowMs = context.nowMs
  const windowMs = opts.windowMinutes * 60_000
  const stallMs = opts.stallMinutes * 60_000
  const windowStartMs = nowMs - windowMs

  const heartbeats = records.heartbeats.filter((rec) => inWindow(rec, windowStartMs))
  const actions = records.actions.filter((rec) => inWindow(rec, windowStartMs))
  const stalls = records.stalls.filter((rec) => inWindow(rec, windowStartMs))
  const replans = records.replans.filter((rec) => inWindow(rec, windowStartMs))
  const recoveries = records.recoveries.filter((rec) => inWindow(rec, windowStartMs))
  const completions = records.completions.filter((rec) => inWindow(rec, windowStartMs))
  const boots = records.boots.filter((rec) => inWindow(rec, windowStartMs))

  const lastHeartbeat = heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : null
  const lastStall = stalls.length > 0 ? stalls[stalls.length - 1] : null
  const lastBeatAgeMs = lastHeartbeat?.tsMs != null ? nowMs - lastHeartbeat.tsMs : null

  let hbStalledMs = null
  let stallAnchor = null
  if (heartbeats.length >= 2) {
    stallAnchor = lastPosChangeAnchor(heartbeats)
    if (stallAnchor.tsMs !== null) hbStalledMs = Math.max(0, nowMs - stallAnchor.tsMs)
  }

  const declaredStalledMs = lastStall?.stalledMs ?? null
  let stalledMs = 0
  if (hbStalledMs !== null && declaredStalledMs !== null) stalledMs = Math.max(hbStalledMs, declaredStalledMs)
  else if (hbStalledMs !== null) stalledMs = hbStalledMs
  else if (declaredStalledMs !== null) stalledMs = declaredStalledMs

  const dominant = dominantActionOf(actions)
  const firstActionTs = actions.length > 0 ? actions[0].tsMs : null
  const actionProgressed = completedAfter(completions, firstActionTs)
  const firstRecoveryTs = recoveries.length > 0 ? recoveries[0].tsMs : null
  const recoveryProgressed = completedAfter(completions, firstRecoveryTs)
  const firstStallTs = stalls.length > 0 ? stalls[0].tsMs : null
  const stallResolved = stalls.length > 0 && completedAfter(completions, firstStallTs)
  const lastStallAgeMs = lastStall?.tsMs != null ? nowMs - lastStall.tsMs : null
  const ongoingStall = lastStallAgeMs !== null && lastStallAgeMs <= opts.heartbeatStaleMs

  const posRaw = lastHeartbeat?.pos?.raw ?? lastStall?.goal ?? null
  const goalRaw = lastStall?.goal ?? lastHeartbeat?.goal ?? null

  const counters = {
    windowStartMs,
    windowEndMs: nowMs,
    heartbeats: heartbeats.length,
    actions: actions.length,
    completions: completions.length,
    lpStall: stalls.length,
    localRecovery: recoveries.length,
    replanThrottled: replans.length,
    dominantAction: dominant?.id ?? null,
    dominantKind: dominant?.kind ?? null,
    actionRepeats: dominant?.count ?? 0,
    lastHeartbeatAgeMs: lastBeatAgeMs,
    hbStalledMs,
    declaredStalledMs,
    boots: boots.length,
  }

  const baseEvidence = []
  if (lastHeartbeat !== null) baseEvidence.push({ kind: 'line', index: lastHeartbeat.index, tsMs: lastHeartbeat.tsMs, text: lastHeartbeat.text })

  const dead = (reason, extraEvidence = []) => {
    const evidence = [...extraEvidence]
    if (records.lines.length > 0) {
      const last = records.lines[records.lines.length - 1]
      evidence.push({ kind: 'line', index: last.index, tsMs: last.tsMs, text: last.text })
    }
    return {
      status: 'DEAD',
      reason,
      reasons: [reason],
      exitCode: EXIT_DEAD,
      liveness: 'dead',
      confidence: 'high',
      stalledMs,
      posRaw,
      goalRaw,
      counters,
      evidence,
    }
  }

  if (context.logExists === false) return dead('log-missing', [fact(`log missing path=${context.logPath}`)])
  if (context.logReadable === false) return dead('log-unreadable', [fact(`log unreadable path=${context.logPath}`)])
  if (context.pid !== null && context.pidAlive === false) {
    return dead('pid-dead', [fact(`pid not alive pid=${context.pid} source=${context.pidSource}`), ...baseEvidence])
  }
  if (context.logAgeMs !== null && context.logAgeMs > opts.maxLogAgeMs) {
    const pidNote = context.pid === null ? 'pid=unknown' : `pid=${context.pid} pidAlive=${context.pidAlive}`
    return dead('log-stale', [
      fact(`log age ${context.logAgeMs}ms exceeds ${opts.maxLogAgeMs}ms (${pidNote})`),
      ...baseEvidence,
    ])
  }

  const reasons = []
  const evidence = []

  // A repeated marker only means FROZEN while the stall is ongoing (last marker
  // is recent) and no completion has landed since it started; otherwise the
  // resident stalled earlier and recovered, which is not this alert.
  const stallMarkerTriggered =
    (declaredStalledMs !== null && declaredStalledMs >= stallMs) ||
    (stalls.length >= opts.stallMarkerCount && ongoingStall && !stallResolved)
  if (stallMarkerTriggered) {
    reasons.push('local-progress-stall')
    for (const stall of stalls.slice(-3)) evidence.push({ kind: 'line', index: stall.index, tsMs: stall.tsMs, text: stall.text })
  }

  if (lastBeatAgeMs !== null && lastBeatAgeMs > opts.heartbeatStaleMs) {
    reasons.push('heartbeat-stale')
    if (lastHeartbeat !== null) evidence.push({ kind: 'line', index: lastHeartbeat.index, tsMs: lastHeartbeat.tsMs, text: lastHeartbeat.text })
  }

  if (hbStalledMs !== null && hbStalledMs >= stallMs) {
    reasons.push('pos-stall')
    if (stallAnchor !== null) evidence.push({ kind: 'line', index: stallAnchor.index, tsMs: stallAnchor.tsMs, text: stallAnchor.text })
    if (lastHeartbeat !== null && lastHeartbeat !== stallAnchor) {
      evidence.push({ kind: 'line', index: lastHeartbeat.index, tsMs: lastHeartbeat.tsMs, text: lastHeartbeat.text })
    }
  }

  if (dominant !== null && dominant.count >= opts.repeatThreshold && !actionProgressed) {
    const isWait = dominant.id === 'WAIT' || dominant.kind === 'WAIT'
    reasons.push(isWait ? 'wait-loop' : 'action-repeat')
    for (const event of dominant.events.slice(-3)) {
      evidence.push({ kind: 'line', index: event.index, tsMs: event.tsMs, text: event.text })
    }
  }

  if (replans.length >= opts.repeatThreshold && !actionProgressed) {
    reasons.push('replan-throttled')
    for (const replan of replans.slice(-3)) evidence.push({ kind: 'line', index: replan.index, tsMs: replan.tsMs, text: replan.text })
  }

  if (recoveries.length >= opts.repeatThreshold && !recoveryProgressed) {
    reasons.push('local-recovery-loop')
    for (const recovery of recoveries.slice(-3)) evidence.push({ kind: 'line', index: recovery.index, tsMs: recovery.tsMs, text: recovery.text })
  }

  if (reasons.length > 0) {
    const seen = new Set()
    const deduped = []
    for (const item of [...evidence, ...baseEvidence]) {
      const key = `${item.kind}:${item.index ?? item.text}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(item)
      if (deduped.length >= 12) break
    }
    return {
      status: 'FROZEN',
      reason: reasons[0],
      reasons,
      exitCode: EXIT_FROZEN,
      liveness: 'alive-frozen',
      confidence: 'high',
      stalledMs,
      posRaw,
      goalRaw,
      counters,
      evidence: deduped,
    }
  }

  const okReason =
    heartbeats.length > 0 ? 'progressing' : boots.length > 0 ? 'warming-up' : 'no-heartbeat'
  return {
    status: 'OK',
    reason: okReason,
    reasons: [],
    exitCode: EXIT_OK,
    liveness: heartbeats.length > 0 ? 'alive' : 'unknown',
    confidence: heartbeats.length > 0 ? 'high' : 'low',
    stalledMs,
    posRaw,
    goalRaw,
    counters,
    evidence: baseEvidence,
  }
}

// ---------------------------------------------------------------------------
// IO (read-only)
// ---------------------------------------------------------------------------

/** Signal 0: asks the kernel whether the pid exists; nothing is delivered. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Read a bounded tail of the log without touching anything else. */
export function readLogTail(logPath, { tailLines = DEFAULTS.tailLines, maxReadBytes = DEFAULTS.maxReadBytes } = {}) {
  const st = statSync(logPath)
  if (!st.isFile()) throw new Error('not a regular file')
  const size = st.size
  const readBytes = Math.max(0, Math.min(size, maxReadBytes))
  const start = size - readBytes
  let text = ''
  if (readBytes > 0) {
    const fd = openSync(logPath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(readBytes)
      const bytesRead = readSync(fd, buffer, 0, readBytes, start)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      closeSync(fd)
    }
  }
  if (start > 0) {
    const newline = text.indexOf('\n')
    text = newline === -1 ? '' : text.slice(newline + 1)
  }
  let lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const truncated = lines.length > tailLines
  if (truncated) lines = lines.slice(-tailLines)
  return { lines, size, mtimeMs: st.mtimeMs, truncated, readBytes }
}

function resolvePaths(opts) {
  const logPath = opts.log !== null ? resolve(opts.log) : join(resolve(opts.root), 'buddy-driver', 'buddy.log')
  const pidFile = opts.pidFile !== null ? resolve(opts.pidFile) : join(dirname(logPath), 'data', 'resident', 'host.lock')
  return { logPath, pidFile }
}

function resolvePid(opts, paths) {
  if (opts.pid !== null) return { pid: opts.pid, alive: pidAlive(opts.pid), source: 'flag' }
  if (!existsSync(paths.pidFile)) return { pid: null, alive: null, source: 'none' }
  try {
    const parsed = Number.parseInt(readTextFileSync(paths.pidFile).trim(), 10)
    if (!Number.isInteger(parsed) || parsed <= 0) return { pid: null, alive: null, source: 'host-lock-invalid' }
    return { pid: parsed, alive: pidAlive(parsed), source: 'host-lock' }
  } catch {
    return { pid: null, alive: null, source: 'host-lock-unreadable' }
  }
}

function readTextFileSync(file) {
  const fd = openSync(file, 'r')
  try {
    const st = statSync(file)
    const buffer = Buffer.allocUnsafe(st.size)
    const bytesRead = readSync(fd, buffer, 0, st.size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** One read-only observation pass. */
export function observe(opts, paths, poll = 1) {
  const nowMs = opts.nowMs ?? Date.now()
  const pidState = resolvePid(opts, paths)
  const context = {
    nowMs,
    logPath: paths.logPath,
    logExists: existsSync(paths.logPath),
    logReadable: false,
    logAgeMs: null,
    size: null,
    mtimeMs: null,
    truncated: false,
    pid: pidState.pid,
    pidAlive: pidState.alive,
    pidSource: pidState.source,
    poll,
  }
  let records = parseLog([])
  if (context.logExists) {
    try {
      const tail = readLogTail(paths.logPath, { tailLines: opts.tailLines, maxReadBytes: opts.maxReadBytes })
      context.logReadable = true
      context.size = tail.size
      context.mtimeMs = tail.mtimeMs
      context.truncated = tail.truncated
      context.logAgeMs = Math.max(0, Math.round(nowMs - tail.mtimeMs))
      records = parseLog(tail.lines)
    } catch {
      context.logReadable = false
    }
  }
  const verdict = evaluate(records, opts, context)
  return {
    tool: 'resident-watchdog',
    schemaVersion: SCHEMA_VERSION,
    poll,
    now: new Date(nowMs).toISOString(),
    log: paths.logPath,
    logAgeMs: context.logAgeMs,
    logSize: context.size,
    logMtime: context.mtimeMs === null ? null : new Date(context.mtimeMs).toISOString(),
    logTruncated: context.truncated,
    pid: context.pid,
    pidAlive: context.pidAlive,
    pidSource: context.pidSource,
    thresholds: {
      stallMinutes: opts.stallMinutes,
      stallMs: Math.round(opts.stallMinutes * 60_000),
      windowMinutes: opts.windowMinutes,
      tailLines: opts.tailLines,
      maxLogAgeMs: opts.maxLogAgeMs,
      heartbeatStaleMs: opts.heartbeatStaleMs,
      stallMarkerCount: opts.stallMarkerCount,
      repeatThreshold: opts.repeatThreshold,
    },
    ...verdict,
  }
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function token(value) {
  if (value === null || value === undefined) return 'unknown'
  return String(value).replace(/\s+/g, '_')
}

export function formatLine(verdict) {
  const c = verdict.counters
  return [
    'WATCHDOG',
    `status=${verdict.status}`,
    `reason=${verdict.reason}`,
    `stalledMs=${Math.round(verdict.stalledMs ?? 0)}`,
    `pos=${token(verdict.posRaw)}`,
    `goal=${token(verdict.goalRaw)}`,
    `reasons=${verdict.reasons.length > 0 ? verdict.reasons.join(',') : 'none'}`,
    `liveness=${verdict.liveness}`,
    `confidence=${verdict.confidence}`,
    `log=${token(verdict.log)}`,
    `logAgeMs=${verdict.logAgeMs ?? 'unknown'}`,
    `heartbeats=${c.heartbeats}`,
    `actions=${c.actions}`,
    `dominantAction=${token(c.dominantAction)}`,
    `actionRepeats=${c.actionRepeats}`,
    `lpStall=${c.lpStall}`,
    `localRecovery=${c.localRecovery}`,
    `replanThrottled=${c.replanThrottled}`,
    `completions=${c.completions}`,
    `pid=${verdict.pid ?? 'unknown'}`,
    `pidAlive=${verdict.pidAlive === null ? 'unknown' : verdict.pidAlive}`,
    `pidSource=${verdict.pidSource}`,
    `exit=${verdict.exitCode}`,
  ].join(' ')
}

export function formatEvidenceLine(item) {
  if (item.kind === 'fact') return `WATCHDOG_EVIDENCE kind=fact text=${token(item.text)}`
  const ts = item.tsMs === null ? 'none' : new Date(item.tsMs).toISOString()
  return `WATCHDOG_EVIDENCE kind=line n=${item.index} ts=${ts} text=${item.text}`
}

export function formatJson(verdict) {
  return JSON.stringify({
    tool: verdict.tool,
    schemaVersion: verdict.schemaVersion,
    poll: verdict.poll,
    now: verdict.now,
    status: verdict.status,
    reason: verdict.reason,
    reasonTitle: reasonTitle(verdict.reason),
    reasons: verdict.reasons,
    stalledMs: Math.round(verdict.stalledMs ?? 0),
    pos: verdict.posRaw,
    goal: verdict.goalRaw,
    liveness: verdict.liveness,
    confidence: verdict.confidence,
    exitCode: verdict.exitCode,
    log: verdict.log,
    logAgeMs: verdict.logAgeMs,
    logSize: verdict.logSize,
    logMtime: verdict.logMtime,
    logTruncated: verdict.logTruncated,
    pid: verdict.pid,
    pidAlive: verdict.pidAlive,
    pidSource: verdict.pidSource,
    counters: verdict.counters,
    thresholds: verdict.thresholds,
    evidence: verdict.evidence,
  })
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function usage() {
  return `resident-watchdog — READ-ONLY freeze detector for the resident

THIS TOOL ONLY OBSERVES. It is NOT a recovery mechanism.
  * It never writes to the resident tree (no artifacts, no state, no lock).
  * It never opens, connects to, or sends on the control socket.
  * It never starts, stops, freezes, resumes, reloads or kills anything.
  * The only process probe is signal 0 ("does this pid exist"), which delivers
    nothing. If you want action, this tool only tells you a human is needed.

It reads a bounded tail of one existing resident log and reports whether the
resident is making progress: OK, FROZEN (alive but no progress) or DEAD
(pid gone / log stale / log missing).

Usage:
  bun tools/resident-watchdog.mjs [options]
  bun tools/resident-watchdog.mjs --follow [--timeout-ms N]
  bun tools/resident-watchdog.mjs --help

Options:
  --log PATH            resident log to read
                        (default <root>/buddy-driver/buddy.log)
  --root PATH           resident tree root whose buddy-driver/buddy.log and
                        data/resident/host.lock are used (default ${DEFAULT_ROOT})
  --stall-minutes N     no-position-change threshold (default ${DEFAULTS.stallMinutes})
  --stall-marker-count N  repeated LOCAL_PROGRESS_STALL lines that mean FROZEN
                        (default ${DEFAULTS.stallMarkerCount})
  --repeat-threshold N  identical action / throttled replan repetitions that
                        mean FROZEN (default ${DEFAULTS.repeatThreshold})
  --window-minutes N    how much of the log tail is considered (default ${DEFAULTS.windowMinutes})
  --tail-lines N        maximum log lines parsed (default ${DEFAULTS.tailLines})
  --max-read-bytes N    maximum bytes read from the log tail (default ${DEFAULTS.maxReadBytes})
  --max-log-age-ms N    log mtime age beyond which the resident is DEAD
                        (default ${DEFAULTS.maxLogAgeMs})
  --heartbeat-stale-ms N  heartbeat age beyond which a fresh log is FROZEN
                        (default ${DEFAULTS.heartbeatStaleMs})
  --pid N               explicit resident pid to probe (read-only)
  --pid-file PATH       pid/host-lock file (default <log dir>/data/resident/host.lock)
  --now ISO|EPOCH-MS    pin the clock for fixtures/replay (testing only)
  --json                emit one JSON object instead of text + evidence lines
  --follow              poll every --interval-ms; exit as soon as a non-OK
                        status appears, otherwise at --timeout-ms
  --interval-ms N       follow poll interval (default ${DEFAULTS.intervalMs})
  --timeout-ms N        follow deadline (default ${DEFAULTS.timeoutMs})
  -h, --help            print this help

Output:
  Text mode prints WATCHDOG_EVIDENCE lines (the exact log lines used) followed
  by one machine-readable summary line:
    WATCHDOG status=OK|FROZEN|DEAD reason=<slug> stalledMs=<n> pos=<x,y,z> goal=<...>
  Whitespace inside pos/goal tokens is replaced with "_". --json prints a single
  JSON object with the same fields plus counters, thresholds and evidence[].

Exit codes:
  0  OK      progress evidence present (or fresh but insufficient)
  1  FROZEN  alive, log fresh, no physical progress — a human is needed
  2  DEAD    pid gone, or log missing/stale beyond the threshold
  3  USAGE   bad arguments (never a health status)
`
}

function parseNumber(name, raw, { min = 0, integer = false } = {}) {
  const value = integer ? Number.parseInt(raw, 10) : Number(raw)
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} expects ${integer ? 'an integer' : 'a number'} >= ${min}, got ${raw}`)
  }
  return value
}

function parseClock(raw) {
  const trimmed = String(raw).trim()
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed)
    if (Number.isFinite(value) && value > 0) return value
  }
  const value = Date.parse(trimmed)
  if (Number.isFinite(value)) return value
  throw new Error(`--now expects an ISO timestamp or epoch-ms, got ${raw}`)
}

export function parseArgs(argv) {
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} expects a value`)
      return value
    }
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--json') opts.json = true
    else if (arg === '--follow') opts.follow = true
    else if (arg === '--log') opts.log = next()
    else if (arg === '--root') opts.root = next()
    else if (arg === '--pid') opts.pid = parseNumber('--pid', next(), { min: 1, integer: true })
    else if (arg === '--pid-file') opts.pidFile = next()
    else if (arg === '--now') opts.now = parseClock(next())
    else if (arg === '--stall-minutes') opts.stallMinutes = parseNumber('--stall-minutes', next())
    else if (arg === '--stall-marker-count') opts.stallMarkerCount = parseNumber('--stall-marker-count', next(), { min: 1, integer: true })
    else if (arg === '--repeat-threshold') opts.repeatThreshold = parseNumber('--repeat-threshold', next(), { min: 1, integer: true })
    else if (arg === '--window-minutes') opts.windowMinutes = parseNumber('--window-minutes', next())
    else if (arg === '--tail-lines') opts.tailLines = parseNumber('--tail-lines', next(), { min: 1, integer: true })
    else if (arg === '--max-read-bytes') opts.maxReadBytes = parseNumber('--max-read-bytes', next(), { min: 1, integer: true })
    else if (arg === '--max-log-age-ms') opts.maxLogAgeMs = parseNumber('--max-log-age-ms', next(), { min: 1, integer: true })
    else if (arg === '--heartbeat-stale-ms') opts.heartbeatStaleMs = parseNumber('--heartbeat-stale-ms', next(), { min: 1, integer: true })
    else if (arg === '--interval-ms') opts.intervalMs = parseNumber('--interval-ms', next(), { min: 1, integer: true })
    else if (arg === '--timeout-ms') opts.timeoutMs = parseNumber('--timeout-ms', next(), { min: 1, integer: true })
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (opts.stallMinutes <= 0) throw new Error('--stall-minutes must be > 0')
  if (opts.windowMinutes <= 0) throw new Error('--window-minutes must be > 0')
  opts.nowMs = opts.now
  return opts
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export function emit(verdict, opts) {
  if (opts.json) {
    process.stdout.write(`${formatJson(verdict)}\n`)
    return
  }
  for (const item of verdict.evidence) process.stdout.write(`${formatEvidenceLine(item)}\n`)
  process.stdout.write(`${formatLine(verdict)}\n`)
}

export async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`resident-watchdog: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write('resident-watchdog: run with --help for usage\n')
    return EXIT_USAGE
  }
  if (opts.help) {
    process.stdout.write(usage())
    return EXIT_OK
  }

  const paths = resolvePaths(opts)
  if (opts.follow) {
    const deadline = Date.now() + opts.timeoutMs
    let poll = 0
    for (;;) {
      poll += 1
      const verdict = observe(opts, paths, poll)
      if (verdict.exitCode !== EXIT_OK || Date.now() >= deadline) {
        emit(verdict, opts)
        return verdict.exitCode
      }
      await sleep(Math.min(opts.intervalMs, Math.max(1, deadline - Date.now())))
    }
  }
  const verdict = observe(opts, paths, 1)
  emit(verdict, opts)
  return verdict.exitCode
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`resident-watchdog: ${error?.stack ?? error}\n`)
      process.exit(EXIT_USAGE)
    })
}
