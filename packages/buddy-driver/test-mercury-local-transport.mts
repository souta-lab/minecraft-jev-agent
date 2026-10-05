// test-mercury-local-transport.mts - local OpenAI-compatible endpoint tests.
//
// Covers the BUDDY_MERCURY_BASE_URL mode: endpoint resolution, the direct
// chat-completions transport (against a deterministic localhost stub server),
// and the MercurySystem2 integration guarantee that local mode never requires
// an AI Gateway key. No external network access is used.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_MERCURY_MAX_PER_HOUR_DEFAULT,
  localMercuryTransport,
  MercurySystem2,
  OPENCODE_GO_MODEL,
  OPENCODE_GO_PROVIDER,
  resolveMercuryLocalEndpoint,
  resolveMercuryOpenCodeGoEndpoint,
  responsesMercuryTransport,
} from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
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
    reason: 'no_progress',
    detail: 'test',
    tick: 1,
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'crafting_table', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [outcome('WAIT'), outcome('WAIT'), outcome('WAIT')],
  }
}

function mercurySummary(): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger: 'no_candidate',
    wakeReason: 'action_impossible',
    wakeDetail: 'test',
    position: { x: 10, y: 62, z: 10 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 0,
    inventory: {},
    stations: { craftingTables: 0, furnaces: 0 },
    knownOres: [],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 0, current: null, hasImpossible: false },
    objective: { targetItem: 'crafting_table', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: ['stone', 'log'], craft: ['crafting_table'], smelt: ['charcoal'] },
  }
}
interface StubRequest {
  readonly url: string
  readonly authorization: string | undefined
  readonly userAgent: string | undefined
  readonly sessionId: string | undefined
  readonly body: { model?: string; messages?: Array<{ role: string; content: string }>; max_tokens?: number; chat_template_kwargs?: Record<string, unknown> }
}

/** Start a localhost stub of an OpenAI-compatible chat-completions server. */
async function startStub(reply: { status: number; content: string | null }): Promise<{
  baseUrl: string
  requests: StubRequest[]
  close: () => Promise<void>
}> {
  const requests: StubRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        userAgent: req.headers['user-agent'],
        sessionId: req.headers['x-opencode-session'] as string | undefined,
        body: JSON.parse(raw) as StubRequest['body'],
      })
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply.content } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface ResponsesStubRequest {
  readonly url: string
  readonly authorization: string | undefined
  readonly userAgent: string | undefined
  readonly sessionId: string | undefined
  readonly body: { model?: string; instructions?: string; input?: string; max_output_tokens?: number; stream?: boolean }
}

