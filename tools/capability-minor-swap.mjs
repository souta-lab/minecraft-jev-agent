#!/usr/bin/env bun
// capability-minor-swap: canonical same-world pN -> pN.x provenance update.
//
//   bun tools/capability-minor-swap.mjs \
//     --minor portal-p19.4 --sha <40hex> --boundary generation-reload \
//     [--runtime-dir <abs>] [--resident-pid <n>] [--resident-stdout <abs>] \
//     [--internal-run-id run-...] [--log <resident stdout>] [--registry <abs>]
//
// Boundaries:
//   generation-reload  - connection-preserving hot reload. The resident HOST,
//                        Mineflayer connection, internal runId and residentPid
//                        MUST be unchanged; only generationSourceSha/id, sha,
//                        runtimeDir move. Verified against GENERATION_READY.
//   resident-restart   - infrastructure reconnect of the SAME major world.
//                        New residentPid + internal runId; hostBootSha updates.
//                        Verified against the first GENERATION_READY of the
//                        new internal run.
//
// The tool refuses to write unverified provenance: the named log must carry a
// GENERATION_READY line with the exact --sha (and, for reloads, the unchanged
// internal runId) before the registry is touched. Writes go through
// updateActiveRunMinor: atomic, runId-preserving, claim-token-rotating.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateActiveRunMinor } from './capability-run.mjs'
import { readResidentReport } from './current-status.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REGISTRY = join(resolve(TOOL_DIR, '..'), 'runs/capability-campaign/active-run.json')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (typeof key !== 'string' || !key.startsWith('--')) throw new Error(`bad arg ${key}`)
    out[key.slice(2)] = argv[i + 1]
  }
  return out
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** Latest GENERATION_READY {runId, id, sourceSha} from a resident log. */
function lastGenerationReady(logPath) {
  if (!existsSync(logPath)) return null
  const lines = readFileSync(logPath, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('GENERATION_READY')) continue
    const field = (name) => line.match(new RegExp(`${name}=(\\S+)`, 'u'))?.[1] ?? null
    return { runId: field('runId'), generationId: field('id') ?? field('generationId'), sourceSha: field('sourceSha'), buildHash: field('buildHash') }
  }
  return null
}

