#!/usr/bin/env bun
// Focused offline fixtures for the run-bound, per-dimension gamerule transcript.
// No Minecraft server, resident, network, or live evidence is used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { checkConsoleGameruleEvidence, parseConsoleGameruleTranscript } from './clean-run-environment.mjs'

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

const descriptor = makeDescriptor()

// 1. The human-readable report parser remains useful for diagnostics, but the
// report alone is not machine-captured evidence and therefore cannot PASS.
{
  const transcript = makeTranscript(descriptor)
  const parsed = parseConsoleGameruleTranscript(transcript)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(Object.fromEntries(Object.entries(parsed.dimensions).map(([dimension, rules]) => [dimension, Object.keys(rules).length])), {
    'minecraft:overworld': 58,
    'minecraft:the_nether': 58,
    'minecraft:the_end': 58,
  })
  assert.equal(parsed.dimensions['minecraft:overworld'].max_minecart_speed, undefined)
  ok('capture report parses 58 queryable rules in each dimension while excluded rules remain unobserved')
}

// 2. Even perfectly formatted, exact-run-looking pasted output stays UNKNOWN
// until the machine capture, journal and Leaf stdout bytes are all present.
{
  const transcript = makeTranscript(descriptor)
  const sha256 = descriptorSha(descriptor)
  const artifact = { record: 'milestone-run-artifact', runId: RUN_ID, run: { runId: RUN_ID, boot: { sourceSha: SOURCE_SHA } } }
  const result = checkConsoleGameruleEvidence({
    descriptor,
    artifact,
    runId: RUN_ID,
    descriptorSha256: sha256,
    path: '/fixture/gamerule-verification.txt',
    text: transcript,
    fileSha256: createHash('sha256').update(transcript).digest('hex'),
  })
  assert.equal(result.verdict, 'UNKNOWN')
  assert.match(result.reason, /machine-captured Leaf console query evidence is unavailable/)
  ok('pasted transcript alone remains UNKNOWN even when its run metadata and values look complete')
}

console.log(`PASS clean-run gamerule report parser fixtures (${checks} checks)`)
