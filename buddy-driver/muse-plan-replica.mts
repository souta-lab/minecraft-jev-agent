// muse-plan-replica.mts - reproducible "before/after" measurement for the
// Mercury (System2 semantic layer) planning call.
//
// It drives the SAME code path the live resident uses - `MercurySystem2` with
// the real SYSTEM_PROMPT and the real json-text transport - against the real
// gateway model, for realistic states (empty queue in the Nether, a stalled
// obsidian retrieval, an impossible smelt). Every raw assistant text is
// recorded so the response shapes are evidence, not inference.
//
//   bun tools/muse-plan-replica.mts [--n=12] [--out=/tmp/replica.jsonl]
//
// Env:
//   BUDDY_MERCURY_MODEL   model id (default meta/muse-spark-1.3-contributor)
//   REPLICA_N             number of consultations (default 12)
//   REPLICA_RETRIES       retries per consultation (default 0 -> 1 attempt each,
//                         so a raw-text shape maps 1:1 to a call)
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import {
  JSON_TEXT_TRANSPORT_INSTRUCTIONS,
  MercurySystem2,
  SYSTEM_PROMPT,
  parseMercuryJsonTextDetailed,
  validateMercuryPlan,
} from './mercury-system2.ts'
import type {
  MercuryStateSummary,
  MercuryTransport,
  MercuryTransportRepair,
} from './mercury-system2.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { resolveJevApiKey } from '../jev-agent/src/jev.ts'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const MODEL = process.env.BUDDY_MERCURY_MODEL ?? 'meta/muse-spark-1.3-contributor'
const N = Number(flag('n', process.env.REPLICA_N ?? '12'))
const RETRIES = Number(flag('retries', process.env.REPLICA_RETRIES ?? '0'))
const OUT = flag('out', join(tmpdir(), `muse-replica-${Date.now()}.jsonl`))

function outcome(actionId: string, failure: string | null = null): System2Outcome {
  return { actionId, status: failure === null ? 'ok' : 'failure', failure, verified: false, detail: '' }
}

function planRequest(reason: System2PlanRequest['reason'], detail: string, tick: number): System2PlanRequest {
  return {
    reason,
    detail,
    tick,
    goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'nether_portal', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [outcome('WAIT'), outcome('WAIT'), outcome('WAIT')],
  }
}

/**
 * Three realistic live shapes. Each carries a per-attempt nonce in
 * `recentFailures` so the state-hash cache cannot replay and inflate success.
 */
function scenario(index: number, nonce: string): { state: MercuryStateSummary; request: System2PlanRequest } {
  const common = {
    humanMission: 'Defeat the Ender Dragon' as const,
    health: 20,
    toolRank: 3,
    consecutiveWait: 3,
    knownOres: ['raw_iron', 'diamond'],
    deathHistory: [],
    allowedGoals: {
      collect: ['obsidian', 'log', 'stone', 'raw_iron', 'diamond'],
      craft: ['crafting_table', 'furnace', 'diamond_pickaxe', 'flint_and_steel'],
      smelt: ['iron_ingot', 'charcoal'],
      place: ['crafting_table', 'furnace'],
      goto_resources: ['obsidian', 'diamond', 'raw_iron'],
      explore_modes: ['cave', 'surface'],
    },
  }
  switch (index % 3) {
    case 0:
      return {
        request: planRequest('queue_empty', `the queue drained in the Nether (${nonce})`, 100 + index),
        state: {
          ...common,
          trigger: 'no_candidate',
          wakeReason: 'queue_empty',
          wakeDetail: `empty goal queue in the Nether (${nonce})`,
          position: { x: 12, y: 64, z: -8 },
          dimension: 'minecraft:the_nether',
          inventory: { obsidian: 10, flint_and_steel: 1, diamond_pickaxe: 1 },
          stations: { craftingTables: 1, furnaces: 0 },
          recentFailures: [`no_candidate:queue_empty:${nonce}`],
          queue: { depth: 0, done: 9, current: null, hasImpossible: false },
          objective: { targetItem: 'nether_portal', requiredCount: 1, haveCount: 0, complete: false },
        },
      }
    case 1:
      return {
        request: planRequest('action_impossible', `obsidian retrieval has no path (${nonce})`, 200 + index),
        state: {
          ...common,
          trigger: 'action_impossible',
          wakeReason: 'action_impossible',
          wakeDetail: `collect obsidian: no_path to the known obsidian at y=12 (${nonce})`,
          position: { x: 40, y: 48, z: 70 },
          dimension: 'minecraft:overworld',
          inventory: { diamond_pickaxe: 1, crafting_table: 1 },
          stations: { craftingTables: 0, furnaces: 0 },
          recentFailures: [`RETRIEVE:obsidian:failure:no_path:${nonce}`],
          queue: { depth: 1, done: 4, current: 'collect 10 x obsidian', hasImpossible: false },
          objective: { targetItem: 'obsidian', requiredCount: 10, haveCount: 0, complete: false },
        },
      }
    default:
      return {
        request: planRequest('action_impossible', `smelt blocked: no furnace station (${nonce})`, 300 + index),
        state: {
          ...common,
          trigger: 'action_impossible',
          wakeReason: 'action_impossible',
          wakeDetail: `smelt iron_ingot blocked: no placed furnace (${nonce})`,
          position: { x: 8, y: 63, z: 8 },
          dimension: 'minecraft:overworld',
          inventory: { raw_iron: 3, crafting_table: 1 },
          stations: { craftingTables: 0, furnaces: 0 },
          recentFailures: [`SMELT:iron_ingot:impossible:no_station:${nonce}`],
          queue: { depth: 1, done: 2, current: 'smelt 1 x iron_ingot', hasImpossible: true },
          objective: { targetItem: 'iron_ingot', requiredCount: 1, haveCount: 0, complete: false },
        },
      }
  }
}

