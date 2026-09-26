// test-reconnect-lease.mts - Issue #27 (bounded reconnect backoff/telemetry) and
// Issue #28 (actuation lease revoke on disconnect). Pure: imports only
// resident-safety.ts, no bot, no socket, no network.
import type { Bot } from 'mineflayer'
import {
  ActuationLeaseManager,
  RECONNECT_CAP_MS,
  ReconnectLedger,
  computeReconnectBackoff,
  withActuationLease,
} from './resident-safety.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
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

const noJitter = (): number => 0
const maxJitter = (): number => 0.999999

addCase('#27 backoff is exponential then capped at ~30s', () => {
  const a1 = computeReconnectBackoff(1, { random: noJitter })
  const a2 = computeReconnectBackoff(2, { random: noJitter })
  const a3 = computeReconnectBackoff(3, { random: noJitter })
  const a4 = computeReconnectBackoff(4, { random: noJitter })
  const a8 = computeReconnectBackoff(8, { random: noJitter })
  const pass =
    a1.targetMs === 5000 &&
    a2.targetMs === 10000 &&
    a3.targetMs === 20000 &&
    a4.targetMs === RECONNECT_CAP_MS &&
    a8.targetMs === RECONNECT_CAP_MS &&
    a4.capped &&
    a8.capped &&
    !a1.capped
  return {
    pass,
    detail: `targetMs 5s/10s/20s/30s/30s=[${a1.targetMs},${a2.targetMs},${a3.targetMs},${a4.targetMs},${a8.targetMs}] capped=[${a1.capped},${a4.capped}]`,
  }
})

addCase('#27 jitter stays within [target/2, target] and never exceeds the cap', () => {
  const rows: string[] = []
  let pass = true
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const low = computeReconnectBackoff(attempt, { random: noJitter })
    const high = computeReconnectBackoff(attempt, { random: maxJitter })
    if (low.delayMs < Math.floor(low.targetMs / 2) || low.delayMs > low.targetMs) pass = false
    if (high.delayMs < Math.floor(high.targetMs / 2) || high.delayMs > high.targetMs) pass = false
    if (high.delayMs > RECONNECT_CAP_MS || low.delayMs > RECONNECT_CAP_MS) pass = false
    rows.push(`${attempt}:${low.delayMs}..${high.delayMs}`)
  }
  return { pass, detail: `delay ranges ${rows.join(' ')}` }
})

addCase('#27 ledger records reason/backoff/uptime and counts reasons', () => {
  const ledger = new ReconnectLedger({ now: () => 1000, random: noJitter })
  const e1 = ledger.noteDisconnect('end', 100)
  const e2 = ledger.noteDisconnect('kicked', 200)
  const report = ledger.report()
  const pass =
    e1.n === 1 &&
    e1.reason === 'end' &&
    e1.backoffMs === 2500 &&
    e1.uptimeMs === 100 &&
    e2.n === 2 &&
    e2.attempt === 2 &&
    e2.backoffMs === 5000 &&
    report.reconnects === 2 &&
    report.reconnectReasons.end === 1 &&
    report.reconnectReasons.kicked === 1 &&
    report.reconnectReasons.error === 0 &&
    report.lastReconnectReason === 'kicked'
  return { pass, detail: `e1=${JSON.stringify(e1)} e2=${JSON.stringify(e2)} reasons=${JSON.stringify(report.reconnectReasons)}` }
})

addCase('#27 a stable connection resets the attempt counter', () => {
  const ledger = new ReconnectLedger({ random: noJitter, now: () => 1 })
  ledger.noteDisconnect('end', 0)
  ledger.noteDisconnect('end', 0)
  const before = ledger.currentAttempt()
  const stable = ledger.noteDisconnect('end', 120000)
  const pass = before === 2 && stable.attempt === 1 && stable.backoffMs === 2500
  return { pass, detail: `attemptBefore=${before} afterStable=${stable.attempt} backoff=${stable.backoffMs}` }
})

