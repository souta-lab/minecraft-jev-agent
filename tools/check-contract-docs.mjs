// check-contract-docs.mjs - machine-checkable guard against resident contract docs drift.
//
// Issue #6: the canonical resident spec drifted from the code (`CONTRACT_VERSION`
// was documented as 1/2 while the code ran 3). The live host then refused every
// hot reload with `RELOAD ok=false ... CONTRACT_VERSION mismatch: generation=3
// host=2` while continuing to run an old generation. Docs drift hid exactly that
// class of failure.
//
// This tool is the single checker. It:
//   1. reads the canonical CODE value from `buddy-driver/resident-types.ts`
//      (`export const CONTRACT_VERSION`) and asserts every other code definition
//      site carries the same number;
//   2. reads the canonical DOC value from the machine-readable block in
//      `RESIDENT-MODE.md` (`CONTRACT_VERSION = <n>`) and asserts it equals code;
//   3. does the same for `STATE_SCHEMA_VERSION` (code source
//      `buddy-driver/state-snapshot.ts`);
//   4. fails loudly with both numbers and the file:line of each when they differ,
//      and refuses any *other* markdown file that re-hardcodes the number.
//
// The pure helpers are exported so `buddy-driver/test-contract-docs.mts` can test
// the checker itself (positive + negative) without shelling out.
//
// Run: node tools/check-contract-docs.mjs
//      node tools/check-contract-docs.mjs --json
// Test hooks (used by the test suite to prove the negative path):
//      CONTRACT_DOCS_SIMULATE_CODE=2 CONTRACT_DOCS_SIMULATE_DOC=3 node tools/check-contract-docs.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Canonical code definition sites. The first entry is the single code source. */
export const CODE_VERSION_SOURCES = [
  { path: 'buddy-driver/resident-types.ts', regex: /export const CONTRACT_VERSION = (\d+)/, canonical: true },
  { path: 'buddy-driver/generation-entry.ts', regex: /export const CONTRACT_VERSION = (\d+)/, canonical: false },
  { path: 'buddy-driver/agent-runner.mts', regex: /^const CONTRACT_VERSION = (\d+)/m, canonical: false },
]

/** Canonical doc definition block. */
export const DOC_VERSION_SOURCE = { path: 'RESIDENT-MODE.md', regex: /^CONTRACT_VERSION = (\d+)$/m }

export const CODE_SCHEMA_SOURCES = [
  { path: 'buddy-driver/state-snapshot.ts', regex: /export const AGENT_SNAPSHOT_SCHEMA_VERSION = (\d+)/, canonical: true },
]

export const DOC_SCHEMA_SOURCE = { path: 'RESIDENT-MODE.md', regex: /^STATE_SCHEMA_VERSION = (\d+)$/m }

/**
 * The exact mismatch text the host raises. Kept next to the checker so the test
 * suite can assert the live host source uses the same interpolation form.
 * Mirrors `agent-runner.mts` (`CONTRACT_VERSION mismatch: generation=${g} host=${h}`).
 */
export function contractVersionMismatchMessage(generationVersion, hostVersion) {
  return `CONTRACT_VERSION mismatch: generation=${generationVersion} host=${hostVersion}`
}

/** Read `value` + 1-based `line` for the first regex match, or null. */
export function readVersion(root, source, override) {
  if (override !== undefined && override !== null) {
    return { value: Number(override), line: null, source: source.path }
  }
  const text = readFileSync(join(root, source.path), 'utf8')
  const match = source.regex.exec(text)
  if (match === null || match[1] === undefined) return null
  const line = text.slice(0, match.index).split('\n').length
  return { value: Number(match[1]), line, source: source.path }
}

/** Pure comparison used by both the CLI and the tests. */
export function compareVersions(name, expected, actual, labels = { minus: 'code', plus: 'doc' }) {
  const pass = expected !== null && actual !== null && expected.value === actual.value
  const diff = pass
    ? []
    : [
        `- ${labels.minus}: ${expected === null ? '<missing>' : expected.value}  (${expected?.source ?? '?'}${expected?.line ? `:${expected.line}` : ''})`,
        `+ ${labels.plus}: ${actual === null ? '<missing>' : actual.value}  (${actual?.source ?? '?'}${actual?.line ? `:${actual.line}` : ''})`,
      ]
  return { name, pass, expected, actual, diff }
}

function collectCodeSources(root, sources, override) {
  const found = []
  for (const source of sources) {
    const value = readVersion(root, source, source.canonical ? override : undefined)
    found.push({ source, value })
  }
  return found
}

/**
 * Check code-copy agreement plus doc==code. Returns a structured result; never
 * throws for a mismatch (throws only for a missing canonical definition).
 */
