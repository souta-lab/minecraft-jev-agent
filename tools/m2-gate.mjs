#!/usr/bin/env bun
// m2-gate: run-scoped PASS/FAIL/UNKNOWN gate for the CURRENT M2 contract
// (MILESTONE-CONTRACT.json M2 "Diamond-to-Nether-gate closed loop").
//
// The four M2 gameplay stages and the real-policy/System2 authority proof are
// judged from ONE runId only:
//   diamond_ready          <- diamond>=3 AND diamond_pickaxe in the inventory
//   portal_materials_ready <- flint_and_steel held AND obsidian>=10
//   portal_built           <- a validated 4x5 obsidian frame (portal_frame_verified)
//   portal_lit             <- PORTAL_LIT in minecraft:overworld then PORTAL_VERIFIED=true
//
// Gameplay evidence is the runtime's own markers, all bound to the single runId:
//   * the resident log, bracketed by its BOOT runId boundary: every INVENTORY /
//     MILESTONE line carries the live item counts, and the portal markers carry
//     the ordered frame -> light -> verify chain;
//   * the run-scoped snapshot `m2-snapshot-<runId>.json` (marker inventories and
//     any marker lines), the same record tools/m2-acceptance.mjs consumes.
//
// `--run <runId>` (or M2_RUN_ID) is MANDATORY. Evidence from another run is
// never attributed to R, so a run's facts can never be combined with another
// run's. Missing/unbound evidence is UNKNOWN and NEVER PASS. A known portal
// failure (shape=bad, PORTAL_LIGHT_REFUSED, PORTAL_VERIFIED=false) is FAIL.
// A gameplay-complete run is still UNKNOWN unless that same run proves Jev
// decisions, typesafe policy, planner=llm with deterministic fallback disabled,
// and at least one model-authored System2 portal plan.
// The old iron-age markers (PREREQ_OPTION/FURNACE_READY/SMELT_DONE) are NOT
// required: they are historical M2 evidence, not the current contract.
//
// Exit: 0 = PASS, 1 = FAIL (known portal failure), 2 = UNKNOWN.
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateCurrentM2AuthorityEvidence, loadPolicyEvidence } from './m2-policy-evidence.mjs'

export const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/
export const M2_RUN_RESULT = 'M2_RUN_RESULT'
export const M2_RUN_GATE = 'M2_RUN_GATE'

/** The four contract stages, in dependency order. */
export const M2_REQUIRED_STAGES = Object.freeze([
  'diamond_ready',
  'portal_materials_ready',
  'portal_built',
  'portal_lit',
])

/** Marker names emitted by the portal runtime (netherPortalPlan.ts:37-45). */
export const PORTAL_MARKERS = Object.freeze([
  'PORTAL_BLOCK_PLACED',
  'PORTAL_FRAME_READY',
  'PORTAL_LIT',
  'PORTAL_VERIFIED',
  'PORTAL_LIGHT_REFUSED',
])

/** A valid obsidian frame needs at least the 10 edge blocks (corners optional). */
export const PORTAL_OBSIDIAN_REQUIRED = 10
export const DIAMOND_READY_COUNT = 3
export const MATERIALS_OBSIDIAN_REQUIRED = 10
export const OVERWORLD = 'minecraft:overworld'
export const DIAMOND = 'diamond'
export const DIAMOND_PICKAXE = 'diamond_pickaxe'
export const FLINT_AND_STEEL = 'flint_and_steel'
export const OBSIDIAN = 'obsidian'
/** matcher for the run-scoped snapshot record written by buddy-driver/m2-snapshot.ts */
export const M2_GATE_SNAPSHOT_RECORD = 'm2-snapshot'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(TOOLS_DIR)
export const M2_GATE_LOG =
  process.env.M2_GATE_LOG ?? process.env.M2_LOG ?? process.env.BUDDY_LOG ?? join(REPO_ROOT, 'buddy-driver', 'buddy.log')
export const M2_GATE_SNAPSHOT_DIR =
  process.env.M2_GATE_SNAPSHOT_DIR ?? process.env.M2_SNAPSHOT_DIR ?? join(REPO_ROOT, 'buddy-driver', 'data', 'resident')
