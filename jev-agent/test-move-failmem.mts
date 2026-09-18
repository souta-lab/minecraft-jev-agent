// test-move-failmem.mts - issue #8 acceptance: durable coordinate failure memory
// + explicit oscillation detection for the movement layer.
//
// Run: npx tsx test-move-failmem.mts
import {
  detectOscillation,
  filterBlacklistedMoves,
  formatMoveFailMem,
  formatMoveFailMemReset,
  formatMoveTargetSkipped,
  formatOscillationDetected,
  MoveFailMemory,
  moveFailureKey,
} from './src/moveFailMemory.ts'
import { guardMoveFailureReason } from './src/controller.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const OVERWORLD = 'overworld'
const NETHER = 'the_nether'
const pos = { x: 39, y: 10, z: 34 }

// (a) repeated failures to one coordinate mark it and skip it after N attempts ----
let clock = 1_000
const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 10_000, maxEntries: 8, now: () => clock })
const first = memory.record(OVERWORLD, pos, 'unreachable')
const second = memory.record(OVERWORLD, pos, 'unreachable')
check(
  'before the limit the coordinate stays selectable',
  !first.blacklisted && !second.blacklisted && memory.check(OVERWORLD, pos).attempts === 2,
  `after2 blacklisted=${memory.check(OVERWORLD, pos).blacklisted} attempts=${memory.check(OVERWORLD, pos).attempts}`,
)
const third = memory.record(OVERWORLD, pos, 'stuck')
check(
  'after N failures the coordinate is marked and blacklisted',
  third.newlyBlacklisted && memory.isBlacklisted(OVERWORLD, pos),
  `newlyBlacklisted=${third.newlyBlacklisted} attempts=${third.entry.attempts}`,
)
const filtered = filterBlacklistedMoves(
  [
    { kind: 'MOVE', target: pos },
    { kind: 'WAIT', target: null },
  ],
  memory,
  OVERWORLD,
)
check(
  'a blacklisted MOVE is skipped while WAIT survives (caller must pick another target)',
  filtered.kept.length === 1 && filtered.kept[0]?.kind === 'WAIT' && filtered.skipped.length === 1,
  `kept=${filtered.kept.map((c) => c.kind).join(',')} skipped=${filtered.skipped.length}`,
)
check(
  'instrumentation line has the required shape',
  formatMoveFailMem(moveFailureKey(OVERWORLD, pos), third.entry.attempts, 'stuck') === 'MOVE_FAILMEM key=overworld:39,10,34 attempts=3 reason=stuck',
  formatMoveFailMem(moveFailureKey(OVERWORLD, pos), third.entry.attempts, 'stuck'),
)
check(
  'a guard-level NO_PATH charges tracked movement as unreachable',
  guardMoveFailureReason({ kind: 'MOVE' }, 'NO_PATH') === 'unreachable' &&
    guardMoveFailureReason({ kind: 'RETRIEVE' }, 'NO_PATH') === 'unreachable',
  `move=${guardMoveFailureReason({ kind: 'MOVE' }, 'NO_PATH')} retrieve=${guardMoveFailureReason({ kind: 'RETRIEVE' }, 'NO_PATH')}`,
)
check(
  'a guard-level NO_PATH does not charge non-movement actions',
  guardMoveFailureReason({ kind: 'MINE' }, 'NO_PATH') === null && guardMoveFailureReason({ kind: 'MOVE' }, 'OUT_OF_REACH') === null,
  `mine=${guardMoveFailureReason({ kind: 'MINE' }, 'NO_PATH')} outOfReach=${guardMoveFailureReason({ kind: 'MOVE' }, 'OUT_OF_REACH')}`,
)

// (b) an oscillating position pair triggers OSCILLATION_DETECTED and breaks the loop ---
const a = { x: 39.1, y: 9.0, z: 33.5 }
const b = { x: 39.1, y: 10.5, z: 34.3 }
const history = [a, b, a, b, a, b, a, b]
const detected = detectOscillation(history)
check(
  'the repeating A/B position pair is detected as oscillation',
  detected.detected && detected.cycles >= 3 && detected.from !== null && detected.to !== null,
  `detected=${detected.detected} cycles=${detected.cycles}`,
)
const oscillationLine =
  detected.from !== null && detected.to !== null
    ? formatOscillationDetected(detected.from, detected.to, detected.cycles, 'blacklist')
    : ''
