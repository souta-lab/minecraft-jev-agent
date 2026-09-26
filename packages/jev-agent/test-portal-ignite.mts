// test-portal-ignite.mts - the LIVE ignition action (Nether portal gate, M3 lane).
//
// The typed portal plan has always compiled `light_portal` / `verify_portal` to
// `null` (`portalStepToPlannedGoal`), so nothing in the live loop could ever
// light a validated frame. This suite is RED-first: it names the missing
// ignition capability end to end.
//
//   1. a pure ignition decision (`planPortalIgnition`) offers a candidate ONLY
//      when flint_and_steel is held AND `validatePortalFrame` says shape=ok;
//   2. the candidate generator surfaces the ignition candidate + a typed refusal
//      (`ignitionRefusal`) instead of silence;
//   3. the real Executor dispatches it through the leased actuation port
//      (`activateBlock`) at the frame's light position;
//   4. a STRICT postcondition proves the `nether_portal` block exists at every
//      expected interior cell - an unverified ignition can never read `done`;
//   5. the durable markers PORTAL_LIT then PORTAL_VERIFIED are emitted only when
//      that postcondition holds;
//   6. the truthful-outcome layer treats IGNITE as self-evident verified so the
//      controller advances only on a proven ignition.
//
// Run: bun test-portal-ignite.mts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import type { ActuationPort } from './src/actuationPort.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import { Executor, defaultExecutorOptions } from './src/index.ts'
import type { Candidate, Vec3Json } from './src/index.ts'
import {
  decideActionOutcome,
  describeActionPostcondition,
  isIgnitePostconditionMet,
  truthfulActionOutcome,
} from './src/actionPostcondition.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { CandidateOptions } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, GoalState, InventoryState, SelfState, WorldState } from './src/state.ts'
import {
  FLINT_AND_STEEL,
  NETHER_PORTAL,
  OVERWORLD,
  PORTAL_LIGHT_REFUSED,
  PORTAL_LIT,
  PORTAL_LIT_PREDICATE,
  PORTAL_VERIFIED,
  PRECONDITION_MISSING,
  isPortalIgnitionPostconditionMet,
  planPortalIgnition,
  portalFrameLayout,
  portalStepToPlannedGoal,
  serializePortalCells,
  validatePortalFrame,
} from './src/netherPortalPlan.ts'
import type { PortalBlockPosition, PortalFrameValidation, PortalStep } from './src/netherPortalPlan.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ORIGIN: PortalBlockPosition = { x: 0, y: 64, z: 0 }

function validFrame(): PortalFrameValidation {
  return validatePortalFrame({ blocks: portalFrameLayout(ORIGIN).frame })
}

function badFrame(): PortalFrameValidation {
  const layout = portalFrameLayout(ORIGIN)
  return validatePortalFrame({ blocks: layout.frame.slice(0, layout.frame.length - 1) })
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_IGNITE',
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

function signals(): AgentSignals {
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
  }
}