addCase('#27 reconnectsLastHour is a rolling window', () => {
  let now = 1_000_000
  const ledger = new ReconnectLedger({ random: noJitter, now: () => now })
  ledger.noteDisconnect('end', 0)
  ledger.noteDisconnect('end', 0)
  ledger.noteDisconnect('error', 0)
  const atStart = ledger.reconnectsLastHour()
  now += 2 * 3600000
  ledger.noteDisconnect('end', 0)
  const afterWindow = ledger.reconnectsLastHour()
  const pass = ledger.reconnects === 4 && atStart === 3 && afterWindow === 1
  return { pass, detail: `total=${ledger.reconnects} lastHourAtStart=${atStart} lastHourAfter2h=${afterWindow}` }
})

addCase('#27 capped episodes are flagged and stay <= cap', () => {
  const ledger = new ReconnectLedger({ random: maxJitter, now: () => 1 })
  const episodes = [1, 2, 3, 4, 5].map(() => ledger.noteDisconnect('error', 0))
  const capped = episodes.filter((episode) => episode.capped)
  const pass = capped.length === 2 && episodes.every((episode) => episode.backoffMs <= RECONNECT_CAP_MS)
  return { pass, detail: `delays=${episodes.map((e) => e.backoffMs).join(',')} cappedCount=${capped.length}` }
})

addCase('#28 acquire activates a generation and logs LEASE_ACQUIRED', () => {
  const manager = new ActuationLeaseManager()
  const logs: Array<{ event: string; detail: Record<string, unknown> }> = []
  manager.acquire('g1', (event, detail) => logs.push({ event, detail: detail ?? {} }))
  const pass = manager.isActive('g1') && manager.activeId === 'g1' && logs.length === 1 && logs[0]!.event === 'LEASE_ACQUIRED' && logs[0]!.detail.generationId === 'g1'
  return { pass, detail: `activeId=${manager.activeId} logs=${JSON.stringify(logs)}` }
})

addCase('#28 revoke is immediate and idempotent (kicked then end logs once)', () => {
  const manager = new ActuationLeaseManager()
  const logs: Array<{ event: string; detail: Record<string, unknown> }> = []
  const log = (event: string, detail?: Record<string, unknown>): void => {
    logs.push({ event, detail: detail ?? {} })
  }
  manager.acquire('g1', log)
  const first = manager.revoke('kicked', log)
  const second = manager.revoke('end', log)
  const revokes = logs.filter((entry) => entry.event === 'LEASE_REVOKED')
  const pass =
    first.revoked &&
    first.generationId === 'g1' &&
    !second.revoked &&
    second.generationId === null &&
    revokes.length === 1 &&
    revokes[0]!.detail.reason === 'kicked' &&
    manager.activeId === ''
  return { pass, detail: `first=${JSON.stringify(first)} second=${JSON.stringify(second)} revokeLogs=${revokes.length}` }
})

addCase('#28 a stale generation cannot act after revoke', () => {
  const manager = new ActuationLeaseManager()
  manager.acquire('g1')
  manager.revoke('end')
  const denied = throwsMessage(() => manager.assertActive('g1', 'bot.dig'))
  const pass = denied !== null && denied.includes('ACTUATION_LEASE_DENIED') && denied.includes('owner=none') && denied.includes('caller=g1')
  return { pass, detail: `${denied}` }
})

