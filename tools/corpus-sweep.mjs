#!/usr/bin/env bun
// Canonical whole-corpus sweep for the offline test-*.mts corpus.
//
// Usage:  bun tools/corpus-sweep.mjs [--out <path>] [--root <worktreeRoot>]
//
// Canonical invocation per file (the form the other lanes use):
//   * a file that imports `bun:test`  -> `bun test ./test-x.mts`  (cwd = package dir)
//   * every other file                -> `bun ./test-x.mts`       (cwd = package dir)
//
// A BARE path with `bun test` from the worktree root does NOT run the file, so
// the runner always cds into the owning package directory and always prefixes
// the relative path with `./`.
//
// Output: one JSONL record per test file + a summary. The record carries the
// exit code and the file's own terminal verdict, so a branch sweep can be
// diffed against a pristine baseline record-for-record.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
function argOf(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const root = resolve(argOf('--root', process.cwd()))
const out = resolve(argOf('--out', join(root, 'corpus-sweep.jsonl')))
const packages = ['packages/jev-agent', 'packages/buddy-driver']
const timeoutMs = Number(argOf('--timeout-ms', '900000'))

const records = []
let passed = 0
let failed = 0

for (const pkg of packages) {
  const packageDir = join(root, pkg)
  if (!existsSync(packageDir)) continue
  const files = readdirSync(packageDir)
    .filter((name) => name.startsWith('test-') && name.endsWith('.mts'))
    .sort()

  for (const file of files) {
    const absolute = join(packageDir, file)
    const source = readFileSync(absolute, 'utf8')
    const usesBunTest = /from\s+['"]bun:test['"]|require\(\s*['"]bun:test['"]\s*\)/.test(source)
    const args = usesBunTest ? ['test', `./${file}`] : [`./${file}`]
    const started = Date.now()
    const run = spawnSync('bun', args, {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      maxBuffer: 64 * 1024 * 1024,
    })
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    const code = run.status === null ? 124 : run.status
    // A file is green when the runner exit code is 0. The declared verdict below
    // is diagnostic only: some files print a trailing banner of their own.
    const declaredPass = /(^|\n)\s*PASS\b/.test(output)
    const declaredFail = /(^|\n)\s*FAIL\b|FAILURE\(S\)|^\s*\d+ fail/m.test(output)
    const record = {
      file: `${pkg}/${file}`,
      command: `cd ${pkg} && bun ${args.join(' ')}`,
      runner: usesBunTest ? 'bun test' : 'bun',
      exitCode: code,
      ok: code === 0,
      declaredPass,
      declaredFail,
      ms: Date.now() - started,
    }
    if (code === 0) passed += 1
    else failed += 1
    if (code !== 0) {
      const tail = output.split('\n').filter((line) => /FAIL|Error|error:|Expected|Received/.test(line))
      record.evidence = tail.slice(0, 12)
    }
    records.push(record)
    process.stdout.write(`${code === 0 ? 'ok  ' : 'FAIL'} ${record.file} (${record.ms}ms)\n`)
  }
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

const failures = records.filter((record) => !record.ok)
console.log(`\n=== corpus sweep: ${records.length} files, ${passed} ok, ${failed} failed`)
console.log(`base sha: ${spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()}`)
console.log(`records: ${out}`)
for (const record of failures) console.log(`  FAIL ${record.file} exit=${record.exitCode}`)
