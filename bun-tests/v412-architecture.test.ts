// bun-tests/v412-architecture.test.ts - V4.1.2 sole-architecture guard.
//
// Mechanical invariants that keep the deleted pre-V4.1.2 semantic authority
// from coming back and the canonical authority stack intact:
//
//   1. no `legacy`-named production source files or `legacy/` directories
//      (compatibility code must name the authoritative side, not hide behind
//      a parallel selectable path);
//   2. none of the deleted semantic selectors / code-owned authority helpers
//      may reappear in production source (comments stripped before scanning,
//      so documenting history stays legal);
//   3. no runtime import cycles among production sources (type-only edges are
//      ignored - they erase at emit);
//   4. the VTR core (kernel, reach/, jev/, system2/, controller-transitions,
//      scheduler) must not import a raw Mineflayer/backend client - mutation
//      crosses `src/minecraft/` ActuationPort only;
//   5. `jev-agent` is the composed package: it must not import `buddy-driver`.
//
// If a legitimate change trips a check, that is the guard working: either the
// change reintroduces a second authority path (fix the change), or the
// constitution moved deliberately (update AGENTS.md AND this list in the same
// commit so the relaxation is reviewable).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize, basename } from 'node:path'
import { describe, expect, test } from 'bun:test'

const ROOT = new URL('..', import.meta.url).pathname
const CODE_EXT = /\.(ts|mts|js|mjs|cjs)$/

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.includes('/mineflayer-src'))

/** Production source: package + tooling code, excluding tests and fixtures. */
function isProduction(file: string): boolean {
  if (!file.startsWith('packages/') && !file.startsWith('tools/')) return false
  if (!CODE_EXT.test(file)) return false
  const base = basename(file)
  if (base.startsWith('test-') || /\.test\.(ts|mts|js|mjs)$/.test(base)) return false
  if (file.includes('/bun-tests/') || file.includes('/test/')) return false
  if (file.includes('/data/') || file.includes('/logs/') || file.includes('/resident/') || file.includes('/node_modules/')) return false
  return true
}

const production = tracked.filter(isProduction)