async function startResponsesStub(content: string): Promise<{
  baseUrl: string
  requests: ResponsesStubRequest[]
  close: () => Promise<void>
}> {
  const requests: ResponsesStubRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        userAgent: req.headers['user-agent'],
        sessionId: req.headers['x-opencode-session'] as string | undefined,
        body: JSON.parse(raw) as ResponsesStubRequest['body'],
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }],
        usage: { input_tokens: 13, output_tokens: 9 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const VALID_PLAN_JSON = JSON.stringify({
  op: 'patch',
  goals: [{ item: 'stone', count: 3 }],
  reason: 'need stone for the furnace',
})

addCase('resolveMercuryLocalEndpoint is disabled without the env opt-in', () => {
  const resolved = resolveMercuryLocalEndpoint({})
  return { pass: resolved === null, detail: `resolved=${JSON.stringify(resolved)}` }
})

addCase('resolveMercuryLocalEndpoint trims the URL and defaults the key', () => {
  const resolved = resolveMercuryLocalEndpoint({ BUDDY_MERCURY_BASE_URL: ' http://127.0.0.1:8080/v1/ ' })
  const keyed = resolveMercuryLocalEndpoint({
    BUDDY_MERCURY_BASE_URL: 'http://127.0.0.1:8080/v1',
    BUDDY_MERCURY_API_KEY: 'secret',
  })
  const pass =
    resolved?.baseUrl === 'http://127.0.0.1:8080/v1' &&
    resolved.apiKey === 'local' &&
    keyed?.apiKey === 'secret'
  return { pass, detail: `resolved=${JSON.stringify(resolved)} keyed=${JSON.stringify(keyed)}` }
})

addCase('OpenCode Go profile reads file-backed credentials and sends honest stable client headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-go-system2-'))
  const keyFile = join(dir, 'key')
  const sessionFile = join(dir, 'session')
  writeFileSync(keyFile, 'fixture-key\n')
  writeFileSync(sessionFile, 'fixture-session\n')
  const endpoint = resolveMercuryOpenCodeGoEndpoint({
    HOME: dir,
    BUDDY_OPENCODE_GO_API_KEY_FILE: keyFile,
    BUDDY_OPENCODE_GO_SESSION_FILE: sessionFile,
    BUDDY_OPENCODE_GO_USER_AGENT: 'minecraft-jev-agent/test system2',
  }, OPENCODE_GO_PROVIDER)
  const disabled = resolveMercuryOpenCodeGoEndpoint({ HOME: dir }, 'muse-spark')
  if (endpoint === null) return { pass: false, detail: 'OpenCode Go endpoint did not resolve' }
  const stub = await startResponsesStub(VALID_PLAN_JSON)
  try {
    const transport = responsesMercuryTransport(OPENCODE_GO_MODEL, { ...endpoint, baseUrl: stub.baseUrl })
    const result = await transport({ system: 'SYS', prompt: 'PROMPT', maxOutputTokens: 512, timeoutMs: 5000 })
    const req = stub.requests[0]
    const usage = result.usage as { inputTokens?: number; outputTokens?: number } | null
    const pass =
      disabled === null &&
      req?.url === '/v1/responses' &&
      req?.authorization === 'Bearer fixture-key' &&
      req?.userAgent === 'minecraft-jev-agent/test system2' &&
      req?.sessionId === 'fixture-session' &&
      req?.body.model === OPENCODE_GO_MODEL &&
      req?.body.input === 'PROMPT' &&
      req?.body.max_output_tokens === 512 &&
      result.text === VALID_PLAN_JSON &&
      usage?.inputTokens === 13 &&
      usage?.outputTokens === 9 &&
      endpoint.providerLabel === OPENCODE_GO_PROVIDER &&
      endpoint.transportLabel === 'opencode-go-responses'
    return {
      pass,
      detail: `requests=${stub.requests.length} model=${req?.body.model ?? 'none'} ua=${req?.userAgent ?? 'none'} sessionHeader=${req?.sessionId === 'fixture-session'} rawText=${result.text === VALID_PLAN_JSON}`,
    }
  } finally {
    await stub.close()
  }
})

addCase('MercurySystem2 config selects OpenCode Go provider and bare Muse model without Gateway credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-go-config-'))
  const keyFile = join(dir, 'key')
  const sessionFile = join(dir, 'session')
  const configPath = join(dir, 'system2.config.json')
  writeFileSync(keyFile, 'fixture-key\n')
  writeFileSync(sessionFile, 'fixture-session\n')
  writeFileSync(configPath, JSON.stringify({ system2: true, provider: OPENCODE_GO_PROVIDER, model: OPENCODE_GO_MODEL }))
  const prior = {
    key: process.env.BUDDY_OPENCODE_GO_API_KEY_FILE,
    session: process.env.BUDDY_OPENCODE_GO_SESSION_FILE,
    provider: process.env.BUDDY_SYSTEM2_PROVIDER,
    system2Model: process.env.BUDDY_SYSTEM2_MODEL,
    mercuryModel: process.env.BUDDY_MERCURY_MODEL,
  }
  process.env.BUDDY_OPENCODE_GO_API_KEY_FILE = keyFile
  process.env.BUDDY_OPENCODE_GO_SESSION_FILE = sessionFile
  delete process.env.BUDDY_SYSTEM2_PROVIDER
  delete process.env.BUDDY_SYSTEM2_MODEL
  delete process.env.BUDDY_MERCURY_MODEL
  const logs: string[] = []
  try {
    const mercury = new MercurySystem2({
      summarize: () => mercurySummary(),
      log: hostLog(logs),
      callsPath: join(dir, 'calls.jsonl'),
      cachePath: join(dir, 'cache.json'),
      configPath,
      transport: async () => ({ toolCalls: [], usage: null, text: '' }),
    })
    const transportLog = logs.find((line) => line.startsWith('ADVISOR_TRANSPORT')) ?? ''
    const pass =
      mercury.provider === OPENCODE_GO_PROVIDER &&
      mercury.model === OPENCODE_GO_MODEL &&
      transportLog.includes('source=opencode-go') &&
      transportLog.includes('transport=opencode-go-responses') &&
      !transportLog.includes('fixture-key') &&
      !transportLog.includes('fixture-session')
    return { pass, detail: `provider=${mercury.provider} model=${mercury.model} transport=${transportLog}` }
  } finally {
    const restore = (name: string, value: string | undefined) => value === undefined ? delete process.env[name] : (process.env[name] = value)
    restore('BUDDY_OPENCODE_GO_API_KEY_FILE', prior.key)
    restore('BUDDY_OPENCODE_GO_SESSION_FILE', prior.session)
    restore('BUDDY_SYSTEM2_PROVIDER', prior.provider)
    restore('BUDDY_SYSTEM2_MODEL', prior.system2Model)
    restore('BUDDY_MERCURY_MODEL', prior.mercuryModel)
  }
})

