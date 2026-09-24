// test-mercury-plan-kinds.mts - issue #19: explicit typed plan kinds. No bot,
// no network. Proves the schema/grounding/compiler and a fixture cache replay.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MERCURY_CACHE_FILE_VERSION,
  MERCURY_CACHE_SCHEMA_VERSION,
  MercurySystem2,
  groundMercuryPlan,
  hashMercuryState,
  mercuryStrategyLabel,
  normalizeResourceItem,
  plannedGoalsFromMercury,
  validateMercuryPlan,
} from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
import { enforceSmeltPriority } from './planner.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { hasBodyDelta } from '../jev-agent/src/replanThrottle.ts'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2.ts'

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
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

function mercuryState(overrides: Partial<MercuryStateSummary> = {}): MercuryStateSummary {
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
    stations: { craftingTables: 0, furnaces: 0 },
    knownOres: ['iron_ore'],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 3, current: 'craft 1 x furnace', hasImpossible: false },
    objective: { targetItem: 'iron_pickaxe', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: {
      collect: ['stone'],
      craft: ['furnace'],
      smelt: ['iron_ingot'],
      place: ['crafting_table', 'furnace'],
      goto_resources: ['raw_iron'],
      explore_modes: ['cave', 'surface'],
    },
    ...overrides,
  }
}

function hostLog(sink: string[]): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail) => {
    const parts = Object.entries(detail ?? {}).map(([key, value]) => `${key}=${String(value)}`)
    sink.push(`${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`)
  }
}

addCase('a typed place:furnace plan validates and compiles to a PLACE step', () => {
  const checked = validateMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'place', item: 'furnace' }],
    reason: 'held furnace must be placed',
  })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const goals = plannedGoalsFromMercury(checked.plan)
  const goal = goals[0]
  const pass = goals.length === 1 && goal?.kind === 'place' && goal.targetItem === 'furnace' && goal.requiredCount === 1
  return { pass, detail: JSON.stringify(goals) }
})

addCase('craft:furnace and place:furnace remain distinct kinds', () => {
  const checked = validateMercuryPlan({
    op: 'replace',
    goals: [
      { kind: 'craft', item: 'furnace', count: 1 },
      { kind: 'place', item: 'furnace' },
    ],
    reason: 'craft then place',
  })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const goals = plannedGoalsFromMercury(checked.plan)
  return {
    pass: goals[0]?.kind === 'craft' && goals[1]?.kind === 'place' && goals[0]?.targetItem === goals[1]?.targetItem,
    detail: goals.map((goal) => `${goal.kind}:${goal.targetItem}`).join(' -> '),
  }
})

addCase('typed collect/smelt compile to matching kinds', () => {
  const checked = validateMercuryPlan({
    op: 'patch',
    goals: [
      { kind: 'collect', item: 'raw_iron', count: 3 },
      { kind: 'smelt', item: 'iron_ingot', count: 3 },
    ],
    reason: 'iron chain',
  })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const goals = plannedGoalsFromMercury(checked.plan)
  return {
    pass: goals[0]?.kind === 'collect' && goals[1]?.kind === 'smelt' && goals[1]?.requiredCount === 3,
    detail: goals.map((goal) => `${goal.kind}:${goal.targetItem}x${goal.requiredCount}`).join(','),
  }
})

addCase('backward compatible: legacy {item,count} still validates and infers the kind', () => {
  const checked = validateMercuryPlan({
    op: 'patch',
    goals: [
      { item: 'stone', count: 12 },
      { item: 'iron_ingot', count: 3 },
      { item: 'furnace', count: 1 },
    ],
    reason: 'legacy shape',
  })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const goals = plannedGoalsFromMercury(checked.plan)
  return {
    pass: goals[0]?.kind === 'collect' && goals[1]?.kind === 'smelt' && goals[2]?.kind === 'craft',
    detail: goals.map((goal) => `${goal.kind}:${goal.targetItem}`).join(','),
  }
})

addCase('impossible verb x target pairs are rejected with a logged reason', () => {
  const placeDiamond = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'place', item: 'diamond' }], reason: 'x' })
  const smeltPick = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'smelt', item: 'wooden_pickaxe', count: 1 }], reason: 'x' })
  const craftRawIron = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'craft', item: 'raw_iron', count: 1 }], reason: 'x' })
  const reasons = [placeDiamond, smeltPick, craftRawIron].map((result) => (result.ok ? 'ACCEPTED' : result.error))
  const pass =
    !placeDiamond.ok &&
    !smeltPick.ok &&
    !craftRawIron.ok &&
    (reasons[0] ?? '').includes('impossible place') &&
    (reasons[1] ?? '').includes('impossible smelt') &&
    (reasons[2] ?? '').includes('impossible craft')
  return { pass, detail: reasons.join(' | ') }
})

