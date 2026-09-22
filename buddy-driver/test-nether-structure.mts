// test-nether-structure.mts - M3: Nether fortress perception + durable structure
// memory, offline (no bot, no network, no live host).
//
// WHY (M3): ender_eye x12 = 12 ender_pearl + 12 blaze_powder, and blaze_powder
// only comes from blaze_rod, which only drops from Nether blazes, which only
// live in Nether fortresses. The candidate layer has no structure/POI perception
// at all, so once the resident reaches the Nether it has nothing to navigate
// toward. This fixture pins the PERCEPTION + DURABLE-MEMORY foundation only
// (the action side is wired separately):
//
//   1. `nether_bricks` (fortress body) is name-scannable for the `blaze_rod`
//      focus, so a sensed fortress material becomes representable truth in
//      `state.blocks`; the unknown-focus contract (undefined) is preserved.
//   2. a sensed Nether fortress site is recorded durably (coordinates +
//      dimension + worldEpoch) and survives a generation/world-memory rebuild
//      with the same worldKey.
//   3. the record is dropped on a worldEpoch change and on a dimension change
//      (no cross-world / cross-dimension leak).
//   4. overworld sensing mints NO Nether structure record: `nether_bricks` is a
//      real block anywhere, but a fortress is Nether-only world truth.
//   5. both commit paths persist the record: the canonical live merge
//      (`mergeWorldMemoryDelta`) and the STAGED commit path
//      (`stageWorldMemory` -> `commitPendingProposals`). A previous #80
//      regression dropped `knownPortalSites` because only the live path handled
//      it; this pins the shared implementation for structure sites.
//
// Before this change none of `NETHER_STRUCTURE_BLOCK_NAMES`, the `blaze_rod`
// direct source, `syncKnownStructureSites` or `ResidentWorldMemory.
// knownStructureSites` existed, so this fixture could not even import; it fails
// before and passes after by construction.
//
// Run: bun test-nether-structure.mts
import { createRequire } from 'node:module'
import type {
  AgentSnapshot,
  KnownStructureSiteJson,
  ResidentWorldMemory,
  WorldKey,
  WorldMemoryDelta,
} from './resident-types.ts'
import { emptyWorldMemory, normalizeWorldMemory, worldKeyString } from './resident-types.ts'
import { emptyAgentSnapshot } from './state-snapshot.ts'
import { durableWriteLanded } from './host-durability.ts'
import {
  commitPendingProposals,
  mergeWorldMemoryDelta,
  newPendingProposals,
  stageWorldMemory,
} from './proposal-staging.ts'
import {
  NETHER_DIMENSION_ID,
  STRUCTURE_SITE_PROOF_DISTANCE,
  isNetherDimension,
  syncKnownStructureSites,
} from './generation-entry.ts'
import {
  NETHER_STRUCTURE_BLOCK_NAMES,
  buildWorldState,
  defaultSensorOptions,
  makeGoal,
  scannedBlockNames,
} from '../jev-agent/src/state.ts'
import type { AgentSignals, Vec3Json } from '../jev-agent/src/state.ts'
import { emptyGoalQueueState } from '../jev-agent/src/goalQueue.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
/** The live server version's real registry (mineflayer loads the same object). */
const registry = require('minecraft-data')('1.21.11')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const SERVER = '127.0.0.1:25565'
const EPOCH = 4
const NETHER: WorldKey = { serverId: SERVER, dimension: 'minecraft:the_nether', worldEpoch: EPOCH }
const OVERWORLD: WorldKey = { serverId: SERVER, dimension: 'minecraft:overworld', worldEpoch: EPOCH }

/** A sensed fortress body cell: nether bricks one block above the lava sea floor. */
const SITE_POS: Vec3Json = { x: 118, y: 71, z: -244 }
/** A fortress body cell inside the sensor scan radius of the fake bot origin. */
const NEAR_POS: Vec3Json = { x: 12, y: 63, z: 8 }
const STALE_POS: Vec3Json = { x: 999, y: 71, z: 999 }
const SITE: KnownStructureSiteJson = {
  x: SITE_POS.x,
  y: SITE_POS.y,
  z: SITE_POS.z,
  kind: 'nether_fortress',
  blocks: ['nether_brick_fence', 'nether_bricks'],
  dimension: NETHER.dimension,
  worldEpoch: EPOCH,
  lastSeenAt: 1000,
}
/** The live scan shape `syncStructureSiteMemory` feeds the pure lifecycle. */
const LIVE_SENSED = [
  { position: SITE_POS, kind: 'nether_fortress' as const, blocks: ['nether_bricks', 'nether_brick_fence'] },
]
/** The bot far from the site: absence there proves nothing (#14 proof distance). */
const FAR: Vec3Json = { x: 0, y: 64, z: 0 }
/** The bot standing at the site: a failing live re-check is proof. */
const AT_SITE: Vec3Json = { x: SITE_POS.x + 2, y: SITE_POS.y, z: SITE_POS.z }

