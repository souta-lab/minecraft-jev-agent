#!/usr/bin/env node
// Jev latency/cost benchmark through the Vercel AI Gateway.
//
//   node bench.mjs [--calls N] [--bucket name[,name...]] [--out file] [--append] [--seed N] [--calibrate]
//
// Path: ai SDK v7 -> experimental_evaluate -> model 'typesafe-ai/jev'.
// The gateway key is read from a 0600 file and is NEVER printed or logged.
//
// Default run = the full interleaved suite:
//   cold(1) + warm(14) + q1(12) + q10(12) + s4k(12) + s8k(12) + burst(15 in 3x5)
// = 78 calls, << $0.05 of input at $0.04 / 1M tokens (output is not billed).

import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = '/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key'
const MODEL = 'typesafe-ai/jev'
const INPUT_PRICE_PER_MTOK = 0.04 // USD per 1M input tokens; output is not billed

// ---------------------------------------------------------------------------
// key: read once, never printed. A length/prefix check is all we ever expose.
// ---------------------------------------------------------------------------
const KEY = readFileSync(KEY_FILE, 'utf8').trim()
process.env.AI_GATEWAY_API_KEY = KEY
if (KEY.length < 20) throw new Error('gateway key looks too short, refusing to run')

const { experimental_evaluate: evaluate } = await import('ai')

// ---------------------------------------------------------------------------
// deterministic RNG so runs are reproducible
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// realistic Minecraft-like state padding (entities / blocks), not random junk
// ---------------------------------------------------------------------------
const BLOCK_TYPES = [
  ['oak_log', 'log'], ['oak_leaves', 'leaves'], ['grass_block', 'ground'],
  ['dirt', 'ground'], ['stone', 'stone'], ['cobblestone', 'stone'],
  ['sand', 'ground'], ['water', 'liquid'], ['lava', 'hazard'],
  ['iron_ore', 'ore'], ['coal_ore', 'ore'], ['crafting_table', 'utility'],
  ['chest', 'utility'], ['torch', 'utility'], ['gravel', 'ground'],
  ['birch_log', 'log'], ['spruce_log', 'log'], ['andesite', 'stone'],
]
const MOB_NAMES = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cow', 'sheep', 'pig',
  'chicken', 'item', 'armor_stand', 'villager', 'enderman',
]
const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman'])

export function makeBlocks(n, rng) {
  const out = []
  for (let i = 0; i < n; i++) {
    const [name, kind] = BLOCK_TYPES[Math.floor(rng() * BLOCK_TYPES.length)]
    const x = 20 + Math.floor((rng() - 0.5) * 64)
    const y = 60 + Math.floor(rng() * 22)
    const z = -80 + Math.floor((rng() - 0.5) * 64)
    const distance = +(rng() * 40).toFixed(1)
    out.push({
      kind,
      name,
      position: { x, y, z },
      distance,
      inReach: distance <= 4.5,
      hasAdjacentStandable: rng() > 0.25,
    })
  }
  return out
}

export function makeEntities(n, rng) {
  const out = []
  for (let i = 0; i < n; i++) {
    const name = MOB_NAMES[Math.floor(rng() * MOB_NAMES.length)]
    out.push({
      id: 6000 + i,
      name,
      distance: +(rng() * 48).toFixed(1),
      hostile: HOSTILE.has(name),
    })
  }
  return out
}

function makeTerrain(n, rng) {
  const standable = []
  for (let i = 0; i < Math.max(2, Math.round(n / 6)); i++) {
    standable.push({
      x: 20 + Math.floor((rng() - 0.5) * 24),
      y: 60 + Math.floor(rng() * 8),
      z: -80 + Math.floor((rng() - 0.5) * 24),
    })
  }
  return { standable }
}