addCase('#28 a fresh generation re-acquires while the old one stays denied', () => {
  const manager = new ActuationLeaseManager()
  const logs: string[] = []
  manager.acquire('g1', (event, detail) => logs.push(`${event} generationId=${String(detail?.generationId)}`))
  manager.revoke('end', (event, detail) => logs.push(`${event} reason=${String(detail?.reason)} generationId=${String(detail?.generationId)}`))
  manager.acquire('g2', (event, detail) => logs.push(`${event} generationId=${String(detail?.generationId)}`))
  const oldDenied = throwsMessage(() => manager.assertActive('g1', 'bot.placeBlock'))
  const newAllowed = throwsMessage(() => manager.assertActive('g2', 'bot.placeBlock')) === null
  const pass = oldDenied !== null && newAllowed && manager.isActive('g2') && !manager.isActive('g1')
  return { pass, detail: `oldDenied=${oldDenied} newAllowed=${newAllowed} logs=[${logs.join(' | ')}]` }
})

addCase('#28 the actuator proxy blocks a stale generation side effect', () => {
  const manager = new ActuationLeaseManager()
  const fakeBot = { dig: () => 'dug', look: () => 'looked' } as unknown as Bot
  const proxied = withActuationLease(fakeBot, manager, 'g1') as unknown as { dig: () => string }
  manager.acquire('g1')
  const activeResult = proxied.dig()
  manager.revoke('error')
  const denied = throwsMessage(() => proxied.dig())
  const pass = activeResult === 'dug' && denied !== null && denied.includes('ACTUATION_LEASE_DENIED') && denied.includes('what=bot.dig')
  return { pass, detail: `activeDig=${activeResult} denied=${denied}` }
})

addCase('V4.1.2 closure: former escape surfaces are lease-denied for a stale generation and observed when granted', () => {
  const manager = new ActuationLeaseManager()
  const calls: string[] = []
  const furnaceWindow = {
    putInput: async () => { calls.push('putInput') },
    putFuel: async () => { calls.push('putFuel') },
    takeOutput: async () => { calls.push('takeOutput') },
    close: () => { calls.push('close') },
  }
  const raw = {
    attack: () => calls.push('attack'),
    stopDigging: () => calls.push('stopDigging'),
    _placeBlockWithOptions: async () => { calls.push('_placeBlockWithOptions') },
    openFurnace: async () => furnaceWindow,
    physicsEnabled: true,
    entity: { velocity: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 64, z: 0, set() {} }, yaw: 0, pitch: 0, onGround: true },
  }
  const observed: string[] = []
  const bot = withActuationLease(raw as unknown as Bot, manager, 'g1', undefined, undefined, (o) => observed.push(`${o.surface}:${o.guarded ? 'guarded' : 'unguarded'}:${o.leaseOutcome}`)) as unknown as typeof raw
  manager.acquire('g1')
  bot.attack()
  bot.stopDigging()
  void bot._placeBlockWithOptions()
  bot.physicsEnabled = false
  bot.entity.velocity.y = 0.42
  const grantedSurfaces = ['bot.attack:guarded:granted', 'bot.stopDigging:guarded:granted', 'bot._placeBlockWithOptions:guarded:granted', 'bot.physicsEnabled:guarded:granted', 'entity.velocity.y:guarded:granted']
  const grantedOk = grantedSurfaces.every((surface) => observed.includes(surface))
  manager.revoke('error')
  const denied = [
    throwsMessage(() => bot.attack()),
    throwsMessage(() => bot.stopDigging()),
    throwsMessage(() => { void bot._placeBlockWithOptions() }),
    throwsMessage(() => { bot.physicsEnabled = true }),
    throwsMessage(() => { bot.entity.velocity.y = 1 }),
  ]
  const allDenied = denied.every((message) => message !== null && message.includes('ACTUATION_LEASE_DENIED'))
  const stateUnchanged = raw.physicsEnabled === false && raw.entity.velocity.y === 0.42
  return { pass: grantedOk && allDenied && stateUnchanged, detail: `observed=[${observed.join(' | ')}] allDenied=${allDenied} stateUnchanged=${stateUnchanged}` }
})

