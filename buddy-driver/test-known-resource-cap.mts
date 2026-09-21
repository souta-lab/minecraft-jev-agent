// test-known-resource-cap.mts - capacity behaviour of the durable known-resource
// store (issue #14 follow-up).
//
// Live defect (source 75efa49): the store saturated at KNOWN_RESOURCE_CAP (256)
// and every later sighting was silently dropped for the lifetime of the world
// key. The resident mined gravel live (flint came from it) yet no gravel cell was
// ever remembered. These cases pin the replacement rule: at the cap a newly
// observed cell EVICTS the least valuable remembered cell (oldest `lastSeenAt`
// proof; lastSeenAt-less legacy entries are treated as oldest) instead of being
// dropped, while the store stays within the cap. Every drop is observable.
import type { Bot } from 'mineflayer'
import { KNOWN_RESOURCE_CAP, evictStaleKnownResources, mergeKnownResources } from './generation-entry.ts'
import { mergeWorldMemoryDelta } from './proposal-staging.ts'
import { emptyWorldMemory, mergeKnownResourcesInto } from './resident-types.ts'
import type { KnownResourceJson } from './resident-types.ts'

interface LogEntry {
  event: string
  detail: Record<string, unknown> | undefined
}

const DIM = 'minecraft:overworld'
const EPOCH = 1
const T0 = 1_700_000_000_000

function cell(name: string, x: number, y: number, z: number, overrides: Partial<KnownResourceJson> = {}): KnownResourceJson {
  return { name, kind: 'ore', x, y, z, dimension: DIM, worldEpoch: EPOCH, ...overrides }
}

/** A store exactly at the cap: index 0 is the oldest proof, each later cell is strictly newer. */
function atCap(): KnownResourceJson[] {
  const store: KnownResourceJson[] = []
  for (let index = 0; index < KNOWN_RESOURCE_CAP; index += 1) {
    store.push(cell('coal_ore', index, 64, 0, { lastSeenAt: T0 + index }))
  }
  return store
}

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// --- (a) at-cap insert keeps learning ------------------------------------------

addCase('at cap, a newly observed cell evicts the oldest cell and is stored (the live gravel gap)', () => {
  const store = atCap()
  const log: LogEntry[] = []
  const added = mergeKnownResources(
    store,
    [cell('gravel', 500, 40, -500, { lastSeenAt: T0 + 100_000 })],
    (event, detail) => log.push({ event, detail }),
    EPOCH,
  )
  const gravel = store.find((resource) => resource.name === 'gravel')
  const evicted = log.find((entry) => entry.event === 'KNOWN_RESOURCE_EVICTED')
  const oldestStillThere = store.some((resource) => resource.name === 'coal_ore' && resource.x === 0 && resource.y === 64)
  const pass =
    added === 1 &&
    store.length === KNOWN_RESOURCE_CAP &&
    gravel !== undefined &&
    gravel.x === 500 &&
    gravel.y === 40 &&
    gravel.z === -500 &&
    !oldestStillThere &&
    evicted !== undefined &&
    evicted.detail?.name === 'coal_ore' &&
    evicted.detail?.at === '0,64,0' &&
    evicted.detail?.reason === 'capacity' &&
    typeof evicted.detail?.ageMs === 'number'
  return {
    pass,
    detail: `added=${added} len=${store.length} gravel=${JSON.stringify(gravel)} oldestStillThere=${oldestStillThere} evicted=${JSON.stringify(evicted?.detail)}`,
  }
})

// --- (b) re-observation refreshes instead of evicting --------------------------

addCase('a re-observed existing cell refreshes lastSeenAt and never spends an eviction', () => {
  const store = atCap()
  const log: LogEntry[] = []
  const refreshedAt = T0 + 999_999
  const added = mergeKnownResources(
    store,
    [cell('coal_ore', 0, 64, 0, { lastSeenAt: refreshedAt })],
    (event, detail) => log.push({ event, detail }),
    EPOCH,
  )
  const entry = store.find((resource) => resource.name === 'coal_ore' && resource.x === 0 && resource.y === 64)
  const evictions = log.filter((entry) => entry.event === 'KNOWN_RESOURCE_EVICTED').length
  const pass = added === 0 && store.length === KNOWN_RESOURCE_CAP && entry?.lastSeenAt === refreshedAt && evictions === 0
  return {
    pass,
    detail: `added=${added} len=${store.length} lastSeenAt=${String(entry?.lastSeenAt)} evictions=${evictions}`,
  }
})

