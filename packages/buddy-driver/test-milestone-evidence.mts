// test-milestone-evidence.mts - #392 evidence truth fixtures.
//
// The removed producer inferred `done=true` for the rung the frontier left from
// `frontier.rungId !== lastMilestoneId` alone:
//
//   if (this.lastMilestoneId !== null) this.log('MILESTONE', { name: this.lastMilestoneId, done: true })
//
// so a milestone could be recorded complete with zero evidence for its own
// outcome (issue example: `done=true` while `ender_pearl = 0`), including on a
// frontier regression or a multi-rung jump. These fixtures drive the replacement
// `advanceMilestones()` with real RUNGS/counts/world observations and assert:
//
//   (a) a rung whose predicate does NOT hold when the frontier moves past it is
//       never `done=true` and is typed with its own facts;
//   (b) a rung whose predicate DOES hold is still `done=true`;
//   (c) the M2 portal rung: frontier -> enter_nether with a verified lit portal
//       records nether_portal done=true, while the same move with an unlit/absent
//       portal records the typed non-completion instead of a completion;
//   (d) ender_pearls/ender_eyes shaped rungs with zero held items are never done;
//   (e) a multi-rung jump verifies every crossed rung individually;
//   (f) verified attainment is recorded once and frontier telemetry is not a
//       completion.
//
// Pure: no bot, no socket, no network.
import { RUNGS, advanceMilestones, computeFrontier, emptyMilestoneStream } from './planner.ts'
import type { Counts, MilestoneRecord, MilestoneStreamState } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

