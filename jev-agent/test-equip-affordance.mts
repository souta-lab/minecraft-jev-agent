// test-equip-affordance.mts - the armor/weapon EQUIP affordance (owner report).
//
// Live gap: the bot owns diamond gear but fights bare-handed and walks around
// unarmoured. Every equip site targeted the main hand only; there was no armor
// destination, no EQUIP candidate kind, and ATTACK never changed the held item.
//
// This suite names the capability end to end:
//   (a) a carried diamond chestplate with nothing worn offers
//       `EQUIP:torso:diamond_chestplate`, and the executor's post-condition is
//       "chestplate worn" (the live armor slot names it, EQUIP_ARMOR emitted);
//   (b) carried armor that is only equal-or-worse than what is worn offers NO
//       candidate (no churn) and surfaces the EQUIP_ARMOR_REFUSED marker;
//   (c) an ATTACK with a sword in the inventory and a pickaxe in hand equips the
//       sword to the main hand before the melee lease (asserted equip call);
//   (d) nothing regresses: the affordance never crowds out a grounded goal
//       route, an already-best weapon does not churn, and EQUIP is a strict
//       self-evident post-condition.
//
// Run: bun test-equip-affordance.mts
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { ActuationPort } from './src/actuationPort.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import { Executor, defaultExecutorOptions } from './src/index.ts'
import type { Candidate, Vec3Json } from './src/index.ts'
import { ACTING_KINDS, guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import { truthfulActionOutcome } from './src/actionPostcondition.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { CandidateOptions } from './src/candidates.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { inventoryCount } from './src/optionSpec.ts'
import { ARMOR_SLOT_INDEX, armorEquipOffers, armorEquipRefusals, armorSlotFor, armorTier, bestWeaponOffer, formatArmorEquip, formatArmorRefusal, formatWeaponEquip, formatWeaponRefusal } from './src/gearPlan.ts'
import type { ArmorSlot, ArmorWorn } from './src/gearPlan.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, BlockState, EntityState, GoalState, InventoryState, SelfState, WorldState } from './src/state.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const recipes = createRecipeIndex(registry as unknown)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

// ---------------------------------------------------------------------------
// pure world-state fixtures
// ---------------------------------------------------------------------------

const FEET: Vec3Json = { x: 0.5, y: 64, z: 0.5 }

function self(position: Vec3Json, armor?: ArmorWorn): SelfState {
  return {
    username: 'AI_EQUIP',
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
    ...(armor === undefined ? {} : { armor: armor as SelfState['armor'] }),
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

function collectGoal(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function collectQueue(targetItem: string): GoalQueueState {
  const goal: QueuedGoal = {
    id: `g-equip-${targetItem}`,
    kind: 'collect',
    description: `collect 1 x ${targetItem}`,
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
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
}

interface WorldInput {
  armor?: ArmorWorn
  counts?: Record<string, number>
  blocks?: BlockState[]
  entities?: EntityState[]
  standable?: Vec3Json[]
  focusItem?: string
}

function worldState(input: WorldInput = {}): WorldState {
  const focusItem = input.focusItem ?? 'oak_log'
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(FEET, input.armor),
    inventory: inventory(input.counts ?? {}),
    entities: input.entities ?? [],
    blocks: input.blocks ?? [],
    terrain: { standable: input.standable ?? [FEET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: collectGoal(focusItem),
    goalQueue: collectQueue(focusItem),
    recentEvents: [],
    signals: signals(),
  }
}

function logBlock(position: Vec3Json): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position,
    distance: Math.hypot(position.x - FEET.x, position.y - FEET.y, position.z - FEET.z),
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
    visible: true,
  }
}

function hostile(id: number, distance: number): EntityState {
  return {
    id,
    name: 'zombie',
    kind: 'hostile',
    username: null,
    position: { x: FEET.x + distance, y: FEET.y, z: FEET.z },
    distance,
    hostile: true,
  }
}

const equipCandidates = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.kind === 'EQUIP')

// ---------------------------------------------------------------------------
// executor fixture: recording actuation port + a mutable armor/hand model
// ---------------------------------------------------------------------------

interface Fixture {
  bot: Bot
  port: ActuationPort
  equipCalls: Array<{ name: string; destination: string }>
  attacks: number[]
  armorName: (slot: ArmorSlot) => string | null
  heldName: () => string | null
}

interface FixtureOptions {
  counts?: Record<string, number>
  held?: string | null
  worn?: Partial<Record<ArmorSlot, string>>
  entity?: { id: number; distance: number }
}

function makeFixture(opts: FixtureOptions = {}): Fixture {
  const feet = new Vec3(FEET.x, FEET.y, FEET.z)
  const counts = { ...(opts.counts ?? {}) }
  const slots: Array<{ name: string; count: number; slot: number; type: number } | null> = new Array(46).fill(null)
  const carried: Array<{ name: string; count: number; slot: number; type: number }> = []
  let nextSlot = 9
  let nextType = 100
  for (const [name, count] of Object.entries(counts)) {
    if (count <= 0) continue
    const item = { name, count, slot: nextSlot, type: nextType++ }
    slots[nextSlot] = item
    carried.push(item)
    nextSlot += 1
  }
  for (const [slot, name] of Object.entries(opts.worn ?? {})) {
    if (name === undefined) continue
    const index = ARMOR_SLOT_INDEX[slot as ArmorSlot]
    slots[index] = { name, count: 1, slot: index, type: nextType++ }
  }

  const equipCalls: Array<{ name: string; destination: string }> = []
  const attacks: number[] = []
  const applyEquip = (item: { name: string }, destination: string): void => {
    if (destination === 'hand') {
      bot.heldItem = { name: item.name, count: 1, slot: 36 } as Bot['heldItem']
      return
    }
    if (destination in ARMOR_SLOT_INDEX) {
      const index = ARMOR_SLOT_INDEX[destination as ArmorSlot]
      slots[index] = { name: item.name, count: 1, slot: index, type: 1 }
    }
  }

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
      distanceTo: (other: { x: number; y: number; z: number }) => feet.distanceTo(new Vec3(other.x, other.y, other.z)),
    },
    _client: { write: () => true },
    physicsEnabled: true,
    health: 20,
    food: 20,
    time: { isDay: true },
    game: { gameMode: 'survival', dimension: 'overworld' },
    entities: {} as Record<number, unknown>,
    inventory: {
      slots,
      items: () => carried.filter((item) => (counts[item.name] ?? 0) > 0),
      count: () => 0,
    },
    heldItem: null as { name: string; count: number; slot: number } | null,
    blockAt: () => null,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async (item: { name: string }, destination: string) => {
      equipCalls.push({ name: item.name, destination })
      applyEquip(item, destination)
    },
    canDigBlock: () => true,
    dig: async () => undefined,
    stopDigging: () => undefined,
    attack: (entity: { id: number }) => {
      attacks.push(entity.id)
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
  if (opts.held !== undefined && opts.held !== null) {
    bot.heldItem = { name: opts.held, count: 1, slot: 36 }
  }
  if (opts.entity !== undefined) {
    const position = feet.offset(opts.entity.distance, 0, 0)
    bot.entities[opts.entity.id] = {
      id: opts.entity.id,
      name: 'zombie',
      type: 'hostile',
      kind: 'Hostile mobs',
      position,
      height: 1.95,
      width: 0.6,
      offset: (x: number, y: number, z: number) => position.offset(x, y, z),
      isValid: true,
    }
  }

  const port: ActuationPort = {
    generationId: 'gen-equip-test',
    assertLease: () => undefined,
    pathTo: () => undefined,
    stopPath: () => undefined,
    setControls: () => undefined,
    clearControls: () => undefined,
    lookAt: async () => undefined,
    dig: async () => undefined,
    placeBlock: async () => undefined,
    activateItem: async () => undefined,
    activateBlock: async () => undefined,
    equip: async (item, destination) => {
      const dest = Array.isArray(destination) ? String(destination[0]) : String(destination ?? 'hand')
      equipCalls.push({ name: item.name, destination: dest })
      applyEquip(item, dest)
    },
    collect: async () => undefined,
    craft: async () => undefined,
    openContainer: async () => undefined,
    writeMovementPacket: () => undefined,
    setPose: () => undefined,
  }

  return {
    bot: bot as unknown as Bot,
    port,
    equipCalls,
    attacks,
    armorName: (slot) => slots[ARMOR_SLOT_INDEX[slot]]?.name ?? null,
    heldName: () => bot.heldItem?.name ?? null,
  }
}

async function runAction(
  fixture: Fixture,
  candidate: Candidate,
): Promise<{ result: Awaited<ReturnType<Executor['claim']>['completion']>; messages: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'equip-'))
  const logPath = join(dir, 'run.jsonl')
  const executor = new Executor(fixture.bot, new EventLogger(new JsonlWriter(logPath), false), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    actuationPort: fixture.port,
  })
  const result = await executor.claim(candidate).completion
  const messages = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { message: string }).message)
  return { result, messages }
}

