// test-mercury-schema-recovery.mts - regression fixture for the live terminal
// failure of 2026-09-21T10:11Z (source 6ee333a, model meta/muse-spark-1.3-contributor):
//
//   MERCURY_ATTEMPT callId=mercury-1-mub33nuq attempt=1 .. trigger=action_impossible
//   PLAN_REJECTED  ... reason=schema:  Required   (path EMPTY, message "Required")
//   MERCURY_RETRY  attempt=1 nextAttempt=2 error=MercuryPlanValidationError: invalid plan: schema:  Required corrective=true
//   MERCURY_RETRY  attempt=2 nextAttempt=3 error=GatewayInternalServerError ...        corrective=false
//   PLAN_REJECTED  ... attempt=3 reason=schema:  Required
//   FATAL code=MODEL_UNAVAILABLE context=mercury:action_impossible attempts=3 error=invalid plan: schema:  Required
//
// Two independent gaps let one schema-shaped mistake become fatal:
//   1. `schema:  Required` had an EMPTY field path, because the rejection was
//      `validateMercuryPlan(undefined)` from a json-text response that contained
//      no parseable plan object. The corrective prompt therefore named nothing.
//   2. The attempt-2 transport failure erased the pending correction (feedbackFor
//      returned null), so attempt 3 was told nothing and repeated the mistake.
//
//   bun ./test-mercury-schema-recovery.mts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCorrectivePrompt,
  isRetryableMercuryAttempt,
  mercuryRetryFeedback,
  MercuryPlanValidationError,
  MercurySystem2,
  parseMercuryJsonTextDetailed,
  runMercuryAttempts,
  validateMercuryPlan,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryTransport, MercuryTransportRepair } from './mercury-system2.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { FatalModelError } from '../jev-agent/src/modelFailure.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

function hostLog(sink: string[]): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail) => {
    const parts = Object.entries(detail ?? {}).map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}=${text}`
    })
    sink.push(`${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`)
  }
}

function outcome(actionId: string): System2Outcome {
  return { actionId, status: 'ok', failure: null, verified: false, detail: '' }
}

function planRequest(): System2PlanRequest {
  return {
    reason: 'action_impossible',
    detail: 'test',
    tick: 1,
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: true, done: 0, goals: [] },
    objective: { targetItem: 'crafting_table', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [outcome('WAIT'), outcome('WAIT'), outcome('WAIT')],
  }
}

function mercurySummary(): MercuryStateSummary {
  return {
    trigger: 'action_impossible',
    wakeReason: 'action_impossible',
    wakeDetail: 'test',
    rung: 'crafting_table',
    rungIndex: 1,
    position: { x: 26, y: 63, z: 20 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 0,
    inventory: {},
    stations: { craftingTables: 0, furnaces: 0 },
    knownOres: [],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 0, current: null, hasImpossible: true },
    objective: { targetItem: 'crafting_table', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: ['stone', 'log', 'oak_log'], craft: ['crafting_table'], smelt: ['charcoal'] },
  }
}

/** Mirrors `defaultMercuryTransport`'s json-text branch (parse + repair report). */
function jsonTextTransport(text: string): MercuryTransport {
  return () => {
    const parsed = parseMercuryJsonTextDetailed(text)
    const repair: MercuryTransportRepair = {
      kind: 'json-text',
      shape: parsed.shape,
      objects: parsed.objects,
      chars: text.length,
    }
    if (parsed.value === null) return Promise.resolve({ toolCalls: [], usage: null, repairs: [repair] })
    return Promise.resolve({
      toolCalls: [{ input: parsed.value }],
      usage: { inputTokens: 1, outputTokens: 1 },
      repairs: parsed.shape === 'exact' ? [] : [repair],
    })
  }
}

function readRecords(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// (a) a plan object wrapped in prose / markdown / emitted twice is recovered
// ---------------------------------------------------------------------------
const wrappedResponse = [
  'I considered the state and drafted {"op":"patch","goals":[{"kind":"goto_resource","item":"diamond"}]} first,',
  'but the current goal is already blocked on the crafting table, so the final answer is:',
  '',
  '```json',
  '{',
  '  "op": "patch",',
  '  "goals": [{ "kind": "craft", "item": "crafting_table", "count": 1 }],',
  '  "reason": "place and use a crafting table first"',
  '}',
  '```',
  '',
  'This is the smallest change that unblocks progress.',
].join('\n')

