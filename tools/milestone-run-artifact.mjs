#!/usr/bin/env bun
// milestone-run-artifact: assemble ONE machine-readable, run-scoped artifact for
// an exact resident runId.
//
// This tool is a READER/ASSEMBLER, never a judge of its own:
//   1. it reads the existing run-scoped evidence (BOOT line, inventory markers,
//      dimension / spawn / environment observations, the run-scoped
//      `m2-snapshot-<runId>.json`, the run-scoped `acceptance-<runId>.json`, the
//      resident's `milestone-predicates-<runId>.json` observations and, only when
//      explicitly asked, the resident's server.properties);
//   2. it obtains the milestone verdicts by delegating to the EXISTING gates
//      (tools/m2-gate.mjs `runM2Gate`, tools/m3-gate.mjs `runM3Gate`) with the
//      SAME run-scoped evidence paths, and embeds their exact verdict lines.
//      It never re-implements a gate predicate and never turns UNKNOWN into PASS;
//   3. it emits a FIRST-CLASS `milestonePredicates` section (derived from the
//      resident observation file + the same log/snapshot facts, with each
//      predicate's `{id, satisfied, observedAtMs, source, evidence}`) and attaches
//      any explicit operator decision to `verdicts.<M>.operatorDecision` WITHOUT
//      rewriting the delegated gate verdict;
//   4. every fact it could not obtain is named in `missingEvidence`, and a
//      missing fact is always an UNKNOWN/exit-2 outcome, never a quiet absence.
//
// Source provenance
// -----------------
// `run.boot.sourceSha` is the SHA the host read when the run OPENED. A run that
// hot-reloaded while it lived executed other code when the result was produced, so
// `run.source` records BOTH: the BOOT origin and the latest source-changing RELOAD
// marker inside the same BOOT-bound window (`provenance: "reload"` ->
// `effectiveSourceSha` is the host generation BUNDLE hash; no reload marker ->
// `provenance: "boot"` and the BOOT SHA is repeated, never replaced by a guess).
// The reload hash is a bundle hash, not a git commit: `effectiveSourceShaKind`
// says which one a reader is looking at.
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
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  M2_RUN_CHAIN,
  RUN_ID_RE,
  asCounts,
  parseInventoryMarker,
  parsePortalChainLine,
  parsePortalMarker,
  readM2Snapshot,
  readPolicySocketBinding,
  runM2Gate,
  scanRunLines,
} from './m2-gate.mjs'
import { runM3Gate } from './m3-gate.mjs'
import { deriveMilestonePredicates, readMilestonePredicateEvidence } from './milestone-predicates.mjs'
import { loadPolicyEvidence } from './m2-policy-evidence.mjs'
import { scanRunSourceExactness } from './run-source-exactness.mjs'

export const RECORD = 'milestone-run-artifact'
// 3 = additive: `authority.jev`, the parsed `authority.system2.stack` + per-fact
// attestation, `authority.fallback`, `environment.dimensions.sequence/transitions`,
// `milestoneAcceptance` and `missingEvidenceDetail`. Every schema-2 field is kept.
// 4 = additive: `run.source` (run-window SOURCE provenance: bootSourceSha +
// latestReload/latestSourceReload + effectiveSourceSha + provenance + the read-only
// control-socket cross-check). `run.boot.sourceSha` and every schema-3 field are
// unchanged.
// 5 = additive, from two independent needs:
//   * `verdicts.M2.chain` - the delegated gate's ORDERED build->light->verify trace,
//     one fact per link with the evidence source that proved it, the marker indices
//     and the frame's own blocks/shape. Present only when the gate emitted `m2_chain:`
//     lines; never a fabricated empty chain.
//   * `verdicts.<M>.operatorDecisionPremise` (what a recorded operator decision COVERS,
//     its `gateFacts` from the delegated gate's STRUCTURED verdict instead of a regex
//     over its lines, and whether THIS run inherits or must build; the operator's own
//     entry is never rewritten), `verdicts.<M>.facts`,
//     `operatorDecisions.{sha256,considered,premises}`, `acceptance.evidenceClass`
//     (+ top-level `evidenceClasses`) and `gateEvidence` (the exact authority evidence
//     both delegated gates received).
// Every schema-5 field is kept.
// 7 = additive authority diagnostics: run-window decision-source completeness
// (`fallback.unclassifiableCount` / `decisions.unclassifiableCount`) and the
// count of ineligible System2 records (`system2.ineligibleModelCount`). Every
// schema-6 field is kept.
// 8 = source-bound initial inventory: `inventory.bootEvidence` records whether
// the generation-entry snapshot matches this BOOT's runId and source SHA. A
// periodic INVENTORY marker can no longer stand in for the starting inventory.
// 9 = System2 source/generation lineage: every in-window GENERATION_READY and
// System2 input/decision marker is preserved, with the policy loader's identity
// verdict and per-decision generation/source/provider/model joins.
// Every schema-8 field is kept.
export const SCHEMA_VERSION = 9
export const DEFAULT_ROOT = '/home/s0u7a/mc-ai-worktrees/m3-live'
/** Repo-level operator decision file; run-scoped by each entry's own runId. */
export const OPERATOR_DECISION_RECORD = 'operator-decision'

/**
 * The HOST writer of the run-scoped acceptance record the artifact reads. It is
 * NOT a milestone verdict and it is NOT written at boot: `writeAcceptance()` runs
 * on a successful generation reload commit, on `freeze` / `resume`, on the
 * read-only `acceptance` control command and on shutdown. A run that has not hit
 * one of those has no record yet, and the artifact must keep saying so instead of
 * inventing one. The milestone question is answered independently by
 * `milestoneAcceptance`, which is derived from the delegated gates.
 */
export const ACCEPTANCE_WRITER = Object.freeze({
  source: 'buddy-driver/agent-runner.mts',
  symbol: 'writeAcceptance()',
  record: 'acceptance',
  pathPattern: 'buddy-driver/data/resident/acceptance-<runId>.json',
  firesOn: ['generation-reload-commit', 'control:freeze', 'control:resume', 'control:acceptance', 'shutdown'],
  note: 'attests the run/HOST state (provenance, listeners, epoch); it never asserts a milestone PASS and is not written at boot',
  /**
   * What the record DOES attest, so an absent record is a named evidence-class gap
   * rather than a hole in the artifact. The milestone question is answered by
   * `milestoneAcceptance` (delegated gate verdicts), never by this record.
   */
  attests: [
    'run source identity (boot commit + mutable checkout HEAD)',
    'generation hash/id and the contract/state schema versions',
    'server id / dimension / worldEpoch / level name / seed',
    'inventory-independent HOST counters: reloads, reconnects, freeze cycles',
    'listener baseline/expected/current counts and the leak flag',
    'the MODE (llm|deterministic) derived from the live policyKind',
  ],
  /**
   * Safe, non-disruptive ways to make the record exist for a run that has not hit
   * one yet. All of them are HOST lifecycle events, so a tool can never fabricate
   * the record: it can only say which trigger would produce it. `freeze` (and
   * `resume`) are reversible per AGENTS.md 4.0; the read-only `acceptance` control
   * query both refreshes and returns the record.
   */
  safeTriggers: [
    'control command `acceptance` (read-only query that also writes the record)',
    'control command `freeze` (reversible) then `resume`',
    'a generation reload commit',
    'a clean resident shutdown',
    'the next BOOT of the resident is NOT a trigger: a record is never written at boot',
  ],
  fabricatable: false,
})

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
/** See tools/m2-gate.mjs BODY_DIMENSION_MARKER_RE: only the body's own dimension markers count. */
const BODY_DIMENSION_MARKER_RE = /\b(?:DIMENSION_OBSERVED|DIMENSION_TRANSITION|SPAWN|DEATH)\b/
const RUN_ID_LINE_RE = /\brunId=(run-[A-Za-z0-9-]+)/
const RELOAD_RE = /\bRELOAD\b(?!_)/
const RESUME_RE = /\bRESUME\b(?!_)/
const BUILD_RE = /\bBUILD\b(?!_)/
const ENV_MARKER_RE = /\b(?:ENVIRONMENT|SERVER_ENV|SERVER_CONFIG|WORLD_ENV|GAMERULES?)\b/
const SERVER_LINE_RE = /\b(?:SPAWN|SERVER_VERSION|SERVER_START)\b/
const KV_KEY_RE = /(?:^|\s)([A-Za-z_][A-Za-z0-9_-]*)=/g

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
 * Tolerant `key=value` reader. JSON object/array values may be nested and contain
 * spaces. After consuming a structured value the cursor skips its full extent,
 * so keys inside JSON strings/objects are never mistaken for top-level fields.
 */
export function parseKeyValues(line) {
  const out = {}
  if (typeof line !== 'string') return out
  const keyRegex = new RegExp(KV_KEY_RE.source, 'g')
  let cursor = 0
  while (cursor < line.length) {
    keyRegex.lastIndex = cursor
    const match = keyRegex.exec(line)
    if (match === null) break
    const key = match[1]
    const valueStart = keyRegex.lastIndex
    const opener = line[valueStart]
    let valueEnd = valueStart
    if (opener === '"' || opener === '{' || opener === '[') {
      const stack = []
      let quoted = false
      let escaped = false
      for (let index = valueStart; index < line.length; index += 1) {
        const char = line[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
          continue
        }
        if (char === '"') {
          quoted = true
          continue
        }
        if (char === '{' || char === '[') stack.push(char)
        else if (char === '}' || char === ']') {
          const opening = stack.pop()
          if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) break
          if (stack.length === 0) {
            valueEnd = index + 1
            break
          }
        }
      }
      if (valueEnd === valueStart) valueEnd = line.length
    } else {
      valueEnd = valueStart
      while (valueEnd < line.length && !/\s/.test(line[valueEnd])) valueEnd += 1
    }
    const raw = line.slice(valueStart, valueEnd)
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try {
        out[key] = JSON.parse(raw)
      } catch {
        out[key] = raw.slice(1, -1)
      }
    } else if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try {
        out[key] = JSON.parse(raw)
      } catch {
        out[key] = raw
      }
    } else out[key] = raw
    cursor = valueEnd > valueStart ? valueEnd : valueStart + 1
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
    cleanRunServerConfig: isPlainObject(kv.cleanRunServerConfig) ? kv.cleanRunServerConfig : null,
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
// resident authority identity (run-scoped markers, never inferred from a name)
// ---------------------------------------------------------------------------
//
// The resident renders its own authority getters into the GENERATION_READY line:
//
//   policyProvider / policyModel            -> the Jev pi authority (WHICH action)
//   system2AuthorityStack                   -> the CONFIGURED System2 stack
//   system2LastAuthority                    -> the last provider that ANSWERED
//   advisor / advisorSource                 -> the resolved long-horizon advisor
//
// `system2AuthorityStack` is `{ provider, model }` where `model` is the stack
// string built by `buddy-driver/planner.ts` (`get authorityStack()`):
//
//   deterministic -> '<plannerModel>'                                  (single segment)
//   single brain  -> '<plannerModel>'                                  (single segment)
//   local-mercury -> 'deterministic|mercury:<model>'
//   hybrid        -> 'typesafe-ai:<jevModel>|<advisorProvider>:<advisorModel>'
//
// i.e. `<left>|<right>`, each half `<provider>:<model>`. A half without both
// sides is reported as unparsed with its raw text echoed; this reader never
// guesses a provider, and a single segment means one brain owns both roles.
export function parseAuthorityStack(stack) {
  const absent = { present: false, raw: null, provider: null, segments: [], jev: null, system2: null, single: false, derived: null, reason: 'authority_stack_missing' }
  if (!isPlainObject(stack) || typeof stack.model !== 'string' || stack.model.trim() === '') return absent
  const raw = stack.model.trim()
  const provider = stringOrNull(stack.provider)
  const segments = raw
    .split('|')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
  const parseSegment = (segment) => {
    const index = segment.indexOf(':')
    if (index <= 0 || index === segment.length - 1) return null
    return { provider: segment.slice(0, index), model: segment.slice(index + 1) }
  }
  const parsed = segments.map(parseSegment)
  if (segments.length === 0) return { ...absent, present: true, raw, provider, reason: 'authority_stack_empty' }
  if (segments.length > 2) {
    return { present: true, raw, provider, segments, jev: null, system2: null, single: false, derived: null, reason: `authority_stack_unparsed segments=${segments.length}` }
  }
  if (segments.length === 1) {
    const only = parsed[0]
    // A parsed single half names both roles; an unparsed one still names the
    // System2 authority through the stack provider that the host emitted next to it.
    const system2 = only ?? (provider === null ? null : { provider, model: segments[0] })
    return {
      present: true,
      raw,
      provider,
      segments,
      jev: only,
      system2,
      single: true,
      derived: only === null && system2 !== null ? 'single_segment_stack_provider' : null,
      reason: system2 === null ? 'authority_stack_unparsed' : null,
    }
  }
  return {
    present: true,
    raw,
    provider,
    segments,
    jev: parsed[0],
    system2: parsed[1],
    single: false,
    derived: null,
    reason: parsed[0] === null || parsed[1] === null ? 'authority_stack_partially_unparsed' : null,
  }
}

/**
 * The host's own `policyProvider` getter maps the policy kind to the provider
 * (`jev-agent/src/controller-legacy.ts`: `kind === 'typesafe' ? 'typesafe-ai' :
 * 'deterministic'`). Used ONLY when the explicit `policyProvider=` field is
 * absent, and always labelled as the derivation it is.
 */
export function providerFromPolicyKind(policyKind) {
  if (policyKind === 'typesafe') return 'typesafe-ai'
  if (policyKind === 'deterministic') return 'deterministic'
  return null
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
    dimensionTransitions: [],
    portalEvents: [],
    environmentObservations: [],
    serverObservations: [],
    foreignRuns: [],
  }
}

/**
 * Attribute every inventory/dimension/environment observation to exactly ONE
 * run, using the gates' BOOT-boundary rule. A BOOT line opens the active run; a
 * later BOOT closes the previous one; lines before any BOOT belong to no run. A
 * non-BOOT line's own `runId=` field is not a boundary, but when present it must
 * match the active BOOT run. Explicitly foreign markers are skipped.
 */
