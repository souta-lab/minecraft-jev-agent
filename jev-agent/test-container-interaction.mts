// test-container-interaction.mts - the generic CONTAINER capability.
//
// Measured gap on main c348bb1: the station family was `furnace | crafting_table`
// only, so a container block (chest / trapped_chest / barrel / shulker box /
// ender_chest) was invisible to every sensor table, was never a station-approach
// target, could never be opened, and its contents could never be withdrawn.
// `actuationPort.ts:63` declared a generic `openContainer`, but its only consumer
// was the furnace-specific `executor.ts:6397 openFurnace`; `grep withdraw` found
// nothing. An operator's supplied shulker box - an ITEM handed over, or a BLOCK
// already standing at the Nether gate - was therefore dead weight.
//
// This suite drives the REAL Executor and the REAL candidate layer over
// structural doubles (no bot, no network, no model) and locks:
//   (A) the sensor/candidate half: a container standing in the world (sensed or
//       remembered) is offered as an OPEN step whose label says `contents
//       unknown`; the offer is WITHHELD while the goal already has a grounded
//       route of its own; an unreachable one and one with no block truth yield
//       typed refusals; every container name is protected from mining.
//   (B) held -> placed: a verified shulker_box placement emits CONTAINER_READY
//       (the durable world fact) and an unverified one emits nothing.
//   (C) open -> observe -> withdraw: the withdraw candidate exists only after an
//       observation, carries the truthful container ref, and the transfer moves
//       exactly the observed count; the marker names what was taken and what
//       remained.
//   (D) fail-closed: a transfer outside the envelope takes nothing, a wrong
//       container ref is refused, a transfer above the declared count is a
//       violation, and an OPEN selection has no transfer authority at all.
//   (E) empty: a typed CONTAINER_EMPTY + `contents=empty` observation, never a
//       silent success and never a withdrawal candidate.
//   (F) unreachable / occluded / open-timeout / block-gone: typed refusals that
//       never call the open.
//   (G) world preservation: a placed container is refused at the dig boundary.
//   (H) the ordinary furnace smelt contract is unchanged.
//   (K/L/M) the LIVE SHAPES of 2026-09-22 (m3-live buddy.log), replayed from the
//       save: (K1) the out-of-reach container Jev chose and the guard refused
//       with `NO_PATH ... (GoalBlock probe)` against the container's own cell -
//       reproduced BEFORE, allowed AFTER through its interaction stand; (K2) a
//       container 26 m away, outside the 16 m near-field scan, offered from
//       durable memory and guard-allowed; (L1) a container no stand can SEE is
//       refused `occluded` / `no_stand_with_line_of_sight` and never opened;
//       (L2) the live 16:03 geometry - the portal-cell stand is blocked by the
//       frame's obsidian column while the stands beside the box see it;
//       (M1) the control: a container-free world is byte-identical to the
//       pristine base's candidate list.
//
// Run: bun test-container-interaction.mts
import type { Bot } from 'mineflayer'
import { createRequire } from 'node:module'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import { blockSightFromStand } from './src/executor.ts'
import { guardDecision } from './src/policy.ts'
import { defaultCandidateOptions, generateCandidates, generateGroundedCandidates } from './src/candidates.ts'
import { placedContainerReadyLine } from './src/executor.ts'
import { effectEnvelopeHash, effectViolation, envelopeForCandidate } from './src/skillCommitment.ts'
import { isProtectedStationBlock, PROTECTED_STATION_BLOCKS } from './src/blockSafety.ts'
import { CONTAINER_BLOCK_NAMES, formatContainerRefusal } from './src/containerAccess.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import { MIRRORED_MARKERS, mirroredEventToken } from './src/controller.ts'
import { buildWorldState, defaultSensorOptions } from './src/state.ts'
import type { Candidate } from './src/candidates.ts'
import type { EffectEnvelope } from './src/skillCommitment.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, GoalState, InventoryState, StationEntry, Vec3Json, WorldState } from './src/state.ts'

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

// ---------------------------------------------------------------------------
// structural doubles
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

interface Slot {
  name: string
  type: number
  count: number
}

interface ContainerBotFixture {
  bot: Bot
  /** every `openContainer(block, face)` the executor issued */
  openCalls: Array<{ block: string; face: Vec3Json | null }>
  /** every `withdraw(itemType, metadata, count)` the window issued */
  withdrawCalls: Array<{ name: string; count: number }>
  /** how many times a window was closed (including a late window after a timeout) */
  closed: () => number
  /** the live container contents */
  containerSlots: Array<Slot | null>
  /** the live player inventory */
  inventorySlots: Array<Slot | null>
  /** the fake window's own container view (fixtures mutate this directly) */
  window: () => FakeContainerWindow
  /** every `placeBlock` the executor issued */
  placeCalls: Array<{ name: string; at: Vec3Json }>
  /** the live block grid (a placement mutates it) */
  blocks: Map<string, string>
}

interface FakeContainerWindow {
  type: string
  id: number
  inventoryStart: number
  inventoryEnd: number
  slots: Array<Slot | null>
  itemsRange: (start: number, end: number) => Slot[]
  withdraw: (itemType: number, metadata: number | null, count: number) => Promise<unknown>
  close: () => void
}

function itemId(name: string): number {
  const item = (registry.itemsByName as Record<string, { id: number }>)[name]
  if (item === undefined) throw new Error(`unknown item ${name}`)
  return item.id
}

/**
 * A structural bot with only what the container path reads: the block grid, the
 * entity feet, a stub pathfinder, an `openContainer` that records the face, and
 * a window whose `withdraw` really moves items between the container and the
 * player inventory (so `itemsGained` is a measured delta, not an echo).
 */
