#!/usr/bin/env bun
// milestone-predicates: FIRST-CLASS, run-scoped milestone predicate evidence.
//
// The operator's M3 PASS definition requires the run-scoped artifact to carry
// "milestone predicate evidence", not merely an inventory dump plus a gate
// verdict. Before this module the artifact had no such section: the delegated
// gates re-derived `ender_eye_ready` / `nether_reached` from whatever samples and
// dimension lines happened to be in the log, so an artifact reader could not see
// WHICH predicate was evaluated, WHEN it was first observed, or FROM WHICH
// evidence source.
//
// This module is the single reader/evaluator for that section. It is a READER:
// it never invents a verdict. Every predicate is reported as
//
//   { id, milestone, label, satisfied, observedAtMs, observedAt, source, evidence }
//
// with `satisfied` being
//   true  - a run-scoped observation PROVES the predicate held,
//   false - a run-scoped observation positively proves it did NOT hold,
//   null  - the predicate was never observed in this run (UNKNOWN, never PASS).
//
// Run isolation: the predicate section names its `runId`, and the optional
// resident-produced observation file `milestone-predicates-<runId>.json` is
// accepted only when BOTH its filename and its body `runId` match. Evidence from
// two runs is never joined. A `sourceSha` mismatch between the resident
// observation and the run's own BOOT source is surfaced in `mismatches` and the
// observation is NOT used.
//
// Evaluation order (highest-confidence wins, but the result is monotonic):
//   1. the resident host observation file (live, appended in the observe loop);
//   2. the run-scoped `m2-snapshot-<runId>.json` markers;
//   3. the run-scoped log lines.
// A `true` observation is sticky: a later `false` can never overwrite the first
// proven `true`, exactly like the run-scoped M2 snapshot chain.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePortalChain } from './m2-gate.mjs'

export const MILESTONE_PREDICATE_RECORD = 'milestone-predicates'
export const MILESTONE_PREDICATE_SCHEMA_VERSION = 1

/** M3 terminal item + the crafting inputs, re-exported by tools/m3-gate.mjs. */
export const ENDER_EYE = 'ender_eye'
export const ENDER_EYE_REQUIRED = 12
export const ENDER_PEARL = 'ender_pearl'
export const ENDER_PEARL_REQUIRED = 12
export const BLAZE_ROD = 'blaze_rod'
export const BLAZE_ROD_REQUIRED = 7
export const BLAZE_POWDER = 'blaze_powder'
export const BLAZE_POWDER_REQUIRED = 12

/**
 * The canonical M2/M3 predicate set. Ids mirror the ladder rung / contract stage
 * they express; the thresholds are the SAME contract numbers the gates enforce
 * (MILESTONE-CONTRACT.json M2/M3), so no new semantics are introduced here.
 */
export const MILESTONE_PREDICATES = Object.freeze([
  { id: 'portal_built', milestone: 'M2', label: 'nether portal frame built and validated', requirement: 'portal_frame_verified' },
  { id: 'portal_lit', milestone: 'M2', label: 'nether portal lit and verified in the overworld', requirement: 'portal_lit_verified + portal_verified' },
  { id: 'portal_verified', milestone: 'M2', label: 'a lit nether portal was positively observed', requirement: 'portal_verified' },
  { id: 'nether_reached', milestone: 'M3', label: 'the body reached minecraft:the_nether', requirement: 'dimension=minecraft:the_nether' },
  { id: 'blaze_rods', milestone: 'M3', label: 'at least 7 blaze rods held', requirement: `blaze_rod>=${BLAZE_ROD_REQUIRED}` },
  { id: 'ender_pearls', milestone: 'M3', label: 'at least 12 ender pearls held', requirement: `ender_pearl>=${ENDER_PEARL_REQUIRED}` },
  { id: 'ender_eyes', milestone: 'M3', label: 'at least 12 eyes of ender held', requirement: `ender_eye>=${ENDER_EYE_REQUIRED}` },
])

export const MILESTONE_PREDICATE_IDS = Object.freeze(MILESTONE_PREDICATES.map((predicate) => predicate.id))

