// test-nether-transfer.mts - issue #37 primitive #4: the resident can transfer
// dimensions through its own lit Nether portal.
//
// Red-first: this file is added before the source change and fails (the typed
// `enter:nether_portal` operation, `planPortalEntry`, the ENTER_PORTAL candidate
// and the executor's dimension postcondition do not exist), then passes.
//
// What it proves, all offline (no live bot, no clock):
//   (1) the typed `enter_portal` step compiles to `place nether_portal` under the
//       `portal_entered` predicate with `dimension == minecraft:the_nether`;
//   (2) `evaluatePortalPostcondition({dimensionIs})` is true ONLY after the
//       dimension change (never from a portal block / inventory);
//   (3) `planPortalEntry` REFUSES with the existing precondition pattern when the
//       portal is not lit (`PRECONDITION_MISSING portal=lit`) or has no safe
//       approach (`PRECONDITION_MISSING approach=safe_stand`), and grounds when
//       both hold;
//   (4) the candidate layer offers ENTER_PORTAL only for the `portal_entered`
//       goal, never for the ignition goal, and surfaces the typed refusal;
//   (5) the REAL executor walks into the portal and only reports `done/entered`
//       when the bot's dimension actually becomes the Nether; a portal that never
//       transfers is a hard `verify_failed`;
//   (6) a remembered resource from another dimension is never offered as a
//       retrieval target (dimension re-anchoring at the jev layer).
//
// Run: bun jev-agent/test-nether-transfer.mts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  NETHER,
  NETHER_PORTAL,
  OVERWORLD,
  PORTAL_ENTERED,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_ENTER_REFUSED,
  evaluatePortalPostcondition,
  formatPortalEntered,
  netherPortalEntryGoal,
  planPortalEntry,
  portalFrameLayout,
  portalStepToPlannedGoal,
} from './src/netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite, PortalPostconditionSnapshot } from './src/netherPortalPlan.ts'
import {
  defaultCandidateOptions,
  generateGroundedCandidates,
  resourceDimensionMatches,
  staleKnownResources,
} from './src/candidates.ts'
import type { CandidateOptions } from './src/candidates.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'
import { Executor } from './src/executor.ts'
import { classifyMoveArrival, defaultExecutorOptions } from './src/executor.ts'
import { guardCandidate } from './src/policy.ts'
import type { Candidate } from './src/candidates.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const ORIGIN: Vec3Json = { x: 10, y: 64, z: 0 }
const WIDTH_AXIS = 'x' as const
const LAYOUT = portalFrameLayout(ORIGIN, WIDTH_AXIS)
const ENTER_CELL = LAYOUT.lightPosition
// The live geometry: the ground in front of the frame is ONE ROW BELOW the portal
// floor (the frame's solid bottom row is the step up), so the entry is a generic
// one-block climb into the interior cell.
const APPROACH: Vec3Json = { x: ENTER_CELL.x, y: ENTER_CELL.y - 1, z: ENTER_CELL.z - 1 }
const key = (p: Vec3Json): string => `${p.x},${p.y},${p.z}`

// ---------------------------------------------------------------------------
// (1) the typed operation compiles to the transfer goal
// ---------------------------------------------------------------------------
{
  const goal = netherPortalEntryGoal()
  const compiled = portalStepToPlannedGoal({
    kind: 'enter_portal',
    capabilityId: 'enter:nether_portal',
    description: 'enter the lit nether portal',
    dimension: NETHER,
    postcondition: { kind: 'dimensionIs', dimension: NETHER },
  })
  const pass =
    goal.kind === 'place' &&
    goal.targetItem === NETHER_PORTAL &&
    goal.targetPredicate === PORTAL_ENTERED_PREDICATE &&
    goal.dimension === NETHER &&
    compiled.targetPredicate === PORTAL_ENTERED_PREDICATE &&
    compiled.dimension === NETHER &&
    compiled.requiredCount === 1
  check(
    '(1) enter_portal compiles to a place nether_portal goal under portal_entered',
    pass,
    `kind=${goal.kind} item=${goal.targetItem} predicate=${goal.targetPredicate} dimension=${goal.dimension}`,
  )
}

