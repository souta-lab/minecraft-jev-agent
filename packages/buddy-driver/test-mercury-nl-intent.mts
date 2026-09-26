// test-mercury-nl-intent.mts - the NATURAL-LANGUAGE contract fixture for the
// semantic (System2 / Mercury) layer.
//
// Operator directive (2026-09-22): the LLM's WHAT is natural language; structured
// output is Jev's job. So the Mercury layer must not reject an answer for shape.
// Every case below feeds a RECORDED raw model answer through the real
// `MercurySystem2` path with a fake transport (no network) and asserts one of two
// typed outcomes:
//
//   grounded  -> executable PlannedGoal records (enrichment OR prose grounding)
//   ungrounded-> `result.ungrounded` set, no FATAL, no corrective retry
//
// and that the strict-schema rejection path is GONE for this layer
// (`MERCURY_SCHEMA_REJECT` / `PLAN_REJECTED` / `invalid plan` never appear).
//
//   bun ./test-mercury-nl-intent.mts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MERCURY_ALLOWED_GOALS,
  MercurySystem2,
  extractMercuryIntent,
  groundMercuryIntent,
  parseMercuryJsonTextDetailed,
  stripUnknownPlanKeys,
  validateMercuryPlan,
} from './mercury-system2.ts'
import type { MercuryStateSummary, MercuryTransport, MercuryTransportRepair } from './mercury-system2.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2/service.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
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

function outcome(actionId: string): System2Outcome {
  return { actionId, status: 'ok', failure: null, verified: false, detail: '' }
}

function planRequest(): System2PlanRequest {
  return {
    reason: 'queue_empty',
    detail: 'the queue drained in the Nether after the obsidian frame was placed',
    tick: 1,
    goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'nether_portal', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [outcome('WAIT'), outcome('WAIT'), outcome('WAIT')],
  }
}

function mercurySummary(): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger: 'no_candidate',
    wakeReason: 'queue_empty',
    wakeDetail: 'empty goal queue in the Nether',
    position: { x: 12, y: 64, z: -8 },
    dimension: 'minecraft:the_nether',
    health: 20,
    toolRank: 3,
    inventory: { obsidian: 10, flint_and_steel: 1, diamond_pickaxe: 1 },
    stations: { craftingTables: 1, furnaces: 0 },
    portal: { verified: true, knownSites: 1 },
    knownOres: ['raw_iron'],
    recentFailures: ['RETRIEVE:obsidian:failure:no_path'],
    consecutiveWait: 3,
    queue: { depth: 0, done: 9, current: null, hasImpossible: false },
    objective: { targetItem: 'nether_portal', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: {
      collect: ['obsidian', 'log', 'stone', 'flint'],
      craft: ['crafting_table', 'furnace', 'flint_and_steel'],
      smelt: ['iron_ingot', 'charcoal'],
      place: ['crafting_table', 'furnace'],
      goto_resources: ['log', 'raw_iron'],
      explore_modes: ['cave', 'surface'],
    },
  }
}

function recordedTransport(text: string, repairs: MercuryTransportRepair[] = []): MercuryTransport {
  return () =>
    Promise.resolve({
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20 },
      text,
      repairs,
    })
}

