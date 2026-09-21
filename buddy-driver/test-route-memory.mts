// test-route-memory.mts - issue #354: durable route/traversal memory.
//
// The live body paced east/west because two lateral directions were
// indistinguishable and a restart forgot every observed route. These cases pin
// the smallest honest slice:
//   (a) a successful leg recorded from a real outcome survives a durable
//       JSON round-trip;
//   (b) a blocked direction is remembered and not re-offered until the world
//       epoch changes;
//   (c) a fresh load from the durable snapshot steers the same way;
//   (d) a worldEpoch change clears the store;
//   plus the ONE bounded-LRU merge (cap + eviction + supersede) and the
//   producer/consumer mapping. Pure: no bot, no network, no live host.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KNOWN_TRAVERSAL_CAP,
  emptyWorldMemory,
  mergeKnownTraversalsInto,
  normalizeWorldMemory,
  worldKeyString,
} from './resident-types.ts'
import type { KnownTraversalJson, ResidentWorldMemory, WorldKey } from './resident-types.ts'
import {
  filterBlockedTraversalWaypoints,
  parseMoveFailureCell,
  traversalCellKey,
  traversalDirection,
  traversalFactFromEvent,
  traversalHintsForWaypoints,
} from './generation-entry.ts'
import { mergeWorldMemoryDelta, writeSnapshotAtomic } from './proposal-staging.ts'
import { acceptsWorldMemoryProposal } from './world-epoch.ts'
import { emptyAgentSnapshot, validateAgentSnapshot } from './state-snapshot.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

interface Captured {
  events: Array<{ event: string; detail: Record<string, unknown> }>
  log: (event: string, detail?: Record<string, unknown>) => void
}

function capture(): Captured {
  const events: Captured['events'] = []
  return {
    events,
    log: (event, detail) => events.push({ event, detail: detail ?? {} }),
  }
}

const EPOCH = 5
const WORLD_KEY: WorldKey = { serverId: '127.0.0.1:25565', dimension: 'minecraft:overworld', worldEpoch: EPOCH }

function fact(overrides: Partial<KnownTraversalJson> = {}): KnownTraversalJson {
  return {
    from: { x: 10, y: 64, z: 0 },
    to: { x: 11, y: 64, z: 0 },
    kind: 'step',
    result: 'ok',
    worldEpoch: EPOCH,
    lastSeenAt: 1000,
    ...overrides,
  }
}

type Waypoint = { name: string; kind: 'ore'; position: { x: number; y: number; z: number } }

function waypoint(x: number, y: number, z: number, name = 'iron_ore'): Waypoint {
  return { name, kind: 'ore', position: { x, y, z } }
}

// --- producer: observed outcome -> durable fact --------------------------------

addCase('(a) a completed executor path records an ok step from the observed cells', () => {
  const observed = traversalFactFromEvent({
    event: 'PATH_CALLBACK',
    detail: { phase: 'completed', actionId: 'a1', target: { x: 11.4, y: 64.2, z: -0.2 }, mode: 'pathfinder' },
    fromPosition: { x: 10.2, y: 64.1, z: 0.1 },
    worldEpoch: EPOCH,
    now: 1234,
  })
  const pass =
    observed !== null &&
    observed.result === 'ok' &&
    observed.kind === 'step' &&
    observed.reason === undefined &&
    traversalCellKey(observed.from) === '10,64,0' &&
    traversalCellKey(observed.to) === '11,64,0' &&
    observed.worldEpoch === EPOCH &&
    observed.lastSeenAt === 1234
  return { pass, detail: JSON.stringify(observed) }
})

addCase('a refused executor path records blocked with a typed reason', () => {
  const lava = traversalFactFromEvent({
    event: 'PATH_CALLBACK',
    detail: { phase: 'failed', actionId: 'a2', target: { x: 9, y: 64, z: 0 }, mode: 'pathfinder', outcome: 'stuck' },
    fromPosition: { x: 10, y: 64, z: 0 },
    worldEpoch: EPOCH,
    reasonAt: (to) => (to.x === 9 ? 'lava' : undefined),
  })
  const generic = traversalFactFromEvent({
    event: 'PATH_CALLBACK',
    detail: { phase: 'failed', actionId: 'a3', target: { x: 12, y: 64, z: 0 }, mode: 'pathfinder', outcome: 'noPath' },
    fromPosition: { x: 10, y: 64, z: 0 },
    worldEpoch: EPOCH,
  })
  const pass =
    lava !== null &&
    lava.result === 'blocked' &&
    lava.reason === 'lava' &&
    generic !== null &&
    generic.result === 'blocked' &&
    generic.reason === 'wall'
  return { pass, detail: `${JSON.stringify(lava)} | ${JSON.stringify(generic)}` }
})

