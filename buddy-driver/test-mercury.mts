// test-mercury.mts - deterministic, no-network safety tests for MercurySystem2.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCorrectivePrompt,
  describeErrorFull,
  isBudgetExhaustedError,
  isRetryableMercuryAttempt,
  isRetryableModelError,
  isTimeoutError,
  MERCURY_ALLOWED_GOALS,
  MERCURY_DEFAULT_COUNT,
  mercuryCostUsd,
  mercuryGoalKind,
  mercuryRetryFeedback,
  mercuryStrategyLabel,
  mercuryTransportMode,
  MUSE_SPARK_MODEL,
  SYSTEM2_MODEL_DEFAULT,
  MercuryPlanValidationError,
  MercurySystem2,
  normalizeMercuryPlan,
  parseMercuryJsonText,
  plannedGoalsFromMercury,
  resolveMercuryEnablement,
  runMercuryAttempts,
  validateMercuryPlan,
} from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
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

// Mirrors the host logger's `event key=value ...` line format so assertions read
// the same strings the resident writes to buddy.log.
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
    reason: 'no_progress',
    detail: 'test',
    tick: 1,
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [outcome('WAIT'), outcome('WAIT'), outcome('WAIT')],
  }
}

function mercurySummary(): MercuryStateSummary {
  return {
    trigger: 'no_candidate',
    wakeReason: 'action_impossible',
    wakeDetail: 'test',
    rung: 'crafting_table',
    rungIndex: 1,
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 0,
    inventory: {},
    stations: { craftingTables: 0, furnaces: 0 },
    knownOres: [],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 0, current: null, hasImpossible: false },
    objective: { targetItem: 'crafting_table', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: ['stone', 'log'], craft: ['crafting_table'], smelt: ['charcoal'] },
  }
}

addCase('maps a valid patch plan onto PlannedGoal records', () => {
  const checked = validateMercuryPlan({
    op: 'patch',
    goals: [{ item: 'stone', count: 12 }],
    reason: 'need stone for the furnace',
  })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const goals = plannedGoalsFromMercury(checked.plan)
  const goal = goals[0]
  const pass =
    goals.length === 1 &&
    goal?.kind === 'collect' &&
    goal.targetItem === 'stone' &&
    goal.requiredCount === 12 &&
    goal.description === 'collect 12 x stone'
  return { pass, detail: JSON.stringify(goals) }
})

addCase('infers craft and smelt kinds from the grounded item', () => {
  const craft = mercuryGoalKind('stone_pickaxe')
  const smelt = mercuryGoalKind('iron_ingot')
  const collect = mercuryGoalKind('raw_iron')
  return {
    pass: craft === 'craft' && smelt === 'smelt' && collect === 'collect',
    detail: `craft=${craft} smelt=${smelt} collect=${collect}`,
  }
})

addCase('rejects motor-level / coordinate-like items', () => {
  const bad = validateMercuryPlan({ op: 'replace', goals: [{ item: 'raw iron at 12,64,8', count: 3 }], reason: 'bad' })
  const motor = validateMercuryPlan({ op: 'replace', goals: [{ item: 'MOVE', count: 1 }], reason: 'bad' })
  return { pass: !bad.ok && !motor.ok, detail: `${bad.ok ? 'accepted' : bad.error} | ${motor.ok ? 'accepted' : motor.error}` }
})

addCase('rejects ungrounded items', () => {
  const checked = validateMercuryPlan({ op: 'patch', goals: [{ item: 'imaginary_ore', count: 3 }], reason: 'x' })
  return { pass: !checked.ok, detail: checked.ok ? 'unexpectedly grounded' : checked.error }
})

addCase('abort requires an empty goal list', () => {
  const bad = validateMercuryPlan({ op: 'abort', goals: [{ item: 'stone', count: 1 }], reason: 'x' })
  const good = validateMercuryPlan({ op: 'abort', goals: [], reason: 'no executable recovery' })
  const goals = good.ok ? plannedGoalsFromMercury(good.plan) : ['invalid']
  return { pass: !bad.ok && good.ok && goals.length === 0, detail: `${bad.ok ? 'accepted' : bad.error}; goals=${goals.length}` }
})

