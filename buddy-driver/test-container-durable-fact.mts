// test-container-durable-fact.mts - the host half of the container capability.
//
// A verified container placement must become a DURABLE WORLD FACT: the block is
// in the world now, so re-visiting the cell must OPEN it instead of re-planning
// a placement of an item the body no longer holds. The executor emits
// `CONTAINER_READY source=placed block=<name> at=x,y,z` (registered in
// `MIRRORED_MARKERS`), the mirroring sink hands the structured detail to the
// host, and `containerReadyKnownResource` turns it into the SAME generic
// `kind: 'station'` known-resource record every other station uses - no new
// memory schema, because the sensor already merges those into
// `WorldState.containers` as `remembered` entries.
//
// This suite locks the mapping, its idempotence, and the re-visit consequence:
//   (1) the detail the executor actually logs maps to the exact durable record;
//   (2) the `"x,y,z"` text form (the mirrored line spelling) maps identically;
//   (3) a non-container block / a detail with no cell records nothing;
//   (4) recording is idempotent (one cell is one record);
//   (5) the remembered cell re-appears as a `remembered` container and yields an
//       OPEN offer - with no PLACE candidate for the consumed item.
//
// Run: bun test-container-durable-fact.mts
import { createRequire } from 'node:module'
import { containerReadyKnownResource, mergeKnownResources } from './generation-entry.ts'
import type { KnownResourceJson, WorldKey } from './resident-types.ts'
import { emptyWorldMemory, normalizeWorldMemory } from './resident-types.ts'
import { defaultCandidateOptions, generateCandidates } from '../jev-agent/src/candidates.ts'
import { buildWorldState, defaultSensorOptions } from '../jev-agent/src/state.ts'
import { emptyGoalQueueState } from '../jev-agent/src/goalQueue.ts'
import type { AgentSignals, GoalState, StationEntry, Vec3Json, WorldState } from '../jev-agent/src/state.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const WORLD_KEY: WorldKey = { serverId: 'local', dimension: 'overworld', worldEpoch: 7 }

/** The exact `detail` object the executor logs with the CONTAINER_READY line. */
const EXECUTOR_DETAIL: Record<string, unknown> = {
  source: 'placed',
  block: 'shulker_box',
  at: '3,64,0',
  target: { x: 3, y: 64, z: 0 },
  actionId: 'PLACE:shulker_box:p3_64_0',
}

addCase('(1) the executor detail maps to the exact durable container record', () => {
  const known = containerReadyKnownResource(EXECUTOR_DETAIL, WORLD_KEY)
  const pass =
    known !== null &&
    known.name === 'shulker_box' &&
    known.kind === 'station' &&
    known.x === 3 &&
    known.y === 64 &&
    known.z === 0 &&
    known.dimension === 'overworld' &&
    known.worldEpoch === 7 &&
    typeof known.lastSeenAt === 'number'
  return { pass, detail: JSON.stringify(known) }
})

addCase('(2) the mirrored "x,y,z" text form maps identically (a detail without a target object)', () => {
  const textOnly = { source: 'placed', block: 'chest', at: '-8,71,12' }
  const known = containerReadyKnownResource(textOnly, WORLD_KEY)
  const objectForm = containerReadyKnownResource({ block: 'chest', target: { x: -8, y: 71, z: 12 } }, WORLD_KEY)
  const pass =
    known !== null &&
    known.name === 'chest' &&
    known.x === -8 &&
    known.y === 71 &&
    known.z === 12 &&
    objectForm !== null &&
    objectForm.name === known.name &&
    objectForm.x === known.x &&
    objectForm.y === known.y &&
    objectForm.z === known.z
  return { pass, detail: `text=${JSON.stringify(known)} object=${JSON.stringify(objectForm)}` }
})

addCase('(3) a non-container block or a missing cell records NOTHING (never a fabricated fact)', () => {
  const furnace = containerReadyKnownResource({ block: 'furnace', target: { x: 1, y: 2, z: 3 } }, WORLD_KEY)
  const noCell = containerReadyKnownResource({ block: 'shulker_box' }, WORLD_KEY)
  const badCell = containerReadyKnownResource({ block: 'shulker_box', at: '1,2' }, WORLD_KEY)
  const noBlock = containerReadyKnownResource({ at: '1,2,3' }, WORLD_KEY)
  const namespaced = containerReadyKnownResource({ block: 'minecraft:barrel', at: '1,2,3' }, WORLD_KEY)
  const pass = furnace === null && noCell === null && badCell === null && noBlock === null && namespaced?.name === 'barrel'
  return { pass, detail: `furnace=${furnace === null} noCell=${noCell === null} badCell=${badCell === null} noBlock=${noBlock === null} namespaced=${namespaced?.name ?? 'null'}` }
})

addCase('(4) recording one placed container is idempotent: one cell is one durable record', () => {
  const memory = normalizeWorldMemory(emptyWorldMemory())
  const known = containerReadyKnownResource(EXECUTOR_DETAIL, WORLD_KEY) as KnownResourceJson
  const first = mergeKnownResources(memory.knownResources, [known])
  const second = mergeKnownResources(memory.knownResources, [{ ...known, lastSeenAt: (known.lastSeenAt ?? 0) + 1000 }])
  const atCell = memory.knownResources.filter((entry) => entry.name === 'shulker_box' && entry.x === 3 && entry.y === 64 && entry.z === 0)
  const pass = first === 1 && second === 0 && memory.knownResources.length === 1 && atCell.length === 1
  return { pass, detail: `first=${first} second=${second} stored=${memory.knownResources.length} atCell=${atCell.length}` }
})

