#!/usr/bin/env bun
// Read-only live dashboard for AI_Buddy.
//
// Inputs:
//   - resident control socket `report` (read-only)
//   - append-only buddy.log
//
// The dashboard deliberately renders a structured Decision Trace instead of
// inventing or exposing hidden model reasoning. Every displayed decision field
// comes from resident state or an emitted audit event.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DEFAULT_RUNTIME_DIR = join(REPO, 'buddy-driver')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4173
const DEFAULT_INTERVAL_MS = 1000
const DEFAULT_LOG_TAIL_BYTES = 128 * 1024

const TRACE_EVENTS = new Set([
  'JEV_HEADS',
  'TOOL_CHOICE',
  'SYSTEM2_AUTHORITY_INPUT',
  'SYSTEM2_AUTHORITY_DECISION',
  'SYSTEM2_AUTHORITY_RETRY',
  'SYSTEM2_STALE_DISCARD',
  'MERCURY_ATTEMPT',
  'MERCURY_RETRY',
  'MERCURY_TRIGGER_BACKOFF',
  'MERCURY_TRIGGER_SUPPRESSED',
  'MERCURY_BUDGET_EXHAUSTED',
  'MERCURY_STALE_DISCARD',
  'MERCURY_FAILURE_STATE',
  'PLAN_REJECTED',
  'ACTION',
  'ACTION_COMMIT',
  'ACTION_PREEMPT',
  'ACTION_UNVERIFIED',
  'HEARTBEAT',
  'MILESTONE',
  'DEATH',
  'GENERATION_READY',
  'RELOAD',
  'DISCONNECT',
  'RECONNECT_SUCCESS',
])

const SECRET_KEY = /(api.?key|authorization|cookie|password|secret|token)/i

function coerceValue(raw) {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  if (/^[\[{\"]/.test(raw)) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** Parse the resident logger's `key=value` tail without splitting JSON values. */
export function parseDetail(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  const matches = [...raw.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+)=/g)]
  const detail = {}
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const key = match[1]
    if (key === undefined || SECRET_KEY.test(key)) continue
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? raw.length) : raw.length
    detail[key] = coerceValue(raw.slice(start, end).trim())
  }
  return detail
}

export function parseBuddyLogLine(line) {
  const match = /^\[([^\]]+)]\s+(\S+)(?:\s+(.*))?$/.exec(line.trim())
  if (match === null) return null
  const [, ts, event, raw = ''] = match
  return {
    ts,
    event,
    detail: parseDetail(raw),
    raw: line.trim(),
  }
}

export function readLogTail(logPath, maxBytes = DEFAULT_LOG_TAIL_BYTES) {
  if (!existsSync(logPath)) return []
  const fd = openSync(logPath, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, Math.max(0, size - length))
    const text = buffer.toString('utf8')
    const clean = size > length ? text.slice(text.indexOf('\n') + 1) : text
    return clean
      .split('\n')
      .map(parseBuddyLogLine)
      .filter((entry) => entry !== null)
  } finally {
    closeSync(fd)
  }
}

export function latestEvent(events, names) {
  const accepted = names instanceof Set ? names : new Set(names)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index]
    if (entry !== undefined && accepted.has(entry.event)) return entry
  }
  return null
}

