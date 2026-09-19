// test-ladder.mts - #12 regression: a missing rung precondition becomes a
// LADDER_PREREQ plan replacement, never a generation stop. Pure, no bot.
import { buildLadder, deriveResumeRung, goalsForStrategy, orderPlanGoalsByReadiness, prerequisiteUnsatisfiable, rungGoalsWithPrereq, RUNGS } from './planner.ts'
import { selectLedgerSnapshot, snapshotGoals } from './generation-entry.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import type { GoalQueueSnapshot, PlannedGoal } from '../jev-agent/src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

const M2_LIVE = {
  cobblestone: 22,
  stone_pickaxe: 1,
  furnace: 1,
  charcoal: 1,
  oak_log: 2,
}

function rung(id: string) {
  const found = RUNGS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no rung ${id}`)
  return found
}

addCase('PRECONDITION_MISSING is immediately followed by LADDER_PREREQ and does not stop the ladder', () => {
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const ladder = buildLadder(M2_LIVE, world({ furnaces: [{ x: 1, y: 64, z: 1 }] }), (event, detail) => {
    log.push({ event, detail })
  })
  const missing = log.findIndex((entry) => entry.event === 'PRECONDITION_MISSING')
  const prereq = log.findIndex((entry) => entry.event === 'LADDER_PREREQ')
  const adjacent = missing >= 0 && prereq === missing + 1
  const chainIncludesOre = ladder.goals.some((goal) => goal.targetItem === 'raw_iron')
  const chainIncludesDescent = ladder.goals.some((goal) => goal.kind === 'descend')
  const keptGoing = ladder.prereqReplaced && ladder.unsatisfiable === null && ladder.goals.length > 1
  return {
    pass: adjacent && chainIncludesOre && chainIncludesDescent && keptGoing,
    detail: `adjacent=${adjacent} replaced=${ladder.prereqReplaced} goals=[${ladder.goals.map((g) => g.targetItem).join(',')}]`,
  }
})

addCase('the predicate descent prerequisite is emitted before its ore goal', () => {
  const goals = rungGoalsWithPrereq(rung('raw_iron'), M2_LIVE, world())
  const descent = goals.findIndex((goal) => goal.kind === 'descend')
  const ore = goals.findIndex((goal) => goal.kind === 'collect' && goal.targetItem === 'raw_iron')
  const bounded = typeof goals[0]?.targetY === 'number' && Number.isFinite(goals[0]?.targetY)
  const named = (goals[0]?.description ?? '').startsWith('descend_to:Y=')
  return {
    pass: descent === 0 && ore === 1 && bounded && named,
    detail: `order=[${goals.map((g) => `${g.kind}:${g.targetItem ?? '-'}`).join(',')}] targetY=${goals[0]?.targetY}`,
  }
})

addCase('a provably unsatisfiable ore precondition is the only stop', () => {
  const none = prerequisiteUnsatisfiable(rung('raw_iron'), M2_LIVE, world(), 'minecraft:overworld')
  const known = prerequisiteUnsatisfiable(rung('raw_iron'), M2_LIVE, world({ discoveredOres: ['iron_ore'] }), 'minecraft:the_nether')
  const absent = prerequisiteUnsatisfiable(rung('raw_iron'), {}, world(), 'minecraft:the_nether')
  return {
    pass: none === null && known === null && absent !== null,
    detail: `overworld=${none} remembered=${known} netherAbsent=${absent}`,
  }
})

addCase('advisory ore strategies carry the descent prerequisite', () => {
  const goals = goalsForStrategy('return_to_known_ore', M2_LIVE, world({ furnaces: [{ x: 1, y: 64, z: 1 }] }))
  const descent = goals.some((goal) => goal.kind === 'descend')
  const ore = goals.some((goal) => goal.targetItem === 'raw_iron')
  return { pass: descent && ore, detail: `goals=[${goals.map((g) => `${g.kind}:${g.targetItem ?? '-'}`).join(',')}]` }
})

addCase('held furnace with none placed becomes a place-furnace prerequisite', () => {
  const counts = { ...M2_LIVE, charcoal: 0, furnace: 1 }
  const near = buildLadder(counts, world(), undefined, { placedFurnacesNear: 0 }).goals
  const placed = buildLadder(counts, world(), undefined, { placedFurnacesNear: 1 }).goals
  const placeIndex = near.findIndex((goal) => goal.kind === 'place' && goal.targetItem === 'furnace')
  const smeltIndex = near.findIndex((goal) => goal.targetItem === 'charcoal')
  const skippedWhenPlaced = !placed.some((goal) => goal.kind === 'place' && goal.targetItem === 'furnace')
  return {
    pass: placeIndex >= 0 && smeltIndex > placeIndex && skippedWhenPlaced,
    detail: `place@${placeIndex} charcoal@${smeltIndex} skippedWhenPlaced=${skippedWhenPlaced}`,
  }
})

addCase('a known iron ore coordinate grounds the descent target below it (#14 + #41)', () => {
  const known = world({
    knownResources: [{ name: 'iron_ore', kind: 'ore', x: 25, y: 49, z: 36, dimension: 'minecraft:overworld', worldEpoch: 1 }],
  })
  const goals = rungGoalsWithPrereq(rung('raw_iron'), M2_LIVE, known)
  const descent = goals[0]
  return {
    pass: descent?.kind === 'descend' && descent.targetY === 47 && descent.targetItem === 'raw_iron',
    detail: `first=${descent?.kind}:${descent?.targetY} desc=${descent?.description}`,
  }
})

addCase('a reset with raw_iron resumes at the iron_ingot rung, not wood (#reset-inventory)', () => {
  const counts = { raw_iron: 8, coal: 7, cobblestone: 112, crafting_table: 1, furnace: 1 }
  const resume = deriveResumeRung(counts, world())
  const ladder = buildLadder(counts, world(), undefined, { resumeRungIndex: resume.rungIndex })
  const expectIndex = RUNGS.findIndex((candidate) => candidate.id === 'iron_ingot')
  // The wood RUNG must not be re-selected: its goal is `collect 3 x log`. A
  // deeper prerequisite (sticks <- planks <- logs) may still add `collect 1 x
  // log` for a later pickaxe craft, which is not a wood-rung resume.
  const noWoodRungGoal = !ladder.goals.some((goal) => goal.targetItem === 'log' && (goal.requiredCount ?? 1) >= 3)
  const noWoodenPickaxe = !ladder.goals.some((goal) => goal.targetItem === 'wooden_pickaxe')
  return {
    pass:
      resume.rungId === 'iron_ingot' &&
      resume.rungIndex === expectIndex &&
      resume.invEmpty === false &&
      resume.fallbackFrom === null &&
      ladder.rungId === 'iron_ingot' &&
      noWoodRungGoal &&
      noWoodenPickaxe,
    detail: `resume=${resume.rungId}@${resume.rungIndex} invEmpty=${resume.invEmpty} ladder=${ladder.rungId} goals=[${ladder.goals.map((g) => g.targetItem).join(',')}]`,
  }
})

