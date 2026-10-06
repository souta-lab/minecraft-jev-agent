#!/usr/bin/env bun
// One derived campaign resume view. Default is read-only; --write replaces only
// CURRENT.json. No lifecycle, gameplay, registry repair or SUCCESS authority.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readResidentReport } from './current-status.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA = (bytes) => createHash('sha256').update(bytes).digest('hex')
const text = (value, limit = 400) => typeof value === 'string' ? value.slice(0, limit) : null
const json = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const data = (reply) => reply?.data ?? reply

/** Match the existing fresh-run launcher or a run-owned saved-world helper. */
export function campaignRunnerMatches(argv, registry) {
  if (typeof registry.runDir !== 'string' || typeof registry.runId !== 'string') return false
  if (argv.some((arg) => arg.startsWith(`${registry.runDir}/`) && arg.endsWith('/resume-stack.py'))) return true
  const value = (flag, fallback = null) => {
    const index = argv.indexOf(flag)
    return index < 0 ? fallback : argv[index + 1]
  }
  const bootSha = registry.hostBootSha ?? registry.sha
  return argv.includes(join(ROOT, 'tools/capability-run.mjs')) &&
    registry.runDir === join(ROOT, 'runs/capability-campaign/runs', registry.runId) &&
    value('--run-id') === registry.runId && Number(value('--port', 26601)) === Number(registry.port) &&
    (bootSha == null || value('--sha') === bootSha)
}

/** Exact campaign process identity, including recycled PID rejection. Never signals processes. */
export function inspectCampaignProcess(pid, role, registry) {
  const result = { pid: Number.isInteger(pid) ? pid : null, alive: false, identityMatches: false }
  if (!Number.isInteger(pid) || pid <= 0) return result
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return result
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    result.alive = true
    if (role === 'resident') result.identityMatches = cwd === registry.runtimeDir && argv.some((arg) => arg.endsWith('agent-runner.mts'))
    if (role === 'supervisor') result.identityMatches = argv.some((arg) => arg.endsWith('resident-supervisor.mjs')) && argv.includes(registry.runtimeDir)
    if (role === 'leaf') result.identityMatches = argv.includes(join(registry.runDir, 'server', 'server.properties'))
    if (role === 'runner') result.identityMatches = campaignRunnerMatches(argv, registry)
  } catch { /* unavailable process truth */ }
  return result
}

function observedDeaths(path, username) {
  if (!path || !username) return null
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    const death = new RegExp(`\\]: ${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (?:was slain|was blown up|was shot|was killed|fell |drowned|burned|suffocated|starved|hit the ground|tried to swim|went up in flames|blew up|experienced kinetic|discovered the floor|froze|withered)`, 'u')
    return lines.filter((line) => death.test(line)).length
  } catch { return null }
}