async function runMercury(text: string): Promise<{ logs: string[]; records: Record<string, unknown>[]; result: Awaited<ReturnType<MercurySystem2['tryRepair']>>; thrown: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-nl-intent-'))
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  const mercury = new MercurySystem2({
    summarize: () => mercurySummary(),
    log: hostLog(logs),
    callsPath,
    cachePath: join(dir, 'mercury-cache.json'),
    maxPerHour: 10,
    resolveKey: () => ({ key: 'test-key', origin: 'test' }),
    transport: recordedTransport(text, [{ kind: 'json-text', shape: parseMercuryJsonTextDetailed(text).shape, objects: parseMercuryJsonTextDetailed(text).objects, chars: text.length }]),
  })
  let thrown: unknown = null
  let result: Awaited<ReturnType<MercurySystem2['tryRepair']>> = null
  try {
    result = await mercury.tryRepair(planRequest(), 'no_candidate')
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

// ---------------------------------------------------------------------------
// RECORDED RAW MODEL OUTPUTS
// Each constant below is copied from a real `meta/muse-spark-1.3-contributor`
// answer (fenced/embedded/prose shapes) or is the exact empty answer observed
// when the reasoning model spent its whole budget without emitting text.
// ---------------------------------------------------------------------------

/** Recorded live: provider aliases (`targetItem`/`requiredCount`) inside a fence. */
const RECORDED_FENCED_ALIASED = [
  'Here is my plan.',
  '```json',
  '{"op":"replace","reason":"start the portal horizon with obsidian collection",',
  ' "goals":[{"kind":"collect","item":"obsidian","targetItem":"obsidian","count":10,"requiredCount":10},',
  '          {"kind":"build_portal_frame"},{"kind":"light_portal"},{"kind":"verify_portal"}]}',
  '```',
].join('\n')

/** Recorded live: prose followed by a small JSON blob with only an alias field. */
const RECORDED_PROSE_PLUS_BLOB =
  'Surface dig timeouts block mining, so a cave route should expose lava. ' +
  '{"op":"patch","goals":[{"kind":"explore","mode":"cave"},{"kind":"collect","targetItem":"obsidian"}]}'

/** Prose only, naming a grounded capability and a target. */
const RECORDED_PROSE_ONLY =
  'The obsidian route has no path, so exploring a cave should expose a new approach to the obsidian.'

/** A reasoning model narrating a draft and then emitting its final answer. */
const RECORDED_REASONING_THEN_ANSWER = [
  'The bot is in the overworld with no furnace. Draft: {"op":"patch","goals":[{"kind":"collect","item":"stone","count":8}]}',
  'But smelting needs a station, so the final answer is:',
  '{"op":"patch","reason":"craft and place a furnace before smelting","goals":[{"kind":"craft","item":"crafting_table","count":1},{"kind":"place","item":"crafting_table"},{"kind":"craft","item":"furnace","count":1},{"kind":"place","item":"furnace"}]}',
].join('\n')

/** Recorded empty answer (reasoning budget exhausted with no visible text). */
const RECORDED_EMPTY = ''

/** Prose that names nothing the capability matrix exposes. */
const RECORDED_PROSE_UNGROUNDED = 'I am not sure what to do next; the situation is unclear right now.'

// ---------------------------------------------------------------------------

addCase('(1) fenced JSON with provider aliases grounds via enrichment coercion', async () => {
  const { logs, records, result, thrown } = await runMercury(RECORDED_FENCED_ALIASED)
  const coerced = logs.find((line) => line.startsWith('MERCURY_ENRICHMENT_COERCED'))
  const intent = logs.find((line) => line.startsWith('MERCURY_INTENT '))
  const goals = result?.goals ?? []
  const record = records[0] ?? {}
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.ungrounded === undefined &&
      goals.length === 4 &&
      goals[0]?.kind === 'collect' &&
      goals[0]?.targetItem === 'obsidian' &&
      goals[0]?.requiredCount === 10 &&
      (goals[1]?.description ?? '').includes('portal frame') &&
      coerced !== undefined &&
      coerced.includes('targetItem->item') &&
      coerced.includes('requiredCount->count') &&
      intent !== undefined &&
      intent.includes('Here is my plan.') &&
      record.outcome === 'success' &&
      record.intentSource === 'enrichment',
    detail: `goals=${goals.map((g) => `${g.kind}:${g.targetItem ?? g.description}`).join(',')} coerced=${coerced !== undefined} intentLogged=${intent !== undefined} source=${String(record.intentSource)}`,
  }
})

addCase('(2) prose plus a small JSON blob uses the blob as enrichment and records the prose as intent', async () => {
  const { logs, records, result, thrown } = await runMercury(RECORDED_PROSE_PLUS_BLOB)
  const goals = result?.goals ?? []
  const record = records[0] ?? {}
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.ungrounded === undefined &&
      goals.length === 2 &&
      (goals[0]?.description ?? '').includes('explore cave') &&
      goals[1]?.targetItem === 'obsidian' &&
      String(record.intent).startsWith('Surface dig timeouts') &&
      record.intentSource === 'enrichment' &&
      logs.some((line) => line.startsWith('MERCURY_INTENT ')),
    detail: `goals=${goals.map((g) => `${g.kind}:${g.targetItem ?? g.description}`).join(',')} source=${String(record.intentSource)} intentLen=${String(record.intent ?? '').length}`,
  }
})

