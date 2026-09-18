import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const helper = join(repoRoot, 'tools', 'sync-shared-tree.mjs')
const fixture = mkdtempSync(join(tmpdir(), 'sync-shared-tree-'))
const remote = join(fixture, 'remote.git')
const upstream = join(fixture, 'upstream')
const shared = join(fixture, 'shared')

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function runHelper(cwd) {
  return execFileSync(process.execPath, [helper], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

try {
  runGit(fixture, ['init', '--bare', remote])
  runGit(fixture, ['init', '-b', 'main', upstream])
  runGit(upstream, ['config', 'user.email', 'test@example.invalid'])
  runGit(upstream, ['config', 'user.name', 'Sync Test'])
  writeFileSync(join(upstream, 'state.txt'), 'initial\n')
  runGit(upstream, ['add', 'state.txt'])
  runGit(upstream, ['commit', '-m', 'initial'])
  runGit(upstream, ['remote', 'add', 'origin', remote])
  runGit(upstream, ['push', '-u', 'origin', 'main'])

  runGit(fixture, ['clone', '--branch', 'main', remote, shared])
  runGit(shared, ['switch', '-c', 'task/example'])
  const strayHead = runGit(shared, ['rev-parse', 'HEAD'])
  let wrongHeadError
  try {
    runHelper(shared)
  } catch (error) {
    wrongHeadError = error
  }
  assert.equal(wrongHeadError?.status, 1)
  assert.match(wrongHeadError?.stderr ?? '', /SYNC_HEAD_WRONG head=task\/example/)
  assert.equal(runGit(shared, ['symbolic-ref', '--short', 'HEAD']), 'task/example')
  assert.equal(runGit(shared, ['rev-parse', 'HEAD']), strayHead)

  writeFileSync(join(upstream, 'state.txt'), 'updated\n')
  runGit(upstream, ['commit', '-am', 'advance main'])
  runGit(upstream, ['push', 'origin', 'main'])
  runGit(shared, ['switch', 'main'])
  const output = runHelper(shared)
  assert.match(output, /SYNC_OK head=main target=[0-9a-f]{40}/)
  assert.equal(runGit(shared, ['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(runGit(shared, ['rev-parse', 'HEAD']), runGit(upstream, ['rev-parse', 'main']))
  console.log('sync-shared-tree: 2/2 checks passed')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