interface RawAttempt {
  consultation: number
  scenario: number
  text: string
  chars: number
  shape: string
  jsonObject: boolean
}

const rawAttempts: RawAttempt[] = []
let activeConsultation = -1
let activeScenario = -1

const transport: MercuryTransport = async ({ system, prompt, maxOutputTokens, timeoutMs }) => {
  const result = await generateText({
    model: MODEL,
    system: `${system}\n\n${JSON_TEXT_TRANSPORT_INSTRUCTIONS}`,
    prompt,
    maxOutputTokens,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(timeoutMs),
  })
  const parsed = parseMercuryJsonTextDetailed(result.text)
  rawAttempts.push({
    consultation: activeConsultation,
    scenario: activeScenario,
    text: result.text,
    chars: result.text.length,
    shape: parsed.shape,
    jsonObject: parsed.value !== null,
  })
  const repair: MercuryTransportRepair = {
    kind: 'json-text',
    shape: parsed.shape,
    objects: parsed.objects,
    chars: result.text.length,
  }
  if (parsed.value === null) return { toolCalls: [], usage: result.usage, text: result.text, repairs: [repair] }
  return {
    toolCalls: [{ input: parsed.value }],
    usage: result.usage,
    text: result.text,
    repairs: parsed.shape === 'exact' ? [] : [repair],
  }
}

// ---------------------------------------------------------------------------
// --recorded: replay the RECORDED live failure answers through the real
// MercurySystem2 path with no network. This isolates the contract change from
// provider flakiness: the same inputs are fatal schema rejections under the old
// JSON schema and grounded/typed-ungrounded outcomes under the natural-language
// contract.
// ---------------------------------------------------------------------------
interface RecordedAnswer {
  name: string
  text: string
  expectation: string
}

