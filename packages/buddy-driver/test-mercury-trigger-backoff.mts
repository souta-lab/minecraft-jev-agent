// test-mercury-trigger-backoff.mts - regression fixture for the semantic-budget
// burn defect (source `44a65ca`, m3-live).
//
// Measured live: ONE unchanged `collect 1 x raw_iron` stall re-fired the
// counter-shaped `wait_limit` trigger six times (once per generation restart),
// each consultation failing 3/3 transport attempts:
//
//   MERCURY_ATTEMPT trigger histogram: wait_limit=18, action_impossible=2, no_progress=1
//   mercury cache: 20/20 in window, 0 available
//   -> FATAL code=MODEL_UNAVAILABLE context=mercury:action_impossible error=budget_exhausted
//
// The trigger fired on a counter (the trailing WAIT streak) that the SAME stall
// keeps incrementing, and a consultation that produced no plan left the input
// unchanged, so every repeat was equally likely and cost another call.
//
// This fixture proves the owning-layer fix: repeat `wait_limit` consultations
// for an unchanged stall back off instead of costing one call each, while a
// fresh stall after progress still triggers immediately and the budget-exhausted
// fail-loud path is unchanged.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import {
  evaluateMercuryWaitLimitBackoff,
  mercuryWaitLimitBackoffDelayMs,
  MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS_DEFAULT,
  MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS_DEFAULT,
} from '../jev-agent/src/system2/escalation.ts'
import type { MercuryWaitLimitBackoffState } from '../jev-agent/src/system2/escalation.ts'
import { FatalModelError } from '../jev-agent/src/modelFailure.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2/service.ts'
import { isBudgetExhaustedError, MercurySystem2 } from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
import { PlannerBrain } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}
const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

const BASE = MERCURY_WAIT_LIMIT_BACKOFF_BASE_MS_DEFAULT
const MAX = MERCURY_WAIT_LIMIT_BACKOFF_MAX_MS_DEFAULT

