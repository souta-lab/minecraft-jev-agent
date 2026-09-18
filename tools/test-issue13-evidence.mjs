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

console.log('issue13-evidence: 3/3 checks passed')
