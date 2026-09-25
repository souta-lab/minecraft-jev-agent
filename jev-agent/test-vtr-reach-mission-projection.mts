import { expect, test } from 'bun:test'
import { projectReachMissionSnapshot } from './src/vtr/reach-mission-projection.ts'
import type { ReachMissionSnapshotInput } from './src/vtr/reach-mission-projection.ts'
import type { ReachIdentity } from './src/vtr/reach.ts'
import type { InventoryReachMission } from './src/vtr/reach-scheduler.ts'

const identity: ReachIdentity = {
  worldKey: 'projection-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 7,
  generationId: 'projection-generation',
  leaseId: 'projection-lease',
}

const mission: InventoryReachMission = {
  id: 'mission-reach-oak',
  kind: 'inventory_at_least',
  item: 'oak_log',
  count: 2,
}

function frame(overrides: Partial<ReachMissionSnapshotInput> = {}): ReachMissionSnapshotInput {
  return {
    mission,
    identity,
    witnessIdentity: identity,
    tick: 18,
    observedAtMs: 18_000,
    bodyPosition: { x: 0, y: 64, z: 0 },
    bodyHealth: 20,
    inventoryCounts: { oak_log: 1 },
    knownSourceNames: ['oak_log'],
    sources: [{
      name: 'oak_log',
      yieldedItem: 'oak_log',
      position: { x: 8, y: 64, z: 0 },
      inReach: false,
      visible: true,
    }],
    routes: [{
      routeId: 'MOVE:oak:8_64_0',
      kind: 'MOVE',
      target: { x: 7, y: 64, z: 0 },
      sourceName: 'oak_log',
      sourcePosition: { x: 8, y: 64, z: 0 },
      explore: false,
    }],
    ...overrides,
  }
}

test('pure Reach projection grounds a current source route with identity-bound evidence', () => {
  const projection = projectReachMissionSnapshot(frame())
  expect(projection.groundedRouteIds).toEqual(['MOVE:oak:8_64_0'])
  expect(projection.snapshot.routes[0]?.witness.observedIdentity).toEqual(identity)
  expect(projection.snapshot.observation.predicates['reach.route:MOVE:oak:8_64_0']?.truth).toBe('true')
  expect(projection.snapshot.observation.predicates['reach.resource-source']?.truth).toBe('false')
  expect(projection.snapshot.progress.reachability).toBe('reachable')
})

test('pure Reach projection rejects stale identity and mismatched source witnesses', () => {
  const staleIdentity = { ...identity, worldEpoch: identity.worldEpoch + 1 }
  const staleFrame = frame({ witnessIdentity: staleIdentity })
  const wrongCellFrame = frame({
    routes: [{
      routeId: 'MOVE:oak:8_64_0',
      kind: 'MOVE',
      target: { x: 7, y: 64, z: 0 },
      sourceName: 'oak_log',
      sourcePosition: { x: 9, y: 64, z: 0 },
      explore: false,
    }],
  })
  expect(projectReachMissionSnapshot(staleFrame).snapshot.routes).toHaveLength(0)
  expect(projectReachMissionSnapshot(wrongCellFrame).snapshot.routes).toHaveLength(0)
})

test('only an observed visible in-reach source sets the deterministic Reach ensures fact', () => {
  const projection = projectReachMissionSnapshot(frame({
    sources: [{
      name: 'oak_log',
      yieldedItem: 'oak_log',
      position: { x: 8, y: 64, z: 0 },
      inReach: true,
      visible: true,
    }],
  }))
  expect(projection.snapshot.observation.predicates['reach.resource-source']?.truth).toBe('true')
  expect(projection.ensuresAlreadyTrueEvidenceId).toBe('verify:18:reach.resource-source-already-true')
})
