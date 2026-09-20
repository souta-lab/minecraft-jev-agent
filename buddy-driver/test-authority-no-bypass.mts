// test-authority-no-bypass.mts - #226 RED-first semantic-authority regressions.
//
// The owner contract: deterministic code may enumerate candidates, provide world
// truth / hard safety / mechanically-valid affordances / verification, and
// execute an already-selected Skill. In llm mode Mercury/Jev SELECTS; code must
// never override, substitute, or pre-empt that selection. A missing model key is
// deliberately used as a tripwire: if a semantic path actually reaches System2
// model authority it MUST fail loudly. Returning a deterministic plan instead
// proves that code bypassed the model.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import { FatalModelError } from '../jev-agent/src/modelFailure.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2.ts'
import {
  PLANNER_CACHE_SCHEMA_VERSION,
  PlannerBrain,
  plannerCapabilityHash,
  plannerStateHash,
  plannerWorldKeyString,
} from './planner.ts'
import type { PlannerEvaluate, PlannerWorldKey } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'

function makeBot(y = 20): Bot {
  return {
    inventory: { items: () => [] },
    entity: { position: { x: 0, y, z: 0 } },
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    registry: { blocksByName: {} },
    findBlocks: () => [],
  } as unknown as Bot
}

function cachePath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `authority-${label}-`)), 'planner-cache.json')
}

function request(
  reason: System2PlanRequest['reason'],
  overrides: Partial<System2PlanRequest> = {},
): System2PlanRequest {
  return {
    reason,
    detail: 'authority fixture',
    tick: 1,
    // done=1 prevents mapReason from treating an empty queue as the initial
    // bootstrap `start`; this is a genuine post-plan queue_empty boundary.
    goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 1, goals: [] },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
    ...overrides,
  }
}

function waits(n: number): System2Outcome[] {
  return Array.from({ length: n }, () => ({ actionId: 'WAIT', status: 'ok', failure: null, verified: false, detail: '' }))
}

function brain(label: string, y = 20): PlannerBrain {
  return new PlannerBrain({
    bot: makeBot(y),
    world: emptyWorldMemory(),
    log: () => undefined,
    cachePath: cachePath(label),
    mode: 'llm',
    maxAttempts: 1,
    resolveKey: () => null,
  })
}

function modelBrain(label: string, evaluate: PlannerEvaluate): PlannerBrain {
  return new PlannerBrain({
    bot: makeBot(),
    world: emptyWorldMemory(),
    log: () => undefined,
    cachePath: cachePath(label),
    mode: 'llm',
    maxAttempts: 1,
    resolveKey: () => ({ key: 'fixture-gateway-key', origin: 'authority fixture' }),
    evaluate,
  })
}

function choiceStub(choice: string | null): PlannerEvaluate {
  return async () => ({
    answers: {
      horizon: choice === null ? {} : { type: 'choice', choice },
      plan_fit: { type: 'score', score: 3 },
      strategy_change: { type: 'boolean', probability: 0.1 },
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  })
}

interface Observation {
  pass: boolean
  observed: string
}

async function observePlan(run: () => Promise<unknown>): Promise<Observation> {
  let thrown: unknown = null
  let returned: unknown = null
  try {
    returned = await run()
  } catch (error) {
    thrown = error
  }
  const pass = thrown instanceof FatalModelError
  return {
    pass,
    observed: thrown instanceof Error ? thrown.message : `returned deterministic plan ${JSON.stringify(returned)}`,
  }
}

async function mustReachModelBoundary(planner: PlannerBrain, input: System2PlanRequest): Promise<Observation> {
  return observePlan(() => planner.plan(input))
}

// Fixture 1/2: a semantic boundary must reach the model, never a deterministic plan.
async function queueEmptyBoundary(): Promise<Observation> {
  return mustReachModelBoundary(brain('queue-empty'), request('queue_empty'))
}

async function capabilityGapBoundary(): Promise<Observation> {
  return mustReachModelBoundary(
    brain('capability-gap', 20),
    request('no_progress', {
      goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 1, goals: [] },
      recentEvents: ['CAPABILITY_GAP reason=ascend_blocked attempts=3 target_y=80'],
    }),
  )
}

