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

function main() {
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
    fields.hostBootSha = current.hostBootSha ?? current.sha
  } else {
    const pid = Number(o['resident-pid'])
    if (!pidAlive(pid)) throw new Error(`--resident-pid ${o['resident-pid']} is not alive`)
    fields.residentPid = pid
    fields.hostBootSha = o.sha
    if (typeof o['resident-stdout'] === 'string') fields.residentStdout = o['resident-stdout']
  }

  if (typeof o['runtime-dir'] === 'string') {
    if (!existsSync(o['runtime-dir'])) throw new Error(`--runtime-dir missing: ${o['runtime-dir']}`)
    fields.runtimeDir = o['runtime-dir']
  }

  const next = updateActiveRunMinor(fields, registryPath)
  process.stdout.write(`${JSON.stringify({ ok: true, boundary: o.boundary, activeMinor: next.activeMinor, sha: next.sha, generationSourceSha: next.generationSourceSha, internalRunId: next.internalRunId, residentPid: next.residentPid, hostBootSha: next.hostBootSha }, null, 2)}\n`)
}

if (import.meta.main) {
  try { main() } catch (error) {
    process.stderr.write(`capability-minor-swap: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
