#!/usr/bin/env bun
// tools/replay.mjs — deterministic offline A/B replay harness (issue #23).
//
// Reads a window of `logs/jev/decisions.jsonl` (plus optional `run.jsonl` for
// CAUSAL/verified outcomes, `jev-calls.jsonl`, `mercury-calls.jsonl`) and
// recomputes, without any network/LLM/server access, what each policy would
// have decided for every recorded state:
//
//   Policy A — the current recorded policy: the action the controller actually
//              took (`chosenAction`) for that state.
//   Policy B — "beta shadow as authority": abandon/replace the plan whenever
//              the recorded `abandon_option` probability crosses its named
//              threshold (`beta >= threshold`). Abandonment is represented as
//              the grounded `ESCALATE` candidate (hand control to System 2).
//
// The report contains the A/B agreement rate, the divergence list (decision
// ids + differing action), and a summary of the CAUSAL `verified=` outcomes
// observed for the divergent chains. Everything is pure data replay.
//
// Usage:
//   bun tools/replay.mjs [--decisions <path>] [--run <path>]
//                         [--jev-calls <path>] [--mercury-calls <path>]
//                         [--last N] [--from-tick N] [--to-tick N]
//                         [--threshold 0.5] [--max-divergences 50]
//                         [--json] [--out <path>]
//
// Exit codes: 0 report produced, 1 bad usage / unreadable input.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Bump when the replay report shape changes in a non-additive way. */
export const SCHEMA_VERSION = 1

/** Fallback beta threshold when a record carries no named threshold. */
export const DEFAULT_THRESHOLD = 0.5

/**
 * Action the β-authority policy emits when it wants to abandon the current
 * option and replan. Matches the grounded `ESCALATE` candidate the controller
 * already uses to hand control to System 2.
 */
export const ABANDON_DECISION = 'ESCALATE'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')
export const DEFAULT_DECISIONS = path.join(REPO_ROOT, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl')
export const DEFAULT_RUN = path.join(REPO_ROOT, 'buddy-driver', 'logs', 'jev', 'run.jsonl')
export const DEFAULT_JEV_CALLS = path.join(REPO_ROOT, 'buddy-driver', 'logs', 'jev', 'jev-calls.jsonl')
export const DEFAULT_MERCURY_CALLS = path.join(REPO_ROOT, 'buddy-driver', 'logs', 'jev', 'mercury-calls.jsonl')

// ---------------------------------------------------------------------------
// Record readers (streaming: the live JSONL files can exceed the string limit)
// ---------------------------------------------------------------------------

/**
 * Stream a JSONL file, invoking `onRecord` for every parsed object. Malformed
 * lines are counted, never thrown.
 * @param {string} file
 * @param {(record: Record<string, unknown>) => void} onRecord
 * @returns {Promise<{ total: number, malformed: number }>}
 */
export async function streamJsonl(file, onRecord) {
  let total = 0
  let malformed = 0
  const input = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue
      total++
      let record
      try {
        record = JSON.parse(line)
      } catch {
        malformed++
        continue
      }
      onRecord(record)
    }
  } finally {
    rl.close()
    input.destroy()
  }
  return { total, malformed }
}

/**
 * Read a window of decision records. `last` keeps only the final N matching
 * records (ring buffer) so a live, growing log can be sampled deterministically.
 * @param {string} file
 * @param {{ last?: number, fromTick?: number|null, toTick?: number|null }} [options]
 */
export async function loadDecisions(file, options = {}) {
  const { last = 0, fromTick = null, toTick = null } = options
  const ring = last > 0 ? [] : []
  let matched = 0
  const { total, malformed } = await streamJsonl(file, (record) => {
    if (fromTick !== null && !(typeof record.tick === 'number' && record.tick >= fromTick)) return
    if (toTick !== null && !(typeof record.tick === 'number' && record.tick <= toTick)) return
    matched++
    if (last > 0) {
      ring.push(record)
      if (ring.length > last) ring.shift()
    } else {
      ring.push(record)
    }
  })
  return { records: ring, total, malformed, matched }
}

