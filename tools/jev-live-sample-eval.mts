#!/usr/bin/env bun
// jev-live-sample-eval: §18 Gate H evidence collector.
//
//   bun tools/jev-live-sample-eval.mts --run-dir <abs> --since <iso> [--until <iso>]
//
// Joins the run's resident stdout (epoch/boundary/stale/outcome markers) with
// logs/jev/jev-calls.jsonl (provider calls) over a bounded live window and
// reports the Gate H contract: calls per semantic commitment, replay rate,
// boundary/requery causes, stale drops, tokens per call, latency, singleton
// DECLINE behaviour, backend/model provenance, generation churn, and verified
// semantic progress. Read-only.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? null : (process.argv[i + 1] ?? null)
}
const runDir = arg('run-dir')
const since = arg('since')
const until = arg('until')
if (!runDir || !since) {
  console.error('usage: bun tools/jev-live-sample-eval.mts --run-dir <abs> --since <iso> [--until <iso>]')
  process.exit(1)
}
const stdoutPath = join(runDir, 'resident-stdout.log')
const callsPath = join(runDir, 'src/packages/buddy-driver/logs/jev/jev-calls.jsonl')
if (!existsSync(stdoutPath) || !existsSync(callsPath)) throw new Error('run dir missing resident-stdout.log or jev-calls.jsonl')

const inWindow = (ts: string): boolean => ts >= since! && (until === null || ts <= until)
const pct = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)))] ?? null
}

// ---- stdout markers -------------------------------------------------------
const epochStarts: { epoch: number; reason: string; cacheHit: boolean; reusedFrom: string | null; hash: string; ts: string }[] = []
const epochEnds: { epoch: number; closeReason: string; commitmentId: string; cacheHit: boolean }[] = []
const staleDrops: { epoch: number; activeEpoch: string; reason: string; ts: string }[] = []
const outcomePackets: { actionId: string; terminalReason: string; verified: boolean; progress: string; failure: string | null; ts: string }[] = []
const generationReadies: { runId: string; generationId: string; sourceSha: string; buildHash: string; provider: string; profile: string; model: string; planner: string; planAuthority: string; ts: string }[] = []
const fatals: { ts: string; context: string; line: string }[] = []
const boundaryChange: Record<string, number> = {}

