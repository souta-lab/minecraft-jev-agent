#!/usr/bin/env bun
// m2-reproducibility — measure the M2 RATE over N FRESH WORLDS, one run-scoped
// trial at a time, with a resumable append-only ledger.
//
// WHY THIS EXISTS (operator redefinition, 2026-09-23)
// ---------------------------------------------------
//   「一発の最高到達点より、再現性。」
//   「M3を一度だけクリアするAI vs 別ワールドでM2を100回クリアするAI」
//   「「最高性能」より「安定して出せる性能」のほうが、エージェントとして強い。」
//
// The headline number is therefore a RATE, not a peak: M2 (`build -> light ->
// verify`) cleared on N FRESH WORLDS with N different seeds. One spectacular
// peak is not the metric; `successes / countable trials` is, plus WHICH
// capability is the reproducibility bottleneck.
//
// WHAT ONE TRIAL IS
// -----------------
//   (a) stage a FRESH world with a NEW seed and a DISTINCT level name, using the
//       existing clean-run stager (tools/clean-run-prepare.mjs) — no second
//       staging implementation;
//   (b) record the trial's IDENTITY (level name, seed, source SHA, server
//       config, descriptor hashes) BEFORE anything runs;
//   (c) start the server on that world and the resident from a tree at the
//       frozen SHA;
//   (d) watch the run's OWN evidence for the M2 chain with a bounded deadline;
//   (e) record ONE row: PASS / FAIL(first unmet gate stage) / TIMEOUT(last observed
//       rung) / SPLIT / INFRA, quoting the run-scoped evidence — never a marker
//       name alone;
//   (f) tear down that trial's server and resident cleanly, then move on.
//
// EVIDENCE RULE (the whole point)
// -------------------------------
// A trial is COUNTABLE only when ONE runId's own evidence carries the ordered
// chain
//
//   PORTAL_BLOCK_PLACED
//     -> PORTAL_FRAME_READY blocks>=10 shape=ok
//       -> PORTAL_LIT dimension=minecraft:overworld
//         -> PORTAL_VERIFIED=true
//
// and is bounded by that runId's own `BOOT ... runId=R` line. The verdict itself
// is never re-derived here: the canonical tools/m2-gate.mjs decides it, in
// process, through runM2Gate()/evaluateM2Gate(). This file only decides WHICH
// trial happened, WHICH evidence belongs to it, and WHETHER it is countable.
//
// SPLIT BOOTS. A resident restart (a provider outage, a crash retried by
// tools/resident-supervisor.mjs) produces a NEW runId, so a chain assembled
// across two boots is not one run's claim. Any trial whose watched window holds
// more than one BOOT runId is recorded as SPLIT: never a PASS, never a FAIL.
// The chain observed across those boots is kept as a DIAGNOSTIC field only and
// can never enter the rate.
//
// WHAT THIS TOOL DOES NOT DO
// --------------------------
//   * It never deletes anything. Worlds are never removed (a played world can
//     never be a clean target); finished durable state is MOVED (quarantined)
//     into the trial's own evidence directory.
//   * It never prints a secret. The staged `server.properties` carries
//     `rcon.password`, so the stager's plan is consumed in-process and only
//     paths/hashes — never file contents — are persisted.
//   * It never touches another trial's evidence: every trial writes into
//     `trial-<NNN>/attempt-<K>/`, created with an exclusive mkdir.
//   * It does not parallelise. `buddy-driver/agent-runner.mts` hardcodes
//     `HOST=127.0.0.1` / `PORT=25565` and the HOST lock is one-per-driver-tree,
//     so exactly one trial can be live on this machine at a time. Campaigns are
//     therefore strictly serial and one campaign refuses to start while another
//     (or any resident) is live.
//
// WHAT IS NOT AUTOMATABLE (see the report this tool prints)
// --------------------------------------------------------
// Freezing the tree, and the ONE-TIME operator decision to release the live
// resident + server (root AGENTS.md H4) before a campaign starts. Everything
// inside a campaign is automated; the campaign boundary is not.
//
// Usage:
//   bun tools/m2-reproducibility.mjs --campaign c1 --trials 3 --frozen-sha <40hex> --apply --live
//   bun tools/m2-reproducibility.mjs --campaign c1 --rehearse --rehearse-outcome pass
//   bun tools/m2-reproducibility.mjs --report --campaign c1
//   bun tools/m2-reproducibility.mjs --help
//
// Exit codes: 0 = ok (report/summary written), 1 = refused (precondition,
// safety, or a campaign whose rate is 0), 2 = usage error.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { hostname, totalmem, freemem } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyPlan, planPrepare, M2_RUN_DIR_NAME } from './clean-run-prepare.mjs'
import {
  PROTECTED_LEVEL_NAMES,
  levelNameProblems,
  loadCleanEnvironment,
  seedProblems,
  sha256Text,
  worldDataExists,
} from './clean-run-environment.mjs'
import {
  M2_REQUIRED_STAGES,
  detectPortalFailure,
  parseInventoryMarker,
  parsePortalMarker,
  portalChainLink,
  evaluatePortalChain,
  evaluateM2Gate,
  formatPortalChainLine,
  readRunScopedM2Evidence,
  residentPaths,
  runM2Gate,
} from './m2-gate.mjs'
import { findResidentProcesses, pidAlive, readHostLock } from './resident-supervisor.mjs'

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(HERE)
export const SCHEMA_VERSION = 1
export const TRIAL_RECORD = 'm2-repro-trial'
export const CAMPAIGN_RECORD = 'm2-repro-campaign'
export const CAMPAIGN_AMENDMENT_RECORD = 'm2-repro-campaign-amendment'
export const LEDGER_NAME = 'ledger.jsonl'
export const SUMMARY_NAME = 'summary.json'
export const TABLE_NAME = 'REPRODUCIBILITY.md'
export const LIVE_CONTAINER = '/home/s0u7a/mc-server'
export const JAVA = '/usr/lib/jvm/java-21-openjdk-amd64/bin/java'
export const SERVER_JAR = 'leaf-1.21.11-178.jar'
export const RESIDENT_PORT = 25565
export const REPRO_ROOT = '/home/s0u7a/mc-ai'
export const WORKTREES_ROOT = '/home/s0u7a/mc-ai-worktrees'

/** Row statuses. `countable` is derived, never asserted. */
export const TRIAL_STATUSES = Object.freeze([
  'PASS',
  'FAIL',
  'TIMEOUT',
  'SPLIT',
  'INFRA',
  'STAGED_ONLY',
  'PLANNED',
])
/** The statuses that enter the denominator of the rate. */
export const COUNTABLE_STATUSES = Object.freeze(['PASS', 'FAIL', 'TIMEOUT'])
/** Statuses that are recorded but excluded from the rate, with the reason. */
export const UNCOUNTABLE_REASONS = Object.freeze({
  SPLIT: 'evidence is split across more than one boot runId: a run-scoped claim may not mix boots',
  INFRA: 'the measurement did not happen (staging/boot/precondition failure)',
  STAGED_ONLY: 'staging+identity only, no server/resident was started (no live measurement)',
  PLANNED: 'identity was recorded but the trial never started',
})

const ISO_RE = /^\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)\]\s*/
const BOOT_RE = /\bBOOT\b(?!_)/
const RUN_ID_RE = /\brunId=(run-[A-Za-z0-9-]+)/
const BOOT_SOURCE_RE = /\bsource=([0-9a-f]{7,40}|null)\b/
const BOOT_PID_RE = /\bpid=(\d+)/
const BOOT_MILESTONE_RE = /\bmilestone=([A-Za-z0-9_]+)/
const BOOT_WORLD_EPOCH_RE = /\bworldEpoch=(\d+)/
const RUNG_RE = /\brung=([A-Za-z0-9_]+)/
const MC_SEED_RE = /Seed:\s*\[(-?\d+)\]/
const MC_FRESH_RE = /No existing world data, creating new world/
const MC_READY_RE = /Done \([0-9.]+s\)!/
const DURABLE_STATE_PATHS = Object.freeze([
  'buddy.log',
  'buddy-state.json',
  'buddy-ledger.json',
  'runner.out',
  'data/resident',
  'data/supervisor',
  'data/supervisor.log',
  'logs',
])

// ---------------------------------------------------------------------------
// tiny utilities
// ---------------------------------------------------------------------------

export function iso(now = Date.now()) {
  return new Date(now).toISOString()
}

export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

export function nowIso() {
  return iso(Date.now())
}

/** sha256 of a file's raw bytes, or null when unreadable. */
export function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** sha256 of a file's UTF-8 text, or null when unreadable. */
export function sha256FileText(path) {
  try {
    return sha256Text(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Validate a one-seed-per-trial list before any campaign output or staging. */
export function validateSeedList(seedList, trials) {
  const problems = []
  if (!Array.isArray(seedList)) return ['seed_list_not_an_array']
  if (!Number.isInteger(trials) || trials < 1) problems.push(`trials_must_be_positive_integer:${String(trials)}`)
  if (seedList.length !== trials) problems.push(`seed_list_length:${seedList.length}:expected:${trials}`)
  const seen = new Map()
  for (let index = 0; index < seedList.length; index += 1) {
    const raw = String(seedList[index] ?? '').trim()
    if (!/^(?:0|-?[1-9]\d*)$/.test(raw)) {
      problems.push(`seed_${index}_not_canonical_integer:${JSON.stringify(raw)}`)
      continue
    }
    let value
    try {
      value = BigInt(raw)
    } catch {
      problems.push(`seed_${index}_not_integer:${JSON.stringify(raw)}`)
      continue
    }
    if (value < -(1n << 63n) || value > (1n << 63n) - 1n) {
      problems.push(`seed_${index}_outside_signed_64_bit_range:${raw}`)
      continue
    }
    if (value === 0n) problems.push(`seed_${index}_is_zero`)
    if (value === 2024n) problems.push(`seed_${index}_reuses_previous_world_seed:2024`)
    const canonical = value.toString()
    if (seen.has(canonical)) problems.push(`seed_duplicate:${canonical}:trials:${seen.get(canonical)},${index}`)
    else seen.set(canonical, index)
  }
  return problems
}

export function parseSeedList(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Read exactly `[from, to)` bytes. Never loads more than the trial's own window,
 * so a shared multi-GB resident log costs only the bytes this trial produced.
 */
export function readWindow(path, from, to, { chunk = 1 << 20 } = {}) {
  if (!isFile(path)) return ''
  const start = Math.max(0, from)
  const end = to === null || to === undefined ? fileSize(path) : to
  if (end <= start) return ''
  const fd = openSync(path, 'r')
  try {
    const parts = []
    let offset = start
    while (offset < end) {
      const want = Math.min(chunk, end - offset)
      const buffer = Buffer.allocUnsafe(want)
      const read = readSync(fd, buffer, 0, want, offset)
      if (read <= 0) break
      parts.push(buffer.subarray(0, read))
      offset += read
    }
    return Buffer.concat(parts).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Append one JSON record and fsync it: the ledger must survive a hard kill. */
export function appendJsonl(path, record) {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a')
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function readJsonl(path) {
  if (!isFile(path)) return []
  const rows = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      rows.push({ record: 'ledger-parse-error', raw: trimmed.slice(0, 200) })
    }
  }
  return rows
}

/** Write a JSON file atomically (tmp + rename) so a reader never sees a half file. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export function freeBytes(path) {
  try {
    const probe = Bun.spawnSync(['df', '-B1', '--output=avail', path])
    const match = /(\d+)/.exec(probe.stdout.toString().trim().split('\n').pop() ?? '')
    return match === null ? null : Number(match[1])
  } catch {
    return null
  }
}

/** True when nothing is listening on 127.0.0.1:<port>. */
export async function portFree(port, { timeoutMs = 800 } = {}) {
  return await new Promise((done) => {
    let settled = false
    const finish = (free) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      done(free)
    }
    const socket = Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open() {
          finish(false)
        },
        error() {
          finish(true)
        },
        data() {
          finish(false)
        },
        close() {
          finish(false)
        },
      },
    })
    socket.catch(() => finish(true))
    setTimeout(() => finish(true), timeoutMs)
  })
}

/**
 * Every resident host process on this machine, by reading /proc directly (no
 * broad `pgrep -f`, root AGENTS.md §7). Used to protect a live trial that this
 * campaign does not own.
 */
export function listResidentPids() {
  const found = []
  let entries = []
  try {
    entries = readdirSync('/proc')
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let cmdline = ''
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
    } catch {
      continue
    }
    if (cmdline.includes('agent-runner.mts')) found.push({ pid: Number(entry), cmdline: cmdline.replaceAll('\0', ' ').trim() })
  }
  return found
}

/** Minecraft server processes are machine-global too; inspect without signalling. */
export function listServerPids(serverJar = SERVER_JAR) {
  const found = []
  let entries = []
  try {
    entries = readdirSync('/proc')
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let cmdline = ''
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
    } catch {
      continue
    }
    const executable = cmdline.split('\0', 1)[0] ?? ''
    if (cmdline.includes(serverJar) && /(?:^|\/)java(?:\d+)?$/.test(executable)) {
      found.push({ pid: Number(entry), cmdline: cmdline.replaceAll('\0', ' ').trim() })
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// seed / level-name derivation
// ---------------------------------------------------------------------------

/** 32-bit-safe slug for level names and campaign ids. */
export function slug(text, { max = 18 } = {}) {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned === '' ? 'x' : cleaned).slice(0, max).replace(/-+$/g, '')
}

/**
 * Deterministic per-trial seed: `sha256(campaignId:trialIndex:seedBase)` folded
 * into a signed 64-bit decimal. Deterministic (not random) so a campaign can be
 * re-derived by anyone holding the campaign id + seed base, and never 0 or the
 * live world's seed 2024.
 */
export function deriveSeed(campaignId, trialIndex, seedBase) {
  const digest = createHash('sha256').update(`${campaignId}:${trialIndex}:${seedBase}`).digest()
  let value = 0n
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(digest[i])
  if (value >= 1n << 63n) value -= 1n << 64n
  if (value === 0n || value === 2024n) value += 1n
  return value.toString()
}

/** Derive an isolated retry seed while preserving the first attempt's seed. */
export function deriveAttemptSeed({ campaignId, trialIndex, attempt, seedBase, explicitSeed = null, usedSeeds = [] }) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be a positive integer, got ${String(attempt)}`)
  if (attempt === 1) {
    return explicitSeed === null ? deriveSeed(campaignId, trialIndex, seedBase) : String(explicitSeed)
  }
  const used = new Set(usedSeeds.map(String))
  if (explicitSeed !== null) used.add(String(explicitSeed))
  for (let collision = 0; collision < 1000; collision += 1) {
    const seed = deriveSeed(
      campaignId,
      `${trialIndex}:attempt:${attempt}:collision:${collision}`,
      `${seedBase}:${String(explicitSeed ?? '')}`,
    )
    if (!used.has(seed)) return seed
  }
  throw new Error(`unable to derive unused seed for trial=${trialIndex} attempt=${attempt}`)
}

/** `m2rep-<campaign>-t<NNN>-a<NN>`; every retry gets a distinct fresh world. */
export function trialLevelName(campaignId, trialIndex, prefix = 'm2rep', attempt = 1) {
  if (!Number.isInteger(trialIndex) || trialIndex < 0) throw new Error(`trialIndex must be a non-negative integer, got ${String(trialIndex)}`)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) throw new Error(`attempt must be in 1..99, got ${String(attempt)}`)
  const safePrefix = slug(prefix, { max: 8 })
  const trial = `t${String(trialIndex).padStart(3, '0')}`
  const attemptToken = `a${String(attempt).padStart(2, '0')}`
  const budget = Math.max(1, 32 - safePrefix.length - trial.length - attemptToken.length - 3)
  return `${safePrefix}-${slug(campaignId, { max: budget })}-${trial}-${attemptToken}`
}

// ---------------------------------------------------------------------------
// campaign lock (machine-global: the resource is machine-global)
// ---------------------------------------------------------------------------

export function campaignLockPath() {
  return process.env.M2_REPRO_LOCK ?? join(REPRO_ROOT, 'runs', 'm2-repro', '.campaign.lock')
}

/**
 * Claim the machine-wide campaign lock with an exclusive create, reclaiming a
 * lock whose pid is provably dead (the same conservative rule the HOST lock
 * uses). Refuses when a live campaign already owns it.
 */
export function claimCampaignLock(path, { campaignId, trials, frozenSha }) {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeFileSync(
        path,
        `${JSON.stringify({ record: 'm2-repro-lock', pid: process.pid, campaignId, trials, frozenSha, host: hostname(), at: nowIso() })}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
      return { ok: true, path, reclaimed: attempt > 0 }
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, path, reason: `lock_write_failed:${String(error?.code ?? error)}` }
      let holder = null
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        holder = null
      }
      const holderPid = Number(holder?.pid ?? Number.NaN)
      if (Number.isFinite(holderPid) && pidAlive(holderPid)) {
        return {
          ok: false,
          path,
          reason: `another campaign is live: pid=${holderPid} campaign=${String(holder?.campaignId)} since=${String(holder?.at)} (a second trial must never run at once; stop it or remove ${path} only if that pid is really gone)`,
          holder,
        }
      }
      // A dead holder: take the file away atomically, then retry the wx create.
      const taken = `${path}.stale-${Date.now()}`
      try {
        renameSync(path, taken)
      } catch {
        /* another process won the reclaim; the next loop iteration re-reads */
      }
    }
  }
  return { ok: false, path, reason: 'lock_reclaim_exhausted' }
}

