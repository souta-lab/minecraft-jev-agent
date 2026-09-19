#!/usr/bin/env node
// m2-watch: read-only exact-run scan of the buddy-driver log for historical M2
// evidence. Final durable state (diamond_pickaxe) is checked separately by
// m2-acceptance. This tool owns the consumable causal history.
// Usage: node tools/m2-watch.mjs [--log <path>] [--since <ISO|epoch-ms>] [--run <runId>]
// Exit: 0 = ordered history complete, 1 = incomplete/invalid, 2 = unreadable/contaminated.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'

const DEFAULT_LOG = '/home/s0u7a/mc-ai/buddy-driver/buddy.log'
const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/

const MARKERS = [
  'PREREQ_OPTION', 'PREREQ_SWITCH', 'ABANDON_ENFORCED', 'ABANDON_SUPPRESSED',
  'ACTION_UNVERIFIED', 'MOVE_TARGET_SKIPPED', 'OSCILLATION_DETECTED', 'CAPABILITY_GAP',
  'PILLAR_REFUSED', 'PILLAR_RELOCATE', 'PILLAR_UP_STEP', 'PILLAR_FAIL', 'ASCENT_PROGRESS',
  'FURNACE_READY', 'SMELT_DONE', 'SMELT_DONE_CHARCOAL', 'SMELT_DONE_IRON_INGOT',
  'RUNG_MISMATCH', 'RELOAD_REJECTED',
]
const REQUIRED = ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE_CHARCOAL', 'SMELT_DONE_IRON_INGOT']

function markerMatches(marker, line) {
  if (marker === 'SMELT_DONE_CHARCOAL') return /\bSMELT_DONE\b.*\bitem=charcoal\b/.test(line)
  if (marker === 'SMELT_DONE_IRON_INGOT') return /\bSMELT_DONE\b.*\bitem=iron_ingot\b/.test(line)
  return line.includes(marker)
}

function generationHashFromLine(line) {
  // Initial BUILD and changed-hash RELOAD lines both carry hash=<12 hex>.
  // Other events may also carry hashes, but only these source-boundary events
  // should participate in the acceptance contamination check.
  if (!/\bBUILD\b/.test(line) && !/\bRELOAD\b/.test(line)) return null
  if (/\bRELOAD_REJECTED\b/.test(line)) return null
  if (/\bRELOAD\b/.test(line) && !/\bok=true\b/.test(line)) return null
  const match = line.match(/\bhash=([0-9a-f]{12})\b/i)
  return match?.[1]?.toLowerCase() ?? null
}

function parseSince(raw) {
  if (raw === null) return { sinceMs: null, sinceLabel: 'all-time' }
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed)
    if (Number.isFinite(value) && value >= 0) return { sinceMs: value, sinceLabel: new Date(value).toISOString() }
  }
  const value = Date.parse(trimmed)
  if (Number.isFinite(value)) return { sinceMs: value, sinceLabel: new Date(value).toISOString() }
  throw new Error(`invalid --since value: ${raw}`)
}

function parseArgs(argv) {
  let logPath = process.env.BUDDY_LOG || DEFAULT_LOG
  let sinceRaw = process.env.M2_SINCE ?? null
  let runId = process.env.M2_RUN_ID ?? null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--log' && argv[i + 1]) { logPath = argv[++i]; continue }
    if (arg === '--since' && argv[i + 1]) { sinceRaw = argv[++i]; continue }
    if (arg === '--run' && argv[i + 1]) { runId = argv[++i]; continue }
  }
  if (runId !== null && !RUN_ID_RE.test(runId.trim())) throw new Error(`invalid --run value: ${runId}`)
  return { logPath, runId: runId?.trim() ?? null, ...parseSince(sinceRaw) }
}

