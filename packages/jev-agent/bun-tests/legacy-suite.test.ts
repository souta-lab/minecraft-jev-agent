import { test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const PACKAGE_ROOT = resolve(import.meta.dir, '..')

async function runFixture(file: string): Promise<void> {
  const child = Bun.spawn([process.execPath, 'test', '--timeout=120000', `./${file}`], {
    cwd: PACKAGE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`${file} exited ${exitCode}\n${stdout}\n${stderr}`)
  }
}

const fixtures = [
  ...readdirSync(PACKAGE_ROOT).filter((file) => /^test-.*\.mts$/.test(file)),
  'data/step-pipeline-test.mts',
  'data/step-cut-test.mts',
]
  .filter((file) => file !== 'test-pillar-takeoff-evidence.mts')
  .sort()

for (const file of fixtures) {
  // The child owns the same 120 s budget. Give the parent wrapper that budget too;
  // otherwise Bun's 5 s default kills healthy long-running fixtures first.
  test(`Bun fixture: ${file}`, async () => runFixture(file), 120_000)
}