export function releaseCampaignLock(path, { finished = true } = {}) {
  if (!existsSync(path)) return
  try {
    renameSync(path, `${path}.${finished ? 'finished' : 'released'}-${Date.now()}`)
  } catch {
    /* the lock is advisory; never fail the run on it */
  }
}

// ---------------------------------------------------------------------------
// preconditions
// ---------------------------------------------------------------------------

/**
 * Everything that must be true before a LIVE trial may start. Fail closed with
 * one named reason each; a campaign never works around a refusal.
 */
export async function checkPreconditions(config, { mode }) {
  const blockers = []
  const observations = {}
  const rehearsal = mode === 'rehearse'
  const stageOnly = mode === 'stage'

  observations.liveResidentProcesses = listResidentPids()
  observations.liveServerProcesses = listServerPids()
  observations.hostLock = readHostLock(config.driverDir)
  observations.residentProcesses = findResidentProcesses(config.driverDir)
  observations.port = RESIDENT_PORT
  observations.portFree = await portFree(RESIDENT_PORT)
  observations.freeBytes = freeBytes(config.serverRoot)
  observations.driverDurableState = durableStatePresent(config.driverDir)

  if (rehearsal) {
    // A rehearsal must be non-overlapping by construction: a scratch container
    // and a stub server on an ephemeral port. It never signals anything.
    if (resolve(config.serverRoot) === resolve(LIVE_CONTAINER)) {
      blockers.push('rehearsal_server_root_is_the_live_container: a rehearsal must stage into its own scratch --server-root')
    }
    if (config.driverDir.startsWith(resolve(LIVE_CONTAINER))) {
      blockers.push('rehearsal_driver_dir_inside_server_root')
    }
    if (config.driverDir === resolve(join(config.frozenTree, 'buddy-driver')) && observations.residentProcesses.length > 0) {
      blockers.push(`resident_already_live_in_this_driver_dir: pids=${observations.residentProcesses.map((p) => p.pid).join(',')}`)
    }
    // The live trial's resident/server are EXPECTED to be running: record it.
    observations.liveTrialPresent = observations.liveResidentProcesses.length > 0
    return { blockers, observations }
  }

  const frozenSource = inspectFrozenSource(config)
  observations.frozenSource = frozenSource.observation
  blockers.push(...frozenSource.blockers)

  if (config.live) {
    const harnessSource = inspectFrozenSource({
      ...config,
      frozenTree: REPO_ROOT,
      driverDir: join(REPO_ROOT, 'buddy-driver'),
    })
    observations.harnessSource = harnessSource.observation
    if (harnessSource.blockers.length > 0) {
      blockers.push(...harnessSource.blockers.map((reason) => `harness_${reason}`))
    }
  }

  if (stageOnly) {
    // Staging writes a world directory and a resolved descriptor and nothing else:
    // no process is started, so the resident/port/tree guards do not apply.
    if (observations.freeBytes !== null && observations.freeBytes < config.minFreeBytes) {
      blockers.push(`low_disk: ${observations.freeBytes} bytes free < min ${config.minFreeBytes}`)
    }
    return { blockers, observations }
  }
  if (observations.liveResidentProcesses.length > 0) {
    blockers.push(
      `resident_is_live: pids=${observations.liveResidentProcesses.map((p) => p.pid).join(',')} — a live trial is not this campaign's to stop. ` +
        'Releasing it is an operator decision (root AGENTS.md H4); this harness never signals a resident it did not start.',
    )
  }
  if (observations.liveServerProcesses.length > 0) {
    blockers.push(`server_is_live: pids=${observations.liveServerProcesses.map((p) => p.pid).join(',')} — a live trial never stops a server it did not start`)
  }
  if (observations.portFree !== true) {
    blockers.push(`port_${RESIDENT_PORT}_in_use: the resident hardcodes 127.0.0.1:${RESIDENT_PORT}, so a trial needs it free`)
  }
  if (observations.hostLock?.present === true && pidAlive(Number(observations.hostLock.pid))) {
    blockers.push(`host_lock_held: ${observations.hostLock.path} pid=${observations.hostLock.pid}`)
  }
  if (config.frozenSha === null || !/^[0-9a-f]{40}$/.test(String(config.frozenSha))) {
    blockers.push(`frozen_sha_not_40_hex: --frozen-sha=${String(config.frozenSha)}`)
  }
  if (config.frozenTree !== null) {
    const head = gitHead(config.frozenTree)
    observations.frozenTreeHead = head
    if (head === null) blockers.push(`frozen_tree_not_a_git_checkout: ${config.frozenTree}`)
    else if (head !== config.frozenSha) blockers.push(`frozen_tree_head_mismatch: ${config.frozenTree} HEAD=${head} but --frozen-sha=${config.frozenSha}`)
  }
  if (!isFile(join(config.serverRoot, SERVER_JAR))) blockers.push(`server_jar_missing: ${join(config.serverRoot, SERVER_JAR)}`)
  if (!isFile(join(config.serverRoot, 'server.properties'))) blockers.push(`server_properties_missing: ${join(config.serverRoot, 'server.properties')}`)
  if (!isFile(join(config.serverRoot, 'eula.txt'))) blockers.push(`eula_missing: ${join(config.serverRoot, 'eula.txt')}`)
  if (config.serverRoot !== LIVE_CONTAINER) {
    blockers.push(
      `server_root_is_not_the_live_container: agent-runner.mts serverSeed() reads ${LIVE_CONTAINER}/server.properties verbatim, ` +
        `so a world served from ${config.serverRoot} would attest the WRONG seed (CLEAN-RUN-EXECUTION.md §4). Live trials must use ${LIVE_CONTAINER}.`,
    )
  }
  if (observations.freeBytes !== null && observations.freeBytes < config.minFreeBytes) {
    blockers.push(`low_disk: ${observations.freeBytes} bytes free < min ${config.minFreeBytes}`)
  }
  return { blockers, observations }
}

export function gitHead(tree) {
  try {
    const probe = Bun.spawnSync(['git', '-C', tree, 'rev-parse', 'HEAD'])
    if (probe.exitCode !== 0) return null
    const head = probe.stdout.toString().trim()
    return /^[0-9a-f]{40}$/.test(head) ? head : null
  } catch {
    return null
  }
}

