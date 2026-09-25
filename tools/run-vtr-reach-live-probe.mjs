#!/usr/bin/env bun
// HOST-only orchestration for one fresh, isolated VTR Reach no-LLM probe.
// This tool creates a run-scoped Leaf world and runtime worktree; it does not
// add gameplay authority to the VTR runtime. It is deliberately fail-closed
// when capture v2 or the no-egress guard is unavailable.

import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, readlinkSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, writeSync,
} from 'node:fs'
import net from 'node:net'
import { gunzipSync } from 'node:zlib'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectLive, parseHostLog } from './collect-vtr-reach-live.mjs'
import { PROVIDER_JOURNALS, VtrProviderActivityWatch } from './capture-vtr-provider-activity.mjs'
import { runVtrReachProbeSupervisor, runtimeAttemptSinkPaths } from './vtr-reach-probe-supervisor.mjs'
import { packageVtrReachArchive } from './package-vtr-reach-live-archive.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE_ROOT = resolve(TOOL_DIR, '..')
const REQUIRED_CAPTURE_SCHEMA = 'vtr-provider-activity-capture/v2'
const NO_DOUBLE_AUTHORITY_FIXTURE_SOURCE = 'jev-agent/test-vtr-reach-executor-dispatch-authority.mts'
const NO_DOUBLE_AUTHORITY_FIXTURE_TEST_ENTRY = 'jev-agent/vtr-reach-executor-dispatch-authority.test.mts'
const PROTECTED_SERVER_PORTS = new Set([25565, 25570, 25572, 25576, 4173, 4174])
const PROTECTED_OBSERVER_PORTS = new Set([25565, 25570, 25572, 25576, 4173, 4174])
const SHA40 = /^[0-9a-f]{40}$/iu
const SHA256 = /^[0-9a-f]{64}$/iu
const HELP = `Usage:
  bun tools/run-vtr-reach-live-probe.mjs --help
  bun tools/run-vtr-reach-live-probe.mjs --preflight [options]
  bun tools/run-vtr-reach-live-probe.mjs --run [options]

Options:
  --source-root <clean checkout>   Exact-source checkout (default: this repository)
  --attempt-root <new path>        Run-scoped evidence/world/runtime directory
  --leaf-jar <Leaf server jar>     Exact Leaf 1.21.11 server JAR
  --guard-script <path>            with-no-llm-egress-guard.mjs (default: source tools/)
  --port <loopback port>           Isolated Leaf port (default: 25577)
  --observer-port <loopback port>  Read-only observer port (default: 4175)
  --java <executable>              Java executable (default: java from PATH)
  --timeout-ms <integer>           Probe/boot timeout (default: 180000)

--preflight creates and removes a private exact-source worktree and frozen
dependency install to prove the same Bun runtime import resolution used by live.
It does not start a Leaf server, observer, or resident and retains no install
directory. It briefly binds/closes the selected loopback ports to check availability.
--run is required for persistent worktrees, directories, listeners, and evidence.
The run refuses protected server ports 25565/25570/25572/25576 and observer
ports 4173/4174, and binds both processes to 127.0.0.1 only.
`

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function isoNow() { return new Date().toISOString() }
function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function parseCliArgs(argv) {
  const options = {
    help: false,
    preflight: false,
    run: false,
    sourceRoot: DEFAULT_SOURCE_ROOT,
    attemptRoot: null,
    leafJar: null,
    guardScript: null,
    port: 25577,
    observerPort: 4175,
    java: 'java',
    timeoutMs: 180_000,
  }
  const valued = new Map([
    ['--source-root', 'sourceRoot'], ['--attempt-root', 'attemptRoot'], ['--leaf-jar', 'leafJar'],
    ['--guard-script', 'guardScript'], ['--port', 'port'], ['--observer-port', 'observerPort'],
    ['--java', 'java'], ['--timeout-ms', 'timeoutMs'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--preflight') { options.preflight = true; continue }
    if (arg === '--run') { options.run = true; continue }
    const key = valued.get(arg)
    if (!key) throw new Error(`unknown argument: ${arg}`)
    const raw = argv[index + 1]
    if (!raw || raw.startsWith('--')) throw new Error(`${arg} requires a value`)
    options[key] = ['port', 'observerPort', 'timeoutMs'].includes(key) ? Number(raw) : raw
    index += 1
  }
  if (options.help) return options
  if (options.preflight === options.run) throw new Error('choose exactly one of --preflight or --run')
  options.sourceRoot = resolve(options.sourceRoot)
  options.attemptRoot = resolve(options.attemptRoot ?? join('/home/s0u7a/vtr-evidence-archive', 'attempts', `vtr-reach-live-${new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`))
  options.leafJar = options.leafJar ? resolve(options.leafJar) : null
  options.guardScript = resolve(options.guardScript ?? join(options.sourceRoot, 'tools', 'with-no-llm-egress-guard.mjs'))
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be a TCP port')
  if (!Number.isInteger(options.observerPort) || options.observerPort < 1 || options.observerPort > 65535) throw new Error('--observer-port must be a TCP port')
  if (options.port === options.observerPort) throw new Error('Leaf and observer ports must be different')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 900_000) throw new Error('--timeout-ms must be in [10000,900000]')
  validatePortPolicy(options.port, options.observerPort)
  return options
}

export function validatePortPolicy(serverPort, observerPort) {
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error('invalid isolated Leaf port')
  if (!Number.isInteger(observerPort) || observerPort < 1 || observerPort > 65535) throw new Error('invalid observer port')
  if (PROTECTED_SERVER_PORTS.has(serverPort)) throw new Error(`refusing protected/reserved port ${serverPort}`)
  if (PROTECTED_OBSERVER_PORTS.has(observerPort)) throw new Error(`refusing protected/reserved port ${observerPort}`)
  if (serverPort === observerPort) throw new Error('Leaf and observer ports must be different')
  return true
}

export function renderProbeServerProperties({ port, levelName }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || PROTECTED_SERVER_PORTS.has(port)) throw new Error('invalid or protected server port')
  if (typeof levelName !== 'string' || !/^vtrreach-[a-z0-9-]{8,64}$/u.test(levelName)) throw new Error('levelName must be unique and run-scoped')
  return [
    '# Fresh isolated VTR Reach mechanics probe; no benchmark seed or prior world.',
    'server-ip=127.0.0.1',
    `server-port=${port}`,
    `level-name=${levelName}`,
    'level-seed=',
    'level-type=minecraft\\:flat',
    'gamemode=survival',
    'difficulty=peaceful',
    'online-mode=false',
    'enforce-secure-profile=false',
    'spawn-protection=0',
    'allow-flight=false',
    'force-gamemode=false',
    'hardcore=false',
    'generate-structures=false',
    'enable-rcon=false',
    'enable-query=false',
    'white-list=false',
    'view-distance=6',
    'simulation-distance=4',
    'motd=isolated-vtr-reach-probe',
    '',
  ].join('\n')
}

export function redactOperationalText(value) {
  return String(value)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, '$1 [REDACTED]')
    .replace(/((?:api.?key|authorization|cookie|password|secret|token)\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]')
}

function safeErrorDescription(error) {
  return redactOperationalText(error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 1200)
}

function runGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnvironment() }).trim()
}