export async function callControlSocket(socketPath, cmd = 'report', timeoutMs = 1500) {
  return await new Promise((resolvePromise) => {
    if (!existsSync(socketPath)) return resolvePromise(null)
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        finish(JSON.parse(buffer.slice(0, newline)))
      } catch {
        finish(null)
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: Date.now() % 1_000_000, cmd, args: {} })}\n`)
    })
  })
}

function readMission(contractPath) {
  try {
    const parsed = JSON.parse(readFileSync(contractPath, 'utf8'))
    const m4 = parsed?.milestones?.M4
    return { id: 'M4', title: typeof m4?.title === 'string' ? m4.title : 'Ender Dragon' }
  } catch {
    return { id: 'M4', title: 'Ender Dragon' }
  }
}

function queueProjection(status) {
  const queue = status?.queue ?? null
  const current = queue?.current ?? null
  return {
    depth: queue?.depth ?? null,
    done: queue?.done ?? null,
    revision: queue?.revision ?? null,
    current: current === null ? null : {
      id: current.id ?? null,
      kind: current.kind ?? null,
      description: current.description ?? null,
      status: current.status ?? null,
      targetItem: current.targetItem ?? null,
      haveCount: current.haveCount ?? null,
      requiredCount: current.requiredCount ?? null,
      semanticOptionIntent: current.semanticOptionIntent ?? null,
      semanticOptionTemplateId: current.semanticOptionTemplateId ?? current.optionTemplateId ?? null,
      semanticOptionInstanceId: current.semanticOptionInstanceId ?? current.optionInstanceId ?? null,
      detail: current.detail ?? null,
    },
  }
}

function traceProjection(entry) {
  if (entry === null) return null
  return { ts: entry.ts, event: entry.event, detail: entry.detail }
}

export function buildObserverSnapshot({ report, events, mission, now = Date.now() }) {
  const data = report?.ok === true ? report.data : null
  const status = data?.status ?? null
  const relevantEvents = events.filter((entry) => TRACE_EVENTS.has(entry.event)).slice(-60)
  const jev = latestEvent(relevantEvents, ['JEV_HEADS', 'TOOL_CHOICE'])
  const system2Input = latestEvent(relevantEvents, ['SYSTEM2_AUTHORITY_INPUT'])
  const system2Decision = latestEvent(relevantEvents, ['SYSTEM2_AUTHORITY_DECISION', 'SYSTEM2_STALE_DISCARD'])
  const mercury = latestEvent(relevantEvents, new Set([
    'MERCURY_ATTEMPT',
    'MERCURY_RETRY',
    'MERCURY_TRIGGER_BACKOFF',
    'MERCURY_TRIGGER_SUPPRESSED',
    'MERCURY_BUDGET_EXHAUSTED',
    'MERCURY_STALE_DISCARD',
    'MERCURY_FAILURE_STATE',
    'PLAN_REJECTED',
  ]))
  const latestActionEvent = latestEvent(relevantEvents, ['ACTION', 'ACTION_COMMIT', 'ACTION_PREEMPT', 'ACTION_UNVERIFIED'])
  const queue = queueProjection(status)
  const current = queue.current

  return {
    schemaVersion: 1,
    observedAt: new Date(now).toISOString(),
    resident: {
      available: data !== null,
      connected: data?.connected ?? false,
      frozen: data?.frozen ?? null,
      runId: data?.runId ?? null,
      generationId: data?.generationId ?? null,
      generationHash: data?.generationHash ?? null,
      worldKey: data?.worldKey ?? status?.worldKey ?? null,
    },
    mission,
    goal: {
      frontier: status?.rungId ?? data?.milestone ?? null,
      frontierIndex: status?.rungIndex ?? null,
      queue,
    },
    option: current === null ? null : {
      intent: current.semanticOptionIntent ?? current.description,
      templateId: current.semanticOptionTemplateId,
      instanceId: current.semanticOptionInstanceId,
    },
    action: status?.currentAction ?? null,
    truth: status?.truth ?? null,
    authority: {
      policy: status === null ? null : {
        kind: status.policyKind ?? null,
        provider: status.policyProvider ?? null,
        model: status.policyModel ?? null,
      },
      system2: status === null ? null : {
        configured: status.system2AuthorityStack ?? null,
        last: status.system2LastAuthority ?? {
          provider: status.system2Provider ?? null,
          model: status.system2Model ?? null,
        },
      },
      deterministicFallbackEnabled: status?.deterministicFallbackEnabled ?? null,
    },
    decisionTrace: {
      jev: traceProjection(jev),
      system2Input: traceProjection(system2Input),
      system2Decision: traceProjection(system2Decision),
      mercury: traceProjection(mercury),
      action: traceProjection(latestActionEvent),
    },
    events: relevantEvents.slice(-30).reverse().map(traceProjection),
  }
}

export function createObserver({ runtimeDir = DEFAULT_RUNTIME_DIR, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const socketPath = join(runtimeDir, 'data', 'resident', 'control.sock')
  const logPath = join(runtimeDir, 'buddy.log')
  const mission = readMission(join(REPO, 'MILESTONE-CONTRACT.json'))

  const snapshot = async () => {
    const [report, events] = await Promise.all([
      callControlSocket(socketPath, 'report'),
      Promise.resolve(readLogTail(logPath)),
    ])
    return buildObserverSnapshot({ report, events, mission })
  }

  return { runtimeDir, socketPath, logPath, mission, intervalMs, snapshot }
}

function htmlPage() {
  return String.raw`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Buddy Observer</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0e13; color: #e7edf5; }
    header { position: sticky; top: 0; z-index: 2; display:flex; gap:16px; align-items:center; justify-content:space-between; padding:16px 22px; background:#10151dcc; backdrop-filter: blur(12px); border-bottom:1px solid #263041; }
    h1 { font-size:18px; margin:0; letter-spacing:.02em; }
    .status { display:flex; gap:10px; align-items:center; color:#9fafc2; font-size:13px; }
    .dot { width:9px; height:9px; border-radius:999px; background:#687587; box-shadow:0 0 0 4px #68758722; }
    .dot.online { background:#50d890; box-shadow:0 0 0 4px #50d89022; }
    main { max-width:1400px; margin:0 auto; padding:22px; }
    .flow { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
    .flow-card,.card { background:#121821; border:1px solid #263041; border-radius:14px; padding:14px; min-width:0; }
    .flow-card .eyebrow,.eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:.12em; color:#73839a; margin-bottom:8px; }
    .flow-card .primary { font-size:16px; font-weight:650; overflow-wrap:anywhere; }
    .flow-card .secondary { margin-top:7px; color:#9fafc2; font-size:12px; overflow-wrap:anywhere; }
    .grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:14px; }
    .card { grid-column:span 4; }
    .card.wide { grid-column:span 8; }
    .card.full { grid-column:1/-1; }
    h2 { margin:0 0 12px; font-size:15px; }
    dl { display:grid; grid-template-columns:minmax(110px,.8fr) 2fr; gap:7px 12px; margin:0; font-size:13px; }
    dt { color:#73839a; }
    dd { margin:0; overflow-wrap:anywhere; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .trace { display:grid; gap:9px; }
    .trace-row { border-left:2px solid #39485d; padding:8px 10px; background:#0e131a; border-radius:0 8px 8px 0; }
    .trace-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:6px; }
    .trace-event { font-weight:650; font-size:12px; }
    .trace-time { color:#65748a; font-size:11px; white-space:nowrap; }
    .trace-detail { color:#afbdcf; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .empty { color:#65748a; font-size:13px; }
    .note { color:#7f8da1; font-size:12px; margin:0 0 14px; }
    @media (max-width: 900px) { .flow { grid-template-columns:1fr 1fr; } .card,.card.wide { grid-column:1/-1; } }
    @media (max-width: 560px) { main { padding:12px; } header { padding:13px 14px; } .flow { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>AI Buddy Observer</h1>
    <div class="status"><span id="dot" class="dot"></span><span id="resident">resident unavailable</span><span id="updated">--:--:--</span></div>
  </header>
  <main>
    <p class="note">Decision Trace は resident が実際に記録した Goal / Option / Jev / System2 / Action の監査情報です。</p>
    <section class="flow">
      <div class="flow-card"><div class="eyebrow">Goal</div><div id="flow-goal" class="primary">—</div><div id="flow-goal-sub" class="secondary"></div></div>
      <div class="flow-card"><div class="eyebrow">Option</div><div id="flow-option" class="primary">—</div><div id="flow-option-sub" class="secondary"></div></div>
      <div class="flow-card"><div class="eyebrow">Decision</div><div id="flow-decision" class="primary">—</div><div id="flow-decision-sub" class="secondary"></div></div>
      <div class="flow-card"><div class="eyebrow">Action</div><div id="flow-action" class="primary">—</div><div id="flow-action-sub" class="secondary"></div></div>
    </section>
    <section class="grid">
      <article class="card"><h2>Mission / Goal</h2><dl id="goal"></dl></article>
      <article class="card"><h2>Jev authority</h2><dl id="jev"></dl></article>
      <article class="card"><h2>System2 / Mercury</h2><dl id="system2"></dl></article>
      <article class="card wide"><h2>Decision Trace</h2><div id="trace" class="trace"></div></article>
      <article class="card"><h2>World truth</h2><dl id="truth"></dl></article>
      <article class="card full"><h2>Recent audit events</h2><div id="events" class="trace"></div></article>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id)
    const text = (value, fallback='—') => value === null || value === undefined || value === '' ? fallback : String(value)
    const compact = (value) => value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value)
    const rows = (target, entries) => { target.innerHTML = entries.map(([k,v]) => '<dt>'+escapeHtml(k)+'</dt><dd>'+escapeHtml(compact(v))+'</dd>').join('') }
    const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    const eventRow = (entry) => {
      if (!entry) return '<div class="empty">No observed decision yet.</div>'
      const time = entry.ts ? new Date(entry.ts).toLocaleTimeString() : ''
      return '<div class="trace-row"><div class="trace-head"><span class="trace-event">'+escapeHtml(entry.event)+'</span><span class="trace-time">'+escapeHtml(time)+'</span></div><div class="trace-detail">'+escapeHtml(JSON.stringify(entry.detail, null, 2))+'</div></div>'
    }
    function render(s) {
      $('dot').className = 'dot' + (s.resident.available && s.resident.connected ? ' online' : '')
      $('resident').textContent = s.resident.available ? (s.resident.connected ? 'connected' : 'resident online / bot disconnected') : 'resident unavailable'
      $('updated').textContent = new Date(s.observedAt).toLocaleTimeString()
      const current = s.goal.queue.current
      const j = s.decisionTrace.jev
      $('flow-goal').textContent = text(current?.description, text(s.goal.frontier))
      $('flow-goal-sub').textContent = 'frontier=' + text(s.goal.frontier) + ' · depth=' + text(s.goal.queue.depth)
      $('flow-option').textContent = text(s.option?.intent)
      $('flow-option-sub').textContent = text(s.option?.templateId)
      $('flow-decision').textContent = text(j?.detail?.action, text(s.decisionTrace.system2Decision?.detail?.chosen, text(s.decisionTrace.system2Decision?.detail?.strategy)))
      $('flow-decision-sub').textContent = j ? 'Jev · ' + text(j.detail.decision) : s.decisionTrace.system2Decision ? 'System2 · ' + text(s.decisionTrace.system2Decision.detail.provider) : '—'
      $('flow-action').textContent = text(s.action?.kind, text(s.decisionTrace.action?.detail?.kind))
      $('flow-action-sub').textContent = s.action ? text(s.action.phase) + ' · ' + text(s.action.id) : text(s.decisionTrace.action?.detail?.id)
      rows($('goal'), [
        ['mission', s.mission.id + ': ' + s.mission.title], ['frontier', s.goal.frontier], ['current', current?.description], ['progress', current ? text(current.haveCount) + '/' + text(current.requiredCount) : null], ['queue depth', s.goal.queue.depth], ['queue revision', s.goal.queue.revision], ['option', s.option?.intent], ['option id', s.option?.templateId]
      ])
      rows($('jev'), [
        ['provider', s.authority.policy?.provider], ['model', s.authority.policy?.model], ['policy', s.authority.policy?.kind], ['selected action', j?.detail?.action], ['abandon p', j?.detail?.abandon], ['beta decision', j?.detail?.decision], ['beta authority', j?.detail?.betaAuthority]
      ])
      rows($('system2'), [
        ['configured', s.authority.system2?.configured], ['last authority', s.authority.system2?.last], ['trigger', s.decisionTrace.system2Input?.detail?.trigger ?? s.decisionTrace.system2Input?.detail?.reason], ['candidate options', s.decisionTrace.system2Input?.detail?.optionIds], ['selected', s.decisionTrace.system2Decision?.detail?.chosen ?? s.decisionTrace.system2Decision?.detail?.strategy], ['goals', s.decisionTrace.system2Decision?.detail?.goals], ['Mercury state', s.decisionTrace.mercury?.event]
      ])
      rows($('truth'), [
        ['position', s.truth?.position], ['dimension', s.truth?.dimension], ['health', s.truth?.health], ['food', s.truth?.food], ['on ground', s.truth?.onGround], ['inventory', s.truth?.inventory], ['generation', s.resident.generationId], ['run', s.resident.runId]
      ])
      $('trace').innerHTML = [s.decisionTrace.jev, s.decisionTrace.system2Input, s.decisionTrace.system2Decision, s.decisionTrace.mercury, s.decisionTrace.action].filter(Boolean).map(eventRow).join('') || '<div class="empty">No observed decision yet.</div>'
      $('events').innerHTML = s.events.map(eventRow).join('') || '<div class="empty">No audit events in the current log tail.</div>'
    }
    async function fallback() { try { render(await fetch('/api/snapshot', {cache:'no-store'}).then(r => r.json())) } catch {} }
    const stream = new EventSource('/events')
    stream.onmessage = (event) => { try { render(JSON.parse(event.data)) } catch {} }
    stream.onerror = fallback
    fallback()
  </script>
</body>
</html>`
}

export function startObserverServer(options = {}) {
  const observer = createObserver(options)
  const hostname = options.hostname ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT

  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
      if (url.pathname === '/') {
        return new Response(htmlPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/api/snapshot') {
        return Response.json(await observer.snapshot(), { headers: { 'cache-control': 'no-store' } })
      }
      if (url.pathname === '/events') {
        let timer = null
        const stream = new ReadableStream({
          start(controller) {
            const emit = async () => {
              try {
                const current = await observer.snapshot()
                controller.enqueue(`data: ${JSON.stringify(current)}\n\n`)
              } catch (error) {
                controller.enqueue(`event: observer-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`)
              }
            }
            void emit()
            timer = setInterval(() => void emit(), observer.intervalMs)
          },
          cancel() {
            if (timer !== null) clearInterval(timer)
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-store',
            connection: 'keep-alive',
          },
        })
      }
      return new Response('Not Found', { status: 404 })
    },
  })

  return { server, observer, url: `http://${hostname}:${server.port}` }
}

if (import.meta.main) {
  const runtimeDir = resolve(process.env.BUDDY_OBSERVER_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR)
  const hostname = process.env.BUDDY_OBSERVER_HOST?.trim() || DEFAULT_HOST
  const rawPort = Number(process.env.BUDDY_OBSERVER_PORT ?? DEFAULT_PORT)
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : DEFAULT_PORT
  const rawInterval = Number(process.env.BUDDY_OBSERVER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 250 ? rawInterval : DEFAULT_INTERVAL_MS
  const { url, observer } = startObserverServer({ runtimeDir, hostname, port, intervalMs })
  process.stdout.write(`AI_BUDDY_OBSERVER url=${url} runtime=${observer.runtimeDir} mode=read-only\n`)
}
