// test-system2-compile.mts - the System2-answer -> executable-row contract.
//
// Measured live defect (run-muctsqt6-27ocr, main 3002d84, m3-live):
//   the model answered `action_impossible` with exactly the right intent
//   (`{"op":"patch","goals":[{"kind":"explore","mode":"cave"}]}` for a Nether
//   blaze_rods mission), validation passed, the head warrant retired the old row
//   and `LLM plan applied ... 1 goal(s)` fired - and the row that landed was
//   `g15:descend:raw_iron` with `dimension=minecraft:overworld`, i.e. the M2
//   substitution `explore cave -> descend_to Y=32 for raw_iron in the overworld`.
//   In the Nether that row is structurally non-executable
//   (`ROW_NOT_EXECUTABLE_HERE ... declared=overworld live=the_nether`), so the
//   body starved on `NO_PRODUCTIVE_HEAD_BOUND` and re-asked forever.
//
// This fixture pins the invariant that was missing: a System2 answer that names a
// goal the mission needs must compile into rows that mean what the model said and
// reach the queue, or be rejected with a TYPED reason saying why. Every input
// below is either a literal recorded model answer or the exact malformed shape
// that was measured; no network, no bot.
//
//   bun ./test-system2-compile.mts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MercurySystem2,
  parseMercuryJsonTextDetailed,
  plannedGoalsFromMercury,
  uncompiledMercuryGoals,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryTransport } from './mercury-system2.ts'
import { applyCompiledPlan, isOptionComplete, makeOptionSnapshot } from '../jev-agent/src/optionSpec.ts'
import { formatCompiledGoalRows, formatSystem2PlanApplied } from '../jev-agent/src/system2Authority.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { OptionCompilingSystem2 } from './option-brain.ts'
import type { System2Brain, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'

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

/**
 * The measured live state, reduced to the fields the compile reads: the body is
 * in the Nether, the head row is not executable here, and the local objective is
 * raw_iron. This is the state the answers below
 * were actually recorded against.
 */
function measuredState(): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger: 'action_impossible',
    wakeReason: 'action_impossible',
    wakeDetail:
      'row not executable here: goal=descend:raw_iron:1 id=g15:descend:raw_iron declared=overworld live=the_nether reason=no_executable_alternative defers=0/3',
    position: { x: 16, y: 37, z: -9 },
    dimension: 'the_nether',
    health: 10,
    toolRank: 2,
    inventory: { netherrack: 28, diamond_sword: 1, stone_pickaxe: 1, flint_and_steel: 1 },
    stations: { craftingTables: 1, furnaces: 0 },
    portal: { verified: false, knownSites: 0 },
    knownOres: [],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 3, current: 'explore', hasImpossible: true },
    objective: { targetItem: 'raw_iron', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: {
      collect: ['log', 'stone', 'coal', 'raw_iron', 'obsidian', 'blaze_rod', 'ender_pearl'],
      craft: ['crafting_table', 'furnace', 'flint_and_steel', 'ender_eye'],
      smelt: ['iron_ingot', 'charcoal'],
      place: ['crafting_table', 'furnace'],
      goto_resources: ['log', 'raw_iron'],
      explore_modes: ['cave', 'surface'],
    },
  }
}

function measuredRequest(): System2PlanRequest {
  return {
    reason: 'action_impossible',
    detail:
      'row not executable here: goal=descend:raw_iron:1 id=g15:descend:raw_iron declared=overworld live=the_nether reason=no_executable_alternative defers=0/3',
    tick: 34,
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: true, done: 3, goals: [] },
    objective: { targetItem: 'raw_iron', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
  }
}

function recordedTransport(text: string): MercuryTransport {
  const parsed = parseMercuryJsonTextDetailed(text)
  return () =>
    Promise.resolve({
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20 },
      text,
      repairs: [{ kind: 'json-text', shape: parsed.shape, objects: parsed.objects, chars: text.length }],
    })
}