function realRegularFile(path, label) {
  let stat
  try { stat = lstatSync(path) } catch { throw new Error(`${label} is missing`) }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`)
  return stat
}

async function loopbackPortFree(port) {
  return await new Promise((resolvePromise) => {
    const server = net.createServer()
    server.once('error', () => resolvePromise(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolvePromise(true))
    })
  })
}

function captureSchemaFromModule(modulePath) {
  try {
    const moduleUrl = pathToFileURL(modulePath).href
    return import(moduleUrl).then((module) => ({
      schema: module.PROVIDER_CAPTURE_SCHEMA ?? null,
      hasWatch: typeof module.VtrProviderActivityWatch === 'function',
      canConstructWatch: typeof module.VtrProviderActivityWatch === 'function',
      modulePath,
    })).catch((error) => ({ schema: null, hasWatch: false, canConstructWatch: false, modulePath, error: error?.code ?? error?.name ?? 'import-failed' }))
  } catch (error) {
    return Promise.resolve({ schema: null, hasWatch: false, canConstructWatch: false, modulePath, error: error?.code ?? 'unavailable' })
  }
}

export function parseJavaMajor(output) {
  const match = /version\s+"?(\d+)(?:\.(\d+))?/iu.exec(String(output))
  if (!match) return null
  const major = Number(match[1] === '1' ? match[2] : match[1])
  return Number.isSafeInteger(major) ? major : null
}

export function parseJavaRuntime(output) {
  const text = String(output)
  const version = /version\s+"?([^\s"]+)/iu.exec(text)?.[1] ?? null
  return {
    major: parseJavaMajor(text),
    version,
    earlyAccess: /\b(?:ea|early[ -]access)\b/iu.test(text),
  }
}

export function inspectLeafEula(leafJarPath) {
  const sourcePath = join(dirname(resolve(leafJarPath)), 'eula.txt')
  const contents = readFileSync(sourcePath, 'utf8')
  const activeEulaLines = contents.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && /^eula\s*=/iu.test(line))
  if (activeEulaLines.length !== 1 || !/^eula\s*=\s*true$/iu.test(activeEulaLines[0] ?? '')) {
    throw new Error('an existing `eula=true` acceptance beside the selected Leaf JAR is required')
  }
  return { sourcePath, contents, sourceSha256: sha256(Buffer.from(contents, 'utf8')) }
}

function javaVersion(javaExecutable) {
  const result = spawnSync(javaExecutable, ['-version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' },
  })
  if (result.error) return { major: null, version: null, earlyAccess: null, reason: result.error.code ?? result.error.name }
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return { ...parseJavaRuntime(combined), exitCode: result.status }
}

export async function preflightProbe(options) {
  const checks = []
  const add = (id, status, detail = {}) => checks.push({ id, status, ...detail })
  const check = async (id, fn) => {
    try { const detail = await fn(); add(id, 'PASS', detail ?? {}) }
    catch (error) {
      const reason = redactOperationalText(safeErrorDescription(error))
      const extra = isPlainObject(error?.preflightDetail) ? error.preflightDetail : {}
      add(id, 'BLOCKED', { reason, ...extra })
    }
  }

  let sourceSha = null
  let branch = null
  await check('source-checkout', () => {
    const root = realpathSync(options.sourceRoot)
    if (root !== options.sourceRoot) throw new Error('source-root path must be canonical (no symlink traversal)')
    sourceSha = runGit(root, ['rev-parse', 'HEAD']).toLowerCase()
    if (!SHA40.test(sourceSha)) throw new Error('source checkout does not have a full commit SHA')
    branch = runGit(root, ['branch', '--show-current']) || null
    const dirty = runGit(root, ['status', '--porcelain', '--untracked-files=all'])
    if (dirty !== '') throw new Error('exact-source checkout is dirty')
    const scriptPath = realpathSync(fileURLToPath(import.meta.url))
    if (!scriptPath.startsWith(`${root}${sep}`)) throw new Error('caller must be part of the exact-source checkout')
    return { sourceSha, branch, clean: true, caller: relative(root, scriptPath).split(sep).join('/') }
  })

  await check('attempt-isolation', () => {
    assertNoSymlinkAncestors(options.attemptRoot)
    if (existsSync(options.attemptRoot)) throw new Error('attempt-root already exists; refusing to reuse it')
    if (options.attemptRoot === '/' || options.attemptRoot === options.sourceRoot) throw new Error('unsafe attempt-root')
    if (ensureInside(options.sourceRoot, options.attemptRoot) || ensureInside(options.attemptRoot, options.sourceRoot)) throw new Error('attempt-root and exact-source checkout must not contain one another')
    return { attemptRoot: options.attemptRoot, fresh: true }
  })

  await check('attempt-storage', () => {
    let ancestor = options.attemptRoot
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error('cannot find an existing attempt-root parent for filesystem capacity check')
      ancestor = parent
    }
    const stat = lstatSync(ancestor)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('attempt-root parent must resolve through real directories')
    const realAncestor = realpathSync(ancestor)
    const fs = statfsSync(realAncestor)
    const freeBytes = Number(fs.bavail) * Number(fs.bsize)
    const requiredBytes = 2 * 1024 * 1024 * 1024
    if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) throw new Error(`attempt filesystem has less than ${requiredBytes} bytes available`)
    return { checkedAncestor: realAncestor, freeBytes, requiredBytes }
  })

  await check('port-policy', async () => {
    validatePortPolicy(options.port, options.observerPort)
    const [serverFree, observerFree] = await Promise.all([loopbackPortFree(options.port), loopbackPortFree(options.observerPort)])
    if (!serverFree) throw new Error(`loopback server port ${options.port} is occupied`)
    if (!observerFree) throw new Error(`loopback observer port ${options.observerPort} is occupied`)
    return { bind: '127.0.0.1', serverPort: options.port, observerPort: options.observerPort, serverFree, observerFree }
  })

  await check('leaf-jar', () => {
    if (!options.leafJar) throw new Error('--leaf-jar is required')
    const stat = realRegularFile(options.leafJar, 'Leaf jar')
    const digest = sha256(readFileSync(options.leafJar))
    return { path: options.leafJar, bytes: stat.size, sha256: digest }
  })

  await check('leaf-eula-acceptance', () => {
    const acceptance = inspectLeafEula(options.leafJar)
    return { accepted: true, sourcePath: acceptance.sourcePath, sourceSha256: acceptance.sourceSha256, stagedIntoAttempt: true }
  })

  await check('java-runtime', () => {
    const result = javaVersion(options.java)
    if (result.major === null || result.major < 21 || result.earlyAccess !== false || result.exitCode !== 0) {
      throw new Error(`a generally available Java 21 or newer runtime is required; observed version=${result.version ?? result.major ?? 'unknown'} earlyAccess=${result.earlyAccess ?? 'unknown'}`)
    }
    return { executable: options.java, major: result.major, version: result.version, earlyAccess: false, versionOutputStream: 'stdout+stderr' }
  })

  await check('host-platform-and-compiler', () => {
    if (process.platform !== 'linux') throw new Error('Linux is required by the process-scoped egress guard')
    const compiler = spawnSync('cc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' } })
    if (compiler.error || compiler.status !== 0) throw new Error('C compiler `cc` is unavailable for the egress guard')
    const socketInfo = spawnSync('ss', ['-h'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' } })
    if (socketInfo.error || socketInfo.status !== 0) throw new Error('`ss` is required to bind each loopback listener to its spawned PID')
    return { platform: process.platform, compiler: 'cc', listenerOwnerAttestation: 'ss -ltnp PID/comm only', available: true }
  })

  await check('capture-v2', async () => {
    const modulePath = join(options.sourceRoot, 'tools', 'capture-vtr-provider-activity.mjs')
    const capture = await captureSchemaFromModule(modulePath)
    if (capture.schema !== REQUIRED_CAPTURE_SCHEMA || !capture.hasWatch || !capture.canConstructWatch) {
      throw new Error(`capture module must expose ${REQUIRED_CAPTURE_SCHEMA} and an armable watch implementation (observed ${capture.schema ?? 'unavailable'})`)
    }
    return { schema: capture.schema, modulePath, watcherClassAvailable: capture.canConstructWatch, adapter: 'local VtrProviderActivityWatch wrapper' }
  })

  await check('no-llm-egress-guard', () => {
    const stat = realRegularFile(options.guardScript, 'egress guard')
    const guardText = readFileSync(options.guardScript, 'utf8')
    if (!guardText.includes('--audit') || !guardText.includes('LD_PRELOAD')) throw new Error('guard is not the expected auditable LD_PRELOAD wrapper')
    const guardDirectory = dirname(options.guardScript)
    const cSource = join(guardDirectory, 'no-llm-egress-guard.c')
    const policy = join(guardDirectory, 'no-llm-egress-guard.policy.json')
    realRegularFile(cSource, 'egress guard C source')
    realRegularFile(policy, 'egress guard policy')
    return {
      path: options.guardScript,
      bytes: stat.size,
      sha256: sha256(Buffer.from(guardText)),
      cSourceSha256: sha256(readFileSync(cSource)),
      policySha256: sha256(readFileSync(policy)),
      supported: true,
    }
  })

  await check('no-double-authority-fixture-contract', () => {
    const fixturePath = join(options.sourceRoot, NO_DOUBLE_AUTHORITY_FIXTURE_SOURCE)
    const source = readFileSync(fixturePath, 'utf8')
    for (const token of ['VTR_REACH_AUTHORITY_FIXTURE_REPORT', 'VTR_REACH_SOURCE_SHA', 'vtr-reach-no-double-authority-fixture/v1']) {
      if (!source.includes(token)) throw new Error(`fixture source does not support exact-source report contract (${token})`)
    }
    const testEntryPath = join(options.sourceRoot, NO_DOUBLE_AUTHORITY_FIXTURE_TEST_ENTRY)
    const testEntry = readFileSync(testEntryPath, 'utf8')
    if (!testEntry.includes("import './test-vtr-reach-executor-dispatch-authority.mts'")) {
      throw new Error('Bun-discoverable fixture entry must import the exact-source authority fixture')
    }
    return {
      sourcePath: NO_DOUBLE_AUTHORITY_FIXTURE_SOURCE,
      testEntryPath: NO_DOUBLE_AUTHORITY_FIXTURE_TEST_ENTRY,
      runBeforeServerStart: true,
    }
  })

  await check('runtime-dependencies', () => {
    if (!SHA40.test(String(sourceSha ?? ''))) throw new Error('exact source SHA is unavailable; skipping temporary dependency installation')
    if (checks.find((entry) => entry.id === 'source-checkout')?.status !== 'PASS') throw new Error('exact-source checkout readiness failed; skipping temporary dependency installation')
    const readiness = inspectExactSourceDependencyReadiness(options.sourceRoot)
    const fullSmoke = runPreflightFrozenInstall(options, sourceSha)
    return {
      bunLockfile: relative(options.sourceRoot, readiness.lockPath),
      lockSha256: readiness.lockSha256,
      installMode: 'bun install --frozen-lockfile in nested exact-source worktree',
      workspaceValidation: readiness.workspaceInstall.workspaceValidation,
      workspaceLinks: readiness.workspaceInstall.workspaceLinks,
      rootPackageJsonSha256: readiness.workspaceInstall.rootPackageJsonSha256,
      temporaryInstallRemoved: fullSmoke.temporaryInstallRemoved,
      fullRuntimeResolutionSmoke: fullSmoke,
    }
  })

  await check('runtime-source-identity', () => {
    if (sourceSha === null) throw new Error('source checkout check did not establish exact SHA')
    const runtimePath = join(options.sourceRoot, 'buddy-driver', 'agent-runner.mts')
    realRegularFile(runtimePath, 'resident HOST source')
    const probeSource = readFileSync(join(options.sourceRoot, 'buddy-driver', 'generation-entry.ts'), 'utf8')
    if (!probeSource.includes("process.env.BUDDY_VTR_REACH_PROBE?.trim() === '1'")) throw new Error('exact source lacks the opt-in VTR Reach probe path')
    return { sourceSha, mission: 'inventory_at_least:minecraft:oak_log x1', startFrozen: true }
  })

  const blocked = checks.filter((entry) => entry.status !== 'PASS')
  return {
    schema: 'vtr-reach-live-probe-preflight/v1',
    status: blocked.length === 0 ? 'READY' : 'BLOCKED',
    sourceSha,
    branch,
    attemptRoot: options.attemptRoot,
    ports: { leaf: options.port, observer: options.observerPort },
    checks,
    blockers: blocked.map(({ id, reason }) => ({ id, reason })),
    sourceTreeReadOnly: true,
    temporaryInstallRemoved: checks.find((entry) => entry.id === 'runtime-dependencies')?.temporaryInstallRemoved ?? null,
    servicesStarted: { leafServer: false, observer: false, resident: false },
  }
}

function ensureInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function assertNoSymlinkAncestors(candidate) {
  const absolute = resolve(candidate)
  const parts = absolute.split(sep).filter(Boolean)
  let current = sep
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`path component is a symlink: ${current}`)
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`path parent is not a directory: ${current}`)
  }
  return absolute
}

function writeJsonExclusive(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temp, path)
}

function commandPromise(child) {
  return new Promise((resolvePromise) => {
    child.once('close', (code, signal) => resolvePromise({ code, signal, at: isoNow() }))
  })
}

function spawnCaptured(command, args, { cwd, env, logPath, stdin = 'ignore', detached = false, onLine } = {}) {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  const logFd = openSync(logPath, 'a', 0o600)
  const child = spawn(command, args, { cwd, env, detached, stdio: [stdin, 'pipe', 'pipe'] })
  const tails = new Map([['spawned-child-stdout', ''], ['spawned-child-stderr', '']])
  const endedStreams = new Set()
  let closedLog = false
  const closeLog = () => {
    if (closedLog || endedStreams.size !== 2) return
    closedLog = true
    closeSync(logFd)
  }
  const persist = (chunk, final = false, streamSource = 'unknown') => {
    const tail = tails.get(streamSource) ?? ''
    const combined = tail + chunk.toString('utf8')
    const lines = combined.split('\n')
    const pending = final ? '' : lines.pop() ?? ''
    if (final && lines.at(-1) === '') lines.pop()
    const ready = final && pending ? [...lines, pending] : lines
    tails.set(streamSource, pending)
    for (const line of ready) {
      const safeLine = redactOperationalText(line)
      writeSync(logFd, `${safeLine}\n`)
      if (typeof onLine === 'function') onLine(safeLine, isoNow(), streamSource, line)
    }
  }
  for (const [streamSource, stream] of [['spawned-child-stdout', child.stdout], ['spawned-child-stderr', child.stderr]]) {
    stream?.on('data', (chunk) => persist(chunk, false, streamSource))
    stream?.once('end', () => {
      persist(Buffer.alloc(0), true, streamSource)
      endedStreams.add(streamSource)
      closeLog()
    })
  }
  const spawned = new Promise((resolvePromise, reject) => {
    child.once('spawn', () => resolvePromise({ pid: child.pid, at: isoNow() }))
    child.once('error', (error) => reject(new Error(`child spawn failed (${error.code ?? error.name})`)))
  })
  const closed = commandPromise(child)
  return { child, spawned, closed, logPath }
}

function minimalEnvironment(overrides = {}) {
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin'
  return { ...env, ...overrides }
}

function hostRows(hostLog) {
  const text = existsSync(hostLog) ? readFileSync(hostLog, 'utf8') : ''
  return text.split(/\r?\n/u).map((raw, index) => {
    const match = /^\[([^\]]+)\]\s+([A-Z][A-Z0-9_]*)\b(?:\s+(.*))?$/u.exec(raw)
    if (!match) return null
    let fields = {}
    try {
      const parsed = JSON.parse(`{${(match[3] ?? '').replace(/([A-Za-z0-9_.-]+)=/gu, '"$1":').replace(/\s+(?=[A-Za-z0-9_.-]+=)/gu, ',')}}`)
      if (isPlainObject(parsed)) fields = parsed
    } catch {
      // The runtime event format supports nested JSON key/value pairs. For the
      // few host lifecycle values consumed here, retain a conservative token parse.
      for (const token of (match[3] ?? '').matchAll(/(?:^|\s)([A-Za-z0-9_.-]+)=([^\s]+)/gu)) {
        const value = token[2] ?? ''
        try { fields[token[1]] = JSON.parse(value) } catch { fields[token[1]] = value }
      }
    }
    return { line: index + 1, ts: match[1], event: match[2], fields, raw }
  }).filter(Boolean)
}

function waitFor(predicate, { timeoutMs, pollMs = 250, label }) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    let last = null
    while (Date.now() < deadline) {
      last = await predicate()
      if (last) return last
      await delay(pollMs)
    }
    throw new Error(`timeout waiting for ${label}`)
  })()
}

async function waitPortOpen(port, timeoutMs) {
  return await waitFor(async () => {
    const open = await new Promise((resolvePromise) => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
      socket.once('error', () => resolvePromise(false))
    })
    return open
  }, { timeoutMs, label: `Leaf listen on 127.0.0.1:${port}` })
}

async function portClosed(port) {
  return await new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolvePromise({ closed: false, code: 'CONNECTED', observedAt: isoNow() }) })
    socket.once('error', (error) => resolvePromise({ closed: error?.code === 'ECONNREFUSED', code: error?.code ?? error?.name ?? 'UNKNOWN', observedAt: isoNow() }))
    socket.setTimeout(1500, () => { socket.destroy(); resolvePromise({ closed: false, code: 'TIMEOUT', observedAt: isoNow() }) })
  })
}

function controlRequest(socketPath, cmd, args = {}, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(socketPath)
    const requestId = `probe-${randomBytes(6).toString('hex')}`
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`control socket ${cmd} timed out`)) }, timeoutMs)
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: requestId, cmd, args })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      socket.end()
      try {
        const reply = JSON.parse(buffer.slice(0, newline))
        if (reply.id !== requestId || reply.ok !== true) throw new Error(`control socket rejected ${cmd}`)
        resolvePromise(reply.data)
      } catch (error) { reject(error) }
    })
    socket.once('error', (error) => { clearTimeout(timer); reject(new Error(`control socket ${cmd} failed (${error.code ?? error.name})`)) })
  })
}

function cleanStatus(root) {
  return runGit(root, ['status', '--porcelain', '--untracked-files=all']) === ''
}

const WORKSPACE_PATHS = Object.freeze([
  'jev-harness', 'jev-agent', 'buddy-driver', 'mcbot', 'mcbot/movement-test',
  'mcbot/movement-test/variants/A', 'companion', 'system2-harness',
])

/**
 * Bun's isolated install may materialize package links under root or nested
 * node_modules directories. Every such link must resolve inside this exact
 * source worktree; resolving the two production entrypoints is checked
 * separately by runRuntimeResolutionSmoke().
 */
export function inspectNodeModulesLinkContainment(runtimeSource) {
  const root = realpathSync(runtimeSource)
  const pending = [{ path: root, underNodeModules: false }]
  const visitedDirectories = new Set()
  const links = []

  while (pending.length > 0) {
    const current = pending.pop()
    const directory = realpathSync(current.path)
    if (!ensureInside(root, directory)) throw new Error('node_modules traversal escaped the exact-source tree')
    if (visitedDirectories.has(directory)) continue
    visitedDirectories.add(directory)
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!current.underNodeModules && entry.name === '.git') continue
      const path = join(directory, entry.name)
      const isNodeModulesEntry = entry.name === 'node_modules'
      if (entry.isSymbolicLink()) {
        if (!current.underNodeModules && !isNodeModulesEntry) continue
        let target
        try { target = realpathSync(path) } catch {
          throw new Error(`dependency symlink is dangling inside exact-source node_modules: ${relative(root, path).split(sep).join('/')}`)
        }
        if (!ensureInside(root, target) || target === root) {
          throw new Error(`dependency symlink resolves outside the exact-source tree: ${relative(root, path).split(sep).join('/')}`)
        }
        const targetStat = statSync(target)
        links.push({
          path: relative(root, path).split(sep).join('/'),
          target: relative(root, target).split(sep).join('/'),
          targetKind: targetStat.isDirectory() ? 'directory' : targetStat.isFile() ? 'file' : 'other',
        })
        if (targetStat.isDirectory()) pending.push({ path: target, underNodeModules: true })
        continue
      }
      if (entry.isDirectory()) {
        pending.push({ path, underNodeModules: current.underNodeModules || isNodeModulesEntry })
      }
    }
  }

  links.sort((left, right) => left.path.localeCompare(right.path) || left.target.localeCompare(right.target))
  const manifest = JSON.stringify(links)
  return {
    schema: 'vtr-exact-source-node-modules-containment/v1',
    status: 'PASS',
    exactSourceRoot: root,
    symlinkCount: links.length,
    externalSymlinkCount: 0,
    danglingSymlinkCount: 0,
    symlinkManifestSha256: sha256(manifest),
  }
}

function readBunLock(lockPath) {
  const text = readFileSync(lockPath, 'utf8')
  if (!globalThis.Bun?.JSONC?.parse) throw new Error('Bun JSONC parser is unavailable for exact-source lock validation')
  return globalThis.Bun.JSONC.parse(text)
}

/**
 * Validate workspace identity from the exact checkout's root manifest and lock,
 * then inspect only links Bun actually installed. A workspace need not have a
 * node_modules link when no package depends on it by package name.
 */
export function validateExactSourceWorkspaceInstall(runtimeSource, workspacePaths = WORKSPACE_PATHS) {
  const root = realpathSync(runtimeSource)
  const rootPackagePath = join(root, 'package.json')
  const rootPackageStat = lstatSync(rootPackagePath)
  if (rootPackageStat.isSymbolicLink() || !rootPackageStat.isFile()) throw new Error('exact-source root package.json must be a regular file')
  const rootPackageBytes = readFileSync(rootPackagePath)
  const rootPackage = JSON.parse(rootPackageBytes.toString('utf8'))
  if (!Array.isArray(rootPackage.workspaces)) throw new Error('exact-source root package.json has no workspace path list')
  const declared = new Set(rootPackage.workspaces)
  const expected = new Set(workspacePaths)
  if (declared.size !== expected.size || [...expected].some((path) => !declared.has(path))) {
    throw new Error('exact-source workspace path list differs from the pinned caller workspace inventory')
  }

  const lockPath = join(root, 'bun.lock')
  const lockStat = lstatSync(lockPath)
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error('exact-source bun.lock must be a regular file')
  const lockBytes = readFileSync(lockPath)
  const lock = readBunLock(lockPath)
  if (!isPlainObject(lock.workspaces) || !isPlainObject(lock.workspaces[''])) throw new Error('exact-source bun.lock has no root/workspace identity map')
  if (lock.workspaces[''].name !== rootPackage.name) throw new Error('root package identity differs from bun.lock')

  const nodeModulesPath = join(root, 'node_modules')
  try {
    const nodeModulesStat = lstatSync(nodeModulesPath)
    if (nodeModulesStat.isSymbolicLink() || !nodeModulesStat.isDirectory()) throw new Error('exact-source node_modules must be a real directory when present')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const dependencyLinkContainment = inspectNodeModulesLinkContainment(root)

  const workspaces = {}
  const names = new Set()
  for (const workspacePath of workspacePaths) {
    if (typeof workspacePath !== 'string' || workspacePath.startsWith('/') || workspacePath.split('/').includes('..')) {
      throw new Error(`workspace path is unsafe: ${String(workspacePath)}`)
    }
    const packagePath = join(root, workspacePath, 'package.json')
    const packageStat = lstatSync(packagePath)
    if (packageStat.isSymbolicLink() || !packageStat.isFile()) throw new Error(`workspace package manifest must be a regular file: ${workspacePath}`)
    const packageBytes = readFileSync(packagePath)
    const packageJson = JSON.parse(packageBytes.toString('utf8'))
    const name = packageJson.name
    if (typeof name !== 'string' || name.length === 0 || name.startsWith('/') || names.has(name)) {
      throw new Error(`workspace package name is invalid or duplicated: ${workspacePath}`)
    }
    names.add(name)
    const lockWorkspace = lock.workspaces[workspacePath]
    if (!isPlainObject(lockWorkspace) || lockWorkspace.name !== name
      || (packageJson.version != null && lockWorkspace.version !== packageJson.version)) {
      throw new Error(`workspace package identity differs from bun.lock: ${workspacePath}`)
    }
    const expectedLexicalRoot = resolve(root, workspacePath)
    if (!(expectedLexicalRoot === root || expectedLexicalRoot.startsWith(`${root}${sep}`))) throw new Error(`workspace path escapes exact-source root: ${workspacePath}`)
    const expectedPackageRoot = realpathSync(expectedLexicalRoot)
    if (expectedPackageRoot !== expectedLexicalRoot) throw new Error(`workspace path resolves through a symlink: ${workspacePath}`)
    const linkPath = join(root, 'node_modules', name)
    let linkStat = null
    try {
      // lstat detects dangling symlinks too; existsSync would misclassify them
      // as absent and could hide a broken or redirected install entry.
      linkStat = lstatSync(linkPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    let installedLink
    if (linkStat === null) {
      installedLink = { status: 'NOT_LINKED', path: relative(root, linkPath).split(sep).join('/') }
    } else {
      const actual = realpathSync(linkPath)
      if (actual !== expectedPackageRoot) throw new Error(`workspace dependency resolves outside the exact-source tree: ${name}`)
      installedLink = {
        status: 'PRESENT',
        path: relative(root, linkPath).split(sep).join('/'),
        target: relative(root, actual).split(sep).join('/'),
      }
    }
    workspaces[name] = {
      packagePath: workspacePath,
      packageJsonSha256: sha256(packageBytes),
      bunLockWorkspace: { path: workspacePath, name, version: packageJson.version ?? null },
      installedLink,
    }
  }
  for (const workspacePath of workspacePaths) {
    if (!Object.hasOwn(lock.workspaces, workspacePath)) throw new Error(`bun.lock is missing workspace entry: ${workspacePath}`)
  }
  return {
    rootPackageJsonSha256: sha256(rootPackageBytes),
    bunLockSha256: sha256(lockBytes),
    workspaceLinks: workspaces,
    noExternalWorkspaceLinks: true,
    dependencyLinkContainment,
    workspaceValidation: {
      status: 'PASS',
      manifestSource: 'exact-source package.json + bun.lock',
      absentUnusedLinksAllowed: true,
      installedLinksChecked: true,
      dependencySymlinksContainedWithinExactSource: true,
    },
  }
}

function inspectProjectConfigPaths(root) {
  const found = []
  for (const directory of ['.', ...WORKSPACE_PATHS]) {
    for (const name of ['.npmrc', '.bunfig.toml', 'bunfig.toml']) {
      const path = join(root, directory, name)
      if (!existsSync(path)) continue
      const stat = lstatSync(path)
      found.push({ path: relative(root, path).split(sep).join('/'), regular: stat.isFile(), symlink: stat.isSymbolicLink() })
    }
  }
  return found
}

export function inspectExactSourceDependencyReadiness(runtimeSource) {
  const projectConfig = inspectProjectConfigPaths(runtimeSource)
  if (projectConfig.length > 0) throw new Error(`exact-source project contains ambient package-manager config (${projectConfig.map((entry) => entry.path).join(', ')})`)
  const lockPath = join(runtimeSource, 'bun.lock')
  if (!existsSync(lockPath)) throw new Error('exact-source frozen Bun lockfile bun.lock is missing')
  const lockStat = lstatSync(lockPath)
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error('exact-source bun.lock must be a regular non-symlink file')
  const workspaceInstall = validateExactSourceWorkspaceInstall(runtimeSource)
  const lockSha256 = sha256(readFileSync(lockPath))
  if (workspaceInstall.bunLockSha256 !== lockSha256) throw new Error('workspace validator observed a different bun.lock identity')
  return { lockPath, lockSha256, workspaceInstall }
}

function evidenceDescriptors(attemptRoot, candidates) {
  const evidence = []
  for (const candidate of candidates.filter((value) => typeof value === 'string')) {
    try {
      const fileStat = lstatSync(candidate)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue
      const bytes = readFileSync(candidate)
      evidence.push({ path: relative(attemptRoot, candidate).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) })
    } catch {
      // Missing evidence remains missing; this function never fabricates it.
    }
  }
  return evidence
}

function setupEvidenceCandidates(attemptRoot, preflightPath = null) {
  return [
    preflightPath,
    join(attemptRoot, 'runner', 'dependency-install.log'),
    join(attemptRoot, 'runner', 'dependency-install.json'),
    join(attemptRoot, 'runner', 'source-bun.lock'),
    join(attemptRoot, 'runner', 'runtime-resolution-full.log'),
    join(attemptRoot, 'runner', 'no-double-authority-fixture.json'),
    join(attemptRoot, 'runner', 'no-double-authority-fixture-test.log'),
    join(attemptRoot, 'runner', 'fixtures', 'test-vtr-reach-executor-dispatch-authority.mts'),
    join(attemptRoot, 'runner', 'fixtures', 'vtr-reach-executor-dispatch-authority.test.mts'),
    join(attemptRoot, 'server', 'eula.txt'),
    join(attemptRoot, 'server', 'eula-attestation.json'),
  ]
}

function runtimeFailureEvidenceCandidates(attemptRoot, preflightPath = null) {
  return [
    ...setupEvidenceCandidates(attemptRoot, preflightPath),
    ...[
      'runner/server-start.json', 'runner/fresh-world-attestation.json',
      'runner/host-lifecycle.jsonl', 'runner/supervisor-capture.json', 'runner/supervisor-lifecycle.json',
      'runner/supervisor-result.json', 'runner/collector-report.json', 'runner/acceptance.json',
      'runner/initial-snapshot.json', 'runner/final-snapshot.json', 'runner/terminal-snapshot.json',
      'runner/fixture-anchor-snapshot.json', 'runner/fixture-command-attempts.jsonl',
      'runner/no-llm-egress-audit.json', 'runner/no-llm-egress-provenance.json',
      'runner/resident-process-group-closure.json', 'runner/package-report.json',
      'runner/validation-report.json', 'runner/caller-result.json', 'runner/fixture-transcript.json',
      'server/server-start.json', 'server/leaf-latest.log', 'server/leaf-stdout-events.jsonl',
      'server/fresh-world-attestation.json',
    ].map((path) => join(attemptRoot, path)),
  ]
}

function createPreflightScratchRoot(options) {
  let parent = dirname(options.attemptRoot)
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) throw new Error('cannot find a parent for temporary preflight installation')
    parent = next
  }
  const parentStat = lstatSync(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || realpathSync(parent) !== parent) throw new Error('temporary preflight parent must be a canonical real directory')
  const available = statfsSync(parent)
  const freeBytes = Number(available.bavail) * Number(available.bsize)
  const requiredBytes = 2 * 1024 * 1024 * 1024
  if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) throw new Error(`temporary preflight filesystem has less than ${requiredBytes} bytes available`)
  const scratch = join(parent, `.vtr-reach-preflight-${process.pid}-${randomBytes(5).toString('hex')}`)
  if (ensureInside(options.sourceRoot, scratch) || ensureInside(scratch, options.sourceRoot)) throw new Error('temporary preflight directory must be isolated from the exact-source checkout')
  assertNoSymlinkAncestors(scratch)
  mkdirSync(scratch, { recursive: false, mode: 0o700 })
  return scratch
}

function removePreflightWorktree(sourceRoot, runtimeSource) {
  let registered = false
  try {
    const listing = runGit(sourceRoot, ['worktree', 'list', '--porcelain'])
    registered = listing.split(/\r?\n/u).some((line) => line === `worktree ${runtimeSource}`)
  } catch {
    return { status: 'INCOMPLETE', reason: 'unable-to-inspect-worktree-registration' }
  }
  if (registered) {
    const removed = spawnSync('git', ['-C', sourceRoot, 'worktree', 'remove', '--force', runtimeSource], {
      stdio: ['ignore', 'ignore', 'pipe'], env: minimalEnvironment(), encoding: 'utf8', timeout: 30_000,
    })
    if (removed.error || removed.status !== 0) return { status: 'INCOMPLETE', reason: `git-worktree-remove-${removed.error?.code ?? removed.status ?? 'unknown'}` }
  } else if (existsSync(runtimeSource)) {
    rmSync(runtimeSource, { recursive: true, force: true })
  }
  return { status: existsSync(runtimeSource) ? 'INCOMPLETE' : 'REMOVED', registered }
}

function runPreflightFrozenInstall(options, sourceSha) {
  if (!SHA40.test(String(sourceSha ?? ''))) throw new Error('exact source SHA is unavailable for temporary frozen install')
  const scratch = createPreflightScratchRoot(options)
  const runtimeSource = join(scratch, 'runtime', 'source')
  let phase = 'exact-source-worktree'
  let install = null
  let error = null
  let evidence = []
  let cleanup = { worktree: { status: 'NOT_ATTEMPTED' }, scratch: { status: 'NOT_ATTEMPTED' } }
  try {
    for (const directory of ['runner', 'server', 'tmp', 'home', 'cache']) mkdirSync(join(scratch, directory), { recursive: true, mode: 0o700 })
    ensureRuntimeSource(options.sourceRoot, scratch, sourceSha, 'preflight-exact-source')
    phase = 'frozen-dependency-install-and-full-resolution-smoke'
    install = runFrozenInstall(runtimeSource, scratch)
  } catch (caught) {
    error = caught
  } finally {
    evidence = evidenceDescriptors(scratch, setupEvidenceCandidates(scratch))
    cleanup.worktree = removePreflightWorktree(options.sourceRoot, runtimeSource)
    if (cleanup.worktree.status === 'REMOVED') {
      try {
        rmSync(scratch, { recursive: true, force: true })
        cleanup.scratch = { status: existsSync(scratch) ? 'INCOMPLETE' : 'REMOVED' }
      } catch (caught) {
        cleanup.scratch = { status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(caught)) }
      }
    } else {
      cleanup.scratch = { status: 'PRESERVED_FOR_RECOVERY', path: scratch }
    }
  }
  const details = {
    phase,
    sourceSha,
    cleanup,
    temporaryInstallRemoved: cleanup.worktree.status === 'REMOVED' && cleanup.scratch.status === 'REMOVED',
    components: { leafServer: 'NOT_STARTED', observer: 'NOT_STARTED', resident: 'NOT_STARTED' },
    evidence: evidence.map((entry) => ({ ...entry, retained: cleanup.scratch.status !== 'REMOVED' })),
    temporaryRootRemoved: cleanup.scratch.status === 'REMOVED',
    installedWorkspaceValidation: install?.workspaceValidation ?? null,
    installedWorkspaceLinks: install?.workspaceLinks ?? null,
    installedLockfile: install?.lockfile ?? null,
    fullRuntimeResolutionSmoke: install?.runtimeResolutionSmoke ?? null,
    frozenInstallStatus: install?.status ?? (error ? 'FAILED' : 'INCOMPLETE'),
  }
  if (error || !details.temporaryInstallRemoved) {
    const reason = error ? redactOperationalText(safeErrorDescription(error)) : 'temporary exact-source install cleanup was incomplete'
    const failure = new Error(reason)
    failure.preflightDetail = details
    throw failure
  }
  return details
}

const RUNTIME_RESOLUTION_ENTRYPOINTS = Object.freeze([
  'buddy-driver/agent-runner.mts',
  'buddy-driver/generation-entry.ts',
])

export function runRuntimeResolutionSmoke(runtimeSource, { mode = 'full', attemptRoot = null } = {}) {
  if (!['full', 'source-graph'].includes(mode)) throw new Error(`unsupported runtime resolution smoke mode: ${mode}`)
  const script = [
    'const { createHash } = require("node:crypto");',
    'const { realpathSync } = require("node:fs");',
    'const { isAbsolute, relative, resolve, sep } = require("node:path");',
    'const entrypoints = ' + JSON.stringify(RUNTIME_RESOLUTION_ENTRYPOINTS) + ';',
    `const mode = ${JSON.stringify(mode)};`,
    'const root = realpathSync(process.cwd());',
    'const result = await Bun.build({ entrypoints, target: "bun", write: false, metafile: true, external: mode === "source-graph" ? ["*"] : [] });',
    'const errors = result.logs.filter((row) => row.level === "error").map((row) => String(row.message ?? row));',
    'const inputs = Object.keys(result.metafile?.inputs ?? {}).sort();',
    'const resolvedInputs = [];',
    'for (const input of inputs) { try { const path = resolve(root, input); const real = realpathSync(path); const rel = relative(root, real); if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) errors.push(`runtime input escapes exact-source tree: ${input}`); else resolvedInputs.push({ input, resolved: rel.split(sep).join("/") }); } catch { errors.push(`runtime input is absent or unresolved in exact-source tree: ${input}`); } }',
    'const inputManifest = JSON.stringify(resolvedInputs);',
    'const resolutionContainment = { status: inputs.length > 0 && errors.length === 0 ? "PASS" : "INCOMPLETE", inputCount: inputs.length, outsideCount: errors.filter((value) => value.includes("escapes exact-source tree")).length, inputManifestSha256: createHash("sha256").update(inputManifest).digest("hex"), inputs: resolvedInputs };',
    'console.log(JSON.stringify({ schema: "vtr-runtime-entrypoint-resolution-smoke/v2", success: result.success, mode, resolver: "Bun.build(target=bun,write=false,metafile=true)", entrypoints, outputCount: result.outputs.length, resolutionContainment, errors }));',
    'if (!result.success) process.exitCode = 1;',
    'if (resolutionContainment.status !== "PASS") process.exitCode = 1;',
  ].join('\n')
  const home = attemptRoot ? join(attemptRoot, 'home', `runtime-smoke-${mode}`) : '/nonexistent'
  const tmp = attemptRoot ? join(attemptRoot, 'tmp', `runtime-smoke-${mode}`) : '/tmp'
  const xdg = attemptRoot ? join(home, '.config') : '/nonexistent'
  const logPath = attemptRoot ? join(attemptRoot, 'runner', `runtime-resolution-${mode}.log`) : null
  if (attemptRoot) for (const directory of [home, tmp, xdg]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const result = spawnSync(process.execPath, ['--no-env-file', '--eval', script], {
    cwd: runtimeSource,
    env: minimalEnvironment({ HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: xdg, BUN_CONFIG_NO_ENV_FILE: '1' }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: mode === 'full' ? 120_000 : 60_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const safeStdout = redactOperationalText(result.stdout ?? '')
  const safeStderr = redactOperationalText(result.stderr ?? '')
  if (logPath) writeFileSync(logPath, `${safeStdout}\n${safeStderr}`, { flag: 'wx', mode: 0o600 })
  if (result.error || result.status !== 0) {
    throw new Error(`Bun ${mode} runtime import-resolution smoke failed (${result.error?.code ?? result.status ?? 'unknown'});${logPath ? ' see ' + relative(attemptRoot, logPath).split(sep).join('/') : ' inspect Bun resolver output'}`)
  }
  const output = safeStdout.trim().split(/\r?\n/u).at(-1)
  let report
  try { report = JSON.parse(output) } catch { throw new Error('Bun runtime resolution smoke did not emit its JSON result') }
  if (report.schema !== 'vtr-runtime-entrypoint-resolution-smoke/v2' || report.success !== true || report.mode !== mode
    || report.outputCount !== RUNTIME_RESOLUTION_ENTRYPOINTS.length || !Array.isArray(report.errors) || report.errors.length !== 0
    || report.resolutionContainment?.status !== 'PASS' || !Number.isSafeInteger(report.resolutionContainment.inputCount)
    || report.resolutionContainment.inputCount < 1 || report.resolutionContainment.outsideCount !== 0
    || !SHA256.test(String(report.resolutionContainment.inputManifestSha256 ?? ''))
    || !Array.isArray(report.resolutionContainment.inputs) || report.resolutionContainment.inputs.length !== report.resolutionContainment.inputCount) {
    throw new Error(`Bun ${mode} runtime import-resolution smoke returned an invalid result${logPath ? '; see ' + relative(attemptRoot, logPath).split(sep).join('/') : ''}`)
  }
  return { ...report, status: 'PASS', logPath: logPath ? relative(attemptRoot, logPath).split(sep).join('/') : null }
}

function ensureRuntimeSource(sourceRoot, attemptRoot, sourceSha, branch) {
  const runtimeParent = join(attemptRoot, 'runtime')
  mkdirSync(runtimeParent, { recursive: true, mode: 0o700 })
  const runtimeSource = join(runtimeParent, 'source')
  execFileSync('git', ['-C', sourceRoot, 'worktree', 'add', '--detach', runtimeSource, sourceSha], { stdio: ['ignore', 'ignore', 'pipe'], env: minimalEnvironment() })
  const nestedSha = runGit(runtimeSource, ['rev-parse', 'HEAD']).toLowerCase()
  if (nestedSha !== sourceSha || !cleanStatus(runtimeSource)) throw new Error('run-scoped source worktree is not exact and clean')
  return { runtimeSource, branch: null, sourceSha: nestedSha }
}

function runFrozenInstall(runtimeSource, attemptRoot) {
  const tempDir = join(attemptRoot, 'tmp', 'bun-install')
  mkdirSync(tempDir, { recursive: true, mode: 0o700 })
  const home = join(attemptRoot, 'home', 'bun-install')
  const xdgConfig = join(home, '.config')
  const xdgCache = join(attemptRoot, 'cache', 'bun-install')
  const bunCache = join(attemptRoot, 'cache', 'bun-install-store')
  const npmCache = join(attemptRoot, 'cache', 'npm-install')
  for (const directory of [home, xdgConfig, xdgCache, bunCache, npmCache]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const readinessBefore = inspectExactSourceDependencyReadiness(runtimeSource)
  const { lockPath, lockSha256 } = readinessBefore
  const installEnvironment = {
    HOME: home,
    TMPDIR: tempDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    BUN_INSTALL_CACHE_DIR: bunCache,
    BUN_CONFIG_NO_ENV_FILE: '1',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    npm_config_userconfig: '/dev/null',
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    npm_config_registry: 'https://registry.npmjs.org/',
  }
  const result = spawnSync(process.execPath, ['--no-env-file', 'install', '--frozen-lockfile'], {
    cwd: runtimeSource,
    env: minimalEnvironment(installEnvironment),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const logPath = join(attemptRoot, 'runner', 'dependency-install.log')
  writeFileSync(logPath, redactOperationalText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`), { flag: 'wx', mode: 0o600 })
  if (result.error || result.status !== 0) throw new Error(`frozen dependency install failed (${result.error?.code ?? result.status ?? 'unknown'}); see runner/dependency-install.log`)
  // Frozen install success plus lock/manifest identity is authoritative for
  // unused workspaces. Bun materializes node_modules links only for packages
  // referenced by dependencies, so require exact-source resolution only for
  // links that are actually present.
  const readinessAfter = inspectExactSourceDependencyReadiness(runtimeSource)
  if (readinessAfter.lockSha256 !== lockSha256) throw new Error('bun.lock changed during frozen dependency install')
  const workspaceInstall = readinessAfter.workspaceInstall
  const runtimeResolutionSmoke = runRuntimeResolutionSmoke(runtimeSource, { mode: 'full', attemptRoot })
  const version = spawnSync(process.execPath, ['--no-env-file', '--version'], { cwd: runtimeSource, env: minimalEnvironment(installEnvironment), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
  const metadata = {
    schema: 'vtr-exact-source-dependency-install/v1',
    status: 'PASS',
    command: 'bun --no-env-file install --frozen-lockfile',
    at: isoNow(),
    sourceSha: runGit(runtimeSource, ['rev-parse', 'HEAD']).toLowerCase(),
    lockfile: { path: relative(runtimeSource, lockPath).split(sep).join('/'), sha256: lockSha256 },
    bunVersion: String(version.stdout ?? '').trim() || null,
    packageInstallIsolation: {
      home: relative(attemptRoot, home).split(sep).join('/'),
      xdgConfigHome: relative(attemptRoot, xdgConfig).split(sep).join('/'),
      xdgCacheHome: relative(attemptRoot, xdgCache).split(sep).join('/'),
      bunInstallCacheDir: relative(attemptRoot, bunCache).split(sep).join('/'),
      npmCache: relative(attemptRoot, npmCache).split(sep).join('/'),
      npmUserConfig: '/dev/null',
      registry: 'https://registry.npmjs.org/',
      envFileLoading: false,
      ambientProjectConfigFiles: [],
      credentialValuesArchived: false,
    },
    runtimeResolutionSmoke,
    ...workspaceInstall,
  }
  const metadataPath = join(attemptRoot, 'runner', 'dependency-install.json')
  const sourceBunLockPath = join(attemptRoot, 'runner', 'source-bun.lock')
  writeJsonExclusive(metadataPath, metadata)
  copyFileSync(lockPath, sourceBunLockPath)
  return { ...metadata, lockPath, logPath, metadataPath, sourceBunLockPath }
}

export function runNoDoubleAuthorityFixture(runtimeSource, attemptRoot, sourceSha) {
  const sourceRelative = NO_DOUBLE_AUTHORITY_FIXTURE_SOURCE
  const testEntryRelative = NO_DOUBLE_AUTHORITY_FIXTURE_TEST_ENTRY
  const sourcePath = join(runtimeSource, sourceRelative)
  const testEntryPath = join(runtimeSource, testEntryRelative)
  const sourceBytes = readFileSync(sourcePath)
  const testEntryBytes = readFileSync(testEntryPath)
  const gitSourceBytes = Buffer.from(execFileSync('git', ['-C', runtimeSource, 'show', `${sourceSha}:${sourceRelative}`]))
  const gitTestEntryBytes = Buffer.from(execFileSync('git', ['-C', runtimeSource, 'show', `${sourceSha}:${testEntryRelative}`]))
  if (sha256(gitSourceBytes) !== sha256(sourceBytes)) throw new Error('fixture bytes in exact checkout differ from the pinned git object')
  if (sha256(gitTestEntryBytes) !== sha256(testEntryBytes)) throw new Error('fixture test entry bytes in exact checkout differ from the pinned git object')
  const archivedSource = join(attemptRoot, 'runner', 'fixtures', 'test-vtr-reach-executor-dispatch-authority.mts')
  const archivedTestEntry = join(attemptRoot, 'runner', 'fixtures', 'vtr-reach-executor-dispatch-authority.test.mts')
  mkdirSync(dirname(archivedSource), { recursive: true, mode: 0o700 })
  writeFileSync(archivedSource, sourceBytes, { flag: 'wx', mode: 0o600 })
  writeFileSync(archivedTestEntry, testEntryBytes, { flag: 'wx', mode: 0o600 })
  const reportPath = join(attemptRoot, 'runner', 'no-double-authority-fixture.json')
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 })
  const tmpDir = join(attemptRoot, 'tmp', 'fixture-test')
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  const logPath = join(attemptRoot, 'runner', 'no-double-authority-fixture-test.log')
  const isolatedHome = join(attemptRoot, 'home', 'fixture-test')
  mkdirSync(isolatedHome, { recursive: true, mode: 0o700 })
  // Bun does not accept the historical `test-*` source filename as a direct
  // test filter. This committed `.test.mts` entry imports and executes the
  // exact-source fixture while remaining discoverable by Bun.
  const result = spawnSync(process.execPath, ['--no-env-file', 'test', '--timeout=120000', testEntryRelative], {
    cwd: runtimeSource,
    env: minimalEnvironment({
      HOME: isolatedHome,
      TMPDIR: tmpDir,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      VTR_REACH_AUTHORITY_FIXTURE_REPORT: reportPath,
      VTR_REACH_SOURCE_SHA: sourceSha,
    }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  writeFileSync(logPath, redactOperationalText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`), { flag: 'wx', mode: 0o600 })
  if (result.error || result.status !== 0) throw new Error(`exact-source no-double-authority fixture failed (${result.error?.code ?? result.status ?? 'unknown'}); see runner/no-double-authority-fixture-test.log`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const fixture = report.fixture ?? {}
  if (report.schema !== 'vtr-reach-no-double-authority-fixture/v1'
    || report.result !== 'PASS'
    || report.sourceSha?.toLowerCase() !== sourceSha
    || report.test?.path !== sourceRelative
    || !SHA256.test(String(report.test?.sourceSha256 ?? ''))
    || report.test.sourceSha256.toLowerCase() !== sha256(sourceBytes)
    || fixture.legacyClaimRejected !== true
    || fixture.vtrOwnerRetained !== true
    || !fixture.transitionId || !fixture.contractHash
    || fixture.pathfinderStartsBeforeLegacyClaim !== fixture.pathfinderStartsAfterLegacyClaim
    || fixture.pathfinderStartDelta !== 0
    || fixture.authorityConflictCount !== 1) {
    throw new Error('no-double-authority fixture artifact failed its exact-source typed schema checks')
  }
  return {
    reportPath,
    sourcePath: archivedSource,
    testEntryPath: archivedTestEntry,
    testEntryRelative,
    sourceSha256: sha256(sourceBytes),
    testEntrySha256: sha256(testEntryBytes),
    gitObjectSha256: sha256(gitSourceBytes),
    gitTestEntryObjectSha256: sha256(gitTestEntryBytes),
    executedCheckoutSha256: sha256(sourceBytes),
    logPath,
    report,
  }
}

export function propertiesObject(text) {
  const result = {}
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    let splitAt = -1
    let escaped = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === ':' || char === '=') { splitAt = index; break }
    }
    if (splitAt < 0) continue
    const unescape = (value) => value.replace(/\\([:=\\])/gu, '$1')
    result[unescape(line.slice(0, splitAt).trim())] = unescape(line.slice(splitAt + 1).trim())
  }
  return result
}

function parseHostRows(text, parseHostLog) {
  const parsed = parseHostLog(text)
  return parsed.map((row) => ({ ...row, ts: row.ts === null ? null : new Date(row.ts).toISOString() }))
}

function readHostRows(hostPath, parseHostLog) {
  return parseHostRows(existsSync(hostPath) ? readFileSync(hostPath, 'utf8') : '', parseHostLog)
}

function positionValue(snapshot) {
  const position = snapshot?.truth?.position
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return null
  return { x: position.x, y: position.y, z: position.z }
}

const REACH_FIXTURE_OFFSETS = Object.freeze({
  fillFrom: Object.freeze({ x: 1, y: -1, z: -3 }),
  fillTo: Object.freeze({ x: 24, y: -1, z: 3 }),
  witness: Object.freeze({ x: 16, y: 0, z: 2 }),
})

function offsetBlockPosition(position, offset) {
  if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) {
    throw new Error('Reach fixture needs a finite exact-source frozen player position')
  }
  const result = {
    x: Math.floor(position.x + offset.x),
    y: Math.floor(position.y + offset.y),
    z: Math.floor(position.z + offset.z),
  }
  if (!Object.values(result).every(Number.isSafeInteger)) throw new Error('Reach fixture produced an unsafe absolute block coordinate')
  return result
}

export function buildReachFixtureGeometry(position) {
  const from = offsetBlockPosition(position, REACH_FIXTURE_OFFSETS.fillFrom)
  const to = offsetBlockPosition(position, REACH_FIXTURE_OFFSETS.fillTo)
  const witness = offsetBlockPosition(position, REACH_FIXTURE_OFFSETS.witness)
  const fillBlockCount = (Math.abs(to.x - from.x) + 1) * (Math.abs(to.y - from.y) + 1) * (Math.abs(to.z - from.z) + 1)
  return {
    coordinateRule: 'floor(position + integer offset)',
    offsets: REACH_FIXTURE_OFFSETS,
    fillFrom: from,
    fillTo: to,
    fillBlockCount,
    witness,
    fillCommand: `fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} minecraft:stone`,
    setblockCommand: `setblock ${witness.x} ${witness.y} ${witness.z} minecraft:oak_log`,
  }
}

function inventoryValue(snapshot) {
  const inventory = snapshot?.truth?.inventory
  if (!isPlainObject(inventory)) return null
  const counts = inventory.counts ?? inventory.items ?? inventory
  if (!isPlainObject(counts)) return null
  const normalized = {}
  for (const [key, value] of Object.entries(counts)) {
    const amount = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(amount) && amount > 0) normalized[key.replace(/^minecraft:/u, '')] = amount
  }
  return normalized
}

async function parseNbtFile(path) {
  const require = (await import('node:module')).createRequire(import.meta.url)
  const parseNbt = require('prismarine-nbt').parse
  const raw = readFileSync(path)
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
  const { parsed } = await parseNbt(bytes, 'big')
  return parsed?.value ?? null
}

function unwrapNbt(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value
}

async function parseLevelDat(levelPath) {
  const root = await parseNbtFile(levelPath)
  const data = unwrapNbt(root?.Data) ?? null
  if (!data) throw new Error('run-scoped level.dat has no Data compound')
  const settings = unwrapNbt(data.WorldGenSettings)
  const rawSeed = unwrapNbt(settings?.seed) ?? unwrapNbt(data.RandomSeed)
  let seed = null
  if (typeof rawSeed === 'bigint') seed = rawSeed.toString()
  else if (typeof rawSeed === 'number' && Number.isSafeInteger(rawSeed)) seed = String(rawSeed)
  else if (Array.isArray(rawSeed) && rawSeed.length === 2) seed = String((BigInt(rawSeed[0]) << 32n) | (BigInt(rawSeed[1]) & 0xffffffffn))
  return {
    levelName: unwrapNbt(data.LevelName) ?? null,
    dataVersion: unwrapNbt(data.DataVersion) ?? null,
    seed,
    difficultyCode: unwrapNbt(data.Difficulty) ?? null,
    gameTypeCode: unwrapNbt(data.GameType) ?? null,
  }
}

function nbtUuid(value) {
  if (typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value)) return value.toLowerCase()
  if (Array.isArray(value) && value.length === 4) {
    const hex = value.map((part) => (Number(part) >>> 0).toString(16).padStart(8, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return null
}

async function parsePlayerDat(playerPath) {
  const root = await parseNbtFile(playerPath)
  if (!isPlainObject(root)) throw new Error('playerdata has no compound root')
  const pos = unwrapNbt(unwrapNbt(root.Pos))
  const rawInventory = unwrapNbt(root.Inventory)
  const stacks = Array.isArray(rawInventory) ? rawInventory : rawInventory?.value
  const inventory = {}
  let inventoryDecodable = Array.isArray(stacks)
  if (Array.isArray(stacks)) {
    for (const rawStack of stacks) {
      const stack = rawStack?.value ?? rawStack
      const itemId = unwrapNbt(stack?.id ?? stack?.Id)
      const rawCount = unwrapNbt(stack?.count ?? stack?.Count)
      if (typeof itemId !== 'string' || !Number.isFinite(Number(rawCount))) { inventoryDecodable = false; continue }
      const item = itemId.replace(/^minecraft:/u, '')
      inventory[item] = (inventory[item] ?? 0) + Number(rawCount)
    }
  }
  return {
    uuid: nbtUuid(unwrapNbt(root.UUID)),
    dimension: unwrapNbt(root.Dimension) ?? null,
    position: Array.isArray(pos) ? pos.map(Number) : null,
    health: unwrapNbt(root.Health) ?? null,
    air: unwrapNbt(root.Air) ?? null,
    inventory,
    inventoryDecodable,
  }
}

export function parseLeafIdentity(logText, expectedLevelName = null) {
  const uuidMatch = /^\[?[^\n]*?UUID of player AI_Buddy is ([0-9a-f-]{36})/imu.exec(logText)
  const lines = logText.split(/\r?\n/u)
  const preparingLines = lines.filter((line) => /Preparing level ["'].*["']/iu.test(line)
    && !/Done preparing level/iu.test(line)
    && (expectedLevelName === null || line.includes(`"${expectedLevelName}"`) || line.includes(`'${expectedLevelName}'`)))
  const completeLines = lines.filter((line) => /Done preparing level ["']/iu.test(line)
    && (expectedLevelName === null || line.includes(`"${expectedLevelName}"`) || line.includes(`'${expectedLevelName}'`)))
  const prepared = preparingLines[0] ?? null
  const complete = completeLines[0] ?? null
  if (!uuidMatch) throw new Error('Leaf log does not contain the joined AI_Buddy UUID')
  if (!prepared) throw new Error('Leaf log does not identify the prepared level')
  if (!complete) throw new Error('Leaf log does not contain an actual level/server startup completion line')
  if (preparingLines.length !== 1) throw new Error(`expected exactly one matching Leaf Preparing level line; observed ${preparingLines.length}`)
  if (completeLines.length !== 1) throw new Error(`expected exactly one Leaf startup completion line; observed ${completeLines.length}`)
  return { botUuid: uuidMatch[1].toLowerCase(), preparedLine: prepared.trim(), completeLine: complete.trim() }
}

function copyIfRegular(source, target) {
  let stat
  try { stat = lstatSync(source) } catch { return null }
  if (stat.isSymbolicLink() || !stat.isFile()) return null
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  copyFileSync(source, target)
  return { source, target, bytes: stat.size, sha256: sha256(readFileSync(target)) }
}

function currentEvidenceRows(path) {
  if (!existsSync(path)) return []
  const rows = []
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { throw new Error(`${path}:${index + 1} is malformed JSONL`) }
  }
  return rows
}

function appendJsonl(path, row) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify(row)}\n`, { flag: 'a', mode: 0o600 })
}

function worldKeyParts(worldKey) {
  const parts = typeof worldKey === 'string' ? worldKey.split('|') : []
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/u.test(parts[2])) throw new Error('worldKey is missing or malformed')
  return { serverId: parts[0], dimension: parts[1].replace(/^minecraft:/u, ''), worldEpoch: Number(parts[2]) }
}

function loopbackOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolvePromise({ open: true, code: 'CONNECTED' }) })
    socket.once('error', (error) => resolvePromise({ open: false, code: error?.code ?? error?.name ?? 'UNKNOWN' }))
    socket.setTimeout(1500, () => { socket.destroy(); resolvePromise({ open: false, code: 'TIMEOUT' }) })
  })
}

async function fetchJson(url) {
  const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`loopback observer returned HTTP ${response.status}`)
  return await response.json()
}

async function writeLineToChild(handle, line, { timeoutMs = 5000 } = {}) {
  if (!handle?.child?.stdin || handle.child.stdin.destroyed || handle.child.exitCode !== null) throw new Error('server stdin is unavailable')
  const stdin = handle.child.stdin
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.off('error', onError)
      if (error) reject(error)
      else resolvePromise({ acknowledgedAt: isoNow() })
    }
    const onError = (error) => finish(new Error(`server stdin write failed (${error?.code ?? error?.name ?? 'UNKNOWN'})`))
    const timer = setTimeout(() => finish(new Error('server stdin write acknowledgement timed out')), timeoutMs)
    stdin.once('error', onError)
    try {
      stdin.write(`${line}\n`, (error) => finish(error ? new Error(`server stdin write failed (${error.code ?? error.name ?? 'UNKNOWN'})`) : null))
    } catch (error) {
      finish(new Error(`server stdin write failed (${error?.code ?? error?.name ?? 'UNKNOWN'})`))
    }
  })
}

function isChildRunning(handle) {
  return Boolean(handle?.child && handle.child.exitCode === null && handle.child.signalCode === null)
}

export function observeProcessGroup(pgid, killFn = process.kill) {
  if (!Number.isSafeInteger(pgid) || pgid < 1) return { state: 'invalid', pgid }
  try {
    killFn(-pgid, 0)
    return { state: 'present', pgid, observedAt: isoNow() }
  } catch (error) {
    if (error?.code === 'ESRCH') return { state: 'gone', pgid, observedAt: isoNow() }
    if (error?.code === 'EPERM') return { state: 'present', pgid, observedAt: isoNow(), reason: 'permission-denied' }
    return { state: 'unknown', pgid, observedAt: isoNow(), reason: error?.code ?? error?.name ?? 'unknown' }
  }
}

export async function terminateOwnedProcessGroup(pgid, {
  killFn = process.kill,
  observe = (target) => observeProcessGroup(target, killFn),
  wait = delay,
  intervalMs = 100,
  termTimeoutMs = 3000,
  killTimeoutMs = 5000,
} = {}) {
  if (!Number.isSafeInteger(pgid) || pgid < 1) {
    return { schema: 'vtr-process-group-closure/v1', pgid: pgid ?? null, state: 'unavailable', signals: [] }
  }
  const signals = []
  const initial = observe(pgid)
  if (initial.state === 'gone') {
    return { schema: 'vtr-process-group-closure/v1', pgid, state: 'gone', initial, signals, goneObservedAt: initial.observedAt }
  }
  const send = (signal) => {
    const sentAt = isoNow()
    try {
      killFn(-pgid, signal)
      signals.push({ signal, sentAt, result: 'sent' })
    } catch (error) {
      signals.push({ signal, sentAt, result: error?.code === 'ESRCH' ? 'already-gone' : 'error', errorCode: error?.code ?? error?.name ?? 'unknown' })
    }
  }
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let last = observe(pgid)
    while (last.state !== 'gone' && Date.now() < deadline) {
      if (last.state === 'unknown' || last.state === 'invalid') break
      await wait(intervalMs)
      last = observe(pgid)
    }
    return last
  }

  send('SIGTERM')
  let finalObservation = await waitGone(termTimeoutMs)
  if (finalObservation.state !== 'gone') {
    send('SIGKILL')
    finalObservation = await waitGone(killTimeoutMs)
  }
  return {
    schema: 'vtr-process-group-closure/v1',
    pgid,
    state: finalObservation.state === 'gone' ? 'gone' : 'INCOMPLETE',
    initial,
    signals,
    finalObservation,
    goneObservedAt: finalObservation.state === 'gone' ? finalObservation.observedAt : null,
  }
}

