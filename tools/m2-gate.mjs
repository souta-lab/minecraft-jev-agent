#!/usr/bin/env bun
// m2-gate: run-scoped PASS/FAIL/UNKNOWN gate for the CURRENT M2 contract
// (MILESTONE-CONTRACT.json M2 "Diamond-to-Nether-gate closed loop").
//
// The four M2 gameplay stages and the real-policy/System2 authority proof are
// judged from ONE runId only:
//   diamond_ready          <- diamond>=3 AND diamond_pickaxe in the inventory
//   portal_materials_ready <- flint_and_steel held AND obsidian>=10
//   portal_built           <- a validated 4x5 obsidian frame (portal_frame_verified)
//   portal_lit             <- PORTAL_LIT in minecraft:overworld then PORTAL_VERIFIED=true
//
// Gameplay evidence is the runtime's own markers, all bound to the single runId:
//   * the resident log, bracketed by its BOOT runId boundary: every INVENTORY /
//     MILESTONE line carries the live item counts, and the portal markers carry
//     the ordered frame -> light -> verify chain;
//   * the run-scoped snapshot `m2-snapshot-<runId>.json` (marker inventories and
//     any marker lines), the same record tools/m2-acceptance.mjs consumes.
//
// `--run <runId>` (or M2_RUN_ID) is MANDATORY. Evidence from another run is
// never attributed to R, so a run's facts can never be combined with another
// run's. Missing/unbound evidence is UNKNOWN and NEVER PASS. A known portal
// failure (shape=bad, PORTAL_LIGHT_REFUSED, PORTAL_VERIFIED=false) is FAIL.
//
// A run that merely INHERITS a pre-existing portal is a distinct UNKNOWN case,
// never a PASS: when R carries a positive portal-truth observation
// (`PORTAL_TRUTH verified=true source=live-world`, i.e. the live world / durable
// memory already held a verified portal) or a chainless `PORTAL_VERIFIED=true`,
// and R has no placed-block -> validated-frame chain of its own, the verdict is
// UNKNOWN with the explicit reason `inherited_portal`. The missing stages stay
// visible in the facts so that reason never hides a real stage gap.
// A gameplay-complete run is still UNKNOWN unless that same run proves Jev
// decisions, typesafe policy, planner=llm with deterministic fallback disabled,
// and at least one model-authored System2 portal plan.
// The old iron-age markers (PREREQ_OPTION/FURNACE_READY/SMELT_DONE) are NOT
// required: they are historical M2 evidence, not the current contract.
//
// WHERE THE RUN'S EVIDENCE IS FOUND
// ---------------------------------
// A run's facts live in the RESIDENT TREE that produced them - the checkout
// owning `buddy-driver/buddy.log`, `buddy-driver/data/resident/`,
// `buddy-driver/logs/jev/decisions.jsonl` - plus, for a supervised resident, the
// supervisor's own stdout under `<resident-tree>/runs/` (recursively, `*.out`). The gate must not
// require the operator to know that path, so it resolves evidence in this order:
//
//   1. `--log` / `--snapshot-dir` / `--decisions` / `--runner-out` (explicit, wins);
//   2. `--root <resident-tree>` (or M2_GATE_ROOT) - the same declared-root contract
//      tools/m3-acceptance-bundle.mjs documents;
//   3. the tree the gate lives in (unchanged legacy default);
//   4. EVERY OTHER git worktree of this repository, newest resident evidence first.
//      A lane resident runs from a worktree (root AGENTS.md 4.0), so `git worktree
//      list` IS the declaration of this repository's resident homes - no private
//      path, no hand-maintained registry.
//
// Discovery can only ever find the REQUESTED run's own evidence: every snapshot is
// bound by filename AND body `runId` AND its `record` field, and a log is attributed
// only inside its own `BOOT runId=R` boundary. A candidate that answers for another
// run is recorded as a mismatch, never used, so `--run B` can never be satisfied by
// run A's snapshot. Discovery never widens a stage condition and never invents a
// marker; it only decides WHICH declared file the gate is allowed to read.
//
// Exit: 0 = PASS, 1 = FAIL (known portal failure), 2 = UNKNOWN.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateCurrentM2AuthorityEvidence, loadPolicyEvidence } from './m2-policy-evidence.mjs'

export const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/
export const M2_RUN_RESULT = 'M2_RUN_RESULT'
export const M2_RUN_GATE = 'M2_RUN_GATE'
/**
 * The ordered per-source build->light->verify trace, one line per evidence
 * source (`m2_chain: source=... built=... lit=... verified=...`). The four M2
 * stage conditions above are unchanged by this line: it exists so the RUN-SCOPED
 * artifact can carry WHICH evidence source proved each link of the chain, which
 * the stage verdicts alone cannot express (a frame from the snapshot and a light
 * from the log would otherwise be indistinguishable from one complete chain).
 * tools/m2-chain-rehearsal.mjs asserts it, tools/milestone-run-artifact.mjs
 * carries it as `verdicts.M2.chain`.
 */
export const M2_RUN_CHAIN = 'm2_chain'
/** Link states for one evidence source. PASS/FAIL/UNKNOWN, mirroring the stage grammar. */
export const CHAIN_LINK_STATES = Object.freeze(['PASS', 'FAIL', 'UNKNOWN'])

/** The four contract stages, in dependency order. */
export const M2_REQUIRED_STAGES = Object.freeze([
  'diamond_ready',
  'portal_materials_ready',
  'portal_built',
  'portal_lit',
])

/**
 * Marker names emitted by the portal runtime (netherPortalPlan.ts:37-45) plus
 * `PORTAL_TRUTH`, the resident's live-world / durable-memory portal verdict
 * (buddy-driver/generation-entry.ts). PORTAL_TRUTH carries NO build chain: it
 * only ever reports that a verified portal already existed.
 */
export const PORTAL_MARKERS = Object.freeze([
  'PORTAL_BLOCK_PLACED',
  'PORTAL_FRAME_READY',
  'PORTAL_LIT',
  'PORTAL_VERIFIED',
  'PORTAL_LIGHT_REFUSED',
  'PORTAL_TRUTH',
])

/** Explicit UNKNOWN reason for a run that inherited a portal instead of making one. */
export const INHERITED_PORTAL_REASON = 'inherited_portal'

/** A valid obsidian frame needs at least the 10 edge blocks (corners optional). */
export const PORTAL_OBSIDIAN_REQUIRED = 10
export const DIAMOND_READY_COUNT = 3
export const MATERIALS_OBSIDIAN_REQUIRED = 10
export const OVERWORLD = 'minecraft:overworld'
export const DIAMOND = 'diamond'
export const DIAMOND_PICKAXE = 'diamond_pickaxe'
export const FLINT_AND_STEEL = 'flint_and_steel'
export const OBSIDIAN = 'obsidian'
/** matcher for the run-scoped snapshot record written by buddy-driver/m2-snapshot.ts */
export const M2_GATE_SNAPSHOT_RECORD = 'm2-snapshot'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(TOOLS_DIR)
export const M2_GATE_LOG =
  process.env.M2_GATE_LOG ?? process.env.M2_LOG ?? process.env.BUDDY_LOG ?? join(REPO_ROOT, 'buddy-driver', 'buddy.log')
export const M2_GATE_SNAPSHOT_DIR =
  process.env.M2_GATE_SNAPSHOT_DIR ?? process.env.M2_SNAPSHOT_DIR ?? join(REPO_ROOT, 'buddy-driver', 'data', 'resident')
