// test-move-blacklist-identity.mts - P0 (#360 follow-up): the movement blacklist
// must be authoritative on the candidate surface Jev is offered, under ONE
// canonical cell identity.
//
// Live failure (runs/m3-live/consolidated-5m.log, 14:00:22.776):
//
//   14:00:22.776 MOVE_TARGET_SKIPPED overworld:3,67,17 ... reason=oscillation
//   14:00:22.777 MOVE_TARGET_SKIPPED overworld:3,67,18 ... reason=oscillation
//   14:00:22.778 LOCAL_MOVE_OSCILLATION from=3.5,67,18.5 to=3.5,67,17.69
//   14:00:23.431 JEV_HEADS action=MOVE:p3_67_18     <- the skipped cell, re-offered
//
// `detectMoveOscillation` blacklists the raw BODY positions; the candidate
// surface (`MOVE:p3_67_18`, target {3,67,18}) is an integer block cell. At rest
// the body sits on the CELL CENTRE, so `Math.round(3.5)=4` and
// `Math.round(18.5)=19`: the skip was recorded as `overworld:4,67,19` and the
// filter tested `overworld:3,67,18`. The skip never reached the surface.
//
// Run: bun test ./test-move-blacklist-identity.mts
import {
  detectOscillation,
  filterBlacklistedMoves,
  MoveFailMemory,
  moveFailureKey,
} from './src/moveFailMemory.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const OVERWORLD = 'overworld'
const NETHER = 'the_nether'

// The exact live loop: two body centres one step apart on z, four cycles.
const A = { x: 3.5, y: 67.0, z: 18.5 }
const B = { x: 3.5, y: 67.0, z: 17.69 }
const history = [A, B, A, B, A, B, A, B]
// The two MOVE candidates the loop re-selected, by their integer target cell.
const moveTo18 = { id: 'MOVE:p3_67_18', kind: 'MOVE', target: { x: 3, y: 67, z: 18 } }
const moveTo17 = { id: 'MOVE:p3_67_17', kind: 'MOVE', target: { x: 3, y: 67, z: 17 } }
const loopCandidates = [moveTo18, moveTo17]

// (a) one canonical identity: a body centre and its block cell are the same key --
check(
  'a body cell centre and its integer block cell share one blacklist key',
  moveFailureKey(OVERWORLD, A) === 'overworld:3,67,18' &&
    moveFailureKey(OVERWORLD, A) === moveFailureKey(OVERWORLD, { x: 3, y: 67, z: 18 }) &&
    moveFailureKey(OVERWORLD, B) === 'overworld:3,67,17' &&
    moveFailureKey(OVERWORLD, B) === moveFailureKey(OVERWORLD, { x: 3, y: 67, z: 17 }),
  `A=${moveFailureKey(OVERWORLD, A)} B=${moveFailureKey(OVERWORLD, B)}`,
)
check(
  'fractional positions use the block floor, not half-up rounding',
  moveFailureKey(OVERWORLD, { x: -31.5, y: 9.9, z: 33.5 }) === 'overworld:-32,9,33' &&
    moveFailureKey(OVERWORLD, { x: 39.1, y: 9.0, z: 33.5 }) === 'overworld:39,9,33',
  `neg=${moveFailureKey(OVERWORLD, { x: -31.5, y: 9.9, z: 33.5 })} pos=${moveFailureKey(OVERWORLD, { x: 39.1, y: 9.0, z: 33.5 })}`,
)

// (b) the live replay: detect the oscillation, run the controller's escape, and
// prove the candidate surface Jev sees is empty for the loop cells ---------------
let clock = 1_000
const escapeMemory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => clock })
const detected = detectOscillation(history)
check(
  'the live A/B body pair is detected as oscillation',
  detected.detected && detected.from !== null && detected.to !== null && detected.cycles >= 3,
  `detected=${detected.detected} cycles=${detected.cycles} from=${detected.from?.x},${detected.from?.z} to=${detected.to?.x},${detected.to?.z}`,
)
// This is what controller-legacy#detectMoveOscillation does with the detection.
if (detected.from !== null) escapeMemory.blacklist(OVERWORLD, detected.from, 'no_progress')
if (detected.to !== null) escapeMemory.blacklist(OVERWORLD, detected.to, 'no_progress')
const escaped = filterBlacklistedMoves(loopCandidates, escapeMemory, OVERWORLD)
check(
  'an oscillation skip removes the loop cells from the candidate surface',
  escaped.kept.length === 0 && escaped.skipped.length === 2,
  `kept=[${escaped.kept.map((c) => c.id).join(',')}] skipped=[${escaped.skipped.map((s) => s.key).join(',')}]`,
)

// (c) failure recording from a raw entity position hits the same cell ------------
const recordMemory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => clock })
recordMemory.record(OVERWORLD, A, 'stuck')
recordMemory.record(OVERWORLD, A, 'stuck')
recordMemory.record(OVERWORLD, A, 'stuck')
const recorded = filterBlacklistedMoves([moveTo18], recordMemory, OVERWORLD)
check(
  'attempts recorded from a body centre blacklist the integer candidate cell',
  recordMemory.isBlacklisted(OVERWORLD, { x: 3, y: 67, z: 18 }) && recorded.kept.length === 0,
  `isBlacklisted=${recordMemory.isBlacklisted(OVERWORLD, { x: 3, y: 67, z: 18 })} kept=${recorded.kept.length}`,
)

