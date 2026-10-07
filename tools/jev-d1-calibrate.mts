// jev-d1-calibrate.mts - JEV-BEST-PRACTICES §18 Gate F: Liquid d1 calibration
// measured separately from TypeSafe Jev. Makes a BOUNDED number of real d1
// calls through the production adapter (systemone-direct, liquid-direct-d1
// profile selected explicitly) over recorded decision states, then reports measured distributions
// for every threshold the runtime applies to model output:
//
//   action.choice      top-label probability + confidence vs
//                      lowConfidenceThreshold (0.55) and agreement with the
//                      recorded Jev answer on the identical state
//   abandon_option     P(true) vs ABANDON_THRESHOLD_DEFAULT (0.5)
//   danger             score + confidence vs DANGER_CONFIDENCE_THRESHOLD (0.4)
//   should_retreat     P(true) vs the 0.30/0.70 strong band
//
// The state sent is the v7 canonical DecisionState (projectionModelView) and
// the questions are the CURRENT Gate-B/D wording - exactly what production
// sends under Gate C. Read-only on corpora; provider calls are bounded by
// --sample/--threat-sample.
//
// Usage: bun tools/jev-d1-calibrate.mts <jev-calls.jsonl> [--sample 40]
//        [--threat-sample 8] [--profile liquid-direct-d1-free] [--model d1:free]
//        [--split dev|holdout|all] [--corpus-sha256 HASH] [--budget-ms 180000]
//        [--dry-run] [--json out]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DECISION_PROFILES,
  DEFAULT_DECISION_PROFILE_ID,
  createDirectDecisionBackend,
  profileLowConfidenceFloor,
  readDirectDecisionDiagnostics,
  resolveProfileCredential,
} from '../packages/jev-harness/providers/systemone-direct.ts'
import {
  buildAuthorityQuestions,
} from '../packages/jev-agent/src/jev/authority.ts'
import { ACTION_DECLINE_LABEL } from '../packages/jev-agent/src/jev/client.ts'
import { projectionModelView } from '../packages/jev-agent/src/jev/semantic-projection.ts'
import { describePredicate } from '../packages/jev-agent/src/optionSpec.ts'

export interface CalibrationOptions {
  file: string
  profileId: string
  model: string
  sample: number
  threatSample: number
  split: 'all' | 'dev' | 'holdout'
  corpusSha256: string | null
  budgetMs: number
  dryRun: boolean
  jsonOut: string | null
}

export function calibrationOptions(args: readonly string[]): CalibrationOptions {
  const file = args[0]
  if (!file || file.startsWith('--')) throw new Error('a recorded jev-call corpus is required')
  const values = new Map<string, string>()
  let dryRun = false
  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i]!
    if (flag === '--dry-run') { dryRun = true; continue }
    if (!['--sample', '--threat-sample', '--profile', '--model', '--split', '--corpus-sha256', '--budget-ms', '--json'].includes(flag)) {
      throw new Error(`unknown option ${flag}`)
    }
    const value = args[++i]
    if (!value || value.startsWith('--') || values.has(flag)) throw new Error(`missing or duplicate ${flag}`)
    values.set(flag, value)
  }
  const profileId = values.get('--profile') ?? DEFAULT_DECISION_PROFILE_ID
  const profile = DECISION_PROFILES[profileId]
  if (!profile || profile.wireDialect !== 'typesafe-systemone/v1') throw new Error(`not a direct decision profile: ${profileId}`)
  const model = values.get('--model') ?? profile.modelId
  if (model !== profile.modelId) throw new Error(`model ${model} does not match profile ${profileId} (${profile.modelId})`)
  const sample = Number(values.get('--sample') ?? 40)
  const threatSample = Number(values.get('--threat-sample') ?? 8)
  if (![sample, threatSample].every((n) => Number.isInteger(n) && n >= 0) || sample + threatSample < 1 || sample + threatSample > 128) {
    throw new Error('sample + threat-sample must be 1..128 nonnegative integer calls')
  }
  const split = values.get('--split') ?? 'all'
  if (!['all', 'dev', 'holdout'].includes(split)) throw new Error(`invalid split ${split}`)
  const budgetMs = Number(values.get('--budget-ms') ?? 180_000)
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 600_000) throw new Error('budget-ms must be 1..600000')
  const corpusSha256 = values.get('--corpus-sha256') ?? null
  if (corpusSha256 !== null && !/^[a-f0-9]{64}$/.test(corpusSha256)) throw new Error('invalid corpus-sha256')
  return { file, profileId, model, sample, threatSample, split: split as CalibrationOptions['split'], corpusSha256, budgetMs, dryRun, jsonOut: values.get('--json') ?? null }
}