addCase('local transport posts chat completions and parses the JSON plan', async () => {
  const stub = await startStub({ status: 200, content: VALID_PLAN_JSON })
  try {
    const transport = localMercuryTransport('bonsai-local', { baseUrl: stub.baseUrl, apiKey: 'test-key' })
    const result = await transport({ system: 'SYS', prompt: 'PROMPT', maxOutputTokens: 512, timeoutMs: 5000 })
    const req = stub.requests[0]
    const input = result.toolCalls[0]?.input as { op?: string; goals?: Array<{ item?: string; count?: number }> }
    const usage = result.usage as { inputTokens?: number; outputTokens?: number } | null
    const pass =
      stub.requests.length === 1 &&
      req?.url === '/v1/chat/completions' &&
      req.authorization === 'Bearer test-key' &&
      req.body.model === 'bonsai-local' &&
      req.body.max_tokens === 512 &&
      req.body.messages?.[0]?.role === 'system' &&
      (req.body.messages?.[0]?.content ?? '').startsWith('SYS') &&
      req.body.messages?.[1]?.content === 'PROMPT' &&
      input.op === 'patch' &&
      input.goals?.[0]?.item === 'stone' &&
      input.goals?.[0]?.count === 3 &&
      usage?.inputTokens === 11 &&
      usage?.outputTokens === 7
    return { pass, detail: `requests=${stub.requests.length} input=${JSON.stringify(input)} usage=${JSON.stringify(usage)}` }
  } finally {
    await stub.close()
  }
})

addCase('local transport returns an empty tool-call list for non-JSON text', async () => {
  const stub = await startStub({ status: 200, content: 'I cannot help with that.' })
  try {
    const transport = localMercuryTransport('bonsai-local', { baseUrl: stub.baseUrl, apiKey: 'local' })
    const result = await transport({ system: 'SYS', prompt: 'PROMPT', maxOutputTokens: 512, timeoutMs: 5000 })
    return {
      pass: result.toolCalls.length === 0,
      detail: `toolCalls=${result.toolCalls.length} (caller converts this into the corrective retry path)`,
    }
  } finally {
    await stub.close()
  }
})

