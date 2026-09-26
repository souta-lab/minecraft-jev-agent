// test-longterm-memory.mts - long-term "where things are" durable memory audit.
//
// OWNER REQUEST: durable memory of *where things are* (furnace, crafting table,
// portal, ores...) that survives generation reloads, respawns and host restarts.
//
// This fixture pins the durability contract end to end, offline (no bot, no
// network, no live host):
//
//   1. write -> serialize to disk -> restore keeps EVERY durable field under the
//      same `worldKey` (`serverId|dimension|worldEpoch`).
//   2. the write paths never persist the live-truth projections (`portalVerified`,
//      `dimension`); they are re-observed, never restored.
//   3. a different dimension / a bumped worldEpoch is a DIFFERENT namespace, so
//      an overworld furnace is not reused in the Nether and a world reset drops
//      the old coordinates (no stale-coordinate reuse).
//   4. the STAGED commit path (`commitPendingProposals`, used by
//      generation-start and every hot reload) persists the same delta fields as
//      the live path. This is where issue #80 regressed: the staged merge
//      (`mergeWorldMemoryDelta`) did not handle `knownPortalSites` /
//      `removeKnownPortalSites`, so a verified portal site was silently dropped
//      on reload/generation-start.
//
// After the fix `mergeWorldMemoryDelta` is the single merge used by both the
// staged commit and the live `proposeWorldMemory` delta path, so the staged case
// below pins the shared implementation for both.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot } from 'mineflayer'
import type {
  AgentSnapshot,
  DeathHazard,
  KnownPortalSiteJson,
  KnownResourceJson,
  KnownStation,
  ResidentWorldMemory,
  TraversalFailure,
  WorldKey,
  WorldMemoryDelta,
} from './resident-types.ts'
import { emptyWorldMemory, worldKeyString } from './resident-types.ts'
import { emptyAgentSnapshot, restoreAgentSnapshot } from './state-snapshot.ts'
import { durableWriteLanded } from './host-durability.ts'
import {
  commitPendingProposals,
  mergeWorldMemoryDelta,
  newPendingProposals,
  stageWorldMemory,
  writeSnapshotAtomic,
} from './proposal-staging.ts'
import { acceptsWorldMemoryProposal, sameWorldKey } from './world-epoch.ts'
import { evictStaleKnownResources, syncKnownPortalSites } from './generation-entry.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const SERVER = '127.0.0.1:25565'
const EPOCH = 3
const OVERWORLD: WorldKey = { serverId: SERVER, dimension: 'minecraft:overworld', worldEpoch: EPOCH }
const NETHER: WorldKey = { serverId: SERVER, dimension: 'minecraft:the_nether', worldEpoch: EPOCH }
const NEXT_EPOCH: WorldKey = { ...OVERWORLD, worldEpoch: EPOCH + 1 }
const OVER_KEY = worldKeyString(OVERWORLD)
const NETHER_KEY = worldKeyString(NETHER)
const NEXT_KEY = worldKeyString(NEXT_EPOCH)

