// test-dimension-provenance.mts - the SENSOR/BLOCK-TRUTH half of the measured
// "a Nether body read Overworld block truth" defect.
//
// The live shape this pins (m3-live run, `buddy-driver/buddy.log`):
//   460803 10:46:24.487 WORLD_KEY_CHANGED from=minecraft:overworld to=minecraft:the_nether
//   460804 10:46:24.487 SPAWN pos=7.4,59.0,8.5 dimension=minecraft:the_nether respawn=false
//   460820 10:46:27.492 DIMENSION_OBSERVED dimension=minecraft:the_nether reason=generation-start
//   460826 10:46:27.845 KNOWN_RESOURCE item=jungle_log at=7,85,7 worldEpoch=1   (49-row batch)
// and the durable row `{"name":"jungle_log","kind":"log","x":8,"y":85,"z":6,
// "dimension":"minecraft:the_nether"}` - a jungle tree in the Nether. 52 sibling
// cells of the same batch were later read as `observed=air`.
//
// The mechanism, measured offline by driving mineflayer 4.39.0's REAL
// `lib/plugins/blocks.js` on a stub client with the real prismarine 1.21.11
// chunk/world (harness: `.lane-reports/measure-column-provenance.cjs`):
//   * a well-formed cross-dimension `respawn` DOES clear every column
//     (`blocks.js:563-580` -> `switchWorld()` -> `:536-538`), so a normal transfer
//     cannot leave one behind;
//   * a `respawn` whose `worldState` is absent THROWS at `blocks.js:568` before
//     `switchWorld()`, and the previous dimension's column stays readable while
//     `bot.game.dimension` is already the new one - the observed shape;
//   * a `dimension` change with no observed `respawn` leaves it readable too;
//   * reusing a 24-section Overworld column for 16-section Nether data throws
//     ("Attempted to read beyond the bounds of the managed data"), and the live log
//     has zero chunk-load errors, which bounds which upstream path can have fired.
// The log cannot discriminate the remaining branches - but every one of them has
// the SAME consequence, which is what this gate closes: one per-connection column
// store with NO world identity, whose invalidation is conditional and silent.
// `bot.blockAt`/`bot.findBlocks` therefore return a foreign dimension's data as if
// it were current, and the writer stamps the LIVE dimension onto it.
//
// Every case below is offline: stub bots, stub/real provenance, no socket, no world.

import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import {
  buildWorldState,
  defaultSensorOptions,
  makeGoal,
} from '../jev-agent/src/state.ts'
import type { DimensionProvenance, KnownResource, Vec3Json } from '../jev-agent/src/state.ts'
import { emptyGoalQueueState } from '../jev-agent/src/goalQueue.ts'
import type { AgentSignals } from '../jev-agent/src/state.ts'
import { generateCandidates, defaultCandidateOptions } from '../jev-agent/src/candidates.ts'
import {
  attachDimensionProvenance,
  createDimensionProvenanceView,
  writeRefusal,
} from './dimension-provenance.ts'
import type { DimensionProvenanceView } from './dimension-provenance.ts'
import { evictStaleKnownResources, mergeKnownResources } from './generation-entry.ts'
import type { KnownResourceJson } from './resident-types.ts'
import { normalizeDimensionId } from './dimension-observer.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The live server version's real registry (mineflayer loads the same object). */
const registry = require('minecraft-data')('1.21.11')

const OVERWORLD = 'minecraft:overworld'
const NETHER = 'minecraft:the_nether'

// The measured cells. (8,85,6)/(7,85,6)/(7,85,7) are chunk (0,0); (37,91,14) is
// chunk (2,0) - the two chunk columns the live scan actually read from.
const CELL_A: Vec3Json = { x: 8, y: 85, z: 6 }
const CELL_B: Vec3Json = { x: 37, y: 91, z: 14 }
const NETHER_FLOOR: Vec3Json = { x: 7, y: 59, z: 8 }

/**
 * A read-only provenance double: a fixed verdict per chunk column. This is the
 * "column cache and live dimension disagree" state the live defect produced, made
 * explicit so the gate can be tested without Mineflayer.
 */