function syncStructures(overrides: {
  known: readonly KnownStructureSiteJson[]
  liveSensed?: typeof LIVE_SENSED
  worldKey?: { dimension: string; worldEpoch: number }
  position?: Vec3Json
  now?: number
}): ReturnType<typeof syncKnownStructureSites> {
  return syncKnownStructureSites({
    known: overrides.known,
    liveSensed: overrides.liveSensed ?? [],
    worldKey: overrides.worldKey ?? NETHER,
    position: overrides.position ?? FAR,
    now: overrides.now ?? 5000,
  })
}

// --- (1) perception: the fortress body is name-scannable ------------------------

type BotLike = Parameters<typeof buildWorldState>[0]

function fakeBot(sensed: Record<string, Vec3Json[]>, counts: Record<string, number>, dimension: string): BotLike {
  const position = new Vec3(0, 64, 0)
  const blocks = new Map<string, { name: string; boundingBox: string; diggable: boolean }>()
  for (const [name, positions] of Object.entries(sensed)) {
    for (const p of positions) blocks.set(`${p.x},${p.y},${p.z}`, { name, boundingBox: 'block', diggable: true })
  }
  const blockAt = (p: { x: number; y: number; z: number }) =>
    blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? {
      name: 'air',
      boundingBox: 'empty',
      diggable: false,
    }
  const findBlocks = (options: {
    matching: ((block: { name: string }) => boolean) | number[]
    maxDistance: number
    count: number
  }): unknown[] => {
    const origin = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    const matches = (name: string): boolean => {
      if (typeof options.matching === 'function') return options.matching({ name })
      const block = registry.blocksByName[name]
      return block !== undefined && options.matching.includes(block.id)
    }
    const out: unknown[] = []
    for (const [name, positions] of Object.entries(sensed)) {
      if (!matches(name)) continue
      for (const p of positions) {
        const block = new Vec3(p.x, p.y, p.z)
        if (block.distanceTo(origin) <= options.maxDistance) out.push(block)
      }
    }
    return out.slice(0, options.count)
  }
  const items = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return {
    username: 'AI_M3NS',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension, minY: 0, height: 256 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => items },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
  } as never
}

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
    ...overrides,
  }
}

