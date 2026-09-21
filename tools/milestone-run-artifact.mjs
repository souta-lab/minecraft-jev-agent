#!/usr/bin/env bun
// milestone-run-artifact: assemble ONE machine-readable, run-scoped artifact for
// an exact resident runId.
//
// This tool is a READER/ASSEMBLER, never a judge of its own:
//   1. it reads the existing run-scoped evidence (BOOT line, inventory markers,
//      dimension / spawn / environment observations, the run-scoped
//      `m2-snapshot-<runId>.json`, the run-scoped `acceptance-<runId>.json` and,
//      only when explicitly asked, the resident's server.properties);
//   2. it obtains the milestone verdicts by delegating to the EXISTING gates
//      (tools/m2-gate.mjs `runM2Gate`, tools/m3-gate.mjs `runM3Gate`) with the
//      SAME run-scoped evidence paths, and embeds their exact verdict lines.
//      It never re-implements a gate predicate and never turns UNKNOWN into PASS;
//   3. every fact it could not obtain is named in `missingEvidence`, and a
//      missing fact is always an UNKNOWN/exit-2 outcome, never a quiet absence.
//
// Run isolation
// -------------
// Every log fact is attributed to the requested runId by the SAME BOOT-boundary
// rule the gates use (tools/m2-gate.mjs `scanRunLines`): a `BOOT ... runId=R`
// line opens R's lifetime, a later BOOT for another run closes it, and lines
// before any BOOT belong to no run. The tool additionally cross-checks its own
// timestamped attribution against `scanRunLines` and reports any divergence in
// `missingEvidence`. The snapshot filename AND body must name runId, and the
// acceptance artifact filename AND body must name runId, or they are ignored.
// Evidence from two different runs can never be joined into one artifact.
//
// Usage:
//   bun tools/milestone-run-artifact.mjs --run <runId> [--root <tree>] [--out <path>]
//   bun tools/milestone-run-artifact.mjs --run <runId> --json
//   bun tools/milestone-run-artifact.mjs --help
//
// Exit codes:
//   0  artifact complete AND both gates report a definite PASS
//   1  at least one gate reports FAIL (the definite verdict is recorded as-is)
//   2  UNKNOWN / missing evidence / usage error (including a missing --run)
//
// This file is intentionally dependency-free beyond the repository gates.
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  RUN_ID_RE,
  asCounts,
  parseInventoryMarker,
  readM2Snapshot,
  readPolicySocketBinding,
  runM2Gate,
  scanRunLines,
} from './m2-gate.mjs'
import { runM3Gate } from './m3-gate.mjs'
import { loadPolicyEvidence } from './m2-policy-evidence.mjs'

export const RECORD = 'milestone-run-artifact'
export const SCHEMA_VERSION = 1
export const DEFAULT_ROOT = '/home/s0u7a/mc-ai-worktrees/m3-live'

/** The M3-relevant inventory subset, in a stable order. */
export const MILESTONE_ITEMS = Object.freeze(['ender_pearl', 'blaze_rod', 'blaze_powder', 'ender_eye'])

/** server.properties keys the artifact is willing to echo (never credentials). */
export const SERVER_PROPERTY_KEYS = Object.freeze([
  'difficulty',
  'spawn-monsters',
  'spawn-animals',
  'level-name',
  'level-seed',
  'gamemode',
  'pvp',
])

const TS_RE = /^\[([^\]]+)\]/
const BOOT_RE = /\bBOOT\b(?!_)/
const DIMENSION_RE = /\bdimension=([A-Za-z0-9:_]+)/
const RUN_ID_LINE_RE = /\brunId=(run-[A-Za-z0-9-]+)/
const ENV_MARKER_RE = /\b(?:ENVIRONMENT|SERVER_ENV|SERVER_CONFIG|WORLD_ENV|GAMERULES?)\b/
const SERVER_LINE_RE = /\b(?:SPAWN|SERVER_VERSION|SERVER_START)\b/
const KV_RE = /(?:^|\s)([A-Za-z_][A-Za-z0-9_-]*)=("(?:[^"\\]|\\.)*"|\{[^{}]*\}|\[[^[\]]*\]|\S+)/g

// ---------------------------------------------------------------------------
// small parsing helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function booleanOrNull(value) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** ISO timestamp of a `[<iso>] ...` log line, or null. */
export function timestampOf(line) {
  if (typeof line !== 'string') return null
  const match = TS_RE.exec(line)
  if (match === null) return null
  const ms = Date.parse(match[1])
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function timestampMsOf(line) {
  if (typeof line !== 'string') return null
  const match = TS_RE.exec(line)
  if (match === null) return null
  const ms = Date.parse(match[1])
  return Number.isFinite(ms) ? ms : null
}

/**
 * Tolerant `key=value` reader. Values that look like JSON objects/arrays are
 * parsed; quoted strings are unquoted. Only the first `(?:^|\s)` occurrence of a
 * key is matched, so JSON `"key":` inside an already-consumed value is ignored.
 */
export function parseKeyValues(line) {
  const out = {}
  if (typeof line !== 'string') return out
  for (const match of line.matchAll(KV_RE)) {
    const key = match[1]
    const raw = match[2]
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try {
        out[key] = JSON.parse(raw)
        continue
      } catch {
        out[key] = raw.slice(1, -1)
        continue
      }
    }
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try {
        out[key] = JSON.parse(raw)
        continue
      } catch {
        /* fall through to the raw string */
      }
    }
    out[key] = raw
  }
  return out
}

