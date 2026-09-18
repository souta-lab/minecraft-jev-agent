import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GH_ISSUE_LIST_COMMAND,
  computeIssueGraph,
  parseDependencies,
  renderReport,
} from './issue-graph.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(repoRoot, 'tools', 'issue-graph.mjs')
let checks = 0

function ok(label, condition) {
  assert.ok(condition, label)
  checks += 1
}

function chainFixture() {
  return [
    { number: 3, title: 'base', body: 'No dependencies here.', labels: ['status/ready'] },
    { number: 2, title: 'middle', body: 'blocked by #3', labels: [] },
    { number: 1, title: 'top', body: '## Dependencies\n\n- #2\n\nDepends on #3', labels: [{ name: 'area/tools' }] },
    { number: 9, title: 'lonely', body: 'Standalone work item.', labels: [] },
  ]
}

const chain = computeIssueGraph(chainFixture())

const position = new Map(chain.order.map((number, index) => [number, index]))
const orderIsValid = chain.nodes.every((node) =>
  node.dependencies.every((dep) => position.get(dep) < position.get(node.number)),
)
ok('topological order respects every dependency edge', orderIsValid)
ok('topological order is deterministic', JSON.stringify(chain.order) === JSON.stringify([3, 2, 1, 9]))
ok('critical path has length 3', chain.criticalPath.length === 3)
ok('critical path visits 1 -> 2 -> 3', JSON.stringify(chain.criticalPath.path) === JSON.stringify([1, 2, 3]))
ok('node 3 is a root', chain.roots.includes(3))
ok('node 9 (no edges) is a root', chain.roots.includes(9))
ok('node 9 has no dependencies', chain.nodes.find((node) => node.number === 9).dependencies.length === 0)
ok('section and inline deps merged', JSON.stringify(chain.nodes.find((node) => node.number === 1).dependencies) === JSON.stringify([2, 3]))
ok('external deps recorded', chain.externalDependencies.length === 0)
ok('chain has no cycle', chain.hasCycle === false)

const cycleFixture = [
  { number: 4, title: 'a', body: 'Depends on #5', labels: [] },
  { number: 5, title: 'b', body: 'blocked by #4', labels: [] },
  { number: 6, title: 'c', body: 'Depends on #6', labels: [] },
]
const cyclic = computeIssueGraph(cycleFixture)

ok('cycle is detected', cyclic.hasCycle === true)
const cycleKey = JSON.stringify([...cyclic.cycles[0]].sort((a, b) => a - b))
ok('cycle reports members 4 and 5', cycleKey === JSON.stringify([4, 5]))
ok('self dependency is ignored', cyclic.nodes.find((node) => node.number === 6).dependencies.length === 0)
ok('cycle nodes omitted from topological order', !cyclic.order.includes(4) && !cyclic.order.includes(5))

ok('parseDependencies removes self reference', parseDependencies('Depends on #7', 7).size === 0)
ok('parseDependencies ignores prose without refs', parseDependencies('random text', 1).size === 0)

const report = computeIssueGraph(chainFixture())
const stableA = renderReport(report, { json: true })
const stableB = renderReport(computeIssueGraph(chainFixture()), { json: true })
ok('--json output is byte-stable', stableA === stableB)
const parsedJson = JSON.parse(stableA)
ok('--json records the exact command', parsedJson.command === GH_ISSUE_LIST_COMMAND)
ok('--json carries topological order', JSON.stringify(parsedJson.order) === JSON.stringify([3, 2, 1, 9]))

const fixtureDir = mkdtempSync(join(tmpdir(), 'issue-graph-'))
try {
  writeFileSync(join(fixtureDir, 'issues.json'), JSON.stringify(chainFixture()))

  const ghOk = join(fixtureDir, 'gh')
  writeFileSync(ghOk, `#!/bin/sh\ncat "${join(fixtureDir, 'issues.json')}"\n`)
  chmodSync(ghOk, 0o755)

  const env = { ...process.env, PATH: `${fixtureDir}:${process.env.PATH}` }
  const cliA = execFileSync(process.execPath, [helper, '--json'], { encoding: 'utf8', env })
  const cliB = execFileSync(process.execPath, [helper, '--json'], { encoding: 'utf8', env })
  ok('CLI --json output is stable across runs', cliA === cliB)
  ok('CLI --json echoes the command', JSON.parse(cliA).command === GH_ISSUE_LIST_COMMAND)
  ok('CLI --json exposes length-3 critical path', JSON.parse(cliA).criticalPath.length === 3)

  const ghFail = join(fixtureDir, 'gh')
  writeFileSync(ghFail, '#!/bin/sh\nexit 3\n')
  chmodSync(ghFail, 0o755)
  let failure
  try {
    execFileSync(process.execPath, [helper], { encoding: 'utf8', env })
  } catch (error) {
    failure = error
  }
  ok('unreadable data prints UNKNOWN', (failure?.stdout ?? '').includes('UNKNOWN'))
} finally {
  rmSync(fixtureDir, { recursive: true, force: true })
}

console.log(`issue-graph: ${checks}/${checks} checks passed`)
