#!/usr/bin/env bun
// tools/test-replay.mjs — fixture test for the #23 replay harness.
//
// Builds a small synthetic decision log + CAUSAL run log, runs both policies,
// and asserts the expected agreement/divergence counts and verified-outcome
// summary. Runs entirely offline; no LLM/server/network.
//
// Usage: bun tools/test-replay.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ABANDON_DECISION,
  DEFAULT_THRESHOLD,
  buildReport,
  evaluatePolicies,
  formatReport,
  loadCausal,
  loadDecisions,
  policyA,
  policyB,
  readBeta,
  summarizeVerifiedOutcomes,
} from './replay.mjs'

let checks = 0
let passed = 0
async function check(name, fn) {
  checks++
  try {
    await fn()
    passed++
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error && error.stack ? error.stack : String(error)}\n`)
    throw error
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-fixture-'))
const decisionsFile = path.join(tmp, 'decisions.jsonl')
const runFile = path.join(tmp, 'run.jsonl')

const decision = (overrides) => ({
  record: 'decision',
  decisionId: overrides.decisionId,
  ts: '2026-09-18T00:00:00.000Z',
  tick: overrides.tick,
  trigger: overrides.trigger ?? 'heartbeat',
  source: 'fallback',
  chainId: overrides.chainId ?? null,
  optionId: overrides.optionId ?? null,
  strategy: overrides.strategy ?? null,
  candidates: [],
  chosenAction: overrides.chosenAction,
  booleanEstimates: overrides.beta === undefined
    ? {}
    : { abandon_option: { probability: overrides.beta, atHalf: overrides.beta >= DEFAULT_THRESHOLD, threshold: DEFAULT_THRESHOLD, would: overrides.beta >= DEFAULT_THRESHOLD } },
  jev: { callId: overrides.callId ?? `call-${overrides.decisionId}`, source: 'fallback', policy: 'fallback', model: 'deterministic-local-fallback', latencyMs: 0, usage: null, answers: {}, dangerGate: null, trigger: overrides.trigger ?? 'heartbeat' },
  goalQueueState: { depth: 1, empty: false, current: null, pending: [] },
  llm: { called: false, runtimeCalls: 0, planCalls: 0 },
  inventory: {},
  calibration: [],
  result: overrides.result ?? null,
})

// Fixture: 6 comparable decisions + 1 without beta.
fs.writeFileSync(decisionsFile, [
  JSON.stringify(decision({ decisionId: 'd-001', tick: 1, beta: 0.2, chosenAction: 'MOVE:p1_2_3', optionId: 'collect:iron', chainId: 'c-1' })),
  JSON.stringify(decision({ decisionId: 'd-002', tick: 2, beta: 0.8, chosenAction: 'MOVE:p1_2_3', optionId: 'collect:iron', chainId: 'c-2' })),
  JSON.stringify(decision({ decisionId: 'd-003', tick: 3, beta: 0.9, chosenAction: ABANDON_DECISION, optionId: 'collect:iron', chainId: 'c-3' })),
  JSON.stringify(decision({ decisionId: 'd-004', tick: 4, beta: 0.5, chosenAction: 'WAIT', optionId: 'smelt:charcoal', chainId: null, result: { verified: false, status: 'failed', progress: 0 } })),
  JSON.stringify(decision({ decisionId: 'd-005', tick: 5, beta: 0.49, chosenAction: 'WAIT', optionId: 'smelt:charcoal', chainId: 'c-5' })),
  JSON.stringify(decision({ decisionId: 'd-006', tick: 6, chosenAction: 'MOVE:p9_9_9', optionId: 'collect:iron', chainId: 'c-6' })),
  JSON.stringify(decision({ decisionId: 'd-007', tick: 7, beta: 0.8, chosenAction: 'DIG:b3_4_5', optionId: 'collect:cobblestone', chainId: 'c-7' })),
  '{ this is not json',
  '',
].join('\n'), 'utf8')

fs.writeFileSync(runFile, [
  JSON.stringify({ record: 'agent-event', source: 'causal', detail: { record: 'causal', chainId: 'c-2', optionId: 'collect:iron', candidateId: 'MOVE:p1_2_3', actionId: 'MOVE:p1_2_3', verified: true, status: 'done', resource: null, progressDelta: 0 } }),
  JSON.stringify({ record: 'agent-event', source: 'causal', detail: { record: 'causal', chainId: 'c-7', optionId: 'collect:cobblestone', candidateId: 'DIG:b3_4_5', actionId: 'DIG:b3_4_5', verified: true, status: 'done', resource: 'cobblestone', progressDelta: 1 } }),
  JSON.stringify({ record: 'agent-event', source: 'other', detail: { record: 'other' } }),
].join('\n'), 'utf8')

async function main() {
  await check('readBeta returns probability+threshold', () => {
    const beta = readBeta(decision({ decisionId: 'x', tick: 1, beta: 0.7, chosenAction: 'WAIT' }))
    assert.deepEqual(beta, { probability: 0.7, threshold: DEFAULT_THRESHOLD })
  })

  await check('readBeta returns null without abandon_option', () => {
    assert.equal(readBeta({ booleanEstimates: {} }), null)
    assert.equal(readBeta({}), null)
  })

  await check('policyA records chosenAction and abandon verdict', () => {
    assert.deepEqual(policyA({ chosenAction: 'MOVE:p1_2_3' }), {
      policy: 'A:current-recorded', decision: 'MOVE:p1_2_3', verdict: 'continue', beta: null, threshold: null,
    })
    assert.equal(policyA({ chosenAction: ABANDON_DECISION }).verdict, 'abandon')
  })

  await check('policyB abandons exactly at beta >= threshold', () => {
    const at = decision({ decisionId: 'b1', tick: 1, beta: DEFAULT_THRESHOLD, chosenAction: 'WAIT' })
    const below = decision({ decisionId: 'b2', tick: 2, beta: DEFAULT_THRESHOLD - 0.01, chosenAction: 'WAIT' })
    assert.equal(policyB(at).decision, ABANDON_DECISION)
    assert.equal(policyB(at).verdict, 'abandon')
    assert.equal(policyB(below).decision, 'WAIT')
    assert.equal(policyB(below).verdict, 'continue')
    assert.equal(policyB(below).defined, true)
  })

  await check('policyB leaves records without beta undefined', () => {
    const result = policyB({ chosenAction: 'WAIT', booleanEstimates: {} })
    assert.equal(result.defined, false)
    assert.equal(result.decision, 'WAIT')
  })

  await check('policyB threshold override defeats recorded threshold', () => {
    const strict = policyB(decision({ decisionId: 'b3', tick: 3, beta: 0.8, chosenAction: 'MOVE:p' }), { threshold: 0.95 })
    assert.equal(strict.decision, 'MOVE:p')
    assert.equal(strict.verdict, 'continue')
    assert.equal(strict.threshold, 0.95)
  })

  await check('loadDecisions filters ticks and reports malformed lines', async () => {
    const all = await loadDecisions(decisionsFile, {})
    assert.equal(all.records.length, 7)
    assert.equal(all.total, 8)
    assert.equal(all.malformed, 1)
    const windowed = await loadDecisions(decisionsFile, { fromTick: 3, toTick: 6 })
    assert.deepEqual(windowed.records.map((r) => r.decisionId), ['d-003', 'd-004', 'd-005', 'd-006'])
    const lastTwo = await loadDecisions(decisionsFile, { last: 2 })
    assert.deepEqual(lastTwo.records.map((r) => r.decisionId), ['d-006', 'd-007'])
  })

  await check('evaluatePolicies counts agreements and divergences', async () => {
    const window = await loadDecisions(decisionsFile, {})
    const result = evaluatePolicies(window.records)
    assert.equal(result.comparable, 6)
    assert.equal(result.skippedNoBeta, 1)
    assert.equal(result.agree, 3)
    assert.equal(result.diverge, 3)
    assert.equal(result.agreementRate, 0.5)
    assert.equal(result.policyAAbandon, 1)
    assert.equal(result.policyBAbandon, 4)
    assert.deepEqual(result.divergences.map((d) => d.decisionId), ['d-002', 'd-004', 'd-007'])
    assert.deepEqual(result.divergences.map((d) => d.actionB), [ABANDON_DECISION, ABANDON_DECISION, ABANDON_DECISION])
  })

  await check('evaluatePolicies with strict threshold has zero divergences', async () => {
    const window = await loadDecisions(decisionsFile, {})
    const result = evaluatePolicies(window.records, { threshold: 0.95 })
    assert.equal(result.comparable, 6)
    assert.equal(result.agree, 6)
    assert.equal(result.diverge, 0)
    assert.equal(result.agreementRate, 1)
  })

  await check('summarizeVerifiedOutcomes joins CAUSAL and falls back to result', async () => {
    const window = await loadDecisions(decisionsFile, {})
    const causal = await loadCausal(runFile, { chainIds: new Set(['c-2', 'c-7']) })
    assert.equal(causal.byChain.size, 2)
    const result = evaluatePolicies(window.records)
    const byId = new Map(result.divergences.map((d) => [d.decisionId, d]))
    const d2 = summarizeVerifiedOutcomes(byId.get('d-002'), causal.byChain)
    assert.deepEqual(d2, { causalRecords: 1, verifiedTrue: 1, verifiedFalse: 0, positiveProgress: 0, statuses: { done: 1 }, source: 'causal' })
    const d4 = summarizeVerifiedOutcomes(byId.get('d-004'), causal.byChain)
    assert.deepEqual(d4, { causalRecords: 0, verifiedTrue: 0, verifiedFalse: 1, positiveProgress: 0, statuses: { failed: 1 }, source: 'decision.result' })
    const d7 = summarizeVerifiedOutcomes(byId.get('d-007'), causal.byChain)
    assert.deepEqual(d7, { causalRecords: 1, verifiedTrue: 1, verifiedFalse: 0, positiveProgress: 1, statuses: { done: 1 }, source: 'causal' })
  })

  await check('buildReport aggregates verified totals and formats', async () => {
    const window = await loadDecisions(decisionsFile, {})
    const causal = await loadCausal(runFile, {})
    const evaluation = evaluatePolicies(window.records)
    const report = buildReport({
      decisionFile: decisionsFile,
      records: window.records,
      decisionsTotal: window.total,
      decisionsMalformed: window.malformed,
      evaluation,
      causalByChain: causal.byChain,
      maxDivergences: 50,
    })
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.counts.agree, 3)
    assert.equal(report.counts.diverge, 3)
    assert.equal(report.counts.agreementRate, 0.5)
    assert.deepEqual(report.verifiedAfterDivergence, {
      divergences: 3,
      withVerifiedTrue: 2,
      withVerifiedFalse: 1,
      withPositiveProgress: 1,
      withoutCausalRecord: 0,
      sourcedFromCausal: 2,
      sourcedFromDecisionResult: 1,
    })
    const text = formatReport(report)
    assert.match(text, /agreement=3\/6 \(50\.0%\) divergences=3/)
    assert.match(text, /decision=d-002/)
  })
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  process.stdout.write(`replay fixture: ${passed}/${checks} checks passed (agreements=3/6, divergences=3)\n`)
}).catch((error) => {
  fs.rmSync(tmp, { recursive: true, force: true })
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
