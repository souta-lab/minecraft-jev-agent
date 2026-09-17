// One-off probe: try to talk to typesafe-ai/jev through Vercel AI Gateway.
// Never prints the API key.
import { readFileSync, appendFileSync } from 'node:fs'

const KEY = readFileSync('/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key', 'utf8').trim()
const BASE = 'https://ai-gateway.vercel.sh'
const MODEL = 'typesafe-ai/jev'
const JSONL = '/home/s0u7a/mc-ai/jev-agent/data/jev-probe.jsonl'

const state = {
  self: { pos: { x: 27, y: 70, z: -63 }, health: 20, hunger: 20, holding: 'stone_axe' },
  inventory: [{ item: 'stone_axe', count: 1 }, { item: 'oak_log', count: 0 }],
  entities: [],
  blocks: [
    { id: 'b381', type: 'oak_log', pos: { x: 33, y: 71, z: -60 }, distance: 6.7, reachable: true },
    { id: 'b442', type: 'oak_log', pos: { x: 34, y: 72, z: -60 }, distance: 8.1, reachable: true },
    { id: 'b501', type: 'grass_block', pos: { x: 30, y: 69, z: -62 }, distance: 3.2, reachable: true },
  ],
  goal: 'chop exactly one oak_log',
  recentEvents: ['spawned', 'moved to (27,70,-63)'],
}

const questions = {
  action: {
    type: 'choice',
    instructions: 'Pick the next executable macro-action that best serves the goal.',
    criteria: {
      'MOVE:p12': 'walk to the block b381 position',
      'MINE:b381': 'dig the oak_log at b381 (within reach)',
      'MINE:b442': 'dig the oak_log at b442',
      'WAIT': 'do nothing this tick',
      'ESCALATE': 'ask the slower planner because the situation is unclear',
    },
  },
  danger: { type: 'score', instructions: 'How dangerous is the current situation?', criteria: ['safe', 'minor risk', 'dangerous', 'lethal'] },
  need_replan: { type: 'noul', instructions: 'The current plan needs to be replanned instead of continuing' },
}

async function probe(name, path, body) {
  const t0 = performance.now()
  let status = 0, text = ''
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    })
    status = r.status
    text = await r.text()
  } catch (e) {
    text = 'fetch error: ' + e.message
  }
  const ms = Math.round(performance.now() - t0)
  console.log(`\n=== ${name} -> HTTP ${status} (${ms}ms) ===`)
  console.log(text.slice(0, 1200))
  appendFileSync(JSONL, JSON.stringify({ name, path, status, ms, body, response: text.slice(0, 4000) }) + '\n')
  return text
}

// A) OpenAI-compatible chat/completions, native Jev payload inside the content
await probe('A chat/completions + JSON content', '/v1/chat/completions', {
  model: MODEL,
  messages: [{ role: 'user', content: JSON.stringify({ state, questions }) }],
})

// B) chat/completions with the native fields at the top level
await probe('B chat/completions + top-level state/questions', '/v1/chat/completions', {
  model: MODEL,
  state,
  questions,
})

// C) native systemone route
await probe('C /v1/systemone', '/v1/systemone', { model: MODEL, state, questions })
