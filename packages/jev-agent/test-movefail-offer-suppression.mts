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
import { regroundVanishedSurvivalChoice } from './src/threat.ts'
import type { OutcomeLedgersHost } from './src/outcome-ledgers.ts'
import { MoveFailMemory, deathZoneMoveBlacklist, moveFailureKey } from './src/moveFailMemory.ts'
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

// ---------------------------------------------------------------------------
// (iv) THE REGROUND SEAM: a stale survival escape re-grounds by its stable
//      body-cell id; MOVE is a survival kind only for escape routes.
// ---------------------------------------------------------------------------

addCase('a stale sealed-pocket escape re-grounds to the same id in the fresh offer', () => {
  const chosen = { id: 'ASCEND:escape:p5_57_-9', kind: 'MOVE', meta: { escapeAscent: true } }
  const fresh = [
    { id: 'ESCALATE', kind: 'ESCALATE' },
    { id: 'ASCEND:escape:p5_57_-9', kind: 'MOVE', meta: { escapeAscent: true } },
  ]
  const reground = regroundVanishedSurvivalChoice(chosen, fresh)
  return {
    pass:
      reground.candidateId === 'ASCEND:escape:p5_57_-9' &&
      reground.kind === 'MOVE' &&
      reground.reason === 'same_escape_route' &&
      reground.outcome === 'REGROUNDED',
    detail: `candidateId=${reground.candidateId} kind=${reground.kind} reason=${reground.reason} outcome=${reground.outcome}`,
  }
})

addCase('an ordinary MOVE still is not a survival action', () => {
  const reground = regroundVanishedSurvivalChoice(
    { id: 'MOVE:p5_57_-10', kind: 'MOVE', meta: {} },
    [{ id: 'MOVE:p5_57_-10', kind: 'MOVE', meta: {} }],
  )
  return {
    pass: reground.candidateId === null && reground.outcome === 'NOT_A_SURVIVAL_ACTION',
    detail: `candidateId=${reground.candidateId} outcome=${reground.outcome}`,
  }
})

addCase('a vanished escape with no fresh offer ends CAPABILITY_LOST, not silent', () => {
  const reground = regroundVanishedSurvivalChoice(
    { id: 'ASCEND:escape:p5_57_-9', kind: 'MOVE', meta: { escapeAscent: true } },
    [{ id: 'ESCALATE', kind: 'ESCALATE' }],
  )
  return {
    pass: reground.candidateId === null && reground.kind === 'MOVE' && reground.outcome === 'CAPABILITY_LOST',
    detail: `candidateId=${reground.candidateId} kind=${reground.kind} outcome=${reground.outcome}`,
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
// (v) THE IN-ZONE SEAM: a death zone that contains the body must not withhold
//     the egress steps out of it. Measured live portal-p23 run-mutsv43u-1a0g
//     (2026-10-04T19:0xZ): ~50+ recorded deaths within 14 m of every respawn
//     scatter point; the radius-16 escape scan sat entirely inside the union,
//     `SURVIVAL_ESCAPE_NONE reason=no_grounded_escape` repeated for seven
//     contact deaths while zombie 55683 + drowned 55113 held the spawn. The
//     blacklist is anti-ENTRY from outside; inside it is egress-descent.
// ---------------------------------------------------------------------------

// Hazards concentrated on BODY's +x side so density descends strictly toward
// -x: density(BODY)=3, deeper cell (9,-9)=3, egress cells progressively less.
const CAMP_HAZARDS = [
  { x: 5, y: 57, z: -9, count: 1 },
  { x: 12, y: 57, z: -9, count: 1 },
  { x: 19, y: 57, z: -9, count: 1 },
]

addCase('an out-of-zone body keeps pure anti-entry semantics', () => {
  const outside = { x: 5.4, y: 57.9, z: -40 }
  const blacklist = deathZoneMoveBlacklist(CAMP_HAZARDS, outside, DIM)
  const inZone = { x: 5, y: 57, z: -9 }
  const free = { x: 5.4, y: 57, z: -41 }
  return {
    pass: blacklist(DIM, inZone) === true && blacklist(DIM, free) === false,
    detail: `inZone=${blacklist(DIM, inZone)} free=${blacklist(DIM, free)}`,
  }
})

addCase('an in-zone body keeps deeper/lateral cells withheld but egress cells open', () => {
  const blacklist = deathZoneMoveBlacklist(CAMP_HAZARDS, BODY, DIM)
  const deeperA = { x: 9, y: 57, z: -9 }
  const deeperB = { x: 15, y: 57, z: -9 }
  const egressNear = { x: 1, y: 57, z: -9 }
  const egressFar = { x: -7, y: 57, z: -9 }
  const out = { x: 5.4, y: 57, z: -40 }
  const results = [
    blacklist(DIM, deeperA),
    blacklist(DIM, deeperB),
    blacklist(DIM, egressNear),
    blacklist(DIM, egressFar),
    blacklist(DIM, out),
  ]
  return {
    pass: results[0] === true && results[1] === true && results[2] === false && results[3] === false && results[4] === false,
    detail: `deeperA=${results[0]} deeperB=${results[1]} egressNear=${results[2]} egressFar=${results[3]} out=${results[4]}`,
  }
})

addCase('death-zone exits ground density-descent cells the uniform zone withheld', () => {
  const camped = inZoneState({})
  camped.terrain.escapeCells = [
    { x: 9, y: 57, z: -9 },
    { x: 1, y: 57, z: -9 },
    { x: -3, y: 57, z: -9 },
    { x: -7, y: 57, z: -9 },
  ]
  const offered = deathZoneEscapeCandidates(camped, {
    ...defaultCandidateOptions,
    blacklistedMoveTargets: deathZoneMoveBlacklist(CAMP_HAZARDS, BODY, DIM),
    reach: 8,
  })
  const ids = offered.map((candidate) => candidate.id)
  return {
    pass:
      ids.length === 3 &&
      !ids.includes('MOVE:dangerzone:p9_57_-9') &&
      ids.includes('MOVE:dangerzone:p1_57_-9') &&
      ids.includes('MOVE:dangerzone:p-3_57_-9') &&
      ids.includes('MOVE:dangerzone:p-7_57_-9'),
    detail: `offered=[${ids.join(' ')}]`,
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
