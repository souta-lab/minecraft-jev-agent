// test-ladder-floor.mts - #73 regression: one rung source of truth plus a
// deterministic ladder floor that always supplies the next horizon on queue_empty.
import type { Bot } from 'mineflayer'
import { emptyWorldMemory } from './resident-types.ts'
import {
  PlannerBrain,
  RUNGS,
  bestPickaxeRank,
  buildPlanOptions,
  deriveResumeRung,
  deriveUpperAccessTargetY,
  ladderFloorGoals,
  resolveRungSourceOfTruth,
  rungIndexById,
  upperAccessRecoveryApplies,
} from './planner.ts'
import { planNetherPortal } from '../jev-agent/src/netherPortalPlan.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
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

// Historical lower-ladder alignment: coal is a smelting fuel but not charcoal, so a coal-only
// inventory is NOT past the charcoal rung. This fixture represents the real
// post-charcoal iron stage, so it holds `charcoal: 1` explicitly; without it the
// ladder would (correctly) resume at the charcoal rung instead of iron_ingot.
const ISSUE_INVENTORY: Record<string, number> = { furnace: 1, raw_iron: 8, coal: 7, charcoal: 1, cobblestone: 112, crafting_table: 1 }
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

function botAt(y: number, counts: Record<string, number>): Bot {
  return { ...(botWith(counts) as object), entity: { position: { x: 0, y, z: 0 } } } as unknown as Bot
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

addCase('(f) the portal rung supplies its typed prerequisite chain from the deterministic floor', () => {
  const index = rungIndexById('nether_portal')
  const floor = ladderFloorGoals(
    { diamond: 3, diamond_pickaxe: 1 },
    emptyWorldMemory(),
    { resumeRungIndex: index },
  )
  const flint = floor.goals.findIndex((goal) => goal.targetItem === 'flint')
  const steel = floor.goals.findIndex((goal) => goal.targetItem === 'flint_and_steel')
  const obsidian = floor.goals.findIndex((goal) => goal.targetItem === 'obsidian')
  const frame = floor.goals.findIndex((goal) => goal.kind === 'place' && goal.targetItem === 'obsidian')
  const obsidianGoal = floor.goals[obsidian]
  const frameGoal = floor.goals[frame]
  return {
    pass:
      index >= 0 &&
      floor.supplied &&
      flint >= 0 &&
      steel > flint &&
      obsidian > steel &&
      frame > obsidian &&
      obsidianGoal?.protected === true &&
      obsidianGoal.core === true &&
      frameGoal?.core === true,
    detail: `idx=${index} supplied=${floor.supplied} order=flint@${flint},steel@${steel},obsidian@${obsidian},frame@${frame}`,
  }
})

addCase('(g) the upper-access hint derives from the highest remembered y, else a bounded rise', () => {
  const world = { ...emptyWorldMemory(), knownResources: [{ name: 'iron_ore', kind: 'ore' as const, x: 37, y: 67, z: 33 }] }
  const remembered = deriveUpperAccessTargetY(world, 10)
  const bounded = deriveUpperAccessTargetY(emptyWorldMemory(), 10)
  return {
    pass: remembered === 68 && bounded === 74 && upperAccessRecoveryApplies(world, 10),
    detail: `remembered=${remembered} bounded=${bounded} applies=${upperAccessRecoveryApplies(world, 10)}`,
  }
})

addCase('(h) a capability gap forces the surface-return goal to the queue head (deterministic fallback)', async () => {
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const world = { ...emptyWorldMemory(), knownResources: [{ name: 'iron_ore', kind: 'ore' as const, x: 37, y: 67, z: 33 }] }
  const brain = new PlannerBrain({
    bot: botAt(10, ISSUE_INVENTORY),
    world,
    log: hostLog(log),
    cachePath: '/tmp/opencode/wt-surface-nonexistent-planner-cache.json',
    mode: 'deterministic',
  })
  const gapRequest: System2PlanRequest = {
    ...request('no_progress', 1),
    recentEvents: ['CAPABILITY_GAP reason=ascend_blocked attempts=41 target_y=67'],
  }
  const plan = await brain.plan(gapRequest)
  const head = plan.goals[0]
  const queue = new GoalQueue()
  queue.applyPlan(plan.goals, 'llm', plan.op ?? 'replace')
  const policy = log.find((entry) => entry.event === 'UPPER_ACCESS_RECOVERY_POLICY')
  return {
    pass:
      head?.kind === 'surface' &&
      head.strategy === 'return_to_surface' &&
      head.description.includes('recover vertical access') &&
      head.targetItem === 'log' &&
      head.targetY === 68 &&
      plan.op === 'replace' &&
      queue.current?.kind === 'surface' &&
      policy?.detail?.chosen === 'recover_vertical_access' &&
      policy?.detail?.reason === 'capability_gap' &&
      Array.isArray(policy?.detail?.alternatives),
    detail: `head=${head?.kind}:${head?.strategy} targetY=${head?.targetY} queueHead=${queue.current?.kind} policy=${JSON.stringify(policy?.detail)}`,
  }
})

addCase('(i) without a capability gap the deterministic floor never emits the surface goal', async () => {
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const world = { ...emptyWorldMemory(), knownResources: [{ name: 'iron_ore', kind: 'ore' as const, x: 37, y: 67, z: 33 }] }
  const brain = new PlannerBrain({
    bot: botAt(10, ISSUE_INVENTORY),
    world,
    log: hostLog(log),
    cachePath: '/tmp/opencode/wt-surface-nonexistent-planner-cache.json',
    mode: 'deterministic',
  })
  const plan = await brain.plan(request('queue_empty', 0))
  const surface = plan.goals.some((goal) => goal.kind === 'surface')
  return {
    pass: !surface && plan.goals.length > 0,
    detail: `surface=${surface} goals=[${plan.goals.map((goal) => goal.kind).join(',')}]`,
  }
})

// M2 = diamond-to-Nether-gate. Full iron armour + sword (the iron_gear rung) is a
// real but OPTIONAL affordance, never a required prerequisite of the diamond /
// portal route. These cases pin that boundary and the nether_portal transition.

const ARMOUR_ITEMS = ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots', 'iron_sword']

function targetItems(goals: readonly PlannedGoal[]): string[] {
  return goals.map((goal) => goal.targetItem).filter((item): item is string => typeof item === 'string')
}

addCase("(j) M2=diamond-to-Nether-gate: the diamond route needs no mandatory full iron armour", () => {
  const counts = { crafting_table: 1, iron_ingot: 3, iron_pickaxe: 1 }
  const options = buildPlanOptions(counts, emptyWorldMemory())
  const diamondRoad = options.find((option) => option.id === 'diamond_road')
  const diamondItems = targetItems(diamondRoad?.goals ?? [])
  const noArmour = !diamondItems.some((item) => ARMOUR_ITEMS.includes(item))
  // The old chain inherited `climb(26, ...)`, which demanded ~22 raw_iron for armour.
  const noRawIronSurge = !(diamondRoad?.goals ?? []).some(
    (goal) => goal.targetItem === 'raw_iron' && (goal.requiredCount ?? 0) >= 22,
  )
  const hasDiamond = diamondItems.includes('diamond')
  const gearStillOffered = options.some((option) => option.id === 'iron_gear')
  return {
    pass: diamondRoad !== undefined && noArmour && noRawIronSurge && hasDiamond && gearStillOffered,
    detail: `diamond_road=[${diamondItems.join(',')}] noArmour=${noArmour} noRawIronSurge=${noRawIronSurge} hasDiamond=${hasDiamond} gearOffered=${gearStillOffered}`,
  }
})

addCase('(k) iron_gear is an explicit optional rung, not a mandatory prerequisite', () => {
  const gear = RUNGS.find((rung) => rung.id === 'iron_gear')
  const diamond = RUNGS.find((rung) => rung.id === 'diamond')
  const portal = RUNGS.find((rung) => rung.id === 'nether_portal')
  const gearOptional = gear?.optional === true
  const diamondMandatory = diamond !== undefined && diamond.optional !== true && diamond.future !== true
  // A portal is only "done" once the nether_portal block exists, not merely when
  // flint_and_steel is held (the old predicate skipped the build/light entirely).
  const portalFuture = portal?.future === true
  const satisfiedEmpty = portal?.satisfied({}, emptyWorldMemory()) === true
  const satisfiedHeld = portal?.satisfied({ nether_portal: 1 }, emptyWorldMemory()) === true
  return {
    pass: gearOptional && diamondMandatory && !portalFuture && !satisfiedEmpty && satisfiedHeld,
    detail: `gearOptional=${gearOptional} diamondMandatory=${diamondMandatory} portalFuture=${portalFuture} satisfiedEmpty=${satisfiedEmpty} satisfiedHeld=${satisfiedHeld}`,
  }
})

addCase('(l) the ladder reaches the nether_portal rung and its typed build/light/verify plan', () => {
  const counts = {
    crafting_table: 1,
    cobblestone: 22,
    stick: 2,
    oak_log: 2,
    stone_pickaxe: 1,
    furnace: 1,
    charcoal: 1,
    iron_ingot: 3,
    iron_pickaxe: 1,
    diamond: 3,
    diamond_pickaxe: 1,
    flint: 1,
    flint_and_steel: 1,
    obsidian: 10,
  }
  const resume = deriveResumeRung(counts, emptyWorldMemory())
  const floor = ladderFloorGoals(counts, emptyWorldMemory(), {
    resumeRungIndex: resume.rungIndex,
    placedFurnacesNear: 1,
    knownFurnaces: 1,
  })
  const plan = planNetherPortal({ inventory: counts, toolRank: bestPickaxeRank(counts) })
  const operationKinds = plan.operations.map((operation) => operation.kind).join(',')
  const everyPostcondition = plan.operations.every((operation) => typeof operation.postcondition.kind === 'string')
  const buildGoal = floor.goals.some((goal) => goal.kind === 'place' && goal.targetItem === 'obsidian')
  const lightGoal = floor.goals.some(
    (goal) => goal.kind === 'place' && goal.targetItem === 'nether_portal' && goal.targetPredicate === 'portal_lit',
  )
  const noArmour = !targetItems(floor.goals).some((item) => ARMOUR_ITEMS.includes(item))
  return {
    pass:
      resume.rungId === 'nether_portal' &&
      floor.rungId === 'nether_portal' &&
      floor.supplied &&
      operationKinds === 'build_portal_frame,light_portal,verify_portal' &&
      everyPostcondition &&
      buildGoal &&
      lightGoal &&
      noArmour,
    detail: `resume=${resume.rungId}@${resume.rungIndex} floor=${floor.rungId} supplied=${floor.supplied} ops=[${operationKinds}] postconditions=${everyPostcondition} build=${buildGoal} light=${lightGoal} noArmour=${noArmour}`,
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