function goal(targetItem: string): GoalState {
  return {
    id: `place:${targetItem}`,
    description: `place 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function placeGoal(targetItem: string): QueuedGoal {
  return {
    id: `g-place-${targetItem}`,
    kind: 'place',
    description: `place 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'mechanical',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(focusItem: string, counts: Record<string, number>): WorldState {
  const feet: Vec3Json = { x: 0.5, y: 64, z: 0.5 }
  return {
    schemaVersion: 1,
    tick: 3,
    timestampMs: 1_700_000_000_000,
    self: self(feet),
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    terrain: { standable: [feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: goal(focusItem),
    goalQueue: queueWith(placeGoal(focusItem)),
    recentEvents: [],
    signals: signals(),
  }
}

const ignitionCandidates = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.kind === 'IGNITE')

// ---------------------------------------------------------------------------
// (1) pure ignition decision
// ---------------------------------------------------------------------------

addCase('(1) planPortalIgnition offers a candidate for a valid frame + held flint_and_steel', () => {
  const frame = validFrame()
  const plan = planPortalIgnition({ frame, hasFlintAndSteel: true, dimension: OVERWORLD })
  const pass =
    plan.ok &&
    plan.candidate.lightPosition.x === frame.lightPosition?.x &&
    plan.candidate.lightPosition.y === frame.lightPosition?.y &&
    plan.candidate.lightPosition.z === frame.lightPosition?.z &&
    plan.candidate.portalCells.length === frame.interior.length &&
    plan.candidate.portalCells.length === 6
  return { pass, detail: JSON.stringify(plan) }
})

addCase('(1) planPortalIgnition refuses a valid frame without flint_and_steel: PRECONDITION_MISSING', () => {
  const plan = planPortalIgnition({ frame: validFrame(), hasFlintAndSteel: false })
  const pass =
    !plan.ok &&
    plan.reason === 'missing_tool' &&
    plan.line === `${PRECONDITION_MISSING} tool=${FLINT_AND_STEEL}`
  return { pass, detail: JSON.stringify(plan) }
})

addCase('(1) planPortalIgnition refuses a malformed frame even with flint_and_steel', () => {
  const plan = planPortalIgnition({ frame: badFrame(), hasFlintAndSteel: true })
  const pass = !plan.ok && plan.reason === 'frame_shape_bad' && plan.line.startsWith(PORTAL_LIGHT_REFUSED)
  return { pass, detail: JSON.stringify(plan) }
})

addCase('(3) isPortalIgnitionPostconditionMet requires nether_portal at EVERY expected cell', () => {
  const frame = validFrame()
  const cells = frame.interior
  const allPortal = (): string => NETHER_PORTAL
  const oneAir = (pos: PortalBlockPosition): string =>
    pos.x === cells[0]?.x && pos.y === cells[0]?.y && pos.z === cells[0]?.z ? 'air' : NETHER_PORTAL
  const pass =
    isPortalIgnitionPostconditionMet(cells, allPortal) &&
    !isPortalIgnitionPostconditionMet(cells, oneAir) &&
    !isPortalIgnitionPostconditionMet(cells, () => null) &&
    !isPortalIgnitionPostconditionMet([], allPortal)
  return { pass, detail: `cells=${cells.length} all=${isPortalIgnitionPostconditionMet(cells, allPortal)} oneAir=${isPortalIgnitionPostconditionMet(cells, oneAir)}` }
})

addCase('(3) isIgnitePostconditionMet (actionPostcondition) is strict on the nether_portal name', () => {
  const pass =
    isIgnitePostconditionMet([NETHER_PORTAL, NETHER_PORTAL]) &&
    !isIgnitePostconditionMet([NETHER_PORTAL, 'air']) &&
    !isIgnitePostconditionMet([])
  return { pass, detail: `ok=${isIgnitePostconditionMet([NETHER_PORTAL])} bad=${isIgnitePostconditionMet(['air'])}` }
})

// ---------------------------------------------------------------------------
// (2) candidate generation + refusal
// ---------------------------------------------------------------------------

addCase('(2) an IGNITE candidate is generated only when holding flint_and_steel AND the frame validates', () => {
  const frame = validFrame()
  const options: CandidateOptions = { ...defaultCandidateOptions, portalFrame: frame }
  const armed = generateGroundedCandidates(worldState(NETHER_PORTAL, { flint_and_steel: 1 }), options)
  const unarmed = generateGroundedCandidates(worldState(NETHER_PORTAL, {}), options)

  const armedIgnite = ignitionCandidates(armed.candidates)
  const candidate = armedIgnite[0]
  const cells = frame.interior
  const pass =
    armedIgnite.length === 1 &&
    candidate !== undefined &&
    candidate.target?.x === frame.lightPosition?.x &&
    candidate.target?.y === frame.lightPosition?.y &&
    candidate.target?.z === frame.lightPosition?.z &&
    candidate.meta.portalCells === serializePortalCells(cells) &&
    armed.ignitionRefusal === null &&
    ignitionCandidates(unarmed.candidates).length === 0 &&
    unarmed.ignitionRefusal !== null &&
    unarmed.ignitionRefusal.line === `${PRECONDITION_MISSING} tool=${FLINT_AND_STEEL}`
  return {
    pass,
    detail: `armed=[${armedIgnite.map((c) => c.id).join(',')}] unarmedRefusal=${JSON.stringify(unarmed.ignitionRefusal)}`,
  }
})

addCase('(2) a malformed frame yields no IGNITE candidate and a PORTAL_LIGHT_REFUSED refusal', () => {
  const options: CandidateOptions = { ...defaultCandidateOptions, portalFrame: badFrame() }
  const grounded = generateGroundedCandidates(worldState(NETHER_PORTAL, { flint_and_steel: 1 }), options)
  const pass =
    ignitionCandidates(grounded.candidates).length === 0 &&
    grounded.ignitionRefusal !== null &&
    grounded.ignitionRefusal.reason === 'frame_shape_bad' &&
    grounded.ignitionRefusal.line.startsWith(PORTAL_LIGHT_REFUSED)
  return { pass, detail: JSON.stringify(grounded.ignitionRefusal) }
})

addCase('(2) ignition is goal-directed: no IGNITE candidate while the goal does not target the portal', () => {
  const options: CandidateOptions = { ...defaultCandidateOptions, portalFrame: validFrame() }
  const grounded = generateGroundedCandidates(worldState('diamond', { flint_and_steel: 1 }), options)
  const pass = ignitionCandidates(grounded.candidates).length === 0 && grounded.ignitionRefusal === null
  return { pass, detail: `ignite=${ignitionCandidates(grounded.candidates).length} refusal=${JSON.stringify(grounded.ignitionRefusal)}` }
})

// ---------------------------------------------------------------------------
// (3) portalStepToPlannedGoal no longer drops light/verify
// ---------------------------------------------------------------------------

addCase('(3) light_portal and verify_portal compile to a place nether_portal goal with the portal_lit predicate', () => {
  const light: PortalStep = {
    kind: 'light_portal',
    capabilityId: 'light:nether_portal',
    description: 'light',
    tool: FLINT_AND_STEEL,
    postcondition: { kind: 'portalLit', dimension: OVERWORLD },
    core: true,
  }
  const verify: PortalStep = {
    kind: 'verify_portal',
    capabilityId: 'verify:nether_portal',
    description: 'verify',
    dimension: OVERWORLD,
    postcondition: { kind: 'portalVerified' },
    core: true,
  }
  const lightGoal = portalStepToPlannedGoal(light)
  const verifyGoal = portalStepToPlannedGoal(verify)
  const pass =
    lightGoal !== null &&
    lightGoal.kind === 'place' &&
    lightGoal.targetItem === NETHER_PORTAL &&
    lightGoal.targetPredicate === PORTAL_LIT_PREDICATE &&
    verifyGoal !== null &&
    verifyGoal.kind === 'place' &&
    verifyGoal.targetItem === NETHER_PORTAL &&
    verifyGoal.targetPredicate === PORTAL_LIT_PREDICATE
  return { pass, detail: `light=${JSON.stringify(lightGoal)} verify=${JSON.stringify(verifyGoal)}` }
})

// ---------------------------------------------------------------------------
// (4)(5) executor: leased activateBlock + strict postcondition + markers
// ---------------------------------------------------------------------------

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

interface FakeBlock {
  name: string
  boundingBox: 'block' | 'empty'
  position: P
}

interface IgniteFixture {
  bot: Bot
  port: ActuationPort
  activated: Array<{ x: number; y: number; z: number }>
  equipCalls: number
  lit: () => boolean
}

/**
 * A structural bot + actuation port for the IGNITE path. The world has the
 * frame obsidian, the interior air, and - once `activateBlock` is called - the
 * interior cells become `nether_portal` (unless `detect=false`, the
 * unverified-server case).
 */
function makeIgniteFixture(frame: PortalFrameValidation, opts: { hasTool: boolean; detect: boolean }): IgniteFixture {
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const grid = new Map<string, string>()
  for (let x = -2; x <= 6; x += 1) for (let z = -2; z <= 4; z += 1) grid.set(key(x, 63, z), 'stone')
  const layout = portalFrameLayout(frame.origin ?? ORIGIN, frame.widthAxis)
  for (const cell of layout.frame) grid.set(key(cell.x, cell.y, cell.z), 'obsidian')
  for (const cell of layout.corners) grid.set(key(cell.x, cell.y, cell.z), 'obsidian')
  for (const cell of frame.interior) grid.set(key(cell.x, cell.y, cell.z), 'air')

  let lit = false
  const activated: Array<{ x: number; y: number; z: number }> = []
  let equipCalls = 0
  const feet = new P(0.5, 64, 0.5)
  const blockAt = (v: { x: number; y: number; z: number }): FakeBlock | null => {
    const name = grid.get(key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
    if (name === undefined) return null
    const isInterior = frame.interior.some(
      (cell) => cell.x === Math.floor(v.x) && cell.y === Math.floor(v.y) && cell.z === Math.floor(v.z),
    )
    const observed = lit && isInterior && opts.detect ? NETHER_PORTAL : name
    return {
      name: observed,
      boundingBox: observed === 'air' ? 'empty' : 'block',
      position: new P(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }

  const port: ActuationPort = {
    generationId: 'gen-ignite-test',
    assertLease: () => undefined,
    pathTo: () => undefined,
    stopPath: () => undefined,
    setControls: () => undefined,
    clearControls: () => undefined,
    lookAt: async () => undefined,
    dig: async () => undefined,
    placeBlock: async () => undefined,
    activateItem: async () => undefined,
    activateBlock: async (block) => {
      activated.push({ x: block.position.x, y: block.position.y, z: block.position.z })
      lit = true
    },
    equip: async () => {
      equipCalls += 1
    },
    collect: async () => undefined,
    craft: async () => undefined,
    openContainer: async () => undefined,
    withdrawFromContainer: async () => undefined,
    writeMovementPacket: () => undefined,
    setPose: () => undefined,
  }

  const items = (): Array<{ name: string; type: number; count: number }> =>
    opts.hasTool ? [{ name: FLINT_AND_STEEL, type: 1, count: 1 }] : []
  const bot = {
    registry,
    entity: {
      position: feet,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number) => feet.offset(x, y, z),
      clone: () => feet.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => feet.distanceTo(other),
    },
    _client: { write: () => true },
    physicsEnabled: true,
    health: 20,
    entities: {},
    inventory: {
      items,
      count: () => 0,
    },
    blockAt,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async () => {
      equipCalls += 1
    },
    canDigBlock: () => true,
    dig: async () => undefined,
    stopDigging: () => undefined,
    activateBlock: async (_block: unknown) => {
      lit = true
    },
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown) => {
        bot.pathfinder.movements = movements
      },
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'noPath', path: [] }),
    },
  }

  return { bot: bot as unknown as Bot, port, activated, equipCalls, lit: () => lit }
}

function igniteCandidateFromFrame(frame: PortalFrameValidation): Candidate {
  const options: CandidateOptions = { ...defaultCandidateOptions, portalFrame: frame }
  const grounded = generateGroundedCandidates(worldState(NETHER_PORTAL, { flint_and_steel: 1 }), options)
  const candidate = ignitionCandidates(grounded.candidates)[0]
  if (candidate === undefined) throw new Error('the candidate generator produced no IGNITE candidate')
  return candidate
}

async function runIgnite(fixture: IgniteFixture, candidate: Candidate): Promise<{ logPath: string; result: Awaited<ReturnType<Executor['claim']>['completion']> }> {
  const dir = mkdtempSync(join(tmpdir(), 'ignite-'))
  const logPath = join(dir, 'run.jsonl')
  const executor = new Executor(fixture.bot, new EventLogger(new JsonlWriter(logPath), false), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    actuationPort: fixture.port,
  })
  const result = await fixtureClaim(executor, candidate).completion
  return { logPath, result }
}