export function attributeRunLines(runId, lines) {
  const bootLines = []
  const inventorySamples = []
  const dimensionObservations = []
  const dimensionTransitions = []
  const portalEvents = []
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
    const explicitLineRunId = RUN_ID_LINE_RE.exec(line)?.[1] ?? null
    if (explicitLineRunId !== null && explicitLineRunId !== runId) {
      foreignRuns.add(explicitLineRunId)
      continue
    }
    const ts = timestampOf(line)
    const counts = parseInventoryMarker(line)
    if (counts !== null) inventorySamples.push({ index, ts, counts })
    const dimension = BODY_DIMENSION_MARKER_RE.test(line) ? DIMENSION_RE.exec(line) : null
    if (dimension !== null) dimensionObservations.push({ index, ts, dimension: dimension[1] })
    if (/\bDIMENSION_TRANSITION\b/.test(line)) {
      const from = /(?:^|\s)from=(\S+)/.exec(line)?.[1] ?? null
      const to = /(?:^|\s)to=(\S+)/.exec(line)?.[1] ?? null
      const observedDimension = /(?:^|\s)dimension=(\S+)/.exec(line)?.[1] ?? null
      const source = /(?:^|\s)source=(\S+)/.exec(line)?.[1] ?? null
      const atMs = timestampMsOf(line)
      if (
        from !== null &&
        to !== null &&
        observedDimension !== null &&
        source === 'live-world' &&
        to.replace(/^minecraft:/, '').toLowerCase() === observedDimension.replace(/^minecraft:/, '').toLowerCase() &&
        atMs !== null
      ) {
        dimensionTransitions.push({ index, ts, atMs, from, to, dimension: observedDimension, source })
      }
    }
    const portal = parsePortalMarker(line)
    if (portal !== null) portalEvents.push({ index, ts, source: 'log', ...portal })
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
    dimensionTransitions,
    portalEvents,
    environmentObservations,
    serverObservations,
    foreignRuns: [...foreignRuns],
  }
}

// ---------------------------------------------------------------------------
// run-window SOURCE provenance (which code actually produced the result)
// ---------------------------------------------------------------------------
//
// `run.boot.sourceSha` is the run's ORIGIN: the SHA the host read when the run
// opened. It is NOT necessarily the source that produced the RESULT, because the
// host hot-reloads the generation while the run lives and this artifact is
// assembled after the fact. The host's own markers answer the "what executed"
// question positively:
//
//   BUILD  hash=<h> bytes=<n> ms=<n> outfile=<path>      the boot generation's bundle hash
//   RELOAD ok=true trigger=source-changed ms=<dur> hash=<h> id=<generationId> generations=<n> ...
//   RELOAD ok=true trigger=control skipped=unchanged ms=<dur>
//   RELOAD ok=true trigger=X deferred=frozen ms=<dur> hash=<h> contractVersion=<n>
//   RELOAD ok=false trigger=X ms=<dur> reason|message=<text>
//   RESUME ok=<bool>
//
// Rules that keep this honest:
//   * the window is the SAME `BOOT ... runId=R` boundary the gates use, and it is
//     deliberately NOT narrowed to the policy window: the latest reload can be
//     later than the last authority marker. It is read from `runner.out` first and
//     from the append-only `buddy.log` when a host restart truncated the former;
//   * a RELOAD line carrying another runId is never attributed (a BOOT for another
//     run closes the window, exactly as in attributeRunLines);
//   * `skipped=unchanged` is RECORDED but is not a new source (the host rebuilt the
//     same bundle, so the executing source did not change);
//   * `deferred=frozen` stages a bundle without swapping it in; it becomes the live
//     source only when a later successful `RESUME ok=true` commits it;
//   * `ok=false` never changes the source;
//   * no SHA is ever invented: with no source-changing reload the artifact says
//     `provenance: "boot"` and repeats the BOOT SHA instead of guessing.
//
// The reload hash is the host's GENERATION BUNDLE hash (12 hex chars), not a git
// commit: `effectiveSourceShaKind` says which one a reader is looking at.

/** What each observed RELOAD marker shape means for the executing source. */
export const RELOAD_MARKER_KINDS = Object.freeze({
  'source-change': 'the swap committed: this generation bundle hash is the live source from this line onward',
  unchanged: 'the host rebuilt the SAME bundle (skipped=unchanged): observed, but not a new source',
  deferred: 'the candidate bundle was validated and remembered (deferred=frozen) but NOT swapped in; it becomes live only when a later RESUME ok=true commits it',
  failed: 'the reload did not commit (ok=false): the previous generation kept running, so the source is unchanged',
  unclassified: 'a RELOAD marker without a parseable hash: recorded, never treated as a source',
})

/** Parse one `RELOAD ...` marker line into its source-relevant fields, or null. */
export function parseReloadLine(line, lineIndex = null) {
  if (typeof line !== 'string' || !RELOAD_RE.test(line)) return null
  const kv = parseKeyValues(line)
  const ok = booleanOrNull(kv.ok)
  const skipped = stringOrNull(kv.skipped)
  const deferred = stringOrNull(kv.deferred)
  const hash = stringOrNull(kv.hash)
  let kind
  if (ok === false) kind = 'failed'
  else if (skipped === 'unchanged') kind = 'unchanged'
  else if (deferred === 'frozen') kind = 'deferred'
  else if (ok === true && hash !== null) kind = 'source-change'
  else kind = 'unclassified'
  return {
    lineIndex,
    ts: timestampOf(line),
    // The line's own timestamp: `ms=` on a RELOAD line is the reload DURATION.
    atMs: timestampMsOf(line),
    ok,
    trigger: stringOrNull(kv.trigger),
    hash,
    // The host names the git commit the bundle was built from (`sourceSha=` on BUILD/RELOAD).
    // The bundle hash alone cannot attest WHICH COMMIT a hot-reloaded run is executing, which is
    // exactly the `exact source SHA` the acceptance asks for; older markers omit it and this is
    // then null rather than a guess.
    sourceSha: stringOrNull(kv.sourceSha),
    generationId: stringOrNull(kv.id),
    generations: numberOrNull(kv.generations),
    durationMs: numberOrNull(kv.ms),
    skipped,
    deferred,
    listenerLeak: booleanOrNull(kv.listenerLeak),
    reason: stringOrNull(kv.reason ?? kv.message),
    kind,
    // `applied` means "this marker changed the live source". A deferred marker is
    // flipped to applied by a later in-window `RESUME ok=true` (the host commits
    // exactly the remembered module), never by itself.
    applied: kind === 'source-change',
    appliedBy: kind === 'source-change' ? 'reload-commit' : null,
    note: RELOAD_MARKER_KINDS[kind] ?? null,
  }
}

function emptyReloadWindow(runnerOutPath, runId, reason) {
  return {
    status: 'unknown',
    reason,
    source: runnerOutPath ?? null,
    runId,
    bootLineIndex: null,
    bootTsMs: null,
    closedByRunId: null,
    scannedToEof: false,
    bootBuildHash: null,
    reloads: [],
    latestReload: null,
    latestSourceReload: null,
    count: 0,
    sourceChangeCount: 0,
    unmatchedDeferred: null,
  }
}

/**
 * Scan ONE run's `BOOT ... runId=R` window for its source-change evidence.
 *
 * Attribution is the gates' own rule: `BOOT ... runId=R` opens R, a later BOOT for
 * another run closes it (and stops the scan), lines before any BOOT belong to no
 * run. Reads only; never mutates the resident.
 */
