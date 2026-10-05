// jev-d1-calibrate.mts - JEV-BEST-PRACTICES §18 Gate F: Liquid d1 calibration
// measured separately from TypeSafe Jev. Makes a BOUNDED number of real d1
// calls through the production adapter (systemone-direct, liquid-direct-d1
// profile) over recorded decision states, then reports measured distributions
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
//        [--threat-sample 8] [--stride] [--json out]

import { readFileSync, writeFileSync } from 'node:fs'
import {
  DECISION_PROFILES,
  createDirectDecisionBackend,
  resolveProfileCredential,
} from '../packages/jev-harness/providers/systemone-direct.ts'
import {
  buildAuthorityQuestions,
} from '../packages/jev-agent/src/jev/authority.ts'
import { ACTION_DECLINE_LABEL } from '../packages/jev-agent/src/jev/client.ts'
import { projectionModelView } from '../packages/jev-agent/src/jev/semantic-projection.ts'
import { describePredicate } from '../packages/jev-agent/src/optionSpec.ts'

const args = process.argv.slice(2)
const file = args[0]
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const SAMPLE = Number(opt('sample') ?? '40')
const THREAT_SAMPLE = Number(opt('threat-sample') ?? '8')
const jsonOut = opt('json')
const TIMEOUT_MS = 30_000

const LOW_CONFIDENCE = 0.55
const ABANDON_THRESHOLD = 0.5
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

const records: any[] = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
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
  records.push(record)
}

const isThreat = (r: any): boolean => {
  const q = r.questions
  return typeof q === 'object' && q !== null && 'danger' in q
}
const threat = records.filter(isThreat)
const core = records.filter((r) => !isThreat(r))

const stride = Math.max(1, Math.floor(core.length / Math.max(1, SAMPLE)))
const coreSample = core.filter((_, i) => i % stride === 0).slice(0, SAMPLE)
const threatStride = Math.max(1, Math.floor(threat.length / Math.max(1, THREAT_SAMPLE)))
const threatSample = threat.filter((_, i) => i % threatStride === 0).slice(0, THREAT_SAMPLE)
const sample = [...coreSample, ...threatSample]

console.log(`corpus ${file}: ${records.length} ok calls (${core.length} core, ${threat.length} threat); sampling ${coreSample.length} core + ${threatSample.length} threat = ${sample.length}`)

// ---------------------------------------------------------------------------
// live d1 calls through the production adapter
// ---------------------------------------------------------------------------

const profile = DECISION_PROFILES['liquid-direct-d1']
const credential = resolveProfileCredential(profile)
if (credential === null) {
  console.error(`no credential for liquid-direct-d1 (${profile.secretFile}) - fail closed`)
  process.exit(2)
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
for (const rec of sample) {
  const proj = reconstruct(rec.state)
  if (proj === null) continue
  const state = { ...projectionModelView(proj as never), projectionHash: rec.state.projectionHash ?? null }
  const questionNames = Object.keys(rec.questions ?? {})
  // The record stores the exact wire questions the model saw (v6 and v7
  // alike); replaying them is more faithful than rebuilding from recorded
  // candidates, whose v7 projection strips the `meta` criteria source.
  const questions = rec.questions ?? buildAuthorityQuestions(rec.state.candidates ?? [], questionNames as never)
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
    reply = await backend.evaluate({ model: 'd1', state, questions, abortSignal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    error = String(e instanceof Error ? e.message : e)
  }
  const latencyMs = Date.now() - started
  const answers = reply?.answers ?? {}
  const metaConfidence = reply?.providerMetadata?.systemone?.confidence ?? {}
  const recordedAction = rec.response?.answers?.action?.value ?? null
  const d1Action = answers.action?.choice ?? answers.action?.value ?? null
  const actionProbs = answers.action?.probabilities ?? {}
  const topProb = d1Action === null ? null : (actionProbs[d1Action] ?? null)
  rows.push({
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
  })
  done += 1
  if (done % 8 === 0) console.log(`  ${done}/${sample.length}...`)
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
    agreeWithRecordedJev: ok.filter((r) => r.agree).length,
    judged: ok.filter((r) => r.d1Action !== null && r.recordedAction !== null).length,
  },
  abandon: {
    p: summarize(ok.map((r) => r.betaP).filter((x): x is number => typeof x === 'number')),
    adoptAtHalf: ok.filter((r) => typeof r.betaP === 'number' && r.betaP >= ABANDON_THRESHOLD).length,
    recordedJevAdoptAtHalf: ok.filter((r) => typeof r.recordedBetaP === 'number' && r.recordedBetaP >= ABANDON_THRESHOLD).length,
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
    .map((r) => ({ ts: r.ts, d1: r.d1Action, jev: r.recordedAction, topProb: r.actionTopProb })),
}

const out = { corpus: file, sampled: sample.length, thresholds: { LOW_CONFIDENCE, ABANDON_THRESHOLD, DANGER_CONFIDENCE, BOOL_LOW, BOOL_HIGH }, metric, rows }
if (jsonOut !== null) writeFileSync(jsonOut, JSON.stringify(out, null, 2))
console.log(JSON.stringify(metric, null, 2))