export const M2_GATE_DECISIONS =
  process.env.M2_DECISIONS ?? join(REPO_ROOT, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl')
export const M2_GATE_RUNNER_OUT =
  process.env.M2_RUNNER_OUT ?? join(REPO_ROOT, 'buddy-driver', 'runner.out')
export const M2_GATE_CONTROL_SOCK =
  process.env.M2_CONTROL_SOCK ?? join(REPO_ROOT, 'buddy-driver', 'data', 'resident', 'control.sock')

/** Declared resident tree (`--root` / M2_GATE_ROOT); null = the gate's own tree. */
export const M2_GATE_ROOT = process.env.M2_GATE_ROOT ?? null
/**
 * How many declared resident homes discovery may open. This machine has 100+
 * worktrees but only the trees that actually ran a resident carry a log, so the
 * bound is a safety valve, not a tuning knob: the home list is ordered
 * newest-resident-evidence-first and homes with no resident artifact are dropped
 * before the limit applies.
 */
export const M2_GATE_HOME_LIMIT = Number.parseInt(process.env.M2_GATE_HOME_LIMIT ?? '8', 10)
/** How many supervisor `.out` files per home are considered, newest first. */
export const M2_GATE_SUPERVISOR_OUT_LIMIT = Number.parseInt(process.env.M2_GATE_SUPERVISOR_OUT_LIMIT ?? '4', 10)

/**
 * The evidence paths a declared resident tree owns. Mirrors `derivePaths()` in
 * tools/milestone-run-artifact.mjs (the shared convention used by
 * tools/m3-acceptance-bundle.mjs `--root`); tools/test-m2-gate.mjs asserts the two
 * agree so the contract cannot drift apart.
 */
export function residentPaths(root) {
  const base = join(root, 'buddy-driver')
  return {
    root,
    logPath: join(base, 'buddy.log'),
    snapshotDir: join(base, 'data', 'resident'),
    decisionsPath: join(base, 'logs', 'jev', 'decisions.jsonl'),
    runnerOutPath: join(base, 'runner.out'),
    controlSocketPath: join(base, 'data', 'resident', 'control.sock'),
  }
}

function safeMtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** The supervisor's own stdout for a home: `<home>/runs/` recursively, `*.out`, newest first. */
export function listSupervisorOuts(home, { limit = M2_GATE_SUPERVISOR_OUT_LIMIT } = {}) {
  const runsDir = join(home, 'runs')
  const found = []
  const walk = (dir, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.out')) found.push(full)
    }
  }
  walk(runsDir, 0)
  return found
    .map((path) => ({ path, mtimeMs: safeMtimeMs(path) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.path)
}

/** The repo's declared resident homes, from git itself (`git worktree list`). */
export function listGitWorktreeRoots({ cwd = REPO_ROOT, spawn = defaultGitSpawn } = {}) {
  const proc = spawn(['git', 'worktree', 'list', '--porcelain'], cwd)
  if (proc === null || proc.exitCode !== 0) return []
  const out = typeof proc.stdout === 'string' ? proc.stdout : ''
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((path) => path.length > 0)
}

function defaultGitSpawn(cmd, cwd) {
  try {
    if (typeof Bun === 'undefined' || typeof Bun.spawnSync !== 'function') return null
    const proc = Bun.spawnSync({ cmd, cwd, stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString('utf8') }
  } catch {
    return null
  }
}

/** How fresh this home's resident evidence is; the newest of its own artifacts. */
export function homeEvidenceFreshness(home, { mtimeMs = safeMtimeMs } = {}) {
  const paths = residentPaths(home)
  return Math.max(
    mtimeMs(paths.logPath),
    mtimeMs(paths.runnerOutPath),
    mtimeMs(paths.decisionsPath),
    mtimeMs(paths.snapshotDir),
    mtimeMs(join(home, 'runs')),
  )
}

/** A home is worth opening only when it owns at least one resident artifact. */
export function homeHasResidentEvidence(home, { mtimeMs = safeMtimeMs } = {}) {
  return homeEvidenceFreshness(home, { mtimeMs }) > 0
}

/**
 * The ordered declared homes the gate may read: the primary tree (declared
 * `--root`, else the gate's own tree) first, then this repository's other git
 * worktrees, homes with no resident artifact dropped and the rest ordered
 * newest-evidence-first so the run's own tree is examined before stale lanes.
 */
export function declaredResidentHomes({
  primaryRoot = M2_GATE_ROOT ?? REPO_ROOT,
  discover = false,
  homes = null,
  listWorktrees = listGitWorktreeRoots,
  hasEvidence = homeHasResidentEvidence,
  freshness = homeEvidenceFreshness,
  limit = M2_GATE_HOME_LIMIT,
} = {}) {
  const ordered = []
  const push = (root) => {
    if (typeof root === 'string' && root.length > 0 && !ordered.includes(root)) ordered.push(root)
  }
  push(primaryRoot)
  if (discover && homes === null) {
    const others = listWorktrees()
      .filter((root) => root !== primaryRoot)
      .filter((root) => hasEvidence(root))
    others.sort((a, b) => freshness(b) - freshness(a) || a.localeCompare(b))
    for (const root of others) push(root)
  }
  for (const root of Array.isArray(homes) ? homes : []) push(root)
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 8
  return ordered.slice(0, Math.max(1, cap))
}

/**
 * Every place the gate is allowed to look for run R's evidence, in order. Each
 * list is independently run-bound downstream, so a longer list can only find
 * R's own evidence - it can never combine facts across runs.
 */
export function evidenceCandidates({
  primaryRoot = M2_GATE_ROOT ?? REPO_ROOT,
  discover = false,
  homes = null,
  logPath = null,
  snapshotDir = null,
  decisionsPath = null,
  runnerOutPath = null,
  listWorktrees = listGitWorktreeRoots,
  supervisorOuts = listSupervisorOuts,
} = {}) {
  const roots = declaredResidentHomes({ primaryRoot, discover, homes, listWorktrees })
  const perHome = roots.map((root) => {
    const paths = residentPaths(root)
    return { root, paths, outs: supervisorOuts(root) }
  })
  const snapshotDirs = snapshotDir !== null ? [snapshotDir] : perHome.map((home) => home.paths.snapshotDir)
  const logCandidates = logPath !== null ? [logPath] : []
  // A supervised resident's stdout is NOT buddy.log: the supervisor captures it
  // under runs/. It is a declared path of the same tree, so it is a legitimate
  // log source - offered after the tree's own buddy.log, never instead of it.
  for (const home of perHome) {
    logCandidates.push(home.paths.logPath)
    for (const out of home.outs) logCandidates.push(out)
  }
  // The authority window comes from the same streams: runner.out when a detached
  // resident wrote it, buddy.log (which carries the identical BOOT lines), then the
  // supervisor's own capture. Deduped, order preserved.
  const policyCandidates = []
  const pushPolicy = (path) => {
    if (typeof path === 'string' && path.length > 0 && !policyCandidates.includes(path)) policyCandidates.push(path)
  }
  pushPolicy(runnerOutPath)
  for (const home of perHome) {
    pushPolicy(home.paths.runnerOutPath)
    pushPolicy(home.paths.logPath)
    for (const out of home.outs) pushPolicy(out)
  }
  const decisionsCandidates =
    decisionsPath !== null ? [decisionsPath] : perHome.map((home) => home.paths.decisionsPath)
  const controlSocketCandidates =
    perHome.map((home) => home.paths.controlSocketPath)
  return { roots, perHome, snapshotDirs, logCandidates, policyCandidates, decisionsCandidates, controlSocketCandidates }
}

const POS_RE = /pos=(-?\d+),(-?\d+),(-?\d+)/

const INVENTORY_RE = /\b(?:items|inventory)=(\{[^{}]*\})/

/**
 * `dimension=<id>` observations inside a run-bound line. Additive: the M3 gate
 * reports the dimension it observed, while the M2 stages ignore this field.
 */
const DIMENSION_RE = /\bdimension=(minecraft:[a-z_]+|[a-z_]+)\b/
/**
 * The ONLY markers that report the BODY's own dimension (buddy-driver/dimension-observer.ts):
 * `DIMENSION_OBSERVED` at generation start and `DIMENSION_TRANSITION` on a live change, whose
 * `dimension=` is the canonical current field. Every other marker that happens to carry a
 * `dimension=` field names something else - the portal's own dimension (PORTAL_LIT,
 * PORTAL_VERIFIED, PORTAL_SITE_RECHECK), a route TARGET (PORTAL_ENTRY_UNVERIFIED
 * `dimension=minecraft:the_nether expected=6`), a death location, a spawn or a structure site -
 * and must never prove the body reached that dimension. Measured false PASS: a run whose only
 * `the_nether` occurrence was a PORTAL_ENTRY_UNVERIFIED target line was gated
 * `nether_reached: PASS` while every body observation said `minecraft:overworld`.
 */
const BODY_DIMENSION_MARKER_RE = /\b(?:DIMENSION_OBSERVED|DIMENSION_TRANSITION|SPAWN|DEATH)\b/

function currentInventoryObservationFromReport(value, reportRunId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const counts = asCounts(value.counts)
  if (
    value.record !== 'current-inventory-observation' ||
    value.schemaVersion !== 1 ||
    value.runId !== reportRunId ||
    typeof value.sourceSha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.sourceSha) ||
    typeof value.observedAtMs !== 'number' || !Number.isFinite(value.observedAtMs) ||
    typeof value.observedAt !== 'string' ||
    Date.parse(value.observedAt) !== value.observedAtMs ||
    counts === null ||
    Object.values(counts).some((count) => !Number.isInteger(count) || count < 0)
  ) return null
  return {
    record: value.record,
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    sourceSha: value.sourceSha.toLowerCase(),
    generationId: typeof value.generationId === 'string' ? value.generationId : null,
    observedAtMs: value.observedAtMs,
    observedAt: value.observedAt,
    worldKey: value.worldKey !== null && typeof value.worldKey === 'object' && !Array.isArray(value.worldKey) ? value.worldKey : null,
    dimension: typeof value.dimension === 'string' ? value.dimension : null,
    counts,
  }
}

/** Read-only current-run binding used only to bound live policy evidence. */
// Resident report can take longer than a short CLI probe while generations are
// recovering from model outages. A timeout here makes a live run look unbounded
// and turns valid model-authority evidence into UNKNOWN, so match the observer's
// 5-second control-socket budget.
export async function readPolicySocketBinding(sockPath = M2_GATE_CONTROL_SOCK, timeoutMs = 5000) {
  if (!existsSync(sockPath)) return null
  return await new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket?.destroy() } catch {}
      resolve(value)
    }
    try {
      socket = net.createConnection(sockPath)
    } catch {
      return finish(null)
    }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const reply = JSON.parse(buffer.slice(0, newline))
        const data = reply?.data ?? reply
        const runId = typeof data?.runId === 'string' ? data.runId : null
        if (runId === null) return finish(null)
        const status = data?.status
        const rawWorldKey = data?.worldKey
        const worldKey = rawWorldKey !== null && typeof rawWorldKey === 'object' && !Array.isArray(rawWorldKey)
          ? rawWorldKey
          : null
        // generationHash/generationId/frozen are ADDITIVE: they let a reader
        // cross-check the live generation against file evidence (the host's
        // `report` reply already carries them, so no extra query is issued and
        // nothing here mutates the resident). `run.boot.sourceSha` remains the
        // run's origin; the binding never replaces it.
        const rawGenerationId = data?.generationId
        const generationId = Array.isArray(rawGenerationId)
          ? (typeof rawGenerationId[0] === 'string' ? rawGenerationId[0] : null)
          : typeof rawGenerationId === 'string'
            ? rawGenerationId
            : null
        finish({
          runId,
          currentInventoryObservation: currentInventoryObservationFromReport(data?.currentInventoryObservation, runId),
          // The terminal inventory's worldKey is joined against this same
          // synchronous HOST report snapshot. Its dimension can lag the live
          // bot dimension across a portal transition; serverId/worldEpoch are
          // the report-level identity fields used by the M3 gate.
          worldKey,
          policyKind: typeof status?.policyKind === 'string' ? status.policyKind : typeof data?.policyKind === 'string' ? data.policyKind : null,
          policyProvider: typeof status?.policyProvider === 'string' ? status.policyProvider : typeof data?.policyProvider === 'string' ? data.policyProvider : null,
          policyModel: typeof status?.policyModel === 'string' ? status.policyModel : typeof data?.policyModel === 'string' ? data.policyModel : null,
          generationHash: typeof data?.generationHash === 'string' ? data.generationHash : null,
          generationId,
          frozen: typeof data?.frozen === 'boolean' ? data.frozen : null,
        })
      } catch {
        finish(null)
      }
    })
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'm2-gate', cmd: 'report' })}\n`))
  })
}

// ---------------------------------------------------------------------------
// marker parsing
// ---------------------------------------------------------------------------

/**
 * Parse one runtime line into a portal marker event, or null. The markers are
 * matched by their full shape (not just a name) so a name alone can never claim
 * `shape=ok` or `PORTAL_VERIFIED=true`.
 */
export function parsePortalMarker(line) {
  if (typeof line !== 'string') return null
  const verified = /\bPORTAL_VERIFIED=(true|false)\b/.exec(line)
  if (verified !== null) return { name: 'PORTAL_VERIFIED', verified: verified[1] === 'true' }
  const truth = /\bPORTAL_TRUTH\b/.exec(line)
  if (truth !== null) {
    const truthVerified = /\bverified=(true|false)\b/.exec(line)
    const reason = /\breason=(\S+)/.exec(line)
    const source = /\bsource=(\S+)/.exec(line)
    return {
      name: 'PORTAL_TRUTH',
      verified: truthVerified === null ? null : truthVerified[1] === 'true',
      ...(reason === null ? {} : { reason: reason[1] }),
      ...(source === null ? {} : { source: source[1] }),
    }
  }
  const frame = /\bPORTAL_FRAME_READY\b/.exec(line)
  if (frame !== null) {
    const blocks = /\bblocks=(\d+)/.exec(line)
    const shape = /\bshape=(ok|bad)\b/.exec(line)
    const pos = POS_RE.exec(line)
    return {
      name: 'PORTAL_FRAME_READY',
      blocks: blocks === null ? null : Number(blocks[1]),
      shape: shape === null ? null : shape[1],
      ...(pos === null ? {} : { pos: [Number(pos[1]), Number(pos[2]), Number(pos[3])] }),
    }
  }
  const lit = /\bPORTAL_LIT\b/.exec(line)
  if (lit !== null) {
    const pos = POS_RE.exec(line)
    const dimension = /\bdimension=(\S+)/.exec(line)
    return {
      name: 'PORTAL_LIT',
      ...(pos === null ? {} : { pos: [Number(pos[1]), Number(pos[2]), Number(pos[3])] }),
      ...(dimension === null ? {} : { dimension: dimension[1] }),
    }
  }
  if (/\bPORTAL_LIGHT_REFUSED\b/.test(line)) return { name: 'PORTAL_LIGHT_REFUSED' }
  const placed = /\bPORTAL_BLOCK_PLACED\b/.exec(line)
  if (placed !== null) {
    const pos = POS_RE.exec(line)
    return { name: 'PORTAL_BLOCK_PLACED', ...(pos === null ? {} : { pos: [Number(pos[1]), Number(pos[2]), Number(pos[3])] }) }
  }
  return null
}

/** A flat item-count map, or null when the JSON is not a plain number map. */
export function asCounts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const counts = {}
  for (const [item, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) return null
    counts[item] = count
  }
  return counts
}

/** Parse the live item counts out of an INVENTORY / MILESTONE / M2_SNAPSHOT line. */
export function parseInventoryMarker(line) {
  if (typeof line !== 'string') return null
  const match = INVENTORY_RE.exec(line)
  if (match === null) return null
  let parsed
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  return asCounts(parsed)
}

function normalizeDimension(dimension) {
  return typeof dimension === 'string' ? dimension.replace(/^minecraft:/, '').toLowerCase() : null
}

/** Parse only the resident's explicit body-dimension transition event. */
function parseBodyDimensionTransition(line) {
  const markerIndex = line.indexOf('DIMENSION_TRANSITION')
  if (markerIndex === -1) return null
  const fields = line.slice(markerIndex)
  const field = (name) => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(fields)?.[1] ?? null
  const from = field('from')
  const to = field('to')
  const dimension = field('dimension')
  const source = field('source')
  if (from === null || to === null || dimension === null || source !== 'live-world') return null
  if (normalizeDimension(to) !== normalizeDimension(dimension)) return null
  const timestamp = /^\[([^\]]+)\]/.exec(line)?.[1] ?? null
  const atMs = timestamp === null ? null : Date.parse(timestamp)
  if (!Number.isFinite(atMs)) return null
  return {
    from,
    to,
    dimension,
    source,
    reason: field('reason'),
    atMs,
    ...(timestamp === null ? {} : { ts: timestamp }),
  }
}

// ---------------------------------------------------------------------------
// ordered chain + known failures
// ---------------------------------------------------------------------------

/**
 * The ordered portal chain inside one evidence source: at least one block placed,
 * then a validated frame (shape=ok, blocks >= 10), then the light, then a true
 * verification. `litDimension` is the dimension reported by the PORTAL_LIT line.
 *
 * `litObserved`/`verifiedObserved` split the links the stage conditions fold
 * together (`litVerified` still means "lit AND verified", unchanged): they let
 * the run-scoped artifact report built/lit/verified separately without touching
 * any stage verdict. `frameBlocks`/`frameShape` are the qualifying frame event's
 * own values, reported verbatim (never re-derived).
 */
export function evaluatePortalChain(events) {
  const seq = Array.isArray(events) ? events : []
  const placed = seq.findIndex((event) => event?.name === 'PORTAL_BLOCK_PLACED')
  const frame = seq.findIndex(
    (event) =>
      event?.name === 'PORTAL_FRAME_READY' &&
      event.shape === 'ok' &&
      Number.isFinite(event.blocks) &&
      event.blocks >= PORTAL_OBSIDIAN_REQUIRED,
  )
  const frameVerified = placed !== -1 && frame !== -1 && frame > placed
  let lit = -1
  let verified = -1
  if (frameVerified) {
    lit = seq.findIndex((event, index) => index > frame && event?.name === 'PORTAL_LIT')
    if (lit !== -1) {
      verified = seq.findIndex(
        (event, index) => index > lit && event?.name === 'PORTAL_VERIFIED' && event.verified === true,
      )
    }
  }
  const litVerified = frameVerified && lit !== -1 && verified !== -1
  const litDimension = lit === -1 ? null : seq[lit].dimension ?? null
  const frameEvent = frame === -1 ? null : seq[frame]
  return {
    frameVerified,
    litVerified,
    litObserved: frameVerified && lit !== -1,
    verifiedObserved: frameVerified && lit !== -1 && verified !== -1,
    litDimension,
    frameBlocks: frameEvent !== null && Number.isFinite(frameEvent.blocks) ? frameEvent.blocks : null,
    frameShape: frameEvent !== null && typeof frameEvent.shape === 'string' ? frameEvent.shape : null,
    indices: { placed, frame, lit, verified },
  }
}

/**
 * Project ONE evidence source's chain onto the three links the M2 contract names
 * (`portal_built` / `portal_lit` / `portal_verified`). Pure; the stage conditions
 * are computed from the union across sources exactly as before, so this function
 * can never widen or narrow a verdict - it only names the evidence.
 */
export function portalChainLink(source) {
  const chain = source?.chain ?? null
  const failure = source?.failure ?? null
  const frameVerified = chain?.frameVerified === true
  const litObserved = chain?.litObserved === true
  const verifiedObserved = chain?.verifiedObserved === true
  const built = frameVerified ? 'PASS' : failure === 'portal_frame_shape_bad' ? 'FAIL' : 'UNKNOWN'
  const lit =
    litObserved ? 'PASS' : failure === 'portal_light_refused' || failure === 'portal_verify_false' ? 'FAIL' : 'UNKNOWN'
  const verified = verifiedObserved ? 'PASS' : failure === 'portal_verify_false' ? 'FAIL' : 'UNKNOWN'
  const litDimension = chain?.litDimension ?? null
  return {
    source: typeof source?.name === 'string' ? source.name : 'none',
    built,
    lit,
    verified,
    ordered: frameVerified && litObserved && verifiedObserved,
    // The gate's `portal_lit` stage additionally requires the overworld (a lit
    // frame in the Nether is a different fact). Reported, never re-judged here.
    overworld: litObserved ? normalizeDimension(litDimension) === normalizeDimension(OVERWORLD) : null,
    blocks: chain?.frameBlocks ?? null,
    shape: chain?.frameShape ?? null,
    dimension: litDimension,
    indices: chain?.indices ?? { placed: -1, frame: -1, lit: -1, verified: -1 },
  }
}

/** Render one chain link as the single-line evidence record the artifact parses. */
export function formatPortalChainLine(link) {
  const indices = link?.indices ?? { placed: -1, frame: -1, lit: -1, verified: -1 }
  const ordered = [indices.placed, indices.frame, indices.lit, indices.verified].map((index) =>
    Number.isFinite(index) ? index : -1,
  )
  return (
    `${M2_RUN_CHAIN}: source=${link?.source ?? 'none'} built=${link?.built ?? 'UNKNOWN'} ` +
    `lit=${link?.lit ?? 'UNKNOWN'} verified=${link?.verified ?? 'UNKNOWN'} ordered=${link?.ordered === true} ` +
    `overworld=${link?.overworld === true ? 'true' : link?.overworld === false ? 'false' : 'unknown'} ` +
    `blocks=${Number.isFinite(link?.blocks) ? link.blocks : 'none'} shape=${typeof link?.shape === 'string' ? link.shape : 'none'} ` +
    `dimension=${typeof link?.dimension === 'string' && link.dimension.length > 0 ? link.dimension : 'none'} ` +
    `indices=${ordered.join(',')}`
  )
}

/**
 * Parse a `m2_chain:` line back into a link record. Returns null for any other
 * line, so a reader can never mistake a different marker for chain evidence.
 */
export function parsePortalChainLine(line) {
  if (typeof line !== 'string' || !line.startsWith(`${M2_RUN_CHAIN}:`)) return null
  const field = (name) => new RegExp(`\\b${name}=(\\S+)`).exec(line)?.[1] ?? null
  const state = (name) => {
    const value = field(name)
    return CHAIN_LINK_STATES.includes(value) ? value : null
  }
  const source = field('source')
  const built = state('built')
  const lit = state('lit')
  const verified = state('verified')
  if (source === null || built === null || lit === null || verified === null) return null
  const rawIndices = (field('indices') ?? '').split(',').map((value) => Number(value))
  const indices =
    rawIndices.length === 4 && rawIndices.every((value) => Number.isFinite(value))
      ? { placed: rawIndices[0], frame: rawIndices[1], lit: rawIndices[2], verified: rawIndices[3] }
      : { placed: -1, frame: -1, lit: -1, verified: -1 }
  const blocks = Number(field('blocks'))
  const overworldToken = field('overworld')
  return {
    source,
    built,
    lit,
    verified,
    ordered: field('ordered') === 'true',
    overworld: overworldToken === 'true' ? true : overworldToken === 'false' ? false : null,
    blocks: Number.isFinite(blocks) ? blocks : null,
    shape: field('shape') === 'none' ? null : field('shape'),
    dimension: field('dimension') === 'none' ? null : field('dimension'),
    indices,
  }
}

/** A known terminal portal failure in this evidence, or null. */
export function detectPortalFailure(events) {
  const seq = Array.isArray(events) ? events : []
  if (seq.some((event) => event?.name === 'PORTAL_FRAME_READY' && event.shape !== 'ok')) return 'portal_frame_shape_bad'
  if (seq.some((event) => event?.name === 'PORTAL_LIGHT_REFUSED')) return 'portal_light_refused'
  if (seq.some((event) => event?.name === 'PORTAL_VERIFIED' && event.verified === false)) return 'portal_verify_false'
  return null
}

/**
 * A positive portal observation in R that is NOT backed by R's own build chain,
 * or null. `PORTAL_TRUTH verified=true` is the resident's live-world / durable
 * memory verdict: the world already held a verified portal. A `PORTAL_VERIFIED=true`
 * with `chain.frameVerified !== true` is the same "already exists" claim straight
 * from the runtime verifier. This never produces a PASS by itself; the caller
 * combines it with `!framePass` and reports `inherited_portal`.
 */
export function detectInheritedPortal(events, chain = null) {
  if (chain?.frameVerified === true) return null
  const seq = Array.isArray(events) ? events : []
  const truth = seq.find((event) => event?.name === 'PORTAL_TRUTH' && event.verified === true)
  if (truth !== undefined) {
    return { kind: 'live_world_truth', source: truth.source ?? null, reason: truth.reason ?? null }
  }
  const verified = seq.find((event) => event?.name === 'PORTAL_VERIFIED' && event.verified === true)
  if (verified !== undefined) return { kind: 'runtime_verified_without_build_chain', source: null, reason: null }
  return null
}

// ---------------------------------------------------------------------------
// the four stage conditions (facts are joined only inside ONE runId)
// ---------------------------------------------------------------------------

/** diamond_ready = diamond>=3 AND a diamond_pickaxe observed in the same run. */
export function evaluateDiamondReady(samples) {
  const list = Array.isArray(samples) ? samples : []
  const hasDiamond = list.some((counts) => (counts?.[DIAMOND] ?? 0) >= DIAMOND_READY_COUNT)
  const hasDiamondPickaxe = list.some((counts) => (counts?.[DIAMOND_PICKAXE] ?? 0) >= 1)
  return { ready: hasDiamond && hasDiamondPickaxe, hasDiamond, hasDiamondPickaxe }
}

/** portal_materials_ready = flint_and_steel held AND obsidian>=10 in the same run. */
export function evaluateMaterialsReady(samples) {
  const list = Array.isArray(samples) ? samples : []
  const hasFlintAndSteel = list.some((counts) => (counts?.[FLINT_AND_STEEL] ?? 0) >= 1)
  const hasObsidian = list.some((counts) => (counts?.[OBSIDIAN] ?? 0) >= MATERIALS_OBSIDIAN_REQUIRED)
  return { ready: hasFlintAndSteel && hasObsidian, hasFlintAndSteel, hasObsidian }
}

function unknownConditions() {
  return {
    diamond_ready: 'UNKNOWN',
    portal_materials_ready: 'UNKNOWN',
    portal_built: 'UNKNOWN',
    portal_lit: 'UNKNOWN',
  }
}

function verdict({
  status,
  code,
  reason,
  runId,
  conditions,
  evidence = null,
  sources = null,
  facts = null,
  sourceSha = null,
  sourceShaReason = null,
  sourceShaMismatch = null,
}) {
  return { id: 'M2', status, code, reason, runId, sourceSha, sourceShaReason, sourceShaMismatch, conditions, evidence, sources, facts }
}

/**
 * Pure run-scoped M2 verdict. PASS (0) only when all four stages are proven from
 * R-bound markers. A known portal failure is FAIL (1). Everything else is
 * UNKNOWN (2) and can never be PASS.
 */
export function evaluateM2Gate({ expectedRunId = null, evidence = null, policy = null } = {}) {
  if (expectedRunId === null || !RUN_ID_RE.test(String(expectedRunId))) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: 'exact_run_scope_required',
      runId: expectedRunId,
      conditions: unknownConditions(),
      sourceShaReason: 'run_boot_source_unavailable',
    })
  }
  if (evidence === null || typeof evidence !== 'object' || evidence.status !== 'valid') {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: evidence?.reason ?? 'm2_evidence_unavailable',
      runId: expectedRunId,
      conditions: unknownConditions(),
      evidence: evidence?.status ?? 'unavailable',
      sources: evidence?.sources ?? null,
      sourceSha: evidence?.sourceSha ?? null,
      sourceShaReason: evidence?.sourceShaReason ?? null,
      sourceShaMismatch: evidence?.sourceShaMismatch ?? null,
    })
  }

  // M2 is a source-specific acceptance gate: runId alone cannot prove which
  // checkout produced the gameplay evidence. Require the one valid SHA parsed
  // from this run's BOOT line(s), and refuse any cross-source mismatch before
  // evaluating stages (including a known gameplay FAIL).
  const sourceSha = typeof evidence.sourceSha === 'string' && BOOT_SOURCE_SHA_RE.test(evidence.sourceSha)
    ? evidence.sourceSha.toLowerCase()
    : null
  const sourceShaReason = evidence.sourceShaReason ?? (sourceSha === null
    ? (evidence.sourceSha == null ? 'run_source_sha_missing' : 'run_source_sha_invalid')
    : null)
  const sourceShaMismatch = evidence.sourceShaMismatch ?? null
  if (sourceSha === null || sourceShaReason !== null || sourceShaMismatch !== null) {
    const identityReason = sourceShaMismatch !== null
      ? 'run_source_sha_mismatch'
      : `run_source_sha_unavailable:${sourceShaReason ?? 'run_source_sha_missing'}`
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: identityReason,
      runId: expectedRunId,
      conditions: unknownConditions(),
      evidence: evidence.status,
      sources: evidence.sources ?? null,
      sourceSha,
      sourceShaReason,
      sourceShaMismatch,
    })
  }

  const sources = Array.isArray(evidence.sources) ? evidence.sources : []
  const samples = sources.flatMap((source) => (Array.isArray(source.inventorySamples) ? source.inventorySamples : []))
  const diamond = evaluateDiamondReady(samples)
  const materials = evaluateMaterialsReady(samples)

  const perSource = sources.map((source) => {
    const chain = evaluatePortalChain(source.portalEvents)
    return {
      name: source.name,
      path: source.path,
      chain,
      failure: detectPortalFailure(source.portalEvents),
      inherited: detectInheritedPortal(source.portalEvents, chain),
    }
  })
  const framePass = perSource.some((source) => source.chain.frameVerified)
  const litPass = perSource.some(
    (source) => source.chain.litVerified && normalizeDimension(source.chain.litDimension) === normalizeDimension(OVERWORLD),
  )
  const frameFail = !framePass && perSource.some((source) => source.failure === 'portal_frame_shape_bad')
  const litFail =
    !litPass && perSource.some((source) => source.failure === 'portal_light_refused' || source.failure === 'portal_verify_false')
  // Inherited: R observed an already-verified portal but built no chain of its own.
  const inheritedObservations = perSource
    .filter((source) => source.inherited !== null)
    .map((source) => ({ source: source.name, ...source.inherited }))
  const inheritedPortal = !framePass && inheritedObservations.length > 0

  const conditions = {
    diamond_ready: diamond.ready ? 'PASS' : 'UNKNOWN',
    // Satisfied by the observed materials OR by the observed frame: a run can finish the
    // gate without ever holding ten obsidian in one sample (the live M3 run continued a
    // partially built frame - one edge already present - holding nine). Those ten edges
    // ARE the obsidian, so requiring a single-sample count would fail a run whose OUTCOME
    // is what M2 asks for.
    portal_materials_ready: materials.ready || framePass ? 'PASS' : 'UNKNOWN',
    portal_built: framePass ? 'PASS' : frameFail ? 'FAIL' : 'UNKNOWN',
    portal_lit: litPass ? 'PASS' : litFail ? 'FAIL' : 'UNKNOWN',
  }
  const missing = M2_REQUIRED_STAGES.filter((stage) => conditions[stage] !== 'PASS')
  // The ordered per-source chain trace. Purely additive reporting: every stage
  // condition above is computed from the same per-source facts exactly as before.
  const chain = perSource.map((source) => portalChainLink(source))
  const facts = {
    diamond,
    materials,
    framePass,
    litPass,
    missing,
    inheritedPortal: { detected: inheritedPortal, observations: inheritedObservations },
    chain,
    policy: policy?.facts ?? null,
  }
  const allPass = Object.values(conditions).every((value) => value === 'PASS')
  const failureReason = conditions.portal_built === 'FAIL'
    ? 'portal_frame_shape_bad'
    : conditions.portal_lit === 'FAIL'
      ? 'portal_not_verified'
      : null
  if (failureReason !== null) {
    return verdict({
      status: 'FAIL',
      code: 1,
      reason: failureReason,
      runId: expectedRunId,
      conditions,
      sources: perSource,
      facts,
      sourceSha,
    })
  }
  if (allPass && policy?.code !== 0) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: `policy_evidence_unverified:${policy?.reason ?? 'unavailable'}`,
      runId: expectedRunId,
      conditions,
      sources: perSource,
      facts,
      sourceSha,
    })
  }
  if (allPass) {
    return verdict({
      status: 'PASS',
      code: 0,
      reason: 'diamond_to_nether_gate_verified',
      runId: expectedRunId,
      conditions,
      sources: perSource,
      facts,
      sourceSha,
    })
  }
  // Inherited-portal case (b): R saw an already-verified portal but produced no
  // build chain of its own. Never PASS; report the explicit reason.
  if (inheritedPortal) {
    return verdict({
      status: 'UNKNOWN',
      code: 2,
      reason: INHERITED_PORTAL_REASON,
      runId: expectedRunId,
      conditions,
      sources: perSource,
      facts,
      sourceSha,
    })
  }
  return verdict({
    status: 'UNKNOWN',
    code: 2,
    reason: `m2_stages_incomplete:${missing.join(',')}`,
    runId: expectedRunId,
    conditions,
    sources: perSource,
    facts,
    sourceSha,
  })
}

// ---------------------------------------------------------------------------
// evidence readers (all bound to ONE runId)
// ---------------------------------------------------------------------------

function runIdOfLine(line) {
  return typeof line === 'string' ? /\brunId=(run-[A-Za-z0-9-]+)/.exec(line)?.[1] ?? null : null
}

function isBootLine(line) {
  return typeof line === 'string' && /\bBOOT\b(?!_)/.test(line)
}

const BOOT_SOURCE_SHA_RE = /^[0-9a-f]{40}$/i

function sourceShaFromBootLine(line) {
  const raw = /\bsource=(\S+)/.exec(line)?.[1] ?? null
  if (raw === null) return { sourceSha: null, sourceShaReason: 'run_source_sha_missing' }
  if (!BOOT_SOURCE_SHA_RE.test(raw)) return { sourceSha: null, sourceShaReason: 'run_source_sha_invalid' }
  return { sourceSha: raw.toLowerCase(), sourceShaReason: null }
}

function resolveBootSourceSha(records) {
  if (records.length === 0) return { sourceSha: null, sourceShaReason: 'run_boot_source_unavailable' }
  const unavailable = records.find((record) => record.sourceSha === null)
  if (unavailable !== undefined) return { sourceSha: null, sourceShaReason: unavailable.sourceShaReason }
  const shas = new Set(records.map((record) => record.sourceSha))
  if (shas.size !== 1) return { sourceSha: null, sourceShaReason: 'run_source_sha_ambiguous' }
  return { sourceSha: records[0].sourceSha, sourceShaReason: null }
}

/**
 * Attribute every portal marker and inventory sample to exactly one run. A BOOT
 * line opens a run boundary; a line without `runId=` belongs to the active
 * (most recent) BOOT, as in tools/m2-watch.mjs. Foreign-run lines are never
 * attributed to R. Returns `unknown` when NO line can be attributed to R, so an
 * unreadable/unscoped run can never produce a PASS.
 */
export function scanRunLines(runId, lines) {
  const portalEvents = []
  const inventorySamples = []
  const dimensionObservations = []
  const dimensionTransitions = []
  const foreignRuns = new Set()
  const bootSources = []
  let activeRunId = null
  let bootSeen = false
  for (const line of Array.isArray(lines) ? lines : []) {
    const bootRunId = isBootLine(line) ? runIdOfLine(line) : null
    if (bootRunId !== null) {
      activeRunId = bootRunId
      if (bootRunId === runId) {
        bootSeen = true
        bootSources.push(sourceShaFromBootLine(line))
      }
    }
    // A marker's own runId field is not a lifetime boundary. Only the real
    // BOOT line may open R; otherwise a copied/stale marker cannot prove R
    // existed. Once R is active, however, an explicitly foreign marker still
    // belongs to that other run and must not be borrowed by R.
    const owningRunId = activeRunId
    if (owningRunId !== runId) {
      const foreign = runIdOfLine(line) ?? owningRunId
      if (foreign !== null) foreignRuns.add(foreign)
      continue
    }
    const markerRunId = runIdOfLine(line)
    if (!isBootLine(line) && markerRunId !== null && markerRunId !== runId) {
      foreignRuns.add(markerRunId)
      continue
    }
    const portal = parsePortalMarker(line)
    if (portal !== null) portalEvents.push(portal)
    const inventory = parseInventoryMarker(line)
    if (inventory !== null) inventorySamples.push(inventory)
    const dimension = BODY_DIMENSION_MARKER_RE.test(line) ? DIMENSION_RE.exec(line) : null
    if (dimension !== null) dimensionObservations.push(dimension[1])
    if (/\bDIMENSION_TRANSITION\b/.test(line)) {
      const transition = parseBodyDimensionTransition(line)
      if (transition !== null) dimensionTransitions.push(transition)
    }
  }
  if (!bootSeen) {
    return {
      status: 'unknown',
      reason: `run_boundary_missing runId=${runId}`,
      portalEvents: [],
      inventorySamples: [],
      dimensionObservations: [],
      dimensionTransitions: [],
      sourceSha: null,
      sourceShaReason: 'run_boot_boundary_missing',
    }
  }
  return {
    status: 'valid',
    portalEvents,
    inventorySamples,
    dimensionObservations,
    dimensionTransitions,
    foreignRuns: [...foreignRuns],
    ...resolveBootSourceSha(bootSources),
  }
}

/** Read and scan the resident log for run R's markers. */
export async function readM2Log(runId, { logPath = M2_GATE_LOG } = {}) {
  if (!existsSync(logPath)) {
    return {
      status: 'unavailable',
      path: logPath,
      portalEvents: [],
      inventorySamples: [],
      dimensionObservations: [],
      dimensionTransitions: [],
      sourceSha: null,
      sourceShaReason: 'run_log_unavailable',
    }
  }
  const lines = []
  const rl = createInterface({ input: createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) lines.push(line)
  return { ...scanRunLines(runId, lines), path: logPath }
}

function snapshotPortalEvents(snapshot) {
  const events = []
  for (const marker of Array.isArray(snapshot?.markers) ? snapshot.markers : []) {
    if (marker === null || typeof marker !== 'object') continue
    if (typeof marker.line === 'string') {
      const parsed = parsePortalMarker(marker.line)
      if (parsed !== null) {
        events.push(Number.isFinite(marker.atMs) ? { ...parsed, atMs: marker.atMs } : parsed)
        continue
      }
    }
    if (typeof marker.name !== 'string' || !PORTAL_MARKERS.includes(marker.name)) continue
    const event = { name: marker.name }
    for (const key of ['blocks', 'shape', 'verified', 'dimension', 'pos']) {
      if (marker[key] !== undefined && marker[key] !== null) event[key] = marker[key]
    }
    if (Number.isFinite(marker.atMs)) event.atMs = marker.atMs
    events.push(event)
  }
  return events
}

function snapshotInventorySamples(snapshot) {
  const samples = []
  const initial = asCounts(snapshot?.initialInventory)
  if (initial !== null) samples.push(initial)
  for (const marker of Array.isArray(snapshot?.markers) ? snapshot.markers : []) {
    const counts = asCounts(marker?.inventory)
    if (counts !== null) samples.push(counts)
  }
  const latest = asCounts(snapshot?.inventory)
  if (latest !== null) samples.push(latest)
  const terminal = asCounts(snapshot?.terminal?.inventory)
  if (terminal !== null) samples.push(terminal)
  return samples
}

/** Read the run-scoped snapshot `m2-snapshot-<runId>.json` for run R only. */
export function readM2Snapshot(runId, { snapshotDir = M2_GATE_SNAPSHOT_DIR } = {}) {
  const path = `${snapshotDir}/${M2_GATE_SNAPSHOT_RECORD}-${runId}.json`
  if (!existsSync(path)) return { status: 'unavailable', path, portalEvents: [], inventorySamples: [] }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { status: 'unknown', path, portalEvents: [], inventorySamples: [], reason: `snapshot_unreadable ${path}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unknown', path, portalEvents: [], inventorySamples: [], reason: `snapshot_malformed ${path}` }
  }
  if (parsed.record !== M2_GATE_SNAPSHOT_RECORD) {
    return {
      status: 'unknown',
      path,
      portalEvents: [],
      inventorySamples: [],
      reason: `snapshot_record_mismatch expected=${M2_GATE_SNAPSHOT_RECORD} observed=${String(parsed.record)}`,
    }
  }
  if (parsed.runId !== runId) {
    return {
      status: 'unknown',
      path,
      portalEvents: [],
      inventorySamples: [],
      reason: `snapshot_run_mismatch expected=${runId} observed=${typeof parsed.runId === 'string' ? parsed.runId : 'unknown'}`,
    }
  }
  return {
    status: 'valid',
    path,
    bootSourceSha: parsed.bootSourceSha ?? null,
    portalEvents: snapshotPortalEvents(parsed),
    inventorySamples: snapshotInventorySamples(parsed),
  }
}