export function residentTerminationProblems({
  guardLoaded, guardClosed, blockedRows = [], wrapperPid, residentPid, wrapperClose,
  processGroupClosure, forced = false,
}) {
  const problems = []
  if (!guardLoaded || !Number.isSafeInteger(guardLoaded.pid) || guardLoaded.pid !== residentPid) problems.push('guard-loaded-pid-mismatch')
  if (!guardClosed || guardClosed.childPid !== residentPid) problems.push('guard-child-close-pid-mismatch')
  if (guardClosed?.childExitCode !== 0) problems.push('resident-child-exit-nonzero-or-missing')
  if (guardClosed?.processGroupGone !== true) problems.push('guard-reported-process-group-not-gone')
  if (!Number.isSafeInteger(wrapperPid) || wrapperClose?.pid !== wrapperPid) problems.push('guard-wrapper-pid-mismatch')
  if (wrapperClose?.exitCode !== 0 || wrapperClose?.signal !== null) problems.push('guard-wrapper-exit-nonzero-or-signaled')
  if (processGroupClosure?.schema !== 'vtr-process-group-closure/v1'
    || processGroupClosure?.pgid !== residentPid || processGroupClosure?.state !== 'gone') problems.push('target-process-group-not-observed-gone')
  if (blockedRows.length !== 0) problems.push('egress-denial-observed')
  if (forced) problems.push('forced-wrapper-stop')
  return problems
}

export function parseListenerOwnerOutput(port, output) {
  const lines = String(output ?? '').trim().split(/\r?\n/u).filter(Boolean)
  const matching = lines.filter((line) => {
    const columns = line.trim().split(/\s+/u)
    const localEndpoint = columns[3] ?? ''
    return localEndpoint === `127.0.0.1:${port}` || localEndpoint === `[::ffff:127.0.0.1]:${port}`
  })
  if (matching.length !== 1) return { status: 'INCOMPLETE', reason: 'expected-one-exact-loopback-listener', count: matching.length }
  const match = /users:\(\("([^"]+)",pid=(\d+),fd=\d+\)\)/u.exec(matching[0])
  if (!match) return { status: 'INCOMPLETE', reason: 'listener-pid-or-comm-unavailable' }
  return { status: 'OBSERVED', pid: Number(match[2]), comm: match[1], host: '127.0.0.1', port, observedAt: isoNow() }
}

function listenerOwner(port) {
  const result = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' },
  })
  if (result.error || result.status !== 0) return { status: 'INCOMPLETE', reason: result.error?.code ?? result.status ?? 'ss-failed' }
  return parseListenerOwnerOutput(port, result.stdout)
}

function observeOwnedProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('spawn callback did not provide an owned child PID')
  let argvBytes
  let cwd
  try {
    argvBytes = readFileSync(`/proc/${pid}/cmdline`)
    cwd = readlinkSync(`/proc/${pid}/cwd`)
  } catch (error) {
    throw new Error(`cannot observe the just-spawned child argv/cwd (${error?.code ?? error?.name})`)
  }
  const argv = argvBytes.toString('utf8').split('\0').filter(Boolean)
  if (argv.length < 2 || !isAbsolute(cwd)) throw new Error('spawned child argv/cwd observation is incomplete')
  return { pid, cwd: realpathSync(cwd), argv, commandLineSha256: sha256(Buffer.from(argv.join('\0'))) }
}

function uniqueArgValue(argv, key) {
  const matches = []
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === key) matches.push(argv[index + 1] ?? null)
  if (matches.length !== 1 || typeof matches[0] !== 'string') throw new Error(`spawned Leaf command must contain exactly one ${key} value`)
  return matches[0]
}

function observeEmptyWorldRoot({ sourceSha, levelName, serverId, port, attemptRoot, worldRoot }) {
  mkdirSync(dirname(worldRoot), { recursive: true, mode: 0o700 })
  let state = 'absent'
  if (existsSync(worldRoot)) {
    const stat = lstatSync(worldRoot)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('world root must be absent or a real directory before launch')
    const entries = readdirSync(worldRoot)
    if (entries.length !== 0) throw new Error('fresh level directory is not empty before launch')
    state = 'empty-directory'
  } else {
    mkdirSync(worldRoot, { recursive: false, mode: 0o700 })
    state = 'empty-directory'
  }
  const realWorldRoot = realpathSync(worldRoot)
  if (!ensureInside(realpathSync(attemptRoot), realWorldRoot) || realWorldRoot === realpathSync(attemptRoot)) {
    throw new Error('world root must be a strict child of the unique attempt root')
  }
  const levelDatPath = join(realWorldRoot, 'level.dat')
  const levelDatOldPath = join(realWorldRoot, 'level.dat_old')
  for (const path of [levelDatPath, levelDatOldPath]) {
    if (existsSync(path)) throw new Error(`${relative(attemptRoot, path)} already exists before fresh-world launch`)
  }
  const observation = {
    schema: 'vtr-fresh-world-prestart-observation/v1',
    sourceSha,
    serverId,
    port,
    levelName,
    observedAt: isoNow(),
    path: realWorldRoot,
    state,
    entries: [],
    levelDat: { state: 'absent', path: levelDatPath },
    levelDatOld: { state: 'absent', path: levelDatOldPath },
  }
  return observation
}

function worldWitnessTarget(terminal) {
  const candidates = [
    terminal?.commit?.detail?.witness?.target,
    terminal?.commit?.detail?.selectedRoute?.witness?.target,
    terminal?.row?.detail?.witness?.target,
  ]
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue
    const target = candidate.block ?? candidate.position ?? candidate
    if (isPlainObject(target) && [target.x, target.y, target.z].every(Number.isSafeInteger)) {
      return { x: target.x, y: target.y, z: target.z }
    }
  }
  return null
}