addCase('rejects out-of-range counts and too many goals', () => {
  const zero = validateMercuryPlan({ op: 'patch', goals: [{ item: 'stone', count: 0 }], reason: 'x' })
  const huge = validateMercuryPlan({ op: 'patch', goals: [{ item: 'stone', count: 65 }], reason: 'x' })
  const many = validateMercuryPlan({
    op: 'patch',
    goals: Array.from({ length: 9 }, () => ({ item: 'stone', count: 1 })),
    reason: 'x',
  })
  return { pass: !zero.ok && !huge.ok && !many.ok, detail: `zero=${zero.ok} huge=${huge.ok} many=${many.ok}` }
})

addCase('strategy label encodes op + kind + item', () => {
  const checked = validateMercuryPlan({ op: 'patch', goals: [{ item: 'raw_iron', count: 3 }], reason: 'x' })
  const label = checked.ok ? mercuryStrategyLabel(checked.plan) : 'invalid'
  const empty = mercuryStrategyLabel({ op: 'continue', goals: [], reason: 'x' })
  return { pass: label === 'mercury_patch_collect_raw_iron' && empty === 'mercury_continue', detail: `${label} | ${empty}` }
})

addCase('cost table uses the gateway input/output rates', () => {
  const cost = mercuryCostUsd('inception/mercury-2.5', { inputTokens: 1000, outputTokens: 1000 })
  const expected = 1000 * 0.00000004 + 1000 * 0.00000015
  const unknown = mercuryCostUsd('some/unknown', { inputTokens: 1000, outputTokens: 1000 })
  return { pass: Math.abs(cost - expected) < 1e-12 && unknown === 0, detail: `cost=${cost} unknown=${unknown}` }
})

addCase('mercury is off by default and not enabled by key presence', () => {
  const previous = process.env.BUDDY_SYSTEM2
  delete process.env.BUDDY_SYSTEM2
  const dir = mkdtempSync(join(tmpdir(), 'mercury-test-'))
  const configPath = join(dir, 'system2.config.json')
  writeFileSync(configPath, '{"mercury":false}\n')
  const off = resolveMercuryEnablement('llm', configPath)
  const on = resolveMercuryEnablement('llm', join(dir, 'missing.json'))
  if (previous === undefined) delete process.env.BUDDY_SYSTEM2
  else process.env.BUDDY_SYSTEM2 = previous
  return { pass: !off.enabled && !on.enabled, detail: `off=${off.source} missing=${on.source}` }
})

addCase('env BUDDY_SYSTEM2=mercury enables it, deterministic planner overrides', () => {
  const previous = process.env.BUDDY_SYSTEM2
  process.env.BUDDY_SYSTEM2 = 'mercury'
  const enabled = resolveMercuryEnablement('llm', '/nonexistent.json')
  const overridden = resolveMercuryEnablement('deterministic', '/nonexistent.json')
  process.env.BUDDY_SYSTEM2 = 'off'
  const forcedOff = resolveMercuryEnablement('llm', '/nonexistent.json')
  if (previous === undefined) delete process.env.BUDDY_SYSTEM2
  else process.env.BUDDY_SYSTEM2 = previous
  return {
    pass: enabled.enabled && !overridden.enabled && !forcedOff.enabled,
    detail: `enabled=${enabled.source} deterministic=${overridden.source} off=${forcedOff.source}`,
  }
})

addCase('config file { mercury: true } enables it', () => {
  const previous = process.env.BUDDY_SYSTEM2
  delete process.env.BUDDY_SYSTEM2
  const dir = mkdtempSync(join(tmpdir(), 'mercury-test-'))
  const configPath = join(dir, 'system2.config.json')
  writeFileSync(configPath, '{"mercury":true}\n')
  const result = resolveMercuryEnablement('llm', configPath)
  if (previous === undefined) delete process.env.BUDDY_SYSTEM2
  else process.env.BUDDY_SYSTEM2 = previous
  return { pass: result.enabled, detail: result.source }
})


