// One real Jev call via Vercel AI Gateway (AI SDK v7 experimental_evaluate).
// The API key is read from a 0600 file and never printed.
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs'

process.env.AI_GATEWAY_API_KEY = readFileSync('/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key', 'utf8').trim()

const { experimental_evaluate: evaluate } = await import('ai')

const state = {
  self: { pos: { x: 27, y: 70, z: -63 }, health: 20, hunger: 20, holding: 'stone_axe' },
  inventory: [{ item: 'stone_axe', count: 1 }],
  entities: [],
  blocks: [
    { id: 'b381', type: 'oak_log', pos: { x: 33, y: 71, z: -60 }, distance: 6.7, reachable: true, hasSupport: true },
    { id: 'b442', type: 'oak_log', pos: { x: 34, y: 72, z: -60 }, distance: 8.1, reachable: false, hasSupport: true },
    { id: 'b501', type: 'grass_block', pos: { x: 30, y: 69, z: -62 }, distance: 3.2, reachable: true, hasSupport: true },
  ],
  goal: 'chop exactly one oak_log',
  recentEvents: ['spawned', 'walked to (27,70,-63)', 'pathfinder: goal_reached'],
}

const questions = {
  action: {
    type: 'choice',
    instructions: 'Pick the single next macro-action that best serves the goal.',
    criteria: {
      'MINE:b381': 'dig the oak_log at b381 (in reach)',
      'MINE:b442': 'dig the oak_log at b442 (out of reach)',
      'MOVE:b442': 'walk closer to b442 first',
      'EAT:bread': 'eat (hunger is full)',
      WAIT: 'do nothing',
      ESCALATE: 'ask the slow planner',
    },
  },
  danger: {
    type: 'score',
    instructions: 'How dangerous is the current situation?',
    criteria: ['safe', 'minor risk', 'dangerous', 'lethal'],
  },
  goal_done: {
    type: 'boolean',
    instructions: 'The goal (chop exactly one oak_log) is already achieved',
  },
  should_retreat: {
    type: 'boolean',
    instructions: 'The bot should retreat from the current area',
  },
}

const t0 = performance.now()
let out
try {
  out = await evaluate({ model: 'typesafe-ai/jev', state, questions })
} catch (e) {
  console.error('CALL FAILED:', e?.message || e)
  console.error('details:', JSON.stringify(e?.data ?? e?.cause ?? {}, null, 2)?.slice(0, 800))
  process.exit(1)
}
const ms = Math.round(performance.now() - t0)

console.log('=== latency:', ms, 'ms ===')
console.log(JSON.stringify(out, null, 2))

mkdirSync('/home/s0u7a/mc-ai/jev-agent/data', { recursive: true })
appendFileSync('/home/s0u7a/mc-ai/jev-agent/data/jev-real-call.jsonl',
  JSON.stringify({ at: new Date().toISOString(), ms, state, questions, result: out }) + '\n')
console.log('=== logged to data/jev-real-call.jsonl ===')