function witnessRegionPath(target) {
  if (!target || ![target.x, target.y, target.z].every(Number.isSafeInteger)) return null
  const chunkX = Math.floor(target.x / 16)
  const chunkZ = Math.floor(target.z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  return `r.${regionX}.${regionZ}.mca`
}

function regularFileObservation(path, archivePath) {
  let stat
  try { stat = lstatSync(path) } catch { return null }
  if (stat.isSymbolicLink() || !stat.isFile()) return null
  const bytes = readFileSync(path)
  return { archivePath, bytes: bytes.length, sha256: sha256(bytes) }
}

function capturePostStopWorldFile({ sourcePath, archivePath, attemptRoot, worldRoot, identity, server }) {
  const attemptReal = realpathSync(attemptRoot)
  const worldReal = realpathSync(worldRoot)
  const sourceReal = realpathSync(sourcePath)
  if (worldReal !== worldRoot || sourceReal !== sourcePath
    || !ensureInside(attemptReal, sourceReal) || !ensureInside(worldReal, sourceReal) || sourceReal === worldReal) {
    throw new Error(`post-stop world artifact is not a canonical child of this attempt world (${archivePath})`)
  }
  const relativePath = relative(attemptReal, sourceReal)
  const components = relativePath.split(sep).filter(Boolean)
  const pathChain = [{ path: attemptReal, realPath: realpathSync(attemptReal), kind: 'directory', symlink: false }]
  let current = attemptReal
  for (const component of components) {
    current = join(current, component)
    const stat = lstatSync(current)
    const real = realpathSync(current)
    if (stat.isSymbolicLink() || real !== current) throw new Error(`world artifact path traverses a symlink (${archivePath})`)
    pathChain.push({ path: current, realPath: real, kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', symlink: false })
  }
  if (pathChain.at(-1)?.kind !== 'file') throw new Error(`post-stop world artifact is not a regular file (${archivePath})`)
  const bytes = readFileSync(sourceReal)
  const capturedAt = isoNow()
  return {
    archivePath,
    sourcePath: sourceReal,
    realPath: sourceReal,
    capturedAt,
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId,
    worldKey: identity.worldKey,
    serverId: worldKeyParts(identity.worldKey).serverId,
    serverPid: server.serverStart.pid,
    port: server.serverStart.port,
    levelName: server.serverStart.levelName,
    bytes: bytes.length,
    sha256: sha256(bytes),
    pathChain,
    sourceBytes: bytes,
  }
}

function copyExact(source, target) {
  let stat
  try { stat = lstatSync(source) } catch { return null }
  if (stat.isSymbolicLink() || !stat.isFile()) return null
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (resolve(source) === resolve(target)) return { path: target, bytes: stat.size, sha256: sha256(readFileSync(target)), sameFile: true }
  copyFileSync(source, target, 0)
  const bytes = readFileSync(target)
  return { path: target, bytes: bytes.length, sha256: sha256(bytes) }
}

function buildRunMetadata({ runtimeSource, identity, collectorReport, terminal, server, level, player, startSnapshot, stopAt, capture }) {
  const parts = worldKeyParts(identity.worldKey)
  const transition = collectorReport?.observed?.transition ?? {}
  const buildHash = collectorReport?.observed?.generationReady?.buildHash ?? null
  const initialPosition = positionValue(startSnapshot)
  const initialInventory = inventoryValue(startSnapshot) ?? {}
  const finalPosition = player?.position && player.position.length === 3
    ? { x: player.position[0], y: player.position[1], z: player.position[2] }
    : null
  const finalInventory = player?.inventoryDecodable ? player.inventory : null
  const mission = collectorReport?.expected?.mission ?? { kind: 'inventory_at_least', item: 'oak_log', count: 1 }
  const witness = worldWitnessTarget(terminal)
  const commit = terminal?.commit?.detail ?? {}
  const verified = terminal?.row?.detail?.outcome ?? {}
  const hostLog = join(runtimeSource, 'buddy-driver', 'buddy.log')
  const rows = parseHostLog(readFileSync(hostLog, 'utf8')).map((row) => ({ ...row, ts: row.ts === null ? null : new Date(row.ts).toISOString() }))
  const readyRow = rows.find((row) => row.event === 'GENERATION_READY'
    && row.fields.runId === identity.runId
    && (row.fields.generationId ?? row.fields.id) === identity.generationId)
  const configRow = rows.find((row) => row.event === 'VTR_REACH_PROBE_CONFIGURED'
    && row.fields.mission?.item === mission.item
    && row.fields.mission?.count === mission.count)
  if (!readyRow || !configRow) throw new Error('run metadata requires exact GENERATION_READY and VTR probe configuration rows')
  // `run.shutdownAt` is the HOST's own recorded shutdown boundary (the single
  // SHUTDOWN log line), not the later process-exit observation. The provider
  // capture window binds the same line, so both must report one instant.
  const shutdownRows = rows.filter((row) => row.event === 'SHUTDOWN')
  const shutdownAt = shutdownRows.length === 1 && shutdownRows[0].ts !== null
    ? shutdownRows[0].ts
    : null
  if (shutdownAt === null) throw new Error('run metadata requires exactly one HOST SHUTDOWN log line')
  const activity = capture?.activity
  const noProviderAttemptEvidence = isPlainObject(activity)
    && activity.networkModelCalls === 0 && activity.jevEvaluateAttempts === 0 && activity.system2EvaluateAttempts === 0
    && activity.jevDecisionFrames === 0
  const policyProvider = typeof readyRow.fields.policyProvider === 'string' ? readyRow.fields.policyProvider : null
  const policyModel = typeof readyRow.fields.policyModel === 'string' && readyRow.fields.policyModel.length > 0
    ? readyRow.fields.policyModel : policyProvider === 'deterministic' ? 'none' : null
  const system2Provider = typeof readyRow.fields.system2Provider === 'string' ? readyRow.fields.system2Provider : null
  const system2Model = typeof readyRow.fields.system2Model === 'string' && readyRow.fields.system2Model.length > 0
    ? readyRow.fields.system2Model : system2Provider === 'none' ? 'none' : null
  if (!policyProvider || !policyModel || !system2Provider || !system2Model) throw new Error('GENERATION_READY does not expose an exact Jev/System2 provider and model (or explicit offline identity)')
  return {
    schema: 'vtr-reach-run-metadata/v1',
    source: {
      repository: 'souta-lab/minecraft-jev-agent',
      commit: identity.sourceSha,
      branch: runGit(runtimeSource, ['branch', '--show-current']) || 'detached-exact-source',
      buildHash,
    },
    run: {
      runId: identity.runId,
      generationId: identity.generationId,
      serverId: parts.serverId,
      worldEpoch: parts.worldEpoch,
      worldKey: identity.worldKey,
      dimension: parts.dimension,
      levelName: server.levelName,
      seed: level.seed,
      minecraftVersion: server.minecraftVersion,
      dataVersion: level.dataVersion,
      difficulty: 'peaceful',
      gameMode: 'survival',
      botUsername: 'AI_Buddy',
      botUuid: server.botUuid ?? null,
      startedAt: new Date(Number(identity.bootAt ?? Date.parse(collectorReport?.observed?.boot?.at ?? server.spawnedAt))).toISOString(),
      generationReadyAt: identity.generationReadyAt,
      shutdownAt,
      finalPosition,
      initialPosition,
    },
    mission: {
      ...mission,
      initialInventory,
      finalInventory,
      initialPosition,
      finalPosition,
    },
    fixture: witness === null ? null : {
      block: 'oak_log',
      position: witness,
      transitionStartPosition: initialPosition,
    },
    configuredNoLlmProbe: {
      BUDDY_VTR_REACH_PROBE: '1',
      BUDDY_POLICY: configRow.fields.jevPolicyMode ?? null,
      BUDDY_SYSTEM2: configRow.fields.system2Mode ?? null,
      effectiveJev: { configuredPolicy: configRow.fields.jevPolicyMode ?? null, provider: policyProvider, model: policyModel },
      effectiveSystem2: { configuredMode: configRow.fields.system2Mode ?? null, provider: system2Provider, model: system2Model },
      BUDDY_MISSION_ITEM: 'oak_log',
      BUDDY_MISSION_COUNT: '1',
      configuredPolicy: configRow.fields.jevPolicyMode ?? null,
      configuredMode: configRow.fields.system2Mode ?? null,
      fallback: {
        fallbackPolicyWasExplicitlyConfigured: true,
        silentFallbackOnProviderFailure: noProviderAttemptEvidence ? false : null,
      JevDecisionInvoked: noProviderAttemptEvidence ? false : null,
      },
    },
    transitionEvidence: {
      transitionId: terminal.transitionId,
      contractHash: terminal.contractHash,
      outcomeKind: terminal.outcomeKind,
      desiredPredicate: commit.desiredPredicate ?? null,
      witness: commit.witness ?? null,
      outcome: verified,
      mechanicalRows: Array.isArray(transition.sourceEventRows) ? transition.sourceEventRows
        .filter((row) => /VTR_MECHANICAL_STEP_(?:RESERVED|OUTCOME)/u.test(String(row.message ?? ''))) : [],
    },
  }
}

export function startRowFromLog(serverLogLines, levelName) {
  const stdoutRows = serverLogLines.filter(({ stream }) => stream === 'spawned-child-stdout')
  const versionLine = stdoutRows.find(({ line }) => /Starting minecraft server version\s+\S+/iu.test(line)) ?? null
  const preparingRows = stdoutRows.filter(({ line }) => line.includes(`Preparing level "${levelName}"`) || line.includes(`Preparing level '${levelName}'`))
  const doneRows = stdoutRows.filter(({ line }) => line.includes(`Done preparing level "${levelName}"`) || line.includes(`Done preparing level '${levelName}'`))
  if (!versionLine) return null
  if (preparingRows.length > 1) throw new Error(`Leaf emitted duplicate Preparing level lines for ${levelName}`)
  if (doneRows.length > 1) throw new Error('Leaf emitted duplicate startup completion lines')
  if (preparingRows.length !== 1 || doneRows.length !== 1) return null
  const version = /Starting minecraft server version\s+(\S+)/iu.exec(versionLine.line)?.[1] ?? null
  if (version !== '1.21.11') throw new Error(`expected Leaf/Minecraft 1.21.11; observed ${version ?? 'unknown'}`)
  if (Date.parse(preparingRows[0].ts) <= Date.parse(versionLine.ts)
    || Date.parse(doneRows[0].ts) <= Date.parse(preparingRows[0].ts)) throw new Error('Leaf startup log observations are not strictly ordered')
  return { minecraftVersion: version, versionLine, preparing: preparingRows[0], done: doneRows[0] }
}

function leafStdoutRow({ sourceSha, identity, server, receipt }) {
  return {
    schema: 'vtr-server-stdout-observation/v1',
    sourceSha,
    runId: identity.runId,
    generationId: identity.generationId ?? null,
    worldKey: identity.worldKey,
    serverId: server.serverId,
    serverPid: server.pid,
    port: server.port,
    levelName: server.levelName,
    sequence: receipt.sequence,
    receivedAt: receipt.ts,
    monotonicNs: receipt.monotonicNs,
    streamSource: 'spawned-server-stdout',
    line: receipt.line,
    lineSha256: receipt.lineSha256,
    rawLineSha256: receipt.rawLineSha256,
  }
}

function bindLeafStdoutIdentity(server, identity) {
  if (server.stdoutState.identity !== null) throw new Error('Leaf stdout identity was already bound')
  const binding = {
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId ?? null,
    worldKey: identity.worldKey,
    serverId: worldKeyParts(identity.worldKey).serverId,
    pid: server.serverStart.pid,
    port: server.options.port,
    levelName: server.serverStart.levelName,
  }
  server.stdoutState.identity = binding
  for (const receipt of server.stdoutReceipts) {
    appendJsonl(server.stdoutEventsPath, leafStdoutRow({ sourceSha: binding.sourceSha, identity: binding, server: binding, receipt }))
  }
  server.stdoutState.flushed = server.stdoutReceipts.length
  return binding
}

async function waitForPortOpen(port, handle, timeoutMs, label) {
  return await waitFor(async () => {
    if (!isChildRunning(handle)) throw new Error(`${label} child exited before its listener opened`)
    const result = await loopbackOpen(port)
    return result.open ? result : null
  }, { timeoutMs, label })
}

async function startLeaf(options, sourceSha, attemptRoot, levelName, onChild = () => {}) {
  const serverDir = join(attemptRoot, 'server')
  const universe = join(serverDir, 'universe')
  const worldRoot = join(universe, levelName)
  const configLaunch = join(serverDir, 'server.properties.launch')
  const configEffective = join(serverDir, 'server.properties.effective-after-boot')
  const eula = inspectLeafEula(options.leafJar)
  const eulaAttemptPath = join(serverDir, 'eula.txt')
  const eulaAttestationPath = join(serverDir, 'eula-attestation.json')
  const javaTmp = join(attemptRoot, 'tmp', 'java')
  const home = join(attemptRoot, 'home', 'leaf')
  for (const directory of [universe, javaTmp, home]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const serverId = `127.0.0.1:${options.port}`
  const preStart = observeEmptyWorldRoot({ sourceSha, levelName, serverId, port: options.port, attemptRoot, worldRoot })
  const preStartPath = join(serverDir, 'pre-start-world-observation.json')
  writeJsonExclusive(preStartPath, preStart)
  const launchProperties = renderProbeServerProperties({ port: options.port, levelName })
  writeFileSync(configLaunch, launchProperties, { flag: 'wx', mode: 0o600 })
  writeFileSync(eulaAttemptPath, eula.contents, { flag: 'wx', mode: 0o600 })
  const eulaAttestation = {
    schema: 'vtr-server-eula-acceptance/v1',
    accepted: true,
    sourcePath: eula.sourcePath,
    sourceSha256: eula.sourceSha256,
    attemptCopyPath: 'server/eula.txt',
    attemptCopySha256: sha256(Buffer.from(eula.contents, 'utf8')),
  }
  writeJsonExclusive(eulaAttestationPath, eulaAttestation)
  const launchProps = propertiesObject(launchProperties)
  const expected = { 'server-ip': '127.0.0.1', 'server-port': String(options.port), 'level-name': levelName, gamemode: 'survival', difficulty: 'peaceful', 'level-seed': '', 'level-type': 'minecraft:flat' }
  for (const [key, value] of Object.entries(expected)) if (launchProps[key] !== value) throw new Error(`launch properties do not contain the exact isolated profile (${key})`)
  const jarStat = realRegularFile(options.leafJar, 'Leaf jar')
  const jarSha256 = sha256(readFileSync(options.leafJar))
  if (jarStat.size <= 0) throw new Error('Leaf jar is empty')
  const serverLogLines = []
  const stdoutReceipts = []
  const stdoutState = { identity: null, flushed: 0 }
  const stdoutEventsPath = join(serverDir, 'leaf-stdout-events.jsonl')
  writeFileSync(stdoutEventsPath, '', { flag: 'wx', mode: 0o600 })
  const logPath = join(serverDir, 'leaf-latest.log')
  const args = [
    '-Xms512M', '-Xmx1G', `-Djava.io.tmpdir=${javaTmp}`,
    '-jar', options.leafJar, '--nogui', '--config', configLaunch,
    '--universe', universe, '--level-name', levelName,
  ]
  const handle = spawnCaptured(options.java, args, {
    cwd: serverDir,
    env: minimalEnvironment({ HOME: home, TMPDIR: javaTmp, LANG: 'C.UTF-8' }),
    logPath,
    stdin: 'pipe',
    onLine: (line, ts, stream, rawLine) => {
      serverLogLines.push({ line, ts, stream })
      if (stream !== 'spawned-child-stdout') return
      const receipt = {
        line,
        ts,
        sequence: stdoutReceipts.length + 1,
        monotonicNs: process.hrtime.bigint().toString(),
        lineSha256: sha256(Buffer.from(line, 'utf8')),
        rawLineSha256: sha256(Buffer.from(rawLine ?? line, 'utf8')),
      }
      stdoutReceipts.push(receipt)
      if (stdoutState.identity !== null) {
        appendJsonl(stdoutEventsPath, leafStdoutRow({ sourceSha: stdoutState.identity.sourceSha, identity: stdoutState.identity, server: stdoutState.identity, receipt }))
        stdoutState.flushed += 1
      }
    },
  })
  onChild('leaf', handle)
  const spawned = await handle.spawned
  if (!Number.isSafeInteger(spawned.pid) || spawned.pid < 1) throw new Error('Leaf child PID was not observed')
  const observedProcess = observeOwnedProcess(spawned.pid)
  if (observedProcess.cwd !== realpathSync(serverDir)) throw new Error('spawned Leaf child CWD differs from the attempt-scoped server directory')
  const jarArgIndex = observedProcess.argv.flatMap((arg, index) => arg === '-jar' ? [index] : [])
  if (jarArgIndex.length !== 1 || !observedProcess.argv[jarArgIndex[0] + 1]
    || realpathSync(observedProcess.argv[jarArgIndex[0] + 1]) !== realpathSync(options.leafJar)) {
    throw new Error('spawned Leaf child argv does not bind the selected server JAR')
  }
  const configArg = uniqueArgValue(observedProcess.argv, '--config')
  const universeArg = uniqueArgValue(observedProcess.argv, '--universe')
  const levelNameArg = uniqueArgValue(observedProcess.argv, '--level-name')
  if (resolve(observedProcess.cwd, configArg) !== configLaunch
    || resolve(observedProcess.cwd, universeArg, levelNameArg) !== worldRoot
    || levelNameArg !== levelName) throw new Error('spawned Leaf child argv does not bind exact config and unique world paths')
  const spawnObservation = {
    schema: 'vtr-server-spawn-observation/v1',
    sourceSha,
    runId: null,
    generationId: null,
    worldKey: null,
    serverId,
    port: options.port,
    levelName,
    pid: spawned.pid,
    spawnedAt: spawned.at,
    cwd: observedProcess.cwd,
    argv: observedProcess.argv,
    commandLineSha256: observedProcess.commandLineSha256,
    configPath: configLaunch,
    configSha256: sha256(Buffer.from(launchProperties)),
    jarPath: realpathSync(options.leafJar),
    jarSha256,
    universePath: universeArg,
    levelNameArg,
  }
  const startup = await waitFor(() => {
    if (!isChildRunning(handle)) throw new Error('isolated Leaf exited before startup completed')
    const lines = startRowFromLog(serverLogLines, levelName)
    if (lines === null) return null
    return lines
  }, { timeoutMs: options.timeoutMs, label: 'same-child Leaf version, fresh level, and completion log' })
  const listener = await waitForPortOpen(options.port, handle, Math.min(options.timeoutMs, 60_000), 'isolated Leaf')
  const listenerProcess = listenerOwner(options.port)
  if (listenerProcess.status !== 'OBSERVED' || listenerProcess.pid !== spawned.pid || listenerProcess.comm !== 'java') {
    throw new Error(`Leaf listener ownership differs from the spawned Java child (observed ${listenerProcess.status === 'OBSERVED' ? `${listenerProcess.comm}:${listenerProcess.pid}` : listenerProcess.reason})`)
  }
  const realWorldRoot = realpathSync(worldRoot)
  if (realWorldRoot !== worldRoot || !ensureInside(realpathSync(attemptRoot), realWorldRoot)) throw new Error('Leaf world root escaped the unique attempt directory')
  const worldSaveFromIndex = serverLogLines.length
  const worldSaveCommand = 'save-all flush'
  const worldSaveIssuedAt = isoNow()
  await writeLineToChild(handle, worldSaveCommand)
  const initialWorldSave = await waitFor(() => {
    if (!isChildRunning(handle)) throw new Error('isolated Leaf exited before its initial world save')
    const response = parseConsoleLines(serverLogLines, worldSaveFromIndex, /Saved the game/iu)
    if (!response || !existsSync(join(worldRoot, 'level.dat'))) return null
    return { command: worldSaveCommand, issuedAt: worldSaveIssuedAt, serverOutput: response.line, observedAt: response.ts, responsePid: spawned.pid }
  }, { timeoutMs: Math.min(options.timeoutMs, 60_000), label: 'Leaf initial world save and fresh level.dat' })
  const level = await parseLevelDat(join(worldRoot, 'level.dat'))
  if (level.levelName !== levelName || level.dataVersion === null || level.seed === null || level.difficultyCode !== 0 || level.gameTypeCode !== 0) {
    throw new Error('fresh level.dat does not attest the requested name, actual seed, peaceful difficulty, survival mode, and data version')
  }
  const effectiveText = existsSync(configLaunch) ? readFileSync(configLaunch, 'utf8') : ''
  const effectiveProps = propertiesObject(effectiveText)
  for (const [key, value] of Object.entries(expected)) if (effectiveProps[key] !== value) throw new Error(`effective server properties differ from the isolated profile (${key})`)
  writeFileSync(configEffective, effectiveText, { flag: 'wx', mode: 0o600 })
  const serverStart = {
    schema: 'vtr-reach-isolated-leaf/v1',
    sourceSha,
    pid: spawned.pid,
    serverPid: spawned.pid,
    host: '127.0.0.1',
    port: options.port,
    serverId,
    worldKey: `${serverId}|minecraft:overworld|1`,
    levelName,
    worldRoot: realWorldRoot,
    attemptRoot: realpathSync(attemptRoot),
    minecraftVersion: startup.minecraftVersion,
    dataVersion: level.dataVersion,
    seed: level.seed,
    difficulty: 'peaceful',
    gameMode: 'survival',
    freshWorld: true,
    serverJar: options.leafJar,
    serverJarSha256: jarSha256,
    serverPropertiesPath: configLaunch,
    serverPropertiesSha256: sha256(Buffer.from(launchProperties)),
    serverPropertiesEffectiveSha256: sha256(Buffer.from(effectiveText)),
    eulaAcceptance: eulaAttestation,
    initialWorldSave,
    startedAt: spawned.at,
    spawnedAt: spawned.at,
    process: {
      pid: spawned.pid,
      startedAt: spawned.at,
      cwd: observedProcess.cwd,
      argv: observedProcess.argv,
      universePath: universeArg,
      universeArg,
      levelNameArg,
      configArg,
      jarArg: observedProcess.argv[jarArgIndex[0] + 1],
      jarPath: realpathSync(options.leafJar),
      serverJarRealpath: realpathSync(options.leafJar),
      serverJarSha256: jarSha256,
      commandLineSha256: observedProcess.commandLineSha256,
    },
    spawnObservation,
    observedListener: listenerProcess,
    startupLog: {
      pid: spawned.pid,
      streamSource: 'spawned-server-stdout',
      version: startup.versionLine,
      preparing: startup.preparing,
      done: startup.done,
    },
  }
  const serverStartPath = join(serverDir, 'server-start.json')
  writeJsonExclusive(serverStartPath, serverStart)
  return { handle, options, attemptRoot, serverDir, universe, worldRoot: realWorldRoot, configLaunch, configEffective, eulaAttemptPath, eulaAttestationPath, eulaAttestation, logPath, serverLogLines, stdoutReceipts, stdoutState, stdoutEventsPath, preStart, preStartPath, launchProperties, effectiveText, serverStart, serverStartPath, level, jarSha256, startup }
}

async function startObserver(options, sourceSha, attemptRoot, runtimeSource, onChild = () => {}) {
  const observerDir = join(attemptRoot, 'runner')
  const observerLog = join(observerDir, 'observer.log')
  const home = join(attemptRoot, 'home', 'observer')
  const tmp = join(attemptRoot, 'tmp', 'observer')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  const observerScript = join(runtimeSource, 'tools', 'buddy-observer.mjs')
  realRegularFile(observerScript, 'read-only observer script')
  const logFd = openSync(observerLog, 'wx', 0o600)
  let childProcess
  try {
    childProcess = spawn(process.execPath, ['--no-env-file', observerScript], {
      cwd: runtimeSource,
      env: minimalEnvironment({ HOME: home, TMPDIR: tmp, LANG: 'C.UTF-8',
        BUDDY_OBSERVER_RUNTIME_DIR: join(runtimeSource, 'buddy-driver'),
        BUDDY_OBSERVER_HOST: '127.0.0.1', BUDDY_OBSERVER_PORT: String(options.observerPort),
      }),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
  } finally { closeSync(logFd) }
  const child = { child: childProcess, spawned: new Promise((resolvePromise, reject) => {
    childProcess.once('spawn', () => resolvePromise({ pid: childProcess.pid, at: isoNow() }))
    childProcess.once('error', (error) => reject(new Error(`observer spawn failed (${error.code ?? error.name})`)))
  }), closed: commandPromise(childProcess), logPath: observerLog }
  onChild('observer', child)
  const spawned = await child.spawned
  childProcess.unref()
  const url = `http://127.0.0.1:${options.observerPort}/api/ai-summary`
  await waitFor(async () => {
    if (!isChildRunning(child)) throw new Error('dedicated observer exited before readiness')
    const listener = await loopbackOpen(options.observerPort)
    if (!listener.open) return null
    const owner = listenerOwner(options.observerPort)
    if (owner.status !== 'OBSERVED' || owner.pid !== spawned.pid) throw new Error('dedicated observer listener is not owned by its spawned process')
    try { return await fetchJson(url) } catch { return null }
  }, { timeoutMs: 20_000, label: 'dedicated read-only observer on the exact attempt runtime' })
  const manifestPath = join(observerDir, 'observer-lifecycle.json')
  const initial = {
    schema: 'vtr-reach-observer-lifecycle/v1',
    sourceSha,
    runtimeDir: realpathSync(join(runtimeSource, 'buddy-driver')),
    observerUrl: url,
    host: '127.0.0.1',
    port: options.observerPort,
    pid: spawned.pid,
    spawnParentPid: process.pid,
    spawnedAt: spawned.at,
    policy: 'leave-bound',
    previousBindingAvailable: false,
    logPath: observerLog,
  }
  writeJsonExclusive(manifestPath, initial)
  return { handle: child, url, manifestPath, logPath: observerLog, runtimeDir: initial.runtimeDir, sourceSha, port: options.observerPort, spawnedAt: spawned.at, pid: spawned.pid, initial }
}

function bindObserverAdapter(observer) {
  return {
    async bind({ runtimeDir, sourceSha, policy }) {
      if (policy !== 'leave-bound' || realpathSync(runtimeDir) !== observer.runtimeDir || sourceSha.toLowerCase() !== observer.sourceSha.toLowerCase()) throw new Error('observer source/runtime/policy mismatch')
      if (!isChildRunning(observer.handle)) throw new Error('dedicated observer process is not running')
      const listener = await loopbackOpen(observer.port)
      if (!listener.open) throw new Error('dedicated observer loopback listener is not open')
      return { status: 'BOUND', runtimeDir: observer.runtimeDir, sourceSha, observerUrl: observer.url, previousBindingAvailable: false, pid: observer.pid }
    },
    async readSummary() { return await fetchJson(observer.url) },
    async restore({ policy }) {
      if (policy !== 'leave-bound' || !isChildRunning(observer.handle)) throw new Error('observer was not retained under its declared leave-bound policy')
      const listener = await loopbackOpen(observer.port)
      if (!listener.open) throw new Error(`dedicated observer loopback port is unavailable (${listener.code})`)
      return { status: 'LEFT_BOUND', runtimeDir: observer.runtimeDir, pid: observer.pid, port: observer.port, confirmedAt: isoNow() }
    },
  }
}

function findControlSocket(runtimeDir) {
  return join(runtimeDir, 'data', 'resident', 'control.sock')
}

async function readInitialResidentSnapshot(runtimeDir, identity, attemptRoot) {
  const socketPath = findControlSocket(runtimeDir)
  const deadline = Date.now() + 60_000
  let report = null
  while (Date.now() < deadline) {
    try {
      report = await controlRequest(socketPath, 'report', {}, 2500)
      if (report?.runId === identity.runId && report.frozen === true && report.connected === true) break
    } catch {}
    await delay(200)
  }
  if (!report || report.runId !== identity.runId || report.frozen !== true || report.connected !== true) throw new Error('resident did not reach frozen+connected state for exact BOOT run')
  const worldKey = report.worldKey
  const worldKeyText = isPlainObject(worldKey) ? `${worldKey.serverId}|${worldKey.dimension}|${worldKey.worldEpoch}` : String(worldKey ?? '')
  if (worldKeyText.replace('|minecraft:', '|') !== identity.worldKey.replace('|minecraft:', '|')) throw new Error('resident control report world identity differs from BOOT')
  const snapshot = await controlRequest(socketPath, 'state', { radius: 8, verticalRadius: 4 })
  const snapshotPath = join(attemptRoot, 'runner', 'initial-snapshot.json')
  const normalized = {
    schema: 'vtr-reach-initial-snapshot/v1',
    sourceSha: identity.sourceSha,
    bootSourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: null,
    worldKey: identity.worldKey,
    worldEpoch: worldKeyParts(identity.worldKey).worldEpoch,
    capturedAt: isoNow(),
    initialInventory: inventoryValue(snapshot) ?? {},
    initialPosition: positionValue(snapshot),
    truth: snapshot?.truth ?? null,
    state: snapshot,
  }
  writeJsonExclusive(snapshotPath, normalized)
  return { snapshot, report, normalized, path: snapshotPath }
}

function parseConsoleLines(lines, fromIndex, pattern) {
  const found = lines.slice(fromIndex).filter(({ line }) => pattern.test(line))
  if (found.length > 1) throw new Error('fixture console emitted more than one matching response for one command')
  return found[0] ?? null
}

class LeafFixtureProbeError extends Error {
  constructor(code, phase) {
    super(`${phase} did not receive its required Leaf console acknowledgement`)
    this.name = 'LeafFixtureProbeError'
    this.code = code
    this.phase = phase
  }
}

function fixtureCommandAttemptsPath(attemptRoot) {
  return join(attemptRoot, 'runner', 'fixture-command-attempts.jsonl')
}

function appendFixtureCommandAttempt(attemptRoot, row) {
  appendJsonl(fixtureCommandAttemptsPath(attemptRoot), {
    schema: 'vtr-fixture-console-attempt/v1',
    ...row,
  })
}

export async function issueLeafCommand(server, command, expectedResponse, {
  timeoutMs = 15_000,
  phase,
  identity,
  sourceSha,
  attemptRoot,
} = {}) {
  if (!['fixture.console-smoke', 'fixture.fill', 'fixture.setblock'].includes(phase)) throw new Error('Leaf fixture command phase is required and must be allowlisted')
  if (!isChildRunning(server.handle)) throw new Error('isolated Leaf exited before fixture command')
  const fromIndex = server.serverLogLines.length
  const issuedAt = isoNow()
  const kind = phase.slice('fixture.'.length)
  const identityFields = {
    sourceSha: sourceSha ?? identity?.sourceSha ?? null,
    runId: identity?.runId ?? null,
    generationId: identity?.generationId ?? null,
    worldKey: identity?.worldKey ?? null,
    serverId: identity?.worldKey ? worldKeyParts(identity.worldKey).serverId : null,
    leaseId: null,
  }
  const commandSha256 = sha256(Buffer.from(command, 'utf8'))
  const attemptBase = {
    ...identityFields,
    phase,
    kind,
    serverPid: server.serverStart.pid,
    issuedAt,
    commandSha256,
    serverLogStartSequence: fromIndex,
  }
  appendFixtureCommandAttempt(attemptRoot, { ...attemptBase, event: 'dispatch-started' })
  let writeAcknowledgement
  try {
    writeAcknowledgement = await writeLineToChild(server.handle, command)
    appendFixtureCommandAttempt(attemptRoot, { ...attemptBase, event: 'stdin-write-acknowledged', ...writeAcknowledgement })
  } catch (error) {
    appendFixtureCommandAttempt(attemptRoot, {
      ...attemptBase,
      event: 'stdin-write-failed',
      errorCode: /^[A-Z0-9_]{1,64}$/u.test(String(error?.code ?? '')) ? error.code : 'STDIN_WRITE_FAILED',
      stdinDestroyed: server.handle.child.stdin.destroyed,
      childExitCode: server.handle.child.exitCode,
    })
    throw new LeafFixtureProbeError('LEAF_FIXTURE_STDIN_WRITE_FAILED', phase)
  }

  let response
  try {
    response = await waitFor(() => parseConsoleLines(server.serverLogLines, fromIndex, expectedResponse), {
      timeoutMs, label: `Leaf console response to ${kind}`,
    })
  } catch (error) {
    const outputRows = server.serverLogLines.slice(fromIndex).map(({ line, ts, stream }) => ({
      ts,
      stream,
      line: redactOperationalText(line).slice(0, 500),
    }))
    const outputBytes = Buffer.from(JSON.stringify(outputRows), 'utf8')
    appendFixtureCommandAttempt(attemptRoot, {
      ...attemptBase,
      event: 'response-timeout',
      stdinAcknowledgedAt: writeAcknowledgement.acknowledgedAt,
      timedOutAt: isoNow(),
      outputRowCount: outputRows.length,
      outputSha256: sha256(outputBytes),
      outputTail: outputRows.slice(-30),
      stdinDestroyed: server.handle.child.stdin.destroyed,
      childExitCode: server.handle.child.exitCode,
      childSignalCode: server.handle.child.signalCode,
    })
    const code = phase === 'fixture.console-smoke' ? 'LEAF_FIXTURE_CONSOLE_SMOKE_RESPONSE_TIMEOUT'
      : phase === 'fixture.fill' ? 'LEAF_FIXTURE_FILL_RESPONSE_TIMEOUT'
        : 'LEAF_FIXTURE_SETBLOCK_RESPONSE_TIMEOUT'
    throw new LeafFixtureProbeError(code, phase)
  }
  const receipts = server.stdoutReceipts.filter((entry) => entry.ts === response.ts && entry.line === response.line)
  if (response.stream !== 'spawned-child-stdout' || receipts.length !== 1) {
    appendFixtureCommandAttempt(attemptRoot, {
      ...attemptBase,
      event: 'response-unreceipted',
      responseAt: response.ts,
      responseSha256: sha256(Buffer.from(response.line, 'utf8')),
      matchingStdoutReceipts: receipts.length,
      responseStream: response.stream,
    })
    throw new LeafFixtureProbeError('LEAF_FIXTURE_RESPONSE_RECEIPT_MISSING', phase)
  }
  const responseReceipt = receipts[0]
  appendFixtureCommandAttempt(attemptRoot, {
    ...attemptBase,
    event: 'response-observed',
    responseAt: response.ts,
    responseSequence: responseReceipt.sequence,
    responseSha256: sha256(Buffer.from(response.line, 'utf8')),
    responseLine: redactOperationalText(response.line).slice(0, 500),
  })
  return {
    issuedAt,
    command,
    commandSha256,
    stdinAcknowledgedAt: writeAcknowledgement.acknowledgedAt,
    serverOutput: response.line,
    observedAt: response.ts,
    responsePid: server.serverStart.pid,
    responseSequence: responseReceipt.sequence,
  }
}

async function prepareFixtureContext({ server, runtimeDir, attemptRoot, identity, sourceSha, startSnapshot }) {
  const serverId = worldKeyParts(identity.worldKey).serverId
  const preStart = server.preStart
  const preStartIdentityBound = {
    sourceSha,
    runId: identity.runId,
    serverPid: server.serverStart.pid,
    serverId,
    port: server.options.port,
    levelName: server.serverStart.levelName,
  }
  const boundPreStart = {
    ...preStart,
    sourceSha,
    runId: identity.runId,
    serverPid: server.serverStart.pid,
    serverId,
    port: server.options.port,
    levelName: server.serverStart.levelName,
    identity: preStartIdentityBound,
    identityBoundAt: isoNow(),
    identityBindingMethod: 'pre-spawn-observation-bound-to-child-pid-and-exact-BOOT-run',
    observationArtifact: { path: relative(attemptRoot, server.preStartPath).split(sep).join('/'), sha256: sha256(readFileSync(server.preStartPath)) },
  }
  server.boundPreStart = boundPreStart
  server.identity = identity
  bindLeafStdoutIdentity(server, identity)
  writeJsonAtomic(server.serverStartPath, {
    ...server.serverStart,
    runId: identity.runId,
    generationId: null,
    worldKey: identity.worldKey,
    worldEpoch: worldKeyParts(identity.worldKey).worldEpoch,
    serverId,
    spawnObservation: {
      ...server.serverStart.spawnObservation,
      sourceSha,
      runId: identity.runId,
      generationId: null,
      worldKey: identity.worldKey,
    },
  })
  server.serverStart = JSON.parse(readFileSync(server.serverStartPath, 'utf8'))
  if (server.stdoutReceipts.length === 0 || server.stdoutState.flushed !== server.stdoutReceipts.length) {
    throw new Error('spawned Leaf child stdout receipt stream was not completely bound to exact BOOT identity')
  }
  const initial = await readInitialResidentSnapshot(runtimeDir, identity, attemptRoot)
  if (startSnapshot) startSnapshot.value = initial

  const initialPosition = initial.normalized.initialPosition
  const geometry = buildReachFixtureGeometry(initialPosition)
  const anchorSnapshotPath = join(attemptRoot, 'runner', 'fixture-anchor-snapshot.json')
  writeJsonExclusive(anchorSnapshotPath, initial.normalized)
  const fixtureAnchor = {
    schema: 'vtr-reach-fixture-anchor/v1',
    sourceSha,
    runId: identity.runId,
    generationId: null,
    leaseId: null,
    worldKey: identity.worldKey,
    worldEpoch: worldKeyParts(identity.worldKey).worldEpoch,
    snapshotPath: 'runner/fixture-anchor-snapshot.json',
    snapshotSha256: sha256(readFileSync(anchorSnapshotPath)),
    positionSource: 'runner/fixture-anchor-snapshot.json.initialPosition',
    initialPosition,
    coordinateRule: geometry.coordinateRule,
    offsets: geometry.offsets,
  }

  const fixtureRows = []
  await issueLeafCommand(server, 'time query daytime', /\bThe time is \d+\b/iu, {
    phase: 'fixture.console-smoke', identity, sourceSha, attemptRoot,
  })
  const fill = await issueLeafCommand(server, geometry.fillCommand, new RegExp(`\\bSuccessfully filled ${geometry.fillBlockCount} block(?:s|\\(s\\))?\\b`, 'iu'), {
    phase: 'fixture.fill', identity, sourceSha, attemptRoot,
  })
  fixtureRows.push({ schema: 'vtr-reach-fixture-command/v2', kind: 'fill', sourceSha, runId: identity.runId, generationId: null, leaseId: null, worldKey: identity.worldKey, serverId, serverPid: server.serverStart.pid, phase: 'resident-frozen-before-generation-ready', fixtureAnchor, ...fill })
  const setblock = await issueLeafCommand(server, geometry.setblockCommand, /\bChanged(?: the)? block at\s+-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\b/iu, {
    phase: 'fixture.setblock', identity, sourceSha, attemptRoot,
  })
  fixtureRows.push({ schema: 'vtr-reach-fixture-command/v2', kind: 'setblock', sourceSha, runId: identity.runId, generationId: null, leaseId: null, worldKey: identity.worldKey, serverId, serverPid: server.serverStart.pid, phase: 'resident-frozen-before-generation-ready', fixtureAnchor, ...setblock })
  const transcriptPath = join(attemptRoot, 'server', 'fixture-commands.jsonl')
  mkdirSync(dirname(transcriptPath), { recursive: true, mode: 0o700 })
  writeFileSync(transcriptPath, `${fixtureRows.map((row) => JSON.stringify(row)).join('\n')}\n`, { flag: 'wx', mode: 0o600 })
  return { status: 'READY', path: transcriptPath, sha256: sha256(readFileSync(transcriptPath)), rows: fixtureRows.length, preStartIdentity: preStartIdentityBound, stdoutEventPath: server.stdoutEventsPath }
}

async function waitAndBindGenerationReady(server, runtimeDir, runId, timeoutMs) {
  const hostLog = join(runtimeDir, 'buddy.log')
  const row = await waitFor(() => {
    const candidates = hostRows(hostLog).filter((entry) => entry.event === 'GENERATION_READY'
      && entry.fields.runId === runId)
    if (candidates.length > 1) throw new Error('multiple GENERATION_READY rows appeared before probe ownership was bound')
    return candidates[0] ?? null
  }, { timeoutMs, label: 'GENERATION_READY after explicit frozen resume' })
  const generationId = row.fields.generationId ?? row.fields.id
  if (typeof generationId !== 'string' || generationId.length === 0) throw new Error('GENERATION_READY did not expose an exact generation id')
  const identity = server.identity
  if (!identity || identity.runId !== runId) throw new Error('server BOOT identity was not bound before resume')
  const next = {
    ...server.serverStart,
    generationId,
    worldKey: identity.worldKey,
    spawnObservation: {
      ...server.serverStart.spawnObservation,
      runId,
      generationId,
      worldKey: identity.worldKey,
    },
  }
  writeJsonAtomic(server.serverStartPath, next)
  server.serverStart = next
  server.identity = { ...identity, generationId, generationReadyAt: new Date(row.ts).toISOString() }
  if (server.stdoutState?.identity) server.stdoutState.identity = { ...server.stdoutState.identity, generationId }
  return server.identity
}

async function startResident(options, sourceSha, attemptRoot, runtimeSource, runtimeDir, paths, onChild = () => {}) {
  const home = join(attemptRoot, 'home', 'resident')
  const tmp = join(attemptRoot, 'tmp', 'resident')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  const auditPath = join(attemptRoot, 'runner', 'no-llm-egress-audit.json')
  const guardLogPath = join(attemptRoot, 'runner', 'resident-guard.log')
  const guardScript = join(runtimeSource, 'tools', 'with-no-llm-egress-guard.mjs')
  const residentScript = join(runtimeSource, 'buddy-driver', 'agent-runner.mts')
  const env = minimalEnvironment({
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C.UTF-8',
    BUDDY_HOST: '127.0.0.1',
    BUDDY_PORT: String(options.port),
    BUDDY_USERNAME: 'AI_Buddy',
    BUDDY_MISSION_ITEM: 'oak_log',
    BUDDY_MISSION_COUNT: '1',
    BUDDY_START_FROZEN: '1',
    BUDDY_VTR_REACH_PROBE: '1',
    BUDDY_POLICY: 'fallback',
    BUDDY_SYSTEM2: 'off',
    VTR_REACH_SOURCE_SHA: sourceSha,
    VTR_REACH_AUTHORITY_FIXTURE_REPORT: join(attemptRoot, 'runner', 'no-double-authority-fixture.json'),
    // Run-scoped world-identity record written by the supervisor at terminal
    // collection; the resident's acceptance report consumes it read-only so
    // levelName/seed carry real bound values instead of null.
    BUDDY_WORLD_IDENTITY_PATH: join(attemptRoot, 'runner', 'world-identity.json'),
  })
  const residentHandle = {
    process: null,
    child: null,
    wrapperPid: null,
    residentPid: null,
    auditPath,
    guardLogPath,
    runtimeDir,
    paths,
    sourceSha,
    serverPort: options.port,
    serverId: `127.0.0.1:${options.port}`,
    startupComplete: false,
  }
  const handle = spawnCaptured('node', [guardScript, '--audit', auditPath, '--', process.execPath, '--no-env-file', residentScript], {
    cwd: runtimeSource,
    env,
    logPath: guardLogPath,
    stdin: 'ignore',
    detached: false,
  })
  Object.assign(residentHandle, { process: handle, child: handle.child })
  // Register a mutable handle before waiting for spawn or guard_loaded so the
  // outer failure path can still find and stop a partially started resident.
  onChild('resident', residentHandle)
  const spawned = await handle.spawned
  if (!Number.isSafeInteger(spawned.pid) || spawned.pid < 1) throw new Error('egress-guard wrapper child PID was not observed')
  residentHandle.wrapperPid = spawned.pid
  const loadedRows = await waitFor(() => {
    const rows = currentEvidenceRows(auditPath).filter((row) => row.event === 'guard_loaded')
    return rows[0] ?? null
  }, { timeoutMs: 30_000, label: 'guard_loaded for the resident child process' })
  if (!Number.isSafeInteger(loadedRows.pid) || loadedRows.pid < 1 || loadedRows.pid === spawned.pid) {
    throw new Error('egress guard did not identify a distinct resident child PID')
  }
  residentHandle.residentPid = loadedRows.pid
  residentHandle.startupComplete = true
  return { frozen: true, pid: loadedRows.pid, handle: residentHandle }
}

async function stopResident({ handle, identity, pid, attemptRoot, gracefulTimeoutMs = null, wrapperTermTimeoutMs = 12_000 }) {
  const processHandle = handle.process
  if (!processHandle?.child || !processHandle?.closed) throw new Error('registered resident handle has no observable egress-guard child')
  if (isChildRunning(processHandle)) {
    try { await controlRequest(findControlSocket(handle.runtimeDir), 'quit', {}, 10_000) } catch {}
  }
  const forced = { value: false }
  // A start failure can reach this adapter before BOOT or guard_loaded. Keep
  // that cleanup bounded while giving a fully started resident its normal
  // graceful shutdown window.
  const gracefulWindowMs = Number.isSafeInteger(gracefulTimeoutMs) && gracefulTimeoutMs >= 0
    ? gracefulTimeoutMs : handle.startupComplete ? 90_000 : 5000
  let result = await Promise.race([
    processHandle.closed,
    delay(gracefulWindowMs).then(() => null),
  ])
  if (result === null) {
    forced.value = true
    try { processHandle.child.kill('SIGTERM') } catch {}
    result = await Promise.race([processHandle.closed, delay(wrapperTermTimeoutMs).then(() => null)])
  }

  // The guard is responsible for the resident's detached process group. If
  // its wrapper does not close after TERM, explicitly terminate that group and
  // verify ESRCH before escalating to SIGKILL on the wrapper. This prevents
  // killing the only supervisor while leaving the resident orphaned.
  let audit = currentEvidenceRows(handle.auditPath)
  const loadedBeforeClose = audit.filter((row) => row.event === 'guard_loaded')
  const rootLoadedBeforeClose = loadedBeforeClose[0] ?? null
  const auditPid = rootLoadedBeforeClose?.pid
  const residentPid = handle.residentPid ?? pid ?? auditPid ?? null
  let processGroupClosure = residentPid
    ? await terminateOwnedProcessGroup(residentPid, {
      termTimeoutMs: result === null ? 3000 : 0,
      killTimeoutMs: 5000,
    })
    : { schema: 'vtr-process-group-closure/v1', pgid: null, state: 'unavailable', signals: [] }

  if (result === null) {
    if (residentPid && processGroupClosure.state !== 'gone') {
      writeJsonExclusive(join(attemptRoot, 'runner', 'resident-process-group-closure.json'), {
        schema: 'vtr-resident-process-group-termination/v1',
        sourceSha: handle.sourceSha,
        runId: identity?.runId ?? null,
        generationId: identity?.generationId ?? null,
        wrapperPid: handle.wrapperPid ?? processHandle.child.pid ?? null,
        residentPid,
        processGroupClosure,
        wrapperEscalation: { status: 'withheld-until-target-group-disappears' },
      })
      throw new Error('resident target process group remained present after SIGTERM/SIGKILL; wrapper SIGKILL withheld to avoid orphaning it')
    }
    forced.value = true
    try { process.kill(processHandle.child.pid, 'SIGKILL') } catch {}
    result = await Promise.race([processHandle.closed, delay(5_000).then(() => null)])
  }
  if (result === null) throw new Error('resident/egress-guard wrapper could not be stopped after TERM/KILL escalation')
  if (!Number.isSafeInteger(result.code)) throw new Error('resident egress-guard wrapper close event had no numeric exit status')
  audit = currentEvidenceRows(handle.auditPath)
  const loaded = audit.filter((row) => row.event === 'guard_loaded')
  const rootLoaded = loaded[0] ?? null
  const closed = audit.filter((row) => row.event === 'guard_wrapper_closed')
  const blocked = audit.filter((row) => row.event === 'blocked_egress')
  if (rootLoaded && !residentPid) {
    processGroupClosure = await terminateOwnedProcessGroup(rootLoaded.pid, { termTimeoutMs: 0, killTimeoutMs: 5000 })
  }
  if (rootLoaded && processGroupClosure.state !== 'gone') {
    // The target is already known to the wrapper. Never silently treat a
    // wrapper close as proof that this separate child process group vanished.
    processGroupClosure = await terminateOwnedProcessGroup(rootLoaded.pid, { termTimeoutMs: 0, killTimeoutMs: 5000 })
  }
  if (processGroupClosure.signals?.length > 0) forced.value = true
  const groupClosedRow = {
    schema: 'vtr-resident-process-group-close-observation/v1',
    sourceSha: handle.sourceSha,
    runId: identity?.runId ?? null,
    generationId: identity?.generationId ?? null,
    wrapperPid: handle.wrapperPid ?? processHandle.child.pid ?? null,
    residentPid: rootLoaded?.pid ?? residentPid,
    groupClosure: processGroupClosure,
    guardLoaded: rootLoaded ? { pid: rootLoaded.pid, utc: rootLoaded.utc } : null,
    guardWrapperClosed: closed[0] ? {
      childPid: closed[0].childPid,
      childExitCode: closed[0].childExitCode,
      processGroupGone: closed[0].processGroupGone,
      utc: closed[0].utc,
    } : null,
    wrapperClose: { pid: handle.wrapperPid ?? processHandle.child.pid ?? null, exitCode: result.code, signal: result.signal ?? null, observedAt: result.at },
  }
  if (!existsSync(join(attemptRoot, 'runner', 'resident-process-group-closure.json'))) {
    writeJsonExclusive(join(attemptRoot, 'runner', 'resident-process-group-closure.json'), groupClosedRow)
  }
  const expectedPid = pid ?? handle.residentPid ?? rootLoaded?.pid ?? null
  const wrapperPid = handle.wrapperPid ?? processHandle.child.pid
  const guardAuditWarnings = existsSync(handle.guardLogPath)
    ? readFileSync(handle.guardLogPath, 'utf8').match(/vtr-egress-guard:\s+audit write failed/giu) ?? []
    : []
  const closeHashes = closed[0] ?? {}
  const hashFields = ['toolSha256', 'sourceSha256', 'librarySha256', 'policySha256']
  const rootLoadedRows = loaded.filter((row) => row.pid === (handle.residentPid ?? residentPid))
  const processKeys = loaded.map((row) => `${row.pid}:${row.processStartTicks}`)
  const invalidLoadedRows = rootLoadedRows.length !== 1 || new Set(processKeys).size !== loaded.length
    || loaded.some((row) => row.reason !== 'preload-active'
    || !Number.isSafeInteger(row.pid) || row.pid < 1
    || !Number.isSafeInteger(row.processStartTicks) || row.processStartTicks < 1
    || !Number.isSafeInteger(row.processGroupId) || row.processGroupId !== (handle.residentPid ?? residentPid)
    || hashFields.some((key) => row[key] !== closeHashes[key]))
    || blocked.some((row) => !loaded.some((entry) => entry.pid === row.pid && entry.processStartTicks === row.processStartTicks)
      || row.processGroupId !== (handle.residentPid ?? residentPid))
  const terminationProblems = residentTerminationProblems({
    guardLoaded: rootLoaded, guardClosed: closed[0], blockedRows: blocked,
    wrapperPid, residentPid: expectedPid,
    wrapperClose: { pid: wrapperPid, exitCode: result.code, signal: result.signal ?? null },
    processGroupClosure, forced: forced.value,
  })
  if (guardAuditWarnings.length > 0) terminationProblems.push('guard-audit-write-failed')
  if (invalidLoadedRows) terminationProblems.push('guard-loaded-row-invalid-or-unbound')
  if (loaded.length < 1 || closed.length !== 1
    || closed[0].coverageStatus !== 'USERSPACE_ONLY_CLOSED'
    || closed[0].preloadVerified !== true
    || closed[0].guardLoadedRows !== loaded.length
    || closed[0].auditPathIdentityVerified !== true
    || closed[0].externalDeniedAttempts !== 0
    || terminationProblems.length > 0) {
    throw new Error(`no-LLM egress audit is incomplete or unsafe (${terminationProblems.join(',') || 'capture-contract-mismatch'})`)
  }
  const provenance = {
    schema: 'vtr-no-llm-egress-provenance/v1',
    sourceSha: handle.sourceSha,
    runId: identity?.runId ?? null,
    generationId: identity?.generationId ?? null,
    guardAuditPath: handle.auditPath,
    guardAuditSha256: sha256(readFileSync(handle.auditPath)),
    childPid: rootLoaded.pid,
    guardLoadedRows: loaded.length,
    processGroupClosurePath: 'runner/resident-process-group-closure.json',
    processGroupClosureSha256: sha256(readFileSync(join(attemptRoot, 'runner', 'resident-process-group-closure.json'))),
    guardWrapperPid: handle.wrapperPid,
    coverageStatus: closed[0].coverageStatus,
    externalDeniedAttempts: closed[0].externalDeniedAttempts,
    blockedEgressRows: blocked.length,
    guardToolSha256: closed[0].toolSha256,
    guardSourceSha256: closed[0].sourceSha256,
    guardLibrarySha256: closed[0].librarySha256,
    guardPolicySha256: closed[0].policySha256,
    openedAt: rootLoaded.utc,
    closedAt: closed[0].utc,
    processGroupGone: closed[0].processGroupGone,
  }
  writeJsonExclusive(join(attemptRoot, 'runner', 'no-llm-egress-provenance.json'), provenance)
  if (rootLoaded.pid !== expectedPid || handle.residentPid && handle.residentPid !== expectedPid) throw new Error('egress audit resident PID differs from the supervisor-owned PID')
  const observedAt = closed[0].utc
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('egress wrapper closure row lacks a valid UTC close timestamp')
  return {
    status: 'STOPPED',
    pid,
    serverId: identity?.worldKey ? worldKeyParts(identity.worldKey).serverId : null,
    exitCode: closed[0].childExitCode,
    stoppedAt: observedAt,
    wrapperPid: handle.wrapperPid ?? processHandle.child.pid,
    processGroupClosure,
    processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: expectedPid, exitCode: closed[0].childExitCode, observedAt },
  }
}

async function stopLeaf({ attestation, attemptRoot, server }) {
  if (isChildRunning(server.handle)) {
    try { await writeLineToChild(server.handle, 'stop') } catch {}
  }
  let result = await Promise.race([server.handle.closed, delay(90_000).then(() => null)])
  let forced = false
  if (result === null) {
    forced = true
    try { server.handle.child.kill('SIGTERM') } catch {}
    result = await Promise.race([server.handle.closed, delay(12_000).then(() => null)])
  }
  if (result === null) {
    try { process.kill(server.handle.child.pid, 'SIGKILL') } catch {}
    result = await Promise.race([server.handle.closed, delay(5_000).then(() => null)])
  }
  if (result === null) throw new Error('isolated Leaf could not be stopped after TERM/KILL escalation')
  if (!Number.isSafeInteger(result.code)) throw new Error('Leaf child close event had no numeric exit status')
  const closure = await portClosed(attestation.port)
  if (closure.closed !== true || closure.code !== 'ECONNREFUSED') throw new Error(`Leaf loopback listener did not produce connection-refused after child exit (${closure.code})`)
  const stoppedAt = closure.observedAt
  if (result.code !== 0 || forced) {
    const failurePath = join(attemptRoot, 'server', 'stop-failure.json')
    writeJsonExclusive(failurePath, {
      schema: 'vtr-reach-server-stop-failure/v1',
      sourceSha: server.identity?.sourceSha ?? server.serverStart.sourceSha,
      runId: server.identity?.runId ?? server.serverStart.runId,
      generationId: server.identity?.generationId ?? server.serverStart.generationId,
      pid: attestation.pid,
      exitCode: result.code,
      forced,
      processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: attestation.pid, exitCode: result.code, observedAt: result.at },
      listenerClosureObservation: { schema: 'vtr-listener-closure-observation/v1', source: 'tcp-connect-probe', state: 'closed', host: '127.0.0.1', port: attestation.port, result: 'connection-refused', observedAt: closure.observedAt },
    })
    throw new Error(`isolated Leaf shutdown was ${forced ? 'forced' : 'nonzero'}; stop evidence retained at server/stop-failure.json`)
  }
  return {
    status: 'STOPPED',
    port: attestation.port,
    pid: attestation.pid,
    serverId: worldKeyParts(attestation.worldKey).serverId,
    exitCode: result.code,
    stoppedAt,
    processExitObservation: { schema: 'vtr-process-exit-observation/v1', source: 'child-close-event', state: 'exited', pid: attestation.pid, exitCode: result.code, observedAt: result.at },
    listenerClosureObservation: { schema: 'vtr-listener-closure-observation/v1', source: 'tcp-connect-probe', state: 'closed', host: '127.0.0.1', port: attestation.port, result: 'connection-refused', observedAt: stoppedAt },
    attemptRoot,
  }
}

async function writeFreshWorldAttestation({ attemptRoot, server, identity, collectorReport, terminal, player, level, serverStoppedAt }) {
  if (!Number.isFinite(Date.parse(serverStoppedAt ?? ''))) throw new Error('fresh-world post-run observation requires the exact server-stopped timestamp')
  const processStart = server.serverStart.process
  if (!processStart || processStart.pid !== server.serverStart.pid
    || resolve(processStart.universePath, processStart.levelNameArg) !== server.worldRoot
    || processStart.levelNameArg !== server.serverStart.levelName
    || processStart.serverJarSha256 !== server.serverStart.serverJarSha256) {
    throw new Error('server-start process arguments do not derive the attested unique world root')
  }
  const levelDat = join(server.worldRoot, 'level.dat')
  const playerPath = player?.uuid ? join(server.worldRoot, 'playerdata', `${player.uuid}.dat`) : null
  const witness = worldWitnessTarget(terminal)
  const regionName = witnessRegionPath(witness)
  const regionPath = regionName ? join(server.worldRoot, 'region', regionName) : null
  const files = []
  const levelEntry = capturePostStopWorldFile({ sourcePath: levelDat, archivePath: 'server/world/level.dat', attemptRoot, worldRoot: server.worldRoot, identity, server })
  files.push(levelEntry)
  const playerArchivePath = player?.uuid ? `server/world/playerdata/${player.uuid}.dat` : null
  if (!playerPath || !playerArchivePath) throw new Error('Leaf UUID-bound playerdata path is unavailable after stop')
  files.push(capturePostStopWorldFile({ sourcePath: playerPath, archivePath: playerArchivePath, attemptRoot, worldRoot: server.worldRoot, identity, server }))
  const regionArchivePath = witness && regionName ? `server/world/region/${regionName}` : null
  if (!regionPath || !regionArchivePath) throw new Error('committed witness does not identify the raw MCA region to inspect')
  files.push(capturePostStopWorldFile({ sourcePath: regionPath, archivePath: regionArchivePath, attemptRoot, worldRoot: server.worldRoot, identity, server }))
  const rawLog = readFileSync(server.logPath, 'utf8')
  const startup = startRowFromLog(server.serverLogLines, server.serverStart.levelName)
  if (!startup) throw new Error('fresh-world attestation cannot bind a unique Leaf preparation and completion line')
  if (server.serverLogLines.filter(({ line }) => line === startup.preparing.line).length !== 1
    || server.serverLogLines.filter(({ line }) => line === startup.done.line).length !== 1
    || rawLog.split(/\r?\n/u).filter((line) => line === startup.preparing.line).length !== 1
    || rawLog.split(/\r?\n/u).filter((line) => line === startup.done.line).length !== 1) {
    throw new Error('Leaf startup lines are not unique in the exact spawned-child log')
  }
  const stdoutRows = currentEvidenceRows(server.stdoutEventsPath)
  const matchingReceipt = (observed) => stdoutRows.filter((row) => row.schema === 'vtr-server-stdout-observation/v1'
    && row.streamSource === 'spawned-server-stdout'
    && row.serverPid === server.serverStart.pid
    && row.sourceSha === identity.sourceSha
    && row.runId === identity.runId
    && row.serverId === worldKeyParts(identity.worldKey).serverId
    && row.port === server.serverStart.port
    && row.levelName === server.serverStart.levelName
    && row.line === observed.line
    && row.receivedAt === observed.ts
    && row.lineSha256 === sha256(Buffer.from(observed.line, 'utf8')))
  const preparingReceipts = matchingReceipt(startup.preparing)
  const doneReceipts = matchingReceipt(startup.done)
  if (preparingReceipts.length !== 1 || doneReceipts.length !== 1) throw new Error('Leaf startup rows are not uniquely bound to this Java child stdout receipt stream')
  if (preparingReceipts[0].sequence >= doneReceipts[0].sequence
    || Date.parse(preparingReceipts[0].receivedAt) >= Date.parse(doneReceipts[0].receivedAt)
    || BigInt(preparingReceipts[0].monotonicNs) >= BigInt(doneReceipts[0].monotonicNs)) {
    throw new Error('Leaf startup receipt ordering is not monotonic')
  }
  const serverId = worldKeyParts(identity.worldKey).serverId
  const preStart = {
    ...server.boundPreStart,
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    serverPid: server.serverStart.pid,
    serverId,
    port: server.serverStart.port,
    levelName: server.serverStart.levelName,
    identity: {
      sourceSha: identity.sourceSha,
      runId: identity.runId,
      serverPid: server.serverStart.pid,
      serverId,
      port: server.serverStart.port,
      levelName: server.serverStart.levelName,
    },
  }
  const artifact = {
    schema: 'vtr-fresh-world-attestation/v1',
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    serverId,
    port: server.serverStart.port,
    levelName: server.serverStart.levelName,
    server: {
      pid: server.serverStart.pid,
      serverId,
      port: server.serverStart.port,
      levelName: server.serverStart.levelName,
      minecraftVersion: server.serverStart.minecraftVersion,
      dataVersion: level.dataVersion,
      jarPath: server.serverStart.serverJar,
      jarSha256: server.serverStart.serverJarSha256,
      spawnedAt: server.serverStart.spawnedAt,
    },
    preStartObservation: preStart,
    worldRoot: {
      absolute: server.worldRoot,
      attemptRoot: realpathSync(attemptRoot),
      archivePath: 'server/world',
      uniqueForRun: identity.runId,
    },
    startupLog: {
      pid: server.serverStart.pid,
      streamSource: 'spawned-server-stdout',
      preparing: {
        line: startup.preparing.line, ts: startup.preparing.ts,
        sequence: preparingReceipts[0].sequence, monotonicNs: preparingReceipts[0].monotonicNs,
        lineSha256: preparingReceipts[0].lineSha256,
      },
      done: {
        line: startup.done.line, ts: startup.done.ts,
        sequence: doneReceipts[0].sequence, monotonicNs: doneReceipts[0].monotonicNs,
        lineSha256: doneReceipts[0].lineSha256,
      },
    },
    configuration: {
      launchPropertiesSha256: server.serverStart.serverPropertiesSha256,
      effectivePropertiesSha256: server.serverStart.serverPropertiesEffectiveSha256,
    },
    postRunObservation: {
      observedAt: isoNow(),
      serverStoppedAt,
      files: files.map(({ sourceBytes, ...row }) => row),
    },
  }
  server.serverStart = {
    ...server.serverStart,
    runId: identity.runId,
    generationId: identity.generationId,
    worldKey: identity.worldKey,
    serverId,
    worldEpoch: worldKeyParts(identity.worldKey).worldEpoch,
    botUuid: player?.uuid ?? null,
    sourceSha: identity.sourceSha,
    spawnObservation: {
      ...server.serverStart.spawnObservation,
      sourceSha: identity.sourceSha,
      runId: identity.runId,
      generationId: identity.generationId,
      worldKey: identity.worldKey,
    },
    freshWorldAttestation: 'server/fresh-world-attestation.json',
  }
  writeJsonAtomic(server.serverStartPath, server.serverStart)
  const attestationPath = join(attemptRoot, 'server', 'fresh-world-attestation.json')
  writeJsonExclusive(attestationPath, artifact)
  return { artifact, path: attestationPath, files, witness, playerPath, levelDat, regionPath }
}

function archiveInputManifest({ attemptRoot, runtimeSource, server, observer, paths, collectorPath, identity, bundlePath, acceptanceSource, noDouble, freshWorld, serverStop, residentStop }) {
  const runner = join(attemptRoot, 'runner')
  const files = {}
  const add = (archivePath, sourcePath) => {
    if (typeof sourcePath === 'string' && existsSync(sourcePath)) files[archivePath] = sourcePath
  }
  for (const path of [
    'runner/acceptance.json', 'runner/initial-snapshot.json', 'runner/fixture-anchor-snapshot.json', 'runner/final-snapshot.json',
    'runner/world-identity.json',
    'runner/milestone-predicates.json', 'runner/run-metadata.json', 'runner/provider-activity-capture.json',
    'runner/host-lifecycle.jsonl', 'runner/dependency-install.json', 'runner/source-bun.lock',
    'runner/no-double-authority-fixture.json', 'runner/fixtures/test-vtr-reach-executor-dispatch-authority.mts',
    'runner/no-llm-egress-audit.json', 'runner/no-llm-egress-provenance.json',
    'runner/resident-process-group-closure.json', 'runner/observer-lifecycle.json', 'runner/collector-report.json',
  ]) add(path, join(attemptRoot, path))
  add('proofs/no-double-authority-fixture.json', noDouble.reportPath)
  add('runner/generation-bundle.mjs', bundlePath)
  add('runner/mission.json', join(attemptRoot, 'runner', 'mission.json'))
  add('server/fixture-commands.jsonl', join(attemptRoot, 'server', 'fixture-commands.jsonl'))
  add('server/leaf-latest.log', server.logPath)
  add('server/leaf-stdout-events.jsonl', server.stdoutEventsPath)
  add('server/server-start.json', server.serverStartPath)
  add('server/server.properties.launch', server.configLaunch)
  add('server/server.properties.effective-after-boot', server.configEffective)
  add('server/eula.txt', server.eulaAttemptPath)
  add('server/eula-attestation.json', server.eulaAttestationPath)
  add('server/pre-start-world-observation.json', server.preStartPath)
  add('server/fresh-world-attestation.json', freshWorld.path)
  add('server/world/level.dat', freshWorld.levelDat)
  add(`server/world/playerdata/${identity.botUuid}.dat`, freshWorld.playerPath)
  const regionName = freshWorld.regionPath ? relative(join(server.worldRoot, 'region'), freshWorld.regionPath).split(sep).join('/') : null
  if (regionName) add(`server/world/region/${regionName}`, freshWorld.regionPath)
  add('runner/mercury-calls.jsonl', paths['mercury-calls'])
  add('runner/kernel-shadow.jsonl', join(runtimeSource, 'buddy-driver', 'logs', 'jev', 'kernel-shadow.jsonl'))
  const manifestPath = join(runner, 'archive-input-manifest.json')
  writeJsonExclusive(manifestPath, { schema: 'vtr-reach-live-archive-input/v1', files })
  return { manifestPath, files }
}

async function captureAndPackage({
  runtimeSource, options, attemptRoot, server, observer, noDouble, install, paths,
  identity, terminal, collectorDescriptor, capture, lifecycle, hostLifecycleTranscript,
  fixtureTranscript, initialSnapshot, observerSnapshots, acceptanceSource,
}) {
  if (capture?.schema !== REQUIRED_CAPTURE_SCHEMA || capture.status !== 'OBSERVED') throw new Error('archive requires the supervisor-verified v2 provider activity capture')
  if (!identity?.runId || !identity?.generationId || !terminal?.transitionId || !terminal?.contractHash) throw new Error('archive requires exact run/generation/typed terminal identity')
  const lifecycleValue = JSON.parse(readFileSync(lifecycle.path, 'utf8'))
  const serverStop = lifecycleValue.leafStop
  const residentStop = lifecycleValue.residentStop
  if (serverStop?.status !== 'STOPPED' || serverStop?.listenerClosureObservation?.result !== 'connection-refused'
    || residentStop?.status !== 'STOPPED') throw new Error('post-run collection requires observed resident and Leaf shutdown evidence')

  const capturePath = join(attemptRoot, 'runner', 'provider-activity-capture.json')
  writeJsonExclusive(capturePath, capture)
  const buildHash = collectorDescriptor.report?.observed?.generationReady?.buildHash
  let bundleSource = null
  if (typeof buildHash === 'string' && /^[0-9a-f]{12}$/iu.test(buildHash)) {
    const candidate = join(runtimeSource, 'buddy-driver', 'data', 'resident', `gen-${buildHash}.mjs`)
    if (existsSync(candidate) && sha256(readFileSync(candidate)).startsWith(buildHash.toLowerCase())) {
      bundleSource = join(attemptRoot, 'runner', 'generation-bundle.mjs')
      copyExact(candidate, bundleSource)
    }
  }

  const acceptancePath = join(attemptRoot, 'runner', 'acceptance.json')
  if (!existsSync(acceptancePath) || typeof acceptanceSource !== 'string') throw new Error('run-scoped acceptance record was not captured while the resident control socket was alive')
  const acceptance = JSON.parse(readFileSync(acceptancePath, 'utf8'))
  if (acceptance.record !== 'acceptance' || acceptance.runId !== identity.runId
    || acceptance.gitCommit !== identity.sourceSha || acceptance.checkoutHead !== identity.sourceSha
    || acceptance.generationHash !== buildHash || acceptance.generationId !== identity.generationId) {
    throw new Error('captured acceptance record does not bind exact source/run/generation/build identity')
  }
  if (noDouble.report) copyExact(noDouble.reportPath, join(attemptRoot, 'runner', 'no-double-authority-fixture.json'))
  copyExact(noDouble.sourcePath, join(attemptRoot, 'runner', 'fixtures', 'test-vtr-reach-executor-dispatch-authority.mts'))
  copyExact(install.sourceBunLockPath, join(attemptRoot, 'runner', 'source-bun.lock'))
  copyExact(install.metadataPath, join(attemptRoot, 'runner', 'dependency-install.json'))

  const initial = initialSnapshot?.normalized
    ?? JSON.parse(readFileSync(join(attemptRoot, 'runner', 'initial-snapshot.json'), 'utf8'))
  initial.generationId = identity.generationId
  initial.capturedAt = initial.capturedAt ?? identity.generationReadyAt
  initial.buildHash = initial.buildHash ?? buildHash
  writeJsonAtomic(join(attemptRoot, 'runner', 'initial-snapshot.json'), initial)
  const finalSnapshotPath = join(attemptRoot, 'runner', 'final-snapshot.json')
  if (!existsSync(finalSnapshotPath)) throw new Error('terminal-time resident world/inventory snapshot is absent')

  // Read the identity-bound playerdata only after actual child close and TCP
  // connection-refused. This is the independent final-world/player fact source.
  const leafIdentity = parseLeafIdentity(readFileSync(server.logPath, 'utf8'), server.serverStart.levelName)
  const playerPath = join(server.worldRoot, 'playerdata', `${leafIdentity.botUuid}.dat`)
  const player = await parsePlayerDat(playerPath)
  if (player.uuid !== leafIdentity.botUuid || !player.inventoryDecodable || !player.position?.every(Number.isFinite)) {
    throw new Error('stopped UUID-bound Leaf playerdata is malformed or does not match the joined AI_Buddy')
  }
  const finalSnapshot = JSON.parse(readFileSync(finalSnapshotPath, 'utf8'))
  if (finalSnapshot.runId !== identity.runId || finalSnapshot.generationId !== identity.generationId
    || finalSnapshot.worldKey !== identity.worldKey) throw new Error('final control snapshot identity differs from the typed terminal')
  const finalInventory = inventoryValue(finalSnapshot.state)
  if (!finalInventory || JSON.stringify(finalInventory) !== JSON.stringify(player.inventory)) {
    throw new Error('terminal snapshot inventory differs from stopped playerdata inventory')
  }
  const level = await parseLevelDat(join(server.worldRoot, 'level.dat'))
  if (level.levelName !== server.serverStart.levelName || level.dataVersion !== server.serverStart.dataVersion
    || level.seed !== server.serverStart.seed) throw new Error('stopped world level.dat differs from the exact Leaf startup observation')

  server.serverStart.botUuid = leafIdentity.botUuid
  server.serverStart.runId = identity.runId
  server.serverStart.generationId = identity.generationId
  server.serverStart.worldKey = identity.worldKey
  server.serverStart.worldEpoch = worldKeyParts(identity.worldKey).worldEpoch
  server.serverStart.serverId = worldKeyParts(identity.worldKey).serverId
  server.serverStart.sourceSha = identity.sourceSha
  server.serverStart.spawnObservation = {
    ...server.serverStart.spawnObservation,
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId,
    worldKey: identity.worldKey,
  }
  writeJsonAtomic(server.serverStartPath, server.serverStart)
  const freshWorld = await writeFreshWorldAttestation({
    attemptRoot, server, identity, collectorReport: collectorDescriptor.report, terminal,
    player, level, serverStoppedAt: serverStop.listenerClosureObservation.observedAt,
  })

  const runMetadata = buildRunMetadata({
    runtimeSource, identity, collectorReport: collectorDescriptor.report, terminal,
    server: { ...server.serverStart, botUuid: leafIdentity.botUuid },
    level, player, startSnapshot: initial,
    stopAt: residentStop.stoppedAt, capture,
  })
  runMetadata.run.generationReadyAt = identity.generationReadyAt
  runMetadata.run.botUuid = leafIdentity.botUuid
  writeJsonExclusive(join(attemptRoot, 'runner', 'run-metadata.json'), runMetadata)
  const missionPath = join(attemptRoot, 'runner', 'mission.json')
  const missionValue = { kind: 'inventory_at_least', item: 'oak_log', count: 1 }
  if (existsSync(missionPath)) {
    if (JSON.stringify(JSON.parse(readFileSync(missionPath, 'utf8'))) !== JSON.stringify(missionValue)) throw new Error('run mission file changed after live collector bound it')
  } else writeJsonExclusive(missionPath, missionValue)
  writeJsonExclusive(join(attemptRoot, 'runner', 'milestone-predicates.json'), {
    schema: 'vtr-reach-milestone-predicates/v1', sourceSha: identity.sourceSha,
    runId: identity.runId, generationId: identity.generationId, worldKey: identity.worldKey,
    desiredPredicate: terminal.commit?.detail?.desiredPredicate ?? null,
    committedWitness: terminal.commit?.detail?.witness ?? null,
    outcome: terminal.row?.detail?.outcome ?? null,
  })

  const terminalSnapshot = observerSnapshots?.find((entry) => entry.phase === 'terminal')
  const expectedWorld = worldKeyParts(identity.worldKey)
  if (!terminalSnapshot || terminalSnapshot.status !== 'READY'
    || terminalSnapshot.sourceSha !== identity.sourceSha || terminalSnapshot.runId !== identity.runId
    || terminalSnapshot.generationId !== identity.generationId || terminalSnapshot.worldKey !== identity.worldKey) {
    throw new Error('observer terminal snapshot does not prove exact source/run/generation/world identity')
  }
  const observerOwner = listenerOwner(observer.port)
  const observerPortState = await loopbackOpen(observer.port)
  if (!isChildRunning(observer.handle) || !observerPortState.open || observerOwner.status !== 'OBSERVED'
    || observerOwner.pid !== observer.pid || observerOwner.comm === 'java') throw new Error('dedicated read-only observer was not retained by its exact non-Java child on loopback')
  writeJsonAtomic(observer.manifestPath, {
    ...observer.initial,
    status: 'LEFT_BOUND',
    confirmedAt: isoNow(),
    finalObservation: {
      childRunning: true, childPid: observer.pid,
      portOpen: observerPortState.open, portProbeResult: observerPortState.code,
      listenerOwner: observerOwner,
      capturedAt: isoNow(),
      summaryIdentity: { sourceSha: terminalSnapshot.sourceSha, runId: terminalSnapshot.runId, generationId: terminalSnapshot.generationId, worldKey: terminalSnapshot.worldKey },
      summaryFreshnessMs: terminalSnapshot.freshnessMs,
      worldIdentity: { serverId: expectedWorld.serverId, dimension: expectedWorld.dimension, worldEpoch: expectedWorld.worldEpoch },
    },
  })

  // Leaf rewrites the --config properties file during boot (normalized header
  // and defaults); the spawn observation and server-start record bind the
  // launch input hash captured before boot. The post-boot content is already
  // preserved as server.properties.effective-after-boot, so restore the exact
  // launch bytes now that the server has provably stopped, letting the archive
  // re-hash to the attested launch input.
  if (typeof server.launchProperties === 'string' && typeof server.configLaunch === 'string'
      && existsSync(server.configLaunch)) {
    writeFileSync(server.configLaunch, server.launchProperties)
  }

  const { manifestPath } = archiveInputManifest({
    attemptRoot, runtimeSource, server, observer, paths, collectorPath: collectorDescriptor.path,
    identity: { ...identity, botUuid: leafIdentity.botUuid }, bundlePath: bundleSource,
    acceptanceSource, noDouble, freshWorld, serverStop, residentStop,
  })
  const archivePath = join(attemptRoot, 'archive')
  const packaged = packageVtrReachArchive({
    collectorReportPath: collectorDescriptor.path,
    manifestPath,
    archivePath,
  })
  const packageReportPath = join(attemptRoot, 'runner', 'package-report.json')
  writeJsonExclusive(packageReportPath, packaged.report)
  return {
    status: packaged.report.packageStatus,
    packageStatus: packaged.report.packageStatus,
    acceptanceEligible: false,
    path: archivePath,
    reportPath: packageReportPath,
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: identity.generationId,
    botUuid: leafIdentity.botUuid,
    playerdataPath: playerPath,
  }
}

function normalizedControlSnapshot({ state, identity, phase }) {
  if (!isPlainObject(state)) throw new Error(`${phase} resident snapshot is not an object`)
  const inventory = inventoryValue(state)
  const position = positionValue(state)
  if (!inventory || !position) throw new Error(`${phase} resident snapshot lacks typed inventory or position truth`)
  return {
    schema: phase === 'initial' ? 'vtr-reach-initial-snapshot/v1' : 'vtr-reach-final-snapshot/v1',
    sourceSha: identity.sourceSha,
    bootSourceSha: identity.sourceSha,
    runId: identity.runId,
    generationId: phase === 'initial' ? null : identity.generationId,
    worldKey: identity.worldKey,
    worldEpoch: worldKeyParts(identity.worldKey).worldEpoch,
    capturedAt: isoNow(),
    ...(phase === 'initial' ? { initialInventory: inventory, initialPosition: position } : {}),
    truth: state?.truth ?? null,
    state,
  }
}

async function captureAcceptanceWhileResidentAlive({ runtimeDir, attemptRoot, identity }) {
  const returnedPath = await controlRequest(findControlSocket(runtimeDir), 'acceptance', {}, 15_000)
  const sourcePath = typeof returnedPath === 'string' ? returnedPath : returnedPath?.path
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) throw new Error('control acceptance command did not return an absolute run-scoped file path')
  const sourceReal = realpathSync(sourcePath)
  const residentData = realpathSync(join(runtimeDir, 'data', 'resident'))
  if (!ensureInside(residentData, sourceReal) || sourceReal === residentData) throw new Error('acceptance source escaped this exact runtime data directory')
  const stat = realRegularFile(sourceReal, 'run-scoped acceptance record')
  if (stat.size <= 0) throw new Error('run-scoped acceptance record is empty')
  const acceptance = JSON.parse(readFileSync(sourceReal, 'utf8'))
  if (acceptance.record !== 'acceptance' || acceptance.runId !== identity.runId
    || acceptance.gitCommit !== identity.sourceSha || acceptance.checkoutHead !== identity.sourceSha
    || acceptance.generationId !== identity.generationId) {
    throw new Error('live acceptance record does not bind the exact source/run/generation')
  }
  const target = join(attemptRoot, 'runner', 'acceptance.json')
  const copied = copyExact(sourceReal, target)
  if (!copied || copied.sha256 !== sha256(readFileSync(sourceReal))) throw new Error('acceptance bytes could not be preserved exactly')
  return { sourcePath: sourceReal, archivePath: target, sha256: copied.sha256, record: acceptance }
}

async function stopPartialChild(handle, { label, port = null, graceful = null, timeoutMs = 5000 } = {}) {
  if (!handle?.child) return { status: 'ABSENT', label }
  const child = handle.child
  let close = null
  if (isChildRunning(handle) && typeof graceful === 'function') {
    try { await graceful(handle) } catch {}
  }
  close = await Promise.race([handle.closed, delay(timeoutMs).then(() => null)])
  const signals = []
  if (close === null && isChildRunning(handle)) {
    signals.push({ signal: 'SIGTERM', sentAt: isoNow() })
    try { child.kill('SIGTERM') } catch {}
    close = await Promise.race([handle.closed, delay(timeoutMs).then(() => null)])
  }
  if (close === null && isChildRunning(handle)) {
    signals.push({ signal: 'SIGKILL', sentAt: isoNow() })
    try { child.kill('SIGKILL') } catch {}
    close = await Promise.race([handle.closed, delay(timeoutMs).then(() => null)])
  }
  if (close === null) throw new Error(`${label} child remains live after bounded TERM/KILL cleanup`)
  let listenerClosureObservation = null
  if (port !== null) {
    const closure = await portClosed(port)
    if (closure.code !== 'ECONNREFUSED') throw new Error(`${label} listener did not close with ECONNREFUSED (${closure.code})`)
    listenerClosureObservation = { host: '127.0.0.1', port, result: 'connection-refused', observedAt: closure.observedAt }
  }
  return {
    status: 'STOPPED', label, pid: child.pid ?? null,
    exitCode: close.code, signal: close.signal ?? null, stoppedAt: close.at,
    processExitObservation: { source: 'child-close-event', state: 'exited', pid: child.pid ?? null, exitCode: close.code, observedAt: close.at },
    listenerClosureObservation, signals,
  }
}

async function cleanupPartialAttempt({ tracked, server, observer, resident, options, identity, attemptRoot, keepObserver }) {
  const results = []
  const residentHandle = resident?.handle ?? tracked.resident
  if (residentHandle?.process && isChildRunning(residentHandle.process)) {
    try {
      const stopped = await stopResident({
        handle: residentHandle,
        identity: identity ?? null,
        pid: residentHandle.residentPid ?? null,
        attemptRoot,
        gracefulTimeoutMs: 5000,
        wrapperTermTimeoutMs: 5000,
      })
      results.push({ component: 'resident', status: stopped.status, pid: stopped.pid, exitCode: stopped.exitCode })
    } catch (error) { results.push({ component: 'resident', status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(error)) }) }
  }
  if (server?.handle && isChildRunning(server.handle)) {
    try {
      const stopped = await stopLeaf({ attestation: server.serverStart, attemptRoot, server })
      results.push({ component: 'leaf', status: stopped.status, pid: stopped.pid, exitCode: stopped.exitCode })
    } catch (error) { results.push({ component: 'leaf', status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(error)) }) }
  } else if (!server && tracked.leaf?.child && isChildRunning(tracked.leaf)) {
    try {
      if (tracked.leaf.child.stdin && !tracked.leaf.child.stdin.destroyed) await writeLineToChild(tracked.leaf, 'stop')
      const stopped = await stopPartialChild(tracked.leaf, { label: 'partially-started-Leaf', port: options.port, timeoutMs: 5000 })
      results.push({ component: 'leaf', ...stopped })
    } catch (error) { results.push({ component: 'leaf', status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(error)) }) }
  }
  const observerHandle = observer?.handle ?? tracked.observer
  if (!keepObserver && observerHandle?.child && isChildRunning(observerHandle)) {
    try {
      const stopped = await stopPartialChild(observerHandle, { label: 'dedicated-observer', port: options.observerPort, timeoutMs: 5000 })
      results.push({ component: 'observer', ...stopped })
      if (observer?.manifestPath) writeJsonAtomic(observer.manifestPath, {
        ...observer.initial,
        status: 'STOPPED_AFTER_FAILED_ATTEMPT',
        stoppedAt: stopped.stoppedAt,
        pid: stopped.pid,
        processExitObservation: stopped.processExitObservation,
        listenerClosureObservation: stopped.listenerClosureObservation,
        signals: stopped.signals,
      })
    } catch (error) { results.push({ component: 'observer', status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(error)) }) }
  }
  return results
}

