#!/usr/bin/env bun
// m2-policy-evidence: read-only proof that the REAL policy (`typesafe-ai/jev`)
// actually ran for an exact resident runId. This is a M2 gate-strengthening
// input: a run whose decisions came from the deterministic fallback can no
// longer satisfy M2 even if its markers and inventory look green.
//
// Two independent facts are required, BOTH bound to the same run R:
//   1. decisions: at least one decision in R's log window carries source=jev
//      (`buddy-driver/logs/jev/decisions.jsonl`; fallback entries carry
//       source=fallback).
//   2. generation: R's generation status reports policyKind=typesafe and
//      policyModel=typesafe-ai/jev. The resident `report` exposes this as
//      `status.policyKind` / `status.policyModel`; the `GENERATION_READY` line
//      in `buddy-driver/runner.out` renders the same facts as `policy=` /
//      `model=`.
//
// R's log window is bracketed by the `BOOT ... runId=R` line in runner.out and
// the next BOOT or `HOST_LOCK released` line. Evidence that cannot be bracketed
// to R, or that names a different run, is UNBOUND and MUST NOT pass. Nothing
// here is reconstructed: the only sources are the two named artifacts plus the
// socket report, and every fact is echoed so the result stays auditable.
//
// Exit: 0 = VERIFIED, 2 = UNKNOWN (never fabricate a pass).
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

export const REQUIRED_POLICY_KIND = 'typesafe'
export const REQUIRED_POLICY_MODEL = 'typesafe-ai/jev'
export const DEFAULT_DECISIONS =
  process.env.M2_DECISIONS ?? '/home/s0u7a/mc-ai/buddy-driver/logs/jev/decisions.jsonl'
export const DEFAULT_RUNNER_OUT =
  process.env.M2_RUNNER_OUT ?? '/home/s0u7a/mc-ai/buddy-driver/runner.out'
export const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/

const TS_RE = /^\[([^\]]+)\]/
const RUN_ID_RE_LINE = /\brunId=(run-[A-Za-z0-9-]+)/
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/i
const BUILD_HASH_RE = /^[0-9a-f]{12}$/i
const NON_MODEL_AUTHORITY_RE = /(?:^|[^a-z0-9])(?:stub|fixture|unavailable|unknown|none|fallback|deterministic|mock|fake)(?:$|[^a-z0-9])/i
const KNOWN_NON_MODEL_DECISION_SOURCES = new Set(['reflex'])

function extractTimestampMs(line) {
  const match = TS_RE.exec(line)
  if (match === null) return null
  const value = Date.parse(match[1])
  return Number.isFinite(value) ? value : null
}

function extractRunId(line) {
  return RUN_ID_RE_LINE.exec(line)?.[1] ?? null
}

function isBootLine(line) {
  return /\bBOOT\b(?!_)/.test(line)
}

function isReleaseLine(line) {
  return /\bHOST_LOCK\b/.test(line) && /\breleased\b/.test(line)
}

/**
 * Parse a GENERATION_READY line. runner.out renders the controller fields as
 * `policy=` / `model=`; the structured event names them policyKind/policyModel.
 * Accept both spellings so a future format change cannot silently hide the fact.
 */
export function parseGenerationLine(line) {
  const kind = /\bpolicyKind=(\S+)/.exec(line)?.[1] ?? /\bpolicy=(\S+)/.exec(line)?.[1] ?? null
  const model = /\bpolicyModel=(\S+)/.exec(line)?.[1] ?? /\bmodel=(\S+)/.exec(line)?.[1] ?? null
  const plannerMode = /\bplanner=(\S+)/.exec(line)?.[1] ?? null
  const fallback = /\bdeterministicFallbackEnabled=(true|false)\b/.exec(line)?.[1] ?? null
  const generationId = /\bgenerationId=(\S+)/.exec(line)?.[1] ?? /\bid=(\S+)/.exec(line)?.[1] ?? null
  return {
    generationId,
    sourceSha: /\bsourceSha=(\S+)/.exec(line)?.[1] ?? null,
    buildHash: /\bbuildHash=(\S+)/.exec(line)?.[1] ?? null,
    policyKind: kind,
    policyModel: model,
    plannerMode,
    deterministicFallbackEnabled: fallback === null ? null : fallback === 'true',
    system2ConfiguredProvider: /\bsystem2ConfiguredProvider=(\S+)/.exec(line)?.[1] ?? null,
    system2ConfiguredModel: /\bsystem2ConfiguredModel=(\S+)/.exec(line)?.[1] ?? null,
  }
}

