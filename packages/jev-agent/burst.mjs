// Post-upgrade burst check: are we still rate-limited (4 req/300s) or paid-tier now?
import { readFileSync } from 'node:fs'
process.env.AI_GATEWAY_API_KEY = readFileSync('/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key', 'utf8').trim()
const { experimental_evaluate: evaluate } = await import('ai')

const state = { self: { pos: { x: 5, y: 66, z: -65 }, health: 20, hunger: 20, holding: 'stone_axe' },
  inventory: [], entities: [],
  blocks: [{ id: 'b1', type: 'oak_log', pos: { x: 6, y: 63, z: -67 }, distance: 3.1, reachable: true }],
  goal: 'collect 1 oak_log', recentEvents: [] }
const questions = {
  action: { type: 'choice', instructions: 'Next executable action?', criteria: { 'MINE:b1': 'dig the oak log', WAIT: 'do nothing', ESCALATE: 'ask the planner' } },
  danger: { type: 'score', instructions: 'How dangerous?', criteria: ['safe', 'minor', 'dangerous', 'lethal'] },
  goal_done: { type: 'boolean', instructions: 'Goal already achieved' },
}

const N = Number(process.argv[2] || 12)
const lat = []; let ok = 0, r429 = 0, other = 0
for (let i = 1; i <= N; i++) {
  const t0 = performance.now()
  try {
    await evaluate({ model: 'typesafe-ai/jev', state, questions })
    const ms = Math.round(performance.now() - t0); lat.push(ms); ok++
    console.log(`#${i} ok ${ms}ms`)
  } catch (e) {
    const msg = String(e?.message || e)
    const is429 = /429|rate/i.test(msg)
    is429 ? r429++ : other++
    console.log(`#${i} FAIL ${is429 ? '429' : 'other'} ${msg.slice(0, 90)}`)
  }
}
const p = (q) => lat.length ? lat.slice().sort((a, b) => a - b)[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0
console.log(`\n=== n=${N} ok=${ok} 429=${r429} other=${other}`)
if (lat.length) console.log(`p50=${p(0.5)}ms p90=${p(0.9)}ms max=${Math.max(...lat)}ms  first=${lat[0]}ms`)
console.log(ok === N ? 'VERDICT: no rate limiting seen (paid tier likely active)' : 'VERDICT: still limited')