function failedRunComponentState(handle, cleanupResults, component) {
  if (!handle) return 'NOT_STARTED'
  const stopped = cleanupResults.find((row) => row.component === component && row.status === 'STOPPED')
  if (stopped) return 'STOPPED'
  const incomplete = cleanupResults.find((row) => row.component === component && row.status === 'INCOMPLETE')
  if (incomplete) return 'STOP_INCOMPLETE'
  return isChildRunning(handle) ? 'RUNNING_AFTER_CLEANUP' : 'STOPPED'
}

function makeWatchFactory() {
  return {
    async arm({ hostLog, journals, lifecycleLog, lifecycleTranscript }) {
      const watch = new VtrProviderActivityWatch({ hostLog, journals, lifecycleLog: lifecycleLog ?? lifecycleTranscript })
      return {
        poll: () => watch.poll(),
        finish: (reason) => watch.finish(Date.now(), reason),
      }
    },
  }
}

function writePreflightArtifact(attemptRoot, report) {
  const path = join(attemptRoot, 'runner', 'preflight.json')
  writeJsonExclusive(path, report)
  return path
}

export function persistRunPreflightFailure(options, report) {
  const isolated = report?.checks?.find((row) => row.id === 'attempt-isolation')?.status === 'PASS'
  if (!isolated || resolve(options.attemptRoot) !== report.attemptRoot) {
    return { status: 'NOT_WRITTEN', reason: 'attempt-root-not-proven-isolated' }
  }

  let preflightPath = null
  try {
    assertNoSymlinkAncestors(options.attemptRoot)
    if (existsSync(options.attemptRoot)) throw new Error('attempt-root appeared after preflight; refusing to reuse it')
    mkdirSync(dirname(options.attemptRoot), { recursive: true, mode: 0o700 })
    assertNoSymlinkAncestors(options.attemptRoot)
    mkdirSync(options.attemptRoot, { recursive: false, mode: 0o700 })
    const rootStat = lstatSync(options.attemptRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || realpathSync(options.attemptRoot) !== options.attemptRoot) {
      throw new Error('attempt-root changed during preflight failure capture')
    }
    mkdirSync(join(options.attemptRoot, 'runner'), { recursive: false, mode: 0o700 })
    preflightPath = writePreflightArtifact(options.attemptRoot, report)

    const dependencyCheck = report.checks.find((row) => row.id === 'runtime-dependencies')
    const dependencyDetail = dependencyCheck?.preflightDetail
    const scratchCleanup = dependencyDetail?.cleanup
    const cleanup = {
      status: dependencyDetail?.temporaryInstallRemoved === false || scratchCleanup?.scratch?.status === 'PRESERVED_FOR_RECOVERY'
        ? 'INCOMPLETE'
        : 'CLEANED',
      attempted: true,
      temporaryPreflightInstall: dependencyDetail?.temporaryInstallRemoved === true ? 'REMOVED'
        : dependencyDetail?.temporaryInstallRemoved === false ? 'INCOMPLETE' : 'NOT_CREATED_OR_NOT_REPORTED',
      details: scratchCleanup ?? null,
    }
    const blocker = report.blockers?.[0]
    const reason = blocker ? `preflight blocked at ${blocker.id}: ${blocker.reason ?? 'unspecified check failure'}` : 'preflight blocked'
    const failurePath = writeSetupFailureArtifact(options.attemptRoot, {
      sourceSha: report.sourceSha ?? null,
      stage: 'preflight',
      error: new Error(reason),
      preflightPath,
      cleanup,
      components: { leafServer: 'NOT_STARTED', observer: 'NOT_STARTED', resident: 'NOT_STARTED' },
      evidenceCandidates: [preflightPath],
    })
    return {
      status: 'WRITTEN',
      path: relative(options.attemptRoot, failurePath).split(sep).join('/'),
      sha256: sha256(readFileSync(failurePath)),
    }
  } catch (error) {
    // Best effort: if the failure happened after attemptRoot/runner existed,
    // preserve a redacted failure row there even when preflight.json could not
    // be written. Unsafe/unavailable roots remain untouched.
    try {
      if (existsSync(join(options.attemptRoot, 'runner')) && !existsSync(join(options.attemptRoot, 'runner', 'runner-failure.json'))) {
        const failurePath = writeSetupFailureArtifact(options.attemptRoot, {
          sourceSha: report.sourceSha ?? null,
          stage: 'preflight-artifact-persistence',
          error,
          preflightPath,
          cleanup: { status: 'INCOMPLETE', attempted: true, reason: redactOperationalText(safeErrorDescription(error)) },
          components: { leafServer: 'NOT_STARTED', observer: 'NOT_STARTED', resident: 'NOT_STARTED' },
          evidenceCandidates: preflightPath ? [preflightPath] : [],
        })
        return {
          status: 'WRITTEN',
          path: relative(options.attemptRoot, failurePath).split(sep).join('/'),
          sha256: sha256(readFileSync(failurePath)),
        }
      }
    } catch {
      // The returned status makes the inability to persist explicit.
    }
    return { status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(error)) }
  }
}

