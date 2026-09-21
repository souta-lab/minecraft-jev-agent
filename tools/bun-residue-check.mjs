#!/usr/bin/env bun
// Repository-level Bun migration invariant.
// `node:` compatibility imports are intentionally allowed: Bun implements
// those modules and Mineflayer's public API still exposes them. This gate
// rejects executable/package-manager residue instead.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const runtime = ['n', 'o', 'd', 'e'].join('')
const packageManager = ['n', 'p', 'm'].join('')
const launcher = ['n', 'p', 'x'].join('')
const typeRunner = ['t', 's', 'x'].join('')
const lockName = ['package', '-lock.json'].join('')
const packageManagerPattern = new RegExp('\\b' + packageManager + '\\b|\\b' + launcher + '\\b|\\b' + typeRunner + '\\b')
const executableMarkers = [
  `${runtime} tools/`,
  `${runtime} scripts/`,
  `${runtime} launch/`,
  `${runtime} buddy-driver/`,
  `${runtime} jev-agent/`,
  `${runtime} mcbot/`,
  `${runtime} src/`,
  `${runtime} test/`,
  `${runtime} bench`,
  `${runtime} probe`,
  `${runtime} vertical`,
  `${runtime} region-read`,
  `${runtime} bot.mjs`,
  `${runtime} buddy.cjs`,
  `${runtime} m2.mts`,
  `${runtime} m1.mts`,
  `${runtime} demo.mts`,
  `${runtime} --test`,
  `${runtime} --check`,
]

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.includes('/mineflayer-src'))

const findings = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (file.endsWith(lockName)) findings.push(`${file}: tracked ${lockName}`)
  if (packageManagerPattern.test(text)) findings.push(`${file}: legacy package/runtime token`)
  if (executableMarkers.some((marker) => text.includes(marker))) findings.push(`${file}: legacy executable command`)
  if (text.includes('#!/usr/bin/env ' + runtime)) findings.push(`${file}: legacy executable shebang`)
}

if (findings.length > 0) {
  process.stderr.write(`BUN_RESIDUE_CHECK FAIL findings=${findings.length}\n${findings.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(`BUN_RESIDUE_CHECK PASS trackedFiles=${files.length} nodeCompatibilityImports=allowed\n`)