/**
 * Resolve every run-scoped M2 source for R. Each source is independently
 * attributed to R; a foreign/unknown source is recorded as a mismatch and never
 * used. Returns `valid` only when at least one R-bound source carries evidence.
 *
 * `snapshotDirs` / `logCandidates` are the ADDITIVE multi-home forms used by
 * discovery: the first candidate that carries R's own evidence answers, and every
 * candidate that refuses (a foreign runId, a malformed record, no BOOT boundary)
 * is recorded as a mismatch with its path. A single `snapshotDir` / `logPath`
 * still behaves exactly as before, so an explicit operator path is never widened.
 */
export async function readRunScopedM2Evidence(
  runId,
  { logPath = M2_GATE_LOG, snapshotDir = M2_GATE_SNAPSHOT_DIR, snapshotDirs = null, logCandidates = null } = {},
) {
  const sources = []
  const mismatches = []
  const bootSourceRecords = []
  let selectedSnapshot = null
  const dirs = Array.isArray(snapshotDirs) && snapshotDirs.length > 0 ? snapshotDirs : [snapshotDir]
  let snapshotTaken = false
  for (const dir of dirs) {
    const snapshot = readM2Snapshot(runId, { snapshotDir: dir })
    if (snapshot.status === 'valid' && (snapshot.portalEvents.length > 0 || snapshot.inventorySamples.length > 0)) {
      sources.push({
        name: 'snapshot',
        path: snapshot.path,
        portalEvents: snapshot.portalEvents,
        inventorySamples: snapshot.inventorySamples,
        // M2 snapshots record portal facts, whose `dimension` describes the portal
        // event. They do not contain body-dimension transitions and cannot prove
        // that the resident entered the Nether.
        dimensionObservations: [],
        dimensionTransitions: [],
      })
      snapshotTaken = true
      selectedSnapshot = snapshot
      break
    }
    if (snapshot.status === 'unknown') mismatches.push(snapshot.reason)
    else if (snapshot.status === 'valid' && !snapshotTaken) mismatches.push(`snapshot_without_evidence ${snapshot.path}`)
  }
  const logPaths = Array.isArray(logCandidates) && logCandidates.length > 0 ? logCandidates : [logPath]
  const seenLogs = new Set()
  for (const candidate of logPaths) {
    if (typeof candidate !== 'string' || candidate.length === 0 || seenLogs.has(candidate)) continue
    seenLogs.add(candidate)
    const log = await readM2Log(runId, { logPath: candidate })
    if (log.status === 'valid') bootSourceRecords.push({ sourceSha: log.sourceSha ?? null, sourceShaReason: log.sourceShaReason ?? 'run_source_sha_unavailable' })
    if (log.status === 'valid' && (log.portalEvents.length > 0 || log.inventorySamples.length > 0 || log.dimensionTransitions.length > 0)) {
      sources.push({
        name: 'log',
        path: log.path,
        portalEvents: log.portalEvents,
        inventorySamples: log.inventorySamples,
        dimensionObservations: log.dimensionObservations ?? [],
        dimensionTransitions: log.dimensionTransitions ?? [],
      })
      break
    }
    // A candidate that exists but holds no line attributable to R is not an error -
    // it is simply not this run's log. Only a broken boundary is worth recording.
    if (log.status === 'unknown') mismatches.push(log.reason)
  }
  const runSource = resolveBootSourceSha(bootSourceRecords)
  let sourceShaMismatch = null
  let sourceShaReason = runSource.sourceShaReason
  if (selectedSnapshot !== null && sourceShaReason === null) {
    const rawSnapshotSha = selectedSnapshot.bootSourceSha
    const snapshotSha = typeof rawSnapshotSha === 'string' && BOOT_SOURCE_SHA_RE.test(rawSnapshotSha)
      ? rawSnapshotSha.toLowerCase()
      : null
    if (snapshotSha !== runSource.sourceSha) {
      sourceShaReason = 'run_source_sha_snapshot_mismatch'
      sourceShaMismatch = {
        expected: runSource.sourceSha,
        observed: snapshotSha ?? (rawSnapshotSha == null ? 'missing' : 'invalid'),
        snapshotPath: selectedSnapshot.path,
      }
    }
  }
  if (sources.length === 0) {
    return {
      status: mismatches.length > 0 ? 'unknown' : 'unavailable',
      runId,
      sources: [],
      mismatches,
      reason: mismatches[0] ?? 'no_run_scoped_m2_evidence',
      ...runSource,
    }
  }
  return {
    status: 'valid',
    runId,
    sources,
    mismatches,
    sourceSha: runSource.sourceSha,
    sourceShaReason,
    sourceShaMismatch,
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

export function requestedRunId(argv = process.argv.slice(2), env = process.env) {
  let value = env.M2_RUN_ID ?? null
  const index = argv.indexOf('--run')
  if (index !== -1) value = argv[index + 1] ?? null
  if (value === null || String(value).trim() === '') return null
  const runId = String(value).trim()
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid --run value: ${value}`)
  return runId
}

/** Preserve order, drop empties and repeats. */
function uniquePaths(paths) {
  const out = []
  for (const path of paths) {
    if (typeof path === 'string' && path.length > 0 && !out.includes(path)) out.push(path)
  }
  return out
}

export async function runM2Gate({
  expectedRunId = null,
  readEvidence = null,
  // `null` means "not given by the caller": resolve it from the declared
  // `--root` / discovery / the gate's own tree. An explicit path is used alone.
  logPath = null,
  snapshotDir = null,
  // Declared resident tree (`--root`, or M2_GATE_ROOT). null = the gate's own tree.
  root = M2_GATE_ROOT,
  // Discover this repository's other git worktrees as candidate resident homes.
  discover = false,
  homes = null,
  listWorktrees = listGitWorktreeRoots,
  policyEvidence = null,
  loadPolicy = loadPolicyEvidence,
  policySocket = undefined,
  controlSocketPath = M2_GATE_CONTROL_SOCK,
  decisionsPath = null,
  runnerOutPath = null,
  now = () => new Date(),
  write = (line) => process.stdout.write(`${line}\n`),
  json = false,
  // ADDITIVE (schema-neutral): an assembler such as tools/milestone-run-artifact.mjs
  // needs the STRUCTURED verdict (conditions + facts) the gate already computed, not
  // a regex over its human lines. Returning it here never changes the verdict, the
  // printed lines, or the exit code - `runM2Gate` still returns the numeric code so
  // the CLI contract (`process.exitCode = await runM2Gate(...)`) is unchanged.
  onResult = null,
} = {}) {
  const stamp = now().toISOString()
  const primaryRoot = root ?? REPO_ROOT
  const plan = evidenceCandidates({
    primaryRoot,
    discover,
    homes,
    logPath,
    snapshotDir,
    decisionsPath,
    runnerOutPath,
    listWorktrees,
  })
  const resolveEvidence =
    readEvidence ??
    ((runId) =>
      readRunScopedM2Evidence(runId, {
        logPath: logPath ?? plan.logCandidates[0] ?? M2_GATE_LOG,
        snapshotDir: snapshotDir ?? plan.snapshotDirs[0] ?? M2_GATE_SNAPSHOT_DIR,
        logCandidates: plan.logCandidates,
        snapshotDirs: plan.snapshotDirs,
      }))
  const scoped = expectedRunId !== null && RUN_ID_RE.test(String(expectedRunId))
  const evidence = scoped ? await resolveEvidence(expectedRunId) : null
  let rawPolicy = policyEvidence
  let policyVerdict = null
  let policyUsed = null
  const policyAttempts = []
  if (scoped && rawPolicy === null) {
    const socketBinding = policySocket === undefined
      ? await readPolicySocketBinding(controlSocketPath)
      : policySocket
    // The run binding is bracketed by the `BOOT ... runId=R` line. The resident is
    // normally started detached, so `runner.out` often does not exist at all (the
    // supervisor writes elsewhere) while `buddy.log` carries the identical
    // `[ISO] BOOT ... runId=...` lines. Without this fallback every verdict degraded to
    // UNKNOWN with reason=decisions_evidence_unavailable, i.e. the run-scoped policy
    // evidence was unavailable for a reason that had nothing to do with the run.
    //
    // A stream that EXISTS is not the same as a stream that carries R: a worktree
    // resident leaves a `runner.out` belonging to a different run generation while
    // `buddy.log` holds R's BOOT boundary, and the supervisor captures R's stdout in
    // `runs/*.out`. So every declared stream is tried in order and the first one that
    // yields R's own bounded window AND a verified authority verdict answers; the
    // attempts are reported. Each attempt is run-bound by loadPolicyEvidence itself,
    // so trying more streams can never attribute another run's decisions to R.
    const groups = plan.perHome.map((home, index) => ({
      root: home.root,
      streams: uniquePaths(
        index === 0 && runnerOutPath !== null
          ? [runnerOutPath, home.paths.runnerOutPath, home.paths.logPath, ...home.outs]
          : [home.paths.runnerOutPath, home.paths.logPath, ...home.outs],
      ),
      decisionsPath: decisionsPath ?? home.paths.decisionsPath,
    }))
    for (const group of groups) {
      for (const stream of group.streams) {
        if (!existsSync(stream)) {
          policyAttempts.push({ root: group.root, stream, status: 'absent' })
          continue
        }
        const loaded = await loadPolicy({
          runId: expectedRunId,
          socket: socketBinding?.runId === expectedRunId ? socketBinding : null,
          decisionsPath: group.decisionsPath,
          runnerOutPath: stream,
        })
        const evaluated = evaluateCurrentM2AuthorityEvidence({
          expectedRunId,
          decisions: loaded?.decisions ?? null,
          generation: loaded?.generation ?? null,
          system2: loaded?.system2 ?? null,
        })
        policyAttempts.push({
          root: group.root,
          stream,
          decisionsPath: group.decisionsPath,
          status: loaded?.reason === null || loaded?.reason === undefined ? 'window' : String(loaded.reason),
          verdict: evaluated.status,
          verdictReason: evaluated.reason,
        })
        if (policyVerdict === null) {
          rawPolicy = loaded
          policyVerdict = evaluated
          policyUsed = { root: group.root, stream, decisionsPath: group.decisionsPath }
        }
        if (evaluated.code === 0) {
          rawPolicy = loaded
          policyVerdict = evaluated
          policyUsed = { root: group.root, stream, decisionsPath: group.decisionsPath }
          break
        }
      }
      if (policyVerdict !== null && policyVerdict.code === 0) break
    }
  }
  const policy = scoped
    ? policyVerdict ??
      evaluateCurrentM2AuthorityEvidence({
        expectedRunId,
        decisions: rawPolicy?.decisions ?? null,
        generation: rawPolicy?.generation ?? null,
        system2: rawPolicy?.system2 ?? null,
      })
    : null
  const result = evaluateM2Gate({ expectedRunId, evidence, policy })
  if (typeof onResult === 'function') onResult(result)
  const evidenceRoots = {
    homes: plan.roots,
    discover,
    declaredRoot: root,
    snapshotFrom: (evidence?.sources ?? []).find((source) => source.name === 'snapshot')?.path ?? null,
    logFrom: (evidence?.sources ?? []).find((source) => source.name === 'log')?.path ?? null,
    policyFrom: policyUsed,
    policyAttempts,
  }

  if (json) {
    write(
      JSON.stringify({
        id: result.id,
        status: result.status,
        reason: result.reason,
        runId: result.runId,
        sourceSha: result.sourceSha,
        sourceShaReason: result.sourceShaReason,
        sourceShaMismatch: result.sourceShaMismatch,
        conditions: result.conditions,
        evidence: evidence === null ? null : {
          status: evidence.status,
          sources: (evidence.sources ?? []).map((s) => s.name),
          sourceSha: evidence.sourceSha ?? null,
          sourceShaReason: evidence.sourceShaReason ?? null,
          sourceShaMismatch: evidence.sourceShaMismatch ?? null,
        },
        policy: policy === null ? null : { status: policy.status, reason: policy.reason },
        inheritedPortal: result.facts?.inheritedPortal ?? null,
        chain: result.facts?.chain ?? null,
        evidenceRoots,
        facts: result.facts ?? null,
      }),
    )
    return result.code
  }

  write(`${M2_RUN_GATE} — ${stamp}`)
  write(`expectedRunId: ${expectedRunId ?? 'none'}`)
  write(
    `m2_source_sha: boot=${result.sourceSha ?? 'unknown'} reason=${result.sourceShaReason ?? 'none'}` +
      (result.sourceShaMismatch === null ? '' : ` expected=${result.sourceShaMismatch.expected} observed=${result.sourceShaMismatch.observed}`),
  )
  if (evidence !== null) {
    const sourceNames = (evidence.sources ?? []).map((source) => source.name).join(',')
    write(`m2_evidence: ${evidence.status} sources=${sourceNames || 'none'}${evidence.reason ? ` reason=${evidence.reason}` : ''}`)
  }
  for (const stage of M2_REQUIRED_STAGES) write(`${stage}: ${result.conditions[stage]}`)
  if (policy !== null) write(`policy: ${policy.status} reason=${policy.reason}`)
  if (result.facts !== null) {
    write(
      `m2_facts: diamond=${result.facts.diamond.hasDiamond} diamond_pickaxe=${result.facts.diamond.hasDiamondPickaxe} ` +
        `flint_and_steel=${result.facts.materials.hasFlintAndSteel} obsidian=${result.facts.materials.hasObsidian} ` +
        `frame=${result.facts.framePass} lit=${result.facts.litPass}`,
    )
    if (result.facts.inheritedPortal?.detected) {
      write(
        `m2_inherited_portal: true observations=${result.facts.inheritedPortal.observations.length} ` +
          `kinds=${result.facts.inheritedPortal.observations.map((observation) => observation.kind).join(',')}`,
      )
    }
    write(`m2_missing: ${result.facts.missing.length > 0 ? result.facts.missing.join(',') : 'none'}`)
  }
  // WHERE the evidence came from, so a verdict is auditable without re-deriving the
  // path: the declared homes examined and which file answered each source.
  write(
    `m2_evidence_roots: homes=${evidenceRoots.homes.length} discover=${evidenceRoots.discover} ` +
      `snapshot_from=${evidenceRoots.snapshotFrom ?? 'none'} log_from=${evidenceRoots.logFrom ?? 'none'} ` +
      `policy_from=${evidenceRoots.policyFrom?.stream ?? 'none'}`,
  )
  // One typed, ordered built->lit->verified trace per evidence source. Printed on
  // EVERY path (including unscoped/unavailable evidence) so a reader can always
  // tell "no chain was looked for" (`source=none`) apart from "a chain was looked
  // for and this source did not prove it".
  const chain = Array.isArray(result.facts?.chain) ? result.facts.chain : []
  if (chain.length === 0) write(formatPortalChainLine({ source: 'none' }))
  for (const link of chain) write(formatPortalChainLine(link))
  write(
    `${M2_RUN_RESULT} status=${result.status} reason=${result.reason} runId=${expectedRunId ?? 'none'} sourceSha=${result.sourceSha ?? 'unknown'} ` +
      `diamond=${result.conditions.diamond_ready} materials=${result.conditions.portal_materials_ready} ` +
      `frame=${result.conditions.portal_built} lit=${result.conditions.portal_lit}`,
  )
  return result.code
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    log: null,
    snapshotDir: null,
    decisions: null,
    runnerOut: null,
    controlSocket: null,
    root: null,
    discover: true,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--run') i += 1
    else if (arg === '--log') out.log = argv[++i] ?? null
    else if (arg === '--snapshot-dir') out.snapshotDir = argv[++i] ?? null
    else if (arg === '--decisions') out.decisions = argv[++i] ?? null
    else if (arg === '--runner-out') out.runnerOut = argv[++i] ?? null
    else if (arg === '--control-socket') out.controlSocket = argv[++i] ?? null
    else if (arg === '--root') out.root = argv[++i] ?? null
    else if (arg === '--no-discover') out.discover = false
    else if (arg === '--json') out.json = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const expectedRunId = requestedRunId(process.argv.slice(2), process.env)
    const options = {
      expectedRunId,
      json: args.json,
      // null = "not given": resolve from --root / discovery / this tree. An explicit
      // path is used alone, exactly as before.
      logPath: args.log,
      snapshotDir: args.snapshotDir,
      decisionsPath: args.decisions,
      runnerOutPath: args.runnerOut,
      controlSocketPath: args.controlSocket ?? M2_GATE_CONTROL_SOCK,
      root: args.root ?? M2_GATE_ROOT,
      // A run's evidence is found without the operator naming a private path: the
      // declared root first, then this repository's other git worktrees (see the
      // header). --no-discover restricts the search to the declared root alone.
      discover: args.discover,
    }
    process.exitCode = await runM2Gate(options)
  } catch (error) {
    process.stderr.write(`M2_GATE_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
