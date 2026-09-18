// test-pit-escape.mts - M2 pit-escape regression.
//
// Reproduces the live loop: the bot is at the bottom of a 1-block pit (feet y=9,
// rim standable at y=10) whose remembered targets all sit above it. The agent
// kept re-selecting a MOVE whose hop failed (JUMP_FAIL) because a
// `done/verified=false` MOVE that wandered >=0.5m reset its own blacklist.
//
//   npm run pit-escape-test
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { classifyMoveOutcome } from './src/controller.ts'
import { formatMoveTargetSkipped, filterBlacklistedMoves, MoveFailMemory, moveFailureKey } from './src/moveFailMemory.ts'
import { evaluateHop, hopHoldsForward, planClimbManeuver } from './src/executor.ts'
import { classifyHeadroomBlocker, formatPillarRefused, selectPillarFallbackColumn } from './src/verticalPlan.ts'
import type { PillarColumnProbe } from './src/verticalPlan.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const OVERWORLD = 'overworld'

// The 1-block pit: feet y=9 on the pit floor; every neighbour column rises one
// block, so the only way out is a 1-block climb onto the rim (feet y=10).
const PIT_FEET: Vec3Json = { x: 39.5, y: 9, z: 33.5 }
const RIM_SPOTS: Vec3Json[] = [
  { x: 41, y: 10, z: 33 },
  { x: 39, y: 10, z: 31 },
  { x: 39, y: 10, z: 35 },
  { x: 37, y: 10, z: 33 },
]

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M2PIT',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: OVERWORLD,
    isDay: true,
    heldItem: null,
  }
}

function inventory(): InventoryState {
  return { slots: [], counts: {}, totalItems: 0 }
}

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
    ...overrides,
  }
}

