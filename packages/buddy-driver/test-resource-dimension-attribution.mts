// test-resource-dimension-attribution.mts - issue #14: a remembered cell's
// dimension is part of its identity, and "I do not know" is not a licence to
// walk to it.
//
// THE MEASURED DEFECT (live, run `run-mucqgrdo-21plr`, main 5397bd8): the body
// stood in the NETHER and the offer carried
//
//   RETRIEVE:known:log:b8_85_6 ... reachable=false reason=needs_ascend
//
// A `jungle_log` at y=85 is a TREE; trees do not generate in the Nether. The
// predicate that was supposed to keep another world's cell out of the offer was
// permissive by construction:
//
//   resourceDimensionMatches: `dimension === undefined -> return true`
//
// i.e. a row whose world was never recorded matched EVERY world - the repo's
// forbidden shape (unknown read as satisfied) one level below the goal layer.
//
// THE RULE (chosen from measurement, not from the shape of the bug):
//
//   * a durable row's OWN `dimension` field is the only attribution evidence;
//     it is never defaulted from the `worldMemoryByKey` bucket it was stored
//     under (that bucket has been measured to hold wrong-world cells: the live
//     nether bucket holds 7 `jungle_log` cells at y=81..114);
//   * a row that records no dimension is UN-ATTRIBUTABLE: it is refused as a
//     locomotion target in EVERY world (fail closed), kept in durable memory
//     (never deleted), reported typed, and healed by the next observation;
//   * every write path stamps the world it observed the cell in.
//
// WHY NOT "unstamped means overworld": the live durable state contains 712
// known-resource rows across 4 world buckets and 0 of them are unstamped, so
// there is no legacy corpus to migrate; and `KnownStation` has no dimension
// field at all, so the LIVE nether bucket holds a station
// (`crafting_table` at 20,59,3) that is a Nether record with no dimension.
// Calling unstamped "overworld" would refuse the body's only Nether crafting
// table while in the Nether and offer it while in the overworld.
//
// Fixtures:
//   (i)   the measured shape: an un-attributed log cell while the body is in the
//         Nether -> NOT offered, with a typed reason naming the cell, the
//         recorded dimension (absent) and the live dimension; and the SAME cell,
//         once a write path stamps the world it was observed in, offered
//         normally in the overworld;
//   (ii)  a stamped overworld cell in the overworld -> unchanged;
//   (iii) a stamped nether cell in the nether -> unchanged;
//   (iv)  every writer stamps the dimension (source assertion + direct calls);
//   (v)   the durable round-trip preserves the dimension.
//
// Run: bun test-resource-dimension-attribution.mts
import { defaultCandidateOptions, generateGroundedCandidates } from '../jev-agent/src/candidates.ts'
import type { Candidate, CandidateOptions } from '../jev-agent/src/candidates.ts'
import { registerPlacedStation } from '../jev-agent/src/controller.ts'
import type { GoalQueueState } from '../jev-agent/src/goalQueue.ts'
import type { AgentSignals, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import {
  containerReadyKnownResource,
  evictStaleKnownResources,
  knownResourceFalsifiedRemovals,
  mergeKnownResources,
  portalSiteKnownResources,
  structureSiteKnownResources,
} from './generation-entry.ts'
import { emptyWorldMemory, mergeKnownResourcesInto } from './resident-types.ts'
import { mergeKnownResourceDtos } from './proposal-staging.ts'
import type { KnownPortalSiteJson, KnownResourceJson, KnownStructureSiteJson } from './resident-types.ts'
import { emptyAgentSnapshot, restoreAgentSnapshot } from './state-snapshot.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const OVERWORLD = 'minecraft:overworld'
const NETHER = 'minecraft:the_nether'
const WORLD_KEY = `127.0.0.1:25565|${OVERWORLD}|1`
/** The measured cell: `RETRIEVE:known:log:b8_85_6` in run-mucqgrdo-21plr. */
const MEASURED_CELL: Vec3Json = { x: 8, y: 85, z: 6 }
const cellToken = (position: Vec3Json): string => `b${position.x}_${position.y}_${position.z}`

function self(dimension: string, position: Vec3Json = { x: 20, y: 51, z: -6 }): SelfState {
  return {
    username: 'AI_ATTR',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension,
    isDay: true,
    heldItem: null,
  }
}

function inventory(): InventoryState {
  return { slots: [], counts: {}, totalItems: 0 }
}

function signals(knownResources: KnownResource[]): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources,
  }
}

