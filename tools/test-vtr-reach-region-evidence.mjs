#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  const positiveRegion = 'server/world/region/r.1.-1.mca'
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
  const negativeRegion = 'server/world/region/r.-1.2.mca'
  assert.equal(witnessRegionRelativePath(negativeWitness), negativeRegion)
  putRegion(archive, negativeRegion, negativeWitness, 'emerald_ore')
  const negativePlane = await inspectWitnessPlane(archive, [negativeRegion], negativeWitness)
  assert.equal(negativePlane.witnessBlock, 'emerald_ore')
  assert.equal(negativePlane.relativePath, negativeRegion)

  const misplacedOnly = 'server/world/region/r.-1.0.mca'
  putRegion(archive, misplacedOnly, negativeWitness, 'emerald_ore')
  const missingCoordinateRegion = await inspectWitnessPlane(archive, [misplacedOnly], negativeWitness)
  assert.equal(missingCoordinateRegion.status, 'INCOMPLETE')
  assert.equal(missingCoordinateRegion.relativePath, negativeRegion)
  assert.equal(missingCoordinateRegion.reason, 'coordinate-derived region file is absent', 'an unrelated legacy-named region cannot satisfy the witness evidence')

  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const SOURCE_SHA = 'a'.repeat(40)
  const FIXTURE_RUN = 'run-region-fixture'
  const FIXTURE_GENERATION = 'gen-region-fixture'
  const FIXTURE_WORLD = '127.0.0.1:25577|overworld|1'
  const FIXTURE_SERVER = {
    pid: 4242, serverId: '127.0.0.1:25577', port: 25577,
    levelName: 'vtrreach-region-test', spawnedAt: '2026-09-25T00:00:00.000Z',
  }
  const FIXTURE_RUN_INFO = {
    runId: FIXTURE_RUN, generationId: FIXTURE_GENERATION, worldKey: FIXTURE_WORLD, worldEpoch: 1,
    startedAt: '2026-09-25T00:00:05.000Z', generationReadyAt: '2026-09-25T00:00:30.000Z',
  }
  const fixtureSpawn = { x: 2.5, y: -60, z: 7.5 }
  const derivedBlock = (position, offset) => ({
    x: Math.floor(position.x + offset.x), y: Math.floor(position.y + offset.y), z: Math.floor(position.z + offset.z),
  })
  const derivedFillFrom = derivedBlock(fixtureSpawn, { x: 1, y: -1, z: -3 })
  const derivedFillTo = derivedBlock(fixtureSpawn, { x: 24, y: -1, z: 3 })
  const derivedWitness = derivedBlock(fixtureSpawn, { x: 16, y: 0, z: 2 })
  const derivedFillCount = (derivedFillTo.x - derivedFillFrom.x + 1) * (derivedFillTo.y - derivedFillFrom.y + 1) * (derivedFillTo.z - derivedFillFrom.z + 1)

  function makeFixtureEvidence({ witnessBlock = 'minecraft:deepslate_copper_ore', missionItem = 'copper_ingot', sourceNames = ['minecraft:copper_ore', 'deepslate_copper_ore'], spawn = fixtureSpawn } = {}) {
    const fillFrom = derivedBlock(spawn, { x: 1, y: -1, z: -3 })
    const fillTo = derivedBlock(spawn, { x: 24, y: -1, z: 3 })
    const witnessPosition = derivedBlock(spawn, { x: 16, y: 0, z: 2 })
    const fillCount = (fillTo.x - fillFrom.x + 1) * (fillTo.y - fillFrom.y + 1) * (fillTo.z - fillFrom.z + 1)
    const anchor = {
      schema: 'vtr-reach-initial-snapshot/v1', sourceSha: SOURCE_SHA, bootSourceSha: SOURCE_SHA,
      runId: FIXTURE_RUN, generationId: null, worldKey: FIXTURE_WORLD, worldEpoch: 1,
      capturedAt: '2026-09-25T00:00:09.000Z', initialInventory: {}, initialPosition: spawn,
    }
    const anchorBytes = Buffer.from(`${JSON.stringify(anchor, null, 2)}\n`)
    const fixtureAnchor = {
      schema: 'vtr-reach-fixture-anchor/v1', sourceSha: SOURCE_SHA, runId: FIXTURE_RUN,
      generationId: null, leaseId: null, worldKey: FIXTURE_WORLD, worldEpoch: 1,
      snapshotPath: 'runner/fixture-anchor-snapshot.json', snapshotSha256: sha256(anchorBytes),
      positionSource: 'runner/fixture-anchor-snapshot.json.initialPosition', initialPosition: spawn,
      coordinateRule: 'floor(position + integer offset)',
      offsets: { fillFrom: { x: 1, y: -1, z: -3 }, fillTo: { x: 24, y: -1, z: 3 }, witness: { x: 16, y: 0, z: 2 } },
    }
    const fillCommand = `fill ${fillFrom.x} ${fillFrom.y} ${fillFrom.z} ${fillTo.x} ${fillTo.y} ${fillTo.z} minecraft:stone`
    const setblockCommand = `setblock ${witnessPosition.x} ${witnessPosition.y} ${witnessPosition.z} ${witnessBlock}`
    const fillOutput = `[00:00:10 INFO]: Successfully filled ${fillCount} block(s)`
    const setblockOutput = `[00:00:11 INFO]: Changed the block at ${witnessPosition.x}, ${witnessPosition.y}, ${witnessPosition.z}`
    const stdoutRow = (sequence, line, receivedAt) => ({
      schema: 'vtr-server-stdout-observation/v1', sourceSha: SOURCE_SHA, runId: FIXTURE_RUN,
      generationId: null, worldKey: FIXTURE_WORLD, serverId: FIXTURE_SERVER.serverId, serverPid: FIXTURE_SERVER.pid,
      port: FIXTURE_SERVER.port, levelName: FIXTURE_SERVER.levelName, sequence, receivedAt,
      monotonicNs: `${sequence}`, streamSource: 'spawned-server-stdout', line,
      lineSha256: sha256(Buffer.from(line)), rawLineSha256: sha256(Buffer.from(line)),
    })
    const row = (kind, command, serverOutput, issuedAt, sequence) => ({
      schema: 'vtr-reach-fixture-command/v2', kind, sourceSha: SOURCE_SHA, runId: FIXTURE_RUN,
      generationId: null, leaseId: null, worldKey: FIXTURE_WORLD, serverId: FIXTURE_SERVER.serverId,
      serverPid: FIXTURE_SERVER.pid, phase: 'resident-frozen-before-generation-ready', fixtureAnchor,
      issuedAt, stdinAcknowledgedAt: issuedAt, command, commandSha256: sha256(Buffer.from(command)),
      serverOutput, observedAt: `2026-09-25T00:00:${kind === 'fill' ? '10' : '11'}.700Z`,
      responsePid: FIXTURE_SERVER.pid, responseSequence: sequence,
    })
    return {
      witness: witnessPosition,
      input: {
        fixtureCommands: [
          row('fill', fillCommand, fillOutput, '2026-09-25T00:00:10.200Z', 3),
          row('setblock', setblockCommand, setblockOutput, '2026-09-25T00:00:11.200Z', 4),
        ],
        missionItem,
        desiredPredicate: { proposition: { item: missionItem, sourceNames } },
        witness: witnessPosition,
        sourceSha: SOURCE_SHA,
        run: FIXTURE_RUN_INFO,
        serverStart: FIXTURE_SERVER,
        anchor,
        anchorBytes,
        initialSnapshot: { ...anchor, generationId: FIXTURE_GENERATION },
        stdoutEvents: [stdoutRow(3, fillOutput, '2026-09-25T00:00:10.700Z'), stdoutRow(4, setblockOutput, '2026-09-25T00:00:11.700Z')],
      },
    }
  }

  const anchored = makeFixtureEvidence()
  const anchoredResult = inspectFixtureWitnessSetup(anchored.input)
  assert.equal(anchoredResult.status, 'PASS', JSON.stringify(anchoredResult))
  assert.equal(anchoredResult.observedBlock, 'deepslate_copper_ore')
  assert.ok(anchoredResult.committedSources.includes('copper_ore'))
  assert.equal(anchoredResult.fillBlocks, derivedFillCount)
  assert.deepEqual(anchoredResult.witness, derivedWitness)
  assert.equal(anchoredResult.anchor.sha256, sha256(anchored.input.anchorBytes))

  const legacyRelative = inspectFixtureWitnessSetup({
    ...anchored.input,
    fixtureCommands: [{
      command: 'execute at AI_Buddy run setblock ~8 ~-1 ~0 minecraft:deepslate_copper_ore replace',
      result: 'Changed block at 528,64,-10',
    }],
  })
  assert.equal(legacyRelative.status, 'FAIL', 'legacy execute/relative fixture commands are no longer acceptable evidence')

  const extraRow = inspectFixtureWitnessSetup({
    ...anchored.input,
    fixtureCommands: [...anchored.input.fixtureCommands, { schema: 'vtr-reach-fixture-command/v2', kind: 'fill', command: anchored.input.fixtureCommands[0].command }],
  })
  assert.equal(extraRow.status, 'FAIL', 'the fixture journal must contain exactly one v2 fill and one v2 setblock')

  const tamperedFillCount = inspectFixtureWitnessSetup({
    ...anchored.input,
    fixtureCommands: anchored.input.fixtureCommands.map((entry) => entry.kind === 'fill'
      ? { ...entry, serverOutput: '[00:00:10 INFO]: Successfully filled 0 blocks' }
      : entry),
  })
  assert.equal(tamperedFillCount.status, 'FAIL', 'the recorded fill response must report the exact derived block count')

  const movedWitness = inspectFixtureWitnessSetup({ ...anchored.input, witness: { x: 520, y: 65, z: -10 } })
  assert.equal(movedWitness.status, 'FAIL', 'the committed witness must equal the anchor-derived fixture position')

  const wrongAnchorHash = inspectFixtureWitnessSetup({
    ...anchored.input,
    anchorBytes: Buffer.from('{"tampered":true}\n'),
  })
  assert.equal(wrongAnchorHash.status, 'FAIL', 'the recorded anchor hash must rebind the preserved snapshot bytes')

  const missingAnchor = inspectFixtureWitnessSetup({ ...anchored.input, anchor: null, anchorBytes: null })
  assert.equal(missingAnchor.status, 'INCOMPLETE', 'a missing frozen anchor snapshot is absent evidence, not a contradiction')

  const movedInitial = inspectFixtureWitnessSetup({
    ...anchored.input,
    initialSnapshot: { ...anchored.input.initialSnapshot, initialPosition: { x: 0, y: 0, z: 0 } },
  })
  assert.equal(movedInitial.status, 'FAIL', 'the final initial snapshot must retain the exact anchor position')

  const missingReceipt = inspectFixtureWitnessSetup({ ...anchored.input, stdoutEvents: [] })
  assert.equal(missingReceipt.status, 'FAIL', 'each v2 command must bind exactly one spawned-stdout receipt')

  const postGeneration = inspectFixtureWitnessSetup({
    ...anchored.input,
    fixtureCommands: anchored.input.fixtureCommands.map((entry) => entry.kind === 'fill' ? { ...entry, generationId: FIXTURE_GENERATION } : entry),
  })
  assert.equal(postGeneration.status, 'FAIL', 'fixture rows must prove the pre-generation frozen window')

  const lateFill = inspectFixtureWitnessSetup({
    ...anchored.input,
    fixtureCommands: anchored.input.fixtureCommands.map((entry) => entry.kind === 'fill'
      ? { ...entry, issuedAt: '2026-09-25T00:00:31.000Z' }
      : entry),
  })
  assert.equal(lateFill.status, 'FAIL', 'fixture commands must precede GENERATION_READY')

  const mismatchedFixture = inspectFixtureWitnessSetup({
    ...anchored.input,
    fixtureCommands: anchored.input.fixtureCommands.map((entry) => entry.kind === 'setblock'
      ? { ...entry, command: `setblock ${derivedWitness.x} ${derivedWitness.y} ${derivedWitness.z} minecraft:iron_ore`, commandSha256: sha256(Buffer.from(`setblock ${derivedWitness.x} ${derivedWitness.y} ${derivedWitness.z} minecraft:iron_ore`)) }
      : entry),
  })
  assert.equal(mismatchedFixture.status, 'FAIL', 'a non-source setblock block contradicts the committed Reach sources')

  const missionMismatch = inspectFixtureWitnessSetup({
    ...anchored.input,
    desiredPredicate: { proposition: { item: 'iron_ingot', sourceNames: ['iron_ore'] } },
  })
  assert.equal(missionMismatch.status, 'FAIL')
  assert.equal(missionMismatch.reason, 'Mission item and committed Reach predicate item disagree')

  assert.equal(witnessRegionRelativePath({ x: -1, y: 5.5, z: 0 }), null, 'region derivation requires integer committed block coordinates')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

process.stdout.write('VTR Reach region evidence tests passed (17 cases)\n')