function makeContainerBot(config: {
  feet: Vec3Json
  blocks: Map<string, string>
  containerSlots: Array<Slot | null>
  inventorySlots?: Array<Slot | null>
  /** present -> answers the line-of-sight read; absent -> no occlusion fact */
  canSeeBlock?: (block: FakeBlock) => boolean
  /**
   * present -> answers `bot.world.raycast` (the sight-aware interaction-stand
   * filter). Returns the first SOLID cell on the segment, or null for no hit.
   */
  sightCast?: (from: Vec3Json, to: Vec3Json) => Vec3Json | null
  /** 'never' keeps the open promise pending forever (the 20 s wedge shape) */
  openMode?: 'normal' | 'never' | 'late'
  lateOpenMs?: number
}): ContainerBotFixture {
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const position = new P(config.feet.x, config.feet.y, config.feet.z)
  const openCalls: Array<{ block: string; face: Vec3Json | null }> = []
  const withdrawCalls: Array<{ name: string; count: number }> = []
  const placeCalls: Array<{ name: string; at: Vec3Json }> = []
  const containerSlots = config.containerSlots
  const inventorySlots: Array<Slot | null> = config.inventorySlots ?? new Array<Slot | null>(36).fill(null)
  let closeCount = 0
  let current: FakeContainerWindow | null = null

  const blockAt = (v: { x: number; y: number; z: number }): FakeBlock | null => {
    const name = config.blocks.get(key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
    const resolved = name ?? 'air'
    return {
      name: resolved,
      boundingBox: resolved === 'air' ? 'empty' : 'block',
      position: new P(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }

  const makeWindow = (): FakeContainerWindow => {
    const window: FakeContainerWindow = {
      type: 'minecraft:generic_9x3',
      id: 1,
      inventoryStart: containerSlots.length,
      inventoryEnd: containerSlots.length + inventorySlots.length,
      slots: [...containerSlots, ...inventorySlots],
      itemsRange: (start: number, end: number) =>
        window.slots.slice(start, end).filter((slot): slot is Slot => slot !== null && slot.count > 0),
      withdraw: async (itemType: number, _metadata: number | null, count: number) => {
        const source = containerSlots.find((slot) => slot !== null && slot.type === itemType && slot.count > 0)
        if (source === undefined || source === null) throw new Error(`Can't find item ${itemType} in the container`)
        const moved = Math.min(count, source.count)
        const target = inventorySlots.find((slot) => slot !== null && slot.type === itemType)
        if (target !== undefined && target !== null) {
          target.count += moved
        } else {
          const empty = inventorySlots.findIndex((slot) => slot === null)
          if (empty < 0) throw new Error('Unable to withdraw, Bot inventory is full.')
          inventorySlots[empty] = { name: source.name, type: source.type, count: moved }
        }
        source.count -= moved
        withdrawCalls.push({ name: source.name, count: moved })
        window.slots = [...containerSlots, ...inventorySlots]
      },
      close: () => {
        closeCount += 1
        current = null
      },
    }
    return window
  }

  const bot = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      eyeHeight: 1.62,
      offset: (x: number, y: number, z: number) => position.offset(x, y, z),
      clone: () => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => position.distanceTo(other),
    },
    _client: { write: () => true },
    physicsEnabled: true,
    entities: {},
    get currentWindow(): FakeContainerWindow | null {
      return current
    },
    inventory: {
      slots: inventorySlots,
      items: (): Slot[] => inventorySlots.filter((slot): slot is Slot => slot !== null && slot.count > 0),
      count: (id: number, _metadata: number | null) =>
        inventorySlots.reduce((sum, slot) => (slot !== null && slot.type === id ? sum + slot.count : sum), 0),
      emptySlotCount: () => inventorySlots.filter((slot) => slot === null).length,
    },
    blockAt,
    ...(config.canSeeBlock === undefined ? {} : { canSeeBlock: (block: FakeBlock) => config.canSeeBlock?.(block) ?? true }),
    ...(config.sightCast === undefined
      ? {}
      : {
          world: {
            raycast: (
              origin: { x: number; y: number; z: number },
              direction: { x: number; y: number; z: number },
              range: number,
            ): { position: Vec3Json } | null => {
              const from = { x: origin.x, y: origin.y, z: origin.z }
              const to = {
                x: origin.x + direction.x * range,
                y: origin.y + direction.y * range,
                z: origin.z + direction.z * range,
              }
              const hit = config.sightCast?.(from, to) ?? null
              return hit === null ? null : { position: hit }
            },
          },
        }),
    heldItem: null as Slot | null,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async (item: Slot) => {
      bot.heldItem = item
    },
    placeBlock: async (reference: FakeBlock, face: { x: number; y: number; z: number }) => {
      const at = { x: reference.position.x + face.x, y: reference.position.y + face.y, z: reference.position.z + face.z }
      const held = bot.heldItem
      if (held === null) throw new Error('no item in hand')
      placeCalls.push({ name: held.name, at })
      // The server-side effect: the held block now occupies the cell. The held
      // stack is consumed, exactly like a real placement.
      config.blocks.set(key(at.x, at.y, at.z), held.name)
      const slot = inventorySlots.find((entry) => entry !== null && entry.name === held.name)
      if (slot !== undefined && slot !== null) {
        slot.count -= 1
        if (slot.count <= 0) inventorySlots[inventorySlots.indexOf(slot)] = null
      }
      bot.heldItem = null
    },
    canDigBlock: () => true,
    dig: async () => undefined,
    stopDigging: () => undefined,
    craft: async () => undefined,
    recipesFor: () => [],
    openContainer: async (_block: unknown, face?: { x: number; y: number; z: number }): Promise<unknown> => {
      openCalls.push({ block: (_block as { name?: string })?.name ?? 'unknown', face: face === undefined ? null : { x: face.x, y: face.y, z: face.z } })
      const mode = config.openMode ?? 'normal'
      if (mode === 'never') return new Promise<never>(() => undefined)
      if (mode === 'late') {
        const window = makeWindow()
        await new Promise((resolve) => setTimeout(resolve, config.lateOpenMs ?? 40))
        current = window
        return window
      }
      const window = makeWindow()
      current = window
      return window
    },
    clickWindow: async () => undefined,
    putSelectedItemRange: async () => undefined,
    closeWindow: async () => undefined,
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

  return {
    bot: bot as unknown as Bot,
    openCalls,
    withdrawCalls,
    closed: () => closeCount,
    containerSlots,
    inventorySlots,
    window: () => current as FakeContainerWindow,
    placeCalls,
    blocks: config.blocks,
  }
}

/** A floor at y=63 plus the given blocks; every unlisted cell is open air. */
function terrain(blocks: Record<string, string> = {}): Map<string, string> {
  const map = new Map<string, string>()
  for (let x = -3; x <= 5; x += 1) for (let z = -3; z <= 3; z += 1) map.set(`${x},63,${z}`, 'stone')
  for (const [cell, name] of Object.entries(blocks)) map.set(cell, name)
  return map
}

class CapturingLogger extends EventLogger {
  readonly lines: string[] = []
  readonly warnings: string[] = []
  /** the structured detail of every mirrored line, keyed by the marker token */
  readonly details = new Map<string, Array<Record<string, unknown>>>()
  constructor() {
    super(null, false)
  }
  override info(_source: string, message: string, detail: Record<string, unknown> = {}): void {
    this.lines.push(message)
    this.remember(message, detail)
  }
  override warn(_source: string, message: string, detail: Record<string, unknown> = {}): void {
    this.warnings.push(message)
    this.remember(message, detail)
  }
  private remember(message: string, detail: Record<string, unknown>): void {
    const token = message.split(' ')[0] ?? ''
    const list = this.details.get(token) ?? []
    list.push(detail)
    this.details.set(token, list)
  }
  detailFor(token: string): Record<string, unknown> | undefined {
    return this.details.get(token)?.[0]
  }
}

// ---------------------------------------------------------------------------
// world-state builders (candidate layer, pure)
// ---------------------------------------------------------------------------

const CONTAINER_CELL: Vec3Json = { x: 1, y: 64, z: 0 }
const STAND_FEET: Vec3Json = { x: 2.5, y: 64, z: 0.5 }

function inventory(counts: Record<string, number>): InventoryState {
  return {
    slots: Object.entries(counts).map(([name, count], slot) => ({ name, count, slot })),
    counts,
    totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0),
  }
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

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function queued(targetItem: string, kind: QueuedGoal['kind'] = 'collect'): QueuedGoal {
  return {
    id: `g-${kind}-${targetItem}`,
    kind,
    description: `${kind} ${targetItem}`,
    targetItem,
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

function goalFor(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function worldState(overrides: {
  containers?: StationEntry[]
  containerContents?: WorldState['containerContents']
  inventory?: Record<string, number>
  goalQueue?: GoalQueueState
  goal?: GoalState
  placementSpots?: Vec3Json[]
  blocks?: WorldState['blocks']
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 92,
    timestampMs: 1_700_000_000_000,
    self: {
      username: 'AI_CONTAINER',
      position: { x: 0.5, y: 64, z: 0.5 },
      eyePosition: { x: 0.5, y: 65.62, z: 0.5 },
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 20,
      food: 20,
      gameMode: 'survival',
      dimension: 'overworld',
      isDay: true,
      heldItem: null,
    },
    inventory: inventory(overrides.inventory ?? {}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: [{ x: 0, y: 64, z: 0 }] },
    craftingTables: [],
    furnaces: [],
    containers: overrides.containers ?? [],
    ...(overrides.containerContents === undefined ? {} : { containerContents: overrides.containerContents }),
    placementSpots: overrides.placementSpots ?? [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: overrides.goal ?? goalFor('iron_ingot'),
    goalQueue: overrides.goalQueue ?? emptyGoalQueueState(),
    recentEvents: [],
    signals: signals(),
  }
}

function containerCandidates(state: WorldState, options = defaultCandidateOptions): Candidate[] {
  return generateCandidates(state, options).filter((candidate) => candidate.kind === 'CONTAINER')
}

function openCandidates(state: WorldState, options = defaultCandidateOptions): Candidate[] {
  return containerCandidates(state, options).filter((candidate) => candidate.meta.containerAction === 'open')
}

function withdrawCandidates(state: WorldState, options = defaultCandidateOptions): Candidate[] {
  return containerCandidates(state, options).filter((candidate) => candidate.meta.containerAction === 'withdraw')
}

const SENSED_CHEST: StationEntry = { ...CONTAINER_CELL, source: 'sensed', name: 'chest' }
const SENSED_SHULKER: StationEntry = { ...CONTAINER_CELL, source: 'sensed', name: 'shulker_box' }

function observed(items: Array<{ name: string; count: number }>, containers: StationEntry[] = [SENSED_CHEST]): WorldState {
  return worldState({
    containers,
    containerContents: [
      { container: 'chest@1,64,0', block: 'chest', position: CONTAINER_CELL, items, observedAt: 1 },
    ],
  })
}

// ---------------------------------------------------------------------------
// (A) the sensor/candidate half: a container standing in the world is noticed
// ---------------------------------------------------------------------------

addCase('(A1) a sensed container with UNKNOWN contents is offered as an OPEN step that says so', () => {
  const state = worldState({ containers: [SENSED_SHULKER], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const opens = openCandidates(state)
  const candidate = opens[0]
  const pass =
    opens.length === 1 &&
    candidate !== undefined &&
    candidate.id === 'CONTAINER:open:shulker_box@1,64,0' &&
    candidate.itemName === null &&
    candidate.targetName === 'shulker_box' &&
    candidate.meta.containerRef === 'shulker_box@1,64,0' &&
    candidate.meta.containerContents === 'unknown' &&
    candidate.label.includes('contents unknown') &&
    withdrawCandidates(state).length === 0 &&
    generateGroundedCandidates(state, defaultCandidateOptions).containerRefusals.length === 0
  return {
    pass,
    detail: `opens=[${opens.map((entry) => entry.id).join(' ')}] label="${candidate?.label ?? 'none'}" withdraws=${withdrawCandidates(state).length}`,
  }
})

addCase('(A2) a goal with NO grounded source of its own is offered the OPEN probe (the reason to go)', () => {
  // `collect ender_pearl` with nothing sensed and no producer route: the body
  // has nothing of its own to advance the goal, and a container of unknown
  // content is the one grounded supply source it can still examine. The offer
  // claims nothing about what is inside.
  const state = worldState({
    containers: [SENSED_CHEST],
    goal: goalFor('ender_pearl'),
    goalQueue: queueWith({ ...queued('ender_pearl'), kind: 'collect' }),
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const opens = grounded.candidates.filter((candidate) => candidate.kind === 'CONTAINER')
  const advancing = grounded.candidates.filter((candidate) => candidate.meta.containerProducer !== undefined)
  const pass = opens.length === 1 && opens[0]?.id === 'CONTAINER:open:chest@1,64,0' && advancing.length === 0
  return { pass, detail: `container=[${opens.map((entry) => entry.id).join(' ')}] advancing=${advancing.length}` }
})

addCase('(A3) an UNOPENED container is offered even while the goal has a route of its own (bounded inspection)', () => {
  const placeGoal: QueuedGoal = { ...queued('furnace'), kind: 'place', description: 'place furnace' }
  const state = worldState({
    containers: [SENSED_CHEST],
    goal: goalFor('furnace'),
    goalQueue: queueWith(placeGoal),
    inventory: { furnace: 1 },
    placementSpots: [{ x: 3, y: 64, z: 0 }],
  })
  const all = generateCandidates(state, defaultCandidateOptions)
  const place = all.filter((candidate) => candidate.kind === 'PLACE')
  const opens = all.filter((candidate) => candidate.kind === 'CONTAINER')
  // Rule change (operator: "use the relief supplies"): an UNOPENED container is a
  // bounded, self-limiting INSPECTION - once opened, the observation is recorded and
  // this arm stops offering it - so it is offered alongside the goal's own route
  // rather than only when the goal has none. Both are present and Jev chooses; code
  // ranks neither. The route itself must still be present, or this test would pass
  // for the wrong reason.
  const pass = place.length > 0 && opens.length === 1 && opens[0]?.kind === 'CONTAINER'
  return { pass, detail: `place=[${place.map((entry) => entry.id).join(' ')}] container=[${opens.map((entry) => entry.id).join(' ')}]` }
})

addCase('(A4) a container cell with no block truth is a typed UNREACHABLE refusal, never skipped', () => {
  const state = worldState({
    containers: [{ ...CONTAINER_CELL, source: 'remembered' }],
    goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }),
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const refusal = grounded.containerRefusals[0]
  const line = refusal === undefined ? '' : formatContainerRefusal(refusal)
  const pass =
    grounded.containerRefusals.length === 1 &&
    refusal?.reason === 'unreachable' &&
    refusal?.detail === 'block_unknown' &&
    line.startsWith('CONTAINER_REFUSED reason=unreachable ') &&
    grounded.candidates.filter((candidate) => candidate.kind === 'CONTAINER').length === 0
  return { pass, detail: `refusals=${grounded.containerRefusals.length} line="${line}"` }
})

addCase('(A5) a container whose interaction approach is refused yields a typed UNREACHABLE refusal', () => {
  const state = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const options = {
    ...defaultCandidateOptions,
    reachability: { memory: null, stationApproach: () => ({ approach: null, path: null }) },
  }
  const grounded = generateGroundedCandidates(state, options)
  const refusal = grounded.containerRefusals[0]
  const pass =
    refusal?.reason === 'unreachable' &&
    refusal?.detail === 'no_interaction_stand_or_path' &&
    refusal?.container === 'chest@1,64,0' &&
    grounded.candidates.filter((candidate) => candidate.kind === 'CONTAINER').length === 0
  return { pass, detail: `refusal=${refusal === undefined ? 'none' : formatContainerRefusal(refusal)}` }
})

addCase('(A6) every container name is protected from mining like a crafting table', () => {
  const names = [...CONTAINER_BLOCK_NAMES]
  const unprotected = names.filter((name) => !isProtectedStationBlock(name))
  const prior = ['crafting_table', 'furnace', 'blast_furnace', 'smoker'].filter((name) => !PROTECTED_STATION_BLOCKS.has(name))
  const namespaced = isProtectedStationBlock('minecraft:shulker_box')
  const pass = names.length === 21 && unprotected.length === 0 && prior.length === 0 && namespaced && !isProtectedStationBlock('dirt')
  return { pass, detail: `names=${names.length} unprotected=[${unprotected.join(',')}] priorMissing=[${prior.join(',')}] namespaced=${namespaced}` }
})

// ---------------------------------------------------------------------------
// (A7) the SENSOR half: a container standing in the world is sensed by the real
// `buildWorldState` scan, exactly like a crafting table or a furnace
// ---------------------------------------------------------------------------

/** Live-sensor double: `sensed` maps block name -> the cells the scan can see. */
function sensorBot(sensed: Record<string, Vec3Json[]>): Parameters<typeof buildWorldState>[0] {
  const Vec3Class = require('vec3')
  const position = new Vec3Class(0.5, 64, 0.5)
  const cells = new Map<string, string>()
  for (const [name, positions] of Object.entries(sensed)) {
    for (const cell of positions) cells.set(`${cell.x},${cell.y},${cell.z}`, name)
  }
  const findBlocks = (options: { matching: (block: { name: string }) => boolean; maxDistance: number; count: number }): unknown[] => {
    const origin = new Vec3Class(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    const out: unknown[] = []
    for (const [key, name] of cells) {
      if (!options.matching({ name })) continue
      const [x, y, z] = key.split(',').map((entry) => Number(entry))
      const block = new Vec3Class(x, y, z)
      if (block.distanceTo(origin) <= options.maxDistance) out.push(block)
    }
    return out.slice(0, options.count)
  }
  const blockAt = (point: { x: number; y: number; z: number }): unknown => {
    const name = cells.get(`${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`)
    if (name === undefined) return null
    return { name, position: new Vec3Class(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)), boundingBox: 'block', diggable: true }
  }
  return {
    username: 'AI_CONTAINER_SENSE',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry: null,
    entities: {},
    inventory: { items: () => [] },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
  } as never
}

addCase('(A7) the real sensor projects a placed shulker box into state.containers and the OPEN offer follows', () => {
  const bot = sensorBot({ shulker_box: [{ x: 1, y: 64, z: 0 }] })
  const state = buildWorldState(
    bot,
    {
      tick: 1,
      goal: goalFor('iron_ingot'),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'iron_ingot',
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
  const sensed = state.containers?.find((entry) => entry.x === 1 && entry.y === 64 && entry.z === 0)
  const opens = openCandidates(state)
  const pass =
    sensed?.source === 'sensed' &&
    sensed?.name === 'shulker_box' &&
    state.containers?.length === 1 &&
    opens.length === 1 &&
    opens[0]?.id === 'CONTAINER:open:shulker_box@1,64,0' &&
    opens[0]?.meta.containerContents === 'unknown'
  return { pass, detail: `containers=${JSON.stringify(state.containers)} opens=[${opens.map((entry) => entry.id).join(' ')}]` }
})

addCase('(A8) a durable remembered container is merged into the sensor as source=remembered with its block name', () => {
  const bot = sensorBot({})
  const state = buildWorldState(
    bot,
    {
      tick: 1,
      goal: goalFor('iron_ingot'),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'iron_ingot',
      recentEvents: [],
      signals: signals(),
      rememberedStations: [{ name: 'barrel', kind: 'station', position: { x: 6, y: 40, z: -2 } }],
    },
    defaultSensorOptions,
  )
  const remembered = state.containers?.find((entry) => entry.x === 6 && entry.y === 40 && entry.z === -2)
  const opens = openCandidates(state)
  const pass =
    remembered?.source === 'remembered' &&
    remembered?.name === 'barrel' &&
    opens.length === 1 &&
    opens[0]?.id === 'CONTAINER:open:barrel@6,40,-2'
  return { pass, detail: `containers=${JSON.stringify(state.containers)} opens=[${opens.map((entry) => entry.id).join(' ')}]` }
})

// ---------------------------------------------------------------------------
// (B) held -> placed: the placement is the durable world fact
// ---------------------------------------------------------------------------

addCase('(B1) a verified shulker_box placement emits CONTAINER_READY; an unverified one emits nothing', () => {
  const ready = placedContainerReadyLine('shulker_box', 'shulker_box', CONTAINER_CELL)
  const wrongBlock = placedContainerReadyLine('shulker_box', 'air', CONTAINER_CELL)
  const notAContainer = placedContainerReadyLine('furnace', 'furnace', CONTAINER_CELL)
  const pass =
    ready === 'CONTAINER_READY source=placed block=shulker_box at=1,64,0' &&
    wrongBlock === null &&
    notAContainer === null
  return { pass, detail: `ready="${ready ?? 'null'}" unverified=${wrongBlock ?? 'null'} furnace=${notAContainer ?? 'null'}` }
})

addCase('(B2) a verified chest placement (the same path) also emits CONTAINER_READY for its own block', () => {
  const ready = placedContainerReadyLine('chest', 'chest', { x: -3, y: 64, z: 7 })
  const pass = ready === 'CONTAINER_READY source=placed block=chest at=-3,64,7'
  return { pass, detail: `ready="${ready ?? 'null'}"` }
})

addCase('(B3) held -> placed -> opened -> withdrawn: the whole chain with the real Executor', async () => {
  // 1. The operator hands over a shulker box: it is an ITEM in the inventory and
  //    the goal is to place it, so the ordinary PLACE family offers the step.
  const cell: Vec3Json = { x: 3, y: 64, z: 0 }
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain(),
    // The shulker box's contents are already inside the box (they arrive with
    // it); the body cannot see them until it opens the placed block.
    containerSlots: [
      { name: 'iron_ingot', type: itemId('iron_ingot'), count: 5 },
      { name: 'golden_apple', type: itemId('golden_apple'), count: 1 },
      null,
    ],
    inventorySlots: [{ name: 'shulker_box', type: itemId('shulker_box'), count: 1 }, ...new Array<Slot | null>(35).fill(null)],
  })
  const placeGoal: QueuedGoal = { ...queued('shulker_box', 'place'), description: 'place shulker_box' }
  const placeState = worldState({
    goal: goalFor('shulker_box'),
    goalQueue: queueWith(placeGoal),
    inventory: { shulker_box: 1 },
    placementSpots: [cell],
  })
  const placeCandidate = generateCandidates(placeState, defaultCandidateOptions).find((candidate) => candidate.kind === 'PLACE')
  if (placeCandidate === undefined) return { pass: false, detail: 'no PLACE candidate for the held shulker_box' }
  const { executor, logger } = containerExecutor(fixture, { goalItem: 'iron_ingot' })
  const placeResult = await executor.claim(placeCandidate).completion
  const readyLine = logger.lines.find((line) => line.startsWith('CONTAINER_READY '))
  const placedBlock = fixture.blocks.get(`${cell.x},${cell.y},${cell.z}`)

  // 2. The next tick SENSES the block that is now standing there (the same state
  //    builder the body uses), and the OPEN step appears with contents unknown.
  const placedState = worldState({ containers: [{ ...cell, source: 'sensed', name: 'shulker_box' }] })
  const openCandidate = containerCandidateAt(placedState, 'open')
  const openResult = await executor.claim(openCandidate).completion
  const openLine = logger.lines.find((line) => line.startsWith('CONTAINER_OPEN '))

  // 3. The observation grounds the transfers; the body takes what the goal wants.
  const next = { ...placedState, containerContents: executor.containerContents() }
  const withdraws = withdrawCandidates(next)
  const ingot = withdraws.find((candidate) => candidate.itemName === 'iron_ingot')
  const withdrawResult = ingot === undefined ? null : await executor.claim(ingot).completion
  const transferLine = logger.lines.find((line) => line.startsWith('CONTAINER_TRANSFER '))
  const held = fixture.inventorySlots.reduce((sum, slot) => (slot?.name === 'iron_ingot' ? sum + slot.count : sum), 0)
  const pass =
    placeResult.status === 'done' &&
    placeResult.verified === true &&
    fixture.placeCalls.length === 1 &&
    fixture.placeCalls[0]?.name === 'shulker_box' &&
    placedBlock === 'shulker_box' &&
    readyLine === 'CONTAINER_READY source=placed block=shulker_box at=3,64,0' &&
    // The mirrored detail carries the exact keys the host durable-fact mapper
    // consumes (`block` + a `target` cell object): the marker text alone is not
    // enough, the host reads the structured detail.
    logger.detailFor('CONTAINER_READY')?.block === 'shulker_box' &&
    JSON.stringify(logger.detailFor('CONTAINER_READY')?.target) === JSON.stringify(cell) &&
    logger.detailFor('CONTAINER_READY')?.source === 'placed' &&
    openResult.status === 'done' &&
    openLine === 'CONTAINER_OPEN container=shulker_box@3,64,0 contents=known slots=2 items=iron_ingot:5,golden_apple:1' &&
    withdraws.length === 2 &&
    withdrawResult?.itemsGained === 5 &&
    transferLine === 'CONTAINER_TRANSFER container=shulker_box@3,64,0 item=iron_ingot taken=5 remaining=0' &&
    held === 5
  return {
    pass,
    detail: `place=${placeResult.status}/${placeResult.verified} block=${placedBlock} ready="${readyLine ?? 'none'}" open="${openLine ?? 'none'}" withdraws=${withdraws.length} took=${withdrawResult?.itemsGained} transfer="${transferLine ?? 'none'}" held=${held}`,
  }
})

// ---------------------------------------------------------------------------
// (C)+(D)+(E)+(F)+(G) the real Executor
// ---------------------------------------------------------------------------

function containerCandidateAt(state: WorldState, action: 'open' | 'withdraw', item: string | null = null): Candidate {
  const matches = containerCandidates(state).filter(
    (candidate) => candidate.meta.containerAction === action && (item === null || candidate.itemName === item),
  )
  const candidate = matches[0]
  if (candidate === undefined) throw new Error(`no CONTAINER ${action} candidate in the grounded set`)
  return candidate
}

function containerExecutor(fixture: ContainerBotFixture, options: Partial<typeof defaultExecutorOptions> = {}, logger = new CapturingLogger()): { executor: Executor; logger: CapturingLogger } {
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
    maxStepsPerWaypoint: 5,
    goalItem: 'iron_ingot',
    ...options,
  })
  return { executor, logger }
}

addCase('(C1) open -> observe -> withdraw: the real Executor transfers exactly the observed items and reports both sides', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [
      { name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 },
      { name: 'oak_planks', type: itemId('oak_planks'), count: 2 },
      null,
    ],
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture)
  const openResult = await executor.claim(containerCandidateAt(seed, 'open')).completion
  const openLine = logger.lines.find((line) => line.startsWith('CONTAINER_OPEN '))
  // The observation is the ONLY thing that makes a withdraw groundable: the next
  // tick's state carries it, and the withdraw candidates appear from it.
  const next = { ...seed, containerContents: executor.containerContents() }
  const withdraws = withdrawCandidates(next)
  const ingot = withdraws.find((candidate) => candidate.itemName === 'iron_ingot')
  const planks = withdraws.find((candidate) => candidate.itemName === 'oak_planks')
  const withdrawResult = ingot === undefined ? null : await executor.claim(ingot).completion
  const transferLine = logger.lines.find((line) => line.startsWith('CONTAINER_TRANSFER '))
  const remaining = fixture.containerSlots.find((slot) => slot?.name === 'iron_ingot')?.count ?? 0
  const held = fixture.inventorySlots.reduce((sum, slot) => (slot?.name === 'iron_ingot' ? sum + slot.count : sum), 0)
  // The ledger is refreshed from the LIVE window after the transfer: the taken
  // stack is gone from it, so the next tick cannot re-offer what the body holds.
  const after = executor.containerContents()[0]
  const afterIngot = after?.items.find((stack) => stack.name === 'iron_ingot')
  const reOffered = withdrawCandidates({ ...next, containerContents: executor.containerContents() }).filter(
    (candidate) => candidate.itemName === 'iron_ingot',
  )
  const pass =
    openResult.status === 'done' &&
    openResult.verified === true &&
    openLine === 'CONTAINER_OPEN container=chest@1,64,0 contents=known slots=2 items=iron_ingot:3,oak_planks:2' &&
    withdraws.length === 2 &&
    ingot?.meta.containerRef === 'chest@1,64,0' &&
    ingot?.meta.containerCount === 3 &&
    ingot?.meta.containerProducer === 'iron_ingot' &&
    planks?.meta.containerProducer === undefined &&
    withdrawResult?.status === 'done' &&
    withdrawResult.verified === true &&
    withdrawResult.itemsGained === 3 &&
    transferLine === 'CONTAINER_TRANSFER container=chest@1,64,0 item=iron_ingot taken=3 remaining=0' &&
    remaining === 0 &&
    held === 3 &&
    fixture.openCalls.length === 2 &&
    fixture.openCalls.every((call) => call.face?.x === 1 && call.face.y === 0 && call.face.z === 0) &&
    afterIngot === undefined &&
    reOffered.length === 0
  return {
    pass,
    detail: `open=${openResult.status}/${openResult.verified} openLine="${openLine ?? 'none'}" withdraws=[${withdraws.map((entry) => entry.id).join(' ')}] result=${withdrawResult?.status}/${withdrawResult?.itemsGained} transfer="${transferLine ?? 'none'}" remaining=${remaining} held=${held} ledgerAfter=[${(after?.items ?? []).map((stack) => `${stack.name}:${stack.count}`).join(',')}] reOffered=${reOffered.length} faces=${JSON.stringify(fixture.openCalls.map((call) => call.face))}`,
  }
})

addCase('(C2) a container that grew after the observation is moved only by the DECLARED count (no silent emptying)', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture)
  const observedState = observed([{ name: 'iron_ingot', count: 3 }])
  const declared = containerCandidateAt(observedState, 'withdraw', 'iron_ingot')
  // Someone added 5 more while the body walked over: the envelope still declares
  // the 3 the selection observed, so only 3 move and 5 remain.
  fixture.containerSlots[0]!.count = 8
  const result = await executor.claim(declared).completion
  const transferLine = logger.lines.find((line) => line.startsWith('CONTAINER_TRANSFER '))
  const pass =
    result.status === 'done' &&
    result.itemsGained === 3 &&
    transferLine === 'CONTAINER_TRANSFER container=chest@1,64,0 item=iron_ingot taken=3 remaining=5' &&
    fixture.containerSlots[0]!.count === 5
  return { pass, detail: `result=${result.status}/${result.itemsGained} transfer="${transferLine ?? 'none'}" left=${fixture.containerSlots[0]!.count}` }
})

addCase('(C3) an OPEN selection has no transfer authority: a transfer outside the envelope takes nothing', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const openCandidate = containerCandidateAt(seed, 'open')
  const openEnvelope = envelopeForCandidate(openCandidate, { stations: ['chest'], transfers: [] })
  // The envelope the OPEN selection derives carries the station but no transfer.
  const transferInside = effectViolation(openEnvelope, { type: 'transfer', itemName: 'iron_ingot', count: 3, container: 'chest@1,64,0' })
  const { executor, logger } = containerExecutor(fixture, { effectEnvelopeOverride: openEnvelope })
  // A withdraw candidate forced through the OPEN envelope must fail closed.
  const withdrawCandidate = { ...containerCandidateAt(observed([{ name: 'iron_ingot', count: 3 }]), 'withdraw', 'iron_ingot') }
  const result = await executor.claim(withdrawCandidate).completion
  const transferLine = logger.lines.find((line) => line.startsWith('CONTAINER_TRANSFER '))
  const held = fixture.inventorySlots.reduce((sum, slot) => (slot?.name === 'iron_ingot' ? sum + slot.count : sum), 0)
  const pass =
    transferInside === 'transfer_not_declared:iron_ingot->chest@1,64,0' &&
    result.status === 'failed' &&
    result.failure === 'effect_envelope_violation' &&
    held === 0 &&
    transferLine === undefined &&
    fixture.withdrawCalls.length === 0
  return { pass, detail: `violation="${transferInside ?? 'none'}" status=${result.status}/${result.failure} held=${held} withdrawCalls=${fixture.withdrawCalls.length}` }
})

addCase('(C4) a transfer declared for a DIFFERENT container is refused (the ref is the container identity)', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
  })
  const candidate = containerCandidateAt(observed([{ name: 'iron_ingot', count: 3 }]), 'withdraw', 'iron_ingot')
  const elsewhere: EffectEnvelope = {
    ...envelopeForCandidate(candidate, { stations: ['chest'], transfers: [] }),
    mayTransferInventory: [{ itemName: 'iron_ingot', count: 3, container: 'chest@9,9,9' }],
  }
  const { executor } = containerExecutor(fixture, { effectEnvelopeOverride: elsewhere })
  const result = await executor.claim(candidate).completion
  const held = fixture.inventorySlots.reduce((sum, slot) => (slot?.name === 'iron_ingot' ? sum + slot.count : sum), 0)
  const pass = result.status === 'failed' && result.failure === 'effect_envelope_violation' && held === 0 && fixture.withdrawCalls.length === 0
  return { pass, detail: `status=${result.status}/${result.failure} held=${held} withdrawCalls=${fixture.withdrawCalls.length}` }
})