addCase('a refused tracked move parses its cell and keeps an explicit descend kind', () => {
  const descend = traversalFactFromEvent({
    event: 'MOVE_FAILMEM',
    detail: { actionId: 'a4', key: 'minecraft:the_nether:5,60,-3', attempts: 2, reason: 'no_path', kind: 'DESCEND' },
    fromPosition: { x: 5, y: 62, z: -3 },
    worldEpoch: EPOCH,
  })
  const pass =
    parseMoveFailureCell('minecraft:the_nether:5,60,-3')?.x === 5 &&
    parseMoveFailureCell('bogus') === null &&
    descend !== null &&
    descend.kind === 'descend' &&
    descend.result === 'blocked' &&
    descend.reason === 'wall' &&
    traversalCellKey(descend.to) === '5,60,-3'
  return { pass, detail: JSON.stringify(descend) }
})

addCase('a degenerate completed leg and an unrelated event produce no fact', () => {
  const degenerate = traversalFactFromEvent({
    event: 'MOVE_FAILMEM_RESET',
    detail: { actionId: 'a5', key: 'minecraft:overworld:10,64,0', kind: 'MOVE' },
    fromPosition: { x: 10, y: 64, z: 0 },
    worldEpoch: EPOCH,
  })
  const unrelated = traversalFactFromEvent({
    event: 'DIG_PATH',
    detail: { actionId: 'a6', dir: 'D' },
    fromPosition: { x: 10, y: 64, z: 0 },
    worldEpoch: EPOCH,
  })
  const inPlaceRefusal = traversalFactFromEvent({
    event: 'MOVE_FAILMEM',
    detail: { actionId: 'a7', key: 'minecraft:overworld:10,64,0', kind: 'MOVE' },
    fromPosition: { x: 10, y: 64, z: 0 },
    worldEpoch: EPOCH,
  })
  const pass = degenerate === null && unrelated === null && inPlaceRefusal !== null && inPlaceRefusal.result === 'blocked'
  return { pass, detail: `degenerate=${degenerate} unrelated=${unrelated} refusal=${JSON.stringify(inPlaceRefusal)}` }
})

addCase('direction is the dominant axis of the observed displacement', () => {
  const p = { x: 0, y: 64, z: 0 }
  const observed = [
    traversalDirection(p, { x: 3, y: 64, z: 1 }),
    traversalDirection(p, { x: -3, y: 64, z: 1 }),
    traversalDirection(p, { x: 1, y: 64, z: 3 }),
    traversalDirection(p, { x: 1, y: 64, z: -3 }),
    traversalDirection(p, { x: 0, y: 62, z: 0 }),
    traversalDirection(p, { x: 0, y: 67, z: 0 }),
  ].join(',')
  return { pass: observed === 'E,W,S,N,D,U', detail: observed }
})

// --- one bounded-LRU merge ------------------------------------------------------

addCase('at the cap the oldest traversal proof is evicted and reported', () => {
  const store: KnownTraversalJson[] = [
    fact({ to: { x: 1, y: 64, z: 0 }, lastSeenAt: 100 }),
    fact({ to: { x: 2, y: 64, z: 0 }, lastSeenAt: 200 }),
  ]
  const log = capture()
  const result = mergeKnownTraversalsInto(store, [fact({ to: { x: 3, y: 64, z: 0 }, lastSeenAt: 300 })], {
    cap: 2,
    log: log.log,
  })
  const evicted = log.events.find((entry) => entry.event === 'TRAVERSAL_EVICTED')
  const pass =
    result.added === 1 &&
    store.length === 2 &&
    store.some((entry) => traversalCellKey(entry.to) === '3,64,0') &&
    !store.some((entry) => traversalCellKey(entry.to) === '1,64,0') &&
    evicted?.detail.to === '1,64,0' &&
    evicted?.detail.reason === 'capacity'
  return { pass, detail: `added=${result.added} len=${store.length} evicted=${JSON.stringify(evicted?.detail)}` }
})