const RECORDED_ANSWERS: RecordedAnswer[] = [
  {
    name: 'fenced-json-with-provider-aliases',
    expectation: 'grounded (enrichment coerced)',
    text: [
      'Here is my plan.',
      '```json',
      '{"op":"replace","reason":"start the portal horizon with obsidian collection",',
      ' "goals":[{"kind":"collect","item":"obsidian","targetItem":"obsidian","count":10,"requiredCount":10},',
      '          {"kind":"build_portal_frame"},{"kind":"light_portal"},{"kind":"verify_portal"}]}',
      '```',
    ].join('\n'),
  },
  {
    name: 'prose-plus-blob-without-reason',
    expectation: 'grounded (reason defaulted from intent)',
    text:
      'Surface dig timeouts block mining, so a cave route should expose lava. ' +
      '{"op":"patch","goals":[{"kind":"explore","mode":"cave"},{"kind":"collect","targetItem":"obsidian"}]}',
  },
  {
    name: 'prose-only-names-grounded-step',
    expectation: 'grounded (intent mapping)',
    text: 'The obsidian route has no path, so exploring a cave should expose a new approach to the obsidian.',
  },
  {
    name: 'reasoning-then-final-answer',
    expectation: 'grounded (last envelope)',
    text: [
      'Draft: {"op":"patch","goals":[{"kind":"collect","item":"stone","count":8}]}',
      'Final answer: {"op":"patch","reason":"craft and place a furnace","goals":[{"kind":"craft","item":"crafting_table","count":1},{"kind":"place","item":"crafting_table"}]}',
    ].join('\n'),
  },
  {
    name: 'empty-answer',
    expectation: 'typed ungrounded (no FATAL)',
    text: '',
  },
  {
    name: 'prose-names-nothing-grounded',
    expectation: 'typed ungrounded (no FATAL)',
    text: 'I am not sure what to do next; the situation is unclear right now.',
  },
]

