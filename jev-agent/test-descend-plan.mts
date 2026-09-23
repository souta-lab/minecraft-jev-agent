// test-descend-plan.mts - Issue #41 unit proof that a `descend_to:Y=<n>` goal
// produces an executable descend candidate (never a WAIT-only list) and that a
// stalled descend escalates. No bot, no network.
//
// Run: bun test-descend-plan.mts
import {
  evaluateDescendProgress,
  formatDescendProgress,
  formatDescendStalled,
  resolveDescendStallTicks,
} from './src/descendPlan.ts'
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { JevController } from './src/controller.ts'
import { DIG_PATH_CAP, DigMemory } from './src/worldMemory.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, DescentOption, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M1D41',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function goal(): GoalState {
  return {
    id: 'descend:raw_iron',
    description: 'descend_to:Y=46',
    targetItem: 'raw_iron',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g1',
    kind: 'descend',
    description: 'descend_to:Y=46',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: 46,
    dimension: 'minecraft:overworld',
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
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

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  signals?: AgentSignals
  descent?: DescentOption[]
  standable?: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: overrides.standable ?? [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(),
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    descent: overrides.descent,
    stepCuts: [],
    headroomCuts: [],
    signals: overrides.signals ?? signals(),
  }
}

// --- progress assertion ----------------------------------------------------------

addCase('a whole-block drop is progress and re-arms the stall counter', () => {
  const decision = evaluateDescendProgress({ previous: { bestY: 55, ticks: 19 }, y: 54, stallTicks: 20 })
  return {
    pass: decision.outcome === 'progress' && decision.bestY === 54 && decision.ticks === 0,
    detail: `${decision.outcome} bestY=${decision.bestY} ticks=${decision.ticks}`,
  }
})

addCase('no vertical movement tracks, then stalls at the window and re-arms', () => {
  let state = { bestY: 55, ticks: 0 }
  const outcomes: string[] = []
  for (let i = 0; i < 21; i += 1) {
    const decision = evaluateDescendProgress({ previous: state, y: 55, stallTicks: 20 })
    outcomes.push(decision.outcome)
    state = { bestY: decision.bestY, ticks: decision.ticks }
  }
  return {
    pass: outcomes[0] === 'tracking' && outcomes[19] === 'stalled' && outcomes[20] === 'tracking',
    detail: `first=${outcomes[0]} tick20=${outcomes[19]} tick21=${outcomes[20]}`,
  }
})

addCase('the exact DESCEND_STALLED / DESCEND_PROGRESS marker lines are stable', () => {
  const stalled = formatDescendStalled(55, 46, 20)
  const progress = formatDescendProgress(50, 46, 5.5, 0)
  return {
    pass:
      stalled === 'DESCEND_STALLED y=55 target_y=46 ticks=20' &&
      progress === 'DESCEND_PROGRESS y=50 target_y=46 delta=5.5 ticks=0',
    detail: `${stalled} | ${progress}`,
  }
})

addCase('invalid BUDDY_DESCEND_STALL_TICKS falls back to the default', () => {
  const fallback = resolveDescendStallTicks({ BUDDY_DESCEND_STALL_TICKS: 'nope' })
  const override = resolveDescendStallTicks({ BUDDY_DESCEND_STALL_TICKS: '3' })
  return { pass: fallback === 20 && override === 3, detail: `fallback=${fallback} override=${override}` }
})

// --- candidate selection ---------------------------------------------------------

addCase('an exhausted descent exposes grounded down and level alternatives to policy', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const level = {
    ...downStep('N', 0, -1, feet),
    mode: 'level' as const,
    step: { x: 0, y: feet.y, z: -1 },
  }
  const candidates = generateCandidates(
    worldState({
      position: feet,
      goalQueue: queueWith(queuedGoal({ targetY: 46 })),
      signals: signals({ digDir: 'E', digMode: 'down', digDirCount: 1, descendLimitReached: true }),
      descent: [downStep('E', 1, 0, feet), downStep('W', -1, 0, feet), level],
    }),
    defaultCandidateOptions,
  ).filter((candidate: Candidate) => candidate.kind === 'DESCEND')
  const alternatives = candidates.map((candidate) => `${String(candidate.meta.mode)}:${String(candidate.meta.dir)}`)
  const boundaries = new Set(candidates.map((candidate) => candidate.meta.legPolicyBoundary))
  return {
    pass:
      alternatives.length === 2 &&
      alternatives.includes('down:W') &&
      alternatives.includes('level:N') &&
      boundaries.size === 1 &&
      String([...boundaries][0]).includes('reason=descent_budget_exhausted'),
    detail: `alternatives=[${alternatives.join(',')}] boundary=${String([...boundaries][0])}`,
  }
})