addCase('(a) prose/markdown/draft-wrapped json-text is extracted and validated', () => {
  const parsed = parseMercuryJsonTextDetailed(wrappedResponse)
  const validated = validateMercuryPlan(parsed.value)
  const object = parsed.value as { op?: string } | null
  // The pre-change extractor took trimmed.slice(first '{', last '}' + 1), which
  // spans BOTH objects and is not valid JSON: exactly the `response: null` case.
  const legacySlice = wrappedResponse.slice(wrappedResponse.indexOf('{'), wrappedResponse.lastIndexOf('}') + 1)
  let legacyParsed = true
  try {
    JSON.parse(legacySlice)
  } catch {
    legacyParsed = false
  }
  return {
    pass: parsed.shape !== 'none' && object?.op === 'patch' && validated.ok,
    detail: `BEFORE legacyExtractorParsed=${legacyParsed}; AFTER shape=${parsed.shape} objects=${parsed.objects} op=${object?.op} validated=${validated.ok}`,
  }
})

addCase('(a2) validation is NOT weakened: bad counts and missing reason still reject', () => {
  const zero = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 0 }], reason: 'x' })
  const noReason = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 1 }] })
  const z = zero.ok ? null : zero.reject
  const n = noReason.ok ? null : noReason.reject
  return {
    pass:
      !zero.ok && !noReason.ok && z?.path === 'goals.0.count' && n?.path === 'reason' && n?.expected === 'string',
    detail: `zero=${zero.ok ? 'ACCEPTED' : `${z?.path} expected=${z?.expected}`} noReason=${noReason.ok ? 'ACCEPTED' : `${n?.path} expected=${n?.expected}`}`,
  }
})

// ---------------------------------------------------------------------------
// (b) a deterministic-able omitted field is filled and the plan is accepted
// ---------------------------------------------------------------------------
addCase(
  '(b) a prose-wrapped response missing count is repaired (MERCURY_FIELD_DEFAULT) and accepted',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-schema-b-'))
    const logs: string[] = []
    // count is omitted on the collect goal: the schema declares it optional and
    // code owns the mechanical minimum, so it must be filled, not rejected.
    const text =
      'Here is my plan.\n\n```json\n{"op":"patch","goals":[{"kind":"collect","item":"stone"}],"reason":"need stone"}\n```'
    const mercury = new MercurySystem2({
      summarize: () => mercurySummary(),
      log: hostLog(logs),
      callsPath: join(dir, 'mercury-calls.jsonl'),
      cachePath: join(dir, 'mercury-cache.json'),
      maxPerHour: 10,
      resolveKey: () => ({ key: 'test-key', origin: 'test' }),
      transport: jsonTextTransport(text),
    })
    const result = await mercury.tryRepair(planRequest(), 'action_impossible')
    const repaired = logs.find((line) => line.startsWith('MERCURY_JSON_TEXT_REPAIRED'))
    const filled = logs.find((line) => line.startsWith('MERCURY_FIELD_DEFAULT'))
    const rejected = logs.some((line) => line.startsWith('MERCURY_SCHEMA_REJECT'))
    const goals = result?.plan.goals ?? []
    return {
      pass:
        result !== null &&
        goals.length === 1 &&
        goals[0]?.requiredCount === 1 &&
        repaired !== undefined &&
        repaired.includes('shape=fenced') &&
        filled !== undefined &&
        filled.includes('path=goals.0.count') &&
        filled.includes('value=1') &&
        !rejected,
      detail: `goals=${goals.map((goal) => `${goal.kind}:${goal.targetItem}x${goal.requiredCount}`).join(',')} | ${repaired ?? 'no MERCURY_JSON_TEXT_REPAIRED'} | ${filled ?? 'no MERCURY_FIELD_DEFAULT'} | rejected=${rejected}`,
    }
  },
)

// ---------------------------------------------------------------------------
// (c) a response that grounds onto nothing is TYPED and non-fatal
//
// CONTRACT CHANGE (operator directive, 2026-09-22): the semantic layer speaks
// natural language, so "no plan object" is not a schema violation. The empty
// answer is a typed UNGROUNDED outcome that leaves WHAT to the next layer; the
// resident is not terminated and no corrective retry is burned. Genuine provider
// unavailability still fails loud (see test-no-silent-fallback.mts).
// ---------------------------------------------------------------------------
const unparsedTransport: MercuryTransport = () =>
  Promise.resolve({
    toolCalls: [],
    usage: null,
    repairs: [{ kind: 'json-text', shape: 'none', objects: 0, chars: 12 }],
  })

