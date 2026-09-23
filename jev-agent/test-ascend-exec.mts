// test-ascend-exec.mts - the LAST MILE of the 48-minute `g2:surface:log` loop:
// a Jev-selected ASCEND candidate that reached the guard and was dropped there.
//
// Measured live (resident m3-live, generation gen-mubc977u-ksj4c8):
//
//   JEV_HEADS action=ASCEND:surface:p3_86_18 abandon=0.38 decision=continue
//   (alternating with JEV_HEADS action=WAIT) for 48 minutes, body stays at
//   (3.5, 67, 18.3); ZERO `ACTION n=... id=ASCEND:...` lines, ZERO
//   `PILLAR_UP`/`ASCENT_*` lines. The decision record for the same chainId says
//   `chosenAction=ASCEND:surface:p3_86_18`, `status="guard-rejected"`,
//   `failureCode="NO_SUPPORT"`.
//
// Owning-layer cause: `policy.guardMove` applied the horizontal
// `terrain.standable` check to EVERY target-less MOVE before any vertical-plan
// exception, so the pillar apex cell (air until the executor places it) was
// refused with `NO_SUPPORT` and the executor was never invoked - even though
// `unreachableMove` and `guardWalkToBlock` already treat `meta.vertical` as the
// route. Nothing mirrored the rejection either: the `guard` log category is not
// part of the agent stream, so the selection left no typed trace at all.
//
// This fixture drives the REAL guard and the REAL executor:
//   * a selected ASCEND/vertical candidate must pass the decision guard and be
//     claimed by the executor with its `vertical=pillar` meta;
//   * a candidate the guard DOES drop must emit the mirrored `ACTION_REJECTED`
//     marker with its deterministic code and reason, through the controller's
//     own `onGuardReject`.
//
// Run: bun test ./test-ascend-exec.mts

