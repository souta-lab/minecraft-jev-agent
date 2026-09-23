#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { classify, render } from './frontier.mjs'

const issues = [
  { number: 1, title: 'P1: live bug', url: 'u1' },
  { number: 2, title: 'Architecture task', url: 'u2' },
  { number: 3, title: 'Research: experiment', url: 'u3' },
  { number: 4, title: 'Backlog cleanup', url: 'u4' },
]

// Same fixture with real GitHub states: #3 is closed.
const statefulIssues = [
  { number: 1, title: 'P1: live bug', url: 'u1', state: 'OPEN' },
  { number: 2, title: 'Architecture task', url: 'u2', state: 'OPEN' },
  { number: 3, title: 'Research: experiment', url: 'u3', state: 'CLOSED' },
  { number: 4, title: 'Backlog cleanup', url: 'u4', state: 'OPEN' },
]

const routing = {
  schemaVersion: 1,
  policy: { wipLimit: 3, newIssueRule: 'search first' },
  now: [1, 2],
  next: [],
  waitingLive: [],
  research: [3],
  future: [],
  referenceOnly: [],
  notes: {},
}

{
  const result = classify(issues, routing)
  assert.deepEqual(result.errors, [])
  assert.equal(result.unclassified.length, 1)
  assert.equal(result.unclassified[0].number, 4)
}

{
  const tooMuch = structuredClone(routing)
  tooMuch.now = [1, 2, 3, 4]
  const result = classify(issues, tooMuch)
  assert.match(result.errors.join('\n'), /WIP limit is 3/)
}

{
  const missingPriority = structuredClone(routing)
  missingPriority.now = [2]
  const result = classify(issues, missingPriority)
  assert.match(result.errors.join('\n'), /unclassified P0\/P1 issues: #1/)
}

{
  const duplicate = structuredClone(routing)
  duplicate.next = [2]
  const result = classify(issues, duplicate)
  assert.match(result.errors.join('\n'), /appears in both NOW and NEXT/)
}

{
  const output = render(issues, routing).markdown
  assert.match(output, /NOW — executable/)
  assert.match(output, /#1 P1: live bug/)
  assert.match(output, /1 other open issues/)
  assert.match(output, /Do not enumerate or evaluate them during normal ORIENT/)
}

// A closed issue must never stay in a routing category: that is how the routing file
// silently kept describing a backlog that no longer existed.
{
  const closedRouted = structuredClone(routing)
  closedRouted.research = [3]
  const result = classify(statefulIssues, closedRouted)
  assert.match(result.errors.join('\n'), /#3 is routed as RESEARCH but is CLOSED/)
}

// A routed number that GitHub does not return at all is a typo/ghost, also an error.
{
  const ghost = structuredClone(routing)
  ghost.now = [1, 99]
  const result = classify(issues, ghost)
  assert.match(result.errors.join('\n'), /#99 is routed as NOW but does not exist/)
}

// Historical rows are the place for closed work: closed + noted is clean.
{
  const withHistory = structuredClone(routing)
  withHistory.now = [1]
  withHistory.research = []
  withHistory.historical = [3]
  withHistory.notes = { 3: 'historical: folded into #1' }
  const withState = [
    { number: 1, title: 'P1: live bug', url: 'u1', state: 'OPEN' },
    { number: 3, title: 'Research: experiment', url: 'u3', state: 'CLOSED' },
    { number: 4, title: 'Backlog cleanup', url: 'u4', state: 'OPEN' },
  ]
  const result = classify(withState, withHistory)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.historical, [3])
  assert.equal(result.unclassified.length, 1)
  const output = render(withState, withHistory).markdown
  assert.match(output, /HISTORICAL — closed rows \(not work\)/)
  assert.match(output, /#3 Research: experiment/)
  assert.match(output, /A fold is not a fix/)
}

// A historical row that is still open would hide live work.
{
  const withHistory = structuredClone(routing)
  withHistory.historical = [2]
  withHistory.notes = { 2: 'historical: should not be here' }
  const result = classify(issues, withHistory)
  assert.match(result.errors.join('\n'), /#2 is listed as historical but is still OPEN/)
}

// A historical row without a note loses the reason it was closed.
{
  const withHistory = structuredClone(routing)
  withHistory.historical = [3]
  const result = classify(issues, withHistory)
  assert.match(result.errors.join('\n'), /#3 is historical but has no note/)
}

// The same number may not be both routed and historical.
{
  const withHistory = structuredClone(routing)
  withHistory.historical = [2]
  withHistory.notes = { 2: 'historical: duplicate' }
  const result = classify(issues, withHistory)
  assert.match(result.errors.join('\n'), /#2 appears in both NOW and HISTORICAL/)
}

// Clusters are a derived view of routed work; stale membership is a warning, not a
// silent resurrection of closed work.
{
  const withClusters = structuredClone(routing)
  withClusters.research = []
  withClusters.clusters = { M3: [1, 3, 4] }
  const result = classify(statefulIssues, withClusters)
  assert.match(result.warnings.join('\n'), /cluster M3 references #3, which is not an open routed issue/)
  assert.match(result.warnings.join('\n'), /cluster M3 references #4, which is not an open routed issue/)
  assert.deepEqual(result.errors, [])
}

// A string policy silently disables wipLimit/selectionRule/completionRule.
{
  const stringPolicy = structuredClone(routing)
  stringPolicy.policy = 'consolidated on 2026-09-23'
  const result = classify(issues, stringPolicy)
  assert.match(result.errors.join('\n'), /policy must be an object/)
}

process.stdout.write('frontier tests: 13/13\n')
