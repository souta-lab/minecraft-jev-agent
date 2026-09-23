import assert from 'node:assert/strict'
import { buildWorldProbe } from './buddy-observer.mjs'

const runId = 'run-probe-test'
const generationId = 'gen-probe-test'
const capturedAt = '2026-09-24T00:00:00.000Z'
const worldKey = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 7 }
const playerPosition = { x: 107.3, y: 63, z: 90.36 }
const supportPosition = { x: 107, y: 62, z: 90 }

function fixture({
  reportGenerationId = generationId,
  probeGenerationId = generationId,
  cacheGenerationId = generationId,
  support = supportPosition,
  supportPlayer = playerPosition,
  supportCapturedAt = capturedAt,
  bounds = { min: { x: 105, y: 61, z: 88 }, max: { x: 109, y: 65, z: 92 } },
  worldReadability,
} = {}) {
  const entityCache = {
    source: 'mineflayer-bot.entities',
    available: true,
    completeness: 'client-side-loaded-entity-cache-only',
    capturedAt,
    runId,
    generationId: cacheGenerationId,
    worldKey,
    playerEntityId: 1,
    totalLoadedEntities: 1,
    nearbyRadius: 2,
    nearbyEntityCount: 1,
    nearbyNonSelfEntityCount: 0,
  }
  const worldCache = {
    schemaVersion: 1,
    kind: 'resident-world-cache-diagnostic',
    readOnly: true,
    capturedAt,
    binding: { runId, generationId: cacheGenerationId, worldKey },
    readability: worldReadability ?? {
      status: 'all-requested-columns-attributable',
      unboundReason: null,
      requestedColumnCount: 1,
      attributableColumnCount: 1,
      refusedColumnCount: 0,
      refusalByCause: { columnNotLoaded: 0, unknownProvenance: 0, foreignDimension: 0, attributable: 1 },
      unknownIsNotAir: true,
    },
    playerChunk: { chunkX: 6, chunkZ: 5 },
    request: { radius: 2, verticalRadius: 2, columns: [{ chunkX: 6, chunkZ: 5, loaded: true, provenance: { kind: 'attributable' } }] },
    loadedColumns: { count: 1, keys: [{ chunkX: 6, chunkZ: 5, provenance: { kind: 'attributable' } }], keysLimit: 128, keysTruncated: false, available: true },
    dimensionProvenance: { status: 'observed', liveDimension: worldKey.dimension, taggedColumns: 1 },
  }
  return buildWorldProbe({
    report: {
      ok: true,
      data: {
        runId,
        ...(reportGenerationId === null ? {} : { generationId: reportGenerationId }),
        worldKey,
      },
    },
    state: {
      ok: true,
      data: {
        capturedAt,
        runId,
        ...(probeGenerationId === null ? {} : { generationId: probeGenerationId }),
        worldKey,
        truth: { position: playerPosition, health: 11, food: 20, dimension: worldKey.dimension },
        world: { dimension: worldKey.dimension },
        worldCache,
        area: {
          blocks: {
            unknown: 0,
            counts: { grass_block: 125 },
            hazards: [],
            portals: [],
            support: { name: 'grass_block', position: support },
            supportEvidence: {
              source: 'current-player-footing-probe',
              status: 'observed-within-sample',
              capturedAt: supportCapturedAt,
              playerPosition: supportPlayer,
              sampleBounds: bounds,
              position: support,
              coordinateIsCurrentPlayerFooting: true,
              refusal: null,
            },
          },
          entities: [{ id: 1, name: 'AI_Buddy', type: 'player', position: playerPosition, distance: 0 }],
          entityCache,
        },
      },
    },
    radius: 2,
    verticalRadius: 2,
    observedAt: '2026-09-24T00:00:00.100Z',
  })
}

const direct = fixture()
assert.equal(direct.binding.sameGeneration, true)
assert.equal(direct.worldCacheBinding.status, 'aligned')
assert.equal(direct.worldCacheBinding.capturedAt, 'aligned')
assert.equal(direct.worldCacheCapturedAt, capturedAt)
assert.equal(direct.area.supportScopeStatus, 'verified-current-player-footing')
assert.equal(direct.dataComplete, true)

const unknownIdentity = fixture({
  reportGenerationId: null,
  probeGenerationId: null,
  cacheGenerationId: null,
  worldReadability: {
    status: 'unbound',
    unboundReason: 'generation-provenance-view-unavailable',
    requestedColumnCount: 1,
    attributableColumnCount: 0,
    refusedColumnCount: 1,
    refusalByCause: { columnNotLoaded: 0, unknownProvenance: 1, foreignDimension: 0, attributable: 0 },
    unknownIsNotAir: true,
  },
})
assert.equal(unknownIdentity.binding.sameGeneration, null)
assert.equal(unknownIdentity.worldCacheBinding.generationId, 'unknown')
assert.equal(unknownIdentity.worldCacheBinding.status, 'unknown')
assert.equal(unknownIdentity.worldCacheReadability.status, 'unbound')
assert.ok(unknownIdentity.unknown.includes('world_reads_unbound:generation-provenance-view-unavailable'))
assert.ok(unknownIdentity.unknown.includes('world_cache_identity_or_timestamp_unknown'))
assert.equal(unknownIdentity.status, 'partial')

const outsideSupport = fixture({ support: { x: 110, y: 62, z: 90 } })
assert.equal(outsideSupport.area.supportScopeStatus, 'outside-requested-sample')
assert.notEqual(outsideSupport.status, 'known')

const staleSupport = fixture({ supportCapturedAt: '2026-09-23T23:59:59.000Z' })
assert.equal(staleSupport.area.supportScopeStatus, 'capture-time-mismatch')
assert.notEqual(staleSupport.status, 'known')

const entityProbe = fixture()
assert.equal(entityProbe.entityCache.source, 'mineflayer-bot.entities')
assert.equal(entityProbe.entityCache.completeness, 'client-side-loaded-entity-cache-only')
assert.equal(entityProbe.entityCache.nearbyNonSelfEntityCount, 0)
assert.equal(entityProbe.entityCacheBinding.status, 'aligned')
assert.equal(entityProbe.area.hostileStatus, 'observed-in-local-client-entity-cache')

process.stdout.write('world probe diagnostics: PASS\n')