/**
 * Index CAUSAL events by `chainId`. Optionally restrict to a set of chain ids.
 * @param {string} file
 * @param {{ chainIds?: Set<string>|null }} [options]
 */
export async function loadCausal(file, options = {}) {
  const chainIds = options.chainIds ?? null
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const byChain = new Map()
  const { total, malformed } = await streamJsonl(file, (record) => {
    const detail = record.detail
    if (!detail || detail.record !== 'causal') return
    const chainId = typeof detail.chainId === 'string' ? detail.chainId : null
    if (chainId === null) return
    if (chainIds !== null && !chainIds.has(chainId)) return
    const list = byChain.get(chainId)
    if (list) list.push(detail)
    else byChain.set(chainId, [detail])
  })
  return { byChain, total, malformed }
}

/**
 * Index Jev call traces by `callId`, keeping only latency/retry/error fields.
 * @param {string} file
 * @param {{ callIds?: Set<string>|null }} [options]
 */
export async function loadJevCalls(file, options = {}) {
  const callIds = options.callIds ?? null
  /** @type {Map<string, Record<string, unknown>>} */
  const byCallId = new Map()
  const { total, malformed } = await streamJsonl(file, (record) => {
    const callId = typeof record.callId === 'string' ? record.callId : null
    if (callId === null) return
    if (callIds !== null && !callIds.has(callId)) return
    byCallId.set(callId, {
      callId,
      stage: record.stage ?? null,
      model: record.model ?? null,
      latencyMs: typeof record.latencyMs === 'number' ? record.latencyMs : null,
      rateLimitRetries: typeof record.rateLimitRetries === 'number' ? record.rateLimitRetries : null,
      rateLimitWaitMs: typeof record.rateLimitWaitMs === 'number' ? record.rateLimitWaitMs : null,
      error: record.error ?? null,
    })
  })
  return { byCallId, total, malformed }
}

/**
 * Load Mercury call traces and aggregate them by trigger (small file).
 * @param {string} file
 */
