#!/usr/bin/env bun
// m3-gate: run-scoped PASS/FAIL/UNKNOWN gate for the CURRENT M3 contract
// (MILESTONE-CONTRACT.json M3 "12 Eyes of Ender").
//
// M3's terminal predicate is ONE final inventory threshold: `ender_eye >= 12`.
// Historical inventory samples and the sticky milestone predicate prove that
// the threshold was reached at some point, but cannot prove the eyes are still
// held at acceptance time. PASS therefore also needs the HOST's current,
// run-bound inventory observation from the read-only control `report` query.
// The item id is `ender_eye` (display "Eye of Ender"); `eye_of_ender` is the thrown
// projectile entity and is never counted here. An M3 PASS is milestone
// acceptance evidence, so it additionally requires the same model-authority
// facts the current-M2 gate enforces:
//   * at least one `source=jev` decision and zero `source=fallback` decisions in R;
//   * generation policyKind=typesafe / policyModel=typesafe-ai/jev;
//   * plannerMode=llm and deterministicFallbackEnabled=false.
// The M2-specific System2 portal-plan decision is deliberately NOT required:
// that fact belongs to M2's portal chain, not to the 12-eyes predicate.
//
// Evidence is the SAME run-scoped artifacts the M2 gate reads, bound to ONE
// runId (no second schema):
//   * `m2-snapshot-<runId>.json` — inventory samples at every recorded marker
//     plus initial/latest/terminal inventory, run-scoped by filename AND body;
//   * `milestone-predicates-<runId>.json` — the resident's own live predicate
//     observations (tools/milestone-predicates.mjs). Used when present; rejected
//     on a record / runId / sourceSha mismatch, and emitted as historical progress;
//   * the resident log, bracketed by its BOOT runId boundary: INVENTORY /
//     MILESTONE lines carry the history needed for resource diagnostics, and
//     `dimension=` lines are reported as an intermediate fact;
//   * the current-inventory observation returned by the same read-only HOST
//     `report` query that bounds live policy evidence. This is pinned into the
//     acceptance artifact and must match R's runId and BOOT source SHA.
//
// `--run <runId>` (or M3_RUN_ID) is MANDATORY. Evidence from another run is
// never attributed to R, so a run's inventory can never be combined with
// another run's. The run's exact 40-hex source SHA is independently bound from
// R's BOOT line; a missing/ambiguous SHA is UNKNOWN, and host predicate evidence
// is accepted only when its own SHA matches that BOOT source. Missing/unbound
// evidence is UNKNOWN and NEVER PASS.
//
// FAIL is reserved for a known capability failure: R's own evidence proves every
// crafting input for 12 eyes existed at one instant (ender_pearl>=12 AND
// (blaze_powder>=12 OR blaze_rod>=7)) while the terminal ender_eye count stayed
// below 12. A run merely short of inputs is UNKNOWN, not FAIL.
//
// Exit: 0 = PASS, 1 = FAIL (materials complete, eyes short), 2 = UNKNOWN.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  M2_GATE_CONTROL_SOCK,
  M2_GATE_DECISIONS,
  M2_GATE_LOG,
  M2_GATE_RUNNER_OUT,
  M2_GATE_SNAPSHOT_DIR,
  RUN_ID_RE,
  readPolicySocketBinding,
  readRunScopedM2Evidence,
} from './m2-gate.mjs'
import { evaluatePolicyEvidence, loadPolicyEvidence } from './m2-policy-evidence.mjs'
import {
  BLAZE_POWDER,
  BLAZE_POWDER_REQUIRED,
  BLAZE_ROD,
  BLAZE_ROD_REQUIRED,
  ENDER_EYE,
  ENDER_EYE_REQUIRED,
  ENDER_PEARL,
  ENDER_PEARL_REQUIRED,
  deriveMilestonePredicates,
  readMilestonePredicateEvidence,
} from './milestone-predicates.mjs'
import { scanRunSourceExactness } from './run-source-exactness.mjs'

/** Re-exported so the live-gate wrapper shares the exact same run-id shape rule. */
export { RUN_ID_RE }
/** The canonical predicate thresholds live with the predicate evaluator. */
export { BLAZE_POWDER, BLAZE_POWDER_REQUIRED, BLAZE_ROD, BLAZE_ROD_REQUIRED, ENDER_EYE, ENDER_EYE_REQUIRED, ENDER_PEARL, ENDER_PEARL_REQUIRED }

export const M3_RUN_RESULT = 'M3_RUN_RESULT'
export const M3_RUN_GATE = 'M3_RUN_GATE'
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/i

/** The conditions M3 must prove; inventory facts beyond these are diagnostics. */
export const M3_REQUIRED_CONDITIONS = Object.freeze(['exact_source', 'ender_eye_ready', 'model_authority', 'nether_reached'])

/** Default to the shared M2 run-scoped artifacts; allow M3-specific overrides. */
export const M3_GATE_LOG = process.env.M3_GATE_LOG ?? process.env.M3_LOG ?? M2_GATE_LOG
export const M3_GATE_SNAPSHOT_DIR =
  process.env.M3_GATE_SNAPSHOT_DIR ?? process.env.M3_SNAPSHOT_DIR ?? M2_GATE_SNAPSHOT_DIR
