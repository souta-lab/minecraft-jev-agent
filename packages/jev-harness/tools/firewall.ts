// jev-harness/tools/firewall.ts - the executable import/authority firewall (#438 section 1/22 I1, I10).
//
// This module is the CI-enforceable form of the rule:
//
//   "No production subsystem outside the Jev harness may know how to call Jev,
//    construct provider questions, parse Jev output, apply Jev thresholds, retry
//    Jev, cache Jev, or interpret provider-specific response shapes."
//
// It is deliberately a *ratchet*:
//   * a NEW offending file fails immediately (with file:line);
//   * a file whose debt has been cleaned MUST be removed from FIREWALL_DEBT, so
//     the allowlist can only shrink;
//   * files inside the harness are never allowed on the debt list.
//
// It also checks the dependency DIRECTION inside the harness: only
// `jev-harness/providers/**` may import the provider SDK, and no harness module
// (outside tests) may import gameplay/planner/runtime modules (I10 / #438 section 23).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface FirewallPattern {
  readonly id: string
  readonly label: string
  readonly regex: RegExp
  readonly rationale: string
  /** #438 migration phase that removes the remaining debt. */
  readonly migrationPhase: 'C' | 'D' | 'E' | 'F'
}

/**
 * The hard patterns. They target the Jev provider PRIMITIVE and its response
 * shapes, not Mercurial/System2 LLM usage (`generateText`) and not diagnostics
 * that merely mention a model name in a log assertion.
 */
export const FIREWALL_PATTERNS: readonly FirewallPattern[] = [
  {
    id: 'jev-provider-primitive',
    label: 'experimental_evaluate',
    regex: /\bexperimental_evaluate\b/,
    rationale: 'the Jev evaluation primitive: only the harness provider adapter may import or call it',
    migrationPhase: 'C',
  },
  {
    id: 'jev-provider-question-type',
    label: 'Experimental_EvaluationQuestion',
    regex: /\bExperimental_EvaluationQuestion\b/,
    rationale: 'provider-owned question type: repo code must use repo-owned request types',
    migrationPhase: 'C',
  },
  {
    id: 'jev-provider-sdk',
    label: '@typesafe-ai/sdk',
    regex: /@typesafe-ai\/sdk/,
    rationale: 'provider SDK import outside the adapter',
    migrationPhase: 'F',
  },
  {
    id: 'jev-provider-response-shape',
    label: 'providerMetadata',
    regex: /\bproviderMetadata\b/,
    rationale: 'gateway-specific response shape: only the adapter may read it; the harness decodes confidence centrally',
    migrationPhase: 'D',
  },
  {
    id: 'jev-provider-client',
    label: 'JevProviderClient',
    regex: /\bJevProviderClient\b/,
    rationale:
      'a raw Jev model client outside the harness: repo code must use JevHarness, never a provider client (#438 section 1)',
    migrationPhase: 'F',
  },
]

export interface FirewallFinding {
  readonly file: string
  readonly line: number
  readonly patternId: string
  readonly text: string
}

export interface FirewallDebtEntry {
  /** Repo-relative POSIX path. */
  readonly file: string
  readonly headIds: readonly string[]
  readonly migrationPhase: 'C' | 'D' | 'E'
  readonly reason: string
}

/**
 * Phase A debt (the four production call sites that still import the provider
 * directly). This list may only SHRINK: `checkFirewall` fails when an entry here
 * no longer has any finding.
 */