// --- (c) bounded under repeated at-cap inserts ---------------------------------

addCase('the store never exceeds the cap across repeated at-cap inserts', () => {
  const store = atCap()
  const log: LogEntry[] = []
  let totalAdded = 0
  let peak = store.length
  for (let index = 0; index < 40; index += 1) {
    totalAdded += mergeKnownResources(
      store,
      [cell('gravel', 10_000 + index, 40, 0, { lastSeenAt: T0 + 200_000 + index })],
      (event, detail) => log.push({ event, detail }),
      EPOCH,
    )
    peak = Math.max(peak, store.length)
  }
  const evictions = log.filter((entry) => entry.event === 'KNOWN_RESOURCE_EVICTED').length
  const pass =
    peak === KNOWN_RESOURCE_CAP && store.length === KNOWN_RESOURCE_CAP && totalAdded === 40 && evictions === 40
  return { pass, detail: `peak=${peak} len=${store.length} added=${totalAdded} evictions=${evictions}` }
})

// --- (d) legacy entries without lastSeenAt -------------------------------------

addCase('lastSeenAt-less legacy entries are evictable first, with ageMs=null and no crash', () => {
  const store: KnownResourceJson[] = []
  for (let index = 0; index < KNOWN_RESOURCE_CAP - 1; index += 1) {
    store.push(cell('coal_ore', index, 30, 0, { lastSeenAt: T0 + index }))
  }
  // Legacy durable JSON predates the bookkeeping field: no lastSeenAt at all.
  store.push({ name: 'oak_log', kind: 'log', x: 777, y: 70, z: 777, dimension: DIM, worldEpoch: EPOCH })
  const log: LogEntry[] = []
  const added = mergeKnownResources(
    store,
    [cell('gravel', 888, 40, 0, { lastSeenAt: T0 + 500_000 })],
    (event, detail) => log.push({ event, detail }),
    EPOCH,
  )
  const legacy = store.find((resource) => resource.name === 'oak_log')
  const evicted = log.find((entry) => entry.event === 'KNOWN_RESOURCE_EVICTED')
  const pass =
    added === 1 &&
    store.length === KNOWN_RESOURCE_CAP &&
    legacy === undefined &&
    evicted?.detail?.name === 'oak_log' &&
    evicted?.detail?.ageMs === null
  return {
    pass,
    detail: `added=${added} len=${store.length} legacy=${JSON.stringify(legacy)} evicted=${JSON.stringify(evicted?.detail)}`,
  }
})

// --- (e) a full store with nothing evictable is never a silent drop ------------

addCase('a store with no eviction candidate reports KNOWN_RESOURCE_FULL instead of dropping silently', () => {
  const store: KnownResourceJson[] = []
  const log: LogEntry[] = []
  const result = mergeKnownResourcesInto(store, [cell('gravel', 1, 2, 3, { lastSeenAt: T0 })], {
    log: (event, detail) => log.push({ event, detail }),
    cap: 0,
  })
  const full = log.find((entry) => entry.event === 'KNOWN_RESOURCE_FULL')
  const pass =
    result.added === 0 &&
    result.dropped === 1 &&
    result.evicted.length === 0 &&
    store.length === 0 &&
    full?.detail?.cap === 0 &&
    full?.detail?.dropped === 1
  return { pass, detail: `added=${result.added} dropped=${result.dropped} len=${store.length} full=${JSON.stringify(full?.detail)}` }
})

// --- (f) evictStaleKnownResources is unchanged ---------------------------------

