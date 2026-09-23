// test-no-silent-fallback.mts - owner directive: a model failure is LOUD.
//
// RED-FIRST guard: an unresolvable key / repeated model failure must raise a
// fatal error (and terminate the resident via the injected terminator), never
// degrade to a deterministic decision. The bounded retry count is respected.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import { JsonlWriter, createJevPolicy } from '../jev-agent/src/jev.ts'
import { FatalModelError, withModelRetries } from '../jev-agent/src/modelFailure.ts'
import type { System2PlanRequest } from '../jev-agent/src/system2.ts'
import { Advisor } from './advisor.ts'
import type { AdvisorState } from './advisor.ts'
import { MercurySystem2 } from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
import { PlannerBrain } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
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

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'no-silent-fallback-')), name)
}

function fatalPolicyOptions(forceFallback: boolean, resolveKey: () => null, writerPath: string) {
  return {
    writer: new JsonlWriter(writerPath),
    model: null,
    timeoutMs: 100,
    maxRetries: 3,
    rateLimitRetries: 0,
    rateLimitBaseDelayMs: 0,
    forceFallback,
    resolveKey,
  }
}

function makeBot(): Bot {
  return {
    inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    registry: { blocksByName: {} },
    findBlocks: () => [],
  } as unknown as Bot
}

function impossibleRequest(): System2PlanRequest {
  return {
    reason: 'action_impossible',
    detail: 'test',
    tick: 1,
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: true, done: 0, goals: [] },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
  }
}

function advisorState(): AdvisorState {
  return {
    rung: 'raw_iron',
    rungIndex: 7,
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    inventory: {},
    toolRank: 2,
    stations: { craftingTables: 1, furnaces: 1 },
    discoveredOres: ['iron_ore'],
    queueCurrent: 'collect 3 x raw_iron',
    queueDepth: 1,
    queueDone: 3,
    waitStreak: 8,
    failedCandidates: { WAIT: 3 },
    recentFailures: [],
  }
}

function mercurySummary(): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger: 'no_candidate',
    wakeReason: 'action_impossible',
    wakeDetail: 'test',
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 2,
    inventory: {},
    stations: { craftingTables: 1, furnaces: 1 },
    knownOres: ['iron_ore'],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 0, current: null, hasImpossible: true },
    objective: { targetItem: 'raw_iron', requiredCount: 3, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: ['stone'], craft: [], smelt: ['charcoal'] },
  }
}

addCase('createJevPolicy: unresolvable key is fatal, never a silent fallback', () => {
  let thrown: unknown = null
  try {
    createJevPolicy(fatalPolicyOptions(false, () => null, tempPath('jev.jsonl')))
  } catch (error) {
    thrown = error
  }
  return {
    pass:
      thrown instanceof FatalModelError &&
      thrown.context === 'jev-policy-key' &&
      thrown.message.includes('no gateway key resolved'),
    detail: thrown instanceof FatalModelError ? `context=${thrown.context} attempts=${thrown.attempts}` : `thrown=${String(thrown)}`,
  }
})

addCase('createJevPolicy: forceFallback is the explicit offline opt-in', () => {
  const policy = createJevPolicy(fatalPolicyOptions(true, () => null, tempPath('jev.jsonl')))
  return {
    pass: policy.kind === 'fallback',
    detail: `kind=${policy.kind} model=${policy.model}`,
  }
})

addCase('withModelRetries: bounded attempt count is respected, then fatal', async () => {
  let calls = 0
  let thrown: unknown = null
  try {
    await withModelRetries('unit-test', 3, async () => {
      calls += 1
      throw new Error(`boom ${calls}`)
    })
  } catch (error) {
    thrown = error
  }
  return {
    pass: thrown instanceof FatalModelError && thrown.attempts === 3 && calls === 3,
    detail: `calls=${calls} thrown=${thrown instanceof FatalModelError ? thrown.message : String(thrown)}`,
  }
})

addCase('PlannerBrain: repeated planner model failure fatals + terminates, no deterministic plan', async () => {
  const logs: string[] = []
  let terminated = 0
  const brain = new PlannerBrain({
    bot: makeBot(),
    world: emptyWorldMemory(),
    log: hostLog(logs),
    cachePath: tempPath('planner-cache.json'),
    mode: 'llm',
    maxAttempts: 3,
    resolveKey: () => null,
    terminate: (): never => {
      terminated += 1
      throw new Error('resident-terminated')
    },
  })
  let thrown: unknown = null
  try {
    await brain.plan(impossibleRequest())
  } catch (error) {
    thrown = error
  }
  const fatal = logs.find((line) => line.startsWith('FATAL'))
  const retries = logs.filter((line) => line.startsWith('PLANNER_RETRY'))
  const degraded = logs.some((line) => line.includes('deterministic ladder') || line.startsWith('PLANNER_FALLBACK'))
  return {
    pass:
      terminated === 1 &&
      thrown instanceof Error &&
      thrown.message === 'resident-terminated' &&
      fatal !== undefined &&
      fatal.includes('code=MODEL_UNAVAILABLE') &&
      fatal.includes('context=system2-unavailable') &&
      fatal.includes('attempts=3') &&
      !degraded,
    detail: `terminated=${terminated} fatal=${fatal ?? 'none'} retries=${retries.length} degraded=${degraded}`,
  }
})

addCase('Advisor: unresolvable key fatals + terminates, no deterministic decision', async () => {
  const logs: string[] = []
  let terminated = 0
  const advisor = new Advisor({
    log: hostLog(logs),
    cachePath: tempPath('advisor-cache.json'),
    mode: 'llm',
    maxAttempts: 3,
    resolveKey: () => null,
    terminate: (): never => {
      terminated += 1
      throw new Error('resident-terminated')
    },
  })
  let thrown: unknown = null
  try {
    await advisor.decide(advisorState(), 'wait_limit')
  } catch (error) {
    thrown = error
  }
  const fatal = logs.find((line) => line.startsWith('FATAL'))
  const degraded = logs.some((line) => line.startsWith('ADVISOR ') && line.includes('source=fallback'))
  return {
    pass:
      terminated === 1 &&
      thrown instanceof Error &&
      thrown.message === 'resident-terminated' &&
      fatal !== undefined &&
      fatal.includes('context=advisor-no-key') &&
      !degraded,
    detail: `terminated=${terminated} fatal=${fatal ?? 'none'} degraded=${degraded}`,
  }
})

addCase('MercurySystem2: unresolvable key fatals, never returns null', async () => {
  const logs: string[] = []
  let terminated = 0
  const mercury = new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath: tempPath('mercury-calls.jsonl'),
    cachePath: tempPath('mercury-cache.json'),
    maxPerHour: 0,
    resolveKey: () => null,
    terminate: (): never => {
      terminated += 1
      throw new Error('resident-terminated')
    },
  })
  let thrown: unknown = null
  try {
    await mercury.tryRepair(impossibleRequest(), 'no_candidate')
  } catch (error) {
    thrown = error
  }
  const fatal = logs.find((line) => line.startsWith('FATAL'))
  const degraded = logs.some((line) => line.includes('strategy=deterministic_ladder'))
  return {
    pass:
      terminated === 1 &&
      thrown instanceof Error &&
      thrown.message === 'resident-terminated' &&
      fatal !== undefined &&
      fatal.includes('context=mercury:no_candidate') &&
      !degraded,
    detail: `terminated=${terminated} fatal=${fatal ?? 'none'} degraded=${degraded}`,
  }
})

let failures = 0
process.stdout.write('No-silent-fallback (loud model failure) tests\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} loud-failure cases passed\n`)
if (failures > 0) process.exit(1)