addCase('(c) an ungroundable/empty response is a typed UNGROUNDED outcome (no FATAL, no reject)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-schema-c-'))
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  const mercury = new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath,
    cachePath: join(dir, 'mercury-cache.json'),
    maxPerHour: 10,
    resolveKey: () => ({ key: 'test-key', origin: 'test' }),
    transport: unparsedTransport,
  })
  let thrown: unknown = null
  let result: Awaited<ReturnType<MercurySystem2['tryRepair']>> = null
  try {
    result = await mercury.tryRepair(planRequest(), 'action_impossible')
  } catch (error) {
    thrown = error
  }
  const records = readRecords(callsPath)
  const fatal = logs.find((line) => line.startsWith('FATAL'))
  const ungroundedMarker = logs.find((line) => line.startsWith('MERCURY_INTENT_UNGROUNDED'))
  const rejects = logs.filter((line) => line.startsWith('MERCURY_SCHEMA_REJECT'))
  const unparsed = logs.filter((line) => line.startsWith('MERCURY_JSON_TEXT_UNPARSED'))
  const ungroundedRecords = records.filter((record) => record.outcome === 'ungrounded')
  const fabricatedFallback = records.filter((record) => record.outcome === 'fallback').length
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.ungrounded !== undefined &&
      result.ungrounded.reason.length > 0 &&
      fatal === undefined &&
      ungroundedMarker !== undefined &&
      ungroundedMarker.includes('reason=empty_answer') &&
      rejects.length === 0 &&
      unparsed.length === 1 &&
      ungroundedRecords.length === 1 &&
      typeof ungroundedRecords[0]?.intent === 'string' &&
      fabricatedFallback === 0,
    detail: `thrown=${thrown === null ? 'none' : String(thrown)} ungrounded=${result?.ungrounded?.reason ?? 'none'} rejects=${rejects.length} unparsed=${unparsed.length} ungroundedRecords=${ungroundedRecords.length} fabricatedFallback=${fabricatedFallback} fatal=${fatal ?? 'none'}`,
  }
})

// ---------------------------------------------------------------------------
// (d) the live sequence: a transport failure must not erase the schema correction
// ---------------------------------------------------------------------------
addCase('(d) a transport error between attempts keeps the correction for the next attempt', async () => {
  const basePrompt = '{"trigger":"action_impossible"}'
  const prompts: string[] = []
  const feedbacks: (string | null)[] = []
  let providerCalls = 0
  const result = await runMercuryAttempts({
    maxAttempts: 3,
    reserveAttempt: () => undefined,
    feedbackFor: mercuryRetryFeedback,
    isRetryable: isRetryableMercuryAttempt,
    onRetry: () => undefined,
    call: (context) => {
      feedbacks.push(context.feedback)
      prompts.push(context.feedback === null ? basePrompt : buildCorrectivePrompt(basePrompt, context.feedback))
      providerCalls += 1
      if (providerCalls === 1) {
        // attempt 1: no plan object at all -> `schema:  Required` before the fix
        const validated = validateMercuryPlan(undefined)
        if (validated.ok) throw new Error('unexpectedly accepted undefined')
        throw new MercuryPlanValidationError(validated.error, undefined, validated.reject)
      }
      if (providerCalls === 2) {
        // attempt 2: the live GatewayInternalServerError, retryable, no correction of its own
        throw Object.assign(new Error('Service temporarily unavailable. Please try again shortly.'), {
          name: 'GatewayInternalServerError',
        })
      }
      const validated = validateMercuryPlan({
        op: 'patch',
        goals: [{ kind: 'craft', item: 'crafting_table', count: 1 }],
        reason: 'corrected after the explicit rejection',
      })
      if (!validated.ok) throw new MercuryPlanValidationError(validated.error, null, validated.reject)
      return Promise.resolve(validated.plan)
    },
  })
  const third = prompts[2] ?? ''
  const first = feedbacks[1] ?? null
  return {
    pass:
      result.ok &&
      providerCalls === 3 &&
      feedbacks[0] === null &&
      first !== null &&
      first.includes('schema: <root>') &&
      first.includes('no plan object was produced') &&
      feedbacks[2] === first &&
      third.includes('CORRECTION REQUIRED') &&
      third.includes('no plan object was produced') &&
      third.includes('named no grounded step'),
    detail: `BEFORE attempt3 corrective=false; AFTER attempt2Error=GatewayInternalServerError feedbacks=[${feedbacks.map((f) => (f === null ? 'null' : 'set')).join(',')}] attempt3CarriesCorrection=${third.includes('CORRECTION REQUIRED')} attempt1Feedback=${first === null ? 'null' : `"${first.slice(0, 80)}..."`} attempts=${result.attempts}`,
  }
})

let failures = 0
process.stdout.write('Mercury schema-recovery fixture (live failure 2026-09-21T10:11Z)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} mercury schema-recovery cases passed\n`)
if (failures > 0) process.exit(1)
