// Execute a deterministic suite and emit the current-result artifact consumed
// by tools/known-red.mjs. Every declared command is attempted, even after a
// failure, so the artifact cannot hide an unobserved test behind fail-fast CI.

import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const RESULT_SCHEMA_VERSION = 1
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const npmRun = (id, script, cwd = '.') => ({
  id,
  cwd,
  command: 'npm',
  args: ['run', script],
})

const npmCommand = (id, args, cwd = '.') => ({
  id,
  cwd,
  command: 'npm',
  args,
})

const command = (id, executable, args, cwd = '.') => ({
  id,
  cwd,
  command: executable,
  args,
})

export const SUITES = Object.freeze({
  convergence: Object.freeze([
    npmRun('convergence.frontier-test', 'frontier-test'),
    npmRun('convergence.issue-state-test', 'issue-state-test'),
    npmRun('convergence.issue-graph-test', 'issue-graph-test'),
    npmRun('convergence.current-status-test', 'current-status-test'),
    npmRun('convergence.lane-guard-test', 'lane-guard-test'),
    npmRun('convergence.milestone-status-check', 'milestone-status:check'),
    npmRun('convergence.milestone-status-test', 'milestone-status-test'),
    npmRun('convergence.m2-watch-test', 'm2-watch-test'),
    npmRun('convergence.m2-acceptance-test', 'm2-acceptance-test'),
    npmRun('convergence.m2-live-gate-test', 'm2-live-gate-test'),
    npmRun('convergence.known-red-test', 'known-red-test'),
    npmRun('convergence.issue13-evidence-test', 'issue13-evidence-test'),
    npmRun('convergence.frontier-check', 'frontier:check'),
    npmRun('convergence.issue-state-check', 'issue-state:check'),
  ]),
  'core-deterministic': Object.freeze([
    npmCommand('core.install', ['ci'], 'jev-agent'),
    command('core.link-shared-dependencies', 'ln', ['-sfn', '../jev-agent/node_modules', 'buddy-driver/node_modules']),
    npmRun('core.typecheck', 'typecheck', 'jev-agent'),
    npmRun('core.game-data-test', 'game-data-test', 'jev-agent'),
    npmRun('core.minecraft-truth-test', 'minecraft-truth-test', 'jev-agent'),
    npmRun('core.option-spec-test', 'option-spec-test', 'jev-agent'),
    npmRun('core.action-verify-test', 'action-verify-test', 'jev-agent'),
    npmRun('core.protected-goals-test', 'protected-goals-test', 'jev-agent'),
    npmRun('core.reachability-test', 'reachability-test', 'jev-agent'),
    npmRun('core.candidate-policy-test', 'candidate-policy-test', 'jev-agent'),
    npmRun('core.move-failmem-test', 'move-failmem-test', 'jev-agent'),
    npmRun('core.pit-escape-test', 'pit-escape-test', 'jev-agent'),
    npmRun('core.pillar-search-test', 'pillar-search-test', 'jev-agent'),
    npmRun('core.hop-policy-test', 'hop-policy-test', 'jev-agent'),
    npmRun('core.pillar-jump-test', 'pillar-jump-test', 'jev-agent'),
    npmRun('core.pillar-apex-test', 'pillar-apex-test', 'jev-agent'),
  ]),
})

function assertEntry(entry) {
  if (typeof entry !== 'object' || entry === null) throw new Error('suite entry must be an object')
  if (typeof entry.id !== 'string' || entry.id.length === 0) throw new Error('suite entry id must be non-empty')
  if (typeof entry.command !== 'string' || entry.command.length === 0) throw new Error(`suite entry ${entry.id} command must be non-empty`)
  if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) throw new Error(`suite entry ${entry.id} args must be strings`)
  if (typeof entry.cwd !== 'string' || entry.cwd.length === 0) throw new Error(`suite entry ${entry.id} cwd must be non-empty`)
}

export function suiteEntries(name) {
  const entries = SUITES[name]
  if (!entries) throw new Error(`unknown suite ${name}`)
  const ids = new Set()
  for (const entry of entries) {
    assertEntry(entry)
    if (ids.has(entry.id)) throw new Error(`suite ${name} contains duplicate id ${entry.id}`)
    ids.add(entry.id)
  }
  return entries
}

export function classifyOutcome(outcome) {
  if (outcome === null || typeof outcome !== 'object') return { status: 'UNKNOWN', detail: 'runner returned no outcome' }
  if (outcome.error !== undefined && outcome.error !== null) {
    return { status: 'UNKNOWN', detail: `runner error: ${outcome.error.message ?? String(outcome.error)}` }
  }
  if (outcome.signal !== null && outcome.signal !== undefined) {
    return { status: 'UNKNOWN', detail: `terminated by signal ${outcome.signal}` }
  }
  if (outcome.status === 0) return { status: 'PASS', detail: 'exit=0' }
  if (Number.isInteger(outcome.status)) return { status: 'FAIL', detail: `exit=${outcome.status}` }
  return { status: 'UNKNOWN', detail: 'runner returned neither exit status nor signal' }
}

export function executeCommand(entry, { root = ROOT } = {}) {
  return spawnSync(entry.command, entry.args, {
    cwd: resolve(root, entry.cwd),
    env: process.env,
    stdio: 'inherit',
  })
}

export function resolveCommit({ root = ROOT, env = process.env } = {}) {
  if (typeof env.GITHUB_SHA === 'string' && env.GITHUB_SHA.trim().length > 0) return env.GITHUB_SHA.trim()
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (git.status === 0 && typeof git.stdout === 'string' && git.stdout.trim().length > 0) return git.stdout.trim()
  return 'unknown'
}

export function runSuite(name, { execute = executeCommand, root = ROOT, commit = resolveCommit({ root }), now = () => new Date() } = {}) {
  const entries = suiteEntries(name)
  const capturedAt = now().toISOString()
  const results = []
  for (const entry of entries) {
    let outcome
    try {
      outcome = execute(entry, { root })
    } catch (error) {
      outcome = { error }
    }
    const result = classifyOutcome(outcome)
    results.push({
      id: entry.id,
      status: result.status,
      command: [entry.command, ...entry.args].join(' '),
      cwd: entry.cwd,
      detail: result.detail,
    })
    process.stdout.write(`KNOWN_RED_TEST id=${entry.id} status=${result.status} detail=${JSON.stringify(result.detail)}\n`)
  }
  const finishedAt = now().toISOString()
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    commit,
    suite: name,
    capturedAt,
    finishedAt,
    results,
  }
}

export function writeArtifact(path, artifact) {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
}

function parseArgs(argv) {
  const args = { suite: null, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--suite' || arg === '--out') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      args[arg.slice(2)] = value
      index += 1
    } else {
      throw new Error(`unknown argument ${arg}`)
    }
  }
  if (args.suite === null || args.out === null) throw new Error('usage: node tools/known-red-runner.mjs --suite <name> --out <path>')
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const artifact = runSuite(args.suite)
  writeArtifact(args.out, artifact)
  const counts = artifact.results.reduce((acc, result) => {
    acc[result.status] += 1
    return acc
  }, { PASS: 0, FAIL: 0, UNKNOWN: 0 })
  process.stdout.write(`KNOWN_RED_CURRENT suite=${args.suite} out=${args.out} pass=${counts.PASS} fail=${counts.FAIL} unknown=${counts.UNKNOWN}\n`)
  if (counts.FAIL > 0) process.exitCode = 1
  else if (counts.UNKNOWN > 0) process.exitCode = 2
  return artifact
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