function perceive(focusItem: string, sensed: Record<string, Vec3Json[]>, dimension = NETHER.dimension) {
  return buildWorldState(
    fakeBot(sensed, { iron_pickaxe: 1 }, dimension),
    {
      tick: 1,
      goal: makeGoal(focusItem, 1),
      goalQueue: emptyGoalQueueState(),
      focusItem,
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
}

addCase('(1) the blaze_rod focus name-scans the Nether fortress body; unknown focus stays undefined', () => {
  const names = scannedBlockNames('blaze_rod')
  const unknown = scannedBlockNames('not_a_real_item')
  const pass =
    names !== undefined &&
    names.includes('nether_bricks') &&
    NETHER_STRUCTURE_BLOCK_NAMES.includes('nether_bricks') &&
    names.includes('nether_brick_fence') &&
    names.includes('nether_brick_stairs') &&
    unknown === undefined &&
    scannedBlockNames('diamond')?.includes('diamond_ore') === true
  return { pass, detail: `blaze_rod=${JSON.stringify(names)} unknown=${String(unknown)}` }
})

addCase('(1) minecraft-data evidence: the fortress body names exist; blaze_spawner does not', () => {
  const present = NETHER_STRUCTURE_BLOCK_NAMES.map((name) => registry.blocksByName[name] !== undefined)
  const blazeSpawner = registry.blocksByName['blaze_spawner']
  const genericSpawner = registry.blocksByName['spawner']
  const pass =
    present.every(Boolean) &&
    registry.version.minecraftVersion === '1.21.11' &&
    blazeSpawner === undefined &&
    genericSpawner !== undefined &&
    !NETHER_STRUCTURE_BLOCK_NAMES.includes('spawner')
  return {
    pass,
    detail: `data=${registry.version.minecraftVersion} present=${JSON.stringify(present)} blaze_spawner=${String(blazeSpawner)} generic_spawner=${genericSpawner !== undefined}`,
  }
})

addCase('(1) a sensed nether_bricks block enters state.blocks with its real pickaxe harvest truth', () => {
  const state = perceive('blaze_rod', { nether_bricks: [NEAR_POS] })
  const sensed = state.blocks.filter((block) => block.name === 'nether_bricks')
  const block = sensed[0]
  return {
    pass:
      sensed.length === 1 &&
      block !== undefined &&
      block.kind === 'ore' &&
      block.yield === 'nether_bricks' &&
      block.harvestTool === 'pickaxe' &&
      block.harvestTier === 0,
    detail: `sensed=${sensed.length} block=${JSON.stringify(block ?? null)}`,
  }
})

addCase('(1) nether bricks are NOT invented for an unrelated focus item', () => {
  const state = perceive('diamond', { nether_bricks: [NEAR_POS] })
  const hallucinated = state.blocks.filter((block) => block.name.startsWith('nether_brick'))
  return { pass: hallucinated.length === 0, detail: `netherBrickBlocks=${hallucinated.length}` }
})

// --- (2) durable record + rebuild ----------------------------------------------

addCase('(2) record-once: a sensed Nether fortress site is recorded exactly once', () => {
  const first = syncStructures({ known: [], liveSensed: LIVE_SENSED })
  const second = syncStructures({ known: first.known, liveSensed: LIVE_SENSED })
  const site = second.known[0]
  const pass =
    first.added.length === 1 &&
    first.removed.length === 0 &&
    first.known.length === 1 &&
    second.added.length === 0 &&
    second.known.length === 1 &&
    site?.x === SITE_POS.x &&
    site?.y === SITE_POS.y &&
    site?.z === SITE_POS.z &&
    site?.kind === 'nether_fortress' &&
    site?.dimension === NETHER.dimension &&
    site?.worldEpoch === EPOCH &&
    site?.lastSeenAt === 5000 &&
    site?.blocks?.includes('nether_bricks') === true
  return {
    pass,
    detail: `firstAdded=${first.added.length} secondAdded=${second.added.length} known=${JSON.stringify(second.known.map((s) => ({ ...s, blocks: s.blocks?.length })))}`,
  }
})

addCase('(2) durable: the site survives a generation/world-memory rebuild with the same worldKey', () => {
  const recorded = syncStructures({ known: [], liveSensed: LIVE_SENSED })
  // Simulate the host write + a new generation loading durable memory: the record
  // crosses the boundary as plain JSON and is normalized on read.
  const durable: ResidentWorldMemory = {
    ...emptyWorldMemory(),
    knownStructureSites: recorded.known.map((site) => ({ ...site, ...(site.blocks === undefined ? {} : { blocks: [...site.blocks] }) })),
  }
  const reloaded = normalizeWorldMemory(JSON.parse(JSON.stringify(durable)) as ResidentWorldMemory)
  // The new generation is far from the site (after a respawn) and senses nothing.
  const afterRebuild = syncStructures({ known: reloaded.knownStructureSites, liveSensed: [], position: FAR })
  const site = afterRebuild.known[0]
  const pass =
    Array.isArray(reloaded.knownStructureSites) &&
    reloaded.knownStructureSites.length === 1 &&
    afterRebuild.removed.length === 0 &&
    afterRebuild.known.length === 1 &&
    site?.x === SITE_POS.x &&
    site?.z === SITE_POS.z &&
    site?.dimension === NETHER.dimension &&
    site?.worldEpoch === EPOCH &&
    site?.blocks?.length === 2
  return { pass, detail: `reloaded=${JSON.stringify(reloaded.knownStructureSites)} afterRebuild=${JSON.stringify(afterRebuild.known)}` }
})

// --- (3) worldEpoch / dimension re-anchoring -----------------------------------

addCase('(3) epoch: a world-epoch change drops the recorded site', () => {
  const result = syncStructures({ known: [SITE], liveSensed: [], worldKey: { ...NETHER, worldEpoch: EPOCH + 1 }, position: FAR })
  const pass = result.removed.length === 1 && result.removed[0]?.x === SITE_POS.x && result.known.length === 0
  return { pass, detail: `removed=${JSON.stringify(result.removed)} known=${result.known.length}` }
})

addCase('(3) dimension: a Nether site is dropped when the active world is the overworld', () => {
  const result = syncStructures({ known: [SITE], liveSensed: [], worldKey: OVERWORLD, position: FAR })
  const pass = result.removed.length === 1 && result.known.length === 0
  return { pass, detail: `removed=${JSON.stringify(result.removed)} known=${result.known.length}` }
})

// --- (4) overworld must never mint a Nether structure record -------------------

addCase('(4) overworld sensing mints NO Nether structure record', () => {
  const result = syncStructures({ known: [], liveSensed: LIVE_SENSED, worldKey: OVERWORLD, position: FAR })
  const pass =
    result.added.length === 0 &&
    result.known.length === 0 &&
    isNetherDimension(NETHER.dimension) === true &&
    isNetherDimension('minecraft:the_nether') === true &&
    isNetherDimension('minecraft:overworld') === false &&
    NETHER_DIMENSION_ID === 'the_nether'
  return { pass, detail: `added=${result.added.length} known=${result.known.length} isNether(overworld)=${isNetherDimension('minecraft:overworld')}` }
})

addCase('(4) proof distance: absence far from the site is not proof and keeps the entry', () => {
  const distance = Math.hypot(SITE.x - FAR.x, SITE.y - FAR.y, SITE.z - FAR.z)
  const result = syncStructures({ known: [SITE], liveSensed: [], position: FAR })
  const pass = distance > STRUCTURE_SITE_PROOF_DISTANCE && result.removed.length === 0 && result.known.length === 1
  return { pass, detail: `distance=${distance.toFixed(1)} proof=${STRUCTURE_SITE_PROOF_DISTANCE} known=${result.known.length}` }
})

addCase('(4) proof: a failing live re-check at the recorded site (bot present) drops the entry', () => {
  const result = syncStructures({ known: [SITE], liveSensed: [], position: AT_SITE })
  const pass = result.removed.length === 1 && result.known.length === 0
  return { pass, detail: `removed=${JSON.stringify(result.removed)} known=${result.known.length}` }
})

// --- (5) both commit paths persist the record ----------------------------------

addCase('(5) live path: the canonical merge handles knownStructureSites and removeKnownStructureSites', () => {
  const memory = emptyWorldMemory()
  memory.knownStructureSites.push({ ...SITE, x: STALE_POS.x, z: STALE_POS.z })
  const delta: WorldMemoryDelta = {
    knownStructureSites: [{ ...SITE }],
    removeKnownStructureSites: [{ ...SITE, x: STALE_POS.x, z: STALE_POS.z }],
  }
  mergeWorldMemoryDelta(memory, delta, () => undefined)
  const site = memory.knownStructureSites[0]
  const pass =
    memory.knownStructureSites.length === 1 &&
    site?.x === SITE_POS.x &&
    site?.kind === 'nether_fortress' &&
    site?.blocks?.length === 2 &&
    site?.blocks !== SITE.blocks // deep copy, not a shared array reference
  return { pass, detail: `known=${JSON.stringify(memory.knownStructureSites)}` }
})

/** `emptyAgentSnapshot` deliberately resets `worldMemoryByKey`, so set it after. */
function snapshotWith(worldMemoryByKey: Record<string, ResidentWorldMemory>, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  const snapshot = emptyAgentSnapshot({ bot: 'AI_M3NS', serverId: SERVER, ...overrides })
  snapshot.worldMemoryByKey = worldMemoryByKey
  return snapshot
}

addCase('(5) staged path: commitPendingProposals persists knownStructureSites (the #80 regression shape)', () => {
  const memory = emptyWorldMemory()
  memory.knownStructureSites.push({ ...SITE, x: STALE_POS.x, z: STALE_POS.z })
  const pending = newPendingProposals()
  pending.generationId = 'gen-m3-ns'
  pending.worldKey = NETHER
  stageWorldMemory(pending, {
    knownStructureSites: [{ ...SITE }],
    removeKnownStructureSites: [{ ...SITE, x: STALE_POS.x, z: STALE_POS.z }],
  })
  let saves = 0
  const result = commitPendingProposals(
    {
      pending,
      memory,
      state: snapshotWith({ [worldKeyString(NETHER)]: memory }, { worldEpoch: EPOCH, dimension: NETHER.dimension }),
      guard: { revision: 5, committedGenerationId: 'gen-m3-ns', activeGenerationId: 'gen-m3-ns' },
      log: () => undefined,
      save: () => {
        saves += 1
        return durableWriteLanded('generation-start', 6)
      },
      worldKey: NETHER,
    },
    'generation-start',
  )
  const site = memory.knownStructureSites[0]
  const pass =
    result.worldMemoryDeltasApplied === 1 &&
    saves === 1 &&
    memory.knownStructureSites.length === 1 &&
    site?.x === SITE_POS.x &&
    site?.dimension === NETHER.dimension &&
    site?.blocks?.length === 2 &&
    !memory.knownStructureSites.some((current) => current.x === STALE_POS.x)
  return { pass, detail: `applied=${result.worldMemoryDeltasApplied} saves=${saves} known=${JSON.stringify(memory.knownStructureSites.map((s) => `${s.x},${s.y},${s.z}`))}` }
})

let failures = 0
process.stdout.write('Nether fortress perception + durable structure memory (M3)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} nether-structure cases passed\n`)
if (failures > 0) process.exit(1)