// ---------------------------------------------------------------------------
// the re-visit consequence
// ---------------------------------------------------------------------------

function signals(): AgentSignals {
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
  }
}

function goalFor(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

/** A live-sensor double that sees the block the placement created. */
function sensorBot(blocks: Record<string, string>): Parameters<typeof buildWorldState>[0] {
  const position = new Vec3(0.5, 64, 0.5)
  const cells = new Map<string, string>(Object.entries(blocks))
  const findBlocks = (options: { matching: (block: { name: string }) => boolean; maxDistance: number; count: number }): unknown[] => {
    const origin = new Vec3(0, 64, 0)
    const out: unknown[] = []
    for (const [key, name] of cells) {
      if (!options.matching({ name })) continue
      const [x, y, z] = key.split(',').map((entry) => Number(entry))
      const block = new Vec3(x, y, z)
      if (block.distanceTo(origin) <= options.maxDistance) out.push(block)
    }
    return out.slice(0, options.count)
  }
  const blockAt = (point: { x: number; y: number; z: number }): unknown => {
    const name = cells.get(`${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`)
    if (name === undefined) return null
    return { name, position: new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)), boundingBox: 'block', diggable: true }
  }
  return {
    username: 'AI_CONTAINER_DURABLE',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry: null,
    entities: {},
    inventory: { items: () => [] },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
  } as never
}

function candidateIds(candidates: readonly { id: string }[]): string {
  return candidates.map((candidate) => candidate.id).join(' | ') || 'none'
}

addCase('(5) the remembered cell re-appears and yields an OPEN offer, and no PLACE for the consumed item', () => {
  const known = containerReadyKnownResource(EXECUTOR_DETAIL, WORLD_KEY) as KnownResourceJson
  const state = buildWorldState(
    sensorBot({ '3,64,0': 'shulker_box' }),
    {
      tick: 5,
      goal: goalFor('golden_apple'),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'golden_apple',
      recentEvents: [],
      signals: signals(),
      rememberedStations: [{ name: known.name, kind: 'station', position: { x: known.x, y: known.y, z: known.z } }],
    },
    defaultSensorOptions,
  )
  const remembered: StationEntry | undefined = state.containers?.find((entry) => entry.x === 3 && entry.y === 64 && entry.z === 0)
  const containers = generateCandidates(state, defaultCandidateOptions).filter((candidate) => candidate.kind === 'CONTAINER')
  const opens = containers.filter((candidate) => candidate.meta.containerAction === 'open')
  // The body no longer holds a shulker box (it was placed), so a `place` goal for
  // it cannot re-plan: the placement is spent and the cell holds the block.
  const placeState: WorldState = { ...state, goal: goalFor('shulker_box'), goalQueue: emptyGoalQueueState() }
  const places = generateCandidates(placeState, defaultCandidateOptions).filter((candidate) => candidate.kind === 'PLACE')
  const pass =
    remembered?.source === 'sensed' &&
    remembered?.name === 'shulker_box' &&
    opens.length === 1 &&
    opens[0]?.meta.containerRef === 'shulker_box@3,64,0' &&
    places.length === 0
  return {
    pass,
    detail: `container=${JSON.stringify(remembered)} containerCandidates=[${candidateIds(containers)}] placeCandidates=[${candidateIds(places)}]`,
  }
})

addCase('(6) a remembered container OUTSIDE the sensor scan still offers OPEN on re-visit (the durable fact alone)', () => {
  const known = containerReadyKnownResource(EXECUTOR_DETAIL, WORLD_KEY) as KnownResourceJson
  // The body comes back with the cell out of scan range: nothing is sensed, so
  // the durable record is the ONLY thing that knows the box is there.
  const state = buildWorldState(
    sensorBot({}),
    {
      tick: 9,
      goal: goalFor('golden_apple'),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'golden_apple',
      recentEvents: [],
      signals: signals(),
      rememberedStations: [{ name: known.name, kind: 'station', position: { x: known.x, y: known.y, z: known.z } }],
    },
    defaultSensorOptions,
  )
  const remembered: StationEntry | undefined = state.containers?.find((entry) => entry.x === 3 && entry.y === 64 && entry.z === 0)
  const opens = generateCandidates(state, defaultCandidateOptions).filter(
    (candidate) => candidate.kind === 'CONTAINER' && candidate.meta.containerAction === 'open',
  )
  const pass =
    remembered?.source === 'remembered' &&
    remembered?.name === 'shulker_box' &&
    opens.length === 1 &&
    opens[0]?.meta.containerRef === 'shulker_box@3,64,0'
  return { pass, detail: `container=${JSON.stringify(remembered)} opens=[${candidateIds(opens)}]` }
})

let failures = 0
process.stdout.write('CONTAINER durable world fact: a verified placement is remembered, a re-visit opens\n')
process.stdout.write('-'.repeat(76) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(76) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} container-durable-fact cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
