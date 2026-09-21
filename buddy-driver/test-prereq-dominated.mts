// test-prereq-dominated.mts - #prereq-dominated regression.
//
// Live defect (source 601a06c, run `run-mubg1zz4-mn4b` / generation
// `gen-mubgihtb-0p7plw`): the bot held `diamond_pickaxe=1` and
// `flint_and_steel=1`, yet the durable queue carried
//   active g1:collect:raw_iron  (0/1)
//   active g2:smelt:iron_ingot  (2/3)
// with `basis.frontierRungId=nether_portal` already. The `iron_ingot` rung's
// `satisfied` predicate already exempted this shape, but the queue rows created
// earlier were never retired: `orphanedPrerequisiteDecision` needs a consumer
// ROW in the ledger and there was none, and `orphanedSmeltPrerequisiteReason`
// is only consulted for protected/core rows while these were `protected=false
// core=false`. The resident therefore starved on
// `blockedBy=precondition:station:furnace` and only escaped ~12s later through
// the β wait-streak abandon (`BETA_ABANDON_RELEASED reason=control_action`),
// after which Mercury patched in a furnace/crafting_table detour.
//
// The general fix: a queued prerequisite whose purposes are already fulfilled by
// better held items is retired with the typed marker
// `PREREQ_DOMINATED item=<item> held=<items> reason=<proof>`.
//
// Run: bun ./test-prereq-dominated.mts
import { buildLadder, deriveResumeRung, dominatedPrerequisiteReason } from './planner.ts'
import { reconcileLedgerGoals } from './generation-entry.ts'
import { emptyWorldMemory } from './resident-types.ts'
import { GoalQueue, PREREQ_DOMINATED, PREREQ_RETIRED, setPrereqAuditSink } from '../jev-agent/src/goalQueue.ts'
import type { GoalKind, GoalQueueSnapshot, GoalStatus, QueuedGoal } from '../jev-agent/src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const world = emptyWorldMemory()

/** The live inventory from the measured run (diamond pickaxe already crafted). */
const DIAMOND_LIVE: Record<string, number> = {
  diamond: 3,
  diamond_pickaxe: 1,
  flint_and_steel: 1,
  iron_ingot: 2,
  cobblestone: 22,
  charcoal: 1,
  furnace: 1,
  crafting_table: 1,
  stick: 4,
}
const IRON_LIVE: Record<string, number> = { ...DIAMOND_LIVE, diamond: 0, diamond_pickaxe: 0, iron_pickaxe: 1 }
const NO_PICKAXE: Record<string, number> = {
  raw_iron: 1,
  iron_ingot: 2,
  cobblestone: 22,
  charcoal: 1,
  furnace: 1,
  crafting_table: 1,
}
const STONE_NO_FLINT: Record<string, number> = { ...NO_PICKAXE, stone_pickaxe: 1 }
const DIAMOND_NO_FLINT: Record<string, number> = { ...DIAMOND_LIVE, flint_and_steel: 0 }

function row(
  partial: Partial<QueuedGoal> & {
    id: string
    kind: GoalKind
    targetItem: string | null
    requiredCount: number
    status: GoalStatus
  },
): QueuedGoal {
  return {
    description: `${partial.kind} ${partial.requiredCount} x ${partial.targetItem ?? 'none'}`,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...partial,
  }
}

/** The exact measured durable iron rows (both unfinished, origin=llm). */
function ironSnapshot(): GoalQueueSnapshot {
  return {
    counter: 2,
    goals: [
      row({ id: 'g1:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 1, status: 'active', haveCount: 0 }),
      row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3, status: 'active', haveCount: 2 }),
    ],
    revision: 1,
  }
}

function marker(lines: readonly string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix))
}

/** The frontier the live generation would resume at (reset/restore path). */
function liveFrontier(counts: Record<string, number>): string {
  const resume = deriveResumeRung(counts, world)
  return buildLadder(counts, world, undefined, { resumeRungIndex: resume.rungIndex }).rungId
}

function dominatedDecision(
  goal: Pick<QueuedGoal, 'kind' | 'targetItem' | 'requiredCount'>,
  counts: Record<string, number>,
): ReturnType<typeof dominatedPrerequisiteReason> {
  return dominatedPrerequisiteReason(goal, counts, world)
}

