#!/usr/bin/env node
// Fixture tests for run-scoped evidence selection.
// A runId on an arbitrary trailing event must not outrank the latest BOOT
// boundary, or a gate can silently evaluate the wrong run.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildChecks, buildManifest, newestRunIdFromLog } from './run-artifacts.mjs'

const dir = mkdtempSync(join(tmpdir(), 'run-artifacts-'))
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

  console.log(`run-artifacts: ${checks}/${checks} checks passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
