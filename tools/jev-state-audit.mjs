// jev-state-audit.mjs - Gate A canonical projection audit (JEV-BEST-PRACTICES
// §18 Gate A). Read-only: consumes a recorded logs/jev/jev-calls.jsonl and
// reports, from the exact recorded model-facing payloads:
//
//   1. field inventory      every model-facing state leaf path + presence
//   2. section sizes        serialized bytes per top-level section + tokens
//   3. duplication          outer vs semantic representation of the same fact
//   4. churn                which leaf paths changed between consecutive calls
//                           that share one coarse semantic signature
//   5. question cost        per-head instruction + criteria byte sizes
//
// Usage: bun tools/jev-state-audit.mjs <jev-calls.jsonl> [--since ISO]
//        [--until ISO] [--json out.json] [--sample N]

import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args[0]
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : args[i + 1]
}
const since = opt('since') === null ? null : Date.parse(opt('since'))
const until = opt('until') === null ? null : Date.parse(opt('until'))
const jsonOut = opt('json')
const sample = Number(opt('sample') ?? '0') // 0 = all

const bytes = (value) => Buffer.byteLength(JSON.stringify(value))

const calls = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (record.record !== 'jev-call' || record.state === undefined || record.state === null) continue
  const ts = Date.parse(record.ts)
  if (since !== null && ts < since) continue
  if (until !== null && ts > until) continue
  calls.push(record)
}
const sampled = sample > 0 ? calls.filter((_, i) => i % Math.ceil(calls.length / sample) === 0) : calls

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function leafPaths(value, prefix, out) {
  if (value === null || typeof value !== 'object') {
    out.push(prefix)
    return
  }
  if (Array.isArray(value)) {
    out.push(`${prefix}[]`)
    for (const item of value.slice(0, 4)) leafPaths(item, `${prefix}[]`, out)
    return
  }
  const keys = Object.keys(value)
  if (keys.length === 0) {
    out.push(prefix)
    return
  }
  for (const key of keys) leafPaths(value[key], `${prefix}.${key}`, out)
}