addCase('(C5) a DIFFERENT container at the cell is refused: the envelope names the block it may open', async () => {
  // The candidate declares `chest@1,64,0` (its own observation), but the block
  // standing there is now a barrel. Opening it would be opening a container the
  // selection never named, so the station effect is outside the envelope and the
  // run fails closed BEFORE any transfer.
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'barrel' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
  })
  const candidate = containerCandidateAt(observed([{ name: 'iron_ingot', count: 3 }]), 'withdraw', 'iron_ingot')
  const { executor, logger } = containerExecutor(fixture)
  const result = await executor.claim(candidate).completion
  const pass =
    result.status === 'failed' &&
    result.failure === 'effect_envelope_violation' &&
    fixture.withdrawCalls.length === 0 &&
    logger.lines.every((line) => !line.startsWith('CONTAINER_TRANSFER ')) &&
    fixture.openCalls.length === 0
  return { pass, detail: `status=${result.status}/${result.failure} openCalls=${fixture.openCalls.length} withdrawCalls=${fixture.withdrawCalls.length}` }
})

addCase('(D1) a count above the declared observation is a typed envelope violation', () => {
  const candidate = containerCandidateAt(observed([{ name: 'iron_ingot', count: 2 }]), 'withdraw', 'iron_ingot')
  const envelope = envelopeForCandidate(candidate, {
    stations: ['chest'],
    transfers: [{ itemName: 'iron_ingot', count: 2, container: 'chest@1,64,0' }],
  })
  const ok = effectViolation(envelope, { type: 'transfer', itemName: 'iron_ingot', count: 2, container: 'chest@1,64,0' })
  const tooMany = effectViolation(envelope, { type: 'transfer', itemName: 'iron_ingot', count: 64, container: 'chest@1,64,0' })
  const wrongItem = effectViolation(envelope, { type: 'transfer', itemName: 'diamond', count: 1, container: 'chest@1,64,0' })
  const pass =
    ok === null &&
    tooMany === 'transfer_count_exceeds_declared:iron_ingot->chest@1,64,0:64>2' &&
    wrongItem === 'transfer_not_declared:diamond->chest@1,64,0'
  return { pass, detail: `ok=${ok ?? 'null'} tooMany="${tooMany ?? 'null'}" wrongItem="${wrongItem ?? 'null'}"` }
})