export const FIREWALL_DEBT: readonly FirewallDebtEntry[] = [
  {
    file: 'jev-agent/src/jev-authority.ts',
    headIds: ['pi_action_v3', 'beta_terminate_v2', 'danger_v1', 'retreat_v1'],
    migrationPhase: 'C',
    reason:
      'model-authoritative kernel batching pi/beta/danger/retreat into one experimental_evaluate call; Phase C moves it behind harness.evaluateBatch()',
  },
  {
    file: 'jev-agent/src/jev-legacy.ts',
    headIds: ['pi_action_legacy_v1', 'beta_terminate_legacy_v1', 'danger_legacy_v1', 'retreat_legacy_v1'],
    migrationPhase: 'E',
    reason: 'legacy TypeSafeJevPolicy; Phase E deletes or migrates it deliberately',
  },
  {
    file: 'buddy-driver/advisor.ts',
    headIds: ['advisor_strategy_v1'],
    migrationPhase: 'C',
    reason: 'advisor strategy choice + durable cache + MAX_CACHE_REPLAYS; Phase C moves the choice behind the harness',
  },
  {
    file: 'buddy-driver/planner-legacy.ts',
    headIds: ['system2_horizon_v1', 'system2_plan_fit_v1', 'system2_strategy_change_v1'],
    migrationPhase: 'C',
    reason: 'legacy System2 batched call; its `match ?? options[0] ?? FRONT_FALLBACK` fallback must become an explicit code-authority fallback',
  },
]

export interface ProductionRoot {
  readonly dir: string
  readonly extensions: readonly string[]
}

export const PRODUCTION_ROOTS: readonly ProductionRoot[] = [
  { dir: 'jev-agent/src', extensions: ['.ts', '.mts'] },
  { dir: 'buddy-driver', extensions: ['.ts', '.mts'] },
  { dir: 'src', extensions: ['.ts', '.mts', '.js', '.mjs'] },
  { dir: 'mcbot', extensions: ['.ts', '.mts', '.js', '.mjs'] },
  { dir: 'tools', extensions: ['.ts', '.mts', '.js', '.mjs'] },
]

const EXCLUDED_DIRS = new Set(['node_modules', 'data', 'logs', 'bun-tests', 'dist', '.git', 'runs'])
const EXCLUDED_FILE = /(^|\/)(test-.*\.(mts|ts|mjs|js)|.*\.test\.(ts|mts|mjs|js))$/

/** Light comment stripper: the firewall is about code, not prose. */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  let inBlock = false
  let inLine = false
  let inString: '"' | "'" | '`' | null = null
  while (index < source.length) {
    const char = source[index] ?? ''
    const next = source[index + 1] ?? ''
    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      } else out += ' '
      index += 1
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        out += '  '
        index += 2
        continue
      }
      out += char === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    if (inString !== null) {
      out += char
      if (char === '\\') {
        out += next
        index += 2
        continue
      }
      if (char === inString) inString = null
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      out += '  '
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      out += '  '
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char
      out += char
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}

function walk(root: string, dir: string, extensions: readonly string[], out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry)
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue
      walk(root, full, extensions, out)
      continue
    }
    if (!info.isFile()) continue
    if (!extensions.some((extension) => entry.endsWith(extension))) continue
    const rel = relative(root, full).split(sep).join('/')
    if (EXCLUDED_FILE.test(rel)) continue
    out.push(rel)
  }
}

export function listProductionFiles(root: string): readonly string[] {
  const files: string[] = []
  for (const productionRoot of PRODUCTION_ROOTS) {
    const dir = resolve(root, productionRoot.dir)
    const collected: string[] = []
    walk(root, dir, productionRoot.extensions, collected)
    files.push(...collected)
  }
  return files.sort()
}

/** Scan the harness itself: only `jev-harness/providers/**` may match. */
/** Harness-relative file list (`root` is the repo root). */
export function listHarnessFiles(root: string): readonly string[] {
  const base = resolve(root, 'jev-harness')
  const files: string[] = []
  walk(base, base, ['.ts', '.mts'], files)
  return files
}

export function scanHarnessSources(root: string): readonly FirewallFinding[] {
  const files = listHarnessFiles(root)
  const base = resolve(root, 'jev-harness')
  const findings: FirewallFinding[] = []
  for (const file of files) {
    if (file.startsWith('bun-tests/')) continue
    let source: string
    try {
      source = readFileSync(resolve(base, file), 'utf8')
    } catch {
      continue
    }
    const codeLines = stripComments(source).split('\n')
    const rawLines = source.split('\n')
    for (let index = 0; index < codeLines.length; index += 1) {
      const line = codeLines[index] ?? ''
      for (const pattern of FIREWALL_PATTERNS) {
        if (!pattern.regex.test(line)) continue
        findings.push({
          file: `jev-harness/${file}`,
          line: index + 1,
          patternId: pattern.id,
          text: (rawLines[index] ?? '').trim().slice(0, 200),
        })
      }
    }
  }
  return findings
}