addCase('evictStaleKnownResources still drops a gone cell and refreshes a live one under the cap rule', () => {
  const known: KnownResourceJson[] = [
    cell('iron_ore', 3, 60, 0, { lastSeenAt: T0 }),
    cell('iron_ore', 2, 59, 0, { lastSeenAt: T0 }),
  ]
  const live = new Map<string, string>([
    ['3,60,0', 'air'],
    ['2,59,0', 'iron_ore'],
  ])
  const bot = {
    entity: { position: { x: 0, y: 60, z: 0 } },
    blockAt: (position: { x: number; y: number; z: number }) => {
      const name = live.get(`${position.x},${position.y},${position.z}`)
      return name === undefined ? null : { name }
    },
  } as unknown as Bot
  const log: LogEntry[] = []
  const evicted = evictStaleKnownResources(bot, known, { dimension: DIM, worldEpoch: EPOCH }, (event, detail) =>
    log.push({ event, detail }),
  )
  const kept = known[0]
  const pass =
    evicted.length === 1 &&
    evicted[0]?.x === 3 &&
    known.length === 1 &&
    kept?.x === 2 &&
    typeof kept?.lastSeenAt === 'number' &&
    kept.lastSeenAt > T0 &&
    log[0]?.event === 'KNOWN_RESOURCE_STALE' &&
    log[0]?.detail?.at === '3,60,0'
  return { pass, detail: `evicted=${evicted.length} kept=${JSON.stringify(kept)} log=${JSON.stringify(log[0]?.detail)}` }
})

// --- (g) the HOST durable merge obeys the same rule -----------------------------

addCase('the HOST durable merge at cap evicts the oldest cell and stores the new sighting', () => {
  const memory = emptyWorldMemory()
  memory.knownResources = atCap()
  const log: LogEntry[] = []
  mergeWorldMemoryDelta(
    memory,
    { knownResources: [cell('gravel', 42, 41, -42, { lastSeenAt: T0 + 100_000 })] },
    (event, detail) => log.push({ event, detail }),
  )
  const gravel = memory.knownResources.find((resource) => resource.name === 'gravel')
  const evicted = log.find((entry) => entry.event === 'KNOWN_RESOURCE_EVICTED')
  const pass =
    memory.knownResources.length === KNOWN_RESOURCE_CAP &&
    gravel !== undefined &&
    gravel.x === 42 &&
    gravel.y === 41 &&
    evicted?.detail?.name === 'coal_ore' &&
    evicted?.detail?.at === '0,64,0' &&
    evicted?.detail?.reason === 'capacity'
  return { pass, detail: `len=${memory.knownResources.length} gravel=${JSON.stringify(gravel)} evicted=${JSON.stringify(evicted?.detail)}` }
})

addCase('the HOST merge re-anchors a same-key cell instead of deleting it (remove before merge)', () => {
  const memory = emptyWorldMemory()
  const stale = cell('iron_ore', 5, 20, 5, { dimension: 'minecraft:the_nether', worldEpoch: 1, lastSeenAt: T0 })
  memory.knownResources = [stale]
  const log: LogEntry[] = []
  mergeWorldMemoryDelta(
    memory,
    {
      removeKnownResources: [cell('iron_ore', 5, 20, 5, { dimension: 'minecraft:the_nether', worldEpoch: 1 })],
      knownResources: [cell('iron_ore', 5, 20, 5, { dimension: 'minecraft:overworld', worldEpoch: 1, lastSeenAt: T0 + 50 })],
    },
    (event, detail) => log.push({ event, detail }),
  )
  const entry = memory.knownResources.find((resource) => resource.name === 'iron_ore' && resource.x === 5 && resource.y === 20)
  const pass = memory.knownResources.length === 1 && entry?.dimension === 'minecraft:overworld' && entry?.lastSeenAt === T0 + 50
  return { pass, detail: `len=${memory.knownResources.length} entry=${JSON.stringify(entry)}` }
})

let failures = 0
process.stdout.write('known-resource capacity eviction (issue #14 follow-up)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} known-resource cap cases passed\n`)
if (failures > 0) process.exit(1)