/** Pure projection: live report wins; durable fields supply historical orientation only. */
export function buildCampaignCurrent({ registry = null, state = {}, report = null, processes = {}, deaths = null, generatedAt, mainSha = null }) {
  const live = data(report)
  const resident = processes.resident
  const observedAt = live?.currentInventoryObservation?.observedAt ?? null
  const ageMs = observedAt === null ? null : Date.parse(generatedAt) - Date.parse(observedAt)
  const fresh = Number.isFinite(ageMs) && ageMs >= -2000 && ageMs <= 15_000
  const usable = registry?.status === 'active' && resident?.alive === true && resident?.identityMatches === true && live?.connected === true && live?.status?.running === true && live?.generationId != null && fresh
  const status = usable ? live.status : null
  const drift = []
  const compare = (field, registered, observed) => {
    if (registered !== undefined && registered !== null && registered !== observed) drift.push(field)
  }
  if (usable) {
    compare('internalRunId', registry.internalRunId, live.runId)
    compare('generationId', registry.activeGenerationId, live.generationId)
    compare('generationSourceSha', registry.generationSourceSha, status.sourceSha)
    compare('generationBuildHash', registry.generationBuildHash, status.buildHash)
    compare('hostBootSha', registry.hostBootSha, live.currentInventoryObservation?.sourceSha)
    compare('serverId', `127.0.0.1:${registry.port}`, live.worldKey?.serverId)
    compare('policyProfile', registry.policyProfile, status.policyProfile)
    compare('policyModel', registry.policyModel, status.policyModel)
    if (status.treeDirty !== false) drift.push('generationTreeDirtyOrUnknown')
  }
  const intent = registry ?? state.liveProvenance ?? {}
  const runId = registry?.runId ?? state.activeRun ?? null
  const score = state.missionScoreboard ?? {}
  const queue = status?.queue?.current
  const inventory = status?.truth?.inventory ?? null
  const pending = Object.entries(state.portalAttempts ?? {}).filter(([key, row]) =>
    key.startsWith(`${runId}.`) && /ARMED|DEFERRED|PENDING/.test(String(row.status)),
  ).slice(-3).map(([minor, row]) => ({ minor, verdict: text(row.status), sourceSha: row.sha ?? null, proof: text(row.proof, 220) }))
  return {
    record: 'campaign-current/v1', generatedAt, derivedOnly: true,
    authority: 'Live server/resident and Kernel/VERIFY; this is a disposable projection, never SUCCESS authority.',
    lifecycle: {
      evidence: usable ? (drift.length ? 'UNKNOWN_PROVENANCE_DRIFT' : 'LIVE') : 'UNKNOWN_NO_MATCHED_LIVE_RESIDENT',
      registryStatus: registry?.status ?? 'absent', connected: usable ? live.connected : null,
      frozen: usable ? live.frozen : null, processes, drift,
      recordedLifecycle: text((registry ?? state.liveProvenance)?.status),
    },
    freshness: { generatedAt, residentInventoryObservedAt: observedAt, ageMs: Number.isFinite(ageMs) ? ageMs : null, status: fresh ? 'FRESH' : (observedAt ? 'STALE' : 'UNKNOWN'), maxAgeMs: 15_000 },
    campaign: {
      runId, activeMinor: registry?.activeMinor ?? state.activePortalMinor ?? null,
      port: intent.port ?? null, seed: intent.seed ?? null,
      resumeRunDir: text(intent.runDir), orientationSource: registry ? 'active-run.json (reconcile with live)' : 'state.json (resume hint only)',
    },
    source: {
      mainHead: mainSha,
      generationId: usable ? live.generationId ?? null : null,
      generationSourceSha: status?.sourceSha ?? null, generationBuildHash: status?.buildHash ?? null,
      hostBootSha: usable ? live.currentInventoryObservation?.sourceSha ?? null : null,
      lastGenerationSourceRecorded: intent.generationSourceSha ?? null,
    },
    serving: status ? {
      provider: status.policyProvider ?? null, profile: status.policyProfile ?? null, model: status.policyModel ?? null,
      system2Provider: status.system2Provider ?? null, system2Model: status.system2Model ?? null,
    } : null,
    liveTruth: status ? {
      worldKey: live.worldKey ?? null, position: status.truth?.position ?? null,
      health: status.truth?.health ?? null, food: status.truth?.food ?? null, inventory,
      currentAction: text(status.currentAction?.id ?? status.currentAction),
      queueHead: queue ? { id: queue.id, kind: queue.kind, targetItem: queue.targetItem ?? null, description: text(queue.description, 160) } : null,
      reconnectsThisHost: live.reconnect?.reconnects ?? null,
    } : null,
    missionHistory: {
      source: 'state.json.missionScoreboard; historical claims, not live facts or a SUCCESS verdict',
      highWater: text(score.highWater), recoveryDebtRecorded: text(score.recoveryDebt),
      lastDelta: score.lastSourceBoundDelta ? { value: score.lastSourceBoundDelta, at: score.lastSourceBoundDeltaAt ?? null, sourceSha: score.lastSourceBoundDeltaSha ?? null } : null,
      attemptDeathsObserved: deaths, attemptDeathsRecorded: score.attemptDeaths ?? null,
      deathsSinceLastDeltaRecorded: score.deathsSinceLastDelta ?? null, reconnectsRetainedRecorded: score.attemptReconnects ?? null,
      netherEntryRecorded: score.verifiedNetherEntry ?? null, verification: 'Consult source-bound Kernel/VERIFY evidence; never infer success from dimension or a rung label.',
      verificationDebt: pending,
    },
    next: { blockerRecorded: text(state.currentCausalBlocker, 600), conversionCheckpointRequired: Number(score.deathsSinceLastDelta) >= 3 },
    history: { state: 'state.json (history on demand)', ledger: 'P-SERIES.md (append-only history on demand)', status: 'STATUS.md (archive pointer only)', archives: 'history/<label>/manifest.json' },
  }
}