// (d) tracked candidate targets and body positions collapse onto ONE entry -------
// #360 §6 remembered the last/previous candidate targets as a compensation. With
// the canonical key they are the same cells as the detection, so the memory does
// not grow a second, unreachable namespace.
const dedupeMemory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => clock })
const trackedTargets = [
  { x: 3, y: 67, z: 17 },
  { x: 3, y: 67, z: 18 },
  ...(detected.from !== null ? [detected.from] : []),
  ...(detected.to !== null ? [detected.to] : []),
]
for (const position of trackedTargets) dedupeMemory.blacklist(OVERWORLD, position, 'no_progress')
check(
  'candidate targets and body positions share one key (no duplicate blacklist namespace)',
  dedupeMemory.size() === 2,
  `size=${dedupeMemory.size()} entries=${dedupeMemory.snapshot().map((e) => e.key).join(',')}`,
)

// (e) escalating cooldown semantics stay intact, and the target returns only when
// the cooldown expires or the invalidating evidence changes ----------------------
const escalating = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => clock })
const firstStrike = escalating.blacklist(OVERWORLD, A, 'no_progress')
const firstUntil = firstStrike.entry.blacklistedUntil
clock = firstUntil + 1
const secondStrike = escalating.blacklist(OVERWORLD, A, 'no_progress')
const secondUntil = secondStrike.entry.blacklistedUntil
check(
  'repeated oscillation escalates the cooldown (30s then 60s)',
  firstUntil === 1_000 + 30_000 && secondUntil === firstUntil + 1 + 60_000,
  `first=${firstUntil} second=${secondUntil}`,
)

// A later mechanical failure at the same cell is MORE evidence: it must not
// downgrade an active escalated escape cooldown back to the base window.
clock = 40_000
escalating.record(OVERWORLD, A, 'stuck')
check(
  'a later attempt failure cannot shorten an active escalated cooldown',
  escalating.check(OVERWORLD, A).blacklisted && escalating.snapshot()[0]!.blacklistedUntil === secondUntil,
  `until=${escalating.snapshot()[0]!.blacklistedUntil} expected=${secondUntil} blacklisted=${escalating.check(OVERWORLD, A).blacklisted}`,
)

const cooldownMemory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => clock })
cooldownMemory.blacklist(OVERWORLD, A, 'no_progress')
const during = filterBlacklistedMoves([moveTo18], cooldownMemory, OVERWORLD)
clock = cooldownMemory.snapshot()[0]!.blacklistedUntil + 1
const after = filterBlacklistedMoves([moveTo18], cooldownMemory, OVERWORLD)
check(
  'the skip holds during the cooldown and the target returns only after it expires',
  during.kept.length === 0 && after.kept.length === 1,
  `during=${during.kept.length} after=${after.kept.length}`,
)

// A verified reach (MOVE_FAILMEM_RESET reason=reached) is invalidating evidence
// and must release the cell immediately.
const reachedMemory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, now: () => clock })
reachedMemory.blacklist(OVERWORLD, A, 'no_progress')
const released = reachedMemory.reset(OVERWORLD, { x: 3, y: 67, z: 18 })
const afterReach = filterBlacklistedMoves([moveTo18], reachedMemory, OVERWORLD)
check(
  'a verified reach (reset) releases the canonical cell immediately',
  released && afterReach.kept.length === 1,
  `released=${released} kept=${afterReach.kept.length}`,
)

// (f) integer keys are unchanged and survive persistence round-trips ------------
const integerPos = { x: 39, y: 10, z: 34 }
const persisted = new MoveFailMemory({ failureLimit: 1, cooldownMs: 10_000, now: () => clock })
persisted.record(OVERWORLD, integerPos, 'unreachable')
const restored = new MoveFailMemory({
  failureLimit: 1,
  cooldownMs: 10_000,
  now: () => clock,
  initialEntries: persisted.snapshot().map((entry) => ({ ...entry, x: 39.4, y: 10, z: 34.4 })),
})
check(
  'integer/fractional persisted entries restore to the same canonical key',
  moveFailureKey(OVERWORLD, integerPos) === 'overworld:39,10,34' && restored.isBlacklisted(OVERWORLD, integerPos),
  `key=${moveFailureKey(OVERWORLD, integerPos)} restored=${restored.isBlacklisted(OVERWORLD, integerPos)}`,
)
check(
  'dimension scoping still separates the same cell across dimensions',
  moveFailureKey(OVERWORLD, integerPos) !== moveFailureKey(NETHER, integerPos),
  `over=${moveFailureKey(OVERWORLD, integerPos)} nether=${moveFailureKey(NETHER, integerPos)}`,
)

const TOTAL = 12
process.stdout.write(`\n${TOTAL - failures}/${TOTAL} move-blacklist-identity cases passed\n`)
process.exit(failures === 0 ? 0 : 1)
