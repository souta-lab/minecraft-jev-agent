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
const logPath = join(root, 'packages/buddy-driver', 'buddy.log')
const decisionsPath = join(root, 'packages/buddy-driver', 'logs', 'jev', 'decisions.jsonl')
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

/**
 * #437 §9/§12: a bounded projection should repeat its hash when the semantic
 * situation repeats.
 *
 * The hash is VERSIONED (`jp<version>:<16 hex>`, see `projectionHash`), so the capture
 * must accept the `jp<version>:` prefix. Matching bare hex here silently reported
 * `observations: 0` on every real run - the metric looked implemented and was
 * always empty. `tools/test-skill-closure-metrics.mjs` pins this.
 */
function projectionStability(window) {
  const hashes = []
  for (const line of window) {
    const m = /JEV_STATE_PROJECTION[^\n]*\bhash=(\S+)/.exec(line)
    if (m !== null) hashes.push(m[1])
  }
  if (hashes.length === 0) return { observations: 0, distinct: 'UNKNOWN', note: 'no JEV_STATE_PROJECTION marker yet' }
  const distinct = new Set(hashes)
  return {
    observations: hashes.length,
    distinct: distinct.size,
    dominantShare: Number((Math.max(...[...distinct].map((h) => hashes.filter((x) => x === h).length)) / hashes.length).toFixed(3)),
  }
}

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
// --- issue #437: the Skill <-> Jev boundary plane -----------------------------
// `jevDecisions` above counts decision RECORDS (ticks that formed a choice), not
// model calls. The boundary markers separate the two: an epoch start WITHOUT
// cacheHit=true is a paid pi call, a cacheHit=true start is a semantic-state
// replay, and the projection hash set shows how many genuinely different
// semantic states the model was asked about.
const epochStarts = window.filter((line) => /\]\s+JEV_DECISION_EPOCH_START\b/.test(line))
const modelCalls = epochStarts.filter((line) => !/cacheHit=true/.test(line)).length
const reusedDecisions = epochStarts.length - modelCalls
const projectionHashes = new Set()
const requeryReasons = new Map()
const outcomeReasons = new Map()
for (const line of window) {
  const p = /\]\s+JEV_STATE_PROJECTION .*?\bhash=(\S+)/.exec(line)
  if (p !== null) projectionHashes.add(p[1])
  const s = /\]\s+JEV_DECISION_EPOCH_START .*?\breason=(\S+)/.exec(line)
  if (s !== null) requeryReasons.set(s[1], (requeryReasons.get(s[1]) ?? 0) + 1)
  const o = /\]\s+SKILL_OUTCOME_PACKET .*?\bterminalReason=(\S+)/.exec(line)
  if (o !== null) outcomeReasons.set(o[1], (outcomeReasons.get(o[1]) ?? 0) + 1)
}
const ratio = (top, bottom) => (bottom === 0 ? null : Number((top / bottom).toFixed(2)))
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
  // #437 §20: pi calls per action and per distinct semantic state, plus the
  // boundary reasons that bought each call. `UNKNOWN` until the lane's markers
  // are live, never a fabricated 0.
  jevBoundary:
    epochStarts.length === 0
      ? 'UNKNOWN (JEV_DECISION_EPOCH_START not in this window)'
      : {
          epochStarts: epochStarts.length,
          modelCalls,
          reusedDecisions,
          distinctProjectionHashes: projectionHashes.size,
          actionsPerModelCall: ratio(actions.length, modelCalls),
          modelCallsPerDistinctProjection: ratio(modelCalls, projectionHashes.size),
          requeryReasons: Object.fromEntries([...requeryReasons.entries()].sort((a, b) => b[1] - a[1])),
          outcomeReasons: Object.fromEntries([...outcomeReasons.entries()].sort((a, b) => b[1] - a[1])),
          staleResultsDropped: num('STALE_JEV_RESULT_DROPPED'),
        },
  skills: { commit: num('SKILL_COMMIT'), step: num('SKILL_STEP'), policyBoundary: num('SKILL_POLICY_BOUNDARY'), end: num('SKILL_END') },
  reflexLayers: {
    mechanicalContinuation: tally(/authority=MECHANICAL_CONTINUATION/g, window.join('\n')),
    mandatoryPrerequisite: tally(/authority=MANDATORY_PREREQUISITE/g, window.join('\n')),
    hardSafetyReflex: tally(/authority=HARD_SAFETY_REFLEX/g, window.join('\n')),
  },
  // #437 acceptance additions: epoch isolation, projection stability, and the two MUST-be-zero counters.
  epoch: {
    starts: num('JEV_DECISION_EPOCH_START'),
    ends: num('JEV_DECISION_EPOCH_END'),
    projections: num('JEV_STATE_PROJECTION'),
    candidateSets: num('JEV_CANDIDATE_SET'),
    outcomePackets: num('SKILL_OUTCOME_PACKET'),
    staleResultsDropped: num('STALE_JEV_RESULT_DROPPED'),
  },
  projectionStability: projectionStability(window),
  // MUST-be-zero counters (#436 §20): reported UNKNOWN until the lanes emit the markers, never as 0 by default.
  targetSwitchWithoutJev: num('TARGET_SWITCH_WITHOUT_JEV') === 0 && num('SKILL_POLICY_BOUNDARY') === 0 ? 'UNKNOWN' : num('TARGET_SWITCH_WITHOUT_JEV'),
  // The executor emits SKILL_ENVELOPE_VIOLATION (executor.ts assertEffect); the old name here
  // matched nothing, so a MUST-be-zero counter read 0 while the live run had 100+ real
  // violations - a false-clean evidence signal. Keep the UNKNOWN-until-the-plane-exists rule.
  effectEnvelopeViolations: num('SKILL_ENVELOPE_VIOLATION') === 0 && num('SKILL_COMMIT') === 0 ? 'UNKNOWN' : num('SKILL_ENVELOPE_VIOLATION'),
}
console.log(JSON.stringify(out, null, 2))