function getPath(obj, path) {
  let cur = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

function diffLeaves(a, b, prefix, out) {
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.add(prefix)
    return
  }
  if (ta === 'array') {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.add(prefix)
    return
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) diffLeaves(a[key], b[key], `${prefix}.${key}`, out)
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

// ---------------------------------------------------------------------------
// 1+2. field inventory + per-section size
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gate B compact simulation: derive the v7 canonical DecisionState from the
// recorded v6 payload and measure the real-corpus reduction. The projection
// keeps every fact once; fields that were outer-only in v6 (Option contract,
// stall evidence, queue head) are folded in from their recorded sources.
// ---------------------------------------------------------------------------

function describePredicate(predicate) {
  if (typeof predicate !== 'object' || predicate === null) return String(predicate)
  switch (predicate.kind) {
    case 'inventoryAtLeast': return `${predicate.item} >= ${predicate.count}`
    case 'inventoryClassAtLeast': return `class ${predicate.cls} >= ${predicate.count}`
    case 'pickaxeRankAtLeast': return `pickaxe rank >= ${predicate.rank}`
    case 'stationKnown': return `station ${predicate.station} known`
    case 'oreKnown': return `ore for ${predicate.item} known`
    case 'dimensionIs': return `dimension == ${predicate.dimension}`
    case 'levelAtMost': return `y <= ${predicate.y}`
    case 'levelAtLeast': return `y >= ${predicate.y}`
    case 'positionNear': return `position within ${predicate.distance} of ${predicate.position?.x},${predicate.position?.y},${predicate.position?.z}`
    case 'healthAtLeast': return `health >= ${predicate.health}`
    case 'custom': return `custom:${predicate.id}`
    default: return JSON.stringify(predicate)
  }
}

function compactSimulate(state) {
  const semantic = state.semantic
  if (semantic === null || typeof semantic !== 'object') return null
  const currentOption = state.currentOption ?? null
  const rawQueue = state.goalQueue ?? null
  const rawStall = state.signals?.strategicNonProgress ?? null
  const queue = rawQueue === null ? null : {
    depth: rawQueue.depth,
    empty: rawQueue.empty,
    hasImpossible: false, // not recorded in the v6 outer block; conservative
    current: rawQueue.current === null || rawQueue.current === undefined ? null : {
      id: rawQueue.current.id,
      description: String(rawQueue.current.description ?? '').slice(0, 160),
      optionInstanceId: rawQueue.current.optionInstanceId ?? null,
      semanticOptionInstanceId: rawQueue.current.semanticOptionInstanceId ?? null,
    },
  }
  const progress = { ...semantic.progress }
  delete progress.stallExhausted
  delete progress.stallDistinctStates
  progress.stall = rawStall === null ? null : {
    windowSize: rawStall.windowSize,
    distinctStates: rawStall.distinctStates,
    bodyDecisions: rawStall.bodyProgressDecisions,
    semanticDecisions: rawStall.semanticProgressDecisions,
    horizon: rawStall.horizon,
    maxDistinctStates: rawStall.maxDistinctStates,
    exhausted: rawStall.exhausted === true,
    exhaustedRepeats: rawStall.exhaustedRepeats,
  }
  const option = {
    ...semantic.option,
    semanticInstanceId: currentOption?.semanticInstanceId ?? null,
    semanticTemplateId: currentOption?.semanticTemplateId ?? null,
    intent: currentOption?.semanticIntent ?? null,
    preconditions: (currentOption?.preconditions ?? []).map(describePredicate),
    success: (currentOption?.success ?? []).map(describePredicate),
    allowedSkills: currentOption?.allowedSkills ?? [],
    verifiedProgress: currentOption?.runtime?.verifiedProgress ?? 0,
    failures: currentOption?.runtime?.failures ?? 0,
  }
  return { ...semantic, option, progress, queue, projectionHash: state.projectionHash ?? null }
}

const compactSim = args.includes('--compact-sim')
const compactBytesList = []
const compactMissing = []

const sectionBytes = new Map() // name -> number[]
const fieldPresence = new Map() // leaf path -> count
const fieldBytes = new Map() // leaf path -> total bytes
const inputTokens = []
const latency = []
const questionBytes = []
const questionInstrBytes = new Map() // head -> instruction chars (constant)

for (const call of sampled) {
  const state = call.state
  if (compactSim) {
    const compact = compactSimulate(state)
    if (compact === null) compactMissing.push(call.callId ?? calls.indexOf(call))
    else compactBytesList.push(bytes(compact))
  }
  for (const [key, value] of Object.entries(state)) {
    const size = bytes(value)
    if (!sectionBytes.has(key)) sectionBytes.set(key, [])
    sectionBytes.get(key).push(size)
  }
  const paths = []
  leafPaths(state, 'state', paths)
  for (const path of new Set(paths)) {
    fieldPresence.set(path, (fieldPresence.get(path) ?? 0) + 1)
    const value = getPath(state, path.slice(6))
    if (value !== undefined) fieldBytes.set(path, (fieldBytes.get(path) ?? 0) + bytes(value))
  }
  const usage = call.response?.usage
  if (usage && typeof usage.inputTokens === 'number') inputTokens.push(usage.inputTokens)
  if (typeof call.latencyMs === 'number') latency.push(call.latencyMs)
  if (call.questions !== undefined && call.questions !== null) {
    questionBytes.push(bytes(call.questions))
    for (const [head, q] of Object.entries(call.questions)) {
      if (typeof q?.instructions === 'string') {
        questionInstrBytes.set(head, q.instructions.length)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. duplication: does the outer representation carry the same semantic fact?
// ---------------------------------------------------------------------------

const dup = {
  inventoryEqual: 0, inventoryTotal: 0, inventoryBytesOuter: 0,
  candidateIdsEqual: 0, candidateTotal: 0, candidateBytesOuter: 0, candidateBytesSemantic: 0,
  goalOverlapBytes: 0, recentOutcomePairs: 0,
  signalsDuplicated: 0, signalsTotal: 0,
  threatRawBytes: 0, entityBytes: 0, blockListBytes: 0, selfPositionBytes: 0,
}
for (const call of sampled) {
  const s = call.state
  const sem = s.semantic
  if (sem === undefined || sem === null) continue
  dup.inventoryTotal += 1
  dup.inventoryBytesOuter += bytes(s.inventory ?? {})
  if (JSON.stringify(s.inventory ?? {}) === JSON.stringify(sem.inventory ?? {})) dup.inventoryEqual += 1
  const outerIds = (s.candidates ?? []).map((c) => c.id).sort()
  const innerIds = (sem.candidates ?? []).map((c) => c.id).sort()
  dup.candidateTotal += 1
  dup.candidateBytesOuter += bytes(s.candidates ?? [])
  dup.candidateBytesSemantic += bytes(sem.candidates ?? [])
  if (JSON.stringify(outerIds) === JSON.stringify(innerIds)) dup.candidateIdsEqual += 1
  dup.goalOverlapBytes += bytes(s.goal ?? {})
  dup.recentOutcomePairs += (s.recentOutcomes ?? []).length
  dup.signalsTotal += 1
  const sig = s.signals ?? {}
  const prog = sem.progress ?? {}
  // exact-computable signals mirrored in semantic.progress
  if (
    sig.consecutiveFailures === prog.consecutiveFailures &&
    (sig.lastFailureCode ?? null) === (prog.lastFailureCode ?? null) &&
    (sig.escalationRecommended ?? false) === (prog.escalationRecommended ?? false) &&
    (sig.oscillationsDetected ?? 0) === (prog.oscillationsDetected ?? 0)
  ) dup.signalsDuplicated += 1
  dup.threatRawBytes += bytes(sig.threat ?? {})
  dup.entityBytes += bytes(s.nearestEntities ?? [])
  dup.blockListBytes += bytes(s.nearestBlocks ?? [])
  dup.selfPositionBytes += bytes(s.self?.position ?? {})
}

// ---------------------------------------------------------------------------
// 4. churn: same coarse semantic signature, different projection hash
// ---------------------------------------------------------------------------

const coarseKey = (call) => {
  const sem = call.state?.semantic ?? {}
  const ids = (sem.candidates ?? []).map((c) => c.identity).sort().join('|')
  return JSON.stringify([sem.goal?.key, sem.option?.instanceId, ids])
}
const sectionChurn = new Map() // leaf path -> count of calls where it changed inside same coarse signature
let sameCoarse = 0
let hashChangedInsideCoarse = 0
let consecutivePairs = 0
for (let i = 1; i < sampled.length; i += 1) {
  const prev = sampled[i - 1]
  const cur = sampled[i]
  if (coarseKey(prev) !== coarseKey(cur)) continue
  sameCoarse += 1
  consecutivePairs += 1
  const prevHash = prev.state?.projectionHash ?? null
  const curHash = cur.state?.projectionHash ?? null
  if (prevHash !== curHash) hashChangedInsideCoarse += 1
  const leaves = new Set()
  diffLeaves(prev.state, cur.state, 'state', leaves)
  for (const leaf of leaves) sectionChurn.set(leaf, (sectionChurn.get(leaf) ?? 0) + 1)
}

// trigger distribution
const triggers = new Map()
for (const call of sampled) {
  const trig = (call.stage ?? '').replace(/^policy-tick-\d+-/, '')
  triggers.set(trig, (triggers.get(trig) ?? 0) + 1)
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const spanMs =
  sampled.length > 1 ? Date.parse(sampled[sampled.length - 1].ts) - Date.parse(sampled[0].ts) : 0

const report = {
  file,
  calls: sampled.length,
  spanMinutes: Math.round((spanMs / 60000) * 100) / 100,
  callsPerMinute: spanMs > 0 ? Math.round((sampled.length / (spanMs / 60000)) * 100) / 100 : null,
  inputTokens: {
    n: inputTokens.length,
    mean: inputTokens.length ? Math.round(inputTokens.reduce((a, b) => a + b, 0) / inputTokens.length) : null,
    p50: percentile([...inputTokens].sort((a, b) => a - b), 0.5),
    p95: percentile([...inputTokens].sort((a, b) => a - b), 0.95),
  },
  stateBytesMean:
    sampled.length === 0
      ? 0
      : Math.round(sampled.reduce((a, c) => a + bytes(c.state), 0) / sampled.length),
  questionsBytesMean:
    questionBytes.length === 0 ? 0 : Math.round(questionBytes.reduce((a, b) => a + b, 0) / questionBytes.length),
  questionInstructionChars: Object.fromEntries(questionInstrBytes),
  sections: Object.fromEntries(
    [...sectionBytes.entries()]
      .map(([name, sizes]) => [
        name,
        { mean: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length), max: Math.max(...sizes) },
      ])
      .sort((a, b) => b[1].mean - a[1].mean),
  ),
  duplication: {
    inventoryIdenticalCalls: `${dup.inventoryEqual}/${dup.inventoryTotal}`,
    meanOuterInventoryBytes: dup.inventoryTotal ? Math.round(dup.inventoryBytesOuter / dup.inventoryTotal) : 0,
    candidateIdSetIdenticalCalls: `${dup.candidateIdsEqual}/${dup.candidateTotal}`,
    meanOuterCandidateBytes: dup.candidateTotal ? Math.round(dup.candidateBytesOuter / dup.candidateTotal) : 0,
    meanSemanticCandidateBytes: dup.candidateTotal ? Math.round(dup.candidateBytesSemantic / dup.candidateTotal) : 0,
    meanGoalBlockBytes: dup.inventoryTotal ? Math.round(dup.goalOverlapBytes / dup.inventoryTotal) : 0,
    outerRecentOutcomeEntries: dup.recentOutcomePairs,
    signalsProgressDuplicatedCalls: `${dup.signalsDuplicated}/${dup.signalsTotal}`,
    meanThreatRawBytes: dup.signalsTotal ? Math.round(dup.threatRawBytes / dup.signalsTotal) : 0,
    meanNearestEntitiesBytes: dup.signalsTotal ? Math.round(dup.entityBytes / dup.signalsTotal) : 0,
    meanNearestBlocksBytes: dup.signalsTotal ? Math.round(dup.blockListBytes / dup.signalsTotal) : 0,
    meanSelfPositionBytes: dup.signalsTotal ? Math.round(dup.selfPositionBytes / dup.signalsTotal) : 0,
  },
  compactSim: compactSim
    ? {
        simulatedCalls: compactBytesList.length,
        missingProjection: compactMissing.length,
        stateBytesMean: Math.round(compactBytesList.reduce((a, b) => a + b, 0) / Math.max(1, compactBytesList.length)),
        stateBytesP50: percentile([...compactBytesList].sort((a, b) => a - b), 0.5),
        stateBytesP95: percentile([...compactBytesList].sort((a, b) => a - b), 0.95),
        reductionVsRecorded: compactBytesList.length === 0 ? null :
          `${(100 * (1 - (compactBytesList.reduce((a, b) => a + b, 0) / compactBytesList.length) / (sampled.reduce((a, c) => a + bytes(c.state), 0) / sampled.length))).toFixed(1)}%`,
      }
    : undefined,
  churn: {
    consecutiveSameCoarseSignaturePairs: sameCoarse,
    hashChangedInsideSameCoarseSignature: hashChangedInsideCoarse,
    churnedLeafPaths: [...sectionChurn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
  },
  triggers: Object.fromEntries([...triggers.entries()].sort((a, b) => b[1] - a[1])),
  topFieldsByBytes: [...fieldBytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
  fieldCount: fieldPresence.size,
}

console.log(JSON.stringify(report, null, 2))
if (jsonOut !== null) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`)