function craftGoal(targetItem: string): GoalState {
  return {
    id: `craft:${targetItem}`,
    description: `craft 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function craftQueue(targetItem: string): GoalQueueState {
  const goal: QueuedGoal = {
    id: `g-craft-${targetItem}`,
    kind: 'craft',
    description: `craft 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'bootstrap',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
}

/** A craft goal with inputs held and no sensed station (the self-contained ladder shape). */
function craftWorldState(counts: Record<string, number>): WorldState {
  return {
    ...worldState({ counts }),
    goal: craftGoal('wooden_pickaxe'),
    goalQueue: craftQueue('wooden_pickaxe'),
  }
}

function candidateById(candidates: readonly Candidate[], id: string): Candidate {
  const candidate = candidates.find((entry) => entry.id === id)
  if (candidate === undefined) throw new Error(`candidate ${id} is missing from [${candidates.map((c) => c.id).join(', ')}]`)
  return candidate
}

// ---------------------------------------------------------------------------
// (0) pure armor/weapon truth
// ---------------------------------------------------------------------------

addCase('(0) armorSlotFor/armorTier map the standard pieces and fail closed on junk', () => {
  const pass =
    armorSlotFor('diamond_chestplate') === 'torso' &&
    armorSlotFor('iron_helmet') === 'head' &&
    armorSlotFor('turtle_helmet') === 'head' &&
    armorSlotFor('netherite_leggings') === 'legs' &&
    armorSlotFor('golden_boots') === 'feet' &&
    armorSlotFor('diamond_sword') === null &&
    (armorTier('diamond_chestplate') ?? 0) > (armorTier('iron_chestplate') ?? 0) &&
    armorTier('mystery_helmet') === null
  return { pass, detail: `torso=${armorSlotFor('diamond_chestplate')} tier=${armorTier('diamond_chestplate')}` }
})

addCase('(0) bestWeaponOffer only upgrades on strictly more damage and never churns a tie', () => {
  const upgrade = bestWeaponOffer('iron_pickaxe', { diamond_sword: 1 })
  // golden_axe and wooden_axe tie at 7 damage; the deterministic order picks one.
  const tie = bestWeaponOffer('wooden_sword', { wooden_axe: 1, golden_axe: 1 })
  const none = bestWeaponOffer(null, { cobblestone: 64 })
  const pass =
    upgrade?.itemName === 'diamond_sword' &&
    upgrade.replaced === 'iron_pickaxe' &&
    tie?.itemName === 'golden_axe' &&
    tie.heldDamage === 4 &&
    none === null
  return { pass, detail: `upgrade=${JSON.stringify(upgrade)} tie=${JSON.stringify(tie)} none=${JSON.stringify(none)}` }
})

addCase('(5) the marker lines are the audited greppable formats', () => {
  const armor = formatArmorEquip({ slot: 'torso', itemName: 'diamond_chestplate', replaced: null })
  const refusal = formatArmorRefusal({ slot: 'torso', itemName: 'leather_chestplate', worn: 'diamond_chestplate', reason: 'not_better' })
  const weapon = formatWeaponEquip({ itemName: 'diamond_sword', damage: 7, replaced: 'iron_pickaxe', heldDamage: 2 })
  const weaponRefusal = formatWeaponRefusal('diamond_sword')
  const pass =
    armor === 'EQUIP_ARMOR slot=torso item=diamond_chestplate from=inventory replaced=none' &&
    refusal === 'EQUIP_ARMOR_REFUSED slot=torso item=leather_chestplate worn=diamond_chestplate reason=not_better' &&
    weapon === 'EQUIP_WEAPON item=diamond_sword replaced=iron_pickaxe reason=combat' &&
    weaponRefusal === 'EQUIP_WEAPON_REFUSED item=diamond_sword reason=no_better_weapon'
  return { pass, detail: `${armor} | ${refusal} | ${weapon} | ${weaponRefusal}` }
})

// ---------------------------------------------------------------------------
// (a) carried chestplate + nothing worn -> EQUIP torso candidate + worn result
// ---------------------------------------------------------------------------

addCase('(a) a carried diamond chestplate with nothing worn offers EQUIP torso', () => {
  const grounded = generateGroundedCandidates(worldState({ counts: { diamond_chestplate: 1 } }))
  const equip = equipCandidates(grounded.candidates)
  const candidate = equip[0]
  const pass =
    equip.length === 1 &&
    candidate?.id === 'EQUIP:torso:diamond_chestplate' &&
    candidate.meta.slot === 'torso' &&
    candidate.meta.replaced === 'none' &&
    candidate.itemName === 'diamond_chestplate'
  return { pass, detail: JSON.stringify(equip.map((entry) => ({ id: entry.id, meta: entry.meta }))) }
})

addCase('(a) the executor equips to the torso destination and its post-condition is "chestplate worn"', async () => {
  const state = worldState({ counts: { diamond_chestplate: 1 } })
  const candidate = candidateById(equipCandidates(generateGroundedCandidates(state).candidates), 'EQUIP:torso:diamond_chestplate')
  const fixture = makeFixture({ counts: { diamond_chestplate: 1 } })
  const { result, messages } = await runAction(fixture, candidate)
  const marker = messages.find((message) => message.startsWith('EQUIP_ARMOR '))
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.kind === 'EQUIP' &&
    fixture.equipCalls.length === 1 &&
    fixture.equipCalls[0]?.name === 'diamond_chestplate' &&
    fixture.equipCalls[0]?.destination === 'torso' &&
    fixture.armorName('torso') === 'diamond_chestplate' &&
    marker === 'EQUIP_ARMOR slot=torso item=diamond_chestplate from=inventory replaced=none'
  return {
    pass,
    detail: `status=${result.status} verified=${result.verified} calls=${JSON.stringify(fixture.equipCalls)} worn=${fixture.armorName('torso')} marker=${marker ?? 'none'}`,
  }
})

addCase('(a) an equip that does not stick fails verify_failed with no EQUIP_ARMOR marker', async () => {
  const state = worldState({ counts: { diamond_chestplate: 1 } })
  const candidate = candidateById(equipCandidates(generateGroundedCandidates(state).candidates), 'EQUIP:torso:diamond_chestplate')
  const fixture = makeFixture({ counts: { diamond_chestplate: 1 } })
  // Strip the destination state mutation: the port records the call but the slot never changes.
  const deaf: ActuationPort = { ...fixture.port, equip: async () => undefined }
  const dir = mkdtempSync(join(tmpdir(), 'equip-'))
  const logPath = join(dir, 'run.jsonl')
  const executor = new Executor(fixture.bot, new EventLogger(new JsonlWriter(logPath), false), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    actuationPort: deaf,
  })
  const result = await executor.claim(candidate).completion
  const messages = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { message: string }).message)
  const pass =
    result.status === 'failed' &&
    result.failure === 'verify_failed' &&
    result.verified === false &&
    !messages.some((message) => message.startsWith('EQUIP_ARMOR '))
  return { pass, detail: `status=${result.status} failure=${result.failure} detail=${result.detail}` }
})

