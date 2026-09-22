#!/usr/bin/env bun
// tools/skill-closure-metrics.mjs — READ-ONLY #436 §20 metrics for one run.
//
// The operator's #436 acceptance asks for temporal-abstraction evidence, not just fewer Jev calls:
//   Jev pi calls / verified Skill completion        -> decisions per completed action
//   primitive mechanical steps / Jev selection      -> actions per decision
//   repeated identical target selections            -> top repeated action ids
//   oscillation / micro-MOVE recurrence             -> distinct positions, revisit count
//   Skill policy-boundary rate                      -> SKILL_POLICY_BOUNDARY per SKILL_COMMIT
//   mandatory-prerequisite rate                     -> SKILL_STEP authority=MANDATORY_PREREQUISITE
//   hard-safety interrupt rate                      -> SKILL_STEP authority=HARD_SAFETY_REFLEX
//   target-switch-without-Jev count                 -> MUST be 0 (reported as UNKNOWN until the lanes land the marker)
//   effect-envelope violation count                 -> MUST be 0 (same)
// It never writes to the run and never touches the control socket.
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1])
const runId = args.get('run')
if (runId === undefined) {
  console.error('usage: bun tools/skill-closure-metrics.mjs --run <runId> [--root <tree>] [--lines <n>]')
  process.exit(2)
}
const root = resolve(args.get('root') ?? process.cwd())
const limit = Number(args.get('lines') ?? 20000)
const logPath = join(root, 'buddy-driver', 'buddy.log')
const decisionsPath = join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl')
for (const p of [logPath, decisionsPath]) if (!existsSync(p)) { console.error(`SKILL_METRICS missing=${p}`); process.exit(2) }

// --- the run window: from the run's BOOT line to the next BOOT (same rule the gates use) ---
const lines = readFileSync(logPath, 'utf8').split('\n')
let start = -1
let end = lines.length
for (let i = 0; i < lines.length; i += 1) {
  const m = /BOOT .*runId=(\S+)/.exec(lines[i] ?? '')
  if (m === null) continue
  if (m[1] === runId && start === -1) start = i
  else if (start !== -1 && m[1] !== runId) { end = i; break }
}
if (start === -1) { console.error(`SKILL_METRICS run_boundary_missing runId=${runId}`); process.exit(2) }
const window = lines.slice(start, end).slice(-limit)

const tally = (re, text) => (text.match(re) ?? []).length
const actions = []
const positions = []
const markers = new Map()
for (const line of window) {
  const a = /ACTION n=(\d+) id=(\S+) kind=(\S+)/.exec(line)
  if (a !== null) actions.push({ id: a[2], kind: a[3] })
  // HEARTBEAT carries the floored body cell; count revisits to expose oscillation.
  const h = /HEARTBEAT pos=([-0-9.]+),([-0-9.]+),([-0-9.]+)/.exec(line)
  if (h !== null) positions.push(`${Math.floor(Number(h[1]))},${Math.floor(Number(h[2]))},${Math.floor(Number(h[3]))}`)
  const m = /\]\s+([A-Z][A-Z0-9_]{2,})\b/.exec(line)
  if (m !== null) markers.set(m[1], (markers.get(m[1]) ?? 0) + 1)
}
const decisions = readFileSync(decisionsPath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
const inWindow = decisions.filter((l) => { try { const d = JSON.parse(l); return typeof d.ts === 'string' && d.ts >= (window[0]?.slice(1, 25) ?? '') } catch { return false } })
const options = new Map()
for (const l of inWindow) { try { const d = JSON.parse(l); const k = String(d.optionId); options.set(k, (options.get(k) ?? 0) + 1) } catch {} }
const repeats = new Map()
for (const a of actions) repeats.set(a.id, (repeats.get(a.id) ?? 0) + 1)
const topRepeats = [...repeats.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5)
const kinds = new Map()
for (const a of actions) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1)
const distinctPositions = new Set(positions)
const uniqueDecisions = options.size

const num = (name) => markers.get(name) ?? 0
const out = {
  runId,
  windowLines: window.length,
  fromLine: start,
  jevDecisions: inWindow.length,
  distinctOptionIds: uniqueDecisions,
  actions: actions.length,
  actionsPerDecision: inWindow.length === 0 ? null : Number((actions.length / inWindow.length).toFixed(2)),
  topRepeatedActions: topRepeats,
  actionKinds: Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)),
  heartbeatPositions: positions.length,
  distinctFlooredCells: distinctPositions.size,
  cellRevisitRatio: positions.length === 0 ? null : Number((1 - distinctPositions.size / positions.length).toFixed(3)),
  skills: { commit: num('SKILL_COMMIT'), step: num('SKILL_STEP'), policyBoundary: num('SKILL_POLICY_BOUNDARY'), end: num('SKILL_END') },
  reflexLayers: {
    mechanicalContinuation: tally(/authority=MECHANICAL_CONTINUATION/g, window.join('\n')),
    mandatoryPrerequisite: tally(/authority=MANDATORY_PREREQUISITE/g, window.join('\n')),
    hardSafetyReflex: tally(/authority=HARD_SAFETY_REFLEX/g, window.join('\n')),
  },
  // MUST-be-zero counters (#436 §20): reported UNKNOWN until the lanes emit the markers, never as 0 by default.
  targetSwitchWithoutJev: num('TARGET_SWITCH_WITHOUT_JEV') === 0 && num('SKILL_POLICY_BOUNDARY') === 0 ? 'UNKNOWN' : num('TARGET_SWITCH_WITHOUT_JEV'),
  effectEnvelopeViolations: num('EFFECT_ENVELOPE_VIOLATION') === 0 && num('SKILL_COMMIT') === 0 ? 'UNKNOWN' : num('EFFECT_ENVELOPE_VIOLATION'),
}
console.log(JSON.stringify(out, null, 2))