addCase('config file { system2: true } enables the generic System2 gateway', () => {
  const previous = process.env.BUDDY_SYSTEM2
  delete process.env.BUDDY_SYSTEM2
  const dir = mkdtempSync(join(tmpdir(), 'system2-test-'))
  const configPath = join(dir, 'system2.config.json')
  writeFileSync(configPath, '{"system2":true}\n')
  const result = resolveMercuryEnablement('llm', configPath)
  if (previous === undefined) delete process.env.BUDDY_SYSTEM2
  else process.env.BUDDY_SYSTEM2 = previous
  return { pass: result.enabled, detail: result.source }
})

addCase('allowed goal sets are disjoint and non-empty', () => {
  const collect = new Set(MERCURY_ALLOWED_GOALS.collect)
  const craft = new Set(MERCURY_ALLOWED_GOALS.craft)
  const smelt = new Set(MERCURY_ALLOWED_GOALS.smelt)
  let overlaps = 0
  for (const item of craft) if (collect.has(item) || smelt.has(item)) overlaps += 1
  for (const item of smelt) if (collect.has(item)) overlaps += 1
  return {
    pass: collect.size > 0 && craft.size > 0 && smelt.size > 0 && overlaps === 0,
    detail: `collect=${collect.size} craft=${craft.size} smelt=${smelt.size} overlaps=${overlaps}`,
  }
})

addCase('portal prerequisite capabilities are exposed without exposing frame semantics', () => {
  const flint = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'flint', count: 1 }], reason: 'portal ignition' })
  const steel = validateMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'craft', item: 'flint_and_steel', count: 1 }],
    reason: 'portal ignition',
  })
  const obsidian = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'obsidian', count: 10 }], reason: 'portal frame' })
  const frame = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'place', item: 'nether_portal', count: 1 }], reason: 'portal frame' })
  const pass = flint.ok && steel.ok && obsidian.ok && !frame.ok
  return {
    pass,
    detail: `flint=${flint.ok} steel=${steel.ok} obsidian=${obsidian.ok} frame=${frame.ok ? 'accepted' : frame.error}`,
  }
})


addCase('Muse Spark is the real default model id and uses the JSON-text transport', () => {
  const pass =
    SYSTEM2_MODEL_DEFAULT === 'meta/muse-spark-1.3-contributor' &&
    MUSE_SPARK_MODEL === SYSTEM2_MODEL_DEFAULT &&
    mercuryTransportMode(SYSTEM2_MODEL_DEFAULT) === 'json-text' &&
    mercuryTransportMode('muse-spark-1.3-contributor') === 'json-text'
  return { pass, detail: `default=${SYSTEM2_MODEL_DEFAULT} mode=${mercuryTransportMode(SYSTEM2_MODEL_DEFAULT)}` }
})

addCase('Muse Spark default does not inherit the old Mercury 20/h self-budget', async () => {
  const previousSystem2Model = process.env.BUDDY_SYSTEM2_MODEL
  const previousMercuryModel = process.env.BUDDY_MERCURY_MODEL
  const previousBudget = process.env.BUDDY_SYSTEM2_MAX_PER_HOUR
  delete process.env.BUDDY_SYSTEM2_MODEL
  delete process.env.BUDDY_MERCURY_MODEL
  delete process.env.BUDDY_SYSTEM2_MAX_PER_HOUR
  const dir = mkdtempSync(join(tmpdir(), 'muse-unbounded-'))
  let transportCalls = 0
  try {
    const system2 = new MercurySystem2({
      summarize: (request) => ({ ...mercurySummary(), recentFailures: [`tick:${request.tick}`] }),
      log: () => undefined,
      callsPath: join(dir, 'system2-calls.jsonl'),
      cachePath: join(dir, 'system2-cache.json'),
      resolveKey: () => ({ key: 'test-key', origin: 'test' }),
      transport: () => {
        transportCalls += 1
        return Promise.resolve({
          toolCalls: [{ input: { op: 'patch', goals: [{ kind: 'collect', item: 'stone', count: 1 }], reason: 'test' } }],
          usage: null,
        })
      },
    })
    for (let tick = 1; tick <= 21; tick += 1) {
      const request = planRequest()
      request.tick = tick
      await system2.tryRepair(request, 'no_candidate')
    }
    return {
      pass: system2.model === SYSTEM2_MODEL_DEFAULT && system2.provider === 'muse-spark' && transportCalls === 21,
      detail: `model=${system2.model} provider=${system2.provider} calls=${transportCalls}`,
    }
  } finally {
    if (previousSystem2Model === undefined) delete process.env.BUDDY_SYSTEM2_MODEL
    else process.env.BUDDY_SYSTEM2_MODEL = previousSystem2Model
    if (previousMercuryModel === undefined) delete process.env.BUDDY_MERCURY_MODEL
    else process.env.BUDDY_MERCURY_MODEL = previousMercuryModel
    if (previousBudget === undefined) delete process.env.BUDDY_SYSTEM2_MAX_PER_HOUR
    else process.env.BUDDY_SYSTEM2_MAX_PER_HOUR = previousBudget
  }
})