check(
  'OSCILLATION_DETECTED names both positions, cycles and the escape action',
  oscillationLine.startsWith('OSCILLATION_DETECTED from=39.1,9,33.5 to=39.1,10.5,34.3 cycles=') && oscillationLine.endsWith('action=blacklist'),
  oscillationLine,
)
check(
  'a monotone walk is NOT flagged as oscillation',
  !detectOscillation([a, b, { x: 41, y: 12, z: 36 }, { x: 44, y: 14, z: 39 }]).detected,
  'straight history not flagged',
)
const escapeMemory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 10_000, now: () => clock })
escapeMemory.blacklist(OVERWORLD, pos, 'no_progress')
const escaped = filterBlacklistedMoves(
  [
    { kind: 'RETRIEVE', target: pos },
    { kind: 'MOVE', target: { x: 41, y: 10, z: 34 } },
  ],
  escapeMemory,
  OVERWORLD,
)
check(
  'blacklisting the cause forces a different target in the same cycle',
  escaped.kept.length === 1 && escaped.kept[0]?.target?.x === 41 && escaped.skipped.length === 1,
  `kept=${escaped.kept.length} skipped=${escaped.skipped.map((s) => s.key).join(',')}`,
)

// (c) success resets the entry ----------------------------------------------------
const wasBlacklisted = memory.isBlacklisted(OVERWORLD, pos)
const hadEntry = memory.reset(OVERWORLD, pos)
check(
  'a reach resets the coordinate memory (MOVE_FAILMEM_RESET reason=reached)',
  wasBlacklisted && hadEntry && !memory.check(OVERWORLD, pos).known,
  formatMoveFailMemReset(moveFailureKey(OVERWORLD, pos)),
)

// (d) cooldown expiry makes the target selectable again ---------------------------
let cooldownClock = 5_000
const cooldownMemory = new MoveFailMemory({ failureLimit: 2, cooldownMs: 5_000, now: () => cooldownClock })
cooldownMemory.record(OVERWORLD, pos, 'stuck')
cooldownMemory.record(OVERWORLD, pos, 'stuck')
const duringCooldown = cooldownMemory.check(OVERWORLD, pos)
cooldownClock = 10_001
const afterCooldown = cooldownMemory.check(OVERWORLD, pos)
check(
  'blacklisted during cooldown, selectable after it expires',
  duringCooldown.blacklisted && duringCooldown.cooldownRemainingMs > 0 && !afterCooldown.blacklisted,
  `during=${duringCooldown.blacklisted} remaining=${duringCooldown.cooldownRemainingMs} after=${afterCooldown.blacklisted}`,
)

// (e) dimension scoping is respected ----------------------------------------------
const scopedMemory = new MoveFailMemory({ failureLimit: 1, cooldownMs: 10_000, now: () => clock })
scopedMemory.record(OVERWORLD, pos, 'unreachable')
check(
  'the overworld key does not blacklist the same coordinate in the nether',
  scopedMemory.isBlacklisted(OVERWORLD, pos) &&
    !scopedMemory.isBlacklisted(NETHER, pos) &&
    moveFailureKey(OVERWORLD, pos) !== moveFailureKey(NETHER, pos),
  `over=${moveFailureKey(OVERWORLD, pos)} nether=${moveFailureKey(NETHER, pos)}`,
)

// (f) bounded memory evicts the least-failed / oldest ------------------------------
const bounded = new MoveFailMemory({ failureLimit: 1, cooldownMs: 1_000, maxEntries: 3, now: () => clock })
bounded.record(OVERWORLD, { x: 0, y: 0, z: 0 }, 'no_path')
bounded.record(OVERWORLD, { x: 1, y: 0, z: 0 }, 'no_path')
bounded.record(OVERWORLD, { x: 2, y: 0, z: 0 }, 'no_path')
// x=2 becomes the most-failed entry, then a new coordinate arrives.
bounded.record(OVERWORLD, { x: 2, y: 0, z: 0 }, 'no_path')
const beforeEvict = bounded.size()
bounded.record(OVERWORLD, { x: 3, y: 0, z: 0 }, 'no_path')
const entries = bounded.snapshot()
const hasMostFailed = entries.some((entry) => entry.x === 2 && entry.attempts >= 2)
const evictedOldest = !entries.some((entry) => entry.x === 0)
check(
  'memory is bounded and evicts the least-failed/oldest, keeping the repeat offender',
  beforeEvict === 3 && bounded.size() === 3 && hasMostFailed && evictedOldest,
  `size=${bounded.size()} entries=${entries.map((entry) => `x${entry.x}:${entry.attempts}`).join(',')}`,
)
check(
  'MOVE_TARGET_SKIPPED reports attempts and cooldown seconds',
  formatMoveTargetSkipped('overworld:39,10,34', 3, 30) === 'MOVE_TARGET_SKIPPED key=overworld:39,10,34 attempts=3 cooldown=30',
  formatMoveTargetSkipped('overworld:39,10,34', 3, 30),
)

process.stdout.write(`\n${15 - failures}/15 move-failmem cases passed\n`)
process.exit(failures === 0 ? 0 : 1)