function gitDirtyTree(tree) {
  try {
    const probe = Bun.spawnSync(['git', '-C', tree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
    if (probe.exitCode !== 0) return null
    return probe.stdout.toString().trim() !== ''
  } catch {
    return null
  }
}

/** Immutable campaign inputs; changing one requires a new campaign id. */
export function campaignParameters(config) {
  return {
    evidenceClass: config.evidenceClass,
    frozenSha: config.frozenSha,
    frozenTree: resolve(config.frozenTree),
    driverDir: resolve(config.driverDir),
    serverRoot: resolve(config.serverRoot),
    descriptorPath: resolve(config.descriptorPath),
    descriptorSha256: sha256FileText(config.descriptorPath),
    seedBase: String(config.seedBase),
    seedListSha256: config.seedListSha256 ?? null,
    levelPrefix: config.levelPrefix,
    botUsername: config.botUsername,
    deadlineMs: config.deadlineMs,
    settleMs: config.settleMs,
    pollMs: config.pollMs,
    bootTimeoutMs: config.bootTimeoutMs,
    serverReadyMs: config.serverReadyMs,
    maxRestarts: config.maxRestarts,
    minFreeBytes: config.minFreeBytes,
    harnessSha: gitHead(REPO_ROOT),
    harnessDirtyTree: gitDirtyTree(REPO_ROOT),
    bunVersion: Bun.version,
  }
}

export function campaignParameterMismatches(pinned, actual) {
  if (pinned === null || typeof pinned !== 'object' || Array.isArray(pinned)) return ['campaign_parameters_missing:new_campaign_id_required']
  return Object.keys(actual)
    .filter((key) => !Object.prototype.hasOwnProperty.call(pinned, key) || JSON.stringify(pinned[key]) !== JSON.stringify(actual[key]))
    .map((key) => `campaign_parameter_changed:${key}:pinned=${JSON.stringify(pinned[key] ?? null)}:requested=${JSON.stringify(actual[key] ?? null)}`)
}

export function campaignExitCode(summary) {
  return summary.rate.successes > 0 || summary.trials.countable === 0 ? 0 : 1
}

export function plannedTrialCount(rows) {
  const campaign = rows.find((row) => row.record === CAMPAIGN_RECORD)
  const amendments = rows.filter((row) => row.record === CAMPAIGN_AMENDMENT_RECORD)
  return amendments.at(-1)?.trials ?? campaign?.trials ?? null
}

/** Check the exact source checkout and keep its resident directory inside it. */
export function inspectFrozenSource(config) {
  const blockers = []
  const observation = {
    tree: config.frozenTree,
    driverDir: config.driverDir,
    head: null,
    dirtyTree: null,
    statusEntries: null,
  }
  if (typeof config.frozenTree !== 'string' || config.frozenTree === '') {
    blockers.push('frozen_tree_missing')
    return { blockers, observation }
  }
  const tree = resolve(config.frozenTree)
  const driver = resolve(config.driverDir)
  observation.tree = tree
  observation.driverDir = driver
  observation.head = gitHead(tree)
  if (observation.head === null) blockers.push(`frozen_tree_not_a_git_checkout:${tree}`)
  else if (observation.head !== config.frozenSha) {
    blockers.push(`frozen_tree_head_mismatch:${tree}:HEAD=${observation.head}:expected=${String(config.frozenSha)}`)
  }
  try {
    const treeReal = realpathSync(tree)
    const lexicalRelative = relative(tree, driver)
    const driverCandidate = resolve(treeReal, lexicalRelative)
    const driverReal = existsSync(driver) ? realpathSync(driver) : driverCandidate
    const driverRelative = relative(treeReal, driverReal)
    observation.treeRealPath = treeReal
    observation.driverRealPath = driverReal
    if (driverRelative === '' || driverRelative === '..' || driverRelative.startsWith(`..${sep}`) || resolve(treeReal, driverRelative) !== driverReal) {
      blockers.push(`driver_dir_outside_frozen_tree:${driverReal}:tree=${treeReal}`)
    }
    if (!isFile(join(driverReal, 'agent-runner.mts'))) {
      blockers.push(`frozen_runner_missing:${join(driverReal, 'agent-runner.mts')}`)
    }
  } catch (error) {
    blockers.push(`frozen_source_path_unreadable:${String(error?.code ?? error)}`)
  }
  try {
    const probe = Bun.spawnSync(['git', '-C', tree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
    if (probe.exitCode !== 0) blockers.push(`frozen_tree_status_failed:${tree}`)
    else {
      const entries = probe.stdout.toString().split('\n').filter(Boolean)
      observation.statusEntries = entries.length
      observation.dirtyTree = entries.length > 0
      if (entries.length > 0) blockers.push(`frozen_tree_dirty:${tree}:entries=${entries.length}`)
    }
  } catch (error) {
    blockers.push(`frozen_tree_status_failed:${String(error?.code ?? error)}`)
  }
  return { blockers, observation }
}

/** The runtime state a resident writes; quarantined between trials (moved, never deleted). */
export function durableStatePresent(driverDir) {
  const present = []
  for (const rel of DURABLE_STATE_PATHS) {
    const path = join(driverDir, rel)
    if (existsSync(path)) {
      let bytes = 0
      try {
        const stat = statSync(path)
        bytes = stat.isDirectory() ? dirSize(path) : stat.size
      } catch {
        bytes = 0
      }
      present.push({ rel, path, bytes })
    }
  }
  return present
}

function dirSize(path) {
  let total = 0
  let entries = []
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else {
      try {
        total += statSync(full).size
      } catch {
        /* ignore */
      }
    }
  }
  return total
}

/**
 * Move every durable-state artefact of the previous trial into the finished
 * trial's archive. Returns the manifest of what moved. Nothing is deleted and no
 * world directory is ever a candidate.
 */
export function quarantineDurableState(driverDir, archiveDir) {
  const moved = []
  const present = durableStatePresent(driverDir)
  if (present.length === 0) return { moved, pristine: true }
  mkdirSync(archiveDir, { recursive: true })
  for (const entry of present) {
    const target = join(archiveDir, entry.rel.replaceAll('/', '__'))
    let destination = target
    let suffix = 1
    while (existsSync(destination)) destination = `${target}.${suffix++}`
    try {
      renameSync(entry.path, destination)
      moved.push({ rel: entry.rel, from: entry.path, to: destination, bytes: entry.bytes })
    } catch (error) {
      moved.push({ rel: entry.rel, from: entry.path, to: null, bytes: entry.bytes, error: String(error?.code ?? error) })
    }
  }
  return { moved, pristine: durableStatePresent(driverDir).length === 0 }
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

/**
 * Stage one trial's fresh world. Consumes the stager's structured plan in
 * process (never its `--json` stdout, which embeds server.properties content and
 * therefore `rcon.password`) and archives the resolved descriptor + manifest
 * immediately, because the staged run directory name is a constant
 * (`m3-clean-run`) that the next trial overwrites.
 */
export function stageTrial(config, trial, { apply }) {
  const plan = planPrepare({
    descriptorPath: config.descriptorPath,
    serverRoot: config.serverRoot,
    sourceSha: config.frozenSha,
    root: null,
    seed: trial.levelSeed,
    levelName: trial.levelName,
    expectedMilestone: 'M2',
    apply: false,
    createServerRoot: config.createServerRoot,
    // M2 uses a per-trial staged config file. Never mutate the shared
    // server.properties, even if an old config object requests an overwrite.
    overwriteProperties: false,
  })
  const cleanProperties = (plan.files ?? []).find((file) => plan.runDir !== undefined && file.path === join(plan.runDir, 'server.properties.clean'))
  const staged = {
    status: plan.status,
    refusals: plan.refusals ?? [],
    warnings: plan.warnings ?? [],
    guards: plan.guards ?? [],
    check: plan.check ?? null,
    actions: (plan.actions ?? []).map((action) => ({ kind: action.kind, path: action.path, note: action.note })),
    container: plan.container ?? null,
    runDir: plan.runDir ?? null,
    worldDir: plan.worldDir ?? null,
    serverProperties: cleanProperties === undefined
      ? null
      : { path: cleanProperties.path, sha256: sha256Text(cleanProperties.content), bytes: Buffer.byteLength(cleanProperties.content, 'utf8') },
    descriptorPath: plan.loaded?.path ?? null,
    descriptorSha256: plan.loaded?.sha256 ?? null,
    applied: [],
    unchanged: [],
    archived: null,
  }
  if (plan.status !== 'REFUSED' && plan.resolved?.cleanRun?.milestone !== 'M2') {
    staged.status = 'REFUSED'
    staged.refusals = [{ reason: `m2_descriptor_required: expected an M2 environment descriptor, got ${String(plan.resolved?.cleanRun?.milestone)}` }]
    return staged
  }
  if (plan.status !== 'REFUSED' && cleanProperties === undefined) {
    staged.status = 'REFUSED'
    staged.refusals = [{ reason: 'm2_server_properties_missing: the trial must have a staged server.properties.clean file so both server and resident attest the same seed' }]
    return staged
  }
  if (plan.status === 'REFUSED') return staged
  if (!apply) return staged

  const applied = applyPlan(plan, { write: () => {} })
  staged.applied = (applied.applied ?? []).map((path) => basename(path))
  staged.unchanged = (applied.unchanged ?? []).map((path) => basename(path))
  staged.status = applied.status
  staged.manifest = applied.manifest ?? null
  staged.archived = archiveStagedDescriptor(plan.runDir, trial.dir)
  return staged
}

function archiveStagedDescriptor(runDir, trialDir) {
  if (runDir === null || runDir === undefined) return null
  const out = {}
  for (const name of ['environment-resolved.json', 'manifest.json', 'attempts.json', 'server-properties.diff.txt', 'operator-commands.txt']) {
    const source = join(runDir, name)
    if (!isFile(source)) continue
    const target = join(trialDir, name)
    writeFileSync(target, readFileSync(source))
    out[name] = { path: target, sha256: sha256File(target), bytes: fileSize(target) }
  }
  return out
}

/** The identity of one trial, recorded BEFORE anything is started. */
export function buildIdentity(config, trial, staged, extra = {}) {
  const resolvedPath = staged.archived?.['environment-resolved.json']?.path ?? null
  const descriptor = resolvedPath === null ? null : JSON.parse(readFileSync(resolvedPath, 'utf8'))
  const values = descriptor?.values ?? {}
  const gamerules = values.gamerules ?? {}
  const serverBlock = values.server ?? {}
  return {
    campaignId: config.campaignId,
    trialIndex: trial.index,
    attempt: trial.attempt,
    trialDir: trial.dir,
    evidenceClass: config.evidenceClass,
    levelName: trial.levelName,
    levelSeed: trial.levelSeed,
    sourceSha: config.frozenSha,
    frozenTree: config.frozenTree,
    driverDir: config.driverDir,
    serverRoot: config.serverRoot,
    worldDir: staged.worldDir ?? join(config.serverRoot, trial.levelName),
    levelDatPresentAtPrepare: staged.worldDir === null ? null : worldDataExists(staged.worldDir),
    descriptor: {
      templatePath: staged.descriptorPath,
      templateSha256: staged.descriptorSha256,
      resolvedPath,
      resolvedSha256: resolvedPath === null ? null : sha256FileText(resolvedPath),
      milestone: descriptor?.cleanRun?.milestone ?? null,
      cleanliness: staged.check?.status ?? null,
    },
    serverConfig: {
      serverId: values.serverId ?? null,
      difficulty: values.difficulty ?? null,
      levelType: values.levelType ?? serverBlock.levelType ?? null,
      mobSpawning: values.mobSpawning ?? null,
      spawnAnimals: values.spawnAnimals ?? null,
      gameruleCount: Object.keys(gamerules).length,
      gamerulesSha256: sha256Text(JSON.stringify(gamerules)),
      server: serverBlock,
      botUsername: config.botUsername,
      port: RESIDENT_PORT,
    },
    // The config path passed to the server and its hash are public metadata;
    // the file contents are deliberately excluded because they can contain the
    // server's RCON password.
    serverProperties: staged.serverProperties ?? null,
    dirtyTree: extra.dirtyTree ?? null,
    assists: descriptor?.assists ?? null,
    deadlineMs: config.deadlineMs,
    pollMs: config.pollMs,
    maxRestarts: config.maxRestarts,
    durableStateAtStart: extra.durableStateAtStart ?? null,
    frozenTreeHead: extra.frozenTreeHead ?? null,
    plannedServerArgv: extra.plannedServerArgv ?? null,
    plannedResidentArgv: extra.plannedResidentArgv ?? null,
    host: hostname(),
    harnessPid: process.pid,
    startedAt: nowIso(),
  }
}

// ---------------------------------------------------------------------------
// process control (only ever touches processes THIS campaign started)
// ---------------------------------------------------------------------------

export function spawnLogged(cmd, { cwd, env, logPath }) {
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a')
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdin: 'pipe',
    stdout: fd,
    stderr: fd,
  })
  closeSync(fd)
  return proc
}

/** Poll a log for the first match of `re`, with a bounded deadline. */
export async function waitForLog(logPath, re, { fromOffset = 0, deadlineAt, pollMs = 2000 }) {
  while (Date.now() < deadlineAt) {
    const text = readWindow(logPath, fromOffset, null)
    if (text.length > 0) {
      const match = re.exec(text)
      if (match !== null) {
        const line = text.split('\n').find((entry) => re.test(entry)) ?? match[0]
        return { ok: true, match: match[0], captures: match.slice(1), line: line.trim(), at: nowIso() }
      }
    }
    await sleep(pollMs)
  }
  return { ok: false, reason: 'deadline' }
}

/**
 * Stop a child this harness started. `graceful` first (a stdin command, then
 * SIGTERM), then SIGKILL; never a broad pattern kill; never a process that is
 * not this campaign's child.
 */
export async function stopChild(proc, { gracefulLine = null, gracefulMs = 20000, termMs = 15000 } = {}) {
  const outcome = { pid: proc.pid, gracefulLine, steps: [] }
  if (proc.exitCode !== null) {
    outcome.steps.push({ step: 'already-exited', exitCode: proc.exitCode })
    return outcome
  }
  if (gracefulLine !== null && proc.stdin !== null) {
    try {
      proc.stdin.write(`${gracefulLine}\n`)
      proc.stdin.flush()
      outcome.steps.push({ step: 'stdin', line: gracefulLine })
    } catch (error) {
      outcome.steps.push({ step: 'stdin-failed', error: String(error?.code ?? error) })
    }
  }
  const gracefulExit = await Promise.race([proc.exited.then((code) => ({ code })), sleep(gracefulMs).then(() => null)])
  if (gracefulExit !== null) {
    outcome.steps.push({ step: 'graceful-exit', exitCode: gracefulExit.code })
    outcome.exitCode = gracefulExit.code
    return outcome
  }
  try {
    process.kill(proc.pid, 'SIGTERM')
    outcome.steps.push({ step: 'sigterm' })
  } catch (error) {
    outcome.steps.push({ step: 'sigterm-failed', error: String(error?.code ?? error) })
  }
  const termExit = await Promise.race([proc.exited.then((code) => ({ code })), sleep(termMs).then(() => null)])
  if (termExit !== null) {
    outcome.steps.push({ step: 'sigterm-exit', exitCode: termExit.code })
    outcome.exitCode = termExit.code
    return outcome
  }
  try {
    process.kill(proc.pid, 'SIGKILL')
    outcome.steps.push({ step: 'sigkill' })
  } catch (error) {
    outcome.steps.push({ step: 'sigkill-failed', error: String(error?.code ?? error) })
  }
  const killExit = await Promise.race([proc.exited.then((code) => ({ code })), sleep(10000).then(() => null)])
  outcome.steps.push({ step: 'sigkill-exit', exitCode: killExit?.code ?? null })
  outcome.exitCode = killExit?.code ?? null
  return outcome
}

// ---------------------------------------------------------------------------
// watch: report only the trial's OWN evidence
// ---------------------------------------------------------------------------

/**
 * Incrementally scan the trial's byte window of a resident log, attributing
 * every line to the boot that owns it (the gate's own rule: a `BOOT ... runId=R`
 * line opens R; a line with a runId that is not the active one is foreign).
 */
export function createWindowScanner(fromOffset) {
  const state = {
    fromOffset,
    consumed: fromOffset,
    pending: '',
    lineIndex: 0,
    boots: [],
    runs: new Map(),
    foreignRunIds: new Set(),
    lastRung: null,
    chainCompleteRunId: null,
  }
  const runFor = (runId) => {
    if (!state.runs.has(runId)) {
      state.runs.set(runId, { runId, events: [], maxIndex: -1, rung: null, lines: 0 })
    }
    return state.runs.get(runId)
  }
  const ingest = (line, offset) => {
    if (line.trim() === '') return
    state.lineIndex += 1
    const isBoot = BOOT_RE.test(line)
    if (isBoot) {
      const runId = RUN_ID_RE.exec(line)?.[1] ?? null
      if (runId !== null) {
        state.boots.push({
          runId,
          offset,
          index: state.lineIndex,
          at: ISO_RE.exec(line)?.[1] ?? null,
          pid: BOOT_PID_RE.exec(line)?.[1] ?? null,
          source: BOOT_SOURCE_RE.exec(line)?.[1] ?? null,
          milestone: BOOT_MILESTONE_RE.exec(line)?.[1] ?? null,
          worldEpoch: BOOT_WORLD_EPOCH_RE.exec(line)?.[1] ?? null,
          line: line.trim(),
        })
        state.activeRunId = runId
        // A BOOT opens a run window even before any marker line arrives, so a
        // caller can ask for a boot's chain and get an empty (not missing) one.
        runFor(runId)
      }
      return
    }
    const ownRunId = RUN_ID_RE.exec(line)?.[1] ?? null
    const active = state.activeRunId ?? null
    if (ownRunId !== null && ownRunId !== active) {
      state.foreignRunIds.add(ownRunId)
      return
    }
    const rung = RUNG_RE.exec(line)?.[1] ?? null
    if (rung !== null) state.lastRung = { value: rung, offset, index: state.lineIndex, at: ISO_RE.exec(line)?.[1] ?? null, line: line.trim() }
    if (active === null) return
    const run = runFor(active)
    run.lines += 1
    if (rung !== null) run.rung = rung
    const portal = parsePortalMarker(line)
    if (portal !== null) run.events.push({ ...portal, offset, index: state.lineIndex, at: ISO_RE.exec(line)?.[1] ?? null, line: line.trim() })
    const inventory = parseInventoryMarker(line)
    if (inventory !== null) run.inventories = [...(run.inventories ?? []), { ...inventory, offset, index: state.lineIndex, line: line.trim() }]
  }
  return {
    state,
    /** Feed only the bytes that arrived since the last call. Returns bytes consumed. */
    pump(path) {
      const size = fileSize(path)
      if (size <= state.consumed) return 0
      const text = `${state.pending}${readWindow(path, state.consumed, size)}`
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline === -1) {
        state.pending = text
        state.consumed = size
        return 0
      }
      state.pending = text.slice(lastNewline + 1)
      let cursor = state.consumed
      for (const line of text.slice(0, lastNewline).split('\n')) {
        ingest(line, cursor)
        cursor += Buffer.byteLength(line, 'utf8') + 1
      }
      state.consumed = size
      return size
    },
    boots: () => state.boots,
    distinctRunIds: () => [...new Set(state.boots.map((boot) => boot.runId))],
    primaryRunId: () => state.boots[0]?.runId ?? null,
    lastRunId: () => state.boots.at(-1)?.runId ?? null,
    run: (runId) => state.runs.get(runId) ?? null,
    foreignRunIds: () => [...state.foreignRunIds],
    lastRung: () => state.lastRung,
    /** The shared gate's own chain evaluator, per runId. */
    chain(runId) {
      const run = state.runs.get(runId)
      if (run === undefined) return { link: portalChainLink({ name: 'none' }), complete: false }
      const chain = evaluatePortalChain(run.events)
      const link = portalChainLink({ name: 'window', chain, failure: null })
      return { link, complete: chain.frameVerified && chain.litVerified && dimensionIsOverworld(chain.litDimension) }
    },
  }
}

/** Final drain used only after the trial children have stopped writing. */
export function rescanFinalBootWindow(scanner, residentLogPath, expectedSource) {
  scanner.pump(residentLogPath)
  const boots = [...scanner.boots()]
  const runIds = [...new Set(boots.map((boot) => boot.runId))]
  const sourceMismatches = boots
    .filter((boot) => boot.source !== expectedSource)
    .map((boot) => ({ runId: boot.runId, source: boot.source, line: boot.line }))
  return { boots, runIds, split: runIds.length > 1, sourceMismatches }
}

function recordFinalBootWindow(row, scanner, residentLogPath, expectedSource) {
  const final = rescanFinalBootWindow(scanner, residentLogPath, expectedSource)
  row.run ??= {}
  row.run.boots = final.boots
  row.run.distinctRunIds = final.runIds
  row.run.foreignRunIds = scanner.foreignRunIds()
  row.run.bootSourceProblems = final.sourceMismatches
  row.run.finalBootRescannedAfterShutdown = true
  row.run.lastObservedRung = scanner.lastRung()
  return final
}

/** Minecraft dimension ids compare case-insensitively with an optional namespace. */
export function dimensionIsOverworld(dimension) {
  if (typeof dimension !== 'string') return false
  return dimension.trim().toLowerCase().replace(/^minecraft:/, '') === 'overworld'
}

/**
 * Every BOOT line in a log, with its absolute byte offset, read in chunks so a
 * multi-GB shared resident log never has to fit in memory. Read-only.
 */
export function scanLogBoots(logPath, { chunk = 1 << 22 } = {}) {
  const boots = []
  if (!isFile(logPath)) return boots
  const size = fileSize(logPath)
  const fd = openSync(logPath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(chunk)
    let offset = 0
    let pending = ''
    let pendingOffset = 0
    while (offset < size) {
      const read = readSync(fd, buffer, 0, Math.min(chunk, size - offset), offset)
      if (read <= 0) break
      const text = pending + buffer.subarray(0, read).toString('utf8')
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline !== -1) {
        let cursor = pendingOffset
        for (const line of text.slice(0, lastNewline).split('\n')) {
          if (BOOT_RE.test(line)) {
            const runId = RUN_ID_RE.exec(line)?.[1] ?? null
            if (runId !== null) {
              boots.push({
                runId,
                offset: cursor,
                at: ISO_RE.exec(line)?.[1] ?? null,
                pid: BOOT_PID_RE.exec(line)?.[1] ?? null,
                source: BOOT_SOURCE_RE.exec(line)?.[1] ?? null,
                milestone: BOOT_MILESTONE_RE.exec(line)?.[1] ?? null,
                line: line.trim(),
              })
            }
          }
          cursor += Buffer.byteLength(line, 'utf8') + 1
        }
        pending = text.slice(lastNewline + 1)
        pendingOffset = cursor
      } else {
        pending = text
      }
      offset += read
    }
    return boots
  } finally {
    closeSync(fd)
  }
}

/**
 * READ-ONLY observation of a run that this harness did not start. It never
 * signals, stages, spawns or locks anything: it slices the run's own byte window
 * out of the shared resident log, copies its run-scoped snapshot, asks the
 * canonical gate, and records an `observation` row that can never enter the rate.
 */