addCase('the store never exceeds KNOWN_TRAVERSAL_CAP across repeated inserts', () => {
  const store: KnownTraversalJson[] = []
  let peak = 0
  for (let index = 0; index < KNOWN_TRAVERSAL_CAP + 25; index += 1) {
    mergeKnownTraversalsInto(store, [fact({ to: { x: index, y: 64, z: 0 }, lastSeenAt: 1000 + index })])
    peak = Math.max(peak, store.length)
  }
  const pass = peak === KNOWN_TRAVERSAL_CAP && store.length === KNOWN_TRAVERSAL_CAP
  return { pass, detail: `peak=${peak} len=${store.length} cap=${KNOWN_TRAVERSAL_CAP}` }
})

addCase('the newest observed outcome for a leg supersedes the previous one', () => {
  const store: KnownTraversalJson[] = []
  mergeKnownTraversalsInto(store, [fact({ result: 'blocked', reason: 'wall', lastSeenAt: 100 })])
  mergeKnownTraversalsInto(store, [fact({ result: 'ok', lastSeenAt: 200 })])
  const entry = store[0]
  const pass =
    store.length === 1 && entry?.result === 'ok' && entry?.reason === undefined && entry?.lastSeenAt === 200
  return { pass, detail: `len=${store.length} entry=${JSON.stringify(entry)}` }
})

addCase('the HOST delta merge routes traversal facts through the same bounded merge', () => {
  const memory = emptyWorldMemory()
  const log = capture()
  mergeWorldMemoryDelta(memory, { knownTraversals: [fact({ result: 'blocked', reason: 'wall' })] }, log.log)
  const first = memory.knownTraversals[0]
  const afterBlock = first === undefined ? null : { ...first }
  mergeWorldMemoryDelta(memory, { knownTraversals: [fact({ result: 'ok', lastSeenAt: 2000 })] }, log.log)
  const afterOk = memory.knownTraversals[0]
  const pass =
    memory.knownTraversals.length === 1 &&
    afterBlock?.result === 'blocked' &&
    afterOk?.result === 'ok' &&
    afterOk?.reason === undefined
  return { pass, detail: `len=${memory.knownTraversals.length} entry=${JSON.stringify(afterOk)}` }
})

// --- (a) durable round-trip -----------------------------------------------------

function durableSnapshot(step: KnownTraversalJson): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'route-memory-'))
  const path = join(dir, 'buddy-state.json')
  const memory = emptyWorldMemory()
  memory.knownTraversals.push(step)
  const snapshot = emptyAgentSnapshot({ worldEpoch: EPOCH })
  snapshot.worldMemoryByKey = { [worldKeyString(WORLD_KEY)]: memory }
  writeSnapshotAtomic(path, snapshot)
  return { dir, path }
}

function loadMemory(path: string): ResidentWorldMemory {
  // Exercise the real host restore path (schema validation + normalisation), not
  // just a raw JSON.parse: (c) must be "fresh load from the durable snapshot".
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const result = validateAgentSnapshot(raw)
  if (result.snapshot === null) throw new Error(`durable snapshot rejected: ${result.rejected ?? 'unknown'}`)
  const memory = result.snapshot.worldMemoryByKey[worldKeyString(WORLD_KEY)]
  if (memory === undefined) throw new Error('world memory key missing from durable snapshot')
  return normalizeWorldMemory(memory)
}