async function runRecorded(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'muse-recorded-'))
  const lines: string[] = []
  let grounded = 0
  let ungrounded = 0
  let fatal = 0
  for (const [index, answer] of RECORDED_ANSWERS.entries()) {
    const logs: string[] = []
    const mercury = new MercurySystem2({
      summarize: (_request, trigger) => ({ ...scenario(index, `rec-${index}`).state, trigger }),
      log: (event, detail) => logs.push(`${event} ${JSON.stringify(detail ?? {})}`),
      callsPath: join(dir, `calls-${index}.jsonl`),
      cachePath: join(dir, `cache-${index}.json`),
      model: 'recorded-fixture',
      timeoutMs: 5_000,
      maxPerHour: 10,
      retries: 0,
      resolveKey: () => ({ key: 'fixture', origin: 'fixture' }),
      // Emulate the transport exactly: parse the text and hand the object on.
      transport: () => {
        const parsed = parseMercuryJsonTextDetailed(answer.text)
        const repair: MercuryTransportRepair = {
          kind: 'json-text',
          shape: parsed.shape,
          objects: parsed.objects,
          chars: answer.text.length,
        }
        if (parsed.value === null) return Promise.resolve({ toolCalls: [], usage: null, text: answer.text, repairs: [repair] })
        return Promise.resolve({ toolCalls: [{ input: parsed.value }], usage: null, text: answer.text, repairs: [repair] })
      },
    })
    let kind = 'unknown'
    let detail = ''
    try {
      const result = await mercury.tryRepair(scenario(index, `rec-${index}`).request, 'no_candidate')
      if (result === null) {
        kind = 'fatal'
        detail = 'tryRepair null'
      } else if (result.ungrounded !== undefined) {
        kind = 'ungrounded'
        detail = result.ungrounded.reason
      } else {
        kind = 'grounded'
        detail = result.goals.map((goal) => `${goal.kind}:${goal.targetItem ?? goal.description}`).join(',')
      }
    } catch (error) {
      kind = error instanceof Error ? error.name : 'fatal'
      detail = error instanceof Error ? error.message.slice(0, 90) : String(error)
    }
    if (kind === 'grounded') grounded += 1
    else if (kind === 'ungrounded') ungrounded += 1
    else fatal += 1
    const rejected = logs.some((line) => line.includes('MERCURY_SCHEMA_REJECT') || line.startsWith('PLAN_REJECTED'))
    lines.push(`  ${answer.name.padEnd(34)} ${kind.padEnd(10)} rejected=${rejected ? 'yes' : 'no '} ${detail.slice(0, 80)}`)
  }
  process.stdout.write(`recorded-answers=${RECORDED_ANSWERS.length} grounded=${grounded} ungrounded=${ungrounded} fatal=${fatal}\n`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (process.argv.includes('--recorded')) {
  await runRecorded()
  process.exit(0)
}

const key = resolveJevApiKey()
if (key === null) {
  process.stderr.write('no gateway key resolved (see JEV_KEY_FILE / AI_GATEWAY_API_KEY)\n')
  process.exit(2)
}
process.stdout.write(`muse-plan-replica model=${MODEL} n=${N} retries=${RETRIES}\n`)

const cacheDir = mkdtempSync(join(tmpdir(), 'muse-replica-cache-'))
const summaries: string[] = []
const outcomes: { consultation: number; scenario: number; kind: string; detail: string; rawTexts: string[]; goals: string[] }[] = []

for (let i = 0; i < N; i += 1) {
  activeConsultation = i
  activeScenario = i % 3
  const nonce = `${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}`
  const { state, request } = scenario(i, nonce)
  const textStart = rawAttempts.length
  const mercury = new MercurySystem2({
    summarize: (_request, trigger) => ({ ...state, trigger }),
    log: (event, detail) => summaries.push(`${i} ${event} ${JSON.stringify(detail ?? {})}`),
    callsPath: join(cacheDir, `calls-${i}.jsonl`),
    cachePath: join(cacheDir, `cache-${i}.json`),
    model: MODEL,
    timeoutMs: 60_000,
    maxOutputTokens: 4096,
    retries: RETRIES,
    maxPerHour: 1000,
    resolveKey: () => key,
    transport,
  })
  let kind = 'unknown'
  let detail = ''
  let goals: string[] = []
  try {
    const result = await mercury.tryRepair(request, state.trigger)
    if (result === null) {
      kind = 'fatal'
      detail = 'tryRepair returned null (fatal model failure)'
    } else {
      kind = 'success'
      goals = result.goals.map((g) => `${g.kind}:${g.targetItem ?? g.description}`)
      detail = `${result.op} strategy=${result.strategy}`
    }
  } catch (error) {
    kind = error instanceof Error ? error.name : 'error'
    detail = error instanceof Error ? error.message : String(error)
  }
  outcomes.push({
    consultation: i,
    scenario: i % 3,
    kind,
    detail: detail.slice(0, 200),
    rawTexts: rawAttempts.slice(textStart).map((a) => a.text),
    goals,
  })
  process.stdout.write(`  [${i}] scenario=${i % 3} ${kind} ${detail.slice(0, 120)}\n`)
}

// ---- classification -------------------------------------------------------
const liveTexts = rawAttempts.filter((a) => a.text.trim().length > 0)
const emptyTexts = rawAttempts.filter((a) => a.text.trim().length === 0)
const jsonTexts = rawAttempts.filter((a) => a.jsonObject)
const proseOnly = liveTexts.filter((a) => !a.jsonObject)
const schemaOutcomes = outcomes.filter((o) => o.kind === 'MercuryPlanValidationError')
const fatalOutcomes = outcomes.filter((o) => o.kind === 'fatal' || o.kind === 'FatalModelError')
const successOutcomes = outcomes.filter((o) => o.kind === 'success')

const lines: string[] = []
lines.push(`model=${MODEL} consultations=${N} attempts=${rawAttempts.length} retries=${RETRIES}`)
lines.push(`  consultations success             : ${successOutcomes.length}/${N}`)
lines.push(`  consultations plan_rejected(schema): ${schemaOutcomes.length}/${N}`)
lines.push(`  consultations fatal/terminate     : ${fatalOutcomes.length}/${N}`)
lines.push(`  attempts with raw text            : ${liveTexts.length}/${rawAttempts.length}`)
lines.push(`  attempts empty text               : ${emptyTexts.length}/${rawAttempts.length}`)
lines.push(`  attempts parsed to a JSON object  : ${jsonTexts.length}/${rawAttempts.length}`)
lines.push(`  attempts prose-only (no object)   : ${proseOnly.length}/${rawAttempts.length}`)
const shapes: Record<string, number> = {}
for (const a of rawAttempts) shapes[a.shape] = (shapes[a.shape] ?? 0) + 1
lines.push(`  envelope shapes                   : ${JSON.stringify(shapes)}`)
const report = lines.join('\n')
process.stdout.write(`\n${report}\n`)

writeFileSync(
  OUT,
  `${[
    JSON.stringify({ record: 'replica-summary', model: MODEL, consultations: N, retries: RETRIES, report }),
    ...rawAttempts.map((a) => JSON.stringify({ record: 'replica-attempt', ...a })),
    ...outcomes.map((o) => JSON.stringify({ record: 'replica-outcome', ...o })),
  ].join('\n')}\n`,
)
process.stdout.write(`raw evidence -> ${OUT}\n`)