async function observeRun(config, args, log) {
  const tree = resolve(args.observeRoot ?? config.driverDir)
  const driverDir = tree.endsWith('buddy-driver') ? tree : join(tree, 'buddy-driver')
  const logPath = join(driverDir, 'buddy.log')
  const runId = args.run
  const boots = scanLogBoots(logPath)
  const mine = boots.filter((boot) => boot.runId === runId)
  const outDir = join(config.trialsDir, `observe-${runId}`)
  mkdirSync(outDir, { recursive: true })
  const evidenceDir = join(outDir, 'evidence')
  mkdirSync(evidenceDir, { recursive: true })
  if (mine.length === 0) {
    process.stderr.write(
      `M2_REPRO_OBSERVE status=UNKNOWN reason=run_not_found runId=${runId} log=${logPath} ` +
        `boots=${boots.length} (the log holds no BOOT line for that runId)\n`,
    )
    return 2
  }
  const from = mine[0].offset
  const text = readWindow(logPath, from, null)
  const windowPath = join(evidenceDir, 'resident-window.log')
  writeFileSync(windowPath, text, 'utf8')
  const distinctAfter = [...new Set(boots.filter((boot) => boot.offset >= from).map((boot) => boot.runId))]
  const split = distinctAfter.length > 1
  const observationScanner = createWindowScanner(0)
  observationScanner.pump(windowPath)
  const observedRun = observationScanner.run(runId)
  const gate = await gateTrial({
    runId,
    evidenceDir,
    driverRoot: tree.endsWith('buddy-driver') ? dirname(tree) : tree,
    runnerOutPath: join(driverDir, 'runner.out'),
    // Deliberately NOT the live control socket: an observation reads files only.
    controlSocketPath: join(evidenceDir, 'no-such-socket'),
    write: () => {},
  })
  const row = {
    record: TRIAL_RECORD,
    schemaVersion: SCHEMA_VERSION,
    campaignId: config.campaignId,
    evidenceClass: 'observation',
    trialIndex: null,
    attempt: 1,
    trialDir: outDir,
    attemptDir: outDir,
    status: split ? 'SPLIT' : gate.status === 'PASS' ? 'PASS' : gate.status === 'FAIL' ? 'FAIL' : 'TIMEOUT',
    terminal: true,
    countable: false,
    failureKind: split ? 'split_boots' : gate.status === 'PASS' ? null : 'observed_unfinished',
    firstUnmetGateStage: firstUnmetGateStage(gate.conditions),
    firstMissingLink: firstUnmetGateStage(gate.conditions),
    causalBlocker: causalBlockerFromRun(runId, observedRun?.events),
    chain: { line: gate.chainLine ?? null, links: gate.chain ?? [], firstMissingChainLink: firstMissingChainLink(gate.chain) },
    gate: { status: gate.status, code: gate.code, reason: gate.reason, conditions: gate.conditions, missing: gate.missing, chainLine: gate.chainLine },
    run: { runId, boots: mine, distinctRunIds: distinctAfter },
    evidence: { residentWindow: { path: windowPath, bytes: fileSize(windowPath), sha256: sha256File(windowPath), fromOffset: from } },
    observationOnly: {
      note: 'READ-ONLY observation of a run this harness did not start: never counted in any rate',
      tree,
      driverDir,
      logPath,
      logBytes: fileSize(logPath),
      bootsForRun: mine.length,
      splitAcrossBoots: split,
      distinctRunIdsAfterFirstBootOfRun: distinctAfter,
    },
    finishedAt: nowIso(),
  }
  writeJsonAtomic(join(outDir, 'observation.json'), row)
  appendJsonl(join(config.trialsDir, LEDGER_NAME), row)
  log(
    `OBSERVE runId=${runId} status=${row.status} gate=${gate.status}(${gate.reason}) first-unmet-stage=${String(row.firstUnmetGateStage ?? '-')} causal-blocker=${String(row.causalBlocker.value ?? 'UNKNOWN')} ` +
      `boots=${mine.length} split=${split} window=${fileSize(windowPath)}B`,
  )
  if (gate.chainLine !== null) log(`OBSERVE chain ${gate.chainLine}`)
  return gate.status === 'PASS' ? 0 : 1
}

// ---------------------------------------------------------------------------
// the canonical verdict, in process
// ---------------------------------------------------------------------------

/**
 * Ask the REAL M2 gate for its verdict over this trial's own evidence. Explicit
 * paths + `discover:false` so the verdict can never be satisfied by another
 * run's files.
 */
export async function gateTrial({ runId, evidenceDir, driverRoot, runnerOutPath = null, controlSocketPath = null, write = () => {} }) {
  const paths = residentPaths(driverRoot)
  const logPath = join(evidenceDir, 'resident-window.log')
  const result = { runId, status: 'UNKNOWN', code: 2, reason: 'gate_not_run', conditions: null, facts: null, lines: [] }
  if (runId === null || !/^run-[A-Za-z0-9-]+$/.test(runId)) {
    result.reason = 'no_run_scoped_evidence'
    return result
  }
  const code = await runM2Gate({
    expectedRunId: runId,
    logPath,
    snapshotDir: evidenceDir,
    decisionsPath: paths.decisionsPath,
    runnerOutPath: runnerOutPath ?? join(evidenceDir, 'runner.out'),
    root: driverRoot,
    discover: false,
    controlSocketPath: controlSocketPath ?? paths.controlSocketPath,
    policySocket: null,
    json: false,
    write: (line) => {
      result.lines.push(line)
      write(line)
    },
    onResult: (verdict) => {
      result.status = verdict.status
      result.code = verdict.code
      result.reason = verdict.reason
      result.conditions = verdict.conditions
      result.facts = verdict.facts ?? null
    },
  })
  result.exitCode = code
  result.chainLines = result.lines.filter((line) => line.startsWith('m2_chain:'))
  result.chain = (result.facts?.chain ?? []).map((link) => link)
  result.chainLine = result.chainLines[0] ?? null
  result.missing = result.facts?.missing ?? [...M2_REQUIRED_STAGES]
  return result
}

/** The first contract stage not proved PASS; this is a gate stage, never a cause. */
export function firstUnmetGateStage(conditions) {
  if (conditions === null || conditions === undefined) return M2_REQUIRED_STAGES[0]
  for (const stage of M2_REQUIRED_STAGES) {
    if (conditions[stage] !== 'PASS') return stage
  }
  return null
}

/** Compatibility name retained for existing ledger readers. */
export function firstMissingLink(conditions) {
  return firstUnmetGateStage(conditions)
}

/** A cause is named only when this run's own log contains a recognized failure event. */
export function causalBlockerFromRun(runId, events) {
  const codeFor = (event) => {
    if (event?.name === 'PORTAL_FRAME_READY' && event.shape !== 'ok') return 'portal_frame_shape_bad'
    if (event?.name === 'PORTAL_LIGHT_REFUSED') return 'portal_light_refused'
    if (event?.name === 'PORTAL_VERIFIED' && event.verified === false) return 'portal_verify_false'
    return null
  }
  const observed = (Array.isArray(events) ? events : [])
    .map((event, order) => ({ event, order, code: codeFor(event) }))
    .filter((entry) => entry.code !== null)
    .sort((a, b) => (a.event.index ?? a.order) - (b.event.index ?? b.order))[0]
  if (runId === null || runId === undefined || observed === undefined) {
    return {
      status: 'UNKNOWN',
      value: null,
      runId: null,
      evidenceLine: null,
      reason: 'no run-scoped recognized failure event supports a causal blocker',
    }
  }
  return {
    status: 'OBSERVED',
    value: observed.code,
    runId,
    event: observed.event.name,
    evidenceLine: observed.event.line ?? null,
  }
}

/**
 * The first chain rung (built -> lit -> verified) that no evidence source could
 * prove, using the SAME union rule the gate applies to its stage conditions:
 * one source carrying the link is enough, and `lit` additionally needs the
 * overworld (a lit frame in the Nether is a different fact).
 */
export function firstMissingChainLink(links) {
  const list = Array.isArray(links) ? links : []
  const anyPass = (name, predicate = (value) => value === 'PASS') =>
    list.some((link) => predicate(link?.[name], link))
  const anyFail = (name) => list.some((link) => link?.[name] === 'FAIL')
  const stateOf = (name) => (anyFail(name) ? 'FAIL' : 'UNKNOWN')
  if (!anyPass('built')) return { link: 'built', state: stateOf('built') }
  if (!anyPass('lit', (value, link) => value === 'PASS' && link?.overworld === true)) {
    return { link: 'lit', state: stateOf('lit') }
  }
  if (!anyPass('verified')) return { link: 'verified', state: stateOf('verified') }
  return null
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/** Pure: reduce ledger rows into the rate, the bottleneck histogram and the table. */
export function summarize(campaignId, rows) {
  const terminal = rows.filter((row) => row.record === TRIAL_RECORD && row.terminal === true)
  const live = terminal.filter((row) => row.evidenceClass === 'live')
  const rehearsal = terminal.filter((row) => row.evidenceClass === 'rehearsal')
  const count = (list, status) => list.filter((row) => row.status === status).length
  const countable = live.filter((row) => COUNTABLE_STATUSES.includes(row.status))
  const passes = countable.filter((row) => row.status === 'PASS')
  const bottleneck = {}
  for (const row of countable) {
    const key = row.status === 'PASS' ? 'cleared' : String(row.firstUnmetGateStage ?? row.firstMissingLink ?? 'unknown')
    bottleneck[key] = (bottleneck[key] ?? 0) + 1
  }
  const failureKinds = {}
  for (const row of live.filter((entry) => entry.status === 'FAIL' || entry.status === 'TIMEOUT')) {
    const key = String(row.failureKind ?? 'unspecified')
    failureKinds[key] = (failureKinds[key] ?? 0) + 1
  }
  const stale = rows
    .filter((row) => row.record === TRIAL_RECORD && row.terminal !== true)
    .map((row) => ({ trialIndex: row.trialIndex, attempt: row.attempt, at: row.at ?? null }))
  return {
    record: 'm2-repro-summary',
    schemaVersion: SCHEMA_VERSION,
    campaignId,
    generatedAt: nowIso(),
    metric: 'M2 (build -> light -> verify) cleared per FRESH WORLD, run-scoped to one boot',
    bottleneckBasis: 'firstUnmetGateStage is the first M2 gate stage not proved PASS; it is not a causal blocker. causalBlocker is OBSERVED only when that runId has a recognized failure event; otherwise UNKNOWN.',
    trials: {
      planned: plannedTrialCount(rows),
      terminal: terminal.length,
      live: live.length,
      rehearsal: rehearsal.length,
      countable: countable.length,
      nonTerminalRecords: stale.length,
    },
    rate: {
      successes: passes.length,
      countable: countable.length,
      value: countable.length === 0 ? null : Number((passes.length / countable.length).toFixed(4)),
      formula: 'PASS / (PASS + FAIL + TIMEOUT) over evidenceClass=live rows',
    },
    statusCounts: Object.fromEntries(TRIAL_STATUSES.map((status) => [status, count(live, status)])),
    uncountable: Object.fromEntries(
      Object.keys(UNCOUNTABLE_REASONS).map((status) => [
        status,
        { count: count(live, status), reason: UNCOUNTABLE_REASONS[status] },
      ]),
    ),
    bottleneck,
    failureKinds,
    rows: live
      .slice()
      .sort((a, b) => a.trialIndex - b.trialIndex || a.attempt - b.attempt)
      .map((row) => ({
        trialIndex: row.trialIndex,
        attempt: row.attempt,
        status: row.status,
        countable: row.countable === true,
        firstUnmetGateStage: row.firstUnmetGateStage ?? row.firstMissingLink ?? null,
        causalBlocker: row.causalBlocker ?? causalBlockerFromRun(null, []),
        // Compatibility alias. Its value names a gate stage, not a cause.
        firstMissingLink: row.firstMissingLink ?? null,
        firstMissingChainLink: row.firstMissingChainLink ?? null,
        lastObservedRung: row.lastObservedRung?.value ?? null,
        runId: row.run?.runId ?? null,
        bootCount: row.run?.boots?.length ?? 0,
        levelName: row.identity?.levelName ?? null,
        levelSeed: row.identity?.levelSeed ?? null,
        wallMs: row.timing?.wallMs ?? null,
        gateReason: row.gate?.reason ?? null,
        failureKind: row.failureKind ?? null,
      })),
    rehearsalRows: rehearsal.map((row) => ({
      trialIndex: row.trialIndex,
      status: row.status,
      firstUnmetGateStage: row.firstUnmetGateStage ?? row.firstMissingLink ?? null,
      causalBlocker: row.causalBlocker ?? causalBlockerFromRun(null, []),
      firstMissingLink: row.firstMissingLink ?? null,
      runId: row.run?.runId ?? null,
      bootCount: row.run?.boots?.length ?? 0,
    })),
  }
}

function humanDuration(ms) {
  if (!Number.isFinite(ms)) return '-'
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, '0')}m`
}

export function formatReport(summary) {
  const lines = []
  lines.push(`# M2 REPRODUCIBILITY — ${summary.campaignId}`)
  lines.push('')
  lines.push(`metric: ${summary.metric}`)
  lines.push(`generated: ${summary.generatedAt}`)
  lines.push('')
  lines.push(`## RATE (evidenceClass=live only)`)
  lines.push('')
  const rate = summary.rate
  lines.push(`  successes / countable = ${rate.successes} / ${rate.countable} = ${rate.value === null ? 'UNDEFINED (no countable trial)' : rate.value.toFixed(4)}`)
  lines.push(`  formula: ${rate.formula}`)
  lines.push('')
  lines.push(`## counts`)
  lines.push('')
  lines.push(`  PASS ${summary.statusCounts.PASS}   FAIL ${summary.statusCounts.FAIL}   TIMEOUT ${summary.statusCounts.TIMEOUT}   (countable)`)
  lines.push(
    `  SPLIT ${summary.uncountable.SPLIT.count}   INFRA ${summary.uncountable.INFRA.count}   ` +
      `STAGED_ONLY ${summary.uncountable.STAGED_ONLY.count}   (recorded, NOT in the denominator)`,
  )
  lines.push(`  SPLIT reason: ${summary.uncountable.SPLIT.reason}`)
  lines.push(`  INFRA reason: ${summary.uncountable.INFRA.reason}`)
  lines.push('')
  lines.push(`## REPRODUCIBILITY BOTTLENECK (first unmet M2 gate stage over countable trials)`)
  lines.push('')
  lines.push('  firstUnmetGateStage is a stage label, not a causal blocker; causalBlocker is UNKNOWN without a run-scoped recognized failure event.')
  lines.push('')
  const bottleneck = Object.entries(summary.bottleneck).sort((a, b) => b[1] - a[1])
  if (bottleneck.length === 0) lines.push('  (no countable trial yet)')
  for (const [key, value] of bottleneck) lines.push(`  ${key.padEnd(24)} ${value}`)
  lines.push('')
  const kinds = Object.entries(summary.failureKinds).sort((a, b) => b[1] - a[1])
  if (kinds.length > 0) {
    lines.push(`## non-PASS outcome kinds (countable trials)`)
    lines.push('')
    for (const [key, value] of kinds) lines.push(`  ${key.padEnd(24)} ${value}`)
    lines.push('')
  }
  lines.push(`## per-trial rows`)
  lines.push('')
  lines.push('  idx  status    kind         first-unmet-stage      causal-blocker           last-rung            boots  wall   runId')
  for (const row of summary.rows) {
    lines.push(
      `  ${String(row.trialIndex).padStart(3, '0')}  ${String(row.status).padEnd(9)} ${String(row.failureKind ?? '-').padEnd(12)} ` +
        `${String(row.firstUnmetGateStage ?? row.firstMissingLink ?? '-').padEnd(20)} ${String(row.causalBlocker?.value ?? 'UNKNOWN').padEnd(24)} ` +
        `${String(row.lastObservedRung ?? '-').padEnd(20)} ` +
        `${String(row.bootCount).padStart(5)}  ${humanDuration(row.wallMs).padStart(5)}  ${row.runId ?? '-'}`,
    )
  }
  if (summary.rehearsalRows.length > 0) {
    lines.push('')
    lines.push(`## rehearsal rows (evidenceClass=rehearsal, NEVER counted)`)
    lines.push('')
    for (const row of summary.rehearsalRows) {
      lines.push(`  ${String(row.trialIndex).padStart(3, '0')}  ${row.status.padEnd(9)} first-unmet-stage=${String(row.firstUnmetGateStage ?? row.firstMissingLink ?? '-')} causal-blocker=${String(row.causalBlocker?.value ?? 'UNKNOWN')} boots=${row.bootCount} runId=${row.runId ?? '-'}`)
    }
  }
  lines.push('')
  lines.push(`## what this rate does NOT say`)
  lines.push('')
  lines.push('  - SPLIT and INFRA trials are excluded from the denominator, not counted as failures.')
  lines.push('  - a rehearsal row proves the harness, never the agent: it is excluded from the rate entirely.')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = {
    campaign: null,
    trials: 100,
    deadlineMs: 4 * 60 * 60 * 1000,
    settleMs: 90 * 1000,
    pollMs: 30000,
    bootTimeoutMs: 300000,
    serverReadyMs: 900000,
    frozenSha: null,
    frozenTree: null,
    createFrozenTree: false,
    driverDir: null,
    serverRoot: LIVE_CONTAINER,
    descriptorPath: join(REPO_ROOT, 'tools', 'fixtures', 'm2-repro-environment.json'),
    trialsDir: null,
    seedBase: null,
    seedList: null,
    levelPrefix: 'm2rep',
    botUsername: 'AI_Buddy',
    maxRestarts: 0,
    minFreeBytes: 8 * 1024 ** 3,
    apply: false,
    live: false,
    rehearse: false,
    rehearseOutcome: 'pass',
    overwriteProperties: false,
    createServerRoot: false,
    status: false,
    report: false,
    observe: false,
    run: null,
    observeRoot: null,
    json: false,
    help: false,
    evidenceClass: null,
    gateOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i] ?? null
    const num = (name) => {
      const value = Number.parseInt(next() ?? '', 10)
      if (!Number.isFinite(value)) throw new Error(`invalid ${name}: expected an integer`)
      return value
    }
    if (arg === '--campaign') out.campaign = next()
    else if (arg === '--trials') out.trials = num(arg)
    else if (arg === '--deadline-ms') out.deadlineMs = num(arg)
    else if (arg === '--settle-ms') out.settleMs = num(arg)
    else if (arg === '--poll-ms') out.pollMs = num(arg)
    else if (arg === '--boot-timeout-ms') out.bootTimeoutMs = num(arg)
    else if (arg === '--server-ready-ms') out.serverReadyMs = num(arg)
    else if (arg === '--frozen-sha') out.frozenSha = next()
    else if (arg === '--frozen-tree') out.frozenTree = next()
    else if (arg === '--create-frozen-tree') out.createFrozenTree = true
    else if (arg === '--driver-dir') out.driverDir = next()
    else if (arg === '--server-root') out.serverRoot = next()
    else if (arg === '--environment') out.descriptorPath = next()
    else if (arg === '--trials-dir') out.trialsDir = next()
    else if (arg === '--seed-base') out.seedBase = next()
    else if (arg === '--seed-list') out.seedList = next()
    else if (arg === '--level-prefix') out.levelPrefix = next()
    else if (arg === '--bot-username') out.botUsername = next()
    else if (arg === '--max-restarts') out.maxRestarts = num(arg)
    else if (arg === '--min-free-bytes') out.minFreeBytes = num(arg)
    else if (arg === '--apply') out.apply = true
    else if (arg === '--live') out.live = true
    else if (arg === '--rehearse') out.rehearse = true
    else if (arg === '--rehearse-outcome') out.rehearseOutcome = next()
    else if (arg === '--no-overwrite-properties') out.overwriteProperties = false
    else if (arg === '--create-server-root') out.createServerRoot = true
    else if (arg === '--evidence-class') out.evidenceClass = next()
    else if (arg === '--observe') out.observe = true
    else if (arg === '--run') out.run = next()
    else if (arg === '--observe-root') out.observeRoot = next()
    else if (arg === '--status') out.status = true
    else if (arg === '--report') out.report = true
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

