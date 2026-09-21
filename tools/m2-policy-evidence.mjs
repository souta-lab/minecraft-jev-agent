#!/usr/bin/env node
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
  return {
    policyKind: kind,
    policyModel: model,
    plannerMode,
    deterministicFallbackEnabled: fallback === null ? null : fallback === 'true',
  }
}

export function parseSystem2AuthorityLine(line) {
  if (!/\bSYSTEM2_AUTHORITY_DECISION\b/.test(line)) return null
  const provider = /\bprovider=(\S+)/.exec(line)?.[1] ?? null
  const model = /\bmodel=(\S+)/.exec(line)?.[1] ?? null
  const chosen = /\bchosen=(\S+)/.exec(line)?.[1] ?? null
  const portalPlan = chosen === 'front_nether_portal' || /\bgoals=\[[^\n]*portal/i.test(line)
  return { provider, model, chosen, portalPlan }
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
  const system2Decisions = []
  const rl = createInterface({ input: createReadStream(runnerOutPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const tsMs = extractTimestampMs(line)
    if (isBootLine(line)) {
      const runId = extractRunId(line)
      if (runId !== null && tsMs !== null) boots.push({ runId, tsMs })
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
    if (tsMs !== null) {
      const system2 = parseSystem2AuthorityLine(line)
      if (system2 !== null) system2Decisions.push({ tsMs, ...system2 })
    }
  }
  return { boots, releases, generations, system2Decisions }
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

/**
 * Count decision sources inside R's window. Decisions carry no runId, so the
 * bracketed window IS the run binding; an unbounded window is refused upstream.
 */
export async function countDecisionSources(decisionsPath, startMs, endMs) {
  if (!existsSync(decisionsPath)) return null
  let jevCount = 0
  let fallbackCount = 0
  let otherCount = 0
  let firstJevTs = null
  let lastJevTs = null
  const rl = createInterface({ input: createReadStream(decisionsPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"record":"decision"')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.record !== 'decision') continue
    const tsMs = typeof record.ts === 'string' ? Date.parse(record.ts) : Number.NaN
    if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs > endMs) continue
    if (record.source === 'jev') {
      jevCount += 1
      if (firstJevTs === null) firstJevTs = record.ts
      lastJevTs = record.ts
    } else if (record.source === 'fallback') {
      fallbackCount += 1
    } else {
      otherCount += 1
    }
  }
  return { jevCount, fallbackCount, otherCount, firstJevTs, lastJevTs }
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
      tsMs: chosen.tsMs,
    }
  }

  const system2InWindow = (evidence.system2Decisions ?? []).filter(
    (entry) => entry.tsMs >= window.startMs && entry.tsMs <= window.endMs,
  )
  const system2 = {
    runId,
    source: runnerOutPath,
    count: system2InWindow.length,
    modelCount: system2InWindow.filter(
      (entry) => typeof entry.provider === 'string' && entry.provider.length > 0 &&
        entry.provider !== 'fallback' && entry.provider !== 'deterministic' &&
        typeof entry.model === 'string' && entry.model.length > 0 && !/deterministic|fallback/i.test(entry.model),
    ).length,
    portalPlanCount: system2InWindow.filter((entry) => entry.portalPlan === true).length,
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
  if (!Number.isFinite(decisions.jevCount) || decisions.jevCount < 1) {
    const reason = Number.isFinite(decisions.fallbackCount) && decisions.fallbackCount > 0
      ? 'decisions_fallback_only'
      : 'no_jev_decisions'
    return outcome(2, 'UNKNOWN', reason, facts)
  }
  if (Number.isFinite(decisions.fallbackCount) && decisions.fallbackCount > 0) {
    return outcome(2, 'UNKNOWN', 'fallback_decisions_present', facts)
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
  if (!Number.isFinite(system2.modelCount) || system2.modelCount < 1) {
    return outcome(2, 'UNKNOWN', 'no_model_system2_authority_decision', facts)
  }
  if (!Number.isFinite(system2.portalPlanCount) || system2.portalPlanCount < 1) {
    return outcome(2, 'UNKNOWN', 'no_system2_portal_plan_decision', facts)
  }
  return outcome(0, 'VERIFIED', 'current_m2_authority_verified', facts)
}
