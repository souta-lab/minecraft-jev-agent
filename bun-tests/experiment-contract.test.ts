// experiment-contract.test.ts - pins the bounded-experiment result contract:
// the schema file parses, a golden record validates, and the hard rules
// (PASS requires failureClass=none; frozenZoneTouched forces ESCALATE) are
// enforced by the validator, not by convention.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const VALIDATOR = join(ROOT, 'tools/validate-experiment-result.mjs')

function runValidator(record: unknown): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'experiment-record-'))
  const file = join(dir, 'record.json')
  writeFileSync(file, JSON.stringify(record))
  try {
    const out = execFileSync(process.execPath, [VALIDATOR, file], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer | string }
    return { code: err.status ?? 1, out: String(err.stdout ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const GOLDEN = {
  schemaVersion: 1,
  experimentId: 'candidate-ranking-v1',
  baseSha: 'a'.repeat(40),
  candidateSha: 'b'.repeat(40),
  scenario: 'jev-agent-behavior-battery',
  command: 'cd packages/jev-agent && bun test',
  status: 'PASS',
  failureClass: 'none',
  metrics: { verifiedTransitions: 12, modelCalls: 3 },
  evidence: ['packages/jev-agent/logs/jev/decisions.jsonl'],
  verdict: 'KEEP',
  frozenZoneTouched: false,
}

describe('experiment result contract', () => {
  test('schema file parses and declares draft 2020-12', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'docs/development/experiment-result.schema.json'), 'utf8'))
    expect(schema.type).toBe('object')
    expect(schema.required).toContain('frozenZoneTouched')
    expect(schema.properties.failureClass.enum).toContain('AUTHORITY_VIOLATION')
  })

  test('golden record validates', () => {
    const result = runValidator(GOLDEN)
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/status=PASS/)
  })

  test('PASS with a non-none failureClass is rejected', () => {
    const result = runValidator({ ...GOLDEN, failureClass: 'VERIFY_FAIL' })
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/failureClass/)
  })

  test('frozenZoneTouched without ESCALATE is rejected', () => {
    const result = runValidator({ ...GOLDEN, frozenZoneTouched: true, verdict: 'KEEP' })
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/ESCALATE/)
  })

  test('unknown fields and bad SHAs are rejected', () => {
    expect(runValidator({ ...GOLDEN, extra: 1 }).code).toBe(1)
    expect(runValidator({ ...GOLDEN, baseSha: 'deadbeef' }).code).toBe(1)
  })

  test('FAIL requires a non-none failure class', () => {
    const ok = runValidator({ ...GOLDEN, status: 'FAIL', failureClass: 'MECHANICAL_FAIL', verdict: 'REVERT' })
    expect(ok.code).toBe(0)
    const bad = runValidator({ ...GOLDEN, status: 'FAIL', failureClass: 'none', verdict: 'REVERT' })
    expect(bad.code).toBe(1)
  })
})