const PREDICATE_BY_ID = new Map(MILESTONE_PREDICATES.map((predicate) => [predicate.id, predicate]))

function normalizeDimension(value) {
  return typeof value === 'string' ? value.replace(/^minecraft:/, '').toLowerCase() : null
}

function msOf(observation) {
  if (observation === null || typeof observation !== 'object') return null
  if (typeof observation.atMs === 'number' && Number.isFinite(observation.atMs)) return observation.atMs
  if (typeof observation.ts === 'string') {
    const parsed = Date.parse(observation.ts)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function isoOf(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** The observation's own evidence-source label, defaulting to the log. */
function sourceOf(observation, kind) {
  const base = typeof observation?.source === 'string' && observation.source.length > 0 ? observation.source : 'log'
  return `${base}:${kind}`
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// per-predicate derivation (pure; no verdicts beyond the predicate itself)
// ---------------------------------------------------------------------------

/**
 * Inventory-threshold predicate. Every inventory sample is a FULL dump (an item
 * absent from the map was observed to be 0 — the same rule the gates and
 * `composeInventory` use), so once ANY sample exists the predicate is observed:
 * `true` if the max count reached the target, else honestly `false`. Only a run
 * with no sample at all is UNKNOWN. `satisfied` is the max over samples because
 * the predicate is existential: a run that held 12 pearls and then crafted them
 * into eyes still proved the pearl predicate.
 */
function deriveInventoryPredicate(id, item, required, samples) {
  const descriptor = PREDICATE_BY_ID.get(id)
  const list = (Array.isArray(samples) ? samples : []).filter((sample) => isPlainObject(sample?.counts))
  if (list.length === 0) {
    return {
      id,
      milestone: descriptor.milestone,
      label: descriptor.label,
      satisfied: null,
      observedAtMs: null,
      observedAt: null,
      source: null,
      evidence: { item, required, observed: false, samples: 0 },
    }
  }
  let max = 0
  for (const sample of list) {
    const raw = Number(sample.counts[item] ?? 0)
    const count = Number.isFinite(raw) ? raw : 0
    if (count > max) max = count
  }
  // The max-reaching sample with the EARLIEST timestamp is the observation that
  // first proved the threshold; the chronologically latest sample is the most
  // recent honest non-observation. Samples may arrive log-first / snapshot-after,
  // so compare timestamps instead of assuming array order.
  const timedMax = list.filter((sample) => Number(sample.counts[item] ?? 0) === max)
  const maxObs = timedMax.sort((a, b) => (msOf(a) ?? Infinity) - (msOf(b) ?? Infinity))[0] ?? list[0]
  const latest = list.reduce((best, sample) => {
    const t = msOf(sample)
    if (t === null) return best
    const bestT = msOf(best)
    return bestT === null || t > bestT ? sample : best
  }, list[0])
  const satisfied = max >= required
  const chosen = satisfied ? maxObs : latest
  const lastRaw = Number(latest.counts[item] ?? 0)
  const atMs = msOf(chosen)
  return {
    id,
    milestone: descriptor.milestone,
    label: descriptor.label,
    satisfied,
    observedAtMs: atMs,
    observedAt: isoOf(atMs),
    source: sourceOf(chosen, 'INVENTORY'),
    evidence: { item, required, max, lastObserved: Number.isFinite(lastRaw) ? lastRaw : 0, samples: list.length, observed: true },
  }
}

/** `dimension=...` observation predicate. Absence of a transition is UNKNOWN, never false. */
function deriveDimensionPredicate(id, dimensions) {
  const descriptor = PREDICATE_BY_ID.get(id)
  let last = null
  const seen = new Set()
  for (const observation of Array.isArray(dimensions) ? dimensions : []) {
    const normalized = normalizeDimension(observation?.dimension)
    if (normalized === null) continue
    last = observation
    seen.add(normalized)
    if (normalized === 'the_nether') {
      const atMs = msOf(observation)
      return {
        id,
        milestone: descriptor.milestone,
        label: descriptor.label,
        satisfied: true,
        observedAtMs: atMs,
        observedAt: isoOf(atMs),
        source: sourceOf(observation, 'dimension'),
        evidence: { dimension: observation.dimension, observed: true },
      }
    }
  }
  const atMs = msOf(last)
  return {
    id,
    milestone: descriptor.milestone,
    label: descriptor.label,
    // Absence of a Nether observation is not evidence of a failed transition,
    // exactly as tools/m3-gate.mjs reports `nether_reached: UNKNOWN`.
    satisfied: null,
    observedAtMs: null,
    observedAt: null,
    source: null,
    evidence: {
      observed: last !== null,
      lastDimension: last?.dimension ?? null,
      lastObservedAt: isoOf(atMs),
      dimensions: [...seen],
    },
  }
}

/** Group portal events by their evidence source so ordering is per-source, never interleaved. */
function groupPortalEventsBySource(events) {
  const groups = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!isPlainObject(event) || typeof event.name !== 'string') continue
    const key = typeof event.source === 'string' && event.source.length > 0 ? event.source : 'log'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event)
  }
  return groups
}

function derivePortalPredicates(events) {
  const frame = []
  const lit = []
  const verified = []
  for (const [source, group] of groupPortalEventsBySource(events)) {
    const chain = evaluatePortalChain(group)
    const frameEvent = group.find(
      (event) => event.name === 'PORTAL_FRAME_READY' && event.shape === 'ok' && Number.isFinite(event.blocks) && event.blocks >= 10,
    )
    if (chain.frameVerified && frameEvent !== undefined) {
      frame.push({
        satisfied: true,
        observedAtMs: msOf(frameEvent),
        source: `${source}:PORTAL_FRAME_READY`,
        evidence: { shape: frameEvent.shape, blocks: frameEvent.blocks },
      })
    } else {
      const bad = group.find((event) => event.name === 'PORTAL_FRAME_READY' && (event.shape !== 'ok' || !(Number.isFinite(event.blocks) && event.blocks >= 10)))
      if (bad !== undefined) {
        frame.push({
          satisfied: false,
          observedAtMs: msOf(bad),
          source: `${source}:PORTAL_FRAME_READY`,
          evidence: { shape: bad.shape ?? null, blocks: bad.blocks ?? null },
        })
      }
    }

    const litEvent = group.find((event) => event.name === 'PORTAL_LIT')
    if (chain.litVerified && litEvent !== undefined) {
      const overworld = normalizeDimension(chain.litDimension) === 'overworld'
      lit.push({
        satisfied: overworld,
        observedAtMs: msOf(litEvent),
        source: `${source}:PORTAL_LIT`,
        evidence: { litDimension: chain.litDimension ?? null, verified: true },
      })
    } else {
      const refused = group.find((event) => event.name === 'PORTAL_LIGHT_REFUSED')
      if (refused !== undefined) {
        lit.push({ satisfied: false, observedAtMs: msOf(refused), source: `${source}:PORTAL_LIGHT_REFUSED`, evidence: { refused: true } })
      }
    }

    // `portal_verified` is the single strongest fact and is deliberately NOT
    // gated on the build chain: a run can INHERIT a previously verified gate
    // (m2-gate reports `inherited_portal`) and that observation is still this
    // run's own run-scoped fact.
    for (const event of group) {
      if (event.name !== 'PORTAL_VERIFIED') continue
      if (event.verified === true) {
        verified.push({ satisfied: true, observedAtMs: msOf(event), source: `${source}:PORTAL_VERIFIED`, evidence: { verified: true } })
      } else if (event.verified === false) {
        verified.push({ satisfied: false, observedAtMs: msOf(event), source: `${source}:PORTAL_VERIFIED`, evidence: { verified: false } })
      }
    }
    const truth = group.find((event) => event.name === 'PORTAL_TRUTH' && event.verified === false)
    if (truth !== undefined) {
      verified.push({ satisfied: false, observedAtMs: msOf(truth), source: `${source}:PORTAL_TRUTH`, evidence: { verified: false, reason: truth.reason ?? null } })
    }
  }
  return { frame, lit, verified }
}

// ---------------------------------------------------------------------------
// resident host observation file (run-scoped, merged, monotonic)
// ---------------------------------------------------------------------------

export function milestonePredicateFileName(runId) {
  return `${MILESTONE_PREDICATE_RECORD}-${runId}.json`
}

/**
 * Read the resident-produced observation file for R. Accepted only when the
 * record tag AND the body `runId` match R; otherwise it is an explicit mismatch
 * and no observation is used.
 */
export function readMilestonePredicateEvidence(runId, { dir } = {}) {
  if (typeof runId !== 'string' || runId.length === 0) {
    return { present: false, path: null, reason: 'run_scope_required', predicates: [], sourceSha: null }
  }
  if (typeof dir !== 'string' || dir.length === 0) {
    return { present: false, path: null, reason: 'observation_dir_unavailable', predicates: [], sourceSha: null }
  }
  const path = join(dir, milestonePredicateFileName(runId))
  if (!existsSync(path)) return { present: false, path, reason: 'milestone_predicates_missing', predicates: [], sourceSha: null }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { present: false, path, reason: 'milestone_predicates_unreadable', predicates: [], sourceSha: null }
  }
  if (!isPlainObject(parsed) || parsed.record !== MILESTONE_PREDICATE_RECORD) {
    return { present: false, path, reason: `milestone_predicates_record_mismatch observed=${String(parsed?.record)}`, predicates: [], sourceSha: null }
  }
  if (parsed.runId !== runId) {
    return {
      present: false,
      path,
      reason: `milestone_predicates_run_mismatch expected=${runId} observed=${String(parsed.runId)}`,
      predicates: [],
      sourceSha: null,
    }
  }
  const predicates = (Array.isArray(parsed.predicates) ? parsed.predicates : []).filter(
    (predicate) => isPlainObject(predicate) && MILESTONE_PREDICATE_IDS.includes(predicate.id),
  )
  return {
    present: true,
    path,
    reason: null,
    predicates,
    sourceSha: typeof parsed.sourceSha === 'string' ? parsed.sourceSha : null,
    generationId: typeof parsed.generationId === 'string' ? parsed.generationId : null,
    observationCount: Number.isFinite(parsed.observationCount) ? parsed.observationCount : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  }
}