function stubProvenance(
  live: string,
  byChunk: Record<string, string>,
  refusals: Array<{ reason: string; source: string; provenance: string; liveDimension: string; cell: Vec3Json }> = [],
  /**
   * Verdict for a chunk the map does not mention. `'unknown'` (the default) is the
   * honest answer for a column we did not watch load. A test that wants to model
   * "every column here was loaded under the live dimension" passes the live
   * dimension explicitly.
   */
  fallback: string | 'unknown' = 'unknown',
): DimensionProvenance {
  const chunkKey = (x: number, z: number): string => `${Math.floor(x / 16)},${Math.floor(z / 16)}`
  return {
    liveDimension: live,
    cellAttribution(x: number, z: number) {
      const chunk = { x: Math.floor(x / 16), y: 0, z: Math.floor(z / 16) }
      if (live.length === 0) {
        return { kind: 'unknown' as const, dimension: '', liveDimension: '', chunk, reason: 'unknown_live_dimension' as const }
      }
      const tagged = byChunk[chunkKey(x, z)] ?? (fallback === 'unknown' ? undefined : fallback)
      if (tagged === undefined) {
        return { kind: 'unknown' as const, dimension: '', liveDimension: live, chunk, reason: 'unknown_column' as const }
      }
      if (normalizeDimensionId(tagged) !== normalizeDimensionId(live)) {
        return { kind: 'foreign' as const, dimension: tagged, liveDimension: live, chunk, reason: 'foreign_column' as const }
      }
      return { kind: 'attributable' as const, dimension: tagged, liveDimension: live, chunk, reason: null }
    },
    refuseRead(input) {
      // The real sink caps per (source, reason, provenance). The double keeps ONE
      // record per key, which is the same shape and keeps a detail line readable.
      const key = `${input.source}|${input.reason}|${input.provenance}`
      if (refusals.some((record) => `${record.source}|${record.reason}|${record.provenance}` === key)) return false
      refusals.push({
        reason: input.reason,
        source: input.source,
        provenance: input.provenance,
        liveDimension: input.liveDimension,
        cell: input.cell,
      })
      return true
    },
  }
}

/** A bot double whose block store is deliberately dimension-blind, like Mineflayer's. */
function fakeBot(
  dimension: string,
  sensed: Record<string, Vec3Json[]>,
  position: Vec3Json = { x: 7, y: 59, z: 8 },
): Bot {
  const origin = new Vec3(position.x, position.y, position.z)
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
  return {
    username: 'AI_SDPROV',
    entity: { id: 1, position: origin, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension, minY: 0, height: 256 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => [{ name: 'iron_axe', count: 1, slot: 0 }] },
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

function perceive(
  bot: Bot,
  focusItem: string,
  provenance: DimensionProvenance | null,
  knownResources: KnownResource[] = [],
) {
  return buildWorldState(
    bot,
    {
      tick: 1,
      goal: makeGoal(focusItem, 1),
      goalQueue: emptyGoalQueueState(),
      focusItem,
      recentEvents: [],
      signals: signals({ knownResources }),
    },
    provenance === null ? defaultSensorOptions : { ...defaultSensorOptions, dimensionProvenance: provenance },
  )
}

// --- (i) a scan from a column whose provenance disagrees is refused ------------
// The measured shape: `jungle_log` readable at (8,85,6) while the live dimension is
// the Nether, because the column behind it was loaded in the Overworld.

addCase('(i) a foreign-column scan is refused (typed), never offered, never routed to', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  // chunk (0,0) and (2,0) both carry OVERWORLD data while the live dimension is the Nether
  const provenance = stubProvenance(NETHER, { '0,0': OVERWORLD, '2,0': OVERWORLD }, refusals)
  const bot = fakeBot(NETHER, { jungle_log: [CELL_A, CELL_B] })
  const state = perceive(bot, 'jungle_log', provenance)
  const logs = state.blocks.filter((block) => block.kind === 'log')
  const offered = JSON.stringify(logs)
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const routed = candidates.filter(
    (candidate) =>
      candidate.target !== null &&
      candidate.target.x === CELL_A.x &&
      candidate.target.y === CELL_A.y &&
      candidate.target.z === CELL_A.z,
  )
  const typed = refusals.filter((refusal) => refusal.reason === 'foreign_column')
  const pass =
    state.blocks.filter((block) => block.kind === 'log').length === 0 &&
    offered === '[]' &&
    routed.length === 0 &&
    typed.length >= 2 &&
    // the typed line names the cell, the read's provenance and the live dimension
    typed.every((refusal) => refusal.provenance === OVERWORLD && refusal.liveDimension === NETHER) &&
    typed.some((refusal) => refusal.cell.x === CELL_A.x && refusal.cell.y === CELL_A.y && refusal.cell.z === CELL_A.z) &&
    typed.some((refusal) => refusal.source.startsWith('logs:'))
  return {
    pass,
    detail: `offered=${offered} routed=${routed.length} foreignRefusals=${typed.length} sample=${typed.length === 0 ? 'none' : `${typed[0]?.source} ${typed[0]?.provenance}->${typed[0]?.liveDimension} cell=${typed[0]?.cell.x},${typed[0]?.cell.y},${typed[0]?.cell.z}`}`,
  }
})

addCase('(i) a refused cell never becomes durable memory (no CELL_A row for the live dimension)', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  const provenance = stubProvenance(NETHER, { '0,0': OVERWORLD }, refusals)
  const known: KnownResourceJson[] = []
  // Model the generation's own write path: the scan gate already dropped the cell,
  // and the writer re-checks provenance before it would stamp.
  const found: KnownResourceJson[] = []
  for (const cell of [CELL_A]) {
    if (writeRefusal(provenance, cell, 'known-resource-write') !== null) {
      provenance.refuseRead(writeRefusal(provenance, cell, 'known-resource-write')!)
      continue
    }
    found.push({ name: 'jungle_log', kind: 'log', x: cell.x, y: cell.y, z: cell.z, dimension: NETHER, worldEpoch: 1 })
  }
  mergeKnownResources(known, found, undefined, 1)
  const pass = found.length === 0 && known.length === 0 && refusals.some((r) => r.source === 'known-resource-write')
  return { pass, detail: `found=${found.length} durable=${known.length} writerRefusals=${refusals.filter((r) => r.source === 'known-resource-write').length}` }
})

