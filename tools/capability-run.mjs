#!/usr/bin/env bun
// capability-run: ONE autonomous capability measurement run for the campaign.
//
//   bun tools/capability-run.mjs --sha <40hex> --seed <int> --run-id <id> [options]
//
// Per run it:
//   1. materializes an exact-source worktree at --sha (own durable state +
//      provenance), runs `bun install --frozen-lockfile` inside;
//   2. stages a fresh NORMAL-type world in an isolated container on an
//      isolated loopback port with the predeclared seed;
//   3. boots packages/buddy-driver/agent-runner.mts (production V4.1.2 path —
//      real Jev policy via the key file/gateway, dynamic System2, no probe
//      mode) with BUDDY_MISSION_ITEM/COUNT;
//   4. polls the resident control socket until stats.goalComplete or timeout;
//   5. writes an acceptance record, quits, stops the server, and harvests
//      run-scoped evidence + a metrics result.json.
//
// Anti-gaming: the seed is predeclared by the caller and pinned into
// server.properties; the world container is created empty. Never reuses a
// generated world. Never issues operator commands to the world once the
// resident is launched — the one allowed fixture is `--start` placement
// (setworldspawn + spawnRadius 0), issued over server stdin after level
// prepare and before the resident's first join, so the measured run begins
// already at the declared coordinate.
//
// Campaign protocol v2 (2026-09-27): ONE live mutating capability run at a
// time (registry + process guard), canonical seed with a predeclared
// coordinate cohort; protocol v1 was per-run fresh seeds with parallel
// worlds — the two result sets are labelled separately and never mixed.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_DIR, '..')
const CAMPAIGN_DIR = join(REPO_ROOT, 'runs/capability-campaign')
const RUNS_ROOT = join(CAMPAIGN_DIR, 'runs')
/**
 * The live-run registry the campaign observer follows. Exactly one mutating
 * capability run owns this file at a time (protocol v2: sequential single-world
 * cohorts); tools/capability-observer.mjs and buddy-observer.mjs resolve the
 * current runtime dir from it instead of scanning for runtime state.
 */
const ACTIVE_RUN_REGISTRY = join(CAMPAIGN_DIR, 'active-run.json')
const LEAF_JAR = '/home/s0u7a/mc-server/leaf-1.21.11-178.jar'
const JAVA = '/usr/lib/jvm/java-21-openjdk-amd64/bin/java'
const RESIDENT_ENV = '/home/s0u7a/.config/mc-ai/resident.env'
const PROTECTED_PORTS = new Set([25565, 25570, 25572, 25576, 4173, 4174, 4175, 25577])
const SHA40 = /^[0-9a-f]{40}$/iu

const HELP = `Usage:
  bun tools/capability-run.mjs --sha <40hex> --seed <int> --run-id <id> [options]
Options:
  --port <n>            isolated loopback server port (default 26601)
  --timeout-min <n>     capability timeout (default 60)
  --mission-item <id>   mission item id (default 'log', the declared rung
                        predicate class: inventory_at_least counts any *_log —
                        a literal species like 'oak_log' makes the resident's
                        internal objective unsatisfiable on seeds whose only
                        trees are another species; measured live 2026-09-27 on
                        dev-424242-cand1: stranded on a pale_oak canopy with 93
                        pale_oak_log sensed and every MINE filtered by the
                        exact-name match, presented=[WAIT] forever)
  --mission-count <n>   mission count (default 1)
  --accept <spec>       success accept spec: 'log' (any *_log item) or a literal
                        item id; default = literal --mission-item. The rung's
                        capability predicate, evaluated on the resident's own
                        live inventory observation (report.currentInventoryObservation).
  --username <name>     bot username (default AI_Cap)
  --start <x>,<y>,<z>   protocol-v2 fixture spawn coordinate (pre-run
                        placement via setworldspawn + gamerule spawnRadius 0
                        over server stdin before the resident joins). Y is the
                        surface block of the declared cohort record — never
                        guessed by this tool. Marks the run protocolVersion=v2;
                        without it the run is v1 (per-run fresh seed).
  --allow-concurrent    escape hatch: launch even though another campaign run
                        is live (records concurrentOverride in the plan; the
                        registry is still written so the observer follows the
                        newest run). The default is a hard refusal — protocol v2
                        is sequential single-world for host stability.
  --keep-worktree       keep the exact-source worktree after the run
  --source-dir <path>   reuse an existing prepared worktree (no install)
  --no-server           skip server launch (attach to an existing world; debug only)
  --dry-run             stage + print the plan, do not launch
`