// ---------------------------------------------------------------------------
// (b) only equal/worse armor -> no candidate, explicit refusal
// ---------------------------------------------------------------------------

addCase('(b) carried armor that is not better than what is worn offers no candidate (no churn)', () => {
  const armor = { head: null, torso: { name: 'diamond_chestplate' }, legs: null, feet: null }
  const state = worldState({ armor, counts: { leather_chestplate: 1, iron_chestplate: 1 } })
  const grounded = generateGroundedCandidates(state)
  const candidates = equipCandidates(grounded.candidates)
  const refusals = grounded.armorRefusals
  const lines = refusals.map(formatArmorRefusal)
  const pass =
    candidates.length === 0 &&
    refusals.length === 2 &&
    lines.includes('EQUIP_ARMOR_REFUSED slot=torso item=leather_chestplate worn=diamond_chestplate reason=not_better') &&
    lines.includes('EQUIP_ARMOR_REFUSED slot=torso item=iron_chestplate worn=diamond_chestplate reason=not_better') &&
    armorEquipOffers(armor, { diamond_chestplate: 1 }).length === 0
  return { pass, detail: `candidates=${candidates.length} refusals=${JSON.stringify(lines)}` }
})

addCase('(b) a strictly better piece still offers while the worse pieces are refused', () => {
  const armor = { head: null, torso: { name: 'iron_chestplate' }, legs: null, feet: null }
  const counts = { leather_chestplate: 1, diamond_chestplate: 1 }
  const offers = armorEquipOffers(armor, counts)
  const refusals = armorEquipRefusals(armor, counts)
  const pass =
    offers.length === 1 &&
    offers[0]?.itemName === 'diamond_chestplate' &&
    offers[0]?.replaced === 'iron_chestplate' &&
    refusals.length === 1 &&
    refusals[0]?.itemName === 'leather_chestplate'
  return { pass, detail: `offers=${JSON.stringify(offers)} refusals=${JSON.stringify(refusals)}` }
})