export function makeState(size, rng) {
  const { blocks, entities } = size
  const bs = makeBlocks(blocks, rng)
  const logs = bs.filter((b) => b.kind === 'log').slice(0, 4)
  return {
    schemaVersion: 1,
    tick: 42,
    timestampMs: Date.now(),
    self: {
      position: { x: 27.5, y: 70, z: -63.25 },
      eyePosition: { x: 27.5, y: 71.62, z: -63.25 },
      health: 20,
      food: 18,
      gameMode: 'survival',
      dimension: 'overworld',
      heldItem: { name: 'stone_axe', count: 1, slot: 36 },
    },
    inventory: { counts: { stone_axe: 1, oak_log: 3, bread: 2, torch: 16, cobblestone: 12 } },
    entities: makeEntities(entities, rng),
    blocks: bs,
    terrain: makeTerrain(blocks, rng),
    goal: { targetItem: 'oak_log', requiredCount: 1, haveCount: 0, progress: 0, complete: false },
    recentEvents: [
      'spawned at (27,70,-63)',
      'pathfinder: goal_reached',
      'scan: found ' + logs.length + ' oak_log candidates',
    ],
    signals: {
      consecutiveFailures: 0,
      lastPathStatus: 'idle',
      stalledMs: 400,
      maxConcurrentActions: 1,
      escalationRecommended: false,
      failedCandidates: {},
    },
    // candidate ids the questions can refer to
    _candidateLogs: logs.map((b) => `MINE:b${b.position.x}_${b.position.y}_${b.position.z}`),
  }
}

// ---------------------------------------------------------------------------
// questions: only the three supported types (choice | score | boolean)
// ---------------------------------------------------------------------------
const ACTION_INSTR =
  'Pick the single next macro-action that best serves the goal. Answer with the id verbatim.'

export function makeQuestions(n, state) {
  const logs = state._candidateLogs
  const actionCriteria = {}
  for (const id of logs) actionCriteria[id] = `mine the oak_log target ${id}`
  actionCriteria['WAIT'] = 'do nothing for one tick'
  actionCriteria['ESCALATE'] = 'ask the slower planner because the situation is unclear'

  const pool = [
    ['action', { type: 'choice', instructions: ACTION_INSTR, criteria: actionCriteria }],
    ['danger', { type: 'score', instructions: 'How dangerous is the current situation?', criteria: ['safe', 'minor', 'dangerous', 'lethal'] }],
    ['goal_done', { type: 'boolean', instructions: 'The goal is already achieved' }],
    ['should_retreat', { type: 'boolean', instructions: 'The bot should retreat' }],
    ['mine_target', { type: 'choice', instructions: 'Which block should the bot mine this tick?', criteria: Object.fromEntries([...logs.map((id) => [id, `oak_log ${id}`]), ['none', 'mine nothing']]) }],
    ['combat_target', { type: 'choice', instructions: 'Which entity should the bot attack this tick?', criteria: { none: 'fight nothing' } }],
    ['route_danger', { type: 'boolean', instructions: 'Does the route to the target look dangerous?' }],
    ['goal_progress', { type: 'score', instructions: 'How far along is the goal?', criteria: ['none', 'a quarter', 'half', 'mostly', 'done'] }],
    ['need_replan', { type: 'boolean', instructions: 'Should the plan be abandoned and re-planned?' }],
    ['threat_level', { type: 'score', instructions: 'How threatening are nearby entities?', criteria: ['none', 'distant', 'close'] }],
  ]
  return Object.fromEntries(pool.slice(0, n))
}

// ---------------------------------------------------------------------------
// suite definition
// ---------------------------------------------------------------------------
// state presets are named; bucket names s1k/s4k/s8k map onto them.
export const SIZE_PRESETS = {
  tiny: { blocks: 3, entities: 1 },    // ~1.2k input tokens (calibrated)
  mid: { blocks: 42, entities: 10 },   // ~4.6k
  large: { blocks: 82, entities: 18 }, // ~8k
}

export const BUCKETS = {
  cold: { questions: 4, preset: 'tiny', count: 1, concurrency: 1 },
  warm: { questions: 4, preset: 'tiny', count: 10, concurrency: 1 }, // = s1k baseline
  q1: { questions: 1, preset: 'tiny', count: 10, concurrency: 1 },
  q10: { questions: 10, preset: 'tiny', count: 10, concurrency: 1 },
  s4k: { questions: 4, preset: 'mid', count: 10, concurrency: 1 },
  s8k: { questions: 4, preset: 'large', count: 10, concurrency: 1 },
  burst: { questions: 4, preset: 'tiny', count: 10, concurrency: 5 },
}