/** Parse a run-open `BOOT ...` line into its identity fields, or null. */
export function parseBootLine(line) {
  if (typeof line !== 'string' || !BOOT_RE.test(line)) return null
  const kv = parseKeyValues(line)
  if (typeof kv.runId !== 'string' || !RUN_ID_RE.test(kv.runId)) return null
  return {
    ts: timestampOf(line),
    pid: numberOrNull(kv.pid),
    runId: kv.runId,
    sourceSha: stringOrNull(kv.source),
    runtime: stringOrNull(kv.runtime),
    runtimeVersion: stringOrNull(kv.runtimeVersion),
    bundle: stringOrNull(kv.bundle),
    milestone: kv.milestone === 'null' ? null : stringOrNull(kv.milestone),
    generationStart: numberOrNull(kv.generations),
    reloads: numberOrNull(kv.reloads),
    contractVersion: numberOrNull(kv.contractVersion),
    schemaVersion: numberOrNull(kv.schemaVersion),
    revision: numberOrNull(kv.revision),
    worldEpoch: numberOrNull(kv.worldEpoch),
    worldKey: isPlainObject(kv.worldKey) ? kv.worldKey : null,
  }
}

/** Parse an `ENVIRONMENT ...` / `GAMERULE ...` marker into environment facts. */
export function parseEnvironmentLine(line) {
  if (typeof line !== 'string' || !ENV_MARKER_RE.test(line)) return null
  const kv = parseKeyValues(line)
  const facts = {}
  const difficulty = stringOrNull(kv.difficulty)
  if (difficulty !== null) facts.difficulty = difficulty.toLowerCase()
  const mobSpawning = booleanOrNull(
    kv.spawnMonsters ?? kv['spawn-monsters'] ?? kv.spawn_monsters ?? kv.spawnMobs ?? kv['spawn-mobs'] ?? kv.spawn_mobs,
  )
  if (mobSpawning !== null) facts.mobSpawning = mobSpawning
  const spawnAnimals = booleanOrNull(kv.spawnAnimals ?? kv['spawn-animals'] ?? kv.spawn_animals)
  if (spawnAnimals !== null) facts.spawnAnimals = spawnAnimals
  const gamerules = {}
  const advanceTime = booleanOrNull(kv.advanceTime ?? kv['advance-time'] ?? kv.advance_time)
  const keepInventory = booleanOrNull(kv.keepInventory ?? kv['keep-inventory'] ?? kv.keep_inventory)
  const spawnMobs = booleanOrNull(kv.spawnMobs ?? kv['spawn-mobs'] ?? kv.spawn_mobs)
  if (advanceTime !== null) gamerules.advanceTime = advanceTime
  if (keepInventory !== null) gamerules.keepInventory = keepInventory
  if (spawnMobs !== null) gamerules.spawnMobs = spawnMobs
  if (Object.keys(gamerules).length > 0) facts.gamerules = gamerules
  return Object.keys(facts).length > 0 ? facts : null
}

/** Parse a run-bound SPAWN/SERVER line for the minecraft server version. */
export function parseServerObservation(line) {
  if (typeof line !== 'string' || !SERVER_LINE_RE.test(line)) return null
  const kv = parseKeyValues(line)
  const fact = {
    serverVersion: stringOrNull(kv.version),
    dimension: stringOrNull(kv.dimension),
    worldEpoch: numberOrNull(kv.worldEpoch),
  }
  return fact.serverVersion === null && fact.dimension === null && fact.worldEpoch === null ? null : fact
}

/** Parse `key=value` properties text (server.properties) into a plain map. */
export function parseServerProperties(text) {
  const values = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return values
}

// ---------------------------------------------------------------------------
// run-bound line attribution (same BOOT rule as tools/m2-gate.mjs scanRunLines)
// ---------------------------------------------------------------------------

function emptyAttribution(reason) {
  return {
    status: 'unknown',
    reason,
    bootLines: [],
    inventorySamples: [],
    dimensionObservations: [],
    environmentObservations: [],
    serverObservations: [],
    foreignRuns: [],
  }
}

/**
 * Attribute every inventory/dimension/environment observation to exactly ONE
 * run, using the gates' BOOT-boundary rule. A BOOT line opens the active run; a
 * later BOOT closes the previous one; lines before any BOOT belong to no run. A
 * non-BOOT line's own `runId=` field is NOT a boundary, so a copied/stale marker
 * can never be attributed to the requested run.
 */
