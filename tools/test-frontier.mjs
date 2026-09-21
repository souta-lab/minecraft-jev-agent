#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { classify, render } from './frontier.mjs'

const issues = [
  { number: 1, title: 'P1: live bug', url: 'u1' },
  { number: 2, title: 'Architecture task', url: 'u2' },
  { number: 3, title: 'Research: experiment', url: 'u3' },
  { number: 4, title: 'Backlog cleanup', url: 'u4' },
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

process.stdout.write('frontier tests: 5/5\n')
