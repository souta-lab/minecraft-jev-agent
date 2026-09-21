// test-observability.mts - Issues #22 (beta shadow), #32 (raw Boolean
// probability) and #36 (end-to-end causal ids). Pure: no bot, no network, no
// model. It also prints the exact BETA_SHADOW and CAUSAL marker lines so the
// dry-run fixture is auditable.
import {
  ABANDON_THRESHOLD_DEFAULT,
  betaShadowDecision,
  booleanEstimate,
  booleanEstimates,
  formatBetaShadow,
  resolveAbandonThreshold,
} from './src/jev.ts'
import type { JevAnswer, JevPolicyKind, JevResult, JevSource } from './src/jev.ts'
import { gateDanger } from './src/gating.ts'
import { makeDecisionRecord } from './src/decisionlog.ts'
import type { DecisionJevLog, DecisionRecord } from './src/decisionlog.ts'
import { completeCausalChain, causalRecord, formatCausalLine, makeCausalStamp, optionIdForGoal, planRevisionForGoal } from './src/causal.ts'
import type { CausalGoalRef } from './src/causal.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function boolAnswer(name: string, probability: number): JevAnswer {
  return {
    name,
    type: 'boolean',
    value: probability,
    probability,
    confidence: null,
    probabilities: { true: probability, false: 1 - probability },
    legend: null,
    note: null,
  }
}

function choiceAnswer(name: string, id: string, probability: number): JevAnswer {
  return {
    name,
    type: 'choice',
    value: id,
    probability,
    confidence: probability,
    probabilities: { [id]: probability },
    legend: null,
    note: null,
  }
}

function decisionRecord(answers: Record<string, JevAnswer>): DecisionRecord {
  const policy: JevPolicyKind = 'typesafe'
  const source: JevSource = 'jev'
  const jev: DecisionJevLog = {
    policy,
    source,
    model: 'typesafe-ai/jev',
    callId: 'call-1',
    latencyMs: 100,
    usage: null,
    answers,
    dangerGate: gateDanger(answers.danger),
    trigger: 'start',
  }
  return makeDecisionRecord({
    decisionId: 'decision-1',
    tick: 1,
    trigger: 'start',
    stateHash: 'sha256:test',
    chainId: 'chain-1',
    optionId: 'collect:raw_iron',
    semanticOptionInstanceId: 'system2:front_raw_iron',
    strategy: 'llm:collect',
    candidates: [],
    failedCandidates: {},
    jev,
    chosenAction: 'MINE:b1_64_0',
    confidence: 0.8,
    dangerOverride: null,
    needLlm: null,
    needLlmAdopted: false,
    goalQueueState: { depth: 0, empty: true, current: null, pending: [] },
    llmResummon: { triggered: false, reason: null, detail: null },
    llm: { called: false, runtimeCalls: 0, planCalls: 0 },
    subgoal: null,
    inventory: {},
  })
}

const GOAL: CausalGoalRef = {
  id: 'g3:collect:raw_iron',
  kind: 'collect',
  description: 'collect 3 x raw_iron',
  targetItem: 'raw_iron',
  requiredCount: 3,
  origin: 'llm',
}

addCase('#32: raw 0.08 survives API parse -> result -> decision record JSONL', () => {
  const record = decisionRecord({ abandon_option: boolAnswer('abandon_option', 0.08) })
  const estimate = record.booleanEstimates.abandon_option
  const json = JSON.stringify(record)
  const pass =
    estimate !== undefined &&
    estimate.probability === 0.08 &&
    estimate.atHalf === false &&
    estimate.would === false &&
    estimate.threshold === ABANDON_THRESHOLD_DEFAULT &&
    json.includes('"probability":0.08') &&
    record.jev.answers.abandon_option?.value === 0.08
  return { pass, detail: `probability=${estimate?.probability} atHalf=${estimate?.atHalf} would=${estimate?.would} jsonHasRaw=${json.includes('"probability":0.08')}` }
})

addCase('#56: completion preserves the canonical semantic Option instance', () => {
  const record = decisionRecord({ abandon_option: boolAnswer('abandon_option', 0.08) })
  const chain = completeCausalChain(
    {
      chainId: record.chainId ?? 'missing',
      optionId: record.optionId,
      semanticOptionInstanceId: record.semanticOptionInstanceId,
      planId: record.goalQueueState.current?.id ?? 'g3:collect:raw_iron',
      strategy: record.strategy,
    },
    {
      candidateId: 'MINE:b1_64_0',
      actionId: 'MINE:b1_64_0',
      verified: true,
      status: 'done',
      progressDelta: 1,
      observable: true,
    },
  )
  const json = JSON.stringify(causalRecord(chain))
  const pass =
    chain.optionId === 'collect:raw_iron' &&
    chain.semanticOptionInstanceId === 'system2:front_raw_iron' &&
    json.includes('"semanticOptionInstanceId":"system2:front_raw_iron"')
  return { pass, detail: `option=${chain.optionId} semanticInstance=${chain.semanticOptionInstanceId}` }
})

addCase('#32: values around 0.5 stay distinguishable (0.01/0.49/0.51/0.99)', () => {
  const low = booleanEstimate(0.01, 0.5)
  const nearly = booleanEstimate(0.49, 0.5)
  const slightly = booleanEstimate(0.51, 0.5)
  const high = booleanEstimate(0.99, 0.5)
  const distinct = new Set([low?.probability, nearly?.probability, slightly?.probability, high?.probability]).size === 4
  const pass =
    low?.would === false &&
    nearly?.would === false &&
    slightly?.would === true &&
    high?.would === true &&
    nearly?.atHalf === false &&
    slightly?.atHalf === true &&
    distinct
  return { pass, detail: `0.01->${low?.would} 0.49->${nearly?.would} 0.51->${slightly?.would} 0.99->${high?.would} distinct=${distinct}` }
})

