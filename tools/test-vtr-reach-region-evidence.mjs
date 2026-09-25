#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  inspectFixtureWitnessSetup,
  inspectWitnessPlane,
  witnessRegionRelativePath,
} from './validate-vtr-reach-evidence.mjs'

const require = createRequire(import.meta.url)
const nbt = require('prismarine-nbt')

function makeRegion({ witness, block }) {
  const chunkX = Math.floor(witness.x / 16)
  const chunkZ = Math.floor(witness.z / 16)
  const chunkIndex = (chunkX & 31) + (chunkZ & 31) * 32
  const sectionY = Math.floor(witness.y / 16)
  const chunk = nbt.comp({
    Level: nbt.comp({
      sections: nbt.list(nbt.comp([{
        Y: nbt.byte(sectionY),
        block_states: nbt.comp({
          palette: nbt.list(nbt.comp([{ Name: nbt.string(`minecraft:${block}`) }])),
        }),
      }])),
    }),
  })
  const compressedChunk = gzipSync(nbt.writeUncompressed(chunk))
  const sectors = Math.ceil((compressedChunk.length + 5) / 4096)
  const bytes = Buffer.alloc((2 + sectors) * 4096)
  bytes.writeUIntBE(2, chunkIndex * 4, 3)
  bytes.writeUInt8(sectors, chunkIndex * 4 + 3)
  bytes.writeUInt32BE(compressedChunk.length + 1, 2 * 4096)
  bytes.writeUInt8(1, 2 * 4096 + 4)
  compressedChunk.copy(bytes, 2 * 4096 + 5)
  return bytes
}

function putRegion(archive, relativePath, target, block) {
  const path = join(archive, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, makeRegion({ witness: target, block }))
  return relativePath
}

const tempRoot = mkdtempSync(join(tmpdir(), 'vtr-reach-region-test-'))
try {
  const archive = join(tempRoot, 'archive')
  mkdirSync(archive)

  const positiveWitness = { x: 520, y: 65, z: -10 }
  const positiveRegion = 'server/world/r.1.-1.mca'
  assert.equal(witnessRegionRelativePath(positiveWitness), positiveRegion)
  putRegion(archive, positiveRegion, positiveWitness, 'deepslate_copper_ore')
  const positivePlane = await inspectWitnessPlane(archive, [positiveRegion], positiveWitness)
  assert.deepEqual(positivePlane, {
    status: 'READ',
    relativePath: positiveRegion,
    witnessBlock: 'deepslate_copper_ore',
    supportBlock: 'deepslate_copper_ore',
  }, 'validator must still parse independent raw MCA block state at witness and support coordinates')

  const negativeWitness = { x: -33, y: 12, z: 1025 }
  const negativeRegion = 'server/world/r.-1.2.mca'
  assert.equal(witnessRegionRelativePath(negativeWitness), negativeRegion)
  putRegion(archive, negativeRegion, negativeWitness, 'emerald_ore')
  const negativePlane = await inspectWitnessPlane(archive, [negativeRegion], negativeWitness)
  assert.equal(negativePlane.witnessBlock, 'emerald_ore')
  assert.equal(negativePlane.relativePath, negativeRegion)

  const misplacedOnly = 'server/world/r.-1.0.mca'
  putRegion(archive, misplacedOnly, negativeWitness, 'emerald_ore')
  const missingCoordinateRegion = await inspectWitnessPlane(archive, [misplacedOnly], negativeWitness)
  assert.equal(missingCoordinateRegion.status, 'INCOMPLETE')
  assert.equal(missingCoordinateRegion.relativePath, negativeRegion)
  assert.equal(missingCoordinateRegion.reason, 'coordinate-derived region file is absent', 'an unrelated legacy-named region cannot satisfy the witness evidence')

  const resourceMission = {
    missionItem: 'copper_ingot',
    desiredPredicate: { proposition: { item: 'copper_ingot', sourceNames: ['minecraft:copper_ore', 'deepslate_copper_ore'] } },
    witness: positiveWitness,
    fixtureCommands: [{
      command: 'execute at AI_Buddy run setblock ~8 ~-1 ~0 minecraft:deepslate_copper_ore replace',
      result: 'Changed block at 528,64,-10',
    }],
  }
  const genericFixture = inspectFixtureWitnessSetup(resourceMission)
  assert.equal(genericFixture.status, 'PASS')
  assert.equal(genericFixture.observedBlock, 'deepslate_copper_ore')
  assert.ok(genericFixture.committedSources.includes('copper_ore'))

  const mismatchedFixture = inspectFixtureWitnessSetup({
    ...resourceMission,
    fixtureCommands: [{
      command: 'execute at AI_Buddy run setblock ~8 ~-1 ~0 minecraft:iron_ore replace',
      result: 'Changed block at 528,64,-10',
    }],
  })
  assert.equal(mismatchedFixture.status, 'INCOMPLETE')
  assert.deepEqual(mismatchedFixture.committedSources, ['copper_ore', 'deepslate_copper_ore'])

  const missionMismatch = inspectFixtureWitnessSetup({
    ...resourceMission,
    desiredPredicate: { proposition: { item: 'iron_ingot', sourceNames: ['iron_ore'] } },
  })
  assert.equal(missionMismatch.status, 'FAIL')
  assert.equal(missionMismatch.reason, 'Mission item and committed Reach predicate item disagree')

  assert.equal(witnessRegionRelativePath({ x: -1, y: 5.5, z: 0 }), null, 'region derivation requires integer committed block coordinates')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

process.stdout.write('VTR Reach region evidence tests passed (7 cases)\n')