export async function captureCampaignCurrent({ campaignDir = join(ROOT, 'runs/capability-campaign'), probe = inspectCampaignProcess, readReport = readResidentReport, mainSha, generatedAt = new Date().toISOString() } = {}) {
  const registry = json(join(campaignDir, 'active-run.json'))
  const state = json(join(campaignDir, 'state.json')) ?? {}
  const hint = registry ?? state.liveProvenance ?? {}
  const processes = Object.fromEntries(['runner', 'supervisor', 'resident', 'leaf'].map((role) => [role, probe(hint[`${role}Pid`], role, hint)]))
  let report = null
  if (registry?.runtimeDir && processes.resident.alive && processes.resident.identityMatches) {
    report = await readReport(join(registry.runtimeDir, 'data/resident/control.sock'), 2000)
  }
  const source = mainSha ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 2000 }).trim()
  return buildCampaignCurrent({ registry, state, report, processes, deaths: observedDeaths(hint.serverLog, hint.username), generatedAt, mainSha: source })
}

/** Seal a lossless history checkpoint; live ledgers remain at their existing paths. */
export function archiveCampaignHistory(campaignDir, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error('invalid archive label')
  const archiveDir = join(campaignDir, 'history', label)
  if (existsSync(archiveDir)) throw new Error('history archive already exists; never overwrite evidence')
  const names = ['P-SERIES.md', 'state.json', 'STATUS.md']
  const contents = names.map((name) => [name, readFileSync(join(campaignDir, name))])
  mkdirSync(archiveDir, { recursive: true })
  const files = contents.map(([name, bytes]) => {
    writeFileSync(join(archiveDir, name), bytes, { flag: 'wx', mode: 0o444 })
    return { name, bytes: bytes.length, sha256: SHA(bytes) }
  })
  writeFileSync(join(archiveDir, 'manifest.json'), JSON.stringify({ record: 'campaign-history-archive/v1', label, files }, null, 2) + '\n', { flag: 'wx', mode: 0o444 })
  // Preserve the former STATUS bytes in the sealed archive before replacing its
  // stale current role with a small pointer. This file has no current authority.
  writeFileSync(join(campaignDir, 'STATUS.md'), [
    '# Campaign STATUS — legacy / non-authoritative', '',
    'Current/resume view: generate `CURRENT.json` with `bun tools/campaign-current.mjs --write`.',
    'Read live registry/process/resident truth first. This file is an archive pointer.', '',
    `Previous bytes preserved losslessly: [STATUS archive](history/${label}/STATUS.md).`,
    `SHA256: ${files.find((f) => f.name === 'STATUS.md').sha256}.`,
    `P-SERIES/state history is preserved; checkpoint manifest: history/${label}/manifest.json.`, '',
  ].join('\n'))
  return { archiveDir, files }
}

export async function main(argv = process.argv.slice(2)) {
  let campaignDir = join(ROOT, 'runs/capability-campaign'), write = false, archiveLabel = null
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--write') write = true
    else if (argv[i] === '--campaign-dir' && argv[i + 1]) campaignDir = resolve(argv[++i])
    else if (argv[i] === '--archive-history' && argv[i + 1]) archiveLabel = argv[++i]
    else throw new Error('usage: campaign-current [--write] [--campaign-dir DIR] [--archive-history UNIQUE_LABEL]')
  }
  if (archiveLabel !== null) archiveCampaignHistory(campaignDir, archiveLabel)
  const snapshot = await captureCampaignCurrent({ campaignDir })
  const bytes = JSON.stringify(snapshot, null, 2) + '\n'
  if (write) {
    const temporary = join(campaignDir, `.CURRENT.${process.pid}.tmp`)
    writeFileSync(temporary, bytes, { flag: 'wx' })
    renameSync(temporary, join(campaignDir, 'CURRENT.json'))
  }
  process.stdout.write(bytes)
}

if (import.meta.main) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
