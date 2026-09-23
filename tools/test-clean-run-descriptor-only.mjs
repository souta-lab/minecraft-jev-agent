#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCleanRunGate } from './clean-run-gate.mjs'

const toolsDir = dirname(fileURLToPath(import.meta.url))
const templatePath = join(toolsDir, 'fixtures', 'm3-clean-environment.json')
const tempRoot = mkdtempSync(join(tmpdir(), 'clean-run-descriptor-only-'))

try {
  const container = join(tempRoot, 'worlds')
  const evidenceDir = join(tempRoot, 'evidence')
  const descriptorPath = join(tempRoot, 'environment-resolved.json')
  const observedWorldPath = join(evidenceDir, 'gamerules-observed.json')
  const sourceSha = 'a'.repeat(40)
  const descriptor = JSON.parse(readFileSync(templatePath, 'utf8'))

  descriptor.cleanRun.worldContainer = container
  descriptor.cleanRun.sourceSha.state = 'FROZEN'
  descriptor.values.levelName = 'm3clean-descriptor-only'
  descriptor.values.levelSeed = '987654321123'
  descriptor.values.sourceSha = sourceSha

  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')
  writeFileSync(observedWorldPath, `${JSON.stringify({ worlds: { world: { levelName: 'world', randomSeed: '2024' } } })}\n`, 'utf8')

  const verdict = await runCleanRunGate({
    environment: descriptorPath,
    worldContainer: container,
    observedWorldPath,
    root: resolve(tempRoot),
  })

  assert.equal(verdict.descriptor.status, 'CLEAN', `descriptor status=${verdict.descriptor.status}`)
  assert.equal(verdict.status, 'CLEAN', `premise status=${verdict.status} failed=${verdict.failed.join(',')}`)
  assert.equal(verdict.acceptanceStatus, 'UNKNOWN', 'descriptor-only judgement must never claim an M3 acceptance')

  for (const id of ['run.cleanFrozenCheckout', 'run.exactFrozenSourceSha', 'run.sourceWindowExact']) {
    const row = verdict.conditions.find((entry) => entry.id === id)
    assert.ok(row, `missing condition ${id}`)
    assert.equal(row.verdict, 'UNKNOWN', `${id} should remain visible as unknown without run evidence`)
    assert.equal(row.required, false, `${id} must not gate a descriptor-only judgement`)
  }

  const observedTarget = verdict.conditions.find((entry) => entry.id === 'world.observedTargetAbsent')
  assert.ok(observedTarget, 'descriptor-only judgement should retain the optional target-world observation')
  assert.equal(observedTarget.verdict, 'PASS', observedTarget.reason)

  const runEvidence = verdict.conditions.find((entry) => entry.id === 'run.evidence')
  assert.equal(runEvidence?.verdict, 'UNKNOWN')
  assert.equal(runEvidence?.required, false)

  const missingArtifactVerdict = await runCleanRunGate({
    environment: descriptorPath,
    artifactPath: join(tempRoot, 'missing-artifact.json'),
    worldContainer: container,
    root: resolve(tempRoot),
  })
  assert.equal(missingArtifactVerdict.status, 'UNKNOWN', 'a supplied but unreadable artifact must not be treated as descriptor-only')
  for (const id of ['run.cleanFrozenCheckout', 'run.exactFrozenSourceSha', 'run.sourceWindowExact']) {
    const row = missingArtifactVerdict.conditions.find((entry) => entry.id === id)
    assert.equal(row?.required, true, `${id} must remain required when an artifact path was supplied`)
  }
  console.log('PASS descriptor-only stays CLEAN; supplied unreadable run evidence remains UNKNOWN')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