export function writeSetupFailureArtifact(attemptRoot, {
  sourceSha, stage, error, preflightPath = null, failureCode = null, failurePhase = null,
  cleanup = { status: 'NOT_REQUIRED', attempted: false, results: [] },
  components = { leafServer: 'NOT_STARTED', observer: 'NOT_STARTED', resident: 'NOT_STARTED' },
  evidenceCandidates = setupEvidenceCandidates(attemptRoot, preflightPath),
}) {
  const path = join(attemptRoot, 'runner', 'runner-failure.json')
  const evidence = evidenceDescriptors(attemptRoot, evidenceCandidates)
  writeJsonExclusive(path, {
    schema: 'vtr-reach-live-caller-failure/v1',
    sourceSha,
    attemptRoot,
    phase: stage,
    failureStage: stage,
    reason: redactOperationalText(safeErrorDescription(error)),
    ...(typeof failureCode === 'string' && /^[A-Z0-9_]{1,64}$/u.test(failureCode) ? { failureCode } : {}),
    ...(typeof failurePhase === 'string' && /^[a-z][a-z0-9.-]{0,63}$/u.test(failurePhase) ? { failurePhase } : {}),
    cleanup,
    components,
    evidence,
    preflightPath,
    capturedAt: isoNow(),
  })
  return path
}

