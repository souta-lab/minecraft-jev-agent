// test-question-heads.mts - JEV-BEST-PRACTICES §18 Gate D: concise independent
// parallel heads with documented consumers and deterministic gates.
//
// Contract under test (never calls a provider):
//   1. the trigger class resolves to an exact question set - core/stall ask
//      the authoritative pair only, threat adds the two safety heads, and no
//      shadow name can ever be requested;
//   2. `action` is the ONLY candidate Choice - the sole actuation authority;
//      beta is a Noul (WHETHER), the safety heads are Score/Noul evidence;
//   3. an unused or evidence-only head cannot execute: `decisionIdFrom` reads
//      only `answers.action`, and the authority kernel throws on a choice that
//      is not an offered grounded id;
//   4. all requested heads travel in ONE batched evaluate over one state;
//   5. route frames journal their own `jev-policy-input` authority, never
//      pi/beta Option authority;
//   6. the typed `decisionReason` (§7.1) is journaled on every call.
import assert from 'node:assert/strict'
import {
  AUTHORITATIVE_QUESTION_NAMES,
  QUESTION_NAMES,
  SAFETY_QUESTION_NAMES,
  SHADOW_QUESTION_NAMES,
  abandonRequested,
  buildQuestions,
  decisionIdFrom,
  questionNamesFor,
  shouldRetreatFrom,
} from './src/jev.ts'
import { AuthorityJevPolicy } from './src/jev/authority.ts'
import type { JevPolicyOptions, JevRequest, JevResult } from './src/jev/client.ts'
import type { Candidate } from './src/candidates.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_EPOCHS = readFileSync(join(HERE, 'src/decision-epochs.ts'), 'utf8')

function candidate(input: Partial<Candidate> & { id: string; kind: Candidate['kind'] }): Candidate {
  return {
    targetName: null, target: null, targetEntityId: null, itemName: null,
    requiresTool: false, toolName: null, inReach: false, hasStandableAdjacent: true,
    label: input.id, meta: {}, ...input,
  } as Candidate
}

const MINE = candidate({ id: 'MINE:b1_2_3', kind: 'MINE', label: 'mine stone' })
const WAIT = candidate({ id: 'WAIT', kind: 'WAIT' })

// --- 1. exact question sets per trigger class; shadow names unreachable. ---
assert.deepEqual(questionNamesFor('core'), ['action', 'abandon_option'])
assert.deepEqual(questionNamesFor('stall'), ['action', 'abandon_option'])
assert.deepEqual(questionNamesFor('threat'), ['action', 'abandon_option', 'danger', 'should_retreat'])
assert.deepEqual(questionNamesFor('all'), [...AUTHORITATIVE_QUESTION_NAMES, ...SAFETY_QUESTION_NAMES])
for (const shadow of SHADOW_QUESTION_NAMES) {
  assert.ok(!(QUESTION_NAMES as readonly string[]).includes(shadow), `shadow head ${shadow} is requestable`)
}
// A request naming only shadow heads emits zero questions - they cannot execute.
const shadowOnly = buildQuestions([MINE, WAIT], ['goal_progress' as never])
assert.deepEqual(Object.keys(shadowOnly), [], 'shadow heads cannot be sent')

// --- 2. `action` is the ONLY candidate Choice; every other head is bounded. ---
const questions = buildQuestions([MINE, WAIT], questionNamesFor('threat'))
assert.deepEqual(Object.keys(questions).sort(), ['abandon_option', 'action', 'danger', 'should_retreat'])
assert.equal(questions.action?.type, 'choice')
assert.equal(questions.abandon_option?.type, 'boolean')
assert.equal(questions.danger?.type, 'score')
assert.equal(questions.should_retreat?.type, 'boolean')
const criteria = (questions.action as { criteria: Record<string, string> }).criteria
assert.deepEqual(Object.keys(criteria).sort(), ['MINE:b1_2_3', 'WAIT'], 'action criteria name exactly the offered grounded ids')

// --- 3. evidence-only heads cannot execute. ---
const safetyOnly = {
  callId: 'c1', policy: 'typesafe', source: 'jev', model: 'm', latencyMs: 1, usage: null,
  answers: {
    danger: { name: 'danger', type: 'score', value: 4, probability: null, confidence: 0.9, probabilities: null, legend: null, note: null },
    should_retreat: { name: 'should_retreat', type: 'boolean', value: 1, probability: 0.99, confidence: null, probabilities: null, legend: null, note: null },
  },
} as unknown as JevResult
assert.equal(decisionIdFrom(safetyOnly), null, 'a safety-only answer authorizes nothing')
assert.equal(shouldRetreatFrom(safetyOnly), true, 'retreat evidence still reads as a band')