async function runMercury(text: string, stateOverride?: MercuryStateSummary): Promise<{
  logs: string[]
  records: Record<string, unknown>[]
  result: Awaited<ReturnType<MercurySystem2['tryRepair']>>
  thrown: unknown
}> {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-compile-'))
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  const mercury = new MercurySystem2({
    summarize: () => stateOverride ?? measuredState(),
    log: hostLog(logs),
    callsPath,
    cachePath: join(dir, 'mercury-cache.json'),
    maxPerHour: 10,
    resolveKey: () => ({ key: 'test-key', origin: 'test' }),
    transport: recordedTransport(text),
  })
  let thrown: unknown = null
  let result: Awaited<ReturnType<MercurySystem2['tryRepair']>> = null
  try {
    result = await mercury.tryRepair(measuredRequest(), 'action_impossible')
  } catch (error) {
    thrown = error
  }
  const records = readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { logs, records, result, thrown }
}

/** A compiled row reduced to what the QUEUE will execute, not what it is called. */
function executableShape(goal: {
  kind?: string
  targetItem?: string | null
  targetY?: number | null
  dimension?: string | null
  description?: string
}): string {
  return `${goal.kind}:${goal.targetItem ?? '-'}:${goal.targetY ?? '-'}:${goal.dimension ?? '-'}`
}

/**
 * The exact M2 substitution that caused the live loop. Named so a regression is
 * described by its meaning (`descend raw_iron y32 overworld`) and not only by a
 * string comparison.
 */
function isOverworldRawIronDescent(goal: {
  kind?: string
  targetItem?: string | null
  dimension?: string | null
}): boolean {
  return goal.kind === 'descend' && goal.targetItem === 'raw_iron' && goal.dimension === 'minecraft:overworld'
}

// ---------------------------------------------------------------------------
// RECORDED RAW MODEL ANSWERS (literal, from the measured run's mercury-calls.jsonl)
// ---------------------------------------------------------------------------

/** mercury-2-muctvvlu, 2026-09-22T15:28:21.315Z, outcome=success, intentSource=enrichment. */
const MEASURED_ANSWER_1 =
  'Explore nether caves for a new route toward blaze rods, since raw iron has no executable path here.\n' +
  '{"op":"patch","goals":[{"kind":"explore","mode":"cave"}],"reason":"raw iron impossible in nether, need new blaze route"}'

/** mercury-2-muctsre5 lineage: the same intent, the other measured wording. */
const MEASURED_ANSWER_2 =
  "The overworld raw_iron descend can't execute in the Nether, so explore Nether caves to find blazes for " +
  'blaze_rods instead.\n' +
  '{"op":"patch","goals":[{"kind":"explore","mode":"cave"}],"reason":"overworld descend impossible in nether, explore for blaze route"}'

/** The malformed-brother shape: goal 0 is valid, goal 1 is rejected at `count`. */
const MALFORMED_SIBLING =
  '{"op":"patch","goals":[{"kind":"collect","item":"log","count":1},{"kind":"collect","item":"diamond","count":0}]}'

/** A kind the schema does not define. */
const MALFORMED_KIND = '{"op":"patch","goals":[{"kind":"teleport","item":"log"}]}'

/** Prose that names a real capability alongside a block that fails validation. */
const PROSE_PLUS_MALFORMED =
  'The obsidian route is still open, so mine the obsidian we already found. ' + MALFORMED_KIND

/** Prose only, naming nothing the capability matrix exposes. */
const PROSE_UNGROUNDED = 'I am not sure what to do next; the situation is unclear right now.'

/** Prose only, naming a grounded capability (must stay groundable, never a rejection). */
const PROSE_GROUNDED = 'Explore a Nether cave to find a new approach for blaze rods.'

// ---------------------------------------------------------------------------
// (i)+(v) the measured shape compiles into an executable explore row
// ---------------------------------------------------------------------------