import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { JevController, MIRRORED_MARKERS, mirroredEventToken } from './src/controller.ts'
import { JevDecisionEpochs } from './src/jevSemanticProjection.ts'
import type { SkillOutcomePacket } from './src/jevSemanticProjection.ts'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import type { JsonlWriter } from './src/jev-legacy.ts'
import { guardDecision } from './src/policy.ts'
import type { GuardCode, GuardResult } from './src/policy.ts'
// Namespace access (never a named import) so this fixture also RUNS against the
// pre-fix module, where the export does not exist yet, and reports a behavioral
// failure instead of aborting the whole run with a SyntaxError.
import * as policyModule from './src/policy.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { DecisionRecord } from './src/decisionlog.ts'
import type { JevResult } from './src/jev.ts'
import type {
  AgentSignals,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The measured live shape: feet (3,67,18), goal `recover vertical access to y>=86`. */
const BODY_FEET: Vec3Json = { x: 3, y: 67, z: 18 }
const GOAL_TARGET_Y = 86
const EXPECTED_ID = 'ASCEND:surface:p3_86_18'

const ACTION_REJECTED = 'ACTION_REJECTED'

const formatActionRejectedMaybe = (
  policyModule as unknown as {
    formatActionRejected?: (candidateId: string, code: GuardCode, reason: string) => string
  }
).formatActionRejected

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_ASCENDEXEC',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: false,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
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

function surfaceGoal(targetY: number): GoalState {
  return {
    id: 'surface:log:1',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedSurface(targetY: number): QueuedGoal {
  return {
    id: 'surface:log:1',
    kind: 'surface',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    targetY,
    dimension: 'overworld',
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

/** The measured 1x1 column: the bot's own cell is the only standable spot. */
function liveWorld(counts: Record<string, number>): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(BODY_FEET),
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    terrain: { standable: [BODY_FEET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: surfaceGoal(GOAL_TARGET_Y),
    goalQueue: queueWith(queuedSurface(GOAL_TARGET_Y)),
    recentEvents: [],
    descent: [],
    stepCuts: [],
    signals: signals(),
  }
}

function ascentOf(candidates: readonly Candidate[]): Candidate | null {
  return candidates.find((candidate) => candidate.meta.surfaceAscent === true) ?? null
}

/** Exactly the context the controller builds at commit time (controller-legacy.ts). */
function decisionGuard(candidate: Candidate, state: WorldState, ids: readonly string[], canComputePath: (p: Vec3Json) => boolean): GuardResult {
  return guardDecision(candidate.id, [candidate], state, {
    phase: 'decision',
    candidateIds: new Set(ids),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 200,
    canComputePath,
  })
}

// --- 1. the selected ASCEND reaches the executor ---------------------------------

/** Minimal structural vec3 the real Executor touches on the fake bot. */
class P {
  x: number
  y: number
  z: number
  constructor(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
  }
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  set(x: number, y: number, z: number): P {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  offset(x: number, y: number, z: number): P {
    return new P(this.x + x, this.y + y, this.z + z)
  }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

interface CapturedLog {
  source: string
  message: string
  detail: Record<string, unknown>
}

function makeCapturingLogger(logs: CapturedLog[]): EventLogger {
  const writer = {
    write: (record: { source?: string; message?: string; detail?: Record<string, unknown> }): void => {
      if (typeof record.message !== 'string') return
      logs.push({ source: record.source ?? 'unknown', message: record.message, detail: record.detail ?? {} })
    },
  } as unknown as JsonlWriter
  return new EventLogger(writer, false)
}

function makeStructuralBot(): { bot: Bot; position: P } {
  const position = new P(BODY_FEET.x + 0.5, BODY_FEET.y, BODY_FEET.z + 0.5)
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const emit = (event: string, payload?: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
  }
  const bot = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      isCollidedHorizontally: false,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number): P => position.offset(x, y, z),
      clone: (): P => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }): number => position.distanceTo(other),
    },
    _client: { write: (): boolean => true },
    physicsEnabled: true,
    entities: {},
    inventory: {
      // The live inventory held 402 cobblestone: the pillar plan's placeable.
      items: (): Array<{ name: string; count: number; slot: number }> => [
        { name: 'cobblestone', count: 402, slot: 0 },
      ],
      count: (name: string): number => (name === 'cobblestone' ? 402 : 0),
    },
    blockAt: (v: { x: number; y: number; z: number }): { name: string; boundingBox: string } => {
      // Solid floor below the feet, air everywhere above: a pillar column.
      if (Math.floor(v.y) <= BODY_FEET.y - 1) return { name: 'stone', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    },
    on: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      set.push(handler)
      listeners.set(event, set)
      return bot
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      listeners.set(event, set.filter((entry) => entry !== handler))
      return bot
    },
    setControlState: (): void => undefined,
    lookAt: async (): Promise<void> => undefined,
    equip: async (): Promise<void> => undefined,
    stopDigging: (): void => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown): void => {
        bot.pathfinder.movements = movements
      },
      setGoal: (goal: { constructor?: { name?: string } } | null): void => {
        if (goal === null) return
        void emit
      },
      stop: (): void => undefined,
      getPathTo: (): { status: string; path: unknown[] } => ({ status: 'noPath', path: [] }),
    },
  }
  return { bot: bot as unknown as Bot, position }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

addCase('a Jev-selected ASCEND pillar passes the decision guard and the executor runs its vertical leg', async () => {
  const world = liveWorld({ diamond_pickaxe: 1, cobblestone: 402 })
  const grounded = generateGroundedCandidates(world, defaultCandidateOptions)
  const ascent = ascentOf(grounded.candidates)
  if (ascent === null) return { pass: false, detail: 'no ASCEND candidate was generated' }
  const ids = grounded.candidates.map((candidate) => candidate.id)

  // `canComputePath: () => false` is the strict case: the horizontal
  // canDig=false GoalBlock probe fails, so only the vertical plan can carry the
  // candidate. The guard must still accept it (the vertical leg IS the path).
  const verdict = decisionGuard(ascent, world, ids, () => false)
  if (!verdict.ok) {
    return { pass: false, detail: `guard dropped the selection: ${verdict.code} :: ${verdict.reason}` }
  }

  const logs: CapturedLog[] = []
  const { bot } = makeStructuralBot()
  const executor = new Executor(bot, makeCapturingLogger(logs), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    // issue #436 section 15: the declared path budget is the COMMITMENT's own
    // wall-clock bound now that the harness layer owns the walk loop, so it must
    // be a real bound - a 1 ms commitment could not run even one pillar step.
    pathTimeoutMs: 3000,
    pickupPathTimeoutMs: 3000,
    packetStepMs: 0,
    maxStepsPerWaypoint: 1,
  })

  // The selection becomes an executor claim carrying the same id and the
  // vertical meta the candidate was enumerated with.
  const claim = executor.claim(ascent)
  const currentId = executor.current?.id ?? null
  const currentKind = executor.current?.kind ?? null
  const pillarRan = await waitFor(
    () => logs.some((line) => line.message.startsWith('PILLAR_UP') && line.detail.actionId === ascent.id),
  )
  executor.cancelCurrent('ascend-exec fixture complete')

  const pass =
    ascent.id === EXPECTED_ID &&
    ascent.meta.vertical === 'pillar' &&
    claim.kept === false &&
    currentId === ascent.id &&
    currentKind === 'MOVE' &&
    pillarRan
  return {
    pass,
    detail: `id=${ascent.id} vertical=${String(ascent.meta.vertical)} claimed=${currentId}/${String(currentKind)} executorPillarLeg=${pillarRan}`,
  }
})