addCase('muse transport uses strict JSON text while Mercury keeps named tool calls', () => {
  const exact = parseMercuryJsonText('{"op":"patch","goals":[],"reason":"ok"}')
  const fenced = parseMercuryJsonText('reasoning\n```json\n{"op":"abort","goals":[],"reason":"blocked"}\n```')
  const malformed = parseMercuryJsonText('not a plan')
  const pass =
    mercuryTransportMode(MUSE_SPARK_MODEL) === 'json-text' &&
    mercuryTransportMode('inception/mercury-2.5') === 'tool-call' &&
    (exact as { op?: string } | null)?.op === 'patch' &&
    (fenced as { op?: string } | null)?.op === 'abort' &&
    malformed === null
  return { pass, detail: `muse=${mercuryTransportMode(MUSE_SPARK_MODEL)} mercury=${mercuryTransportMode('inception/mercury-2.5')} malformed=${malformed}` }
})

addCase('(a) a valid model plan that omits count is accepted and normalized, not rejected', () => {
  // Ground truth 2026-09-19T18:22:16Z: Mercury proposed this exact goal list and
  // the validator rejected it with `goal[1] collect needs a count in [1,64]`.
  const checked = validateMercuryPlan({
    op: 'replace',
    goals: [
      { kind: 'goto_resource', item: 'diamond' },
      { kind: 'collect', item: 'oak_log' },
      { kind: 'place', item: 'crafting_table' },
      { kind: 'craft', item: 'diamond_pickaxe' },
    ],
    reason: 'blocked obsidian; take the diamond route',
  })
  if (!checked.ok) return { pass: false, detail: `REJECTED (the exact 18:22 rejection): ${checked.error}` }
  const goals = plannedGoalsFromMercury(checked.plan)
  const pass =
    checked.plan.goals[1]?.count === MERCURY_DEFAULT_COUNT &&
    checked.plan.goals[3]?.count === MERCURY_DEFAULT_COUNT &&
    goals.length === 4 &&
    goals[0]?.kind === 'collect' &&
    goals[0]?.targetItem === 'diamond' &&
    goals[1]?.kind === 'collect' &&
    goals[1]?.targetItem === 'oak_log' &&
    goals[1]?.requiredCount === MERCURY_DEFAULT_COUNT &&
    goals[2]?.kind === 'place' &&
    goals[2]?.targetItem === 'crafting_table' &&
    goals[3]?.kind === 'craft' &&
    goals[3]?.targetItem === 'diamond_pickaxe'
  return { pass, detail: goals.map((goal) => `${goal.kind}:${goal.targetItem}x${goal.requiredCount}`).join(' -> ') }
})

addCase('(b) an explicit out-of-range count is still rejected with a clear error', () => {
  const zero = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 0 }], reason: 'x' })
  const tooBig = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 65 }], reason: 'x' })
  const fractional = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'collect', item: 'oak_log', count: 1.5 }], reason: 'x' })
  const reasons = [zero, tooBig, fractional].map((result) => (result.ok ? 'ACCEPTED' : result.error))
  const pass = !zero.ok && !tooBig.ok && !fractional.ok && reasons.every((reason) => reason.toLowerCase().includes('count'))
  return { pass, detail: reasons.join(' | ') }
})