function goal(): GoalState {
  return {
    id: 'collect:diamond',
    description: 'collect 1 x diamond',
    targetItem: 'diamond',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(): QueuedGoal {
  return {
    id: 'g1:collect:diamond',
    kind: 'collect',
    description: 'collect 1 x diamond',
    targetItem: 'diamond',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function pitWorldState(): WorldState {
  return {
    schemaVersion: 1,
    tick: 42,
    timestampMs: 1_700_000_000_000,
    self: self(PIT_FEET),
    inventory: inventory(),
    entities: [],
    blocks: [],
    terrain: { standable: [PIT_FEET, ...RIM_SPOTS] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(),
    goalQueue: queueWith(queuedGoal()),
    recentEvents: [],
    signals: signals(),
  }
}

function movementCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) =>
    candidate.kind === 'MOVE' || candidate.kind === 'RETRIEVE' || candidate.kind === 'RETREAT' || candidate.kind === 'STEP',
  )
}

function pitEscapeCandidate(candidates: readonly Candidate[]): Candidate | null {
  return movementCandidates(candidates).find((candidate) => candidate.target !== null && candidate.target.y > PIT_FEET.y) ?? null
}

addCase('the 1-block pit offers a climb-out MOVE to the rim at feet+1 (productive escape exists)', () => {
  const candidates = generateCandidates(pitWorldState(), defaultCandidateOptions)
  const escape = pitEscapeCandidate(candidates)
  const pass = escape !== null && escape.kind === 'MOVE' && escape.target?.y === PIT_FEET.y + 1
  return {
    pass,
    detail: `escape=${escape?.id ?? 'none'} target=${escape?.target === null ? 'null' : JSON.stringify(escape?.target)} all=[${candidates.map((c) => c.id).join(',')}]`,
  }
})

addCase('a body in terrain contact plans the forward-released vertical hop (never a blocked jump)', () => {
  const pinned = planClimbManeuver({
    climbDetected: true,
    onGround: true,
    pinned: true,
    faceAtFeet: true,
    standingStill: false,
  })
  const faceContact = planClimbManeuver({
    climbDetected: true,
    onGround: true,
    pinned: false,
    faceAtFeet: true,
    standingStill: false,
  })
  const pass = pinned === 'vertical-hop' && faceContact === 'vertical-hop'
  return { pass, detail: `pinned=${pinned} faceContact=${faceContact}` }
})

addCase('a free approach jumps pre-contact while forward is unblocked', () => {
  const maneuver = planClimbManeuver({
    climbDetected: true,
    onGround: true,
    pinned: false,
    faceAtFeet: false,
    standingStill: false,
  })
  const airborne = planClimbManeuver({
    climbDetected: true,
    onGround: false,
    pinned: false,
    faceAtFeet: false,
    standingStill: false,
  })
  const pass = maneuver === 'pre-contact-jump' && airborne === 'continue'
  return { pass, detail: `grounded=${maneuver} airborne=${airborne}` }
})

addCase('the vertical hop holds forward when the body is free and releases it when pinned', () => {
  const free = hopHoldsForward(false)
  const pinned = hopHoldsForward(true)
  const pass = free === true && pinned === false
  return { pass, detail: `pinned=false -> forward=${free}; pinned=true -> forward=${pinned}` }
})

addCase('a hop rising dy >= 0.75 emits the JUMP_ESCAPE marker (the released-forward hop cannot)', () => {
  const before = { x: 40.55, y: 8, z: 31.95 }
  const node = { x: 42, y: 10, z: 33 }
  // Live pre-fix rises with forward held: 1.12 / 1.17 / 1.18 / 1.20.
  const hopOutcomes = [1.12, 1.17, 1.18, 1.2].map((rise) =>
    evaluateHop(before, { x: 40.32, y: before.y + rise, z: 31.84 }, node),
  )
  const escaped = hopOutcomes.every(
    (hop) =>
      hop.hopOk &&
      hop.dy >= 0.75 &&
      hop.escapeMarker !== null &&
      hop.escapeMarker.startsWith('JUMP_ESCAPE rise=') &&
      hop.escapeMarker.includes('from=(40.55,8,31.95)') &&
      hop.escapeMarker.includes('target=(42,10,33)'),
  )
  // The regression: the released-forward hop ends where it started (dy=0) and
  // this target node is outside the occupied window -> no JUMP_ESCAPE.
  const released = evaluateHop(before, { ...before }, node)
  // The unchanged `|| occupiedTarget` arm: a hop landing on the node still escapes.
  const settled = evaluateHop(before, { x: 40.6, y: 8, z: 32.2 }, { x: 40, y: 9, z: 32 })
  const pass =
    escaped &&
    released.dy === 0 &&
    !released.hopOk &&
    released.escapeMarker === null &&
    settled.hopOk &&
    settled.escapeMarker !== null
  return {
    pass,
    detail: `rise=1.12 -> ${hopOutcomes[0]?.escapeMarker ?? 'none'}; released-forward -> ok=${released.hopOk} marker=${released.escapeMarker ?? 'none'}; occupiedTarget -> ok=${settled.hopOk}`,
  }
})

addCase('an unverified MOVE that wandered 1.66m is never an arrival (classifier)', () => {
  const unverifiedWander = classifyMoveOutcome(false, 1.66)
  const verifiedWander = classifyMoveOutcome(true, 1.66)
  const verifiedNoProgress = classifyMoveOutcome(true, 0.2)
  const pass = unverifiedWander === 'unverified' && verifiedWander === 'arrived' && verifiedNoProgress === 'no-progress'
  return {
    pass,
    detail: `unverified=${unverifiedWander} verified=${verifiedWander} tiny=${verifiedNoProgress}`,
  }
})

addCase('repeated JUMP_FAIL outcomes blacklist the MOVE target within the bounded limit', () => {
  let clock = 1_000
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => clock })
  const candidates = generateCandidates(pitWorldState(), defaultCandidateOptions)
  const escape = pitEscapeCandidate(candidates)
  if (escape === null || escape.target === null) return { pass: false, detail: 'no escape candidate' }
  const target = escape.target
  let blacklistedOnCycle = -1
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const outcome = classifyMoveOutcome(false, 1.66)
    if (outcome === 'arrived') memory.reset(OVERWORLD, target)
    else memory.record(OVERWORLD, target, 'no_progress')
    if (blacklistedOnCycle < 0 && memory.check(OVERWORLD, target).blacklisted) blacklistedOnCycle = cycle
  }
  const check = memory.check(OVERWORLD, target)
  const filtered = filterBlacklistedMoves(candidates, memory, OVERWORLD)
  const skipped = filtered.skipped.find((entry) => entry.candidate.id === escape.id)
  const reselected = filtered.kept.some((candidate) => candidate.id === escape.id)
  const pass =
    blacklistedOnCycle === 3 &&
    check.blacklisted &&
    check.cooldownRemainingMs > 0 &&
    skipped !== undefined &&
    !reselected
  return {
    pass,
    detail: `blacklistedOn=${blacklistedOnCycle} attempts=${check.attempts} cooldown=${check.cooldownRemainingMs} skipped=${skipped?.key ?? 'no'} reselected=${reselected}`,
  }
})