function parseArgs(argv) {
  const options = { sha: null, seed: null, runId: null, port: 26601, timeoutMin: 60, missionItem: 'log', missionCount: '1', accept: 'log', username: 'AI_Cap', start: null, allowConcurrent: false, keepWorktree: false, sourceDir: null, noServer: false, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return null
    if (arg === '--sha') options.sha = argv[++i] ?? null
    else if (arg === '--seed') options.seed = argv[++i] ?? null
    else if (arg === '--run-id') options.runId = argv[++i] ?? null
    else if (arg === '--port') options.port = Number(argv[++i])
    else if (arg === '--timeout-min') options.timeoutMin = Number(argv[++i])
    else if (arg === '--mission-item') options.missionItem = argv[++i]
    else if (arg === '--mission-count') options.missionCount = argv[++i]
    else if (arg === '--accept') options.accept = argv[++i]
    else if (arg === '--username') options.username = argv[++i]
    else if (arg === '--start') {
      const parts = String(argv[++i] ?? '').split(',').map((p) => Number(p.trim()))
      if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) throw new Error('--start must be <x>,<y>,<z> integers')
      const [x, y, z] = parts
      if (Math.abs(x) > 29_999_999 || Math.abs(z) > 29_999_999 || y < -64 || y > 320) throw new Error('--start out of world bounds')
      options.start = { x, y, z }
    }
    else if (arg === '--allow-concurrent') options.allowConcurrent = true
    else if (arg === '--keep-worktree') options.keepWorktree = true
    else if (arg === '--source-dir') options.sourceDir = argv[++i]
    else if (arg === '--no-server') options.noServer = true
    else if (arg === '--dry-run') options.dryRun = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options === null) return null
  if (!SHA40.test(String(options.sha ?? ''))) throw new Error('--sha must be a 40-hex commit')
  if (options.seed === null || !/^-?\d+$/.test(String(options.seed))) throw new Error('--seed must be an integer')
  if (typeof options.runId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,48}$/u.test(options.runId)) throw new Error('--run-id must be a lowercase slug')
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || PROTECTED_PORTS.has(options.port)) throw new Error('--port invalid or protected')
  if (!Number.isFinite(options.timeoutMin) || options.timeoutMin < 1) throw new Error('--timeout-min must be >= 1')
  return options
}

function loadResidentEnv() {
  const env = {}
  try {
    for (const line of readFileSync(RESIDENT_ENV, 'utf8').split(/\r?\n/u)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
      if (match) env[match[1]] = match[2]
    }
  } catch { /* absent env file is allowed; key file covers Jev */ }
  return env
}

function renderServerProperties({ port, levelName, seed }) {
  return [
    '# capability-campaign run-scoped world; predeclared seed; vanilla defaults otherwise',
    'server-ip=127.0.0.1',
    `server-port=${port}`,
    `level-name=${levelName}`,
    `level-seed=${seed}`,
    'level-type=minecraft\\:normal',
    'gamemode=survival',
    'difficulty=normal',
    'online-mode=false',
    'enforce-secure-profile=false',
    'spawn-protection=0',
    'allow-flight=false',
    'force-gamemode=false',
    'hardcore=false',
    'enable-rcon=false',
    'enable-query=false',
    'white-list=false',
    'view-distance=8',
    'simulation-distance=6',
    `motd=capability-run ${levelName}`,
    '',
  ].join('\n')
}

function portFree(port) {
  return new Promise((resolvePromise) => {
    const srv = net.createServer()
    srv.once('error', () => resolvePromise(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolvePromise(true)))
  })
}