for (const [index, answer] of [MEASURED_ANSWER_1, MEASURED_ANSWER_2].entries()) {
  addCase(`(i) measured answer ${index + 1} compiles to a first-class explore row (no M2 substitution)`, async () => {
    const { result, records, logs, thrown } = await runMercury(answer)
    const goal = result?.goals[0]
    const record = records[0] ?? {}
    return {
      pass:
        thrown === null &&
        result !== null &&
        result.ungrounded === undefined &&
        result.goals.length === 1 &&
        goal?.kind === 'explore' &&
        (goal.targetItem ?? null) === null &&
        (goal.targetY ?? null) === null &&
        (goal.dimension ?? null) === null &&
        (goal.description ?? '').includes('explore cave') &&
        goal.optionTemplateId === 'explore:cave' &&
        !isOverworldRawIronDescent(goal) &&
        result.plan.provenance?.intentSource === 'enrichment' &&
        result.plan.provenance?.intent === answer &&
        result.plan.provenance?.noGoalsReason === undefined &&
        record.outcome === 'success' &&
        record.intentSource === 'enrichment' &&
        logs.some((line) => line.startsWith('MERCURY_INTENT ')),
      detail: `shape=${goal === undefined ? 'none' : executableShape(goal)} desc="${goal?.description ?? ''}" tpl=${goal?.optionTemplateId ?? 'none'} intentSource=${String(result?.plan.provenance?.intentSource)} record=${String(record.outcome)}`,
    }
  })
}

addCase('(i) the compiled row becomes the queue head and declares no foreign dimension', async () => {
  const { result } = await runMercury(MEASURED_ANSWER_1)
  const compiled = result?.goals ?? []
  const snapshot = makeOptionSnapshot({
    inventory: { netherrack: 28 },
    dimension: 'the_nether',
    position: { x: 16, y: 37, z: -9 },
    health: 10,
    toolRank: 2,
  })
  const roundTripped = applyCompiledPlan(compiled, snapshot, { enabled: true }).goals
  const queue = new GoalQueue()
  const added = queue.applyPlan(roundTripped, 'llm', 'patch', { reason: 'mercury patch: raw iron impossible in nether' })
  const head = queue.current
  const summary = formatCompiledGoalRows(
    added.map((goal) => ({
      id: goal.id,
      kind: goal.kind,
      targetItem: goal.targetItem ?? null,
      targetY: goal.targetY ?? null,
      dimension: goal.dimension ?? null,
      description: goal.description,
    })),
  )
  return {
    pass:
      added.length === 1 &&
      head?.kind === 'explore' &&
      head.optionTemplateId === 'explore:cave' &&
      (head.dimension ?? null) === null &&
      head.status === 'active' &&
      !isOverworldRawIronDescent(head) &&
      summary === 'explore:-',
    detail: `added=${added.length} head=${head === null ? 'none' : `${head.id}|${executableShape(head)}|status=${head.status}`} appliedLine=${summary}`,
  }
})

// ---------------------------------------------------------------------------
// (ii) an answer that produces no goal is a TYPED rejection, never a no-op
// ---------------------------------------------------------------------------

addCase('(ii) prose-only answer that grounds nothing carries a typed no-goals reason', async () => {
  const { result, records, thrown } = await runMercury(PROSE_UNGROUNDED)
  const record = records[0] ?? {}
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.goals.length === 0 &&
      result.ungrounded !== undefined &&
      result.plan.provenance?.intentSource === 'ungrounded' &&
      result.plan.provenance?.noGoalsReason === 'answer_ungrounded' &&
      result.plan.provenance?.intent === PROSE_UNGROUNDED &&
      record.outcome === 'ungrounded' &&
      record.intentSource === 'ungrounded' &&
      formatCompiledGoalRows([]) === 'none',
    detail: `goals=${result?.goals.length ?? 0} reason=${String(result?.plan.provenance?.noGoalsReason)} record=${String(record.outcome)} appliedLine=${formatCompiledGoalRows([])}`,
  }
})

addCase('(ii) prose-only answer that DOES name a capability is not a rejection', async () => {
  const { result, thrown } = await runMercury(PROSE_GROUNDED)
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.goals.length === 1 &&
      result.goals[0]?.kind === 'explore' &&
      result.plan.provenance?.intentSource === 'intent' &&
      result.plan.provenance?.noGoalsReason === undefined,
    detail: `goals=${JSON.stringify(result?.goals.map((goal) => executableShape(goal)))} intentSource=${String(result?.plan.provenance?.intentSource)}`,
  }
})

// ---------------------------------------------------------------------------
// (iii) a malformed goal is a total, typed rejection - never a partial apply
// ---------------------------------------------------------------------------

