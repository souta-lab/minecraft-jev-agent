#!/usr/bin/env node
// tools/run-artifacts.mjs — run-scoped acceptance artifacts (issue #63, section 4).
//
// Shared `buddy.log`, `mercury-calls.jsonl` and friends are append-only and mix
// commits, generations, world epochs and concurrent lanes. They stay useful for
// diagnosis but must not be the authoritative acceptance source. This helper
// materialises one directory per run:
//
//   runs/<runId>/
//     manifest.json         commit/generation/world/deps/mode/bot/start-pos/window
//     acceptance.json       raw AcceptanceRecord + POLICY/IMPLEMENTED/OBSERVED/COMPLIANCE checks
//     evidence.log          the buddy.log lines that belong to this run only
//     mercury-calls.jsonl   time-sliced Mercury records (when the shared file exists)
//
// Commands:
//   list                      list runs with the artifacts each one has
//   capture <runId>           write runs/<runId>/{manifest,acceptance,evidence}.log
//                             [--log PATH] [--force] [--with-mercury]
//   slice <runId>             write only runs/<runId>/evidence.log [--log PATH] [--out PATH]
//   window <runId>            print the run's log line window {from,to,startLine,endLine}
//   current                   print the newest runId seen in the log
//   resolve [--run <runId>]   what the gates will read: run-scoped artifact vs all-time fallback
//
// Read-only except `capture`/`slice`, which only ever write under runs/.
// Never prints secrets. Non-secret BUDDY_* env is redacted by name.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const SCHEMA_VERSION = 1
export const MARKER_FALLBACK = 'all-time-shared-log'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')
// Runtime data (buddy.log, resident acceptance records, jsonl traces) lives in
// the shared tree that the resident host writes to, not necessarily in the lane
// worktree the tool is checked out in. Existing gates hardcode the shared path;
// keep the same default but allow an override. `runs/` is written next to the
// data it describes so gates and the host agree on one location.
export const MC_AI_ROOT =
  process.env.MC_AI_ROOT || (fs.existsSync('/home/s0u7a/mc-ai') ? '/home/s0u7a/mc-ai' : REPO_ROOT)
export const RUNS_ROOT = path.join(MC_AI_ROOT, 'runs')
export const ACCEPTANCE_DIR = path.join(MC_AI_ROOT, 'buddy-driver', 'data', 'resident')
export const BUDDY_LOG = path.join(MC_AI_ROOT, 'buddy-driver', 'buddy.log')
export const MERCURY_CALLS = path.join(MC_AI_ROOT, 'buddy-driver', 'logs', 'jev', 'mercury-calls.jsonl')
export const JEV_CALLS = path.join(MC_AI_ROOT, 'buddy-driver', 'logs', 'jev', 'jev-calls.jsonl')

const RUN_ID_RE = /^(run-[A-Za-z0-9-]+)$/

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Parse the leading `[<iso>Z]` timestamp of a buddy.log line, in ms. */
export function lineTs(line) {
  const m = typeof line === 'string' ? line.match(/\[([\d-]+T[\d:.]+Z)\]/) : null
  return m ? Date.parse(m[1]) : null
}

/** Extract runId from a BOOT/ACCEPTANCE/other line, or null. */
export function runIdOfLine(line) {
  const m = typeof line === 'string' ? line.match(/\brunId=(run-[A-Za-z0-9-]+)/) : null
  return m ? m[1] : null
}

function runDir(runId) {
  return path.join(RUNS_ROOT, runId)
}

/** Stream a text file line by line without holding the whole file in memory. */
export async function* readLines(file) {
  if (!fs.existsSync(file)) return
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) yield line
}

async function readLinesArray(file) {
  const out = []
  for await (const line of readLines(file)) out.push(line)
  return out
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await fsp.rename(tmp, file)
}

function acceptancePathFor(runId) {
  return path.join(ACCEPTANCE_DIR, `acceptance-${runId}.json`)
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** Non-secret BUDDY_* configuration; secret-looking keys are redacted by name. */
export function configFromEnv(env = process.env) {
  const out = {}
  const SECRET = /KEY|TOKEN|SECRET|PASS|CRED|COOKIE|AUTH/i
  for (const k of Object.keys(env).sort()) {
    if (!k.startsWith('BUDDY_')) continue
    out[k] = SECRET.test(k) ? '<redacted>' : env[k]
  }
  return out
}

/** Newest runId mentioned by a BOOT line in the log, scanning backwards cheaply. */
export async function newestRunIdFromLog(log = BUDDY_LOG) {
  if (!fs.existsSync(log)) return null
  const text = await fsp.readFile(log, 'utf8')
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const id = runIdOfLine(lines[i])
    if (id) return id
  }
  return null
}