// ---------------------------------------------------------------------------
// merge + section assembly
// ---------------------------------------------------------------------------

function normalizeHostObservation(predicate) {
  const atMs = typeof predicate.observedAtMs === 'number' && Number.isFinite(predicate.observedAtMs) ? predicate.observedAtMs : null
  return {
    id: predicate.id,
    satisfied: predicate.satisfied === true ? true : predicate.satisfied === false ? false : null,
    observedAtMs: atMs,
    source: typeof predicate.source === 'string' && predicate.source.length > 0 ? predicate.source : 'host-observe',
    evidence: isPlainObject(predicate.evidence) ? predicate.evidence : null,
  }
}

/** Monotonic pick: earliest proven `true`, else earliest `false`, else the derived UNKNOWN. */
function pickObservation(observations, derived) {
  const byTime = (a, b) => (a.observedAtMs ?? Infinity) - (b.observedAtMs ?? Infinity)
  const truths = observations.filter((observation) => observation.satisfied === true).sort(byTime)
  if (truths.length > 0) return truths[0]
  const falses = observations.filter((observation) => observation.satisfied === false).sort(byTime)
  if (falses.length > 0) return falses[0]
  return derived
}

function sectionPredicate(id, observations, derived) {
  const descriptor = PREDICATE_BY_ID.get(id)
  const chosen = pickObservation(observations, derived)
  const atMs = chosen.observedAtMs ?? null
  return {
    id,
    milestone: descriptor.milestone,
    label: descriptor.label,
    requirement: descriptor.requirement,
    satisfied: chosen.satisfied ?? null,
    observedAtMs: atMs,
    observedAt: isoOf(atMs),
    source: chosen.source ?? null,
    evidence: chosen.evidence ?? null,
  }
}

