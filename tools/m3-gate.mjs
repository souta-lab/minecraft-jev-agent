#!/usr/bin/env bun
// m3-gate: run-scoped PASS/FAIL/UNKNOWN gate for the CURRENT M3 contract
// (MILESTONE-CONTRACT.json M3 "12 Eyes of Ender").
//
// M3's terminal predicate is ONE inventory threshold: `ender_eye >= 12`. The
// item id is `ender_eye` (display "Eye of Ender"); `eye_of_ender` is the thrown
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
//     on a record / runId / sourceSha mismatch. It may only UPGRADE a condition to
//     PASS when a predicate is truly observed as satisfied, and the gate also
//     emits the full `m3_predicate <id>: PASS|FAIL|UNKNOWN at=… source=…` section;
//   * the resident log, bracketed by its BOOT runId boundary: INVENTORY /
//     MILESTONE lines carry the live counts, and `dimension=` lines are
//     reported as an intermediate fact.
//
// `--run <runId>` (or M3_RUN_ID) is MANDATORY. Evidence from another run is
// never attributed to R, so a run's inventory can never be combined with
// another run's. Missing/unbound evidence is UNKNOWN and NEVER PASS.
//
// FAIL is reserved for a known capability failure: R's own evidence proves every
// crafting input for 12 eyes existed at one instant (ender_pearl>=12 AND
// (blaze_powder>=12 OR blaze_rod>=7)) while the terminal ender_eye count stayed
// below 12. A run merely short of inputs is UNKNOWN, not FAIL.
//
// Exit: 0 = PASS, 1 = FAIL (materials complete, eyes short), 2 = UNKNOWN.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
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

/** Re-exported so the live-gate wrapper shares the exact same run-id shape rule. */
export { RUN_ID_RE }
/** The canonical predicate thresholds live with the predicate evaluator. */
export { BLAZE_POWDER, BLAZE_POWDER_REQUIRED, BLAZE_ROD, BLAZE_ROD_REQUIRED, ENDER_EYE, ENDER_EYE_REQUIRED, ENDER_PEARL, ENDER_PEARL_REQUIRED }

export const M3_RUN_RESULT = 'M3_RUN_RESULT'
export const M3_RUN_GATE = 'M3_RUN_GATE'

/** The conditions M3 must prove; inventory facts beyond these are diagnostics. */
export const M3_REQUIRED_CONDITIONS = Object.freeze(['ender_eye_ready', 'model_authority', 'nether_reached'])

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
 * The M3 inventory facts from R's samples. `ready` is the contract predicate;
 * `materialInputsComplete` is true only when ONE sample held every crafting
 * input for 12 eyes, so a FAIL can never be assembled from two instants.
 */
export function evaluateEnderEyes(samples) {
  const list = Array.isArray(samples) ? samples : []
  const enderEye = maxObserved(list, ENDER_EYE)
  const enderPearl = maxObserved(list, ENDER_PEARL)
  const blazeRod = maxObserved(list, BLAZE_ROD)
  const blazePowder = maxObserved(list, BLAZE_POWDER)
  const ready = enderEye >= ENDER_EYE_REQUIRED
  const materialInputsComplete = list.some(
    (counts) =>
      (counts?.[ENDER_PEARL] ?? 0) >= ENDER_PEARL_REQUIRED &&
      ((counts?.[BLAZE_POWDER] ?? 0) >= BLAZE_POWDER_REQUIRED || (counts?.[BLAZE_ROD] ?? 0) >= BLAZE_ROD_REQUIRED),
  )
  return { ready, enderEye, enderPearl, blazeRod, blazePowder, materialInputsComplete }
}

// ---------------------------------------------------------------------------
// model authority (mirrors the M2 gate minus the M2-only System2 requirement)
// ---------------------------------------------------------------------------

/**
 * M3 authority verdict. Reuses the M2 policy evidence evaluator (jev decisions +
 * typesafe policy/model) and adds the planner/fallback facts. Every non-proof
 * path is UNKNOWN (code 2); PASS requires code 0.
 */
