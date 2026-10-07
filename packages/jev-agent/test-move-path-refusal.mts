// Regressions for one destination getting two contradictory path verdicts and
// then being selected again before its ordinary failure cooldown.
import { guardMoveFailureReason } from './src/controller.ts'
import { filterBlacklistedMoves, MoveFailMemory } from './src/moveFailMemory.ts'
import { recordMoveFailure } from './src/outcome-ledgers.ts'
import type { OutcomeLedgersHost } from './src/outcome-ledgers.ts'
import { createPositionFactCache } from './src/positionFactCache.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const target = { x: 98, y: 67, z: 78 }
const origin = { x: 106, y: 63, z: 106 }
let pathSearches = 0
const sharedPathFacts = createPositionFactCache((position) => {
  pathSearches += 1
  return { probe: position.x === target.x ? ('reachable' as const) : ('no_path' as const) }
})

// Candidate grounding and guard both read the same per-destination fact cache.
const candidateProbe = sharedPathFacts(target).probe
const guardCanComputePath = (position: typeof target): boolean => sharedPathFacts(position).probe === 'reachable'
const guardProbe = guardCanComputePath(target) ? 'reachable' : 'NO_PATH'
check(
  'candidate and guard share one path result for the destination',
  candidateProbe === 'reachable' && guardProbe === 'reachable' && pathSearches === 1,
  `candidate=${candidateProbe} guard=${guardProbe} searches=${pathSearches}`,
)

// If a guard still reports NO_PATH (for example, a second guard predicate
// catches a pathfinder discrepancy), treat it as a scoped mechanical refusal.
const guardFailure = guardMoveFailureReason({ kind: 'MOVE' }, 'NO_PATH')
let now = 10_000
const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => now })
const scope = { origin, worldRevision: 51, generationId: 'generation-a' }
if (guardFailure === 'no_path') memory.recordPathFailure('overworld', target, scope)
const offered = [
  { id: 'MOVE:b98_67_78', kind: 'MOVE', target },
  { id: 'MOVE:b121_70_91', kind: 'MOVE', target: { x: 121, y: 70, z: 91 } },
  { id: 'WAIT', kind: 'WAIT', target: null },
]
const filtered = filterBlacklistedMoves(offered, memory, 'overworld', scope)
check(
  'a guard NO_PATH removes the contradicted destination before its cooldown',
  guardFailure === 'no_path' &&
    filtered.kept.map((candidate) => candidate.id).join(',') === 'MOVE:b121_70_91,WAIT' &&
    filtered.skipped.length === 1 &&
    memory.check('overworld', target, scope).blacklisted &&
    memory.check('overworld', target, scope).cooldownRemainingMs === 0,
  `guardFailure=${guardFailure} kept=${filtered.kept.map((candidate) => candidate.id).join(',')} ` +
    `cooldown=${memory.check('overworld', target, scope).cooldownRemainingMs}`,
)

// The refusal is invalidated by movement, a world mutation, or a new resident
// generation. The ordinary attempt threshold/cooldown still governs repeats.
const movedScope = { ...scope, origin: { x: 107, y: 63, z: 106 } }
const changedWorldScope = { ...scope, worldRevision: 52 }
const newGenerationScope = { ...scope, generationId: 'generation-b' }
check(
  'path refusal expires when its complete witness changes',
  !memory.isBlacklisted('overworld', target, movedScope) &&
    !memory.isBlacklisted('overworld', target, changedWorldScope) &&
    !memory.isBlacklisted('overworld', target, newGenerationScope),
  `moved=${memory.isBlacklisted('overworld', target, movedScope)} ` +
    `world=${memory.isBlacklisted('overworld', target, changedWorldScope)} ` +
    `generation=${memory.isBlacklisted('overworld', target, newGenerationScope)}`,
)

// Keep the ordinary bounded cooldown as a cross-generation fallback after the
// threshold is reached, even when the immediate same-state scope no longer fits.
memory.recordPathFailure('overworld', target, scope)
memory.recordPathFailure('overworld', target, scope)
const afterThreshold = memory.check('overworld', target, newGenerationScope)
const afterThresholdFilter = filterBlacklistedMoves(offered, memory, 'overworld', newGenerationScope)
check(
  'the existing threshold cooldown remains the fallback outside path scope',
  afterThreshold.blacklisted &&
    afterThreshold.cooldownRemainingMs > 0 &&
    !afterThresholdFilter.kept.some((candidate) => candidate.id === 'MOVE:b98_67_78'),
  `attempts=${afterThreshold.attempts} cooldown=${afterThreshold.cooldownRemainingMs} ` +
    `retained=${afterThresholdFilter.kept.some((candidate) => candidate.id === 'MOVE:b98_67_78')}`,
)

// p27: a settled RETREAT path_stuck was immediately re-offered as MOVE at the
// same cell. Preserve that exact-cell refusal across candidate kinds only while
// body cell, world revision, and generation still match; leave alternatives live.
const p27Memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => now })
const p27Target = { x: 7190, y: 14, z: 1269 }
const p27Scope = { origin: { x: 7191, y: 14, z: 1268 }, worldRevision: 104, generationId: 'gen-p27' }
const p27Host = {
  currentDimension: () => 'overworld',
  movePathFailureScope: () => p27Scope,
  moveFailMemory: p27Memory,
  logger: { warn: () => {} },
  tickCounter: 1,
  notifyMoveFailureMemory: () => {},
} as unknown as OutcomeLedgersHost
recordMoveFailure(p27Host, {
  id: 'RETREAT:p7190_14_1269', kind: 'RETREAT', target: p27Target,
} as Parameters<typeof recordMoveFailure>[1], 'stuck')
const p27Offer = [
  { id: 'RETREAT:p7190_14_1269', kind: 'RETREAT', target: p27Target },
  { id: 'MOVE:p7190_14_1269', kind: 'MOVE', target: p27Target },
  { id: 'MOVE:p7189_15_1269', kind: 'MOVE', target: { x: 7189, y: 15, z: 1269 } },
  { id: 'WAIT', kind: 'WAIT', target: null },
]
const p27Same = filterBlacklistedMoves(p27Offer, p27Memory, 'overworld', p27Scope)
const p27Restored = new MoveFailMemory({ now: () => now, initialEntries: p27Memory.snapshot() })
const p27ChangedOrigin = filterBlacklistedMoves(p27Offer, p27Restored, 'overworld', {
  ...p27Scope,
  origin: { x: 7192, y: 15, z: 1268 },
})
check(
  'p27 settled path_stuck suppresses the same cell across RETREAT/MOVE, but preserves other routes and invalidates on movement',
  p27Same.kept.map((candidate) => candidate.id).join(',') === 'MOVE:p7189_15_1269,WAIT' &&
    p27Same.skipped.length === 2 &&
    p27Restored.isBlacklisted('overworld', p27Target, p27Scope) &&
    p27ChangedOrigin.kept.some((candidate) => candidate.id === 'MOVE:p7190_14_1269'),
  `sameScopeKept=${p27Same.kept.map((candidate) => candidate.id).join(',')} ` +
    `skipped=${p27Same.skipped.length} restored=${p27Restored.isBlacklisted('overworld', p27Target, p27Scope)} ` +
    `movedOriginReoffered=${p27ChangedOrigin.kept.some((candidate) => candidate.id === 'MOVE:p7190_14_1269')}`,
)

process.stdout.write(`\n${5 - failures}/5 move-path-refusal cases passed\n`)
process.exit(failures === 0 ? 0 : 1)
