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
import { deathZoneEscapeCandidates, defaultCandidateOptions, isDeathZoneEscapeRoute } from './src/candidates.ts'
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

// ---------------------------------------------------------------------------
// (ii) THE GATE SEAM: refused exits must not count as locomotion at generation
//      time, or the sealed-pocket escape arm stays gated off forever while the
//      body has no real route. Producer-side suppression keeps the accounting
//      honest: an always-blocked exit was never a route.
// ---------------------------------------------------------------------------

function inZoneState(failedCandidates: Record<string, number>): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: {
      username: 'AI_TEST',
      position: { ...BODY },
      eyePosition: { x: BODY.x, y: BODY.y + 1.62, z: BODY.z },
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 20,
      food: 20,
      gameMode: 'survival',
      dimension: DIM,
      isDay: true,
      heldItem: null,
    },
    inventory: { slots: [], counts: {}, totalItems: 0 },
    entities: [],
    blocks: [],
    terrain: {
      standable: [],
      escapeCells: [
        { x: -3, y: 57, z: 17 },
        { x: -4, y: 57, z: 17 },
        { x: -5, y: 57, z: 17 },
        { x: -6, y: 57, z: 17 },
      ],
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: 'explore:explore:1',
      description: 'explore',
      targetItem: null,
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 60_000,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates,
      knownResources: [],
      exploredCells: [],
    },
  } as unknown as WorldState
}

const dzOptions = {
  ...defaultCandidateOptions,
  // The body's own cell is in the death zone; the exit cells are outside it.
  blacklistedMoveTargets: (_dim: string, pos: Vec3Json) => Math.hypot(pos.x - BODY.x, pos.y - BODY.y, pos.z - BODY.z) <= 14,
  reach: 8,
}

addCase('uncharged dangerzone exits are offered normally (baseline)', () => {
  const offered = deathZoneEscapeCandidates(inZoneState({}), dzOptions)
  const ids = offered.map((candidate) => candidate.id)
  return {
    pass: ids.length === 3 && ids[0] === 'MOVE:dangerzone:p-3_57_17',
    detail: `offered=[${ids.join(' ')}]`,
  }
})

addCase('a failure-memorised exit is withheld at generation; farther exits stay offered', () => {
  const offered = deathZoneEscapeCandidates(
    inZoneState({ 'MOVE:dangerzone:p-3_57_17': 6 }),
    dzOptions,
  )
  const ids = offered.map((candidate) => candidate.id)
  const suppressed = !ids.includes('MOVE:dangerzone:p-3_57_17')
  return {
    pass: suppressed && ids.length === 3 && ids.includes('MOVE:dangerzone:p-6_57_17'),
    detail: `offered=[${ids.join(' ')}] suppressed=${suppressed}`,
  }
})

addCase('all refused exits empty the generation-time envelope (ungates sealed-pocket escape arm)', () => {
  const offered = deathZoneEscapeCandidates(
    inZoneState({
      'MOVE:dangerzone:p-3_57_17': 6,
      'MOVE:dangerzone:p-4_57_17': 6,
      'MOVE:dangerzone:p-5_57_17': 6,
      'MOVE:dangerzone:p-6_57_17': 6,
    }),
    dzOptions,
  )
  return {
    pass: offered.length === 0,
    detail: `offered=[${offered.map((candidate) => candidate.id).join(' ')}]`,
  }
})

// ---------------------------------------------------------------------------
// (iii) THE SURVIVAL SEAM: the sealed-pocket escape ascent is the survival
//       route. A contact-range hostile strips every MOVE that is not a
//       recognized escape, so the arm's only offer must be recognized.
// ---------------------------------------------------------------------------

addCase('a sealed-pocket escape ascent counts as a survival escape route under threat', () => {
  const escape = {
    id: 'ASCEND:escape:p5_57_-9',
    kind: 'MOVE' as Candidate['kind'],
    meta: { escapeAscent: true },
  } as unknown as Candidate
  const ordinary = {
    id: 'MOVE:p5_57_-10',
    kind: 'MOVE' as Candidate['kind'],
    meta: {},
  } as unknown as Candidate
  const dangerzone = {
    id: 'MOVE:dangerzone:p-3_57_17',
    kind: 'MOVE' as Candidate['kind'],
    meta: {},
  } as unknown as Candidate
  return {
    pass:
      isDeathZoneEscapeRoute(escape) === true &&
      isDeathZoneEscapeRoute(ordinary) === false &&
      isDeathZoneEscapeRoute(dangerzone) === true,
    detail: `escape=${isDeathZoneEscapeRoute(escape)} ordinary=${isDeathZoneEscapeRoute(ordinary)} dangerzone=${isDeathZoneEscapeRoute(dangerzone)}`,
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