export async function scanRunReloadWindow(runnerOutPath, runId) {
  if (typeof runnerOutPath !== 'string' || runnerOutPath === '' || !existsSync(runnerOutPath)) {
    return emptyReloadWindow(runnerOutPath, runId, `runner_out_missing runId=${runId}`)
  }
  let activeRunId = null
  let boundaryFound = false
  let bootLineIndex = null
  let bootTsMs = null
  let closedByRunId = null
  let bootBuildHash = null
  let pendingDeferred = null
  let lineIndex = -1
  const reloads = []
  let rl
  try {
    rl = createInterface({ input: createReadStream(runnerOutPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of rl) {
      lineIndex += 1
      if (BOOT_RE.test(line)) {
        const rid = RUN_ID_LINE_RE.exec(line)?.[1] ?? null
        if (rid !== null) {
          if (boundaryFound && rid !== runId) {
            closedByRunId = rid
            break
          }
          activeRunId = rid
          if (rid === runId) {
            boundaryFound = true
            bootLineIndex = lineIndex
            bootTsMs = timestampMsOf(line)
          }
        }
      }
      if (!boundaryFound || activeRunId !== runId) continue
      const explicitLineRunId = RUN_ID_LINE_RE.exec(line)?.[1] ?? null
      if (explicitLineRunId !== null && explicitLineRunId !== runId) continue
      if (bootBuildHash === null && BUILD_RE.test(line)) {
        bootBuildHash = stringOrNull(parseKeyValues(line).hash)
      }
      if (RESUME_RE.test(line) && booleanOrNull(parseKeyValues(line).ok) === true && pendingDeferred !== null) {
        // The host resumes exactly the remembered module (`loadGenerationModule(false)`
        // returns the frozen candidate), so the staged bundle is the live source now.
        pendingDeferred.applied = true
        pendingDeferred.appliedBy = 'resume'
        pendingDeferred.resumedAtMs = timestampMsOf(line)
        pendingDeferred.resumeLineIndex = lineIndex
        pendingDeferred = null
      }
      const marker = parseReloadLine(line, lineIndex)
      if (marker === null) continue
      reloads.push(marker)
      if (marker.kind === 'deferred' && marker.hash !== null) pendingDeferred = marker
      else if (marker.kind === 'source-change') pendingDeferred = null
    }
  } catch (error) {
    return emptyReloadWindow(runnerOutPath, runId, `runner_out_unreadable ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try {
      rl?.close()
    } catch {
      /* best effort */
    }
  }
  if (!boundaryFound) return emptyReloadWindow(runnerOutPath, runId, `run_boundary_missing runId=${runId}`)
  const applied = reloads.filter((marker) => marker.applied === true && marker.hash !== null)
  return {
    status: 'valid',
    reason: null,
    source: runnerOutPath,
    runId,
    bootLineIndex,
    bootTsMs,
    closedByRunId,
    scannedToEof: closedByRunId === null,
    bootBuildHash,
    reloads,
    latestReload: reloads.at(-1) ?? null,
    latestSourceReload: applied.at(-1) ?? null,
    count: reloads.length,
    sourceChangeCount: applied.length,
    unmatchedDeferred: pendingDeferred,
  }
}

/** The latest reload marker as the artifact records it (id fields + window count). */
function reloadView(marker, count) {
  if (marker === null) return null
  return {
    hash: marker.hash,
    sourceSha: marker.sourceSha ?? null,
    trigger: marker.trigger,
    atMs: marker.atMs,
    generationId: marker.generationId,
    lineIndex: marker.lineIndex,
    count,
    ts: marker.ts,
    ok: marker.ok,
    kind: marker.kind,
    applied: marker.applied === true,
    appliedBy: marker.appliedBy ?? null,
    skipped: marker.skipped,
    deferred: marker.deferred,
    generations: marker.generations,
    durationMs: marker.durationMs,
    listenerLeak: marker.listenerLeak ?? null,
    reason: marker.reason ?? null,
    note: marker.note ?? null,
  }
}

/**
 * Compose the first-class `run.source` provenance section.
 *
 * `effectiveSourceSha` is the latest source-changing reload's bundle hash when the
 * run window has one, else the BOOT SHA (provenance "boot"), else null
 * (provenance "unknown"): the artifact never invents a SHA. A control-socket
 * `report` reply, when it belongs to THIS runId, is recorded as a read-only
 * cross-check; disagreements are named, never used to overwrite the file facts.
 */
export function composeRunSource({
  runId = null,
  boot = null,
  snapshotBuildHash = null,
  reloadWindow = null,
  socketBinding = null,
  acceptanceRecord = null,
  sourceExactness = null,
} = {}) {
  const window = reloadWindow ?? emptyReloadWindow(null, runId, 'reload_window_not_scanned')
  const bootSourceSha = boot?.sourceSha ?? null
  const bootSourceShaIsGitCommit = typeof bootSourceSha === 'string' && /^[a-f0-9]{40}$/i.test(bootSourceSha)
  const latestSourceReload = window.latestSourceReload ?? null
  const reloadHash = stringOrNull(latestSourceReload?.hash)
  const reloadSourceSha = stringOrNull(latestSourceReload?.sourceSha)
  const effectiveSourceSha = reloadHash ?? bootSourceSha ?? null
  const provenance = reloadHash !== null ? 'reload' : bootSourceSha !== null ? 'boot' : 'unknown'
  const acceptanceGitCommit = stringOrNull(acceptanceRecord?.gitCommit)
  const acceptanceCheckoutHead = stringOrNull(acceptanceRecord?.checkoutHead)
  const acceptanceGitCommitMismatch =
    acceptanceGitCommit !== null && bootSourceSha !== null && acceptanceGitCommit.toLowerCase() !== bootSourceSha.toLowerCase()
  const unclassifiedReload = Array.isArray(window.reloads)
    ? window.reloads.find((marker) => marker?.kind === 'unclassified') ?? null
    : null
  let exactGitSource
  if (sourceExactness !== null && sourceExactness?.status !== 'exact') {
    exactGitSource = { status: 'unknown', sourceSha: sourceExactness?.sourceSha ?? null, reason: sourceExactness?.reason ?? 'source_provenance_unavailable' }
  } else if (sourceExactness?.sourceSha && bootSourceSha && sourceExactness.sourceSha.toLowerCase() !== bootSourceSha.toLowerCase()) {
    exactGitSource = { status: 'unknown', sourceSha: sourceExactness.sourceSha, reason: `source_stream_boot_sha_disagreement artifact=${bootSourceSha} gate=${sourceExactness.sourceSha}` }
  } else if (reloadHash !== null) {
    exactGitSource = { status: 'unknown', sourceSha: sourceExactness?.sourceSha ?? null, reason: 'source_changing_reload_has_no_exact_git_sha' }
  } else if (unclassifiedReload !== null) {
    exactGitSource = { status: 'unknown', sourceSha: sourceExactness?.sourceSha ?? null, reason: `reload_source_effect_unattested line=${unclassifiedReload.lineIndex ?? 'unknown'}` }
  } else if (window.status !== 'valid') {
    exactGitSource = { status: 'unknown', sourceSha: sourceExactness?.sourceSha ?? null, reason: `source_window_unavailable ${window.reason ?? 'unknown'}` }
  } else if (!bootSourceShaIsGitCommit) {
    exactGitSource = { status: 'unknown', sourceSha: sourceExactness?.sourceSha ?? null, reason: bootSourceSha === null ? 'boot_source_sha_missing' : 'boot_source_sha_not_exact_git_sha' }
  } else if (acceptanceGitCommitMismatch) {
    exactGitSource = { status: 'unknown', sourceSha: sourceExactness?.sourceSha ?? null, reason: `acceptance_git_commit_mismatch boot=${bootSourceSha} acceptance=${acceptanceGitCommit}` }
  } else {
    exactGitSource = { status: 'exact', sourceSha: sourceExactness?.sourceSha ?? bootSourceSha, reason: null }
  }
  const provenanceBasis =
    reloadHash !== null
      ? `log:RELOAD@line ${latestSourceReload.lineIndex} hash=${reloadHash} trigger=${latestSourceReload.trigger ?? 'unknown'} (generation bundle hash; the git SHA behind that bundle is not attested by the marker)`
      : bootSourceSha !== null
        ? `log:BOOT@line ${window.bootLineIndex ?? 'unknown'} source=${bootSourceSha}; the run window in ${window.source ?? 'unknown'} (${window.count} RELOAD marker(s), ${window.sourceChangeCount} source-changing) carries no later source`
        : 'neither a source-changing RELOAD hash nor a BOOT source SHA could be read'

  const socketForRun = isPlainObject(socketBinding) && socketBinding.runId === runId ? socketBinding : null
  const socketHash = stringOrNull(socketForRun?.generationHash)
  const socketGenerationId = stringOrNull(socketForRun?.generationId)
  const fileHash = reloadHash ?? stringOrNull(window.bootBuildHash)
  // The socket reports the LIVE generation INSTANCE; the file records the instance a
  // reload created. Same hash + different instance is a restart of the same bundle,
  // NOT a source change - say so instead of letting a reader guess.
  const generationIdDiffers =
    socketHash !== null && socketGenerationId !== null && stringOrNull(latestSourceReload?.generationId) !== null
      ? socketGenerationId !== latestSourceReload.generationId
      : null
  const stagedCandidateHash = stringOrNull(window.unmatchedDeferred?.hash)
  // A FROZEN host keeps the staged candidate in `generationHash` without swapping
  // it in, so a socket hash equal to the staged candidate is NOT the executing
  // source. Name that instead of leaving a bare disagreement for a reader to misread.
  const frozenExplainsSocket =
    socketForRun?.frozen === true && socketHash !== null && stagedCandidateHash !== null && socketHash === stagedCandidateHash
  const disagreements = []
  let agrees = null
  if (socketHash !== null && fileHash !== null) {
    agrees = socketHash === fileHash
    if (!agrees) {
      disagreements.push(
        `control_socket_generationHash=${socketHash} vs file_${reloadHash !== null ? 'latest_source_reload' : 'boot_build'}_hash=${fileHash}`,
      )
    }
  }
  const crossCheck = {
    queried: socketBinding !== null && socketBinding !== undefined,
    readOnly: true,
    command: 'report',
    socketRunId: isPlainObject(socketBinding) ? (socketBinding.runId ?? null) : null,
    forRequestedRun: socketForRun !== null,
    generationHash: socketHash,
    generationId: socketGenerationId,
    generationIdDiffers,
    frozen: socketForRun?.frozen ?? null,
    stagedCandidateHash,
    frozenExplainsSocket,
    fileEffectiveHash: reloadHash,
    fileBootBuildHash: stringOrNull(window.bootBuildHash),
    agrees,
    note:
      socketForRun === null
        ? 'no live control-socket report for this runId was available: the file evidence stands alone'
        : frozenExplainsSocket
          ? 'the host is FROZEN: generationHash names the STAGED deferred candidate, so the EXECUTING source is still the last committed reload recorded above, not the socket hash'
          : generationIdDiffers === true && agrees === true
            ? 'the live generation is a NEWER INSTANCE of the same bundle hash (a restart, not a source change); a read-only `report` reply never overrides the file facts, it only cross-checks them'
            : 'a read-only `report` reply for this runId; it never overrides the file facts, only cross-checks them',
  }

  // A window with no source-changing reload can still be BLIND: another
  // run-scoped source can attest that the bundle changed mid-run while the window
  // shows no RELOAD. That is the one case where "provenance: boot" is not merely a
  // fallback but an unprovable claim, so it is named as missing evidence.
  const blindSources = []
  if (reloadHash === null && window.status === 'valid') {
    if (socketHash !== null && crossCheck.fileBootBuildHash !== null && socketHash !== crossCheck.fileBootBuildHash) {
      blindSources.push(`control_socket generationHash=${socketHash} differs from the window's boot BUILD hash=${crossCheck.fileBootBuildHash}`)
    }
    if (typeof snapshotBuildHash === 'string' && snapshotBuildHash !== '' && crossCheck.fileBootBuildHash !== null && snapshotBuildHash !== crossCheck.fileBootBuildHash) {
      blindSources.push(`run-scoped snapshot buildHash=${snapshotBuildHash} differs from the window's boot BUILD hash=${crossCheck.fileBootBuildHash}`)
    }
  }

  return {
    bootSourceSha,
    bootSourceShaKind: bootSourceSha === null ? null : bootSourceShaIsGitCommit ? 'git-commit-sha' : 'unvalidated-source-identifier',
    exactGitSource: {
      ...exactGitSource,
      evidence: sourceExactness
        ? {
            path: sourceExactness.path ?? null,
            attempts: sourceExactness.attempts ?? [],
            observations: sourceExactness.observations ?? [],
            reloadCount: sourceExactness.reloadCount ?? 0,
            sourceChangeCount: sourceExactness.sourceChangeCount ?? 0,
            changedMarkers: sourceExactness.changedMarkers ?? [],
            ambiguousMarkers: sourceExactness.ambiguousMarkers ?? [],
          }
        : null,
    },
    acceptanceSource: {
      gitCommit: acceptanceGitCommit,
      checkoutHead: acceptanceCheckoutHead,
      gitCommitAgreesWithBoot: acceptanceGitCommit === null ? null : !acceptanceGitCommitMismatch,
      // checkoutHead is deliberately descriptive: it may move after boot and does
      // not rewrite the immutable source identity. A live generation reload is
      // separately rejected above unless that generation carries an exact Git SHA.
      checkoutHeadDiffersFromBoot:
        acceptanceCheckoutHead === null || bootSourceSha === null
          ? null
          : acceptanceCheckoutHead.toLowerCase() !== bootSourceSha.toLowerCase(),
    },
    latestReload: reloadView(window.latestReload, window.count),
    latestSourceReload: reloadView(latestSourceReload, window.count),
    effectiveSourceSha,
    effectiveSourceShaKind:
      effectiveSourceSha === null
        ? null
        : reloadHash !== null
          ? 'generation-bundle-hash'
          : bootSourceShaIsGitCommit
            ? 'git-commit-sha'
            : 'unvalidated-source-identifier',
    provenance,
    provenanceBasis,
    reloadCount: window.count,
    sourceChangeCount: window.sourceChangeCount,
    observed: window.reloads,
    window: {
      status: window.status,
      reason: window.reason ?? null,
      path: window.source ?? null,
      runId,
      rule: 'BOOT ... runId=R opens the window; a later BOOT for another run closes it (same rule as tools/m2-gate.mjs scanRunLines)',
      bootLineIndex: window.bootLineIndex,
      bootTsMs: window.bootTsMs,
      closedByRunId: window.closedByRunId,
      scannedToEof: window.scannedToEof === true,
      bootBuildHash: crossCheck.fileBootBuildHash,
      // Which stream was tried, in order: `runner.out` is TRUNCATED on restart while
      // `buddy.log` is append-only, so a superseded run resolves from the log.
      attempts: window.attempts ?? null,
    },
    unmatchedDeferred: window.unmatchedDeferred ?? null,
    windowBlind: { detected: blindSources.length > 0, reasons: blindSources },
    crossCheck,
    disagreements,
    note: 'bootSourceSha is the run ORIGIN (BOOT line); effectiveSourceSha is what the run window proves executed at its end (latest source-changing RELOAD hash, else the BOOT SHA). With provenance=reload the value is the host generation BUNDLE hash, not a git commit.',
  }
}

/**
 * The run window can live in EITHER stream. A detached resident writes
 * `runner.out`, whose redirect TRUNCATES the file on restart, so a run superseded
 * by a host restart keeps no window there; `buddy.log` is append-only and still
 * holds that run's BOOT/RELOAD markers. Prefer the stream the caller named, fall
 * back to the log only when it does not carry this run's BOOT boundary, and record
 * both attempts so a reader sees which stream answered and why the other could not.
 */
async function scanRunSourceWindow(paths, runId) {
  const attempts = []
  const primary = await scanRunReloadWindow(paths.runnerOutPath, runId)
  attempts.push({ path: paths.runnerOutPath ?? null, status: primary.status, reason: primary.reason ?? null })
  let window = primary
  if (primary.status !== 'valid' && typeof paths.logPath === 'string' && paths.logPath !== paths.runnerOutPath) {
    const fallback = await scanRunReloadWindow(paths.logPath, runId)
    attempts.push({ path: paths.logPath, status: fallback.status, reason: fallback.reason ?? null })
    if (fallback.status === 'valid') window = fallback
  }
  return { ...window, attempts }
}

// ---------------------------------------------------------------------------
// evidence readers (each independently bound to the requested runId)
// ---------------------------------------------------------------------------

export function derivePaths(root, overrides = {}) {
  const acceptanceDir = overrides.acceptanceDir ?? join(root, 'buddy-driver', 'data', 'resident')
  // Operator decisions are a REPO-level product record, not resident data, so the
  // default is repo-relative; each entry is still scoped to its own runId.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
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
    operatorDecisions:
      overrides.operatorDecisions === null
        ? null
        : overrides.operatorDecisions ?? join(repoRoot, 'OPERATOR-DECISIONS.json'),
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
// operator decisions (an explicit product decision, never a gate verdict)
// ---------------------------------------------------------------------------
//
// Some milestones are passed by an operator ruling over STANDING/durable
// evidence that a single run did not itself produce (the live case: M2 inherited
// a previously verified lit portal, so `tools/m2-gate.mjs` correctly reports
// UNKNOWN `inherited_portal`). The operator's ruling must be visible in the
// artifact WITHOUT silently rewriting the delegated gate verdict:
//
//   * `verdicts.<M>.status` stays exactly what the gate emitted;
//   * `verdicts.<M>.operatorDecision` records the ruling, its authority, its
//     run scope and the gate facts that CORROBORATE its `basis`;
//   * a decision whose basis the gate does not corroborate is recorded as
//     NOT_APPLIED, never applied.
//
// The decision file is run-scoped by each entry's own `runId` / `runIds`; an
// entry with neither does NOT apply (a standing ruling must say so explicitly
// with `standing: true`).

export function readOperatorDecisions(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) {
    return { present: false, path: path ?? null, reason: 'operator_decisions_missing', sha256: null, decisions: [] }
  }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { present: false, path, reason: 'operator_decisions_unreadable', sha256: null, decisions: [] }
  }
  // The decision file is a REPO-level product record and more than one checkout of
  // this repo exists; the content hash is what makes `source` exact, so a reviewer
  // can tell WHICH copy of the ruling an artifact was built against.
  const sha256 = createHash('sha256').update(text).digest('hex')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { present: false, path, reason: 'operator_decisions_unreadable', sha256, decisions: [] }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.decisions) ? parsed.decisions : null
  if (list === null) return { present: false, path, reason: 'operator_decisions_shape_mismatch', sha256, decisions: [] }
  const decisions = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      (entry.record === undefined || entry.record === OPERATOR_DECISION_RECORD) &&
      typeof entry.milestone === 'string' &&
      (entry.status === 'PASS' || entry.status === 'FAIL'),
  )
  return { present: true, path, reason: null, sha256, decisions }
}

function decisionAppliesToRun(entry, runId) {
  if (typeof entry.runId === 'string' && entry.runId.length > 0) return entry.runId === runId
  if (Array.isArray(entry.runIds)) return entry.runIds.includes(runId)
  return entry.standing === true
}

/** The scope a decision entry declares: its own runId / runIds / `standing`, else null. */
export function operatorDecisionScope(entry) {
  if (typeof entry?.runId === 'string' && entry.runId.length > 0) return entry.runId
  if (Array.isArray(entry?.runIds)) return [...entry.runIds]
  if (entry?.standing === true) return 'standing'
  return null
}

/** The gate facts that must corroborate a decision's `basis` before it is applied. */
export function corroborateOperatorDecision(entry, gateVerdict) {
  const basis = typeof entry?.basis === 'string' ? entry.basis : null
  const lines = Array.isArray(gateVerdict?.lines) ? gateVerdict.lines : []
  if (basis === 'inherited_portal') {
    const inherited = lines.filter((line) => /^m2_inherited_portal: true\b/.test(String(line)))
    return { corroborated: inherited.length > 0, evidence: { basis, inheritedPortalLines: inherited, gateStatus: gateVerdict?.status ?? null } }
  }
  return { corroborated: false, evidence: { basis, reason: 'unknown_basis', gateStatus: gateVerdict?.status ?? null } }
}

/**
 * Select and corroborate the operator decision for ONE milestone. The delegated
 * gate verdict is NEVER modified; the caller attaches the returned annotation.
 */
