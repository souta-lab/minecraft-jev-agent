import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { test } from 'bun:test'
import type { Candidate } from './src/candidates.ts'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import type { InternalEffectActuationOutcome, InternalEffectReservation } from './src/executor.ts'
import type { EffectEnvelope } from './src/skillCommitment.ts'
import { EventLogger } from './src/jev.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

function candidate(): Candidate {
  return {
    id: 'EQUIP:torso:iron_chestplate',
    kind: 'EQUIP',
    label: 'equip iron_chestplate to torso',
    targetName: 'iron_chestplate',
    target: null,
    targetEntityId: null,
    itemName: 'iron_chestplate',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, slot: 'torso', itemName: 'iron_chestplate' },
  }
}

function makeFixture(equip: (item: { name: string }, destination: string) => Promise<void>): {
  bot: Bot
  equipCalls: () => number
} {
  let calls = 0
  const slots: Array<{ name?: string } | null> = new Array(46).fill(null)
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>
  Object.assign(emitter, {
    registry,
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    entity: {
      id: 1,
      position: new Vec3(0.5, 64, 0.5),
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
    },
    inventory: {
      slots,
      items: () => [{ name: 'iron_chestplate', type: registry.itemsByName.iron_chestplate.id, count: 1, slot: 39 }],
      count: () => 1,
    },
    pathfinder: {
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    blockAt: () => null,
    stopDigging: () => undefined,
    clearControlStates: () => undefined,
    setControlState: () => undefined,
    canDigBlock: () => false,
    equip: async (item: { name: string }, destination: string) => {
      calls += 1
      await equip(item, destination)
      const slot = { head: 5, torso: 6, legs: 7, feet: 8 }[destination as 'head' | 'torso' | 'legs' | 'feet']
      if (slot !== undefined) slots[slot] = { name: item.name }
    },
  })
  return { bot: emitter as unknown as Bot, equipCalls: () => calls }
}

function block(name: string, x: number, y: number, z: number, boundingBox: 'block' | 'empty' = 'block') {
  return { name, position: new Vec3(x, y, z), boundingBox, diggable: true, hardness: 1 }
}

function makePlaceFixture(actuate: (position: { x: number; y: number; z: number }) => Promise<void>): {
  bot: Bot
  placedBlock: () => string | null
} {
  const grid = new Map<string, ReturnType<typeof block>>([
    ['1,63,0', block('stone', 1, 63, 0)],
  ])
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>
  Object.assign(emitter, {
    registry,
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    oxygenLevel: 300,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    heldItem: { name: 'cobblestone', type: registry.itemsByName.cobblestone.id },
    inventory: {
      slots: new Array(46).fill(null),
      items: () => [{ name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 1, slot: 36 }],
      count: () => 1,
    },
    pathfinder: { setMovements: () => undefined, setGoal: () => undefined, stop: () => undefined, getPathTo: () => ({ status: 'success', path: [] }) },
    blockAt: (position: { x: number; y: number; z: number }) => grid.get(key(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))) ?? null,
    placeBlock: async (reference: ReturnType<typeof block>, face: { x: number; y: number; z: number }) => {
      const position = {
        x: reference.position.x + face.x,
        y: reference.position.y + face.y,
        z: reference.position.z + face.z,
      }
      await actuate(position)
      grid.set(key(position.x, position.y, position.z), block('cobblestone', position.x, position.y, position.z))
    },
    stopDigging: () => undefined,
    clearControlStates: () => undefined,
    setControlState: () => undefined,
    canDigBlock: () => true,
    lookAt: async () => undefined,
  })
  return {
    bot: emitter as unknown as Bot,
    placedBlock: () => grid.get('1,64,0')?.name ?? null,
  }
}