export function usage() {
  return `m2-reproducibility — measure the M2 rate over N fresh worlds

Usage:
  bun tools/m2-reproducibility.mjs --campaign <id> --trials <N> --frozen-sha <40hex> --apply --live
  bun tools/m2-reproducibility.mjs --campaign <id> --rehearse [--rehearse-outcome pass|fail|timeout|split]
  bun tools/m2-reproducibility.mjs --report --campaign <id> [--json]
  bun tools/m2-reproducibility.mjs --status --campaign <id>

Campaign:
  --campaign <id>          campaign id (required for anything but --help)
  --trials N               number of trials (default 100)
  --frozen-sha <40hex>     the commit the run must boot (required for --live)
  --frozen-tree <path>     checkout at --frozen-sha (created with --create-frozen-tree)
  --create-frozen-tree     create the frozen tree with 'git worktree add --detach'
  --driver-dir <path>      driver directory (default <frozen-tree>/buddy-driver)

World staging:
  --environment <path>     M2 clean-run descriptor template (default tools/fixtures/m2-repro-environment.json)
  --server-root <path>     server container (default ${LIVE_CONTAINER}; the ONLY valid value for --live)
  --level-prefix <p>       level-name prefix (default m2rep)
  --seed-base <s>          seed derivation base (default the campaign id)
  --seed-list <file>       explicit one-seed-per-line list (trial i takes line i)
  --create-server-root     allow creating a missing container (rehearsal only)
  --no-overwrite-properties  accepted for compatibility; M2 always keeps the shared server.properties unchanged

Timing:
  --deadline-ms N          per-trial M2 deadline (default ${4 * 60 * 60 * 1000} = 4h)
  --poll-ms N              evidence poll interval (default 30000)
  --settle-ms N            grace after the chain looks complete but the gate is not PASS (default 90000)
  --boot-timeout-ms N      resident BOOT deadline after the server is ready (default 300000)
  --server-ready-ms N      server 'Done' deadline (default 900000)
  --max-restarts N         supervisor restarts allowed INSIDE one trial (default 0; see the header)
  --min-free-bytes N       refuse below this free space (default 8 GiB)

Modes:
  --observe                READ-ONLY: judge a run this harness did not start (no lock, no spawn, no signal)
  --run <runId>            the run to observe (required with --observe)
  --observe-root <tree>    the resident tree that owns the run (default <frozen-tree>)
  --apply                  perform the staging writes (without it: plan + identity only)
  --live                   actually spawn the server + resident (a live campaign needs it)
  --rehearse               scratch container + stub server/resident, synthetic evidence, evidenceClass=rehearsal
  --rehearse-outcome <o>   pass | fail | timeout | split | tail-boot | wrong-source (default pass)
  --report                 print the rate + bottleneck table from the ledger (no execution)
  --status                 print the ledger's non-terminal records (read-only)
  --json                   machine-readable summary on stdout
  --help

Environment:
  M2_REPRO_LOCK            override the machine-global campaign lock path

Exit codes: 0 ok, 1 refused / rate 0, 2 usage error.`
}

// ---------------------------------------------------------------------------
// campaign driver
// ---------------------------------------------------------------------------

function stubServerSource() {
  return `#!/usr/bin/env bun
// generated by tools/m2-reproducibility.mjs --rehearse: a stand-in for the Leaf
// server. It speaks the same readiness lines the real server prints, creates a
// level.dat so freshness can be observed, binds a TCP port so teardown is real,
// and stops on the 'stop' stdin command.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const logPath = arg('--log')
const worldDir = arg('--world')
const levelName = arg('--level-name')
const seed = arg('--seed')
const port = Number.parseInt(arg('--port', '0'), 10)
const driverLog = arg('--driver-log')
const tailBoot = arg('--tail-boot', 'false') === 'true'
const tailBootSource = arg('--tail-boot-source', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
const line = (text) => appendFileSync(logPath, \`[\${new Date().toISOString().slice(11, 19)} INFO]: \${text}\\n\`)
const server = createServer((socket) => socket.end())
await new Promise((done) => server.listen(port, '127.0.0.1', done))
line('No existing world data, creating new world')
mkdirSync(worldDir, { recursive: true })
writeFileSync(\`\${worldDir}/level.dat\`, 'stub-level-dat\\n')
line(\`Preparing level "\${levelName}"\`)
line(\`Seed: [\${seed}]\`)
line(\`Done (1.234s)! For help, type "help"\`)
const stop = () => {
  line('Stopping the server')
  if (tailBoot && driverLog !== null) {
    appendFileSync(driverLog, '[' + new Date().toISOString() + '] BOOT pid=' + process.pid + ' runId=run-tailboot-stub source=' + tailBootSource + ' runtime=bun runtimeVersion=1.4.2 bundle=none milestone=stone generations=1 reloads=0 contractVersion=3 schemaVersion=3 revision=1 worldEpoch=2 worldKey={"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":2} frozen=false\\n')
  }
  server.close()
  process.exit(0)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk.includes('stop')) stop()
})
process.stdin.on('end', stop)
setInterval(() => {}, 1 << 30)
`
}

function stubResidentSource() {
  return `#!/usr/bin/env bun
// generated by tools/m2-reproducibility.mjs --rehearse: a stand-in for the
// resident host. It renders the SAME line shapes the real host renders
// (BOOT ... runId=..., HEARTBEAT ... rung=..., the portal chain, GENERATION_READY,
// SYSTEM2_AUTHORITY_DECISION), writes a run-scoped m2-snapshot, and then stays
// alive so teardown has something to stop. Every line goes to BOTH the resident
// log and stdout, exactly as buddy-driver/agent-runner.mts log() does.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const outcome = process.env.M2_REPRO_STUB_OUTCOME ?? 'pass'
const driverDir = process.env.M2_REPRO_STUB_DRIVER_DIR
const source = process.env.M2_REPRO_STUB_SOURCE ?? 'deadbeef'
const stamp = (offset) => new Date(Date.now() + offset * 1000).toISOString()
const logPath = join(driverDir, 'buddy.log')
const snapshotDir = join(driverDir, 'data', 'resident')
const decisionsPath = join(driverDir, 'logs', 'jev', 'decisions.jsonl')
mkdirSync(snapshotDir, { recursive: true })
mkdirSync(join(driverDir, 'logs', 'jev'), { recursive: true })
const emit = (line) => {
  appendFileSync(logPath, line + '\\n')
  process.stdout.write(line + '\\n')
}
const boot = (id, offset) =>
  \`[\${stamp(offset)}] BOOT pid=\${process.pid} runId=\${id} source=\${source} runtime=bun runtimeVersion=1.4.2 bundle=none milestone=stone generations=1 reloads=0 contractVersion=3 schemaVersion=3 revision=1 worldEpoch=1 worldKey={"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":1} frozen=false\`
const heartbeat = (rung, items, offset) =>
  \`[\${stamp(offset)}] HEARTBEAT pos=10,64,20 health=20 running=true rung=\${rung} inv=\${JSON.stringify(items)}\`
const inventory = (items, offset) => \`[\${stamp(offset)}] INVENTORY items=\${JSON.stringify(items)} pos=10,64,20\`
const ready = (offset, id) =>
  \`[\${stamp(offset)}] GENERATION_READY id=gen-\${id} generationId=gen-\${id} sourceSha=\${source} buildHash=eeeeeeeeeeee system2ConfiguredProvider=typesafe-ai system2ConfiguredModel=typesafe-ai/jev generation=1 policy=typesafe model=typesafe-ai/jev planner=llm deterministicFallbackEnabled=false\`
const authorityInput = (offset, id) =>
  \`[\${stamp(offset)}] SYSTEM2_AUTHORITY_INPUT generationId=gen-\${id} sourceSha=\${source} buildHash=eeeeeeeeeeee configuredProvider=typesafe-ai configuredModel=typesafe-ai/jev trigger=queue_empty provider=typesafe-ai model=typesafe-ai/jev\`
const authority = (offset, id) =>
  \`[\${stamp(offset)}] SYSTEM2_AUTHORITY_DECISION generationId=gen-\${id} sourceSha=\${source} buildHash=eeeeeeeeeeee configuredProvider=typesafe-ai configuredModel=typesafe-ai/jev trigger=queue_empty provider=typesafe-ai model=typesafe-ai/jev chosen=front_nether_portal goals=[front_nether_portal]\`
const first = 'run-m2repstub-a'
const second = 'run-m2repstub-b'
const inventoryLines = [
  inventory({ diamond: 3, diamond_pickaxe: 1 }, 1),
  inventory({ flint_and_steel: 1, obsidian: 10 }, 2),
]
const chainLines = [
  \`[\${stamp(3)}] PORTAL_BLOCK_PLACED pos=10,64,20\`,
  \`[\${stamp(4)}] PORTAL_FRAME_READY blocks=10 shape=ok\`,
  \`[\${stamp(5)}] PORTAL_LIT pos=11,65,21 dimension=minecraft:overworld\`,
  \`[\${stamp(6)}] PORTAL_VERIFIED=true\`,
]
const failLines = [
  \`[\${stamp(3)}] PORTAL_BLOCK_PLACED pos=10,64,20\`,
  \`[\${stamp(4)}] PORTAL_FRAME_READY blocks=7 shape=bad\`,
]
const partialLines = [\`[\${stamp(3)}] PORTAL_BLOCK_PLACED pos=10,64,20\`]
const markerFields = (entry) => {
  const fields = { line: entry.replace(/^\\[[^\\]]+\\]\\s*/, '') }
  const blocks = /blocks=(\\d+)/.exec(entry)
  if (blocks !== null) fields.blocks = Number(blocks[1])
  const shape = /shape=(\\w+)/.exec(entry)
  if (shape !== null) fields.shape = shape[1]
  if (/PORTAL_VERIFIED=true/.test(entry)) fields.verified = true
  const dimension = /dimension=(\\S+)/.exec(entry)
  if (dimension !== null) fields.dimension = dimension[1]
  return fields
}
const markerName = (entry) => /^\\[[^\\]]+\\]\\s*(\\S+)/.exec(entry)?.[1] ?? 'UNKNOWN'
const writeSnapshot = (id, markerLines, offset) => {
  const snapshot = {
    schemaVersion: 2,
    record: 'm2-snapshot',
    runId: id,
    generationId: 'gen-stub-1',
    bootSourceSha: source,
    buildHash: 'stubbuild',
    worldEpoch: 1,
    worldKey: '127.0.0.1:25565|minecraft:overworld|1',
    atMs: Date.now() + offset * 1000,
    at: stamp(offset),
    initialInventory: {},
    markers: markerLines.map((entry) => ({ name: markerName(entry), atMs: Date.now(), at: stamp(offset), inventory: {}, ...markerFields(entry) })),
    sequence: [],
    chain: { status: 'INCOMPLETE', required: ['PORTAL_BLOCK_PLACED', 'PORTAL_FRAME_READY', 'PORTAL_LIT', 'PORTAL_VERIFIED'], observed: [] },
    legacyChain: { status: 'INCOMPLETE', required: ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'], observed: [] },
    inventory: {},
    terminal: null,
  }
  writeFileSync(join(snapshotDir, \`m2-snapshot-\${id}.json\`), JSON.stringify(snapshot, null, 2))
}
const writeDecisions = (id, count) => {
  const lines = []
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      record: 'decision', ts: stamp(3 + i), runId: id,
      generationId: \`gen-\${id}\`, sourceSha: source,
      source: 'jev', kind: 'place', reason: \`rehearsal:model_authored_jev_decision_\${i}\`,
    }))
  }
  writeFileSync(decisionsPath, lines.join('\\n') + '\\n')
}
const openRun = (id, offset) => {
  emit(boot(id, offset))
  emit(ready(offset + 0.1, id))
  emit(authorityInput(offset + 0.15, id))
  emit(authority(offset + 0.2, id))
}
openRun(first, 0)
emit(heartbeat('stone_pickaxe', {}, 0.5))
if (outcome === 'split') {
  for (const line of [...inventoryLines, ...partialLines]) emit(line)
  emit(heartbeat('nether_portal', { diamond: 3 }, 7))
  writeSnapshot(first, partialLines, 3)
  writeDecisions(first, 2)
  emit(\`[\${stamp(7.5)}] HOST_LOCK released pid=\${process.pid} runId=\${first}\`)
  await new Promise((done) => setTimeout(done, 4000))
  openRun(second, 8)
  emit(heartbeat('nether_portal', { diamond: 3 }, 8.5))
  for (const line of [...inventoryLines, ...chainLines]) emit(line)
  emit(heartbeat('nether_portal', { obsidian: 10 }, 9))
  writeSnapshot(second, chainLines, 3)
  writeDecisions(second, 2)
  emit(\`[\${stamp(30)}] HOST_LOCK released pid=\${process.pid} runId=\${second}\`)
} else {
  for (const line of inventoryLines) emit(line)
  if (outcome === 'timeout') {
    for (const line of partialLines) emit(line)
    emit(heartbeat('diamond_pickaxe', { diamond: 3, diamond_pickaxe: 1 }, 7))
    writeSnapshot(first, partialLines, 3)
    writeDecisions(first, 2)
  } else if (outcome === 'fail') {
    for (const line of failLines) emit(line)
    emit(heartbeat('nether_portal', { diamond: 3 }, 7))
    writeSnapshot(first, failLines, 3)
    writeDecisions(first, 2)
    emit(\`[\${stamp(30)}] HOST_LOCK released pid=\${process.pid} runId=\${first}\`)
  } else {
    for (const line of chainLines) emit(line)
    emit(heartbeat('nether_portal', { obsidian: 10 }, 7))
    writeSnapshot(first, chainLines, 3)
    writeDecisions(first, 2)
    emit(\`[\${stamp(30)}] HOST_LOCK released pid=\${process.pid} runId=\${first}\`)
  }
}
setInterval(() => {}, 1 << 30)
`
}