// (a) diamond pickaxe + flint_and_steel: the smelt is dominated by the named
//     substitutes, and the raw_iron predecessor needs no consumer row.
addCase('(a) diamond pickaxe + flint_and_steel dominates -> held=diamond_pickaxe,flint_and_steel', () => {
  const smelt = dominatedDecision({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }, DIAMOND_LIVE)
  const raw = dominatedDecision({ kind: 'collect', targetItem: 'raw_iron', requiredCount: 1 }, DIAMOND_LIVE)
  const pass =
    smelt?.item === 'iron_ingot' &&
    smelt.held.join(',') === 'diamond_pickaxe,flint_and_steel' &&
    smelt.reason === 'producer_rung_satisfied' &&
    raw?.item === 'raw_iron' &&
    raw.held.includes('flint_and_steel') &&
    raw.reason === 'all_consumers_satisfied'
  return { pass, detail: `smelt=${JSON.stringify(smelt)} raw=${JSON.stringify(raw)}` }
})

// (a) restore reconciliation retires BOTH rows at once, with the typed proof.
addCase('(a) ledger reconciliation retires the queued raw_iron+smelt rows', () => {
  const { snapshot, dominated } = reconcileLedgerGoals(ironSnapshot(), DIAMOND_LIVE, world)
  const smelt = snapshot.goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const raw = snapshot.goals.find((goal) => goal.id === 'g1:collect:raw_iron')
  const smeltProof = dominated.find((entry) => entry.item === 'iron_ingot')
  const pass =
    smelt?.status === 'impossible' &&
    raw?.status === 'impossible' &&
    smelt.detail?.includes('item=iron_ingot') === true &&
    smeltProof?.held.join(',') === 'diamond_pickaxe,flint_and_steel' &&
    dominated.length === 2 &&
    // nothing unfinished is left to starve
    snapshot.goals.every((goal) => goal.status !== 'active' && goal.status !== 'pending')
  return {
    pass,
    detail: `smelt=${smelt?.status} raw=${raw?.status} dominated=[${dominated.map((d) => `${d.item}:${d.held.join('+')}:${d.reason}`).join(' | ')}]`,
  }
})

// (a) the runtime queue emits the exact typed marker and cascades the predecessor.
addCase('(a) the GoalQueue emits PREREQ_DOMINATED and clears the queue', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => dominatedDecision(goal, DIAMOND_LIVE))
  queue.restore(ironSnapshot())
  const dominated = marker(lines, PREREQ_DOMINATED)
  const smeltLine = dominated.find((line) => line.includes('id=g2:smelt:iron_ingot'))
  const pass =
    smeltLine?.includes('item=iron_ingot') === true &&
    smeltLine?.includes('held=diamond_pickaxe,flint_and_steel') === true &&
    smeltLine?.includes('reason=producer_rung_satisfied') === true &&
    queue.current === null &&
    queue.isEmpty
  return { pass, detail: `current=${queue.current?.id ?? 'none'} lines=[${dominated.join(' | ')}]` }
})

// (a) the frontier has already advanced past the iron rungs.
addCase('(a) the ladder frontier is past iron_ingot (nether_portal)', () => {
  const frontier = liveFrontier(DIAMOND_LIVE)
  return { pass: frontier === 'nether_portal', detail: `frontier=${frontier}` }
})

// (b) iron pickaxe + flint_and_steel: the same proof applies.
addCase('(b) iron pickaxe + flint_and_steel dominates the iron rows', () => {
  const smelt = dominatedDecision({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }, IRON_LIVE)
  const { snapshot } = reconcileLedgerGoals(ironSnapshot(), IRON_LIVE, world)
  const frontier = liveFrontier(IRON_LIVE)
  const pass =
    smelt?.held.includes('iron_pickaxe') === true &&
    smelt?.held.includes('flint_and_steel') === true &&
    snapshot.goals.every((goal) => goal.status === 'impossible') &&
    !['raw_iron', 'iron_ingot', 'iron_pickaxe', 'stone_pickaxe'].includes(frontier)
  return { pass, detail: `smelt=${JSON.stringify(smelt)} frontier=${frontier}` }
})

// (c) no pickaxe: more iron IS genuinely needed - the chain stays.
addCase('(c) with no pickaxe the iron chain stays', () => {
  const smelt = dominatedDecision({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }, NO_PICKAXE)
  const raw = dominatedDecision({ kind: 'collect', targetItem: 'raw_iron', requiredCount: 1 }, NO_PICKAXE)
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => dominatedDecision(goal, NO_PICKAXE))
  queue.restore(ironSnapshot())
  const pass =
    smelt === null &&
    raw === null &&
    queue.current?.targetItem === 'raw_iron' &&
    marker(lines, PREREQ_DOMINATED).length === 0
  return { pass, detail: `smelt=${JSON.stringify(smelt)} raw=${JSON.stringify(raw)} current=${queue.current?.id ?? 'none'}` }
})