addCase('the blacklist cooldown is bounded: the same target is selectable again after it expires', () => {
  let clock = 5_000
  const memory = new MoveFailMemory({ failureLimit: 2, cooldownMs: 30_000, now: () => clock })
  const target = { x: 39, y: 9, z: 33 }
  memory.record(OVERWORLD, target, 'no_progress')
  memory.record(OVERWORLD, target, 'no_progress')
  const during = memory.check(OVERWORLD, target)
  clock = 35_001
  const after = memory.check(OVERWORLD, target)
  const pass = during.blacklisted && during.cooldownRemainingMs > 0 && !after.blacklisted
  return {
    pass,
    detail: `during=${during.blacklisted} remaining=${during.cooldownRemainingMs} after=${after.blacklisted}`,
  }
})

addCase('the live pit coordinate produces the MOVE_TARGET_SKIPPED marker with its cooldown', () => {
  const target = { x: 39, y: 9, z: 33 }
  const key = moveFailureKey(OVERWORLD, target)
  const line = formatMoveTargetSkipped(key, 3, 30)
  const pass =
    key === 'overworld:39,9,33' &&
    line === 'MOVE_TARGET_SKIPPED key=overworld:39,9,33 attempts=3 cooldown=30'
  return { pass, detail: line }
})

addCase('a pit with no standable rim spot yields no escape MOVE (nothing to climb toward)', () => {
  const blocked: WorldState = { ...pitWorldState(), terrain: { standable: [PIT_FEET] } }
  const candidates = generateCandidates(blocked, defaultCandidateOptions)
  const pass = pitEscapeCandidate(candidates) === null
  return { pass, detail: `escape=none moves=[${movementCandidates(candidates).map((c) => c.id).join(',')}] candidates=[${candidates.map((c) => c.id).join(',')}]` }
})

addCase('a ceiling-capped pocket column refuses with the marker and offers the adjacent open pillar column', () => {
  // Live pocket: feet (40,8,31), cobblestone ceiling at (40,9,31), no pickaxe;
  // (40,8,32) is the open neighbour the pillar must relocate to.
  const feet = { x: 40, y: 8, z: 31 }
  const decision = classifyHeadroomBlocker({
    cell: { x: 40, y: 9, z: 31 },
    name: 'cobblestone',
    diggable: true,
    fluidOrHazard: false,
    floodRisk: false,
    toolOk: false,
  })
  const marker =
    decision.kind === 'refuse'
      ? formatPillarRefused({ reason: 'no_headroom', cell: feet, obstacle: decision.obstacle, cause: decision.reason })
      : 'not-refused'
  const probes: PillarColumnProbe[] = [
    { cell: { x: 40, y: 8, z: 32 }, supported: true, feetClear: true, headClear: true, aboveHeadClear: true, unsafe: false },
    { cell: { x: 39, y: 9, z: 32 }, supported: true, feetClear: true, headClear: true, aboveHeadClear: true, unsafe: false },
  ]
  const fallback = selectPillarFallbackColumn(probes, feet)
  const pass =
    decision.kind === 'refuse' &&
    decision.reason === 'needs_tool' &&
    marker.startsWith('PILLAR_REFUSED reason=no_headroom cell=40,8,31 obstacle=cobblestone@40,9,31') &&
    fallback?.x === 40 &&
    fallback?.y === 8 &&
    fallback?.z === 32
  return {
    pass,
    detail: `decision=${decision.kind}${decision.kind === 'refuse' ? `/${decision.reason}` : ''} fallback=${fallback === null ? 'none' : `${fallback.x},${fallback.y},${fallback.z}`} marker=${marker}`,
  }
})

let failures = 0
process.stdout.write('M2 pit escape - 1-block climb + JUMP_FAIL suppression\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} pit-escape cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