export function attributeRunLines(runId, lines) {
  const bootLines = []
  const inventorySamples = []
  const dimensionObservations = []
  const environmentObservations = []
  const serverObservations = []
  const foreignRuns = new Set()
  let activeRunId = null
  let bootSeen = false
  for (let index = 0; index < (Array.isArray(lines) ? lines.length : 0); index += 1) {
    const line = lines[index]
    if (BOOT_RE.test(line)) {
      const rid = RUN_ID_LINE_RE.exec(line)?.[1] ?? null
      if (rid !== null) {
        activeRunId = rid
        if (rid === runId) {
          bootSeen = true
          bootLines.push({ index, line, ts: timestampOf(line) })
        }
      }
    }
    if (activeRunId !== runId) {
      const foreign = RUN_ID_LINE_RE.exec(line)?.[1] ?? activeRunId
      if (foreign !== null) foreignRuns.add(foreign)
      continue
    }
    const ts = timestampOf(line)
    const counts = parseInventoryMarker(line)
    if (counts !== null) inventorySamples.push({ index, ts, counts })
    const dimension = DIMENSION_RE.exec(line)
    if (dimension !== null) dimensionObservations.push({ index, ts, dimension: dimension[1] })
    const environment = parseEnvironmentLine(line)
    if (environment !== null) environmentObservations.push({ index, ts, ...environment })
    const server = parseServerObservation(line)
    if (server !== null) serverObservations.push({ index, ts, ...server })
  }
  if (!bootSeen) {
    return { ...emptyAttribution(`run_boundary_missing runId=${runId}`), foreignRuns: [...foreignRuns] }
  }
  return {
    status: 'valid',
    reason: null,
    bootLines,
    inventorySamples,
    dimensionObservations,
    environmentObservations,
    serverObservations,
    foreignRuns: [...foreignRuns],
  }
}

// ---------------------------------------------------------------------------
// evidence readers (each independently bound to the requested runId)
// ---------------------------------------------------------------------------

export function derivePaths(root, overrides = {}) {
  const acceptanceDir = overrides.acceptanceDir ?? join(root, 'buddy-driver', 'data', 'resident')
  return {
    logPath: overrides.logPath ?? join(root, 'buddy-driver', 'buddy.log'),
    snapshotDir: overrides.snapshotDir ?? acceptanceDir,
    decisionsPath: overrides.decisionsPath ?? join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'),
    // A worktree resident logs to buddy.log with no runner.out; the gates already fall
    // back to it, so read the authority fields from the stream that actually exists.
    runnerOutPath:
      overrides.runnerOutPath ??
      firstExistingPath([
        join(root, 'buddy-driver', 'runner.out'),
        join(root, 'buddy-driver', 'buddy.log'),
      ]),
    controlSocketPath:
      overrides.controlSocketPath === null
        ? null
        : overrides.controlSocketPath ?? join(root, 'buddy-driver', 'data', 'resident', 'control.sock'),
    acceptanceDir,
    serverProperties: overrides.serverProperties ?? null,
    environment: overrides.environment ?? null,
  }
}

/** Read the run-scoped `m2-snapshot-<runId>.json`, validating record AND body runId. */
export function readSnapshotForRun(runId, snapshotDir) {
  const path = join(snapshotDir, `m2-snapshot-${runId}.json`)
  const viaGate = readM2Snapshot(runId, { snapshotDir })
  let record = null
  if (viaGate.status === 'valid' && existsSync(path)) {
    try {
      record = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      record = null
    }
  }
  return {
    present: viaGate.status === 'valid',
    status: viaGate.status,
    path: viaGate.path ?? path,
    reason: typeof viaGate.reason === 'string' ? viaGate.reason : null,
    record,
  }
}

/** Read the run-scoped `acceptance-<runId>.json`, validating record AND body runId. */
export function readAcceptanceArtifact(runId, acceptanceDir) {
  const path = join(acceptanceDir, `acceptance-${runId}.json`)
  if (!existsSync(path)) return { present: false, path, reason: 'acceptance_artifact_missing', record: null }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { present: false, path, reason: 'acceptance_artifact_unreadable', record: null }
  }
  if (!isPlainObject(parsed) || parsed.record !== 'acceptance') {
    return { present: false, path, reason: `acceptance_record_mismatch observed=${String(parsed?.record)}`, record: null }
  }
  if (parsed.runId !== runId) {
    return {
      present: false,
      path,
      reason: `acceptance_run_mismatch expected=${runId} observed=${String(parsed.runId)}`,
      record: null,
    }
  }
  return { present: true, path, reason: null, record: parsed }
}

/** Read a whitelisted view of server.properties. Never echoes credentials. */
export function readServerProperties(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return null
  let text
  let mtime = null
  try {
    text = readFileSync(path, 'utf8')
    mtime = statSync(path).mtime.toISOString()
  } catch {
    return null
  }
  const all = parseServerProperties(text)
  const values = {}
  for (const key of SERVER_PROPERTY_KEYS) if (all[key] !== undefined) values[key] = all[key]
  return { path, mtime, runScoped: false, values }
}

// ---------------------------------------------------------------------------
// descriptive composition (never a verdict)
// ---------------------------------------------------------------------------