const TABLE: KnownStation = {
  x: 10,
  y: 65,
  z: -9,
  kind: 'crafting_table',
  firstSeenAt: 100,
  lastVerifiedAt: 200,
  status: 'verified',
  failures: 0,
}
const FURNACE: KnownStation = {
  x: 10,
  y: 65,
  z: -8,
  kind: 'furnace',
  firstSeenAt: 100,
  lastVerifiedAt: 200,
  status: 'verified',
  failures: 0,
}
const RESOURCE: KnownResourceJson = {
  name: 'iron_ore',
  kind: 'ore',
  x: 12,
  y: 40,
  z: -4,
  dimension: 'minecraft:overworld',
  worldEpoch: EPOCH,
  lastSeenAt: 150,
}
const PORTAL: KnownPortalSiteJson = {
  x: 40,
  y: 64,
  z: -12,
  widthAxis: 'x',
  dimension: 'minecraft:overworld',
  worldEpoch: EPOCH,
  lastVerifiedAt: 175,
  frame: [
    { x: 40, y: 64, z: -12 },
    { x: 41, y: 64, z: -12 },
  ],
  interior: [{ x: 40, y: 65, z: -12 }],
}
const TRAVERSAL: TraversalFailure = {
  obstacleSignature: 'wall:2',
  from: { x: 1, y: 64, z: 1 },
  toward: { x: 3, y: 64, z: 1 },
  wallHeight: 2,
  failureKind: 'stuck',
  attempts: 2,
  lastSeenAt: 160,
}
const MOVE_FAIL = {
  key: 'minecraft:overworld:9,64,9',
  dimension: 'minecraft:overworld',
  x: 9,
  y: 64,
  z: 9,
  attempts: 3,
  firstFailedAt: 1,
  lastFailedAt: 2,
  lastReason: 'unreachable' as const,
  blacklistedUntil: 30_000,
}
const HAZARD: DeathHazard = {
  x: 5,
  y: 30,
  z: 5,
  reason: 'lava',
  count: 2,
  firstSeenAt: 1,
  lastSeenAt: 2,
  source: 'production',
}

/** A memory carrying every durable field, used for round-trip/keying cases. */
function richMemory(): ResidentWorldMemory {
  return {
    ...emptyWorldMemory(),
    craftingTables: [{ ...TABLE }],
    furnaces: [{ ...FURNACE }],
    mined: { '1,63,2:stone': 2 },
    discoveredOres: ['iron_ore', 'coal_ore'],
    knownResources: [{ ...RESOURCE }],
    knownPortalSites: [
      { ...PORTAL, frame: PORTAL.frame?.map((cell) => ({ ...cell })), interior: PORTAL.interior?.map((cell) => ({ ...cell })) },
    ],
    traversalFailures: [{ ...TRAVERSAL, from: { ...TRAVERSAL.from }, toward: { ...TRAVERSAL.toward } }],
    moveFailures: [{ ...MOVE_FAIL }],
    hazards: [{ ...HAZARD }],
  }
}

/** `emptyAgentSnapshot` deliberately resets `worldMemoryByKey`, so set it after. */
function snapshotWith(worldMemoryByKey: Record<string, ResidentWorldMemory>, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  const snapshot = emptyAgentSnapshot({ bot: 'AI_LTM', serverId: SERVER, ...overrides })
  snapshot.worldMemoryByKey = worldMemoryByKey
  return snapshot
}

/** Mimic the host's `keyedMemory()` lookup: the current world key's namespace. */
function keyedLookup(map: Record<string, ResidentWorldMemory>, key: WorldKey): ResidentWorldMemory {
  return map[worldKeyString(key)] ?? emptyWorldMemory()
}

function capture(): { events: Array<{ event: string; detail: Record<string, unknown> }>; log: (event: string, detail?: Record<string, unknown>) => void } {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = []
  return { events, log: (event, detail) => events.push({ event, detail: detail ?? {} }) }
}

// ---------------------------------------------------------------------------
// 1. write -> serialize -> restore, same worldKey
// ---------------------------------------------------------------------------