addCase('V4.1.2 closure: a window returned by a guarded open is itself lease-guarded and observed', async () => {
  const manager = new ActuationLeaseManager()
  const calls: string[] = []
  const furnaceWindow = {
    putInput: async () => { calls.push('putInput') },
    takeOutput: async () => { calls.push('takeOutput') },
    close: () => { calls.push('close') },
    type: 'minecraft:furnace',
  }
  const raw = { openFurnace: async () => furnaceWindow }
  const observed: string[] = []
  const bot = withActuationLease(raw as unknown as Bot, manager, 'g1', undefined, undefined, (o) => observed.push(`${o.surface}:${o.leaseOutcome}`)) as unknown as typeof raw
  manager.acquire('g1')
  const furnace = await bot.openFurnace()
  await furnace.putInput()
  const readable = furnace.type === 'minecraft:furnace'
  manager.revoke('error')
  const denied = throwsMessage(() => { void furnace.takeOutput() })
  const pass =
    readable &&
    calls.join(',') === 'putInput' &&
    observed.includes('bot.openFurnace:granted') &&
    observed.includes('window.putInput:granted') &&
    denied !== null && denied.includes('what=window.takeOutput')
  return { pass, detail: `calls=${calls.join(',')} observed=[${observed.join(' | ')}] denied=${denied}` }
})

addCase('#28 scripted disconnect: LEASE_REVOKED -> bounded backoff -> LEASE_ACQUIRED', () => {
  const manager = new ActuationLeaseManager()
  const ledger = new ReconnectLedger({ random: noJitter, now: () => 1 })
  const trace: string[] = []
  manager.acquire('g1', (event, detail) => trace.push(`${event} generationId=${String(detail?.generationId)}`))
  manager.revoke('end', (event, detail) => trace.push(`${event} reason=${String(detail?.reason)} generationId=${String(detail?.generationId)}`))
  const episode = ledger.noteDisconnect('end', 0)
  trace.push(`BACKOFF backoffMs=${episode.backoffMs} attempt=${episode.attempt} capped=${episode.capped}`)
  manager.acquire('g2', (event, detail) => trace.push(`${event} generationId=${String(detail?.generationId)}`))
  const oldDenied = throwsMessage(() => manager.assertActive('g1', 'bot.craft'))
  const newAllowed = throwsMessage(() => manager.assertActive('g2', 'bot.craft')) === null
  const bounded = episode.backoffMs >= 2500 && episode.backoffMs <= RECONNECT_CAP_MS
  const revokeIndex = trace.findIndex((line) => line.startsWith('LEASE_REVOKED'))
  const backoffIndex = trace.findIndex((line) => line.startsWith('BACKOFF'))
  const reacquireIndex = trace.findIndex((line) => line.startsWith('LEASE_ACQUIRED') && line.includes('g2'))
  const ordered = revokeIndex >= 0 && backoffIndex === revokeIndex + 1 && reacquireIndex === backoffIndex + 1
  const pass = oldDenied !== null && newAllowed && bounded && ordered
  return { pass, detail: `trace=[${trace.join(' -> ')}] oldDenied=${oldDenied !== null} newAllowed=${newAllowed} ordered=${ordered}` }
})

addCase('#27 report exposes the reconnect counters the control socket surfaces', () => {
  const ledger = new ReconnectLedger({ random: noJitter, now: () => 5000 })
  ledger.noteDisconnect('end', 0)
  ledger.noteDisconnect('kicked', 0)
  const report = ledger.report()
  const pass =
    report.reconnects === 2 &&
    report.reconnectsLastHour === 2 &&
    report.reconnectAttempt === 2 &&
    report.lastReconnectReason === 'kicked' &&
    report.lastReconnectBackoffMs === 5000 &&
    report.lastReconnectUptimeMs === 0 &&
    report.reconnectReasons.error === 0
  return { pass, detail: `report=${JSON.stringify(report)}` }
})

let failures = 0
process.stdout.write('resident-safety - reconnect backoff (#27) + lease revoke (#28)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} resident-safety cases passed\n`)
if (failures > 0) process.exit(1)