addCase('(3) prose only is grounded onto the capability matrix (no JSON required)', async () => {
  const { logs, records, result, thrown } = await runMercury(RECORDED_PROSE_ONLY)
  const goals = result?.goals ?? []
  const grounded = logs.find((line) => line.startsWith('MERCURY_INTENT_GROUNDED'))
  const record = records[0] ?? {}
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.ungrounded === undefined &&
      goals.length >= 1 &&
      goals.some((goal) => goal.targetItem === 'obsidian') &&
      grounded !== undefined &&
      grounded.includes('source=intent') &&
      record.intentSource === 'intent' &&
      String(record.rawText).includes('exploring a cave'),
    detail: `goals=${goals.map((g) => `${g.kind}:${g.targetItem ?? g.description}`).join(',')} grounded=${grounded ?? 'none'} source=${String(record.intentSource)}`,
  }
})

addCase('(3b) prose can name the already-live gate as enter_portal without rebuilding it', async () => {
  const text = 'The Nether portal is already lit and verified, so enter the Nether portal now.'
  const { logs, result, thrown } = await runMercury(text)
  const goal = result?.goals[0]
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.ungrounded === undefined &&
      result.goals.length === 1 &&
      goal?.targetItem === 'nether_portal' &&
      goal.targetPredicate === 'portal_entered' &&
      goal.dimension === 'minecraft:the_nether' &&
      !result.goals.some((entry) => entry.targetItem === 'obsidian') &&
      logs.some((line) => line.startsWith('MERCURY_INTENT_GROUNDED') && line.includes('enter_portal')),
    detail: `goal=${goal?.kind}:${goal?.targetItem}@${goal?.targetPredicate}/${goal?.dimension} goals=${result?.goals.length ?? 0}`,
  }
})

addCase('(4) reasoning-then-answer takes the final envelope, not the draft', async () => {
  const parsed = parseMercuryJsonTextDetailed(RECORDED_REASONING_THEN_ANSWER)
  const { result, records, thrown } = await runMercury(RECORDED_REASONING_THEN_ANSWER)
  const goals = result?.goals ?? []
  const record = records[0] ?? {}
  return {
    pass:
      thrown === null &&
      parsed.shape === 'multi-final' &&
      result !== null &&
      result.ungrounded === undefined &&
      goals.length === 4 &&
      goals[0]?.targetItem === 'crafting_table' &&
      !goals.some((goal) => goal.targetItem === 'stone') &&
      String(record.intent).includes('final answer'),
    detail: `shape=${parsed.shape} objects=${parsed.objects} goals=${goals.map((g) => `${g.kind}:${g.targetItem ?? g.description}`).join(',')}`,
  }
})

