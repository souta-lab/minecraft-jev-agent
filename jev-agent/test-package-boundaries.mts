// test-package-boundaries.mts — Packages-by-Feature dependency guard.
//
// Static scan of every `from '...'` edge under `src/`. Encodes the canonical
// direction matrix from TYPESCRIPT-PACKAGE-ARCHITECTURE.md so boundary
// violations fail mechanically instead of being rediscovered by review.
//
// Package owners (shallow, feature-oriented):
//   reach/     Reach feature domain (ports, projection, runtime, plane)
//   minecraft/ backend implementations behind consumer-owned ports
//   legacy/    quarantine for transitional controller-extracted planes
//   vtr/       cross-feature authority/lifecycle mechanisms (may be absent)
//   flat       src/*.ts transitional modules awaiting a canonical address
//
// Direction matrix (forbidden edges):
//   reach     -> minecraft, legacy   (feature must not see the impl or quarantine)
//   vtr       -> reach, minecraft, legacy, flat   (cross-feature owns nothing outside vtr/)
//   minecraft -> legacy              (backend impl never enters quarantine)
//   legacy    -> minecraft           (quarantine never sees backend impl)
//
// Raw backend (mineflayer / Bot / this.bot) may appear only in the flat
// transitional layer and the minecraft/ adapter allowlist — never in
// canonical packages (reach/, vtr/) or quarantined domain logic.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'bun:test'

type Owner = 'reach' | 'minecraft' | 'legacy' | 'vtr' | 'flat'

const PACKAGE_DIRS: readonly Owner[] = ['reach', 'minecraft', 'legacy', 'vtr']

const FORBIDDEN: Readonly<Record<string, readonly Owner[]>> = {
  reach: ['minecraft', 'legacy'],
  vtr: ['reach', 'minecraft', 'legacy', 'flat'],
  minecraft: ['legacy'],
  legacy: ['minecraft'],
}

/** Flat transitional modules allowed to touch the raw backend. */
const RAW_BACKEND_ALLOWLIST = new Set([
  'controller-legacy.ts',
  'controller.ts',
  'craftWindow.ts',
  'executor.ts',
  'index.ts',
  'scheduler.ts',
  'state.ts',
])

function srcFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(new URL(`./src/${prefix}`, import.meta.url))) return
    for (const entry of readdirSync(new URL(`./src/${prefix}`, import.meta.url), { withFileTypes: true })) {
      const rel = prefix + entry.name
      if (entry.isDirectory()) walk(dir, rel + '/')
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('./src/', '')
  return out
}

function ownerOf(rel: string): Owner {
  for (const dir of PACKAGE_DIRS) {
    if (rel.startsWith(`${dir}/`)) return dir
  }
  return 'flat'
}

function resolveImport(fromRel: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const parts = fromRel.split('/')
  parts.pop()
  for (const seg of specifier.split('/')) {
    if (seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const joined = parts.join('/')
  // Imports resolve only inside src/ for this guard; ../architecture is kernel source.
  return joined.startsWith('../') || joined.startsWith('./') ? joined : joined
}

function importsOf(rel: string, source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) out.push(match[1])
  return out
}

describe('Packages-by-Feature dependency guard', () => {
  const files = srcFiles()

  it('forbids cross-package edges outside the direction matrix', () => {
    const violations: string[] = []
    for (const rel of files) {
      const owner = ownerOf(rel)
      const forbidden = FORBIDDEN[owner]
      if (forbidden === undefined || forbidden.length === 0) continue
      const source = readFileSync(new URL(`./src/${rel}`, import.meta.url), 'utf8')
      for (const specifier of importsOf(rel, source)) {
        if (!specifier.startsWith('.')) continue
        const target = resolveImport(rel, specifier)
        const targetOwner = ownerOf(target)
        if (forbidden.includes(targetOwner)) {
          violations.push(`${rel} -> ${specifier} (owner ${owner} may not import ${targetOwner})`)
        }
      }
    }
    assert.deepEqual(violations, [])
  })

  it('keeps raw Mineflayer out of canonical packages and non-allowlisted code', () => {
    const violations: string[] = []
    for (const rel of files) {
      const owner = ownerOf(rel)
      const source = readFileSync(new URL(`./src/${rel}`, import.meta.url), 'utf8')
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '')
      // Quarantine rule: legacy Host interfaces may carry `import type { Bot }`
      // while they are being narrowed; value imports and live bot reads are not.
      if (owner === 'legacy') {
        const hits: string[] = []
        for (const match of code.matchAll(/from\s+['"]mineflayer['"]/g)) {
          const stmtStart = code.lastIndexOf('import', match.index)
          const stmt = code.slice(stmtStart === -1 ? match.index : stmtStart, match.index + 1)
          if (!/^\s*import\s+type\b/.test(stmt)) hits.push('value-imports mineflayer')
        }
        if (/this\.bot\b/.test(code)) hits.push('reads this.bot')
        for (const hit of hits) violations.push(`${rel} (legacy): ${hit}`)
        continue
      }
      const hits: string[] = []
      if (/from\s+['"]mineflayer['"]/.test(code)) hits.push("imports 'mineflayer'")
      if (/\bBot\b/.test(code)) hits.push('references Bot')
      if (/this\.bot\b/.test(code)) hits.push('reads this.bot')
      if (hits.length === 0) continue
      const allowed = owner === 'minecraft' || (owner === 'flat' && RAW_BACKEND_ALLOWLIST.has(rel))
      if (!allowed) violations.push(`${rel} (${owner}): ${hits.join(', ')}`)
    }
    assert.deepEqual(violations, [])
  })

  it('keeps the minecraft adapter free of quarantine and the reach plane free of impl details', () => {
    for (const rel of files.filter((f) => f.startsWith('minecraft/'))) {
      const source = readFileSync(new URL(`./src/${rel}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /from\s+['"][^'"]*legacy\//, `${rel} must not import quarantined legacy code`)
    }
    const plane = readFileSync(new URL('./src/reach/controller-plane.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(plane, /from\s+['"][^'"]*minecraft\//, 'the Reach plane consumes ports only')
    assert.match(plane, /host\.reachRuntimeAdapter\./, 'the Reach plane goes through typed runtime ports')
  })
})
