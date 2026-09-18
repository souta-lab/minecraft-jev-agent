// test-reload-lifecycle.mts - Issue #49 reload rollback ownership + old-generation
// disposal (#13). Pure: no bot, no socket; fakes implement the swap ports.
import { EventEmitter } from 'node:events'
import type { Bot } from 'mineflayer'
import {
  ActuationLeaseManager,
  GenerationResourceRegistry,
  collectedGenerationRegistryIds,
  liveGenerationRegistryCount,
  withActuationLease,
} from './resident-safety.ts'
import type { GenerationResourceCounts } from './resident-types.ts'
import { commitOwner, swapGeneration, type OwnershipFields, type SwapPorts } from './generation-swap.ts'

interface LogEntry {
  event: string
  detail: Record<string, unknown>
}

class FakeGeneration {
  readonly id: string
  started = false
  attached = false
  quiesced = false
  disposed = false
  smoked = false
  private readonly failOnStart: boolean
  private readonly emitter: EventEmitter | null
  private readonly registry: GenerationResourceRegistry | null
  private handler: (() => void) | null = null

  constructor(options: { id: string; failOnStart?: boolean; emitter?: EventEmitter; registry?: GenerationResourceRegistry }) {
    this.id = options.id
    this.failOnStart = options.failOnStart ?? false
    this.emitter = options.emitter ?? null
    this.registry = options.registry ?? null
  }

  attach(): void {
    this.attached = true
  }

  start(): void {
    if (this.failOnStart) throw new Error(`forced start failure ${this.id}`)
    this.started = true
    if (this.emitter !== null) {
      this.handler = () => undefined
      this.emitter.on('physicsTick', this.handler)
      this.registry?.trackListener(this.emitter, 'physicsTick', this.handler)
    }
  }

  async quiesce(): Promise<void> {
    this.quiesced = true
  }

  dispose(): void {
    this.disposed = true
    this.registry?.dispose()
  }
}

interface Harness {
  ports: SwapPorts
  lease: ActuationLeaseManager
  ownership: OwnershipFields
  state: { live: FakeGeneration | null }
  logs: LogEntry[]
  persisted: string[]
  revision: () => number
}

function makeHarness(resumeFactory: () => FakeGeneration | null): Harness {
  const lease = new ActuationLeaseManager()
  const ownership: OwnershipFields = { generationId: null, lastGenerationId: null }
  const state: { live: FakeGeneration | null } = { live: null }
  const logs: LogEntry[] = []
  const persisted: string[] = []
  let revision = 0
  const log = (event: string, detail?: Record<string, unknown>): void => {
    logs.push({ event, detail: detail ?? {} })
  }
  const ports: SwapPorts = {
    log,
    lease,
    ownership,
    getLive: () => state.live,
    setLive: (generation) => {
      state.live = generation as FakeGeneration | null
    },
    buildResume: () => resumeFactory(),
    dispose: (generation) => {
      const fake = generation as FakeGeneration
      fake.dispose()
      const counts: GenerationResourceCounts = { listeners: 0, timers: 0 }
      return counts
    },
    smoke: (generation) => {
      ;(generation as FakeGeneration).smoked = true
    },
    persist: (event) => {
      revision += 1
      persisted.push(event)
    },
    revision: () => revision,
  }
  return { ports, lease, ownership, state, logs, persisted, revision: () => revision }
}

function consistent(harness: Harness): { ok: boolean; detail: string } {
  const liveId = harness.state.live === null ? null : harness.state.live.id
  const leaseId = harness.lease.activeId === '' ? null : harness.lease.activeId
  const snapshotId = harness.ownership.generationId
  return { ok: liveId === leaseId && leaseId === snapshotId, detail: `live=${liveId} lease=${leaseId} snapshot=${snapshotId}` }
}

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

addCase('#49 forced failed reload rolls back to one consistent owner (A/B disposed, C live)', async () => {
  const harness = makeHarness(() => new FakeGeneration({ id: 'C' }))
  const a = new FakeGeneration({ id: 'A' })
  commitOwner(harness.ports, a)
  const before = consistent(harness)
  const b = new FakeGeneration({ id: 'B', failOnStart: true })
  const outcome = await swapGeneration(harness.ports, b)
  const after = consistent(harness)
  const rollback = harness.logs.find((entry) => entry.event === 'RELOAD_ROLLBACK')
  const pass =
    before.ok &&
    outcome.status === 'rolled-back' &&
    after.ok &&
    harness.state.live?.id === 'C' &&
    harness.lease.activeId === 'C' &&
    harness.ownership.generationId === 'C' &&
    a.disposed &&
    b.disposed &&
    a.quiesced &&
    rollback !== undefined &&
    rollback.detail.resumed === 'C' &&
    rollback.detail.leaseOwner === 'C' &&
    rollback.detail.snapshotGenerationId === 'C' &&
    rollback.detail.generationId === 'C'
  return {
    pass,
    detail: `outcome=${outcome.status} before[${before.detail}] after[${after.detail}] A.disposed=${a.disposed} B.disposed=${b.disposed} rollback=${JSON.stringify(rollback?.detail ?? null)}`,
  }
})