/**
 * Derive the complete run-scoped milestone-predicate section.
 *
 * All inputs are already attributed to ONE runId by the caller (the artifact
 * assembler uses the gates' BOOT-boundary rule). `hostObservation` is the
 * optional resident file; `runSourceSha` is the run's BOOT source SHA and is used
 * only to REJECT the host observation on a mismatch, never to rewrite it.
 */
export function deriveMilestonePredicates({
  runId = null,
  runSourceSha = null,
  inventorySamples = [],
  dimensionObservations = [],
  portalEvents = [],
  hostObservation = null,
  now = () => new Date(),
} = {}) {
  const mismatches = []
  let hostPredicates = []
  if (hostObservation !== null && hostObservation.present === true) {
    const hostSha = hostObservation.sourceSha
    if (runSourceSha !== null && hostSha !== null && hostSha !== runSourceSha) {
      mismatches.push(`milestone_predicates_source_sha_mismatch expected=${runSourceSha} observed=${hostSha}`)
    } else {
      hostPredicates = hostObservation.predicates.map(normalizeHostObservation)
    }
  } else if (hostObservation !== null && typeof hostObservation.reason === 'string' && hostObservation.reason.endsWith('_run_mismatch')) {
    mismatches.push(hostObservation.reason)
  }

  const portal = derivePortalPredicates(portalEvents)
  const unknown = (evidence) => ({ satisfied: null, observedAtMs: null, source: null, evidence })
  const derivedById = {
    portal_built: pickObservation(portal.frame, unknown({ observed: false })),
    portal_lit: pickObservation(portal.lit, unknown({ observed: false })),
    portal_verified: pickObservation(portal.verified, unknown({ observed: false })),
    nether_reached: deriveDimensionPredicate('nether_reached', dimensionObservations),
    blaze_rods: deriveInventoryPredicate('blaze_rods', BLAZE_ROD, BLAZE_ROD_REQUIRED, inventorySamples),
    ender_pearls: deriveInventoryPredicate('ender_pearls', ENDER_PEARL, ENDER_PEARL_REQUIRED, inventorySamples),
    ender_eyes: deriveInventoryPredicate('ender_eyes', ENDER_EYE, ENDER_EYE_REQUIRED, inventorySamples),
  }

  const hostById = new Map()
  for (const observation of hostPredicates) {
    if (!MILESTONE_PREDICATE_IDS.includes(observation.id)) continue
    if (!hostById.has(observation.id)) hostById.set(observation.id, [])
    hostById.get(observation.id).push(observation)
  }

  const predicates = MILESTONE_PREDICATE_IDS.map((id) => sectionPredicate(id, hostById.get(id) ?? [], derivedById[id]))

  const missing = predicates.filter((predicate) => predicate.satisfied === null).map((predicate) => predicate.id)
  const sources = new Set()
  for (const predicate of predicates) if (typeof predicate.source === 'string' && predicate.source.length > 0) sources.add(predicate.source.split(':')[0])
  if (hostPredicates.length > 0) sources.add('host-observe')

  return {
    record: MILESTONE_PREDICATE_RECORD,
    schemaVersion: MILESTONE_PREDICATE_SCHEMA_VERSION,
    runId,
    sourceSha: runSourceSha,
    generatedAt: now().toISOString(),
    observationSources: [...sources].sort(),
    hostObservation:
      hostObservation === null
        ? null
        : {
            present: hostObservation.present === true,
            path: hostObservation.path ?? null,
            reason: hostObservation.reason ?? null,
            sourceSha: hostObservation.sourceSha ?? null,
            generationId: hostObservation.generationId ?? null,
            observationCount: hostObservation.observationCount ?? null,
          },
    predicates,
    missing,
    mismatches,
  }
}

/** Extract the per-predicate `{id, satisfied}` map a gate can consume without re-deriving. */
export function predicateConditionMap(section) {
  const out = {}
  for (const predicate of Array.isArray(section?.predicates) ? section.predicates : []) {
    out[predicate.id] = predicate.satisfied === true ? 'PASS' : predicate.satisfied === false ? 'FAIL' : 'UNKNOWN'
  }
  return out
}