/**
 * The log line window that belongs to one run: from the BOOT line carrying the
 * runId up to (excluding) the next BOOT line that belongs to a different run.
 * Returns { from, to, startLine, endLine, lines, matched } — `lines` is only
 * populated when `{ collect: true }`.
 */
export async function windowOfRun(runId, { log = BUDDY_LOG, collect = false } = {}) {
  const lines = collect ? [] : null
  let start = -1
  let end = -1
  let index = -1
  let current = null
  let from = null
  let to = null
  let matched = false
  for await (const raw of readLines(log)) {
    index += 1
    const boot = /\bBOOT\b/.test(raw) ? runIdOfLine(raw) : null
    if (boot) {
      if (current === runId && start >= 0 && end < 0) {
        // same run booted again (relaunch/reconnect); keep the window open
      } else if (boot === runId) {
        start = start < 0 ? index : start
        end = -1
      } else if (current === runId && end < 0) {
        end = index
      }
      current = boot
    }
    if (start >= 0 && end < 0) {
      const t = lineTs(raw)
      if (t !== null) {
        if (from === null || t < from) from = t
        if (to === null || t > to) to = t
      }
      if (runIdOfLine(raw) === runId) matched = true
      if (collect) lines.push(raw)
    }
  }
  if (end < 0) end = index + 1
  return { runId, from, to, startLine: start < 0 ? null : start, endLine: start < 0 ? null : end, lines, matched }
}

/** Slice a buddy.log by runId (run-scoped), returning the lines and window. */
export async function sliceLogByRun(runId, { log = BUDDY_LOG } = {}) {
  const w = await windowOfRun(runId, { log, collect: true })
  return { runId, lines: w.lines ?? [], from: w.from, to: w.to, startLine: w.startLine, endLine: w.endLine, matched: w.matched }
}

/** Slice any timestamped buddy.log-style file by [fromMs, toMs]. */
export async function sliceLogByTime(fromMs, toMs, { log = BUDDY_LOG } = {}) {
  const out = []
  for await (const raw of readLines(log)) {
    const t = lineTs(raw)
    if (t === null) continue
    if (fromMs !== null && t < fromMs) continue
    if (toMs !== null && t > toMs) continue
    out.push(raw)
  }
  return out
}

/** Slice a JSONL trace by its `ts` field against [fromMs, toMs]. */
export async function sliceJsonlByTime(file, fromMs, toMs) {
  const out = []
  for await (const raw of readLines(file)) {
    if (!raw.trim()) continue
    let rec = null
    try {
      rec = JSON.parse(raw)
    } catch {
      continue
    }
    const t = rec && typeof rec.ts === 'string' ? Date.parse(rec.ts) : null
    if (t === null) continue
    if (fromMs !== null && t < fromMs) continue
    if (toMs !== null && t > toMs) continue
    out.push(rec)
  }
  return out
}