function composeInventory({ attribution, snapshot }) {
  const samples = attribution.inventorySamples.map((sample) => ({ source: 'log', ts: sample.ts, counts: sample.counts }))
  const snapshotInitial = asCounts(snapshot?.record?.initialInventory)
  const snapshotLatest = asCounts(snapshot?.record?.terminal?.inventory) ?? asCounts(snapshot?.record?.inventory)
  let boot = samples[0] ?? null
  let latest = samples.at(-1) ?? null
  if (boot === null && snapshotInitial !== null) boot = { source: 'snapshot', ts: snapshot?.record?.at ?? null, counts: snapshotInitial }
  if (latest === null && snapshotLatest !== null) {
    latest = { source: 'snapshot', ts: snapshot?.record?.terminal?.at ?? null, counts: snapshotLatest }
  }

  // An `INVENTORY items={...}` / `MILESTONE ... inventory={...}` line is a FULL
  // inventory dump: an item absent from the map was observed to be 0, exactly as
  // the gates read it. `observed` therefore means "covered by >=1 sample", while
  // `keySeen` records whether the literal key ever appeared and `held` whether
  // the count ever reached 1. No sample at all => genuinely not observed.
  const milestoneItems = {}
  for (const item of MILESTONE_ITEMS) {
    let keySeen = false
    let firstHeldAt = null
    let lastHeldAt = null
    let max = 0
    for (const sample of samples) {
      if (!Object.prototype.hasOwnProperty.call(sample.counts, item)) continue
      keySeen = true
      const count = sample.counts[item]
      if (count > 0) {
        if (firstHeldAt === null) firstHeldAt = sample.ts
        lastHeldAt = sample.ts
      }
      if (count > max) max = count
    }
    const bootCounts = boot?.counts ?? {}
    const latestCounts = latest?.counts ?? {}
    milestoneItems[item] = {
      observed: samples.length > 0,
      keySeen,
      held: firstHeldAt !== null,
      boot: Object.prototype.hasOwnProperty.call(bootCounts, item) ? bootCounts[item] : 0,
      latest: Object.prototype.hasOwnProperty.call(latestCounts, item) ? latestCounts[item] : 0,
      max,
      firstObservedAt: samples[0]?.ts ?? null,
      lastObservedAt: samples.at(-1)?.ts ?? null,
      firstHeldAt,
      lastHeldAt,
    }
  }

  return {
    source: samples.length > 0 ? 'log' : boot === null && latest === null ? 'none' : 'snapshot',
    observationCount: samples.length,
    boot,
    latest,
    milestoneItems,
    snapshot: {
      present: snapshot?.present ?? false,
      path: snapshot?.path ?? null,
      status: snapshot?.status ?? 'unavailable',
      reason: snapshot?.reason ?? null,
      markerCount: Array.isArray(snapshot?.record?.markers) ? snapshot.record.markers.length : null,
    },
  }
}

/** server.properties values are strings; coerce the obvious boolean/number ones. */
export function coercePropertyValue(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw)
  return raw
}

export function readEnvironmentFile(path) {
  if (typeof path !== 'string' || !existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const values = parsed?.values ?? parsed
    if (!isPlainObject(values)) return null
    return { path, mtime: statSync(path).mtime.toISOString(), values }
  } catch {
    return null
  }
}

function composeEnvironment({ observations, dimensions, serverProperties, environmentFile = null }) {
  const logFacts = { difficulty: null, mobSpawning: null, spawnAnimals: null, gamerules: null }
  for (const observation of Array.isArray(observations) ? observations : []) {
    for (const key of Object.keys(logFacts)) {
      if (observation[key] !== undefined && observation[key] !== null) logFacts[key] = { value: observation[key], at: observation.ts }
    }
  }
  const fromLog = (key) =>
    logFacts[key] === null ? null : { value: logFacts[key].value, source: 'log', runScoped: true, at: logFacts[key].at }
  const envValues = environmentFile?.values ?? null
  // Operator-recorded environment facts (console-verified gamerules). Mineflayer cannot
  // read gamerules, so the honest source is the command plus the console confirmation;
  // labelled runScoped:false, below run-scoped log facts and above server.properties.
  const fromEnv = (key) => {
    if (envValues === null || envValues[key] === undefined) return null
    return { value: envValues[key], source: environmentFile.path, runScoped: false, at: environmentFile.mtime }
  }
  const props = serverProperties?.values ?? null
  const fromProps = (key) => {
    if (props === null || props[key] === undefined) return null
    return { value: coercePropertyValue(props[key]), source: serverProperties.path, runScoped: false, at: serverProperties.mtime }
  }
  const observedDimensions = [...new Set((dimensions ?? []).map((entry) => entry.dimension))]
  return {
    difficulty: fromLog('difficulty') ?? fromEnv('difficulty') ?? fromProps('difficulty'),
    mobSpawning: fromLog('mobSpawning') ?? fromEnv('mobSpawning') ?? fromProps('spawn-monsters'),
    spawnAnimals: fromLog('spawnAnimals') ?? fromEnv('spawnAnimals') ?? fromProps('spawn-animals'),
    gamerules: fromLog('gamerules') ?? fromEnv('gamerules'),
    environmentFile:
      environmentFile === null
        ? null
        : { path: environmentFile.path, mtime: environmentFile.mtime, runScoped: false, values: environmentFile.values },
    dimensions: {
      count: (dimensions ?? []).length,
      observed: observedDimensions,
      first: dimensions?.length ? { ts: dimensions[0].ts, dimension: dimensions[0].dimension } : null,
      last: dimensions?.length ? { ts: dimensions.at(-1).ts, dimension: dimensions.at(-1).dimension } : null,
    },
    serverProperties: serverProperties === null ? null : { path: serverProperties.path, mtime: serverProperties.mtime, runScoped: false, values: serverProperties.values },
  }
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return candidates[0] ?? null
}