// ---------------------------------------------------------------------------
// (c) ATTACK with a carried sword and a pickaxe in hand -> sword equipped
// ---------------------------------------------------------------------------

addCase('(c) an ATTACK is offered while a sword is carried and a pickaxe is held', () => {
  const state = worldState({ counts: { diamond_sword: 1, iron_pickaxe: 1 }, entities: [hostile(19, 1.5)] })
  const grounded = generateGroundedCandidates(state)
  const attack = grounded.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const pass = attack?.id === 'ATTACK:e19'
  return { pass, detail: JSON.stringify(grounded.candidates.map((entry) => entry.id)) }
})

addCase('(c) the ATTACK lease equips the carried sword to the main hand before it swings', async () => {
  const state = worldState({ counts: { diamond_sword: 1, iron_pickaxe: 1 }, entities: [hostile(19, 1.5)] })
  const candidate = candidateById(generateGroundedCandidates(state).candidates, 'ATTACK:e19')
  const fixture = makeFixture({ counts: { diamond_sword: 1, iron_pickaxe: 1 }, held: 'iron_pickaxe', entity: { id: 19, distance: 1.5 } })
  const { result, messages } = await runAction(fixture, candidate)
  const marker = messages.find((message) => message.startsWith('EQUIP_WEAPON '))
  const pass =
    result.status === 'done' &&
    result.kind === 'ATTACK' &&
    fixture.equipCalls.length === 1 &&
    fixture.equipCalls[0]?.name === 'diamond_sword' &&
    fixture.equipCalls[0]?.destination === 'hand' &&
    fixture.heldName() === 'diamond_sword' &&
    fixture.attacks.length > 0 &&
    marker === 'EQUIP_WEAPON item=diamond_sword replaced=iron_pickaxe reason=combat'
  return {
    pass,
    detail: `status=${result.status} calls=${JSON.stringify(fixture.equipCalls)} held=${fixture.heldName()} attacks=${fixture.attacks.length} marker=${marker ?? 'none'}`,
  }
})