export function selectOperatorDecision(decisions, { milestone, runId, gateVerdict } = {}) {
  const list = Array.isArray(decisions) ? decisions : []
  const matching = list.filter((entry) => entry.milestone === milestone && decisionAppliesToRun(entry, runId))
  if (matching.length === 0) return { applied: false, reason: 'no_matching_operator_decision', entry: null, evidence: null }
  for (const entry of matching) {
    const corroboration = corroborateOperatorDecision(entry, gateVerdict)
    if (corroboration.corroborated) return { applied: true, reason: null, entry, evidence: corroboration.evidence }
  }
  const first = matching[0]
  return {
    applied: false,
    reason: `basis_not_corroborated:${first.basis ?? 'none'}`,
    entry: first,
    evidence: corroborateOperatorDecision(first, gateVerdict).evidence,
  }
}

/**
 * The STRUCTURED gate facts an operator decision's `basis` is corroborated against.
 * Before schema 5 the assembler kept only the gate's human `factsLine`, so
 * "inherited (live_world_truth / runtime_verified_without_build_chain) vs built"
 * survived only as prose. This is a reader: it copies what the gate computed.
 */
export function summarizeGateFacts(gateVerdict) {
  const conditions = isPlainObject(gateVerdict?.conditions) ? { ...gateVerdict.conditions } : {}
  const facts = isPlainObject(gateVerdict?.facts) ? gateVerdict.facts : null
  if (facts === null) return { available: false, conditions, reason: 'gate_facts_unavailable' }
  const inheritedPortal = isPlainObject(facts.inheritedPortal) ? facts.inheritedPortal : null
  const eyes = isPlainObject(facts.eyes) ? facts.eyes : null
  return {
    available: true,
    conditions,
    missing: Array.isArray(facts.missing) ? [...facts.missing] : null,
    framePass: typeof facts.framePass === 'boolean' ? facts.framePass : null,
    litPass: typeof facts.litPass === 'boolean' ? facts.litPass : null,
    netherReached: typeof facts.netherReached === 'boolean' ? facts.netherReached : null,
    inheritedPortal:
      inheritedPortal === null
        ? null
        : {
            detected: inheritedPortal.detected === true,
            observations: (Array.isArray(inheritedPortal.observations) ? inheritedPortal.observations : []).map((observation) => ({
              kind: observation?.kind ?? null,
              source: observation?.source ?? null,
              reason: observation?.reason ?? null,
            })),
          },
    eyes:
      eyes === null
        ? null
        : {
            ready: eyes.ready === true,
            enderEye: eyes.enderEye ?? null,
            enderPearl: eyes.enderPearl ?? null,
            blazeRod: eyes.blazeRod ?? null,
            blazePowder: eyes.blazePowder ?? null,
            materialInputsComplete: eyes.materialInputsComplete === true,
          },
  }
}

/**
 * WHAT a recorded operator decision COVERS, per run — and whether THIS run inherits
 * it or must build the milestone on its own facts.
 *
 * This is a DERIVED VIEW: it never edits the operator's entry, never rewrites the
 * delegated gate verdict, and never turns an UNKNOWN into a PASS. It exists because
 * an operator decision is scoped to its own runId, so on every OTHER run the
 * artifact used to say nothing at all about the milestone's premise (the annotation
 * was simply null) even though `verdicts.M2.reason` was `inherited_portal`.
 */
export function operatorDecisionPremise({ decisions, milestone, runId, gateVerdict = null, decisionsPath = null } = {}) {
  const entries = (Array.isArray(decisions) ? decisions : []).filter((entry) => entry.milestone === milestone)
  const base = {
    milestone,
    runId,
    source: decisionsPath,
    gateStatus: gateVerdict?.status ?? null,
    gateReason: gateVerdict?.reason ?? null,
    gateFacts: summarizeGateFacts(gateVerdict),
  }
  const note =
    'derived view of the recorded operator decision(s): the entry itself is never rewritten and the delegated gate verdict above is UNCHANGED'
  if (entries.length === 0) {
    return {
      ...base,
      present: false,
      reason: 'no_operator_decision_recorded',
      thisRunInherits: false,
      thisRunBasis: null,
      thisRunMust: 'build',
      consequence:
        `no operator decision for ${milestone} is recorded, so this run's ${milestone} premise can only be met by this run's own facts ` +
        `(delegated gate status=${gateVerdict?.status ?? 'UNKNOWN'} reason=${gateVerdict?.reason ?? 'unknown'})`,
      decisions: [],
      note,
    }
  }
  const considered = entries.map((entry) => {
    const applies = decisionAppliesToRun(entry, runId)
    const corroboration = applies ? corroborateOperatorDecision(entry, gateVerdict) : null
    const outcome = applies
      ? corroboration.corroborated
        ? 'inherited_by_this_run'
        : 'basis_not_corroborated_by_this_run'
      : 'scoped_to_another_run'
    return {
      status: entry.status,
      authority: typeof entry.authority === 'string' ? entry.authority : 'operator',
      basis: typeof entry.basis === 'string' ? entry.basis : null,
      // The entry's OWN declared scope string (e.g. "M2 only"), carried verbatim.
      decisionScope: typeof entry.scope === 'string' ? entry.scope : null,
      runScope: operatorDecisionScope(entry),
      recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : null,
      ruling: typeof entry.ruling === 'string' ? entry.ruling : null,
      appliesToThisRun: applies,
      corroboratedByThisRun: corroboration === null ? null : corroboration.corroborated,
      outcome,
      reason: applies ? (corroboration.corroborated ? null : `basis_not_corroborated:${entry.basis ?? 'none'}`) : 'scoped_to_another_run',
    }
  })
  const inherited = considered.find((decision) => decision.outcome === 'inherited_by_this_run') ?? null
  const covering = considered.filter((decision) => decision.appliesToThisRun)
  const scoped = considered.filter((decision) => !decision.appliesToThisRun)
  let consequence
  if (inherited !== null) {
    consequence =
      `this run INHERITS the recorded ${milestone} ${inherited.status} on basis=${inherited.basis ?? 'none'} ` +
      `(runScope=${JSON.stringify(inherited.runScope)}${inherited.decisionScope === null ? '' : `, scope=${JSON.stringify(inherited.decisionScope)}`}); ` +
      `the delegated gate verdict stays ${base.gateStatus} reason=${base.gateReason}`
  } else if (covering.length > 0) {
    consequence =
      `a recorded decision covers this run (runScope=${JSON.stringify(covering[0].runScope)}) but this run's gate facts do NOT corroborate ` +
      `basis=${covering[0].basis ?? 'none'} (${covering[0].reason}); the ${milestone} premise is UNRESOLVED for this run and the delegated verdict stays ` +
      `${base.gateStatus} reason=${base.gateReason}`
  } else {
    consequence =
      `the recorded ${milestone} ${scoped[0].status} is scoped to runScope=${JSON.stringify(scoped[0].runScope)}` +
      `${scoped[0].decisionScope === null ? '' : ` (scope=${JSON.stringify(scoped[0].decisionScope)})`} and does NOT cover this run ` +
      `(runId=${runId}): the ${milestone} premise must be BUILT in-run for this run, or a new operator decision scoped to runId=${runId} must be recorded. ` +
      `The recorded ruling is unchanged for its own scope; the delegated verdict stays ${base.gateStatus} reason=${base.gateReason}`
  }
  return {
    ...base,
    present: true,
    reason: inherited !== null ? null : covering.length > 0 ? covering[0].reason : 'scoped_to_another_run',
    thisRunInherits: inherited !== null,
    thisRunBasis: inherited?.basis ?? null,
    thisRunMust: inherited !== null ? 'inherit' : 'build',
    consequence,
    decisions: considered,
    note,
  }
}

/** The per-run fields of one considered decision (used by `operatorDecisions.considered`). */
function decisionSummary(decision) {
  return {
    status: decision.status,
    basis: decision.basis,
    decisionScope: decision.decisionScope,
    runScope: decision.runScope,
    appliesToThisRun: decision.appliesToThisRun,
    outcome: decision.outcome,
    reason: decision.reason,
  }
}

function operatorDecisionAnnotation({ selection, decisionsPath, gateVerdict }) {
  if (selection.entry === null) return null
  const entry = selection.entry
  return {
    decision: 'operator',
    status: selection.applied ? entry.status : 'NOT_APPLIED',
    authority: typeof entry.authority === 'string' ? entry.authority : 'operator',
    ruling: typeof entry.ruling === 'string' ? entry.ruling : null,
    recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : null,
    basis: typeof entry.basis === 'string' ? entry.basis : null,
    reason: selection.reason,
    source: decisionsPath,
    runScope: typeof entry.runId === 'string' ? entry.runId : Array.isArray(entry.runIds) ? [...entry.runIds] : 'standing',
    gateStatus: gateVerdict?.status ?? null,
    evidence: selection.evidence,
    note: 'records an explicit operator product decision over standing evidence; the delegated gate verdict above is UNCHANGED',
  }
}

// ---------------------------------------------------------------------------
// descriptive composition (never a verdict)
// ---------------------------------------------------------------------------

function composeInventory({ attribution, snapshot, bootSourceSha, runId }) {
  const samples = attribution.inventorySamples.map((sample) => ({ source: 'log', ts: sample.ts, counts: sample.counts }))
  const snapshotInitial = asCounts(snapshot?.record?.initialInventory)
  const snapshotLatest = asCounts(snapshot?.record?.terminal?.inventory) ?? asCounts(snapshot?.record?.inventory)
  const snapshotBootSourceSha = typeof snapshot?.record?.bootSourceSha === 'string' ? snapshot.record.bootSourceSha : null
  let bootReason = null
  let boot = null
  if (!snapshot?.present || snapshot?.status !== 'valid' || snapshot?.record?.runId !== runId) {
    bootReason = 'run_scoped_initial_inventory_snapshot_unavailable'
  } else if (snapshotInitial === null) {
    bootReason = 'snapshot_initial_inventory_missing'
  } else if (bootSourceSha === null || bootSourceSha === undefined) {
    bootReason = 'run_boot_source_sha_missing'
  } else if (snapshotBootSourceSha === null) {
    bootReason = 'snapshot_boot_source_sha_missing'
  } else if (snapshotBootSourceSha !== bootSourceSha) {
    bootReason = `snapshot_boot_source_sha_mismatch expected=${bootSourceSha} observed=${snapshotBootSourceSha}`
  } else {
    // Generation-entry initialInventory is the only boot-time sample. Periodic
    // INVENTORY lines can describe an already-changed inventory and never
    // substitute for this source, even when they happen to be the first log row.
    boot = { source: 'snapshot', ts: snapshot?.record?.at ?? null, counts: snapshotInitial }
  }
  let latest = samples.at(-1) ?? null
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
      boot: boot === null ? null : Object.prototype.hasOwnProperty.call(bootCounts, item) ? bootCounts[item] : 0,
      latest: Object.prototype.hasOwnProperty.call(latestCounts, item) ? latestCounts[item] : 0,
      final: null,
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
    bootEvidence: { status: boot === null ? 'unknown' : 'verified', reason: bootReason, runId, bootSourceSha: bootSourceSha ?? null, snapshotBootSourceSha },
    latest,
    final: null,
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
    const text = readFileSync(path, 'utf8')
    const parsed = JSON.parse(text)
    const values = parsed?.values ?? parsed
    if (!isPlainObject(values)) return null
    const configurationChanges = Array.isArray(parsed?.configurationChanges) ? parsed.configurationChanges : null
    // `configurationChanges` records settings selected before world creation;
    // `worldChanges` records edits after creation. Keep these evidence classes
    // separate and preserve each descriptor entry verbatim.
    const worldChanges = Array.isArray(parsed?.worldChanges) ? parsed.worldChanges : null
    return {
      path,
      mtime: statSync(path).mtime.toISOString(),
      sha256: createHash('sha256').update(text).digest('hex'),
      values,
      ...(configurationChanges === null ? {} : { configurationChanges }),
      ...(worldChanges === null ? {} : { worldChanges }),
    }
  } catch {
    return null
  }
}