function resolveConfig(args) {
  const campaignId = args.campaign
  const rehearse = args.rehearse
  const evidenceClass = args.evidenceClass ?? (rehearse ? 'rehearsal' : 'live')
  if (rehearse && evidenceClass !== 'rehearsal') {
    throw new Error('--rehearse requires evidenceClass=rehearsal: a stub run can never be counted as a live trial')
  }
  const trialsDir = args.trialsDir ?? join(REPRO_ROOT, 'runs', 'm2-repro', campaignId ?? 'unscoped')
  const frozenTree = args.frozenTree ?? (rehearse ? trialsDir : join(WORKTREES_ROOT, `m2-repro-${slug(campaignId ?? 'campaign', { max: 24 })}`))
  const serverRoot = resolve(args.serverRoot)
  return {
    campaignId,
    trials: args.trials,
    deadlineMs: args.deadlineMs,
    settleMs: args.settleMs,
    pollMs: args.pollMs,
    bootTimeoutMs: args.bootTimeoutMs,
    serverReadyMs: args.serverReadyMs,
    frozenSha: args.frozenSha,
    frozenTree: resolve(frozenTree),
    createFrozenTree: args.createFrozenTree,
    driverDir: resolve(args.driverDir ?? join(frozenTree, 'buddy-driver')),
    serverRoot,
    descriptorPath: resolve(args.descriptorPath),
    trialsDir: resolve(trialsDir),
    seedBase: args.seedBase ?? campaignId ?? 'm2rep',
    seedList: args.seedList,
    seedListValues: null,
    levelPrefix: args.levelPrefix,
    botUsername: args.botUsername,
    maxRestarts: args.maxRestarts,
    minFreeBytes: args.minFreeBytes,
    apply: args.apply || rehearse,
    live: args.live && !rehearse,
    rehearse,
    rehearseOutcome: args.rehearseOutcome,
    overwriteProperties: args.overwriteProperties,
    createServerRoot: args.createServerRoot || rehearse,
    json: args.json,
    evidenceClass,
  }
}

async function ensureFrozenTree(config, log) {
  const residentProcesses = listResidentPids()
  if (residentProcesses.length > 0) {
    return {
      created: false,
      tree: config.frozenTree,
      error: `resident_is_live:pids=${residentProcesses.map((entry) => entry.pid).join(',')} (operator decision (root AGENTS.md H4); no signal will be sent)`,
    }
  }
  const serverProcesses = listServerPids()
  if (serverProcesses.length > 0) {
    return {
      created: false,
      tree: config.frozenTree,
      error: `server_is_live:pids=${serverProcesses.map((entry) => entry.pid).join(',')} (operator decision (root AGENTS.md H4); no signal will be sent)`,
    }
  }
  if (!(await portFree(RESIDENT_PORT))) {
    return { created: false, tree: config.frozenTree, error: `resident_port_${RESIDENT_PORT}_is_in_use (H4; no process will be signalled)` }
  }
  const hostLock = readHostLock(config.driverDir)
  if (hostLock.present && pidAlive(Number(hostLock.pid))) {
    return { created: false, tree: config.frozenTree, error: `host_lock_is_live:pid=${String(hostLock.pid)} (operator decision (root AGENTS.md H4); no signal will be sent)` }
  }
  let created = false
  if (existsSync(join(config.frozenTree, '.git')) || existsSync(join(config.frozenTree, 'buddy-driver'))) {
    created = false
  } else {
    if (!config.createFrozenTree) return { created: false, tree: config.frozenTree, missing: true }
    const result = Bun.spawnSync(['git', '-C', REPRO_ROOT, 'worktree', 'add', '--detach', config.frozenTree, config.frozenSha])
    if (result.exitCode !== 0) {
      return { created: false, tree: config.frozenTree, error: result.stderr.toString().trim().slice(0, 400) }
    }
    created = true
  }

  const source = inspectFrozenSource(config)
  if (source.blockers.length > 0) {
    return { created, tree: config.frozenTree, error: `exact_source_preflight_failed:${source.blockers.join('|')}` }
  }

  const install = Bun.spawnSync(['bun', 'install', '--frozen-lockfile'], { cwd: config.frozenTree })
  log(`FROZEN_TREE created=${created} tree=${config.frozenTree} installExit=${install.exitCode}`)
  if (install.exitCode !== 0) {
    return { created, tree: config.frozenTree, error: `bun_install_frozen_lockfile_failed:exitCode=${String(install.exitCode)}` }
  }
  const afterInstall = inspectFrozenSource(config)
  if (afterInstall.blockers.length > 0) {
    return { created, tree: config.frozenTree, error: `exact_source_post_install_failed:${afterInstall.blockers.join('|')}` }
  }
  return { created, tree: config.frozenTree, installExitCode: install.exitCode }
}

function nextAttemptDir(trialDir) {
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const dir = join(trialDir, `attempt-${attempt}`)
    try {
      mkdirSync(dir)
      return { attempt, dir }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`no free attempt directory under ${trialDir}`)
}

