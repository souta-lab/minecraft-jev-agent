// Issue #391 - outcome truth for a non-hunt ATTACK.
//
// Live evidence (consolidated 12-min window): `ATTACK:e4698` at
// phase=closing-to-melee-range kept being re-offered while the target stayed
// unreachable and the body drowned. The ATTACK lease counted issued swings
// (`bot.attack()` calls) and reported `done`/`verified=true`, so nothing in the
// loop - failure memory, the candidate filter, the beta boundary - could see
// that no hit had ever happened.
//
// This fixture pins the evidence bar for the two ATTACK contracts:
//
//   * a non-hunt ATTACK (self-defence / food) is a success only on a
//     SERVER-OBSERVED hit on the target: an `entityHurt` attributable to this
//     lease (the server `damage_event` source is our own entity, or the hurt
//     arrived inside the post-swing correlation window), or the target died
//     during the lease. Issuing swings proves nothing.
//     The bar is a HIT, never a kill: a connected swipe against a mob that
//     survives is still a successful ATTACK.
//   * a goal-drop mob hunt keeps its own, stricter contract: `entityDead` plus
//     the drop reaching the inventory. A hit is not a kill.
//
// The failing-before cases are (a) no-hit, (c) foreign-attributed hurt,
// (d) vanished target and (e) connected-hit evidence; (b) the hunt contract is
// the existing, already-typed behaviour.
//
//   bun test ./test-attack-outcome.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { Candidate } from './src/candidates.ts'
import type { ExecutionResult } from './src/executor.ts'
import { classifyActionOutcome, truthfulActionOutcome } from './src/actionPostcondition.ts'

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

/**
 * `no-hit`        swings land on nothing (the live shape)
 * `hit`           each swing's damage is attributed to the bot by the server
 * `foreign-hit`   the target is hurt, but by another entity
 * `vanished`      the target leaves the entity set without hurt or death
 * `hunt-hurt`     goalDrop hunt that lands hits but never observes entityDead
 */
type AttackMode = 'no-hit' | 'hit' | 'foreign-hit' | 'vanished' | 'hunt-hurt'

interface Fixture {
  bot: Bot
  emitter: EventEmitter
  attacks: () => number
}

function makeFixture(mode: AttackMode): Fixture {
  const emitter = new EventEmitter()
  const feet = new P(0, 64, 0)
  const mob = { id: 31, name: 'zombie', kind: 'hostile', height: 1.95, isValid: true, position: new P(1, 64, 0) }
  const bystander = { id: 99, name: 'skeleton', kind: 'hostile', height: 1.99, isValid: true, position: new P(6, 64, 0) }
  const pearlId = registry.itemsByName.ender_pearl.id
  let attacks = 0
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry,
    health: 20,
    oxygenLevel: 20,
    physicsEnabled: true,
    entity: { id: 1, position: feet, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: { 31: mob },
    blockAt: () => null,
    inventory: {
      count: (id: number) => (id === pearlId ? 0 : 0),
      items: () => [],
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
      if (mode === 'vanished') {
        delete bot.entities[entity.id]
        return
      }
      if (mode === 'hit' || mode === 'hunt-hurt') {
        // The server round-trip is asynchronous: `damage_event` arrives after
        // the swing packet, never inside the `bot.attack()` call.
        setTimeout(() => emitter.emit('entityHurt', entity, bot.entity), 10)
        return
      }
      if (mode === 'foreign-hit') {
        setTimeout(() => emitter.emit('entityHurt', entity, bystander), 10)
      }
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  return { bot: bot as unknown as Bot, emitter, attacks: () => attacks }
}

function attackCandidate(goalDrop: string | null): Candidate {
  return {
    id: 'ATTACK:e31',
    kind: 'ATTACK',
    label: 'attack zombie 1m away',
    targetName: 'zombie',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: 31,
    itemName: goalDrop,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      tick: 1,
      entityId: 31,
      distance: 1,
      ...(goalDrop === null ? {} : { goalDrop, requiresKill: true }),
    },
  }
}

async function run(mode: AttackMode, goalDrop: string | null) {
  const fixture = makeFixture(mode)
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    goalItem: 'ender_pearl',
    verifyTimeoutMs: 700,
    pickupPathTimeoutMs: 700,
  })
  const result = await executor.claim(attackCandidate(goalDrop)).completion
  return { fixture, result }
}

