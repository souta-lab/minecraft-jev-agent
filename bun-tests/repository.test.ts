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
const SUITE_OPTIONS = { timeout: 120_000 }

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