export const M3_GATE_DECISIONS = process.env.M3_DECISIONS ?? M2_GATE_DECISIONS
export const M3_GATE_RUNNER_OUT = process.env.M3_RUNNER_OUT ?? M2_GATE_RUNNER_OUT
export const M3_GATE_CONTROL_SOCK = process.env.M3_CONTROL_SOCK ?? M2_GATE_CONTROL_SOCK

// ---------------------------------------------------------------------------
// inventory facts (all joined only inside ONE runId)
// ---------------------------------------------------------------------------

function maxObserved(samples, item) {
  let max = 0
  for (const counts of samples) {
    const value = counts?.[item]
    if (typeof value === 'number' && Number.isFinite(value) && value > max) max = value
  }
  return max
}

/**
 * The M3 inventory facts from R's history plus its acceptance-time HOST
 * observation. `ready` is true only when that current inventory holds 12 eyes;
 * `materialInputsComplete` is true only when ONE historical sample held every
 * crafting input for 12 eyes, so a FAIL can never be assembled from two instants.
 */
export function evaluateEnderEyes(samples, terminalInventory = null) {
  const list = Array.isArray(samples) ? samples : []
  const maxObservedEnderEye = maxObserved(list, ENDER_EYE)
  const terminalCounts = terminalInventory?.counts
  const terminalInventoryObserved = terminalCounts !== null && typeof terminalCounts === 'object' && !Array.isArray(terminalCounts)
  const enderEye = terminalInventoryObserved ? terminalCounts[ENDER_EYE] ?? 0 : null
  const enderPearl = maxObserved(list, ENDER_PEARL)
  const blazeRod = maxObserved(list, BLAZE_ROD)
  const blazePowder = maxObserved(list, BLAZE_POWDER)
  const ready = terminalInventoryObserved && enderEye >= ENDER_EYE_REQUIRED
  const materialInputsComplete = list.some(
    (counts) =>
      (counts?.[ENDER_PEARL] ?? 0) >= ENDER_PEARL_REQUIRED &&
      ((counts?.[BLAZE_POWDER] ?? 0) >= BLAZE_POWDER_REQUIRED || (counts?.[BLAZE_ROD] ?? 0) >= BLAZE_ROD_REQUIRED),
  )
  return {
    ready,
    enderEye,
    maxObservedEnderEye,
    enderPearl,
    blazeRod,
    blazePowder,
    materialInputsComplete,
    terminalInventoryObserved,
  }
}

function bindTerminalInventoryObservation(value, expectedRunId, runSourceSha, reportWorldKey) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unavailable', reason: 'current_inventory_observation_missing', observation: null }
  }
  const counts = value.counts
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    return { status: 'invalid', reason: 'current_inventory_counts_missing', observation: null }
  }
  if (value.record !== 'current-inventory-observation' || value.schemaVersion !== 1) {
    return { status: 'invalid', reason: 'current_inventory_record_invalid', observation: null }
  }
  if (value.runId !== expectedRunId) {
    return { status: 'invalid', reason: `current_inventory_run_mismatch observed=${String(value.runId ?? 'unknown')}`, observation: null }
  }
  if (normalizeSourceSha(value.sourceSha) !== runSourceSha) {
    return {
      status: 'invalid',
      reason: `current_inventory_source_sha_mismatch expected=${runSourceSha} observed=${normalizeSourceSha(value.sourceSha) ?? 'invalid'}`,
      observation: null,
    }
  }
  if (
    !Number.isFinite(value.observedAtMs) ||
    typeof value.observedAt !== 'string' ||
    Date.parse(value.observedAt) !== value.observedAtMs
  ) {
    return { status: 'invalid', reason: 'current_inventory_timestamp_invalid', observation: null }
  }
  const observationWorldKey = value.worldKey
  if (observationWorldKey === null || typeof observationWorldKey !== 'object' || Array.isArray(observationWorldKey)) {
    return { status: 'invalid', reason: 'current_inventory_world_key_missing', observation: null }
  }
  if (reportWorldKey === null || typeof reportWorldKey !== 'object' || Array.isArray(reportWorldKey)) {
    return { status: 'invalid', reason: 'report_world_key_missing', observation: null }
  }
  const validWorldIdentity = (key) =>
    typeof key.serverId === 'string' && key.serverId.trim().length > 0 &&
    Number.isInteger(key.worldEpoch) && key.worldEpoch >= 0
  if (!validWorldIdentity(observationWorldKey) || !validWorldIdentity(reportWorldKey)) {
    return { status: 'invalid', reason: 'current_inventory_world_identity_invalid', observation: null }
  }
  if (observationWorldKey.serverId !== reportWorldKey.serverId || observationWorldKey.worldEpoch !== reportWorldKey.worldEpoch) {
    return { status: 'invalid', reason: 'current_inventory_world_identity_mismatch', observation: null }
  }
  if (typeof value.dimension !== 'string' || value.dimension.length === 0 || observationWorldKey.dimension !== value.dimension) {
    return { status: 'invalid', reason: 'current_inventory_dimension_world_key_mismatch', observation: null }
  }
  for (const count of Object.values(counts)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      return { status: 'invalid', reason: 'current_inventory_counts_invalid', observation: null }
    }
  }
  return {
    status: 'valid',
    reason: null,
    observation: {
      record: value.record,
      schemaVersion: value.schemaVersion,
      runId: value.runId,
      sourceSha: value.sourceSha.toLowerCase(),
      generationId: typeof value.generationId === 'string' ? value.generationId : null,
      observedAtMs: value.observedAtMs,
      observedAt: value.observedAt,
      worldKey: value.worldKey !== null && typeof value.worldKey === 'object' && !Array.isArray(value.worldKey) ? value.worldKey : null,
      dimension: typeof value.dimension === 'string' ? value.dimension : null,
      counts: { ...counts },
    },
  }
}