addCase('malformed typed goals are rejected: missing y, bad mode, unknown kind, coordinates', () => {
  const noY = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'descend_to' }], reason: 'x' })
  const badMode = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'explore', mode: 'nether' }], reason: 'x' })
  const unknown = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'teleport', item: 'furnace' }], reason: 'x' })
  const coords = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'goto', item: 'raw_iron', x: 1, z: 2 }], reason: 'x' })
  const pass = !noY.ok && !badMode.ok && !unknown.ok && !coords.ok && !coords.ok && String(coords.error).includes('schema')
  return {
    pass,
    detail: [noY, badMode, unknown, coords].map((r) => (r.ok ? 'ACCEPTED' : r.error)).join(' | '),
  }
})

addCase('goto_resource compiles to known-resource retrieval and normalizes ore blocks', () => {
  const normalized = normalizeResourceItem('iron_ore')
  const deepslate = normalizeResourceItem('deepslate_iron_ore')
  const checked = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'goto_resource', item: 'iron_ore' }], reason: 'known ore' })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const goal = plannedGoalsFromMercury(checked.plan)[0]
  const bad = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'goto_resource', item: 'imaginary_ore' }], reason: 'x' })
  return {
    pass: normalized === 'raw_iron' && deepslate === 'raw_iron' && goal?.kind === 'collect' && goal.targetItem === 'raw_iron' && !bad.ok,
    detail: `normalized=${normalized}/${deepslate} goal=${goal?.kind}:${goal?.targetItem} bad=${bad.ok ? 'accepted' : bad.error}`,
  }
})

addCase('descend_to compiles to the DESCEND predicate with targetY', () => {
  const checked = validateMercuryPlan({ op: 'replace', goals: [{ kind: 'descend_to', y: 16 }], reason: 'ore band' })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const goal = plannedGoalsFromMercury(checked.plan)[0]
  const outOfRange = validateMercuryPlan({ op: 'replace', goals: [{ kind: 'descend_to', y: 999 }], reason: 'x' })
  return {
    pass: goal?.kind === 'descend' && goal.targetY === 16 && goal.dimension === 'minecraft:overworld' && !outOfRange.ok,
    detail: `goal=${goal?.kind} targetY=${goal?.targetY} dim=${goal?.dimension} oob=${outOfRange.ok ? 'accepted' : outOfRange.error}`,
  }
})

addCase('explore remains a first-class search Option instead of becoming an M2 resource goal', () => {
  const cave = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'explore', mode: 'cave' }], reason: 'x' })
  const surface = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'explore', mode: 'surface' }], reason: 'x' })
  const caveGoal = cave.ok ? plannedGoalsFromMercury(cave.plan)[0] : null
  const surfaceGoal = surface.ok ? plannedGoalsFromMercury(surface.plan)[0] : null
  return {
    pass:
      caveGoal?.kind === 'explore' && caveGoal.targetItem === null && caveGoal.dimension === undefined &&
      surfaceGoal?.kind === 'explore' && surfaceGoal.targetItem === null && surfaceGoal.dimension === undefined,
    detail: `cave=${caveGoal?.kind}:${caveGoal?.targetItem ?? 'none'} surface=${surfaceGoal?.kind}:${surfaceGoal?.targetItem ?? 'none'}`,
  }
})

addCase('hasBodyDelta treats place as a body change so it survives replan substitute', () => {
  const current = { kind: 'collect', targetItem: 'raw_iron' }
  const place = [{ kind: 'place', targetItem: 'furnace', requiredCount: 1 }]
  const stationary = [{ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }]
  return {
    pass: hasBodyDelta(place, current) && !hasBodyDelta(stationary, current),
    detail: `place=${hasBodyDelta(place, current)} stationary=${hasBodyDelta(stationary, current)}`,
  }
})

addCase('enforceSmeltPriority never promotes a smelt above a preceding place', () => {
  const place: PlannedGoal = { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 }
  const smelt: PlannedGoal = { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }
  const descend: PlannedGoal = { kind: 'descend', description: 'descend_to:Y=8', targetItem: 'diamond', requiredCount: 1, targetY: 8 }
  const counts = { raw_iron: 8, coal: 7, iron_ingot: 0 }
  const held = enforceSmeltPriority([place, smelt], counts)
  const normal = enforceSmeltPriority([descend, smelt], counts)
  return {
    pass:
      held[0]?.kind === 'place' &&
      held[1]?.kind === 'smelt' &&
      normal[0]?.kind === 'smelt' &&
      normal[0]?.targetItem === 'iron_ingot',
    detail: `held=${held.map((goal) => goal.kind).join(',')} normal=${normal.map((goal) => goal.kind).join(',')}`,
  }
})