addCase('(c) budget exhaustion is a distinct observable status, never a silent fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-budget-'))
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  let transportCalls = 0
  const mercury = new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath,
    cachePath: join(dir, 'mercury-cache.json'),
    maxPerHour: 0,
    resolveKey: () => ({ key: 'test-key', origin: 'test' }),
    transport: () => {
      transportCalls += 1
      return Promise.resolve({ toolCalls: [], usage: null })
    },
  })
  let thrown: unknown = null
  try {
    await mercury.tryRepair(planRequest(), 'no_candidate')
  } catch (error) {
    thrown = error
  }
  const records = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
  const status = records.find((record) => record.outcome === 'budget_exhausted')
  const silentFallback = records.some((record) => record.outcome === 'fallback')
  const budgetLog = logs.find((line) => line.startsWith('MERCURY_BUDGET_EXHAUSTED'))
  const deterministic = logs.some((line) => line.includes('deterministic'))
  const errorText = typeof status?.error === 'string' ? status.error : ''
  const pass =
    thrown instanceof FatalModelError &&
    thrown.context === 'mercury:no_candidate' &&
    thrown.reason.includes('hourly budget exhausted') &&
    transportCalls === 0 &&
    status !== undefined &&
    errorText.includes('hourly budget exhausted') &&
    budgetLog !== undefined &&
    !silentFallback &&
    !deterministic
  return {
    pass,
    detail: `thrown=${thrown instanceof FatalModelError ? thrown.reason : String(thrown)} transportCalls=${transportCalls} outcomes=${records.map((record) => String(record.outcome)).join(',')} budgetLog=${budgetLog !== undefined} silentFallback=${silentFallback} deterministic=${deterministic}`,
  }
})

addCase('retries only abort/timeout errors, never schema errors', () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const wrapper = new Error('outer', { cause: timeout })
  const status504 = Object.assign(new Error('bad gateway'), { statusCode: 504 })
  const schemaError = new Error('No object generated: response did not match schema')
  return {
    pass: isTimeoutError(timeout) && isTimeoutError(wrapper) && isTimeoutError(status504) && !isTimeoutError(schemaError),
    detail: `timeout=${isTimeoutError(timeout)} nested=${isTimeoutError(wrapper)} 504=${isTimeoutError(status504)} schema=${isTimeoutError(schemaError)}`,
  }
})

addCase('captures the full provider error (status + body + cause chain)', () => {
  const inner = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const gateway = Object.assign(new Error('GatewayResponseError: Invalid error response format'), {
    name: 'GatewayResponseError',
    statusCode: 504,
    url: 'https://ai-gateway.vercel.sh/v1/ai/language-model',
    responseBody: '{"error":"upstream timeout"}',
    cause: inner,
  })
  const detail = describeErrorFull(gateway) as Record<string, unknown>
  const cause = detail.cause as Record<string, unknown> | undefined
  return {
    pass:
      detail.statusCode === 504 &&
      detail.responseBody === '{"error":"upstream timeout"}' &&
      cause?.name === 'TimeoutError',
    detail: JSON.stringify(detail).slice(0, 260),
  }
})

addCase('counts a timeout retry at the provider boundary and on the final record', async () => {
  let providerCalls = 0
  const reservedAttempts: number[] = []
  const retryLogs: number[] = []
  const timeout = Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' })
  const result = await runMercuryAttempts({
    maxAttempts: 2,
    reserveAttempt: (attempt) => reservedAttempts.push(attempt),
    call: async () => {
      providerCalls += 1
      if (providerCalls === 1) throw timeout
      return 'plan'
    },
    isRetryable: isTimeoutError,
    onRetry: ({ attempt }) => retryLogs.push(attempt),
  })
  return {
    pass:
      result.ok &&
      result.result === 'plan' &&
      result.attempts === 2 &&
      result.failures === 1 &&
      result.attempts - 1 === 1 &&
      providerCalls === 2 &&
      JSON.stringify(reservedAttempts) === '[1,2]' &&
      JSON.stringify(retryLogs) === '[1]',
    detail: JSON.stringify({ result, providerCalls, reservedAttempts, retryLogs }),
  }
})