addCase('#32: named threshold is configurable and raw probability is never re-thresholded', () => {
  const configured = booleanEstimate(0.08, 0.05)
  const estimates = booleanEstimates({ abandon_option: boolAnswer('abandon_option', 0.08) }, { abandon_option: 0.05 })
  const pass = configured?.probability === 0.08 && configured.would === true && estimates.abandon_option?.probability === 0.08
  const old = process.env.BUDDY_ABANDON_THRESHOLD
  process.env.BUDDY_ABANDON_THRESHOLD = '0.05'
  const envResolved = resolveAbandonThreshold()
  if (old === undefined) delete process.env.BUDDY_ABANDON_THRESHOLD
  else process.env.BUDDY_ABANDON_THRESHOLD = old
  return { pass: pass && envResolved === 0.05, detail: `configured=${configured?.probability}/would=${configured?.would} envThreshold=${envResolved}` }
})

addCase('#22: beta 0.73 vs a continuing controller logs would=abandon actual=continue', () => {
  const shadow = betaShadowDecision({ optionId: 'collect:raw_iron', beta: 0.73, actualReplan: false })
  const line = formatBetaShadow(shadow)
  const expected = 'BETA_SHADOW option=collect:raw_iron beta=0.73 threshold=0.5 would=abandon actual=continue'
  return { pass: line === expected && shadow.agree === false, detail: line }
})

addCase('#22: beta 0.08 below threshold votes continue (raw value kept)', () => {
  const shadow = betaShadowDecision({ optionId: 'collect:raw_iron', beta: 0.08, actualReplan: false })
  const line = formatBetaShadow(shadow)
  return { pass: shadow.would === 'continue' && shadow.agree === true && line.includes('beta=0.08'), detail: line }
})

addCase('#22: raw beta is null-safe and never drives agreement', () => {
  const shadow = betaShadowDecision({ optionId: null, beta: null, actualReplan: true })
  const line = formatBetaShadow(shadow)
  return { pass: shadow.would === 'continue' && shadow.actual === 'abandon' && line.includes('option=null') && line.includes('beta=null'), detail: line }
})

addCase('#36: causal ids join option -> candidate -> action -> verify across stages', () => {
  const stamp = makeCausalStamp({ chainId: 'chain-1', goal: GOAL })
  const chain = completeCausalChain(stamp, {
    candidateId: 'MINE:b1_64_0',
    actionId: 'MINE:b1_64_0',
    verified: true,
    status: 'done',
    resource: 'raw_iron',
    progressDelta: 1,
  })
  const line = formatCausalLine(chain)
  const joins =
    stamp.chainId === chain.chainId &&
    stamp.optionId === chain.optionId &&
    stamp.planId === chain.planId &&
    stamp.strategy === chain.strategy &&
    chain.chainId === 'chain-1' &&
    line.includes('chain=chain-1') &&
    line.includes('option=collect:raw_iron') &&
    line.includes('plan=g3:collect:raw_iron') &&
    line.includes('strategy=llm:collect') &&
    line.includes('candidate=MINE:b1_64_0') &&
    line.includes('action=MINE:b1_64_0') &&
    line.includes('verified=true') &&
    line.includes('resource=raw_iron')
  const record = causalRecord(chain)
  return { pass: joins && record.record === 'causal' && record.verified === true, detail: line }
})

addCase('#36: missing parent links are explicit null, not inferred', () => {
  const stamp = makeCausalStamp({ chainId: 'chain-2', goal: null })
  const chain = completeCausalChain(stamp, { candidateId: null, actionId: null, verified: false, status: 'failed' })
  const line = formatCausalLine(chain)
  const pass =
    stamp.optionId === null &&
    stamp.planId === null &&
    line.includes('option=null') &&
    line.includes('candidate=null') &&
    line.includes('resource=null') &&
    line.includes('progressDelta=null') &&
    optionIdForGoal(null) === null &&
    planRevisionForGoal(null) === null
  return { pass, detail: line }
})

addCase('#36: option id matches the OptionSpec compiler for the same plan row', () => {
  const stamp = makeCausalStamp({ chainId: 'chain-3', goal: GOAL })
  const js = makeCausalStamp({ chainId: 'chain-4', goal: { ...GOAL, kind: 'craft', targetItem: 'iron_pickaxe', description: 'craft 1 x iron_pickaxe' } })
  const pass = stamp.optionId === 'collect:raw_iron' && js.optionId === 'craft:iron_pickaxe'
  return { pass, detail: `collect=${stamp.optionId} craft=${js.optionId}` }
})

let failures = 0
process.stdout.write('observability - raw probability (#32), beta shadow (#22), causal ids (#36)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}

const shadowSample = betaShadowDecision({ optionId: 'collect:raw_iron', beta: 0.73, actualReplan: false })
const chainSample = completeCausalChain(makeCausalStamp({ chainId: 'chain-1', goal: GOAL }), {
  candidateId: 'MINE:b1_64_0',
  actionId: 'MINE:b1_64_0',
  verified: true,
  status: 'done',
  resource: 'raw_iron',
  progressDelta: 1,
})
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write('fixture (one decision):\n')
process.stdout.write(`  ${formatBetaShadow(shadowSample)}\n`)
process.stdout.write(`  ${formatCausalLine(chainSample)}\n`)
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} observability cases passed\n`)
if (failures > 0) process.exit(1)
