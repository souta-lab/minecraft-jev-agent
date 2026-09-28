// test-movefail-offer-suppression.mts - the consume side of the coordinate
// failure memory must actually filter the offered set.
//
// THE MEASURED LIVE SHAPE (portal-p19.5, run-mul5t8tp-93bb, gen-mul7bf6o):
//
//   [guard] REJECTED MOVE:dangerzone:p-3_57_17 code=NO_PATH :: no canDig=false
//     path to (-3,57,17) (GoalBlock probe)
//   MOVE_FAILMEM key=overworld:-3,57,17 attempts=261 reason=no_path
//   SKILL_OUTCOME_PACKET ... terminalReason=blocked progress=none
//
//   -> 261 consecutive NO_PATH charges on ONE death-zone exit cell while the
//      parked body re-committed it every decision epoch. `filterBlacklistedMoves`
//      was orphaned by the pre-V4.1.2 selector cleanup (13df8d77), so the memory
//      was written and persisted but never consumed. With actionable=3 the
//      starvation bound could never accrue, `blocked` carries progress=none so
//      the strategic-stall window never fills, and NO_PATH is deliberately
//      excluded from same_failure_3x: a permanent wedge shape.
//
// The restored filterMoveCandidates wrapper rebinds the write side
// (MOVE_FAILMEM / path-scoped NO_PATH) to the offer set: a target the world
// has mechanically refused stops being offered, which is the CAN fact - never
// a semantic choice of what replaces it.
//
//   bun ./test-movefail-offer-suppression.mts
import {
  filterMoveCandidates,
  movePathFailureScope,
} from './src/outcome-ledgers.ts'
import type { OutcomeLedgersHost } from './src/outcome-ledgers.ts'
import { MoveFailMemory, moveFailureKey } from './src/moveFailMemory.ts'
import type { Candidate } from './src/candidates.ts'
import type { Vec3Json, WorldState } from './src/state.ts'
import type { Bot } from 'mineflayer'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}
const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const BODY: Vec3Json = { x: 5.4, y: 57.9, z: -8.7 }
const DIM = 'overworld'

const logged: string[] = []
const host = {
  moveFailMemory: new MoveFailMemory({ now: () => 1_000_000 }),
  movePathFailureGenerationId: 'gen-test',
  scheduler: { worldRevision: 3 },
  bot: { entity: { position: { ...BODY } } } as unknown as Bot,
  logger: {
    info: (_cat: string, line: string) => {
      logged.push(line)
    },
    warn: (_cat: string, line: string) => {
      logged.push(line)
    },
  },
  tickCounter: 1,
} as unknown as OutcomeLedgersHost

const state = {
  self: { dimension: DIM, position: { ...BODY } },
} as unknown as WorldState