addCase('#49 snapshot generationId always matches the attached generation across commits', async () => {
  const harness = makeHarness(() => new FakeGeneration({ id: 'E' }))
  const checks: boolean[] = []
  commitOwner(harness.ports, new FakeGeneration({ id: 'A' }))
  checks.push(consistent(harness).ok)
  const b = new FakeGeneration({ id: 'B' })
  await swapGeneration(harness.ports, b)
  checks.push(consistent(harness).ok)
  const c = new FakeGeneration({ id: 'C' })
  await swapGeneration(harness.ports, c)
  checks.push(consistent(harness).ok)
  const d = new FakeGeneration({ id: 'D', failOnStart: true })
  const outcome = await swapGeneration(harness.ports, d)
  checks.push(consistent(harness).ok)
  const allConsistent = harness.logs
    .filter((entry) => entry.event === 'RELOAD_ROLLBACK')
    .every((entry) => entry.detail.leaseOwner === entry.detail.snapshotGenerationId && entry.detail.generationId === entry.detail.resumed)
  const pass =
    checks.every((ok) => ok) &&
    outcome.status === 'rolled-back' &&
    harness.state.live?.id === 'E' &&
    harness.lease.activeId === 'E' &&
    harness.ownership.generationId === 'E' &&
    harness.ownership.lastGenerationId === 'D' &&
    c.disposed &&
    d.disposed &&
    allConsistent
  return {
    pass,
    detail: `consistent=[${checks.join(',')}] lastGenerationId=${harness.ownership.lastGenerationId} live=${harness.state.live?.id} lease=${harness.lease.activeId} snapshot=${harness.ownership.generationId} rollbackConsistent=${allConsistent}`,
  }
})

addCase('#49 N successful reloads keep listener/timer counts stable and no old registry reachable', async () => {
  const emitter = new EventEmitter()
  const baselineListener = (): void => undefined
  emitter.on('physicsTick', baselineListener)
  const baseline = emitter.listenerCount('physicsTick')
  const lease = new ActuationLeaseManager()
  const ownership: OwnershipFields = { generationId: null, lastGenerationId: null }
  const state: { live: FakeGeneration | null } = { live: null }
  const logs: LogEntry[] = []
  let revision = 0
  const registries: GenerationResourceRegistry[] = []
  const ports: SwapPorts = {
    log: (event, detail) => logs.push({ event, detail: detail ?? {} }),
    lease,
    ownership,
    getLive: () => state.live,
    setLive: (generation) => {
      state.live = generation as FakeGeneration | null
    },
    buildResume: () => null,
    dispose: (generation) => {
      const fake = generation as FakeGeneration
      fake.dispose()
      return { listeners: 0, timers: 0 }
    },
    smoke: () => undefined,
    persist: () => {
      revision += 1
    },
    revision: () => revision,
  }

  let stable = true
  const observer: number[] = []
  for (let i = 1; i <= 8; i += 1) {
    const registry = new GenerationResourceRegistry()
    registries.push(registry)
    const generation = new FakeGeneration({ id: `G${i}`, emitter, registry })
    await swapGeneration(ports, generation)
    const count = emitter.listenerCount('physicsTick')
    observer.push(count)
    if (count !== baseline + 1) stable = false
  }
  const liveRegistryBefore = liveGenerationRegistryCount()
  const clearCalls: string[] = []
  const handle = { clear: (): void => { clearCalls.push('cleared') } }
  registries[registries.length - 1]?.trackTimer(handle)
  const timed = registries[registries.length - 1]?.counts()
  state.live?.dispose()
  const liveRegistryAfter = liveGenerationRegistryCount()
  const finalizerNotes = collectedGenerationRegistryIds()
  const disposedAll = registries.every((registry) => registry.isDisposed())
  const pass =
    stable &&
    baseline === 1 &&
    observer.every((count) => count === 2) &&
    liveRegistryBefore === 1 &&
    liveRegistryAfter === 0 &&
    finalizerNotes.length === 0 &&
    disposedAll &&
    clearCalls.length === 1 &&
    timed?.timers === 1
  return {
    pass,
    detail: `baseline=${baseline} observer=[${observer.join(',')}] liveRegistryBefore=${liveRegistryBefore} liveRegistryAfter=${liveRegistryAfter} finalizerNotes=${finalizerNotes.length} registriesDisposed=${disposedAll} timersCleared=${clearCalls.length} timed=${JSON.stringify(timed)}`,
  }
})

addCase('#13 generation-owned listeners are removable and untracked by the lease proxy', async () => {
  const registry = new GenerationResourceRegistry()
  const emitter = new EventEmitter()
  const lease = new ActuationLeaseManager()
  lease.acquire('G')
  const bot = withActuationLease(emitter as unknown as Bot, lease, 'G', registry)
  const handler = (): void => undefined
  ;(bot as unknown as { on(event: string, fn: () => void): void }).on('physicsTick', handler)
  ;(bot as unknown as { on(event: string, fn: () => void): void }).on('physicsTick', handler)
  const before = registry.counts()
  const removed = registry.dispose()
  const pass =
    emitter.listenerCount('physicsTick') === 0 &&
    before.listeners === 2 &&
    removed.listeners === 0 &&
    removed.timers === 0 &&
    registry.isDisposed()
  return { pass, detail: `before=${JSON.stringify(before)} after=${JSON.stringify(removed)} emitterListeners=${emitter.listenerCount('physicsTick')}` }
})

let failures = 0
process.stdout.write('generation swap/rollback (#49) + disposal (#13)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} generation-lifecycle cases passed\n`)
if (failures > 0) process.exit(1)
