#!/usr/bin/env bun
// Fixture tests for run-scoped evidence selection.
// A runId on an arbitrary trailing event must not outrank the latest BOOT
// boundary, or a gate can silently evaluate the wrong run.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'run-artifacts-'))
process.env.MC_AI_ROOT = dir
const { artifactFreshness, buildChecks, buildManifest, newestRunIdFromLog, resolveMercuryRecords, resolveRunEvidence, windowOfRun } = await import('./run-artifacts.mjs')
let checks = 0

try {
  const log = join(dir, 'buddy.log')
  writeFileSync(
    log,
    [
      '[2026-09-19T00:00:00.000Z] BOOT pid=10 runId=run-old bundle=old',
      '[2026-09-19T00:00:01.000Z] EVENT runId=run-old',
      '[2026-09-19T00:01:00.000Z] BOOT pid=11 runId=run-new bundle=new',
      '[2026-09-19T00:01:01.000Z] LATE_EVENT runId=run-old',
      '[2026-09-19T00:01:02.000Z] unrelated runId=run-not-a-boot',
    ].join('\n') + '\n',
    'utf8',
  )
  assert.equal(await newestRunIdFromLog(log), 'run-new')
  checks++

  const noBoot = join(dir, 'no-boot.log')
  writeFileSync(noBoot, '[2026-09-19T00:02:00.000Z] EVENT runId=run-only-event\n', 'utf8')
  assert.equal(await newestRunIdFromLog(noBoot), null)
  checks++

  const currentRecord = {
    runId: 'run-current',
    listenerBaseline: {},
    listenerCurrent: {},
    listenerLeak: false,
    reconnects: 0,
    reloadsChangedHash: 5,
    wedge: false,
    goalComplete: false,
  }
  const metadata = buildChecks(currentRecord).find((check) => check.id === 'run_metadata_completeness')
  assert.equal(metadata?.compliance, 'UNKNOWN')
  assert.match(metadata?.observed ?? '', /serverVersion/)
  checks++

  const partialRecord = {
    ...currentRecord,
    serverVersion: 'Leaf 1.21.11',
    difficulty: 'peaceful',
    jevModel: 'typesafe-ai/jev',
  }
  const partialMetadata = buildChecks(partialRecord).find((check) => check.id === 'run_metadata_completeness')
  assert.equal(partialMetadata?.compliance, 'UNKNOWN')
  assert.match(partialMetadata?.observed ?? '', /mercuryModel/)
  assert.equal(buildManifest({ record: partialRecord, window: null, logLineCount: 0 }).models.mercury, null)
  checks++

  const mercuryModel = 'inception/mercury-2.5'
  const completeMetadata = buildChecks(partialRecord, mercuryModel).find((check) => check.id === 'run_metadata_completeness')
  assert.equal(completeMetadata?.compliance, 'PASS')
  assert.equal(buildManifest({ record: partialRecord, window: null, logLineCount: 0, mercuryModel }).models.mercury, mercuryModel)
  checks++

  const runtimeLog = join(dir, 'packages/buddy-driver', 'buddy.log')
  const sharedMercury = join(dir, 'packages/buddy-driver', 'logs', 'jev', 'mercury-calls.jsonl')
  mkdirSync(dirname(sharedMercury), { recursive: true })
  const activeLines = [
    '[2026-09-19T00:00:00.000Z] BOOT pid=10 runId=run-active bundle=active',
    '[2026-09-19T00:01:00.000Z] ACTIVE_EVENT runId=run-active',
    '[2026-09-19T00:02:00.000Z] CURRENT_EVENT runId=run-active',
  ]
  writeFileSync(runtimeLog, `${activeLines.join('\n')}\n`, 'utf8')
  writeFileSync(sharedMercury, `${JSON.stringify({ ts: '2026-09-19T00:02:00.000Z', callId: 'new-shared', retries: 0 })}\n`, 'utf8')
  const activeDir = join(dir, 'runs', 'run-active')
  mkdirSync(activeDir, { recursive: true })
  writeFileSync(join(activeDir, 'evidence.log'), 'OLD_ACTIVE_ARTIFACT\n', 'utf8')
  writeFileSync(
    join(activeDir, 'manifest.json'),
    JSON.stringify({ runId: 'run-active', window: { fromMs: Date.parse('2026-09-19T00:00:00.000Z'), toMs: Date.parse('2026-09-19T00:01:00.000Z'), startLine: 0, endLine: 2 } }),
    'utf8',
  )
  writeFileSync(join(activeDir, 'mercury-calls.jsonl'), `${JSON.stringify({ ts: '2026-09-19T00:01:00.000Z', callId: 'old-artifact', retries: 0 })}\n`, 'utf8')
  const activeWindow = await windowOfRun('run-active', { log: runtimeLog, collect: false })
  assert.equal(activeWindow.closed, false)
  const activeManifest = JSON.parse(await readFile(join(activeDir, 'manifest.json'), 'utf8'))
  assert.equal((await artifactFreshness('run-active', { log: runtimeLog, manifest: activeManifest })).usable, false)
  const activeEvidence = await resolveRunEvidence({ runId: 'run-active', log: runtimeLog })
  assert.equal(activeEvidence.source, 'run-slice-from-shared-log')
  assert.match(activeEvidence.text, /CURRENT_EVENT/)
  const activeMercury = await resolveMercuryRecords({ runId: 'run-active', log: runtimeLog, file: sharedMercury })
  assert.equal(activeMercury.source, 'run-slice-from-shared-jsonl')
  assert.equal(activeMercury.records[0]?.callId, 'new-shared')
  checks += 3

  const closedLines = [...activeLines, '[2026-09-19T00:10:00.000Z] BOOT pid=11 runId=run-closed bundle=closed', '[2026-09-19T00:11:00.000Z] CLOSED_EVENT runId=run-closed', '[2026-09-19T00:12:00.000Z] BOOT pid=12 runId=run-next bundle=next']
  writeFileSync(runtimeLog, `${closedLines.join('\n')}\n`, 'utf8')
  const closedDir = join(dir, 'runs', 'run-closed')
  mkdirSync(closedDir, { recursive: true })
  writeFileSync(join(closedDir, 'evidence.log'), 'CLOSED_ARTIFACT\n', 'utf8')
  writeFileSync(
    join(closedDir, 'manifest.json'),
    JSON.stringify({ runId: 'run-closed', window: { fromMs: Date.parse('2026-09-19T00:10:00.000Z'), toMs: Date.parse('2026-09-19T00:10:00.000Z'), startLine: 3, endLine: 4 } }),
    'utf8',
  )
  writeFileSync(join(closedDir, 'mercury-calls.jsonl'), `${JSON.stringify({ ts: '2026-09-19T00:10:30.000Z', callId: 'closed-artifact', retries: 0 })}\n`, 'utf8')
  const closedWindow = await windowOfRun('run-closed', { log: runtimeLog, collect: false })
  assert.equal(closedWindow.closed, true)
  const closedEvidence = await resolveRunEvidence({ runId: 'run-closed', log: runtimeLog })
  assert.equal(closedEvidence.source, 'run-artifact')
  assert.match(closedEvidence.text, /CLOSED_ARTIFACT/)
  const closedMercury = await resolveMercuryRecords({ runId: 'run-closed', log: runtimeLog, file: sharedMercury })
  assert.equal(closedMercury.source, 'run-artifact')
  assert.equal(closedMercury.records[0]?.callId, 'closed-artifact')
  checks += 3

  console.log(`run-artifacts: ${checks}/${checks} checks passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