/** The exact truth + taxonomy the controller derives from one settled result. */
function layers(result: ExecutionResult) {
  const truth = truthfulActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: result.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    progressed: result.progressed,
    entityDefeated: result.entityDefeated,
    damageObserved: result.damageObserved,
  })
  const taxonomy = classifyActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: truth.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    progressed: result.progressed,
    entityDefeated: result.entityDefeated,
    damageObserved: result.damageObserved,
    failureCode: result.failure,
  })
  return { truth, taxonomy }
}

function evidence(result: ExecutionResult): string {
  return (
    `status=${result.status} verified=${result.verified} failure=${result.failure} phase=${result.phase} ` +
    `hits=${result.attackHits} damageObserved=${result.damageObserved} targetHealthDelta=${result.targetHealthDelta}`
  )
}

let failures = 0
const report = (pass: boolean, name: string, detail: string): void => {
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

process.stdout.write('issue #391 - a non-hunt ATTACK needs hit evidence, a hunt needs the death event\n')
process.stdout.write(`${'-'.repeat(80)}\n`)

{
  const { fixture, result } = await run('no-hit', null)
  const { truth, taxonomy } = layers(result)
  const pass =
    result.status === 'failed' &&
    result.verified === false &&
    result.failure === 'verify_failed' &&
    result.phase === 'no-hit' &&
    result.attackHits === 0 &&
    result.damageObserved === false &&
    result.entityDefeated !== true &&
    fixture.attacks() >= 1 &&
    truth.verified === false &&
    truth.observableProgress === false &&
    truth.resetsFailureMemory === false &&
    taxonomy.progress === 'none' &&
    taxonomy.execution === 'failure' &&
    taxonomy.verification === 'unverified' &&
    fixture.emitter.listenerCount('entityHurt') === 0 &&
    fixture.emitter.listenerCount('entityDead') === 0
  report(
    pass,
    'swings that never connect are a typed non-success, never a successful attack',
    `${evidence(result)} truth(observable=${truth.observableProgress} resets=${truth.resetsFailureMemory}) ` +
      `taxonomy(exec=${taxonomy.execution} verify=${taxonomy.verification} progress=${taxonomy.progress}) swings=${fixture.attacks()}`,
  )
}

{
  const { fixture, result } = await run('hit', null)
  const { truth, taxonomy } = layers(result)
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.failure === null &&
    result.attackHits !== undefined &&
    result.attackHits >= 1 &&
    result.damageObserved === true &&
    result.entityDefeated !== true &&
    fixture.attacks() >= 1 &&
    truth.verified === true &&
    truth.observableProgress === true &&
    truth.resetsFailureMemory === true &&
    taxonomy.verification === 'verified' &&
    taxonomy.progress === 'search' &&
    fixture.emitter.listenerCount('entityHurt') === 0
  report(
    pass,
    'a connected hit is a verified ATTACK without requiring a kill',
    `${evidence(result)} truth(observable=${truth.observableProgress} resets=${truth.resetsFailureMemory}) ` +
      `taxonomy(verify=${taxonomy.verification} progress=${taxonomy.progress}) swings=${fixture.attacks()}`,
  )
}

{
  const { fixture, result } = await run('foreign-hit', null)
  const { taxonomy } = layers(result)
  const pass =
    result.status === 'failed' &&
    result.verified === false &&
    result.failure === 'verify_failed' &&
    result.phase === 'no-hit' &&
    result.attackHits === 0 &&
    result.damageObserved === false &&
    taxonomy.progress === 'none' &&
    fixture.attacks() >= 1
  report(
    pass,
    'damage attributed to another entity is not this ATTACK hit',
    `${evidence(result)} taxonomy(progress=${taxonomy.progress}) swings=${fixture.attacks()}`,
  )
}

{
  const { fixture, result } = await run('vanished', null)
  const { taxonomy } = layers(result)
  const pass =
    result.status === 'failed' &&
    result.verified === false &&
    result.failure === 'verify_failed' &&
    result.phase === 'no-hit' &&
    result.attackHits === 0 &&
    result.entityDefeated !== true &&
    taxonomy.progress === 'none' &&
    fixture.attacks() >= 1
  report(
    pass,
    'a target that leaves the entity set is not automatically a hit',
    `${evidence(result)} taxonomy(progress=${taxonomy.progress}) swings=${fixture.attacks()}`,
  )
}

{
  const { fixture, result } = await run('hunt-hurt', 'ender_pearl')
  const { truth, taxonomy } = layers(result)
  // Hits are real target-state evidence (search progress), but the hunt's own
  // contract is the server death event: without `entityDead` plus the drop it
  // stays a typed non-completion and never advances the Option.
  const pass =
    result.status === 'failed' &&
    result.verified === false &&
    result.failure === 'verify_failed' &&
    result.phase === 'target-not-defeated' &&
    result.entityDefeated === false &&
    result.itemsGained === 0 &&
    result.damageObserved === true &&
    result.attackHits !== undefined &&
    result.attackHits >= 1 &&
    truth.verified === false &&
    truth.resetsFailureMemory === false &&
    taxonomy.execution === 'failure' &&
    taxonomy.verification === 'unverified' &&
    taxonomy.progress === 'search' &&
    taxonomy.semantic === 'none' &&
    fixture.emitter.listenerCount('entityHurt') === 0 &&
    fixture.emitter.listenerCount('entityDead') === 0
  report(
    pass,
    'a goal-drop hunt that lands hits but sees no entityDead is still a non-completion',
    `${evidence(result)} defeated=${result.entityDefeated} gained=${result.itemsGained} ` +
      `truth(resets=${truth.resetsFailureMemory}) taxonomy(exec=${taxonomy.execution} progress=${taxonomy.progress} semantic=${taxonomy.semantic}) swings=${fixture.attacks()}`,
  )
}

{
  // Defense in depth, executor-free: even a raw result that CLAIMS
  // `done`/`verified=true` for an ATTACK must not be recorded as observable
  // success when no target-state evidence came with it. This is the truth-layer
  // half of issue #391 - ATTACK is no longer a self-evident verified kind.
  const nakedClaim = truthfulActionOutcome({
    kind: 'ATTACK',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
  })
  const withHit = truthfulActionOutcome({
    kind: 'ATTACK',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    damageObserved: true,
  })
  const taxonomy = classifyActionOutcome({
    kind: 'ATTACK',
    status: 'done',
    verified: nakedClaim.verified,
    itemsGained: 0,
    blockRemoved: false,
  })
  const pass =
    nakedClaim.verified === false &&
    nakedClaim.status === 'zero_progress' &&
    nakedClaim.observableProgress === false &&
    nakedClaim.downgraded === true &&
    nakedClaim.resetsFailureMemory === false &&
    withHit.verified === true &&
    withHit.status === 'done' &&
    withHit.observableProgress === true &&
    withHit.resetsFailureMemory === true &&
    taxonomy.progress === 'none'
  report(
    pass,
    'the truth layer rejects a bare ATTACK `verified=true` claim with no hit evidence',
    `naked=${JSON.stringify(nakedClaim)} withHit(verified=${withHit.verified} observable=${withHit.observableProgress}) taxonomy(progress=${taxonomy.progress})`,
  )
}

process.stdout.write(`${'-'.repeat(80)}\n`)
process.stdout.write(`${6 - failures}/6 attack-outcome cases passed\n`)
if (failures > 0) process.exit(1)
