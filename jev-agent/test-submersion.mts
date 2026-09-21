// test-submersion.mts - P1 durability: the body's breath and water state.
//
// OPERATOR REPORT 2026-09-21: the agent "made two crafting tables underwater and
// drowned". Measured from the live log (source 7beaa81):
//
//   16:58:59.092Z ACTION id=ATTACK:e4698 phase=closing-to-melee-range pos=68.5,59.0,27.6
//   16:59:12.608Z ACTION id=ATTACK:e4698 phase=closing-to-melee-range pos=68.5,57.0,28.5
//   16:59:34.792Z DEATH pos=67.5,58.3,28.5 dimension=minecraft:overworld
//   16:59:34.794Z LADDER_RESET reason=death invEmpty=false cause=water simulated=false
//
// `ATTACK:e4698` was a goal-drop hunt for `salmon`: the lease followed the fish
// down the water column while `resource=salmon` stayed unmet, and NOTHING in the
// repo read `bot.oxygenLevel` (grep for `oxygen` found zero references), so no
// layer owned "do not keep working while the body is out of air".
//
// Red-first: the source changes that make these cases pass are the sensor facts
// (`SelfState.air/feetInWater/eyesInWater`, `submergedPlacementSpots`), the
// scheduler `low_air` preempt, the candidate submersion restriction, the guard
// `SUBMERGED` code and the executor's typed `place_refused`/`submerged` outcomes.
//
// Run: bun test ./test-submersion.mts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  bodyIsOutOfAir,
  bodySubmersion,
  buildWorldState,
  defaultSensorOptions,
  formatBodySubmerged,
  LOW_AIR_LEVEL,
  MAX_AIR,
} from './src/state.ts'
import type { AgentSignals, GoalState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import {
  dryAwarePlacementSpots,
  restrictCandidatesDuringSubmersion,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import {
  CRITICAL_TRIGGERS,
  questionSetForTrigger,
} from './src/controller.ts'
import { guardCandidate, guardRejectionChargesOption } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import {
  DecisionScheduler,
  formatLowAirPreempt,
  LOW_AIR_PREEMPT,
  PREEMPTIVE_TRIGGERS,
  shouldInterruptAttackLease,
  TRIGGER_PRIORITY,
} from './src/scheduler.ts'
import type { DecisionTrigger } from './src/scheduler.ts'
import { defaultExecutorOptions, Executor } from './src/executor.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const Vec3 = require('vec3')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${p.x},${p.y},${p.z}`

function makeLogger(): { logger: EventLogger; messages: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'submersion-'))
  const logPath = join(dir, 'agent.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  return {
    logger,
    messages: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => (JSON.parse(line) as { message?: string }).message ?? ''),
  }
}

