// test-contract-docs.mts - guard tests for issue #6 (resident spec vs CONTRACT_VERSION).
//
// Proves:
//   (a) the doc/code version assertion PASSES when they are equal;
//   (b) it FAILS LOUDLY (exit 1) with both numbers when the doc or a code copy drifts
//       (the negative case is driven by CONTRACT_DOCS_SIMULATE_* env hooks);
//   (c) the live host's reload-refusal path logs the mismatch with BOTH versions
//       (ERROR + RELOAD_REJECTED + RELOAD ok=false) and exposes contractVersion in
//       report/status/acceptance (never silent);
//   (d) the migration procedure (including the mandatory host restart) is documented.
//
// Run: npm run contract-docs-test
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CHECKER = join(ROOT, 'tools', 'check-contract-docs.mjs')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

function codeValue(): number {
  const match = /export const CONTRACT_VERSION = (\d+)/.exec(read('buddy-driver/resident-types.ts'))
  if (match === null || match[1] === undefined) throw new Error('CONTRACT_VERSION not found in resident-types.ts')
  return Number(match[1])
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runChecker(env: Record<string, string>): RunResult {
  const result = spawnSync(process.execPath, [CHECKER], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// (a) positive: the real repo is consistent -----------------------------------
addCase('a. checker exits 0 when the documented value equals the code value', () => {
  const run = runChecker({})
  const pass = run.status === 0 && run.stdout.includes('contract-docs checks passed')
  return { pass, detail: `exit=${run.status} ${run.stdout.split('\n').slice(-2, -1)[0] ?? ''}` }
})

// (b1) negative: stale doc ----------------------------------------------------
addCase('b1. stale documented value exits 1 and prints code vs doc numbers', () => {
  const code = codeValue()
  const stale = String(code - 1)
  const run = runChecker({ CONTRACT_DOCS_SIMULATE_DOC: stale })
  const showsBoth = run.stdout.includes(`- code: ${code}`) && run.stdout.includes(`+ doc: ${stale}`)
  const pass = run.status === 1 && showsBoth && run.stdout.includes('DRIFT DETECTED')
  return { pass, detail: `exit=${run.status} showsBoth=${showsBoth}` }
})

// (b2) negative: stale code copy ----------------------------------------------
addCase('b2. a code definition site that drifts from the canonical value exits 1', () => {
  const code = codeValue()
  const drift = String(code + 1)
  const run = runChecker({ CONTRACT_DOCS_SIMULATE_CODE: drift })
  const pass = run.status === 1 && run.stdout.includes('FAIL  code copy agrees')
  return { pass, detail: `exit=${run.status} codeCopyFail=${run.stdout.includes('FAIL  code copy agrees')}` }
})

// (b3) positive control: simulated equal values still pass ---------------------
addCase('b3. simulated override equal to the code value still exits 0', () => {
  const code = String(codeValue())
  const run = runChecker({ CONTRACT_DOCS_SIMULATE_CODE: code, CONTRACT_DOCS_SIMULATE_DOC: code })
  return { pass: run.status === 0, detail: `exit=${run.status}` }
})

// (c1) every code definition site carries one value ---------------------------
addCase('c1. all CONTRACT_VERSION definition sites carry the same value', () => {
  const sites: { rel: string; regex: RegExp }[] = [
    { rel: 'buddy-driver/resident-types.ts', regex: /export const CONTRACT_VERSION = (\d+)/ },
    { rel: 'buddy-driver/generation-entry.ts', regex: /export const CONTRACT_VERSION = (\d+)/ },
    { rel: 'buddy-driver/agent-runner.mts', regex: /^const CONTRACT_VERSION = (\d+)/m },
  ]
  const values = sites.map((site) => {
    const match = site.regex.exec(read(site.rel))
    return { rel: site.rel, value: match?.[1] ?? null }
  })
  const pass = values.every((v) => v.value !== null && v.value === values[0]?.value)
  return { pass, detail: values.map((v) => `${v.rel}=${v.value}`).join(' ') }
})

// (c2) mismatch is logged with both versions ----------------------------------
addCase('c2. host reload-refusal logs ERROR + RELOAD_REJECTED + RELOAD ok=false with both versions', () => {
  const runner = read('buddy-driver/agent-runner.mts')
  const templateSource = 'CONTRACT_VERSION mismatch: generation=\\$\\{[^}]+\\} host=\\$\\{[^}]+\\}'
  const templateHits = (runner.match(new RegExp(templateSource, 'g')) ?? []).length
  const sample = new RegExp(templateSource).exec(runner)?.[0] ?? ''
  const rendered = sample.replace('${mod.CONTRACT_VERSION}', '${generation}').replace('${CONTRACT_VERSION}', '${host}')
  const bothVersions = rendered.replace('${generation}', '2').replace('${host}', '3') === 'CONTRACT_VERSION mismatch: generation=2 host=3'
  const loadSite = runner.includes("where: 'loadGenerationModule'")
  const reloadSite = runner.includes("where: 'performReload'")
  const rejected = runner.includes("log('RELOAD_REJECTED'") && runner.includes("action: 'keep-previous-generation'")
  const reloadFalse = runner.includes("log('RELOAD', { ok: false")
  const pass = templateHits >= 2 && bothVersions && loadSite && reloadSite && rejected && reloadFalse
  return {
    pass,
    detail: `throwSites=${templateHits} rendered=${rendered} loadSite=${loadSite} reloadSite=${reloadSite} rejected=${rejected} reloadOkFalse=${reloadFalse}`,
  }
})

// (c3) status/report/acceptance expose contractVersion ------------------------
addCase('c3. report/status, acceptance and generation status expose contractVersion', () => {
  const runner = read('buddy-driver/agent-runner.mts')
  const gen = read('buddy-driver/generation-entry.ts')
  const runnerCount = (runner.match(/contractVersion: CONTRACT_VERSION/g) ?? []).length
  const genCount = (gen.match(/contractVersion: CONTRACT_VERSION/g) ?? []).length
  const pass = runnerCount >= 3 && genCount >= 1
  return { pass, detail: `agent-runner=${runnerCount} generation-entry=${genCount}` }
})

// (d) migration procedure documented (incl. mandatory restart) ---------------
addCase('d. RESIDENT-MODE.md documents the canonical value, refusal and restart migration', () => {
  const doc = read('RESIDENT-MODE.md')
  const code = codeValue()
  const canonical = doc.includes(`CONTRACT_VERSION = ${code}`)
  const schemaBlock = /^STATE_SCHEMA_VERSION = \d+$/m.test(doc)
  const refusal = doc.includes('RELOAD_REJECTED') && doc.includes('CONTRACT_VERSION mismatch')
  const restart = doc.includes('再起動') && doc.includes('hot reload')
  const guard = doc.includes('check-contract-docs.mjs') && doc.includes('contract-docs-test')
  const pass = canonical && schemaBlock && refusal && restart && guard
  return {
    pass,
    detail: `canonical=${canonical} schema=${schemaBlock} refusal=${refusal} restart=${restart} guard=${guard}`,
  }
})

let failures = 0
process.stdout.write('contract-docs guard tests (issue #6)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} contract-docs cases passed\n`)
if (failures > 0) process.exit(1)