function placeCandidate(): Candidate {
  return {
    id: 'PLACE:cobblestone:p1_64_0',
    kind: 'PLACE',
    label: 'place cobblestone at 1,64,0',
    targetName: 'cobblestone',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: null,
    itemName: 'cobblestone',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

function makeDigFixture(actuate: () => Promise<void>): { bot: Bot; targetBlock: () => string | null } {
  let target: ReturnType<typeof block> | null = block('stone', 1, 64, 0)
  const listeners = new EventEmitter()
  const emitter = listeners as EventEmitter & Record<string, any>
  Object.assign(emitter, {
    registry,
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    oxygenLevel: 300,
    physicsEnabled: false,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    inventory: { items: () => [], count: () => 0 },
    pathfinder: { setMovements: () => undefined, setGoal: () => undefined, stop: () => undefined, getPathTo: () => ({ status: 'success', path: [] }) },
    blockAt: (position: { x: number; y: number; z: number }) => {
      return Math.floor(position.x) === 1 && Math.floor(position.y) === 64 && Math.floor(position.z) === 0 ? target : null
    },
    canDigBlock: () => true,
    digTime: () => 1,
    dig: async () => {
      await actuate()
      target = null
    },
    stopDigging: () => undefined,
    lookAt: async () => undefined,
    clearControlStates: () => undefined,
    setControlState: () => undefined,
  })
  return { bot: emitter as unknown as Bot, targetBlock: () => target?.name ?? null }
}

function mineClearanceCandidate(): Candidate {
  return {
    id: 'MINE:stone:b1_64_0',
    kind: 'MINE',
    label: 'clear stone at 1,64,0',
    targetName: 'stone',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, clearance: true },
  }
}

const emptyEnvelope: EffectEnvelope = {
  mayMove: false,
  mayLook: false,
  mayJump: false,
  maySprint: false,
  mayAttackEntityIds: [],
  mayDigBlocks: [],
  mayPlaceBlocks: [],
  mayEquipItems: [],
  mayUseStations: [],
  mayTransferInventory: [],
}

function callbacks(
  before: (reservation: InternalEffectReservation) => boolean,
  after: (settlement: InternalEffectReservation & { outcome: InternalEffectActuationOutcome }) => void,
) {
  return { before, after }
}

test('VTR internal effect callbacks reserve and settle a real declared equip mutation', async () => {
  const events: string[] = []
  const reservations: InternalEffectReservation[] = []
  const settlements: Array<InternalEffectReservation & { outcome: InternalEffectActuationOutcome }> = []
  const fixture = makeFixture(async (item, destination) => {
    events.push('actuator')
    assert.equal(item.name, 'iron_chestplate')
    assert.equal(destination, 'torso')
  })
  const executor = new Executor(fixture.bot, new EventLogger(null, false), defaultExecutorOptions)
  const claimed = executor.claim(candidate(), {
    authorityLabel: 'vtr-reach',
    transitionId: 'transition:reach-effect-fixture',
    transitionContractHash: 'contract:reach-effect-fixture',
    internalEffectCallbacks: callbacks(
      (reservation) => {
        events.push('reserve')
        reservations.push(reservation)
        return true
      },
      (settlement) => {
        events.push('settle')
        settlements.push(settlement)
      },
    ),
  })

  const result = await claimed.completion
  assert.equal(result.status, 'done', result.detail)
  assert.equal(result.verified, true)
  assert.equal(fixture.equipCalls(), 1)
  assert.deepEqual(events, ['reserve', 'actuator', 'settle'])
  assert.equal(reservations.length, 1)
  assert.equal(settlements.length, 1)
  assert.equal(reservations[0]?.effectId, settlements[0]?.effectId)
  assert.equal(reservations[0]?.actionId, candidate().id)
  assert.equal(reservations[0]?.actionEpoch, claimed.epoch)
  assert.equal(reservations[0]?.transitionId, 'transition:reach-effect-fixture')
  assert.deepEqual(reservations[0]?.effect, {
    type: 'equip',
    itemName: 'iron_chestplate',
    destination: 'torso',
  })
  assert.deepEqual(settlements[0]?.outcome, { status: 'actuator-returned' })
  assert.match(reservations[0]?.effectId ?? '', /^EQUIP:torso:iron_chestplate:epoch:\d+:effect:1$/)
})

test('place callbacks carry the exact declared block and cell around the real placement path', async () => {
  const events: string[] = []
  const settlements: Array<InternalEffectReservation & { outcome: InternalEffectActuationOutcome }> = []
  const fixture = makePlaceFixture(async (position) => {
    events.push(`actuator:${position.x},${position.y},${position.z}`)
  })
  const executor = new Executor(fixture.bot, new EventLogger(null, false), defaultExecutorOptions)
  const claimed = executor.claim(placeCandidate(), {
    authorityLabel: 'vtr-reach',
    transitionId: 'transition:reach-place-fixture',
    transitionContractHash: 'contract:reach-place-fixture',
    internalEffectCallbacks: callbacks(
      (reservation) => {
        events.push('reserve')
        assert.deepEqual(reservation.effect, {
          type: 'place',
          position: { x: 1, y: 64, z: 0 },
          itemName: 'cobblestone',
        })
        return true
      },
      (settlement) => {
        events.push(`settle:${settlement.outcome.status}`)
        settlements.push(settlement)
      },
    ),
  })
  const result = await claimed.completion

  assert.equal(result.status, 'done', result.detail)
  assert.equal(result.verified, true)
  assert.equal(fixture.placedBlock(), 'cobblestone')
  assert.deepEqual(events, ['reserve', 'actuator:1,64,0', 'settle:actuator-returned'])
  assert.equal(settlements.length, 1)
  assert.deepEqual(settlements[0]?.outcome, { status: 'actuator-returned' })
})

test('dig callbacks reserve the exact block cell at the actual dig mutation', async () => {
  const events: string[] = []
  const settlements: Array<InternalEffectReservation & { outcome: InternalEffectActuationOutcome }> = []
  const fixture = makeDigFixture(async () => { events.push('actuator') })
  const executor = new Executor(fixture.bot, new EventLogger(null, false), defaultExecutorOptions)
  const claimed = executor.claim(mineClearanceCandidate(), {
    authorityLabel: 'vtr-reach',
    transitionId: 'transition:reach-dig-fixture',
    transitionContractHash: 'contract:reach-dig-fixture',
    internalEffectCallbacks: callbacks(
      (reservation) => {
        events.push('reserve')
        assert.deepEqual(reservation.effect, {
          type: 'dig',
          position: { x: 1, y: 64, z: 0 },
          blockName: 'stone',
        })
        return true
      },
      (settlement) => {
        events.push(`settle:${settlement.outcome.status}`)
        settlements.push(settlement)
      },
    ),
  })
  const result = await claimed.completion

  assert.equal(result.status, 'done', result.detail)
  assert.equal(result.verified, true)
  assert.equal(result.blockRemoved, true)
  assert.equal(fixture.targetBlock(), null)
  assert.deepEqual(events, ['reserve', 'actuator', 'settle:actuator-returned'])
  assert.equal(settlements.length, 1)
  assert.deepEqual(settlements[0]?.outcome, { status: 'actuator-returned' })
})

test('a reservation refusal aborts before the Bot mutation', async () => {
  const fixture = makeFixture(async () => {
    throw new Error('Bot equip must not run after reservation refusal')
  })
  let afterCalls = 0
  const executor = new Executor(fixture.bot, new EventLogger(null, false), defaultExecutorOptions)
  const claimed = executor.claim(candidate(), {
    authorityLabel: 'vtr-reach',
    transitionId: 'transition:reach-reservation-refused',
    transitionContractHash: 'contract:reach-reservation-refused',
    internalEffectCallbacks: callbacks(() => false, () => { afterCalls += 1 }),
  })
  const result = await claimed.completion

  assert.equal(result.status, 'failed')
  assert.equal(result.failure, 'effect_reservation_refused')
  assert.equal(result.verified, false)
  assert.equal(fixture.equipCalls(), 0)
  assert.equal(afterCalls, 0)
})

test('an actuator rejection is reported as rejected, never as settled success', async () => {
  const events: string[] = []
  const settlements: Array<InternalEffectReservation & { outcome: InternalEffectActuationOutcome }> = []
  const fixture = makeFixture(async () => {
    events.push('actuator')
    throw new Error('equip packet rejected')
  })
  const executor = new Executor(fixture.bot, new EventLogger(null, false), defaultExecutorOptions)
  const claimed = executor.claim(candidate(), {
    authorityLabel: 'vtr-reach',
    transitionId: 'transition:reach-effect-failed',
    transitionContractHash: 'contract:reach-effect-failed',
    internalEffectCallbacks: callbacks(
      () => {
        events.push('reserve')
        return true
      },
      (settlement) => {
        events.push('settle')
        settlements.push(settlement)
      },
    ),
  })
  const result = await claimed.completion

  assert.equal(result.status, 'failed')
  assert.equal(result.verified, false)
  assert.deepEqual(events, ['reserve', 'actuator', 'settle'])
  assert.equal(settlements.length, 1)
  assert.deepEqual(settlements[0]?.outcome, { status: 'actuator-rejected', error: 'equip packet rejected' })
  assert.notDeepEqual(settlements[0]?.outcome, { status: 'actuator-returned' })
})

test('the candidate effect envelope still rejects an undeclared mutation before reservation', async () => {
  const fixture = makeFixture(async () => {
    throw new Error('Bot equip must not run for an undeclared effect')
  })
  let beforeCalls = 0
  let afterCalls = 0
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    effectEnvelopeOverride: emptyEnvelope,
  })
  const claimed = executor.claim(candidate(), {
    authorityLabel: 'vtr-reach',
    transitionId: 'transition:reach-undeclared-effect',
    transitionContractHash: 'contract:reach-undeclared-effect',
    internalEffectCallbacks: callbacks(
      () => {
        beforeCalls += 1
        return true
      },
      () => { afterCalls += 1 },
    ),
  })
  const result = await claimed.completion

  assert.equal(result.status, 'failed')
  assert.equal(result.failure, 'effect_envelope_violation')
  assert.equal(result.verified, false)
  assert.equal(fixture.equipCalls(), 0)
  assert.equal(beforeCalls, 0)
  assert.equal(afterCalls, 0)
})