addCase('a reset with an empty inventory starts at wood (#reset-inventory)', () => {
  const resume = deriveResumeRung({}, world())
  const ladder = buildLadder({}, world(), undefined, { resumeRungIndex: resume.rungIndex })
  const woodGoal = ladder.goals.some((goal) => goal.targetItem === 'log')
  return {
    pass: resume.rungId === 'wood' && resume.rungIndex === 0 && resume.invEmpty === true && ladder.rungId === 'wood' && woodGoal,
    detail: `resume=${resume.rungId}@${resume.rungIndex} invEmpty=${resume.invEmpty} ladder=${ladder.rungId} woodGoal=${woodGoal}`,
  }
})

addCase('a reset with only unusable items still starts at wood (#reset-inventory)', () => {
  const resume = deriveResumeRung({ dirt: 5, gravel: 3 }, world())
  return {
    pass: resume.invEmpty === true && resume.rungId === 'wood',
    detail: `resume=${resume.rungId} invEmpty=${resume.invEmpty}`,
  }
})

addCase('a resume rung whose precondition is missing falls back one step and logs it (#reset-inventory)', () => {
  const counts = { cobblestone: 5, raw_iron: 8, coal: 7, crafting_table: 1, furnace: 1 }
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const resume = deriveResumeRung(counts, world(), (event, detail) => log.push({ event, detail }))
  const fallback = log.find((entry) => entry.event === 'LADDER_RESUME_FALLBACK')
  return {
    pass:
      resume.rungId === 'wooden_pickaxe' &&
      resume.fallbackFrom === 'cobblestone' &&
      resume.fallbackNeed === 'wooden_pickaxe' &&
      fallback !== undefined &&
      fallback.detail?.to === 'wooden_pickaxe',
    detail: `resume=${resume.rungId} fallbackFrom=${resume.fallbackFrom} need=${resume.fallbackNeed} log=${JSON.stringify(fallback?.detail)}`,
  }
})