// --- (ii) a legitimate same-dimension scan is byte-identical -------------------

addCase('(ii) an attributable same-dimension scan is byte-identical to the un-gated sensor', () => {
  const sensed = {
    jungle_log: [CELL_A, CELL_B],
    crafting_table: [{ x: 20, y: 59, z: 3 }],
    iron_ore: [{ x: 3, y: 40, z: -2 }],
  }
  const ungated = perceive(fakeBot(NETHER, sensed), 'jungle_log', null)
  const gatedBot = fakeBot(NETHER, sensed)
  const gated = perceive(
    gatedBot,
    'jungle_log',
    stubProvenance(NETHER, {}, [], NETHER),
  )
  // `timestampMs` and `goal.startedAtMs` are wall-clock stamps taken per call (by
  // design), so they are the only fields two builds cannot share; everything else
  // must be byte-identical.
  const strip = (value: unknown): string =>
    JSON.stringify(value, (key, item) => (key === 'timestampMs' || key === 'startedAtMs' ? 0 : item))
  const a = strip(ungated)
  const b = strip(gated)
  const pass = a === b && ungated.blocks.filter((block) => block.kind === 'log').length === 2
  return {
    pass,
    detail: `identical=${a === b} logs=${gated.blocks.filter((block) => block.kind === 'log').length} (len ${a.length} vs ${b.length})`,
  }
})

// --- (iii) a dimension transition leaves no stale column readable --------------