export const M2_GATE_DECISIONS =
  process.env.M2_DECISIONS ?? join(REPO_ROOT, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl')
export const M2_GATE_RUNNER_OUT =
  process.env.M2_RUNNER_OUT ?? join(REPO_ROOT, 'buddy-driver', 'runner.out')
export const M2_GATE_CONTROL_SOCK =
  process.env.M2_CONTROL_SOCK ?? join(REPO_ROOT, 'buddy-driver', 'data', 'resident', 'control.sock')

const POS_RE = /pos=(-?\d+),(-?\d+),(-?\d+)/

const INVENTORY_RE = /\b(?:items|inventory)=(\{[^{}]*\})/

/**
 * `dimension=<id>` observations inside a run-bound line. Additive: the M3 gate
 * reports the dimension it observed, while the M2 stages ignore this field.
 */
const DIMENSION_RE = /\bdimension=(minecraft:[a-z_]+|[a-z_]+)\b/

/** Read-only current-run binding used only to bound live policy evidence. */
export async function readPolicySocketBinding(sockPath = M2_GATE_CONTROL_SOCK, timeoutMs = 1500) {
  if (!existsSync(sockPath)) return null
  return await new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch {}
      resolve(value)
    }
    try {
      socket = net.createConnection(sockPath)
    } catch {
      return finish(null)
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const reply = JSON.parse(buffer.slice(0, newline))
        const data = reply?.data ?? reply
        const runId = typeof data?.runId === 'string' ? data.runId : null
        if (runId === null) return finish(null)
        const status = data?.status
        finish({
          runId,
          policyKind: typeof status?.policyKind === 'string' ? status.policyKind : typeof data?.policyKind === 'string' ? data.policyKind : null,
          policyModel: typeof status?.policyModel === 'string' ? status.policyModel : typeof data?.policyModel === 'string' ? data.policyModel : null,
        })
      } catch {
        finish(null)
      }
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'm2-gate', cmd: 'report' })}\n`))
  })
}

// ---------------------------------------------------------------------------
// marker parsing
// ---------------------------------------------------------------------------

/**
 * Parse one runtime line into a portal marker event, or null. The markers are
 * matched by their full shape (not just a name) so a name alone can never claim
 * `shape=ok` or `PORTAL_VERIFIED=true`.
 */
export function parsePortalMarker(line) {
  if (typeof line !== 'string') return null
  const verified = /\bPORTAL_VERIFIED=(true|false)\b/.exec(line)
  if (verified !== null) return { name: 'PORTAL_VERIFIED', verified: verified[1] === 'true' }
  const frame = /\bPORTAL_FRAME_READY\b/.exec(line)
  if (frame !== null) {
    const blocks = /\bblocks=(\d+)/.exec(line)
    const shape = /\bshape=(ok|bad)\b/.exec(line)
    const pos = POS_RE.exec(line)
    return {
      name: 'PORTAL_FRAME_READY',
      blocks: blocks === null ? null : Number(blocks[1]),
      shape: shape === null ? null : shape[1],
      ...(pos === null ? {} : { pos: [Number(pos[1]), Number(pos[2]), Number(pos[3])] }),
    }
  }
  const lit = /\bPORTAL_LIT\b/.exec(line)
  if (lit !== null) {
    const pos = POS_RE.exec(line)
    const dimension = /\bdimension=(\S+)/.exec(line)
    return {
      name: 'PORTAL_LIT',
      ...(pos === null ? {} : { pos: [Number(pos[1]), Number(pos[2]), Number(pos[3])] }),
      ...(dimension === null ? {} : { dimension: dimension[1] }),
    }
  }
  if (/\bPORTAL_LIGHT_REFUSED\b/.test(line)) return { name: 'PORTAL_LIGHT_REFUSED' }
  const placed = /\bPORTAL_BLOCK_PLACED\b/.exec(line)
  if (placed !== null) {
    const pos = POS_RE.exec(line)
    return { name: 'PORTAL_BLOCK_PLACED', ...(pos === null ? {} : { pos: [Number(pos[1]), Number(pos[2]), Number(pos[3])] }) }
  }
  return null
}

/** A flat item-count map, or null when the JSON is not a plain number map. */
export function asCounts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const counts = {}
  for (const [item, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) return null
    counts[item] = count
  }
  return counts
}

/** Parse the live item counts out of an INVENTORY / MILESTONE / M2_SNAPSHOT line. */
export function parseInventoryMarker(line) {
  if (typeof line !== 'string') return null
  const match = INVENTORY_RE.exec(line)
  if (match === null) return null
  let parsed
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  return asCounts(parsed)
}

function normalizeDimension(dimension) {
  return typeof dimension === 'string' ? dimension.replace(/^minecraft:/, '').toLowerCase() : null
}

// ---------------------------------------------------------------------------
// ordered chain + known failures
// ---------------------------------------------------------------------------

/**
 * The ordered portal chain inside one evidence source: at least one block placed,
 * then a validated frame (shape=ok, blocks >= 10), then the light, then a true
 * verification. `litDimension` is the dimension reported by the PORTAL_LIT line.
 */
export function evaluatePortalChain(events) {
  const seq = Array.isArray(events) ? events : []
  const placed = seq.findIndex((event) => event?.name === 'PORTAL_BLOCK_PLACED')
  const frame = seq.findIndex(
    (event) =>
      event?.name === 'PORTAL_FRAME_READY' &&
      event.shape === 'ok' &&
      Number.isFinite(event.blocks) &&
      event.blocks >= PORTAL_OBSIDIAN_REQUIRED,
  )
  const frameVerified = placed !== -1 && frame !== -1 && frame > placed
  let lit = -1
  let verified = -1
  if (frameVerified) {
    lit = seq.findIndex((event, index) => index > frame && event?.name === 'PORTAL_LIT')
    if (lit !== -1) {
      verified = seq.findIndex(
        (event, index) => index > lit && event?.name === 'PORTAL_VERIFIED' && event.verified === true,
      )
    }
  }
  const litVerified = frameVerified && lit !== -1 && verified !== -1
  const litDimension = lit === -1 ? null : seq[lit].dimension ?? null
  return { frameVerified, litVerified, litDimension, indices: { placed, frame, lit, verified } }
}

/** A known terminal portal failure in this evidence, or null. */
export function detectPortalFailure(events) {
  const seq = Array.isArray(events) ? events : []
  if (seq.some((event) => event?.name === 'PORTAL_FRAME_READY' && event.shape !== 'ok')) return 'portal_frame_shape_bad'
  if (seq.some((event) => event?.name === 'PORTAL_LIGHT_REFUSED')) return 'portal_light_refused'
  if (seq.some((event) => event?.name === 'PORTAL_VERIFIED' && event.verified === false)) return 'portal_verify_false'
  return null
}

// ---------------------------------------------------------------------------
// the four stage conditions (facts are joined only inside ONE runId)
// ---------------------------------------------------------------------------

/** diamond_ready = diamond>=3 AND a diamond_pickaxe observed in the same run. */
export function evaluateDiamondReady(samples) {
  const list = Array.isArray(samples) ? samples : []
  const hasDiamond = list.some((counts) => (counts?.[DIAMOND] ?? 0) >= DIAMOND_READY_COUNT)
  const hasDiamondPickaxe = list.some((counts) => (counts?.[DIAMOND_PICKAXE] ?? 0) >= 1)
  return { ready: hasDiamond && hasDiamondPickaxe, hasDiamond, hasDiamondPickaxe }
}

/** portal_materials_ready = flint_and_steel held AND obsidian>=10 in the same run. */
export function evaluateMaterialsReady(samples) {
  const list = Array.isArray(samples) ? samples : []
  const hasFlintAndSteel = list.some((counts) => (counts?.[FLINT_AND_STEEL] ?? 0) >= 1)
  const hasObsidian = list.some((counts) => (counts?.[OBSIDIAN] ?? 0) >= MATERIALS_OBSIDIAN_REQUIRED)
  return { ready: hasFlintAndSteel && hasObsidian, hasFlintAndSteel, hasObsidian }
}

function unknownConditions() {
  return {
    diamond_ready: 'UNKNOWN',
    portal_materials_ready: 'UNKNOWN',
    portal_built: 'UNKNOWN',
    portal_lit: 'UNKNOWN',
  }
}

function verdict({ status, code, reason, runId, conditions, evidence = null, sources = null, facts = null }) {
  return { id: 'M2', status, code, reason, runId, conditions, evidence, sources, facts }
}

/**
 * Pure run-scoped M2 verdict. PASS (0) only when all four stages are proven from
 * R-bound markers. A known portal failure is FAIL (1). Everything else is
 * UNKNOWN (2) and can never be PASS.
 */
export function evaluateM2Gate({ expectedRunId = null, evidence = null, policy = null } = {}) {
  if (expectedRunId === null || !RUN_ID_RE.test(String(expectedRunId))) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: 'exact_run_scope_required',
      runId: expectedRunId,
      conditions: unknownConditions(),
    })
  }
  if (evidence === null || typeof evidence !== 'object' || evidence.status !== 'valid') {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: evidence?.reason ?? 'm2_evidence_unavailable',
      runId: expectedRunId,
      conditions: unknownConditions(),
      evidence: evidence?.status ?? 'unavailable',
      sources: evidence?.sources ?? null,
    })
  }

  const sources = Array.isArray(evidence.sources) ? evidence.sources : []
  const samples = sources.flatMap((source) => (Array.isArray(source.inventorySamples) ? source.inventorySamples : []))
  const diamond = evaluateDiamondReady(samples)
  const materials = evaluateMaterialsReady(samples)

  const perSource = sources.map((source) => ({
    name: source.name,
    path: source.path,
    chain: evaluatePortalChain(source.portalEvents),
    failure: detectPortalFailure(source.portalEvents),
  }))
  const framePass = perSource.some((source) => source.chain.frameVerified)
  const litPass = perSource.some(
    (source) => source.chain.litVerified && normalizeDimension(source.chain.litDimension) === normalizeDimension(OVERWORLD),
  )
  const frameFail = !framePass && perSource.some((source) => source.failure === 'portal_frame_shape_bad')
  const litFail =
    !litPass && perSource.some((source) => source.failure === 'portal_light_refused' || source.failure === 'portal_verify_false')

  const conditions = {
    diamond_ready: diamond.ready ? 'PASS' : 'UNKNOWN',
    portal_materials_ready: materials.ready ? 'PASS' : 'UNKNOWN',
    portal_built: framePass ? 'PASS' : frameFail ? 'FAIL' : 'UNKNOWN',
    portal_lit: litPass ? 'PASS' : litFail ? 'FAIL' : 'UNKNOWN',
  }
  const facts = { diamond, materials, framePass, litPass, policy: policy?.facts ?? null }
  const allPass = Object.values(conditions).every((value) => value === 'PASS')
  const failureReason = conditions.portal_built === 'FAIL'
    ? 'portal_frame_shape_bad'
    : conditions.portal_lit === 'FAIL'
      ? 'portal_not_verified'
      : null
  if (failureReason !== null) {
    return verdict({
      status: 'FAIL',
      code: 1,
      reason: failureReason,
      runId: expectedRunId,
      conditions,
      sources: perSource,
      facts,
    })
  }
  if (allPass && policy?.code !== 0) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `policy_evidence_unverified:${policy?.reason ?? 'unavailable'}`,
      runId: expectedRunId,
      conditions,
      sources: perSource,
      facts,
    })
  }
  if (allPass) {
    return verdict({
      status: 'PASS',
      code: 0,
      reason: 'diamond_to_nether_gate_verified',
      runId: expectedRunId,
      conditions,
      sources: perSource,
      facts,
    })
  }
  const missing = M2_REQUIRED_STAGES.filter((stage) => conditions[stage] !== 'PASS')
  return verdict({
    status: 'UNKNOWN',
    code: 2,
    reason: `m2_stages_incomplete:${missing.join(',')}`,
    runId: expectedRunId,
    conditions,
    sources: perSource,
    facts,
  })
}

// ---------------------------------------------------------------------------
// evidence readers (all bound to ONE runId)
// ---------------------------------------------------------------------------

function runIdOfLine(line) {
  return typeof line === 'string' ? /\brunId=(run-[A-Za-z0-9-]+)/.exec(line)?.[1] ?? null : null
}

function isBootLine(line) {
  return typeof line === 'string' && /\bBOOT\b(?!_)/.test(line)
}

/**
 * Attribute every portal marker and inventory sample to exactly one run. A BOOT
 * line opens a run boundary; a line without `runId=` belongs to the active
 * (most recent) BOOT, as in tools/m2-watch.mjs. Foreign-run lines are never
 * attributed to R. Returns `unknown` when NO line can be attributed to R, so an
 * unreadable/unscoped run can never produce a PASS.
 */
export function scanRunLines(runId, lines) {
  const portalEvents = []
  const inventorySamples = []
  const dimensionObservations = []
  const foreignRuns = new Set()
  let activeRunId = null
  let bootSeen = false
  for (const line of Array.isArray(lines) ? lines : []) {
    const bootRunId = isBootLine(line) ? runIdOfLine(line) : null
    if (bootRunId !== null) {
      activeRunId = bootRunId
      if (bootRunId === runId) bootSeen = true
    }
    // A marker's own runId field is not a lifetime boundary. Only the real
    // BOOT line may open R; otherwise a copied/stale marker can be attributed
    // to a requested run without proof that R ever existed.
    const owningRunId = activeRunId
    if (owningRunId !== runId) {
      const foreign = runIdOfLine(line) ?? owningRunId
      if (foreign !== null) foreignRuns.add(foreign)
      continue
    }
    const portal = parsePortalMarker(line)
    if (portal !== null) portalEvents.push(portal)
    const inventory = parseInventoryMarker(line)
    if (inventory !== null) inventorySamples.push(inventory)
    const dimension = DIMENSION_RE.exec(line)
    if (dimension !== null) dimensionObservations.push(dimension[1])
  }
  if (!bootSeen) {
    return {
      status: 'unknown',
      reason: `run_boundary_missing runId=${runId}`,
      portalEvents: [],
      inventorySamples: [],
      dimensionObservations: [],
    }
  }
  return { status: 'valid', portalEvents, inventorySamples, dimensionObservations, foreignRuns: [...foreignRuns] }
}

/** Read and scan the resident log for run R's markers. */
export async function readM2Log(runId, { logPath = M2_GATE_LOG } = {}) {
  if (!existsSync(logPath)) return { status: 'unavailable', path: logPath, portalEvents: [], inventorySamples: [] }
  const lines = []
  const rl = createInterface({ input: createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) lines.push(line)
  return { ...scanRunLines(runId, lines), path: logPath }
}

function snapshotPortalEvents(snapshot) {
  const events = []
  for (const marker of Array.isArray(snapshot?.markers) ? snapshot.markers : []) {
    if (marker === null || typeof marker !== 'object') continue
    if (typeof marker.line === 'string') {
      const parsed = parsePortalMarker(marker.line)
      if (parsed !== null) {
        events.push(Number.isFinite(marker.atMs) ? { ...parsed, atMs: marker.atMs } : parsed)
        continue
      }
    }
    if (typeof marker.name !== 'string' || !PORTAL_MARKERS.includes(marker.name)) continue
    const event = { name: marker.name }
    for (const key of ['blocks', 'shape', 'verified', 'dimension', 'pos']) {
      if (marker[key] !== undefined && marker[key] !== null) event[key] = marker[key]
    }
    if (Number.isFinite(marker.atMs)) event.atMs = marker.atMs
    events.push(event)
  }
  return events
}

function snapshotInventorySamples(snapshot) {
  const samples = []
  const initial = asCounts(snapshot?.initialInventory)
  if (initial !== null) samples.push(initial)
  for (const marker of Array.isArray(snapshot?.markers) ? snapshot.markers : []) {
    const counts = asCounts(marker?.inventory)
    if (counts !== null) samples.push(counts)
  }
  const latest = asCounts(snapshot?.inventory)
  if (latest !== null) samples.push(latest)
  const terminal = asCounts(snapshot?.terminal?.inventory)
  if (terminal !== null) samples.push(terminal)
  return samples
}

/** Read the run-scoped snapshot `m2-snapshot-<runId>.json` for run R only. */
export function readM2Snapshot(runId, { snapshotDir = M2_GATE_SNAPSHOT_DIR } = {}) {
  const path = `${snapshotDir}/${M2_GATE_SNAPSHOT_RECORD}-${runId}.json`
  if (!existsSync(path)) return { status: 'unavailable', path, portalEvents: [], inventorySamples: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { status: 'unknown', path, portalEvents: [], inventorySamples: [], reason: `snapshot_unreadable ${path}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unknown', path, portalEvents: [], inventorySamples: [], reason: `snapshot_malformed ${path}` }
  }
  if (parsed.record !== M2_GATE_SNAPSHOT_RECORD) {
    return {
      status: 'unknown',
      path,
      portalEvents: [],
      inventorySamples: [],
      reason: `snapshot_record_mismatch expected=${M2_GATE_SNAPSHOT_RECORD} observed=${String(parsed.record)}`,
    }
  }
  if (parsed.runId !== runId) {
    return {
      status: 'unknown',
      path,
      portalEvents: [],
      inventorySamples: [],
      reason: `snapshot_run_mismatch expected=${runId} observed=${typeof parsed.runId === 'string' ? parsed.runId : 'unknown'}`,
    }
  }
  return { status: 'valid', path, portalEvents: snapshotPortalEvents(parsed), inventorySamples: snapshotInventorySamples(parsed) }
}

