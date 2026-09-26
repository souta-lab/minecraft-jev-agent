// test-actuation-port.mts - Issue #38: the leased allowlist ActuationPort and the
// nested-capability guards. Pure: no bot connection, no socket, no network.
//
// Covers the three bypass families named in #38:
//   raw protocol write  (bot._client.write)
//   plugin capability   (bot.collectBlock.collect)
//   direct state change (bot.entity.position.set / entity.yaw =)
import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'
import { Vec3 } from 'vec3'
import { ACTUATION_PORT_OPERATIONS } from '../jev-agent/src/actuationPort.ts'
import {
  ActuationLeaseManager,
  STRICT_ACTUATION_ENV,
  assertActuationSurfaceCovered,
  createActuationPort,
  isLeasedBot,
  withActuationLease,
} from './resident-safety.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function throwsMessage(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

interface FakeBot {
  writes: Array<{ name: string; payload: Record<string, unknown> }>
  collects: number
  digCalls: number
  entity: { position: Vec3; yaw: number; pitch: number; onGround: boolean }
  _client: { write: (name: string, payload: Record<string, unknown>) => boolean }
  collectBlock: { collect: (entity: unknown, options?: unknown) => Promise<unknown> }
  pathfinder: { setGoal: (goal: unknown) => void; stop: () => void; setMovements: () => void; goto: () => void }
  dig: () => string
  look: () => string
}

function makeFakeBot(): FakeBot {
  const bot: FakeBot = {
    writes: [],
    collects: 0,
    digCalls: 0,
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, onGround: false },
    _client: {
      write: (name, payload) => {
        bot.writes.push({ name, payload })
        return true
      },
    },
    collectBlock: {
      collect: async () => {
        bot.collects += 1
        return undefined
      },
    },
    pathfinder: { setGoal: () => undefined, stop: () => undefined, setMovements: () => undefined, goto: () => undefined },
    dig: () => {
      bot.digCalls += 1
      return 'dug'
    },
    look: () => 'looked',
  }
  return bot
}

addCase('#38 the port exposes only the allowlisted operations (no raw escape hatch)', () => {
  const manager = new ActuationLeaseManager()
  const port = createActuationPort(makeFakeBot() as unknown as Bot, manager, 'g1')
  const required = port as unknown as Record<string, unknown>
  const missing = ACTUATION_PORT_OPERATIONS.filter((operation) => typeof required[operation] !== 'function')
  const escape = ['bot', '_client', 'collectBlock', 'entity'].filter((name) => name in required)
  const pass = missing.length === 0 && escape.length === 0 && port.generationId === 'g1'
  return { pass, detail: `operations=${ACTUATION_PORT_OPERATIONS.length} missing=[${missing.join(',')}] escape=[${escape.join(',')}]` }
})

addCase('#38 admitted lease: writeMovementPacket delegates to _client.write', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const port = createActuationPort(fake as unknown as Bot, manager, 'g1')
  manager.acquire('g1')
  const error = throwsMessage(() => port.writeMovementPacket('position_look', { x: 1, y: 2, z: 3 }))
  const pass = error === null && fake.writes.length === 1 && fake.writes[0]!.name === 'position_look'
  return { pass, detail: `error=${error} writes=${JSON.stringify(fake.writes)}` }
})

addCase('#38 denied lease: writeMovementPacket is refused, logged, and no packet is written', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const logs: Array<{ event: string; detail: Record<string, unknown> }> = []
  const port = createActuationPort(fake as unknown as Bot, manager, 'g1', (event, detail) => logs.push({ event, detail: detail ?? {} }))
  manager.acquire('g1')
  manager.revoke('replaced-by-new-generation')
  const message = throwsMessage(() => port.writeMovementPacket('position_look', { x: 9, y: 9, z: 9 }))
  const denied = logs.find((entry) => entry.event === 'LEASE_DENIED')
  const pass =
    message !== null &&
    message.includes('ACTUATION_LEASE_DENIED') &&
    message.includes('what=port.writeMovementPacket') &&
    fake.writes.length === 0 &&
    denied !== undefined &&
    denied.detail.owner === 'none' &&
    denied.detail.caller === 'g1'
  return { pass, detail: `message=${message} writes=${fake.writes.length} leaseDenied=${JSON.stringify(denied)}` }
})

addCase('#38 denied lease: collectBlock.collect is refused and never invoked', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const logs: string[] = []
  const port = createActuationPort(fake as unknown as Bot, manager, 'g1', (event) => logs.push(event))
  manager.acquire('g1')
  manager.revoke('end')
  let rejected = false
  try {
    const run = port.collect({ id: 7 } as unknown as Entity)
    run.catch(() => undefined)
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('ACTUATION_LEASE_DENIED')
  }
  const pass = rejected && fake.collects === 0 && logs.includes('LEASE_DENIED')
  return { pass, detail: `rejected=${rejected} collectCalls=${fake.collects} logs=[${logs.join(',')}]` }
})

addCase('#38 admitted lease: setPose mutates the live entity pose', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const port = createActuationPort(fake as unknown as Bot, manager, 'g1')
  manager.acquire('g1')
  port.setPose({ x: 5.5, y: 70, z: -2.5, yaw: 1.25, onGround: true })
  const pass = fake.entity.position.x === 5.5 && fake.entity.position.y === 70 && fake.entity.position.z === -2.5 && fake.entity.yaw === 1.25 && fake.entity.onGround === true
  return { pass, detail: `pos=${fake.entity.position.toString()} yaw=${fake.entity.yaw} onGround=${fake.entity.onGround}` }
})

