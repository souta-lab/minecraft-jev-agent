// probe-hunt-teleport.mts - BEFORE/AFTER evidence for the teleporting-producer
// hunt. Uses ONLY exports that exist on both sides of the change, so the same
// file can be run against origin/main and against the fixed tree:
//
//   bun jev-agent/data/probe-hunt-teleport.mts
//
// Two shapes, both taken from the live measurement (2026-09-21T17:07-17:08,
// `ATTACK:e1758` enderman, lease ended after 1.0-2.0 s with ZERO swings):
//   1. the enderman TELEPORTS after one landed swing, and a second enderman is
//      already sensed;
//   2. the enderman has ALREADY left the tracked set before the first swing.
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, defaultExecutorOptions } from '../src/executor.ts'
import { EventLogger } from '../src/jev.ts'
import type { Candidate } from '../src/candidates.ts'
import { fixtureClaim } from '../test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const pearlId = registry.itemsByName.ender_pearl.id

class P {
  constructor(public x: number, public y: number, public z: number) {}
  clone(): P { return new P(this.x, this.y, this.z) }
  offset(x: number, y: number, z: number): P { return new P(this.x + x, this.y + y, this.z + z) }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

function fixture(shape: 'after-hit' | 'before-first-swing') {
  const emitter = new EventEmitter()
  const feet = new P(0, 64, 0)
  let pearls = 0
  let swings = 0
  const logs: string[] = []
  const logger = new EventLogger(null, false)
  const originalLog = logger.log.bind(logger)
  logger.log = (source, level, message, detail = {}, tick = null) => {
    logs.push(message)
    originalLog(source, level, message, detail, tick)
  }
  const primary = { id: 31, name: 'enderman', kind: 'hostile', height: 2.9, isValid: true, position: new P(1, 64, 0) }
  const second = { id: 32, name: 'enderman', kind: 'hostile', height: 2.9, isValid: true, position: new P(2, 64, 0) }
  const entities: Record<number, unknown> = { 31: primary }
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry,
    health: 20,
    physicsEnabled: true,
    entity: { id: 1, position: feet, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities,
    inventory: {
      count: (id: number) => (id === pearlId ? pearls : 0),
      items: () => (pearls > 0 ? [{ name: 'ender_pearl', type: pearlId, count: pearls, slot: 0 }] : []),
    },
    pathfinder: { setMovements: () => undefined, setGoal: () => undefined, stop: () => undefined, getPathTo: () => ({ status: 'success', path: [] }) },
    lookAt: async () => undefined,
    attack: (entity: { id: number }) => {
      swings += 1
      if (entity.id === 31) {
        // the teleport: the instance leaves the tracked set, no death event
        delete entities[31]
        entities[32] = second
        return
      }
      if (entity.id === 32) {
        pearls += 1
        emitter.emit('entityDead', entity)
        delete entities[32]
      }
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  if (shape === 'before-first-swing') delete entities[31]
  return { bot: bot as unknown as Bot, logger, logs, swings: () => swings, pearls: () => pearls }
}

function candidate(): Candidate {
  return {
    id: 'ATTACK:e31',
    kind: 'ATTACK',
    label: 'hunt enderman for ender_pearl',
    targetName: 'enderman',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: 31,
    itemName: 'ender_pearl',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, entityId: 31, distance: 1, goalDrop: 'ender_pearl', requiresKill: true },
  }
}

for (const shape of ['after-hit', 'before-first-swing'] as const) {
  const f = fixture(shape)
  const executor = new Executor(f.bot, f.logger, {
    ...defaultExecutorOptions,
    goalItem: 'ender_pearl',
    verifyTimeoutMs: 300,
    pickupPathTimeoutMs: 300,
  })
  const started = Date.now()
  const result = await fixtureClaim(executor, candidate()).completion
  process.stdout.write(`\n== hunt shape: ${shape}\n`)
  process.stdout.write(
    `   status=${result.status} failure=${result.failure} phase=${result.phase} verified=${result.verified} ` +
      `defeated=${String(result.entityDefeated)} gained=${result.itemsGained} swings=${f.swings()} pearls=${f.pearls()} ms=${Date.now() - started}\n`,
  )
  process.stdout.write(`   huntEnd=${String(result.huntEnd)} reacquired=${String(result.huntReacquired)} lastKnown=${JSON.stringify(result.huntLastKnown ?? null)}\n`)
  process.stdout.write(`   detail=${result.detail}\n`)
  const hunt = f.logs.filter((line) => line.startsWith('HUNT_') || line.startsWith('ATTACK_'))
  process.stdout.write(`   huntMarkers=${JSON.stringify(hunt)}\n`)
}