export function scanImportFirewall(root: string): readonly FirewallFinding[] {
  const findings: FirewallFinding[] = []
  for (const file of listProductionFiles(root)) {
    let source: string
    try {
      source = readFileSync(resolve(root, file), 'utf8')
    } catch {
      continue
    }
    const code = stripComments(source)
    const codeLines = code.split('\n')
    const rawLines = source.split('\n')
    for (let index = 0; index < codeLines.length; index += 1) {
      const line = codeLines[index] ?? ''
      for (const pattern of FIREWALL_PATTERNS) {
        if (!pattern.regex.test(line)) continue
        findings.push({
          file,
          line: index + 1,
          patternId: pattern.id,
          text: (rawLines[index] ?? '').trim().slice(0, 200),
        })
      }
    }
  }
  return findings
}

/**
 * Harness-relative locations allowed to know provider vocabulary. This list is
 * intentionally tiny: the adapter, the single response decoder, and the firewall
 * pattern table itself.
 */
export const HARNESS_PROVIDER_ALLOWED: readonly string[] = ['providers/', 'decoding.ts', 'tools/firewall.ts']

/**
 * Patterns that are forbidden everywhere inside the harness except the allowed
 * locations above. `jev-provider-response-shape` is deliberately NOT here: the
 * harness's own transport contract (`ProviderDispatchResponse.providerMetadata`)
 * is harness-owned vocabulary, and the ban exists to stop *call sites* from
 * reading gateway response shapes.
 */
export const HARNESS_FORBIDDEN_PATTERN_IDS: readonly string[] = [
  'jev-provider-primitive',
  'jev-provider-question-type',
  'jev-provider-sdk',
]

export interface FirewallReport {
  readonly ok: boolean
  readonly findings: readonly FirewallFinding[]
  /** New offenders: files that are not in the debt allowlist. */
  readonly violations: readonly FirewallFinding[]
  /** Debt entries whose findings disappeared: the allowlist must shrink. */
  readonly cleared: readonly FirewallDebtEntry[]
  /** Findings inside the harness itself: never allowed. */
  readonly harnessViolations: readonly FirewallFinding[]
}

