// test-authority-no-bypass.mts - #226 RED-first semantic-authority regressions.
//
// In llm mode, a missing model key is deliberately used as a tripwire. If a
// semantic path actually reaches System2 model authority it MUST fail loudly.
// Returning a deterministic plan instead proves that code bypassed the model.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import { FatalModelError } from '../jev-agent/src/modelFailure.ts'
import type { System2PlanRequest } from '../jev-agent/src/system2/service.ts'
import { PlannerBrain } from './planner.ts'
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

function brain(label: string, y = 20): PlannerBrain {
  return new PlannerBrain({
    bot: makeBot(y),
    world: emptyWorldMemory(),
    log: () => undefined,
    mode: 'llm',
    maxAttempts: 1,
  })
}

async function mustReachModelBoundary(label: string, planner: PlannerBrain, input: System2PlanRequest): Promise<boolean> {
  let thrown: unknown = null
  let returned: unknown = null
  try {
    returned = await planner.plan(input)
  } catch (error) {
    thrown = error
  }
  const pass = thrown instanceof FatalModelError
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  ${label} -> ${thrown instanceof Error ? thrown.message : `returned deterministic plan ${JSON.stringify(returned)}`}\n`,
  )
  return pass
}

let failures = 0
process.stdout.write('System2 authority no-bypass fixture (#226)\n')
process.stdout.write('-'.repeat(72) + '\n')

if (!(await mustReachModelBoundary('llm queue_empty reaches model authority', brain('queue-empty'), request('queue_empty')))) {
  failures += 1
}

if (
  !(await mustReachModelBoundary(
    'llm capability gap offers recovery but does not force-select it',
    brain('capability-gap', 20),
    request('no_progress', {
      goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 1, goals: [] },
      recentEvents: ['CAPABILITY_GAP reason=ascend_blocked attempts=3 target_y=80'],
    }),
  ))
) {
  failures += 1
}

process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${2 - failures}/2 authority no-bypass cases passed\n`)
if (failures > 0) process.exit(1)
