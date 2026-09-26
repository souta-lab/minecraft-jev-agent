// Goal-directed mob hunt regression: a producer ATTACK is a bounded Skill whose
// mechanical completion is Mineflayer's `entityDead` event. Semantic collect
// progress still requires the wanted drop to reach the inventory, and a mob that
// despawns/escapes (no death event) is a typed non-completion - never a silent
// "the mob disappeared" success.
//
//   bun test ./test-mob-hunt.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { Candidate } from './src/candidates.ts'
import { classifyActionOutcome } from './src/actionPostcondition.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

class P {
  constructor(public x: number, public y: number, public z: number) {}
  clone(): P { return new P(this.x, this.y, this.z) }
  set(x: number, y: number, z: number): P { this.x = x; this.y = y; this.z = z; return this }
  offset(x: number, y: number, z: number): P { return new P(this.x + x, this.y + y, this.z + z) }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

type HuntMode = 'drop' | 'no-drop' | 'despawn'

interface HuntFixture {
  bot: Bot
  emitter: EventEmitter
  attacks: () => number
  pearls: () => number
}

function makeFixture(mode: HuntMode): HuntFixture {
  const emitter = new EventEmitter()
  const feet = new P(0, 64, 0)
  const mob = { id: 31, name: 'enderman', kind: 'mob', height: 2.9, isValid: true, position: new P(1, 64, 0) }
  const pearlId = registry.itemsByName.ender_pearl.id
  let pearls = 0
  let attacks = 0
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry,
    health: 20,
    oxygenLevel: 20,
    blockAt: () => null,
    physicsEnabled: true,
    entity: { id: 1, position: feet, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: { 31: mob },
    inventory: {
      count: (id: number) => (id === pearlId ? pearls : 0),
      items: () => pearls > 0 ? [{ name: 'ender_pearl', type: pearlId, count: pearls, slot: 0 }] : [],
    },
    pathfinder: {
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    lookAt: async () => undefined,
    attack: (entity: typeof mob) => {
      attacks += 1
      if (mode === 'despawn') {
        // The mob escapes/despawns: it leaves the sensed entity set without a
        // server `entityDead` event.
        delete bot.entities[entity.id]
        return
      }
      if (mode === 'drop') pearls += 1
      emitter.emit('entityDead', entity)
      delete bot.entities[entity.id]
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  return { bot: bot as unknown as Bot, emitter, attacks: () => attacks, pearls: () => pearls }
}

function huntCandidate(): Candidate {
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

async function run(mode: HuntMode) {
  const fixture = makeFixture(mode)
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    goalItem: 'ender_pearl',
    verifyTimeoutMs: 700,
    pickupPathTimeoutMs: 700,
  })
  const result = await fixtureClaim(executor, huntCandidate()).completion
  return { fixture, result }
}

let failures = 0
const report = (pass: boolean, name: string, detail: string): void => {
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

process.stdout.write('goal-directed mob hunt: entity death and drop acquisition stay distinct\n')
process.stdout.write(`${'-'.repeat(80)}\n`)

{
  const { fixture, result } = await run('drop')
  const taxonomy = classifyActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: result.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    entityDefeated: result.entityDefeated,
    semanticProgress: result.itemsGained > 0,
  })
  const pass =
    result.status === 'done' && result.verified && result.entityDefeated === true &&
    result.itemsGained === 1 && result.yieldItem === 'ender_pearl' &&
    fixture.attacks() === 1 && fixture.pearls() === 1 &&
    fixture.emitter.listenerCount('entityDead') === 0 && taxonomy.progress === 'goal'
  report(pass, 'entityDead + acquired drop is verified goal progress',
    `status=${result.status} defeated=${result.entityDefeated} gained=${result.itemsGained} progress=${taxonomy.progress} listeners=${fixture.emitter.listenerCount('entityDead')}`)
}

{
  const { fixture, result } = await run('no-drop')
  const taxonomy = classifyActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: result.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    entityDefeated: result.entityDefeated,
    semanticProgress: result.itemsGained > 0,
  })
  const pass =
    result.status === 'failed' && result.failure === 'drop_not_acquired' && !result.verified &&
    result.entityDefeated === true && result.dropAcquired === false &&
    result.itemsGained === 0 && fixture.pearls() === 0 &&
    fixture.emitter.listenerCount('entityDead') === 0 && taxonomy.progress === 'search' && taxonomy.semantic === 'none'
  report(pass, 'entityDead without the drop is search progress, never collect completion',
    `status=${result.status} failure=${result.failure} verified=${result.verified} defeated=${result.entityDefeated} gained=${result.itemsGained} progress=${taxonomy.progress}/${taxonomy.semantic} listeners=${fixture.emitter.listenerCount('entityDead')}`)
}

{
  const { fixture, result } = await run('despawn')
  const taxonomy = classifyActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: result.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    entityDefeated: result.entityDefeated,
    semanticProgress: result.itemsGained > 0,
  })
  const pass =
    result.status === 'failed' && result.verified === false &&
    result.failure === 'verify_failed' && result.phase === 'target-not-defeated' &&
    result.entityDefeated === false && result.itemsGained === 0 &&
    fixture.pearls() === 0 && fixture.emitter.listenerCount('entityDead') === 0 &&
    taxonomy.progress === 'none' && taxonomy.semantic === 'none'
  report(pass, 'a mob that despawns/escapes is a typed non-completion, never a collect',
    `status=${result.status} failure=${result.failure} phase=${result.phase} defeated=${result.entityDefeated} gained=${result.itemsGained} progress=${taxonomy.progress}`)
}

process.stdout.write(`${'-'.repeat(80)}\n`)
process.stdout.write(`${3 - failures}/3 mob-hunt executor cases passed\n`)
if (failures > 0) process.exit(1)