export async function loadMercuryCalls(file) {
  const calls = []
  const { total, malformed } = await streamJsonl(file, (record) => {
    if (record.record !== 'mercury-call') return
    const trigger = record.state && typeof record.state.trigger === 'string' ? record.state.trigger : null
    calls.push({
      callId: record.callId ?? null,
      ts: record.ts ?? null,
      trigger,
      model: record.model ?? null,
      latencyMs: typeof record.latencyMs === 'number' ? record.latencyMs : null,
      retries: typeof record.retries === 'number' ? record.retries : null,
    })
  })
  return { calls, total, malformed }
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * The recorded `abandon_option` estimate, or null when the decision predates
 * β shadow logging / had no Option context.
 * @param {Record<string, unknown>} record
 */
export function readBeta(record) {
  const estimates = record.booleanEstimates
  const estimate = estimates && typeof estimates === 'object'
    ? /** @type {Record<string, unknown>} */ (estimates).abandon_option
    : null
  if (!estimate || typeof estimate !== 'object') return null
  const probability = /** @type {Record<string, unknown>} */ (estimate).probability
  if (typeof probability !== 'number') return null
  const threshold = /** @type {Record<string, unknown>} */ (estimate).threshold
  return {
    probability,
    threshold: typeof threshold === 'number' ? threshold : DEFAULT_THRESHOLD,
  }
}

/**
 * Policy A — the current recorded policy. The decision is exactly the action
 * the controller took; it counts as an abandonment when that action is the
 * grounded `ESCALATE` candidate.
 * @param {Record<string, unknown>} record
 */
export function policyA(record) {
  const decision = typeof record.chosenAction === 'string' ? record.chosenAction : 'UNKNOWN'
  return {
    policy: 'A:current-recorded',
    decision,
    verdict: decision === ABANDON_DECISION ? 'abandon' : 'continue',
    beta: null,
    threshold: null,
  }
}

/**
 * Policy B — β shadow promoted to authority. When `beta >= threshold` the plan
 * is abandoned and replaced by the escalation/replan action; otherwise the
 * recorded action stands.
 * @param {Record<string, unknown>} record
 * @param {{ threshold?: number|null, abandonDecision?: string }} [options]
 */
export function policyB(record, options = {}) {
  const abandonDecision = options.abandonDecision ?? ABANDON_DECISION
  const beta = readBeta(record)
  const fallback = typeof record.chosenAction === 'string' ? record.chosenAction : 'UNKNOWN'
  if (beta === null) {
    return {
      policy: 'B:beta-shadow-as-authority',
      decision: fallback,
      verdict: 'continue',
      beta: null,
      threshold: options.threshold ?? null,
      defined: false,
    }
  }
  const threshold = options.threshold ?? beta.threshold
  const abandon = beta.probability >= threshold
  return {
    policy: 'B:beta-shadow-as-authority',
    decision: abandon ? abandonDecision : fallback,
    verdict: abandon ? 'abandon' : 'continue',
    beta: beta.probability,
    threshold,
    defined: true,
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Compare policy A and policy B over decision records.
 * @param {Array<Record<string, unknown>>} records
 * @param {{ threshold?: number|null, abandonDecision?: string }} [options]
 */
export function evaluatePolicies(records, options = {}) {
  let comparable = 0
  let skippedNoBeta = 0
  let agree = 0
  let policyAAbandon = 0
  let policyBAbandon = 0
  const divergences = []
  for (const record of records) {
    const a = policyA(record)
    const b = policyB(record, options)
    if (a.verdict === 'abandon') policyAAbandon++
    if (!b.defined) {
      skippedNoBeta++
      continue
    }
    comparable++
    if (b.verdict === 'abandon') policyBAbandon++
    if (a.decision === b.decision) {
      agree++
      continue
    }
    divergences.push({
      decisionId: record.decisionId ?? null,
      tick: typeof record.tick === 'number' ? record.tick : null,
      ts: record.ts ?? null,
      optionId: record.optionId ?? null,
      strategy: record.strategy ?? null,
      chainId: record.chainId ?? null,
      trigger: record.trigger ?? null,
      chosenAction: a.decision,
      actionA: a.decision,
      actionB: b.decision,
      verdictA: a.verdict,
      verdictB: b.verdict,
      beta: b.beta,
      threshold: b.threshold,
      source: record.source ?? null,
      result: record.result ?? null,
    })
  }
  return {
    comparable,
    skippedNoBeta,
    agree,
    diverge: divergences.length,
    agreementRate: comparable === 0 ? null : agree / comparable,
    policyAAbandon,
    policyBAbandon,
    divergences,
  }
}

/**
 * Summarize the CAUSAL `verified=` outcomes observed for a divergent chain.
 * Falls back to the decision's own `result.verified` when no CAUSAL line exists.
 * @param {Record<string, unknown>} divergence
 * @param {Map<string, Array<Record<string, unknown>>>} causalByChain
 */
export function summarizeVerifiedOutcomes(divergence, causalByChain) {
  const chainId = typeof divergence.chainId === 'string' ? divergence.chainId : null
  const causals = chainId !== null ? causalByChain.get(chainId) ?? [] : []
  const summary = {
    causalRecords: causals.length,
    verifiedTrue: 0,
    verifiedFalse: 0,
    positiveProgress: 0,
    statuses: /** @type {Record<string, number>} */ ({}),
    source: causals.length > 0 ? 'causal' : 'none',
  }
  for (const causal of causals) {
    if (causal.verified === true) summary.verifiedTrue++
    else if (causal.verified === false) summary.verifiedFalse++
    const status = typeof causal.status === 'string' ? causal.status : 'unknown'
    summary.statuses[status] = (summary.statuses[status] ?? 0) + 1
    if (typeof causal.progressDelta === 'number' && causal.progressDelta > 0) summary.positiveProgress++
  }
  if (causals.length === 0 && divergence.result && typeof divergence.result === 'object') {
    const result = /** @type {Record<string, unknown>} */ (divergence.result)
    summary.source = 'decision.result'
    if (result.verified === true) summary.verifiedTrue = 1
    else if (result.verified === false) summary.verifiedFalse = 1
    const status = typeof result.status === 'string' ? result.status : 'unknown'
    summary.statuses[status] = 1
    if (typeof result.progress === 'number' && result.progress > 0) summary.positiveProgress = 1
  }
  return summary
}

function tally(values) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const value of values) {
    const key = value === null || value === undefined ? 'null' : String(value)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

function topCounts(record, limit = 10) {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

/**
 * Build the machine-readable report.
 * @param {{
 *   decisionFile: string,
 *   records: Array<Record<string, unknown>>,
 *   decisionsTotal: number,
 *   decisionsMalformed: number,
 *   evaluation: ReturnType<typeof evaluatePolicies>,
 *   causalByChain: Map<string, Array<Record<string, unknown>>>,
 *   causalTotal?: number,
 *   jevCalls?: Map<string, Record<string, unknown>>|null,
 *   mercuryCalls?: Array<Record<string, unknown>>|null,
 *   input?: Record<string, unknown>,
 *   maxDivergences?: number,
 * }} args
 */
export function buildReport(args) {
  const {
    records,
    evaluation,
    causalByChain,
    jevCalls = null,
    mercuryCalls = null,
    maxDivergences = 50,
  } = args

  const verifiedByDivergence = evaluation.divergences.map((divergence) =>
    summarizeVerifiedOutcomes(divergence, causalByChain),
  )

  const verifiedTotals = {
    divergences: evaluation.divergences.length,
    withVerifiedTrue: 0,
    withVerifiedFalse: 0,
    withPositiveProgress: 0,
    withoutCausalRecord: 0,
    sourcedFromCausal: 0,
    sourcedFromDecisionResult: 0,
  }
  for (const summary of verifiedByDivergence) {
    if (summary.verifiedTrue > 0) verifiedTotals.withVerifiedTrue++
    if (summary.verifiedFalse > 0) verifiedTotals.withVerifiedFalse++
    if (summary.positiveProgress > 0) verifiedTotals.withPositiveProgress++
    if (summary.causalRecords === 0 && summary.source === 'none') verifiedTotals.withoutCausalRecord++
    if (summary.source === 'causal') verifiedTotals.sourcedFromCausal++
    else if (summary.source === 'decision.result') verifiedTotals.sourcedFromDecisionResult++
  }

  const jevLatencies = []
  let jevErrors = 0
  let jevMatched = 0
  if (jevCalls) {
    for (const divergence of evaluation.divergences) {
      const record = records.find((candidate) => candidate.decisionId === divergence.decisionId)
      const jev = record && record.jev && typeof record.jev === 'object'
        ? /** @type {Record<string, unknown>} */ (record.jev)
        : null
      const callId = jev && typeof jev.callId === 'string' ? jev.callId : null
      if (callId === null) continue
      const call = jevCalls.get(callId)
      if (!call) continue
      jevMatched++
      if (typeof call.latencyMs === 'number') jevLatencies.push(call.latencyMs)
      if (call.error) jevErrors++
    }
  }

  const divergenceDetails = evaluation.divergences.map((divergence, index) => ({
    ...divergence,
    verified: verifiedByDivergence[index],
  }))

  return {
    schemaVersion: SCHEMA_VERSION,
    harness: 'tools/replay.mjs',
    generatedAt: new Date().toISOString(),
    policies: {
      A: {
        name: 'current-recorded',
        definition: 'the action the controller actually took (chosenAction)',
        abandonAction: ABANDON_DECISION,
      },
      B: {
        name: 'beta-shadow-as-authority',
        definition: 'abandon/replan when recorded abandon_option probability >= threshold',
        abandonAction: ABANDON_DECISION,
      },
    },
    input: args.input ?? { decisions: args.decisionFile },
    counts: {
      decisionsRead: args.decisionsTotal,
      decisionsMalformed: args.decisionsMalformed,
      recordsInWindow: records.length,
      comparable: evaluation.comparable,
      skippedNoBeta: evaluation.skippedNoBeta,
      agree: evaluation.agree,
      diverge: evaluation.diverge,
      agreementRate: evaluation.agreementRate,
      policyAAbandon: evaluation.policyAAbandon,
      policyBAbandon: evaluation.policyBAbandon,
    },
    verifiedAfterDivergence: verifiedTotals,
    jevCalls: jevCalls
      ? {
          matchedForDivergences: jevMatched,
          latencySamples: jevLatencies.length,
          latencyMsMean: jevLatencies.length > 0 ? jevLatencies.reduce((a, b) => a + b, 0) / jevLatencies.length : null,
          errors: jevErrors,
        }
      : null,
    mercuryCalls: mercuryCalls
      ? {
          total: mercuryCalls.length,
          byTrigger: tally(mercuryCalls.map((call) => call.trigger)),
        }
      : null,
    divergenceByOption: topCounts(tally(evaluation.divergences.map((d) => d.optionId))),
    divergenceByActionA: topCounts(tally(evaluation.divergences.map((d) => d.actionA))),
    divergences: divergenceDetails.slice(0, maxDivergences),
    divergencesTruncated: divergenceDetails.length > maxDivergences,
  }
}

// ---------------------------------------------------------------------------
// Rendering / CLI
// ---------------------------------------------------------------------------

function pct(rate) {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`
}

/** Human-readable summary of a report. */
export function formatReport(report) {
  const c = report.counts
  const v = report.verifiedAfterDivergence
  const lines = []
  lines.push(`replay ${report.harness} schemaVersion=${report.schemaVersion}`)
  lines.push(`window records=${c.recordsInWindow} comparable=${c.comparable} skippedNoBeta=${c.skippedNoBeta}`)
  lines.push(`A=${report.policies.A.name}  B=${report.policies.B.name} (abandon action=${report.policies.B.abandonAction})`)
  lines.push(`agreement=${c.agree}/${c.comparable} (${pct(c.agreementRate)}) divergences=${c.diverge}`)
  lines.push(`A abandon=${c.policyAAbandon}  B abandon=${c.policyBAbandon}`)
  lines.push(
    `verified after divergence: withVerifiedTrue=${v.withVerifiedTrue} withVerifiedFalse=${v.withVerifiedFalse} ` +
      `positiveProgress=${v.withPositiveProgress} noCausal=${v.withoutCausalRecord}`,
  )
  if (report.jevCalls) {
    lines.push(
      `jev-calls matched=${report.jevCalls.matchedForDivergences} meanLatencyMs=` +
        `${report.jevCalls.latencyMsMean === null ? 'n/a' : report.jevCalls.latencyMsMean.toFixed(0)} errors=${report.jevCalls.errors}`,
    )
  }
  if (report.mercuryCalls) {
    lines.push(`mercury-calls total=${report.mercuryCalls.total} byTrigger=${JSON.stringify(report.mercuryCalls.byTrigger)}`)
  }
  lines.push(`divergences by option: ${report.divergenceByOption.map((e) => `${e.key}=${e.count}`).join(', ')}`)
  lines.push('example divergences:')
  for (const d of report.divergences.slice(0, 3)) {
    lines.push(
      `  decision=${d.decisionId} tick=${d.tick} option=${d.optionId} ` +
        `beta=${d.beta}>=${d.threshold} A=${d.actionA} B=${d.actionB} ` +
        `verified=${d.verified.verifiedTrue}/${d.verified.verifiedFalse} progress=${d.verified.positiveProgress}`,
    )
  }
  if (report.divergencesTruncated) {
    lines.push(`  ... (${report.counts.diverge} total divergences; list truncated)`)
  }
  lines.push(`doc: schemaVersion=${report.schemaVersion} — deterministic replay, no LLM/server calls`)
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {
    decisions: DEFAULT_DECISIONS,
    run: null,
    jevCalls: null,
    mercuryCalls: null,
    last: 0,
    fromTick: null,
    toTick: null,
    threshold: null,
    maxDivergences: 50,
    json: false,
    out: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      return value
    }
    switch (arg) {
      case '--decisions': args.decisions = next(); break
      case '--run': args.run = next(); break
      case '--jev-calls': args.jevCalls = next(); break
      case '--mercury-calls': args.mercuryCalls = next(); break
      case '--last': args.last = Number(next()); break
      case '--from-tick': args.fromTick = Number(next()); break
      case '--to-tick': args.toTick = Number(next()); break
      case '--threshold': args.threshold = Number(next()); break
      case '--max-divergences': args.maxDivergences = Number(next()); break
      case '--out': args.out = next(); break
      case '--json': args.json = true; break
      case '--help':
      case '-h':
        return { help: true }
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function usage() {
  return [
    'usage: bun tools/replay.mjs [options]',
    '',
    'options:',
    '  --decisions <path>     default buddy-driver/logs/jev/decisions.jsonl',
    '  --run <path>           run JSONL with CAUSAL verified outcomes (optional)',
    '  --jev-calls <path>     jev-calls.jsonl for latency/error enrichment (optional)',
    '  --mercury-calls <path> mercury-calls.jsonl summary (optional)',
    '  --last N               keep only the final N matching decisions',
    '  --from-tick N          include decisions with tick >= N',
    '  --to-tick N            include decisions with tick <= N',
    '  --threshold P          override the recorded abandon_option threshold',
    '  --max-divergences N    cap the divergence list in the report (default 50)',
    '  --json                 print the machine-readable report',
    '  --out <path>           write the JSON report to a file',
  ].join('\n')
}

function exists(file) {
  return typeof file === 'string' && file.length > 0 && fs.existsSync(file)
}

export async function runCli(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`)
    return 1
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (!exists(args.decisions)) {
    process.stderr.write(`decisions log not found: ${args.decisions}\n`)
    return 1
  }

  const window = await loadDecisions(args.decisions, {
    last: args.last,
    fromTick: args.fromTick,
    toTick: args.toTick,
  })

  const evaluation = evaluatePolicies(window.records, { threshold: args.threshold })

  const chainIds = new Set(
    evaluation.divergences
      .map((divergence) => divergence.chainId)
      .filter((chainId) => typeof chainId === 'string'),
  )

  let causalByChain = new Map()
  let causalTotal = null
  const runFile = args.run ?? (exists(DEFAULT_RUN) ? DEFAULT_RUN : null)
  if (runFile && exists(runFile)) {
    const causal = await loadCausal(runFile, { chainIds: chainIds.size > 0 ? chainIds : null })
    causalByChain = causal.byChain
    causalTotal = causal.total
  }

  let jevCalls = null
  const jevCallIds = new Set()
  for (const record of window.records) {
    const jev = record.jev
    const callId = jev && typeof jev === 'object' ? /** @type {Record<string, unknown>} */ (jev).callId : null
    if (typeof callId === 'string') jevCallIds.add(callId)
  }
  const jevFile = args.jevCalls ?? (exists(DEFAULT_JEV_CALLS) ? DEFAULT_JEV_CALLS : null)
  if (jevFile && exists(jevFile)) {
    const loaded = await loadJevCalls(jevFile, { callIds: jevCallIds.size > 0 ? jevCallIds : null })
    jevCalls = loaded.byCallId
  }

  let mercuryCalls = null
  const mercuryFile = args.mercuryCalls ?? (exists(DEFAULT_MERCURY_CALLS) ? DEFAULT_MERCURY_CALLS : null)
  if (mercuryFile && exists(mercuryFile)) {
    const loaded = await loadMercuryCalls(mercuryFile)
    mercuryCalls = loaded.calls
  }

  const report = buildReport({
    decisionFile: args.decisions,
    records: window.records,
    decisionsTotal: window.total,
    decisionsMalformed: window.malformed,
    evaluation,
    causalByChain,
    causalTotal,
    jevCalls,
    mercuryCalls,
    input: {
      decisions: args.decisions,
      run: runFile,
      jevCalls: jevFile,
      mercuryCalls: mercuryFile,
      last: args.last,
      fromTick: args.fromTick,
      toTick: args.toTick,
      threshold: args.threshold,
      decisionsMatched: window.matched,
    },
    maxDivergences: args.maxDivergences,
  })

  if (args.out) {
    await fsp.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  runCli().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    },
  )
}