addCase('a successful policy-selected recovery starts its own bounded Skill continuation', () => {
  type RecoveryRuntime = {
    digMemory: DigMemory
    options: { worldEpoch: number }
    bot: { game: { dimension: string }; entity: { position: Vec3Json } }
    logger: {
      info: (channel: string, message: string, fields: Record<string, unknown>, tick: number) => void
      warn: (channel: string, message: string, fields: Record<string, unknown>, tick: number) => void
    }
    tickCounter: number
    digOscillationReported: boolean
    descendHaveBaseline: number
    actionStart: Vec3Json
    queue: { current: QueuedGoal }
    effectiveHave: () => number
    onDescendComplete: (result: { actionId: string }, candidate: Candidate) => void
  }
  const feet = { x: 0, y: 55, z: 0 }
  const level = {
    ...downStep('N', 0, -1, feet),
    mode: 'level' as const,
    step: { x: 0, y: feet.y, z: -1 },
  }
  const offered = generateCandidates(
    worldState({
      position: feet,
      goalQueue: queueWith(queuedGoal({ targetY: 46 })),
      signals: signals({
        digDir: 'E',
        digMode: 'down',
        digDirCount: 4,
        descendNoProgress: 4,
        descendLimitReached: true,
      }),
      descent: [downStep('E', 1, 0, feet), level],
    }),
    defaultCandidateOptions,
  )
  const selected = offered.find(
    (candidate: Candidate) =>
      candidate.kind === 'DESCEND' &&
      candidate.meta.mode === 'level' &&
      candidate.meta.dir === 'N',
  )
  if (selected === undefined) return { pass: false, detail: 'policy alternative level:N was not offered' }

  const memory = new DigMemory()
  memory.bindScope({ dimension: 'minecraft:overworld', worldEpoch: 1 })
  memory.observeStoneY(30)
  memory.record({ x: 1, y: 54, z: 0, dir: 'E', mode: 'down', target: 'raw_iron', atMs: 1 })
  for (let index = 0; index < 4; index += 1) memory.markDescend(false)
  const lines: string[] = []
  const runtime = Object.create(JevController.prototype) as RecoveryRuntime
  runtime.digMemory = memory
  runtime.options = { worldEpoch: 1 }
  runtime.bot = {
    game: { dimension: 'minecraft:overworld' },
    entity: { position: feet },
  }
  runtime.logger = {
    info: (_channel, message) => lines.push(message),
    warn: (_channel, message) => lines.push(message),
  }
  runtime.tickCounter = 1
  runtime.digOscillationReported = false
  runtime.descendHaveBaseline = 0
  runtime.actionStart = feet
  runtime.queue = { current: queuedGoal({ targetY: 46 }) }
  runtime.effectiveHave = () => 0
  runtime.onDescendComplete({ actionId: selected.id }, selected)

  const afterSelection = memory.snapshot()
  const continuation = generateCandidates(
    worldState({
      position: feet,
      goalQueue: queueWith(queuedGoal({ targetY: 46 })),
      signals: signals({
        digDir: afterSelection.digDir,
        digMode: afterSelection.digMode,
        digDirCount: afterSelection.digDirCount,
        digDepth: afterSelection.digDepth,
        digOscillate: afterSelection.digOscillate,
        descendNoProgress: afterSelection.descendNoProgress,
        descendLimitReached: afterSelection.descendLimitReached,
      }),
      descent: [level],
    }),
    defaultCandidateOptions,
  ).find((candidate: Candidate) => candidate.kind === 'DESCEND')

  return {
    pass:
      selected.meta.recoveryBoundaryReason === 'descent_budget_exhausted' &&
      afterSelection.digDir === 'N' &&
      afterSelection.digMode === 'level' &&
      afterSelection.digDirCount === 1 &&
      afterSelection.descendNoProgress === 1 &&
      !afterSelection.descendLimitReached &&
      afterSelection.knownStoneY === 30 &&
      continuation?.meta.dir === 'N' &&
      continuation.meta.mode === 'level' &&
      continuation.meta.recoveryBoundaryReason === undefined &&
      lines.some((line) => line.startsWith('DESCEND_RECOVERY_SELECTED reason=descent_budget_exhausted')),
    detail: `selected=${selected.id} next=${continuation?.id ?? 'none'} mode=${afterSelection.digMode} ` +
      `streak=${afterSelection.descendNoProgress} limit=${afterSelection.descendLimitReached} ` +
      `nextBoundary=${String(continuation?.meta.recoveryBoundaryReason ?? 'none')}`,
  }
})

