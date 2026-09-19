#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT_PATH = join(ROOT, 'MILESTONE-CONTRACT.json')
const STATUS = new Set(['PASS', 'FAIL', 'UNKNOWN'])

export function loadContract(path = CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function validateContract(contract) {
  const errors = []
  if (contract?.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!Array.isArray(contract?.statusValues) || contract.statusValues.join(',') !== 'PASS,FAIL,UNKNOWN') {
    errors.push('statusValues must be exactly PASS, FAIL, UNKNOWN')
  }
  const milestones = contract?.milestones
  if (milestones === null || typeof milestones !== 'object' || Array.isArray(milestones)) {
    errors.push('milestones must be an object')
    return errors
  }
  for (const id of ['M0', 'M1', 'M2', 'M3', 'M4']) {
    const milestone = milestones[id]
    if (milestone === null || typeof milestone !== 'object') {
      errors.push(`${id} is missing`)
      continue
    }
    if (typeof milestone.title !== 'string' || milestone.title.length === 0) errors.push(`${id}.title is required`)
    const evaluator = milestone.evaluator
    if (evaluator?.type !== 'manual' && evaluator?.type !== 'command') errors.push(`${id}.evaluator.type must be manual|command`)
    if (evaluator?.type === 'manual' && (typeof evaluator.reason !== 'string' || evaluator.reason.length === 0)) {
      errors.push(`${id}.evaluator.reason is required for manual gates`)
    }
    if (evaluator?.type === 'command') {
      if (typeof evaluator.script !== 'string' || evaluator.script.length === 0) errors.push(`${id}.evaluator.script is required for command gates`)
      if (evaluator.scopeArg !== undefined && evaluator.scopeArg !== '--since' && evaluator.scopeArg !== '--run') {
        errors.push(`${id}.evaluator.scopeArg must be --since|--run when present`)
      }
    }
  }
  return errors
}

function parseM2Status(text) {
  const matches = [...text.matchAll(/M2_LIVE_RESULT\s+status=(PASS|FAIL|UNKNOWN)\b/g)]
  return matches.at(-1)?.[1] ?? null
}

export function evaluateMilestone(contract, id, options = {}) {
  const milestone = contract.milestones[id]
  if (milestone === undefined) return { id, status: 'UNKNOWN', reason: 'unknown_milestone' }
  const evaluator = milestone.evaluator
  if (evaluator.type === 'manual') return { id, status: 'UNKNOWN', reason: evaluator.reason }

  const since = options.since ?? null
  const runId = options.runId ?? null
  const scopeValue = evaluator.scopeArg === '--run' ? runId : evaluator.scopeArg === '--since' ? since : null
  if (evaluator.scopeArg !== undefined && (typeof scopeValue !== 'string' || scopeValue.trim().length === 0)) {
    return { id, status: 'UNKNOWN', reason: evaluator.scopeArg === '--run' ? 'exact_run_scope_required' : 'run_scope_required' }
  }

  const args = [join(ROOT, evaluator.script)]
  if (evaluator.scopeArg !== undefined) args.push(evaluator.scopeArg, scopeValue)
  const run = options.runCommand ?? ((argv) => spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8' }))
  const result = run(args)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const parsed = id === 'M2' ? parseM2Status(output) : null
  if (parsed !== null && STATUS.has(parsed)) return { id, status: parsed, reason: `delegated:${evaluator.script}`, output }
  if (result.error !== undefined) return { id, status: 'UNKNOWN', reason: `gate_error:${result.error.message}`, output }
  return { id, status: 'UNKNOWN', reason: 'gate_emitted_no_machine_status', output }
}

function parseArgs(argv) {
  const out = { milestone: null, since: null, runId: null, json: false, check: false, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--milestone') out.milestone = argv[++i] ?? null
    else if (arg === '--since') out.since = argv[++i] ?? null
    else if (arg === '--run') out.runId = argv[++i] ?? null
    else if (arg === '--json') out.json = true
    else if (arg === '--check') out.check = true
    else if (arg === '--list') out.list = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const contract = loadContract()
  const errors = validateContract(contract)
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`MILESTONE_CONTRACT_ERROR ${error}\n`)
    process.exitCode = 1
    return
  }
  if (args.check) {
    process.stdout.write('MILESTONE_CONTRACT status=PASS schemaVersion=1\n')
    return
  }
  if (args.list) {
    for (const [id, milestone] of Object.entries(contract.milestones)) process.stdout.write(`${id}\t${milestone.title}\n`)
    return
  }
  if (args.milestone === null) throw new Error('usage: milestone-status --milestone M0|M1|M2|M3|M4 [--run RUN_ID|--since ISO] [--json]')
  const result = evaluateMilestone(contract, args.milestone, { since: args.since, runId: args.runId })
  if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`MILESTONE_RESULT id=${result.id} status=${result.status} reason=${JSON.stringify(result.reason)}\n`)
  process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`MILESTONE_STATUS_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