/** Discover runs from the runs/ dir and the resident acceptance records. */
export async function discoverRuns() {
  const byId = new Map()
  const ensure = (runId) => {
    if (!byId.has(runId)) {
      byId.set(runId, {
        runId,
        dir: runDir(runId),
        hasManifest: false,
        hasAcceptance: false,
        hasEvidenceLog: false,
        hasMercuryCalls: false,
        acceptanceRecordPath: null,
        runArtifact: false,
      })
    }
    return byId.get(runId)
  }
  if (fs.existsSync(RUNS_ROOT)) {
    for (const entry of await fsp.readdir(RUNS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      const r = ensure(entry.name)
      r.runArtifact = true
      r.hasManifest = fs.existsSync(path.join(r.dir, 'manifest.json'))
      r.hasAcceptance = fs.existsSync(path.join(r.dir, 'acceptance.json'))
      r.hasEvidenceLog = fs.existsSync(path.join(r.dir, 'evidence.log'))
      r.hasMercuryCalls = fs.existsSync(path.join(r.dir, 'mercury-calls.jsonl'))
    }
  }
  if (fs.existsSync(ACCEPTANCE_DIR)) {
    for (const name of await fsp.readdir(ACCEPTANCE_DIR)) {
      const m = name.match(/^acceptance-(run-[A-Za-z0-9-]+)\.json$/)
      if (!m) continue
      const r = ensure(m[1])
      r.acceptanceRecordPath = path.join(ACCEPTANCE_DIR, name)
    }
  }
  return [...byId.values()].sort((a, b) => a.runId.localeCompare(b.runId))
}

/**
 * What a gate will read. Preference order:
 *   1. runs/<runId>/evidence.log                        -> source 'run-artifact'
 *   2. slice of shared buddy.log by runId               -> source 'run-slice-from-shared-log'
 *   3. whole shared buddy.log                           -> source MARKER_FALLBACK (labelled)
 */
export async function resolveRunEvidence({ runId = null, log = BUDDY_LOG } = {}) {
  const runs = await discoverRuns()
  const explicit = runId && RUN_ID_RE.test(runId) ? runId : null
  const newest = await newestRunIdFromLog(log)
  const candidates = []
  const seen = new Set()
  const push = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id)
      candidates.push(id)
    }
  }
  // Prefer the explicitly requested run, then the currently-running run, then
  // any run that already has artifacts (newest first by runId; runIds are
  // time-sortable enough for this purpose).
  push(explicit)
  push(newest)
  for (const r of runs.filter((r) => r.hasEvidenceLog || r.hasManifest).sort((a, b) => b.runId.localeCompare(a.runId))) push(r.runId)

  for (const chosen of candidates) {
    const artifact = path.join(runDir(chosen), 'evidence.log')
    if (fs.existsSync(artifact)) {
      const text = await fsp.readFile(artifact, 'utf8')
      return {
        runId: chosen,
        source: 'run-artifact',
        fallback: false,
        reason: `runs/${chosen}/evidence.log`,
        evidenceLogPath: artifact,
        artifactDir: runDir(chosen),
        lines: text.trim() ? text.trim().split('\n') : [],
        text,
        window: null,
      }
    }
    const w = await windowOfRun(chosen, { log, collect: true })
    if (w.startLine !== null) {
      const text = (w.lines ?? []).join('\n')
      return {
        runId: chosen,
        source: 'run-slice-from-shared-log',
        fallback: false,
        reason: `slice of ${path.basename(log)} by runId=${chosen}`,
        evidenceLogPath: null,
        artifactDir: runDir(chosen),
        lines: w.lines ?? [],
        text,
        window: { from: w.from, to: w.to, startLine: w.startLine, endLine: w.endLine },
      }
    }
  }

  const text = fs.existsSync(log) ? await fsp.readFile(log, 'utf8') : ''
  return {
    runId: null,
    source: MARKER_FALLBACK,
    fallback: true,
    reason: `runId could not be resolved; reading all-time ${path.basename(log)} (mixes commits/worlds/lanes)`,
    evidenceLogPath: null,
    artifactDir: null,
    lines: text.trim() ? text.trim().split('\n') : [],
    text,
    window: null,
  }
}

/**
 * Mercury records for a gate: prefer the run artifact, else a time slice of the
 * shared jsonl, else the whole shared file (labelled fallback).
 */
export async function resolveMercuryRecords({ runId = null, log = BUDDY_LOG, file = MERCURY_CALLS } = {}) {
  const runs = await discoverRuns()
  const explicit = runId && RUN_ID_RE.test(runId) ? runId : null
  const newest = await newestRunIdFromLog(log)
  const candidates = []
  const seen = new Set()
  const push = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id)
      candidates.push(id)
    }
  }
  push(explicit)
  push(newest)
  for (const r of runs.filter((r) => r.hasMercuryCalls).sort((a, b) => b.runId.localeCompare(a.runId))) push(r.runId)

  const all = (await readLinesArray(file)).filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })

  for (const chosen of candidates) {
    const artifact = path.join(runDir(chosen), 'mercury-calls.jsonl')
    if (fs.existsSync(artifact)) {
      const recs = (await readLinesArray(artifact)).filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)]
        } catch {
          return []
        }
      })
      return { runId: chosen, source: 'run-artifact', fallback: false, reason: `runs/${chosen}/mercury-calls.jsonl`, records: recs }
    }
    const w = await windowOfRun(chosen, { log, collect: false })
    if (w.from !== null) {
      // Runs are identified by proximity: the record timestamp must fall inside
      // the run's buddy.log window.
      const recs = all.filter((r) => {
        const t = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN
        return Number.isFinite(t) && t >= w.from && (w.to === null || t <= w.to)
      })
      return { runId: chosen, source: 'run-slice-from-shared-jsonl', fallback: false, reason: `time-slice of ${path.basename(file)} by runId=${chosen}`, records: recs }
    }
  }
  return { runId: null, source: 'all-time-shared-jsonl', fallback: true, reason: `runId could not be resolved; reading all-time ${path.basename(file)}`, records: all }
}

