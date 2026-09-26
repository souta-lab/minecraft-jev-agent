// system2-harness/bun-tests/static-scan.ts - source-tree scans used by the
// #439 section 31 static invariants (S1/S2/S8/S10/S15).
//
// These scans read the repository as text. They are intentionally blunt: a
// static invariant that needs a parser to be true is not a fence, it is a
// preference.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
export const HARNESS_DIR = join(REPO_ROOT, 'packages', 'system2-harness')

/**
 * Production files that still call a provider SDK directly.
 *
 * #439 section 1 forbids this, and #439 section 33 Phase G turns it into a CI
 * firewall. Until Phases C/D/E migrate them, the set is pinned here as a RATCHET:
 * the set must match EXACTLY, so
 *   * adding a new direct provider call fails, and
 *   * removing one also fails until its entry is deleted (which is how the
 *     migration becomes visible instead of silently drifting).
 */
export const ALLOWED_LEGACY_PROVIDER_CALLS: Readonly<Record<string, string>> = Object.freeze({
  'packages/buddy-driver/mercury-system2.ts': '#439 Phase D/E: the live System2 WHAT authority being replaced by the harness',
  'packages/buddy-driver/muse-plan-replica.mts': '#419 naming/provider migration: offline evidence replica, no authority',
  'packages/jev-agent/src/jev/authority.ts': '#438 lane: Jev pi harness extraction in flight',
  'packages/jev-agent/src/jev/client.ts': '#438 lane: legacy Jev pi path, shadow comparison',
})

const SOURCE_DIRS = [
  'packages/buddy-driver',
  'packages/jev-agent/src',
  'packages/mcp-server',
  'tools',
  'packages/companion',
  'packages/mcbot',
  'packages/system2-harness',
] as const

const SKIP_DIRS = new Set(['node_modules', '.git', 'runs', 'data', 'dist', 'build'])

export function listSourceFiles(rootRelative: string): readonly string[] {
  const absolute = join(REPO_ROOT, rootRelative)
  if (!existsSync(absolute)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(entry)) continue
      const path = join(dir, entry)
      const info = statSync(path)
      if (info.isDirectory()) {
        walk(path)
        continue
      }
      if (/\.(ts|mts|mjs|js)$/.test(entry)) found.push(path)
    }
  }
  walk(absolute)
  return found
}

export function allProductionSourceFiles(): readonly string[] {
  const files: string[] = []
  for (const dir of SOURCE_DIRS) files.push(...listSourceFiles(dir))
  return files.filter((file) => !isTestPath(relativeToRepo(file)))
}

export function relativeToRepo(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/')
}

/** Test files are not production surfaces and never count as authority. */
export function isTestPath(relativePath: string): boolean {
  if (relativePath.includes('/bun-tests/')) return true
  const base = relativePath.split('/').pop() ?? ''
  return /^test-/.test(base) || /\.(test|spec)\.(ts|mts|mjs)$/.test(base)
}

export function readSource(absolute: string): string {
  return readFileSync(absolute, 'utf8')
}

const PROVIDER_SDK_PATTERN = /(?:^|\n)\s*import[^\n]*from\s+['"]ai['"]|require\(\s*['"]ai['"]\s*\)/

/**
 * Files that import the provider SDK (`ai`) anywhere in the production tree.
 * `system2-harness/` is skipped: the harness IS the adapter, so the SDK import
 * there is the sanctioned one (see `harnessSdkImporters`).
 */
export function providerSdkImporters(): readonly string[] {
  const importers: string[] = []
  for (const file of allProductionSourceFiles()) {
    const relativePath = relativeToRepo(file)
    if (relativePath.startsWith('packages/system2-harness/')) continue
    if (PROVIDER_SDK_PATTERN.test(readSource(file))) importers.push(relativePath)
  }
  return importers.sort()
}

/** Modules INSIDE the harness that import the provider SDK. Only adapters may. */
export function harnessSdkImporters(): readonly string[] {
  return harnessModuleSources()
    .filter((module) => PROVIDER_SDK_PATTERN.test(module.text))
    .map((module) => module.file)
    .sort()
}

/**
 * Deep imports of harness internals from outside the package. Only the barrel
 * (`system2-harness` / `system2-harness/index.ts`) is a legal import surface: a
 * call site that can import `compiler.ts` can also construct its own patch.
 */
export function deepHarnessImports(): readonly string[] {
  const offenders: string[] = []
  for (const file of allProductionSourceFiles()) {
    const relativePath = relativeToRepo(file)
    if (relativePath.startsWith('packages/system2-harness/')) continue
    const source = readSource(file)
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]*system2-harness[^'"]*)['"]/g)].map((match) => match[1] ?? '')
    for (const specifier of specifiers) {
      const tail = specifier.replace(/^.*system2-harness\/?/, '')
      if (tail !== '' && tail !== 'index.ts') offenders.push(`${relativePath} -> ${specifier}`)
    }
  }
  return offenders.sort()
}

/** Text of every non-test harness module, for token-level absence checks. */
export function harnessModuleSources(): readonly { readonly file: string; readonly text: string }[] {
  return listSourceFiles('packages/system2-harness')
    .filter((file) => !isTestPath(relativeToRepo(file)))
    .map((file) => ({ file: relativeToRepo(file), text: readSource(file) }))
    .sort((left, right) => left.file.localeCompare(right.file))
}

export function referencesSymbol(rootRelative: string, token: string): readonly string[] {
  const hits: string[] = []
  for (const file of allProductionSourceFiles()) {
    if (readSource(file).includes(token)) hits.push(relativeToRepo(file))
  }
  void rootRelative
  return hits.sort()
}

/**
 * Remove comments so a token scan reads CODE, not prose. Without this, a comment
 * that says "never use RUNGS here" would look like a RUNGS implementation.
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export interface HarnessCodeSource {
  readonly file: string
  readonly text: string
  readonly code: string
}

export function harnessCodeSources(): readonly HarnessCodeSource[] {
  return harnessModuleSources().map((module) => ({ ...module, code: stripComments(module.text) }))
}