/** Seeds already assigned to an attempt, including a crash before ledger append. */
function collectAttemptSeeds(trialsDir) {
  const seeds = new Set()
  const recordSeed = (value) => {
    if (value !== null && value !== undefined && String(value) !== '') seeds.add(String(value))
  }
  for (const row of readJsonl(join(trialsDir, LEDGER_NAME))) recordSeed(row.identity?.levelSeed)
  let trialEntries = []
  try {
    trialEntries = readdirSync(trialsDir, { withFileTypes: true })
  } catch {
    return [...seeds]
  }
  for (const trialEntry of trialEntries) {
    if (!trialEntry.isDirectory() || !/^trial-\d+$/.test(trialEntry.name)) continue
    const trialPath = join(trialsDir, trialEntry.name)
    let attempts = []
    try {
      attempts = readdirSync(trialPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const attemptEntry of attempts) {
      if (!attemptEntry.isDirectory() || !/^attempt-\d+$/.test(attemptEntry.name)) continue
      try {
        const identity = JSON.parse(readFileSync(join(trialPath, attemptEntry.name, 'identity.json'), 'utf8'))
        recordSeed(identity.levelSeed)
      } catch {
        // An attempt without identity.json never recorded a seed assignment.
      }
    }
  }
  return [...seeds]
}

async function runOneTrial(config, trialIndex, log) {
  const trialDir = join(config.trialsDir, `trial-${String(trialIndex).padStart(3, '0')}`)
  mkdirSync(trialDir, { recursive: true })
  const { attempt, dir: attemptDir } = nextAttemptDir(trialDir)
  const evidenceDir = join(attemptDir, 'evidence')
  mkdirSync(evidenceDir, { recursive: true })
  const seedList = config.seedList === null ? null : config.seedListValues
  const primarySeeds = seedList === null
    ? Array.from({ length: config.trials }, (_, index) => deriveSeed(config.campaignId, index, config.seedBase))
    : seedList.map(String)
  const levelSeed = deriveAttemptSeed({
    campaignId: config.campaignId,
    trialIndex,
    attempt,
    seedBase: config.seedBase,
    explicitSeed: seedList === null ? null : seedList[trialIndex],
    usedSeeds: [...primarySeeds, ...collectAttemptSeeds(config.trialsDir)],
  })
  const levelName = trialLevelName(config.campaignId, trialIndex, config.levelPrefix, attempt)
  const row = {
    record: TRIAL_RECORD,
    schemaVersion: SCHEMA_VERSION,
    campaignId: config.campaignId,
    evidenceClass: config.evidenceClass,
    trialIndex,
    attempt,
    trialDir,
    attemptDir,
    status: 'PLANNED',
    terminal: false,
    countable: false,
  }

  // --- (a) stage a FRESH world with a NEW seed and a DISTINCT level name -----
  const nameProblems = [...levelNameProblems(levelName), ...(PROTECTED_LEVEL_NAMES.includes(levelName) ? [`protected level name: ${levelName}`] : [])]
  const seedProblemList = seedProblems(levelSeed, null)
  if (nameProblems.length > 0 || seedProblemList.length > 0) {
    row.status = 'INFRA'
    row.failureKind = 'identity_invalid'
    row.reasons = [...nameProblems, ...seedProblemList]
    row.terminal = true
    return finishRow(config, row, { log })
  }
  const staged = stageTrial(config, { index: trialIndex, attempt, levelName, levelSeed, dir: attemptDir }, { apply: config.apply })
  row.staging = {
    status: staged.status,
    refusals: staged.refusals.map((entry) => entry.reason),
    guards: staged.guards.map((guard) => ({ id: guard.id, verdict: guard.verdict })),
    actions: staged.actions,
    applied: staged.applied,
    unchanged: staged.unchanged,
    worldDir: staged.worldDir,
    runDir: staged.runDir,
    descriptorTemplateSha256: staged.descriptorSha256,
  }
  if (staged.status === 'REFUSED') {
    row.status = 'INFRA'
    row.failureKind = 'staging_refused'
    row.reasons = staged.refusals.map((entry) => entry.reason)
    row.terminal = true
    return finishRow(config, row, { log })
  }

  // A trial must start from a tree that carries NO durable memory of a previous
  // world: worldKey is `serverId|dimension|epoch`, so a stale ledger would resume
  // the previous trial's rung instead of measuring M2 from scratch.
  const durableStateAtStart = durableStatePresent(config.driverDir)
  const backend = buildBackend(config, { attemptDir, trialDir, levelName, levelSeed, serverPropertiesPath: staged.serverProperties?.path ?? null })

  // --- (b) identity BEFORE anything runs ------------------------------------
  const identity = buildIdentity(config, { index: trialIndex, attempt, levelName, levelSeed, dir: attemptDir }, staged, {
    durableStateAtStart,
    frozenTreeHead: gitHead(config.frozenTree),
    dirtyTree: config.rehearse ? null : false,
    plannedServerArgv: backend.serverCmd,
    plannedResidentArgv: backend.residentCmd,
  })
  row.identity = identity
  writeJsonAtomic(join(attemptDir, 'identity.json'), identity)

  if (!config.apply || (!config.live && !config.rehearse)) {
    row.status = 'STAGED_ONLY'
    row.failureKind = config.apply ? 'no_live' : 'no_apply'
    row.reasons = [
      config.apply
        ? '--live was not given: the world is staged and the identity is recorded, no server/resident was started'
        : '--apply was not given: the plan and identity were produced, nothing was written or started',
    ]
    row.terminal = true
    return finishRow(config, row, { log })
  }
  if (config.live && durableStateAtStart.length > 0) {
    row.status = 'INFRA'
    row.failureKind = 'durable_state_not_pristine'
    row.reasons = [
      `the driver tree carries durable state before the trial started: ${durableStateAtStart.map((entry) => entry.rel).join(', ')}`,
      'a live trial must start from a tree with no memory of another world (CLEAN-RUN-EXECUTION.md §1)',
    ]
    row.terminal = true
    return finishRow(config, row, { log })
  }

  appendJsonl(join(config.trialsDir, LEDGER_NAME), {
    record: TRIAL_RECORD,
    schemaVersion: SCHEMA_VERSION,
    campaignId: config.campaignId,
    evidenceClass: config.evidenceClass,
    trialIndex,
    attempt,
    terminal: false,
    status: 'PLANNED',
    at: nowIso(),
    identity,
    staging: row.staging,
  })
  log(`TRIAL ${trialIndex} identity levelName=${levelName} seed=${levelSeed} descriptor=${String(identity.descriptor.resolvedSha256 ?? 'none').slice(0, 12)} world=${String(staged.worldDir)} durableState=${durableStateAtStart.length === 0 ? 'pristine' : durableStateAtStart.map((entry) => entry.rel).join('+')}`)

  // --- (c) start the server, then the resident -------------------------------
  const startedAt = Date.now()
  row.timing = { startedAt: nowIso() }
  row.quarantine = null
  const serverLog = join(attemptDir, 'server.log')
  const serverProc = spawnLogged(backend.serverCmd, { cwd: backend.serverCwd, logPath: serverLog, env: backend.serverEnv })
  row.run = { server: { pid: serverProc.pid, log: serverLog, argv: backend.serverCmd } }
  const serverReady = await waitForLog(serverLog, MC_READY_RE, {
    deadlineAt: startedAt + config.serverReadyMs,
    pollMs: 2000,
  })
  const serverText = readWindow(serverLog, 0, null)
  row.run.server.ready = serverReady.ok
  row.run.server.readyLine = serverReady.ok ? serverReady.line : null
  row.run.server.seedLine = /Seed:\s*\[-?\d+\]/.exec(serverText)?.[0] ?? null
  row.run.server.observedSeed = MC_SEED_RE.exec(serverText)?.[1] ?? null
  row.run.server.freshWorldLine = MC_FRESH_RE.exec(serverText)?.[0] ?? null
  row.run.server.worldCreated = staged.worldDir === null ? null : worldDataExists(staged.worldDir)
  row.run.server.seedMatchesDeclared = row.run.server.observedSeed === null ? null : row.run.server.observedSeed === levelSeed
  if (!serverReady.ok) {
    row.status = 'INFRA'
    row.failureKind = 'server_not_ready'
    row.reasons = [`the server did not print 'Done (' within ${config.serverReadyMs} ms`]
    row.run.server.stdoutTail = serverText.split('\n').slice(-25)
    const teardown = await stopChild(serverProc, { gracefulLine: 'stop' })
    row.teardown = { server: teardown }
    row.terminal = true
    return finishRow(config, row, { log })
  }
  if (row.run.server.seedMatchesDeclared === false) {
    row.status = 'INFRA'
    row.failureKind = 'seed_mismatch'
    row.reasons = [`the server reported Seed: [${row.run.server.observedSeed}] but the trial declared ${levelSeed}`]
    const teardown = await stopChild(serverProc, { gracefulLine: 'stop' })
    row.teardown = { server: teardown }
    row.terminal = true
    return finishRow(config, row, { log })
  }

  const residentLogPath = backend.driverLogPath
  const logFrom = fileSize(residentLogPath)
  const runnerOutPath = join(attemptDir, 'runner.out')
  const residentProc = spawnLogged(backend.residentCmd, {
    cwd: backend.residentCwd,
    logPath: runnerOutPath,
    env: backend.residentEnv,
  })
  row.run.resident = { pid: residentProc.pid, argv: backend.residentCmd, logFrom, runnerOut: runnerOutPath, log: residentLogPath }

  const scanner = createWindowScanner(logFrom)
  const bootDeadline = Date.now() + config.bootTimeoutMs
  let bootSeen = false
  while (!bootSeen && Date.now() < bootDeadline && residentProc.exitCode === null) {
    scanner.pump(residentLogPath)
    bootSeen = scanner.boots().length > 0
    if (!bootSeen) await sleep(Math.min(2000, config.pollMs))
  }
  if (!bootSeen) {
    row.status = 'INFRA'
    row.failureKind = 'resident_never_booted'
    row.reasons = [`no 'BOOT ... runId=' line appeared in ${residentLogPath} within ${config.bootTimeoutMs} ms`]
    row.run.resident.exitCode = residentProc.exitCode
    row.run.resident.stdoutTail = readWindow(runnerOutPath, 0, null).split('\n').slice(-25)
    row.teardown = await stopTrialProcesses(config, row, { serverProc, residentProc, backend })
    recordFinalBootWindow(row, scanner, residentLogPath, config.frozenSha)
    row.evidence = await materializeEvidence(config, {
      attemptDir,
      evidenceDir,
      residentLogPath,
      logFrom,
      scanner,
      runId: scanner.primaryRunId(),
    })
    row.teardown.quarantine = quarantineDurableState(config.driverDir, join(evidenceDir, 'durable-state'))
    row.terminal = true
    return finishRow(config, row, { log })
  }
  const firstBoot = scanner.boots()[0]
  if (config.frozenSha === null || firstBoot.source !== config.frozenSha) {
    row.status = 'INFRA'
    row.failureKind = 'boot_source_mismatch'
    row.reasons = [`the resident booted source=${String(firstBoot.source)} but the campaign froze exactly ${String(config.frozenSha)}`]
    row.teardown = await stopTrialProcesses(config, row, { serverProc, residentProc, backend })
    recordFinalBootWindow(row, scanner, residentLogPath, config.frozenSha)
    row.evidence = await materializeEvidence(config, {
      attemptDir,
      evidenceDir,
      residentLogPath,
      logFrom,
      scanner,
      runId: firstBoot.runId,
    })
    row.teardown.quarantine = quarantineDurableState(config.driverDir, join(evidenceDir, 'durable-state'))
    row.terminal = true
    return finishRow(config, row, { log })
  }
  log(`TRIAL ${trialIndex} boot runId=${firstBoot.runId} source=${String(firstBoot.source)}`)

  // --- (d) watch the run's OWN evidence with a bounded deadline --------------
  const deadlineAt = startedAt + config.deadlineMs
  let split = false
  let gate = null
  let settleUntil = null
  let gateCalls = 0
  let residentExited = false
  let serverExited = false
  while (Date.now() < deadlineAt) {
    scanner.pump(residentLogPath)
    const runIds = scanner.distinctRunIds()
    if (runIds.length > 1 && !split) {
      split = true
      log(`TRIAL ${trialIndex} SPLIT runIds=${runIds.join(',')}`)
    }
    if (residentProc.exitCode !== null) {
      residentExited = true
      break
    }
    if (serverProc.exitCode !== null) {
      serverExited = true
      break
    }
    const primary = scanner.primaryRunId()
    const chain = primary === null ? null : scanner.chain(primary)
    // A KNOWN portal failure (shape=bad, light refused, verify false) is terminal:
    // the canonical gate turns it into FAIL, so waiting out the deadline would only
    // waste the trial's wall time.
    const failure = primary === null ? null : detectPortalFailure(scanner.run(primary)?.events ?? [])
    const trigger = (chain !== null && chain.complete) || failure !== null
    if (trigger && settleUntil === null) settleUntil = Date.now() + config.settleMs
    if ((trigger || split) && gateCalls < 8) {
      const snapshotDir = await materializeEvidence(config, { attemptDir, evidenceDir, residentLogPath, logFrom, scanner, runId: primary })
      gate = await gateTrial({
        runId: primary,
        evidenceDir,
        driverRoot: backend.driverRoot,
        runnerOutPath,
        controlSocketPath: backend.controlSocketPath,
        write: () => {},
      })
      gateCalls += 1
      row.gate = { status: gate.status, code: gate.code, reason: gate.reason, conditions: gate.conditions, missing: gate.missing, chainLine: gate.chainLine, chain: gate.chain, calls: gateCalls, snapshotDir }
      if (gate.status === 'PASS') break
      if (gate.status === 'FAIL') break
      if (split) break
      if (settleUntil !== null && Date.now() >= settleUntil) break
    }
    await sleep(config.pollMs)
  }
  const hitDeadline = Date.now() >= deadlineAt && gate?.status !== 'PASS'
  row.timing.finishedAt = nowIso()
  row.timing.wallMs = Date.now() - startedAt
  row.run.boots = scanner.boots()
  row.run.distinctRunIds = scanner.distinctRunIds()
  row.run.foreignRunIds = scanner.foreignRunIds()
  row.run.lastObservedRung = scanner.lastRung()

  // --- (f) teardown, then classify ------------------------------------------
  // Order matters: stop the processes, THEN snapshot the evidence (the resident
  // has stopped writing, so the window is final), THEN quarantine the durable
  // state so the next trial starts from a tree with no memory of this one.
  const primaryRunId = scanner.primaryRunId()
  row.run.runId = primaryRunId
  const teardown = await stopTrialProcesses(config, row, { serverProc, residentProc, backend })
  row.teardown = teardown
  const finalBoots = recordFinalBootWindow(row, scanner, residentLogPath, config.frozenSha)
  split ||= finalBoots.split
  const evidence = await materializeEvidence(config, { attemptDir, evidenceDir, residentLogPath, logFrom, scanner, runId: primaryRunId })
  row.evidence = evidence
  const quarantine = quarantineDurableState(config.driverDir, join(evidenceDir, 'durable-state'))
  row.teardown.quarantine = quarantine
  if (gate === null || (gate.status !== 'PASS' && gateCalls < 8)) {
    gate = await gateTrial({
      runId: primaryRunId,
      evidenceDir,
      driverRoot: backend.driverRoot,
      runnerOutPath,
      controlSocketPath: backend.controlSocketPath,
      write: () => {},
    })
    row.gate = { status: gate.status, code: gate.code, reason: gate.reason, conditions: gate.conditions, missing: gate.missing, chainLine: gate.chainLine, chain: gate.chain, calls: (row.gate?.calls ?? 0) + 1, snapshotDir: evidence.snapshotDir }
  }
  writeFileSync(join(evidenceDir, 'm2-gate.txt'), `${(gate.lines ?? []).join('\n')}\n`, 'utf8')
  row.chain = {
    line: gate.chainLine ?? null,
    links: gate.chain ?? [],
    firstMissingChainLink: firstMissingChainLink(gate.chain),
  }
  row.firstUnmetGateStage = firstUnmetGateStage(gate.conditions)
  // Historical alias: firstMissingLink means only the first unmet M2 gate
  // stage; it does not imply that the stage is the cause of the failure.
  row.firstMissingLink = row.firstUnmetGateStage
  row.causalBlocker = causalBlockerFromRun(primaryRunId, scanner.run(primaryRunId)?.events)
  row.lastObservedRung = scanner.lastRung()

  if (finalBoots.sourceMismatches.length > 0) {
    row.status = 'INFRA'
    row.failureKind = 'boot_source_mismatch'
    row.countable = false
    row.reasons = finalBoots.sourceMismatches.map((boot) => `BOOT runId=${boot.runId} source=${String(boot.source)} does not equal frozen source ${String(config.frozenSha)}`)
  } else if (split) {
    row.status = 'SPLIT'
    row.failureKind = 'split_boots'
    row.countable = false
    row.diagnosticOnly = {
      note: 'DIAGNOSTIC ONLY - never counted as a pass or a fail: the chain below spans more than one boot runId',
      runIds: scanner.distinctRunIds(),
      perBootChain: scanner.distinctRunIds().map((runId) => {
        const link = scanner.chain(runId).link
        return { runId, ...link, chainLine: formatPortalChainLine(link) }
      }),
      lastGateStatus: gate.status,
      lastGateReason: gate.reason,
    }
  } else if (gate.status === 'PASS') {
    row.status = 'PASS'
    row.failureKind = null
    row.countable = true
  } else if (gate.status === 'FAIL') {
    row.status = 'FAIL'
    row.failureKind = 'capability'
    row.countable = true
  } else if (residentExited) {
    row.status = 'FAIL'
    row.failureKind = 'resident_exit'
    row.countable = true
    row.reasons = [`the resident exited before the M2 chain was complete (exitCode=${String(residentProc.exitCode)})`]
    row.terminatingMarkers = readWindow(join(attemptDir, 'runner.out'), 0, null)
      .split('\n')
      .filter((line) => /FATAL|ERROR|MODEL_UNAVAILABLE|SUPERVISOR_(FAILURE|STOP)/.test(line))
      .slice(-6)
  } else if (serverExited) {
    row.status = 'INFRA'
    row.failureKind = 'server_exit'
    row.reasons = [`the server exited before the M2 chain was complete (exitCode=${String(serverProc.exitCode)})`]
  } else if (hitDeadline) {
    row.status = 'TIMEOUT'
    row.failureKind = 'deadline'
    row.countable = true
    row.reasons = [`the M2 chain was not complete within ${config.deadlineMs} ms`]
  } else {
    row.status = 'TIMEOUT'
    row.failureKind = 'gate_not_pass'
    row.countable = true
    row.reasons = [`the canonical gate returned ${gate.status} (${gate.reason})`]
  }
  row.terminal = true
  return finishRow(config, row, { log })
}

/**
 * Copy the trial's OWN bytes of the shared resident log plus its run-scoped
 * snapshot into the trial's evidence directory. The excerpt is bounded by the
 * byte offset recorded before the resident started, so it can only ever contain
 * this trial's lines, and the snapshot is copied (never moved) so the live
 * resident keeps its own file.
 */
async function materializeEvidence(config, { attemptDir, evidenceDir, residentLogPath, logFrom, scanner, runId }) {
  const windowPath = join(evidenceDir, 'resident-window.log')
  const text = readWindow(residentLogPath, logFrom, null)
  writeFileSync(windowPath, text, 'utf8')
  const snapshot = { copied: null, path: null }
  if (runId !== null) {
    const source = join(config.driverDir, 'data', 'resident', `m2-snapshot-${runId}.json`)
    if (isFile(source)) {
      const target = join(evidenceDir, `m2-snapshot-${runId}.json`)
      writeFileSync(target, readFileSync(source))
      snapshot.copied = target
      snapshot.path = source
    }
  }
  const quotes = []
  for (const runIdEntry of scanner.distinctRunIds()) {
    const run = scanner.run(runIdEntry)
    quotes.push({
      runId: runIdEntry,
      lines: run === null ? 0 : run.lines,
      portalMarkers: (run?.events ?? []).map((event) => ({ name: event.name, line: event.line, index: event.index })),
      boots: scanner.boots().filter((boot) => boot.runId === runIdEntry).map((boot) => boot.line),
    })
  }
  const inventoryQuotes = []
  for (const runIdEntry of scanner.distinctRunIds()) {
    const run = scanner.run(runIdEntry)
    for (const sample of (run?.inventories ?? []).slice(-4)) inventoryQuotes.push({ runId: runIdEntry, line: sample.line })
  }
  const rungQuote = scanner.lastRung()
  return {
    residentWindow: { path: windowPath, bytes: fileSize(windowPath), sha256: sha256File(windowPath), fromOffset: logFrom },
    snapshot,
    gateLog: join(evidenceDir, 'm2-gate.txt'),
    quotes,
    inventoryQuotes,
    rungQuote,
    note: 'every line quoted here is inside this trial byte window of the shared resident log; the snapshot is the runId-scoped file copied verbatim',
  }
}

async function stopTrialProcesses(config, row, { serverProc, residentProc, backend }) {
  const teardown = {
    at: nowIso(),
    resident: null,
    server: null,
    portChecked: backend.kind === 'live' ? RESIDENT_PORT : null,
    portFree: null,
    hostLockReleased: null,
    quarantine: null,
  }
  if (residentProc !== undefined && residentProc !== null) {
    teardown.resident = await stopChild(residentProc, { gracefulLine: null, gracefulMs: 1500, termMs: 20000 })
    // A supervisor that has gone does not prove the CHILD is gone: signal only the
    // pid this trial's own host.lock names, and only if it is still alive.
    const lock = readHostLock(config.driverDir)
    if (lock?.present === true && pidAlive(Number(lock.pid)) && Number(lock.pid) !== residentProc.pid) {
      try {
        process.kill(Number(lock.pid), 'SIGTERM')
        teardown.residentChildSignalled = Number(lock.pid)
      } catch (error) {
        teardown.residentChildSignalled = `failed:${String(error?.code ?? error)}`
      }
      const until = Date.now() + 20000
      while (Date.now() < until && pidAlive(Number(lock.pid))) await sleep(500)
    }
    const finalLock = readHostLock(config.driverDir)
    teardown.hostLockReleased = finalLock?.present !== true || !pidAlive(Number(finalLock?.pid))
    teardown.residentProcessesAfter = findResidentProcesses(config.driverDir).map((entry) => entry.pid)
  }
  if (serverProc !== undefined && serverProc !== null) {
    teardown.server = await stopChild(serverProc, { gracefulLine: 'stop', gracefulMs: 60000, termMs: 20000 })
  }
  if (backend.kind === 'live') teardown.portFree = await portFree(RESIDENT_PORT, { timeoutMs: 1500 })
  else teardown.portNote = 'rehearsal stubs bind an ephemeral port, so 25565 is neither used nor checked'
  teardown.worldsPreserved = {
    note: 'no world directory was deleted or moved by this harness',
    worldDir: row.staging?.worldDir ?? null,
    worldDirStillPresent: row.staging?.worldDir === null || row.staging?.worldDir === undefined ? null : existsSync(row.staging.worldDir),
  }
  teardown.diskFreeAfter = freeBytes(config.serverRoot)
  return teardown
}

function finishRow(config, row, { log }) {
  if (row.firstUnmetGateStage === undefined) row.firstUnmetGateStage = row.firstMissingLink ?? null
  if (row.firstMissingLink === undefined) row.firstMissingLink = row.firstUnmetGateStage
  if (row.causalBlocker === undefined) row.causalBlocker = causalBlockerFromRun(null, [])
  const summary = {
    status: row.status,
    firstUnmetGateStage: row.firstUnmetGateStage,
    causalBlocker: row.causalBlocker,
    // Compatibility alias for existing consumers. This is a stage label only.
    firstMissingLink: row.firstMissingLink ?? null,
    firstMissingChainLink: row.firstMissingChainLink ?? null,
    lastObservedRung: row.lastObservedRung?.value ?? null,
    runId: row.run?.runId ?? row.run?.boots?.[0]?.runId ?? null,
    boots: row.run?.boots?.length ?? 0,
  }
  row.finishedAt = nowIso()
  row.summary = summary
  const payload = { ...row }
  delete payload.identity
  writeJsonAtomic(join(row.attemptDir, 'outcome.json'), row)
  appendJsonl(join(config.trialsDir, LEDGER_NAME), { ...row, terminal: true, identity: row.identity ?? null })
  log(
    `TRIAL ${row.trialIndex} ${row.status} first-unmet-stage=${String(row.firstUnmetGateStage ?? '-')} causal-blocker=${String(row.causalBlocker.value ?? 'UNKNOWN')} ` +
      `rung=${String(summary.lastObservedRung ?? '-')} runId=${String(summary.runId ?? '-')} boots=${summary.boots}`,
  )
  return row
}

// ---------------------------------------------------------------------------
// backends: the live one and the rehearsal one
// ---------------------------------------------------------------------------

function buildBackend(config, { attemptDir, trialDir, levelName, levelSeed, serverPropertiesPath = null }) {
  // The supervisor spawns its child with `cwd: driverDir`; a missing directory
  // makes posix_spawn fail with a misleading ENOENT naming the interpreter. A
  // fresh campaign tree has no buddy-driver/ yet, so create it first.
  mkdirSync(config.driverDir, { recursive: true })
  if (config.rehearse) {
    const stubDir = join(config.trialsDir, '_stubs')
    mkdirSync(stubDir, { recursive: true })
    const stubServer = join(stubDir, 'stub-server.mjs')
    const stubResident = join(stubDir, 'stub-resident.mjs')
    writeFileSync(stubServer, stubServerSource(), 'utf8')
    writeFileSync(stubResident, stubResidentSource(), 'utf8')
    return {
      kind: 'rehearsal',
      driverRoot: config.frozenTree,
      driverLogPath: join(config.driverDir, 'buddy.log'),
      controlSocketPath: join(config.driverDir, 'data', 'resident', 'control.sock'),
      serverCwd: config.serverRoot,
      serverCmd: [
        process.execPath,
        stubServer,
        '--log',
        join(attemptDir, 'server.log'),
        '--world',
        join(config.serverRoot, levelName),
        '--level-name',
        levelName,
        '--seed',
        levelSeed,
        '--port',
        '0',
        '--driver-log',
        join(config.driverDir, 'buddy.log'),
        '--tail-boot',
        String(config.rehearseOutcome === 'tail-boot'),
        '--tail-boot-source',
        config.frozenSha ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      ],
      serverEnv: {},
      residentCwd: config.frozenTree,
      residentCmd: [
        process.execPath,
        join(REPO_ROOT, 'tools', 'resident-supervisor.mjs'),
        '--driver-dir',
        config.driverDir,
        '--child-script',
        stubResident,
        '--artifact-dir',
        join(attemptDir, 'supervisor'),
        '--log',
        join(attemptDir, 'supervisor.log'),
        '--max-restarts',
        String(config.maxRestarts),
      ],
      residentEnv: {
        M2_REPRO_STUB_OUTCOME: config.rehearseOutcome,
        M2_REPRO_STUB_DRIVER_DIR: config.driverDir,
        M2_REPRO_STUB_SOURCE: config.rehearseOutcome === 'wrong-source'
          ? 'deadbeef'
          : config.frozenSha ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        BUDDY_USERNAME: config.botUsername,
      },
    }
  }
  const cleanProperties = serverPropertiesPath ?? join(config.serverRoot, M2_RUN_DIR_NAME, 'server.properties.clean')
  const supervisorRoot = config.rehearse ? REPO_ROOT : config.frozenTree
  const supervisorScript = join(supervisorRoot, 'tools', 'resident-supervisor.mjs')
  const serverCmd = [
    JAVA,
    '-Xmx1G',
    '-Xms1G',
    '-DPaper.IgnoreJavaVersion=true',
    '-jar',
    SERVER_JAR,
    '--nogui',
  ]
  serverCmd.push('--config', cleanProperties, '--universe', config.serverRoot, '--level-name', levelName)
  return {
    kind: 'live',
    driverRoot: config.frozenTree,
    driverLogPath: join(config.driverDir, 'buddy.log'),
    controlSocketPath: join(config.driverDir, 'data', 'resident', 'control.sock'),
    serverCwd: config.serverRoot,
    serverCmd,
    serverEnv: {},
    residentCwd: supervisorRoot,
    residentCmd: [
      process.execPath,
      supervisorScript,
      '--driver-dir',
      config.driverDir,
      '--artifact-dir',
      join(attemptDir, 'supervisor'),
      '--log',
      join(attemptDir, 'supervisor.log'),
      '--max-restarts',
      String(config.maxRestarts),
    ],
    residentEnv: { BUDDY_USERNAME: config.botUsername, BUDDY_SERVER_PROPERTIES_PATH: cleanProperties },
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`M2_REPRO_ERROR ${error.message}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (args.campaign === null) {
    process.stderr.write('M2_REPRO_ERROR --campaign <id> is required (see --help)\n')
    return 2
  }
  const config = resolveConfig(args)
  const ledgerPath = join(config.trialsDir, LEDGER_NAME)
  const log = (line) => process.stdout.write(`${nowIso()} ${line}\n`)

  if (args.observe) {
    if (args.run === null) {
      process.stderr.write('M2_REPRO_ERROR --observe requires --run <runId>\n')
      return 2
    }
    return observeRun(config, args, log)
  }

  if (args.status || args.report) {
    const rows = readJsonl(ledgerPath)
    if (rows.length === 0) {
      process.stdout.write(`no ledger at ${ledgerPath}\n`)
      return 1
    }
    const summary = summarize(config.campaignId, rows)
    writeJsonAtomic(join(config.trialsDir, SUMMARY_NAME), summary)
    if (args.status) {
      process.stdout.write(`campaign=${config.campaignId} ledger=${ledgerPath} records=${rows.length}\n`)
      for (const row of summary.rows) {
        process.stdout.write(
          `  trial-${String(row.trialIndex).padStart(3, '0')} ${row.status} first-unmet-stage=${String(row.firstUnmetGateStage ?? row.firstMissingLink ?? '-')} causal-blocker=${String(row.causalBlocker?.value ?? 'UNKNOWN')} rung=${String(row.lastObservedRung ?? '-')} runId=${String(row.runId ?? '-')}\n`,
        )
      }
      return 0
    }
    const report = formatReport(summary)
    writeFileSync(join(config.trialsDir, TABLE_NAME), report, 'utf8')
    if (args.json) process.stdout.write(`${JSON.stringify(summary)}\n`)
    else process.stdout.write(report)
    return campaignExitCode(summary)
  }

  if (!Number.isInteger(config.trials) || config.trials < 1) {
    process.stderr.write(`M2_REPRO_ERROR --trials must be a positive integer, got ${String(config.trials)}\n`)
    return 2
  }
  if (config.seedList !== null) {
    let seedList
    try {
      const seedText = readFileSync(config.seedList, 'utf8')
      seedList = parseSeedList(seedText)
      config.seedListSha256 = sha256Text(seedText)
    } catch (error) {
      process.stderr.write(`M2_REPRO_ERROR seed_list_unreadable path=${config.seedList} reason=${String(error?.code ?? error)}\n`)
      return 2
    }
    const seedProblems = validateSeedList(seedList, config.trials)
    if (seedProblems.length > 0) {
      process.stderr.write(`M2_REPRO_ERROR invalid_seed_list:\n${seedProblems.map((problem) => `  - ${problem}`).join('\n')}\n`)
      return 2
    }
    config.seedListValues = seedList
  }

  if (config.rehearse) {
    if (resolve(config.serverRoot) === resolve(LIVE_CONTAINER)) {
      process.stderr.write(
        'M2_REPRO_ERROR --rehearse must not stage into the live container: pass --server-root <scratch dir> ' +
          '(a rehearsal never writes next to the real run directory or boots the real world)\n',
      )
      return 1
    }
    if (config.frozenSha === null) config.frozenSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  }
  if (config.live && (config.frozenSha === null || !/^[0-9a-f]{40}$/.test(String(config.frozenSha)))) {
    process.stderr.write(`M2_REPRO_ERROR --live requires --frozen-sha <40hex>, got ${String(config.frozenSha)}\n`)
    return 2
  }

  const lock = claimCampaignLock(campaignLockPath(), {
    campaignId: config.campaignId,
    trials: config.trials,
    frozenSha: config.frozenSha,
  })
  if (!lock.ok) {
    process.stderr.write(`M2_REPRO_REFUSED ${lock.reason}\n`)
    return 1
  }
  log(`CAMPAIGN ${config.campaignId} trials=${config.trials} mode=${config.rehearse ? 'rehearse' : config.live ? 'live' : 'apply-only'} ledger=${ledgerPath}`)
  if (lock.reclaimed === true) log(`LOCK reclaimed a stale campaign lock at ${lock.path}`)

  const rows = readJsonl(ledgerPath)
  const campaignRow = rows.find((row) => row.record === CAMPAIGN_RECORD)
  const parameters = campaignParameters(config)
  const previousTrials = plannedTrialCount(rows)
  const mismatches = campaignRow === undefined ? [] : campaignParameterMismatches(campaignRow.parameters, parameters)
  if (campaignRow !== undefined) {
    if (previousTrials === null) mismatches.push('campaign_trial_count_missing:new_campaign_id_required')
    else if (config.trials < previousTrials) mismatches.push(`campaign_trial_count_cannot_shrink:pinned=${previousTrials}:requested=${config.trials}`)
  } else if (rows.some((row) => row.record === TRIAL_RECORD)) {
    releaseCampaignLock(lock.path)
    process.stderr.write('M2_REPRO_REFUSED campaign_identity_missing: trial rows exist without a pinned campaign record; use a new campaign id\n')
    return 1
  }
  if (mismatches.length > 0) {
    releaseCampaignLock(lock.path)
    process.stderr.write(`M2_REPRO_REFUSED campaign_identity_mismatch:\n${mismatches.map((entry) => `  - ${entry}`).join('\n')}\n`)
    return 1
  }

  // Lock the machine-global run before creating a frozen worktree or installing
  // dependencies; otherwise two campaigns could mutate the same custom tree.
  const frozen = config.live ? await ensureFrozenTree(config, log) : { created: false, tree: config.frozenTree }
  if (frozen.error !== undefined) {
    releaseCampaignLock(lock.path)
    process.stderr.write(`M2_REPRO_REFUSED ${frozen.error}\n`)
    return 1
  }
  if (frozen.missing === true) {
    releaseCampaignLock(lock.path)
    process.stderr.write(
      `M2_REPRO_REFUSED frozen_tree_unavailable: ${config.frozenTree}\n` +
        '  create it first, or pass --create-frozen-tree:\n' +
        `    git -C ${REPRO_ROOT} worktree add --detach ${config.frozenTree} ${String(config.frozenSha)}\n` +
        `    cd ${config.frozenTree} && bun install --frozen-lockfile\n`,
    )
    return 1
  }

  if (campaignRow === undefined) {
    appendJsonl(ledgerPath, {
      record: CAMPAIGN_RECORD,
      schemaVersion: SCHEMA_VERSION,
      campaignId: config.campaignId,
      trials: config.trials,
      parameters,
      evidenceClass: config.evidenceClass,
      frozenSha: config.frozenSha,
      frozenTree: config.frozenTree,
      driverDir: config.driverDir,
      serverRoot: config.serverRoot,
      descriptorPath: config.descriptorPath,
      seedBase: config.seedBase,
      levelPrefix: config.levelPrefix,
      deadlineMs: config.deadlineMs,
      maxRestarts: config.maxRestarts,
      startedAt: nowIso(),
      pid: process.pid,
      host: hostname(),
      hostTotalMemBytes: totalmem(),
      hostFreeMemBytes: freemem(),
      machine: { harness: 'tools/m2-reproducibility.mjs', version: SCHEMA_VERSION },
    })
  } else if (config.trials > previousTrials) {
    appendJsonl(ledgerPath, {
      record: CAMPAIGN_AMENDMENT_RECORD,
      schemaVersion: SCHEMA_VERSION,
      campaignId: config.campaignId,
      previousTrials,
      trials: config.trials,
      reason: 'planned trial count expanded; pinned source, environment, seed derivation, and run thresholds are unchanged',
      at: nowIso(),
    })
  }

  let campaignSummary = null
  try {
    const terminalFor = new Map()
    for (const row of rows) {
      if (row.record === TRIAL_RECORD && row.terminal === true) terminalFor.set(row.trialIndex, row)
    }
    const nonTerminal = rows.filter((row) => row.record === TRIAL_RECORD && row.terminal !== true)
    if (nonTerminal.length > 0) {
      log(
        `RESUME ${terminalFor.size} trial(s) already terminal; ${nonTerminal.length} interrupted record(s) ` +
          `(trial ${nonTerminal.map((row) => `${row.trialIndex}/attempt-${row.attempt}`).join(', ')}) will be retried as a NEW attempt directory: nothing is overwritten`,
      )
    }
    for (let trialIndex = 0; trialIndex < config.trials; trialIndex += 1) {
      if (terminalFor.has(trialIndex)) {
        log(`SKIP trial ${trialIndex} already terminal (${terminalFor.get(trialIndex).status})`)
        continue
      }
      const preconditions = await checkPreconditions(config, {
        mode: config.rehearse ? 'rehearse' : config.live ? 'live' : 'stage',
      })
      if (preconditions.blockers.length > 0) {
        process.stderr.write(
          `M2_REPRO_REFUSED trial=${trialIndex} preconditions:\n${preconditions.blockers.map((entry) => `  - ${entry}`).join('\n')}\n` +
            `  observations=${JSON.stringify(preconditions.observations)}\n`,
        )
        return 1
      }
      const row = await runOneTrial(config, trialIndex, log)
      terminalFor.set(trialIndex, row)
      if (row.status === 'INFRA' && config.live) {
        process.stderr.write(`M2_REPRO_STOP trial=${trialIndex} INFRA (${String(row.failureKind)}) - refusing to continue a live campaign on a broken measurement\n`)
        break
      }
    }
  } finally {
    const finalRows = readJsonl(ledgerPath)
    const summary = summarize(config.campaignId, finalRows)
    campaignSummary = summary
    writeJsonAtomic(join(config.trialsDir, SUMMARY_NAME), summary)
    writeFileSync(join(config.trialsDir, TABLE_NAME), formatReport(summary), 'utf8')
    releaseCampaignLock(lock.path)
    log(
      `SUMMARY successes=${summary.rate.successes}/${summary.rate.countable} rate=${summary.rate.value === null ? 'UNDEFINED' : summary.rate.value} ` +
        `rows=${summary.trials.terminal} summary=${join(config.trialsDir, SUMMARY_NAME)}`,
    )
    if (config.json) process.stdout.write(`${JSON.stringify(summary)}\n`)
  }
  return campaignExitCode(campaignSummary)
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`M2_REPRO_ERROR ${error?.stack ?? error}\n`)
      process.exit(2)
    })
}

export { main, runOneTrial, buildBackend, resolveConfig }