// --- candidate generation (the measured stall) ----------------------------------

addCase('a latched descend budget still yields a DESCEND candidate for a predicate goal', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 46 })),
    signals: signals({ descendLimitReached: true }),
    descent: [downStep('D', 0, 0, feet)],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const descend = candidates.find((candidate: Candidate) => candidate.kind === 'DESCEND')
  return {
    pass:
      descend !== undefined &&
      descend.meta.mode === 'down' &&
      descend.meta.predicate === 'descend_to:Y=46' &&
      descend.meta.dir === 'D' &&
      candidates.some((candidate: Candidate) => candidate.kind === 'WAIT'),
    detail: descend === undefined ? 'no DESCEND' : `${descend.id} dir=${String(descend.meta.dir)}`,
  }
})

addCase('a latched item-goal descent budget preserves safe lateral search', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const lateral = {
    ...downStep('E', 1, 0, feet),
    mode: 'level' as const,
    step: { x: 1, y: 55, z: 0 },
    floor: { x: 1, y: 54, z: 0 },
    wall: { x: 1, y: 55, z: 0 },
    head: { x: 1, y: 56, z: 0 },
  }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(
      queuedGoal({ kind: 'collect', targetY: undefined, description: 'collect raw iron' }),
    ),
    signals: signals({ descendLimitReached: true }),
    descent: [lateral],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const descend = candidates.find((candidate: Candidate) => candidate.kind === 'DESCEND')
  return {
    pass: descend !== undefined && descend.meta.mode === 'level' && descend.meta.dir === 'E',
    detail: descend === undefined ? 'no lateral DESCEND' : `${descend.id} mode=${String(descend.meta.mode)}`,
  }
})

addCase('a capped lateral tunnel stops offering same-height DESCEND steps', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const lateral = {
    ...downStep('E', 1, 0, feet),
    mode: 'level' as const,
    step: { x: 1, y: 55, z: 0 },
  }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(
      queuedGoal({ kind: 'collect', targetY: undefined, description: 'collect raw iron' }),
    ),
    signals: signals({
      descendLimitReached: true,
      digDir: 'E',
      digMode: 'level',
      digDirCount: DIG_PATH_CAP,
    }),
    descent: [lateral],
  })
  const descend = generateCandidates(state, defaultCandidateOptions).filter(
    (candidate: Candidate) => candidate.kind === 'DESCEND',
  )
  return {
    pass: descend.length === 0,
    detail: descend.map((candidate) => candidate.id).join(',') || 'no DESCEND at path cap',
  }
})

addCase('the path cap still permits a grounded downward step', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const lateral = {
    ...downStep('E', 1, 0, feet),
    mode: 'level' as const,
    step: { x: 1, y: 55, z: 0 },
  }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(
      queuedGoal({ kind: 'collect', targetY: undefined, description: 'collect raw iron' }),
    ),
    signals: signals({ digDir: 'E', digMode: 'level', digDirCount: DIG_PATH_CAP, knownStoneY: 40 }),
    descent: [lateral, downStep('D', 0, 0, feet)],
  })
  const descend = generateCandidates(state, defaultCandidateOptions).filter(
    (candidate: Candidate) => candidate.kind === 'DESCEND',
  )
  return {
    pass: descend.length === 1 && descend[0]?.meta.mode === 'down',
    detail: descend.map((candidate) => `${candidate.id} mode=${String(candidate.meta.mode)}`).join(',') || 'no DESCEND',
  }
})