function hostLog(sink: string[]): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail) => {
    const parts = Object.entries(detail ?? {}).map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}=${text}`
    })
    sink.push(`${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`)
  }
}

function waitOutcome(): System2Outcome {
  return { actionId: 'WAIT', status: 'done', failure: null, verified: true, detail: '', control: 'wait' }
}

/** Minimal well-formed QueuedGoal for the preserved queue head. */
function currentGoal(id: string, targetItem: string, optionId: string) {
  return {
    id,
    kind: 'collect' as const,
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    semanticOptionInstanceId: optionId,
    semanticOptionTemplateId: optionId,
    startCount: 0,
    haveCount: 0,
    status: 'pending' as const,
    origin: 'llm' as const,
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function waitLimitRequest(authorityEpoch = 0): System2PlanRequest {
  return {
    reason: 'no_progress',
    detail: 'WAIT chosen 8x with no verified progress',
    tick: 100,
    goalQueueState: {
      depth: 5,
      current: currentGoal('g3', 'raw_iron', 'goto:raw_iron'),
      empty: false,
      hasImpossible: false,
      done: 4,
      goals: [],
    },
    objective: { targetItem: 'raw_iron', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [waitOutcome(), waitOutcome(), waitOutcome(), waitOutcome(), waitOutcome(), waitOutcome()],
    requestContext: {
      requestId: 'req-backoff',
      queueRevision: 9,
      optionInstanceId: 'goto:raw_iron',
      optionTemplateId: 'goto:raw_iron',
      worldEpoch: 1,
      stateFingerprint: 'fp-stall',
      authorityEpoch,
    },
  }
}

function mercurySummary(trigger: MercuryStateSummary['trigger'] = 'wait_limit'): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger,
    wakeReason: 'no_progress',
    wakeDetail: 'WAIT chosen 8x with no verified progress',
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 3,
    inventory: { iron_pickaxe: 1 },
    stations: { craftingTables: 0, furnaces: 0 },
    knownOres: ['raw_iron'],
    recentFailures: ['WAIT:done'],
    consecutiveWait: 8,
    queue: { depth: 5, done: 4, current: 'collect 1 x raw_iron', hasImpossible: false },
    objective: { targetItem: 'raw_iron', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: {
      collect: ['raw_iron', 'log'],
      craft: ['crafting_table'],
      smelt: ['iron_ingot'],
      place: ['furnace'],
      goto_resources: ['raw_iron'],
      explore_modes: ['cave', 'surface'],
    },
  }
}

const fakeBot = {
  inventory: { items: () => [] },
  entity: { position: { x: 0, y: 61, z: 0 } },
  game: { dimension: 'minecraft:overworld' },
  health: 20,
  food: 20,
  registry: { blocksByName: {} },
  findBlocks: () => [],
} as unknown as Bot

const VALID_PLAN = {
  toolCalls: [{ input: { op: 'replace', goals: [{ kind: 'collect', item: 'raw_iron', count: 1 }], reason: 'recover' } }],
  usage: { inputTokens: 1, outputTokens: 1 },
}

// ---------------------------------------------------------------------------
// (a) N consecutive no-plan wait_limit consultations must not cost N calls
// ---------------------------------------------------------------------------

addCase('(a) six identical no-plan wait_limit consultations cost ONE ask', () => {
  let state: MercuryWaitLimitBackoffState | null = null
  const now = 1_700_000_000_000
  let allowed = 0
  for (let i = 0; i < 6; i += 1) {
    const decision = evaluateMercuryWaitLimitBackoff(state, {
      stallKey: 'goto:raw_iron|objective:raw_iron:1',
      waitStreak: 8,
      authorityEpoch: 0,
      now,
      baseMs: BASE,
      maxMs: MAX,
    })
    state = decision.state
    if (decision.allow) allowed += 1
  }
  return {
    pass: allowed === 1 && state?.consultations === 1,
    detail: `allowed=${allowed} consultations=${state?.consultations} (before: 6 asks)`,
  }
})

addCase('(a) the backoff is exponential and re-allows only after the wait', () => {
  const now = 1_700_000_000_000
  const key = 'goto:raw_iron|objective:raw_iron:1'
  const first = evaluateMercuryWaitLimitBackoff(null, { stallKey: key, waitStreak: 3, authorityEpoch: 0, now, baseMs: BASE, maxMs: MAX })
  assert.equal(first.allow, true)
  const tooEarly = evaluateMercuryWaitLimitBackoff(first.state, { stallKey: key, waitStreak: 4, authorityEpoch: 0, now: now + BASE - 1, baseMs: BASE, maxMs: MAX })
  const second = evaluateMercuryWaitLimitBackoff(tooEarly.state, { stallKey: key, waitStreak: 4, authorityEpoch: 0, now: now + BASE, baseMs: BASE, maxMs: MAX })
  // After two consultations the next wait is doubled.
  const stillWaiting = evaluateMercuryWaitLimitBackoff(second.state, { stallKey: key, waitStreak: 5, authorityEpoch: 0, now: now + BASE + 2 * BASE - 1, baseMs: BASE, maxMs: MAX })
  const third = evaluateMercuryWaitLimitBackoff(stillWaiting.state, { stallKey: key, waitStreak: 5, authorityEpoch: 0, now: now + BASE + 2 * BASE, baseMs: BASE, maxMs: MAX })
  return {
    pass:
      !tooEarly.allow &&
      tooEarly.waitMs === 1 &&
      second.allow &&
      second.reason === 'cooldown_elapsed' &&
      !stillWaiting.allow &&
      third.allow &&
      mercuryWaitLimitBackoffDelayMs(1, BASE, MAX) === BASE &&
      mercuryWaitLimitBackoffDelayMs(2, BASE, MAX) === 2 * BASE &&
      mercuryWaitLimitBackoffDelayMs(50, BASE, MAX) === MAX,
    detail: `first=${first.reason} tooEarly=${tooEarly.reason}/${tooEarly.waitMs}ms second=${second.reason} third=${third.reason}`,
  }
})

// ---------------------------------------------------------------------------
// (b) a fresh stall after progress still triggers immediately
// ---------------------------------------------------------------------------

addCase('(b) progress re-arms the gate immediately', () => {
  const now = 1_700_000_000_000
  const key = 'goto:raw_iron|objective:raw_iron:1'
  const first = evaluateMercuryWaitLimitBackoff(null, { stallKey: key, waitStreak: 3, authorityEpoch: 7, now, baseMs: BASE, maxMs: MAX })
  const suppressed = evaluateMercuryWaitLimitBackoff(first.state, { stallKey: key, waitStreak: 4, authorityEpoch: 7, now: now + 1000, baseMs: BASE, maxMs: MAX })
  const afterProgress = evaluateMercuryWaitLimitBackoff(suppressed.state, {
    stallKey: key,
    waitStreak: 3,
    authorityEpoch: 8,
    now: now + 1001,
    baseMs: BASE,
    maxMs: MAX,
  })
  const newOption = evaluateMercuryWaitLimitBackoff(suppressed.state, {
    stallKey: 'explore:cave|objective:raw_iron:1',
    waitStreak: 3,
    authorityEpoch: 7,
    now: now + 1002,
    baseMs: BASE,
    maxMs: MAX,
  })
  return {
    pass:
      !suppressed.allow &&
      afterProgress.allow &&
      afterProgress.reason === 'progress' &&
      newOption.allow &&
      newOption.reason === 'fresh_stall',
    detail: `suppressed=${suppressed.reason} afterProgress=${afterProgress.reason} newOption=${newOption.reason}`,
  }
})

// ---------------------------------------------------------------------------
// durability: the burn happened ACROSS generation restarts
// ---------------------------------------------------------------------------

addCase('durable: the backoff survives a generation restart (cache reload)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-trigger-backoff-'))
  const cachePath = join(dir, 'mercury-cache.json')
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const make = (): MercurySystem2 =>
    new MercurySystem2({
      summarize: () => mercurySummary(),
      log: () => undefined,
      callsPath,
      cachePath,
      resolveKey: () => ({ key: 'fixture', origin: 'fixture' }),
      transport: async () => VALID_PLAN,
    })
  const before = make()
  const first = before.evaluateWaitLimitTrigger({ request: waitLimitRequest(0), stallKey: 'goto:raw_iron|objective:raw_iron:1', now: 5_000 })
  // Simulate the FATAL restart: a brand-new generation reloads the same cache file.
  const after = make()
  const second = after.evaluateWaitLimitTrigger({ request: waitLimitRequest(0), stallKey: 'goto:raw_iron|objective:raw_iron:1', now: 5_500 })
  return {
    pass: first.allow && !second.allow && second.reason === 'unchanged_stall',
    detail: `first=${first.reason} second=${second.reason} waitMs=${second.waitMs}`,
  }
})

// ---------------------------------------------------------------------------
// planner wiring: a suppressed wait_limit never reaches the provider
// ---------------------------------------------------------------------------

addCase('planner: repeat wait_limit does not reach Mercury; progress does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-trigger-planner-'))
  const logs: string[] = []
  let transportCalls = 0
  const mercury = new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath: join(dir, 'mercury-calls.jsonl'),
    cachePath: join(dir, 'mercury-cache.json'),
    resolveKey: () => ({ key: 'fixture', origin: 'fixture' }),
    retries: 0,
    transport: async () => {
      transportCalls += 1
      throw new Error('GatewayInternalServerError: fixture transport failure')
    },
  })
  const planner = new PlannerBrain({
    bot: fakeBot,
    world: emptyWorldMemory(),
    log: hostLog(logs),
    mode: 'llm',
    mercury,
    maxAttempts: 1,
  })
  const capture = async (request: System2PlanRequest): Promise<FatalModelError | null> => {
    try {
      await planner.plan(request)
      return null
    } catch (error) {
      return error instanceof FatalModelError ? error : null
    }
  }
  const first = await capture(waitLimitRequest(0))
  const afterFirst = transportCalls
  const second = await capture(waitLimitRequest(0))
  const afterSecond = transportCalls
  const progressed = await capture(waitLimitRequest(1))
  const afterProgress = transportCalls
  const suppressed = logs.some((line) => line.startsWith('MERCURY_TRIGGER_SUPPRESSED trigger=wait_limit'))
  const backedOff = logs.some((line) =>
    line.startsWith('MERCURY_TRIGGER_BACKOFF trigger=wait_limit') &&
    /consecutiveNoPlan=\d+/.test(line) &&
    /waitMs=\d+/.test(line),
  )
  return {
    pass:
      first?.context === 'mercury:wait_limit' &&
      afterFirst === 1 &&
      afterSecond === 1 &&
      // The held request keeps the active semantic option without consulting a
      // second planner or falling through to the deterministic ladder.
      second === null &&
      progressed?.context === 'mercury:wait_limit' &&
      afterProgress === 2 &&
      suppressed &&
      backedOff,
    detail: `first=${first?.context} afterFirst=${afterFirst} second=${second?.context} afterSecond=${afterSecond} progressed=${progressed?.context} afterProgress=${afterProgress} suppressedMarker=${suppressed} backoffMarker=${backedOff}`,
  }
})

addCase('recovery planner bypasses wait_limit cooldown and cached plan for a fresh authority response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-recovery-wait-limit-'))
  const logs: string[] = []
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const cachePath = join(dir, 'mercury-cache.json')
  let providerCalls = 0
  const makeMercury = (requireFreshProviderDecision: boolean): MercurySystem2 => new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath,
    cachePath,
    resolveKey: () => ({ key: 'fixture', origin: 'fixture' }),
    requireFreshProviderDecision,
    retries: 0,
    transport: async () => {
      providerCalls += 1
      return VALID_PLAN
    },
  })
  const ordinaryPlanner = new PlannerBrain({
    bot: fakeBot,
    world: emptyWorldMemory(),
    log: hostLog(logs),
    mode: 'llm',
    mercury: makeMercury(false),
    maxAttempts: 1,
  })
  await ordinaryPlanner.plan(waitLimitRequest(0))
  assert.equal(providerCalls, 1)

  const recoveryPlanner = new PlannerBrain({
    bot: fakeBot,
    world: emptyWorldMemory(),
    log: hostLog(logs),
    mode: 'llm',
    mercury: makeMercury(true),
    maxAttempts: 1,
    requireFreshProviderDecision: true,
  })
  const recoveryLogStart = logs.length
  const recovered = await recoveryPlanner.plan(waitLimitRequest(0))
  const recoveryLogs = logs.slice(recoveryLogStart)
  assert.equal(providerCalls, 2, 'recovery consults the same Mercury provider after the persisted wait-limit cooldown')
  assert.notEqual(recovered.provenance?.intentSource, 'none')
  assert.notEqual(recovered.provenance?.intentSource, 'cached')
  assert.equal(recoveryLogs.some((line) => line.startsWith('SYSTEM2_WAIT_LIMIT_BYPASSED')), true)
  assert.equal(recoveryLogs.some((line) => line.startsWith('MERCURY_CACHE_BYPASSED')), true)
  return {
    pass: providerCalls === 2 && recovered.provenance?.intentSource !== 'none' && recovered.provenance?.intentSource !== 'cached',
    detail: `providerCalls=${providerCalls} intentSource=${recovered.provenance?.intentSource ?? null} waitBypass=${recoveryLogs.some((line) => line.startsWith('SYSTEM2_WAIT_LIMIT_BYPASSED'))} cacheBypass=${recoveryLogs.some((line) => line.startsWith('MERCURY_CACHE_BYPASSED'))}`,
  }
})

// ---------------------------------------------------------------------------
// fail-loud budget contract is unchanged when a call is genuinely allowed
// ---------------------------------------------------------------------------

addCase('budget_exhausted stays fail-loud after the backoff re-allows a call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-trigger-budget-'))
  const logs: string[] = []
  let transportCalls = 0
  const mercury = new MercurySystem2({
    summarize: (request) => ({
      ...mercurySummary(),
      objective: request.objective,
      queue: { ...mercurySummary().queue, current: request.goalQueueState.current?.description ?? null },
    }),
    log: hostLog(logs),
    callsPath: join(dir, 'mercury-calls.jsonl'),
    cachePath: join(dir, 'mercury-cache.json'),
    maxPerHour: 1,
    resolveKey: () => ({ key: 'fixture', origin: 'fixture' }),
    transport: async () => {
      transportCalls += 1
      return VALID_PLAN
    },
  })
  const firstRequest = waitLimitRequest(0)
  await mercury.tryRepair(firstRequest, 'no_progress')
  const secondRequest: System2PlanRequest = {
    ...waitLimitRequest(0),
    objective: { targetItem: 'log', requiredCount: 1, haveCount: 0, complete: false },
    goalQueueState: {
      ...waitLimitRequest(0).goalQueueState,
      current: currentGoal('g9', 'log', 'collect:log'),
    },
  }
  // A different stall is allowed by the gate immediately (fresh_stall)...
  const gate = mercury.evaluateWaitLimitTrigger({ request: secondRequest, stallKey: 'collect:log|objective:log:1', now: 9_000 })
  let thrown: unknown = null
  try {
    await mercury.tryRepair(secondRequest, 'wait_limit')
  } catch (error) {
    thrown = error
  }
  const budgetMarker = logs.some((line) => line.startsWith('MERCURY_BUDGET_EXHAUSTED'))
  return {
    pass:
      gate.allow &&
      gate.reason === 'fresh_stall' &&
      thrown instanceof FatalModelError &&
      thrown.context === 'mercury:wait_limit' &&
      thrown.reason.includes('budget_exhausted') &&
      isBudgetExhaustedError(thrown) &&
      budgetMarker &&
      transportCalls === 1,
    detail: `gate=${gate.reason} thrown=${thrown instanceof FatalModelError ? `${thrown.context}:${thrown.reason}` : String(thrown)} transportCalls=${transportCalls} marker=${budgetMarker}`,
  }
})

let failures = 0
process.stdout.write('Mercury wait_limit trigger backoff - semantic budget burn regression\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} trigger-backoff cases passed\n`)
if (failures > 0) process.exit(1)