function markerIndexes(logPath: string): { lit: number; verified: number; messages: string[] } {
  const messages = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { message: string }).message)
  return {
    lit: messages.findIndex((message) => message.startsWith(PORTAL_LIT)),
    verified: messages.findIndex((message) => message.startsWith(PORTAL_VERIFIED)),
    messages,
  }
}

addCase('(4)(5) the executor activates the leased block at the light position and emits PORTAL_LIT then PORTAL_VERIFIED', async () => {
  const frame = validFrame()
  const fixture = makeIgniteFixture(frame, { hasTool: true, detect: true })
  const candidate = igniteCandidateFromFrame(frame)
  const { logPath, result } = await runIgnite(fixture, candidate)
  const markers = markerIndexes(logPath)
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.kind === 'IGNITE' &&
    fixture.activated.length === 1 &&
    fixture.activated[0]?.x === frame.lightPosition?.x &&
    fixture.activated[0]?.y === frame.lightPosition?.y &&
    fixture.activated[0]?.z === frame.lightPosition?.z &&
    markers.lit >= 0 &&
    markers.verified >= 0 &&
    markers.lit < markers.verified
  return {
    pass,
    detail: `status=${result.status} verified=${result.verified} activated=${JSON.stringify(fixture.activated)} litIdx=${markers.lit} verifiedIdx=${markers.verified}`,
  }
})