addCase('(c)(d) an already-best held weapon is not churned and the refusal marker is emitted', async () => {
  const state = worldState({ counts: { diamond_sword: 1, stone_sword: 1 }, entities: [hostile(19, 1.5)] })
  const candidate = candidateById(generateGroundedCandidates(state).candidates, 'ATTACK:e19')
  const fixture = makeFixture({ counts: { diamond_sword: 1, stone_sword: 1 }, held: 'diamond_sword', entity: { id: 19, distance: 1.5 } })
  const { result, messages } = await runAction(fixture, candidate)
  const refusal = messages.find((message) => message.startsWith('EQUIP_WEAPON_REFUSED '))
  const pass =
    result.status === 'done' &&
    fixture.equipCalls.length === 0 &&
    fixture.heldName() === 'diamond_sword' &&
    refusal === 'EQUIP_WEAPON_REFUSED item=diamond_sword reason=no_better_weapon' &&
    fixture.attacks.length > 0
  return { pass, detail: `calls=${fixture.equipCalls.length} refusal=${refusal ?? 'none'} attacks=${fixture.attacks.length}` }
})

// ---------------------------------------------------------------------------
// (d) no regression: offered alongside goals, guardable, strict post-condition
// ---------------------------------------------------------------------------

addCase('(d) the EQUIP affordance does not crowd out a grounded goal route', () => {
  const block = logBlock({ x: 1, y: 64, z: 0 })
  const state = worldState({ counts: { diamond_chestplate: 1 }, blocks: [block], standable: [FEET, { x: 0, y: 64, z: 0 }] })
  const options: CandidateOptions = { ...defaultCandidateOptions }
  const ids = generateGroundedCandidates(state, options).candidates.map((candidate) => candidate.id)
  const pass =
    ids.includes('EQUIP:torso:diamond_chestplate') &&
    ids.some((id) => id.startsWith('MINE:') || id.startsWith('ACCESS:'))
  return { pass, detail: JSON.stringify(ids) }
})