addCase('a verified move after the capped tunnel opens a fresh bounded path', () => {
  type ResetRuntime = {
    digMemory: DigMemory
    options: { worldEpoch: number }
    bot: { game: { dimension: string } }
    logger: { info: (channel: string, message: string, fields: Record<string, unknown>, tick: number) => void }
    tickCounter: number
    resetDescendBudgetAfterWorldChange: (
      actionId: string,
      reason: 'verified_mine' | 'verified_move',
    ) => void
  }
  const runtime = Object.create(JevController.prototype) as ResetRuntime
  const memory = new DigMemory()
  memory.bindScope({ dimension: 'minecraft:overworld', worldEpoch: 1 })
  const lines: string[] = []
  for (let index = 0; index < DIG_PATH_CAP; index += 1) {
    memory.record({ x: index, y: 55, z: 0, dir: 'E', mode: 'level', target: 'raw_iron', atMs: index })
  }
  for (let index = 0; index < 4; index += 1) memory.markDescend(false)
  runtime.digMemory = memory
  runtime.options = { worldEpoch: 1 }
  runtime.bot = { game: { dimension: 'minecraft:overworld' } }
  runtime.logger = { info: (_channel, message) => lines.push(message) }
  runtime.tickCounter = 1

  runtime.resetDescendBudgetAfterWorldChange('MINE:b8_55_0', 'verified_mine')
  const afterMine = memory.snapshot()
  for (let index = 0; index < 4; index += 1) memory.markDescend(false)
  runtime.resetDescendBudgetAfterWorldChange('MOVE:p9_55_0', 'verified_move')
  const snapshot = memory.snapshot()
  const nextFeet = { x: 9, y: 55, z: 0 }
  const nextLateral = {
    ...downStep('E', 1, 0, nextFeet),
    mode: 'level' as const,
    step: { x: 10, y: 55, z: 0 },
  }
  const nextColumn = worldState({
    position: nextFeet,
    goalQueue: queueWith(
      queuedGoal({ kind: 'collect', targetY: undefined, description: 'collect raw iron' }),
    ),
    signals: signals({
      descendLimitReached: snapshot.descendLimitReached,
      digDir: snapshot.digDir,
      digDirCount: snapshot.digDirCount,
    }),
    descent: [nextLateral],
  })
  const nextStep = generateCandidates(nextColumn, defaultCandidateOptions).find(
    (candidate: Candidate) => candidate.kind === 'DESCEND' && candidate.meta.mode === 'level',
  )
  return {
    pass:
      afterMine.digDirCount === DIG_PATH_CAP &&
      afterMine.descendNoProgress === 0 &&
      snapshot.digDir === null &&
      snapshot.digDirCount === 0 &&
      snapshot.descendNoProgress === 0 &&
      lines.some((line) => line.startsWith('DIG_PATH_RESET reason=cap_after_verified_move')) &&
      lines.some((line) => line.startsWith('DESCEND_BUDGET_RESET actionId=MOVE:p9_55_0')) &&
      nextStep !== undefined,
    detail: `mineCount=${afterMine.digDirCount} nextStep=${nextStep?.id ?? 'none'} dir=${snapshot.digDir} count=${snapshot.digDirCount} noProgress=${snapshot.descendNoProgress} logs=${lines.join(' | ')}`,
  }
})

addCase('a predicate goal with only unsafe steps has no DESCEND candidate (escalation path)', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const unsafe = { ...downStep('D', 0, 0, feet), safe: false, reason: 'lava/water in the step column' }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 46 })),
    descent: [unsafe],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const descend = candidates.filter((candidate: Candidate) => candidate.kind === 'DESCEND')
  const escalate = candidates.find((candidate: Candidate) => candidate.kind === 'ESCALATE')
  return {
    pass:
      descend.length === 0 &&
      escalate?.meta.reason === 'no_grounded_local_frontier' &&
      escalate.meta.skillOutcome === 'BLOCKED' &&
      String(escalate.meta.legPolicyBoundary).includes('reason=no_grounded_local_frontier'),
    detail: `descend=${descend.length} escalate=${String(escalate?.meta.reason ?? 'none')} boundary=${String(escalate?.meta.legPolicyBoundary ?? 'none')}`,
  }
})