addCase('(4) an ignition whose nether_portal never appears fails verify_failed and emits NO marker', async () => {
  const frame = validFrame()
  const fixture = makeIgniteFixture(frame, { hasTool: true, detect: false })
  const candidate = igniteCandidateFromFrame(frame)
  const { logPath, result } = await runIgnite(fixture, candidate)
  const markers = markerIndexes(logPath)
  const pass =
    result.status === 'failed' &&
    result.failure === 'verify_failed' &&
    result.verified === false &&
    fixture.activated.length === 1 &&
    markers.lit === -1 &&
    markers.verified === -1
  return {
    pass,
    detail: `status=${result.status} failure=${result.failure} activated=${fixture.activated.length} litIdx=${markers.lit} verifiedIdx=${markers.verified}`,
  }
})

addCase('(2)(5) a missing flint_and_steel refuses before any activation with PRECONDITION_MISSING', async () => {
  const frame = validFrame()
  const fixture = makeIgniteFixture(frame, { hasTool: false, detect: true })
  // Bypass the generator's own precondition gate to prove the executor re-checks.
  const candidate = igniteCandidateFromFrame(validFrame())
  const { logPath, result } = await runIgnite(fixture, candidate)
  const markers = markerIndexes(logPath)
  const pass =
    result.status === 'failed' &&
    result.detail.includes(PRECONDITION_MISSING) &&
    result.detail.includes(FLINT_AND_STEEL) &&
    fixture.activated.length === 0 &&
    markers.lit === -1 &&
    markers.verified === -1
  return { pass, detail: `status=${result.status} detail=${result.detail} activated=${fixture.activated.length}` }
})

