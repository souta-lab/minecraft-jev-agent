// jev-replay-eval.mts - JEV-BEST-PRACTICES §18 Gate E: replay + sealed-holdout
// proof on recorded corpora. Read-only over logs/jev/jev-calls.jsonl.
//
// For every recorded provider call, reconstruct the v7 canonical projection
// (same mapping as Gate B --compact-sim) and run the REAL Gate C classifier:
//
//   anchor = projection bound to the last ACCEPTED answer
//   verdict = classifySemanticBoundary({answered: anchor, current: proj_i,
//                                       lastOutcomeRequiredDecision,
//                                       leaseHeld})
//   requery -> the recorded call is a REAL boundary; the anchor advances iff
//              the recorded call succeeded (accepted answer only)
//   replay  -> the recorded call was unnecessary; compare the repointed anchor
//              answer with what the model actually answered (fidelity)
//
// Mandatory-boundary flag: reconstructed from the call's own
// `previousDecision.terminalReason` (the same settle packet production reads).
// `hasImpossible` is not reconstructible from v6 outer queue state - a queue
// impossibility flip is a blind spot (documented, biases toward replay).
//
// Split: chronological; first --dev-frac is the dev slice, the remainder is
// sealed holdout. Run once per corpus; do not tune on holdout.
//
// Usage: bun tools/jev-replay-eval.mts <jev-calls.jsonl> [--label p24]
//        [--dev-frac 0.75] [--since ISO] [--until ISO] [--json out] [--verbose]

import { readFileSync, writeFileSync } from 'node:fs'
import { classifySemanticBoundary, mandatoryPolicyBoundary } from '../packages/jev-agent/src/jev/semantic-projection.ts'
import { describePredicate } from '../packages/jev-agent/src/optionSpec.ts'

const args = process.argv.slice(2)
const file = args[0]
const opt = (name: string): string | null => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : (args[i + 1] ?? null)
}
const label = opt('label') ?? file
const devFrac = Number(opt('dev-frac') ?? '0.75')
const since = opt('since') === null ? null : Date.parse(opt('since')!)
const until = opt('until') === null ? null : Date.parse(opt('until')!)
const jsonOut = opt('json')
const verbose = args.includes('--verbose')

// ---------------------------------------------------------------------------
// v6 record -> v7-equivalent projection (Gate B compactSimulate mapping)
// ---------------------------------------------------------------------------

function reconstruct(state: Record<string, any>): Record<string, any> | null {
  // v7 records already store the classifier-ready projection directly in
  // `state` (schema `jev-semantic-projection/v7`): option carries
  // semanticInstanceId/intent/preconditions/success as described strings,
  // progress.stall the measured window, queue/world the same fields the v6
  // envelope rebuild below produces. Anything else predates the projection
  // field the classifier needs and is dropped.
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
        hasImpossible: rawQueue.hasImpossible === true, // absent in v6 -> false
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
  return {
    ...semantic,
    option,
    progress,
    queue,
    // exempt memory fields are irrelevant to the classifier; normalize anyway
    previousDecision: semantic.previousDecision ?? null,
    recentOutcomes: semantic.recentOutcomes ?? [],
    counts: {},
  }
}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

interface Slice {
  name: string
  calls: any[]
}

const records: any[] = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  let record: any
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.record !== 'jev-call' || record.state === null || record.state === undefined) continue
  if ((record.state.semantic ?? null) === null && record.state.schema !== 'jev-semantic-projection/v7') continue
  const ts = Date.parse(record.ts)
  if (since !== null && ts < since) continue
  if (until !== null && ts > until) continue
  records.push(record)
}

const splitAt = Math.floor(records.length * devFrac)
const slices: Slice[] = [
  { name: 'all', calls: records },
  { name: 'dev', calls: records.slice(0, splitAt) },
  { name: 'holdout', calls: records.slice(splitAt) },
]

function run(slice: Slice) {
  const reasons: Record<string, number> = {}
  let simulatedCalls = 0
  let replays = 0
  let replayAgree = 0
  let replayDisagree = 0
  let replayUnmappable = 0
  let hashChurnReplay = 0 // raw-hash replay would have missed these entirely
  let erroredNecessary = 0
  let erroredReplay = 0
  const disagreements: any[] = []
  let anchor: { proj: Record<string, any>; identity: string | null; answer: string } | null = null
  let anchorHash: string | null = null

  for (const rec of slice.calls) {
    const proj = reconstruct(rec.state)
    if (proj === null) continue
    const mandatory = mandatoryPolicyBoundary(proj.previousDecision?.terminalReason ?? null as never)
    const leaseHeld = proj.world?.leaseHeld !== false
    const verdict =
      anchor === null
        ? { requery: true, reason: 'first_decision' as const }
        : classifySemanticBoundary({
            answered: anchor.proj as never,
            current: proj as never,
            lastOutcomeRequiredDecision: mandatory,
            leaseHeld,
          })
    const hash = rec.state.projectionHash ?? null

    if (verdict.requery) {
      simulatedCalls += 1
      reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1
      if (rec.error !== undefined && rec.error !== null) {
        erroredNecessary += 1 // call spent, no accepted answer -> no anchor
      } else {
        const answer = rec.response?.answers?.action?.value
        const answeredCand = (proj.candidates ?? []).find((c: any) => c.id === answer)
        anchor = { proj, identity: answeredCand?.identity ?? null, answer }
        anchorHash = hash
      }
      continue
    }

    replays += 1
    reasons.same_semantic_state = (reasons.same_semantic_state ?? 0) + 1
    if (hash !== null && anchorHash !== null && hash !== anchorHash) hashChurnReplay += 1
    if (rec.error !== undefined && rec.error !== null) {
      erroredReplay += 1
      continue // no accepted answer was recorded; fidelity is not measurable
    }
    // fidelity: repoint anchor identity -> current realization, compare answers
    const recorded = rec.response?.answers?.action?.value ?? null
    const repointed =
      anchor === null ? null : (proj.candidates ?? []).find((c: any) => c.identity === anchor.identity)?.id ?? null
    if (anchor !== null && repointed === null) {
      replayUnmappable += 1
    } else if (anchor !== null && repointed === recorded) {
      replayAgree += 1
    } else if (anchor !== null) {
      replayDisagree += 1
      if (verbose && disagreements.length < 25) {
        disagreements.push({
          ts: rec.ts,
          repointed,
          recorded,
          anchorIdentity: anchor.identity,
        })
      }
    }
  }

  return {
    calls: slice.calls.length,
    simulatedCalls,
    replays,
    reduction: slice.calls.length === 0 ? 0 : 1 - simulatedCalls / slice.calls.length,
    reasons,
    fidelity: { agree: replayAgree, disagree: replayDisagree, unmappable: replayUnmappable },
    errored: { necessary: erroredNecessary, suppressed: erroredReplay },
    hashChurnReplay,
    disagreements,
  }
}

const result: Record<string, ReturnType<typeof run>> = {}
for (const slice of slices) result[slice.name] = run(slice)

const out = { label, file, devFrac, slices: result }
if (jsonOut !== null) writeFileSync(jsonOut, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