export function parseSystem2AuthorityLine(line) {
  if (!/\bSYSTEM2_AUTHORITY_DECISION\b/.test(line)) return null
  const provider = /\bprovider=(\S+)/.exec(line)?.[1] ?? null
  const model = /\bmodel=(\S+)/.exec(line)?.[1] ?? null
  const chosen = /\bchosen=(\S+)/.exec(line)?.[1] ?? null
  const portalPlan = chosen === 'front_nether_portal' || /\bgoals=\[[^\n]*portal/i.test(line)
  return {
    generationId: /\bgenerationId=(\S+)/.exec(line)?.[1] ?? null,
    sourceSha: /\bsourceSha=(\S+)/.exec(line)?.[1] ?? null,
    buildHash: /\bbuildHash=(\S+)/.exec(line)?.[1] ?? null,
    provider,
    model,
    configuredProvider: /\bconfiguredProvider=(\S+)/.exec(line)?.[1] ?? null,
    configuredModel: /\bconfiguredModel=(\S+)/.exec(line)?.[1] ?? null,
    trigger: /\btrigger=(\S+)/.exec(line)?.[1] ?? null,
    chosen,
    portalPlan,
  }
}

export function parseSystem2AuthorityInputLine(line) {
  if (!/\bSYSTEM2_AUTHORITY_INPUT\b/.test(line)) return null
  return {
    generationId: /\bgenerationId=(\S+)/.exec(line)?.[1] ?? null,
    sourceSha: /\bsourceSha=(\S+)/.exec(line)?.[1] ?? null,
    buildHash: /\bbuildHash=(\S+)/.exec(line)?.[1] ?? null,
    provider: /\bprovider=(\S+)/.exec(line)?.[1] ?? null,
    model: /\bmodel=(\S+)/.exec(line)?.[1] ?? null,
    configuredProvider: /\bconfiguredProvider=(\S+)/.exec(line)?.[1] ?? null,
    configuredModel: /\bconfiguredModel=(\S+)/.exec(line)?.[1] ?? null,
    trigger: /\btrigger=(\S+)/.exec(line)?.[1] ?? null,
  }
}

export function isModelSystem2Decision(entry) {
  const provider = typeof entry?.provider === 'string' ? entry.provider.trim() : ''
  const model = typeof entry?.model === 'string' ? entry.model.trim() : ''
  return provider.length > 0 && model.length > 0 &&
    !NON_MODEL_AUTHORITY_RE.test(provider) && !NON_MODEL_AUTHORITY_RE.test(model)
}

/**
 * Scan runner.out once for the run boundaries and generation-start facts. BOOT
 * and HOST_LOCK released lines bracket a resident lifetime; GENERATION_READY
 * lines carry the policy facts but no runId, so they are only usable inside a
 * bracketed window.
 */
export async function scanRunnerOut(runnerOutPath) {
  const boots = []
  const releases = []
  const generations = []
  const system2Inputs = []
  const system2Decisions = []
  const rl = createInterface({ input: createReadStream(runnerOutPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const tsMs = extractTimestampMs(line)
    if (isBootLine(line)) {
      const runId = extractRunId(line)
      const sourceSha = /\bsource=(\S+)/.exec(line)?.[1] ?? null
      if (runId !== null && tsMs !== null) boots.push({ runId, tsMs, sourceSha })
      continue
    }
    if (isReleaseLine(line)) {
      if (tsMs !== null) releases.push(tsMs)
      continue
    }
    if (line.includes('GENERATION_READY') && tsMs !== null) {
      const parsed = parseGenerationLine(line)
      generations.push({ tsMs, ...parsed })
      continue
    }
    if (line.includes('SYSTEM2_AUTHORITY_INPUT') && tsMs !== null) {
      const parsed = parseSystem2AuthorityInputLine(line)
      if (parsed !== null) system2Inputs.push({ tsMs, ...parsed })
      continue
    }
    if (tsMs !== null) {
      const system2 = parseSystem2AuthorityLine(line)
      if (system2 !== null) system2Decisions.push({ tsMs, ...system2 })
    }
  }
  return { boots, releases, generations, system2Inputs, system2Decisions }
}

/** Bracket R's lifetime: [BOOT runId=R, next BOOT | HOST_LOCK released | now-live). */
export function resolveRunWindow(boots, releases, runId, { live = false, nowMs = Date.now() } = {}) {
  const index = boots.findIndex((boot) => boot.runId === runId)
  if (index === -1) return null
  const startMs = boots[index].tsMs
  const candidates = []
  const nextBoot = boots[index + 1]
  if (nextBoot !== undefined) candidates.push(nextBoot.tsMs)
  for (const released of releases) if (released > startMs) candidates.push(released)
  let endMs = candidates.length > 0 ? Math.min(...candidates) : null
  if (endMs === null && live) endMs = nowMs
  return { startMs, endMs, bounded: endMs !== null }
}

function buildSystem2GenerationLineage({ generations, inputs, decisions, bootSourceSha }) {
  const issues = []
  const generationById = new Map()
  const usedInputs = new Set()
  const addIssue = (reason) => {
    if (!issues.includes(reason)) issues.push(reason)
  }

  if (generations.length === 0) addIssue('generation_ready_missing')
  if (typeof bootSourceSha !== 'string' || !SOURCE_SHA_RE.test(bootSourceSha)) addIssue('boot_source_sha_missing_or_invalid')

  for (const generation of generations) {
    if (typeof generation.generationId !== 'string' || generation.generationId.length === 0) {
      addIssue(`generation_id_missing line=${generation.lineIndex ?? 'unknown'}`)
      continue
    }
    const existing = generationById.get(generation.generationId)
    if (existing !== undefined) {
      addIssue(`generation_id_duplicate id=${generation.generationId}`)
      continue
    }
    generationById.set(generation.generationId, generation)
    if (typeof generation.sourceSha !== 'string' || !SOURCE_SHA_RE.test(generation.sourceSha)) {
      addIssue(`generation_source_sha_missing_or_invalid id=${generation.generationId}`)
    } else if (typeof bootSourceSha === 'string' && SOURCE_SHA_RE.test(bootSourceSha) && generation.sourceSha.toLowerCase() !== bootSourceSha.toLowerCase()) {
      addIssue(`generation_source_sha_mismatch id=${generation.generationId} expected=${bootSourceSha} observed=${generation.sourceSha}`)
    }
    if (typeof generation.buildHash !== 'string' || !BUILD_HASH_RE.test(generation.buildHash)) {
      addIssue(`generation_build_hash_missing_or_invalid id=${generation.generationId}`)
    }
    if (typeof generation.system2ConfiguredProvider !== 'string' || generation.system2ConfiguredProvider.length === 0) {
      addIssue(`system2_configured_provider_missing id=${generation.generationId}`)
    }
    if (typeof generation.system2ConfiguredModel !== 'string' || generation.system2ConfiguredModel.length === 0) {
      addIssue(`system2_configured_model_missing id=${generation.generationId}`)
    }
  }

  const configuredAuthorities = new Set(generations
    .filter((generation) => typeof generation.system2ConfiguredProvider === 'string' && typeof generation.system2ConfiguredModel === 'string')
    .map((generation) => `${generation.system2ConfiguredProvider}\u0000${generation.system2ConfiguredModel}`))
  if (configuredAuthorities.size > 1) addIssue(`system2_authority_changed_across_generations count=${configuredAuthorities.size}`)

  for (const decision of decisions) {
    const id = decision.generationId
    if (typeof id !== 'string' || id.length === 0) {
      addIssue('system2_decision_generation_id_missing')
      continue
    }
    const generation = generationById.get(id)
    if (generation === undefined) {
      addIssue(`system2_decision_generation_unjoined id=${id}`)
      continue
    }
    if (typeof decision.sourceSha !== 'string' || !SOURCE_SHA_RE.test(decision.sourceSha)) {
      addIssue(`system2_decision_source_sha_missing_or_invalid id=${id}`)
    } else if (decision.sourceSha.toLowerCase() !== String(generation.sourceSha ?? '').toLowerCase()) {
      addIssue(`system2_decision_source_sha_mismatch id=${id}`)
    }
    if (typeof decision.buildHash !== 'string' || !BUILD_HASH_RE.test(decision.buildHash)) {
      addIssue(`system2_decision_build_hash_missing_or_invalid id=${id}`)
    } else if (decision.buildHash.toLowerCase() !== String(generation.buildHash ?? '').toLowerCase()) {
      addIssue(`system2_decision_build_hash_mismatch id=${id}`)
    }
    if (decision.configuredProvider !== generation.system2ConfiguredProvider || decision.configuredModel !== generation.system2ConfiguredModel) {
      addIssue(`system2_decision_config_mismatch id=${id}`)
    }
    if (!isModelSystem2Decision(decision)) addIssue(`system2_decision_non_model_authority id=${id}`)

    const inputIndex = inputs.findIndex((input, index) =>
      !usedInputs.has(index) && input.tsMs >= generation.tsMs && input.tsMs <= decision.tsMs &&
      input.generationId === decision.generationId &&
      input.sourceSha === decision.sourceSha && input.buildHash === decision.buildHash &&
      input.provider === decision.provider && input.model === decision.model &&
      input.configuredProvider === decision.configuredProvider && input.configuredModel === decision.configuredModel &&
      input.trigger === decision.trigger,
    )
    if (inputIndex < 0) addIssue(`system2_decision_input_unjoined id=${id}`)
    else usedInputs.add(inputIndex)
  }

  const decisionAuthorities = new Set(decisions
    .filter((decision) => isModelSystem2Decision(decision))
    .map((decision) => `${decision.provider}\u0000${decision.model}`))
  if (decisionAuthorities.size > 1) addIssue(`system2_effective_authority_changed_across_generations count=${decisionAuthorities.size}`)
  if (decisions.length === 0) addIssue('system2_model_decision_missing')

  const onlyConfigured = [...configuredAuthorities][0] ?? null
  const [configuredProvider, configuredModel] = onlyConfigured === null ? [null, null] : onlyConfigured.split('\u0000')
  const onlyEffective = [...decisionAuthorities][0] ?? null
  const [effectiveProvider, effectiveModel] = onlyEffective === null ? [null, null] : onlyEffective.split('\u0000')
  return {
    status: issues.length === 0 ? 'verified' : 'unknown',
    reason: issues.length === 0 ? null : issues.join('; '),
    issues,
    generationCount: generations.length,
    decisionCount: decisions.length,
    configuredProvider,
    configuredModel,
    effectiveProvider,
    effectiveModel,
    sourceSha: typeof bootSourceSha === 'string' && SOURCE_SHA_RE.test(bootSourceSha) ? bootSourceSha.toLowerCase() : null,
    generationIds: generations.map((generation) => generation.generationId).filter((id) => typeof id === 'string'),
  }
}

/**
 * Count decision sources inside R's window. Decisions carry no runId, so the
 * bracketed window IS the run binding; an unbounded window is refused upstream.
 */
export async function countDecisionSources(decisionsPath, startMs, endMs) {
  if (!existsSync(decisionsPath)) return null
  let jevCount = 0
  let fallbackCount = 0
  let otherCount = 0
  let unclassifiableCount = 0
  let firstJevTs = null
  let lastJevTs = null
  const rl = createInterface({ input: createReadStream(decisionsPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!/\"record\"\s*:\s*\"decision\"/.test(line)) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      const rawTs = /\"ts\"\s*:\s*\"([^\"]+)\"/.exec(line)?.[1] ?? null
      const tsMs = rawTs === null ? Number.NaN : Date.parse(rawTs)
      // A malformed row without a trustworthy timestamp cannot be ruled out of
      // the requested run's bracketed window. Keep the uncertainty explicit;
      // silently dropping it could hide a fallback decision in that run.
      if (!Number.isFinite(tsMs) || (tsMs >= startMs && tsMs <= endMs)) {
        unclassifiableCount += 1
      }
      continue
    }
    if (record?.record !== 'decision') continue
    const tsMs = typeof record.ts === 'string' ? Date.parse(record.ts) : Number.NaN
    if (!Number.isFinite(tsMs)) {
      unclassifiableCount += 1
      continue
    }
    if (tsMs < startMs || tsMs > endMs) continue
    if (record.source === 'jev') {
      jevCount += 1
      if (firstJevTs === null) firstJevTs = record.ts
      lastJevTs = record.ts
    } else if (record.source === 'fallback') {
      fallbackCount += 1
    } else if (KNOWN_NON_MODEL_DECISION_SOURCES.has(record.source)) {
      otherCount += 1
    } else {
      otherCount += 1
      unclassifiableCount += 1
    }
  }
  return { jevCount, fallbackCount, otherCount, unclassifiableCount, firstJevTs, lastJevTs }
}

/**
 * Load and run-bind the policy evidence for `runId`. `socket` is the optional
 * resident `report` status ({ runId, policyKind, policyModel }); it is the
 * strongest binding because it is keyed by the live runId. runner.out is the
 * file fallback, usable only inside R's bracketed window.
 */
export async function loadPolicyEvidence({
  runId,
  socket = null,
  decisionsPath = DEFAULT_DECISIONS,
  runnerOutPath = DEFAULT_RUNNER_OUT,
  now = () => Date.now(),
  scan = scanRunnerOut,
} = {}) {
  if (runId === null || !RUN_ID_RE.test(String(runId))) {
    return { decisions: null, generation: null, reason: 'exact_run_scope_required' }
  }
  if (!existsSync(runnerOutPath)) {
    return { decisions: null, generation: null, reason: 'runner_out_unreadable' }
  }
  let evidence
  try {
    evidence = await scan(runnerOutPath)
  } catch {
    return { decisions: null, generation: null, reason: 'runner_out_unreadable' }
  }
  const live = socket !== null && socket.runId === runId
  const window = resolveRunWindow(evidence.boots, evidence.releases, runId, { live, nowMs: now() })
  if (window === null) return { decisions: null, generation: null, reason: 'run_boot_boundary_missing' }
  if (!window.bounded) return { decisions: null, generation: null, reason: 'run_window_unbounded' }

  const bootRecord = evidence.boots.find((entry) => entry.runId === runId && entry.tsMs === window.startMs) ?? null
  const bootSourceSha = bootRecord?.sourceSha ?? null
  const inWindow = evidence.generations.filter((g) => g.tsMs >= window.startMs && g.tsMs <= window.endMs)
  const withPolicy = inWindow.filter((g) => typeof g.policyKind === 'string' && g.policyKind.length > 0)
  const chosen = withPolicy.at(-1) ?? inWindow.at(-1) ?? null
  let generation = null
  if (live && typeof socket.policyKind === 'string' && typeof socket.policyModel === 'string') {
    generation = {
      runId,
      source: 'socket_report',
      policyKind: socket.policyKind,
      policyModel: socket.policyModel,
      plannerMode: chosen?.plannerMode ?? null,
      deterministicFallbackEnabled: chosen?.deterministicFallbackEnabled ?? null,
      generationId: chosen?.generationId ?? null,
      sourceSha: chosen?.sourceSha ?? null,
      buildHash: chosen?.buildHash ?? null,
      system2ConfiguredProvider: chosen?.system2ConfiguredProvider ?? null,
      system2ConfiguredModel: chosen?.system2ConfiguredModel ?? null,
      tsMs: now(),
    }
  } else if (chosen !== null) {
    generation = {
      runId,
      source: runnerOutPath,
      policyKind: chosen.policyKind,
      policyModel: chosen.policyModel,
      plannerMode: chosen.plannerMode ?? null,
      deterministicFallbackEnabled: chosen.deterministicFallbackEnabled ?? null,
      generationId: chosen.generationId ?? null,
      sourceSha: chosen.sourceSha ?? null,
      buildHash: chosen.buildHash ?? null,
      system2ConfiguredProvider: chosen.system2ConfiguredProvider ?? null,
      system2ConfiguredModel: chosen.system2ConfiguredModel ?? null,
      tsMs: chosen.tsMs,
    }
  }

  const system2InWindow = (evidence.system2Decisions ?? []).filter(
    (entry) => entry.tsMs >= window.startMs && entry.tsMs <= window.endMs,
  )
  const system2InputsInWindow = (evidence.system2Inputs ?? []).filter(
    (entry) => entry.tsMs >= window.startMs && entry.tsMs <= window.endMs,
  )
  const system2Lineage = buildSystem2GenerationLineage({
    generations: inWindow,
    inputs: system2InputsInWindow,
    decisions: system2InWindow,
    bootSourceSha,
  })
  const modelDecisions = system2InWindow.filter(isModelSystem2Decision)
  const system2 = {
    runId,
    source: runnerOutPath,
    count: system2InWindow.length,
    modelCount: modelDecisions.length,
    ineligibleModelCount: system2InWindow.length - modelDecisions.length,
    portalPlanCount: modelDecisions.filter((entry) => entry.portalPlan === true).length,
    identityStatus: system2Lineage.status,
    identityReason: system2Lineage.reason,
    identityIssues: system2Lineage.issues,
    effectiveProvider: system2Lineage.effectiveProvider,
    effectiveModel: system2Lineage.effectiveModel,
    configuredProvider: system2Lineage.configuredProvider,
    configuredModel: system2Lineage.configuredModel,
    sourceSha: system2Lineage.sourceSha,
    generationIds: system2Lineage.generationIds,
    generationCount: system2Lineage.generationCount,
    inputCount: system2InputsInWindow.length,
    inputs: system2InputsInWindow,
    decisions: system2InWindow,
  }

  const counts = await countDecisionSources(decisionsPath, window.startMs, window.endMs)
  const decisions =
    counts === null
      ? null
      : { runId, source: decisionsPath, window: { startMs: window.startMs, endMs: window.endMs }, ...counts }

  return { decisions, generation, system2, reason: null, window }
}

function outcome(code, status, reason, facts) {
  return { code, status, reason, facts }
}

/**
 * Pure verdict for the real-policy requirement. Returns VERIFIED (code 0) only
 * when every fact is present and bound to expectedRunId; every other path is
 * UNKNOWN (code 2) and never PASS.
 */
export function evaluatePolicyEvidence({ expectedRunId = null, decisions = null, generation = null } = {}) {
  const facts = {
    expectedRunId,
    requiredPolicyKind: REQUIRED_POLICY_KIND,
    requiredPolicyModel: REQUIRED_POLICY_MODEL,
    decisionsRunId: decisions?.runId ?? null,
    decisionsSource: decisions?.source ?? null,
    jevDecisions: Number.isFinite(decisions?.jevCount) ? decisions.jevCount : null,
    fallbackDecisions: Number.isFinite(decisions?.fallbackCount) ? decisions.fallbackCount : null,
    otherDecisions: Number.isFinite(decisions?.otherCount) ? decisions.otherCount : null,
    unclassifiableDecisionRecords: Number.isFinite(decisions?.unclassifiableCount) ? decisions.unclassifiableCount : null,
    firstJevTs: decisions?.firstJevTs ?? null,
    lastJevTs: decisions?.lastJevTs ?? null,
    generationRunId: generation?.runId ?? null,
    generationSource: generation?.source ?? null,
    policyKind: generation?.policyKind ?? null,
    policyModel: generation?.policyModel ?? null,
  }

  if (expectedRunId === null || !RUN_ID_RE.test(String(expectedRunId))) {
    return outcome(2, 'UNKNOWN', 'exact_run_scope_required', facts)
  }
  if (decisions === null || typeof decisions !== 'object') {
    return outcome(2, 'UNKNOWN', 'decisions_evidence_unavailable', facts)
  }
  if (decisions.runId !== expectedRunId) {
    return outcome(2, 'UNKNOWN', `decisions_evidence_run_mismatch expected=${expectedRunId} observed=${decisions.runId ?? 'unknown'}`, facts)
  }
  if (!Number.isInteger(decisions.unclassifiableCount) || decisions.unclassifiableCount < 0) {
    return outcome(2, 'UNKNOWN', 'decision_source_completeness_unavailable', facts)
  }
  if (decisions.unclassifiableCount > 0) {
    return outcome(2, 'UNKNOWN', `decision_records_unclassifiable count=${decisions.unclassifiableCount}`, facts)
  }
  // Each source class must be explicitly counted. Missing fallback/other
  // counts cannot be interpreted as zero; otherwise partial evidence could
  // claim an all-Jev run while hiding a non-model decision.
  const sourceCounts = [decisions.jevCount, decisions.fallbackCount, decisions.otherCount]
  if (!sourceCounts.every((count) => Number.isInteger(count) && count >= 0)) {
    return outcome(2, 'UNKNOWN', 'decision_source_counts_unavailable_or_invalid', facts)
  }
  if (!Number.isFinite(decisions.jevCount) || decisions.jevCount < 1) {
    const reason = Number.isFinite(decisions.fallbackCount) && decisions.fallbackCount > 0
      ? 'decisions_fallback_only'
      : 'no_jev_decisions'
    return outcome(2, 'UNKNOWN', reason, facts)
  }
  if (Number.isFinite(decisions.fallbackCount) && decisions.fallbackCount > 0) {
    return outcome(2, 'UNKNOWN', 'fallback_decisions_present', facts)
  }
  if (decisions.otherCount > 0) {
    return outcome(2, 'UNKNOWN', `unrecognized_decision_sources_present count=${decisions.otherCount}`, facts)
  }
  if (generation === null || typeof generation !== 'object') {
    return outcome(2, 'UNKNOWN', 'generation_status_unavailable', facts)
  }
  if (generation.runId !== expectedRunId) {
    return outcome(2, 'UNKNOWN', `generation_run_mismatch expected=${expectedRunId} observed=${generation.runId ?? 'unknown'}`, facts)
  }
  if (generation.policyKind !== REQUIRED_POLICY_KIND) {
    return outcome(2, 'UNKNOWN', `policy_kind_not_typesafe observed=${generation.policyKind ?? 'unknown'}`, facts)
  }
  if (generation.policyModel !== REQUIRED_POLICY_MODEL) {
    return outcome(2, 'UNKNOWN', `policy_model_not_typesafe observed=${generation.policyModel ?? 'unknown'}`, facts)
  }
  return outcome(0, 'VERIFIED', 'real_policy_evidence_verified', facts)
}

/** Current M2 additionally requires real long-horizon System2 authority. */
export function evaluateCurrentM2AuthorityEvidence({ expectedRunId = null, decisions = null, generation = null, system2 = null } = {}) {
  const base = evaluatePolicyEvidence({ expectedRunId, decisions, generation })
  const facts = {
    ...base.facts,
    plannerMode: generation?.plannerMode ?? null,
    deterministicFallbackEnabled: generation?.deterministicFallbackEnabled ?? null,
    system2RunId: system2?.runId ?? null,
    system2Source: system2?.source ?? null,
    system2Decisions: Number.isFinite(system2?.count) ? system2.count : null,
    system2ModelDecisions: Number.isFinite(system2?.modelCount) ? system2.modelCount : null,
    system2IdentityStatus: system2?.identityStatus ?? null,
    system2IdentityReason: system2?.identityReason ?? null,
    system2EffectiveProvider: system2?.effectiveProvider ?? null,
    system2EffectiveModel: system2?.effectiveModel ?? null,
    system2ConfiguredProvider: system2?.configuredProvider ?? null,
    system2ConfiguredModel: system2?.configuredModel ?? null,
    system2PortalPlans: Number.isFinite(system2?.portalPlanCount) ? system2.portalPlanCount : null,
  }
  if (base.code !== 0) return outcome(base.code, base.status, base.reason, facts)
  if (generation?.plannerMode !== 'llm') {
    return outcome(2, 'UNKNOWN', `planner_not_llm observed=${generation?.plannerMode ?? 'unknown'}`, facts)
  }
  if (generation?.deterministicFallbackEnabled !== false) {
    return outcome(2, 'UNKNOWN', `deterministic_fallback_not_disabled observed=${String(generation?.deterministicFallbackEnabled ?? 'unknown')}`, facts)
  }
  if (system2 === null || typeof system2 !== 'object') {
    return outcome(2, 'UNKNOWN', 'system2_evidence_unavailable', facts)
  }
  if (system2.runId !== expectedRunId) {
    return outcome(2, 'UNKNOWN', `system2_evidence_run_mismatch expected=${expectedRunId} observed=${system2.runId ?? 'unknown'}`, facts)
  }
  if (system2.identityStatus !== 'verified') {
    return outcome(2, 'UNKNOWN', `system2_generation_identity_unverified reason=${system2.identityReason ?? 'missing'}`, facts)
  }
  if (!Number.isFinite(system2.modelCount) || system2.modelCount < 1) {
    return outcome(2, 'UNKNOWN', 'no_model_system2_authority_decision', facts)
  }
  if (!Number.isFinite(system2.portalPlanCount) || system2.portalPlanCount < 1) {
    return outcome(2, 'UNKNOWN', 'no_system2_portal_plan_decision', facts)
  }
  return outcome(0, 'VERIFIED', 'current_m2_authority_verified', facts)
}