function readRegistry(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function verifyLiveGenerationForSwap({ current, ready, boundary, residentPid, report, now = Date.now(), isAlive = pidAlive } = {}) {
  const live = report?.data ?? report
  if (!live || typeof live !== 'object') throw new Error('native resident report unavailable; refusing unverified provenance')
  if (live.frozen === true || live.generationId == null) throw new Error('native resident report is frozen or has no active generation')
  if (live.connected !== true || live.status?.running !== true) throw new Error('native resident report is not connected with a running generation')
  if (live.runId !== ready.runId || live.generationId !== ready.generationId || live.status?.sourceSha !== ready.sourceSha) {
    throw new Error('native resident report does not match the candidate GENERATION_READY')
  }
  if (ready.buildHash && live.status?.buildHash !== ready.buildHash) {
    throw new Error('native resident report build hash does not match the candidate GENERATION_READY')
  }
  const expectedServerId = Number.isInteger(current.port) ? `127.0.0.1:${current.port}` : null
  if (expectedServerId !== null && live.worldKey?.serverId !== expectedServerId) {
    throw new Error('native resident report is connected to a different server')
  }
  const observedAt = Date.parse(live.currentInventoryObservation?.observedAt ?? '')
  if (!Number.isFinite(observedAt) || now - observedAt < -2000 || now - observedAt > 15_000) {
    throw new Error('native resident report inventory observation is stale or missing')
  }
  const hostBootSha = live.currentInventoryObservation?.sourceSha
  if (typeof hostBootSha !== 'string' || !/^[0-9a-f]{40}$/u.test(hostBootSha)) {
    throw new Error('native resident report has no valid HOST boot SHA')
  }
  if (boundary === 'generation-reload') {
    if (!isAlive(current.residentPid)) throw new Error(`resident pid ${current.residentPid} is not alive`)
    if (residentPid !== current.residentPid || ready.runId !== current.internalRunId) {
      throw new Error('generation-reload requires unchanged resident PID and internal run ID')
    }
  } else if (boundary === 'resident-restart') {
    if (!Number.isInteger(residentPid) || !isAlive(residentPid)) throw new Error(`resident pid ${residentPid} is not alive`)
    if (residentPid === current.residentPid || ready.runId === current.internalRunId) {
      throw new Error('resident-restart requires a new resident PID and internal run ID')
    }
    if (hostBootSha !== ready.sourceSha) throw new Error('resident restart HOST boot SHA does not match the new resident source')
  } else {
    throw new Error(`unsupported boundary ${boundary}`)
  }
  return { live, hostBootSha }
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const registryPath = o.registry ?? DEFAULT_REGISTRY
  const required = ['minor', 'sha', 'boundary']
  for (const k of required) if (typeof o[k] !== 'string') throw new Error(`--${k} required`)
  if (!/^[0-9a-f]{40}$/u.test(o.sha)) throw new Error('--sha must be a full 40-hex commit')
  if (o.boundary !== 'generation-reload' && o.boundary !== 'resident-restart') {
    throw new Error('--boundary must be generation-reload|resident-restart')
  }

  const current = readRegistry(registryPath)
  if (current === null || current.record !== 'capability-active-run') throw new Error(`no registry at ${registryPath}`)
  if (current.status !== 'active') throw new Error(`registry status=${current.status}, refusing swap on non-active run`)

  const logPath = o.log ?? o['resident-stdout'] ?? current.residentStdout
  if (typeof logPath !== 'string' || !existsSync(logPath)) throw new Error(`resident log not found: ${logPath}`)
  const ready = lastGenerationReady(logPath)
  if (ready === null) throw new Error(`no GENERATION_READY in ${logPath}`)
  if (ready.sourceSha !== o.sha) {
    throw new Error(`GENERATION_READY sourceSha=${ready.sourceSha} != --sha ${o.sha}; refusing unverified provenance`)
  }

  const runtimeDir = o['runtime-dir'] ?? current.runtimeDir
  if (typeof runtimeDir !== 'string' || !existsSync(runtimeDir)) throw new Error(`runtime directory missing: ${runtimeDir}`)
  const residentPid = o.boundary === 'generation-reload' ? current.residentPid : Number(o['resident-pid'])
  const residentReport = await readResidentReport(join(runtimeDir, 'data', 'resident', 'control.sock'), 2000)
  const { hostBootSha } = verifyLiveGenerationForSwap({
    current, ready, boundary: o.boundary, residentPid, report: residentReport,
  })

  const fields = {
    activeMinor: o.minor,
    segmentId: o.minor,
    sha: o.sha,
    generationSourceSha: o.sha,
    activeGenerationId: ready.generationId,
    internalRunId: ready.runId,
    boundary: o.boundary,
  }

  if (o.boundary === 'generation-reload') {
    // Connection preserved: resident pid + internal runId must be unchanged.
    if (typeof current.internalRunId === 'string' && ready.runId !== current.internalRunId) {
      throw new Error(`generation-reload requires unchanged internal runId (registry=${current.internalRunId}, log=${ready.runId})`)
    }
    if (!pidAlive(current.residentPid)) throw new Error(`resident pid ${current.residentPid} is not alive`)
    fields.residentPid = current.residentPid
    fields.hostBootSha = hostBootSha
  } else {
    const pid = Number(o['resident-pid'])
    fields.residentPid = pid
    fields.hostBootSha = hostBootSha
    if (typeof o['resident-stdout'] === 'string') fields.residentStdout = o['resident-stdout']
  }

  if (typeof o['runtime-dir'] === 'string') {
    fields.runtimeDir = o['runtime-dir']
  }
  fields.lifecycle = 'active'

  const next = updateActiveRunMinor(fields, registryPath)
  process.stdout.write(`${JSON.stringify({ ok: true, boundary: o.boundary, activeMinor: next.activeMinor, sha: next.sha, generationSourceSha: next.generationSourceSha, internalRunId: next.internalRunId, residentPid: next.residentPid, hostBootSha: next.hostBootSha }, null, 2)}\n`)
}

if (import.meta.main) {
  try { await main() } catch (error) {
    process.stderr.write(`capability-minor-swap: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
