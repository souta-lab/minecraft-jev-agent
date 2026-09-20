#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  classifyEntity,
  comparePlayerSources,
  evaluateClosedLoop,
  normalizeDimension,
  normalizeInventory,
  parseAdminMessages,
  parseArgs,
  summarizeBlocks,
  summarizeEntities,
} from './world-player-state.mjs'

const cases = []
const add = (name, fn) => cases.push({ name, fn })

add('argument parsing keeps observer read-only and bounded', () => {
  const options = parseArgs(['--target', 'AI_Buddy', '--radius', '99', '--samples', '3', '--json'])
  assert.equal(options.target, 'AI_Buddy')
  assert.equal(options.radius, 16)
  assert.equal(options.samples, 3)
  assert.equal(options.json, true)
  assert.equal(options.adminUser, null)
})

add('inventory normalization joins slots and strips minecraft namespace', () => {
  assert.deepEqual(
    normalizeInventory([{ id: 'minecraft:diamond', count: 1 }, { name: 'diamond', count: 2 }, { name: 'air', count: 0 }]),
    { diamond: 3 },
  )
})

add('operator query parser recovers target position, inventory, health and difficulty', () => {
  const result = parseAdminMessages([
    'AI_Buddy has the following entity data: [6.5d, 71.0d, -7.3d]',
    'AI_Buddy has the following entity data: [{Slot: 0b, id: "minecraft:diamond", count: 1}]',
    'AI_Buddy has the following entity data: 20.0f',
    'The difficulty is Easy',
  ])
  assert.deepEqual(result.position, { x: 6.5, y: 71, z: -7.3 })
  assert.deepEqual(result.inventory, { diamond: 1 })
  assert.equal(result.health, 20)
  assert.equal(result.difficulty, 'easy')
})

add('hostile classification is explicit and does not claim combat success', () => {
  assert.equal(classifyEntity({ name: 'zombie', type: 'mob' }), 'hostile')
  assert.equal(classifyEntity({ name: 'zombie', type: 'hostile', username: null }), 'hostile')
  assert.equal(classifyEntity({ name: 'pig', type: 'animal', kind: 'Passive mobs' }), 'passive')
  assert.equal(classifyEntity({ name: 'player', type: 'player' }), 'player')
})

add('entity and block summaries expose nearby hostiles, hazards and portal cells', () => {
  const entities = summarizeEntities([
    { id: 1, name: 'zombie', type: 'mob', position: { x: 2, y: 0, z: 0 }, health: 20 },
    { id: 2, name: 'pig', type: 'animal', kind: 'Passive mobs', position: { x: 20, y: 0, z: 0 } },
  ], { x: 0, y: 0, z: 0 }, 8)
  const blocks = summarizeBlocks([
    { name: 'nether_portal', position: { x: 0, y: 1, z: 0 } },
    { name: 'lava', position: { x: 1, y: 0, z: 0 } },
    { name: 'obsidian', position: { x: 0, y: 0, z: 0 } },
    { name: null, position: { x: 3, y: 0, z: 0 } },
  ])
  assert.equal(entities.hostiles.length, 1)
  assert.equal(entities.entities.length, 1)
  assert.equal(blocks.portalInteriorCount, 1)
  assert.equal(blocks.obsidianCount, 1)
  assert.equal(blocks.hazards.length, 1)
  assert.equal(blocks.unknown, 1)
})

add('closed loop remains PARTIAL when player truth or difficulty is missing', () => {
  const result = evaluateClosedLoop({
    connected: true,
    targetPosition: { x: 0, y: 64, z: 0 },
    inventory: null,
    dimension: 'overworld',
    difficulty: null,
    blockSummary: { unknown: 0, counts: {}, hazards: [], support: { name: 'grass_block' } },
    entitySummary: { hostiles: [{ name: 'zombie' }] },
    resident: { runId: 'run-test' },
  })
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.hostilePresent, true)
  assert.equal(result.combatAssessment, 'HOSTILE_PRESENT_PLAYER_STATE_INCOMPLETE')
  assert.deepEqual(result.unknown, ['target_inventory_unknown', 'difficulty_unknown'])
})

add('closed loop is KNOWN only when all required facts are present', () => {
  const result = evaluateClosedLoop({
    connected: true,
    targetPosition: { x: 0, y: 64, z: 0 },
    inventory: { wooden_pickaxe: 1 },
    dimension: normalizeDimension('overworld'),
    difficulty: 'easy',
    blockSummary: { unknown: 0, counts: { grass_block: 1 }, hazards: [], support: { name: 'grass_block' } },
    entitySummary: { hostiles: [] },
    resident: { runId: 'run-test' },
  })
  assert.equal(result.status, 'KNOWN')
  assert.equal(result.combatAssessment, 'NO_HOSTILE_OBSERVED')
  assert.equal(result.safeGround, 'OBSERVED_SAFE')
  assert.deepEqual(result.unknown, [])
})

add('resident truth stays primary and cross-source movement drift is explicit', () => {
  const result = comparePlayerSources({
    residentTruth: { position: { x: 10, y: 70, z: 4 }, inventory: { oak_log: 3 } },
    admin: { position: { x: 14, y: 70, z: 4 }, inventory: { oak_log: 3 } },
    entityPosition: { x: 10.5, y: 70, z: 4 },
  })
  assert.equal(result.status, 'MISMATCH')
  assert.deepEqual(result.mismatches, ['resident_admin_position'])
  assert.equal(result.inventoryEqual, true)
  assert.equal(result.positionDistance, 4)
})

let failed = 0
for (const test of cases) {
  try {
    test.fn()
    process.stdout.write(`PASS ${test.name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${test.name}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
process.stdout.write(`world-player-state-test: ${cases.length - failed}/${cases.length} passed\n`)
process.exitCode = failed === 0 ? 0 : 1
