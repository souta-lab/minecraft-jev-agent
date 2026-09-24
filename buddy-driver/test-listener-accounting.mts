// Host listener accounting must include every scheduler-owned event so the
// baseline, current count and generation-adjusted expected count share coverage.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const runner = readFileSync(new URL('./agent-runner.mts', import.meta.url), 'utf8')

function constantArray(name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(runner)
  assert.ok(match, `missing ${name}`)
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]!)
}

const countedEvents = constantArray('LISTENER_EVENTS')
const requiredSchedulerEvents = constantArray('GENERATION_SCHEDULER_EVENTS')
assert.ok(countedEvents.includes('breath'), 'breath must be included in host baseline/current/expected counts')
assert.ok(requiredSchedulerEvents.includes('breath'), 'baseline capture must wait for the scheduler breath listener')

const countsStart = runner.indexOf('function listenerCounts():')
const expectedStart = runner.indexOf('function expectedListenerCounts():', countsStart)
const leakStart = runner.indexOf('function listenerLeak():', expectedStart)
const readyStart = runner.indexOf('function listenerBaselineReady(', leakStart)
const scheduleStart = runner.indexOf('function scheduleListenerBaseline(', readyStart)
assert.ok(countsStart >= 0 && expectedStart > countsStart && leakStart > expectedStart && readyStart > leakStart && scheduleStart > readyStart)

const countsBody = runner.slice(countsStart, expectedStart)
const expectedBody = runner.slice(expectedStart, leakStart)
const leakBody = runner.slice(leakStart, readyStart)
const readyBody = runner.slice(readyStart, scheduleStart)
assert.match(countsBody, /for \(const event of LISTENER_EVENTS\)/)
assert.match(expectedBody, /for \(const event of LISTENER_EVENTS\)/)
assert.match(expectedBody, /hostCount \+ \(owned\[event\] \?\? 0\)/)
assert.match(leakBody, /listenerCounts\(\)/)
assert.match(readyBody, /GENERATION_SCHEDULER_EVENTS\.every\(/)

process.stdout.write('PASS listener accounting includes scheduler breath ownership in baseline/current/expected paths\n')