/** A bot double with the two things the tracker needs: events and an unload hook. */
function eventBot(options: { onUnload?: (key: string) => void; columns?: () => string[] } = {}): Bot {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const bot = {
    game: { dimension: 'overworld' },
    world: {
      unloadColumn: (x: number, z: number) => options.onUnload?.(`${x},${z}`),
      getColumns: () => (options.columns?.() ?? []).map((key) => ({ chunkX: Number(key.split(',')[0]), chunkZ: Number(key.split(',')[1]) })),
    },
    on: (event: string, fn: (...args: unknown[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
      return bot
    },
    off: () => bot,
    emit: (event: string, ...args: unknown[]) => {
      for (const fn of handlers.get(event) ?? []) fn(...args)
      return true
    },
  }
  return bot as unknown as Bot
}

addCase('(iii) a dimension transition drops every tag and unloads every known column', () => {
  const unloaded: string[] = []
  const tagged = new Set<string>(['0,0', '2,0'])
  const bot = eventBot({
    onUnload: (key) => {
      unloaded.push(key)
      tagged.delete(key)
    },
    columns: () => [...tagged],
  })
  attachDimensionProvenance(bot)
  tagged.add('0,0')
  tagged.add('2,0')
  const view: DimensionProvenanceView = createDimensionProvenanceView(bot, () => {}, 'run-test', 'generation-start')
  // The server loads two Overworld columns under the live Overworld dimension.
  tagged.add('0,0')
  tagged.add('2,0')
  // Feed the forwarded load events the way Mineflayer does.
  ;(bot as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit('chunkColumnLoad', new Vec3(0, 0, 0))
  ;(bot as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit('chunkColumnLoad', new Vec3(32, 0, 0))

  const before = view.cellAttribution(CELL_A.x, CELL_A.z)
  // The body transfers. `buildWorldState` calls this once per build.
  ;(bot as unknown as { game: { dimension: string } }).game.dimension = 'the_nether'
  unloaded.length = 0
  view.syncLiveDimension('sensor-build')
  const after = view.cellAttribution(CELL_A.x, CELL_A.z)

  // The Nether server has not re-sent chunk (0,0) yet: the cell must NOT be readable.
  const staleReadable = after.kind === 'attributable'
  const pass =
    before.kind === 'attributable' &&
    before.dimension === 'minecraft:overworld' &&
    after.kind !== 'attributable' &&
    after.liveDimension === 'minecraft:the_nether' &&
    !staleReadable &&
    view.stats().taggedColumns === 0
  return {
    pass,
    detail: `before=${before.kind}:${before.dimension} after=${after.kind}:${after.reason} unloaded=${JSON.stringify(unloaded)} tagged=${view.stats().taggedColumns}`,
  }
})

addCase('(iii) a column re-loaded under the new dimension is attributable again', () => {
  const bot = eventBot()
  attachDimensionProvenance(bot)
  const view = createDimensionProvenanceView(bot, () => {}, 'run-test', 'generation-start')
  ;(bot as unknown as { game: { dimension: string } }).game.dimension = 'the_nether'
  view.syncLiveDimension('sensor-build')
  const beforeLoad = view.cellAttribution(NETHER_FLOOR.x, NETHER_FLOOR.z)
  ;(bot as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit('chunkColumnLoad', new Vec3(0, 0, 0))
  const afterLoad = view.cellAttribution(NETHER_FLOOR.x, NETHER_FLOOR.z)
  const pass =
    beforeLoad.kind === 'unknown' &&
    beforeLoad.reason === 'unknown_column' &&
    afterLoad.kind === 'attributable' &&
    afterLoad.dimension === 'minecraft:the_nether'
  return { pass, detail: `beforeLoad=${beforeLoad.kind}:${beforeLoad.reason} afterLoad=${afterLoad.kind}:${afterLoad.dimension}` }
})

addCase('(iii) the same column written by a transfer is never readable, and the read is refused typed', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  // Provenance cannot be established for chunk (0,0) after the transfer.
  const provenance = stubProvenance(NETHER, {}, refusals)
  const bot = fakeBot(NETHER, { jungle_log: [CELL_A] })
  const state = perceive(bot, 'jungle_log', provenance)
  const pass =
    state.blocks.filter((block) => block.kind === 'log').length === 0 &&
    refusals.some((r) => r.reason === 'unknown_column' && r.liveDimension === NETHER) &&
    refusals.every((r) => r.provenance === '')
  return { pass, detail: `logs=${state.blocks.filter((block) => block.kind === 'log').length} reasons=[${[...new Set(refusals.map((r) => r.reason))].join(',')}] prov=[${[...new Set(refusals.map((r) => r.provenance))].join(',')}]` }
})

// --- (iv) the writer refuses a mismatch and still writes a match ---------------

addCase('(iv) the durable writer refuses a mismatched-provenance cell and writes a matching one', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  const provenance = stubProvenance(NETHER, { '0,0': OVERWORLD, '2,0': NETHER }, refusals)
  const mismatch = writeRefusal(provenance, CELL_A, 'known-resource-write')
  const match = writeRefusal(provenance, CELL_B, 'known-resource-write')
  const unknown = writeRefusal(stubProvenance(NETHER, {}), CELL_A, 'known-resource-write')

  const kept: KnownResourceJson[] = []
  const found: KnownResourceJson[] = []
  for (const cell of [CELL_A, CELL_B]) {
    if (writeRefusal(provenance, cell, 'known-resource-write') !== null) continue
    found.push({ name: 'jungle_log', kind: 'log', x: cell.x, y: cell.y, z: cell.z, dimension: NETHER, worldEpoch: 1 })
  }
  mergeKnownResources(kept, found, undefined, 1)
  const pass =
    mismatch !== null &&
    mismatch.reason === 'foreign_column' &&
    mismatch.provenance === OVERWORLD &&
    mismatch.liveDimension === NETHER &&
    mismatch.cell.x === CELL_A.x &&
    mismatch.cell.y === CELL_A.y &&
    mismatch.cell.z === CELL_A.z &&
    match === null &&
    unknown !== null &&
    unknown.reason === 'unknown_column' &&
    kept.length === 1 &&
    kept[0]?.x === CELL_B.x &&
    kept[0]?.dimension === NETHER
  return {
    pass,
    detail: `mismatch=${mismatch?.reason ?? 'none'} match=${match === null ? 'written' : 'refused'} unknown=${unknown?.reason ?? 'none'} durable=${JSON.stringify(kept)}`,
  }
})

addCase('(iv) the staleness probe cannot re-confirm a foreign cell (it stays unknown, never present)', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  const provenance = stubProvenance(NETHER, { '0,0': OVERWORLD }, refusals)
  // Inside KNOWN_RESOURCE_STALENESS_RADIUS (24) of the body at (7,59,8), i.e. the
  // one band where the probe actually reads the cell (distance 16.2).
  const known: KnownResourceJson[] = [
    { name: 'jungle_log', kind: 'log', x: 8, y: 75, z: 6, dimension: NETHER, worldEpoch: 1 },
  ]
  const bot = fakeBot(NETHER, { jungle_log: [{ x: 8, y: 75, z: 6 }] })
  const evicted = evictStaleKnownResources(
    bot,
    known,
    { dimension: NETHER, worldEpoch: 1 },
    () => {},
    provenance,
  )
  const pass =
    evicted.length === 0 &&
    known.length === 1 &&
    known[0]?.lastSeenAt === undefined &&
    refusals.some((r) => r.source === 'known-resource-staleness' && r.reason === 'foreign_column')
  return { pass, detail: `evicted=${evicted.length} lastSeenAt=${String(known[0]?.lastSeenAt)} refusals=${refusals.length}` }
})

// --- (v) unknown provenance is not treated as valid ---------------------------

addCase('(v) an unknown-provenance read is refused, not assumed valid', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  const provenance = stubProvenance(NETHER, {}, refusals)
  const bot = fakeBot(NETHER, { jungle_log: [CELL_A] })
  const state = perceive(bot, 'jungle_log', provenance)
  const pass =
    state.blocks.filter((block) => block.kind === 'log').length === 0 &&
    refusals.length > 0 &&
    refusals.every((r) => r.reason === 'unknown_column') &&
    provenance.cellAttribution(CELL_A.x, CELL_A.z).kind === 'unknown'
  return { pass, detail: `logs=${state.blocks.filter((block) => block.kind === 'log').length} n=${refusals.length} reasons=[${[...new Set(refusals.map((r) => r.reason))].join(',')}]` }
})

addCase('(v) an unknown LIVE dimension refuses every read', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  const provenance = stubProvenance('', { '0,0': NETHER }, refusals)
  const bot = fakeBot(NETHER, { jungle_log: [CELL_A] })
  const state = perceive(bot, 'jungle_log', provenance)
  const pass =
    state.blocks.filter((block) => block.kind === 'log').length === 0 &&
    refusals.length > 0 &&
    refusals.every((r) => r.reason === 'unknown_live_dimension')
  return { pass, detail: `logs=${state.blocks.filter((block) => block.kind === 'log').length} reasons=${refusals.map((r) => r.reason).join(',')}` }
})