addCase('(E1) an EMPTY container is a typed empty observation, never a silent success', async () => {
  const fixture = makeContainerBot({ feet: STAND_FEET, blocks: terrain({ '1,64,0': 'chest' }), containerSlots: [null, null, null] })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture)
  const result = await executor.claim(containerCandidateAt(seed, 'open')).completion
  const openLine = logger.lines.find((line) => line.startsWith('CONTAINER_OPEN '))
  const emptyLine = logger.lines.find((line) => line.startsWith('CONTAINER_EMPTY '))
  // The observation resolves to a typed EMPTY fact on the planning side too: no
  // withdrawal is offered, and the refusal names `empty` (never "no contents").
  const next = { ...seed, containerContents: executor.containerContents() }
  const grounded = generateGroundedCandidates(next, defaultCandidateOptions)
  const refusal = grounded.containerRefusals[0]
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    openLine === 'CONTAINER_OPEN container=chest@1,64,0 contents=empty slots=0 items=none' &&
    emptyLine === 'CONTAINER_EMPTY container=chest@1,64,0 contents=empty items=none' &&
    refusal?.reason === 'empty' &&
    grounded.candidates.filter((candidate) => candidate.kind === 'CONTAINER').length === 0 &&
    fixture.withdrawCalls.length === 0
  return { pass, detail: `result=${result.status}/${result.verified} open="${openLine ?? 'none'}" empty="${emptyLine ?? 'none'}" refusal=${refusal?.reason ?? 'none'} withdrawCalls=${fixture.withdrawCalls.length}` }
})