/**
 * Resolve every run-scoped M2 source for R. Each source is independently
 * attributed to R; a foreign/unknown source is recorded as a mismatch and never
 * used. Returns `valid` only when at least one R-bound source carries evidence.
 */
export async function readRunScopedM2Evidence(runId, { logPath = M2_GATE_LOG, snapshotDir = M2_GATE_SNAPSHOT_DIR } = {}) {
  const sources = []
  const mismatches = []
  const snapshot = readM2Snapshot(runId, { snapshotDir })
  if (snapshot.status === 'valid' && (snapshot.portalEvents.length > 0 || snapshot.inventorySamples.length > 0)) {
    sources.push({
      name: 'snapshot',
      path: snapshot.path,
      portalEvents: snapshot.portalEvents,
      inventorySamples: snapshot.inventorySamples,
      // Dimension is only recorded on portal markers; the M3 gate reports it as
      // an intermediate fact without requiring a portal chain.
      dimensionObservations: snapshot.portalEvents.map((event) => event.dimension).filter((value) => typeof value === 'string'),
    })
  } else if (snapshot.status === 'unknown') {
    mismatches.push(snapshot.reason)
  }
  const log = await readM2Log(runId, { logPath })
  if (log.status === 'valid' && (log.portalEvents.length > 0 || log.inventorySamples.length > 0)) {
    sources.push({
      name: 'log',
      path: log.path,
      portalEvents: log.portalEvents,
      inventorySamples: log.inventorySamples,
      dimensionObservations: log.dimensionObservations ?? [],
    })
  } else if (log.status === 'unknown') {
    mismatches.push(log.reason)
  }
  if (sources.length === 0) {
    return {
      status: mismatches.length > 0 ? 'unknown' : 'unavailable',
      runId,
      sources: [],
      mismatches,
      reason: mismatches[0] ?? 'no_run_scoped_m2_evidence',
    }
  }
  return { status: 'valid', runId, sources, mismatches }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export function requestedRunId(argv = process.argv.slice(2), env = process.env) {
  let value = env.M2_RUN_ID ?? null
  const index = argv.indexOf('--run')
  if (index !== -1) value = argv[index + 1] ?? null
  if (value === null || String(value).trim() === '') return null
  const runId = String(value).trim()
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid --run value: ${value}`)
  return runId
}

export async function runM2Gate({
  expectedRunId = null,
  readEvidence = null,
  logPath = M2_GATE_LOG,
  snapshotDir = M2_GATE_SNAPSHOT_DIR,
  policyEvidence = null,
  loadPolicy = loadPolicyEvidence,
  policySocket = undefined,
  controlSocketPath = M2_GATE_CONTROL_SOCK,
  decisionsPath = M2_GATE_DECISIONS,
  runnerOutPath = M2_GATE_RUNNER_OUT,
  now = () => new Date(),
  write = (line) => process.stdout.write(`${line}\n`),
  json = false,
} = {}) {
  const stamp = now().toISOString()
  const resolveEvidence = readEvidence ?? ((runId) => readRunScopedM2Evidence(runId, { logPath, snapshotDir }))
  const scoped = expectedRunId !== null && RUN_ID_RE.test(String(expectedRunId))
  const evidence = scoped ? await resolveEvidence(expectedRunId) : null
  let rawPolicy = policyEvidence
  if (scoped && rawPolicy === null) {
    const socketBinding = policySocket === undefined
      ? await readPolicySocketBinding(controlSocketPath)
      : policySocket
    rawPolicy = await loadPolicy({
      runId: expectedRunId,
      socket: socketBinding?.runId === expectedRunId ? socketBinding : null,
      decisionsPath,
      runnerOutPath,
    })
  }
  const policy = scoped
    ? evaluateCurrentM2AuthorityEvidence({
        expectedRunId,
        decisions: rawPolicy?.decisions ?? null,
        generation: rawPolicy?.generation ?? null,
        system2: rawPolicy?.system2 ?? null,
      })
    : null
  const result = evaluateM2Gate({ expectedRunId, evidence, policy })

  if (json) {
    write(
      JSON.stringify({
        id: result.id,
        status: result.status,
        reason: result.reason,
        runId: result.runId,
        conditions: result.conditions,
        evidence: evidence === null ? null : { status: evidence.status, sources: (evidence.sources ?? []).map((s) => s.name) },
        policy: policy === null ? null : { status: policy.status, reason: policy.reason },
        facts: result.facts ?? null,
      }),
    )
    return result.code
  }

  write(`${M2_RUN_GATE} — ${stamp}`)
  write(`expectedRunId: ${expectedRunId ?? 'none'}`)
  if (evidence !== null) {
    const sourceNames = (evidence.sources ?? []).map((source) => source.name).join(',')
    write(`m2_evidence: ${evidence.status} sources=${sourceNames || 'none'}${evidence.reason ? ` reason=${evidence.reason}` : ''}`)
  }
  for (const stage of M2_REQUIRED_STAGES) write(`${stage}: ${result.conditions[stage]}`)
  if (policy !== null) write(`policy: ${policy.status} reason=${policy.reason}`)
  if (result.facts !== null) {
    write(
      `m2_facts: diamond=${result.facts.diamond.hasDiamond} diamond_pickaxe=${result.facts.diamond.hasDiamondPickaxe} ` +
        `flint_and_steel=${result.facts.materials.hasFlintAndSteel} obsidian=${result.facts.materials.hasObsidian} ` +
        `frame=${result.facts.framePass} lit=${result.facts.litPass}`,
    )
  }
  write(
    `${M2_RUN_RESULT} status=${result.status} reason=${result.reason} runId=${expectedRunId ?? 'none'} ` +
      `diamond=${result.conditions.diamond_ready} materials=${result.conditions.portal_materials_ready} ` +
      `frame=${result.conditions.portal_built} lit=${result.conditions.portal_lit}`,
  )
  return result.code
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { log: null, snapshotDir: null, decisions: null, runnerOut: null, controlSocket: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--run') i += 1
    else if (arg === '--log') out.log = argv[++i] ?? null
    else if (arg === '--snapshot-dir') out.snapshotDir = argv[++i] ?? null
    else if (arg === '--decisions') out.decisions = argv[++i] ?? null
    else if (arg === '--runner-out') out.runnerOut = argv[++i] ?? null
    else if (arg === '--control-socket') out.controlSocket = argv[++i] ?? null
    else if (arg === '--json') out.json = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const expectedRunId = requestedRunId(process.argv.slice(2), process.env)
    const options = {
      expectedRunId,
      json: args.json,
      logPath: args.log ?? M2_GATE_LOG,
      snapshotDir: args.snapshotDir ?? M2_GATE_SNAPSHOT_DIR,
      decisionsPath: args.decisions ?? M2_GATE_DECISIONS,
      runnerOutPath: args.runnerOut ?? M2_GATE_RUNNER_OUT,
      controlSocketPath: args.controlSocket ?? M2_GATE_CONTROL_SOCK,
    }
    process.exitCode = await runM2Gate(options)
  } catch (error) {
    process.stderr.write(`M2_GATE_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
