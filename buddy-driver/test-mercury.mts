// test-mercury.mts - deterministic, no-network safety tests for MercurySystem2.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeErrorFull,
  isRetryableModelError,
  isTimeoutError,
  MERCURY_ALLOWED_GOALS,
  mercuryCostUsd,
  mercuryGoalKind,
  mercuryStrategyLabel,
  plannedGoalsFromMercury,
  resolveMercuryEnablement,
  runMercuryAttempts,
  validateMercuryPlan,
} from './mercury-system2.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
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