addCase('vertical planning skips a stair cut that intersects a live structure member', () => {
  const world = liveWorld({ diamond_pickaxe: 1, cobblestone: 402 })
  const cut = { x: 4, y: BODY_FEET.y + 1, z: BODY_FEET.z }
  world.stepCuts = [
    {
      dir: 'E',
      dx: 1,
      dz: 0,
      cut,
      step: { x: 4, y: BODY_FEET.y + 1, z: BODY_FEET.z },
      name: 'obsidian',
      safe: true,
      reason: 'safe',
    },
  ]
  const unprotected = ascentOf(generateGroundedCandidates(world, defaultCandidateOptions).candidates)
  world.liveStructureMembers = [{ kind: 'synthetic_structure', position: { ...cut } }]
  const protectedAscent = ascentOf(generateGroundedCandidates(world, defaultCandidateOptions).candidates)
  return {
    pass:
      unprotected?.meta.vertical === 'staircase-up' &&
      protectedAscent?.meta.vertical === 'pillar',
    detail: `unprotected=${String(unprotected?.meta.vertical ?? 'none')} protected=${String(protectedAscent?.meta.vertical ?? 'none')}`,
  }
})

addCase('a plain horizontal MOVE to an unknown standable cell is still guard-rejected', () => {
  const world = liveWorld({ diamond_pickaxe: 1, cobblestone: 402 })
  const plain: Candidate = {
    id: 'MOVE:p3_80_18',
    kind: 'MOVE',
    label: 'move to (3,80,18)',
    targetName: null,
    target: { x: 3, y: 80, z: 18 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: world.tick },
  }
  const verdict = decisionGuard(plain, world, [plain.id], () => true)
  const pass = !verdict.ok && verdict.code === 'NO_SUPPORT'
  return { pass, detail: verdict.ok ? 'accepted (the vertical exception leaked)' : `${verdict.code} :: ${verdict.reason}` }
})

addCase('a vertical-plan MOVE below the void floor is still guard-rejected', () => {
  const world = liveWorld({ diamond_pickaxe: 1, cobblestone: 402 })
  const deep: Candidate = {
    id: 'ASCEND:surface:p3_-70_18',
    kind: 'MOVE',
    label: 'void pillar',
    targetName: null,
    target: { x: 3, y: -70, z: 18 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: world.tick, vertical: 'pillar' },
  }
  const verdict = decisionGuard(deep, world, [deep.id], () => true)
  const pass = !verdict.ok && verdict.code === 'NO_SUPPORT' && verdict.reason.includes('void')
  return { pass, detail: verdict.ok ? 'accepted (void check lost)' : `${verdict.code} :: ${verdict.reason}` }
})

// --- 2. a selected-but-dropped action emits the typed marker ---------------------

interface GuardRejectRuntime {
  logger: EventLogger
  goal: { progress: number }
  decisionWriter: { write: (record: unknown) => void }
  conflictDeferrals: number
  guardRejections: number
  recentEvents: string[]
  tickCounter: number
  // Issue #437: state the guard-reject path now touches when it emits the packet.
  actionEpochByLease: Map<number, { epoch: number; commitmentId: string; identity: string }>
  decisionEpochs: JevDecisionEpochs
  recentSkillOutcomes: SkillOutcomePacket[]
  compressedSkillSteps: number
  /** not under test: the packet's Option identity is irrelevant to the marker */
  currentOptionContext: () => null
  noteCandidateFailure: (id: string) => void
  recordMoveFailure: (candidate: Candidate, reason: string) => void
  chargeGuardRejection: (record: DecisionRecord, code: GuardCode) => void
  recordFailure: (code: string, detail: string) => void
  onGuardReject: (
    guarded: Extract<GuardResult, { ok: false }>,
    decision: JevResult,
    record: DecisionRecord,
    candidate: Candidate | undefined,
  ) => void
}