function cleanupFailedRunSetup(sourceRoot, runtimeSource, attemptRoot) {
  const worktree = removePreflightWorktree(sourceRoot, runtimeSource)
  const caches = []
  for (const relativePath of [
    'cache/bun-install', 'cache/bun-install-store', 'cache/npm-install',
    'home/bun-install', 'home/fixture-test', 'tmp/bun-install', 'tmp/fixture-test',
  ]) {
    const candidate = join(attemptRoot, relativePath)
    try {
      const stat = lstatSync(candidate)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        caches.push({ path: relativePath, status: 'PRESERVED_UNSAFE_TYPE' })
        continue
      }
      rmSync(candidate, { recursive: true, force: true })
      caches.push({ path: relativePath, status: existsSync(candidate) ? 'INCOMPLETE' : 'REMOVED' })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      caches.push({ path: relativePath, status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(error)) })
    }
  }
  return {
    status: worktree.status === 'REMOVED' && caches.every((row) => row.status === 'REMOVED') ? 'CLEANED' : 'INCOMPLETE',
    attempted: true,
    worktree,
    caches,
  }
}

async function executeRun(options, preflight) {
  const sourceSha = preflight.sourceSha
  if (!SHA40.test(String(sourceSha ?? ''))) throw new Error('preflight did not establish an exact source SHA')
  mkdirSync(dirname(options.attemptRoot), { recursive: true, mode: 0o700 })
  assertNoSymlinkAncestors(options.attemptRoot)
  mkdirSync(options.attemptRoot, { recursive: false, mode: 0o700 })
  const rootStat = lstatSync(options.attemptRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || realpathSync(options.attemptRoot) !== options.attemptRoot) throw new Error('attempt root must be a new canonical directory')
  const exactBranch = preflight.branch ?? 'detached-exact-source'
  let runtimeSource = join(options.attemptRoot, 'runtime', 'source')
  let preflightPath = null
  let install
  let noDouble
  let setupStage = 'attempt-artifact-layout'
  try {
    for (const dir of ['runner', 'server', 'tmp', 'home', 'cache']) mkdirSync(join(options.attemptRoot, dir), { recursive: true, mode: 0o700 })
    setupStage = 'preflight-artifact'
    preflightPath = writePreflightArtifact(options.attemptRoot, preflight)
    setupStage = 'exact-source-worktree'
    ensureRuntimeSource(options.sourceRoot, options.attemptRoot, sourceSha, exactBranch)
    setupStage = 'frozen-dependency-install'
    install = runFrozenInstall(runtimeSource, options.attemptRoot)
    setupStage = 'no-double-authority-fixture'
    noDouble = runNoDoubleAuthorityFixture(runtimeSource, options.attemptRoot, sourceSha)
  } catch (error) {
    const failurePath = join(options.attemptRoot, 'runner', 'runner-failure.json')
    if (!existsSync(failurePath)) {
      const cleanup = cleanupFailedRunSetup(options.sourceRoot, runtimeSource, options.attemptRoot)
      try { writeSetupFailureArtifact(options.attemptRoot, { sourceSha, stage: setupStage, error, preflightPath, cleanup }) } catch {}
    }
    throw error
  }
  const tracked = {}
  const onChild = (name, handle) => { tracked[name] = handle }
  let server = null
  let observer = null
  let resident = null
  let snapshotRef = { value: null }
  let identityRef = null
  let acceptanceRef = null
  let supervisorEntered = false
  let result = null
  let failurePhase = 'mission-preparation'
  try {
    const runNonce = randomBytes(8).toString('hex')
    const levelName = `vtrreach-${sourceSha.slice(0, 12)}-${runNonce}`
    writeJsonExclusive(join(options.attemptRoot, 'runner', 'mission.json'), { kind: 'inventory_at_least', item: 'oak_log', count: 1 })
    failurePhase = 'leaf-start'
    server = await startLeaf(options, sourceSha, options.attemptRoot, levelName, onChild)
    failurePhase = 'observer-start'
    observer = await startObserver(options, sourceSha, options.attemptRoot, runtimeSource, onChild)
    const runtimeDir = realpathSync(join(runtimeSource, 'buddy-driver'))
    const paths = runtimeAttemptSinkPaths(runtimeDir)
    const outputPaths = {
      capture: join(options.attemptRoot, 'runner', 'supervisor-capture.json'),
      lifecycle: join(options.attemptRoot, 'runner', 'supervisor-lifecycle.json'),
      result: join(options.attemptRoot, 'runner', 'supervisor-result.json'),
    }
    const watchFactory = makeWatchFactory()
    failurePhase = 'supervisor-lifecycle'
    supervisorEntered = true
    result = await runVtrReachProbeSupervisor({
      attemptRoot: options.attemptRoot,
      runtimeDir,
      sourceSha,
      paths,
      expectedCaptureSchema: REQUIRED_CAPTURE_SCHEMA,
      expectedCaptureStatus: 'OBSERVED',
      captureJournalNames: Object.fromEntries(PROVIDER_JOURNALS.map((name) => [name, name])),
      serverAttestation: server.serverStart,
      isolatedPort: options.port,
      watchFactory,
      observerAdapter: bindObserverAdapter(observer),
      observerPolicy: 'leave-bound',
      timeoutMs: options.timeoutMs,
      outputPaths,
      adapters: {
        async startResidentFrozen() {
          failurePhase = 'resident-start'
          resident = await startResident(options, sourceSha, options.attemptRoot, runtimeSource, runtimeDir, paths, onChild)
          return resident
        },
        async prepareFixture({ handle, identity }) {
          failurePhase = 'fixture-preparation'
          identityRef = { ...identity }
          return await prepareFixtureContext({ server, runtimeDir, attemptRoot: options.attemptRoot, identity, sourceSha, startSnapshot: snapshotRef })
        },
        async resumeResident({ handle, identity }) {
          failurePhase = 'generation-resume'
          const resumed = await controlRequest(findControlSocket(runtimeDir), 'resume', {}, 20_000)
          if (resumed?.started !== true || resumed?.frozen !== false) throw new Error('resident control plane did not acknowledge unfreeze and generation start')
          const completeIdentity = await waitAndBindGenerationReady(server, runtimeDir, identity.runId, options.timeoutMs)
          identityRef = completeIdentity
          return { started: true, generationId: completeIdentity.generationId }
        },
        async stopResident(args) {
          failurePhase = 'resident-stop'
          const stopped = await stopResident({ ...args, attemptRoot: options.attemptRoot })
          return stopped
        },
        async stopIsolatedLeaf({ attestation, identity, reason }) {
          failurePhase = 'leaf-stop'
          return await stopLeaf({ attestation: { ...attestation, worldKey: server.serverStart.worldKey }, attemptRoot: options.attemptRoot, server })
        },
        async collect({ identity, terminal, observerUrl }) {
          failurePhase = 'terminal-collection'
          identityRef = identity
          // The resident cannot learn the world seed from the Mineflayer
          // client (the server never sends it), so the supervisor writes a
          // run-scoped world-identity record the resident's acceptance report
          // reads via BUDDY_WORLD_IDENTITY_PATH. It binds the exact launch
          // level-name and the level.dat seed already verified above.
          writeJsonExclusive(join(options.attemptRoot, 'runner', 'world-identity.json'), {
            schema: 'vtr-run-scoped-world-identity/v1',
            sourceSha: identity.sourceSha,
            runId: identity.runId,
            generationId: identity.generationId,
            worldKey: identity.worldKey,
            levelName: server.serverStart.levelName,
            seed: String(server.serverStart.seed ?? ''),
            evidence: {
              levelName: 'leaf --level-name spawn argument',
              seed: 'server/world/level.dat parsed post-boot and rebound post-stop',
            },
            capturedAt: isoNow(),
          })
          acceptanceRef = await captureAcceptanceWhileResidentAlive({ runtimeDir, attemptRoot: options.attemptRoot, identity })
          const state = await controlRequest(findControlSocket(runtimeDir), 'state', { radius: 8, verticalRadius: 4 }, 15_000)
          const finalSnapshot = normalizedControlSnapshot({ state, identity, phase: 'terminal' })
          const finalSnapshotPath = join(options.attemptRoot, 'runner', 'final-snapshot.json')
          writeJsonExclusive(finalSnapshotPath, finalSnapshot)
          const outputPath = join(options.attemptRoot, 'runner', 'collector-report.json')
          const collector = await collectLive([
            '--host-log', paths['host-log'],
            '--run-journal', paths['run-journal'],
            '--jev-calls', paths['jev-calls'],
            '--jev-decisions', paths['jev-decisions'],
            '--system2-journal', paths['system2-journal'],
            '--mission-file', join(options.attemptRoot, 'runner', 'mission.json'),
            '--source-sha', sourceSha,
            '--run-id', identity.runId,
            '--generation-id', identity.generationId,
            '--observer-url', observerUrl,
            '--output', outputPath,
            '--timeout-ms', String(Math.min(options.timeoutMs, 60_000)),
            '--poll-ms', '250',
          ])
          if (!collector.report || !existsSync(outputPath)) throw new Error('read-only live collector did not emit its run-scoped report')
          return { status: collector.report.status, path: outputPath, sha256: sha256(readFileSync(outputPath)), report: collector.report, exitCode: collector.exitCode }
        },
        async sealArchive(args) {
          failurePhase = 'archive-seal'
          if (!acceptanceRef?.sourcePath || !snapshotRef.value) throw new Error('acceptance/initial snapshot must be captured while the run is live')
          return await captureAndPackage({
            runtimeSource, options, attemptRoot: options.attemptRoot, server, observer, noDouble, install, paths,
            identity: args.identity, terminal: args.terminal, collectorDescriptor: args.collector,
            capture: args.capture, lifecycle: args.lifecycle, hostLifecycleTranscript: args.hostLifecycleTranscript,
            fixtureTranscript: args.fixtureTranscript, initialSnapshot: snapshotRef.value,
            observerSnapshots: args.observerSnapshots, acceptanceSource: acceptanceRef.sourcePath,
          })
        },
        async validateArchive({ archive }) {
          failurePhase = 'archive-validation'
          const archivePath = archive?.path
          if (typeof archivePath !== 'string' || !existsSync(archivePath)) throw new Error('archive directory does not exist for validation')
          const validatorPath = join(runtimeSource, 'tools', 'validate-vtr-reach-evidence.mjs')
          const home = join(options.attemptRoot, 'home', 'validator')
          const tmp = join(options.attemptRoot, 'tmp', 'validator')
          mkdirSync(home, { recursive: true, mode: 0o700 })
          mkdirSync(tmp, { recursive: true, mode: 0o700 })
          const checked = spawnSync(process.execPath, ['--no-env-file', validatorPath, '--archive', archivePath, '--repo', runtimeSource], {
            cwd: runtimeSource,
            env: minimalEnvironment({ HOME: home, TMPDIR: tmp, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(options.attemptRoot, 'cache', 'validator') }),
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
          })
          if (checked.error || !checked.stdout) throw new Error(`exact-source archive validator failed to produce JSON (${checked.error?.code ?? checked.status ?? 'unknown'})`)
          let report
          try { report = JSON.parse(checked.stdout) } catch { throw new Error('exact-source archive validator output is not JSON') }
          const reportPath = join(options.attemptRoot, 'runner', 'validation-report.json')
          writeJsonExclusive(reportPath, report)
          return {
            status: report.probeStatus ?? report.status ?? 'INCOMPLETE',
            path: reportPath,
            sha256: sha256(readFileSync(reportPath)),
            exitCode: checked.status,
            probeStatus: report.probeStatus ?? report.status ?? null,
            migrationMilestoneStatus: report.migrationMilestoneStatus ?? report.overallStatus ?? null,
          }
        },
      },
    })
    // A start adapter may fail after registering a child but before it can
    // return a frozen resident handle to the supervisor. The supervisor then
    // has no `resident` value to stop in its finally block; reconcile every
    // still-live registered child here before reporting the attempt.
    failurePhase = 'post-supervisor-cleanup'
    const lateCleanup = await cleanupPartialAttempt({
      tracked, server, observer, resident, options, identity: identityRef, attemptRoot: options.attemptRoot,
      keepObserver: true,
    })
    if (lateCleanup.length > 0) writeJsonExclusive(join(options.attemptRoot, 'runner', 'post-supervisor-cleanup.json'), {
      schema: 'vtr-reach-probe-post-supervisor-cleanup/v1', capturedAt: isoNow(), results: lateCleanup,
    })
    failurePhase = 'caller-result'
    const runnerResultPath = join(options.attemptRoot, 'runner', 'caller-result.json')
    writeJsonExclusive(runnerResultPath, { schema: 'vtr-reach-live-caller-result/v1', preflightPath, attemptRoot: options.attemptRoot, sourceSha, result })
    if (result?.status !== 'PASS') {
      const runnerFailurePath = join(options.attemptRoot, 'runner', 'runner-failure.json')
      if (!existsSync(runnerFailurePath)) {
        const detail = isPlainObject(result?.failureDetails) ? result.failureDetails : null
        const detailPhase = typeof detail?.phase === 'string' && /^[a-z][a-z0-9.-]{0,63}$/u.test(detail.phase) ? detail.phase : null
        const detailCode = typeof detail?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(detail.code) ? detail.code : null
        const phase = detailPhase ?? 'supervisor-lifecycle'
        const residentStopped = result?.events?.some((row) => row.event === 'resident-stopped') === true
        const serverStopped = result?.events?.some((row) => row.event === 'isolated-leaf-stopped') === true
        const residentRunning = isChildRunning(resident?.handle?.process ?? tracked.resident?.process)
        const leafRunning = isChildRunning(server?.handle ?? tracked.leaf)
        const observerLeftBound = observer !== null && isChildRunning(observer.handle)
        const components = {
          leafServer: serverStopped || !leafRunning ? 'STOPPED' : 'STOP_INCOMPLETE',
          observer: observerLeftBound ? 'LEFT_BOUND' : 'STOPPED',
          resident: residentStopped || !residentRunning ? 'STOPPED' : 'STOP_INCOMPLETE',
        }
        const failureCleanup = {
          status: Object.values(components).includes('STOP_INCOMPLETE') || lateCleanup.some((row) => row.status === 'INCOMPLETE') ? 'INCOMPLETE' : 'COMPLETE',
          attempted: true,
          observerPolicy: 'leave-bound',
          results: [
            { component: 'resident', status: components.resident },
            { component: 'leaf', status: components.leafServer },
            { component: 'observer', status: components.observer },
            ...lateCleanup.map(({ component, status, pid, exitCode, reason }) => ({ component, status, ...(pid === undefined ? {} : { pid }), ...(exitCode === undefined ? {} : { exitCode }), ...(reason === undefined ? {} : { reason }) })),
          ],
        }
        try {
          writeSetupFailureArtifact(options.attemptRoot, {
            sourceSha,
            stage: phase,
            error: new Error(result.failure ?? `supervisor returned ${result.status ?? 'unknown'}`),
            failureCode: detailCode,
            failurePhase: detailPhase,
            preflightPath,
            cleanup: failureCleanup,
            components,
            evidenceCandidates: runtimeFailureEvidenceCandidates(options.attemptRoot, preflightPath),
          })
        } catch {}
      }
    }
    return result
  } catch (error) {
    let cleanup = []
    try {
      cleanup = await cleanupPartialAttempt({
        tracked, server, observer, resident, options, identity: identityRef, attemptRoot: options.attemptRoot,
        keepObserver: false,
      })
    } catch (cleanupError) {
      cleanup = [{ component: 'cleanup', status: 'INCOMPLETE', reason: redactOperationalText(safeErrorDescription(cleanupError)) }]
    }
    const failurePath = join(options.attemptRoot, 'runner', 'runner-failure.json')
    if (!existsSync(failurePath)) {
      const cleanupStatus = cleanup.some((row) => row.status === 'INCOMPLETE') ? 'INCOMPLETE' : 'COMPLETE'
      const components = {
        leafServer: failedRunComponentState(server?.handle ?? tracked.leaf, cleanup, 'leaf'),
        observer: failedRunComponentState(observer?.handle ?? tracked.observer, cleanup, 'observer'),
        resident: failedRunComponentState(resident?.handle ?? tracked.resident, cleanup, 'resident'),
      }
      try {
        writeSetupFailureArtifact(options.attemptRoot, {
          sourceSha, stage: failurePhase, error, preflightPath,
          cleanup: { status: cleanupStatus, attempted: true, results: cleanup },
          components,
          evidenceCandidates: runtimeFailureEvidenceCandidates(options.attemptRoot, preflightPath),
        })
      } catch {}
    }
    throw error
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseCliArgs(argv) } catch (error) {
    process.stderr.write(`${redactOperationalText(safeErrorDescription(error))}\n${HELP}`)
    return 64
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  const preflight = await preflightProbe(options)
  if (options.preflight) {
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`)
    return preflight.status === 'READY' ? 0 : 2
  }
  if (preflight.status !== 'READY') {
    preflight.failureArtifact = persistRunPreflightFailure(options, preflight)
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`)
    process.stderr.write(`preflight is BLOCKED; no service was started; failure artifact: ${preflight.failureArtifact.path ?? preflight.failureArtifact.status}\n`)
    return 2
  }
  process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`)
  try {
    const result = await executeRun(options, preflight)
    process.stdout.write(`${JSON.stringify({ status: result.status, attemptRoot: options.attemptRoot, sourceSha: result.sourceSha, runId: result.runId, generationId: result.generationId, transitionId: result.terminal?.transitionId ?? null, captureStatus: result.captureGate?.status ?? null, probeStatus: result.validation?.probeStatus ?? result.validation?.status ?? null, observer: `http://127.0.0.1:${options.observerPort}/api/ai-summary` })}\n`)
    return result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2
  } catch (error) {
    process.stderr.write(`${redactOperationalText(safeErrorDescription(error))}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main()