addCase('stops before a retry when the attempt budget is exhausted', async () => {
  let providerCalls = 0
  let budgetUsed = 0
  const timeout = Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' })
  const result = await runMercuryAttempts({
    maxAttempts: 2,
    reserveAttempt: () => {
      if (budgetUsed >= 1) throw new Error('hourly budget exhausted (1/h)')
      budgetUsed += 1
    },
    call: async () => {
      providerCalls += 1
      throw timeout
    },
    isRetryable: isTimeoutError,
    onRetry: () => undefined,
  })
  return {
    pass: !result.ok && result.attempts === 1 && result.failures === 1 && providerCalls === 1 && budgetUsed === 1,
    detail: JSON.stringify({ result, providerCalls, budgetUsed }),
  }
})

addCase('counts a first-attempt success without a retry', async () => {
  const result = await runMercuryAttempts({
    maxAttempts: 2,
    reserveAttempt: () => undefined,
    call: async () => 'plan',
    isRetryable: isTimeoutError,
    onRetry: () => undefined,
  })
  return {
    pass: result.ok && result.result === 'plan' && result.attempts === 1 && result.failures === 0 && result.attempts - 1 === 0,
    detail: JSON.stringify(result),
  }
})

addCase('retries rate-limit, 5xx and transport errors but not config or schema failures', () => {
  const checks = {
    rateLimit: isRetryableModelError(Object.assign(new Error('rate limited'), { statusCode: 429 })),
    serverError: isRetryableModelError(Object.assign(new Error('bad gateway'), { statusCode: 503 })),
    gatewayInternal: isRetryableModelError(Object.assign(new Error('boom'), { name: 'GatewayInternalServerError' })),
    transport: isRetryableModelError(new Error('fetch failed')),
    budgetConfig: isRetryableModelError(new Error('hourly budget exhausted (20/h)')),
    schema: isRetryableModelError(Object.assign(new Error('invalid plan'), { name: 'ZodError' })),
  }
  const pass =
    checks.rateLimit &&
    checks.serverError &&
    checks.gatewayInternal &&
    checks.transport &&
    !checks.budgetConfig &&
    !checks.schema
  return { pass, detail: JSON.stringify(checks) }
})

addCase('bounded attempts with the retryable predicate stop at maxAttempts on a 429', async () => {
  let calls = 0
  const result = await runMercuryAttempts({
    maxAttempts: 3,
    reserveAttempt: () => undefined,
    call: async () => {
      calls += 1
      throw Object.assign(new Error('rate limited'), { statusCode: 429 })
    },
    isRetryable: isRetryableModelError,
    onRetry: () => undefined,
  })
  const pass = !result.ok && result.attempts === 3 && calls === 3
  return { pass, detail: JSON.stringify({ result, calls }) }
})