/** Chronological split is fixed before stratification; holdout cannot leak into dev. */
export function calibrationSample(records: readonly any[], options: CalibrationOptions): any[] {
  const cut = Math.floor(records.length * 0.75)
  const slice = options.split === 'dev' ? records.slice(0, cut) : options.split === 'holdout' ? records.slice(cut) : records
  const pick = (rows: readonly any[], limit: number) => {
    if (limit === 0) return []
    const stride = Math.max(1, Math.floor(rows.length / limit))
    return rows.filter((_, i) => i % stride === 0).slice(0, limit)
  }
  return [
    ...pick(slice.filter((r) => !('danger' in (r.questions ?? {}))), options.sample),
    ...pick(slice.filter((r) => 'danger' in (r.questions ?? {})), options.threatSample),
  ]
}

const TIMEOUT_MS = 30_000

const DANGER_CONFIDENCE = 0.4
const BOOL_LOW = 0.3
const BOOL_HIGH = 0.7

// ---------------------------------------------------------------------------
// v6 record -> v7-equivalent projection (same mapping as jev-replay-eval)
// ---------------------------------------------------------------------------

function reconstruct(state: Record<string, any>): Record<string, any> | null {
  // v7 records already store the classifier-ready projection directly in
  // `state` (schema `jev-semantic-projection/v7`); see jev-replay-eval.
  if (state.schema === 'jev-semantic-projection/v7') {
    return { ...state, counts: {} }
  }
  const semantic = state.semantic
  if (semantic === null || typeof semantic !== 'object') return null
  const currentOption = state.currentOption ?? null
  const rawQueue = state.goalQueue ?? null
  const rawStall = state.signals?.strategicNonProgress ?? null
  const queue = rawQueue === null
    ? null
    : {
        depth: rawQueue.depth,
        empty: rawQueue.empty,
        hasImpossible: rawQueue.hasImpossible === true,
        current:
          rawQueue.current === null || rawQueue.current === undefined
            ? null
            : {
                id: rawQueue.current.id,
                description: String(rawQueue.current.description ?? '').slice(0, 160),
                optionInstanceId: rawQueue.current.optionInstanceId ?? null,
                semanticOptionInstanceId:
                  rawQueue.current.semanticOptionInstanceId ??
                  rawQueue.current.optionSpec?.semanticOptionInstanceId ??
                  null,
              },
      }
  const progress = { ...(semantic.progress ?? {}) }
  delete progress.stallExhausted
  delete progress.stallDistinctStates
  progress.stall = rawStall === null
    ? null
    : {
        windowSize: rawStall.windowSize,
        distinctStates: rawStall.distinctStates,
        bodyDecisions: rawStall.bodyProgressDecisions,
        semanticDecisions: rawStall.semanticProgressDecisions,
        horizon: rawStall.horizon,
        maxDistinctStates: rawStall.maxDistinctStates,
        exhausted: rawStall.exhausted === true,
        exhaustedRepeats: rawStall.exhaustedRepeats,
      }
  const option = semantic.option === null || semantic.option === undefined
    ? null
    : {
        ...semantic.option,
        semanticInstanceId: currentOption?.semanticInstanceId ?? null,
        semanticTemplateId: currentOption?.semanticTemplateId ?? null,
        intent: currentOption?.semanticIntent ?? null,
        preconditions: (currentOption?.preconditions ?? []).map(describePredicate),
        success: (currentOption?.success ?? []).map(describePredicate),
        allowedSkills: currentOption?.allowedSkills ?? [],
        verifiedProgress: currentOption?.runtime?.verifiedProgress ?? 0,
        failures: currentOption?.runtime?.failures ?? 0,
      }
  return { ...semantic, option, progress, queue, counts: {} }
}

// ---------------------------------------------------------------------------
// deterministic stratified sample: every threat-set record (capped) + an even
// stride across the core-set records
// ---------------------------------------------------------------------------

