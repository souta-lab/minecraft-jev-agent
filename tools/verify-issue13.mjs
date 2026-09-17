#!/usr/bin/env node
// verify-issue13: listener-leak acceptance check.
// Samples the resident control socket several times and asserts that no event's
// listener count ever exceeds the recorded baseline (i.e. reloads do not accumulate handlers).
// Usage: node tools/verify-issue13.mjs [--json] [--samples 3] [--gap 8000]
import net from 'node:net'
import { existsSync } from 'node:fs'

const SOCK = '/home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock'
const args = process.argv.slice(2)
const num = (flag, d) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d
}
const SAMPLES = num('--samples', 3)
const GAP = num('--gap', 8000)
const JSON_OUT = args.includes('--json')

function report() {
  return new Promise((resolve) => {
    if (!existsSync(SOCK)) return resolve(null)
    const s = net.createConnection(SOCK)
    let buf = ''
    const done = (v) => { try { s.destroy() } catch {} ; resolve(v) }
    s.setTimeout(6000, () => done(null))
    s.on('error', () => done(null))
    s.on('data', (d) => {
      buf += d.toString('utf8')
      if (buf.includes('\n')) { try { done(JSON.parse(buf.split('\n')[0])) } catch { done(null) } }
    })
    s.on('connect', () => s.write(JSON.stringify({ id: Date.now() % 100000, cmd: 'report' }) + '\n'))
  })
}

const samples = []
for (let i = 0; i < SAMPLES; i++) {
  const r = await report()
  if (!r?.ok) { console.log('control socket unavailable'); process.exit(2) }
  samples.push({
    at: new Date().toISOString(),
    generations: r.data.generations,
    listenerLeak: r.data.listenerLeak,
    listeners: r.data.listeners,
    baseline: r.data.listenerBaseline,
  })
  if (i < SAMPLES - 1) await new Promise((res) => setTimeout(res, GAP))
}

const events = new Set(samples.flatMap((s) => Object.keys(s.listeners || {})))
const over = {}
for (const e of events) {
  const maxSeen = Math.max(...samples.map((s) => s.listeners?.[e] ?? 0))
  const base = samples[samples.length - 1].baseline?.[e] ?? 0
  if (maxSeen > base) over[e] = { maxSeen, base }
}
const leakFlags = samples.map((s) => s.listenerLeak)
const genGrowth = samples.length > 1 ? samples[samples.length - 1].generations - samples[0].generations : 0

const checks = [
  { id: 'no_event_over_baseline', pass: Object.keys(over).length === 0, detail: JSON.stringify(over) },
  { id: 'leak_flag_false_in_all_samples', pass: leakFlags.every((f) => f === false), detail: JSON.stringify(leakFlags) },
]
const passCount = checks.filter((c) => c.pass).length
const out = {
  issue: 13,
  verdict: passCount === checks.length ? 'PASS' : 'FAIL',
  passCount,
  total: checks.length,
  samples,
  generationGrowth: genGrowth,
  checks,
}

if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
else {
  console.log(`== issue #13 acceptance: ${out.verdict} (${passCount}/${checks.length}) ==`)
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id.padEnd(30)} ${c.detail}`)
  console.log(`  generations over sampling window: ${genGrowth}`)
  for (const s of samples) console.log(`  sample ${s.at} leak=${s.listenerLeak} listeners=${JSON.stringify(s.listeners)}`)
}