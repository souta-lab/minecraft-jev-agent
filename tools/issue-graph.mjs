#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const GH_ISSUE_LIST_COMMAND = 'gh issue list --state open --limit 1000 --json number,title,body,labels'
export const UNKNOWN = 'UNKNOWN'

const DEPENDS_INLINE = /\b(?:depends?\s+on|blocked\s+by)\s*:?\s*#(\d+)/gi
const DEPENDENCIES_HEADING = /^#{1,6}\s*Dependencies\s*$/im
const ANY_HEADING = /^#{1,6}\s/m
const HASH_REF = /#(\d+)/g

export function defaultGhRunner() {
    return execFileSync('gh', ['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,labels'], {
    encoding: 'utf8',
  })
}

export function readIssues(run = defaultGhRunner) {
  let raw
  try {
    raw = run()
  } catch (err) {
    return { error: `failed to run ${GH_ISSUE_LIST_COMMAND}: ${err?.message ?? String(err)}`, issues: [] }
  }
  let data
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (err) {
    return { error: `unreadable issue data: ${err?.message ?? String(err)}`, issues: [] }
  }
  if (!Array.isArray(data)) {
    return { error: 'unreadable issue data: expected an array of issues', issues: [] }
  }
  return { error: null, issues: data }
}

export function parseDependencies(body, selfNumber) {
  const deps = new Set()
  if (typeof body !== 'string' || body.length === 0) return deps

  for (const match of body.matchAll(DEPENDS_INLINE)) deps.add(Number(match[1]))

  const heading = body.match(DEPENDENCIES_HEADING)
  if (heading) {
    const rest = body.slice(heading.index + heading[0].length)
    const next = rest.search(ANY_HEADING)
    const section = next === -1 ? rest : rest.slice(0, next)
    for (const match of section.matchAll(HASH_REF)) deps.add(Number(match[1]))
  }

  if (Number.isInteger(selfNumber)) deps.delete(selfNumber)
  return deps
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return []
  return labels
    .map((label) => {
      if (typeof label === 'string') return label
      if (label && typeof label.name === 'string') return label.name
      return null
    })
    .filter((label) => label !== null)
    .sort()
}

export function buildGraph(issues) {
  const nodes = new Map()
  for (const issue of Array.isArray(issues) ? issues : []) {
    const number = Number(issue?.number)
    if (!Number.isInteger(number)) continue
    nodes.set(number, {
      number,
      title: typeof issue.title === 'string' ? issue.title : '',
      labels: normalizeLabels(issue.labels),
      body: typeof issue.body === 'string' ? issue.body : '',
    })
  }

  const edges = new Map()
  const external = new Set()
  for (const node of nodes.values()) {
    const local = new Set()
    for (const dep of parseDependencies(node.body, node.number)) {
      if (nodes.has(dep)) local.add(dep)
      else external.add(dep)
    }
    edges.set(node.number, local)
  }

  return { nodes, edges, external: [...external].sort((a, b) => a - b) }
}

function findCycles(graph, candidates) {
  const inScope = new Set(candidates)
  const state = new Map()
  const cycles = []
  const seen = new Set()

  for (const start of [...inScope].sort((a, b) => a - b)) {
    if (state.get(start)) continue
    const stack = [{ node: start, iter: 0 }]
    const path = [start]
    const pathIndex = new Map([[start, 0]])
    state.set(start, 1)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const neighbors = [...graph.edges.get(frame.node)].sort((a, b) => a - b)
      if (frame.iter < neighbors.length) {
        const next = neighbors[frame.iter++]
        if (!inScope.has(next)) continue
        const seenState = state.get(next) ?? 0
        if (seenState === 0) {
          state.set(next, 1)
          pathIndex.set(next, path.length)
          path.push(next)
          stack.push({ node: next, iter: 0 })
        } else if (seenState === 1) {
          const cycle = path.slice(pathIndex.get(next))
          const key = [...cycle].sort((a, b) => a - b).join(',')
          if (!seen.has(key)) {
            seen.add(key)
            cycles.push(cycle)
          }
        }
      } else {
        state.set(frame.node, 2)
        pathIndex.delete(frame.node)
        path.pop()
        stack.pop()
      }
    }
  }

  return cycles
}