// Fixture 3: waitStreak >= 3 (`stalled`) must not discard the model's choice and
// substitute the deterministic body-change option.
async function stalledKeepsModelChoice(): Promise<Observation> {
  const chosen = 'two_rungs'
  const planner = modelBrain('stalled', choiceStub(chosen))
  const plan = await planner.plan(
    request('no_progress', {
      goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 1, goals: [] },
      recentOutcomes: waits(3),
    }),
  )
  const modelWon = plan.note === `llm chose ${chosen}`
  const deterministicBodyChange = plan.note.includes('body_change') || plan.goals.some((goal) => goal.targetItem === 'raw_iron')
  return {
    pass: modelWon && !deterministicBodyChange,
    observed: `note=${plan.note} goals=[${plan.goals.map((goal) => goal.targetItem ?? goal.kind).join(',')}]`,
  }
}

// Fixture 4: a cache entry whose id left the horizon is a cache miss, not an
// authority. The path must go to the model (here: the missing-key tripwire).
async function staleCacheGoesToModel(): Promise<Observation> {
  const dir = mkdtempSync(join(tmpdir(), 'authority-stale-'))
  const file = join(dir, 'planner-cache.json')
  const world = emptyWorldMemory()
  const worldKey: PlannerWorldKey = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 0 }
  const capabilityHash = plannerCapabilityHash()
  const identity = {
    worldKey: plannerWorldKeyString(worldKey),
    worldEpoch: worldKey.worldEpoch,
    schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
    capabilityHash,
  }
  const input = request('queue_empty')
  const key = plannerStateHash({}, world, input.objective, identity)
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 2,
      worldKey: identity.worldKey,
      worldEpoch: identity.worldEpoch,
      schemaVersion: identity.schemaVersion,
      capabilityHash,
      lastCallAt: 0,
      entries: {
        [key]: {
          optionId: 'stale_option_gone_from_horizon',
          worldKey: identity.worldKey,
          schemaVersion: identity.schemaVersion,
          capabilityHash,
          costUsd: 0,
          ts: Date.now(),
        },
      },
    })}\n`,
  )
  const planner = new PlannerBrain({
    bot: makeBot(),
    world,
    log: () => undefined,
    cachePath: file,
    worldKey,
    mode: 'llm',
    maxAttempts: 1,
    resolveKey: () => null,
  })
  return mustReachModelBoundary(planner, input)
}

// Fixture 5: an unknown or malformed model choice must fail loudly, never fall
// back to options[0] / FRONT_FALLBACK.
async function unknownChoiceFailsLoud(): Promise<Observation> {
  const input = request('no_progress', {
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 1, goals: [] },
  })
  const unknown = await mustReachModelBoundary(modelBrain('unknown-choice', choiceStub('definitely_not_an_option')), input)
  const malformed = await mustReachModelBoundary(modelBrain('malformed-choice', choiceStub(null)), input)
  return {
    pass: unknown.pass && malformed.pass,
    observed: `unknown=${unknown.observed} malformed=${malformed.observed}`,
  }
}

const fixtures: Array<{ name: string; run: () => Promise<Observation> }> = [
  { name: 'llm queue_empty reaches model authority', run: queueEmptyBoundary },
  { name: 'llm capability gap offers recovery but does not force-select it', run: capabilityGapBoundary },
  { name: 'llm stall keeps the model choice, no deterministic body-change substitute', run: stalledKeepsModelChoice },
  { name: 'llm stale cache entry goes to the model, not the deterministic option', run: staleCacheGoesToModel },
  { name: 'llm unknown/malformed model choice fails loud', run: unknownChoiceFailsLoud },
]

let failures = 0
process.stdout.write('System2 authority no-bypass fixture (#226)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const fixture of fixtures) {
  const observed = await fixture.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${fixture.name} -> ${observed.observed}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${fixtures.length - failures}/${fixtures.length} authority no-bypass cases passed\n`)
if (failures > 0) process.exit(1)