addCase('a guard-dropped selection emits ACTION_REJECTED with its code and reason', () => {
  const world = liveWorld({ diamond_pickaxe: 1, cobblestone: 402 })
  const plain: Candidate = {
    id: 'MOVE:p3_80_18',
    kind: 'MOVE',
    label: 'move to (3,80,18)',
    targetName: null,
    target: { x: 3, y: 80, z: 18 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: world.tick },
  }
  const verdict = decisionGuard(plain, world, [plain.id], () => true)
  if (verdict.ok) return { pass: false, detail: 'fixture precondition failed: expected a guard rejection' }

  const logs: CapturedLog[] = []
  const controller = Object.create(JevController.prototype) as unknown as GuardRejectRuntime
  controller.logger = makeCapturingLogger(logs)
  controller.goal = { progress: 0 }
  controller.decisionWriter = { write: () => undefined }
  controller.conflictDeferrals = 0
  controller.guardRejections = 0
  controller.recentEvents = []
  controller.tickCounter = 1
  // Issue #437: the guard-reject path also emits the typed SkillOutcomePacket, so
  // this prototype stub must carry the epoch/packet state the real controller owns.
  controller.actionEpochByLease = new Map()
  controller.decisionEpochs = new JevDecisionEpochs()
  controller.recentSkillOutcomes = []
  controller.compressedSkillSteps = 0
  controller.currentOptionContext = () => null
  // The rejection bookkeeping is not under test here; the marker is.
  controller.noteCandidateFailure = () => undefined
  controller.recordMoveFailure = () => undefined
  controller.chargeGuardRejection = () => undefined
  controller.recordFailure = () => undefined

  const record = {
    optionId: 'recover_vertical_access',
    goalQueueState: { current: { id: 'g2:surface:log' } },
    chainId: 'ascend-exec-fixture',
    jev: { answers: {} },
  } as unknown as DecisionRecord
  const decision = { callId: 'ascend-exec-fixture', policy: 'fixture' } as unknown as JevResult

  controller.onGuardReject(verdict, decision, record, plain)

  const mirrored = logs.filter((line) => mirroredEventToken(line.message) === ACTION_REJECTED)
  const line = mirrored[0]?.message ?? null
  const formatted = formatActionRejectedMaybe === undefined
    ? null
    : formatActionRejectedMaybe(plain.id, verdict.code, verdict.reason)
  const pass =
    MIRRORED_MARKERS.has(ACTION_REJECTED) &&
    formatActionRejectedMaybe !== undefined &&
    formatted !== null &&
    formatted.startsWith(ACTION_REJECTED) &&
    formatted.includes(`id=${plain.id}`) &&
    formatted.includes(`code=${verdict.code}`) &&
    formatted.includes(verdict.reason) &&
    line !== null &&
    line.includes(plain.id) &&
    line.includes(verdict.code)
  return {
    pass,
    detail:
      line === null
        ? `no mirrored ACTION_REJECTED (logs=[${logs.map((entry) => entry.message.split(' ')[0]).join(',')}]) formatted=${String(formatted)}`
        : line,
  }
})

addCase('the executor refusal for an unplaceable pillar leaves a typed PILLAR marker, never silence', async () => {
  const world = liveWorld({ diamond_pickaxe: 1 })
  const grounded = generateGroundedCandidates(world, defaultCandidateOptions)
  const ascent = ascentOf(grounded.candidates)
  if (ascent === null) {
    // No placeable => the generator already names the typed refusal; that is the
    // same contract at the candidate layer.
    const refusal = (grounded as unknown as { surfaceAscentRefusal?: { reason?: string } | null }).surfaceAscentRefusal
    return { pass: refusal?.reason === 'no_placeable', detail: `refusal=${refusal?.reason ?? 'null'}` }
  }
  const logs: CapturedLog[] = []
  const { bot } = makeStructuralBot()
  // Remove the placeable from the live inventory, keeping the enumerated plan.
  ;(bot as unknown as { inventory: { items: () => Array<{ name: string; count: number; slot: number }> } }).inventory.items =
    (): Array<{ name: string; count: number; slot: number }> => []
  const executor = new Executor(bot, makeCapturingLogger(logs), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    // issue #436 section 15: the declared path budget is the COMMITMENT's own
    // wall-clock bound now that the harness layer owns the walk loop, so it must
    // be a real bound - a 1 ms commitment could not run even one pillar step.
    pathTimeoutMs: 3000,
    pickupPathTimeoutMs: 3000,
    packetStepMs: 0,
    maxStepsPerWaypoint: 1,
  })
  executor.claim(ascent)
  const typed = await waitFor(
    () =>
      logs.some(
        (line) =>
          (line.message.startsWith('PILLAR_UP') || line.message.startsWith('PILLAR_FAIL')) &&
          line.detail.actionId === ascent.id,
      ),
    // `pillarUp` refuses before equipping when the stack is gone; the PILLAR_UP
    // line is emitted by the vertical leg regardless.
  )
  executor.cancelCurrent('ascend-exec fixture complete')
  return { pass: typed, detail: `markers=[${logs.map((entry) => entry.message.split(' ')[0]).join(',')}]` }
})

let failures = 0
process.stdout.write(`ascend-exec: selected ASCEND/vertical candidate -> guard -> executor\n`)
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} ascend-exec cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