// ---------------------------------------------------------------------------
// (2) the postcondition is the dimension change, nothing else
// ---------------------------------------------------------------------------
{
  const base: PortalPostconditionSnapshot = {
    inventory: { nether_portal: 99 },
    toolRank: 4,
    frame: { shape: 'ok' } as PortalPostconditionSnapshot['frame'],
    lit: true,
    litDimension: OVERWORLD,
    verified: true,
  }
  const inOverworld = evaluatePortalPostcondition({ kind: 'dimensionIs', dimension: NETHER }, { ...base, dimension: OVERWORLD })
  const inNether = evaluatePortalPostcondition({ kind: 'dimensionIs', dimension: NETHER }, { ...base, dimension: NETHER })
  const shorthand = evaluatePortalPostcondition({ kind: 'dimensionIs', dimension: 'the_nether' }, { ...base, dimension: 'minecraft:the_nether' })
  const unknown = evaluatePortalPostcondition({ kind: 'dimensionIs', dimension: NETHER }, { ...base, dimension: null })
  const pass = inOverworld === false && inNether === true && shorthand === true && unknown === false
  check(
    '(2) dimensionIs is true only in the target dimension',
    pass,
    `overworld=${inOverworld} nether=${inNether} shorthand=${shorthand} unknown=${unknown}`,
  )
}

// ---------------------------------------------------------------------------
// (3) planPortalEntry: lit + standable-entry preconditions and typed refusals
// ---------------------------------------------------------------------------
function litBlockAt(site: PortalFrameSite, lit: boolean) {
  const interior = new Set(portalFrameLayout(site.origin, site.widthAxis).interior.map(key))
  return (cell: Vec3Json): string | null => (lit && interior.has(key(cell)) ? NETHER_PORTAL : 'air')
}

const SITE: PortalFrameSite = { origin: ORIGIN, widthAxis: WIDTH_AXIS, safe: true, reachable: true, existingFrame: LAYOUT.frame }
/** The generic locomotion rule proves every cell standable (feet+head clear, support below). */
const STANDABLE = (): boolean => true
/** Nothing is standable: no interior cell the body can occupy. */
const NOT_STANDABLE = (): boolean => false

