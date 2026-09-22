#!/usr/bin/env bun
// tools/jev-semantic-gate-estimate.mjs — READ-ONLY offline estimate for #437.
//
// WHY THIS EXISTS: the live proof of the semantic-state gate needs the resident to
// reload with the new code (the run's `JEV_DECISION_EPOCH_START` markers). Until a
// post-reload run exists, this tool answers one counterfactual question from data
// that is already on disk:
//
//   "how many of the recorded pi decisions were asked against a semantic state
//    that had not changed since the previous decision?"
//
// It is an ESTIMATE, not live acceptance (AGENTS #63): it replays each recorded
// decision's model-visible candidate shapes (the recorded `label` with digits
// erased, plus goal/Option/inventory) and counts consecutive repeats. The real
// projection also carries safety bands and the typed previous outcome, so the real
// gate can only be EQUAL OR MORE conservative than this number - never less.
//
// usage: bun tools/jev-semantic-gate-estimate.mjs [--run <runId>] [--root <tree>] [--last <n>]
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]?.replace(/^--/, ''), process.argv[index + 1])
const root = resolve(args.get('root') ?? process.cwd())
const runId = args.get('run') ?? null
const last = Number(args.get('last') ?? 500)
const logPath = join(root, 'buddy-driver', 'buddy.log')
const decisionsPath = join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl')
for (const path of [logPath, decisionsPath]) if (!existsSync(path)) { console.error(`JEV_GATE_ESTIMATE missing=${path}`); process.exit(2) }

const lines = readFileSync(logPath, 'utf8').split('\n')
let from = ''
let to = ''
if (runId !== null) {
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const match = /BOOT .*runId=(\S+)/.exec(lines[index] ?? '')
    if (match === null) continue
    if (match[1] === runId && start === -1) start = index
    else if (start !== -1 && match[1] !== runId) { to = (lines[index] ?? '').slice(1, 25); break }
  }
  if (start === -1) { console.error(`JEV_GATE_ESTIMATE run_boundary_missing runId=${runId}`); process.exit(2) }
  from = (lines[start] ?? '').slice(1, 25)
}

const digitless = (text) => String(text).replace(/[-0-9]+/g, '#')
const semanticKey = (record) =>
  JSON.stringify({
    option: record.semanticOptionInstanceId ?? record.optionId ?? null,
    goal: record.goalQueueState?.current?.id ?? null,
    have: record.goalQueueState?.current?.haveCount ?? null,
    inventory: record.inventory ?? {},
    candidates: (record.candidates ?? [])
      .map((candidate) => `${candidate.kind}|${digitless(candidate.label ?? candidate.id)}`)
      .sort(),
  })

const records = readFileSync(decisionsPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter((record) => record !== null && typeof record.ts === 'string')
  .filter((record) => (from === '' || record.ts >= from) && (to === '' || record.ts < to))
  .slice(-last)

let suppressed = 0
let previous = null
const distinct = new Set()
const repeatedChosen = new Map()
for (const record of records) {
  const key = semanticKey(record)
  distinct.add(key)
  if (previous === key) suppressed += 1
  previous = key
  const chosen = String(record.chosenAction ?? 'none')
  repeatedChosen.set(chosen, (repeatedChosen.get(chosen) ?? 0) + 1)
}

const modelCalls = records.length - suppressed
const out = {
  plane: 'OFFLINE_ESTIMATE (not live acceptance)',
  runId: runId ?? `last ${records.length} recorded decisions`,
  records: records.length,
  distinctSemanticStates: distinct.size,
  // decisions the semantic-state gate would have replayed instead of re-asking
  estimatedSuppressedModelCalls: suppressed,
  estimatedModelCalls: modelCalls,
  estimatedSuppressionRatio: records.length === 0 ? null : Number((suppressed / records.length).toFixed(3)),
  estimatedModelCallsPerDistinctState: distinct.size === 0 ? null : Number((modelCalls / distinct.size).toFixed(2)),
  topRepeatedChoices: [...repeatedChosen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  caveat: 'the real projection also carries safety bands + the typed previous outcome, so the live gate is equal or MORE conservative',
}
console.log(JSON.stringify(out, null, 2))
