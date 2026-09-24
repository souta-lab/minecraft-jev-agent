#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunnerOutput, runCli } from './clean-run-runner-output.mjs'

const roots = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clean-run-runner-output-'))
  roots.push(root)
  const driverDir = join(root, 'buddy-driver')
  mkdirSync(driverDir)
  mkdirSync(join(driverDir, 'data', 'resident'), { recursive: true })
  return { root, driverDir, outputPath: join(driverDir, 'runner.out'), hostLockPath: join(driverDir, 'data', 'resident', 'host.lock'), controlSocketPath: join(driverDir, 'data', 'resident', 'control.sock') }
}

{
  const paths = fixture()
  const result = createRunnerOutput(paths, { isResidentServiceActive: () => false })
  assert.equal(result.status, 'CREATED')
  assert.equal(readFileSync(paths.outputPath, 'utf8'), '')
  assert.equal(statSync(paths.outputPath).mode & 0o777, 0o600)
  assert.throws(() => createRunnerOutput(paths, { isResidentServiceActive: () => true }), /service is active/)
  assert.equal(readFileSync(paths.outputPath, 'utf8'), '', 'a second invocation preserves the existing artifact')
  console.log('  ok - creates an empty 0600 runner.out exclusively and refuses stale evidence')
}

{
  const paths = fixture()
  const oldContents = 'BOOT old-run source=historical\n'.repeat(3)
  writeFileSync(paths.outputPath, oldContents, { mode: 0o600 })
  const result = createRunnerOutput(paths, { isResidentServiceActive: () => false })
  assert.equal(result.status, 'ARCHIVED_AND_CREATED')
  assert.equal(readFileSync(result.archivedPath, 'utf8'), oldContents, 'archive preserves every byte of old authority output')
  assert.equal(lstatSync(result.archivedPath).mode & 0o777, 0o400, 'archive becomes owner-read-only')
  assert.equal(readFileSync(paths.outputPath, 'utf8'), '')
  assert.equal(statSync(paths.outputPath).mode & 0o777, 0o600)
  console.log('  ok - safely archives existing regular single-link output and creates a fresh 0600 file')
}

{
  const paths = fixture()
  writeFileSync(paths.outputPath, 'preserve\n', { mode: 0o600 })
  assert.throws(() => createRunnerOutput(paths, { isResidentServiceActive: () => true }), /service is active/)
  assert.equal(readFileSync(paths.outputPath, 'utf8'), 'preserve\n')
  writeFileSync(paths.hostLockPath, '{"pid":1}\n', { mode: 0o600 })
  assert.throws(() => createRunnerOutput(paths, { isResidentServiceActive: () => false }), /host\.lock or control\.sock exists/)
  assert.equal(readFileSync(paths.outputPath, 'utf8'), 'preserve\n')
  console.log('  ok - refuses rotation while the resident unit or host lock is active')
}

{
  const paths = fixture()
  const outside = join(paths.root, 'outside.log')
  writeFileSync(outside, 'protected\n')
  symlinkSync(outside, paths.outputPath)
  assert.throws(() => createRunnerOutput(paths, { isResidentServiceActive: () => false }), /non-regular runner\.out/)
  assert.equal(readFileSync(outside, 'utf8'), 'protected\n')
  console.log('  ok - refuses symlinked output without following it')
}

{
  const paths = fixture()
  const outside = join(paths.root, 'outside.log')
  writeFileSync(outside, 'shared\n', { mode: 0o600 })
  linkSync(outside, paths.outputPath)
  assert.throws(() => createRunnerOutput(paths, { isResidentServiceActive: () => false }), /hard-linked runner\.out/)
  assert.equal(readFileSync(outside, 'utf8'), 'shared\n')
  assert.equal(statSync(outside).nlink, 2)
  console.log('  ok - refuses hard-linked output without changing its shared target')
}

{
  const paths = fixture()
  let stdout = ''
  let stderr = ''
  const status = runCli({ argv: ['--root', paths.root], write: (value) => { stdout += value }, writeError: (value) => { stderr += value }, isResidentServiceActive: () => false })
  assert.equal(status, 0)
  assert.match(stdout, /CLEAN_RUN_RUNNER_OUTPUT status=CREATED/)
  assert.equal(stderr, '')
  console.log('  ok - CLI creates the exact root/buddy-driver/runner.out location')
}

for (const root of roots) rmSync(root, { recursive: true, force: true })
console.log('test-clean-run-runner-output: 6 checks passed')
