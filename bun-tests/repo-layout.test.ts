// Repo-level layout guard (monorepo Packages-by-Feature).
//
// Enforces the composition-surface invariant: production/test source lives in
// an owning package or the repository tooling dirs, never loose at the root.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const CODE_EXT = /\.(ts|mts|js|mjs|cjs)$/

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.includes('/mineflayer-src'))

const SOURCE_OWNERS = /^(packages|tools|bun-tests|ops)\//

function importSpecifiers(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) out.push(match[1]!)
  return out
}

describe('repo layout guard', () => {
  test('tracked source lives only in packages/, tools/, bun-tests/, ops/', () => {
    const stray = tracked.filter((file) => CODE_EXT.test(file) && !SOURCE_OWNERS.test(file))
    expect(stray).toEqual([])
  })

  test('packages/kernel stays a leaf: no imports outside its own package', () => {
    const kernelFiles = tracked.filter((file) => file.startsWith('packages/kernel/') && CODE_EXT.test(file))
    expect(kernelFiles.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of kernelFiles) {
      for (const spec of importSpecifiers(readFileSync(`${ROOT}${file}`, 'utf8'))) {
        if (!spec.startsWith('.') && !spec.startsWith('node:') && spec !== 'bun:test') violations.push(`${file} -> ${spec}`)
      }
    }
    assert.deepEqual(violations, [])
  })

  test('packages/mcp-server does not import sibling package internals', () => {
    const files = tracked.filter((file) => file.startsWith('packages/mcp-server/') && CODE_EXT.test(file))
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(`${ROOT}${file}`, 'utf8'))) {
        if (spec.startsWith('.') && spec.includes('..')) violations.push(`${file} -> ${spec}`)
      }
    }
    assert.deepEqual(violations, [])
  })

  test('root keeps only composition files (no stray tracked dirs outside the allowlist)', () => {
    const allowed = /^(packages|tools|bun-tests|ops|docs|runs|\.github|\.devin)\/|^[^/]+$/
    const stray = tracked.filter((file) => !allowed.test(file))
    expect(stray).toEqual([])
  })
})