addCase('(E2) a container observed empty in the state never yields a withdraw candidate', () => {
  const state = observed([], [SENSED_CHEST])
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    withdrawCandidates(state).length === 0 &&
    grounded.containerRefusals.some((refusal) => refusal.reason === 'empty') &&
    grounded.candidates.filter((candidate) => candidate.kind === 'CONTAINER').length === 0
  return { pass, detail: `refusals=[${grounded.containerRefusals.map((refusal) => formatContainerRefusal(refusal)).join(' | ')}]` }
})

addCase('(F1) a container with no valid interaction stand fails typed and NEVER opens', async () => {
  const fixture = makeContainerBot({
    feet: { x: 0.5, y: 62, z: 0.5 },
    blocks: (() => {
      const map = terrain({ '1,64,0': 'chest' })
      // Wall the chest in: every adjacent feet/head cell is solid.
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        for (let y = 62; y <= 66; y += 1) map.set(`${1 + dx},${y},${0 + dz}`, 'stone')
      }
      return map
    })(),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor } = containerExecutor(fixture)
  const result = await executor.claim(containerCandidateAt(seed, 'open')).completion
  const pass = result.status === 'failed' && result.failure === 'path_stuck' && fixture.openCalls.length === 0
  return { pass, detail: `status=${result.status}/${result.failure} openCalls=${fixture.openCalls.length} detail=${result.detail}` }
})

