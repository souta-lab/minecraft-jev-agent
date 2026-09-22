import { test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

async function runBun(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`${args.join(' ')} exited ${exitCode}\n${stdout}\n${stderr}`)
  }
}

const TEST_ARGS = ['test', '--timeout=120000', '--max-concurrency=1']
// The jev-agent suite is the long pole: measured 141 s on the walk-skill branch and
// 148 s on clean main (all fixtures passing), so the old 120 s budget was a
// pre-existing known-red rather than a hang. Raised with margin so the gate reports
// real failures instead of timing out a passing suite.
const SUITE_OPTIONS = { timeout: 300_000 }

test('jev-agent Bun suite', async () => runBun(resolve(ROOT, 'jev-agent'), TEST_ARGS), SUITE_OPTIONS)
test('buddy-driver Bun suite', async () => runBun(resolve(ROOT, 'buddy-driver'), TEST_ARGS), SUITE_OPTIONS)
test('Bedrock MCP companion imports under Bun', async () => {
  await runBun(ROOT, [
    '-e',
    "const { McBot } = require('./src/bot.js'); if (typeof McBot !== 'function') throw new Error('McBot export missing')",
  ])
})

const toolFixtures = readdirSync(resolve(ROOT, 'tools'))
  .filter((file) => /^test-.*\.mjs$/.test(file))
  .sort()

for (const file of toolFixtures) {
  test(`Bun tool fixture: ${file}`, async () => runBun(ROOT, [`tools/${file}`]))
}