function rung(id: string) {
  const found = RUNGS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no rung ${id}`)
  return found
}

const named = (records: readonly MilestoneRecord[], name: string): MilestoneRecord[] =>
  records.filter((record) => record.name === name)

const fmt = (record: MilestoneRecord): string =>
  `MILESTONE name=${record.name} done=${record.done} reason=${record.reason} facts=${JSON.stringify(record.facts)}`

const fmtAll = (records: readonly MilestoneRecord[]): string =>
  records.length === 0 ? '(no records)' : records.map(fmt).join('\n      ')

function goalFor(record: MilestoneRecord, item: string): { target: string | null; required: number | null; have: number | null } | null {
  const goals = record.facts.goals
  if (!Array.isArray(goals)) return null
  for (const goal of goals) {
    if (goal === null || typeof goal !== 'object') continue
    const shaped = goal as Record<string, unknown>
    if (shaped.target !== item) continue
    return {
      target: typeof shaped.target === 'string' ? shaped.target : null,
      required: typeof shaped.required === 'number' ? shaped.required : null,
      have: typeof shaped.have === 'number' ? shaped.have : null,
    }
  }
  return null
}

/**
 * Evidence-truth invariant, re-derived from the live rung definition: a record
 * may claim `done=true` only under `reason=predicate_satisfied`, `facts.predicate`
 * must equal the rung's real `satisfied(counts, world)`, and `done` must equal
 * that predicate. Frontier telemetry must never be a completion.
 */
function predicateConsistent(
  records: readonly MilestoneRecord[],
  counts: Counts,
  observed: ResidentWorldMemory,
): string | null {
  for (const record of records) {
    if (record.done && record.reason !== 'predicate_satisfied') {
      return `${record.name}: done=true with reason=${record.reason}`
    }
    if (record.reason === 'frontier' && record.done) {
      return `${record.name}: frontier telemetry claimed done=true`
    }
    const definition = RUNGS.find((candidate) => candidate.id === record.name)
    const claimed = record.facts.predicate === true
    if (definition !== undefined) {
      const actual = definition.satisfied(counts, observed)
      if (actual !== claimed) return `${record.name}: facts.predicate=${claimed} but rung predicate=${actual}`
    }
    if (record.done !== claimed) return `${record.name}: done=${record.done} but facts.predicate=${claimed}`
  }
  return null
}

/** Run one observation through the stream and keep both the state and the invariant verdict. */
function step(
  state: MilestoneStreamState,
  counts: Counts,
  observed: ResidentWorldMemory,
): { records: MilestoneRecord[]; state: MilestoneStreamState; violation: string | null } {
  const advanced = advanceMilestones(state, counts, observed)
  return { records: advanced.records, state: advanced.state, violation: predicateConsistent(advanced.records, counts, observed) }
}

const CLOSURE_ONLY = world({ craftingTables: [{ x: 1, y: 64, z: 1 }] })
const M2_INVENTORY: Counts = { crafting_table: 1, diamond: 1, diamond_pickaxe: 1 }

addCase('(a) frontier past charcoal without charcoal: typed non-completion, never done=true', () => {
  // Pre-jump: the live ladder sits on `charcoal` (its own predicate is false).
  const before = step(emptyMilestoneStream(), { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3 }, world())
  // Post-jump: a diamond pickaxe puts the whole iron age behind the frontier,
  // yet `charcoal` itself was never produced. The old producer emitted
  // `MILESTONE name=charcoal done=true` here purely because the id changed.
  const after = step(
    before.state,
    { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3, diamond: 1, diamond_pickaxe: 1 },
    world(),
  )
  const frontierBefore = computeFrontier({ crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3 }, world())
  const charcoal = named(after.records, 'charcoal')
  const doneClaims = charcoal.filter((record) => record.done)
  const typed = charcoal.length === 1 && charcoal[0]?.reason === 'frontier_advanced_without_predicate'
  const goal = charcoal[0] === undefined ? null : goalFor(charcoal[0], 'charcoal')
  const factsRecorded = goal !== null && goal.target === 'charcoal' && goal.have === 0 && charcoal[0]?.facts.predicate === false
  const pass =
    frontierBefore.rungId === 'charcoal' &&
    doneClaims.length === 0 &&
    typed &&
    factsRecorded &&
    after.violation === null
  return {
    pass,
    detail:
      `frontier ${frontierBefore.rungId}->${computeFrontier({ crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3, diamond: 1, diamond_pickaxe: 1 }, world()).rungId} ` +
      `charcoalDone=${doneClaims.length} goal=${goal?.target}:${goal?.have}/${goal?.required} violation=${after.violation ?? 'none'}\n      ${fmtAll(charcoal)}`,
  }
})

addCase('(b) the same advance with the predicate held: done=true reason=predicate_satisfied', () => {
  const before = step(emptyMilestoneStream(), { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3 }, world())
  const after = step(
    before.state,
    { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3, diamond: 1, diamond_pickaxe: 1, charcoal: 1 },
    world(),
  )
  const charcoal = named(after.records, 'charcoal')
  const goal = charcoal[0] === undefined ? null : goalFor(charcoal[0], 'charcoal')
  const pass =
    charcoal.length === 1 &&
    charcoal[0]?.done === true &&
    charcoal[0]?.reason === 'predicate_satisfied' &&
    goal?.have === 1 &&
    after.violation === null
  return { pass, detail: `goal=${goal?.target}:${goal?.have}/${goal?.required} violation=${after.violation ?? 'none'}\n      ${fmtAll(charcoal)}` }
})

addCase('(c1) M2: frontier -> enter_nether with a verified lit portal records nether_portal done=true', () => {
  const before = step(emptyMilestoneStream(), M2_INVENTORY, world())
  const after = step(before.state, M2_INVENTORY, world({ portalVerified: true }))
  const portal = named(after.records, 'nether_portal')
  const frontierAfter = computeFrontier(M2_INVENTORY, world({ portalVerified: true }))
  const pass =
    frontierAfter.rungId === 'enter_nether' &&
    portal.length === 1 &&
    portal[0]?.done === true &&
    portal[0]?.reason === 'predicate_satisfied' &&
    portal[0]?.facts.portalVerified === true &&
    after.violation === null
  return {
    pass,
    detail: `frontier=${frontierAfter.rungId} violation=${after.violation ?? 'none'}\n      ${fmtAll(portal)}`,
  }
})

addCase('(c2) M2: the same move with an unlit/absent portal never records enter_nether done=true', () => {
  const before = step(emptyMilestoneStream(), M2_INVENTORY, world())
  const lit = step(before.state, M2_INVENTORY, world({ portalVerified: true }))
  // The portal goes dark/absent while the body is still in the overworld: the
  // frontier regresses and the old producer called the rung it left `done=true`.
  const dark = step(lit.state, M2_INVENTORY, world())
  const enter = named(dark.records, 'enter_nether')
  const doneClaims = dark.records.filter((record) => record.done)
  const pass =
    computeFrontier(M2_INVENTORY, world()).rungId === 'nether_portal' &&
    enter.length === 1 &&
    enter[0]?.done === false &&
    enter[0]?.reason === 'frontier_regressed_without_predicate' &&
    enter[0]?.facts.portalVerified === false &&
    doneClaims.length === 0 &&
    dark.violation === null
  return {
    pass,
    detail:
      `enterDoneClaims=${enter.filter((r) => r.done).length} portalVerified=${String(enter[0]?.facts.portalVerified)} violation=${dark.violation ?? 'none'}\n      ${fmtAll(dark.records)}`,
  }
})

addCase('(d) ender_pearls/ender_eyes with zero held items are never recorded done', () => {
  // Reached the M3 rungs in the Nether (12 pearls, 7 rods), then lost them:
  // the frontier regresses and both ender rungs are re-observed at zero.
  const nether = step(
    emptyMilestoneStream(),
    { ...M2_INVENTORY, blaze_rod: 7, ender_pearl: 12 },
    world({ dimension: 'minecraft:the_nether' }),
  )
  const lost = step(nether.state, M2_INVENTORY, world())
  // The issue's exact shape: a stale/restored frontier named `ender_pearls`
  // while the live observation holds zero pearls.
  const stale = step({ frontierId: 'ender_pearls', recorded: {} }, M2_INVENTORY, world())
  const enderRecords = [...lost.records, ...stale.records].filter((record) => record.name.startsWith('ender_'))
  const doneClaims = enderRecords.filter((record) => record.done)
  const lostEyes = named(lost.records, 'ender_eyes')
  const stalePearls = named(stale.records, 'ender_pearls')
  const eyesGoal = lostEyes[0] === undefined ? null : goalFor(lostEyes[0], 'ender_eye')
  const pearlGoal = stalePearls[0] === undefined ? null : goalFor(stalePearls[0], 'ender_pearl')
  const pass =
    doneClaims.length === 0 &&
    lostEyes.length === 1 &&
    lostEyes[0]?.reason === 'frontier_regressed_without_predicate' &&
    eyesGoal?.target === 'ender_eye' &&
    eyesGoal?.have === 0 &&
    stalePearls.length === 1 &&
    stalePearls[0]?.reason === 'frontier_regressed_without_predicate' &&
    pearlGoal?.target === 'ender_pearl' &&
    pearlGoal?.have === 0 &&
    lost.violation === null &&
    stale.violation === null
  return {
    pass,
    detail:
      `enderDoneClaims=${doneClaims.length} eyes=${eyesGoal?.target}:${eyesGoal?.have}/${eyesGoal?.required} pearls=${pearlGoal?.target}:${pearlGoal?.have}/${pearlGoal?.required} ` +
      `violation=${lost.violation ?? stale.violation ?? 'none'}\n      ${fmtAll(enderRecords)}`,
  }
})

addCase('(e) a multi-rung jump verifies every crossed rung with its own predicate', () => {
  const iron = step(
    emptyMilestoneStream(),
    { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, charcoal: 1, raw_iron: 3, iron_ingot: 3 },
    world(),
  )
  const jumped = step(iron.state, { ...M2_INVENTORY }, world({ portalVerified: true }))
  const crossed = ['iron_pickaxe', 'diamond', 'diamond_pickaxe', 'nether_portal']
  const emitted = crossed.map((id) => named(jumped.records, id))
  const allDone = emitted.every(
    (records) => records.length === 1 && records[0]?.done === true && records[0]?.reason === 'predicate_satisfied',
  )
  const pass =
    computeFrontier({ crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, charcoal: 1, raw_iron: 3, iron_ingot: 3 }, world()).rungId === 'iron_pickaxe' &&
    computeFrontier(M2_INVENTORY, world({ portalVerified: true })).rungId === 'enter_nether' &&
    allDone &&
    jumped.violation === null
  return {
    pass,
    detail: `crossed=[${crossed.map((id, i) => `${id}:${emitted[i]?.length ?? 0}`).join(',')}] violation=${jumped.violation ?? 'none'}\n      ${fmtAll(jumped.records)}`,
  }
})

addCase('(f) verified attainment is recorded once, and frontier telemetry is not a completion', () => {
  const before = step(emptyMilestoneStream(), { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3 }, world())
  const repeated = step(before.state, { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3 }, world())
  const advanced = step(
    repeated.state,
    { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3, diamond: 1, diamond_pickaxe: 1, charcoal: 1 },
    world(),
  )
  const again = step(
    advanced.state,
    { crafting_table: 1, stone_pickaxe: 1, furnace: 1, cobblestone: 12, raw_iron: 3, diamond: 1, diamond_pickaxe: 1, charcoal: 1 },
    world(),
  )
  const charcoalDone = named(advanced.records, 'charcoal').filter((record) => record.done)
  const frontierTelemetry = advanced.records.filter((record) => record.reason === 'frontier')
  const pass =
    repeated.records.length === 0 &&
    again.records.length === 0 &&
    charcoalDone.length === 1 &&
    frontierTelemetry.length === 1 &&
    frontierTelemetry[0]?.done === false &&
    advanced.violation === null &&
    again.violation === null
  return {
    pass,
    detail:
      `repeat=${repeated.records.length} again=${again.records.length} charcoalDone=${charcoalDone.length} telemetry=${frontierTelemetry.length}:${String(frontierTelemetry[0]?.name)} ` +
      `violation=${advanced.violation ?? again.violation ?? 'none'}\n      ${fmtAll(again.records)}`,
  }
})

let failures = 0
process.stdout.write('milestone evidence truth (#392)\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n      ${observed.detail}\n`)
}
process.stdout.write(`${cases.length - failures}/${cases.length} milestone evidence cases passed\n`)
if (failures > 0) process.exit(1)