// ---------------------------------------------------------------------------
// (c1) the SENSOR owns the missing fact: air, feet/eyes water, wet-access spots
// ---------------------------------------------------------------------------
// The measured body was at (67.5,58.3,28.5) with its head under water and no
// air fact anywhere. This drives the real `buildWorldState` over a structural
// fake world where the body stands in a water column next to one placement spot
// that is only reachable through water and one that has dry access.
{
  const ORIGIN: Vec3Json = { x: 1, y: 64, z: 0 }
  const WATER_SPOT: Vec3Json = { x: 2, y: 64, z: 0 }
  const DRY_SPOT: Vec3Json = { x: 3, y: 64, z: 2 }
  const grid = new Map<string, string>()
  for (let x = -4; x <= 6; x += 1) {
    for (let z = -4; z <= 6; z += 1) {
      for (let y = 60; y <= 68; y += 1) grid.set(`${x},${y},${z}`, y === 63 ? 'stone' : 'air')
    }
  }
  // The body's own column is water (feet + head), so it is submerged.
  for (let y = 64; y <= 65; y += 1) {
    for (let x = 1; x <= 3; x += 1) {
      for (let z = -1; z <= 1; z += 1) grid.set(`${x},${y},${z}`, 'water')
    }
  }
  // The wet placement spot is an air pocket inside that water: every standable
  // neighbour is a fluid column.
  grid.set(key(WATER_SPOT), 'air')
  grid.set(`${WATER_SPOT.x},${WATER_SPOT.y + 1},${WATER_SPOT.z}`, 'air')
  // The dry spot has a dry standable neighbour at (3,64,1)... which is water, so
  // its dry neighbour is (2,64,2): air with solid support and air above.
  grid.set(key(DRY_SPOT), 'air')
  grid.set(`${DRY_SPOT.x},${DRY_SPOT.y + 1},${DRY_SPOT.z}`, 'air')
  const blockAt = (v: Vec3Json) => {
    const name = grid.get(key({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }))
    if (name === undefined) return null
    return { name, boundingBox: name === 'air' ? ('empty' as const) : name === 'water' ? ('empty' as const) : ('block' as const), diggable: name === 'stone' }
  }
  const position = new Vec3(ORIGIN.x + 0.5, ORIGIN.y, ORIGIN.z + 0.5)
  const bot = {
    username: 'AI_SUBMERGE',
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
    },
    health: 20,
    food: 20,
    oxygenLevel: 3,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => [] },
    blockAt,
    canSeeBlock: () => true,
    findBlocks: () => [],
  } as unknown as Bot

  const goal: GoalState = {
    id: 'place:furnace',
    description: 'place 1 x furnace',
    targetItem: 'furnace',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
  const signals: AgentSignals = {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
  }
  const state = buildWorldState(
    bot,
    {
      tick: 1,
      goal,
      goalQueue: { depth: 1, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
      recentEvents: [],
      signals,
    },
    { ...defaultSensorOptions, maxPlacementSpots: 24 },
  )
  const submersion = bodySubmersion(state.self)
  const wetKeys = new Set((state.submergedPlacementSpots ?? []).map(key))
  const dry = dryAwarePlacementSpots(state)
  const pass =
    state.self.air === 3 &&
    state.self.feetInWater === true &&
    state.self.eyesInWater === true &&
    submersion.state === 'out_of_air' &&
    bodyIsOutOfAir(state.self) === true &&
    wetKeys.has(key(WATER_SPOT)) &&
    dry.some((spot) => key(spot) === key(DRY_SPOT)) &&
    !dry.some((spot) => key(spot) === key(WATER_SPOT)) &&
    dry.length > 0
  check(
    '(c1) the sensor exposes breath + water cells and the wet-access placement spot',
    pass,
    `air=${state.self.air} feetWet=${state.self.feetInWater} headWet=${state.self.eyesInWater} state=${submersion.state} ` +
      `spots=${state.placementSpots.length} wet=${[...wetKeys].join('|') || 'none'} dryAlternatives=${dry.map(key).join('|')}`,
  )
}

// ---------------------------------------------------------------------------
// (c2) the SCHEDULER owns the preempt: low air is a typed, edge-triggered event
// ---------------------------------------------------------------------------
{
  type Handler = (...args: unknown[]) => void
  const handlers = new Map<string, Handler[]>()
  const bot = {
    entity: { position: { x: 67.5, y: 58.3, z: 28.5 } },
    health: 20,
    food: 20,
    oxygenLevel: MAX_AIR,
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    removeListener: () => undefined,
    inventory: { on: () => undefined, removeListener: () => undefined },
  }
  const { logger, messages } = makeLogger()
  const events: Array<{ trigger: DecisionTrigger; detail: Record<string, unknown> }> = []
  const scheduler = new DecisionScheduler(bot as unknown as Bot, logger, {
    heartbeatMs: 3_600_000,
    enabledTriggers: ['low_air'],
    coalesceMs: 1,
  })
  scheduler.start()
  scheduler.onDecision((event) => events.push({ trigger: event.trigger, detail: event.detail }))
  const breath = (air: number): void => {
    bot.oxygenLevel = air
    for (const handler of handlers.get('breath') ?? []) handler()
  }
  breath(MAX_AIR)
  breath(12) // above the SAFE threshold: no preempt
  breath(10) // band 2 -> preempt 1
  breath(8) // same band -> silent
  breath(9) // band 1 -> preempt 2
  breath(4) // band 0 -> preempt 3
  breath(20) // surfaced: re-arm
  breath(5) // band 1 -> preempt 4
  scheduler.stop()

  const preempts = events.filter((event) => event.trigger === 'low_air')
  const lines = messages().filter((line) => line.startsWith(LOW_AIR_PREEMPT))
  const pass =
    PREEMPTIVE_TRIGGERS.has('low_air') &&
    TRIGGER_PRIORITY.low_air >= TRIGGER_PRIORITY.mob_appeared &&
    CRITICAL_TRIGGERS.has('low_air') &&
    questionSetForTrigger('low_air') === 'threat' &&
    shouldInterruptAttackLease('low_air', 20, 6, 4) === true &&
    shouldInterruptAttackLease('low_air', 20, 6, MAX_AIR) === false &&
    shouldInterruptAttackLease('hp_changed', 5) === true &&
    shouldInterruptAttackLease('action_completed', 1) === false &&
    preempts.length === 4 &&
    preempts.every((event) => event.detail.threshold === LOW_AIR_LEVEL) &&
    lines.length === 4 &&
    lines[0] === formatLowAirPreempt(10, { x: 67.5, y: 58.3, z: 28.5 })
  check(
    '(c2) low air is a typed preemptive trigger, edge-triggered per air band',
    pass,
    `preempts=${preempts.length} lines=${lines.length} first="${lines[0] ?? 'none'}" priority=${TRIGGER_PRIORITY.low_air}`,
  )
}

// ---------------------------------------------------------------------------
// (c3) the CANDIDATE layer keeps only routes that can end the submersion
// ---------------------------------------------------------------------------
{
  const candidate = (id: string, kind: Candidate['kind']): Candidate => ({
    id,
    kind,
    label: id,
    targetName: null,
    target: null,
    targetEntityId: kind === 'ATTACK' ? 7 : null,
    itemName: kind === 'PLACE' ? 'furnace' : null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  })
  const all = [
    candidate('ATTACK:e7', 'ATTACK'),
    candidate('PLACE:furnace:p2_64_0', 'PLACE'),
    candidate('ASCEND:surface:p1_65_0', 'MOVE'),
    candidate('RETREAT:p0_64_0', 'RETREAT'),
    candidate('WAIT', 'WAIT'),
  ]
  const drowning: Pick<WorldState, 'self'> = {
    self: { ...({} as SelfState), air: 3, feetInWater: true, eyesInWater: true },
  }
  const dryBody: Pick<WorldState, 'self'> = { self: { ...({} as SelfState), air: MAX_AIR } }
  const kept = restrictCandidatesDuringSubmersion(drowning, all).map((entry) => entry.id)
  const untouched = restrictCandidatesDuringSubmersion(dryBody, all).map((entry) => entry.id)
  const noRescue = restrictCandidatesDuringSubmersion(drowning, [all[0]!, all[1]!, all[4]!]).map((entry) => entry.id)
  const pass =
    kept.length === 2 &&
    kept.includes('ASCEND:surface:p1_65_0') &&
    kept.includes('RETREAT:p0_64_0') &&
    !kept.includes('ATTACK:e7') &&
    !kept.includes('PLACE:furnace:p2_64_0') &&
    untouched.length === all.length &&
    noRescue.length === 3
  check(
    '(c3) an out-of-air body is only offered routes that can end the submersion',
    pass,
    `kept=${kept.join('|')} untouched=${untouched.length} noRescue=${noRescue.length}`,
  )
}

// ---------------------------------------------------------------------------
// (c4) the GUARD owns the refusal: PLACE/ATTACK from a drowning body
// ---------------------------------------------------------------------------
{
  const self: SelfState = {
    username: 'AI_SUBMERGE',
    position: { x: 2.5, y: 64, z: 0.5 },
    eyePosition: { x: 2.5, y: 65.62, z: 0.5 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
    air: 2,
    feetInWater: true,
    eyesInWater: true,
  }
  const place: Candidate = {
    id: 'PLACE:furnace:p2_64_0',
    kind: 'PLACE',
    label: 'place furnace',
    targetName: 'furnace',
    target: { x: 2, y: 64, z: 0 },
    targetEntityId: null,
    itemName: 'furnace',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
  const attack: Candidate = {
    ...place,
    id: 'ATTACK:e7',
    kind: 'ATTACK',
    targetName: 'salmon',
    target: { x: 70, y: 57, z: 30 },
    targetEntityId: 7,
    itemName: null,
  }
  const state = {
    schemaVersion: 1 as const,
    tick: 1,
    timestampMs: 0,
    self,
    inventory: { slots: [], counts: { furnace: 1 }, totalItems: 1 },
    entities: [{ id: 7, name: 'salmon', kind: 'salmon', username: null, position: { x: 70, y: 57, z: 30 }, distance: 12, hostile: false }],
    blocks: [],
    terrain: { standable: [] },
    placementSpots: [{ x: 2, y: 64, z: 0 }],
    submergedPlacementSpots: [{ x: 2, y: 64, z: 0 }],
    craftingTables: [],
    furnaces: [],
    goal: { id: 'g', description: 'place furnace', targetItem: 'furnace', requiredCount: 1, startCount: 0, haveCount: 0, progress: 0, complete: false, startedAtMs: 0 },
    goalQueue: { depth: 1, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle' as const,
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
    },
  } as unknown as WorldState
  const context: GuardContext = {
    phase: 'decision',
    candidateIds: new Set([place.id, attack.id]),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 100,
  }
  const places = guardCandidate(place, state, context)
  const attacks = guardCandidate(attack, state, context)
  const dryState = { ...state, self: { ...self, air: MAX_AIR, feetInWater: false, eyesInWater: false } } as WorldState
  const dryPlace = guardCandidate(place, dryState, context)
  const pass =
    places.ok === false &&
    places.code === 'SUBMERGED' &&
    attacks.ok === false &&
    attacks.code === 'SUBMERGED' &&
    dryPlace.ok === true &&
    guardRejectionChargesOption('SUBMERGED') === false
  check(
    '(c4) the guard refuses PLACE/ATTACK with typed SUBMERGED and does not charge the option',
    pass,
    `place=${places.ok ? 'ok' : places.code} attack=${attacks.ok ? 'ok' : attacks.code} dryPlace=${dryPlace.ok ? 'ok' : dryPlace.code} charges=${guardRejectionChargesOption('SUBMERGED')} ` +
      `reason="${places.ok ? '' : places.reason}"`,
  )
}

// ---------------------------------------------------------------------------
// executor fixtures: the mechanical half of the same facts
// ---------------------------------------------------------------------------
interface PlaceWorld {
  bot: Bot
  grid: Map<string, string>
  placeCalls: Vec3Json[]
}

/**
 * A structural fake world for the executor's single-cell PLACE path: a stone
 * floor at y=63, air above, an optional water column around the body, and a
 * `placeBlock` behaviour chosen by the case (succeed / refuse).
 */
function makeExecutorWorld(options: {
  feet: Vec3Json
  target: Vec3Json
  air: number
  waterBody: boolean
  refusePlace: boolean
}): PlaceWorld {
  const grid = new Map<string, string>()
  for (let x = -3; x <= 8; x += 1) {
    for (let z = -3; z <= 8; z += 1) {
      for (let y = 60; y <= 68; y += 1) grid.set(`${x},${y},${z}`, y === 63 ? 'stone' : 'air')
    }
  }
  if (options.waterBody) {
    for (let y = options.feet.y; y <= options.feet.y + 1; y += 1) {
      grid.set(`${options.feet.x},${y},${options.feet.z}`, 'water')
    }
  }
  const blockAt = (v: Vec3Json) => {
    const name = grid.get(key({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }))
    if (name === undefined) return null
    return {
      name,
      boundingBox: name === 'stone' ? ('block' as const) : ('empty' as const),
      diggable: name === 'stone',
      position: { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) },
    }
  }
  const position = new Vec3(options.feet.x + 0.5, options.feet.y, options.feet.z + 0.5)
  const placeCalls: Vec3Json[] = []
  const obsidianId = (registry.itemsByName as Record<string, { id: number }>).furnace?.id ?? 0
  let heldName: string | null = null
  const bot = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
    },
    oxygenLevel: options.air,
    health: 20,
    food: 20,
    _client: { write: () => true },
    physicsEnabled: true,
    entities: {},
    inventory: {
      count: (id: number) => (id === obsidianId ? 1 : 0),
      items: () => [{ name: 'furnace', type: obsidianId, count: 1 }],
    },
    get heldItem(): { name: string } | null {
      return heldName === null ? null : { name: heldName }
    },
    blockAt,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async (item: { name: string }) => {
      heldName = item.name
    },
    canDigBlock: () => true,
    dig: async () => undefined,
    placeBlock: async (block: { position: Vec3Json }, face: Vec3Json): Promise<void> => {
      const placed = { x: block.position.x + face.x, y: block.position.y + face.y, z: block.position.z + face.z }
      placeCalls.push(placed)
      if (options.refusePlace) {
        // Exactly what mineflayer throws when the server refuses the placement
        // (`lib/plugins/place_block.js`: the observed block never changed).
        throw new Error(
          `Server refused to place ${heldName ?? 'block'} at (${placed.x}, ${placed.y}, ${placed.z}): the block is still air`,
        )
      }
      grid.set(key(placed), heldName ?? 'furnace')
    },
    pathfinder: {
      movements: null as unknown,
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'noPath', path: [] }),
    },
  }
  return { bot: bot as unknown as Bot, grid, placeCalls }
}