export function evaluateM3AuthorityEvidence({ expectedRunId = null, decisions = null, generation = null } = {}) {
  const base = evaluatePolicyEvidence({ expectedRunId, decisions, generation })
  const facts = {
    ...base.facts,
    plannerMode: generation?.plannerMode ?? null,
    deterministicFallbackEnabled: generation?.deterministicFallbackEnabled ?? null,
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
  return { code: 0, status: 'VERIFIED', reason: 'm3_model_authority_verified', facts }
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

function unknownConditions() {
  return { ender_eye_ready: 'UNKNOWN', model_authority: 'UNKNOWN' }
}

function verdict({ status, code, reason, runId, conditions, evidence = null, sources = null, facts = null }) {
  return { id: 'M3', status, code, reason, runId, conditions, evidence, sources, facts }
}

/**
 * Pure run-scoped M3 verdict. PASS (0) only when `ender_eye>=12` AND the full
 * model-authority proof are bound to R. A materials-complete run whose eyes are
 * short is FAIL (1). Everything else is UNKNOWN (2) and can never be PASS.
 */
export function evaluateM3Gate({ expectedRunId = null, evidence = null, policy = null, dimensions = null, milestonePredicates = null, sourceSha = null } = {}) {
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
  if (typeof evidence.runId === 'string' && evidence.runId !== expectedRunId) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `evidence_run_mismatch expected=${expectedRunId} observed=${evidence.runId}`,
      runId: expectedRunId,
      conditions: unknownConditions(),
    })
  }

  const sources = Array.isArray(evidence.sources) ? evidence.sources : []
  const samples = sources.flatMap((source) => (Array.isArray(source.inventorySamples) ? source.inventorySamples : []))
  const eyes = evaluateEnderEyes(samples)
  const observedDimensions = Array.isArray(dimensions)
    ? dimensions
    : sources.flatMap((source) => (Array.isArray(source.dimensionObservations) ? source.dimensionObservations : []))
  const dimension = observedDimensions.length > 0 ? observedDimensions.at(-1) : null
  const authorityPass = policy?.code === 0

  // FIRST-CLASS milestone predicate evidence. When the caller already read the
  // run-scoped predicate section (resident observe-loop observations + log +
  // snapshot) it is used as-is; otherwise it is derived from the SAME run-scoped
  // sources this gate judges. A predicate may only ever UPGRADE a condition to
  // PASS when it was truly observed (`satisfied === true`); `false`/UNKNOWN never
  // manufacture a PASS, and the FAIL path below is driven by the inventory facts.
  const predicateSection =
    milestonePredicates ??
    deriveMilestonePredicates({
      runId: expectedRunId,
      runSourceSha: sourceSha ?? null,
      inventorySamples: samples.map((counts) => ({ counts, source: 'log' })),
      dimensionObservations: observedDimensions.map((entry) => ({
        dimension: typeof entry === 'string' ? entry : entry?.dimension,
        source: typeof entry === 'object' && entry?.source ? entry.source : 'log',
      })),
      portalEvents: sources.flatMap((source) => (Array.isArray(source.portalEvents) ? source.portalEvents.map((event) => ({ ...event, source: source.name })) : [])),
    })
  const predicateTrue = (id) => predicateSection.predicates.some((predicate) => predicate.id === id && predicate.satisfied === true)
  const eyesReady = eyes.ready || predicateTrue('ender_eyes')
  const materialsFail = !eyesReady && eyes.materialInputsComplete

  // M3 is "reach the Nether and prove twelve eyes", so Nether arrival is a REQUIRED condition,
  // not a diagnostic: without it a run could claim M3 from the eyes alone while never having
  // left the overworld. UNKNOWN (never FAIL) when the run simply has no Nether observation yet -
  // the absence of a transition is not evidence of a failed one.
  const netherObserved =
    predicateTrue('nether_reached') ||
    observedDimensions.some((entry) => {
      const value = typeof entry === 'string' ? entry : String(entry?.dimension ?? '')
      return value === 'minecraft:the_nether' || value === 'the_nether'
    })
  const conditions = {
    ender_eye_ready: eyesReady ? 'PASS' : materialsFail ? 'FAIL' : 'UNKNOWN',
    model_authority: authorityPass ? 'PASS' : 'UNKNOWN',
    nether_reached: netherObserved ? 'PASS' : 'UNKNOWN',
  }
  const perSource = sources.map((source) => ({
    name: source.name,
    path: source.path,
    inventorySamples: Array.isArray(source.inventorySamples) ? source.inventorySamples.length : 0,
    dimensionObservations: Array.isArray(source.dimensionObservations) ? source.dimensionObservations : [],
  }))
  const facts = {
    eyes,
    dimension,
    dimensions: [...new Set(observedDimensions.map((entry) => (typeof entry === 'string' ? entry : entry?.dimension ?? null)))],
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
  let rawPolicy = policyEvidence
  if (scoped && rawPolicy === null) {
    const socketBinding = policySocket === undefined ? await readPolicySocketBinding(controlSocketPath) : policySocket
    // Same run-binding fallback as the M2 gate: the resident is normally started detached,
    // so `runner.out` often does not exist while `buddy.log` carries the identical
    // `[ISO] BOOT ... runId=...` lines. Without this the acceptance verdict degrades to
    // `decisions_evidence_unavailable`, which says nothing about the run.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const runnerOutForScan =
      runnerOutPath !== null && runnerOutPath !== undefined && existsSync(runnerOutPath)
        ? runnerOutPath
        : join(repoRoot, 'buddy-driver', 'buddy.log')
    rawPolicy = await loadPolicy({
      runId: expectedRunId,
      socket: socketBinding?.runId === expectedRunId ? socketBinding : null,
      decisionsPath,
      runnerOutPath: runnerOutForScan,
    })
  }
  const policy = scoped
    ? evaluateM3AuthorityEvidence({
        expectedRunId,
        decisions: rawPolicy?.decisions ?? null,
        generation: rawPolicy?.generation ?? null,
      })
    : null
  // The resident produces a run-scoped predicate observation file in the same
  // directory as the M2 snapshot. It is used when present (live observations),
  // and the gate otherwise derives the section from its own run-scoped evidence.
  const hostObservation = scoped ? readMilestonePredicateEvidence(expectedRunId, { dir: snapshotDir }) : null
  const milestonePredicates =
    scoped && hostObservation !== null && hostObservation.present
      ? deriveMilestonePredicates({
          runId: expectedRunId,
          runSourceSha: sourceSha ?? null,
          inventorySamples: (evidence?.sources ?? []).flatMap((source) =>
            (Array.isArray(source.inventorySamples) ? source.inventorySamples : []).map((counts) => ({ counts, source: 'log' })),
          ),
          dimensionObservations: (evidence?.sources ?? []).flatMap((source) =>
            (Array.isArray(source.dimensionObservations) ? source.dimensionObservations : []).map((dimension) => ({ dimension, source: 'log' })),
          ),
          portalEvents: (evidence?.sources ?? []).flatMap((source) =>
            (Array.isArray(source.portalEvents) ? source.portalEvents : []).map((event) => ({ ...event, source: source.name })),
          ),
          hostObservation,
        })
      : null
  const result = evaluateM3Gate({ expectedRunId, evidence, policy, milestonePredicates, sourceSha })
  if (typeof onResult === 'function') onResult(result)

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

  write(`${M3_RUN_GATE} — ${stamp}`)
  write(`expectedRunId: ${expectedRunId ?? 'none'}`)
  if (evidence !== null) {
    const sourceNames = (evidence.sources ?? []).map((source) => source.name).join(',')
    write(`m3_evidence: ${evidence.status} sources=${sourceNames || 'none'}${evidence.reason ? ` reason=${evidence.reason}` : ''}`)
  }
  for (const condition of M3_REQUIRED_CONDITIONS) write(`${condition}: ${result.conditions[condition]}`)
  if (policy !== null) write(`policy: ${policy.status} reason=${policy.reason}`)
  if (result.facts !== null) {
    write(
      `m3_facts: ender_pearl=${result.facts.eyes.enderPearl} blaze_rod=${result.facts.eyes.blazeRod} ` +
        `blaze_powder=${result.facts.eyes.blazePowder} ender_eye=${result.facts.eyes.enderEye} ` +
        `dimension=${result.facts.dimension ?? 'unknown'} dimensions=${result.facts.dimensions.join(',') || 'none'}`,
    )
    const section = result.facts.milestonePredicates
    if (section !== undefined && section !== null) {
      write(
        `m3_predicates: runId=${section.runId ?? 'none'} sourceSha=${section.sourceSha ?? 'unknown'} ` +
          `sources=${section.observationSources.join(',') || 'none'} ` +
          `observed=${section.predicates.filter((predicate) => predicate.satisfied !== null).length}/${section.predicates.length} ` +
          `missing=${section.missing.join(',') || 'none'}`,
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
      `ender_eye=${result.conditions.ender_eye_ready} authority=${result.conditions.model_authority}`,
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