addCase('(a) a recorded successful step survives a durable JSON round-trip', () => {
  const step = fact({
    from: { x: 196, y: 67, z: -15 },
    to: { x: 195, y: 66, z: -15 },
    kind: 'descend',
    result: 'ok',
    reason: undefined,
    lastSeenAt: 1700,
  })
  const { dir, path } = durableSnapshot(step)
  try {
    const loaded = loadMemory(path)
    const restored = loaded.knownTraversals[0]
    const pass =
      reloadJsonEquals(restored, step) &&
      restored !== undefined &&
      traversalCellKey(restored.from) === '196,67,-15' &&
      traversalCellKey(restored.to) === '195,66,-15' &&
      restored.kind === 'descend' &&
      restored.result === 'ok' &&
      restored.worldEpoch === EPOCH
    return { pass, detail: `restored=${JSON.stringify(restored)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function reloadJsonEquals(a: KnownTraversalJson | undefined, b: KnownTraversalJson): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// --- (b) consumer: blocked direction not re-offered -----------------------------

addCase('(b) a remembered blocked leg suppresses the waypoint it covers', () => {
  const blocked = fact({ result: 'blocked', reason: 'wall' })
  const far = waypoint(40, 64, 0)
  const result = filterBlockedTraversalWaypoints(
    [waypoint(11, 64, 0), far],
    [blocked],
    { x: 10, y: 64, z: 0 },
    EPOCH,
  )
  const suppression = result.blocked[0]
  const pass =
    result.kept.length === 1 &&
    result.kept[0]?.position.x === 40 &&
    result.blocked.length === 1 &&
    suppression?.direction === 'E' &&
    suppression?.fact.reason === 'wall'
  return { pass, detail: `kept=${result.kept.length} blocked=${JSON.stringify(suppression)}` }
})

addCase('(b) a blocked leg does not suppress an unrelated waypoint or a foreign epoch leg', () => {
  // A blocked leg to a cell that is not a waypoint suppresses nothing.
  const elsewhere = filterBlockedTraversalWaypoints(
    [waypoint(11, 64, 0)],
    [fact({ to: { x: 30, y: 64, z: 0 }, result: 'blocked', worldEpoch: EPOCH })],
    { x: 10, y: 64, z: 0 },
    EPOCH,
  )
  // A blocked leg stamped to a previous epoch is not world truth for this one.
  const foreignEpoch = filterBlockedTraversalWaypoints(
    [waypoint(11, 64, 0)],
    [fact({ result: 'blocked', worldEpoch: EPOCH - 1 })],
    { x: 10, y: 64, z: 0 },
    EPOCH,
  )
  const pass = elsewhere.kept.length === 1 && elsewhere.blocked.length === 0 && foreignEpoch.kept.length === 1 && foreignEpoch.blocked.length === 0
  return {
    pass,
    detail: `elsewhere=${elsewhere.kept.length}/${elsewhere.blocked.length} foreignEpoch=${foreignEpoch.kept.length}/${foreignEpoch.blocked.length}`,
  }
})

addCase('(d) a worldEpoch change keeps the waypoint and starts a fresh empty store', () => {
  const stale = fact({ result: 'blocked', worldEpoch: EPOCH })
  const result = filterBlockedTraversalWaypoints(
    [waypoint(11, 64, 0)],
    [stale],
    { x: 10, y: 64, z: 0 },
    EPOCH + 1,
  )
  const nextEpoch: WorldKey = { ...WORLD_KEY, worldEpoch: EPOCH + 1 }
  const fresh = emptyWorldMemory()
  const pass =
    result.kept.length === 1 &&
    result.blocked.length === 0 &&
    fresh.knownTraversals.length === 0 &&
    acceptsWorldMemoryProposal(WORLD_KEY, nextEpoch) === false &&
    worldKeyString(WORLD_KEY) !== worldKeyString(nextEpoch)
  return { pass, detail: `kept=${result.kept.length} blocked=${result.blocked.length} fresh=${fresh.knownTraversals.length}` }
})

// --- (c) restart steers the same way --------------------------------------------

addCase('(c) after a restart the durable snapshot suppresses the same direction', () => {
  const blocked = fact({ result: 'blocked', reason: 'fall', lastSeenAt: 1700 })
  const { dir, path } = durableSnapshot(blocked)
  try {
    const loaded = loadMemory(path)
    const result = filterBlockedTraversalWaypoints(
      [waypoint(11, 64, 0), waypoint(40, 64, 0)],
      loaded.knownTraversals,
      { x: 10, y: 64, z: 0 },
      EPOCH,
    )
    const pass =
      loaded.knownTraversals.length === 1 &&
      result.blocked.length === 1 &&
      result.blocked[0]?.direction === 'E' &&
      result.blocked[0]?.fact.reason === 'fall' &&
      result.kept.length === 1
    return { pass, detail: `loaded=${loaded.knownTraversals.length} blocked=${JSON.stringify(result.blocked)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- consumer: ok leg corroborates a reachable waypoint -------------------------

addCase('a remembered ok leg yields a TRAVERSAL_HINT for a reachable waypoint', () => {
  const ok = fact({ result: 'ok' })
  const hints = traversalHintsForWaypoints([waypoint(11, 64, 0), waypoint(40, 64, 0)], [ok], { x: 10, y: 64, z: 0 }, EPOCH)
  const blockedHints = traversalHintsForWaypoints(
    [waypoint(11, 64, 0)],
    [fact({ result: 'blocked' })],
    { x: 10, y: 64, z: 0 },
    EPOCH,
  )
  const pass = hints.length === 1 && hints[0]?.waypoint.x === 11 && blockedHints.length === 0
  return { pass, detail: `hints=${JSON.stringify(hints)} blocked=${blockedHints.length}` }
})

let failures = 0
process.stdout.write('durable route/traversal memory (#354)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} route-memory cases passed\n`)
if (failures > 0) process.exit(1)