export function checkContractDocs(options = {}) {
  const root = options.root ?? findRepoRoot(dirname(fileURLToPath(import.meta.url)))
  const checks = []

  const codeSources = collectCodeSources(root, CODE_VERSION_SOURCES, options.codeOverride)
  const canonical = codeSources[0]
  if (canonical === undefined || canonical.value === null) {
    throw new Error(`canonical CONTRACT_VERSION not found in ${CODE_VERSION_SOURCES[0].path}`)
  }

  for (const entry of codeSources.slice(1)) {
    checks.push(
      compareVersions(
        `code copy agrees: ${entry.source.path}`,
        { value: canonical.value.value, line: canonical.value.line, source: canonical.value.source },
        entry.value,
        { minus: 'canonical', plus: 'copy' },
      ),
    )
  }

  const docValue = readVersion(root, DOC_VERSION_SOURCE, options.docOverride)
  checks.push(
    compareVersions(
      'doc CONTRACT_VERSION == code CONTRACT_VERSION',
      { value: canonical.value.value, line: canonical.value.line, source: canonical.value.source },
      docValue,
    ),
  )

  const schemaCode = collectCodeSources(root, CODE_SCHEMA_SOURCES)[0]
  const schemaDoc = readVersion(root, DOC_SCHEMA_SOURCE, options.schemaDocOverride)
  checks.push(
    compareVersions(
      'doc STATE_SCHEMA_VERSION == code state schema',
      schemaCode?.value ?? null,
      schemaDoc,
    ),
  )

  const duplicates = findHardcodedDuplicates(root, canonical.value.value)
  checks.push({
    name: 'no other markdown hardcodes the version',
    pass: duplicates.length === 0,
    expected: { value: canonical.value.value, source: canonical.value.source, line: canonical.value.line },
    actual: duplicates.length === 0 ? null : { value: null, line: null, source: duplicates.join(', ') },
    diff: duplicates.map((d) => `! stale hardcoded version: ${d}`),
  })

  return { ok: checks.every((c) => c.pass), root, checks }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'runs', 'dist'])

/** Any `.md` outside the canonical doc that writes a literal version number. */
export function findHardcodedDuplicates(root, codeValue) {
  const offenders = []
  const pattern = /(?:CONTRACT_VERSION|contractVersion|STATE_SCHEMA_VERSION)\s*[:=]\s*(\d+)/g
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.md')) continue
      const rel = relative(root, full)
      if (rel === DOC_VERSION_SOURCE.path) continue
      const text = readFileSync(full, 'utf8')
      for (const match of text.matchAll(pattern)) {
        if (Number(match[1]) !== codeValue) {
          const line = text.slice(0, match.index).split('\n').length
          offenders.push(`${rel}:${line} (${match[0].trim()})`)
        }
      }
    }
  }
  walk(root)
  return offenders
}

export function findRepoRoot(start) {
  let dir = resolve(start)
  for (let i = 0; i < 8; i += 1) {
    try {
      statSync(join(dir, 'RESIDENT-MODE.md'))
      statSync(join(dir, 'tools'))
      return dir
    } catch {
      // keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`repo root (RESIDENT-MODE.md + tools/) not found above ${start}`)
}

function formatSource(entry) {
  if (entry === null) return '<missing>'
  return entry.line === null ? `${entry.source}` : `${entry.source}:${entry.line}`
}

export function formatReport(result) {
  const lines = ['contract-docs guard', '-'.repeat(72)]
  for (const check of result.checks) {
    const expected = formatSource(check.expected ?? null)
    const actual = formatSource(check.actual ?? null)
    lines.push(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`)
    if (!check.pass) {
      lines.push(`      expected (code): ${expected}`)
      lines.push(`      actual        : ${actual}`)
      lines.push('      --- diff ---')
      for (const d of check.diff) lines.push(`      ${d}`)
    } else if (check.actual !== null) {
      lines.push(`      value=${check.actual.value} (${actual})`)
    }
  }
  const passed = result.checks.filter((c) => c.pass).length
  lines.push('-'.repeat(72))
  lines.push(`${passed}/${result.checks.length} contract-docs checks passed`)
  if (!result.ok) lines.push('DRIFT DETECTED: docs must match the code value. See RESIDENT-MODE.md §4-A.')
  return lines.join('\n')
}

function main() {
  const json = process.argv.includes('--json')
  const simulateCode = process.env.CONTRACT_DOCS_SIMULATE_CODE
  const simulateDoc = process.env.CONTRACT_DOCS_SIMULATE_DOC
  const simulateSchemaDoc = process.env.CONTRACT_DOCS_SIMULATE_SCHEMA_DOC
  const result = checkContractDocs({
    codeOverride: simulateCode,
    docOverride: simulateDoc,
    schemaDocOverride: simulateSchemaDoc,
  })
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(`${formatReport(result)}\n`)
  if (!result.ok) process.exit(1)
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main()