addCase('(F2) an OCCLUDED container is refused with reason=occluded and never opened', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
    canSeeBlock: () => false,
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture)
  const result = await executor.claim(containerCandidateAt(seed, 'open')).completion
  const refusal = logger.warnings.find((line) => line.startsWith('CONTAINER_REFUSED '))
  const pass =
    result.status === 'failed' &&
    result.failure === 'container_occluded' &&
    fixture.openCalls.length === 0 &&
    refusal === 'CONTAINER_REFUSED reason=occluded container=chest@1,64,0 at=1,64,0 detail=line_of_sight_blocked'
  return { pass, detail: `status=${result.status}/${result.failure} openCalls=${fixture.openCalls.length} refusal="${refusal ?? 'none'}"` }
})

addCase('(F3) a window that never opens inside the bound is a typed open_timeout, and a LATE window is closed', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
    openMode: 'late',
    lateOpenMs: 60,
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture, { containerOpenTimeoutMs: 15 })
  const result = await executor.claim(containerCandidateAt(seed, 'open')).completion
  const refusal = logger.warnings.find((line) => line.startsWith('CONTAINER_REFUSED '))
  await new Promise((resolve) => setTimeout(resolve, 120))
  const pass =
    result.status === 'failed' &&
    result.failure === 'container_unreachable' &&
    refusal === 'CONTAINER_REFUSED reason=open_timeout container=chest@1,64,0 at=1,64,0 detail=no_window_within_bound' &&
    // The late window must not leak into the next action: it is closed.
    fixture.closed() >= 1
  return { pass, detail: `status=${result.status}/${result.failure} refusal="${refusal ?? 'none'}" closed=${fixture.closed()}` }
})

addCase('(F4) a cell that no longer holds a container is a typed target_gone with the measured detail', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'stone' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture)
  const result = await executor.claim(containerCandidateAt(seed, 'open')).completion
  const refusal = logger.warnings.find((line) => line.startsWith('CONTAINER_REFUSED '))
  const pass =
    result.status === 'failed' &&
    result.failure === 'target_gone' &&
    fixture.openCalls.length === 0 &&
    refusal === 'CONTAINER_REFUSED reason=unreachable container=chest@1,64,0 at=1,64,0 detail=block_missing'
  return { pass, detail: `status=${result.status}/${result.failure} openCalls=${fixture.openCalls.length} refusal="${refusal ?? 'none'}"` }
})

addCase('(G) a placed container is refused at the dig boundary, never mined for materials', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'shulker_box' }),
    containerSlots: [null],
  })
  const { executor } = containerExecutor(fixture)
  const mine: Candidate = {
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    label: 'mine shulker_box at (1,64,0)',
    targetName: 'shulker_box',
    target: CONTAINER_CELL,
    targetEntityId: null,
    itemName: 'shulker_box',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, x: 1, y: 64, z: 0 },
  }
  const result = await executor.claim(mine).completion
  const pass = result.status === 'failed' && result.failure === 'protected_station'
  return { pass, detail: `status=${result.status}/${result.failure} detail=${result.detail}` }
})

// ---------------------------------------------------------------------------
// (H) the furnace smelt contract is unchanged
// ---------------------------------------------------------------------------

addCase('(H1) the SMELT envelope is exactly the pre-existing one (station names + null-count furnace slots)', () => {
  const smelt: Candidate = {
    id: 'SMELT:iron_ingot',
    kind: 'SMELT',
    label: 'smelt iron_ingot',
    targetName: 'furnace',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: null,
    itemName: 'iron_ingot',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { inputItem: 'raw_iron', fuelItem: 'coal', inputCount: 1, fuelCount: 1 },
  }
  const envelope = envelopeForCandidate(smelt, {
    equipItems: [],
    stations: ['furnace', 'blast_furnace', 'smoker'],
    transfers: [
      { itemName: 'raw_iron', count: null, container: 'furnace_input' },
      { itemName: 'coal', count: null, container: 'furnace_fuel' },
      { itemName: 'iron_ingot', count: null, container: 'furnace_output' },
    ],
  })
  // The historical any-count contract still holds for the slot roles.
  const anyCount = effectViolation(envelope, { type: 'transfer', itemName: 'raw_iron', count: 64, container: 'furnace_input' })
  const pass =
    envelope.mayTransferInventory?.length === 3 &&
    envelope.mayTransferInventory?.every((entry) => entry.count === null) &&
    envelope.mayUseStations?.join(',') === 'furnace,blast_furnace,smoker' &&
    envelope.mayTransferInventory[0]?.container === 'furnace_input' &&
    envelope.mayTransferInventory[1]?.container === 'furnace_fuel' &&
    envelope.mayTransferInventory[2]?.container === 'furnace_output' &&
    anyCount === null &&
    effectEnvelopeHash(envelope) === SMELT_ENVELOPE_HASH_ON_MAIN
  return { pass, detail: `hash=${effectEnvelopeHash(envelope)} pinned=${SMELT_ENVELOPE_HASH_ON_MAIN} anyCount=${anyCount ?? 'null'}` }
})