const TS_RE = /^\[([^\]]+)\]/
function extractTimestamp(line) { return TS_RE.exec(line)?.[1] ?? null }
function extractTimestampMs(line) {
  const text = extractTimestamp(line)
  if (text === null) return null
  const value = Date.parse(text)
  return Number.isFinite(value) ? value : null
}
function extractRunId(line) { return line.match(/\brunId=(run-[A-Za-z0-9-]+)/)?.[1] ?? null }
function isBootLine(line) { return /\bBOOT\b(?!_)/.test(line) }
function emptyStats() {
  return {
    counts: new Map(MARKERS.map((marker) => [marker, 0])),
    first: new Map(), last: new Map(),
    occurrences: new Map(MARKERS.map((marker) => [marker, []])),
    generationHashes: new Set(),
    heartbeat: null, totalLines: 0, scopedLines: 0,
  }
}

async function collectBoots(logPath) {
  const boots = []
  let lineNumber = 0
  const rl = createInterface({ input: createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    lineNumber += 1
    if (!isBootLine(line)) continue
    const runId = extractRunId(line)
    const tsMs = extractTimestampMs(line)
    if (runId !== null && tsMs !== null) boots.push({ runId, tsMs, lineNumber })
  }
  return boots
}

function resolveRunScope(boots, sinceMs, explicitRunId) {
  if (explicitRunId !== null) {
    return boots.some((boot) => boot.runId === explicitRunId)
      ? { runId: explicitRunId, error: null }
      : { runId: null, error: 'explicit_run_boundary_missing' }
  }
  if (sinceMs === null) return { runId: null, error: null }
  const after = boots.filter((boot) => boot.tsMs >= sinceMs)
  if (after.length > 1) return { runId: null, error: 'multiple_run_boundaries_after_since' }
  if (after.length === 1) return { runId: after[0].runId, error: null }
  const current = boots.filter((boot) => boot.tsMs < sinceMs).at(-1)
  return current === undefined ? { runId: null, error: 'run_boundary_missing' } : { runId: current.runId, error: null }
}

async function scan(logPath, sinceMs, runId) {
  const stats = emptyStats()
  let activeRunId = null
  const rl = createInterface({ input: createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    stats.totalLines += 1
    if (isBootLine(line)) {
      const bootRunId = extractRunId(line)
      if (bootRunId !== null) activeRunId = bootRunId
    }
    const owningRunId = extractRunId(line) ?? activeRunId
    if (runId !== null && owningRunId !== runId) continue
    if (sinceMs !== null) {
      const tsMs = extractTimestampMs(line)
      if (tsMs === null || tsMs < sinceMs) continue
    }
    stats.scopedLines += 1
    const generationHash = generationHashFromLine(line)
    if (generationHash !== null) stats.generationHashes.add(generationHash)
    for (const marker of MARKERS) {
      if (!markerMatches(marker, line)) continue
      stats.counts.set(marker, stats.counts.get(marker) + 1)
      const ts = extractTimestamp(line)
      if (!stats.first.has(marker)) stats.first.set(marker, ts)
      stats.last.set(marker, ts)
      stats.occurrences.get(marker).push(stats.totalLines)
    }
    if (line.includes('HEARTBEAT')) stats.heartbeat = line
  }
  return stats
}

function firstAfter(values, afterLine) {
  for (const value of values ?? []) if (value > afterLine) return value
  return null
}
function deriveFrontier(stats) {
  const prereqLine = firstAfter(stats.occurrences.get('PREREQ_OPTION'), -1)
  if (prereqLine === null) return { stage: 'START', next: 'PREREQ_OPTION', complete: false }
  const furnaceLine = firstAfter(stats.occurrences.get('FURNACE_READY'), prereqLine)
  if (furnaceLine === null) return { stage: 'PREREQ_OPTION', next: 'FURNACE_READY', complete: false }
  const charcoalLine = firstAfter(stats.occurrences.get('SMELT_DONE_CHARCOAL'), furnaceLine)
  if (charcoalLine === null) return { stage: 'FURNACE_READY', next: 'SMELT_DONE_CHARCOAL', complete: false }
  const ironLine = firstAfter(stats.occurrences.get('SMELT_DONE_IRON_INGOT'), charcoalLine)
  if (ironLine === null) return { stage: 'SMELT_DONE_CHARCOAL', next: 'SMELT_DONE_IRON_INGOT', complete: false }
  return { stage: 'SMELT_DONE_IRON_INGOT', next: 'terminal_inventory', complete: true }
}

let args
try { args = parseArgs(process.argv.slice(2)) }
catch (error) {
  console.log('UNKNOWN')
  console.error(`M2_WATCH status=UNREADABLE reason=${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
const { logPath, sinceMs, sinceLabel, runId: requestedRunId } = args
if (!existsSync(logPath)) {
  console.log('UNKNOWN'); console.error(`M2_WATCH log=${logPath} status=UNREADABLE reason=missing`); process.exit(2)
}
try { if (!statSync(logPath).isFile()) throw new Error('not a file') }
catch (error) {
  console.log('UNKNOWN'); console.error(`M2_WATCH log=${logPath} status=UNREADABLE reason=${error instanceof Error ? error.message : String(error)}`); process.exit(2)
}

let scope
try { scope = resolveRunScope(await collectBoots(logPath), sinceMs, requestedRunId) }
catch (error) {
  console.log('UNKNOWN'); console.error(`M2_WATCH log=${logPath} status=UNREADABLE reason=${error instanceof Error ? error.message : String(error)}`); process.exit(2)
}
if (scope.error !== null) {
  console.log('UNKNOWN')
  console.error(`M2_SCOPE status=UNKNOWN reason=${scope.error} since=${sinceLabel} requestedRunId=${requestedRunId ?? 'none'}`)
  process.exit(2)
}

let stats
try { stats = await scan(logPath, sinceMs, scope.runId) }
catch (error) {
  console.log('UNKNOWN'); console.error(`M2_WATCH log=${logPath} status=UNREADABLE reason=${error instanceof Error ? error.message : String(error)}`); process.exit(2)
}

const hashes = [...stats.generationHashes]
console.log(`M2_WATCH log=${logPath}`)
console.log(`M2_SCOPE since=${sinceLabel} runId=${scope.runId ?? 'all'} scopedLines=${stats.scopedLines} totalLines=${stats.totalLines}`)
console.log(`M2_SOURCE generationHashes=${hashes.length === 0 ? 'unknown' : hashes.join(',')}`)
if (scope.runId !== null && hashes.length > 1) {
  console.log('UNKNOWN')
  console.error(`M2_SOURCE status=UNKNOWN reason=mixed_generation_hashes runId=${scope.runId} hashes=${hashes.join(',')}`)
  process.exit(2)
}
for (const marker of MARKERS) {
  const count = stats.counts.get(marker)
  if (count === 0) console.log(`${marker} MISSING`)
  else console.log(`${marker} count=${count} first=${stats.first.get(marker) ?? 'null'} last=${stats.last.get(marker) ?? 'null'}`)
}
if (stats.heartbeat) console.log(`HEARTBEAT ${stats.heartbeat}`)
else console.log('HEARTBEAT MISSING')

const frontier = deriveFrontier(stats)
console.log(`M2_FRONTIER stage=${frontier.stage} next=${frontier.next}`)
const missingRequired = REQUIRED.filter((marker) => stats.counts.get(marker) === 0)
if (frontier.complete) {
  console.log('M2_SEQUENCE status=VALID chain=PREREQ_OPTION->FURNACE_READY->SMELT_DONE(charcoal)->SMELT_DONE(iron_ingot)')
  console.log('M2_REQUIRED status=COMPLETE history=true terminal=delegated_to_m2_acceptance')
  process.exit(0)
}
if (missingRequired.length === 0) {
  console.log('M2_SEQUENCE status=INVALID reason=no_ordered_full_M2_history_chain')
  console.log(`M2_REQUIRED status=INCOMPLETE next=${frontier.next}`)
  process.exit(1)
}
console.log(`M2_SEQUENCE status=INCOMPLETE next=${frontier.next}`)
console.log(`M2_REQUIRED status=INCOMPLETE missing=${missingRequired.join(',')} next=${frontier.next}`)
process.exit(1)