function spawnLogged(command, args, { cwd, env, logPath, stdin = 'ignore' } = {}) {
  mkdirSync(dirname(logPath), { recursive: true })
  const out = appendFileSync.bind(null, logPath)
  const child = spawn(command, args, { cwd, env, detached: true, stdio: [stdin, 'pipe', 'pipe'] })
  child.stdout?.on('data', (chunk) => out(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => out(chunk.toString('utf8')))
  return child
}

async function control(sockPath, cmd, args = {}, timeoutMs = 10_000) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection(sockPath)
    let data = ''
    const timer = setTimeout(() => { socket.destroy(); resolvePromise({ ok: false, error: 'control-timeout' }) }, timeoutMs)
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: `cap-${Date.now()}`, cmd, args })}\n`))
    socket.on('data', (chunk) => { data += chunk.toString('utf8') })
    socket.on('end', () => {
      clearTimeout(timer)
      try { resolvePromise(JSON.parse(data.trim().split('\n').at(-1) ?? '{}')) } catch { resolvePromise({ ok: false, error: 'control-parse', raw: data.slice(-500) }) }
    })
    socket.on('error', (error) => { clearTimeout(timer); resolvePromise({ ok: false, error: `control-${error.code ?? 'connect'}` }) })
  })
}

function countMarkers(text, names) {
  const counts = {}
  for (const name of Object.keys(names)) counts[name] = 0
  for (const line of text.split('\n')) {
    const match = /^\[[^\]]*\]\s+([A-Z][A-Z0-9_]*)\b/u.exec(line)
    if (match && match[1] in counts) counts[match[1]] += 1
  }
  return counts
}

function extractLevelSeed(serverDir) {
  // cheapest honest seed echo: the level.dat RandomSeed — parsed elsewhere in
  // the repo via NBT; here we only need the *configured* seed echoed back, so
  // we verify world existence instead and let the acceptance record carry seed.
  return existsSync(join(serverDir, 'level.dat')) || existsSync(join(serverDir, 'world', 'level.dat'))
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function readActiveRunRegistry(path = ACTIVE_RUN_REGISTRY) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' && value.record === 'capability-active-run' && typeof value.runId === 'string' ? value : null
  } catch { return null }
}

function writeActiveRunRegistry(value, path = ACTIVE_RUN_REGISTRY) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Clear only when the entry still names THIS run — a newer run's claim is never clobbered by a stale cleanup. */
function clearActiveRunRegistry(runId, path = ACTIVE_RUN_REGISTRY) {
  const current = readActiveRunRegistry(path)
  if (current !== null && current.runId === runId) {
    try { unlinkSync(path) } catch { /* already gone */ }
  }
}

/**
 * Other live campaign runs visible to the process table (covers runs launched
 * before the registry existed — their server JVM carries the run path in argv).
 */
function liveCampaignProcesses() {
  const out = spawnSync('pgrep', ['-fa', 'runs/capability-campaign/runs/'], { encoding: 'utf8' })
  if (out.status !== 0 || typeof out.stdout !== 'string') return []
  // Exclude self and the direct parent: a `bash -c 'nohup bun … > runs/…/x.log &'`
  // launch wrapper carries the run path in its own cmdline for its ~ms lifetime.
  const selfPids = new Set([process.pid, process.ppid])
  return out.stdout.split('\n').map((line) => line.trim())
    .filter((line) => line !== '' && !selfPids.has(Number(line.split(/\s+/u, 1)[0])))
}

/** Sequential-cohort guard: refuse a second live mutating run unless explicitly overridden. */
function assertSingleLiveRun(options) {
  const registry = readActiveRunRegistry()
  const blockers = []
  if (registry !== null && pidAlive(registry.runnerPid)) {
    blockers.push(`registry names live run ${registry.runId} (runner pid ${registry.runnerPid})`)
  }
  const stray = liveCampaignProcesses()
  if (stray.length > 0) blockers.push(`live campaign processes: ${stray.join(' | ').slice(0, 400)}`)
  if (blockers.length > 0 && !options.allowConcurrent) {
    throw new Error(`protocol v2 is sequential: ${blockers.join('; ')}. Wait for it to finish or pass --allow-concurrent.`)
  }
  return { priorRegistry: registry, concurrentOverride: blockers.length > 0 }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options === null) { process.stdout.write(HELP); return 0 }
  const runId = options.runId
  const runDir = join(RUNS_ROOT, runId)
  if (existsSync(runDir)) throw new Error(`run dir already exists: ${runDir}`)
  const protocolVersion = options.start === null ? 'v1' : 'v2'
  // Dry-run is a non-mutating plan preview; the sequential guard binds only real launches.
  const { priorRegistry, concurrentOverride } = options.dryRun
    ? { priorRegistry: readActiveRunRegistry(), concurrentOverride: false }
    : assertSingleLiveRun(options)
  mkdirSync(runDir, { recursive: true })
  // Claim the active slot immediately: the full entry (runtimeDir, resident
  // pid, mission) is written after resident launch. This closes the staging
  // window where a second launch could otherwise pass the process guard.
  if (!options.dryRun) {
    writeActiveRunRegistry({
      record: 'capability-active-run',
      schemaVersion: 1,
      status: 'claiming',
      runId,
      runDir,
      runnerPid: process.pid,
      sha: options.sha,
      seed: options.seed,
      port: options.port,
      protocolVersion,
      ...(options.start !== null ? { start: options.start } : {}),
      claimedAt: new Date().toISOString(),
    })
  }

  const levelName = `cap-${runId}`
  const serverDir = join(runDir, 'server')
  const wtDir = options.sourceDir ?? join(runDir, 'src')
  const plan = {
    runId, sha: options.sha, seed: options.seed, port: options.port, levelName, runDir, serverDir, worktree: wtDir, timeoutMin: options.timeoutMin,
    mission: `inventory_at_least(${options.missionItem},${options.missionCount})`,
    protocolVersion,
    ...(options.start === null ? {} : {
      fixture: {
        start: options.start,
        method: 'setworldspawn+gamerule-spawnRadius-0',
        timing: 'pre-resident-join, after level prepare',
      },
    }),
    ...(concurrentOverride ? { concurrentOverride: true } : {}),
  }
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)

  // --- stage world container ---
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, 'server.properties'), renderServerProperties({ port: options.port, levelName, seed: options.seed }))
  writeFileSync(join(serverDir, 'eula.txt'), 'eula=true\n')
  if (options.dryRun) { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return 0 }

  // --- exact-source worktree ---
  if (options.sourceDir === null) {
    const add = spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', wtDir, options.sha], { encoding: 'utf8' })
    if (add.status !== 0) throw new Error(`git worktree add failed: ${add.stderr?.slice(0, 400)}`)
    const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: wtDir, encoding: 'utf8', timeout: 600_000 })
    if (install.status !== 0) throw new Error(`bun install failed: ${install.stderr?.slice(0, 400)}`)
  }
  const runnerEntry = join(wtDir, 'packages/buddy-driver/agent-runner.mts')
  if (!existsSync(runnerEntry)) throw new Error(`agent-runner.mts missing in worktree ${wtDir}`)

  if (!(await portFree(options.port))) throw new Error(`port ${options.port} is busy`)

  const procs = []
  const cleanup = async () => {
    clearActiveRunRegistry(runId)
    for (const p of procs.reverse()) {
      try { if (p.stdin && !p.stdin.destroyed) p.stdin.write('stop\n') } catch { /* ignore */ }
      try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch { /* ignore */ } }
    }
    await new Promise((r) => setTimeout(r, 3000))
    for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL') } catch { /* ignore */ } }
  }

  let serverProc = null
  try {
    // --- leaf server ---
    if (!options.noServer) {
      serverProc = spawnLogged(JAVA, ['-Xmx2G', '-Xms2G', '-DPaper.IgnoreJavaVersion=true', '-jar', LEAF_JAR, '--nogui', '--config', join(serverDir, 'server.properties'), '--universe', serverDir, '--level-name', levelName], { cwd: serverDir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, logPath: join(runDir, 'server.log'), stdin: 'pipe' })
      procs.push(serverProc)
      const deadline = Date.now() + 180_000
      let ready = false
      while (Date.now() < deadline) {
        const log = existsSync(join(runDir, 'server.log')) ? readFileSync(join(runDir, 'server.log'), 'utf8') : ''
        if (log.includes(`Done preparing level "${levelName}"`) || /Done \([\d.]+s\)! For help/u.test(log)) { ready = true; break }
        if (serverProc.exitCode !== null) throw new Error(`server exited early (code ${serverProc.exitCode}); see ${runDir}/server.log`)
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (!ready) throw new Error('server did not finish preparing the level within 180s')

      // Protocol-v2 start fixture: place the world's spawn at the declared
      // cohort coordinate BEFORE the resident joins (spawnRadius 0 makes the
      // first join land exactly on it). This is the only console command the
      // run ever issues; the measured clock starts after resident launch.
      if (options.start !== null) {
        const { x, y, z } = options.start
        serverProc.stdin.write('gamerule spawnRadius 0\n')
        serverProc.stdin.write(`setworldspawn ${x} ${y} ${z}\n`)
        // Let the console apply it before the bot's first login resolves spawn.
        await new Promise((r) => setTimeout(r, 1500))
      }
    }

    // --- resident (production V4.1.2 path; no probe mode) ---
    const residentEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/home/s0u7a',
      LANG: process.env.LANG ?? 'C.UTF-8',
      TZ: process.env.TZ ?? 'UTC',
      ...loadResidentEnv(),
      BUDDY_HOST: '127.0.0.1',
      BUDDY_PORT: String(options.port),
      BUDDY_USERNAME: options.username,
      BUDDY_MISSION_ITEM: options.missionItem,
      BUDDY_MISSION_COUNT: String(options.missionCount),
    }
    const residentProc = spawnLogged('bun', ['agent-runner.mts'], { cwd: join(wtDir, 'packages/buddy-driver'), env: residentEnv, logPath: join(runDir, 'resident-stdout.log') })
    procs.push(residentProc)

    // The canonical campaign pointer: the observer (tools/buddy-observer.mjs
    // registry mode) and rung bookkeeping follow this file instead of scanning
    // for runtime state. Cleared by cleanup() only while it still names this run.
    writeActiveRunRegistry({
      record: 'capability-active-run',
      schemaVersion: 1,
      status: 'active',
      runId,
      runDir,
      runtimeDir: join(wtDir, 'packages/buddy-driver'),
      serverLog: join(runDir, 'server.log'),
      residentStdout: join(runDir, 'resident-stdout.log'),
      port: options.port,
      runnerPid: process.pid,
      residentPid: residentProc.pid,
      sha: options.sha,
      seed: options.seed,
      username: options.username,
      mission: plan.mission,
      protocolVersion,
      ...(options.start !== null ? { start: options.start } : {}),
      ...(concurrentOverride ? { concurrentOverride: true } : {}),
      ...(priorRegistry !== null ? { reclaimedStaleRegistryFrom: priorRegistry.runId } : {}),
      startedAt: new Date().toISOString(),
    })

    // --- poll for mission completion ---
    // Success = the rung predicate holds in the resident's OWN live inventory
    // observation (currentInventoryObservation.counts). stats.goalComplete is
    // intentionally not the gate: resident mode runs finishOnObjectiveComplete=false,
    // so the generation never stops on objective; the verified inventory delta is
    // the honest capability evidence.
    const acceptLog = options.accept === 'log'
    const acceptItem = options.accept === null ? options.missionItem : options.accept
    const acceptCount = Number(options.missionCount)
    const accepts = (counts) => {
      if (counts === null || typeof counts !== 'object') return false
      if (acceptLog) return Object.entries(counts).some(([name, n]) => name.endsWith('_log') && Number(n) >= acceptCount)
      return Number(counts[acceptItem] ?? 0) >= acceptCount
    }
    const sock = join(wtDir, 'packages/buddy-driver/data/resident/control.sock')
    const buddyLogPath = join(wtDir, 'packages/buddy-driver/buddy.log')
    const stdoutLogPath = join(runDir, 'resident-stdout.log')
    const lastHeartbeatCounts = (text) => {
      // Last `inv={...}` inventory payload in a HEARTBEAT line. The resident's
      // socket replies starve while the generation is mid-scan (measured: report
      // hangs >12s during CANDIDATE_STARVATION loops, dev-424242-m2), so the
      // decision loop reads the honest inventory stream the resident itself
      // writes — same predicate, no socket dependency.
      let counts = null
      for (const m of text.matchAll(/HEARTBEAT [^\n]*?inv=(\{[^\n]*?\})/gu)) {
        try { counts = JSON.parse(m[1]) } catch { /* partial line */ }
      }
      return counts
    }
    const tailedInventory = () => {
      for (const path of [buddyLogPath, stdoutLogPath]) {
        try {
          if (!existsSync(path)) continue
          const text = readFileSync(path, 'utf8')
          const counts = lastHeartbeatCounts(text.slice(-2_000_000))
          if (counts !== null) return counts
        } catch { /* log not readable yet */ }
      }
      return null
    }
    const deadline = Date.now() + options.timeoutMin * 60_000
    const startedAt = Date.now()
    let outcome = 'TIMEOUT'
    let lastStatus = null
    let lastInventory = null
    let objectiveCompleteAtMs = null
    let inventoryAtCompletion = null
    let residentAliveAtEnd = false
    while (Date.now() < deadline) {
      if (residentProc.exitCode !== null) { outcome = `RESIDENT_EXIT_${residentProc.exitCode}`; break }
      const reply = await control(sock, 'report')
      if (reply.ok === true) {
        lastStatus = reply.data
        const counts = reply.data?.currentInventoryObservation?.counts ?? null
        if (counts !== null) lastInventory = counts
      }
      const polled = reply.ok === true ? (reply.data?.currentInventoryObservation?.counts ?? null) : null
      const live = polled ?? tailedInventory()
      if (live !== null) lastInventory = live
      if (accepts(live)) {
        objectiveCompleteAtMs = Date.now() - startedAt
        inventoryAtCompletion = live
        outcome = 'OBJECTIVE_SATISFIED'
        break
      }
      await new Promise((r) => setTimeout(r, 10_000))
    }
    residentAliveAtEnd = residentProc.exitCode === null

    // --- harvest ---
    await control(sock, 'acceptance').catch(() => null)
    await new Promise((r) => setTimeout(r, 1500))
    await control(sock, 'quit').catch(() => null)
    await new Promise((r) => setTimeout(r, 5000))

    const buddyLog = existsSync(join(wtDir, 'packages/buddy-driver/buddy.log')) ? readFileSync(join(wtDir, 'packages/buddy-driver/buddy.log'), 'utf8') : ''
    // last-resort inventory source: HEARTBEAT inv={...} lines (used when the
    // control socket is already gone at harvest time)
    let heartbeatInv = null
    let heartbeatInvAt = null
    for (const m of buddyLog.matchAll(/\[([0-9T:.Z-]+)\] HEARTBEAT [^\n]*?inv=(\{[^\n]*?\})/gu)) {
      heartbeatInvAt = m[1]
      try { heartbeatInv = JSON.parse(m[2]) } catch { /* partial line */ }
    }
    if (lastInventory === null && heartbeatInv !== null) lastInventory = heartbeatInv
    // first-satisfaction recovery for runs launched before report-polling existed:
    // scan HEARTBEAT lines in order for the first inv satisfying the accept spec.
    if (objectiveCompleteAtMs === null && outcome === 'TIMEOUT') {
      for (const m of buddyLog.matchAll(/\[([0-9T:.Z-]+)\] HEARTBEAT [^\n]*?inv=(\{[^\n]*?\})/gu)) {
        let counts = null
        try { counts = JSON.parse(m[2]) } catch { continue }
        if (accepts(counts)) {
          const t = Date.parse(m[1].replace(/Z$/, 'Z'))
          objectiveCompleteAtMs = Number.isFinite(t) ? t - startedAt : null
          inventoryAtCompletion = counts
          outcome = 'OBJECTIVE_SATISFIED_LATE_OBSERVED'
          break
        }
      }
    }
    // Fixture verification (protocol v2): the resident's own first SPAWN line is
    // the evidence the declared start coordinate is where the measured run began.
    const firstSpawn = /SPAWN pos=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/u.exec(buddyLog)
    const actualSpawn = firstSpawn === null ? null : { x: Number(firstSpawn[1]), y: Number(firstSpawn[2]), z: Number(firstSpawn[3]) }
    const fixtureDisplacement = options.start !== null && actualSpawn !== null
      ? Math.hypot(actualSpawn.x - (options.start.x + 0.5), actualSpawn.z - (options.start.z + 0.5))
      : null
    const markers = countMarkers(buddyLog, {
      DEATH: 0, RECOVERY: 0, RECONNECT: 0, QUIT: 0, ERROR: 0, WARN: 0,
      MISSION_PREFLIGHT: 0, PROPOSALS_COMMITTED: 0, PROPOSALS_DISCARDED: 0,
      MODEL_UNAVAILABLE: 0, MODEL_RECOVERED: 0, BOOT: 0, ACCEPTANCE: 0,
      LADDER_INVENTORY_SETTLE: 0, LEDGER_REGROUND: 0,
    })
    const acceptanceDir = join(wtDir, 'packages/buddy-driver/data/resident')
    const acceptanceFiles = existsSync(acceptanceDir) ? readdirSync(acceptanceDir).filter((f) => f.startsWith('acceptance-') && f.endsWith('.json')) : []
    const latestAcceptance = acceptanceFiles.length > 0 ? JSON.parse(readFileSync(join(acceptanceDir, acceptanceFiles.sort().at(-1)), 'utf8')) : null
    const jevDecisionsDir = join(wtDir, 'packages/jev-agent/logs')
    let jevDecisionCount = 0
    if (existsSync(jevDecisionsDir)) for (const f of readdirSync(jevDecisionsDir).filter((f) => f.startsWith('decisions') && f.endsWith('.jsonl'))) jevDecisionCount += readFileSync(join(jevDecisionsDir, f), 'utf8').split('\n').filter((l) => l.trim().length > 0).length

    const result = {
      record: 'capability-run-result', schemaVersion: 2,
      runId, sha: options.sha, seed: String(options.seed), port: options.port, levelName,
      mission: plan.mission, accept: options.accept ?? acceptItem, username: options.username,
      protocolVersion,
      ...(options.start === null ? {} : {
        fixture: { start: options.start, actualSpawn, fixtureDisplacementBlocks: fixtureDisplacement },
      }),
      ...(concurrentOverride ? { concurrentOverride: true } : {}),
      outcome, residentAliveAtEnd, worldPresent: extractLevelSeed(serverDir),
      objectiveCompleteAtMs, inventoryAtCompletion, finalInventory: lastInventory,
      wallClockMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
      markers, jevDecisionCount,
      stats: lastStatus?.stats ?? null,
      modelAvailability: lastStatus?.modelAvailability ?? null,
      acceptance: latestAcceptance === null ? null : {
        runId: latestAcceptance.runId, goalComplete: latestAcceptance.goalComplete, wedge: latestAcceptance.wedge,
        reconnects: latestAcceptance.reconnects, reloads: latestAcceptance.reloads, levelName: latestAcceptance.levelName,
        seed: latestAcceptance.seed, sourceSha: latestAcceptance.sourceSha ?? latestAcceptance.provenance ?? null,
        modelAvailability: latestAcceptance.modelAvailability ?? null, listenerLeak: latestAcceptance.listenerLeak ?? null,
      },
      paths: { runDir, worktree: wtDir, buddyLog: join(wtDir, 'packages/buddy-driver/buddy.log'), serverLog: join(runDir, 'server.log'), residentStdout: join(runDir, 'resident-stdout.log') },
    }
    writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    await cleanup()
    if (!options.keepWorktree && options.sourceDir === null) {
      spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', wtDir], { encoding: 'utf8' })
    }
    process.stdout.write(`${JSON.stringify({ runId, outcome, objectiveCompleteAtMs, inventory: inventoryAtCompletion ?? lastInventory, runDir }, null, 2)}\n`)
    return outcome === 'OBJECTIVE_SATISFIED' ? 0 : outcome.startsWith('RESIDENT_EXIT') ? 2 : 1
  } catch (error) {
    await cleanup()
    writeFileSync(join(runDir, 'error.txt'), `${error instanceof Error ? error.stack : String(error)}\n`)
    process.stderr.write(`capability-run failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