export function topologicalOrder(graph) {
  const pending = new Map()
  for (const number of graph.nodes.keys()) pending.set(number, graph.edges.get(number).size)

  const ready = [...graph.nodes.keys()].filter((number) => pending.get(number) === 0).sort((a, b) => a - b)
  const order = []

  while (ready.length > 0) {
    const number = ready.shift()
    order.push(number)
    for (const [dependent, deps] of graph.edges) {
      if (!deps.has(number)) continue
      const remaining = pending.get(dependent) - 1
      pending.set(dependent, remaining)
      if (remaining === 0) {
        ready.push(dependent)
        ready.sort((a, b) => a - b)
      }
    }
  }

  const leftover = [...graph.nodes.keys()].filter((number) => pending.get(number) > 0)
  const hasCycle = leftover.length > 0
  const cycles = hasCycle ? findCycles(graph, leftover) : []
  return { order, hasCycle, cycles, leftover }
}

export function criticalPath(graph, order) {
  const depth = new Map()
  const next = new Map()

  for (const number of order) {
    let best = 0
    let bestDep = null
    for (const dep of graph.edges.get(number)) {
      const depDepth = depth.get(dep) ?? 0
      if (depDepth > best) {
        best = depDepth
        bestDep = dep
      }
    }
    depth.set(number, best + 1)
    if (bestDep !== null) next.set(number, bestDep)
  }

  let end = null
  let max = 0
  for (const number of order) {
    if ((depth.get(number) ?? 0) > max) {
      max = depth.get(number)
      end = number
    }
  }

  const path = []
  let current = end
  while (current !== null && current !== undefined) {
    path.push(current)
    current = next.get(current) ?? null
  }

  return { length: max, path }
}

export function computeIssueGraph(issues) {
  const graph = buildGraph(issues)
  const { order, hasCycle, cycles } = topologicalOrder(graph)
  const critical = criticalPath(graph, order)

  const nodes = [...graph.nodes.values()]
    .map((node) => ({
      number: node.number,
      title: node.title,
      labels: node.labels,
      dependencies: [...graph.edges.get(node.number)].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.number - b.number)

  return {
    nodes,
    externalDependencies: graph.external,
    roots: order.filter((number) => graph.edges.get(number).size === 0),
    order,
    hasCycle,
    cycles,
    criticalPath: critical,
    counts: {
      issues: graph.nodes.size,
      edges: [...graph.edges.values()].reduce((sum, deps) => sum + deps.size, 0),
    },
  }
}

export function renderReport(report, { json = false } = {}) {
  if (json) {
    return JSON.stringify({ command: GH_ISSUE_LIST_COMMAND, ...report }, null, 2)
  }

  const lines = []
  lines.push(`command: ${GH_ISSUE_LIST_COMMAND}`)
  lines.push(`issues: ${report.counts.issues} edges: ${report.counts.edges}`)
  lines.push(`external dependencies: ${report.externalDependencies.join(', ') || 'none'}`)
  lines.push(`roots: ${report.roots.join(', ') || 'none'}`)
  lines.push(`topological order: ${report.order.join(' -> ') || 'none'}`)
  lines.push(`critical path: length=${report.criticalPath.length} ${report.criticalPath.path.join(' -> ') || 'none'}`)
  lines.push(`cycle detected: ${report.hasCycle ? report.cycles.map((cycle) => cycle.join(' -> ')).join(' | ') : 'none'}`)
  return lines.join('\n')
}

export function main(argv = process.argv.slice(2), { run = defaultGhRunner, log = console.log } = {}) {
  const json = argv.includes('--json')
  const { issues, error } = readIssues(run)

  if (error) {
    if (json) {
      log(JSON.stringify({ command: GH_ISSUE_LIST_COMMAND, result: UNKNOWN, error }))
    } else {
      log(`command: ${GH_ISSUE_LIST_COMMAND}`)
      log(UNKNOWN)
      log(error)
    }
    return 1
  }

  log(renderReport(computeIssueGraph(issues), { json }))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