addCase('corrective retry: attempt 2 gets the validation error and its corrected plan succeeds', async () => {
  const basePrompt = '{"trigger":"no_progress"}'
  const prompts: string[] = []
  const feedbacks: (string | null)[] = []
  // A genuinely invalid plan (ungrounded item), NOT a count-less plan: a missing
  // count is now normalized mechanically and must not be used as a rejection fixture.
  const invalidPlan = { op: 'patch', goals: [{ kind: 'collect', item: 'not_a_real_item', count: 2 }], reason: 'need it' }
  const correctedPlan = { op: 'patch', goals: [{ kind: 'collect', item: 'stone', count: 4 }], reason: 'need four stone' }
  let providerCalls = 0
  const result = await runMercuryAttempts({
    maxAttempts: 3,
    reserveAttempt: () => undefined,
    feedbackFor: mercuryRetryFeedback,
    isRetryable: isRetryableMercuryAttempt,
    onRetry: () => undefined,
    call: (context) => {
      feedbacks.push(context.feedback)
      const prompt = context.feedback === null ? basePrompt : buildCorrectivePrompt(basePrompt, context.feedback)
      prompts.push(prompt)
      providerCalls += 1
      const raw = providerCalls === 1 ? invalidPlan : correctedPlan
      const validated = validateMercuryPlan(raw)
      if (!validated.ok) throw new MercuryPlanValidationError(validated.error, raw)
      return Promise.resolve(validated.plan)
    },
  })
  const second = prompts[1] ?? ''
  const invalidCheck = validateMercuryPlan(invalidPlan)
  const expectedError = invalidCheck.ok ? 'unexpectedly accepted' : invalidCheck.error
  return {
    pass:
      result.ok &&
      result.attempts === 2 &&
      result.failures === 1 &&
      providerCalls === 2 &&
      prompts[0] === basePrompt &&
      !prompts[0]?.includes('CORRECTION REQUIRED') &&
      !invalidCheck.ok &&
      second.includes(expectedError) &&
      second.includes('CORRECTION REQUIRED') &&
      feedbacks[1] === expectedError &&
      result.result.goals[0]?.count === 4,
    detail: JSON.stringify({
      attempts: result.attempts,
      failures: result.failures,
      secondHasError: second.includes(expectedError),
      feedback: feedbacks[1] ?? null,
      goals: result.ok ? result.result.goals : null,
    }),
  }
})

addCase('all attempts invalid ends in the loud fatal with per-attempt audit, never a fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-exhaust-'))
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  const prompts: string[] = []
  // Out-of-range count stays a hard rejection (missing count no longer rejects).
  const invalidPlan = { op: 'patch', goals: [{ kind: 'collect', item: 'stone', count: 65 }], reason: 'need stone' }
  const mercury = new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath,
    cachePath: join(dir, 'mercury-cache.json'),
    maxPerHour: 10,
    resolveKey: () => ({ key: 'test-key', origin: 'test' }),
    transport: ({ prompt }) => {
      prompts.push(prompt)
      return Promise.resolve({ toolCalls: [{ input: invalidPlan }], usage: { inputTokens: 10, outputTokens: 5 } })
    },
  })
  let thrown: unknown = null
  try {
    await mercury.tryRepair(planRequest(), 'no_candidate')
  } catch (error) {
    thrown = error
  }
  const fatal = logs.find((line) => line.startsWith('FATAL'))
  const rejects = logs.filter((line) => line.startsWith('PLAN_REJECTED'))
  const records = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
  const rejected = records.filter((record) => record.outcome === 'plan_rejected')
  const fabricatedFallback = records.filter((record) => record.outcome === 'fallback').length
  const correctivePrompts = prompts.slice(1).filter((prompt) => prompt.includes('CORRECTION REQUIRED')).length
  const degraded = logs.some((line) => line.includes('deterministic'))
  return {
    pass:
      thrown instanceof FatalModelError &&
      thrown.context === 'mercury:no_candidate' &&
      thrown.reason.includes('invalid plan') &&
      fatal !== undefined &&
      fatal.includes('code=MODEL_UNAVAILABLE') &&
      prompts.length === 3 &&
      correctivePrompts === 2 &&
      rejects.length === 3 &&
      rejected.length === 3 &&
      fabricatedFallback === 0 &&
      rejected.every((record) => typeof record.error === 'string' && String(record.error).includes('invalid plan')) &&
      rejected.every((record) => record.outcome === 'plan_rejected') &&
      !degraded,
    detail: `thrown=${thrown instanceof FatalModelError ? thrown.context : String(thrown)} prompts=${prompts.length} corrective=${correctivePrompts} rejected=${rejected.length} rejects=${rejects.length} fabricatedFallback=${fabricatedFallback} fatal=${fatal ?? 'none'}`,
  }
})

let failures = 0
process.stdout.write('Mercury System 2 - bounded structured planner tests\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} Mercury cases passed\n`)
if (failures > 0) process.exit(1)