addCase('the straight-down candidate records the exact predicate target in its meta', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 46 })),
    descent: [downStep('D', 0, 0, feet)],
  })
  const descend = generateCandidates(state, defaultCandidateOptions).find(
    (candidate: Candidate) => candidate.kind === 'DESCEND',
  )
  const target = descend?.target
  return {
    pass:
      descend !== undefined &&
      target !== null &&
      target !== undefined &&
      target.x === 0 &&
      target.y === 54 &&
      target.z === 0,
    detail: descend === undefined ? 'no DESCEND' : `target=${JSON.stringify(descend.target)}`,
  }
})

// (12) LIVE SHAPE (run-muc3qbug-18vg3, main 35dfd29): a `descend_to:Y=<n>` goal
// whose own column offers NO safe step at all. The sensor refuses every cardinal
// step and the own column (hazard / no support / unbreakable floor), so the
// descent family yields nothing and the offer collapsed to `kinds=['ESCALATE']`
// while the row stayed active and the body idled at y=55 with the target 109
// blocks below. A blocked column is not a blocked descent: the offer must carry a
// grounded retarget to a DIFFERENT standable column.
addCase('(12) a descend goal with no safe step in its own column retargets a fresh column', () => {
  const feet: Vec3Json = { x: 11.5, y: 55, z: 21.7 }
  const unsafe = (dir: DescentOption['dir'], dx: number, dz: number): DescentOption => ({
    ...downStep(dir, dx, dz, feet),
    safe: false,
    reason: 'no solid support at (12,53,22)',
    refusal: 'no_support',
  })
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetItem: null as unknown as string, targetY: -54 })),
    descent: [unsafe('E', 1, 0), unsafe('W', -1, 0), unsafe('N', 0, -1), unsafe('S', 0, 1)],
    standable: [feet, { x: 9, y: 54, z: 22 }, { x: 13, y: 56, z: 21 }],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const retarget = candidates.find((candidate: Candidate) => candidate.meta.descendRetarget === true)
  const escalateOnly = candidates.length > 0 && candidates.every((candidate: Candidate) => candidate.kind === 'ESCALATE')
  return {
    pass:
      !escalateOnly &&
      retarget !== undefined &&
      retarget.kind === 'MOVE' &&
      retarget.target?.x === 9 &&
      retarget.target?.y === 54 &&
      retarget.meta.verticalRecovery === 'descent_retarget',
    detail: `candidates=[${candidates.map((candidate: Candidate) => candidate.id).join(',')}] retarget=${retarget?.id ?? 'none'}`,
  }
})

// (13) A typed failure on the selected route suppresses that exact hard-invalid
// candidate; a distinct grounded route remains visible to policy.
addCase('(13) a spent down candidate is excluded while a grounded level alternative remains for policy', () => {
  const feet: Vec3Json = { x: 10, y: 64, z: 22 }
  const down = downStep('N', 0, -1, feet)
  const level: DescentOption = {
    ...down,
    mode: 'level',
    step: { x: 10, y: 64, z: 21 },
    floor: { x: 10, y: 63, z: 21 },
  }
  const spent = {
    [`DESCEND:down:N:b${down.floor.x}_${down.floor.y}_${down.floor.z}`]: 99,
  }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: -54 })),
    signals: signals({ failedCandidates: spent, digDir: 'N', digMode: 'down' }),
    descent: [level, down],
  })
  const descend = generateCandidates(state, defaultCandidateOptions).find(
    (candidate: Candidate) => candidate.kind === 'DESCEND',
  )
  return {
    pass:
      descend !== undefined &&
      descend.meta.mode === 'level' &&
      descend.meta.dir === 'N' &&
      descend.meta.skillOutcome === 'BLOCKED' &&
      typeof descend.meta.legPolicyBoundary === 'string' &&
      String(descend.meta.legPolicyBoundary).includes('reason=selected_descent_blocked_or_spent'),
    detail: `descend=${descend?.id ?? 'none'} mode=${String(descend?.meta.mode ?? '-')} boundary=${String(descend?.meta.legPolicyBoundary ?? 'none')}`,
  }
})

let failures = 0
process.stdout.write('descend plan (#41): candidate generation + stall escalation\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} descend-plan cases passed\n`)
if (failures > 0) process.exit(1)