// ---------------------------------------------------------------------------
// model authority (mirrors the M2 gate minus the M2-only System2 requirement)
// ---------------------------------------------------------------------------

/**
 * M3 authority verdict. Reuses the M2 policy evidence evaluator (jev decisions +
 * typesafe policy/model) and adds the planner/fallback facts. Every non-proof
 * path is UNKNOWN (code 2); PASS requires code 0.
 */
export function evaluateM3AuthorityEvidence({ expectedRunId = null, decisions = null, generation = null, system2 = null } = {}) {
  const base = evaluatePolicyEvidence({ expectedRunId, decisions, generation })
  const facts = {
    ...base.facts,
    plannerMode: generation?.plannerMode ?? null,
    deterministicFallbackEnabled: generation?.deterministicFallbackEnabled ?? null,
    system2IdentityStatus: system2?.identityStatus ?? null,
    system2IdentityReason: system2?.identityReason ?? null,
    system2EffectiveProvider: system2?.effectiveProvider ?? null,
    system2EffectiveModel: system2?.effectiveModel ?? null,
    system2ConfiguredProvider: system2?.configuredProvider ?? null,
    system2ConfiguredModel: system2?.configuredModel ?? null,
    system2Decisions: Number.isFinite(system2?.count) ? system2.count : null,
    system2ModelDecisions: Number.isFinite(system2?.modelCount) ? system2.modelCount : null,
  }
  if (base.code !== 0) return { code: base.code, status: base.status, reason: base.reason, facts }
  if (generation?.plannerMode !== 'llm') {
    return { code: 2, status: 'UNKNOWN', reason: `planner_not_llm observed=${generation?.plannerMode ?? 'unknown'}`, facts }
  }
  if (generation?.deterministicFallbackEnabled !== false) {
    return {
      code: 2,
      status: 'UNKNOWN',
      reason: `deterministic_fallback_not_disabled observed=${String(generation?.deterministicFallbackEnabled ?? 'unknown')}`,
      facts,
    }
  }
  if (system2 === null || system2.runId !== expectedRunId || system2.identityStatus !== 'verified') {
    return {
      code: 2,
      status: 'UNKNOWN',
      reason: `system2_generation_identity_unverified runId=${system2?.runId ?? 'unknown'} reason=${system2?.identityReason ?? 'missing'}`,
      facts,
    }
  }
  if (!Number.isFinite(system2.count) || system2.count < 1 || system2.modelCount !== system2.count ||
      typeof system2.effectiveProvider !== 'string' || system2.effectiveProvider.length === 0 ||
      typeof system2.effectiveModel !== 'string' || system2.effectiveModel.length === 0) {
    return { code: 2, status: 'UNKNOWN', reason: 'system2_effective_model_authority_missing_or_incomplete', facts }
  }
  return { code: 0, status: 'VERIFIED', reason: 'm3_model_authority_verified', facts }
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

function unknownConditions() {
  return { exact_source: 'UNKNOWN', ender_eye_ready: 'UNKNOWN', model_authority: 'UNKNOWN', nether_reached: 'UNKNOWN' }
}

function normalizeSourceSha(value) {
  return typeof value === 'string' && SOURCE_SHA_RE.test(value) ? value.toLowerCase() : null
}

function normalizeDimensionId(value) {
  return typeof value === 'string' ? value.replace(/^minecraft:/, '').toLowerCase() : null
}

/** Only a live-world BODY transition from a known non-Nether dimension proves entry. */
function isNetherEntryTransition(value) {
  const from = normalizeDimensionId(value?.from)
  const to = normalizeDimensionId(value?.to)
  const dimension = normalizeDimensionId(value?.dimension)
  return value?.source === 'live-world' &&
    Number.isFinite(value?.atMs) &&
    from !== null && from !== 'unknown' && from !== 'the_nether' &&
    to === 'the_nether' && dimension === to
}

function verdict({ status, code, reason, runId, sourceSha = null, conditions, evidence = null, sources = null, facts = null }) {
  return { id: 'M3', status, code, reason, runId, sourceSha, conditions, evidence, sources, facts }
}

function bindAcceptanceGitCommit(runId, snapshotDir, sourceExactness) {
  if (sourceExactness?.status !== 'exact') return sourceExactness
  const path = join(snapshotDir, `acceptance-${runId}.json`)
  if (!existsSync(path)) return sourceExactness
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (record?.record !== 'acceptance' || record.runId !== runId) {
      return { ...sourceExactness, status: 'unknown', exact: false, reason: `acceptance_record_run_mismatch path=${path}` }
    }
    const gitCommit = typeof record.gitCommit === 'string' ? record.gitCommit.toLowerCase() : null
    if (gitCommit !== null && gitCommit !== sourceExactness.sourceSha.toLowerCase()) {
      return {
        ...sourceExactness,
        status: 'unknown',
        exact: false,
        reason: `acceptance_git_commit_mismatch boot=${sourceExactness.sourceSha} acceptance=${gitCommit}`,
      }
    }
    return sourceExactness
  } catch (error) {
    return {
      ...sourceExactness,
      status: 'unknown',
      exact: false,
      reason: `acceptance_artifact_unreadable ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Pure run-scoped M3 verdict. PASS (0) only when the HOST's acceptance-time
 * inventory observation proves `ender_eye>=12`, and the full model-authority
 * proof plus Nether observation are bound to R. A materials-complete run whose
 * acceptance-time inventory is short is FAIL (1). Missing or mismatched final
 * inventory is UNKNOWN (2), never PASS.
 */
export function evaluateM3Gate({
  expectedRunId = null,
  evidence = null,
  policy = null,
  dimensions = null,
  milestonePredicates = null,
  sourceSha = null,
  currentInventoryObservation = null,
  reportWorldKey = null,
  sourceExactness = null,
} = {}) {
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
      reason: evidence?.reason ?? 'm3_evidence_unavailable',
      runId: expectedRunId,
      conditions: unknownConditions(),
      evidence: evidence?.status ?? 'unavailable',
      sources: evidence?.sources ?? null,
    })
  }
  // Defense in depth: even an already-`valid` evidence bundle must name R. The
  // reader binds by filename/BOOT boundary; this guard makes cross-run joining
  // impossible even through an injected reader.
  if (evidence.runId !== expectedRunId) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `evidence_run_mismatch expected=${expectedRunId} observed=${typeof evidence.runId === 'string' ? evidence.runId : 'unknown'}`,
      runId: expectedRunId,
      conditions: unknownConditions(),
    })
  }

  // The run's source identity comes from its same-run BOOT and remains exact only
  // when every available log stream agrees and no source-changing reload replaced
  // it. Generation bundle hashes never stand in for Git SHAs.
  const exactSourceSha = normalizeSourceSha(sourceExactness?.sourceSha)
  if (sourceExactness?.status !== 'exact' || sourceExactness?.runId !== expectedRunId || exactSourceSha === null) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `run_source_not_exact reason=${sourceExactness?.reason ?? 'source_provenance_unavailable'}`,
      runId: expectedRunId,
      conditions: unknownConditions(),
      evidence: sourceExactness?.status ?? 'unavailable',
      facts: { sourceSha: exactSourceSha, sourceExactness },
    })
  }
  // The scanner independently reads the BOOT window; require it to agree with
  // the M2 evidence reader before either one can establish the gate's source.
  const runSourceSha = normalizeSourceSha(evidence.sourceSha)
  if (runSourceSha === null || runSourceSha !== exactSourceSha) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: runSourceSha === null
        ? `run_source_sha_unavailable reason=${evidence.sourceShaReason ?? 'run_source_sha_missing'}`
        : `source_stream_boot_sha_disagreement evidence=${runSourceSha} exactness=${exactSourceSha}`,
      runId: expectedRunId,
      sourceSha: exactSourceSha,
      conditions: unknownConditions(),
      evidence: evidence.status,
      facts: { sourceSha: exactSourceSha, sourceExactness },
    })
  }
  // A run-scoped M2 snapshot can contribute inventory and dimension history to
  // this gate. Its runId-bound filename is not enough to bind that history to
  // the code that produced the run, so preserve and honor the reader's explicit
  // snapshot/source mismatch even when the BOOT logs themselves agree exactly.
  if (evidence.sourceShaReason != null || evidence.sourceShaMismatch != null) {
    const reason = evidence.sourceShaReason ?? 'run_source_sha_mismatch'
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `run_evidence_source_sha_unverified reason=${reason}`,
      runId: expectedRunId,
      sourceSha: exactSourceSha,
      conditions: unknownConditions(),
      evidence: evidence.status,
      facts: {
        sourceSha: runSourceSha,
        sourceExactness,
        sourceShaReason: evidence.sourceShaReason ?? null,
        sourceShaMismatch: evidence.sourceShaMismatch ?? null,
      },
    })
  }
  if (sourceSha !== null && normalizeSourceSha(sourceSha) !== runSourceSha) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `run_source_sha_mismatch expected=${runSourceSha} observed=${normalizeSourceSha(sourceSha) ?? 'invalid'}`,
      runId: expectedRunId,
      sourceSha: runSourceSha,
      conditions: unknownConditions(),
      evidence: evidence.status,
      facts: { sourceSha: runSourceSha, sourceExactness },
    })
  }

  const sources = Array.isArray(evidence.sources) ? evidence.sources : []
  const samples = sources.flatMap((source) => (Array.isArray(source.inventorySamples) ? source.inventorySamples : []))
  const terminalInventory = bindTerminalInventoryObservation(currentInventoryObservation, expectedRunId, runSourceSha, reportWorldKey)
  const eyes = evaluateEnderEyes(samples, terminalInventory.observation)
  const observedDimensions = Array.isArray(dimensions)
    ? dimensions
    : sources.flatMap((source) => (Array.isArray(source.dimensionObservations) ? source.dimensionObservations : []))
  const observedDimensionTransitions = sources.flatMap((source) => (Array.isArray(source.dimensionTransitions) ? source.dimensionTransitions : []))
  const netherEntryTransitions = observedDimensionTransitions.filter(isNetherEntryTransition)
  const dimension = observedDimensions.length > 0 ? observedDimensions.at(-1) : null
  const authorityPass = policy?.code === 0

  // FIRST-CLASS milestone predicate evidence. When the caller already read the
  // run-scoped predicate section (resident observe-loop observations + log +
  // snapshot) it is used as-is; otherwise it is derived from the SAME run-scoped
  // sources this gate judges. These are historical rung observations: the sticky
  // `ender_eyes` predicate cannot prove the final count, which is checked from the
  // current HOST observation. Nether arrival can be proven from run-bound history.
  const deriveFromRunEvidence = (hostObservation = null) =>
    deriveMilestonePredicates({
      runId: expectedRunId,
      runSourceSha,
      inventorySamples: samples.map((counts) => ({ counts, source: 'log' })),
      dimensionObservations: netherEntryTransitions.map((entry) => ({
        dimension: entry.to,
        from: entry.from,
        to: entry.to,
        atMs: entry.atMs,
        source: 'log:DIMENSION_TRANSITION',
      })),
      portalEvents: sources.flatMap((source) => (Array.isArray(source.portalEvents) ? source.portalEvents.map((event) => ({ ...event, source: source.name })) : [])),
      hostObservation,
    })
  let predicateSection = milestonePredicates ?? deriveFromRunEvidence()
  if (
    milestonePredicates !== null &&
    (milestonePredicates.runId !== expectedRunId || normalizeSourceSha(milestonePredicates.sourceSha) !== runSourceSha)
  ) {
    const observedSha = normalizeSourceSha(milestonePredicates.sourceSha) ?? 'unknown'
    const reason = milestonePredicates.runId !== expectedRunId
      ? `milestone_predicates_run_mismatch expected=${expectedRunId} observed=${milestonePredicates.runId ?? 'unknown'}`
      : `milestone_predicates_source_sha_mismatch expected=${runSourceSha} observed=${observedSha}`
    predicateSection = deriveFromRunEvidence()
    predicateSection.mismatches.push(reason)
  }
  // The observe-loop predicate is a useful record, but a caller-supplied or
  // pre-derived `nether_reached=true` is not itself the required transition
  // evidence. Replace that row from the independently scanned BODY transition
  // so its source and timestamp describe the proof the gate actually accepts.
  const independentNetherSection = deriveMilestonePredicates({
    runId: expectedRunId,
    runSourceSha,
    dimensionObservations: netherEntryTransitions.map((entry) => ({
      dimension: entry.to,
      from: entry.from,
      to: entry.to,
      atMs: entry.atMs,
      source: 'log:DIMENSION_TRANSITION',
    })),
  })
  const independentNetherPredicate = independentNetherSection.predicates.find((predicate) => predicate.id === 'nether_reached')
  const suppliedPredicates = Array.isArray(predicateSection?.predicates)
    ? predicateSection.predicates.filter((predicate) => predicate !== null && typeof predicate === 'object' && !Array.isArray(predicate))
    : []
  const suppliedNetherPredicate = suppliedPredicates.find((predicate) => predicate.id === 'nether_reached')
  const ignoredPredicateClaim = suppliedNetherPredicate?.satisfied === true && independentNetherPredicate.satisfied !== true
  let replacedNether = independentNetherPredicate
  if (netherEntryTransitions.length > 0) {
    const transition = netherEntryTransitions[0]
    replacedNether = {
      ...independentNetherPredicate,
      evidence: {
        ...(independentNetherPredicate.evidence ?? {}),
        transition: {
          from: transition.from,
          to: transition.to,
          dimension: transition.dimension,
          atMs: transition.atMs,
          source: transition.source,
          runId: expectedRunId,
          sourceSha: runSourceSha,
        },
      },
    }
  } else {
    replacedNether = {
      ...independentNetherPredicate,
      evidence: { ...(independentNetherPredicate.evidence ?? {}), rejected: 'body_dimension_transition_missing' },
    }
  }
  predicateSection = {
    ...(predicateSection !== null && typeof predicateSection === 'object' ? predicateSection : {}),
    observationSources: Array.isArray(predicateSection?.observationSources) ? predicateSection.observationSources : [],
    mismatches: [
      ...(Array.isArray(predicateSection?.mismatches) ? predicateSection.mismatches : []),
      ...(ignoredPredicateClaim ? ['unverified_nether_predicate_source_ignored'] : []),
    ],
    missing: [
      ...(Array.isArray(predicateSection?.missing) ? predicateSection.missing.filter((id) => id !== 'nether_reached') : []),
      ...(replacedNether.satisfied === true ? [] : ['nether_reached']),
    ],
    predicates: (() => {
      let replaced = false
      const predicates = suppliedPredicates.map((predicate) => {
        if (predicate.id !== 'nether_reached') return predicate
        replaced = true
        return replacedNether
      })
      if (!replaced) predicates.push(replacedNether)
      return predicates
    })(),
  }
  // The sticky milestone predicate is historical progress. It cannot replace the
  // final inventory observation required by the M3 acceptance contract.
  const eyesReady = eyes.ready
  const materialsFail = terminalInventory.status === 'valid' && !eyesReady && eyes.materialInputsComplete

  // M3 requires a same-run live BODY transition into the Nether. Portal
  // dimensions, route targets, spawn-at-generation-start, and sticky predicates
  // cannot substitute for an independently logged transition.
  const netherObserved = netherEntryTransitions.length > 0
  const conditions = {
    exact_source: 'PASS',
    ender_eye_ready: eyesReady ? 'PASS' : materialsFail ? 'FAIL' : 'UNKNOWN',
    model_authority: authorityPass ? 'PASS' : 'UNKNOWN',
    nether_reached: netherObserved ? 'PASS' : 'UNKNOWN',
  }
  const perSource = sources.map((source) => ({
    name: source.name,
    path: source.path,
    inventorySamples: Array.isArray(source.inventorySamples) ? source.inventorySamples.length : 0,
    dimensionObservations: Array.isArray(source.dimensionObservations) ? source.dimensionObservations : [],
    dimensionTransitions: Array.isArray(source.dimensionTransitions) ? source.dimensionTransitions : [],
  }))
  const facts = {
    sourceSha: runSourceSha,
    sourceExactness,
    eyes,
    terminalInventory: {
      status: terminalInventory.status,
      reason: terminalInventory.reason,
      observation: terminalInventory.observation,
    },
    dimension,
    dimensions: [...new Set(observedDimensions.map((entry) => (typeof entry === 'string' ? entry : entry?.dimension ?? null)))],
    dimensionTransitions: observedDimensionTransitions,
    netherEntryTransitions,
    netherReached: netherObserved,
    authority: policy?.facts ?? null,
    milestonePredicates: {
      runId: predicateSection.runId,
      sourceSha: predicateSection.sourceSha,
      observationSources: predicateSection.observationSources,
      missing: predicateSection.missing,
      mismatches: predicateSection.mismatches,
      predicates: predicateSection.predicates.map((predicate) => ({
        id: predicate.id,
        satisfied: predicate.satisfied,
        observedAtMs: predicate.observedAtMs,
        observedAt: predicate.observedAt,
        source: predicate.source,
        evidence: predicate.evidence,
      })),
    },
  }

  if (materialsFail) {
    return verdict({
      status: 'FAIL',
      code: 1,
      reason: 'ender_eyes_short_with_crafting_materials',
      runId: expectedRunId,
      sourceSha: runSourceSha,
      conditions,
      sources: perSource,
      facts,
    })
  }
  if (eyesReady && !authorityPass) {
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
  // The PASS branch must not bypass the required-condition list: before this, `eyes.ready &&
  // authorityPass` returned PASS regardless of any other required condition, which is how a run
  // could have claimed M3 while `nether_reached` was still UNKNOWN.
  const unmetRequired = M3_REQUIRED_CONDITIONS.filter((condition) => conditions[condition] !== 'PASS')
  if (eyesReady && authorityPass && unmetRequired.length > 0) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `m3_stages_incomplete:${unmetRequired.join(',')}`,
      runId: expectedRunId,
      sourceSha: runSourceSha,
      conditions,
      sources: perSource,
      facts,
    })
  }
  if (eyesReady && authorityPass) {
    return verdict({
      status: 'PASS',
      code: 0,
      reason: 'twelve_eyes_of_ender_verified',
      runId: expectedRunId,
      sourceSha: runSourceSha,
      conditions,
      sources: perSource,
      facts,
    })
  }
  const missing = M3_REQUIRED_CONDITIONS.filter((condition) => conditions[condition] !== 'PASS')
  return verdict({
    status: 'UNKNOWN',
    code: 2,
    reason: `m3_stages_incomplete:${missing.join(',')}`,
    runId: expectedRunId,
    sourceSha: runSourceSha,
    conditions,
    sources: perSource,
    facts,
  })
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export function requestedM3RunId(argv = process.argv.slice(2), env = process.env) {
  let value = env.M3_RUN_ID ?? null
  const index = argv.indexOf('--run')
  if (index !== -1) value = argv[index + 1] ?? null
  if (value === null || String(value).trim() === '') return null
  const runId = String(value).trim()
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid --run value: ${value}`)
  return runId
}

export async function runM3Gate({
  expectedRunId = null,
  readEvidence = null,
  logPath = M3_GATE_LOG,
  snapshotDir = M3_GATE_SNAPSHOT_DIR,
  policyEvidence = null,
  loadPolicy = loadPolicyEvidence,
  policySocket = undefined,
  controlSocketPath = M3_GATE_CONTROL_SOCK,
  decisionsPath = M3_GATE_DECISIONS,
  runnerOutPath = M3_GATE_RUNNER_OUT,
  sourceSha = null,
  now = () => new Date(),
  write = (line) => process.stdout.write(`${line}\n`),
  json = false,
  // ADDITIVE (schema-neutral): see tools/m2-gate.mjs `onResult`. The structured
  // verdict is handed to an assembler without changing the printed lines or the
  // returned exit code.
  onResult = null,
} = {}) {
  const stamp = now().toISOString()
  const resolveEvidence = readEvidence ?? ((runId) => readRunScopedM2Evidence(runId, { logPath, snapshotDir }))
  const scoped = expectedRunId !== null && RUN_ID_RE.test(String(expectedRunId))
  const evidence = scoped ? await resolveEvidence(expectedRunId) : null
  let socketBinding = policySocket === undefined ? null : policySocket
  let rawPolicy = policyEvidence
  if (scoped && rawPolicy === null) {
    socketBinding = policySocket === undefined ? await readPolicySocketBinding(controlSocketPath) : policySocket
    // Same run-binding fallback as the M2 gate: the resident is normally started detached,
    // so `runner.out` often does not exist while `buddy.log` carries the identical
    // `[ISO] BOOT ... runId=...` lines. Without this the acceptance verdict degrades to
    // `decisions_evidence_unavailable`, which says nothing about the run.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const runnerOutForScan =
      runnerOutPath !== null && runnerOutPath !== undefined && existsSync(runnerOutPath)
        ? runnerOutPath
        : join(repoRoot, 'packages/buddy-driver', 'buddy.log')
    rawPolicy = await loadPolicy({
      runId: expectedRunId,
      socket: socketBinding?.runId === expectedRunId ? socketBinding : null,
      decisionsPath,
      runnerOutPath: runnerOutForScan,
    })
  }
  if (policySocket !== undefined) socketBinding = policySocket
  const policy = scoped
    ? evaluateM3AuthorityEvidence({
        expectedRunId,
      decisions: rawPolicy?.decisions ?? null,
      generation: rawPolicy?.generation ?? null,
      system2: rawPolicy?.system2 ?? null,
    })
    : null
  const scannedSourceExactness = scoped
    ? await scanRunSourceExactness(expectedRunId, [logPath, runnerOutPath])
    : { status: 'unknown', exact: false, runId: expectedRunId, sourceSha: null, reason: 'exact_run_scope_required' }
  const sourceExactness = scoped
    ? bindAcceptanceGitCommit(expectedRunId, snapshotDir, scannedSourceExactness)
    : scannedSourceExactness
  // The resident produces a run-scoped predicate observation file in the same
  // directory as the M2 snapshot. It is used when present (live observations),
  // and the gate otherwise derives the section from its own run-scoped evidence.
  const hostObservation = scoped ? readMilestonePredicateEvidence(expectedRunId, { dir: snapshotDir }) : null
  const milestonePredicates =
    scoped && hostObservation !== null && hostObservation.present
      ? deriveMilestonePredicates({
          runId: expectedRunId,
          runSourceSha: sourceExactness?.sourceSha ?? null,
          inventorySamples: (evidence?.sources ?? []).flatMap((source) =>
            (Array.isArray(source.inventorySamples) ? source.inventorySamples : []).map((counts) => ({ counts, source: 'log' })),
          ),
          dimensionObservations: (evidence?.sources ?? []).flatMap((source) =>
            (Array.isArray(source.dimensionTransitions) ? source.dimensionTransitions : [])
              .filter(isNetherEntryTransition)
              .map((transition) => ({
                dimension: transition.to,
                from: transition.from,
                to: transition.to,
                atMs: transition.atMs,
                source: 'log:DIMENSION_TRANSITION',
              })),
          ),
          portalEvents: (evidence?.sources ?? []).flatMap((source) =>
            (Array.isArray(source.portalEvents) ? source.portalEvents : []).map((event) => ({ ...event, source: source.name })),
          ),
          hostObservation,
        })
      : null
  const result = evaluateM3Gate({
    expectedRunId,
    evidence,
    policy,
    milestonePredicates,
    sourceSha,
    currentInventoryObservation: socketBinding?.runId === expectedRunId ? socketBinding.currentInventoryObservation ?? null : null,
    reportWorldKey: socketBinding?.runId === expectedRunId ? socketBinding.worldKey ?? null : null,
    sourceExactness,
  })
  if (typeof onResult === 'function') onResult(result)

  if (json) {
    write(
      JSON.stringify({
        id: result.id,
        status: result.status,
        reason: result.reason,
        runId: result.runId,
        sourceSha: result.sourceSha,
        sourceExactness: result.facts?.sourceExactness ?? null,
        conditions: result.conditions,
        evidence: evidence === null ? null : { status: evidence.status, sources: (evidence.sources ?? []).map((s) => s.name) },
        policy: policy === null ? null : { status: policy.status, reason: policy.reason },
        facts: result.facts ?? null,
      }),
    )
    return result.code
  }

  write(`${M3_RUN_GATE} — ${stamp}`)
  write(`expectedRunId: ${expectedRunId ?? 'none'}`)
  write(`sourceSha: ${result.sourceSha ?? 'unknown'}`)
  write(
    `m3_source: status=${result.facts?.sourceExactness?.status ?? 'unknown'} ` +
      `reason=${result.facts?.sourceExactness?.reason ?? 'none'} ` +
      `reloads=${result.facts?.sourceExactness?.reloadCount ?? 0}`,
  )
  if (evidence !== null) {
    const sourceNames = (evidence.sources ?? []).map((source) => source.name).join(',')
    write(`m3_evidence: ${evidence.status} sources=${sourceNames || 'none'}${evidence.reason ? ` reason=${evidence.reason}` : ''}`)
  }
  for (const condition of M3_REQUIRED_CONDITIONS) write(`${condition}: ${result.conditions[condition]}`)
  if (policy !== null) write(`policy: ${policy.status} reason=${policy.reason}`)
  if (result.facts?.eyes !== undefined) {
    write(
      `m3_facts: ender_pearl=${result.facts.eyes.enderPearl} blaze_rod=${result.facts.eyes.blazeRod} ` +
        `blaze_powder=${result.facts.eyes.blazePowder} ender_eye=${result.facts.eyes.enderEye ?? 'unknown'} ` +
        `ender_eye_max_observed=${result.facts.eyes.maxObservedEnderEye} ` +
        `dimension=${result.facts.dimension ?? 'unknown'} dimensions=${result.facts.dimensions.join(',') || 'none'}`,
    )
    for (const transition of result.facts.netherEntryTransitions ?? []) {
      write(
        `m3_dimension_transition from=${transition.from} to=${transition.to} at=${transition.ts ?? new Date(transition.atMs).toISOString()} ` +
          `source=${transition.source} runId=${expectedRunId} sourceSha=${result.sourceSha}`,
      )
    }
    write(
      `m3_terminal_inventory: status=${result.facts.terminalInventory.status} ` +
        `reason=${result.facts.terminalInventory.reason ?? 'none'} ` +
        `observedAt=${result.facts.terminalInventory.observation?.observedAt ?? 'unknown'} ` +
        `ender_eye=${result.facts.terminalInventory.observation?.counts?.ender_eye ?? 0}`,
    )
    const section = result.facts.milestonePredicates
    if (section !== undefined && section !== null) {
      write(
        `m3_predicates: runId=${section.runId ?? 'none'} sourceSha=${section.sourceSha ?? 'unknown'} ` +
          `sources=${section.observationSources.join(',') || 'none'} ` +
          `observed=${section.predicates.filter((predicate) => predicate.satisfied !== null).length}/${section.predicates.length} ` +
          `missing=${section.missing.join(',') || 'none'} ` +
          `mismatches=${section.mismatches.join(',') || 'none'}`,
      )
      for (const predicate of section.predicates) {
        write(
          `m3_predicate ${predicate.id}: ${predicate.satisfied === true ? 'PASS' : predicate.satisfied === false ? 'FAIL' : 'UNKNOWN'} ` +
            `at=${predicate.observedAt ?? (predicate.satisfied === null ? 'never' : 'unavailable')} source=${predicate.source ?? 'unobserved'}`,
        )
      }
    }
  }
  write(
    `${M3_RUN_RESULT} status=${result.status} reason=${result.reason} runId=${expectedRunId ?? 'none'} ` +
      `ender_eye=${result.conditions.ender_eye_ready} authority=${result.conditions.model_authority} ` +
      `sourceSha=${result.sourceSha ?? 'unknown'}`,
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
    const expectedRunId = requestedM3RunId(process.argv.slice(2), process.env)
    const options = {
      expectedRunId,
      json: args.json,
      logPath: args.log ?? M3_GATE_LOG,
      snapshotDir: args.snapshotDir ?? M3_GATE_SNAPSHOT_DIR,
      decisionsPath: args.decisions ?? M3_GATE_DECISIONS,
      runnerOutPath: args.runnerOut ?? M3_GATE_RUNNER_OUT,
      controlSocketPath: args.controlSocket ?? M3_GATE_CONTROL_SOCK,
    }
    process.exitCode = await runM3Gate(options)
  } catch (error) {
    process.stderr.write(`M3_GATE_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