/** Strip line + block comments so identifier checks ignore documentation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '').replace(/([^:])\/\/[^\n]*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// 1. legacy filenames
// ---------------------------------------------------------------------------

const FORBIDDEN_BASENAME = /(^|[.-])legacy([.-]|$)|^advisor\.ts$|^planner-legacy\.ts$/

// Explicitly-labelled evidence baselines may carry the `legacy` name under
// tools/: they replay the deleted authority for comparison evidence and are
// never reachable from production source (the import check below enforces
// that boundary for packages/, where runtime code lives).
const LABELLED_LEGACY_TOOLS = /^tools\/[\w.-]*legacy[\w.-]*\.mjs$/

describe('V4.1.2 guard: filenames', () => {
  test('no legacy-named production source file or directory', () => {
    const offenders = production.filter(
      (file) =>
        file.startsWith('packages/') &&
        (FORBIDDEN_BASENAME.test(basename(file)) || file.split('/').includes('legacy')),
    )
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. deleted semantic selectors and code-owned authority must not return
// ---------------------------------------------------------------------------

// Every entry was deleted under V4.1.2 because it made a second semantic
// authority path executable: env/runtime architecture selectors, shadow-vs-
// authority switches, code-owned prerequisite ladders that bypassed Jev's
// grounded choice, and candidate-hiding failure filters.
const FORBIDDEN_IDENTIFIERS = [
  'BUDDY_BETA_AUTHORITY',
  'BUDDY_PREREQ_RANK_POLICY',
  'BUDDY_OPTION_COMPILER',
  'resolveBetaAuthority',
  'applyFurnacePrereq',
  'nextUsablePrereqPath',
  'abandonedPrereqSet',
  'filterFurnacePrerequisiteCandidates',
  'realJevPolicy',
]

describe('V4.1.2 guard: selectors', () => {
  test('deleted pre-V4.1.2 authority identifiers stay out of production source', () => {
    const hits: string[] = []
    for (const file of production) {
      const source = stripComments(readFileSync(join(ROOT, file), 'utf8'))
      for (const identifier of FORBIDDEN_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(source)) hits.push(`${file}: ${identifier}`)
      }
    }
    expect(hits).toEqual([])
  })

  test('no production import specifier points at a legacy/advisor module', () => {
    const hits: string[] = []
    for (const file of production) {
      for (const specifier of importSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
        const resolved = specifier.split('/').includes('legacy') || FORBIDDEN_BASENAME.test(basename(specifier))
        if (!resolved) continue
        // Intra-tools imports of labelled baseline fixtures are evidence, not
        // runtime authority. Packages must never reference them at all.
        if (file.startsWith('tools/') && LABELLED_LEGACY_TOOLS.test(normalize(join(dirname(file), specifier)))) continue
        hits.push(`${file} -> ${specifier}`)
      }
    }
    expect(hits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// import graph helpers
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g
const TYPE_ONLY_RE = /^\s*(import|export)\s+type\b|^\s*import\s*\{[^}]*\btype\b/

function importSpecifiers(source: string, runtimeOnly = false): string[] {
  const out: string[] = []
  const text = stripComments(source)
  for (const line of text.split('\n')) {
    if (runtimeOnly && TYPE_ONLY_RE.test(line)) continue
    for (const match of line.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2]
      if (spec !== undefined) out.push(spec)
    }
  }
  return out
}

/** Resolve a relative import specifier to a tracked production file. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = normalize(join(dirname(fromFile), specifier))
  for (const candidate of [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`]) {
    if (production.includes(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// 3. no runtime import cycles
// ---------------------------------------------------------------------------

describe('V4.1.2 guard: import graph', () => {
  test('no runtime import cycles among production sources', () => {
    const graph = new Map<string, Set<string>>()
    for (const file of production) {
      const deps = new Set<string>()
      for (const spec of importSpecifiers(readFileSync(join(ROOT, file), 'utf8'), true)) {
        const target = resolveLocal(file, spec)
        if (target !== null) deps.add(target)
      }
      graph.set(file, deps)
    }
    const color = new Map<string, 0 | 1 | 2>()
    const cycles: string[] = []
    const visit = (node: string, stack: string[]): void => {
      color.set(node, 1)
      for (const dep of graph.get(node) ?? []) {
        const mark = color.get(dep) ?? 0
        if (mark === 1) cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(' -> '))
        else if (mark === 0) visit(dep, [...stack, dep])
      }
      color.set(node, 2)
    }
    for (const file of production) if ((color.get(file) ?? 0) === 0) visit(file, [file])
    expect(cycles).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. VTR core does not touch the raw client
// ---------------------------------------------------------------------------

// Mutation crosses the Runtime Adapter / ActuationPort in `src/minecraft/`.
// The VTR core may import the model SDK (`ai`) for policy calls, but never a
// Mineflayer/prismarine client or the concrete adapter module.
const VTR_CORE = /^(packages\/kernel\/|packages\/jev-agent\/src\/(reach|jev|system2)\/|packages\/jev-agent\/src\/controller-transitions\.ts$)/
const RAW_CLIENT_SPEC = /^mineflayer(-|$)|^prismarine(-|$)|\/minecraft\//

describe('V4.1.2 guard: authority boundary', () => {
  test('VTR core modules never import a raw client or the concrete adapter', () => {
    const files = production.filter((file) => VTR_CORE.test(file))
    expect(files.length).toBeGreaterThan(0)
    const hits: string[] = []
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
        if (RAW_CLIENT_SPEC.test(spec)) hits.push(`${file} -> ${spec}`)
      }
    }
    expect(hits).toEqual([])
  })

  test('packages/kernel stays a leaf: no imports outside its own package', () => {
    const kernelFiles = production.filter((file) => file.startsWith('packages/kernel/'))
    expect(kernelFiles.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of kernelFiles) {
      for (const spec of importSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
        if (!spec.startsWith('.') && !spec.startsWith('node:') && spec !== 'bun:test') violations.push(`${file} -> ${spec}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('jev-agent/src never imports buddy-driver (composition is driver -> agent)', () => {
    // Scoped to src/: package-root scripts like standalone-kernel-authority.mts
    // are composition helpers that legitimately wire both packages.
    const files = production.filter((file) => file.startsWith('packages/jev-agent/src/'))
    const hits: string[] = []
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
        const target = resolveLocal(file, spec)
        if (target !== null && target.startsWith('packages/buddy-driver/')) hits.push(`${file} -> ${spec}`)
        else if (spec.includes('buddy-driver')) hits.push(`${file} -> ${spec}`)
      }
    }
    expect(hits).toEqual([])
  })
})