addCase('a missing ledger snapshot degrades to an empty goal list, never throws (#resume-guard)', () => {
  let threw: string | null = null
  let goals: unknown = null
  try {
    goals = snapshotGoals(null)
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  const undefinedSnapshot = snapshotGoals(undefined)
  const legacyShape = snapshotGoals({ depth: 1, current: { id: 'g5:collect:diamond' } } as never)
  return {
    pass:
      threw === null &&
      Array.isArray(goals) &&
      goals.length === 0 &&
      Array.isArray(undefinedSnapshot) &&
      undefinedSnapshot.length === 0 &&
      Array.isArray(legacyShape) &&
      legacyShape.length === 0,
    detail: `threw=${threw} null=[] undefined=[] legacy=[]`,
  }
})

addCase('the resume path logs LADDER_RESUME_NO_SNAPSHOT and still resumes from live inventory (#resume-guard)', () => {
  const counts = { raw_iron: 8, coal: 7, cobblestone: 112, crafting_table: 1, furnace: 1 }
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const emit = (event: string, detail?: Record<string, unknown>): void => {
    log.push({ event, detail })
  }
  const resume = deriveResumeRung(counts, world(), emit)
  const resumeReason = 'inventory-resume'
  const resumeGoals = snapshotGoals(null)
  if (resumeGoals.length === 0) emit('LADDER_RESUME_NO_SNAPSHOT', { reason: resumeReason, goals: resumeGoals.length })
  emit('LADDER_RESUME', { rung: resume.rungId, rungIndex: resume.rungIndex, reason: resumeReason, invEmpty: resume.invEmpty })
  const noSnapshot = log.find((entry) => entry.event === 'LADDER_RESUME_NO_SNAPSHOT')
  const resumed = log.find((entry) => entry.event === 'LADDER_RESUME')
  return {
    pass:
      noSnapshot !== undefined &&
      noSnapshot.detail?.reason === resumeReason &&
      noSnapshot.detail?.goals === 0 &&
      resumed !== undefined &&
      resumed.detail?.rung === 'iron_ingot' &&
      resumed.detail?.rungIndex === 8,
    detail: `noSnapshot=${JSON.stringify(noSnapshot?.detail)} resumed=${JSON.stringify(resumed?.detail)}`,
  }
})

addCase('#prereq-order: a blocked ore plan gets the craftable pickaxe as the queue head, ore retained', () => {
  const counts = { cobblestone: 42, stick: 2, birch_planks: 7 }
  const rawIron: PlannedGoal = { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 }
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const ordered = orderPlanGoalsByReadiness([rawIron], counts, world(), (event, detail) => log.push({ event, detail }))
  const queue = new GoalQueue()
  queue.applyPlan(ordered, 'llm', 'replace')
  const head = queue.current
  const retained = queue.state.goals.some((goal) => goal.targetItem === 'raw_iron' && goal.status === 'pending')
  const planOrder = log.find((entry) => entry.event === 'PLAN_ORDER' && entry.detail?.reason === 'prerequisite_required')
  const pass =
    head?.kind === 'craft' &&
    head.targetItem === 'stone_pickaxe' &&
    retained &&
    ordered.some((goal) => goal.targetItem === 'raw_iron') &&
    planOrder?.detail?.preferred === 'craft_stone_pickaxe' &&
    planOrder.detail?.over === 'collect 3 x raw_iron'
  return { pass, detail: `head=${head?.kind}:${head?.targetItem} retained=${retained} order=${JSON.stringify(planOrder?.detail ?? null)}` }
})

addCase('#prereq-order: with a stone pickaxe the blocked goal is the head and nothing is inserted', () => {
  const counts = { cobblestone: 42, stick: 2, birch_planks: 7, stone_pickaxe: 1 }
  const rawIron: PlannedGoal = { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 }
  const ordered = orderPlanGoalsByReadiness([rawIron], counts, world())
  const queue = new GoalQueue()
  queue.applyPlan(ordered, 'llm', 'replace')
  const pass = ordered.length === 1 && queue.current?.targetItem === 'raw_iron'
  return { pass, detail: `goals=${ordered.length} head=${String(queue.current?.targetItem)}` }
})

addCase('a legitimate wedge abort resumes the preserved ledger at the same rung (#11 v2 §7)', () => {
  const counts = { birch_planks: 2, stick: 2, cobblestone: 170, dirt: 37, leaf_litter: 4, andesite: 7 }
  const memory = world()
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const emit = (event: string, detail?: Record<string, unknown>): void => {
    log.push({ event, detail })
  }
  // The aborted generation's plan, still recorded in the host ledger. A wedge
  // abort never archives the ledger (only goal-complete does), so the restart
  // reads this exact snapshot and the live inventory.
  const hostSnapshot: GoalQueueSnapshot = {
    counter: 42,
    goals: [
      {
        id: 'g-craft-pick',
        kind: 'craft',
        description: 'craft 1 x wooden_pickaxe',
        targetItem: 'wooden_pickaxe',
        requiredCount: 1,
        startCount: 0,
        haveCount: 0,
        status: 'active',
        origin: 'bootstrap',
        createdAt: 0,
        updatedAt: 0,
        detail: null,
      },
    ],
  }
  const chosen = selectLedgerSnapshot(hostSnapshot, null, counts, memory)
  const before = deriveResumeRung(counts, memory, emit)
  const after = deriveResumeRung(counts, memory, emit)
  const resumedLadder = buildLadder(counts, memory, emit, { resumeRungIndex: after.rungIndex })
  const queue = new GoalQueue()
  if (chosen !== null) queue.restore(chosen.snapshot)
  const fallback = log.filter((entry) => entry.event === 'LADDER_RESUME_FALLBACK')
  const pass =
    chosen?.source === 'host-snapshot' &&
    before.rungId === after.rungId &&
    before.rungIndex === after.rungIndex &&
    after.rungIndex > 0 &&
    fallback.length === 0 &&
    resumedLadder.rungId === after.rungId &&
    queue.current?.description === 'craft 1 x wooden_pickaxe'
  return {
    pass,
    detail: `rung=${after.rungId}@${after.rungIndex} source=${chosen?.source} fallback=${fallback.length} head=${queue.current?.description ?? 'none'} ladder=${resumedLadder.rungId}`,
  }
})

let failures = 0
process.stdout.write('ladder precondition regression (#12)\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n      ${observed.detail}\n`)
}
process.stdout.write(`${cases.length - failures}/${cases.length} ladder cases passed\n`)
if (failures > 0) process.exit(1)