addCase('(iii) a malformed sibling goal rejects the block whole and names the field', async () => {
  const { result, records, logs, thrown } = await runMercury(MALFORMED_SIBLING)
  const reject = result?.plan.provenance?.rejectedBlock
  const record = records[0] ?? {}
  const partial = result?.goals ?? []
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.goals.length === 0 &&
      partial.length === 0 &&
      reject?.stage === 'schema' &&
      reject?.path === 'goals.1.count' &&
      reject?.expected === 'too_small' &&
      result.plan.provenance?.noGoalsReason === 'rejected_block_no_grounded_prose' &&
      record.outcome === 'ungrounded' &&
      logs.some((line) => line.startsWith('MERCURY_ENRICHMENT_UNUSABLE') && line.includes('goals.1.count')) &&
      logs.some((line) => line.startsWith('MERCURY_INTENT_UNGROUNDED') && line.includes('text=prose_only')),
    detail: `goals=${partial.length} reject=${JSON.stringify(reject)} reason=${String(result?.plan.provenance?.noGoalsReason)} record=${String(record.outcome)}`,
  }
})

addCase('(iii) an unknown goal kind names kind as the rejected field', async () => {
  const { result } = await runMercury(MALFORMED_KIND)
  const reject = result?.plan.provenance?.rejectedBlock
  return {
    pass:
      result !== null &&
      result.goals.length === 0 &&
      reject?.stage === 'schema' &&
      reject?.path === 'goals.0.kind' &&
      reject?.expected === 'invalid_enum_value',
    detail: `goals=${result?.goals.length ?? 0} reject=${JSON.stringify(reject)}`,
  }
})

addCase('(iii) prose survives a rejected block, and the rejection is still recorded', async () => {
  const { result, thrown } = await runMercury(PROSE_PLUS_MALFORMED)
  const goals = result?.goals ?? []
  return {
    pass:
      thrown === null &&
      result !== null &&
      goals.length === 1 &&
      goals[0]?.targetItem === 'obsidian' &&
      result.plan.provenance?.intentSource === 'intent' &&
      result.plan.provenance?.rejectedBlock?.path === 'goals.0.kind' &&
      !goals.some((goal) => goal.targetItem === 'log'),
    detail: `goals=${JSON.stringify(goals.map((goal) => executableShape(goal)))} reject=${JSON.stringify(result?.plan.provenance?.rejectedBlock)}`,
  }
})

addCase('(iii) an uncompilable goal is reported, never silently skipped', () => {
  const plan = { op: 'patch', goals: [{ kind: 'recover_death_site' }], reason: 'recover the drop' } as never
  const compiled = plannedGoalsFromMercury(plan, { dimension: 'the_nether' })
  const uncompiled = uncompiledMercuryGoals(plan, { dimension: 'the_nether' })
  return {
    pass:
      compiled.length === 0 &&
      uncompiled.length === 1 &&
      uncompiled[0]?.index === 0 &&
      uncompiled[0]?.kind === 'recover_death_site' &&
      (uncompiled[0]?.detail ?? '').includes('death point'),
    detail: `compiled=${compiled.length} uncompiled=${JSON.stringify(uncompiled)}`,
  }
})

// ---------------------------------------------------------------------------
// (iv) an ordinary healthy re-plan is unchanged
// ---------------------------------------------------------------------------

addCase('(iv) an ordinary healthy re-plan compiles to the same rows as before', () => {
  const plan = {
    op: 'patch',
    goals: [
      { kind: 'collect', item: 'obsidian', count: 10 },
      { kind: 'build_portal_frame' },
      { kind: 'light_portal' },
    ],
    reason: 'build the portal',
  } as never
  const compiled = plannedGoalsFromMercury(plan, { dimension: 'minecraft:overworld' })
  const shapes = compiled.map((goal) => executableShape(goal))
  return {
    pass:
      shapes.length === 3 &&
      shapes[0] === 'collect:obsidian:-:-' &&
      shapes[1] === 'place:obsidian:-:-' &&
      shapes[2] === 'place:nether_portal:-:minecraft:overworld' &&
      compiled[2]?.targetPredicate === 'portal_lit' &&
      compiled[0]?.requiredCount === 10,
    detail: `shapes=${JSON.stringify(shapes)} pred=${compiled[2]?.targetPredicate ?? 'none'}`,
  }
})