addCase('#38 denied lease: setPose cannot mutate shared authoritative state', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const port = createActuationPort(fake as unknown as Bot, manager, 'g1')
  manager.acquire('g1')
  manager.revoke('kicked')
  const message = throwsMessage(() => port.setPose({ x: 99, y: 99, z: 99, yaw: 9, onGround: true }))
  const unchanged = fake.entity.position.x === 0 && fake.entity.position.y === 64 && fake.entity.yaw === 0
  const pass = message !== null && message.includes('ACTUATION_LEASE_DENIED') && unchanged
  return { pass, detail: `message=${message} pos=${fake.entity.position.toString()} yaw=${fake.entity.yaw}` }
})

addCase('#38 nested guards: _client.write / collectBlock.collect / entity.position.set are leased', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const leased = withActuationLease(fake as unknown as Bot, manager, 'g1') as unknown as FakeBot
  manager.acquire('g1')
  leased._client.write('position', { x: 0 })
  const activeCollect = leased.collectBlock.collect({ id: 1 })
  leased.entity.position.set(1, 2, 3)
  leased.entity.yaw = 0.5
  manager.revoke('replaced-by-new-generation')
  const writeDenied = throwsMessage(() => leased._client.write('position', { x: 1 }))
  const collectDenied = throwsMessage(() => {
    const run = leased.collectBlock.collect({ id: 2 })
    run.catch(() => undefined)
  })
  const positionDenied = throwsMessage(() => leased.entity.position.set(9, 9, 9))
  const yawDenied = throwsMessage(() => {
    leased.entity.yaw = 9
  })
  const pass =
    fake.writes.length === 1 &&
    fake.collects === 1 &&
    fake.entity.position.x === 1 &&
    activeCollect !== null &&
    writeDenied?.includes('what=bot._client.write') === true &&
    collectDenied?.includes('what=bot.collectBlock.collect') === true &&
    positionDenied?.includes('what=bot.entity.position.set') === true &&
    yawDenied?.includes('what=bot.entity.yaw') === true
  return {
    pass,
    detail: `write=${writeDenied} collect=${collectDenied} position=${positionDenied} yaw=${yawDenied}`,
  }
})

addCase('#38 a leased read observes the position object prismarine-physics replaces (apply substitution)', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const leased = withActuationLease(fake as unknown as Bot, manager, 'g1') as unknown as FakeBot
  manager.acquire('g1')
  // The executor's launch read primes the guard's position proxy around the
  // current Vec3. prismarine-physics `apply()` then REPLACES `entity.position`
  // with a fresh Vec3 (`bot.entity.position = this.pos`, index.js:855) instead
  // of mutating the existing one in place.
  const launchY = leased.entity.position.y
  fake.entity.position = new Vec3(fake.entity.position.x, launchY + 0.42, fake.entity.position.z)
  const advancedY = leased.entity.position.y
  const pass = launchY === 64 && advancedY === 64.42 && fake.entity.position.y === 64.42
  return { pass, detail: `launchY=${launchY} advancedY=${advancedY} rawY=${fake.entity.position.y}` }
})

addCase('#38 surface check: the raw bot is flagged, the leased proxy passes', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const leased = withActuationLease(fake as unknown as Bot, manager, 'g1')
  const rawReport = assertActuationSurfaceCovered(fake)
  const leasedReport = assertActuationSurfaceCovered(leased)
  const pass =
    !rawReport.ok &&
    rawReport.uncovered.includes('bot(not-leased-proxy)') &&
    leasedReport.ok &&
    leasedReport.uncovered.length === 0 &&
    isLeasedBot(leased) &&
    !isLeasedBot(fake)
  return { pass, detail: `raw=${JSON.stringify(rawReport)} leased=${JSON.stringify(leasedReport)}` }
})

addCase('#38 strict mode turns an uncovered surface into a hard failure', () => {
  const fake = makeFakeBot()
  process.env[STRICT_ACTUATION_ENV] = '1'
  const message = throwsMessage(() => assertActuationSurfaceCovered(fake))
  delete process.env[STRICT_ACTUATION_ENV]
  const pass = message !== null && message.includes('ACTUATION_SURFACE_UNCOVERED') && message.includes('bot(not-leased-proxy)')
  return { pass, detail: `${message}` }
})

addCase('#38 a fresh generation is admitted while the previous owner stays denied', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const portA = createActuationPort(fake as unknown as Bot, manager, 'gA')
  const portB = createActuationPort(fake as unknown as Bot, manager, 'gB')
  manager.acquire('gA')
  manager.revoke('replaced-by-new-generation')
  manager.acquire('gB')
  const oldDenied = throwsMessage(() => portA.writeMovementPacket('position', { z: 1 }))
  const newAllowed = throwsMessage(() => portB.writeMovementPacket('position', { z: 1 }))
  const pass = oldDenied !== null && oldDenied.includes('caller=gA') && newAllowed === null && fake.writes.length === 1
  return { pass, detail: `oldDenied=${oldDenied} newAllowed=${newAllowed} writes=${fake.writes.length}` }
})

addCase('#38 leased bot top-level mutators still assert the lease', () => {
  const manager = new ActuationLeaseManager()
  const fake = makeFakeBot()
  const leased = withActuationLease(fake as unknown as Bot, manager, 'g1') as unknown as FakeBot
  manager.acquire('g1')
  const dug = leased.dig()
  manager.revoke('error')
  const denied = throwsMessage(() => leased.dig())
  const pass = dug === 'dug' && fake.digCalls === 1 && denied !== null && denied.includes('what=bot.dig')
  return { pass, detail: `dug=${dug} digCalls=${fake.digCalls} denied=${denied}` }
})

let failures = 0
process.stdout.write('actuation port (#38) - leased allowlist + nested-capability guards\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} actuation-port cases passed\n`)
if (failures > 0) process.exit(1)