const busyAction = {
  callId: 'c2', policy: 'typesafe', source: 'jev', model: 'm', latencyMs: 1, usage: null,
  answers: {
    action: { name: 'action', type: 'choice', value: 'MINE:b1_2_3', probability: 0.8, confidence: 0.8, probabilities: null, legend: null, note: null },
    abandon_option: { name: 'abandon_option', type: 'boolean', value: 0, probability: 0.1, confidence: null, probabilities: null, legend: null, note: null },
  },
} as unknown as JevResult
assert.equal(decisionIdFrom(busyAction), 'MINE:b1_2_3')
assert.equal(abandonRequested(busyAction, 0.5), false, 'beta WHETHER does not select WHICH')

// --- 4/5/6. one batched evaluate, route-frame authority, decisionReason journal. ---
const records: Record<string, unknown>[] = []
let evalArgs: { state: unknown; questions: Record<string, unknown> } | null = null
const policy = new AuthorityJevPolicy(
  {
    writer: { path: 'test', write: (record: unknown) => records.push(record as Record<string, unknown>) },
    model: 'liquid/d1',
    timeoutMs: 1000,
    maxRetries: 0,
    rateLimitRetries: 0,
    rateLimitBaseDelayMs: 1,
  } as unknown as JevPolicyOptions,
  { key: 'fixture', origin: 'test' },
  {
    evaluate: (async (args: { state: unknown; questions: Record<string, unknown> }) => {
      evalArgs = args
      return {
        answers: {
          action: { choice: 'WAIT', probabilities: { 'MINE:b1_2_3': 0.1, WAIT: 0.9 } },
          abandon_option: { probability: 0.2 },
          danger: { score: 1, probabilities: {} },
          should_retreat: { probability: 0.1 },
        },
        providerMetadata: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    }) as never,
    sleep: async () => {},
    random: () => 0.5,
  },
)

const request = {
  stage: 'head-contract-test',
  candidates: [MINE, WAIT],
  questionNames: questionNamesFor('threat'),
  decisionReason: 'safety_changed',
  state: {
    tick: 1,
    self: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
    signals: {},
    inventory: { counts: {} },
    goal: null,
    goalQueue: { depth: 0, empty: true, current: null },
    currentOption: null,
    recentOutcomes: [],
    blocks: [],
    entities: [],
    recentEvents: [],
  },
} as unknown as JevRequest
await policy.decide(request)

// ONE batched evaluate carried all four heads against one state.
assert.ok(evalArgs !== null, 'one evaluate call ran')
assert.deepEqual(Object.keys((evalArgs as unknown as { questions: object }).questions).sort(),
  ['abandon_option', 'action', 'danger', 'should_retreat'])
const record = records[0] as Record<string, unknown>
assert.equal((record.authority as Record<string, unknown>).decisionReason, 'safety_changed', 'typed reason journaled')
assert.equal((record.authority as Record<string, unknown>).pi, 'model')
assert.equal((record.authority as Record<string, unknown>).beta, 'model')

// Route frame: journaled as a scoped policy input, never pi/beta Option authority.
records.length = 0
const routeRequest = {
  ...request,
  questionNames: ['action'] as const,
  decisionReason: 'route_frame',
  decisionFrame: { kind: 'vtr-reach-route', instructions: 'route', context: { leg: 1 } },
} as unknown as JevRequest
await policy.decide(routeRequest)
const routeRecord = records[0] as Record<string, unknown>
const routeAuthority = routeRecord.authority as Record<string, unknown>
assert.equal(routeAuthority.pi, undefined, 'a route frame is not pi authority')
assert.equal(routeAuthority.beta, undefined, 'a route frame is not beta authority')
assert.deepEqual(
  (routeAuthority.decisionFrame as Record<string, unknown>).questionAuthorities,
  { action: 'jev-policy-input' },
)
assert.equal(routeAuthority.decisionReason, 'route_frame')

// An invented (non-offered) action id is rejected before any commitment.
let threw = false
try {
  const badPolicy = new AuthorityJevPolicy(
    { writer: { path: 'test', write: () => {} }, model: 'liquid/d1', timeoutMs: 1000, maxRetries: 0, rateLimitRetries: 0, rateLimitBaseDelayMs: 1 } as unknown as JevPolicyOptions,
    { key: 'fixture', origin: 'test' },
    {
      evaluate: (async () => ({
        answers: { action: { choice: 'MINE:b99_99_99' } },
        providerMetadata: {},
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })) as never,
      sleep: async () => {},
      random: () => 0.5,
    },
  )
  await badPolicy.decide(request)
} catch {
  threw = true
}
assert.ok(threw, 'a choice outside the grounded offer is a failure, never an action')

// --- no singleton bypass: the source keeps the documented non-bypass and
// never short-circuits a lone-candidate offer past the model. ---
assert.ok(SRC_EPOCHS.includes('candidates.length === 1` is deliberately NOT'), 'singleton non-bypass marker missing')
const decideBody = SRC_EPOCHS.slice(SRC_EPOCHS.indexOf('export async function decide('), SRC_EPOCHS.indexOf('export async function decide(') + 8000)
assert.ok(!/candidates\.length === 1\s*[?&{:]/.test(decideBody) && !decideBody.includes('return without calling'), 'no singleton early return inside decide()')

process.stdout.write('question-heads (§18 Gate D): PASS\n')