addCase('(iv) a healthy answer carries no rejection, no uncompiled goal and no no-goals reason', async () => {
  const answer =
    'Build the nether portal from the obsidian we mined.\n' +
    '{"op":"patch","goals":[{"kind":"collect","item":"obsidian","count":10},{"kind":"build_portal_frame"}],"reason":"build the portal"}'
  const { result, thrown } = await runMercury(answer)
  const provenance = result?.plan.provenance
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.goals.length === 2 &&
      provenance?.intentSource === 'enrichment' &&
      provenance?.noGoalsReason === undefined &&
      provenance?.rejectedBlock === undefined &&
      (provenance?.uncompiled?.length ?? 0) === 0,
    detail: `goals=${result?.goals.length ?? 0} intentSource=${String(provenance?.intentSource)} noGoalsReason=${String(provenance?.noGoalsReason)} uncompiled=${provenance?.uncompiled?.length ?? 0}`,
  }
})

addCase('(iv) a lifecycle op keeps its empty goal list without a no-goals alarm', async () => {
  const answer = '{"op":"abort","goals":[],"reason":"give up on the raw iron descent"}'
  const { result } = await runMercury(answer)
  return {
    pass:
      result !== null &&
      result.op === 'abort' &&
      result.goals.length === 0 &&
      result.plan.provenance?.noGoalsReason === 'lifecycle_op',
    detail: `op=${String(result?.op)} reason=${String(result?.plan.provenance?.noGoalsReason)}`,
  }
})

// ---------------------------------------------------------------------------
// (v) two more measured compiler drops of the same family
// ---------------------------------------------------------------------------

/**
 * A death-site recovery the HOST can ground: the live death point is in the live
 * dimension. The Option compiler rejected this row outright (`OPTION_COMPILE_REJECTED
 * reason="id must be \"<kind>:<target>\" without whitespace"`, 8 measured live
 * events on 2026-09-22), and the coordinate was dropped even when it did compile.
 */
function postDeathState(): MercuryStateSummary {
  return {
    ...measuredState(),
    wakeReason: 'post_death',
    wakeDetail: 'the body died at 27,59,-7 in the_nether and dropped its kit',
    postDeath: {
      latestDeathPoint: { x: 27, y: 59, z: -7 },
      dimension: 'minecraft:the_nether',
      cause: 'lava',
      lostInventory: { iron_ingot: 2 },
      itemsLost: 2,
      nearbyHostiles: [],
      recentDeathCount: 1,
      recentDeathWindowSec: 30,
      recoveryChoices: ['recover_death_site', 'rebuild_equipment', 'leave_danger_area'],
    },
  }
}

addCase('(v) a grounded death-site recovery survives the Option compiler and keeps its coordinate', async () => {
  const answer = '{"op":"patch","goals":[{"kind":"recover_death_site"}],"reason":"recover the dropped kit"}'
  const { result, thrown } = await runMercury(answer, postDeathState())
  const compiled = result?.goals ?? []
  const snapshot = makeOptionSnapshot({
    inventory: {},
    dimension: 'the_nether',
    position: { x: 16, y: 37, z: -9 },
    health: 10,
    toolRank: 2,
  })
  const roundTrip = applyCompiledPlan(compiled, snapshot, { enabled: true })
  const row = roundTrip.goals[0]
  const queue = new GoalQueue()
  const added = queue.applyPlan(roundTrip.goals, 'llm', 'patch', { reason: 'mercury patch: recover' })
  return {
    pass:
      thrown === null &&
      compiled.length === 1 &&
      compiled[0]?.kind === 'goto' &&
      compiled[0]?.targetPredicate === 'death_site_recovery' &&
      compiled[0]?.optionTemplateId === 'goto:death_site' &&
      roundTrip.rejected.length === 0 &&
      row?.targetPosition?.x === 27 &&
      row?.targetPosition?.y === 59 &&
      row?.targetPosition?.z === -7 &&
      added.length === 1 &&
      queue.current?.targetPosition?.y === 59,
    detail: `compiled=${compiled.length} rejected=${roundTrip.rejected.length} row=${row === undefined ? 'none' : `${row.kind}|${row.optionTemplateId}|pos=${JSON.stringify(row.targetPosition ?? null)}`} headPos=${JSON.stringify(queue.current?.targetPosition ?? null)}`,
  }
})