function composeEnvironment({ observations, dimensions, dimensionTransitions = [], serverProperties, environmentFile = null, runId = null, sourceSha = null }) {
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
  // `sequence` records body-location observations; `transitions` records only
  // explicit live-world body transition events. A different observed location
  // (for example a Nether SPAWN) is not evidence that this run entered it.
  const sequence = []
  for (const entry of Array.isArray(dimensions) ? dimensions : []) {
    const previous = sequence.at(-1) ?? null
    if (previous !== null && previous.dimension === entry.dimension) continue
    sequence.push({ dimension: entry.dimension, firstAt: entry.ts ?? null, source: entry.source ?? 'log' })
  }
  const transitions = (Array.isArray(dimensionTransitions) ? dimensionTransitions : []).map((entry) => ({
    from: entry.from,
    to: entry.to,
    dimension: entry.dimension,
    at: entry.ts ?? null,
    atMs: entry.atMs,
    source: entry.source,
    runId,
    sourceSha,
  }))
  return {
    difficulty: fromLog('difficulty') ?? fromEnv('difficulty') ?? fromProps('difficulty'),
    mobSpawning: fromLog('mobSpawning') ?? fromEnv('mobSpawning') ?? fromProps('spawn-monsters'),
    spawnAnimals: fromLog('spawnAnimals') ?? fromEnv('spawnAnimals') ?? fromProps('spawn-animals'),
    gamerules: fromLog('gamerules') ?? fromEnv('gamerules'),
    environmentFile:
      environmentFile === null
        ? null
        : {
            path: environmentFile.path,
            mtime: environmentFile.mtime,
            sha256: environmentFile.sha256 ?? null,
            runScoped: false,
            values: environmentFile.values,
            ...(Array.isArray(environmentFile.configurationChanges) ? { configurationChanges: environmentFile.configurationChanges } : {}),
          },
    // A configuration change describes host/world-generation configuration
    // selected before this run; it is not a post-creation edit to the world.
    // Bind the exact descriptor entries to the BOOT identity and keep them in a
    // separate field from `worldChanges`, which remains reserved for edits.
    configurationChanges:
      Array.isArray(environmentFile?.configurationChanges)
        ? {
            source: environmentFile.path,
            descriptorSha256: environmentFile.sha256 ?? null,
            runId,
            sourceSha,
            count: environmentFile.configurationChanges.length,
            changes: environmentFile.configurationChanges,
          }
        : null,
    // The operator's M3 rules require an environment CHANGE (not just its configuration)
    // to be recorded with its reason and its effect on the run. A world edit is not a
    // config value, so it is carried verbatim from the environment record: what changed,
    // who changed it, why, how it was measured and what it did to the run. Empty when the
    // environment was never modified - an absent field and an empty list mean the same
    // thing here, and neither is evidence that nothing changed.
    worldChanges:
      Array.isArray(environmentFile?.worldChanges) && environmentFile.worldChanges.length > 0
        ? { source: environmentFile.path, mtime: environmentFile.mtime, runScoped: false, count: environmentFile.worldChanges.length, changes: environmentFile.worldChanges }
        : null,
    dimensions: {
      count: (dimensions ?? []).length,
      observed: observedDimensions,
      first: dimensions?.length ? { ts: dimensions[0].ts, dimension: dimensions[0].dimension } : null,
      last: dimensions?.length ? { ts: dimensions.at(-1).ts, dimension: dimensions.at(-1).dimension } : null,
      sequence,
      transitions,
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
 * policy loader does not surface (policyProvider / plannerModel / the System2
 * authority stack and the decisions that answered). Attribution uses the SAME
 * BOOT-boundary rule as the log scan: a `BOOT ... runId=R` opens R, a later BOOT
 * for another run closes it. This is reading, not judging: when the loader can
 * bind a gate window we restrict to it, otherwise the descriptive facts are still
 * reported and the artifact records that the GATE could not bind them
 * (`authority.gateBound=false`).
 *
 * Every captured fact carries the line index it came from, so a reader can point
 * at the exact run-scoped line instead of trusting a summary.
 */
export async function readAuthorityExtras(runnerOutPath, runId, policy = null) {
  if (typeof runnerOutPath !== 'string' || !existsSync(runnerOutPath)) return null
  const policyStartMs = policy?.window?.startMs ?? null
  const policyEndMs = policy?.window?.endMs ?? null
  let activeRunId = null
  let boundaryFound = false
  let bootTsMs = null
  let generation = null
  let generationCount = 0
  const generationMarkers = []
  let system2Decision = null
  const system2Decisions = []
  const system2Inputs = []
  const system2LineageEvents = []
  let lineIndex = -1
  const rl = createInterface({ input: createReadStream(runnerOutPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    lineIndex += 1
    if (BOOT_RE.test(line)) {
      const rid = RUN_ID_LINE_RE.exec(line)?.[1] ?? null
      if (rid !== null) {
        if (boundaryFound && rid !== runId) break
        activeRunId = rid
        if (rid === runId) {
          boundaryFound = true
          bootTsMs = timestampMsOf(line)
          generation = null
          generationMarkers.length = 0
          system2Decision = null
          system2Decisions.length = 0
          system2Inputs.length = 0
          system2LineageEvents.length = 0
        }
      }
    }
    if (!boundaryFound || activeRunId !== runId) continue
    const tsMs = timestampMsOf(line)
    if (policyStartMs !== null && tsMs !== null && tsMs < policyStartMs) continue
    if (policyEndMs !== null && tsMs !== null && tsMs > policyEndMs) break
    if (line.includes('GENERATION_READY')) {
      const kv = parseKeyValues(line)
      generationCount += 1
      generation = {
        tsMs,
        lineIndex,
        generationId: stringOrNull(kv.id),
        sourceSha: stringOrNull(kv.sourceSha),
        buildHash: stringOrNull(kv.buildHash),
        policyKind: stringOrNull(kv.policy ?? kv.policyKind),
        policyProvider: stringOrNull(kv.policyProvider),
        policyModel: stringOrNull(kv.policyModel ?? kv.model),
        plannerMode: stringOrNull(kv.planner ?? kv.plannerMode),
        plannerModel: stringOrNull(kv.plannerModel),
        deterministicFallbackEnabled: booleanOrNull(kv.deterministicFallbackEnabled),
        // The controller's LAST answerer, not the configured authority. The host
        // initialises it to `none` until a model actually answers.
        system2Provider: stringOrNull(kv.system2Provider),
        system2Model: stringOrNull(kv.system2Model),
        system2ConfiguredProvider: stringOrNull(kv.system2ConfiguredProvider),
        system2ConfiguredModel: stringOrNull(kv.system2ConfiguredModel),
        system2AuthorityStack: isPlainObject(kv.system2AuthorityStack) ? kv.system2AuthorityStack : null,
        system2LastAuthority: isPlainObject(kv.system2LastAuthority) ? kv.system2LastAuthority : null,
        advisor: stringOrNull(kv.advisor),
        advisorSource: stringOrNull(kv.advisorSource),
        optionCompiler: booleanOrNull(kv.optionCompiler),
      }
      generationMarkers.push(generation)
    } else if (line.includes('SYSTEM2_AUTHORITY_INPUT') || line.includes('SYSTEM2_AUTHORITY_DECISION') || line.includes('SYSTEM2_AUTHORITY_STALE_DISCARD') || line.includes('SYSTEM2_AUTHORITY_WAIT_LIMIT_HELD')) {
      const kv = parseKeyValues(line)
      const record = {
        tsMs,
        lineIndex,
        event: line.match(/\b(SYSTEM2_AUTHORITY_[A-Z_]+)/)?.[1] ?? 'SYSTEM2_AUTHORITY_UNKNOWN',
        generationId: stringOrNull(kv.generationId ?? kv.id),
        sourceSha: stringOrNull(kv.sourceSha),
        buildHash: stringOrNull(kv.buildHash),
        provider: stringOrNull(kv.provider),
        model: stringOrNull(kv.model),
        configuredProvider: stringOrNull(kv.configuredProvider),
        configuredModel: stringOrNull(kv.configuredModel),
        chosen: stringOrNull(kv.chosen),
        source: stringOrNull(kv.source),
        trigger: stringOrNull(kv.trigger),
        reason: stringOrNull(kv.reason),
      }
      system2LineageEvents.push(record)
      if (record.event === 'SYSTEM2_AUTHORITY_INPUT') system2Inputs.push(record)
      if (record.event === 'SYSTEM2_AUTHORITY_DECISION') {
        const decision = { ...record, op: stringOrNull(kv.op), strategy: stringOrNull(kv.strategy) }
        system2Decisions.push(decision)
        system2Decision = decision
      }
    }
  }
  if (!boundaryFound) return null
  return {
    boundaryFound,
    source: runnerOutPath,
    bootTsMs,
    window: policy?.window ?? null,
    generation,
    generationCount,
    generationMarkers,
    system2Decision,
    system2Decisions,
    system2Inputs,
    system2LineageEvents,
  }
}

/** How many of the (sparse) System2 decisions the artifact keeps verbatim. */
export const SYSTEM2_DECISION_KEEP = 20

function mergeAuthorityLineageRecords(preferred, raw) {
  const primary = Array.isArray(preferred) ? preferred : []
  const secondary = Array.isArray(raw) ? raw : []
  if (primary.length === 0) return secondary
  if (secondary.length === 0) return primary
  const unused = new Set(secondary.map((_, index) => index))
  const merged = primary.map((record) => {
    let matchIndex = -1
    if (record?.lineIndex != null) {
      matchIndex = secondary.findIndex((candidate, index) => unused.has(index) && candidate?.lineIndex === record.lineIndex)
    }
    if (matchIndex < 0) {
      matchIndex = secondary.findIndex((candidate, index) => unused.has(index) &&
        candidate?.tsMs === record?.tsMs && candidate?.event === record?.event &&
        candidate?.provider === record?.provider && candidate?.model === record?.model &&
        candidate?.chosen === record?.chosen && candidate?.generationId === record?.generationId)
    }
    const fallback = matchIndex < 0 ? null : secondary[matchIndex]
    if (matchIndex >= 0) unused.delete(matchIndex)
    const combined = { ...(fallback ?? {}), ...(record ?? {}) }
    for (const [key, value] of Object.entries(fallback ?? {})) {
      if ((combined[key] === null || combined[key] === undefined) && value !== null && value !== undefined) combined[key] = value
    }
    return combined
  })
  for (const index of unused) merged.push(secondary[index])
  return merged.sort((left, right) => {
    const leftTs = Number.isFinite(left?.tsMs) ? left.tsMs : Number.MAX_SAFE_INTEGER
    const rightTs = Number.isFinite(right?.tsMs) ? right.tsMs : Number.MAX_SAFE_INTEGER
    if (leftTs !== rightTs) return leftTs - rightTs
    const leftIndex = Number.isFinite(left?.lineIndex) ? left.lineIndex : Number.MAX_SAFE_INTEGER
    const rightIndex = Number.isFinite(right?.lineIndex) ? right.lineIndex : Number.MAX_SAFE_INTEGER
    return leftIndex - rightIndex
  })
}

/**
 * Compose the authority section from run-scoped facts only.
 *
 * The EFFECTIVE System2 provider/model is the configured authority stack the
 * in-window `GENERATION_READY` marker attests (`system2AuthorityStack`), falling
 * back to the last in-window `SYSTEM2_AUTHORITY_DECISION` when no stack is
 * parseable. The last answerer and every decision stay visible next to it, so a
 * run whose stack is configured but whose last answer came from elsewhere is
 * reported as a disagreement instead of being silently collapsed.
 */
async function composeAuthority({ runId, runnerOutPath, policy, extras }) {
  const generation = policy?.generation ?? null
  const extra = extras?.generation ?? null
  const system2 = policy?.system2 ?? null
  const decisions = policy?.decisions ?? null
  const policyDecisions = Array.isArray(system2?.decisions) ? system2.decisions : []
  const extraDecisions = Array.isArray(extras?.system2Decisions) ? extras.system2Decisions : []
  const decisionList = mergeAuthorityLineageRecords(policyDecisions, extraDecisions)
  const inputList = mergeAuthorityLineageRecords(system2?.inputs, extras?.system2Inputs)
  const generationMarkers = Array.isArray(extras?.generationMarkers) ? extras.generationMarkers : []
  const identityStatus = system2?.identityStatus ?? 'unknown'
  const identityReason = system2?.identityReason ?? (identityStatus === 'verified' ? null : 'policy_loader_did_not_verify_system2_generation_lineage')
  const identityIssues = Array.isArray(system2?.identityIssues) ? system2.identityIssues : []
  const latestDecision = decisionList.at(-1) ?? null
  const stack = parseAuthorityStack(extra?.system2AuthorityStack)

  // The Jev pi authority: the host's explicit `policyProvider=`/`policyModel=`
  // fields first, the loader's generation bundle second, the host's own
  // kind->provider getter only when the explicit field is absent (and labelled).
  const explicitProvider = extra?.policyProvider ?? null
  const policyProvider = explicitProvider ?? providerFromPolicyKind(generation?.policyKind ?? extra?.policyKind ?? null)
  const policyModel = generation?.policyModel ?? extra?.policyModel ?? null
  const jevSource =
    explicitProvider !== null
      ? 'log:GENERATION_READY:policyProvider'
      : policyProvider !== null
        ? 'derived:policyKind (jev-agent/src/controller-legacy.ts get policyProvider())'
        : generation?.source ?? null
  const jev = {
    provider: policyProvider,
    model: policyModel,
    attested: policyProvider !== null && policyModel !== null,
    source: jevSource,
    tsMs: extra?.tsMs ?? generation?.tsMs ?? null,
    lineIndex: extra?.lineIndex ?? null,
    evidence: {
      generationReadyPolicyProvider: explicitProvider,
      generationReadyPolicyModel: extra?.policyModel ?? null,
      loaderPolicyKind: generation?.policyKind ?? null,
      loaderSource: generation?.source ?? null,
      authorityStackLeftHalf: stack.jev,
    },
  }

  let system2Resolution
  if (stack.system2 !== null) {
    system2Resolution = {
      provider: stack.system2.provider,
      model: stack.system2.model,
      source: 'log:GENERATION_READY:system2AuthorityStack',
      tsMs: extra?.tsMs ?? null,
      lineIndex: extra?.lineIndex ?? null,
      kind: 'configured_authority_stack',
    }
  } else if (latestDecision !== null && (latestDecision.provider !== null || latestDecision.model !== null)) {
    system2Resolution = {
      provider: latestDecision.provider ?? null,
      model: latestDecision.model ?? null,
      source: 'log:SYSTEM2_AUTHORITY_DECISION',
      tsMs: latestDecision.tsMs ?? null,
      lineIndex: latestDecision.lineIndex ?? null,
      kind: 'last_authority_decision',
    }
  } else {
    system2Resolution = { provider: null, model: null, source: null, tsMs: null, lineIndex: null, kind: null }
  }

  // A configured stack plus a DIFFERENT last answerer is not an error, but it
  // must be visible: the two fields answer different questions.
  const disagreements = []
  if (
    stack.system2 !== null &&
    latestDecision !== null &&
    typeof latestDecision.provider === 'string' &&
    latestDecision.provider !== stack.system2.provider
  ) {
    disagreements.push(`last_answerer=${latestDecision.provider} vs configured_stack=${stack.system2.provider}`)
  }
  if (stack.jev !== null && policyProvider !== null && policyModel !== null && stack.jev.provider !== policyProvider) {
    disagreements.push(`authority_stack_jev=${stack.jev.provider} vs policyProvider=${policyProvider}`)
  }
  if (stack.jev !== null && policyModel !== null && stack.jev.model !== policyModel) {
    disagreements.push(`authority_stack_jev_model=${stack.jev.model} vs policyModel=${policyModel}`)
  }

  // "No hidden deterministic fallback" is answered by two independent host
  // facts: the run-scoped flag and the run-window decision sources.
  const fallbackEnabled = generation?.deterministicFallbackEnabled ?? extra?.deterministicFallbackEnabled ?? null
  const countsKnown = decisions !== null &&
    [decisions.jevCount, decisions.fallbackCount, decisions.otherCount, decisions.unclassifiableCount]
      .every((count) => Number.isInteger(count) && count >= 0)
  const fallbackDecisions = countsKnown ? decisions.fallbackCount : null
  const otherDecisions = countsKnown ? decisions.otherCount : null
  const unclassifiableDecisions = countsKnown ? decisions.unclassifiableCount : null
  let hiddenFallback
  let fallbackReason
  if (fallbackEnabled === true || (fallbackDecisions !== null && fallbackDecisions > 0)) {
    hiddenFallback = 'observed'
    fallbackReason = fallbackEnabled === true ? 'deterministicFallbackEnabled=true' : `fallback_decisions=${fallbackDecisions}`
  } else if (fallbackEnabled === false && countsKnown && fallbackDecisions === 0 && otherDecisions === 0 && unclassifiableDecisions === 0) {
    hiddenFallback = 'none_observed'
    fallbackReason = 'deterministicFallbackEnabled=false and every in-window decision source is classifiable with no fallback or other sources'
  } else {
    hiddenFallback = 'unknown'
    fallbackReason =
      fallbackEnabled === null
        ? 'deterministicFallbackEnabled_unavailable'
        : !countsKnown
          ? 'decision_source_counts_unavailable'
          : unclassifiableDecisions > 0
            ? `decision_records_unclassifiable=${unclassifiableDecisions}`
          : otherDecisions > 0
            ? `decisions_with_other_source=${otherDecisions}`
            : 'insufficient_fallback_evidence'
  }

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
    policyProvider,
    policyModel,
    plannerModel: extra?.plannerModel ?? null,
    deterministicFallbackEnabled: fallbackEnabled,
    jev,
    system2: {
      provider: system2Resolution.provider,
      model: system2Resolution.model,
      attested: system2Resolution.provider !== null && system2Resolution.model !== null,
      identityStatus: system2?.identityStatus ?? null,
      identityReason: system2?.identityReason ?? null,
      identityIssues: Array.isArray(system2?.identityIssues) ? system2.identityIssues : [],
      effectiveProvider: system2?.effectiveProvider ?? null,
      effectiveModel: system2?.effectiveModel ?? null,
      configuredProvider: system2?.configuredProvider ?? null,
      configuredModel: system2?.configuredModel ?? null,
      sourceSha: system2?.sourceSha ?? null,
      generationIds: Array.isArray(system2?.generationIds) ? system2.generationIds : [],
      generationCount: Number.isFinite(system2?.generationCount) ? system2.generationCount : null,
      attestation: {
        kind: system2Resolution.kind,
        source: system2Resolution.source,
        tsMs: system2Resolution.tsMs,
        lineIndex: system2Resolution.lineIndex,
      },
      chosen: latestDecision?.chosen ?? extras?.system2Decision?.chosen ?? null,
      count: Number.isFinite(system2?.count) ? system2.count : decisionList.length,
      modelCount: Number.isFinite(system2?.modelCount) ? system2.modelCount : null,
      ineligibleModelCount: Number.isFinite(system2?.ineligibleModelCount) ? system2.ineligibleModelCount : null,
      portalPlanCount: Number.isFinite(system2?.portalPlanCount) ? system2.portalPlanCount : null,
      identityStatus,
      identityReason,
      identityIssues,
      effectiveProvider: system2?.effectiveProvider ?? null,
      effectiveModel: system2?.effectiveModel ?? null,
      configuredProvider: system2?.configuredProvider ?? null,
      configuredModel: system2?.configuredModel ?? null,
      sourceSha: system2?.sourceSha ?? null,
      generationIds: Array.isArray(system2?.generationIds) ? system2.generationIds : generationMarkers.map((marker) => marker?.generationId).filter((id) => typeof id === 'string'),
      generationCount: Number.isFinite(system2?.generationCount) ? system2.generationCount : extras?.generationCount ?? null,
      inputCount: Number.isFinite(system2?.inputCount) ? system2.inputCount : inputList.length,
      inputs: inputList,
      generations: generationMarkers,
      lineageEvents: Array.isArray(extras?.system2LineageEvents) ? extras.system2LineageEvents : [],
      authorityStack: extra?.system2AuthorityStack ?? null,
      stack,
      lastAuthority: extra?.system2LastAuthority ?? null,
      lastDecision: latestDecision,
      decisionCount: decisionList.length,
      decisions: decisionList,
      recentDecisions: decisionList.slice(-SYSTEM2_DECISION_KEEP),
      generationMarkerCount: extras?.generationCount ?? null,
      disagreements,
      note: 'provider/model are the CONFIGURED System2 authority stack attested by the run\'s own GENERATION_READY marker; lastAuthority/lastDecision are the last provider that actually answered',
    },
    fallback: {
      deterministicFallbackEnabled: fallbackEnabled,
      deterministicFallbackSource: generation !== null ? generation.source ?? 'generation' : extra !== null ? 'log:GENERATION_READY' : null,
      decisionsSource: decisions?.source ?? null,
      jevCount: countsKnown ? decisions.jevCount : null,
      fallbackCount: fallbackDecisions,
      otherCount: otherDecisions,
      unclassifiableCount: unclassifiableDecisions,
      hiddenDeterministicFallback: hiddenFallback,
      reason: fallbackReason,
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
            unclassifiableCount: decisions.unclassifiableCount ?? null,
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

/**
 * Carry the delegated M2 gate's ORDERED build->light->verify trace into the
 * run-scoped artifact.
 *
 * The gate's stage conditions say WHAT passed; they cannot say WHICH evidence
 * source proved each link, and a frame proven by the snapshot plus a light proven
 * by the log would look identical to one complete chain. The gate emits one
 * `m2_chain:` line per evidence source (tools/m2-gate.mjs formatPortalChainLine);
 * this turns them into per-link facts with their own `source`.
 *
 * The `best` link is the strongest source-level trace: a complete ordered chain
 * first, else the source that proved the build, else the one that lit. A source
 * named `none` is the gate stating no chain was found - it is recorded but can
 * never become `best`, so this field can never manufacture a link.
 *
 * Returns null when the gate emitted no `m2_chain:` line at all (an older gate),
 * so the field is absent rather than falsely empty.
 */
export function composePortalChain(lines) {
  const links = (Array.isArray(lines) ? lines : []).map((line) => parsePortalChainLine(line)).filter((link) => link !== null)
  if (links.length === 0) return null
  const proven = links.filter((link) => link.source !== 'none')
  const best =
    proven.find((link) => link.ordered === true) ??
    proven.find((link) => link.built === 'PASS') ??
    proven.find((link) => link.lit === 'PASS') ??
    null
  const linkFact = (name) => {
    if (best === null) return null
    const fact = { status: best[name], source: best.source }
    if (name === 'built') {
      fact.index = best.indices.frame
      fact.blocks = best.blocks
      fact.shape = best.shape
    } else if (name === 'lit') {
      fact.index = best.indices.lit
      fact.dimension = best.dimension
      fact.overworld = best.overworld
    } else {
      fact.index = best.indices.verified
    }
    return fact
  }
  return {
    ordered: best?.ordered === true,
    built: linkFact('built'),
    lit: linkFact('lit'),
    verified: linkFact('verified'),
    placedIndex: best === null ? null : best.indices.placed,
    sources: proven.map((link) => link.source),
    links,
  }
}

async function runDelegatedGate({ id, gate, gateRunner, runId, paths, policyEvidence, policySocket, sourceSha = null }) {
  const lines = []
  let code = 2
  let error = null
  // The gate's STRUCTURED verdict (conditions + facts), captured additively via
  // `onResult`. It is what an operator decision's `basis` is corroborated against,
  // so `inherited_portal` provenance is machine-readable instead of a regex over
  // the human lines.
  let gateResult = null
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
      // The run's BOOT source SHA, so the delegated gate independently rejects a
      // run-scoped resident observation written by a DIFFERENT build.
      sourceSha,
      json: false,
      write: (line) => lines.push(String(line)),
      onResult: (result) => {
        gateResult = result
      },
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
    missing.push({ field: `verdict:${id}`, reason: `the delegated gate emitted no ${id}_RUN_RESULT status line (exit code ${code})` })
  } else if (parsed.status !== codeStatus) {
    // Never reconcile a mismatch towards PASS; surface it as UNKNOWN.
    status = 'UNKNOWN'
    missing.push({
      field: `verdict:${id}:status_mismatch`,
      reason: `gate exit code ${code} implies ${codeStatus} but its status line says ${parsed.status} (reason=${parsed.reason}); a mismatch is never reconciled towards PASS`,
    })
  } else {
    status = parsed.status
    if (status === 'UNKNOWN') missing.push({ field: `verdict:${id}`, reason: `the gate reported UNKNOWN reason=${parsed.reason}` })
  }
  const factsLine = lines.find((line) => line.startsWith(`${id.toLowerCase()}_facts:`)) ?? null
  const verdict = {
    id,
    gate,
    runId,
    // Preserve the structured evaluator identity beside the requested run scope.
    // Aggregators can then bind a PASS to the same run and BOOT source instead of
    // trusting the wrapper's requested runId alone.
    gateRunId: typeof gateResult?.runId === 'string' ? gateResult.runId : null,
    gateStatus: ['PASS', 'FAIL', 'UNKNOWN'].includes(gateResult?.status) ? gateResult.status : null,
    sourceSha: typeof gateResult?.sourceSha === 'string' ? gateResult.sourceSha : null,
    sourceShaReason: typeof gateResult?.sourceShaReason === 'string' ? gateResult.sourceShaReason : null,
    status,
    reason: parsed?.reason ?? error ?? `gate_emitted_no_status code=${code}`,
    statusLine: parsed === null ? null : `${id}_RUN_RESULT`,
    // The gate's own CONDITIONS and structured FACTS (schema 5, additive). Both are
    // exactly what the delegated gate computed - never re-derived here - and the
    // line parser stays the fallback for a gate that did not return them.
    conditions: isPlainObject(gateResult?.conditions) ? { ...gateResult.conditions } : parseConditions(lines),
    facts: isPlainObject(gateResult?.facts) ? gateResult.facts : null,
    factsLine,
    lines,
  }
  // Additive: the ordered per-link chain trace, only when the gate emitted one.
  // Absent for gates that do not produce it (M3), never a fabricated empty chain.
  const chain = composePortalChain(lines)
  if (chain !== null) verdict.chain = chain
  return { verdict, missing }
}

// ---------------------------------------------------------------------------
// artifact assembly
// ---------------------------------------------------------------------------

/**
 * Every gap the artifact can report, with the reason it is a gap. `fields` keeps
 * the historical `missingEvidence` string list (same order, same values) so
 * existing readers keep working; `detail` is the one clear list an operator
 * reads: field + why it is missing + which source would provide it.
 */
function missingCollector() {
  const fields = []
  const detail = []
  return {
    fields,
    detail,
    add(field, reason) {
      fields.push(field)
      detail.push({ field, reason })
    },
  }
}

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
      M2: {
        id: 'M2',
        gate: 'tools/m2-gate.mjs',
        runId: null,
        status: 'UNKNOWN',
        reason,
        conditions: {},
        facts: null,
        lines: [],
        operatorDecision: null,
        operatorDecisionPremise: {
          milestone: 'M2',
          runId: null,
          present: false,
          reason,
          thisRunInherits: false,
          thisRunBasis: null,
          thisRunMust: 'build',
          consequence: 'no run scope was given, so no M2 premise can be stated for a run',
          decisions: [],
        },
      },
      M3: {
        id: 'M3',
        gate: 'tools/m3-gate.mjs',
        runId: null,
        status: 'UNKNOWN',
        reason,
        conditions: {},
        facts: null,
        lines: [],
        operatorDecision: null,
        operatorDecisionPremise: {
          milestone: 'M3',
          runId: null,
          present: false,
          reason,
          thisRunInherits: false,
          thisRunBasis: null,
          thisRunMust: 'build',
          consequence: 'no run scope was given, so no M3 premise can be stated for a run',
          decisions: [],
        },
      },
    },
    milestonePredicates: null,
    milestoneAcceptance: { status: 'UNKNOWN', reason, basis: 'delegated gate verdicts', milestones: {}, incompleteMilestones: ['M2', 'M3'] },
    operatorDecisions: { present: false, path: null, sha256: null, reason: 'run_scope_required', applied: [], considered: [], premises: { M2: null, M3: null } },
    acceptance: { present: false, path: null, reason, writer: ACCEPTANCE_WRITER, record: null, evidenceClass: null },
    gateEvidence: { authority: null, socketBinding: null, note: 'run scope required' },
    evidenceClasses: [{ id: 'runId', status: 'MISSING', source: null, reason }],
    missingEvidence: ['runId'],
    missingEvidenceDetail: [{ field: 'runId', reason }],
  }
}

/**
 * The milestone-acceptance question, answered INDEPENDENTLY of the host's
 * acceptance record: an `acceptance-<runId>.json` attests run/HOST state and
 * never asserts a milestone, so the milestone status is always derived from the
 * delegated gate verdicts. A gate that could not prove a condition leaves the
 * milestone INCOMPLETE here — never PASS.
 */
export function composeMilestoneAcceptance(verdicts) {
  const milestones = {}
  for (const id of ['M2', 'M3']) {
    const verdict = verdicts?.[id] ?? null
    const conditions = isPlainObject(verdict?.conditions) ? verdict.conditions : {}
    const entries = Object.entries(conditions)
    milestones[id] = {
      status: verdict?.status ?? 'UNKNOWN',
      reason: verdict?.reason ?? null,
      satisfiedConditions: entries.filter(([, status]) => status === 'PASS').map(([condition]) => condition),
      unmetConditions: entries.filter(([, status]) => status === 'FAIL').map(([condition]) => condition),
      unknownConditions: entries.filter(([, status]) => status === 'UNKNOWN').map(([condition]) => condition),
    }
  }
  const incompleteMilestones = Object.entries(milestones)
    .filter(([, milestone]) => milestone.status !== 'PASS')
    .map(([id]) => id)
  return {
    status: incompleteMilestones.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
    basis: 'the delegated gate verdicts embedded above (tools/m2-gate.mjs, tools/m3-gate.mjs)',
    milestones,
    incompleteMilestones,
    note: 'a gate condition that is UNKNOWN is recorded as not-met; an acceptance-<runId>.json record never turns this into PASS',
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
  const missing = missingCollector()

  // ---- log: one read, then the canonical gate attribution + our timestamped one
  let lines = []
  let attribution = emptyAttribution(`log_unreadable runId=${runId}`)
  let gateScan = { status: 'unknown', inventorySamples: [], dimensionObservations: [], dimensionTransitions: [], reason: 'log_unavailable' }
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
  if (attribution.status !== 'valid') {
    missing.add('boot', `${attribution.reason}; no \`BOOT ... runId=${runId}\` line was found in ${paths.logPath}, so no log fact can be bound to this run`)
  }
  const gateAttributionConsistent =
    attribution.status === gateScan.status &&
    attribution.inventorySamples.length === (Array.isArray(gateScan.inventorySamples) ? gateScan.inventorySamples.length : 0) &&
    attribution.dimensionObservations.length === (Array.isArray(gateScan.dimensionObservations) ? gateScan.dimensionObservations.length : 0) &&
    JSON.stringify(attribution.dimensionTransitions.map(({ from, to, dimension, atMs, source }) => ({ from, to, dimension, atMs, source }))) ===
      JSON.stringify((Array.isArray(gateScan.dimensionTransitions) ? gateScan.dimensionTransitions : []).map(({ from, to, dimension, atMs, source }) => ({ from, to, dimension, atMs, source })))
  if (!gateAttributionConsistent) {
    missing.add(
      'attribution:gate_cross_check',
      `this reader and tools/m2-gate.mjs scanRunLines disagree (reader status=${attribution.status} inventory=${attribution.inventorySamples.length} dimensions=${attribution.dimensionObservations.length} transitions=${attribution.dimensionTransitions.length}; gate status=${gateScan.status} inventory=${Array.isArray(gateScan.inventorySamples) ? gateScan.inventorySamples.length : 'n/a'} dimensions=${Array.isArray(gateScan.dimensionObservations) ? gateScan.dimensionObservations.length : 'n/a'} transitions=${Array.isArray(gateScan.dimensionTransitions) ? gateScan.dimensionTransitions.length : 'n/a'})`,
    )
  }

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
      if (boot[field] === null || boot[field] === undefined) missing.add(label, `the run's BOOT line omits \`${field}\``)
    }
  }

  // ---- snapshot / inventory
  const snapshot = readSnapshotForRun(runId, paths.snapshotDir)
  const inventory = composeInventory({ attribution, snapshot, bootSourceSha: boot?.sourceSha ?? null, runId })
  if (inventory.observationCount === 0 && inventory.snapshot.present) {
    missing.add('inventory:log', `the run-scoped snapshot exists but ${paths.logPath} holds no INVENTORY/MILESTONE sample bound to runId=${runId}`)
  }
  if (inventory.boot === null) {
    missing.add('inventory.boot', inventory.bootEvidence.reason ?? 'generation-entry initialInventory could not be bound to the exact BOOT source SHA')
  }
  if (inventory.latest === null) {
    missing.add('inventory.latest', 'no log inventory sample, no snapshot inventory and no snapshot terminal inventory could be bound to this run')
  }
  for (const item of MILESTONE_ITEMS) {
    if (!inventory.milestoneItems[item].observed) {
      missing.add(`milestoneItem:${item}`, `no run-scoped inventory dump mentions \`${item}\`, so it is unobserved rather than 0`)
    }
  }

  // ---- environment
  const serverProperties = readServerProperties(paths.serverProperties)
  const environment = composeEnvironment({
    observations: attribution.environmentObservations,
    dimensions: attribution.dimensionObservations,
    dimensionTransitions: gateScan.dimensionTransitions ?? [],
    serverProperties,
    environmentFile: readEnvironmentFile(paths.environment),
    runId,
    sourceSha: boot?.sourceSha ?? null,
  })
  const environmentSources = `run-scoped ENVIRONMENT log marker, --environment <operator JSON>, --server-properties <file>`
  if (environment.difficulty === null) missing.add('environment.difficulty', `no difficulty fact from any of: ${environmentSources}`)
  if (environment.mobSpawning === null) missing.add('environment.mobSpawning', `no mob-spawning fact from any of: ${environmentSources}`)
  if (environment.gamerules === null) missing.add('environment.gamerules', `no gamerule fact from a run-scoped ENVIRONMENT log marker or --environment <operator JSON>`)
  if (environment.dimensions.count === 0) {
    missing.add('environment.dimension', `no \`dimension=<id>\` observation bound to runId=${runId}, so dimension transitions cannot be reconstructed`)
  }
  const serverVersion =
    attribution.serverObservations.find((observation) => observation.serverVersion !== null)?.serverVersion ?? null
  if (serverVersion === null) missing.add('serverVersion', `no run-bound SPAWN/SERVER_VERSION marker carrying \`version=\` in ${paths.logPath}`)

  // ---- acceptance artifact (HOST-written; NOT a milestone verdict)
  const acceptance = readAcceptanceArtifact(runId, paths.acceptanceDir)
  if (!acceptance.present) {
    missing.add(
      'acceptance',
      `${acceptance.reason}: ${ACCEPTANCE_WRITER.pathPattern} is written by ${ACCEPTANCE_WRITER.source} ${ACCEPTANCE_WRITER.symbol} on ${ACCEPTANCE_WRITER.firesOn.join('/')} — a run that has not reached one of those has no record yet; the milestone question is answered by milestoneAcceptance instead`,
    )
  }

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
  if (!authority.present) missing.add('authority', `no run-scoped authority fact in ${paths.runnerOutPath} or ${paths.decisionsPath}`)
  if (!authority.gateBound) {
    missing.add(
      'authority.gateBinding',
      `the policy loader could not bracket runId=${runId} inside ${paths.runnerOutPath} (reason=${policy?.reason ?? 'unknown'}) and no matching control-socket report was available; the descriptive authority facts below are still reported but the delegated gates judged nothing`,
    )
  }
  if (authority.plannerMode === null) missing.add('authority.plannerMode', 'no `planner=` field in an in-window GENERATION_READY marker')
  if (authority.policyProvider === null) {
    missing.add('authority.policyProvider', 'no `policyProvider=` field in an in-window GENERATION_READY marker and no policyKind to derive it from')
  }
  if (authority.policyModel === null) {
    missing.add('authority.policyModel', 'no `policyModel=`/`model=` field in an in-window GENERATION_READY marker and no bound generation report')
  }
  if (authority.deterministicFallbackEnabled === null) {
    missing.add('authority.deterministicFallbackEnabled', 'no `deterministicFallbackEnabled=` field in an in-window GENERATION_READY marker')
  }
  if (authority.jev.provider === null || authority.jev.model === null) {
    missing.add(
      'authority.jev',
      `the effective Jev pi authority could not be attested (provider=${authority.jev.provider ?? 'null'} model=${authority.jev.model ?? 'null'})`,
    )
  }
  if (authority.system2.provider === null || authority.system2.model === null) {
    missing.add(
      'authority.system2',
      `no parseable \`system2AuthorityStack\` in an in-window GENERATION_READY marker and no in-window SYSTEM2_AUTHORITY_DECISION to fall back to (raw stack=${JSON.stringify(authority.system2.authorityStack)})`,
    )
  }
  if (authority.fallback.hiddenDeterministicFallback === 'unknown') {
    missing.add('authority.fallback', `cannot rule out a hidden deterministic fallback: ${authority.fallback.reason}`)
  }

  // ---- run source provenance (which code actually produced the result)
  //
  // `run.boot.sourceSha` stays the run's origin. A run that hot-reloaded while it
  // lived executed OTHER code at the end, so the window's own BUILD/RELOAD markers
  // are read as first-class provenance. A window with no source-changing reload
  // keeps `provenance: "boot"` (the BOOT SHA is repeated, never replaced by a
  // guess) and that fact is named in missingEvidenceDetail as soon as it stops
  // being provable - either because the window could not be read at all, or
  // because another run-scoped source attests a bundle change the window missed.
  const reloadWindow = await scanRunSourceWindow(paths, runId)
  const exactSourceWindow = await scanRunSourceExactness(runId, [paths.logPath, paths.runnerOutPath])
  const runSource = composeRunSource({
    runId,
    boot,
    snapshotBuildHash: snapshot.record?.buildHash ?? null,
    reloadWindow,
    socketBinding,
    acceptanceRecord: acceptance.record,
    sourceExactness: exactSourceWindow,
  })
  if (runSource.window.status !== 'valid') {
    const tried = (runSource.window.attempts ?? [])
      .map((attempt) => `${attempt.path ?? 'none'}=${attempt.status}${attempt.reason === null ? '' : ` (${attempt.reason})`}`)
      .join(', ')
    missing.add(
      'run.source:reload_window',
      `${runSource.window.reason}; no BUILD/RELOAD marker for this run could be read from any stream (tried: ${tried || paths.runnerOutPath}), so effectiveSourceSha can only repeat the BOOT SHA (provenance=${runSource.provenance}) and the source that produced the result is unattested`,
    )
  } else if (runSource.windowBlind.detected) {
    missing.add(
      'run.source:reload_window',
      `the run window records no source-changing RELOAD marker, so effectiveSourceSha falls back to the BOOT SHA (provenance=boot, ${String(runSource.effectiveSourceSha)}), but another run-scoped source attests the bundle changed mid-run (${runSource.windowBlind.reasons.join('; ')}): the window is blind to at least one source change`,
    )
  }
  if (runSource.exactGitSource.status !== 'exact') {
    missing.add(
      'run.source:exact_git_sha',
      `${runSource.exactGitSource.reason}; the run's final executing source must be attributable to an exact Git commit SHA, and a generation bundle hash is not a commit SHA`,
    )
  }

  // ---- milestone predicate evidence (first-class, run-scoped)
  //
  // The resident's own run-scoped observation file is preferred when it exists
  // (live, written by the HOST observe loop). When it does not, the predicates are
  // derived from the SAME run-scoped log + snapshot facts the gates read, and each
  // predicate names its evidence source and observation time. An unobserved
  // predicate is `satisfied: null` (UNKNOWN) and is listed in `missing`, never
  // silently absent and never a PASS.
  const hostObservation = readMilestonePredicateEvidence(runId, { dir: paths.snapshotDir })
  // The run-scoped snapshot is the resident's own marker-time evidence. Its portal
  // markers and full inventories are FIRST-CLASS predicate evidence (the M2 gate
  // reads the same markers), so they are included alongside the log: an inherited
  // portal observed by `durable-site-recheck` must not be invisible here just
  // because the current log line stream did not repeat it.
  const snapshotMarkers = Array.isArray(snapshot.record?.markers) ? snapshot.record.markers : []
  const snapshotPortalEvents = snapshotMarkers
    .filter((marker) => typeof marker?.name === 'string' && marker.name.startsWith('PORTAL_'))
    .map((marker) => ({
      name: marker.name,
      verified: marker.verified,
      shape: marker.shape,
      blocks: marker.blocks,
      dimension: marker.dimension,
      atMs: marker.atMs,
      source: 'snapshot',
    }))
  const snapshotSamples = []
  {
    const initial = asCounts(snapshot.record?.initialInventory)
    if (initial !== null) snapshotSamples.push({ counts: initial, source: 'snapshot' })
    for (const marker of snapshotMarkers) {
      const counts = asCounts(marker?.inventory)
      if (counts !== null) snapshotSamples.push({ counts, ts: marker.at, atMs: marker.atMs, source: 'snapshot' })
    }
    const latest = asCounts(snapshot.record?.inventory)
    if (latest !== null) snapshotSamples.push({ counts: latest, atMs: snapshot.record?.atMs, source: 'snapshot' })
    const terminal = asCounts(snapshot.record?.terminal?.inventory)
    if (terminal !== null) snapshotSamples.push({ counts: terminal, atMs: snapshot.record?.terminal?.atMs, source: 'snapshot' })
  }
  let milestonePredicates = deriveMilestonePredicates({
    runId,
    runSourceSha: boot?.sourceSha ?? null,
    inventorySamples: [
      ...attribution.inventorySamples.map((sample) => ({ counts: sample.counts, ts: sample.ts, source: 'log' })),
      ...snapshotSamples,
    ],
    dimensionObservations: gateScan.dimensionTransitions
      .filter((transition) => {
        const normalize = (value) => typeof value === 'string' ? value.replace(/^minecraft:/, '').toLowerCase() : null
        const from = normalize(transition.from)
        const to = normalize(transition.to)
        return Number.isFinite(transition.atMs) &&
          transition.source === 'live-world' &&
          from !== null && from !== 'unknown' && from !== 'the_nether' &&
          to === 'the_nether' && normalize(transition.dimension) === to
      })
      .map((transition) => ({
        dimension: transition.to,
        from: transition.from,
        to: transition.to,
        atMs: transition.atMs,
        source: 'log:DIMENSION_TRANSITION',
      })),
    portalEvents: [...attribution.portalEvents, ...snapshotPortalEvents],
    hostObservation,
    now,
  })
  // The resident observe-loop file can contain sticky semantic projections, but
  // its `nether_reached` row is not acceptance evidence on its own. Replace it
  // with the exact BOOT-scoped live-world transition parsed from the log.
  const normalizeDimension = (value) => typeof value === 'string' ? value.replace(/^minecraft:/, '').toLowerCase() : null
  const bodyNetherTransitions = (gateScan.dimensionTransitions ?? []).filter((transition) => {
    const from = normalizeDimension(transition.from)
    const to = normalizeDimension(transition.to)
    return Number.isFinite(transition.atMs) &&
      transition.source === 'live-world' &&
      from !== null && from !== 'unknown' && from !== 'the_nether' &&
      to === 'the_nether' && normalizeDimension(transition.dimension) === to
  })
  const independentNether = deriveMilestonePredicates({
    runId,
    runSourceSha: boot?.sourceSha ?? null,
    dimensionObservations: bodyNetherTransitions.map((transition) => ({
      dimension: transition.to,
      from: transition.from,
      to: transition.to,
      atMs: transition.atMs,
      source: 'log:DIMENSION_TRANSITION',
    })),
  }).predicates.find((predicate) => predicate.id === 'nether_reached')
  const suppliedNether = milestonePredicates.predicates.find((predicate) => predicate.id === 'nether_reached')
  const rejectedNetherClaim = suppliedNether?.satisfied === true && independentNether.satisfied !== true
  let netherPredicate = independentNether
  if (bodyNetherTransitions.length > 0) {
    const transition = bodyNetherTransitions[0]
    netherPredicate = {
      ...independentNether,
      evidence: {
        ...(independentNether.evidence ?? {}),
        transition: {
          from: transition.from,
          to: transition.to,
          dimension: transition.dimension,
          atMs: transition.atMs,
          source: transition.source,
          runId,
          sourceSha: boot?.sourceSha ?? null,
        },
      },
    }
  } else {
    netherPredicate = {
      ...independentNether,
      evidence: { ...(independentNether.evidence ?? {}), rejected: 'body_dimension_transition_missing' },
    }
  }
  milestonePredicates = {
    ...milestonePredicates,
    mismatches: [
      ...milestonePredicates.mismatches,
      ...(rejectedNetherClaim ? ['unverified_nether_predicate_source_ignored'] : []),
    ],
    missing: [
      ...milestonePredicates.missing.filter((id) => id !== 'nether_reached'),
      ...(netherPredicate.satisfied === true ? [] : ['nether_reached']),
    ],
    predicates: milestonePredicates.predicates.map((predicate) =>
      predicate.id === 'nether_reached' ? netherPredicate : predicate,
    ),
  }
  // Unobserved predicates stay visible in `milestonePredicates.missing` with their
  // `satisfied: null` + evidence, but they do NOT by themselves make the artifact
  // "incomplete": an M3 run legitimately inherits its M2 portal, so `portal_built`
  // / `portal_lit` may be unobserved in-run while the terminal M3 conditions are
  // the ones the delegated verdicts already gate. A rejected/duplicate observation
  // (source mismatch) IS an integrity gap and is surfaced at the top level.
  if (milestonePredicates.mismatches.length > 0) {
    missing.add(
      'milestonePredicate:source_mismatch',
      `${milestonePredicates.mismatches.length} resident observation(s) were rejected (run/source mismatch); see milestonePredicates.mismatches`,
    )
  }

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
    sourceSha: boot?.sourceSha ?? null,
  })
  const terminalInventory = m3.verdict?.facts?.terminalInventory ?? null
  const terminalObservation = terminalInventory?.status === 'valid' ? terminalInventory.observation : null
  inventory.final = terminalObservation === null
    ? {
        status: 'MISSING',
        source: 'control.report',
        reason: terminalInventory?.reason ?? 'current_inventory_observation_unavailable',
        counts: null,
      }
    : {
        ...terminalObservation,
        status: 'PRESENT',
        source: 'control.report',
      }
  if (terminalObservation === null) {
    missing.add(
      'inventory.final',
      `${inventory.final.reason}; final inventory requires the same-run HOST current-inventory observation captured by the read-only report query at acceptance time`,
    )
  } else {
    for (const item of MILESTONE_ITEMS) {
      inventory.milestoneItems[item].final = inventory.final.counts[item] ?? 0
    }
  }
  for (const gap of [...m2.missing, ...m3.missing]) {
    missing.add(gap.field ?? gap, gap.reason ?? `the delegated gate could not produce this verdict fact (${String(gap)})`)
  }

  // ---- explicit operator decisions (annotate; never rewrite a gate verdict)
  const operatorDecisions = readOperatorDecisions(paths.operatorDecisions)
  const m2Decision = operatorDecisionAnnotation({
    selection: selectOperatorDecision(operatorDecisions.decisions, { milestone: 'M2', runId, gateVerdict: m2.verdict }),
    decisionsPath: paths.operatorDecisions,
    gateVerdict: m2.verdict,
  })
  const m3Decision = operatorDecisionAnnotation({
    selection: selectOperatorDecision(operatorDecisions.decisions, { milestone: 'M3', runId, gateVerdict: m3.verdict }),
    decisionsPath: paths.operatorDecisions,
    gateVerdict: m3.verdict,
  })
  m2.verdict.operatorDecision = m2Decision
  m3.verdict.operatorDecision = m3Decision
  // The PREMISE (schema 5): what each recorded decision covers and whether THIS run
  // inherits it or must build the milestone itself. Present for every milestone,
  // including when no decision exists at all, so a fresh run's reader never has to
  // guess why `verdicts.M2.reason` is `inherited_portal`.
  const m2Premise = operatorDecisionPremise({
    decisions: operatorDecisions.decisions,
    milestone: 'M2',
    runId,
    gateVerdict: m2.verdict,
    decisionsPath: paths.operatorDecisions,
  })
  const m3Premise = operatorDecisionPremise({
    decisions: operatorDecisions.decisions,
    milestone: 'M3',
    runId,
    gateVerdict: m3.verdict,
    decisionsPath: paths.operatorDecisions,
  })
  // WHICH copy of the ruling this premise was derived from (more than one checkout of
  // this repo exists; the content hash makes the per-run scoping exact).
  m2Premise.sha256 = operatorDecisions.sha256
  m3Premise.sha256 = operatorDecisions.sha256
  m2.verdict.operatorDecisionPremise = m2Premise
  m3.verdict.operatorDecisionPremise = m3Premise
  // A milestone whose gate did NOT pass while a recorded decision exists for it and
  // does not cover this run is a NAMED gap: this is the one case where the premise
  // must be visible in the single gap list, and it can only ever appear on a
  // milestone that is already not PASS (so it can never make a PASS complete=false).
  for (const [id, premise, verdict] of [
    ['M2', m2Premise, m2.verdict],
    ['M3', m3Premise, m3.verdict],
  ]) {
    // Only when the recorded decision is actually RELEVANT to why this milestone is
    // undecided: this run inherited (or is recorded as inheriting) a premise it did
    // not build. A run that simply has not reached the milestone yet is already named
    // by the gate's own `verdict:<id>` gap, and duplicating it would be noise.
    const decisionRelevant =
      premise.thisRunInherits ||
      verdict.reason === 'inherited_portal' ||
      premise.decisions.some((decision) => decision.appliesToThisRun)
    if (premise.present && !premise.thisRunInherits && verdict.status !== 'PASS' && decisionRelevant) {
      missing.add(
        `premise:${id}`,
        `${premise.consequence} — recorded at ${premise.source ?? 'operator-decisions'} (sha256=${operatorDecisions.sha256 ?? 'unknown'})`,
      )
    }
  }

  const verdicts = { M2: m2.verdict, M3: m3.verdict }
  const statuses = [verdicts.M2.status, verdicts.M3.status]
  const milestoneAcceptance = composeMilestoneAcceptance(verdicts)
  const complete = missing.fields.length === 0
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
      // Provenance: `boot` is the run ORIGIN, `source` is what the run's own
      // window proves executed (both SHAs, with the basis and any disagreement).
      source: runSource,
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
      operatorDecisions: paths.operatorDecisions,
      serverProperties: paths.serverProperties,
    },
    inventory,
    environment,
    authority,
    milestonePredicates,
    milestoneAcceptance,
    operatorDecisions: {
      present: operatorDecisions.present,
      path: operatorDecisions.path,
      // WHICH copy of the ruling was read (several checkouts of this repo exist).
      sha256: operatorDecisions.sha256,
      reason: operatorDecisions.reason,
      applied: [
        ...(m2Decision !== null && m2Decision.status !== 'NOT_APPLIED' ? [{ milestone: 'M2', status: m2Decision.status }] : []),
        ...(m3Decision !== null && m3Decision.status !== 'NOT_APPLIED' ? [{ milestone: 'M3', status: m3Decision.status }] : []),
      ],
      // Every recorded decision for M2/M3 with its outcome for THIS run, including
      // the ones that do NOT apply (schema 5). `applied` above keeps its schema-2/3/4
      // shape; `considered` is the per-run truth a reviewer needs.
      considered: [
        ...m2Premise.decisions.map((decision) => ({ milestone: 'M2', ...decisionSummary(decision) })),
        ...m3Premise.decisions.map((decision) => ({ milestone: 'M3', ...decisionSummary(decision) })),
      ],
      premises: { M2: m2Premise, M3: m3Premise },
    },
    acceptance: {
      present: acceptance.present,
      path: acceptance.path,
      reason: acceptance.reason,
      writer: ACCEPTANCE_WRITER,
      record: acceptance.record,
      // The EVIDENCE CLASS, stated precisely (schema 5). This record is a HOST
      // lifecycle attestation, not a milestone verdict: absent stays absent, and the
      // reason + the safe triggers that would produce it are named here so a reader
      // never has to guess what `missingEvidence: ['acceptance']` means.
      evidenceClass: {
        id: 'acceptance',
        kind: 'host-lifecycle-attestation',
        status: acceptance.present ? 'PRESENT' : 'MISSING',
        reason: acceptance.present ? null : acceptance.reason,
        attests: ACCEPTANCE_WRITER.attests,
        safeTriggers: ACCEPTANCE_WRITER.safeTriggers,
        fabricatable: ACCEPTANCE_WRITER.fabricatable,
        blocksMilestoneVerdict: false,
        milestoneQuestionAnsweredBy: 'milestoneAcceptance (the delegated gate verdicts)',
      },
    },
    // Which authority evidence the delegated gates actually judged. Two tools that
    // read the same tree can only disagree here when one of them obtained a live
    // control-socket report and the other did not, so the fact is recorded instead of
    // being left to a reader to infer from `authority.reason`.
    gateEvidence: {
      authority: {
        injected: true,
        gateBound: authority.gateBound === true,
        source: policy?.generation?.source ?? null,
        decisionsSource: policy?.decisions?.source ?? null,
        reason: policy?.reason ?? null,
        runId: policy?.generation?.runId ?? policy?.decisions?.runId ?? null,
      },
      socketBinding:
        socketBinding === null
          ? null
          : {
              runId: socketBinding.runId ?? null,
              matched: socketBinding.runId === runId,
              frozen: socketBinding.frozen ?? null,
              currentInventoryObservationAt: inventory.final.observedAt ?? null,
            },
      note:
        'both delegated gates (tools/m2-gate.mjs, tools/m3-gate.mjs) received this exact policy evidence object; a gate invoked separately with a LIVE control-socket report can judge a different authority bundle for the same run, so a bundle that must not disagree pins ONE binding and runs both from it',
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
    // ONE place a reviewer (or a script) can read WHICH evidence class is missing and
    // WHY, instead of inferring it from a flat `missingEvidence` string list. A class
    // that is MISSING never becomes a fabricated fact: it stays MISSING with its
    // reason, and the milestone question remains with the delegated gate verdicts.
    evidenceClasses: [
      {
        id: 'runLog',
        status: attribution.status === 'valid' ? 'PRESENT' : 'MISSING',
        source: paths.logPath,
        reason: attribution.status === 'valid' ? null : attribution.reason,
      },
      {
        id: 'snapshot',
        status: snapshot.present ? 'PRESENT' : 'MISSING',
        source: snapshot.path,
        reason: snapshot.present ? null : snapshot.reason,
      },
      {
        id: 'milestonePredicates',
        status: milestonePredicates.mismatches.length > 0 ? 'REJECTED' : hostObservation?.present === true ? 'PRESENT' : 'DERIVED',
        source: hostObservation?.path ?? `derived from ${paths.logPath} + ${paths.snapshotDir}`,
        reason: milestonePredicates.mismatches.length > 0 ? milestonePredicates.mismatches.join('; ') : null,
      },
      {
        id: 'authority',
        status: authority.gateBound === true ? 'PRESENT' : 'MISSING',
        source: policy?.generation?.source ?? paths.runnerOutPath,
        reason: authority.gateBound === true ? null : (policy?.reason ?? authority.reason ?? 'generation_status_unavailable'),
      },
      {
        id: 'acceptance',
        status: acceptance.present ? 'PRESENT' : 'MISSING',
        source: acceptance.path,
        reason: acceptance.present ? null : acceptance.reason,
      },
    ],
    verdicts,
    missingEvidence: missing.fields,
    missingEvidenceDetail: missing.detail,
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
    else if (arg === '--operator-decisions') out.overrides.operatorDecisions = argv[++i] ?? null
    else if (arg === '--no-operator-decisions') out.overrides.operatorDecisions = null
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
    '  --operator-decisions <p>  read explicit operator milestone decisions (default <repo>/OPERATOR-DECISIONS.json)',
    '  --no-operator-decisions   never read an operator decision file',
    '  --server-properties <p>  read difficulty/spawn-monsters from a server.properties (labelled NOT run-scoped)',
    '  --environment <p>        read operator environment facts and configurationChanges/worldChanges records',
    '',
    'Artifact sections (per runId):',
    '  run                      boot identity: exact source SHA, runtime, contract/schema, world epoch/key, MC server version',
    '  run.source               SOURCE provenance: BOOT origin SHA vs the run window\'s latest source-changing RELOAD hash',
    '                           (effectiveSourceSha + provenance + provenanceBasis, the observed RELOAD markers and the',
    '                           read-only control-socket generation-hash cross-check; boot fallback is never silent)',
    '  inventory                boot (initial) and latest (final) inventory + the milestone item subset',
    '  environment              difficulty / mob spawning / gamerules, config-change rationale bound to run/source, world changes, and dimensions',
    '  authority.jev            effective Jev pi provider/model and the line it came from',
    '  authority.system2        effective System2 authority (configured stack first, last answerer kept beside it)',
    '  authority.fallback       deterministicFallbackEnabled + in-window decision sources => hidden fallback absence',
    '  milestonePredicates      every M2/M3 predicate with satisfied/observedAt/source/evidence',
    '  milestoneAcceptance      milestone completeness derived from the delegated verdicts (never from acceptance-*.json)',
    '  acceptance               the HOST-written acceptance-<runId>.json (writer + triggers recorded; absent stays absent)',
    '  missingEvidence          the historical string list of gaps',
    '  missingEvidenceDetail    the same gaps as {field, reason} and printed to stderr as MILESTONE_RUN_ARTIFACT_MISSING lines',
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
  // The single human-readable gap list: field + why it is missing. It goes to
  // stderr so the stdout JSON contract (`--json` / default) stays machine-parseable.
  const gaps = Array.isArray(artifact?.missingEvidenceDetail) ? artifact.missingEvidenceDetail : []
  if (gaps.length > 0) {
    writeError(`MILESTONE_RUN_ARTIFACT_MISSING runId=${artifact?.runId ?? 'none'} count=${gaps.length}\n`)
    for (const gap of gaps) writeError(`  - ${gap.field}: ${gap.reason}\n`)
  }
  return { exitCode, artifact }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const result = await runCli()
  process.exitCode = result.exitCode
}