/**
 * Second read of the run's runner-out for DESCRIPTIVE model fields that the
 * policy loader does not surface (policyProvider / plannerModel / system2 stack
 * and decision). Attribution uses the SAME BOOT-boundary rule as the log scan: a
 * `BOOT ... runId=R` opens R, a later BOOT for another run closes it. This is
 * reading, not judging: when the loader can bind a gate window we restrict to it,
 * otherwise the descriptive facts are still reported and the artifact records
 * that the GATE could not bind them (`authority.gateBound=false`).
 */
export async function readAuthorityExtras(runnerOutPath, runId, policy = null) {
  if (typeof runnerOutPath !== 'string' || !existsSync(runnerOutPath)) return null
  const policyStartMs = policy?.window?.startMs ?? null
  const policyEndMs = policy?.window?.endMs ?? null
  let activeRunId = null
  let boundaryFound = false
  let bootTsMs = null
  let generation = null
  let system2Decision = null
  const rl = createInterface({ input: createReadStream(runnerOutPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (BOOT_RE.test(line)) {
      const rid = RUN_ID_LINE_RE.exec(line)?.[1] ?? null
      if (rid !== null) {
        if (boundaryFound && rid !== runId) break
        activeRunId = rid
        if (rid === runId) {
          boundaryFound = true
          bootTsMs = timestampMsOf(line)
          generation = null
          system2Decision = null
        }
      }
    }
    if (!boundaryFound || activeRunId !== runId) continue
    const tsMs = timestampMsOf(line)
    if (policyStartMs !== null && tsMs !== null && tsMs < policyStartMs) continue
    if (policyEndMs !== null && tsMs !== null && tsMs > policyEndMs) break
    if (line.includes('GENERATION_READY')) {
      const kv = parseKeyValues(line)
      generation = {
        tsMs,
        policyKind: stringOrNull(kv.policy ?? kv.policyKind),
        policyProvider: stringOrNull(kv.policyProvider),
        policyModel: stringOrNull(kv.policyModel ?? kv.model),
        plannerMode: stringOrNull(kv.planner ?? kv.plannerMode),
        plannerModel: stringOrNull(kv.plannerModel),
        deterministicFallbackEnabled: booleanOrNull(kv.deterministicFallbackEnabled),
        system2AuthorityStack: isPlainObject(kv.system2AuthorityStack) ? kv.system2AuthorityStack : null,
        system2LastAuthority: isPlainObject(kv.system2LastAuthority) ? kv.system2LastAuthority : null,
      }
    } else if (line.includes('SYSTEM2_AUTHORITY_DECISION')) {
      const kv = parseKeyValues(line)
      system2Decision = {
        tsMs,
        provider: stringOrNull(kv.provider),
        model: stringOrNull(kv.model),
        chosen: stringOrNull(kv.chosen),
      }
    }
  }
  if (!boundaryFound) return null
  return { boundaryFound, bootTsMs, generation, system2Decision }
}

async function composeAuthority({ runId, runnerOutPath, policy, extras }) {
  const generation = policy?.generation ?? null
  const extra = extras?.generation ?? null
  const system2 = policy?.system2 ?? null
  const system2Decisions = Array.isArray(system2?.decisions) ? system2.decisions : []
  const latestDecision = system2Decisions.at(-1) ?? null
  const decisions = policy?.decisions ?? null
  return {
    present: generation !== null || extra !== null,
    // `gateBound` is true only when the policy loader produced the generation
    // bundle the delegated gates actually judge; descriptive-only facts are not
    // a substitute for that.
    gateBound: generation !== null,
    source: runnerOutPath,
    reason: policy?.reason ?? (generation === null ? 'generation_status_unavailable' : null),
    window: policy?.window ?? null,
    plannerMode: generation?.plannerMode ?? extra?.plannerMode ?? null,
    policyKind: generation?.policyKind ?? extra?.policyKind ?? null,
    policyProvider: extra?.policyProvider ?? null,
    policyModel: generation?.policyModel ?? extra?.policyModel ?? null,
    plannerModel: extra?.plannerModel ?? null,
    deterministicFallbackEnabled: generation?.deterministicFallbackEnabled ?? extra?.deterministicFallbackEnabled ?? null,
    system2: {
      provider: latestDecision?.provider ?? extras?.system2Decision?.provider ?? null,
      model: latestDecision?.model ?? extras?.system2Decision?.model ?? null,
      chosen: latestDecision?.chosen ?? extras?.system2Decision?.chosen ?? null,
      count: Number.isFinite(system2?.count) ? system2.count : null,
      modelCount: Number.isFinite(system2?.modelCount) ? system2.modelCount : null,
      portalPlanCount: Number.isFinite(system2?.portalPlanCount) ? system2.portalPlanCount : null,
      authorityStack: extra?.system2AuthorityStack ?? null,
      lastAuthority: extra?.system2LastAuthority ?? null,
    },
    decisions:
      decisions === null
        ? null
        : {
            runId: decisions.runId,
            source: decisions.source,
            jevCount: decisions.jevCount ?? null,
            fallbackCount: decisions.fallbackCount ?? null,
            otherCount: decisions.otherCount ?? null,
            firstJevTs: decisions.firstJevTs ?? null,
            lastJevTs: decisions.lastJevTs ?? null,
          },
    runId,
  }
}

// ---------------------------------------------------------------------------
// verdict delegation (the only place a PASS/FAIL/UNKNOWN is produced)
// ---------------------------------------------------------------------------

function statusForCode(code) {
  return code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'UNKNOWN'
}

export function parseVerdictLine(id, lines) {
  const re = new RegExp(`\\b${id}_RUN_RESULT status=(PASS|FAIL|UNKNOWN) reason=(\\S+) runId=(\\S+)`)
  for (const line of Array.isArray(lines) ? lines : []) {
    const match = re.exec(String(line))
    if (match !== null) return { status: match[1], reason: match[2], runId: match[3] }
  }
  return null
}

export function parseConditions(lines) {
  const out = {}
  for (const line of Array.isArray(lines) ? lines : []) {
    const match = /^([a-z][a-z0-9_]*): (PASS|FAIL|UNKNOWN)$/.exec(String(line).trim())
    if (match !== null) out[match[1]] = match[2]
  }
  return out
}

async function runDelegatedGate({ id, gate, gateRunner, runId, paths, policyEvidence, policySocket }) {
  const lines = []
  let code = 2
  let error = null
  try {
    code = await gateRunner({
      expectedRunId: runId,
      logPath: paths.logPath,
      snapshotDir: paths.snapshotDir,
      decisionsPath: paths.decisionsPath,
      runnerOutPath: paths.runnerOutPath,
      controlSocketPath: paths.controlSocketPath ?? undefined,
      policyEvidence,
      policySocket,
      json: false,
      write: (line) => lines.push(String(line)),
    })
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
    lines.push(`${id}_GATE_ERROR ${error}`)
  }
  const parsed = parseVerdictLine(id, lines)
  const codeStatus = statusForCode(code)
  const missing = []
  let status
  if (parsed === null) {
    // A gate that emits no machine status line has NOT produced a verdict.
    status = 'UNKNOWN'
    missing.push(`verdict:${id}`)
  } else if (parsed.status !== codeStatus) {
    // Never reconcile a mismatch towards PASS; surface it as UNKNOWN.
    status = 'UNKNOWN'
    missing.push(`verdict:${id}:status_mismatch code=${code} line=${parsed.status}`)
  } else {
    status = parsed.status
    if (status === 'UNKNOWN') missing.push(`verdict:${id}`)
  }
  const factsLine = lines.find((line) => line.startsWith(`${id.toLowerCase()}_facts:`)) ?? null
  return {
    verdict: {
      id,
      gate,
      runId,
      status,
      reason: parsed?.reason ?? error ?? `gate_emitted_no_status code=${code}`,
      statusLine: parsed === null ? null : `${id}_RUN_RESULT`,
      conditions: parseConditions(lines),
      factsLine,
      lines,
    },
    missing,
  }
}

// ---------------------------------------------------------------------------
// artifact assembly
// ---------------------------------------------------------------------------

function unscopedArtifact({ root, now, reason }) {
  return {
    record: RECORD,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    root,
    runId: null,
    status: 'UNKNOWN',
    complete: false,
    reason,
    verdicts: {
      M2: { id: 'M2', gate: 'tools/m2-gate.mjs', runId: null, status: 'UNKNOWN', reason, conditions: {}, lines: [] },
      M3: { id: 'M3', gate: 'tools/m3-gate.mjs', runId: null, status: 'UNKNOWN', reason, conditions: {}, lines: [] },
    },
    missingEvidence: ['runId'],
  }
}

export async function buildRunArtifact({
  runId,
  root = DEFAULT_ROOT,
  overrides = {},
  now = () => new Date(),
  gates = { M2: runM2Gate, M3: runM3Gate },
  loadPolicy = loadPolicyEvidence,
  readSocket = readPolicySocketBinding,
} = {}) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return {
      artifact: unscopedArtifact({ root, now, reason: runId === null || runId === undefined ? 'exact_run_scope_required' : `invalid_run_id ${String(runId)}` }),
      exitCode: 2,
    }
  }

  const paths = derivePaths(root, overrides)
  const missing = []

  // ---- log: one read, then the canonical gate attribution + our timestamped one
  let lines = []
  let attribution = emptyAttribution(`log_unreadable runId=${runId}`)
  let gateScan = { status: 'unknown', inventorySamples: [], dimensionObservations: [], reason: 'log_unavailable' }
  if (existsSync(paths.logPath)) {
    let text = null
    try {
      text = readFileSync(paths.logPath, 'utf8')
    } catch {
      text = null
    }
    if (text !== null) {
      lines = text.split(/\r?\n/)
      attribution = attributeRunLines(runId, lines)
      gateScan = scanRunLines(runId, lines)
    }
  }
  if (attribution.status !== 'valid') missing.push('boot')
  const gateAttributionConsistent =
    attribution.status === gateScan.status &&
    attribution.inventorySamples.length === (Array.isArray(gateScan.inventorySamples) ? gateScan.inventorySamples.length : 0) &&
    attribution.dimensionObservations.length === (Array.isArray(gateScan.dimensionObservations) ? gateScan.dimensionObservations.length : 0)
  if (!gateAttributionConsistent) missing.push('attribution:gate_cross_check')

  // ---- boot identity
  const boot = attribution.bootLines.length > 0 ? parseBootLine(attribution.bootLines[0].line) : null
  if (boot !== null) {
    for (const [field, label] of [
      ['sourceSha', 'boot.sourceSha'],
      ['runtime', 'boot.runtime'],
      ['runtimeVersion', 'boot.runtimeVersion'],
      ['contractVersion', 'boot.contractVersion'],
      ['schemaVersion', 'boot.schemaVersion'],
      ['worldEpoch', 'boot.worldEpoch'],
      ['worldKey', 'boot.worldKey'],
    ]) {
      if (boot[field] === null || boot[field] === undefined) missing.push(label)
    }
  }

  // ---- snapshot / inventory
  const snapshot = readSnapshotForRun(runId, paths.snapshotDir)
  const inventory = composeInventory({ attribution, snapshot })
  if (inventory.observationCount === 0 && inventory.snapshot.present) missing.push('inventory:log')
  if (inventory.boot === null) missing.push('inventory.boot')
  if (inventory.latest === null) missing.push('inventory.latest')
  for (const item of MILESTONE_ITEMS) if (!inventory.milestoneItems[item].observed) missing.push(`milestoneItem:${item}`)

  // ---- environment
  const serverProperties = readServerProperties(paths.serverProperties)
  const environment = composeEnvironment({
    observations: attribution.environmentObservations,
    dimensions: attribution.dimensionObservations,
    serverProperties,
    environmentFile: readEnvironmentFile(paths.environment),
  })
  if (environment.difficulty === null) missing.push('environment.difficulty')
  if (environment.mobSpawning === null) missing.push('environment.mobSpawning')
  if (environment.gamerules === null) missing.push('environment.gamerules')
  if (environment.dimensions.count === 0) missing.push('environment.dimension')
  const serverVersion =
    attribution.serverObservations.find((observation) => observation.serverVersion !== null)?.serverVersion ?? null
  if (serverVersion === null) missing.push('serverVersion')

  // ---- acceptance artifact
  const acceptance = readAcceptanceArtifact(runId, paths.acceptanceDir)
  if (!acceptance.present) missing.push('acceptance')

  // ---- authority (read once; the gates reuse this exact bundle)
  const socketBinding =
    typeof paths.controlSocketPath === 'string' && paths.controlSocketPath !== ''
      ? await readSocket(paths.controlSocketPath)
      : null
  const policy = await loadPolicy({
    runId,
    socket: socketBinding !== null && socketBinding.runId === runId ? socketBinding : null,
    decisionsPath: paths.decisionsPath,
    runnerOutPath: paths.runnerOutPath,
  })
  const extras = await readAuthorityExtras(paths.runnerOutPath, runId, policy)
  const authority = await composeAuthority({ runId, runnerOutPath: paths.runnerOutPath, policy, extras })
  if (!authority.present) missing.push('authority')
  if (!authority.gateBound) missing.push('authority.gateBinding')
  if (authority.plannerMode === null) missing.push('authority.plannerMode')
  if (authority.policyProvider === null) missing.push('authority.policyProvider')
  if (authority.policyModel === null) missing.push('authority.policyModel')
  if (authority.deterministicFallbackEnabled === null) missing.push('authority.deterministicFallbackEnabled')
  if (authority.system2.provider === null || authority.system2.model === null) missing.push('authority.system2')

  // ---- delegated verdicts
  const m2 = await runDelegatedGate({
    id: 'M2',
    gate: 'tools/m2-gate.mjs',
    gateRunner: gates.M2,
    runId,
    paths,
    policyEvidence: policy,
    policySocket: socketBinding,
  })
  const m3 = await runDelegatedGate({
    id: 'M3',
    gate: 'tools/m3-gate.mjs',
    gateRunner: gates.M3,
    runId,
    paths,
    policyEvidence: policy,
    policySocket: socketBinding,
  })
  missing.push(...m2.missing, ...m3.missing)

  const verdicts = { M2: m2.verdict, M3: m3.verdict }
  const statuses = [verdicts.M2.status, verdicts.M3.status]
  const complete = missing.length === 0
  const status = statuses.includes('FAIL') ? 'FAIL' : statuses.includes('UNKNOWN') || !complete ? 'UNKNOWN' : 'PASS'
  const exitCode = statuses.includes('FAIL') ? 1 : status === 'PASS' ? 0 : 2

  const artifact = {
    record: RECORD,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    root,
    runId,
    status,
    complete,
    run: {
      runId,
      boot,
      runtime: boot?.runtime ?? null,
      runtimeVersion: boot?.runtimeVersion ?? null,
      contractVersion: boot?.contractVersion ?? null,
      schemaVersion: boot?.schemaVersion ?? null,
      worldEpoch: boot?.worldEpoch ?? snapshot?.record?.worldEpoch ?? null,
      worldKey: boot?.worldKey ?? null,
      serverVersion,
    },
    sources: {
      logPath: paths.logPath,
      snapshotDir: paths.snapshotDir,
      decisionsPath: paths.decisionsPath,
      runnerOutPath: paths.runnerOutPath,
      controlSocketPath: paths.controlSocketPath,
      acceptanceDir: paths.acceptanceDir,
      serverProperties: paths.serverProperties,
    },
    inventory,
    environment,
    authority,
    acceptance: {
      present: acceptance.present,
      path: acceptance.path,
      reason: acceptance.reason,
      record: acceptance.record,
    },
    snapshot: {
      present: snapshot.present,
      status: snapshot.status,
      path: snapshot.path,
      reason: snapshot.reason,
      runId: snapshot.record?.runId ?? null,
      bootSourceSha: snapshot.record?.bootSourceSha ?? null,
      buildHash: snapshot.record?.buildHash ?? null,
      worldEpoch: snapshot.record?.worldEpoch ?? null,
      worldKey: snapshot.record?.worldKey ?? null,
      markerCount: Array.isArray(snapshot.record?.markers) ? snapshot.record.markers.length : null,
    },
    verdicts,
    missingEvidence: missing,
  }
  return { artifact, exitCode }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { run: null, root: null, out: null, json: false, pretty: false, help: false, overrides: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--run') out.run = argv[++i] ?? null
    else if (arg === '--root') out.root = argv[++i] ?? null
    else if (arg === '--out') out.out = argv[++i] ?? null
    else if (arg === '--json') out.json = true
    else if (arg === '--pretty') out.pretty = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--log') out.overrides.logPath = argv[++i] ?? null
    else if (arg === '--snapshot-dir') out.overrides.snapshotDir = argv[++i] ?? null
    else if (arg === '--decisions') out.overrides.decisionsPath = argv[++i] ?? null
    else if (arg === '--runner-out') out.overrides.runnerOutPath = argv[++i] ?? null
    else if (arg === '--control-socket') out.overrides.controlSocketPath = argv[++i] ?? null
    else if (arg === '--no-control-socket') out.overrides.controlSocketPath = null
    else if (arg === '--acceptance-dir') out.overrides.acceptanceDir = argv[++i] ?? null
    else if (arg === '--server-properties') out.overrides.serverProperties = argv[++i] ?? null
    else if (arg === '--environment') out.overrides.environment = argv[++i] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

export function usage() {
  return [
    'milestone-run-artifact — assemble ONE run-scoped JSON artifact for an exact runId',
    '',
    'Usage:',
    '  bun tools/milestone-run-artifact.mjs --run <runId> [--root <tree>] [--out <path>] [--json|--pretty]',
    '  bun tools/milestone-run-artifact.mjs --help',
    '',
    'Required:',
    '  --run <runId>            exact resident runId (shape run-[A-Za-z0-9-]+); missing => UNKNOWN, exit 2',
    '',
    'Options:',
    `  --root <tree>            resident tree root (default ${DEFAULT_ROOT})`,
    '  --out <path>             write the artifact to this path instead of stdout',
    '  --json                   emit compact single-line JSON (default: 2-space pretty JSON)',
    '  --pretty                 emit 2-space pretty JSON (default)',
    '  --log <path>             override <root>/buddy-driver/buddy.log',
    '  --snapshot-dir <path>    override <root>/buddy-driver/data/resident (m2-snapshot-<runId>.json)',
    '  --decisions <path>       override <root>/buddy-driver/logs/jev/decisions.jsonl',
    '  --runner-out <path>      override <root>/buddy-driver/runner.out (BOOT/GENERATION_READY window)',
    '  --control-socket <path>  override <root>/buddy-driver/data/resident/control.sock (read-only report query)',
    '  --no-control-socket      never query the resident control socket',
    '  --acceptance-dir <path>  override the acceptance-<runId>.json directory',
    '  --server-properties <p>  read difficulty/spawn-monsters from a server.properties (labelled NOT run-scoped)',
    '  --environment <p>        read operator-recorded environment facts (difficulty/gamerules JSON, labelled NOT run-scoped)',
    '',
    'Exit codes: 0 complete + both gates PASS; 1 a gate FAILs; 2 UNKNOWN/missing evidence/usage error.',
    '',
  ].join('\n')
}

export async function runCli({
  argv = process.argv.slice(2),
  write = (line) => process.stdout.write(line),
  writeError = (line) => process.stderr.write(line),
  build = buildRunArtifact,
} = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    writeError(`MILESTONE_RUN_ARTIFACT_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return { exitCode: 2, artifact: null }
  }
  if (args.help) {
    write(usage())
    return { exitCode: 0, artifact: null }
  }
  const root = args.root ?? DEFAULT_ROOT
  const { artifact, exitCode } = await build({ runId: args.run, root, overrides: args.overrides })
  const text = args.json ? JSON.stringify(artifact) : JSON.stringify(artifact, null, 2)
  if (typeof args.out === 'string' && args.out !== '') {
    try {
      mkdirSync(dirname(args.out), { recursive: true })
      writeFileSync(args.out, `${text}\n`, 'utf8')
    } catch (error) {
      writeError(`MILESTONE_RUN_ARTIFACT_ERROR cannot write --out ${args.out}: ${error instanceof Error ? error.message : String(error)}\n`)
      return { exitCode: 2, artifact }
    }
  } else {
    write(`${text}\n`)
  }
  return { exitCode, artifact }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const result = await runCli()
  process.exitCode = result.exitCode
}
