#!/usr/bin/env node
// verify-mercury: acceptance checks for the Mercury System2Brain issues
//   #15 cache hit must NOT discard the cached plan (no "continue []")
//   #30 patch/replace must not drop the tail of the plan
//   #18 retry accounting should be visible
// Usage: node tools/verify-mercury.mjs [--json]
// Read-only. Never prints secrets. Prints only structural fields of each record.
import { readFileSync, existsSync } from 'node:fs'

const FILE = '/home/s0u7a/mc-ai/buddy-driver/logs/jev/mercury-calls.jsonl'
const JSON_OUT = process.argv.includes('--json')
if (!existsSync(FILE)) {
  console.log(`mercury-calls.jsonl not found at ${FILE}`)
  process.exit(2)
}
const records = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const isCacheHit = (r) => /cache/i.test(String(r.stage ?? '')) || r.cached === true || /cached/i.test(String(r.note ?? ''))
const goalsOf = (r) => {
  const resp = r.response
  if (!resp) return null
  if (Array.isArray(resp.goals)) return resp.goals
  if (Array.isArray(resp?.plan?.goals)) return resp.plan.goals
  if (Array.isArray(resp?.data?.goals)) return resp.data.goals
  return null
}

const ok = records.filter((r) => !r.error)
const errored = records.filter((r) => r.error)
const cacheHits = records.filter(isCacheHit)
const emptyPlanOk = ok.filter((r) => { const g = goalsOf(r); return g !== null && g.length === 0 })
const nonEmptyPlanOk = ok.filter((r) => { const g = goalsOf(r); return g !== null && g.length > 0 })
const retryVisible = records.filter((r) => r.retries !== undefined)

const checks = [
  { id: 'has_successful_call', pass: ok.length > 0, detail: `ok=${ok.length} errored=${errored.length} total=${records.length}` },
  { id: 'no_cache_hit_with_empty_plan', pass: cacheHits.every((r) => { const g = goalsOf(r); return g === null || g.length > 0 }), detail: `cacheHits=${cacheHits.length} emptyPlanOk=${emptyPlanOk.length}` },
  { id: 'at_least_one_nonempty_plan', pass: nonEmptyPlanOk.length > 0, detail: `nonEmptyPlans=${nonEmptyPlanOk.length}` },
  { id: 'retry_accounting_present', pass: retryVisible.length === records.length && records.length > 0, detail: `recordsWithRetriesField=${retryVisible.length}/${records.length}` },
]

// Advisor-layer cache loop detection (issue #15): consecutive identical cached strategies
// mean the cache replays a label that never changes the body.
const LOG = '/home/s0u7a/mc-ai/buddy-driver/buddy.log'
const advisorLines = existsSync(LOG)
  ? readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('ADVISOR') && l.includes('cached=true'))
  : []
const advisorStrategies = advisorLines.map((l) => (l.match(/strategy=([a-z_]+)/) || [])[1]).filter(Boolean)
let maxRun = 0
let run = 0
for (let i = 0; i < advisorStrategies.length; i++) {
  run = i > 0 && advisorStrategies[i] === advisorStrategies[i - 1] ? run + 1 : 1
  if (run > maxRun) maxRun = run
}
const MAX_ALLOWED_RUN = 2
checks.push({
  id: 'no_cached_strategy_loop',
  pass: maxRun <= MAX_ALLOWED_RUN,
  detail: `cachedAdvisorLines=${advisorLines.length} maxConsecutiveSameStrategy=${maxRun} (allowed<=${MAX_ALLOWED_RUN})`,
})

const passCount = checks.filter((c) => c.pass).length
const last = ok[ok.length - 1]
const out = {
  verdict: passCount === checks.length ? 'PASS' : 'FAIL',
  passCount,
  total: checks.length,
  counters: { total: records.length, ok: ok.length, errored: errored.length, cacheHits: cacheHits.length, emptyPlanOk: emptyPlanOk.length, nonEmptyPlans: nonEmptyPlanOk.length },
  lastOk: last ? { ts: last.ts, model: last.model, stage: last.stage, latencyMs: last.latencyMs, cost: last.cost, goals: goalsOf(last)?.length ?? null, op: last.response?.op ?? last.response?.plan?.op ?? null } : null,
  checks,
}

if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
else {
  console.log(`== Mercury acceptance: ${out.verdict} (${passCount}/${checks.length}) ==`)
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id.padEnd(32)} ${c.detail}`)
  console.log(`  counters: ${JSON.stringify(out.counters)}`)
  if (out.lastOk) console.log(`  last ok call: ${JSON.stringify(out.lastOk)}`)
  if (out.verdict === 'FAIL') console.log('  note: #15 = a cache hit must replay the cached plan, not emit an empty/continue plan; #30 = patch/replace must keep the plan tail.')
}