/**
 * The `collect:<item>` option the live run carried when it offered the marker
 * (`g2:collect:log`) or the ordinary `collect:obsidian` shape.
 */
function collectGoalQueue(item: string): GoalQueueState {
  const current = {
    id: `g2:collect:${item}`,
    kind: 'collect' as const,
    description: `collect ${item}`,
    targetItem: item,
    requiredCount: 1,
    targetPredicate: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    status: 'active' as const,
    origin: 'mechanical' as const,
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

/** The measured shape: the body in one world, its remembered cells. */
function worldState(dimension: string, knownResources: KnownResource[], item = 'log'): WorldState {
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(dimension),
    inventory: inventory(),
    entities: [],
    blocks: [],
    terrain: { standable: [] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: `g2:collect:${item}`,
      description: `collect ${item}`,
      targetItem: item,
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: collectGoalQueue(item),
    recentEvents: [],
    signals: signals(knownResources),
  }
}

/** Every host path leg is reachable, so the ONLY refusal under test is the dimension gate. */
const reachableOptions: CandidateOptions = {
  ...defaultCandidateOptions,
  reachability: { memory: null, pathProbe: () => 'reachable' as const },
}

function offered(
  state: WorldState,
  item = 'log',
): { ids: string[]; offered: string[]; retrieve: string | undefined; exclusions: string[] } {
  const grounded = generateGroundedCandidates(state, reachableOptions)
  const candidates: Candidate[] = grounded.candidates
  // `withheld` are candidates the generator built but refused a gate for; both
  // sets are inspected so "not offered" cannot be confused with "not built".
  const ids = candidates.map((candidate) => candidate.id)
  const withheld = grounded.withheld.map((entry) => entry.candidate.id)
  return {
    ids,
    offered: [...ids, ...withheld],
    retrieve: [...ids, ...withheld].find((id) => id.startsWith(`RETRIEVE:known:${item}:`)),
    exclusions: (grounded.sourceExclusions ?? []).map(
      (exclusion) =>
        `${exclusion.reason} cell=${exclusion.cell.x},${exclusion.cell.y},${exclusion.cell.z} recorded=${exclusion.recordedDimension ?? 'none'} live=${exclusion.liveDimension ?? 'unknown'}`,
    ),
  }
}

// ---------------------------------------------------------------------------
// (i) the measured shape
// ---------------------------------------------------------------------------
{
  // (i-a) UN-ATTRIBUTED: no dimension recorded anywhere. Fail closed in the world
  // the defect was measured in, and the refusal is typed and names all three facts.
  const unattributed: KnownResource = { name: 'jungle_log', kind: 'log', position: { ...MEASURED_CELL } }
  const inNether = offered(worldState(NETHER, [unattributed]))
  const expectedToken = cellToken(MEASURED_CELL)
  const refusal = inNether.exclusions.find((line) => line.startsWith('dimension_unattributed'))
  const passA =
    inNether.retrieve === undefined &&
    !inNether.ids.some((id) => id.includes(expectedToken)) &&
    refusal === `dimension_unattributed cell=8,85,6 recorded=none live=${NETHER}`
  check(
    '(i-a) an un-attributed log cell is NOT a target in the Nether, with a typed reason naming cell / recorded / live dimension',
    passA,
    `retrieve=${inNether.retrieve ?? 'none'} ids=${inNether.ids.join(',') || 'none'} refusals=[${inNether.exclusions.join(' | ') || 'none'}]`,
  )

  // (i-b) the SAME cell, after a write path observed it in a real world and
  // stamped it: offered normally there, still refused in the other world.
  const attributed = mergeKnownResources(
    [] as KnownResourceJson[],
    [{ name: 'jungle_log', kind: 'log', ...MEASURED_CELL, dimension: OVERWORLD, worldEpoch: 1, lastSeenAt: 1 }],
  )
  const healedRow = mergeKnownResources(
    [] as KnownResourceJson[],
    [{ name: 'jungle_log', kind: 'log', ...MEASURED_CELL, dimension: OVERWORLD, worldEpoch: 1 }],
  )
  const sameCellAttributed: KnownResource = {
    name: 'jungle_log',
    kind: 'log',
    position: { ...MEASURED_CELL },
    dimension: OVERWORLD,
  }
  const inOverworld = offered(worldState(OVERWORLD, [sameCellAttributed]))
  const inNetherAgain = offered(worldState(NETHER, [sameCellAttributed]))
  const passB =
    attributed === 1 &&
    healedRow === 1 &&
    inOverworld.retrieve === `RETRIEVE:known:log:${expectedToken}` &&
    inNetherAgain.retrieve === undefined &&
    inNetherAgain.exclusions.some((line) => line.startsWith('dimension_mismatch'))
  check(
    '(i-b) the SAME cell, once a write path stamps the world it was observed in, is offered normally in the overworld and refused in the Nether',
    passB,
    `overworld=${inOverworld.retrieve ?? 'none'} nether=${inNetherAgain.retrieve ?? 'none'} refusals=[${inNetherAgain.exclusions.join(' | ') || 'none'}]`,
  )
}

// ---------------------------------------------------------------------------
// (ii) a stamped overworld cell in the overworld -> unchanged
// ---------------------------------------------------------------------------
{
  const row: KnownResource = { name: 'jungle_log', kind: 'log', position: { x: 12, y: 70, z: 4 }, dimension: OVERWORLD, worldEpoch: 1 }
  const state = worldState(OVERWORLD, [row])
  const result = offered(state)
  const expected = `RETRIEVE:known:log:${cellToken(row.position)}`
  check(
    '(ii) a stamped overworld cell in the overworld is unchanged (same RETRIEVE id, no dimension refusal)',
    result.retrieve === expected && result.exclusions.length === 0,
    `retrieve=${result.retrieve ?? 'none'} expected=${expected} refusals=[${result.exclusions.join(' | ') || 'none'}]`,
  )
}

// ---------------------------------------------------------------------------
// (iii) a stamped nether cell in the nether -> unchanged
// ---------------------------------------------------------------------------
{
  // A real Nether record: the live nether bucket holds 80 obsidian cells (the
  // portal frames the body lit there). Same dimension, so nothing changes.
  const row: KnownResource = { name: 'obsidian', kind: 'ore', position: { x: 3, y: 58, z: -2 }, dimension: NETHER, worldEpoch: 1 }
  const state = worldState(NETHER, [row], 'obsidian')
  const result = offered(state, 'obsidian')
  const expected = `RETRIEVE:known:obsidian:${cellToken(row.position)}`
  check(
    '(iii) a stamped nether cell in the nether is unchanged (same RETRIEVE id, no dimension refusal)',
    result.retrieve === expected && result.exclusions.length === 0,
    `retrieve=${result.retrieve ?? 'none'} expected=${expected} refusals=[${result.exclusions.join(' | ') || 'none'}]`,
  )
}

// ---------------------------------------------------------------------------
// (iv) every writer stamps the dimension
// ---------------------------------------------------------------------------
{
  const worldKey = { serverId: '127.0.0.1:25565', dimension: NETHER, worldEpoch: 1 }

  // The VERIFIED-container writer (generation-entry), the one write path that is
  // a direct call.
  const container = containerReadyKnownResource({ target: { x: 20, y: 59, z: 3 }, block: 'chest' }, worldKey)

  // The placed-station writer (controller). The live dimension is passed at the
  // call site; without it the row would be un-attributable and refused everywhere.
  const stations: KnownResource[] = []
  const placed = registerPlacedStation(stations, 'furnace', { x: 4, y: 62, z: 9 }, NETHER)

  // The durable-site projections copy the SITE's own dimension (never invented).
  const portalSites: KnownPortalSiteJson[] = [
    { x: 25, y: 66, z: 9, widthAxis: 'x', dimension: OVERWORLD, worldEpoch: 1 },
  ]
  const structureSites: KnownStructureSiteJson[] = [
    { x: 35, y: 60, z: -22, kind: 'nether_fortress', dimension: NETHER, worldEpoch: 1 },
  ]
  const portals = portalSiteKnownResources(portalSites)
  const structures = structureSiteKnownResources(structureSites)

  // The durable insert path stamps what it is given AND names it in the marker.
  const markers: Array<{ event: string; detail: Record<string, unknown> }> = []
  const store: KnownResourceJson[] = []
  const inserted = mergeKnownResourcesInto(
    store,
    [{ name: 'obsidian', kind: 'ore', x: 3, y: 58, z: -2, dimension: NETHER, worldEpoch: 1, lastSeenAt: 7 }],
    { emitInsertMarker: true, log: (event, detail) => markers.push({ event, detail: detail ?? {} }) },
  )
  const insertMarker = markers.find((marker) => marker.event === 'KNOWN_RESOURCE')

  const directPass =
    container !== null &&
    container.dimension === NETHER &&
    placed.station.dimension === NETHER &&
    portals[0]?.dimension === OVERWORLD &&
    structures[0]?.dimension === NETHER &&
    inserted.added === 1 &&
    store[0]?.dimension === NETHER &&
    insertMarker?.detail.dimension === NETHER

  // Source assertion: every remaining known-resource writer is INLINE in
  // `createGeneration` (the four scan pushes and the station envelope
  // projections), so it is asserted at the source, where a future writer that
  // forgets the stamp is caught.
  const source = await Bun.file(new URL('./generation-entry.ts', import.meta.url)).text()
  const scanBlocks = source.split('foundResources.push(').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('})')))
  const scanStamped = scanBlocks.length === 4 && scanBlocks.every((block) => block.includes('dimension: ctx.worldKey.dimension'))
  const stationEnvelopeStamped =
    /world\.furnaces\.map\(\(furnace\) => \(\{[\s\S]{0,400}?dimension: ctx\.worldKey\.dimension/.test(source) &&
    /world\.craftingTables\.map\(\(table\) => \(\{[\s\S]{0,400}?dimension: ctx\.worldKey\.dimension/.test(source)
  const portalKeepsOwnDimension = source.includes('...(site.dimension === undefined ? {} : { dimension: site.dimension })')

  check(
    '(iv) every known-resource writer stamps the dimension (direct calls + source assertion on the inline scan/envelope writers)',
    directPass && scanStamped && stationEnvelopeStamped && portalKeepsOwnDimension,
    `container=${container?.dimension ?? 'none'} placed=${placed.station.dimension ?? 'none'} portal=${portals[0]?.dimension ?? 'none'} structure=${structures[0]?.dimension ?? 'none'} insertMarker=${String(insertMarker?.detail.dimension)} scanPushes=${scanBlocks.length}/stamped=${scanStamped} stationEnvelope=${stationEnvelopeStamped} portalOwnDimension=${portalKeepsOwnDimension}`,
  )
}

// ---------------------------------------------------------------------------
// (v) the durable round-trip preserves the dimension
// ---------------------------------------------------------------------------
{
  const row: KnownResourceJson = { name: 'obsidian', kind: 'ore', x: 3, y: 58, z: -2, dimension: NETHER, worldEpoch: 1, lastSeenAt: 7 }

  // The HOST merge into the durable store (the only insert path).
  const durable: KnownResourceJson[] = []
  mergeKnownResourceDtos(durable, [row])
  const afterHostMerge = durable[0]?.dimension

  // The file round-trip: exactly the raw shape `buddy-state.json` holds, restored
  // through the host's own validate/normalize/restore path.
  const raw = {
    schemaVersion: 3,
    bot: 'AI_ATTR',
    serverId: '127.0.0.1:25565',
    dimension: NETHER,
    worldEpoch: 1,
    worldMemoryByKey: { [`127.0.0.1:25565|${NETHER}|1`]: { ...emptyWorldMemory(), knownResources: [row] } },
  }
  const restored = restoreAgentSnapshot(JSON.parse(JSON.stringify(raw)), emptyAgentSnapshot(), () => undefined)
  const restoredRow = restored.worldMemoryByKey[`127.0.0.1:25565|${NETHER}|1`]?.knownResources[0]

  // The refresh-heal (option (a)'s "the writer stamps it on the next
  // observation"): an un-attributed row is stamped by re-observation, and an
  // already-stamped row is never re-attributed by the merge.
  const legacy: KnownResourceJson[] = [{ name: 'jungle_log', kind: 'log', x: 8, y: 85, z: 6, worldEpoch: 1, lastSeenAt: 1 }]
  mergeKnownResources(legacy, [{ name: 'jungle_log', kind: 'log', x: 8, y: 85, z: 6, dimension: OVERWORLD, worldEpoch: 1, lastSeenAt: 2 }])
  const healed = legacy[0]?.dimension
  const keep: KnownResourceJson[] = [{ name: 'jungle_log', kind: 'log', x: 8, y: 85, z: 6, dimension: NETHER, worldEpoch: 1, lastSeenAt: 1 }]
  mergeKnownResources(keep, [{ name: 'jungle_log', kind: 'log', x: 8, y: 85, z: 6, dimension: OVERWORLD, worldEpoch: 1, lastSeenAt: 2 }])
  const notRestamped = keep[0]?.dimension

  check(
    '(v) the durable round-trip preserves the dimension, and the refresh heals only an UN-attributed row',
    afterHostMerge === NETHER && restoredRow?.dimension === NETHER && healed === OVERWORLD && notRestamped === NETHER,
    `hostMerge=${afterHostMerge ?? 'none'} restored=${restoredRow?.dimension ?? 'none'} healed=${healed ?? 'none'} notRestamped=${notRestamped ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (vi) an un-attributed row is never DELETED as "proven absent" in a world it
//      may not belong to (the eviction path is fail-closed too)
// ---------------------------------------------------------------------------
{
  const positions = new Map<string, string>()
  const bot = {
    entity: { position: { x: 8, y: 60, z: 6 } },
    // The live world at the measured cell holds a nether block, so a probe would
    // "prove" the remembered log is gone.
    blockAt: (point: { x: number; y: number; z: number }) => {
      const name = positions.get(`${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`) ?? 'netherrack'
      return { name }
    },
  }
  const known: KnownResourceJson[] = [
    { name: 'jungle_log', kind: 'log', x: 8, y: 85, z: 6, worldEpoch: 1, lastSeenAt: 1 },
    { name: 'jungle_log', kind: 'log', x: 9, y: 85, z: 6, dimension: OVERWORLD, worldEpoch: 1, lastSeenAt: 1 },
  ]
  const evicted = evictStaleKnownResources(bot as never, known, { dimension: NETHER, worldEpoch: 1 })
  const unattributedSurvives = known.some((resource) => resource.name === 'jungle_log' && resource.x === 8 && resource.dimension === undefined)
  const otherWorldEvicted = evicted.some((resource) => resource.x === 9)
  check(
    '(vi) an un-attributed row is kept (not probed, not evicted); a row naming another world is still re-anchored',
    evicted.length === 1 && unattributedSurvives && otherWorldEvicted,
    `evicted=${evicted.map((resource) => `${resource.name}@${resource.x}${resource.dimension === undefined ? ':(unattributed)' : ''}`).join(',') || 'none'} kept=${known.length}`,
  )
}

// ---------------------------------------------------------------------------
// (vii) the SENSOR-probe deletion path is fail-closed too: a `block_mined` proof
//       read in one world can never delete a row that names another world (or
//       none), because that coordinate is a different place there
// ---------------------------------------------------------------------------
{
  const rows: KnownResourceJson[] = [
    { name: 'jungle_log', kind: 'log', x: 8, y: 85, z: 6, dimension: OVERWORLD, worldEpoch: 1 },
    { name: 'jungle_log', kind: 'log', x: 8, y: 85, z: 6, worldEpoch: 1 },
  ]
  const proofInNether = knownResourceFalsifiedRemovals(rows, { reason: 'block_mined', cell: MEASURED_CELL }, NETHER)
  const proofInOverworld = knownResourceFalsifiedRemovals(rows, { reason: 'block_mined', cell: MEASURED_CELL }, OVERWORLD)
  const unattributedOnly: KnownResourceJson[] = [rows[1]!]
  const proofAgainstUnattributed = knownResourceFalsifiedRemovals(
    unattributedOnly,
    { reason: 'block_mined', cell: MEASURED_CELL },
    OVERWORLD,
  )
  check(
    '(vii) a block_mined proof deletes only the row attributable to the probed world; an un-attributed row is never deleted',
    proofInNether.length === 0 &&
      proofInOverworld.length === 1 &&
      proofInOverworld[0]?.dimension === OVERWORLD &&
      proofAgainstUnattributed.length === 0,
    `netherProof=${proofInNether.length} overworldProof=${proofInOverworld.length} unattributed=${proofAgainstUnattributed.length}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
