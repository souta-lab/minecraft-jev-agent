#!/usr/bin/env node
import assert from 'node:assert/strict'
import { inspectGenerationCallbackLog } from './issue13-evidence.mjs'

const good = [
  '[2026-09-19T00:00:00.000Z] ACTION n=1 id=MOVE kind=MOVE generationId=gen-a',
  '[2026-09-19T00:00:00.001Z] PATH_CALLBACK phase=completed generationId=gen-a actionId=MOVE mode=pathfinder',
  '[2026-09-19T00:00:00.002Z] GENERATION_DISPOSED id=gen-a listeners=0 timers=0',
  '[2026-09-19T00:00:00.003Z] ACTION n=2 id=WAIT kind=WAIT generationId=gen-b',
  '[2026-09-19T00:00:00.004Z] PATH_CALLBACK phase=failed generationId=gen-b actionId=WAIT mode=pathfinder outcome=timeout',
].join('\n')
const goodResult = inspectGenerationCallbackLog(good)
assert.equal(goodResult.observabilityReady, true)
assert.equal(goodResult.noDisposedGenerationCallbacks, true)
assert.equal(goodResult.pathCallbacks, 2)

const bad = `${good}\n[2026-09-19T00:00:00.005Z] PATH_CALLBACK phase=completed generationId=gen-a actionId=STALE mode=pathfinder`
const badResult = inspectGenerationCallbackLog(bad)
assert.equal(badResult.noDisposedGenerationCallbacks, false)
assert.equal(badResult.staleCallbackViolations.length, 1)

const scoped = [
  '[2026-09-19T00:01:00.000Z] BOOT runId=run-a pid=1',
  '[2026-09-19T00:01:00.001Z] ACTION n=1 id=MOVE kind=MOVE generationId=gen-a',
  '[2026-09-19T00:01:00.002Z] PATH_CALLBACK phase=completed generationId=gen-a actionId=MOVE mode=pathfinder',
  '[2026-09-19T00:02:00.000Z] BOOT runId=run-b pid=2',
  '[2026-09-19T00:02:00.001Z] ACTION n=1 id=WAIT kind=WAIT generationId=gen-b',
  '[2026-09-19T00:02:00.002Z] PATH_CALLBACK phase=completed generationId=gen-b actionId=WAIT mode=pathfinder',
].join('\n')
const scopedResult = inspectGenerationCallbackLog(scoped, { runId: 'run-a' })
assert.equal(scopedResult.scopeMatched, true)
assert.equal(scopedResult.scopeSource, 'run-id')
assert.equal(scopedResult.actionLogs, 1)
assert.equal(scopedResult.pathCallbacks, 1)
assert.equal(scopedResult.observabilityReady, true)

const missingScope = inspectGenerationCallbackLog(scoped, { runId: 'run-missing' })
assert.equal(missingScope.scopeMatched, false)
assert.equal(missingScope.observabilityReady, false)
assert.equal(missingScope.scopeSource, 'run-id-not-found')
assert.equal(missingScope.actionLogs, 0)
assert.equal(missingScope.pathCallbacks, 0)

console.log('issue13-evidence: 5/5 checks passed')