// (d) stone pickaxe without flint_and_steel: the flint consumer is unmet.
addCase('(d) stone pickaxe without flint_and_steel keeps the iron chain', () => {
  const smelt = dominatedDecision({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }, STONE_NO_FLINT)
  const raw = dominatedDecision({ kind: 'collect', targetItem: 'raw_iron', requiredCount: 1 }, STONE_NO_FLINT)
  return { pass: smelt === null && raw === null, detail: `smelt=${JSON.stringify(smelt)} raw=${JSON.stringify(raw)}` }
})

// (d2) diamond pickaxe but NO flint_and_steel: the flint consumer still needs iron.
addCase('(d2) diamond pickaxe without flint_and_steel keeps the iron chain', () => {
  const smelt = dominatedDecision({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }, DIAMOND_NO_FLINT)
  const raw = dominatedDecision({ kind: 'collect', targetItem: 'raw_iron', requiredCount: 1 }, DIAMOND_NO_FLINT)
  return { pass: smelt === null && raw === null, detail: `smelt=${JSON.stringify(smelt)} raw=${JSON.stringify(raw)}` }
})

// (e) the existing orphaned-smelt path is untouched: with no domination proof
//     installed, the exact live ledger still retires via PREREQ_RETIRED.
addCase('(e) the existing orphaned-smelt retirement still behaves', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.restore({
    counter: 47,
    goals: [
      row({ id: 'g1:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 1, status: 'done', haveCount: 3, protected: true, core: true }),
      row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'active', protected: true, core: true }),
      row({ id: 'g3:collect:flint', kind: 'collect', targetItem: 'flint', requiredCount: 1, status: 'done', haveCount: 1, protected: true, core: true }),
      row({ id: 'g4:craft:flint_and_steel', kind: 'craft', targetItem: 'flint_and_steel', requiredCount: 1, status: 'done', haveCount: 1, protected: true, core: true }),
      row({ id: 'g5:collect:obsidian', kind: 'collect', targetItem: 'obsidian', requiredCount: 10, status: 'active', protected: true, core: true }),
    ],
    revision: 7,
  })
  const smelt = queue.state.goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const retired = marker(lines, PREREQ_RETIRED)
  const pass =
    smelt?.status === 'impossible' &&
    smelt.detail?.includes('reason=all_dependents_resolved') === true &&
    retired.some((line) => line.includes('id=g2:smelt:iron_ingot')) &&
    queue.current?.targetItem === 'obsidian' &&
    marker(lines, PREREQ_DOMINATED).length === 0
  return { pass, detail: `smelt=${smelt?.status} current=${queue.current?.id ?? 'none'} retired=[${retired.join(' | ')}]` }
})

// (f) M2's obsidian/portal rungs keep their live-gate semantics: a verified
//     portal satisfies the rung without making obsidian a dominated row.
addCase('(f) the M2 portal/obsidian rungs are not turned into dominated rows', () => {
  const verified = { ...world, portalVerified: true } as typeof world
  const obsidian = dominatedPrerequisiteReason({ kind: 'collect', targetItem: 'obsidian', requiredCount: 9 }, DIAMOND_LIVE, verified)
  const frame = dominatedPrerequisiteReason({ kind: 'place', targetItem: 'obsidian', requiredCount: 10 }, DIAMOND_LIVE, verified)
  const unverifiedFrontier = liveFrontier(DIAMOND_LIVE)
  const resume = deriveResumeRung(DIAMOND_LIVE, verified)
  const verifiedFrontier = buildLadder(DIAMOND_LIVE, verified, undefined, { resumeRungIndex: resume.rungIndex }).rungId
  const pass =
    obsidian === null &&
    frame === null &&
    unverifiedFrontier === 'nether_portal' &&
    verifiedFrontier === 'enter_nether'
  return { pass, detail: `obsidian=${JSON.stringify(obsidian)} unverified=${unverifiedFrontier} verified=${verifiedFrontier}` }
})

let failures = 0
process.stdout.write('prerequisite domination (#prereq-dominated)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
setPrereqAuditSink(null)
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} prerequisite-domination cases passed\n`)

if (failures > 0) process.exit(1)