// ---------------------------------------------------------------------------
// rate-limit pacer
//
// The gateway key is on the FREE tier: measured quota = 4 successful requests
// per ~300 s rolling window, then HTTP 429 with a long cooldown. The pacer
// never lets a 5th success into the trailing window, so sequential buckets do
// not burn calls on 429s. Burst calls bypass the pacer on purpose: measuring
// that degradation IS the point of the burst bucket.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PACER = {
  enabled: true,
  quota: 4,
  windowMs: 300_000,
  successes: [], // timestamps (ms) of successful calls
  totalWaitMs: 0,
}
export function configurePacer({ enabled, quota, windowMs }) {
  if (enabled != null) PACER.enabled = enabled
  if (quota != null) PACER.quota = quota
  if (windowMs != null) PACER.windowMs = windowMs
}
function withinWindow() {
  const now = Date.now()
  while (PACER.successes.length && now - PACER.successes[0] >= PACER.windowMs) PACER.successes.shift()
  return PACER.successes
}
async function pace(tag = '') {
  if (!PACER.enabled) return 0
  let waited = 0
  while (withinWindow().length >= PACER.quota) {
    const wait = PACER.windowMs - (Date.now() - PACER.successes[0]) + 2000
    const w = Math.max(1000, wait)
    console.log(`[pace] quota ${PACER.quota}/${PACER.windowMs / 1000}s reached${tag ? ' before ' + tag : ''}, sleeping ${Math.round(w / 1000)}s`)
    await sleep(w)
    waited += w
    PACER.totalWaitMs += w
  }
  return waited
}
function recordSuccess() {
  PACER.successes.push(Date.now())
}
// wait until the trailing window has room again (server told us it is saturated)
async function waitForReset(reason) {
  let waited = 0
  const step = 30_000
  while (true) {
    const full = withinWindow().length >= PACER.quota
    if (!full && waited >= 60_000) break
    console.log(`[pace] 429 rate-limited (${reason}); silent wait ${Math.round((waited + step) / 1000)}s`)
    await sleep(step)
    waited += step
    PACER.totalWaitMs += step
  }
  return waited
}