addCase('(d) an EQUIP offer never starves the inputs-held craft ladder', () => {
  const state = craftWorldState({ birch_planks: 4, stick: 2, diamond_chestplate: 1 })
  const grounded = generateGroundedCandidates(state, { ...defaultCandidateOptions, recipes })
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const pass =
    ids.includes('EQUIP:torso:diamond_chestplate') &&
    ids.some((id) => id.startsWith('CRAFT:'))
  return { pass, detail: JSON.stringify(ids) }
})

addCase('(d) guardEquip accepts a live carried piece and denies a stale one', () => {
  const state = worldState({ counts: { diamond_chestplate: 1 } })
  const candidate = candidateById(equipCandidates(generateGroundedCandidates(state).candidates), 'EQUIP:torso:diamond_chestplate')
  const context: GuardContext = {
    phase: 'decision',
    candidateIds: new Set([candidate.id]),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 100,
  }
  const accepted = guardCandidate(candidate, state, context)
  const gone = guardCandidate(
    { ...candidate, itemName: 'netherite_chestplate' },
    state,
    { ...context, candidateIds: new Set([candidate.id]) },
  )
  const pass = accepted.ok === true && gone.ok === false && gone.code === 'EMPTY_HAND'
  return { pass, detail: `accepted=${JSON.stringify(accepted)} gone=${JSON.stringify(gone)}` }
})

addCase('(d) EQUIP is an acting kind and a strict self-evident post-condition', () => {
  const state = worldState({ counts: { diamond_chestplate: 1 } })
  const candidate = candidateById(equipCandidates(generateGroundedCandidates(state).candidates), 'EQUIP:torso:diamond_chestplate')
  const verified = truthfulActionOutcome({ kind: 'EQUIP', status: 'done', verified: true, itemsGained: 0, blockRemoved: false })
  const unverified = truthfulActionOutcome({ kind: 'EQUIP', status: 'done', verified: false, itemsGained: 0, blockRemoved: false })
  const pass =
    ACTING_KINDS.has('EQUIP') &&
    candidate.kind === 'EQUIP' &&
    verified.verified === true &&
    verified.status === 'done' &&
    verified.resetsFailureMemory === true &&
    unverified.verified === false &&
    unverified.observableProgress === false &&
    unverified.resetsFailureMemory === false
  return { pass, detail: `verified=${JSON.stringify(verified)} unverified=${JSON.stringify(unverified)}` }
})

addCase('(d) the old hand-only inventory view is unchanged: worn armor is not a carried item', () => {
  const armor = { head: null, torso: { name: 'diamond_chestplate' }, legs: null, feet: null }
  const state = worldState({ armor, counts: { diamond_chestplate: 1, cobblestone: 64 } })
  // The carried chestplate is an upgrade refusal (equal), the pickaxe-like stack is untouched.
  const pass =
    inventoryCount(state.inventory.counts, 'cobblestone') === 64 &&
    armorEquipOffers(armor, state.inventory.counts).length === 0 &&
    armorEquipRefusals(armor, state.inventory.counts).length === 1
  return { pass, detail: `counts=${JSON.stringify(state.inventory.counts)}` }
})

// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('LIVE armor-equip affordance + combat weapon-in-hand\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} equip-affordance cases passed\n`)
if (failures > 0) process.exit(1)