function moveCandidate(id: string, target: Vec3Json): Candidate {
  return {
    id,
    kind: 'MOVE',
    label: `move to ${target.x},${target.y},${target.z}`,
    targetName: null,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

function waitCandidate(): Candidate {
  return {
    id: 'WAIT',
    kind: 'WAIT',
    label: 'wait',
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

// ---------------------------------------------------------------------------
// (i) THE MEASURED SHAPE: repeated NO_PATH on one death-zone exit suppresses
//     exactly that offer while a fresh exit stays offerable.
// ---------------------------------------------------------------------------

addCase('path-scoped NO_PATH suppresses the refused exit target on the same body cell', () => {
  host.moveFailMemory = new MoveFailMemory({ now: () => 1_000_000 })
  logged.length = 0
  const refused = { x: -3, y: 57, z: 17 }
  const scope = movePathFailureScope(host, state)
  if (scope === null) return { pass: false, detail: 'path failure scope unavailable' }
  host.moveFailMemory.recordPathFailure(DIM, refused, scope)
  const offer = [
    moveCandidate('MOVE:dangerzone:p-3_57_17', refused),
    moveCandidate('MOVE:dangerzone:p-4_57_17', { x: -4, y: 57, z: 17 }),
    waitCandidate(),
  ]
  const kept = filterMoveCandidates(host, offer, state)
  const ids = kept.map((candidate) => candidate.id)
  const suppressed = !ids.includes('MOVE:dangerzone:p-3_57_17')
  const othersKept = ids.includes('MOVE:dangerzone:p-4_57_17') && ids.includes('WAIT')
  return {
    pass: suppressed && othersKept,
    detail: `kept=[${ids.join(' ')}] suppressed=${suppressed} othersKept=${othersKept}`,
  }
})

addCase('cooldown blacklist suppresses a target after the failure limit', () => {
  host.moveFailMemory = new MoveFailMemory({ now: () => 1_000_000 })
  const target = { x: -5, y: 57, z: 17 }
  for (let i = 0; i < 3; i += 1) host.moveFailMemory.record(DIM, target, 'stuck')
  const offer = [moveCandidate('MOVE:dangerzone:p-5_57_17', target), waitCandidate()]
  const kept = filterMoveCandidates(host, offer, state)
  const ids = kept.map((candidate) => candidate.id)
  return {
    pass: !ids.includes('MOVE:dangerzone:p-5_57_17') && ids.includes('WAIT'),
    detail: `kept=[${ids.join(' ')}]`,
  }
})

addCase('a different body cell or world revision releases the path-scoped refusal', () => {
  host.moveFailMemory = new MoveFailMemory({ now: () => 1_000_000 })
  const refused = { x: -3, y: 57, z: 17 }
  const scope = movePathFailureScope(host, state)
  if (scope === null) return { pass: false, detail: 'path failure scope unavailable' }
  host.moveFailMemory.recordPathFailure(DIM, refused, scope)
  const moved = {
    self: { dimension: DIM, position: { x: 40.5, y: 62.0, z: 30.5 } },
  } as unknown as WorldState
  const movedHost = {
    ...host,
    bot: { entity: { position: { x: 40.5, y: 62.0, z: 30.5 } } } as unknown as Bot,
  } as unknown as OutcomeLedgersHost
  const offer = [moveCandidate('MOVE:dangerzone:p-3_57_17', refused)]
  const kept = filterMoveCandidates(movedHost, offer, moved)
  return {
    pass: kept.length === 1,
    detail: `kept=${kept.length} (scope changed -> path refusal released)`,
  }
})

addCase('all refused dangerzone exits empty the move envelope; control candidates survive', () => {
  host.moveFailMemory = new MoveFailMemory({ now: () => 1_000_000 })
  const scope = movePathFailureScope(host, state)
  if (scope === null) return { pass: false, detail: 'path failure scope unavailable' }
  const exits = [
    { x: -3, y: 57, z: 17 },
    { x: -4, y: 57, z: 17 },
    { x: -5, y: 57, z: 17 },
  ]
  for (const cell of exits) host.moveFailMemory.recordPathFailure(DIM, cell, scope)
  const offer = [
    ...exits.map((cell, i) => moveCandidate(`MOVE:dangerzone:p${cell.x}_${cell.y}_${cell.z}`, cell)),
    waitCandidate(),
  ]
  const kept = filterMoveCandidates(host, offer, state)
  const ids = kept.map((candidate) => candidate.id)
  const movesLeft = ids.filter((id) => id.startsWith('MOVE:'))
  return {
    pass: movesLeft.length === 0 && ids.includes('WAIT'),
    detail: `moves_left=[${movesLeft.join(' ')}] kept=[${ids.join(' ')}]`,
  }
})

addCase('MOVE_TARGET_SKIPPED is logged once per suppressed candidate', () => {
  host.moveFailMemory = new MoveFailMemory({ now: () => 1_000_000 })
  logged.length = 0
  const target = { x: -3, y: 57, z: 17 }
  for (let i = 0; i < 3; i += 1) host.moveFailMemory.record(DIM, target, 'stuck')
  filterMoveCandidates(host, [moveCandidate('MOVE:p-3_57_17', target)], state)
  const skipLine = logged.find((line) => line.includes('MOVE_TARGET_SKIPPED'))
  const expectedKey = moveFailureKey(DIM, target)
  return {
    pass: skipLine !== undefined && skipLine.includes(expectedKey),
    detail: `line=${skipLine ?? '[none]'} expectedKey=${expectedKey}`,
  }
})

// ---------------------------------------------------------------------------

let failed = 0
for (const entry of cases) {
  const result = entry.run()
  if (result.pass) {
    console.log(`PASS ${entry.name}`)
  } else {
    failed += 1
    console.log(`FAIL ${entry.name} :: ${result.detail}`)
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