let lastTs = ''
for (const line of readFileSync(stdoutPath, 'utf8').split('\n')) {
  const tsMatch = /^\[(2\d{3}-\d{2}-\d{2}T[0-9:.]+Z)\]/.exec(line)
  if (tsMatch) lastTs = tsMatch[1]!
  const ts = lastTs
  if (ts === '' || !inWindow(ts)) continue
  if (line.includes('JEV_DECISION_EPOCH_START') && /\breason=\S/.test(line)) {
    const m = /epoch=(\d+) projectionHash=(\S+) .*?reason=(\S+?)(?: cacheHit=(\S+) reusedFrom=(\S+))? /.exec(`${line} `)
      ?? /epoch=(\d+) projectionHash=(\S+) .*reason=(\S+?)(?:\s|$)/.exec(line)
    const cacheHit = /cacheHit=true/.test(line)
    const reused = /reusedFrom=(\S+)/.exec(line)?.[1] ?? null
    const epoch = Number(/epoch=(\d+)/.exec(line)?.[1] ?? -1)
    const hash = /projectionHash=(\S+)/.exec(line)?.[1] ?? ''
    const reason = /reason=(\S+)/.exec(line)?.[1] ?? 'unknown'
    epochStarts.push({ epoch, reason, cacheHit, reusedFrom: reused, hash, ts })
  } else if (line.includes('JEV_DECISION_EPOCH_END') && /\bcloseReason=\S/.test(line)) {
    epochEnds.push({
      epoch: Number(/epoch=(\d+)/.exec(line)?.[1] ?? -1),
      closeReason: /closeReason=(\S+)/.exec(line)?.[1] ?? 'unknown',
      commitmentId: /commitmentId=(\S+)/.exec(line)?.[1] ?? 'none',
      cacheHit: /cacheHit=true/.test(line),
    })
  } else if (line.includes('STALE_JEV_RESULT_DROPPED')) {
    staleDrops.push({ epoch: Number(/epoch=(\d+)/.exec(line)?.[1] ?? -1), activeEpoch: /activeEpoch=(\S+)/.exec(line)?.[1] ?? '', reason: /reason=(\S+)/.exec(line)?.[1] ?? '', ts })
  } else if (line.includes('SKILL_OUTCOME_PACKET')) {
    outcomePackets.push({
      actionId: /\b(?:candidateId|actionId)=(\S+)/.exec(line)?.[1] ?? '',
      terminalReason: /terminalReason=(\S+)/.exec(line)?.[1] ?? '',
      verified: /verified=true/.test(line),
      progress: /\bprogress=(\S+)/.exec(line)?.[1] ?? '',
      failure: /failure=(\S+)/.exec(line)?.[1] ?? null,
      ts,
    })
  } else if (line.includes('GENERATION_READY')) {
    generationReadies.push({
      runId: /runId=(\S+)/.exec(line)?.[1] ?? '', generationId: /generationId=(\S+)/.exec(line)?.[1] ?? '',
      sourceSha: /sourceSha=(\S+)/.exec(line)?.[1] ?? '', buildHash: /buildHash=(\S+)/.exec(line)?.[1] ?? '',
      provider: /policyProvider=(\S+)/.exec(line)?.[1] ?? '', profile: /policyProfile=(\S+)/.exec(line)?.[1] ?? '',
      model: /policyModel=(\S+)/.exec(line)?.[1] ?? '', planner: /planner=(\S+)/.exec(line)?.[1] ?? '',
      planAuthority: /productionPlanAuthority=(\S+)/.exec(line)?.[1] ?? '', ts,
    })
  } else if (line.includes('FATAL') || line.includes('terminate-resident')) {
    fatals.push({ ts, context: /context=(\S+)/.exec(line)?.[1] ?? '', line: line.slice(0, 220) })
  }
}

