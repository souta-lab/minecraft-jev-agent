// test-local-oscillation-durable.mts - the class-A half of the local-motion record.
//
// The controller-scoped counters that watch a stall are erased by a generation
// change (a new `JevController` per generation), which is one of the measured
// reasons the Nether portal loop survived: the body kept returning to the same
// 2-3 cells while every counter that could have noticed started over. The record
// this file covers is the one that does NOT start over.
//
// It pins, offline and with the REAL host functions (no bot, no network):
//   1. write -> snapshot -> restore keeps the record under the same world key;
//   2. the canonical merge REPLACES it and `null` clears it (the runtime
//      `ctx.proposeWorldMemory` path and the staged commit path are the same
//      implementation);
//   3. legacy/partial JSON without the field still parses (`normalizeWorldMemory`);
//   4. a different world key does not inherit the record (no cross-world reuse),
//      and a stale-key staged proposal is rejected wholesale;
//   5. the generation SEED whitelist (`cloneMemory` in `agent-runner.mts`) carries
//      the field - the #80 omission class this clone exists to prevent;
//   6. end to end: the boundary trips at the SAME return count after a simulated
//      generation change, where a generation-scoped counter would restart.
//
//   bun ./test-local-oscillation-durable.mts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT,
  localOscillationCell,
  observeLocalOscillation,
  restoreLocalOscillationRecord,
} from '../jev-agent/src/localOscillation.ts'
import type { LocalOscillationRecordJson } from '../jev-agent/src/localOscillation.ts'
import { emptyWorldMemory, normalizeWorldMemory, worldKeyString } from './resident-types.ts'
import type { AgentSnapshot, ResidentWorldMemory, WorldKey, WorldMemoryDelta } from './resident-types.ts'
import { emptyAgentSnapshot, restoreAgentSnapshot } from './state-snapshot.ts'
import { durableWriteLanded } from './host-durability.ts'
import {
  commitPendingProposals,
  mergeWorldMemoryDelta,
  newPendingProposals,
  stageWorldMemory,
  writeSnapshotAtomic,
} from './proposal-staging.ts'
import { acceptsWorldMemoryProposal } from './world-epoch.ts'