addCase('groundMercuryPlan reports a missing smelt input without replacing the typed semantic plan', () => {
  const plan = { op: 'replace' as const, goals: [{ kind: 'smelt' as const, item: 'iron_ingot', count: 3 }], reason: 'smelt it' }
  const refused = groundMercuryPlan(plan, { inventory: {} })
  const applicable = groundMercuryPlan(plan, { inventory: { raw_iron: 3 } })
  const validated = validateMercuryPlan(refused.plan)
  return {
    pass:
      refused.refused !== null &&
      refused.plan.goals[0]?.kind === 'smelt' &&
      refused.plan.goals[0]?.item === 'iron_ingot' &&
      validated.ok &&
      applicable.refused === null,
    detail: `refused=${JSON.stringify(refused.refused)} goals=${JSON.stringify(refused.plan.goals)}`,
  }
})

addCase('json round-trip preserves the explicit kind (cache write shape)', () => {
  const original = { op: 'patch' as const, goals: [{ kind: 'place' as const, item: 'furnace' }], reason: 'x' }
  const roundTripped = JSON.parse(JSON.stringify(original)) as unknown
  const checked = validateMercuryPlan(roundTripped)
  const goal = checked.ok ? plannedGoalsFromMercury(checked.plan)[0] : null
  const label = checked.ok ? mercuryStrategyLabel(checked.plan) : 'invalid'
  return {
    pass: goal?.kind === 'place' && goal.targetItem === 'furnace' && label === 'mercury_patch_place_furnace',
    detail: `goal=${goal?.kind}:${goal?.targetItem} label=${label}`,
  }
})

addCase('fixture cache replay applies a typed place plan with no network call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-kinds-'))
  const cachePath = join(dir, 'mercury-cache.json')
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const summary = mercuryState()
  writeFileSync(
    cachePath,
    `${JSON.stringify({
      version: MERCURY_CACHE_FILE_VERSION,
      worldKey: 'local|unknown|0',
      worldEpoch: 0,
      schemaVersion: MERCURY_CACHE_SCHEMA_VERSION,
      entries: {
        [hashMercuryState(summary)]: {
          op: 'patch',
          goals: [{ kind: 'place', item: 'furnace' }],
          reason: 'held furnace must be placed',
          strategy: 'mercury_patch_place_furnace',
          costUsd: 0,
          ts: Date.now(),
          replays: 0,
        },
      },
      callTimes: [],
      consecutiveStrategy: null,
      consecutiveCount: 0,
    })}\n`,
  )
  const logs: string[] = []
  const mercury = new MercurySystem2({
    summarize: () => summary,
    log: hostLog(logs),
    callsPath,
    cachePath,
    maxPerHour: 0,
  })
  const repair = await mercury.tryRepair(planRequest(), 'no_candidate')
  const expected = plannedGoalsFromMercury({ op: 'patch', goals: [{ kind: 'place', item: 'furnace' }], reason: 'x' })
  const callsWritten = (await import('node:fs')).existsSync(callsPath)
  return {
    pass:
      repair !== null &&
      repair.cached &&
      repair.op === 'patch' &&
      repair.strategy === 'mercury_patch_place_furnace' &&
      JSON.stringify(repair.goals) === JSON.stringify(expected) &&
      repair.goals[0]?.kind === 'place' &&
      repair.goals[0]?.targetItem === 'furnace' &&
      !callsWritten,
    detail: `cached=${repair?.cached} strategy=${repair?.strategy} goals=${JSON.stringify(repair?.goals)} callsWritten=${callsWritten}`,
  }
})

addCase('a compiled typed place plan becomes the active GoalQueue goal', () => {
  const checked = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'place', item: 'furnace' }], reason: 'x' })
  if (!checked.ok) return { pass: false, detail: checked.error }
  const compiled = plannedGoalsFromMercury(checked.plan)
  const queue = new GoalQueue()
  queue.applyPlan(compiled, 'llm', checked.plan.op)
  const current = queue.current
  return {
    pass: current?.kind === 'place' && current.targetItem === 'furnace' && current.status === 'active',
    detail: `current=${current?.kind}:${current?.targetItem} status=${current?.status}`,
  }
})

let failures = 0
process.stdout.write('Mercury typed plan kinds (#19): schema + grounding + compiler\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} plan-kind cases passed\n`)
if (failures > 0) process.exit(1)