addCase('(v) a descend_to with no named dimension is grounded to the LIVE dimension', async () => {
  const answer = '{"op":"patch","goals":[{"kind":"descend_to","y":32}],"reason":"go deeper for the ore band"}'
  const { result, thrown } = await runMercury(answer)
  const goal = result?.goals[0]
  const explicit = plannedGoalsFromMercury(
    { op: 'patch', goals: [{ kind: 'descend_to', y: 32, dimension: 'minecraft:overworld' }] } as never,
    { dimension: 'the_nether' },
  )[0]
  const offline = plannedGoalsFromMercury({ op: 'patch', goals: [{ kind: 'descend_to', y: 16 }] } as never)[0]
  return {
    pass:
      thrown === null &&
      goal?.kind === 'descend' &&
      goal?.targetY === 32 &&
      goal.dimension === 'minecraft:the_nether' &&
      explicit?.dimension === 'minecraft:overworld' &&
      offline?.dimension === 'minecraft:overworld',
    detail: `live=${goal?.dimension} explicit=${explicit?.dimension} offline=${offline?.dimension}`,
  }
})

addCase('(v) a goal the Option compiler rejects is typed onto the plan, not silently dropped', async () => {
  // Synthetic but honest: no shape reaching a VALIDATED Mercury answer is rejected
  // by the Option compiler any more (the death-site row above now compiles), so the
  // plumbing is pinned with a spec that cannot validate. The live producer of this
  // path was `OPTION_COMPILE_REJECTED` (10 lines, host log only) where the queue saw
  // a normal plan with fewer rows.
  const badPlan: System2Plan = {
    op: 'patch',
    goals: [
      {
        kind: 'descend',
        description: 'descend into the dark',
        targetItem: null,
        requiredCount: 1,
        targetY: Number.NaN,
      },
    ],
    note: 'mercury patch: synthetic rejection',
    provenance: { intentSource: 'enrichment', intent: 'descend into the dark' },
  }
  const inner: System2Brain = { model: 'fixture-brain', plan: () => Promise.resolve(badPlan) }
  const brain = new OptionCompilingSystem2(inner, {
    log: () => {},
    snapshot: () =>
      makeOptionSnapshot({ inventory: {}, dimension: 'the_nether', position: null, health: 10, toolRank: 2 }),
    enabled: true,
  })
  const out = await brain.plan(measuredRequest())
  return {
    pass:
      out.goals.length === 0 &&
      out.provenance?.noGoalsReason === 'option_compile_rejected' &&
      out.provenance?.uncompiled?.[0]?.kind === 'option_compile_rejected' &&
      (out.provenance?.uncompiled?.[0]?.detail ?? '').includes('targetY'),
    detail: `goals=${out.goals.length} reason=${String(out.provenance?.noGoalsReason)} uncompiled=${JSON.stringify(out.provenance?.uncompiled ?? [])}`,
  }
})

addCase('(v) a delayed System2 answer compiles against the body’s fresh post-MOVE snapshot', async () => {
  let resolvePlan: (plan: System2Plan) => void = () => {}
  const delayed: System2Brain = {
    model: 'fixture-brain',
    plan: () => new Promise<System2Plan>((resolve) => { resolvePlan = resolve }),
  }
  let bodyPosition = { x: 0, y: 64, z: 0 }
  const observedPositions: Array<{ x: number; y: number; z: number }> = []
  const brain = new OptionCompilingSystem2(delayed, {
    log: () => {},
    snapshot: () => {
      observedPositions.push({ ...bodyPosition })
      return makeOptionSnapshot({ inventory: {}, dimension: 'minecraft:overworld', position: bodyPosition, health: 20, toolRank: 0 })
    },
    enabled: true,
  })
  const pending = brain.plan(measuredRequest())
  bodyPosition = { x: 10, y: 64, z: 0 }
  const gotoGoal = {
    kind: 'goto' as const,
    description: 'move to the grounded point',
    targetItem: null,
    requiredCount: 1,
    targetPosition: { ...bodyPosition },
    dimension: 'minecraft:overworld',
  }
  resolvePlan({
    op: 'patch',
    goals: [gotoGoal],
    note: 'fixture delayed goto',
    provenance: { intentSource: 'intent', intent: 'go to the selected point' },
  })
  const result = await pending
  const compiled = result.goals[0]?.optionSpec
  const freshSnapshot = makeOptionSnapshot({
    inventory: {},
    dimension: 'minecraft:overworld',
    position: bodyPosition,
    health: 20,
    toolRank: 0,
  })
  return {
    pass:
      observedPositions.length === 1 &&
      observedPositions[0]?.x === 10 &&
      compiled !== undefined &&
      isOptionComplete(compiled, freshSnapshot),
    detail: `snapshotAtCompile=${JSON.stringify(observedPositions)} compiledSuccess=${JSON.stringify(compiled?.success ?? null)} completeAtFreshBody=${compiled === undefined ? false : isOptionComplete(compiled, freshSnapshot)}`,
  }
})