addCase('local transport throws on HTTP errors so the retry/fatal path owns it', async () => {
  const stub = await startStub({ status: 500, content: null })
  try {
    const transport = localMercuryTransport('bonsai-local', { baseUrl: stub.baseUrl, apiKey: 'local' })
    let thrown: unknown = null
    try {
      await transport({ system: 'SYS', prompt: 'PROMPT', maxOutputTokens: 512, timeoutMs: 5000 })
    } catch (error) {
      thrown = error
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    return { pass: message.includes('HTTP 500'), detail: message }
  } finally {
    await stub.close()
  }
})

addCase('local mode never requires an AI Gateway key', async () => {
  const stub = await startStub({ status: 200, content: VALID_PLAN_JSON })
  const dir = mkdtempSync(join(tmpdir(), 'mercury-local-'))
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  const gatewayEnvBefore = process.env.AI_GATEWAY_API_KEY
  delete process.env.AI_GATEWAY_API_KEY
  try {
    const mercury = new MercurySystem2({
      summarize: () => mercurySummary(),
      log: hostLog(logs),
      callsPath,
      cachePath: join(dir, 'mercury-cache.json'),
      maxPerHour: 10,
      model: 'bonsai-local',
      localEndpoint: { baseUrl: stub.baseUrl, apiKey: 'local' },
      // Proves the gateway resolver is never consulted in local mode.
      resolveKey: () => null,
    })
    const repair = await mercury.tryRepair(planRequest(), 'no_candidate')
    const records = existsSync(callsPath)
      ? readFileSync(callsPath, 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as { outcome?: string; model?: string })
      : []
    const transportLog = logs.find((line) => line.startsWith('ADVISOR_TRANSPORT'))
    const pass =
      repair !== null &&
      repair.op === 'patch' &&
      repair.goals.length === 1 &&
      repair.goals[0]?.targetItem === 'stone' &&
      repair.cached === false &&
      records.length === 1 &&
      records[0]?.outcome === 'success' &&
      records[0]?.model === 'bonsai-local' &&
      process.env.AI_GATEWAY_API_KEY === undefined &&
      transportLog !== undefined &&
      transportLog.includes('transport=local-openai-compatible') &&
      transportLog.includes(`baseUrl=${stub.baseUrl}`)
    return {
      pass,
      detail: `repair=${repair === null ? 'null' : repair.op} goals=${repair?.goals.length ?? 0} records=${records.length} transportLog=${transportLog ?? 'none'}`,
    }
  } finally {
    if (gatewayEnvBefore !== undefined) process.env.AI_GATEWAY_API_KEY = gatewayEnvBefore
    await stub.close()
  }
})

addCase('resolveMercuryLocalEndpoint maps NO_THINK to chat_template_kwargs', () => {
  const on = resolveMercuryLocalEndpoint({
    BUDDY_MERCURY_BASE_URL: 'http://127.0.0.1:8080/v1',
    BUDDY_MERCURY_LOCAL_NO_THINK: '1',
  })
  const off = resolveMercuryLocalEndpoint({ BUDDY_MERCURY_BASE_URL: 'http://127.0.0.1:8080/v1' })
  const pass =
    on?.chatTemplateKwargs?.enable_thinking === false &&
    off !== null &&
    off.chatTemplateKwargs === undefined
  return { pass, detail: `on=${JSON.stringify(on?.chatTemplateKwargs)} off=${JSON.stringify(off?.chatTemplateKwargs)}` }
})

addCase('local transport forwards chat_template_kwargs to the server', async () => {
  const stub = await startStub({ status: 200, content: VALID_PLAN_JSON })
  try {
    const transport = localMercuryTransport('bonsai-local', {
      baseUrl: stub.baseUrl,
      apiKey: 'local',
      chatTemplateKwargs: { enable_thinking: false },
    })
    await transport({ system: 'SYS', prompt: 'PROMPT', maxOutputTokens: 512, timeoutMs: 5000 })
    const kwargs = stub.requests[0]?.body.chat_template_kwargs
    return {
      pass: kwargs?.enable_thinking === false,
      detail: `chat_template_kwargs=${JSON.stringify(kwargs)}`,
    }
  } finally {
    await stub.close()
  }
})

addCase('local Mercury default budget is effectively unbounded for resident use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mercury-local-budget-'))
  const logs: string[] = []
  const envBefore = process.env.BUDDY_SYSTEM2_MAX_PER_HOUR
  delete process.env.BUDDY_SYSTEM2_MAX_PER_HOUR
  let transportCalls = 0
  try {
    const mercury = new MercurySystem2({
      summarize: (request) => ({ ...mercurySummary(), wakeDetail: request.detail, recentFailures: [request.detail] }),
      log: hostLog(logs),
      callsPath: join(dir, 'mercury-calls.jsonl'),
      cachePath: join(dir, 'mercury-cache.json'),
      model: 'bonsai-local',
      retries: 0,
      localEndpoint: { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local' },
      transport: async () => {
        transportCalls += 1
        return {
          toolCalls: [{ input: JSON.parse(VALID_PLAN_JSON) }],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      },
    })
    for (let i = 0; i < 25; i += 1) {
      const repair = await mercury.tryRepair({ ...planRequest(), detail: `unique-${i}`, tick: i + 1 }, 'no_candidate')
      if (repair === null) return { pass: false, detail: `repair null at i=${i}` }
    }
    const budgetLog = logs.find((line) => line.startsWith('ADVISOR_TRANSPORT')) ?? ''
    const exhausted = logs.some((line) => line.startsWith('MERCURY_BUDGET_EXHAUSTED'))
    const pass =
      transportCalls === 25 &&
      !exhausted &&
      budgetLog.includes(`maxPerHour=${LOCAL_MERCURY_MAX_PER_HOUR_DEFAULT}`)
    return { pass, detail: `calls=${transportCalls} exhausted=${exhausted} transport=${budgetLog}` }
  } finally {
    if (envBefore === undefined) delete process.env.BUDDY_SYSTEM2_MAX_PER_HOUR
    else process.env.BUDDY_SYSTEM2_MAX_PER_HOUR = envBefore
  }
})

let failures = 0
process.stdout.write('Mercury local OpenAI-compatible transport tests\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} Mercury local transport cases passed\n`)
if (failures > 0) process.exit(1)
