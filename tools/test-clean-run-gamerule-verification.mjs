#!/usr/bin/env bun
// Focused offline fixtures for the run-bound, per-dimension gamerule transcript.
// No Minecraft server, resident, network, or live evidence is used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { checkConsoleGameruleEvidence } from './clean-run-environment.mjs'

const TEMPLATE = new URL('./fixtures/m3-clean-environment.json', import.meta.url)
const RUN_ID = 'run-gamerule-verification-fixture'
const SOURCE_SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const OTHER_SHA = 'bb22cc33dd44ee55ff6677889900aabbccddeeff'
let checks = 0

function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function makeDescriptor() {
  const descriptor = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  descriptor.values.levelName = 'm3clean-gamerule'
  descriptor.values.levelSeed = '-4187923615481'
  descriptor.values.sourceSha = SOURCE_SHA
  descriptor.cleanRun.sourceSha.state = 'FROZEN'
  return descriptor
}

function descriptorSha(descriptor) {
  return createHash('sha256').update(`${JSON.stringify(descriptor, null, 2)}\n`).digest('hex')
}

function makeTranscript(descriptor, {
  sha256 = descriptorSha(descriptor),
  runId = RUN_ID,
  sourceSha = descriptor.values.sourceSha,
  missingMetadata = null,
  omittedDimension = null,
  omittedRule = null,
  extraDimension = null,
} = {}) {
  const metadata = {
    record: 'm3-clean-gamerule-verification',
    schemaVersion: '1',
    runId,
    descriptorSha256: sha256,
    levelName: descriptor.values.levelName,
    seed: String(descriptor.values.levelSeed),
    sourceSha,
    capturedAt: '2026-09-24T00:00:00.000Z',
  }
  if (missingMetadata !== null) delete metadata[missingMetadata]
  const lines = Object.entries(metadata).map(([key, value]) => `${key}=${value}`)
  for (const dimension of descriptor.cleanRun.gameruleScope.dimensions) {
    if (dimension === omittedDimension) continue
    lines.push('', `[dimension=${dimension}]`)
    for (const [rule, value] of Object.entries(descriptor.values.gamerules)) {
      if (dimension === omittedRule?.dimension && rule === omittedRule?.rule) continue
      lines.push(`[Server thread/INFO]: Gamerule ${rule} is currently set to: ${String(value)}`)
    }
  }
  if (extraDimension !== null) {
    lines.push('', `[dimension=${extraDimension}]`, 'keep_inventory = false')
  }
  return lines.join('\n')
}

function evaluate(descriptor, text, { runId = RUN_ID, bootSourceSha = descriptor.values.sourceSha, descriptorSha256 = descriptorSha(descriptor) } = {}) {
  const artifact = { record: 'milestone-run-artifact', runId, run: { runId, boot: { sourceSha: bootSourceSha } } }
  return checkConsoleGameruleEvidence({ descriptor, artifact, runId, descriptorSha256, text })
}

const descriptor = makeDescriptor()

// 1. All declared values in every descriptor dimension bind to this run.
{
  const result = evaluate(descriptor, makeTranscript(descriptor))
  assert.equal(result.verdict, 'PASS', result.reason)
  assert.equal(result.detail.requiredDimensions.length, 3)
  assert.equal(result.detail.expectedRuleCount, 58)
  assert.deepEqual(result.detail.observedRulesByDimension, {
    'minecraft:overworld': 58,
    'minecraft:the_nether': 58,
    'minecraft:the_end': 58,
  })
  ok('bound exact-source transcript verifies 58 gamerules in all three dimensions')
}

// 2. An unfilled template field is not evidence and stays UNKNOWN.
{
  const result = evaluate(descriptor, makeTranscript(descriptor, { missingMetadata: 'runId' }))
  assert.equal(result.verdict, 'UNKNOWN')
  assert.ok(result.detail.missingMetadata.includes('runId'))
  ok('missing run metadata remains UNKNOWN')
}

// 3. The transcript runId must equal the requested and artifact runId.
{
  const result = evaluate(descriptor, makeTranscript(descriptor, { runId: 'another-run' }))
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.reason, /runId=/)
  ok('runId mismatch FAILs')
}

// 4. Both the bound source and its BOOT provenance must equal the descriptor.
{
  const result = evaluate(descriptor, makeTranscript(descriptor, { sourceSha: OTHER_SHA }))
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.reason, /sourceSha=/)
  ok('transcript source SHA mismatch FAILs')
}
{
  const result = evaluate(descriptor, makeTranscript(descriptor), { bootSourceSha: OTHER_SHA })
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.reason, /BOOT source/)
  ok('artifact BOOT source mismatch FAILs')
}

// 5. A transcript cannot bind to a different resolved descriptor digest.
{
  const result = evaluate(descriptor, makeTranscript(descriptor, { sha256: '0'.repeat(64) }))
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.reason, /descriptorSha256=/)
  ok('descriptor digest mismatch FAILs')
}

// 6. Every scoped dimension and every declared gamerule must be present.
{
  const result = evaluate(descriptor, makeTranscript(descriptor, { omittedDimension: 'minecraft:the_nether' }))
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.reason, /missing dimension listing minecraft:the_nether/)
  ok('missing dimension listing FAILs')
}
{
  const result = evaluate(descriptor, makeTranscript(descriptor, { omittedRule: { dimension: 'minecraft:the_end', rule: 'keep_inventory' } }))
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.reason, /minecraft:the_end missing keep_inventory/)
  ok('incomplete dimension gamerule listing FAILs')
}
{
  const result = evaluate(descriptor, makeTranscript(descriptor, { extraDimension: 'minecraft:custom' }))
  assert.equal(result.verdict, 'FAIL')
  assert.match(result.reason, /unexpected dimension listing minecraft:custom/)
  ok('unexpected dimension listing FAILs')
}

console.log(`PASS clean-run gamerule verification fixtures (${checks} checks)`)
