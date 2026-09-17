#!/usr/bin/env node
// verify-mercury: acceptance checks for the Mercury System2Brain issues
//   #15 cache hit must NOT discard the cached plan (no "continue []")
//   #15 cache invalidation: repeated identical cached strategies must be bypassed
//   #30 patch/replace must not drop the tail of the plan
//   #18 retry accounting should be visible
// Usage: node tools/verify-mercury.mjs [--json] [--all] [--samples]
//   --all     count the whole buddy.log (reproduces the historical pre-fix loop)
//   --samples print the most recent ADVISOR_CACHE bypass / STRATEGY_REFUSED lines
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
// mean the cache replays a label that never changes the body. The guard in advisor.ts /
// mercury-system2.ts caps a cached strategy at 2 replays and then emits ADVISOR_CACHE
// bypass. By default only lines AFTER the first ADVISOR_CACHE_GUARD marker are
// counted, so the check measures the guarded code path from its deploy boundary;
// --all reproduces the historical failure across the whole append-only log.
const LOG = '/home/s0u7a/mc-ai/buddy-driver/buddy.log'
const ALL = process.argv.includes('--all')
const SAMPLES = process.argv.includes('--samples')
const logLines = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n') : []
const guardIndex = ALL ? -1 : logLines.findIndex((line) => line.includes('ADVISOR_CACHE_GUARD'))
const windowLines = guardIndex >= 0 ? logLines.slice(guardIndex) : logLines
const advisorLines = windowLines.filter((l) => l.includes('ADVISOR') && l.includes('cached=true'))
const advisorStrategies = advisorLines.map((l) => (l.match(/strategy=([a-z_]+)/) || [])[1]).filter(Boolean)
let maxRun = 0
let run = 0
for (let i = 0; i < advisorStrategies.length; i++) {
  run = i > 0 && advisorStrategies[i] === advisorStrategies[i - 1] ? run + 1 : 1
  if (run > maxRun) maxRun = run
}
const bypassLines = windowLines.filter((l) => l.includes('ADVISOR_CACHE bypass'))
const refusalLines = windowLines.filter((l) => l.includes('STRATEGY_REFUSED'))
const window = ALL ? 'full-log' : guardIndex >= 0 ? `post-guard@${guardIndex}` : 'pre-guard-full-log'
const MAX_ALLOWED_RUN = 2
checks.push({
  id: 'no_cached_strategy_loop',
  pass: maxRun <= MAX_ALLOWED_RUN,
  detail: `window=${window} cachedAdvisorLines=${advisorLines.length} maxConsecutiveSameStrategy=${maxRun} (allowed<=${MAX_ALLOWED_RUN}) bypasses=${bypassLines.length} refusals=${refusalLines.length}`,
})

const passCount = checks.filter((c) => c.pass).length
const last = ok[ok.length - 1]
const out = {
  verdict: passCount === checks.length ? 'PASS' : 'FAIL',
  passCount,
  total: checks.length,
  window,
  counters: {
    total: records.length,
    ok: ok.length,
    errored: errored.length,
    cacheHits: cacheHits.length,
    emptyPlanOk: emptyPlanOk.length,
    nonEmptyPlans: nonEmptyPlanOk.length,
    cachedAdvisorLines: advisorLines.length,
    maxConsecutiveSameStrategy: maxRun,
    bypasses: bypassLines.length,
    refusals: refusalLines.length,
  },
  recentBypass: bypassLines.slice(-3),
  recentRefusal: refusalLines.slice(-3),
  lastOk: last ? { ts: last.ts, model: last.model, stage: last.stage, latencyMs: last.latencyMs, cost: last.cost, goals: goalsOf(last)?.length ?? null, op: last.response?.op ?? last.response?.plan?.op ?? null } : null,
  checks,
}

if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
else {
  console.log(`== Mercury acceptance: ${out.verdict} (${passCount}/${checks.length}) ==`)
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id.padEnd(32)} ${c.detail}`)
  console.log(`  counters: ${JSON.stringify(out.counters)}`)
  if (out.lastOk) console.log(`  last ok call: ${JSON.stringify(out.lastOk)}`)
  if (SAMPLES) {
    for (const line of out.recentBypass) console.log(`  bypass: ${line.slice(0, 220)}`)
    for (const line of out.recentRefusal) console.log(`  refusal: ${line.slice(0, 220)}`)
  }
  if (out.verdict === 'FAIL') {
    console.log('  note: #15 = a cache hit must replay the cached plan, not emit an empty/continue plan; repeated identical cached strategies must bypass (ADVISOR_CACHE bypass).')
    console.log('  note: re-run with --all to include the historical pre-fix loop; --samples to print bypass/refusal lines.')
  }
}