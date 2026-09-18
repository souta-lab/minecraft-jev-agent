// test-ladder-floor.mts - #73 regression: one rung source of truth plus a
// deterministic ladder floor that always supplies the next horizon on queue_empty.
import type { Bot } from 'mineflayer'
import { emptyWorldMemory } from './resident-types.ts'
import { PlannerBrain, buildPlanOptions, ladderFloorGoals, resolveRungSourceOfTruth, rungIndexById } from './planner.ts'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { LlmSummonReason, System2PlanRequest } from '../jev-agent/src/system2.ts'

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const ISSUE_INVENTORY: Record<string, number> = { furnace: 1, raw_iron: 8, coal: 7, cobblestone: 112, crafting_table: 1 }
const MISMATCH_INVENTORY: Record<string, number> = { ...ISSUE_INVENTORY, oak_log: 3 }

function hostLog(sink: Array<{ event: string; detail: Record<string, unknown> | undefined }>) {
  return (event: string, detail?: Record<string, unknown>): void => {
    sink.push({ event, detail })
  }
}

function botWith(counts: Record<string, number>): Bot {
  return {
    inventory: { items: () => Object.entries(counts).map(([name, count]) => ({ name, count })) },
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    registry: { blocksByName: {} },
    findBlocks: () => [],
  } as unknown as Bot
}

function request(reason: LlmSummonReason, depth: number): System2PlanRequest {
  return {
    reason,
    detail: 'test',
    tick: 1,
    goalQueueState: { depth, current: null, empty: depth === 0, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
  }
}

const EARLY_ITEMS = new Set(['log', 'wooden_pickaxe', 'crafting_table', 'planks', 'stick'])

function earlyGoals(goals: readonly PlannedGoal[]): PlannedGoal[] {
  return goals.filter((goal) => typeof goal.targetItem === 'string' && EARLY_ITEMS.has(goal.targetItem))
}

addCase('(a) queue_empty at rung=iron_ingot supplies the smelt goal and its place-furnace prerequisite', () => {
  const floor = ladderFloorGoals(ISSUE_INVENTORY, emptyWorldMemory(), { placedFurnacesNear: 0 })
  const place = floor.goals.findIndex((goal) => goal.kind === 'place' && goal.targetItem === 'furnace')
  const smelt = floor.goals.findIndex((goal) => goal.kind === 'smelt' && goal.targetItem === 'iron_ingot')
  return {
    pass: floor.supplied && floor.rungId === 'iron_ingot' && place >= 0 && smelt > place,
    detail: `rung=${floor.rungId} supplied=${floor.supplied} goals=[${floor.goals.map((goal) => `${goal.kind}:${goal.targetItem}`).join(',')}]`,
  }
})

addCase('(b) the floor supplies the remaining steps for two other rungs (raw_iron, diamond)', () => {
  const counts = { crafting_table: 1, stone_pickaxe: 1 }
  const ore = ladderFloorGoals(counts, emptyWorldMemory(), { resumeRungIndex: rungIndexById('raw_iron') })
  const diamond = ladderFloorGoals(counts, emptyWorldMemory(), { resumeRungIndex: rungIndexById('diamond') })
  const oreOk = ore.supplied && ore.goals.some((goal) => goal.targetItem === 'raw_iron')
  const diamondOk = diamond.supplied && diamond.goals.some((goal) => goal.targetItem === 'diamond')
  return {
    pass: oreOk && diamondOk,
    detail: `raw_iron=[${ore.goals.map((goal) => goal.targetItem).join(',')}] diamond=[${diamond.goals.map((goal) => goal.targetItem).join(',')}]`,
  }
})

addCase('(c) a mismatched planner/ledger rung adopts the ledger deterministically', () => {
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const resolved = resolveRungSourceOfTruth(MISMATCH_INVENTORY, emptyWorldMemory(), hostLog(log))
  const mismatch = log.find((entry) => entry.event === 'RUNG_MISMATCH')
  const adopt = log.find((entry) => entry.event === 'RUNG_ADOPT')
  return {
    pass:
      resolved.mismatch &&
      resolved.plannerRungId === 'wooden_pickaxe' &&
      resolved.ledgerRungId === 'iron_ingot' &&
      resolved.adoptedRungId === 'iron_ingot' &&
      resolved.source === 'ledger' &&
      mismatch?.detail?.adopt === 'iron_ingot' &&
      adopt?.detail?.source === 'ledger',
    detail: `planner=${resolved.plannerRungId} ledger=${resolved.ledgerRungId} adopt=${resolved.adoptedRungId}/${resolved.source} log=[${log.map((entry) => entry.event).join(',')}]`,
  }
})

addCase('(d) no early-game goal is supplied when the ledger rung is iron_ingot', () => {
  const resolved = resolveRungSourceOfTruth(ISSUE_INVENTORY, emptyWorldMemory())
  const options = buildPlanOptions(ISSUE_INVENTORY, emptyWorldMemory(), { resumeRungIndex: resolved.adoptedRungIndex })
  const early = earlyGoals(options.flatMap((option) => option.goals))
  const front = options[0]
  const smelt = options.some((option) => option.goals.some((goal) => goal.kind === 'smelt' && goal.targetItem === 'iron_ingot'))
  return {
    pass: early.length === 0 && front?.id === 'front_iron_ingot' && smelt,
    detail: `front=${front?.id} earlyCount=${early.length} smelt=${smelt}`,
  }
})

addCase('(e) PlannerBrain answers queue_empty with PLAN source=ladder rung=iron_ingot and no LLM', async () => {
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const brain = new PlannerBrain({
    bot: botWith(ISSUE_INVENTORY),
    world: emptyWorldMemory(),
    log: hostLog(log),
    cachePath: '/tmp/opencode/wt73-nonexistent-planner-cache-73.json',
    mode: 'deterministic',
  })
  const first = await brain.plan(request('queue_empty', 0))
  const second = await brain.plan(request('queue_empty', 0))
  const ladderLine = log.find(
    (entry) => entry.event === 'PLAN' && entry.detail?.source === 'ladder' && entry.detail?.reason === 'queue_empty',
  )
  const smelt = second.goals.some((goal) => goal.kind === 'smelt' && goal.targetItem === 'iron_ingot')
  return {
    pass: ladderLine !== undefined && ladderLine.detail?.rung === 'iron_ingot' && second.op === 'replace' && smelt && first.goals.length > 0,
    detail: `floorLine=${JSON.stringify(ladderLine?.detail)} op=${second.op} goals=[${second.goals.map((goal) => goal.description).join('|')}]`,
  }
})

addCase('(f) an incomplete rung with no emittable step logs QUEUE_EMPTY_UNSUPPLIED', () => {
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const index = rungIndexById('nether_portal')
  const floor = ladderFloorGoals({}, emptyWorldMemory(), { resumeRungIndex: index, log: hostLog(log) })
  const unsupplied = log.find((entry) => entry.event === 'QUEUE_EMPTY_UNSUPPLIED')
  return {
    pass: index >= 0 && !floor.supplied && unsupplied?.detail?.rung === 'nether_portal',
    detail: `idx=${index} supplied=${floor.supplied} log=${JSON.stringify(unsupplied?.detail)}`,
  }
})

let failures = 0
process.stdout.write('ladder floor / rung source of truth (#73)\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n      ${observed.detail}\n`)
}
process.stdout.write(`${cases.length - failures}/${cases.length} ladder-floor cases passed\n`)
if (failures > 0) process.exit(1)