export function checkFirewall(root: string): FirewallReport {
  const findings = scanImportFirewall(root)
  const debtFiles = new Set(FIREWALL_DEBT.map((entry) => entry.file))
  // The harness IS the permitted home for provider access - but only in the
  // provider adapter, the centralized response decoder, and this checker's own
  // pattern table. Anywhere else inside the harness is a violation.
  const harnessViolations = scanHarnessSources(root).filter((finding) => {
    if (!HARNESS_FORBIDDEN_PATTERN_IDS.includes(finding.patternId)) return false
    const relative = finding.file.replace(/^jev-harness\//, '')
    return !HARNESS_PROVIDER_ALLOWED.some((allowed) => relative.startsWith(allowed))
  })
  const violations = findings.filter((finding) => !debtFiles.has(finding.file))
  const cleared = FIREWALL_DEBT.filter((entry) => !findings.some((finding) => finding.file === entry.file))
  return {
    ok: violations.length === 0 && cleared.length === 0 && harnessViolations.length === 0,
    findings,
    violations,
    cleared,
    harnessViolations,
  }
}

export function formatFinding(finding: FirewallFinding): string {
  return `${finding.file}:${finding.line}: [${finding.patternId}] ${finding.text}`
}

// ---------------------------------------------------------------------------
// dependency direction inside the harness (I10 / #438 section 23)
// ---------------------------------------------------------------------------

export interface HarnessIsolationOptions {
  readonly root: string
  readonly harnessDir?: string
}

export interface IsolationViolation {
  readonly file: string
  readonly line: number
  readonly reason: string
  readonly text: string
}

const PROVIDER_IMPORT = /\bfrom\s+['"]ai['"]|\brequire\(\s*['"]ai['"]\s*\)/
const GAMEPLAY_IMPORT =
  /\bfrom\s+['"](\.\.\/)+(jev-agent|buddy-driver)\/|\bfrom\s+['"](mineflayer|minecraft-data|prismarine-[a-z]+|vec3)['"]/
const PLATFORM_IMPORT = /\bfrom\s+['"]node:|\bfrom\s+['"]bun['"]/

/**
 * The provider adapter must not reach gameplay/planner/runtime objects (I10), and
 * only the adapter layer may import the provider SDK (#438 section 23). The core
 * harness is plain-data only, so it may not import node:/bun: either (the
 * platform-coupled file sink lives in artifacts.ts and is exempted explicitly).
 */
export const PLATFORM_EXEMPT_FILES: readonly string[] = [
  // deterministic hashing (sha256) for projection/candidate/artifact identity
  'canonical.ts',
  // the (optional) JSONL file sink
  'artifacts.ts',
  // this checker itself
  'tools/firewall.ts',
]

export function checkHarnessIsolation(options: HarnessIsolationOptions): readonly IsolationViolation[] {
  const harnessDir = options.harnessDir ?? 'jev-harness'
  const base = resolve(options.root, harnessDir)
  const violations: IsolationViolation[] = []
  const files = listHarnessFiles(options.root).filter((file) => existsSync(resolve(base, file)))
  for (const file of files) {
    if (file.startsWith('bun-tests/')) continue
    const source = readFileSync(resolve(base, file), 'utf8')
    const codeLines = stripComments(source).split('\n')
    const rawLines = source.split('\n')
    const isProviderFile = file.startsWith('providers/')
    const platformExempt = PLATFORM_EXEMPT_FILES.includes(file)
    for (let index = 0; index < codeLines.length; index += 1) {
      const line = codeLines[index] ?? ''
      const text = (rawLines[index] ?? '').trim().slice(0, 200)
      if (PROVIDER_IMPORT.test(line) && !isProviderFile) {
        violations.push({ file, line: index + 1, reason: 'provider SDK import outside providers/**', text })
      }
      const gameplay = GAMEPLAY_IMPORT.exec(line)
      if (gameplay !== null) {
        violations.push({ file, line: index + 1, reason: 'gameplay/runtime import inside the harness', text })
      }
      if (PLATFORM_IMPORT.test(line) && !platformExempt && !isProviderFile) {
        violations.push({ file, line: index + 1, reason: 'platform import in the plain-data harness core', text })
      }
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// CLI: `bun jev-harness/tools/firewall.ts [root]`
// ---------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  const root = resolve(process.argv[2] ?? join(dirname(new URL(import.meta.url).pathname), '..', '..'))
  const report = checkFirewall(root)
  const isolation = checkHarnessIsolation({ root })
  for (const finding of report.findings) process.stdout.write(`debt   ${formatFinding(finding)}\n`)
  for (const violation of report.violations) process.stdout.write(`FAIL   ${formatFinding(violation)}\n`)
  for (const violation of report.harnessViolations) process.stdout.write(`FAIL   ${formatFinding(violation)}\n`)
  for (const entry of report.cleared) {
    process.stdout.write(`FAIL   ${entry.file}: debt cleared - remove it from FIREWALL_DEBT (allowlist may only shrink)\n`)
  }
  for (const violation of isolation) {
    process.stdout.write(`FAIL   ${violation.file}:${violation.line}: ${violation.reason}: ${violation.text}\n`)
  }
  process.stdout.write(
    `JEV_IMPORT_FIREWALL ok=${report.ok && isolation.length === 0} findings=${report.findings.length} ` +
      `violations=${report.violations.length} cleared=${report.cleared.length} isolation=${isolation.length}\n`,
  )
  if (!report.ok || isolation.length > 0) process.exit(1)
}