addCase('#durable: every durable field survives write -> serialize -> restore under the same worldKey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'longterm-memory-'))
  const path = join(dir, 'buddy-state.json')
  try {
    writeSnapshotAtomic(path, snapshotWith({ [OVER_KEY]: richMemory() }, { worldEpoch: EPOCH, revision: 7 }))
    const restored = restoreAgentSnapshot(
      JSON.parse(readFileSync(path, 'utf8')),
      emptyAgentSnapshot({ bot: 'AI_LTM', serverId: SERVER }),
      capture().log,
    )
    const memory = restored.worldMemoryByKey[OVER_KEY]
    const pass =
      restored.worldEpoch === EPOCH &&
      worldKeyString({ serverId: restored.serverId, dimension: restored.dimension, worldEpoch: restored.worldEpoch }) === OVER_KEY &&
      memory !== undefined &&
      memory.craftingTables.length === 1 &&
      memory.craftingTables[0]?.status === 'verified' &&
      memory.craftingTables[0]?.lastVerifiedAt === 200 &&
      memory.furnaces.length === 1 &&
      memory.furnaces[0]?.kind === 'furnace' &&
      memory.mined['1,63,2:stone'] === 2 &&
      memory.discoveredOres.join(',') === 'iron_ore,coal_ore' &&
      memory.knownResources.length === 1 &&
      memory.knownResources[0]?.dimension === 'minecraft:overworld' &&
      memory.knownResources[0]?.worldEpoch === EPOCH &&
      memory.knownResources[0]?.lastSeenAt === 150 &&
      memory.knownPortalSites.length === 1 &&
      memory.knownPortalSites[0]?.widthAxis === 'x' &&
      memory.knownPortalSites[0]?.frame?.length === 2 &&
      memory.knownPortalSites[0]?.interior?.length === 1 &&
      memory.knownPortalSites[0]?.lastVerifiedAt === 175 &&
      memory.traversalFailures.length === 1 &&
      memory.traversalFailures[0]?.toward.x === 3 &&
      memory.moveFailures.length === 1 &&
      memory.moveFailures[0]?.attempts === 3 &&
      memory.hazards.length === 1 &&
      memory.hazards[0]?.reason === 'lava' &&
      memory.hazards[0]?.count === 2
    return { pass, detail: `key=${OVER_KEY} mem=${memory === undefined ? 'MISSING' : JSON.stringify({ tables: memory.craftingTables.length, furnaces: memory.furnaces.length, mined: Object.keys(memory.mined).length, ores: memory.discoveredOres.length, resources: memory.knownResources.length, portals: memory.knownPortalSites.length, traversal: memory.traversalFailures.length, moveFailures: memory.moveFailures.length, hazards: memory.hazards.length })}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#durable: live-truth projections never enter durable state through a write path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'longterm-memory-'))
  const path = join(dir, 'buddy-state.json')
  try {
    // Build the memory ONLY through the canonical merge (as every runtime/staged
    // write does), then round-trip it to disk.
    const memory = emptyWorldMemory()
    mergeWorldMemoryDelta(
      memory,
      {
        craftingTables: [{ ...TABLE }],
        knownPortalSites: [{ ...PORTAL }],
        hazards: [{ ...HAZARD }],
      },
      () => undefined,
    )
    const live = memory as unknown as Record<string, unknown>
    writeSnapshotAtomic(path, snapshotWith({ [OVER_KEY]: memory }, { worldEpoch: EPOCH }))
    const restored = restoreAgentSnapshot(
      JSON.parse(readFileSync(path, 'utf8')),
      emptyAgentSnapshot({ bot: 'AI_LTM', serverId: SERVER }),
      capture().log,
    )
    const restoredMemory = restored.worldMemoryByKey[OVER_KEY] as unknown as Record<string, unknown> | undefined
    const pass =
      live.portalVerified === undefined &&
      live.dimension === undefined &&
      restoredMemory !== undefined &&
      restoredMemory.portalVerified === undefined &&
      restoredMemory.dimension === undefined
    return { pass, detail: `mergedPortalVerified=${String(live.portalVerified)} mergedDimension=${String(live.dimension)} restoredPortalVerified=${String(restoredMemory?.portalVerified)} restoredDimension=${String(restoredMemory?.dimension)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. keying: dimension + worldEpoch
// ---------------------------------------------------------------------------

addCase('#keying: an overworld furnace is not visible/reusable in the Nether (same epoch)', () => {
  const map: Record<string, ResidentWorldMemory> = { [OVER_KEY]: richMemory() }
  const nether = keyedLookup(map, NETHER)
  const accepted = acceptsWorldMemoryProposal(OVERWORLD, NETHER)
  const pass =
    nether.furnaces.length === 0 &&
    nether.knownResources.length === 0 &&
    nether.knownPortalSites.length === 0 &&
    map[OVER_KEY]?.furnaces.length === 1 &&
    map[NETHER_KEY] === undefined &&
    !accepted &&
    !sameWorldKey(OVERWORLD, NETHER)
  return { pass, detail: `netherFurnaces=${nether.furnaces.length} overworldFurnaces=${map[OVER_KEY]?.furnaces.length} accepted=${accepted} netherKeyPresent=${map[NETHER_KEY] !== undefined}` }
})

addCase('#keying: a worldEpoch bump drops the old namespace and rejects its proposals', () => {
  const map: Record<string, ResidentWorldMemory> = { [OVER_KEY]: richMemory() }
  const next = keyedLookup(map, NEXT_EPOCH)
  const accepted = acceptsWorldMemoryProposal(OVERWORLD, NEXT_EPOCH)
  const pass =
    next.craftingTables.length === 0 &&
    next.knownPortalSites.length === 0 &&
    next.hazards.length === 0 &&
    !accepted &&
    map[NEXT_KEY] === undefined &&
    map[OVER_KEY]?.hazards.length === 1
  return { pass, detail: `nextEpochEmpty=${next.craftingTables.length === 0} accepted=${accepted} nextKeyPresent=${map[NEXT_KEY] !== undefined}` }
})

addCase('#keying: live re-validation drops same-key entries stamped with another epoch/dimension', () => {
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    blockAt: () => ({ name: 'iron_ore' }),
  } as unknown as Bot
  const resources: KnownResourceJson[] = [
    { ...RESOURCE, worldEpoch: EPOCH },
    { ...RESOURCE, x: 30, dimension: 'minecraft:the_nether' },
  ]
  const evicted = evictStaleKnownResources(bot, resources, { dimension: 'minecraft:overworld', worldEpoch: EPOCH + 1 }, () => undefined)
  const portal = syncKnownPortalSites({
    known: [{ ...PORTAL }],
    liveVerified: [],
    worldKey: { dimension: 'minecraft:the_nether', worldEpoch: EPOCH },
    position: { x: 0, y: 64, z: 0 },
  })
  const pass = evicted.length === 2 && resources.length === 0 && portal.removed.length === 1 && portal.known.length === 0
  return { pass, detail: `evictedResources=${evicted.length} portalRemoved=${portal.removed.length}` }
})

// ---------------------------------------------------------------------------
// 3. staged commit parity (the #80 regression)
// ---------------------------------------------------------------------------

addCase('#80 fix: the staged commit path persists knownPortalSites and removeKnownPortalSites', () => {
  const memory = emptyWorldMemory()
  const stale: KnownPortalSiteJson = { ...PORTAL, x: 50, z: 50 }
  memory.knownPortalSites.push({ ...stale })
  const pending = newPendingProposals()
  pending.generationId = 'gen-1'
  pending.worldKey = OVERWORLD
  stageWorldMemory(pending, { knownPortalSites: [{ ...PORTAL }], removeKnownPortalSites: [{ ...stale }] })
  let saves = 0
  const result = commitPendingProposals(
    {
      pending,
      memory,
      state: snapshotWith({ [OVER_KEY]: memory }, { worldEpoch: EPOCH }),
      guard: { revision: 5, committedGenerationId: 'gen-1', activeGenerationId: 'gen-1' },
      log: capture().log,
      save: () => {
        saves += 1
        return durableWriteLanded('generation-start', 6)
      },
      worldKey: OVERWORLD,
    },
    'generation-start',
  )
  const pass =
    result.worldMemoryDeltasApplied === 1 &&
    saves === 1 &&
    memory.knownPortalSites.length === 1 &&
    memory.knownPortalSites[0]?.x === PORTAL.x &&
    memory.knownPortalSites[0]?.z === PORTAL.z &&
    memory.knownPortalSites[0]?.widthAxis === 'x' &&
    memory.knownPortalSites[0]?.frame?.length === 2 &&
    !memory.knownPortalSites.some((site) => site.x === stale.x)
  return { pass, detail: `applied=${result.worldMemoryDeltasApplied} saves=${saves} known=${JSON.stringify(memory.knownPortalSites.map((site) => `${site.x},${site.y},${site.z}`))}` }
})

addCase('#durable: the canonical merge handles every WorldMemoryDelta field (staged == live)', () => {
  const memory = emptyWorldMemory()
  memory.knownPortalSites.push({ ...PORTAL, x: 99, z: 99 })
  memory.knownResources.push({ ...RESOURCE, x: 99, z: 99 })
  const delta: WorldMemoryDelta = {
    craftingTables: [{ ...TABLE }],
    furnaces: [{ ...FURNACE }],
    removeStations: [{ ...TABLE, x: 1, y: 1, z: 1 }],
    discoveredOres: ['iron_ore'],
    knownResources: [{ ...RESOURCE }],
    removeKnownResources: [{ ...RESOURCE, x: 99, z: 99 }],
    knownPortalSites: [{ ...PORTAL }],
    removeKnownPortalSites: [{ ...PORTAL, x: 99, z: 99 }],
    mined: { '1,63,2:stone': 1 },
    traversalFailures: [{ ...TRAVERSAL }],
    moveFailures: [{ ...MOVE_FAIL }],
    hazards: [{ ...HAZARD }],
  }
  mergeWorldMemoryDelta(memory, delta, () => undefined)
  const pass =
    memory.craftingTables.length === 1 &&
    memory.furnaces.length === 1 &&
    memory.discoveredOres.includes('iron_ore') &&
    memory.knownResources.length === 1 &&
    memory.knownResources[0]?.x === RESOURCE.x &&
    memory.knownPortalSites.length === 1 &&
    memory.knownPortalSites[0]?.x === PORTAL.x &&
    memory.mined['1,63,2:stone'] === 1 &&
    memory.traversalFailures.length === 1 &&
    memory.moveFailures.length === 1 &&
    memory.hazards.length === 1 &&
    memory.hazards[0]?.count === 2
  return { pass, detail: JSON.stringify({ tables: memory.craftingTables.length, furnaces: memory.furnaces.length, ores: memory.discoveredOres.length, resources: memory.knownResources.length, portals: memory.knownPortalSites.length, mined: Object.keys(memory.mined).length, traversal: memory.traversalFailures.length, moveFailures: memory.moveFailures.length, hazards: memory.hazards.length }) }
})

addCase('#durable: a stale-key staged delta is rejected wholesale (no cross-world write)', () => {
  const memory = emptyWorldMemory()
  const pending = newPendingProposals()
  pending.generationId = 'gen-1'
  pending.worldKey = OVERWORLD
  stageWorldMemory(pending, { furnaces: [{ ...FURNACE }] })
  const cap = capture()
  const result = commitPendingProposals(
    {
      pending,
      memory,
      state: snapshotWith({ [NETHER_KEY]: memory }, { worldEpoch: EPOCH, dimension: 'minecraft:the_nether' }),
      guard: { revision: 5, committedGenerationId: 'gen-1', activeGenerationId: 'gen-1' },
      log: cap.log,
      save: () => durableWriteLanded('generation-start', 6),
      worldKey: NETHER,
    },
    'generation-start',
  )
  const rejected = cap.events.find((event) => event.event === 'WORLDMEMORY_REJECTED')
  const pass = result.worldMemoryDeltasApplied === 0 && memory.furnaces.length === 0 && rejected !== undefined
  return { pass, detail: `applied=${result.worldMemoryDeltasApplied} furnaces=${memory.furnaces.length} rejected=${rejected !== undefined}` }
})

let failures = 0
process.stdout.write('long-term world memory durability (where things are)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} long-term-memory cases passed\n`)
if (failures > 0) process.exit(1)