// ---------------------------------------------------------------------------
// one call, with up to 2 retries (3 attempts). Never throws.
// ---------------------------------------------------------------------------
export async function callOnce({ bucket, preset, questions }, i, { coldStart, concurrency, group, attempts = 3, paced = true }) {
  const rng = mulberry32(0x9e3779b9 ^ (i * 2654435761))
  const state = makeState(SIZE_PRESETS[preset], rng)
  const qs = makeQuestions(questions, state)
  delete state._candidateLogs
  // (candidate ids folded into questions already)

  const base = {
    bucket,
    i,
    coldStart: !!coldStart,
    questions,
    inputTokens: null,
    outputTokens: null,
    ms: 0,
    ok: false,
    at: new Date().toISOString(),
    statePreset: preset,
    concurrency,
    group,
  }

  let rateLimitWaits = 0
  let rateLimited = false
  const RL_RETRY_CAP = 8 // 429s are pacing, not logical failures; cap so we cannot loop forever
  let attempt = 0
  while (true) {
    attempt++
    if (paced) await pace(`${bucket}#${i}`)
    const t0 = performance.now()
    try {
      const out = await evaluate({
        model: MODEL,
        state,
        questions: qs,
        maxRetries: 0, // we own retries so failures are recorded, not hidden
        abortSignal: AbortSignal.timeout(45_000),
      })
      const ms = Math.round(performance.now() - t0)
      recordSuccess()
      const usage = out.usage ?? {}
      const typesafe = out.providerMetadata?.typesafe ?? {}
      const gw = out.providerMetadata?.gateway ?? {}
      return {
        ...base,
        ms,
        ok: true,
        attempts: attempt,
        rateLimited,
        rateLimitWaits,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        rounding: out.rounding ?? null,
        confidence: typesafe.confidence ?? null,
        resolvedProvider: gw.routing?.finalProvider ?? null,
        modelAttempts: gw.routing?.modelAttemptCount ?? null,
      }
    } catch (e) {
      const status = e?.statusCode ?? e?.data?.statusCode ?? e?.cause?.statusCode ?? null
      const isRL = status === 429
      if (isRL) {
        rateLimited = true
        const canRetryRateLimit = paced && PACER.enabled && rateLimitWaits < RL_RETRY_CAP
        if (canRetryRateLimit) {
          rateLimitWaits++
          attempt-- // a rate-limit wait does not consume a logical attempt
          await waitForReset(`${bucket}#${i}`)
          continue
        }
      }
      if (attempt < attempts) continue
      const ms = Math.round(performance.now() - t0)
      return {
        ...base,
        ms,
        ok: false,
        // count logical attempt + any extra rate-limit retries
        attempts: attempt,
        rateLimited,
        rateLimitWaits,
        error: String(e?.message ?? e).slice(0, 300),
        status,
        retryable: e?.isRetryable ?? null,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// percentiles / reporting helpers
// ---------------------------------------------------------------------------
export function pct(sorted, p) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function fmt(x, d = 0) {
  return x == null ? '  -  ' : x.toFixed(d)
}

export function summarise(records) {
  const by = new Map()
  for (const r of records) {
    if (!by.has(r.bucket)) by.set(r.bucket, [])
    by.get(r.bucket).push(r)
  }
  const rows = []
  for (const [bucket, rs] of by) {
    const ok = rs.filter((r) => r.ok)
    const ms = ok.map((r) => r.ms).sort((a, b) => a - b)
    const tin = ok.reduce((a, r) => a + (r.inputTokens || 0), 0)
    const rl = rs.filter((r) => r.status === 429).length
    rows.push({
      bucket,
      n: rs.length,
      ok: ok.length,
      errors: rs.length - ok.length,
      rateLimited: rl,
      p50: pct(ms, 0.5),
      p90: pct(ms, 0.9),
      p95: pct(ms, 0.95),
      max: ms.length ? ms[ms.length - 1] : null,
      min: ms.length ? ms[0] : null,
      mean: mean(ms),
      meanInTok: ok.length ? tin / ok.length : null,
      inputTokens: tin,
      cost: (tin / 1_000_000) * INPUT_PRICE_PER_MTOK,
      concurrency: rs[0]?.concurrency ?? 1,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { bucket: [], out: resolve(HERE, 'data/bench.jsonl'), calls: null, append: false, seed: 12345, calibrate: false, pace: true, quota: 4, windowSec: 300 }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--calls') a.calls = Number(argv[++i])
    else if (t === '--bucket') a.bucket.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean))
    else if (t === '--out') a.out = resolve(process.cwd(), argv[++i])
    else if (t === '--append') a.append = true
    else if (t === '--seed') a.seed = Number(argv[++i])
    else if (t === '--pace') a.pace = argv[++i] !== 'off'
    else if (t === '--quota') a.quota = Number(argv[++i])
    else if (t === '--window-sec') a.windowSec = Number(argv[++i])
    else if (t === '--calibrate') a.calibrate = true
    else if (t === '--help' || t === '-h') { a.help = true }
    else throw new Error('unknown arg: ' + t)
  }
  return a
}

function shuffled(arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---------------------------------------------------------------------------
// calibrate: measure usage.inputTokens for a few state sizes (cheap, q4)
// ---------------------------------------------------------------------------
async function calibrate() {
  console.log('calibration: q4 calls, measuring usage.inputTokens per preset')
  for (const [name, size] of Object.entries(SIZE_PRESETS)) {
    const r = await callOnce({ bucket: 'calibrate', preset: name, questions: 4 }, 0, { coldStart: false, concurrency: 1, group: null })
    console.log(`  ${name.padEnd(6)} blocks=${String(size.blocks).padStart(4)} entities=${String(size.entities).padStart(3)} -> inputTokens=${r.inputTokens} ms=${r.ms} ok=${r.ok}${r.ok ? '' : ' err=' + r.error}`)
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
async function run() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n')); return }

  const rng = mulberry32(args.seed)
  configurePacer({ enabled: args.pace, quota: args.quota, windowMs: args.windowSec * 1000 })

  if (args.calibrate) { await calibrate(); return }

  // which buckets and how many samples each
  const plan = []
  if (args.bucket.length) {
    for (const b of args.bucket) {
      if (!BUCKETS[b]) throw new Error(`unknown bucket '${b}' (have: ${Object.keys(BUCKETS).join(', ')})`)
      plan.push({ name: b, bucket: b, ...BUCKETS[b], count: args.calls ?? Math.max(1, BUCKETS[b].count) })
    }
  } else {
    for (const [name, cfg] of Object.entries(BUCKETS)) plan.push({ name, bucket: name, ...cfg })
    if (args.calls != null) {
      const total = plan.reduce((a, p) => a + p.count, 0)
      if (args.calls < total) {
        const scale = args.calls / total
        for (const p of plan) p.count = Math.max(1, Math.round(p.count * scale))
      }
    }
  }

  const seqBuckets = plan.filter((p) => p.concurrency === 1 && p.name !== 'cold')
  const burstBuckets = plan.filter((p) => p.concurrency > 1)
  const coldBucket = plan.find((p) => p.name === 'cold')

  const total = plan.reduce((a, p) => a + p.count, 0)
  const perRound = shuffled(seqBuckets.map((p) => p.name), rng)

  mkdirSync(dirname(args.out), { recursive: true })
  if (!args.append) writeFileSync(args.out, '')
  const write = (rec) => appendFileSync(args.out, JSON.stringify(rec) + '\n')

  console.log(`[bench] out=${args.out} total=${total} calls`)
  console.log(`[bench] key check: length=${KEY.length} prefix=${KEY.slice(0, 4)}... (never printed in full)`)
  console.log(`[bench] sequential order (shuffled once, seed=${args.seed}): ${perRound.join(' -> ')}${burstBuckets.length ? ' | ' + burstBuckets.map((b) => b.name + '(x' + b.concurrency + ')').join(',') : ''}`)

  let done = 0
  const all = []

  const emit = (rec) => {
    write(rec)
    all.push(rec)
    done++
    if (done % 10 === 0 || done === total) {
      const r = rec
      console.log(`[bench] ${done}/${total} ${r.bucket} ms=${r.ms} in=${r.inputTokens ?? '-'} ok=${r.ok}${r.error ? ' err=' + r.error.slice(0, 60) : ''}`)
    }
  }

  // 1) the very first call of the process = cold
  if (coldBucket) {
    const r = await callOnce(coldBucket, 0, { coldStart: true, concurrency: 1, group: null })
    emit(r)
  }

  // 2) interleaved rounds: one sample per bucket per round, shuffled each round
  const remaining = new Map(seqBuckets.map((p) => [p.name, p.count]))
  const byName = new Map(seqBuckets.map((p) => [p.name, p]))
  const roundOrder = shuffled(seqBuckets.map((p) => p.name), rng)
  let round = 0
  while ([...remaining.values()].some((v) => v > 0)) {
    for (const name of roundOrder) {
      if ((remaining.get(name) ?? 0) <= 0) continue
      remaining.set(name, remaining.get(name) - 1)
      const p = byName.get(name)
      const idx = p.count - remaining.get(name) - 1
      const r = await callOnce(p, idx, { coldStart: false, concurrency: 1, group: round })
      emit(r)
    }
    round++
  }

  // 3) burst: groups of `concurrency` in flight, measured separately.
  //    Deliberately NOT paced inside a group: the 429s are the measurement.
  for (const p of burstBuckets) {
    const groups = Math.ceil(p.count / p.concurrency)
    for (let g = 0; g < groups; g++) {
      await pace(`burst group ${g}`) // wait for a fresh window between groups
      const size = Math.min(p.concurrency, p.count - g * p.concurrency)
      const t0 = performance.now()
      const recs = await Promise.all(
        Array.from({ length: size }, (_, k) => {
          const idx = g * p.concurrency + k
          return callOnce(p, idx, { coldStart: false, concurrency: size, group: g, attempts: 1, paced: false })
        }),
      )
      const wall = Math.round(performance.now() - t0)
      recs.forEach(emit)
      console.log(`[burst] group ${g} size=${size} wall=${wall}ms max=${Math.max(...recs.map((r) => r.ms))}ms ok=${recs.filter((r) => r.ok).length}/${size}`)
    }
  }

  // key-leak assertion: the raw key must never appear in the JSONL
  const raw = readFileSync(args.out, 'utf8')
  if (raw.includes(KEY)) throw new Error('SECURITY: key leaked into JSONL output')
  console.log(`[bench] key-leak check: OK (key not present in ${args.out})`)

  // report
  const rows = summarise(all)
  console.log('\n=== percentiles (ms) ===')
  console.log(['bucket', 'n', 'ok', 'err', 'p50', 'p90', 'p95', 'max', 'mean', 'meanInTok', 'cost$'].join('\t'))
  let cost = 0
  for (const r of rows) {
    cost += r.cost
    console.log([r.bucket, r.n, r.ok, r.errors, fmt(r.p50), fmt(r.p90), fmt(r.p95), fmt(r.max), fmt(r.mean), fmt(r.meanInTok), r.cost.toFixed(6)].join('\t'))
  }
  console.log(`\n[bench] total input cost = $${cost.toFixed(6)} (output not billed)`)

  const summaryPath = args.out.replace(/\.jsonl$/, '.summary.json')
  writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, seed: args.seed, total, rows }, null, 2))
  console.log(`[bench] summary -> ${summaryPath}`)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  // the SDK's keep-alive sockets would otherwise hold the event loop open
  run().then(() => process.exit(0), (e) => { console.error('bench failed:', e?.message || e); process.exit(1) })
}