// ---- provider calls ---------------------------------------------------------
interface CallRow { ts: string; model: string; latencyMs: number; reason: string | null; inTok: number | null; action: string | null; actionConf: number | null; offered: number; declined: boolean; declineOffered: boolean; questionNames: string[]; abandonedP: number | null }
const calls: CallRow[] = []
const errors: { ts: string; error: string; reason: string | null }[] = []
for (const line of readFileSync(callsPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let r: Record<string, unknown>
  try { r = JSON.parse(line) } catch { continue }
  const ts = String(r.ts ?? '')
  if (!inWindow(ts)) continue
  if (typeof r.error === 'string' && r.error.length > 0) {
    errors.push({ ts, error: r.error.slice(0, 160), reason: (r.authority as Record<string, unknown> | undefined)?.decisionReason as string ?? null })
    continue
  }
  if (!r.state) continue
  const questions = (r.questions ?? {}) as Record<string, { type?: string; criteria?: Record<string, string> }>
  const actionQ = questions['action']
  const offered = actionQ?.criteria ? Object.keys(actionQ.criteria).length : 0
  const response = (r.response ?? {}) as { usage?: { inputTokens?: number }; answers?: Record<string, { value?: unknown; confidence?: number }> }
  const actionVal = response.answers?.['action']?.value
  calls.push({
    ts, model: String(r.model ?? ''), latencyMs: Number(r.latencyMs ?? 0),
    reason: ((r.authority as Record<string, unknown> | undefined)?.decisionReason as string) ?? null,
    inTok: response.usage?.inputTokens ?? null,
    action: typeof actionVal === 'string' ? actionVal : null,
    actionConf: response.answers?.['action']?.confidence ?? null,
    offered, declined: actionVal === 'DECLINE', declineOffered: offered === 2 && 'DECLINE' in (actionQ?.criteria ?? {}),
    questionNames: Object.keys(questions),
    abandonedP: typeof response.answers?.['abandon_option']?.value === 'number' ? response.answers['abandon_option'].value as number : null,
  })
}

// ---- report ------------------------------------------------------------------
const boundaryHist: Record<string, number> = {}
for (const e of epochStarts) boundaryHist[e.reason] = (boundaryHist[e.reason] ?? 0) + 1
const reasonHist: Record<string, number> = {}
for (const c of calls) reasonHist[c.reason ?? 'null'] = (reasonHist[c.reason ?? 'null'] ?? 0) + 1
const actionHist: Record<string, number> = {}
for (const c of calls) { const a = c.action === 'DECLINE' ? 'DECLINE' : (c.action?.split(':')[0] ?? 'null'); actionHist[a] = (actionHist[a] ?? 0) + 1 }
const terminalHist: Record<string, number> = {}
for (const o of outcomePackets) terminalHist[o.terminalReason] = (terminalHist[o.terminalReason] ?? 0) + 1

const toks = calls.map(c => c.inTok).filter((x): x is number => x !== null)
const lats = calls.map(c => c.latencyMs)
const epochsTotal = epochStarts.length
const replays = epochStarts.filter(e => e.cacheHit).length
const providerCalls = calls.length
const uniqueGens = new Set(generationReadies.map(g => g.generationId))
const singletonCalls = calls.filter(c => c.declineOffered)
const verifiedOutcomes = outcomePackets.filter(o => o.verified)
const progressed = outcomePackets.filter(o => !o.progress.startsWith('none'))

console.log(JSON.stringify({
  window: { since, until },
  provenance: generationReadies.map(g => ({ gen: g.generationId, sha: g.sourceSha.slice(0, 8), build: g.buildHash, provider: g.provider, profile: g.profile, model: g.model, planner: g.planner, planAuthority: g.planAuthority })),
  generationChurn: { generationReadyCount: generationReadies.length, uniqueGenerations: uniqueGens.size, fatals: fatals.length, fatalContexts: [...new Set(fatals.map(f => f.context))] },
  decisions: {
    providerCalls,
    epochsStarted: epochsTotal,
    replayedEpochs: replays,
    callsPerEpoch: epochsTotal > 0 ? +(providerCalls / epochsTotal).toFixed(3) : null,
    replayRate: epochsTotal > 0 ? +(replays / epochsTotal).toFixed(3) : null,
    staleResultDrops: staleDrops.length,
    epochBoundaryReasons: boundaryHist,
    callDecisionReasons: reasonHist,
    epochEnds: epochEnds.length,
    closeReasons: epochEnds.reduce<Record<string, number>>((m, e) => { m[e.closeReason] = (m[e.closeReason] ?? 0) + 1; return m }, {}),
  },
  tokens: { n: toks.length, mean: toks.length ? +(toks.reduce((a, b) => a + b, 0) / toks.length).toFixed(1) : null, p50: pct(toks, 50), p90: pct(toks, 90), max: toks.length ? Math.max(...toks) : null },
  latencyMs: { p50: pct(lats, 50), p90: pct(lats, 90), max: lats.length ? Math.max(...lats) : null },
  actions: actionHist,
  decline: { singletonOfferCalls: singletonCalls.length, declined: calls.filter(c => c.declined).length, declineOnMultiCandidate: calls.filter(c => c.declined && !c.declineOffered).length },
  abandonP: { n: calls.filter(c => c.abandonedP !== null).length, mean: (() => { const xs = calls.map(c => c.abandonedP).filter((x): x is number => x !== null); return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null })() },
  questionSets: [...new Set(calls.map(c => c.questionNames.join('+')))],
  progress: {
    outcomePackets: outcomePackets.length,
    verifiedTrue: verifiedOutcomes.length,
    nonzeroProgress: progressed.length,
    terminalReasons: terminalHist,
    distinctVerifiedActions: [...new Set(verifiedOutcomes.map(o => `${o.actionId.split(':')[0]}:${o.progress}`))].slice(0, 20),
  },
  errors: { count: errors.length, kinds: [...new Set(errors.map(e => e.error.slice(0, 60)))] },
}, null, 2))
