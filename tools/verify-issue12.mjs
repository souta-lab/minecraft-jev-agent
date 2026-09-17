#!/usr/bin/env node
// verify-issue12: automatic acceptance check for issue #12
// (PRECONDITION_MISSING must not stop the generation; the ladder must be replaced with
//  the prerequisite chain, and the agent must actually start digging again).
//
// Usage: node tools/verify-issue12.mjs [--json]
// Read-only. No secrets printed.
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const LOG = '/home/s0u7a/mc-ai/buddy-driver/buddy.log'
const JSON_OUT = process.argv.includes('--json')
const txt = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
const lines = txt.trim() ? txt.trim().split('\n') : []

const count = (s) => txt.split(s).length - 1

// 1. precondition vs replacement
const precond = count('PRECONDITION_MISSING')
const ladderPrereq = count('LADDER_PREREQ')
const ladderReset = count('LADDER_RESET')

// 2. generation ticks (from GENERATION_STOP ... ticks=N) — only the RECENT window,
//    so historical 1-tick stops before a fix do not poison the verdict forever.
const WINDOW_MIN = 10
const tsOf = (line) => {
  const m = line.match(/\[([\d-]+T[\d:.]+)Z\]/)
  return m ? Date.parse(m[1] + 'Z') : null
}
const allTs = lines.map(tsOf).filter(Boolean)
const newestTs = allTs.length ? Math.max(...allTs) : 0
const cutoff = newestTs - WINDOW_MIN * 60 * 1000
const recentLines = newestTs ? lines.filter((l) => { const t = tsOf(l); return t === null || t >= cutoff }) : lines
const recentTxt = recentLines.join('\n')

const tickValues = [...recentTxt.matchAll(/GENERATION_STOP[^\n]*?ticks=(\d+)/g)].map((m) => Number(m[1]))
const ticksAllTime = [...txt.matchAll(/GENERATION_STOP[^\n]*?ticks=(\d+)/g)].length
const ticks1 = tickValues.filter((t) => t <= 1).length
const ticksGe100 = tickValues.filter((t) => t >= 100).length
const maxTicks = tickValues.length ? Math.max(...tickValues) : 0

// 3. digging markers (proof the body resumed working)
const digMarkers = {
  TOOL_CHOICE: count('TOOL_CHOICE'),
  DIG_PATH: count('DIG_PATH'),
  JUMP_ATTEMPT: count('JUMP_ATTEMPT'),
  DESCEND_LIMIT: count('DESCEND_LIMIT'),
  STAIRCASE: count('STAIRCASE'),
  REUSE_TUNNEL: count('REUSE_TUNNEL'),
}
const digging = Object.values(digMarkers).some((v) => v > 0)

// 4. target resource actually obtained
const rawIronLines = [...txt.matchAll(/"raw_iron"\s*:\s*(\d+)/g)].map((m) => Number(m[1]))
const rawIron = rawIronLines.length ? Math.max(...rawIronLines) : 0

// 5. churn rate: generations/recoveries in the last 5 minutes of the log
function ts(line) {
  const m = line.match(/\[([\d-]+T[\d:.]+)Z\]/)
  return m ? Date.parse(m[1] + 'Z') : null
}
const lastTs = [...lines].reverse().map(ts).find(Boolean)
const genStarts = lines.filter((l) => l.includes('GENERATION_START')).map((l) => ({ t: ts(l) })).filter((x) => x.t)
const recents = lastTs ? genStarts.filter((g) => lastTs - g.t <= 5 * 60 * 1000) : []
const gensLast5min = recents.length

const checks = [
  { id: 'ladder_prereq_present', pass: ladderPrereq > 0, detail: `LADDER_PREREQ=${ladderPrereq}` },
  { id: 'no_1tick_rotation', pass: tickValues.length > 0 && ticks1 === 0, detail: `recent ${WINDOW_MIN}min: ticks<=1 count=${ticks1} of ${tickValues.length} stops (max=${maxTicks}, all-time stops=${ticksAllTime})` },
  { id: 'generation_survives_100_ticks', pass: ticksGe100 > 0, detail: `ticks>=100 count=${ticksGe100}` },
  { id: 'digging_resumed', pass: digging, detail: JSON.stringify(digMarkers) },
  { id: 'raw_iron_obtained', pass: rawIron >= 1, detail: `max raw_iron seen in inventory logs = ${rawIron}` },
  { id: 'churn_reduced', pass: gensLast5min <= 3, detail: `GENERATION_START in last 5min = ${gensLast5min} (<=3 required; 0 means no churn)` },
]

const passCount = checks.filter((c) => c.pass).length
const result = {
  issue: 12,
  verdict: passCount === checks.length ? 'PASS' : 'FAIL',
  passCount,
  total: checks.length,
  counters: { precond, ladderPrereq, ladderReset, genStops: tickValues.length, maxTicks, gensLast5min, rawIron },
  checks,
}

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`== issue #12 acceptance: ${result.verdict} (${passCount}/${checks.length}) ==`)
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id.padEnd(32)} ${c.detail}`)
  console.log(`  counters: ${JSON.stringify(result.counters)}`)
  if (result.verdict === 'FAIL') {
    console.log('  note: PRECONDITION_MISSING is still a stop condition -> the agent never digs,')
    console.log('        so movement fixes (#7/#8/#9) remain unobservable. This is the critical path.')
  }
}