let failures = 0
let cases = 0
const check = (name: string, run: () => boolean, detail: () => string): void => {
  cases += 1
  let pass = false
  let info = ''
  try {
    pass = run()
    info = detail()
  } catch (error) {
    info = `threw ${String(error)}`
  }
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${info}\n`)
}

const SERVER = '127.0.0.1:25565'
const EPOCH = 4
const NETHER: WorldKey = { serverId: SERVER, dimension: 'minecraft:the_nether', worldEpoch: EPOCH }
const OVERWORLD: WorldKey = { serverId: SERVER, dimension: 'minecraft:overworld', worldEpoch: EPOCH }
const NETHER_KEY = worldKeyString(NETHER)

const DIMENSION = 'minecraft:the_nether'
const GOAL = 'descend:raw_iron:1'
const BODY_CELL = localOscillationCell(DIMENSION, { x: 24.6, y: 53, z: -10.1 })
const ATTEMPT_CELLS = [
  { x: 25, y: 54, z: -9 },
  { x: 24, y: 53, z: -9 },
  { x: 25, y: 54, z: -10 },
].map((position) => localOscillationCell(DIMENSION, position))

/** A record shaped exactly like the measured live episode, ready to persist. */
function measuredRecord(returns: number): LocalOscillationRecordJson {
  return {
    dimension: DIMENSION,
    cells: [ATTEMPT_CELLS[0] as string, ATTEMPT_CELLS[1] as string, ATTEMPT_CELLS[2] as string, BODY_CELL],
    firstSeenAt: 1_000,
    lastSeenAt: 1_000 + returns * 1_350,
    decisions: returns + 4,
    returns,
    escapes: 0,
    cellChanges: 0,
    trips: 0,
    goal: GOAL,
  }
}

function snapshotWith(worldMemoryByKey: Record<string, ResidentWorldMemory>, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  const snapshot = emptyAgentSnapshot({ bot: 'AI_OSC', serverId: SERVER, ...overrides })
  snapshot.worldMemoryByKey = worldMemoryByKey
  return snapshot
}

const quiet = (): void => undefined

// ---------------------------------------------------------------------------
// 1. the class-A round trip
// ---------------------------------------------------------------------------
check(
  '1. the record survives write -> snapshot -> restore under the same world key',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'oscillation-durable-'))
    const path = join(dir, 'buddy-state.json')
    try {
      const memory = emptyWorldMemory()
      memory.localOscillation = measuredRecord(6)
      writeSnapshotAtomic(path, snapshotWith({ [NETHER_KEY]: memory }, { worldEpoch: EPOCH, dimension: 'minecraft:the_nether' }))
      const restored = restoreAgentSnapshot(
        JSON.parse(readFileSync(path, 'utf8')),
        emptyAgentSnapshot({ bot: 'AI_OSC', serverId: SERVER }),
        quiet,
      )
      const record = restored.worldMemoryByKey[NETHER_KEY]?.localOscillation
      return (
        restored.worldEpoch === EPOCH &&
        record !== null &&
        record !== undefined &&
        record.returns === 6 &&
        record.cells.length === 4 &&
        record.goal === GOAL &&
        record.dimension === DIMENSION
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'oscillation-durable-'))
    const path = join(dir, 'buddy-state.json')
    try {
      const memory = emptyWorldMemory()
      memory.localOscillation = measuredRecord(6)
      writeSnapshotAtomic(path, snapshotWith({ [NETHER_KEY]: memory }, { worldEpoch: EPOCH }))
      const restored = restoreAgentSnapshot(JSON.parse(readFileSync(path, 'utf8')), emptyAgentSnapshot({ bot: 'AI_OSC', serverId: SERVER }), quiet)
      return JSON.stringify(restored.worldMemoryByKey[NETHER_KEY]?.localOscillation ?? null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// ---------------------------------------------------------------------------
// 2. the canonical merge (the runtime proposeWorldMemory path)
// ---------------------------------------------------------------------------
check(
  '2. mergeWorldMemoryDelta replaces the record, and `null` clears it',
  () => {
    const memory = emptyWorldMemory()
    mergeWorldMemoryDelta(memory, { localOscillation: measuredRecord(3) } as WorldMemoryDelta, quiet)
    const first = memory.localOscillation
    mergeWorldMemoryDelta(memory, { localOscillation: measuredRecord(11) } as WorldMemoryDelta, quiet)
    const second = memory.localOscillation
    mergeWorldMemoryDelta(memory, { localOscillation: null } as WorldMemoryDelta, quiet)
    const cleared = memory.localOscillation
    return (
      first?.returns === 3 &&
      second?.returns === 11 &&
      second.cells.length === 4 &&
      cleared === null &&
      // the durable copy is not the generation's own object
      second !== first
    )
  },
  () => JSON.stringify({ after: 3, second: 11, cleared: null }),
)

check(
  '2. a delta without the field leaves the record untouched (additive/optional)',
  () => {
    const memory = emptyWorldMemory()
    memory.localOscillation = measuredRecord(5)
    mergeWorldMemoryDelta(memory, { discoveredOres: ['iron_ore'] } as WorldMemoryDelta, quiet)
    return memory.localOscillation?.returns === 5
  },
  () => 'an unrelated delta does not clear the record',
)

// ---------------------------------------------------------------------------
// 3. legacy / partial durable JSON
// ---------------------------------------------------------------------------
check(
  '3. normalizeWorldMemory defaults a missing record to null and keeps a present one',
  () => {
    const legacy = emptyWorldMemory() as ResidentWorldMemory
    delete (legacy as { localOscillation?: unknown }).localOscillation
    normalizeWorldMemory(legacy)
    const modern = emptyWorldMemory()
    modern.localOscillation = measuredRecord(2)
    normalizeWorldMemory(modern)
    return legacy.localOscillation === null && modern.localOscillation?.returns === 2
  },
  () => 'missing -> null, present -> untouched',
)

check(
  '3. a restored record is re-validated by the generation (garbage never reaches the tracker)',
  () => {
    const garbage = restoreLocalOscillationRecord({ dimension: DIMENSION, cells: 'nope' })
    const usable = restoreLocalOscillationRecord(measuredRecord(4))
    return garbage === null && usable?.returns === 4
  },
  () => JSON.stringify({ garbage: restoreLocalOscillationRecord({ dimension: DIMENSION, cells: 'nope' }), usable: true }),
)

// ---------------------------------------------------------------------------
// 4. no cross-world reuse
// ---------------------------------------------------------------------------
check(
  '4. the record is world-keyed: another dimension/epoch does not inherit it',
  () => {
    const memory = emptyWorldMemory()
    memory.localOscillation = measuredRecord(7)
    const sameWorld = acceptsWorldMemoryProposal(NETHER, NETHER)
    const otherDimension = acceptsWorldMemoryProposal(NETHER, OVERWORLD)
    const otherEpoch = acceptsWorldMemoryProposal(NETHER, { ...NETHER, worldEpoch: EPOCH + 1 })
    return sameWorld && !otherDimension && !otherEpoch && worldKeyString(OVERWORLD) !== NETHER_KEY
  },
  () => JSON.stringify({ same: acceptsWorldMemoryProposal(NETHER, NETHER), otherDimension: acceptsWorldMemoryProposal(NETHER, OVERWORLD), otherEpoch: acceptsWorldMemoryProposal(NETHER, { ...NETHER, worldEpoch: EPOCH + 1 }) }),
)

check(
  '4. a stale-world-key staged proposal is rejected wholesale (the record cannot cross a world)',
  () => {
    const memory = emptyWorldMemory()
    const pending = newPendingProposals()
    pending.generationId = 'gen-1'
    pending.worldKey = NETHER
    stageWorldMemory(pending, { localOscillation: measuredRecord(9) } as WorldMemoryDelta)
    const events: string[] = []
    const result = commitPendingProposals(
      {
        pending,
        memory,
        state: snapshotWith({ [worldKeyString(OVERWORLD)]: memory }, { worldEpoch: EPOCH }),
        guard: { revision: 5, committedGenerationId: 'gen-1', activeGenerationId: 'gen-1' },
        log: (event) => events.push(event),
        save: () => durableWriteLanded('generation-start', 6),
        worldKey: OVERWORLD,
      },
      'generation-start',
    )
    return result.worldMemoryDeltasApplied === 0 && memory.localOscillation === null && events.includes('WORLDMEMORY_REJECTED')
  },
  () => 'world-key mismatch rejects the delta',
)

// ---------------------------------------------------------------------------
// 5. the generation seed whitelist
// ---------------------------------------------------------------------------
check(
  '5. the generation seed (cloneMemory in agent-runner.mts) carries localOscillation',
  () => {
    // `agent-runner.mts` is the HOST entry: a side-effecting top-level script that
    // cannot be imported by a test. This is the strongest available check, and it
    // guards exactly the #80 omission class the clone exists to prevent.
    const source = readFileSync(new URL('./agent-runner.mts', import.meta.url), 'utf8')
    const clone = /function cloneMemory\([\s\S]*?\n}/.exec(source)?.[0] ?? ''
    return clone.length > 0 && /localOscillation\s*:/.test(clone)
  },
  () => 'cloneMemory copies localOscillation',
)

// ---------------------------------------------------------------------------
// 6. end to end: the boundary trips at the same return count after a reload
// ---------------------------------------------------------------------------
const SHAPE: Array<number | null> = [0, null, 1, 2, 0, null]

interface TickResult {
  record: LocalOscillationRecordJson | null
  trip: boolean
  persisted: Array<LocalOscillationRecordJson | null>
}

/**
 * Drive the measured loop for `count` decisions. `handoff` is invoked at decision
 * `at` with whatever a generation would have persisted, and returns the record
 * the NEXT generation starts from: `null` for a controller-scoped counter, the
 * durable JSON for this record.
 */
function drive(
  count: number,
  at: number,
  handoff: (persisted: LocalOscillationRecordJson | null) => LocalOscillationRecordJson | null,
): { trips: number[]; tripIndexes: number[]; persisted: Array<LocalOscillationRecordJson | null>; last: LocalOscillationRecordJson | null } {
  let record: LocalOscillationRecordJson | null = null
  let durable: LocalOscillationRecordJson | null = null
  const trips: number[] = []
  const tripIndexes: number[] = []
  const persisted: Array<LocalOscillationRecordJson | null> = []
  for (let index = 0; index < count; index += 1) {
    if (index === at) record = handoff(durable)
    const slot = SHAPE[index % SHAPE.length] ?? null
    const decision = observeLocalOscillation(record, {
      bodyCell: BODY_CELL,
      attemptCell: slot === null ? null : (ATTEMPT_CELLS[slot] as string),
      dimension: DIMENSION,
      goal: GOAL,
      cellChanged: false,
      semanticProgress: false,
      inventoryChanged: false,
      distanceClosed: false,
      now: 1_000 + index * 1_350,
    })
    record = decision.record
    if (decision.exhausted) {
      trips.push(decision.record?.returns ?? 0)
      tripIndexes.push(index)
    }
    durable = decision.record === null ? null : (JSON.parse(JSON.stringify(decision.record)) as LocalOscillationRecordJson)
    persisted.push(durable)
  }
  return { trips, tripIndexes, persisted, last: record }
}

check(
  '6. a generation change at decision 6 keeps the trip at the SAME decision and return count',
  () => {
    const uninterrupted = drive(40, -1, () => null)
    const reloaded = drive(40, 6, (persisted) => restoreLocalOscillationRecord(persisted))
    return (
      uninterrupted.trips.length >= 1 &&
      reloaded.trips.length >= 1 &&
      reloaded.tripIndexes[0] === uninterrupted.tripIndexes[0] &&
      reloaded.trips[0] === uninterrupted.trips[0] &&
      reloaded.trips[0] === LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT
    )
  },
  () => JSON.stringify({ uninterrupted: drive(40, -1, () => null).tripIndexes, reloaded: drive(40, 6, (persisted) => restoreLocalOscillationRecord(persisted)).tripIndexes }),
)

check(
  '6. CONTRAST: the same reload with a controller-scoped counter restarts and trips LATER',
  () => {
    const durable = drive(40, 6, (persisted) => restoreLocalOscillationRecord(persisted))
    const scoped = drive(40, 6, () => null)
    return (
      durable.tripIndexes.length >= 1 &&
      scoped.tripIndexes.length >= 1 &&
      (scoped.tripIndexes[0] as number) > (durable.tripIndexes[0] as number)
    )
  },
  () => {
    const durable = drive(40, 6, (persisted) => restoreLocalOscillationRecord(persisted))
    const scoped = drive(40, 6, () => null)
    return JSON.stringify({ durableFirstTrip: durable.tripIndexes[0] ?? -1, scopedFirstTrip: scoped.tripIndexes[0] ?? -1 })
  },
)

check(
  '6. the durable record handed across the change is the measured episode (cells, span, goal)',
  () => {
    const reloaded = drive(20, 6, (persisted) => restoreLocalOscillationRecord(persisted))
    const record = restoreLocalOscillationRecord(reloaded.persisted[5] ?? null)
    return record !== null && record.cells.length === 4 && record.goal === GOAL && record.returns > 0
  },
  () => JSON.stringify(restoreLocalOscillationRecord(drive(20, 6, (persisted) => restoreLocalOscillationRecord(persisted)).persisted[5] ?? null)),
)

process.stdout.write(`${'-'.repeat(72)}\n${cases - failures}/${cases} local-oscillation durable cases passed\n`)
if (failures > 0) process.exit(1)