export async function calibrate(args: readonly string[]): Promise<void> {
  const options = calibrationOptions(args)
  const { file, jsonOut } = options
  if (jsonOut !== null && existsSync(jsonOut)) throw new Error('output already exists; evidence is immutable')
  const profile = DECISION_PROFILES[options.profileId]!
  const LOW_CONFIDENCE = profileLowConfidenceFloor(profile, {})
  const ABANDON_THRESHOLD = profile.abandonThreshold ?? 0.5
  const bytes = readFileSync(file)
  const corpusSha256 = createHash('sha256').update(bytes).digest('hex')
  if (options.corpusSha256 !== null && options.corpusSha256 !== corpusSha256) throw new Error('sealed corpus hash mismatch; no calls made')
  const records: any[] = []
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.record !== 'jev-call') continue
    if ((record.state?.semantic ?? null) === null && record.state?.schema !== 'jev-semantic-projection/v7') continue
    if (record.error !== undefined && record.error !== null) continue // calibration needs a real recorded answer
    records.push({ ...record, corpusOrdinal: records.length })
  }

  const isThreat = (r: any): boolean => {
    const q = r.questions
    return typeof q === 'object' && q !== null && 'danger' in q
  }
  const threat = records.filter(isThreat)
  const core = records.filter((r) => !isThreat(r))

  const sample = calibrationSample(records, options)
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const sourceTreeDirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim() !== ''
  const provenance = {
    sourceSha, sourceTreeDirty,
    profileId: profile.profileId, provider: profile.providerId, model: profile.modelId,
    corpus: file, corpusSha256, eligible: records.length, split: options.split,
    devFraction: 0.75, maxCalls: options.sample + options.threatSample, budgetMs: options.budgetMs,
    selected: sample.map((r) => ({ ordinal: r.corpusOrdinal, callId: r.callId, ts: r.ts, threat: isThreat(r) })),
  }

  console.log(`corpus ${file}: ${records.length} eligible (${core.length} core, ${threat.length} threat); ${options.split} sample ${sample.length}; ${profile.profileId} / ${profile.modelId}`)
  if (options.dryRun) {
    if (jsonOut !== null) writeFileSync(jsonOut, JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(provenance, null, 2))
    return
  }
  if (sourceTreeDirty) throw new Error('commit calibration source before provider evaluation')

  // ---------------------------------------------------------------------------
  // live d1 calls through the production adapter
  // ---------------------------------------------------------------------------

  const credential = resolveProfileCredential(profile)
  if (credential === null) {
    throw new Error(`no credential for ${profile.profileId} (${profile.secretFile}) - fail closed`)
  }
  const backend = createDirectDecisionBackend(profile, credential, { timeoutMs: TIMEOUT_MS })

  const quantile = (xs: number[], p: number): number | null => {
    if (xs.length === 0) return null
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(s.length * p))]!
  }
  const summarize = (xs: number[]) => ({
    n: xs.length,
    mean: xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length,
    p10: quantile(xs, 0.1),
    p50: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
  })

  const rows: any[] = []
  let done = 0
  const deadline = Date.now() + options.budgetMs
  let stopReason: string | null = null
  for (const rec of sample) {
    if (Date.now() >= deadline) { stopReason = 'wall_budget'; break }
    const proj = reconstruct(rec.state)
    if (proj === null) continue
    const state = { ...projectionModelView(proj as never), projectionHash: rec.state.projectionHash ?? null }
    const questionNames = Object.keys(rec.questions ?? {})
    // The record stores the exact wire questions the model saw (v6 and v7
    // alike); replaying them is more faithful than rebuilding from recorded
    // candidates, whose v7 projection strips the `meta` criteria source.
    const questions = structuredClone(rec.questions ?? buildAuthorityQuestions(rec.state.candidates ?? [], questionNames as never))
    // Some recorded questions predate the singleton-offer DECLINE leg; the wire
    // requires >=2 Choice labels, so inject the same leg production adds.
    const actionQ = questions.action
    if (actionQ?.type === 'choice' && Object.keys(actionQ.criteria ?? {}).length === 1) {
      actionQ.criteria[ACTION_DECLINE_LABEL] =
        'decline the only grounded action: this Option cannot proceed as offered'
    }
    const started = Date.now()
    let reply: any = null
    let error: string | null = null
    try {
      reply = await backend.evaluate({ model: profile.modelId, state, questions, abortSignal: AbortSignal.timeout(Math.min(TIMEOUT_MS, Math.max(1, deadline - Date.now()))) })
    } catch (e) {
      error = String(e instanceof Error ? e.message : e)
    }
    const latencyMs = Date.now() - started
    const answers = reply?.answers ?? {}
    const diagnostics = readDirectDecisionDiagnostics(reply)
    const metaConfidence = diagnostics.confidence
    const recordedAction = rec.response?.answers?.action?.value ?? null
    const d1Action = answers.action?.choice ?? answers.action?.value ?? null
    const actionProbs = answers.action?.probabilities ?? {}
    const topProb = d1Action === null ? null : (actionProbs[d1Action] ?? null)
    rows.push({
      corpusOrdinal: rec.corpusOrdinal,
      recordedCallId: rec.callId,
      recordedModel: rec.response?.model ?? rec.backend?.model ?? null,
      reportedModel: diagnostics.reportedModel,
      requestId: diagnostics.requestId,
      stateSha256: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
      questionsSha256: createHash('sha256').update(JSON.stringify(questions)).digest('hex'),
      ts: rec.ts,
      set: questionNames.sort().join('+'),
      d1Action,
      recordedAction,
      agree: d1Action !== null && d1Action === recordedAction,
      actionTopProb: topProb,
      actionConfidence: metaConfidence.action ?? answers.action?.confidence ?? null,
      betaP: answers.abandon_option?.probability ?? null,
      recordedBetaP: rec.response?.answers?.abandon_option?.probability ?? null,
      dangerScore: answers.danger?.score ?? null,
      dangerConfidence: metaConfidence.danger ?? answers.danger?.confidence ?? null,
      retreatP: answers.should_retreat?.probability ?? null,
      usage: reply?.usage ?? null,
      latencyMs,
      error,
      answers,
    })
    done += 1
    if (done % 8 === 0) console.log(`  ${done}/${sample.length}...`)
    if (rows.filter((r) => r.error !== null).length >= 2) { stopReason = 'provider_failure_bound'; break }
  }

  const ok = rows.filter((r) => r.error === null)
  const failures = rows.filter((r) => r.error !== null)
  const metric = {
    calls: rows.length,
    ok: ok.length,
    failed: failures.length,
    failureMessages: [...new Set(failures.map((r) => String(r.error).slice(0, 140)))],
    action: {
      topProb: summarize(ok.map((r) => r.actionTopProb).filter((x): x is number => typeof x === 'number')),
      confidence: summarize(ok.map((r) => r.actionConfidence).filter((x): x is number => typeof x === 'number')),
      belowLowConfidence: ok.filter((r) => typeof r.actionConfidence === 'number' && r.actionConfidence < LOW_CONFIDENCE).length,
      agreeWithRecorded: ok.filter((r) => r.agree).length,
      judged: ok.filter((r) => r.d1Action !== null && r.recordedAction !== null).length,
    },
    abandon: {
      p: summarize(ok.map((r) => r.betaP).filter((x): x is number => typeof x === 'number')),
      adoptAtThreshold: ok.filter((r) => typeof r.betaP === 'number' && r.betaP >= ABANDON_THRESHOLD).length,
      recordedAdoptAtThreshold: ok.filter((r) => typeof r.recordedBetaP === 'number' && r.recordedBetaP >= ABANDON_THRESHOLD).length,
    },
    danger: {
      confidence: summarize(ok.map((r) => r.dangerConfidence).filter((x): x is number => typeof x === 'number')),
      belowConfidenceGate: ok.filter((r) => typeof r.dangerConfidence === 'number' && r.dangerConfidence < DANGER_CONFIDENCE).length,
      scoreDistribution: ok.reduce((acc: Record<string, number>, r) => {
        if (typeof r.dangerScore === 'number') acc[String(r.dangerScore)] = (acc[String(r.dangerScore)] ?? 0) + 1
        return acc
      }, {}),
    },
    retreat: {
      p: summarize(ok.map((r) => r.retreatP).filter((x): x is number => typeof x === 'number')),
      strongTrue: ok.filter((r) => typeof r.retreatP === 'number' && r.retreatP >= BOOL_HIGH).length,
      uncertain: ok.filter((r) => typeof r.retreatP === 'number' && r.retreatP > BOOL_LOW && r.retreatP < BOOL_HIGH).length,
      strongFalse: ok.filter((r) => typeof r.retreatP === 'number' && r.retreatP <= BOOL_LOW).length,
    },
    usage: {
      inputTokens: summarize(ok.map((r) => r.usage?.inputTokens).filter((x): x is number => typeof x === 'number')),
      outputTokens: summarize(ok.map((r) => r.usage?.outputTokens).filter((x): x is number => typeof x === 'number')),
      latencyMs: summarize(ok.map((r) => r.latencyMs)),
    },
    disagreeExamples: ok.filter((r) => !r.agree && r.d1Action !== null && r.recordedAction !== null).slice(0, 12)
      .map((r) => ({ ts: r.ts, d1: r.d1Action, recorded: r.recordedAction, topProb: r.actionTopProb })),
  }

  const out = { ...provenance, sampled: sample.length, stopReason, completedAt: new Date().toISOString(), keyOrigin: credential.origin,
    calibrationStatus: 'distribution-and-reference-replay-only; no independently verified correctness labels',
    thresholds: { LOW_CONFIDENCE, ABANDON_THRESHOLD, DANGER_CONFIDENCE, BOOL_LOW, BOOL_HIGH }, metric, rows }
  if (jsonOut !== null) writeFileSync(jsonOut, JSON.stringify(out, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(metric, null, 2))
}

if (import.meta.main) await calibrate(process.argv.slice(2))
