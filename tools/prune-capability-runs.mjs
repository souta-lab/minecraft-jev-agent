#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = resolve(TOOL_DIR, '..')
const PORTAL_ID = /^portal-p(\d+)(?:\.(\d+))?$/u
const SUMMARY = 'retention-summary.json'
const PROTECT = '.retention-protect'
const IMPORTANT = [
  'DEATH ', 'SYSTEM2_PLAN_APPLIED', 'SYSTEM2_PLAN_DISCARDED',
  'AUTHORITY_VIOLATION', 'LOCAL_PROGRESS_STALL',
  'CANDIDATE_STARVATION', 'ESCALATE_HANDOFF',
]

function versionOf(name) {
  const m = PORTAL_ID.exec(name)
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null
}
function cmpVersion(a, b) {
  const av = versionOf(a) ?? [-1, -1]
  const bv = versionOf(b) ?? [-1, -1]
  return av[0] - bv[0] || av[1] - bv[1]
}
function json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function treeStats(root) {
  if (!existsSync(root)) return { bytes: 0, files: 0 }
  let bytes = 0, files = 0
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) { files += 1; bytes += statSync(p).size }
    }
  }
  walk(root)
  return { bytes, files }
}
async function logSummary(path) {
  if (!existsSync(path)) return null
  const counts = Object.fromEntries(IMPORTANT.map((p) => [p.trim(), 0]))
  let firstHeartbeat = null, lastHeartbeat = null
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  stream.on('data', (chunk) => hash.update(chunk))
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    for (const pattern of IMPORTANT) if (line.includes(pattern)) counts[pattern.trim()] += 1
    if (line.includes('HEARTBEAT ')) {
      if (firstHeartbeat === null) firstHeartbeat = line.slice(0, 500)
      lastHeartbeat = line.slice(0, 500)
    }
  }
  return { bytes: statSync(path).size, sha256: hash.digest('hex'), counts, firstHeartbeat, lastHeartbeat }
}
function protectedOutcome(result) {
  return result?.outcome === 'OBJECTIVE_SATISFIED' || result?.acceptance?.goalComplete === true
}
function activeRunId(campaignDir) {
  const a = json(join(campaignDir, 'active-run.json'))
  return a?.status === 'active' || a?.status === 'claiming' ? a.runId ?? null : null
}
function gzip(path) {
  if (!existsSync(path)) return null
  const gz = `${path}.gz`
  if (existsSync(gz)) unlinkSync(gz)
  execFileSync('gzip', ['-3', '-f', path], { stdio: 'ignore' })
  return gz
}

export async function pruneCapabilityRuns({ repoRoot = DEFAULT_REPO_ROOT, keepPortal = 10, apply = false, quiet = false } = {}) {
  const campaignDir = join(repoRoot, 'runs/capability-campaign')
  const runsDir = join(campaignDir, 'runs')
  if (!existsSync(runsDir)) return { apply, keepPortal, candidates: [], pruned: [], protected: [] }
  const active = activeRunId(campaignDir)
  const ledgerPath = join(campaignDir, 'P-SERIES.md')
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : ''
  const portalRuns = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PORTAL_ID.test(e.name)).map((e) => e.name).sort(cmpVersion)
  const newest = new Set(portalRuns.slice(-Math.max(0, keepPortal)))
  const report = { schema: 'capability-retention-run/v1', at: new Date().toISOString(), apply, keepPortal, active, candidates: [], pruned: [], protected: [] }

  for (const runId of portalRuns) {
    const dir = join(runsDir, runId)
    const resultPath = join(dir, 'result.json')
    const result = json(resultPath)
    const world = join(dir, 'server')
    const resident = join(dir, 'resident-stdout.log')
    const residentGz = `${resident}.gz`
    let reason = null
    if (runId === active) reason = 'active'
    else if (newest.has(runId)) reason = 'recent'
    else if (!result) reason = 'incomplete-no-result'
    else if (!ledger.includes(`| ${runId} |`)) reason = 'missing-p-series-ledger'
    else if (protectedOutcome(result)) reason = 'successful-accepted'
    else if (existsSync(join(dir, PROTECT))) reason = 'retention-protect-sentinel'
    else if (existsSync(join(dir, SUMMARY)) && !existsSync(world) && !existsSync(resident) && existsSync(residentGz)) reason = 'already-pruned'
    if (reason) { report.protected.push({ runId, reason }); continue }

    const before = treeStats(dir)
    const worldInfo = treeStats(world)
    const logInfo = existsSync(resident) ? await logSummary(resident) : null
    const item = { runId, resultOutcome: result?.outcome ?? null, before, world: worldInfo, residentLog: logInfo }
    report.candidates.push(item)
    if (!apply) continue

    const retention = {
      schema: 'capability-retention-summary/v1', runId, prunedAt: new Date().toISOString(),
      policy: { keepPortal, world: 'deleted', residentStdout: 'gzip-retained', serverLog: 'retained', planResult: 'retained' },
      resultOutcome: result?.outcome ?? null, sourceSha: result?.sha ?? result?.sourceSha ?? json(join(dir, 'plan.json'))?.sha ?? null,
      before, world: worldInfo, residentLog: logInfo,
    }
    writeFileSync(join(dir, SUMMARY), `${JSON.stringify(retention, null, 2)}\n`)
    // Preserve the AI log first; only then remove the reproducible raw world.
    if (existsSync(resident)) gzip(resident)
    if (existsSync(world)) rmSync(world, { recursive: true, force: true })
    const after = treeStats(dir)
    report.pruned.push({ runId, beforeBytes: before.bytes, afterBytes: after.bytes, freedBytes: before.bytes - after.bytes, residentGz: existsSync(residentGz) })
  }
  if (!quiet) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report
}

function parseArgs(argv) {
  let apply = false, keepPortal = 10
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') apply = true
    else if (argv[i] === '--keep-portal') keepPortal = Number(argv[++i])
    else if (argv[i] === '--help') return { help: true, apply, keepPortal }
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!Number.isInteger(keepPortal) || keepPortal < 1) throw new Error('--keep-portal must be an integer >= 1')
  return { help: false, apply, keepPortal }
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) process.stdout.write('Usage: bun tools/prune-capability-runs.mjs [--apply] [--keep-portal N]\nDefault is dry-run; completed failed portal runs older than the newest N are pruned.\n')
  else await pruneCapabilityRuns({ apply: opts.apply, keepPortal: opts.keepPortal })
}