addCase('(5) an empty answer is a typed UNGROUNDED outcome, not a schema rejection', async () => {
  const { logs, records, result, thrown } = await runMercury(RECORDED_EMPTY)
  const record = records[0] ?? {}
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.ungrounded !== undefined &&
      result.ungrounded.reason.length > 0 &&
      result.goals.length === 0 &&
      record.outcome === 'ungrounded' &&
      record.intent === '' &&
      logs.some((line) => line.startsWith('MERCURY_INTENT_UNGROUNDED')) &&
      !logs.some((line) => line.includes('MERCURY_SCHEMA_REJECT')),
    detail: `ungrounded=${result?.ungrounded?.reason ?? 'none'} outcome=${String(record.outcome)} fatal=${logs.some((l) => l.startsWith('FATAL'))}`,
  }
})

addCase('(6) prose naming nothing grounded is a typed UNGROUNDED outcome', async () => {
  const { logs, records, result, thrown } = await runMercury(RECORDED_PROSE_UNGROUNDED)
  const record = records[0] ?? {}
  return {
    pass:
      thrown === null &&
      result !== null &&
      result.ungrounded !== undefined &&
      String(record.intent).startsWith('I am not sure') &&
      record.outcome === 'ungrounded' &&
      logs.some((line) => line.includes('MERCURY_INTENT_UNGROUNDED') && line.includes('no_grounded_goal_in_intent')),
    detail: `ungrounded=${result?.ungrounded?.reason ?? 'none'} intent="${String(record.intent).slice(0, 40)}"`,
  }
})

addCase('(7) unknown top-level keys are stripped before validation and the plan is kept', () => {
  const stripped = stripUnknownPlanKeys({
    op: 'patch',
    goals: [{ kind: 'collect', item: 'obsidian', count: 10 }],
    reason: 'need obsidian',
    planId: 'abc',
    confidence: 0.9,
    notes: ['ignore me'],
  })
  const validated = stripped === null ? null : validateMercuryPlan(stripped.value)
  return {
    pass:
      stripped !== null &&
      validated !== null &&
      validated.ok &&
      stripped.notes.droppedKeys.includes('planId') &&
      stripped.notes.droppedKeys.includes('confidence') &&
      validated.plan.goals.length === 1,
    detail: `dropped=${JSON.stringify(stripped?.notes.droppedKeys ?? [])} validated=${validated?.ok ?? false}`,
  }
})

addCase('(8) NO case produced a strict-schema rejection or a fatal (contract check)', async () => {
  const samples = [RECORDED_FENCED_ALIASED, RECORDED_PROSE_PLUS_BLOB, RECORDED_PROSE_ONLY, RECORDED_REASONING_THEN_ANSWER, RECORDED_EMPTY, RECORDED_PROSE_UNGROUNDED]
  const offenders: string[] = []
  let grounded = 0
  let ungrounded = 0
  for (const [index, sample] of samples.entries()) {
    const { logs, thrown } = await runMercury(sample)
    if (thrown !== null) offenders.push(`${index}:threw`)
    if (logs.some((line) => line.includes('MERCURY_SCHEMA_REJECT'))) offenders.push(`${index}:schemaReject`)
    if (logs.some((line) => line.startsWith('PLAN_REJECTED'))) offenders.push(`${index}:planRejected`)
    if (logs.some((line) => line.startsWith('FATAL'))) offenders.push(`${index}:fatal`)
    if (logs.some((line) => line.includes('CORRECTION REQUIRED'))) offenders.push(`${index}:corrective`)
    const extraction = extractMercuryIntent(sample, parseMercuryJsonTextDetailed(sample).value)
    if (extraction.empty && sample.length > 0) offenders.push(`${index}:lostIntent`)
    if (groundMercuryIntent(sample, MERCURY_ALLOWED_GOALS).ok) grounded += 1
    else ungrounded += 1
  }
  return {
    pass: offenders.length === 0 && grounded + ungrounded === samples.length,
    detail: `samples=${samples.length} grounded=${grounded} ungrounded=${ungrounded} offenders=${offenders.join(',') || 'none'}`,
  }
})

let failures = 0
process.stdout.write('Mercury natural-language intent contract (recorded raw responses, no network)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} mercury natural-language cases passed\n`)
if (failures > 0) process.exit(1)
