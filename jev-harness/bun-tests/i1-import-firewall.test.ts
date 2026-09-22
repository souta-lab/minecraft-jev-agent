// I1 - the import firewall fails CI (not just documentation).
//
// Evidence that the test can FAIL (not merely pass vacuously): the negative
// fixture below writes a violating production file into a temp root and asserts
// the scanner reports it with file:line.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  FIREWALL_DEBT,
  FIREWALL_PATTERNS,
  checkFirewall,
  checkHarnessIsolation,
  formatFinding,
  listProductionFiles,
  scanImportFirewall,
  stripComments,
} from '../tools/firewall.ts'

const ROOT = resolve(import.meta.dir, '..', '..')

describe('#438 section 22 I1 - no direct Jev/provider access outside the harness', () => {
  const report = checkFirewall(ROOT)

  test('the live tree has no NEW offender (debt allowlist may only shrink)', () => {
    const detail = report.violations.map(formatFinding).join('\n')
    expect(detail).toBe('')
    expect(report.ok).toBe(true)
  })

  test('no harness file imports the provider primitive outside providers/**', () => {
    expect(report.harnessViolations.map(formatFinding).join('\n')).toBe('')
  })

  test('every debt entry still has a finding, so the allowlist is a real ratchet', () => {
    expect(report.cleared.map((entry) => entry.file)).toEqual([])
  })

  test('the debt allowlist is exactly the Phase A inventory of five call sites', () => {
    expect(FIREWALL_DEBT.map((entry) => entry.file).sort()).toEqual([
      'buddy-driver/advisor.ts',
      'buddy-driver/planner-legacy.ts',
      'buddy-driver/planner.ts',
      'jev-agent/src/jev-authority.ts',
      'jev-agent/src/jev-legacy.ts',
    ])
  })

  test('a new violating production file fails with file:line', () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-firewall-'))
    mkdirSync(join(root, 'jev-agent', 'src'), { recursive: true })
    writeFileSync(
      join(root, 'jev-agent', 'src', 'rogue.ts'),
      "import { experimental_evaluate as evaluate } from 'ai'\nconst q = await evaluate({})\n",
    )
    const fixtureReport = checkFirewall(root)
    expect(fixtureReport.ok).toBe(false)
    const violation = fixtureReport.violations[0]
    expect(violation).toBeDefined()
    expect(violation?.file).toBe('jev-agent/src/rogue.ts')
    expect(violation?.line).toBe(1)
    expect(formatFinding(violation!)).toContain('jev-agent/src/rogue.ts:1')
  })

  test('a violating file inside the harness is never acceptable', () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-firewall-'))
    mkdirSync(join(root, 'jev-harness'), { recursive: true })
    writeFileSync(join(root, 'jev-harness', 'sneaky.ts'), "export const x = 'experimental_evaluate'\n")
    const fixtureReport = checkFirewall(root)
    expect(fixtureReport.harnessViolations.length).toBeGreaterThan(0)
    expect(fixtureReport.ok).toBe(false)
  })

  test('debt clearing is detected (allowlist cannot outlive the debt)', () => {
    const root = mkdtempSync(join(tmpdir(), 'jev-firewall-'))
    mkdirSync(join(root, 'buddy-driver'), { recursive: true })
    // The production tree is nearly empty, so every debt entry is "cleared".
    const fixtureReport = checkFirewall(root)
    expect(fixtureReport.cleared.length).toBe(FIREWALL_DEBT.length)
    expect(fixtureReport.ok).toBe(false)
  })

  test('prose mentioning the provider does not count (comments are stripped)', () => {
    expect(stripComments('// experimental_evaluate lives here\nconst x = 1\n')).not.toContain('experimental_evaluate')
    expect(stripComments('/* providerMetadata.confidence */\nconst x = 1\n')).not.toContain('providerMetadata')
    expect(stripComments("const s = 'experimental_evaluate'\n")).toContain('experimental_evaluate')
  })

  test('the scanner covers the five production roots and skips fixtures', () => {
    const files = listProductionFiles(ROOT)
    expect(files).toContain('jev-agent/src/jev-authority.ts')
    expect(files).toContain('buddy-driver/planner.ts')
    expect(files.some((file) => file.startsWith('buddy-driver/data/'))).toBe(false)
    expect(files.some((file) => file.includes('node_modules'))).toBe(false)
    expect(files.some((file) => /(^|\/)test-.*\.mts$/.test(file))).toBe(false)
  })

  test('every firewall pattern is documented with a migration phase', () => {
    for (const pattern of FIREWALL_PATTERNS) {
      expect(pattern.rationale.length).toBeGreaterThan(10)
      expect(['C', 'D', 'E', 'F']).toContain(pattern.migrationPhase)
    }
  })

  test('the firewall only reports the provider primitive, not System2 generateText usage', () => {
    const findings = scanImportFirewall(ROOT)
    const files = new Set(findings.map((finding) => finding.file))
    // buddy-driver/mercury-system2.ts uses `generateText` from 'ai' for the WHAT
    // layer; that is NOT the Jev primitive and must not be flagged.
    expect(files.has('buddy-driver/mercury-system2.ts')).toBe(false)
  })
})

describe('#438 section 22 I10 - provider adapter cannot reach gameplay/runtime objects', () => {
  const violations = checkHarnessIsolation({ root: ROOT })

  test('no harness module imports gameplay/planner/runtime modules', () => {
    expect(violations.map((violation) => `${violation.file}:${violation.line} ${violation.reason}`).join('\n')).toBe('')
  })

  test('only providers/** imports the provider SDK', () => {
    const providerImports = violations.filter((violation) => violation.reason.includes('provider SDK'))
    expect(providerImports).toEqual([])
  })
})