/**
 * The `effectEnvelopeHash` of the SMELT envelope above, computed on pristine
 * main c348bb1 (the container lane must not disturb the furnace contract). It is
 * a pin, not a re-derivation: if a SMELT input ever changes, this fixture fails.
 */
const SMELT_ENVELOPE_HASH_ON_MAIN = '1adf436a'

// ---------------------------------------------------------------------------
// (J) markers are REGISTERED (an unregistered marker is dropped by the mirroring
// sink, which is how a real capability becomes invisible in `buddy.log`)
// ---------------------------------------------------------------------------

addCase('(J1) every container marker is registered and mirrored, and the emitted lines resolve to their token', async () => {
  const fixture = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 1 }],
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture)
  await executor.claim(containerCandidateAt(seed, 'open')).completion
  const next = { ...seed, containerContents: executor.containerContents() }
  await executor.claim(containerCandidateAt(next, 'withdraw', 'iron_ingot')).completion
  // The refusals ride the same mirrored path.
  const occluded = makeContainerBot({
    feet: STAND_FEET,
    blocks: terrain({ '1,64,0': 'chest' }),
    containerSlots: [null],
    canSeeBlock: () => false,
  })
  const refused = containerExecutor(occluded)
  await refused.executor.claim(containerCandidateAt(seed, 'open')).completion
  // The EMPTY observation rides the same path (its own registered marker).
  const emptyFixture = makeContainerBot({ feet: STAND_FEET, blocks: terrain({ '1,64,0': 'chest' }), containerSlots: [null] })
  const emptyRun = containerExecutor(emptyFixture)
  await emptyRun.executor.claim(containerCandidateAt(seed, 'open')).completion
  const emitted = [
    ...logger.lines.filter((line) => line.startsWith('CONTAINER_')),
    ...emptyRun.logger.lines.filter((line) => line.startsWith('CONTAINER_')),
    ...refused.logger.warnings.filter((line) => line.startsWith('CONTAINER_')),
    placedContainerReadyLine('shulker_box', 'shulker_box', CONTAINER_CELL) ?? '',
  ]
  const tokens = emitted.map((line) => line.split(' ')[0] ?? '')
  const registered = ['CONTAINER_OPEN', 'CONTAINER_EMPTY', 'CONTAINER_TRANSFER', 'CONTAINER_REFUSED', 'CONTAINER_READY']
  const missingFromRegistry = registered.filter((token) => !MIRRORED_MARKERS.has(token))
  const unmirrored = emitted.filter((line) => mirroredEventToken(line) === null)
  const pass =
    emitted.length >= 4 &&
    tokens.includes('CONTAINER_OPEN') &&
    tokens.includes('CONTAINER_EMPTY') &&
    tokens.includes('CONTAINER_TRANSFER') &&
    tokens.includes('CONTAINER_REFUSED') &&
    tokens.includes('CONTAINER_READY') &&
    missingFromRegistry.length === 0 &&
    unmirrored.length === 0
  return {
    pass,
    detail: `emitted=${emitted.length} tokens=[${[...new Set(tokens)].join(',')}] missing=[${missingFromRegistry.join(',')}] unmirrored=${unmirrored.length}`,
  }
})

// ---------------------------------------------------------------------------
// (K/L/M) the MEASURED LIVE SHAPES: m3-live buddy.log, 2026-09-22
// ---------------------------------------------------------------------------

/** A voxel walker: the first SOLID cell on the segment, or null. `solid` decides. */
function solidVoxelCast(
  blocks: Map<string, string>,
  solid: (name: string) => boolean,
): (from: Vec3Json, to: Vec3Json) => Vec3Json | null {
  return (from, to) => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const length = Math.hypot(dx, dy, dz)
    if (!Number.isFinite(length) || length <= 0) return null
    const steps = Math.max(1, Math.ceil(length / 0.02))
    let last: string | null = null
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      const x = Math.floor(from.x + dx * t)
      const y = Math.floor(from.y + dy * t)
      const z = Math.floor(from.z + dz * t)
      const key = `${x},${y},${z}`
      if (key === last) continue
      last = key
      if (solid(blocks.get(key) ?? 'air')) return { x, y, z }
    }
    return null
  }
}

/**
 * The live Nether slice around the operator's shulker box, read from the save
 * (`/home/s0u7a/mc-server/world_nether/DIM-1/region/r.0.0.mca`, chunk 0,0 via
 * `tools/world-truth-plane.mjs` + a plane dump): a purple_shulker_box at
 * (10,59,8) on soul_sand, the portal's obsidian frame columns x=6 and x=9 at
 * y=58..62 plus the frame's y=58/y=62 rows through x=7..8, the lit portal plane
 * x=7..8 y=59..61 z=8, a soul_sand floor at y=56..58, everything else around the
 * box open air.
 */
function liveNetherSlice(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (let x = 5; x <= 14; x += 1) for (let z = 5; z <= 14; z += 1) blocks.set(`${x},56,${z}`, 'soul_sand')
  for (let x = 6; x <= 9; x += 1) for (let y = 58; y <= 62; y += 1) blocks.set(`${x},${y},8`, 'obsidian')
  for (let x = 7; x <= 8; x += 1) for (let y = 59; y <= 61; y += 1) blocks.set(`${x},${y},8`, 'nether_portal')
  blocks.set('10,57,8', 'soul_sand')
  blocks.set('10,58,8', 'soul_sand')
  blocks.set('11,58,8', 'soul_sand')
  blocks.set('10,58,9', 'soul_sand')
  blocks.set('10,59,8', 'purple_shulker_box')
  return blocks
}

/** Vanilla raycast semantics: the portal plane is not solid, the rest is. */
const LIVE_SOLID = (name: string): boolean => name !== 'air' && name !== 'nether_portal'

addCase('(K1) the LIVE 14:17 shape: an out-of-reach container is guard-allowed through its STAND, never refused against its own cell', () => {
  // m3-live buddy.log 2026-09-22T14:17:10.218Z:
  //   JEV_HEADS action=CONTAINER:open:purple_shulker_box@10,59,8
  //   ACTION_REJECTED ... code=NO_PATH reason=no canDig=false path to (10,59,8) (GoalBlock probe)
  // The body stood at (22.3,59,-0.3), 14.8 m away, and never moved: the guard
  // probed `GoalBlock(<container cell>)`, a cell the shulker box occupies.
  const cell: Vec3Json = { x: 10, y: 59, z: 8 }
  const state = worldState({ containers: [{ ...cell, source: 'sensed', name: 'purple_shulker_box' }] })
  state.self.position = { x: 22.3, y: 59, z: -0.3 }
  state.self.eyePosition = { x: 22.3, y: 60.62, z: -0.3 }
  const candidate = openCandidates(state)[0]
  if (candidate === undefined) return { pass: false, detail: 'no OPEN candidate offered at all' }
  const context = {
    phase: 'decision' as const,
    candidateIds: new Set([candidate.id]),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 40,
    // The live controller probe: `new goals.GoalBlock(10,59,8)` is unsatisfiable.
    canComputePath: () => false,
  }
  const before = guardDecision(candidate.id, [candidate], state, { ...context })
  const stand: Vec3Json = { x: 11, y: 59, z: 8 }
  const after = guardDecision(candidate.id, [candidate], state, {
    ...context,
    stationApproach: () => ({ approach: stand, path: 'reachable' }),
  })
  const lidless = guardDecision(candidate.id, [candidate], state, {
    ...context,
    stationApproach: () => ({ approach: null, path: null }),
  })
  const walled = guardDecision(candidate.id, [candidate], state, {
    ...context,
    stationApproach: () => ({ approach: stand, path: 'no_path' }),
  })
  const pass =
    candidate.id === 'CONTAINER:open:purple_shulker_box@10,59,8' &&
    before.ok === false &&
    before.code === 'NO_PATH' &&
    before.reason === 'no canDig=false path to (10,59,8) (GoalBlock probe)' &&
    after.ok === true &&
    lidless.ok === false &&
    lidless.code === 'NO_PATH' &&
    lidless.reason === 'no interaction stand for purple_shulker_box@10,59,8 at (10,59,8) within reach' &&
    walled.ok === false &&
    walled.code === 'NO_PATH' &&
    walled.reason ===
      'no canDig=false path to the interaction stand (11,59,8) for purple_shulker_box@10,59,8 at (10,59,8)'
  return {
    pass,
    detail: `id=${candidate.id} before=${before.ok ? 'ok' : `${before.code}:${before.reason}`} after=${after.ok ? 'ok' : 'refused'} noStand=${lidless.ok ? 'ok' : lidless.reason} noPath=${walled.ok ? 'ok' : walled.reason}`,
  }
})