// ---------------------------------------------------------------------------
// (6) truthful-outcome wiring: IGNITE only advances on a proven ignition
// ---------------------------------------------------------------------------

addCase('(6) truthfulActionOutcome accepts a verified IGNITE and rejects an unverified one', () => {
  const verified = truthfulActionOutcome({
    kind: 'IGNITE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
  })
  const unverified = truthfulActionOutcome({
    kind: 'IGNITE',
    status: 'done',
    verified: false,
    itemsGained: 0,
    blockRemoved: false,
  })
  const advances = decideActionOutcome({ kind: 'IGNITE', status: 'done', verified: true, itemsGained: 0, blockRemoved: false })
  const unverifiedAdvances = decideActionOutcome({
    kind: 'IGNITE',
    status: 'done',
    verified: false,
    itemsGained: 0,
    blockRemoved: false,
  })
  const postcondition = describeActionPostcondition('IGNITE')
  const pass =
    verified.verified &&
    verified.status === 'done' &&
    verified.resetsFailureMemory &&
    !unverified.verified &&
    !unverified.resetsFailureMemory &&
    !unverified.observableProgress &&
    advances.advances &&
    !unverifiedAdvances.advances &&
    postcondition.includes(NETHER_PORTAL)
  return {
    pass,
    detail: `verified=${JSON.stringify(verified)} unverified=${JSON.stringify(unverified)} advances=${advances.advances} postcondition=${postcondition}`,
  }
})

let failures = 0
process.stdout.write('LIVE ignition action (Nether portal gate)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} portal-ignite cases passed\n`)
if (failures > 0) process.exit(1)