{
  const notLit = planPortalEntry({
    site: SITE,
    self: { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z - 2 },
    blockAt: litBlockAt(SITE, false),
    isStandable: STANDABLE,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  const noApproach = planPortalEntry({
    site: SITE,
    self: { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z - 2 },
    blockAt: litBlockAt(SITE, true),
    isStandable: NOT_STANDABLE,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  const alreadyThere = planPortalEntry({
    site: SITE,
    self: { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z - 2 },
    blockAt: litBlockAt(SITE, true),
    isStandable: STANDABLE,
    fromDimension: NETHER,
    dimension: NETHER,
  })
  const grounded = planPortalEntry({
    site: SITE,
    self: { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z - 2 },
    blockAt: litBlockAt(SITE, true),
    isStandable: STANDABLE,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  const pass =
    !notLit.ok &&
    notLit.refused === true &&
    notLit.reason === 'portal_not_lit' &&
    notLit.line === 'PRECONDITION_MISSING portal=lit' &&
    !noApproach.ok &&
    noApproach.reason === 'no_safe_approach' &&
    noApproach.line === 'PRECONDITION_MISSING approach=safe_stand' &&
    !alreadyThere.ok &&
    alreadyThere.reason === 'already_in_dimension' &&
    alreadyThere.line.startsWith(`${PORTAL_ENTER_REFUSED} reason=already_in_dimension`) &&
    grounded.ok &&
    grounded.candidate.dimension === NETHER &&
    grounded.candidate.portalCells.length === LAYOUT.interior.length &&
    key(grounded.candidate.enterCell) === key(ENTER_CELL) &&
    grounded.candidate.line === formatPortalEntered(ENTER_CELL, NETHER)
  const detail = `unlit=[${notLit.ok ? 'ok' : notLit.line}] entry=[${noApproach.ok ? 'ok' : noApproach.line}] already=[${alreadyThere.ok ? 'ok' : alreadyThere.line}] ok=${grounded.ok}`
  check(
    '(3) planPortalEntry refuses unlit / unstandable portals and grounds a lit one',
    pass,
    detail,
  )
}

// ---------------------------------------------------------------------------
// candidate-layer helpers
// ---------------------------------------------------------------------------
function self(position: Vec3Json, dimension: string = OVERWORLD): SelfState {
  return {
    username: 'AI_TRANSFER',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension,
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function signals(knownResources: KnownResource[] = []): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources,
  }
}

function queuedPlace(predicate: string, dimension: string): QueuedGoal {
  return {
    id: `g-${predicate}`,
    kind: 'place',
    description: `${predicate} nether_portal`,
    targetItem: NETHER_PORTAL,
    requiredCount: 1,
    targetPredicate: predicate,
    dimension,
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

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  dimension?: string
  portalFrameSites?: PortalFrameSite[]
  knownResources?: KnownResource[]
  blocks?: WorldState['blocks']
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position, overrides.dimension ?? OVERWORLD),
    inventory: inventory({}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: overrides.portalFrameSites,
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: 'g',
      description: 'place nether_portal',
      targetItem: NETHER_PORTAL,
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    signals: signals(overrides.knownResources),
  }
}

function entryPlan(): PortalEntryPlan {
  const plan = planPortalEntry({
    site: SITE,
    self: { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z - 2 },
    blockAt: litBlockAt(SITE, true),
    isStandable: STANDABLE,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  if (!plan.ok) throw new Error('fixture: expected a grounded entry plan')
  return plan
}

// ---------------------------------------------------------------------------
// (4) the candidate layer offers ENTER_PORTAL only for the entry goal
// ---------------------------------------------------------------------------
{
  const entryState = worldState({
    position: { x: ENTER_CELL.x + 0.5, y: ENTER_CELL.y, z: ENTER_CELL.z - 2.5 },
    goalQueue: queueWith(queuedPlace(PORTAL_ENTERED_PREDICATE, NETHER)),
    portalFrameSites: [SITE],
  })
  const entryOptions: CandidateOptions = { ...defaultCandidateOptions, reach: 4.5, portalEntry: entryPlan() }
  const entryGrounded = generateGroundedCandidates(entryState, entryOptions)
  const enter = entryGrounded.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL')

  const ignitionState = worldState({
    position: { x: ENTER_CELL.x + 0.5, y: ENTER_CELL.y, z: ENTER_CELL.z - 2.5 },
    goalQueue: queueWith(queuedPlace('portal_lit', OVERWORLD)),
    portalFrameSites: [SITE],
  })
  const ignitionGrounded = generateGroundedCandidates(ignitionState, entryOptions)
  const strayEnter = ignitionGrounded.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL')

  const refusalState = worldState({
    position: { x: ENTER_CELL.x + 0.5, y: ENTER_CELL.y, z: ENTER_CELL.z - 2.5 },
    goalQueue: queueWith(queuedPlace(PORTAL_ENTERED_PREDICATE, NETHER)),
    portalFrameSites: [SITE],
  })
  const unlitPlan = planPortalEntry({
    site: SITE,
    self: { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z - 2 },
    blockAt: litBlockAt(SITE, false),
    isStandable: STANDABLE,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  const refusalGrounded = generateGroundedCandidates(refusalState, {
    ...defaultCandidateOptions,
    reach: 4.5,
    portalEntry: unlitPlan,
  })

  const pass =
    enter !== undefined &&
    enter.kind === 'ENTER_PORTAL' &&
    enter.target !== null &&
    // The locomotion target is the interior cell itself (no bespoke approach).
    key(enter.target) === key(ENTER_CELL) &&
    enter.meta.dimension === NETHER &&
    enter.meta.enterX === ENTER_CELL.x &&
    enter.meta.enterY === ENTER_CELL.y &&
    enter.meta.enterZ === ENTER_CELL.z &&
    enter.meta.approachX === undefined &&
    enter.meta.approachY === undefined &&
    enter.meta.approachZ === undefined &&
    strayEnter === undefined &&
    refusalGrounded.entryRefusal !== null &&
    refusalGrounded.entryRefusal.line === 'PRECONDITION_MISSING portal=lit'
  check(
    '(4) ENTER_PORTAL targets the interior cell and is offered only for the entry goal',
    pass,
    `enter=${enter?.id ?? 'none'} target=${JSON.stringify(enter?.target)} stray=${strayEnter?.id ?? 'none'} refusal=${refusalGrounded.entryRefusal?.line ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (5) the REAL executor: dimension change is the only success
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

function makeEnterBot(feet: Vec3Json) {
  const portalCells = new Set(LAYOUT.interior.map(key))
  const grid = new Map<string, string>()
  for (const cell of LAYOUT.frame) grid.set(key(cell), 'obsidian')
  for (const cell of LAYOUT.interior) grid.set(key(cell), NETHER_PORTAL)
  grid.set(key({ x: APPROACH.x, y: APPROACH.y - 1, z: APPROACH.z }), 'stone')
  grid.set(key({ x: ENTER_CELL.x, y: ENTER_CELL.y - 1, z: ENTER_CELL.z }), 'obsidian')
  const blockAt = (v: { x: number; y: number; z: number }) => {
    const name = grid.get(`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`)
    if (name === undefined) return null
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: new P(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) }
  }
  const position = new P(feet.x, feet.y, feet.z)
  const bot = {
    registry,
    game: { dimension: 'overworld' as string },
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number) => position.offset(x, y, z),
      clone: () => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => position.distanceTo(other),
    },
    _client: { write: () => true },
    physicsEnabled: true,
    entities: {},
    inventory: {
      items: (): Array<{ name: string; type: number; count: number }> => [],
      count: () => 0,
    },
    heldItem: null,
    blockAt,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
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
  return { bot: bot as unknown as Bot, grid, portalCells, position }
}

function enterCandidate() {
  return {
    id: `ENTER:${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`,
    kind: 'ENTER_PORTAL' as const,
    label: 'walk into the lit nether portal',
    targetName: NETHER_PORTAL,
    // The interior cell is the locomotion target now: no bespoke approach cell.
    target: { ...ENTER_CELL },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      tick: 9,
      enterX: ENTER_CELL.x,
      enterY: ENTER_CELL.y,
      enterZ: ENTER_CELL.z,
      dimension: NETHER,
      portalCells: LAYOUT.interior.map(key).join(';'),
    },
  }
}

async function runEnter(transfer: boolean) {
  const fixture = makeEnterBot(APPROACH)
  const dir = mkdtempSync(join(tmpdir(), 'nether-transfer-'))
  const logPath = join(dir, 'agent.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet', portalEnterTimeoutMs: 400 })
  // The GENERIC locomotion stub: record the target the entry asked the ordinary
  // mover for, step the body into that interior cell, and (for the success case)
  // let the server-side transfer change the dimension. Nothing portal-specific
  // is injected: the entry path is `pathTo`, exactly like a MOVE.
  const calls: Vec3Json[] = []
  ;(executor as unknown as {
    pathTo: (target: Vec3Json, epoch: number, signal: AbortSignal, goalKind: string, fallback?: unknown) => Promise<void>
  }).pathTo = async (target) => {
    calls.push({ ...target })
    fixture.position.set(ENTER_CELL.x + 0.5, ENTER_CELL.y, ENTER_CELL.z + 0.5)
    if (transfer) fixture.bot.game.dimension = 'the_nether'
  }
  const result = await executor.claim(enterCandidate()).completion
  const messages = (await Bun.file(logPath).text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { message?: string }).message ?? '')
  return { result, messages, calls }
}

{
  const success = await runEnter(true)
  const failure = await runEnter(false)
  const enteredLines = success.messages.filter((line) => line.startsWith(PORTAL_ENTERED))
  const pass =
    success.result.status === 'done' &&
    success.result.verified === true &&
    success.result.failure === null &&
    // Fixture (a): the entry movement target is the interior cell, reached by
    // the generic locomotion path (no bespoke approach / direct-bearing walk).
    success.calls.length === 1 &&
    key(success.calls[0] ?? { x: -1, y: -1, z: -1 }) === key(ENTER_CELL) &&
    enteredLines.length === 1 &&
    enteredLines[0] === formatPortalEntered(ENTER_CELL, NETHER) &&
    failure.result.status === 'failed' &&
    failure.result.failure === 'verify_failed' &&
    failure.messages.every((line) => !line.startsWith(PORTAL_ENTERED))
  check(
    '(5) executor reports done/entered only after dimension == the_nether',
    pass,
    `success=${success.result.status}/${success.result.failure ?? 'none'} verified=${success.result.verified} pathTo=${JSON.stringify(success.calls[0])} marker=[${enteredLines[0] ?? 'none'}] noTransfer=${failure.result.status}/${failure.result.failure ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (6) remembered resources are dimension-scoped
// ---------------------------------------------------------------------------
{
  const overworldOre: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 12, y: 40, z: 5 }, dimension: OVERWORLD }
  const netherOre: KnownResource = { name: 'nether_quartz_ore', kind: 'ore', position: { x: 12, y: 40, z: 5 }, dimension: NETHER }
  const legacy: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 1, y: 2, z: 3 } }
  const inOverworld = worldState({
    position: { x: 12, y: 40, z: 5 },
    dimension: OVERWORLD,
    goalQueue: queueWith(queuedPlace(PORTAL_ENTERED_PREDICATE, NETHER)),
    knownResources: [overworldOre, netherOre, legacy],
    // The live block at the overworld ore cell is gone -> it is provably mined.
    blocks: [],
  })
  const stale = staleKnownResources(inOverworld)
  const pass =
    resourceDimensionMatches(overworldOre, OVERWORLD) === true &&
    resourceDimensionMatches(overworldOre, NETHER) === false &&
    resourceDimensionMatches(legacy, OVERWORLD) === true &&
    resourceDimensionMatches(netherOre, NETHER) === true &&
    stale.length === 1 &&
    stale[0]?.name === 'iron_ore' &&
    stale.some((resource) => resource.dimension === NETHER) === false
  check(
    '(6) a remembered resource from another dimension is never a retrieval target',
    pass,
    `stale=${stale.map((resource) => `${resource.name}@${resource.dimension ?? 'legacy'}`).join(',') || 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (7) the generic MOVE machinery is not portal-specific: a NON-PORTAL, non-solid
//     standable cell is an ordinary movement target (guard + arrival)
// ---------------------------------------------------------------------------
{
  const CELL: Vec3Json = { x: 5, y: 70, z: 5 }
  const state = worldState({
    position: { x: CELL.x, y: CELL.y, z: CELL.z - 1 },
    goalQueue: queueWith(queuedPlace(PORTAL_ENTERED_PREDICATE, NETHER)),
  })
  // The generic sensor lists a non-solid cell (e.g. short_grass over stone) as
  // standable; nothing portal-specific is involved. `isStandable` itself is
  // pinned in test-portal-entry-generic.mts; here the MOVE machinery must accept
  // that cell exactly like any other.
  state.terrain = { standable: [CELL, { x: CELL.x, y: CELL.y, z: CELL.z - 1 }] }
  const move: Candidate = {
    id: `MOVE:p${CELL.x}_${CELL.y}_${CELL.z}`,
    kind: 'MOVE',
    label: 'walk to a standable spot',
    targetName: null,
    target: { ...CELL },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 9 },
  }
  const guard = guardCandidate(move, state, {
    phase: 'decision',
    candidateIds: new Set([move.id]),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 100,
  })
  const arrival = classifyMoveArrival({
    end: { x: CELL.x + 0.5, y: CELL.y, z: CELL.z + 0.5 },
    target: CELL,
    anchor: null,
    anchorBefore: null,
    anchorDistance: 0,
    reach: 4.5,
    pinned: false,
  })
  const pass = guard.ok === true && arrival.verified === true
  check(
    '(7) a non-portal, non-solid standable cell is an ordinary MOVE target (generic locomotion)',
    pass,
    `guard=${guard.ok ? 'ok' : guard.reason} arrival=${arrival.verified}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
