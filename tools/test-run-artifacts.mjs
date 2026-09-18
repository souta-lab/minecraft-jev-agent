#!/usr/bin/env node
// Fixture tests for run-scoped evidence selection.
// A runId on an arbitrary trailing event must not outrank the latest BOOT
// boundary, or a gate can silently evaluate the wrong run.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newestRunIdFromLog } from './run-artifacts.mjs'

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

  console.log(`run-artifacts: ${checks}/${checks} checks passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
