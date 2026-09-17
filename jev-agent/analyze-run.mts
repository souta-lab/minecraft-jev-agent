// analyze-run.mts - post-run evidence extractor for the "how far ahead each
// layer thinks" design. It reads the JSONL logs a demo run just wrote and prints,
// with raw numbers:
//
//   * the ONE batched Jev request (all 7 questions, latency, usage.inputTokens),
//   * any decision where need_llm=true caused an LLM summon, with the reason,
//   * the verified-dig walk window and the Jev calls inside it (expected zero),
//   * total Jev calls for the run and the verified digs,
//   * cost accounting at $0.04 / 1M input tokens (output free).
//
// Run: npm run analyze              (defaults to logs/)
//      npx tsx analyze-run.mts --log-dir logs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Args {
  logDir: string
  inputPricePerMillion: number
}

function parseArgs(argv: string[]): Args {
  const opt = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`)
    const value = index === -1 ? undefined : argv[index + 1]
    return value ?? fallback
  }
  return {
    logDir: opt('log-dir', 'logs'),
    inputPricePerMillion: Number(opt('input-price', '0.04')),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readField(source: unknown, key: string): unknown {
  return asRecord(source)?.[key]
}

function readString(source: unknown, key: string): string | null {
  const value = readField(source, key)
  return typeof value === 'string' ? value : null
}

function readNumber(source: unknown, key: string): number | null {
  const value = readField(source, key)
  return typeof value === 'number' ? value : null
}

function readBool(source: unknown, key: string): boolean | null {
  const value = readField(source, key)
  return typeof value === 'boolean' ? value : null
}

function readJsonl(path: string): unknown[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed) as unknown)
    } catch {
      // skip malformed line
    }
  }
  return out
}

function ms(ts: string): number {
  return Date.parse(ts)
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

const args = parseArgs(process.argv.slice(2))
const runPath = join(args.logDir, 'run.jsonl')
const jevPath = join(args.logDir, 'jev-calls.jsonl')
const decisionPath = join(args.logDir, 'decisions.jsonl')
const system2Path = join(args.logDir, 'system2.jsonl')

const runRecords = readJsonl(runPath)
const jevRecords = readJsonl(jevPath)
const decisionRecords = readJsonl(decisionPath)
const system2Records = readJsonl(system2Path)

interface Event {
  ts: string
  at: number
  source: string
  message: string
}

const events: Event[] = []
for (const record of runRecords) {
  const ts = readString(record, 'ts')
  const message = readString(record, 'message')
  if (ts === null || message === null) continue
  if (readString(record, 'record') !== 'agent-event') continue
  events.push({ ts, at: ms(ts), source: readString(record, 'source') ?? '?', message })
}
events.sort((a, b) => a.at - b.at)

const startEvents = events.filter((event) => event.message.startsWith('jev-agent started'))
const startEvent = startEvents[startEvents.length - 1]
if (startEvent === undefined) {
  process.stdout.write('[analyze] no "jev-agent started" event found; run the demo first\n')
  process.exit(1)
}
const endEvent = events[events.length - 1] ?? startEvent
const startAt = startEvent.at
const endAt = endEvent.at
const durationMs = Math.max(0, endAt - startAt)

interface Call {
  ts: string
  at: number
  policy: string
  model: string
  stage: string
  latencyMs: number
  inputTokens: number | null
  questionNames: string[]
  answerNames: string[]
  record: unknown
}

const calls: Call[] = []
for (const record of jevRecords) {
  if (readString(record, 'record') !== 'jev-call') continue
  const ts = readString(record, 'ts')
  if (ts === null) continue
  const at = ms(ts)
  if (at < startAt || at > endAt) continue
  const response = readField(record, 'response')
  const usage = readField(response, 'usage')
  const questions = asRecord(readField(record, 'questions')) ?? {}
  const answers = asRecord(readField(response, 'answers')) ?? {}
  calls.push({
    ts,
    at,
    policy: readString(record, 'policy') ?? '?',
    model: readString(record, 'model') ?? '?',
    stage: readString(record, 'stage') ?? '?',
    latencyMs: readNumber(record, 'latencyMs') ?? 0,
    inputTokens: readNumber(usage, 'inputTokens'),
    questionNames: Object.keys(questions),
    answerNames: Object.keys(answers),
    record,
  })
}
calls.sort((a, b) => a.at - b.at)

const realCalls = calls.filter((call) => call.policy === 'typesafe')
const questionNames = Array.from(new Set(realCalls.flatMap((call) => call.questionNames))).sort()
const totalInputTokens = realCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0)
const costUsd = (totalInputTokens / 1_000_000) * args.inputPricePerMillion
const durationHours = durationMs / 3_600_000
const projectedPerHour = durationHours > 0 ? costUsd / durationHours : 0
const callRatePerMin = durationMs > 0 ? realCalls.length / (durationMs / 60_000) : 0

process.stdout.write('===== jev-agent run analysis =====\n')
process.stdout.write(`window: ${iso(startAt)} .. ${iso(endAt)} (${durationMs} ms)\n`)
const summaryLine = events.filter((event) => event.message.startsWith('stopped reason=')).pop()
process.stdout.write(`stop: ${summaryLine?.message ?? 'n/a'}\n\n`)

process.stdout.write(`--- (a) ONE batched Jev request (all questions in a single call) ---\n`)
process.stdout.write(`real (typesafe) calls in window: ${realCalls.length}\n`)
process.stdout.write(`distinct question names across the batch: ${questionNames.length} -> ${questionNames.join(', ')}\n`)
process.stdout.write(`latency p50-ish samples: ${realCalls.slice(0, 5).map((call) => call.latencyMs).join(', ')} ms\n`)
const sample = realCalls[0]
if (sample !== undefined) {
  process.stdout.write(`first real call ts=${sample.ts} stage=${sample.stage} latencyMs=${sample.latencyMs} inputTokens=${sample.inputTokens}\n`)
  process.stdout.write(`raw request/response JSONL record (state/questions truncated for display):\n`)
  const record = asRecord(sample.record) ?? {}
  const compact = {
    record: readString(record, 'record'),
    callId: readString(record, 'callId'),
    ts: readString(record, 'ts'),
    policy: readString(record, 'policy'),
    model: readString(record, 'model'),
    stage: readString(record, 'stage'),
    latencyMs: readNumber(record, 'latencyMs'),
    usage: readField(readField(record, 'response'), 'usage'),
    questions: sample.questionNames,
    answers: sample.answerNames,
  }
  process.stdout.write(`${JSON.stringify(compact)}\n`)
}
process.stdout.write('\n')

process.stdout.write(`--- (b) decisions where need_llm=true escalated to the stubbed LLM ---\n`)
interface Decision {
  ts: string
  at: number
  tick: number | null
  trigger: string
  chosenAction: string
  needLlm: number | null
  needLlmAdopted: boolean | null
  resummon: unknown
  queueDepth: number | null
}
const decisions: Decision[] = []
for (const record of decisionRecords) {
  if (readString(record, 'record') !== 'decision') continue
  const ts = readString(record, 'ts')
  if (ts === null) continue
  const at = ms(ts)
  if (at < startAt || at > endAt) continue
  decisions.push({
    ts,
    at,
    tick: readNumber(record, 'tick'),
    trigger: readString(record, 'trigger') ?? '?',
    chosenAction: readString(record, 'chosenAction') ?? '?',
    needLlm: readNumber(record, 'needLlm'),
    needLlmAdopted: readBool(record, 'needLlmAdopted'),
    resummon: readField(record, 'llmResummon'),
    queueDepth: readNumber(readField(record, 'goalQueueState'), 'depth'),
  })
}
const needLlmDecisions = decisions.filter((entry) => entry.needLlmAdopted === true)
process.stdout.write(`decisions in window: ${decisions.length}; with needLlmAdopted=true: ${needLlmDecisions.length}\n`)
for (const entry of needLlmDecisions.slice(0, 5)) {
  process.stdout.write(
    `  ts=${entry.ts} tick=${entry.tick} trigger=${entry.trigger} P(need_llm)=${entry.needLlm} ` +
      `chosen=${entry.chosenAction} queueDepth=${entry.queueDepth} llmResummon=${JSON.stringify(entry.resummon)}\n`,
  )
}
const summonLines = events.filter((event) => event.message.includes('SUMMON LLM reason=need_llm'))
for (const line of summonLines.slice(0, 5)) {
  process.stdout.write(`  logline: ${line.ts} [${line.source}] ${line.message}\n`)
}
const planRecords = system2Records.filter((record) => readString(record, 'record') === 'system2-plan')
process.stdout.write(`system2-plan records in file: ${planRecords.length}\n`)
process.stdout.write('\n')

process.stdout.write(`--- (c) walk window with ZERO Jev calls ---\n`)
const startRe = /^action#(\d+) (\S+) START/
interface ActionWindow {
  epoch: number
  actionId: string
  startTs: string
  startAt: number
  endTs: string
  endAt: number
  endMessage: string
}
const windows: ActionWindow[] = []
for (let index = 0; index < events.length; index += 1) {
  const event = events[index]
  if (event === undefined) continue
  const match = startRe.exec(event.message)
  if (match === null) continue
  const epoch = Number(match[1])
  const actionId = match[2] ?? '?'
  let endTs = event.ts
  let endAt = event.at
  let endMessage = 'still running'
  for (let cursor = index + 1; cursor < events.length; cursor += 1) {
    const later = events[cursor]
    if (later === undefined) continue
    if (later.source === 'verify' || later.message.startsWith('VERIFIED')) {
      endTs = later.ts
      endAt = later.at
      endMessage = later.message
      break
    }
    if (later.message.includes(`action#${epoch}`) && /(CANCELLED|FAILED|CRASHED)/.test(later.message)) {
      endTs = later.ts
      endAt = later.at
      endMessage = later.message
      break
    }
    const nextStart = startRe.exec(later.message)
    if (nextStart !== null && Number(nextStart[1]) !== epoch) {
      endTs = later.ts
      endAt = later.at
      endMessage = `superseded: ${later.message}`
      break
    }
  }
  windows.push({ epoch, actionId, startTs: event.ts, startAt: event.at, endTs, endAt, endMessage })
}
const finishedWindows = windows.filter((window) => window.endAt > window.startAt)
finishedWindows.sort((a, b) => b.endAt - b.startAt - (a.endAt - a.startAt))
for (const window of finishedWindows.slice(0, 3)) {
  const inside = calls.filter((call) => call.at >= window.startAt && call.at <= window.endAt)
  process.stdout.write(
    `action#${window.epoch} ${window.actionId}: ${window.startTs} -> ${window.endTs} ` +
      `(${window.endAt - window.startAt} ms) terminal="${window.endMessage}" jevCallsInside=${inside.length}\n`,
  )
  for (const call of inside) process.stdout.write(`    jev-call ${call.ts} latency=${call.latencyMs}ms\n`)
}
const verifiedWindow = finishedWindows.find((window) => window.endMessage.startsWith('VERIFIED'))
if (verifiedWindow !== undefined) {
  process.stdout.write(`\nverified-dig walk timeline (action#${verifiedWindow.epoch} ${verifiedWindow.actionId}):\n`)
  const excerpt = events.filter((event) => event.at >= verifiedWindow.startAt && event.at <= verifiedWindow.endAt)
  for (const event of excerpt) {
    process.stdout.write(`  ${event.ts} [${event.source}] ${event.message}\n`)
  }
  const callsInWindow = calls.filter((call) => call.at >= verifiedWindow.startAt && call.at <= verifiedWindow.endAt)
  process.stdout.write(`  -> Jev calls strictly inside this ${verifiedWindow.endAt - verifiedWindow.startAt} ms walk window: ${callsInWindow.length}\n`)
}
process.stdout.write('\n')

process.stdout.write(`--- (d) totals + cost ---\n`)
const verifiedDigs = events.filter((event) => event.message.startsWith('VERIFIED')).length
process.stdout.write(`total Jev calls in window: ${realCalls.length} (typesafe)\n`)
process.stdout.write(`verified dig events in window: ${verifiedDigs}\n`)
process.stdout.write(
  `inputTokens total=${totalInputTokens} cost=$${costUsd.toFixed(6)} ` +
    `($${args.inputPricePerMillion}/1M input, output free)\n`,
)
process.stdout.write(`call rate=${callRatePerMin.toFixed(2)} calls/min\n`)
process.stdout.write(`projected cost/hour at this rate=$${projectedPerHour.toFixed(4)}\n`)