function placeCandidate(target: Vec3Json, id = `PLACE:furnace:p${target.x}_${target.y}_${target.z}`): Candidate {
  return {
    id,
    kind: 'PLACE',
    label: `place furnace at (${target.x},${target.y},${target.z})`,
    targetName: 'furnace',
    target,
    targetEntityId: null,
    itemName: 'furnace',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

// ---------------------------------------------------------------------------
// (b) the REAL cause of the furnace PLACE retry loop: `place_refused`
// ---------------------------------------------------------------------------
// Live 2026-09-21T16:29:56.736Z (gen-mubgihtb-0p7plw):
//   action#163 PLACE:furnace:p57_59_-3 FAILED
//   {"failure":"unknown_event","message":"Server refused to place furnace at
//    (57, 59, -3): the block is still air"}
// Ten retries were logged as `reason=unknown_event` because the mechanism's own
// refusal is a plain `Error`, not an `ExecutorError`.
{
  const target: Vec3Json = { x: 3, y: 64, z: 1 }
  const world = makeExecutorWorld({ feet: { x: 2, y: 64, z: 0 }, target, air: MAX_AIR, waterBody: false, refusePlace: true })
  const { logger, messages } = makeLogger()
  const executor = new Executor(world.bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const result = await executor.claim(placeCandidate(target)).completion
  const refusedLine = messages().find((line) => line.includes('FAILED'))
  const pass =
    result.status === 'failed' &&
    result.failure === 'place_refused' &&
    result.verified === false &&
    world.grid.get(key(target)) === 'air'
  check(
    '(b) a server-refused placement fails typed `place_refused`, never `unknown_event`',
    pass,
    `status=${result.status} failure=${result.failure} block=${world.grid.get(key(target))} detail="${result.detail}" log="${refusedLine ?? 'none'}"`,
  )
}

// ---------------------------------------------------------------------------
// (d) a DRY placement still completes (the safety rule must not block work)
// ---------------------------------------------------------------------------
{
  const target: Vec3Json = { x: 3, y: 64, z: 1 }
  const world = makeExecutorWorld({ feet: { x: 2, y: 64, z: 0 }, target, air: MAX_AIR, waterBody: false, refusePlace: false })
  const { logger } = makeLogger()
  const executor = new Executor(world.bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const result = await executor.claim(placeCandidate(target)).completion
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    world.grid.get(key(target)) === 'furnace' &&
    world.placeCalls.length === 1
  check(
    '(d) a dry placement still completes and verifies',
    pass,
    `status=${result.status} verified=${result.verified} block=${world.grid.get(key(target))} calls=${world.placeCalls.length}`,
  )
}

// ---------------------------------------------------------------------------
// (c5) a drowning body cannot place, and an ATTACK lease stops typed
// ---------------------------------------------------------------------------
{
  const target: Vec3Json = { x: 3, y: 64, z: 1 }
  const wet = makeExecutorWorld({ feet: { x: 2, y: 64, z: 0 }, target, air: 3, waterBody: true, refusePlace: false })
  const { logger, messages } = makeLogger()
  const executor = new Executor(wet.bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const placed = await executor.claim(placeCandidate(target)).completion
  const submergedLines = messages().filter((line) => line.startsWith('BODY_SUBMERGED'))
  const pass =
    placed.status === 'failed' &&
    placed.failure === 'submerged' &&
    wet.placeCalls.length === 0 &&
    submergedLines.length === 1 &&
    submergedLines[0] === formatBodySubmerged({ air: 3, feetInWater: true, eyesInWater: true, state: 'out_of_air' }, target)
  check(
    '(c5) a body out of air fails PLACE with typed `submerged` and emits BODY_SUBMERGED',
    pass,
    `status=${placed.status} failure=${placed.failure} placeCalls=${wet.placeCalls.length} line="${submergedLines[0] ?? 'none'}"`,
  )
}

{
  const feet: Vec3Json = { x: 68, y: 57, z: 28 }
  const grid = new Map<string, string>()
  for (let x = 60; x <= 75; x += 1) {
    for (let z = 20; z <= 35; z += 1) {
      for (let y = 55; y <= 68; y += 1) grid.set(`${x},${y},${z}`, y <= 56 ? 'stone' : 'air')
    }
  }
  for (let y = 57; y <= 58; y += 1) grid.set(`68,${y},28`, 'water')
  const blockAt = (v: Vec3Json) => {
    const name = grid.get(key({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }))
    if (name === undefined) return null
    return { name, boundingBox: name === 'stone' ? ('block' as const) : ('empty' as const), diggable: name === 'stone' }
  }
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const pathGoals: unknown[] = []
  const bot = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
    },
    // The measured body: health 20, breath almost gone, head under water.
    oxygenLevel: 2,
    health: 20,
    food: 20,
    _client: { write: () => true },
    physicsEnabled: true,
    entities: {
      4698: { id: 4698, name: 'salmon', kind: 'salmon', position: { x: 74, y: 57, z: 31 }, height: 0.6, width: 0.6 },
    },
    inventory: { count: () => 0, items: () => [] },
    heldItem: null,
    blockAt,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async () => undefined,
    attack: () => undefined,
    canDigBlock: () => true,
    dig: async () => undefined,
    placeBlock: async () => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: () => undefined,
      setGoal: (goal: unknown) => pathGoals.push(goal),
      stop: () => undefined,
      getPathTo: () => ({ status: 'noPath', path: [] }),
    },
  }
  const attack: Candidate = {
    id: 'ATTACK:e4698',
    kind: 'ATTACK',
    label: 'hunt salmon 8m away for salmon',
    targetName: 'salmon',
    target: { x: 74, y: 57, z: 31 },
    targetEntityId: 4698,
    itemName: 'salmon',
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 1, entityId: 4698, goalDrop: 'salmon', requiresKill: true },
  }
  const { logger, messages } = makeLogger()
  const executor = new Executor(bot as unknown as Bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const result = await executor.claim(attack).completion
  const submergedLines = messages().filter((line) => line.startsWith('BODY_SUBMERGED'))
  const pass =
    result.status === 'failed' &&
    result.failure === 'submerged' &&
    submergedLines.length === 1 &&
    result.detail.includes('breath at 2/20')
  check(
    '(c5) a goal-drop ATTACK lease stops typed `submerged` instead of following the target under water',
    pass,
    `status=${result.status} failure=${result.failure} bodySubmerged=${submergedLines.length} pathGoals=${pathGoals.length} detail="${result.detail}"`,
  )
}

process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${failures === 0 ? 'all' : String(failures) + ' failing'} submersion cases\n`)
if (failures > 0) process.exit(1)