// ---------------------------------------------------------------------------
// acceptance checks: POLICY / IMPLEMENTED / OBSERVED / COMPLIANCE
// ---------------------------------------------------------------------------

export function buildChecks(record) {
  const checks = []
  const push = (id, policy, implemented, observed, compliance, command) =>
    checks.push({ id, policy, implemented, observed, compliance, command })

  if (!record) {
    push(
      'acceptance_record_present',
      'DEVELOPMENT-METHOD.md §4: every acceptance claim must be backed by a run-scoped AcceptanceRecord.',
      'buddy-driver/agent-runner.mts:1166-1211 writeAcceptance().',
      'no acceptance-<runId>.json under buddy-driver/data/resident/.',
      'UNKNOWN',
      'node tools/run-artifacts.mjs capture <runId>',
    )
    return checks
  }

  const baseline = record.listenerBaseline ?? {}
  const current = record.listenerCurrent ?? {}
  const grew = Object.keys(baseline).filter((e) => (current[e] ?? 0) > (baseline[e] ?? 0))
  push(
    'listener_stability',
    'RESIDENT-MODE.md §13-0 P1 / root AGENTS.md §2: listener counts must not grow across reloads; listenerLeak must be false.',
    'buddy-driver/agent-runner.mts:518-527 listenerCounts()/listenerLeak(); baseline set at :667-668; recorded at :1201-1203.',
    `listenerLeak=${record.listenerLeak} grew=[${grew.join(',')}] baseline=${JSON.stringify(baseline)} current=${JSON.stringify(current)}`,
    record.listenerLeak === false && grew.length === 0 ? 'PASS' : 'FAIL',
    `node tools/run-artifacts.mjs capture ${record.runId}`,
  )
  push(
    'reconnect_free',
    'RESIDENT-MODE.md §13-0 P1: the run must complete with reconnect 0.',
    'buddy-driver/resident-types.ts:308 stats.reconnects; recorded at buddy-driver/agent-runner.mts:1195.',
    `reconnects=${record.reconnects}`,
    record.reconnects === 0 ? 'PASS' : 'FAIL',
    `node tools/run-artifacts.mjs capture ${record.runId}`,
  )
  push(
    'reload_hash_churn',
    'RESIDENT-MODE.md §13-0 P1: at least 5 real reloads with a changed generation hash (skipped=unchanged does not count).',
    'buddy-driver/agent-runner.mts:1249,1283 increment stats.reloadsChangedHash; recorded at :1197.',
    `reloadsChangedHash=${record.reloadsChangedHash} reloadsSkippedUnchanged=${record.reloadsSkippedUnchanged} reloadsFailed=${record.reloadsFailed}`,
    record.reloadsChangedHash >= 5 ? 'PASS' : 'FAIL',
    `node tools/run-artifacts.mjs capture ${record.runId}`,
  )
  push(
    'no_wedge',
    'Root AGENTS.md §2 / #12 acceptance: the agent must not be wedged.',
    'buddy-driver/resident-types.ts:307 stats.wedge; recorded at buddy-driver/agent-runner.mts:1194.',
    `wedge=${record.wedge} goalComplete=${record.goalComplete}`,
    record.wedge === false ? 'PASS' : 'FAIL',
    `node tools/run-artifacts.mjs capture ${record.runId}`,
  )
  return checks
}

