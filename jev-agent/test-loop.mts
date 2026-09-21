// test-loop.mts - deterministic proof of the "lookahead" mechanics, no bot,
// no network:
//
//   1. the batched question set is CORE + trigger-specific with the right primitives;
//   2. the trigger class selects the right question subset;
//   3. Boolean answers are read through the 0.30/0.70 uncertainty zone, never
//      through provider confidence;
//   4. the goal queue consumes a plan in order and advances on completion;
//   5. `evaluateSummonConditions` maps exception conditions to LLM summon reasons.
//
// Run: bun run loop-test
import type { Candidate } from './src/candidates.ts'
import { buildQuestions, AUTHORITATIVE_QUESTION_NAMES, QUESTION_NAMES, questionNamesFor, SAFETY_QUESTION_NAMES, SHADOW_QUESTION_NAMES } from './src/jev.ts'
import type { JevAnswer, JevQuestionType, JevResult } from './src/jev.ts'
import { DUPLICATE_GOAL_SKIPPED, GoalQueue } from './src/goalQueue.ts'
import { buildStubPlan, evaluateSummonConditions, LLM_SUMMON_REASONS } from './src/system2.ts'
import type { System2PlanRequest } from './src/system2.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []

function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

function mineCandidate(): Candidate {
  return {
    id: 'MINE:b6_63_-67',
    kind: 'MINE',
    label: 'mine oak_log at (6,63,-67), in reach, walk-up access',
    targetName: 'oak_log',
    target: { x: 6, y: 63, z: -67 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: 'axe',
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

function booleanAnswer(name: string, probability: number): JevAnswer {
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

function jevResult(shouldRetreatProbability: number | null): JevResult {
  return {
    callId: 'test-call',
    policy: 'typesafe',
    source: 'jev',
    model: 'typesafe-ai/jev',
    latencyMs: 410,
    usage: { inputTokens: 1166, outputTokens: 300, totalTokens: 1466 },
    answers: {
      action: {
        name: 'action',
        type: 'choice',
        value: 'MINE:b6_63_-67',
        probability: 0.9,
        confidence: 0.9,
        probabilities: { 'MINE:b6_63_-67': 0.9 },
        legend: null,
        note: null,
      },
      ...(shouldRetreatProbability === null ? {} : { should_retreat: booleanAnswer('should_retreat', shouldRetreatProbability) }),
    },
  }
}

function stubRequest(): System2PlanRequest {
  return {
    reason: 'queue_empty',
    detail: 'test',
    tick: 1,
    goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'oak_log', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
  }
}

addCase('batched questions: exactly two authoritative heads (action, abandon_option) + safety', () => {
  const questions = buildQuestions([mineCandidate()])
  const types: Record<string, JevQuestionType> = {}
  for (const name of QUESTION_NAMES) {
    const question = questions[name]
    if (question !== undefined) types[name] = question.type
  }
  const expected: Record<string, JevQuestionType> = {
    action: 'choice',
    abandon_option: 'boolean',
    danger: 'score',
    should_retreat: 'boolean',
  }
  const shadowAbsent = SHADOW_QUESTION_NAMES.every((name) => !(name in types))
  const pass =
    Object.keys(types).length === 4 &&
    AUTHORITATIVE_QUESTION_NAMES.length === 2 &&
    QUESTION_NAMES.every((name) => types[name] === expected[name]) &&
    Object.keys(questions.action?.criteria ?? {}).includes('MINE:b6_63_-67') &&
    shadowAbsent &&
    !('need_llm' in types) &&
    !('target' in types)
  return { pass, detail: `types=${JSON.stringify(types)} shadowAbsent=${shadowAbsent}` }
})

addCase('trigger class selects the authoritative heads + safety subset', () => {
  const core = questionNamesFor('core')
  const threat = questionNamesFor('threat')
  const stall = questionNamesFor('stall')
  const pass =
    core.length === AUTHORITATIVE_QUESTION_NAMES.length &&
    core.includes('action') &&
    core.includes('abandon_option') &&
    !core.includes('danger') &&
    !core.includes('should_retreat') &&
    SAFETY_QUESTION_NAMES.every((name) => threat.includes(name)) &&
    AUTHORITATIVE_QUESTION_NAMES.every((name) => threat.includes(name)) &&
    stall.length === AUTHORITATIVE_QUESTION_NAMES.length &&
    !stall.includes('danger') &&
    SHADOW_QUESTION_NAMES.every((name) => !(core as readonly string[]).includes(name) && !(threat as readonly string[]).includes(name) && !(stall as readonly string[]).includes(name))
  return {
    pass,
    detail: `core=[${core.join(',')}] threat=[${threat.join(',')}] stall=[${stall.join(',')}]`,
  }
})

addCase('Boolean strong true: P(true)=0.9 -> should_retreat adopted', async () => {
  const { shouldRetreatFrom } = await import('./src/jev.ts')
  const adopted = shouldRetreatFrom(jevResult(0.9))
  return { pass: adopted === true, detail: `P(true)=0.9 -> adopted=${adopted}` }
})

addCase('Boolean strong false: P(true)=0.1 -> not adopted', async () => {
  const { shouldRetreatFrom } = await import('./src/jev.ts')
  const adopted = shouldRetreatFrom(jevResult(0.1))
  return { pass: adopted === false, detail: `P(true)=0.1 -> adopted=${adopted}` }
})

addCase('Boolean uncertain: P(true)=0.5 -> keeps current action (not adopted)', async () => {
  const { booleanBand, shouldRetreatFrom } = await import('./src/jev.ts')
  const band = booleanBand(0.5)
  const adopted = shouldRetreatFrom(jevResult(0.5))
  return { pass: band === 'uncertain' && adopted === false, detail: `P(true)=0.5 band=${band} adopted=${adopted}` }
})

addCase('queue consumes the stub plan in order and completes on progress', () => {
  const queue = new GoalQueue()
  const plan = buildStubPlan(stubRequest())
  queue.applyPlan(plan, 'llm')
  const first = queue.state
  queue.markProgress(1)
  const second = queue.state
  const pass =
    first.depth === 4 &&
    first.current?.kind === 'collect' &&
    first.current.targetItem === 'oak_log' &&
    first.goals[1]?.targetItem === 'crafting_table' &&
    first.goals[3]?.targetItem === 'cobblestone' &&
    second.current?.targetItem === 'crafting_table' &&
    second.done === 1
  return {
    pass,
    detail: `first depth=${first.depth} current=${first.current?.description}; after completion current=${second.current?.description} done=${second.done}`,
  }
})

addCase('repeated ticks with unchanged state do NOT grow the queue depth', () => {
  const queue = new GoalQueue()
  const plan = [
    { kind: 'collect' as const, description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 },
    { kind: 'craft' as const, description: 'craft 1 x stone_pickaxe', targetItem: 'stone_pickaxe', requiredCount: 1 },
  ]
  queue.applyPlan(plan, 'llm', 'replace')
  const firstDepth = queue.state.depth
  const duplicates: string[] = []
  for (let tick = 0; tick < 5; tick += 1) {
    queue.applyPlan(plan, 'llm', 'continue', { onDuplicate: (line) => duplicates.push(line) })
  }
  const afterDepth = queue.state.depth
  const distinct = new GoalQueue()
  distinct.applyPlan(
    [
      { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 },
      { kind: 'collect', description: 'collect 6 x raw_iron', targetItem: 'raw_iron', requiredCount: 6 },
    ],
    'llm',
    'replace',
  )
  const pass =
    firstDepth === 2 &&
    afterDepth === 2 &&
    duplicates.length === 10 &&
    duplicates.every((line) => line.startsWith(DUPLICATE_GOAL_SKIPPED)) &&
    distinct.state.depth === 2
  return {
    pass,
    detail: `firstDepth=${firstDepth} afterRepeats=${afterDepth} duplicates=${duplicates.length} distinctCounts=${distinct.state.depth}`,
  }
})

addCase('summon conditions map to the 5 documented LLM reasons', () => {
  const all = evaluateSummonConditions({
    queueEmpty: true,
    needLlm: true,
    actionImpossible: true,
    unknownSituation: true,
    noProgress: true,
  })
  const none = evaluateSummonConditions({
    queueEmpty: false,
    needLlm: false,
    actionImpossible: false,
    unknownSituation: false,
    noProgress: false,
  })
  const pass =
    all.length === 5 &&
    LLM_SUMMON_REASONS.every((reason) => all.includes(reason)) &&
    none.length === 0
  return { pass, detail: `all=${all.join(',')} none=${none.length}` }
})

let failures = 0
process.stdout.write('lookahead loop - CORE + trigger-specific Jev + goal queue + LLM summon rules\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} loop cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