addCase('(i) the mirrored apply line names the intent, the compiled rows and the outcome', async () => {
  const { result } = await runMercury(MEASURED_ANSWER_1)
  const compiled = result?.goals ?? []
  const snapshot = makeOptionSnapshot({
    inventory: { netherrack: 28 },
    dimension: 'the_nether',
    position: { x: 16, y: 37, z: -9 },
    health: 10,
    toolRank: 2,
  })
  const queue = new GoalQueue()
  const added = queue.applyPlan(applyCompiledPlan(compiled, snapshot, { enabled: true }).goals, 'llm', 'patch', {
    reason: 'mercury patch: raw iron impossible in nether',
  })
  const line = formatSystem2PlanApplied({
    requestId: '3840717e-7f31-4e12-a574-51973b893f6c',
    op: 'patch',
    accepted: true,
    applied: added.length,
    depth: queue.state.depth,
    intentSource: result?.plan.provenance?.intentSource ?? 'unrecorded',
    uncompiled: result?.plan.provenance?.uncompiled?.length ?? 0,
    intent: result?.plan.provenance?.intent ?? null,
    rows: added.map((goal) => ({
      id: goal.id,
      kind: goal.kind,
      targetItem: goal.targetItem ?? null,
      targetY: goal.targetY ?? null,
      dimension: goal.dimension ?? null,
      description: goal.description,
    })),
  })
  // Injection safety: a model sentence cannot forge a field or a second row.
  const forged = formatSystem2PlanApplied({
    requestId: 'r',
    op: 'patch',
    accepted: true,
    applied: 1,
    depth: 1,
    intentSource: 'enrichment',
    uncompiled: 0,
    intent: 'explore cave"] applied=99 compiled=[descend:raw_iron@overworld]\nSYSTEM2_PLAN_APPLIED forged',
    rows: [
      { id: 'g1:explore', kind: 'explore', targetItem: null, targetY: null, dimension: null, description: 'explore' },
    ],
  })
  // The unforgeable part is the FIELD region: the intent is flattened to one line,
  // its quotes are neutralized, and it is emitted last inside a single quoted value,
  // so model text can never add a field, a row or a second marker line.
  const head = forged.slice(0, forged.indexOf('intent="'))
  const intentMatch = /intent="([^"]*)"$/.exec(forged)
  const injectionBlocked =
    (head.match(/SYSTEM2_PLAN_APPLIED/g) ?? []).length === 1 &&
    (head.match(/applied=/g) ?? []).length === 1 &&
    (head.match(/compiled=\[/g) ?? []).length === 1 &&
    !forged.includes('\n') &&
    intentMatch !== null &&
    (intentMatch[1] ?? '').includes("compiled=[descend:raw_iron@overworld]")
  return {
    pass:
      line.startsWith('SYSTEM2_PLAN_APPLIED op=patch requestId=3840717e') &&
      line.includes('applied=1') &&
      line.includes('intentSource=enrichment') &&
      line.includes('compiled=[explore:-]') &&
      line.includes('uncompiled=0') &&
      line.includes('Explore nether caves for a new route toward blaze rods') &&
      !line.includes('descend:raw_iron') &&
      injectionBlocked,
    detail: `line=${line.slice(0, 200)} injectionBlocked=${injectionBlocked}`,
  }
})

// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('System2 answer -> executable row contract (recorded answers, no network)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} system2-compile cases passed\n`)
if (failures > 0) process.exit(1)