addCase('(v) unknown provenance is NOT absence: a remembered cell stays unknown, never falsified', () => {
  const refusals: Parameters<typeof stubProvenance>[2] = []
  const provenance = stubProvenance(NETHER, {}, refusals)
  const known: KnownResource[] = [{ name: 'iron_ore', kind: 'ore', position: { x: CELL_A.x, y: CELL_A.y, z: CELL_A.z } }]
  const bot = fakeBot(NETHER, { iron_ore: [CELL_A] })
  const state = perceive(bot, 'raw_iron', provenance, known)
  const verdicts = state.knownResourceEvidence ?? []
  const pass =
    verdicts.length === 1 &&
    verdicts[0]?.status === 'unknown' &&
    verdicts.every((verdict) => verdict.status !== 'falsified') &&
    // and the cell was NOT removed from the signals the candidate layer sees
    (state.signals.knownResources ?? []).length === 1
  return { pass, detail: `status=${verdicts[0]?.status} observed=${JSON.stringify(verdicts[0]?.observed)}` }
})

// --- the gate is opt-in: no provenance means the old sensor path exactly -------

addCase('absent provenance leaves the un-gated sensor path exactly (fixtures/replays unchanged)', () => {
  const sensed = { jungle_log: [CELL_A], crafting_table: [{ x: 20, y: 59, z: 3 }] }
  const bot = fakeBot(NETHER, sensed)
  const state = perceive(bot, 'jungle_log', null)
  const pass = state.blocks.filter((block) => block.kind === 'log').length === 1 && state.blocks.find((block) => block.kind === 'log')?.position.y === CELL_A.y
  return { pass, detail: `logs=${JSON.stringify(state.blocks.filter((b) => b.kind === 'log').map((b) => b.position))}` }
})

let failures = 0
process.stdout.write('sensor dimension provenance: a block read is attributable to its dimension\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} dimension-provenance cases passed\n`)
if (failures > 0) process.exit(1)