/** Build the manifest from the resident record plus the run's log window. */
export function buildManifest({ record, window, logLineCount, mercuryModel = null }) {
  const commit = record?.gitCommit ?? sh('git', ['rev-parse', 'HEAD'])
  const status = sh('git', ['status', '--porcelain'])
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: record?.runId ?? null,
    capturedAt: new Date().toISOString(),
    commit,
    dirtyTree: status === null ? null : status.length > 0,
    dirtyTreeNote: 'working-tree state at capture time; the resident AcceptanceRecord does not record a per-run dirty flag',
    generationHash: record?.generationHash ?? null,
    generationId: record?.generationId ?? null,
    worldEpoch: record?.worldEpoch ?? null,
    worldKey: record ? `${record.serverId}|${record.dimension}|${record.worldEpoch}` : null,
    seed: record?.seed ?? null,
    serverId: record?.serverId ?? null,
    dimension: record?.dimension ?? null,
    levelName: record?.levelName ?? null,
    serverVersion: null,
    difficulty: null,
    dependencies: record?.dependencies ?? null,
    contractVersion: record?.contractVersion ?? null,
    stateSchemaVersion: record?.stateSchemaVersion ?? null,
    stateRevision: record?.stateRevision ?? null,
    mode: record?.mode ?? null,
    botUsername: record?.botUsername ?? null,
    startPosition: record?.startPosition ?? null,
    config: configFromEnv(),
    models: { jev: null, mercury: mercuryModel },
    window: window ?? null,
    logLineCount: logLineCount ?? null,
    sources: {
      acceptanceRecord: record ? `buddy-driver/data/resident/acceptance-${record.runId}.json` : null,
      buddyLog: 'buddy-driver/buddy.log',
      mercuryCalls: 'buddy-driver/logs/jev/mercury-calls.jsonl',
    },
    dirtyTreeSource: 'git status --porcelain at capture',
  }
}

// ---------------------------------------------------------------------------
// capture / slice
// ---------------------------------------------------------------------------

