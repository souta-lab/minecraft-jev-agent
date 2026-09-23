#!/usr/bin/env bun
// Focused offline fixtures for clean-run exact source provenance.
// No Minecraft server, resident, network, or live evidence is used.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCleanRunGate } from './clean-run-gate.mjs'

const TEMPLATE = new URL('./fixtures/m3-clean-environment.json', import.meta.url)
const SOURCE_SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const RUN_ID = 'run-source-provenance-fixture'
const DIFFERENT_SHA = 'bb22cc33dd44ee55ff6677889900aabbccddeeff'
let checks = 0

function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

function makeArtifact(runId = RUN_ID, sourceSha = SOURCE_SHA) {
  return {
    record: 'milestone-run-artifact',
    schemaVersion: 4,
    runId,
    status: 'UNKNOWN',
    complete: false,
    run: {
      runId,
      boot: { sourceSha },
      source: {
        bootSourceSha: sourceSha,
        provenance: 'boot',
        effectiveSourceSha: sourceSha,
        effectiveSourceShaKind: 'git-commit-sha',
        reloadCount: 0,
        sourceChangeCount: 0,
        observed: [],
        latestSourceReload: null,
        window: { status: 'valid', runId, bootLineIndex: 0, scannedToEof: true },
        windowBlind: { detected: false, reasons: [] },
        crossCheck: { queried: false, agrees: null },
        disagreements: [],
      },
    },
    sources: { logPath: null },
  }
}

function makeReloadArtifact(runId = RUN_ID, bootSha = SOURCE_SHA, reloadSha = bootSha) {
  const artifact = makeArtifact(runId, bootSha)
  const marker = {
    hash: 'e6be1812c804',
    sourceSha: reloadSha,
    trigger: 'source-changed',
    lineIndex: 8,
    ok: true,
    kind: 'source-change',
    applied: true,
    appliedBy: 'reload-commit',
  }
  Object.assign(artifact.run.source, {
    provenance: 'reload',
    effectiveSourceSha: marker.hash,
    effectiveSourceShaKind: 'generation-bundle-hash',
    reloadCount: 1,
    sourceChangeCount: 1,
    observed: [marker],
    latestSourceReload: marker,
    window: { status: 'valid', runId, bootLineIndex: 0, scannedToEof: true },
  })
  return artifact
}

function makeCase(name, { runId = RUN_ID, bundleRunId = runId, sourceSha = SOURCE_SHA, dirty = false, artifact = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), `clean-run-source-${name}-`))
  const environmentPath = join(root, 'environment.json')
  const bundleDir = join(root, 'bundle')
  const container = join(root, 'worlds')
  mkdirSync(bundleDir, { recursive: true })
  mkdirSync(container, { recursive: true })

  const environment = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  environment.values.levelName = `m3clean-${name}`
  environment.values.levelSeed = '-4187923615481'
  environment.values.sourceSha = sourceSha
  environment.cleanRun.sourceSha.state = 'FROZEN'
  environment.cleanRun.worldContainer = container
  writeFileSync(environmentPath, `${JSON.stringify(environment, null, 2)}\n`)

  const runArtifact = artifact ?? makeArtifact(runId, sourceSha)
  const bundle = {
    record: 'm3-acceptance-bundle',
    runId: bundleRunId,
    git: { head: sourceSha, dirty },
    artifact: { document: runArtifact },
    acceptanceVerdict: { status: 'PASS' },
    liveAcceptance: false,
    evidenceClass: 'fixture',
    gate: { status: 'PASS', reason: null },
    residual: [],
  }
  writeFileSync(join(bundleDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`)
  return { root, environmentPath, bundleDir, runArtifact }
}

async function judge(name, options = {}, requestedRunId = RUN_ID) {
  const fixture = makeCase(name, options)
  try {
    return await runCleanRunGate({
      environment: fixture.environmentPath,
      bundleDir: fixture.bundleDir,
      runId: requestedRunId,
      root: fixture.root,
    })
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

const row = (verdict, id) => verdict.conditions.find((entry) => entry.id === id) ?? null

// 1. Exact descriptor pin, clean checkout, BOOT, source origin, and current run bind.
{
  const verdict = await judge('matching')
  for (const id of ['run.cleanFrozenCheckout', 'run.exactFrozenSourceSha', 'run.sourceWindowExact']) {
    assert.equal(row(verdict, id)?.verdict, 'PASS', `${id}: ${row(verdict, id)?.reason}`)
  }
  ok('matching frozen SHA + clean git + complete current-run source window PASS')
}

// 2. A dirty checkout is an explicit failure even when every SHA agrees.
{
  const verdict = await judge('dirty', { dirty: true })
  assert.equal(row(verdict, 'run.cleanFrozenCheckout')?.verdict, 'FAIL')
  assert.notEqual(verdict.acceptanceStatus, 'ACCEPTED')
  ok('dirty checkout FAILs source-clean acceptance')
}

// 3. Missing/malformed provenance stays UNKNOWN rather than inheriting PASS.
{
  const artifact = makeArtifact()
  artifact.run.source.window.status = 'unknown'
  const verdict = await judge('missing', { dirty: null, artifact })
  assert.equal(row(verdict, 'run.cleanFrozenCheckout')?.verdict, 'UNKNOWN')
  assert.equal(row(verdict, 'run.sourceWindowExact')?.verdict, 'UNKNOWN')
  assert.notEqual(verdict.acceptanceStatus, 'ACCEPTED')
  ok('missing dirty status and malformed source window remain UNKNOWN')
}

// 4. An applied reload built from another commit invalidates exact provenance.
{
  const artifact = makeReloadArtifact(RUN_ID, SOURCE_SHA, DIFFERENT_SHA)
  const verdict = await judge('mixed', { artifact })
  assert.equal(row(verdict, 'run.sourceWindowExact')?.verdict, 'FAIL')
  assert.match(row(verdict, 'run.sourceWindowExact')?.reason ?? '', /differs from BOOT sourceSha/)
  assert.notEqual(verdict.acceptanceStatus, 'ACCEPTED')
  ok('applied reload with mismatched source SHA FAILs')
}

// 5. Evidence scoped to another requested runId cannot pass the source window.
{
  const verdict = await judge('run-mismatch', {}, 'run-requested-different')
  assert.equal(row(verdict, 'run.sourceWindowExact')?.verdict, 'FAIL')
  assert.equal(row(verdict, 'run.scope')?.verdict, 'FAIL')
  assert.notEqual(verdict.acceptanceStatus, 'ACCEPTED')
  ok('requested runId mismatch FAILs run and source-window scope')
}

// 6. The bundle wrapper's own runId must agree with both the request and artifact.
{
  const verdict = await judge('bundle-run-mismatch', { bundleRunId: 'run-wrapper-different' })
  assert.equal(row(verdict, 'run.sourceWindowExact')?.verdict, 'FAIL')
  assert.match(row(verdict, 'run.sourceWindowExact')?.reason ?? '', /bundle runId=.*differs from requested runId/)
  assert.notEqual(verdict.acceptanceStatus, 'ACCEPTED')
  ok('bundle wrapper runId mismatch FAILs source-window scope')
}

console.log(`PASS clean-run source provenance fixtures (${checks} checks)`)