addCase('(K2) a container 26 m away (outside the 16 m near-field scan) is offered from DURABLE memory and guard-allowed', () => {
  // The scan radius is `Math.max(16, reach + 8)` (state.ts buildStations), but a
  // host-validated durable station is merged in as `remembered` (radius 48), so
  // the near-field radius is NOT the binding limit for a known container.
  const cell: Vec3Json = { x: 10, y: 59, z: 8 }
  const state = worldState({ containers: [{ ...cell, source: 'remembered', name: 'purple_shulker_box' }] })
  state.self.position = { x: 36, y: 59, z: 8 }
  state.self.eyePosition = { x: 36, y: 60.62, z: 8 }
  const candidate = openCandidates(state)[0]
  const offeredDistance = candidate === undefined ? -1 : Math.abs((candidate.target?.x ?? Number.NaN) - 36)
  const guarded = candidate === undefined
    ? null
    : guardDecision(candidate.id, [candidate], state, {
        phase: 'decision',
        candidateIds: new Set([candidate.id]),
        inFlight: null,
        reach: 4.5,
        maxCandidateAgeTicks: 40,
        canComputePath: () => false,
        stationApproach: () => ({ approach: { x: 11, y: 59, z: 8 }, path: 'reachable' }),
      })
  const pass =
    candidate !== undefined &&
    candidate.meta.containerSource === 'remembered' &&
    candidate.target?.x === 10 &&
    Math.abs((candidate.target?.x ?? 0) - 36) === 26 &&
    offeredDistance === 26 &&
    candidate.inReach === false &&
    guarded?.ok === true
  return {
    pass,
    detail: `candidate=${candidate?.id ?? 'none'} source=${String(candidate?.meta.containerSource)} inReach=${String(candidate?.inReach)} offeredAt=${offeredDistance}m guarded=${guarded?.ok === true ? 'ok' : 'refused'}`,
  }
})

addCase('(L1) a container every stand is sight-blocked from is refused typed (occluded / no_stand_with_line_of_sight) and never opened', async () => {
  // A LIDDED container: a solid block in the cell above it intercepts the eye
  // ray of every same-level interaction stand, so no stand can SEE the container.
  const blocks = terrain({ '1,64,0': 'chest', '1,65,0': 'stone' })
  const fixture = makeContainerBot({
    feet: { x: 6.5, y: 64, z: 0.5 },
    blocks,
    containerSlots: [{ name: 'iron_ingot', type: itemId('iron_ingot'), count: 3 }],
    canSeeBlock: () => false,
    sightCast: solidVoxelCast(blocks, (name) => name !== 'air'),
  })
  const seed = worldState({ containers: [SENSED_CHEST], goalQueue: queueWith({ ...queued('iron_ingot'), kind: 'collect' }) })
  const { executor, logger } = containerExecutor(fixture)
  const result = await executor.claim(containerCandidateAt(seed, 'open')).completion
  const refusal = logger.warnings.find((line) => line.startsWith('CONTAINER_REFUSED '))
  const pass =
    result.status === 'failed' &&
    result.failure === 'container_occluded' &&
    fixture.openCalls.length === 0 &&
    refusal === 'CONTAINER_REFUSED reason=occluded container=chest@1,64,0 at=1,64,0 detail=no_stand_with_line_of_sight'
  return {
    pass,
    detail: `status=${result.status}/${result.failure} openCalls=${fixture.openCalls.length} refusal="${refusal ?? 'none'}"`,
  }
})

addCase('(L2) the LIVE 16:03 geometry: the portal-cell stand is sight-blocked by the frame column, the clear stands see the box', () => {
  // m3-live buddy.log 2026-09-22T16:03:47.146Z: the body stood in the Nether
  // portal cell (7,59,8) 2.4 m from the box, `canSeeBlock` was false and the open
  // was refused occluded. The geometry says why: the frame's obsidian column
  // x=9 at y=60 is the FIRST SOLID HIT on the eye->box ray, while the same box is
  // in plain sight from the stands beside it.
  const blocks = liveNetherSlice()
  const cast = solidVoxelCast(blocks, LIVE_SOLID)
  const box: Vec3Json = { x: 10, y: 59, z: 8 }
  const portalStand: Vec3Json = { x: 7, y: 59, z: 8 }
  const clearStands: Vec3Json[] = [
    { x: 11, y: 59, z: 8 },
    { x: 10, y: 59, z: 9 },
  ]
  const blockedHit = cast({ x: 7.5, y: 60.62, z: 8.5 }, { x: 10.5, y: 59.5, z: 8.5 })
  const portalSees = blockSightFromStand(portalStand, box, 1.62, cast)
  const clearSees = clearStands.map((stand) => blockSightFromStand(stand, box, 1.62, cast))
  const pass =
    portalSees === false &&
    blockedHit?.x === 9 &&
    blockedHit?.y === 60 &&
    blockedHit?.z === 8 &&
    clearSees.every((sees) => sees === true)
  return {
    pass,
    detail: `portalStandSees=${portalSees} firstHit=${JSON.stringify(blockedHit)} clearStands=[${clearStands.map((stand, index) => `${stand.x},${stand.y},${stand.z}:${clearSees[index]}`).join(' ')}]`,
  }
})

addCase('(M1) the CONTROL: a world with NO container present yields no container candidate, no container evidence, and the pristine candidate ids', () => {
  const control = worldState({ containers: [] })
  const candidates = containerCandidates(control)
  const ids = generateCandidates(control, defaultCandidateOptions).map((candidate) => candidate.id)
  const containerIds = ids.filter((id) => id.startsWith('CONTAINER'))
  const blocked = blockSightFromStand({ x: 2, y: 64, z: 0 }, CONTAINER_CELL, 1.62, () => null)
  // Captured on the PRISTINE base of this lane (38cbb22, `git status` empty):
  // the same no-container world produced exactly this candidate list, so the
  // container work moved nothing in a container-free tick.
  const pristine = 'WAIT'
  const pass =
    candidates.length === 0 &&
    containerIds.length === 0 &&
    control.containers?.length === 0 &&
    // A world with nothing to see still answers "not occluded": the new sight
    // predicate can never invent an occluder.
    blocked === true &&
    ids.join(' ') === pristine
  return {
    pass,
    detail: `containers=${control.containers?.length ?? -1} containerCandidates=${candidates.length} allCandidates=[${ids.join(' ')}] pristine=[${pristine}] containerIds=${containerIds.length} noHitSees=${blocked}`,
  }
})

// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('CONTAINER interaction: sensor offer, open, typed transfer, typed refusals\n')
process.stdout.write('-'.repeat(76) + '\n')
for (const testCase of cases) {
  try {
    const observed = await testCase.run()
    if (!observed.pass) failures += 1
    process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
    process.stdout.write(`      ${observed.detail}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL  ${testCase.name}\n      threw: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
process.stdout.write('-'.repeat(76) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} container cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