export async function captureRun(runId, { log = BUDDY_LOG, force = false, withMercury = true } = {}) {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid runId: ${runId}`)
  const dir = runDir(runId)
  if (fs.existsSync(path.join(dir, 'manifest.json')) && !force) {
    return { runId, dir, skipped: true, reason: 'manifest.json exists; pass --force to overwrite' }
  }

  const record = await readJson(acceptancePathFor(runId))
  const slice = await sliceLogByRun(runId, { log })
  const window = {
    from: slice.from === null ? null : new Date(slice.from).toISOString(),
    to: slice.to === null ? null : new Date(slice.to).toISOString(),
    fromMs: slice.from,
    toMs: slice.to,
    startLine: slice.startLine,
    endLine: slice.endLine,
  }

  let mercuryModel = null
  let mercuryRecords = null
  if (withMercury && fs.existsSync(MERCURY_CALLS)) {
    mercuryRecords = await sliceJsonlByTime(MERCURY_CALLS, slice.from, slice.to)
    const lastOk = [...mercuryRecords].reverse().find((r) => r && !r.error)
    mercuryModel = lastOk?.model ?? mercuryRecords.at(-1)?.model ?? null
  }

  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'evidence.log'), slice.lines.length ? `${slice.lines.join('\n')}\n` : '')
  if (mercuryRecords) {
    await fsp.writeFile(path.join(dir, 'mercury-calls.jsonl'), mercuryRecords.map((r) => JSON.stringify(r)).join('\n') + (mercuryRecords.length ? '\n' : ''))
  }

  const manifest = buildManifest({ record, window, logLineCount: slice.lines.length, mercuryModel })
  const acceptance = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    generatedAt: new Date().toISOString(),
    evidenceSource: 'run-scoped',
    policyRefs: [
      'DEVELOPMENT-METHOD.md §3 (POLICY/IMPLEMENTED/OBSERVED/COMPLIANCE)',
      'RESIDENT-MODE.md §13-0 P1',
      'root AGENTS.md §2',
    ],
    window,
    checks: buildChecks(record),
    record,
  }
  await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest)
  await writeJsonAtomic(path.join(dir, 'acceptance.json'), acceptance)
  return { runId, dir, skipped: false, logLineCount: slice.lines.length, mercuryRecords: mercuryRecords?.length ?? 0, checks: acceptance.checks }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], log: BUDDY_LOG, force: false, withMercury: true, run: null, out: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--log') args.log = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--run') args.run = argv[++i]
    else if (a === '--force') args.force = true
    else if (a === '--no-mercury') args.withMercury = false
    else if (a === '--json') args.json = true
    else args._.push(a)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] ?? 'resolve'
  const runId = args._[1] ?? args.run

  if (cmd === 'list') {
    const runs = await discoverRuns()
    if (args.json) {
      console.log(JSON.stringify({ runs }, null, 2))
      return
    }
    if (runs.length === 0) {
      console.log('no runs found (runs/ empty and no acceptance records)')
      return
    }
    console.log('runId                        artifact  manifest acceptance evidence mercury')
    for (const r of runs) {
      console.log(
        `${r.runId.padEnd(28)} ${(r.runArtifact ? 'yes' : 'no').padEnd(9)} ${(r.hasManifest ? 'yes' : 'no').padEnd(8)} ${(r.hasAcceptance ? 'yes' : 'no').padEnd(10)} ${(r.hasEvidenceLog ? 'yes' : 'no').padEnd(8)} ${r.hasMercuryCalls ? 'yes' : 'no'}`,
      )
    }
    return
  }

  if (cmd === 'current') {
    const id = await newestRunIdFromLog(args.log)
    if (args.json) console.log(JSON.stringify({ runId: id, dir: id ? runDir(id) : null }, null, 2))
    else console.log(id ?? 'none')
    return
  }

  if (cmd === 'resolve') {
    const ev = await resolveRunEvidence({ runId: args.run, log: args.log })
    const mer = await resolveMercuryRecords({ runId: ev.runId ?? args.run, log: args.log })
    const out = {
      runId: ev.runId,
      evidenceSource: ev.source,
      fallback: ev.fallback,
      reason: ev.reason,
      artifactDir: ev.artifactDir,
      window: ev.window,
      mercurySource: mer.source,
      mercuryFallback: mer.fallback,
      mercuryRecords: mer.records.length,
    }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(`runId:          ${out.runId ?? 'none'}`)
      console.log(`evidenceSource: ${out.evidenceSource}${out.fallback ? '  <-- FALLBACK (all-time shared log)' : ''}`)
      console.log(`reason:         ${out.reason}`)
      console.log(`mercurySource:  ${out.mercurySource}${out.mercuryFallback ? '  <-- FALLBACK (all-time shared jsonl)' : ''} (${out.mercuryRecords} records)`)
    }
    return
  }

  if (cmd === 'window') {
    if (!runId) throw new Error('usage: run-artifacts.mjs window <runId>')
    const w = await windowOfRun(runId, { log: args.log, collect: false })
    const out = {
      runId,
      from: w.from === null ? null : new Date(w.from).toISOString(),
      to: w.to === null ? null : new Date(w.to).toISOString(),
      startLine: w.startLine,
      endLine: w.endLine,
      matched: w.matched,
    }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else console.log(JSON.stringify(out))
    return
  }

  if (cmd === 'slice') {
    if (!runId) throw new Error('usage: run-artifacts.mjs slice <runId>')
    const slice = await sliceLogByRun(runId, { log: args.log })
    const out = args.out ?? path.join(runDir(runId), 'evidence.log')
    await fsp.mkdir(path.dirname(out), { recursive: true })
    await fsp.writeFile(out, slice.lines.length ? `${slice.lines.join('\n')}\n` : '')
    console.log(`wrote ${out} (${slice.lines.length} lines, ${new Date(slice.from).toISOString()} .. ${new Date(slice.to).toISOString()})`)
    return
  }

  if (cmd === 'capture') {
    if (!runId) throw new Error('usage: run-artifacts.mjs capture <runId>')
    const r = await captureRun(runId, { log: args.log, force: args.force, withMercury: args.withMercury })
    if (args.json) console.log(JSON.stringify(r, null, 2))
    else if (r.skipped) console.log(`${r.runId}: skipped (${r.reason})`)
    else {
      console.log(`${r.runId}: wrote ${r.dir} (evidence lines=${r.logLineCount}, mercury records=${r.mercuryRecords})`)
      for (const c of r.checks) console.log(`  [${c.compliance}] ${c.id.padEnd(24)} ${c.observed}`)
    }
    return
  }

  throw new Error(`unknown command: ${cmd}`)
}

// Only run the CLI when invoked directly; importing for gate helpers is silent.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`run-artifacts: ${err.message}`)
    process.exit(1)
  })
}
