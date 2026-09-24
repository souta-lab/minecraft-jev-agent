// agent-runner.mts - the HOST. It owns the one long-lived Mineflayer connection
// and swaps the reloadable intelligence (a hash-stamped Bun.build bundle) without
// ever reconnecting.
//
//   HOST (never reloaded): createBot + plugins, reconnect backoff, logger,
//          durable state mirror (buddy-state.json), control socket, reload arbiter
//   GENERATION (swapped): the jev-agent controller + planner, bundled to ONE file
//
// Launch (detached, survives the shell):
//   cd /home/s0u7a/mc-ai/buddy-driver && setsid nohup bun agent-runner.mts \
//     </dev/null > runner.out 2>&1 &
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { execSync } from 'node:child_process'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import mineflayer from 'mineflayer'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { buildGeneration } from './build.mts'
import type {
  AcceptanceRecord,
  ActuationLease,
  AgentSnapshot,
  DeathHazard,
  DeathRecoveryContext,
  GenerationContext,
  GenerationModule,
  GenerationResourceCounts,
  GenerationStatus,
  HazardSource,
  ResidentGeneration,
  ResidentWorldMemory,
  StructuralSmokeResult,
  Vec3Json,
  WorldKey,
  WorldMemoryDelta,
} from './resident-types.ts'
import { emptyWorldMemory, normalizeWorldMemory, worldKeyString } from './resident-types.ts'
import { milestoneReport } from './milestone-report.ts'
import { MilestonePredicateRecorder } from './milestone-predicates.ts'
import { ModelAvailabilityTracker, modelRecoveryStartGate } from './model-recovery.ts'
import { normalizeStation } from './station-memory.ts'
import {
  capturePreLossInventory,
  createPreLossInventoryTracker,
  parseRehearsalMode,
  recordRehearsalHazard,
  shouldRegisterHazard,
  type DeathTelemetry,
  type RehearsalMode,
} from './simdeath.ts'
import {
  commitPendingProposals,
  mergeWorldMemoryDelta,
  newPendingProposals,
  stageLedgerProposal,
  stageLedgerReconciliation,
  stageWorldMemory,
  writeSnapshotAtomic,
} from './proposal-staging.ts'
import type { PendingProposals } from './proposal-staging.ts'
import { ActuationLeaseManager, GenerationResourceRegistry, ReconnectLedger, type DisconnectReason } from './resident-safety.ts'
import type { GoalQueueSnapshot } from '../jev-agent/src/goalQueue.ts'
import { isHostileEntityName } from '../jev-agent/src/state.ts'
import { AGENT_SNAPSHOT_SCHEMA_VERSION, goalQueueSnapshotFromState } from './state-snapshot.ts'
import { commitOwner, swapGeneration, type OwnershipPorts, type SwapGeneration, type SwapPorts } from './generation-swap.ts'
import { commitLedgerProposal } from './ledger-guard.ts'
import { connectAfterGenerationValidation, generationModuleReadinessError } from './generation-connection-gate.ts'
import {
  HostDurabilityLedger,
  HostLock,
  closeControlServer,
  createFatalHandlers,
  createStateWriter,
  defaultPidAlive,
  loadStateWithQuarantine,
  openResidentBoot,
  runShutdownSequence,
  shutdownExitCodeForReason,
  type DurableWriteOutcome,
  type HostLockOutcome,
  type HostLockReport,
} from './host-durability.ts'
import { ReloadArbiter } from './reload-arbiter.ts'
import { acceptsWorldMemoryProposal, resetWorldEpoch } from './world-epoch.ts'
import {
  RESPAWN_INVENTORY_POLL_MS,
  RESPAWN_INVENTORY_SETTLE_MS,
  settleInventoryAfterRespawn,
  shouldSettleRespawnInventory,
} from './inventory-settle.ts'

const CONTRACT_VERSION = 3
const STATE_SCHEMA_VERSION = AGENT_SNAPSHOT_SCHEMA_VERSION
const LISTENER_EVENTS = [
  'physicsTick',
  'goal_reached',
  'goal_updated',
  'path_update',
  'blockUpdate',
  'entitySpawn',
  'health',
  'playerCollect',
  'death',
  'end',
  'kicked',
] as const

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data', 'resident')
const LOGS = join(HERE, 'logs')
const JEV_LOGS = join(LOGS, 'jev')
const FREEZE_DIR = join(LOGS, 'resident')
const LEDGER = join(HERE, 'buddy-ledger.json')
const STATE_PATH = join(HERE, 'buddy-state.json')
const LOG_PATH = join(HERE, 'buddy.log')
const SOCK = join(DATA, 'control.sock')
const LOCK_PATH = join(DATA, 'host.lock')
const MC_AI = dirname(HERE)
const JEV_SRC = join(MC_AI, 'jev-agent', 'src')

const HOST = '127.0.0.1'
const PORT = 25565
const USERNAME = process.env.BUDDY_USERNAME ?? 'AI_Buddy'
const VERSION = '1.21.11'
const HEARTBEAT_MS = 15000
const OBSERVE_MS = 1500
const RELOAD_DEBOUNCE_MS = 1200
const GEN_RESTART_MS = 3000
const LISTENER_BASELINE_POLL_MS = 25
const LISTENER_BASELINE_MAX_POLLS = 200
const GOAL_ITEM = 'iron_ingot'
const GOAL_COUNT = 3

// The generation scheduler owns these bot listeners in the default resident
// configuration.  The HOST must not capture its leak baseline until this set
// is attached; otherwise deterministic bootstrap (which awaits its plan
// before scheduler.start()) makes a healthy generation look like a leak.
const GENERATION_SCHEDULER_EVENTS = ['goal_reached', 'blockUpdate', 'entitySpawn', 'health', 'playerCollect'] as const

for (const dir of [DATA, LOGS, JEV_LOGS, FREEZE_DIR]) mkdirSync(dir, { recursive: true })

// ---------------------------------------------------------------------------
// logging (structured, append-only, also to stdout for runner.out)
// ---------------------------------------------------------------------------
function fmtValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function log(event: string, detail?: Record<string, unknown>): void {
  const parts: string[] = []
  for (const [key, value] of Object.entries(detail ?? {})) parts.push(`${key}=${fmtValue(value)}`)
  const line = `[${new Date().toISOString()}] ${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`
  try {
    appendFileSync(LOG_PATH, `${line}\n`)
  } catch {
    // never let logging kill the resident
  }
  process.stdout.write(`${line}\n`)
}

function fmtPos(pos: Vec3Json | null): string {
  if (pos === null) return '?'
  return `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`
}

function shortInv(inv: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, n] of Object.entries(inv)) {
    if (n > 0) out[name] = n
  }
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// durable state mirror (in-memory is the truth; tmp -> rename is the mirror)
// ---------------------------------------------------------------------------
const SERVER_ID = `${HOST}:${PORT}`

function normalizeDimension(dimension: string | undefined): string {
  if (dimension === undefined || dimension.length === 0) return 'minecraft:overworld'
  if (dimension.includes(':')) return dimension
  return `minecraft:${dimension}`
}

function currentWorldKey(): WorldKey {
  return { serverId: state.serverId, dimension: state.dimension, worldEpoch: state.worldEpoch }
}

function keyedMemory(): ResidentWorldMemory {
  const key = worldKeyString(currentWorldKey())
  const existing = state.worldMemoryByKey[key]
  if (existing !== undefined) return normalizeWorldMemory(existing)
  const created = emptyWorldMemory()
  state.worldMemoryByKey[key] = created
  return created
}

function cloneMemory(memory: ResidentWorldMemory): ResidentWorldMemory {
  const normal = normalizeWorldMemory(memory)
  return {
    craftingTables: normal.craftingTables.map((station) => normalizeStation(station, 'crafting_table')),
    furnaces: normal.furnaces.map((station) => normalizeStation(station, 'furnace')),
    mined: { ...normal.mined },
    discoveredOres: [...normal.discoveredOres],
    knownResources: normal.knownResources.map((resource) => ({ ...resource })),
    knownPortalSites: normal.knownPortalSites.map((site) => ({ ...site })),
    // M3: the live path must carry structure sites too. This one-line omission is
    // exactly how `knownPortalSites` was silently dropped on every reload before
    // #80 — a field the canonical merge handled but the generation seed forgot.
    knownStructureSites: normal.knownStructureSites.map((site) => ({
      ...site,
      ...(site.blocks === undefined ? {} : { blocks: [...site.blocks] }),
    })),
    // #354: the durable traversal facts must ride the generation seed too, or the
    // candidate consumer never sees the remembered connectivity (the #80 omission
    // class this clone exists to prevent).
    knownTraversals: normal.knownTraversals.map((traversal) => ({
      ...traversal,
      from: { ...traversal.from },
      to: { ...traversal.to },
    })),
    traversalFailures: normal.traversalFailures.map((t) => ({ ...t, from: { ...t.from }, toward: { ...t.toward } })),
    moveFailures: normal.moveFailures.map((entry) => ({ ...entry })),
    // #oscillation-boundary: the durable local-motion record must ride the
    // generation seed, or a reload would restart the very count it exists to
    // keep (the #80 omission class this clone exists to prevent).
    localOscillation:
      normal.localOscillation === undefined || normal.localOscillation === null
        ? null
        : { ...normal.localOscillation, cells: [...normal.localOscillation.cells] },
    // The durable cross-action repeat ledger must ride the generation seed too,
    // or a reload would restart the very count this clone exists to keep (the
    // #80 omission class this clone exists to prevent).
    repeatedOutcomes: normal.repeatedOutcomes.map((entry) => ({ ...entry })),
    hazards: normal.hazards.map((h) => ({ ...h })),
  }
}

function defaultState(): AgentSnapshot {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    worldEpoch: 1,
    generationId: null,
    bot: USERNAME,
    serverId: SERVER_ID,
    dimension: 'minecraft:overworld',
    levelName: null,
    firstSeenAt: Date.now(),
    updatedAt: Date.now(),
    milestoneIndex: -1,
    milestone: null,
    ledger: null,
    worldMemoryByKey: {},
    generations: 0,
    reloads: 0,
    recoveries: 0,
    lastGenerationId: null,
    actions: 0,
  }
}

/**
 * P0 durability evidence mirror (#379/#388/#378/#381). Every durability outcome is
 * recorded here with the SAME marker that is logged, so `acceptance-<runId>.json`
 * and the control `report` can show the run's write-failure / quarantine /
 * lock-reclaim / lock-loss / fatal-shutdown markers (#63 evidence taxonomy).
 */
const durability = new HostDurabilityLedger()

/**
 * #388: an unparseable or newer-schema state file is QUARANTINED (moved aside with
 * the reason recorded) instead of being replaced by defaults and then overwritten
 * by the boot commit. A rejected file that cannot be moved aside refuses boot:
 * committing defaults over the only copy of durable memory is not acceptable.
 */
function loadState(): AgentSnapshot {
  const base = defaultState()
  const outcome = loadStateWithQuarantine({ statePath: STATE_PATH, base, log, durability })
  if (outcome.blocked) {
    log('BOOT_REFUSED', { reason: 'state-unreadable-and-not-quarantinable', path: STATE_PATH, action: 'exit' })
    process.exit(1)
  }
  return outcome.snapshot
}

let state = loadState()

/**
 * Issue #48: revision at which the authoritative ledger was last committed by an
 * accepted generation proposal. A generation is seeded with `state.revision` and
 * the guard rejects any proposal based on a ledger lineage older than this.
 */
let ledgerRevision = state.revision

/**
 * Issue #40: the HOST is the only writer of class-A state. Every commit bumps the
 * revision and writes tmp -> rename atomically. A stale/foreign schema is coerced
 * (and logged) rather than silently accepted.
 *
 * #379: the commit returns a REPORTED outcome. The revision advances only when the
 * bytes landed; a failed write rolls the in-memory commit marker back, removes the
 * half-written tmp file and emits STATE_WRITE_FAILED, so no caller can report a
 * durable commit that never happened.
 */
const stateWriter = createStateWriter({
  path: STATE_PATH,
  state: () => state,
  log,
  durability,
  expectedSchemaVersion: STATE_SCHEMA_VERSION,
  suffix: `.${process.pid}.tmp`,
  write: (path, snapshot, suffix) => writeSnapshotAtomic(path, snapshot, suffix),
})

function saveState(event = 'save'): DurableWriteOutcome {
  return stateWriter.save(event)
}

const pendingByGeneration = new Map<string, PendingProposals>()

/** Host-only rewrite of the derived ledger mirror (class C) from the committed
 * class-A snapshot. The generation never writes this file (#5). */
function writeLedgerMirror(): void {
  if (state.ledger === null) return
  try {
    const tmp = `${LEDGER}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state.ledger, null, 2)}\n`)
    renameSync(tmp, LEDGER)
  } catch (error) {
    log('ERROR', { where: 'writeLedgerMirror', message: error instanceof Error ? error.message : String(error) })
  }
}

/** Host-only archive of an inconsistent derived ledger (#5 reconcile proposal). */
function archiveReconciledLedger(reason: string): void {
  archiveLedger(`reconcile:${reason}`)
}

/**
 * A ledger proposal is only allowed from the generation the HOST currently owns:
 * the leased action owner, falling back to the committed snapshot owner when the
 * lease has already been revoked (a stopped generation's final flush). #49 tracks
 * making the two fields identical at every stable point.
 */
function allowedGenerationId(): string | null {
  if (leaseManager.activeId.length > 0) return leaseManager.activeId
  return state.generationId
}

/**
 * Issue #48: a generation PROPOSES its authoritative ledger; the HOST validates
 * identity + lineage revision and is the only writer. A stale/foreign/future
 * proposal is rejected and logged; the store is left untouched.
 *
 * #379: the lineage revision advances ONLY when the ledger commit actually landed.
 * A failed durable write keeps `ledgerRevision` where it was (fail closed: the next
 * proposal is still validated against the last durable lineage).
 */
function onGenerationLedgerProposal(proposal: unknown, source: string): void {
  let persisted = true
  const decision = commitLedgerProposal(
    state,
    proposal,
    { revision: state.revision, ledgerRevision, generationId: allowedGenerationId() },
    log,
    (event) => {
      persisted = saveState(event).ok
    },
    source,
  )
  if (decision.ok && persisted) {
    ledgerRevision = state.revision
  } else if (decision.ok && !persisted) {
    log('LEDGER_COMMIT_NOT_DURABLE', {
      source,
      revision: state.revision,
      ledgerRevision,
      action: 'ledger-revision-not-advanced',
    })
  }
}

/**
 * HOST-initiated ledger sample (heartbeat). The HOST is the sole writer, so this
 * is not subject to the generation proposal guard and does not advance the
 * generation lineage revision - it must never invalidate a live generation.
 */
function commitHostLedger(ledger: GoalQueueSnapshot, source: string): void {
  state.ledger = ledger
  writeLedgerMirror()
  saveState(`ledger-host:${source}`)
}

/**
 * Live world-memory delta from the active (non-speculative) generation. The
 * world-key guard rejects a proposal stamped with a superseded key, then the
 * single canonical merge (`mergeWorldMemoryDelta`) is applied and committed. The
 * staged commit point uses the SAME merge, so a field added to `WorldMemoryDelta`
 * can never be persisted on one path and dropped on the other (#80 regression).
 */
function applyWorldMemoryDelta(delta: WorldMemoryDelta, sourceWorldKey: WorldKey): void {
  const currentKey = currentWorldKey()
  if (!acceptsWorldMemoryProposal(sourceWorldKey, currentKey)) {
    log('WORLDMEMORY_REJECTED', { reason: 'world-key-mismatch', sourceWorldKey, currentWorldKey: currentKey })
    return
  }
  mergeWorldMemoryDelta(keyedMemory(), delta, log)
  saveState('world-memory')
}

/** Issue #5 commit point: apply staged proposals only after ownership is committed. */
function commitStagedProposals(generationId: string, event: string): void {
  const pending = pendingByGeneration.get(generationId)
  if (pending === undefined) {
    saveState(event)
    return
  }
  const result = commitPendingProposals(
    {
      pending,
      memory: keyedMemory(),
      state,
      guard: {
        revision: state.revision,
        committedGenerationId: state.generationId,
        activeGenerationId: leaseManager.activeId,
        ledgerRevision,
      },
      log,
      save: (evt) => saveState(evt),
      reconcileLedger: archiveReconciledLedger,
      writeLedgerMirror,
      worldKey: currentWorldKey(),
    },
    event,
  )
  if (result.ledgerApplied && result.writeOk) ledgerRevision = state.revision
  log('PROPOSALS_COMMITTED', {
    generationId,
    event,
    worldMemoryDeltas: result.worldMemoryDeltasApplied,
    ledgerApplied: result.ledgerApplied,
    ledgerRejected: result.ledgerRejected,
    reconciliationRequested: result.reconciliationRequested,
    writes: result.writes,
    writeOk: result.writeOk,
    writeError: result.writeError,
  })
  pendingByGeneration.delete(generationId)
}

/** Merge a death coordinate. The HOST is the only writer; two deaths at the same
 * rounded coordinate make the hazard permanent (`count >= 2`). */
function hazardKey(h: { x: number; y: number; z: number }): string {
  return `${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.z)}`
}

function mergeHazard(target: DeathHazard[], found: DeathHazard): DeathHazard {
  if (found.source === 'simulation') {
    // Defense in depth for #26: even if a caller bypasses the source gate, a
    // rehearsal hazard is returned detached and never merged into the durable set.
    return { ...found, count: Math.max(1, found.count) }
  }
  const key = hazardKey(found)
  const existing = target.find((h) => hazardKey(h) === key)
  if (existing === undefined) {
    const created: DeathHazard = {
      x: Math.round(found.x),
      y: Math.round(found.y),
      z: Math.round(found.z),
      reason: found.reason,
      count: Math.max(1, found.count),
      firstSeenAt: found.firstSeenAt || Date.now(),
      lastSeenAt: found.lastSeenAt || Date.now(),
    }
    target.push(created)
    if (target.length > 128) target.splice(0, target.length - 128)
    return created
  }
  existing.count += Math.max(1, found.count)
  existing.reason = found.reason
  existing.lastSeenAt = found.lastSeenAt || Date.now()
  return existing
}

/** Drop a rejected/superseded generation's staged proposals without writing. */
function discardStagedProposals(generationId: string, reason: string): void {
  const pending = pendingByGeneration.get(generationId)
  pendingByGeneration.delete(generationId)
  if (pending === undefined) return
  log('PROPOSALS_DISCARDED', {
    generationId,
    reason,
    worldMemoryDeltas: pending.worldMemory.length,
    ledger: pending.ledger !== null,
    reconciliation: pending.ledgerReconcile !== null,
  })
}

function archiveLedger(reason: string): void {
  if (!existsSync(LEDGER)) return
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(LEDGER, join(DATA, `ledger-complete-${stamp}.json`))
    log('RECOVERY', { reason: 'ledger archived', detail: reason })
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// bot + generation lifecycle
// ---------------------------------------------------------------------------
let bot: Bot | null = null
let generation: ResidentGeneration | null = null
let generationModule: GenerationModule | null = null
let currentBundle: string | null = null
let reconnecting = false
let shuttingDown = false
// Maintenance-safe boot: the control socket is started before Minecraft connect,
// but spawn can race an operator's first freeze request. Opting in here makes the
// host frozen from process birth; `startGeneration` below enforces the same flag.
let frozen = (process.env.BUDDY_START_FROZEN ?? '').trim() === '1'
let generationRestartTimer: NodeJS.Timeout | null = null
let generationConnectionRetryTimer: NodeJS.Timeout | null = null
let generationConnectionAttempt: Promise<boolean> | null = null
let reloadTimer: NodeJS.Timeout | null = null
let deferredModelReloadTrigger: string | null = null
let reloadArbiter: ReloadArbiter | null = null
let lastSrcSignature = ''
let lastInventoryHash = ''
let lastActionId: string | null = null
let lastHeartbeatAt = 0
const leaseManager = new ActuationLeaseManager()
const modelAvailability = new ModelAvailabilityTracker()
const reconnectLedger = new ReconnectLedger()
/** #384: the control socket server; closed (and awaited) before the lock is released. */
let controlServer: Server | null = null
let connectedSince = 0
let reconnectScheduledAt: number | null = null
let disconnectReasonSeen: DisconnectReason | null = null
let disconnectDetail: string | null = null
let generationHash: string | null = null
let generationSourceSha: string | null = null
let listenerBaseline: Record<string, number> = {}
let listenerHostBaseline: Record<string, number> = {}
let baselineCaptured = false
let listenerBaselineTimer: NodeJS.Timeout | null = null
let listenerBaselineGeneration: ResidentGeneration | null = null
let startPosition: Vec3Json | null = null
let lastStatus: GenerationStatus | null = null
/**
 * HOST-owned, run-scoped milestone predicate recorder. Created lazily on the
 * first observation that carries `status.milestonePredicates` (older generations
 * do not), and reused across hot reloads so a proven predicate survives every
 * generation swap. It writes `milestone-predicates-<runId>.json` next to the
 * run-scoped M2 snapshot, which tools/milestone-run-artifact.mjs reads.
 */
let milestonePredicateRecorder: MilestonePredicateRecorder | null = null
let deathResetPending = false
let pendingResetReason: string | null = null
let lastDeathAt = 0
let lastHealth: number | null = null
let lastSeenDeathPosition: Vec3Json | null = null
let lastDeathRecoveryContext: DeathRecoveryContext | null = null
const recentDeathTimes: number[] = []
const DEATH_RECOVERY_WINDOW_MS = 2 * 60 * 1000
const DEATH_HOSTILE_RADIUS = 16
// #34: the last inventory observed while alive. A Mineflayer `death` read is
// already post-drop, so the DEATH marker uses this instead of reading at death.
const preLossInventory = createPreLossInventoryTracker()

// #13/#49: one host-owned resource ledger per generation. The generation records
// every listener/timer it owns; disposal removes exactly those and reports the
// counts, so an old generation cannot leave listeners behind silently.
const generationRegistries = new Map<string, GenerationResourceRegistry>()
const generationStopWatch = new Map<string, NodeJS.Timeout>()

const runId = `run-${Date.now().toString(36)}-${process.pid.toString(36)}`
import { acceptanceProvenance } from './acceptance-provenance.ts'
import { cleanRunServerConfigAtBoot } from './clean-run-server-config.ts'

const bootSourceSha = gitCommit()
const stats = {
  reconnects: 0,
  reconnectsLastHour: 0,
  reconnectAttempt: 0,
  reconnectReasons: { end: 0, kicked: 0, error: 0 } as Record<DisconnectReason, number>,
  reloadsChangedHash: 0,
  reloadsSkippedUnchanged: 0,
  reloadsFailed: 0,
  freezeCycles: 0,
  wedge: false,
  goalComplete: false,
}

// The HOST owns the lease. A generation may only act while its id is active;
// the reload commit point is exactly this switch. Rollback switches it back.
const lease: ActuationLease = {
  get activeId(): string {
    return leaseManager.activeId
  },
  isActive: (id: string): boolean => leaseManager.isActive(id),
  assertActive: (id: string, what: string): void => leaseManager.assertActive(id, what),
}

function revokeLease(reason: string): void {
  leaseManager.revoke(reason, log)
}

function syncReconnectStats(): void {
  const report = reconnectLedger.report()
  stats.reconnects = report.reconnects
  stats.reconnectsLastHour = report.reconnectsLastHour
  stats.reconnectAttempt = report.reconnectAttempt
  stats.reconnectReasons = report.reconnectReasons
}

/**
 * #378: single-instance host lock. Claiming is an exclusive create (`wx`), so a
 * check-then-write race between two residents cannot let both win; a stale lock is
 * reclaimed race-safely (atomic take-away, verify the taken bytes, exclusive
 * create, restore-with-hard-link when a fresh live claim was captured by mistake).
 * Liveness uses the one conservative probe (`EPERM` = alive), so a pid that cannot
 * be shown dead is never displaced.
 */
const hostLock = new HostLock({ path: LOCK_PATH, log, durability, isAlive: defaultPidAlive })

function releaseHostLock(): void {
  hostLock.release()
}

function hostLockReport(): HostLockReport {
  return hostLock.report()
}

function listenerCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  if (bot === null) return counts
  const countable = bot as unknown as { listenerCount(event: string): number }
  for (const event of LISTENER_EVENTS) counts[event] = countable.listenerCount(event)
  return counts
}

function expectedListenerCounts(): Record<string, number> {
  const expected = { ...listenerBaseline }
  if (generation === null || Object.keys(listenerBaseline).length === 0) return expected
  const registry = generationRegistries.get(generation.id)
  if (registry === undefined || Object.keys(listenerHostBaseline).length === 0) return expected
  const owned = registry.ownedListenerCounts()
  for (const event of LISTENER_EVENTS) {
    const hostCount = listenerHostBaseline[event]
    if (hostCount !== undefined) expected[event] = hostCount + (owned[event] ?? 0)
  }
  return expected
}

function listenerLeak(): boolean {
  const current = listenerCounts()
  const expected = expectedListenerCounts()
  return Object.keys(listenerBaseline).some((event) => (current[event] ?? 0) > (expected[event] ?? 0))
}

function clearListenerBaselineTimer(): void {
  if (listenerBaselineTimer !== null) {
    clearTimeout(listenerBaselineTimer)
    listenerBaselineTimer = null
  }
  listenerBaselineGeneration = null
}

function listenerBaselineReady(beforeStart: Record<string, number>, current: Record<string, number>): boolean {
  return GENERATION_SCHEDULER_EVENTS.every((event) => (current[event] ?? 0) > (beforeStart[event] ?? 0))
}

function scheduleListenerBaseline(gen: ResidentGeneration, beforeStart: Record<string, number>): void {
  if (baselineCaptured || listenerBaselineTimer !== null || listenerBaselineGeneration !== null) return
  listenerBaselineGeneration = gen
  let polls = 0

  const poll = (): void => {
    listenerBaselineTimer = null
    if (listenerBaselineGeneration !== gen) return
    if (baselineCaptured || generation !== gen || gen.hasStopped() || shuttingDown) {
      listenerBaselineGeneration = null
      return
    }
    const listeners = listenerCounts()
    if (listenerBaselineReady(beforeStart, listeners)) {
      baselineCaptured = true
      listenerBaseline = listeners
      listenerBaselineGeneration = null
      log('LISTENER_BASELINE', { listeners: listenerBaseline, generationId: gen.id, polls })
      return
    }
    polls += 1
    if (polls >= LISTENER_BASELINE_MAX_POLLS) {
      listenerBaselineGeneration = null
      log('LISTENER_BASELINE_UNKNOWN', {
        generationId: gen.id,
        polls,
        beforeStart,
        listeners,
        requiredEvents: GENERATION_SCHEDULER_EVENTS,
      })
      return
    }
    listenerBaselineTimer = setTimeout(poll, LISTENER_BASELINE_POLL_MS)
  }

  listenerBaselineTimer = setTimeout(poll, 0)
}

async function loadGenerationModule(force: boolean): Promise<GenerationModule | null> {
  if (!force && generationModule !== null) return generationModule
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const built = await buildGeneration()
      const sourceSha = gitCommit()
      const mod = (await import(`${pathToFileURL(built.outfile).href}?v=${built.hash}`)) as GenerationModule
      const readinessError = generationModuleReadinessError(mod, CONTRACT_VERSION)
      if (readinessError !== null) throw new Error(readinessError)
      generationModule = mod
      currentBundle = built.outfile
      generationHash = built.hash
      generationSourceSha = sourceSha
      // The bundle hash attests WHICH bundle; the git commit attests WHICH SOURCE it was built from.
      // Without this a hot-reloaded run could prove its bundle but not its commit, which is exactly what the
      // acceptance asks for (`exact source SHA`).
      log('BUILD', { hash: built.hash, sourceSha, bytes: built.bytes, ms: built.ms, outfile: built.outfile })
      return mod
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('ERROR', { where: 'loadGenerationModule', attempt, message })
      if (attempt < 3) await delay(5000)
    }
  }
  return null
}

/**
 * STRUCTURAL smoke: contract version, import surface, required methods, snapshot
 * schema, sensor readability, listener sanity. It must PASS with an EMPTY plan
 * and NO completed goals - hot reload never depends on a goal existing.
 */
function runStructuralSmoke(gen: ResidentGeneration): StructuralSmokeResult {
  let result: StructuralSmokeResult
  try {
    result = gen.structuralSmoke()
  } catch (error) {
    throw new Error(`structural smoke threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  const surface = ['attach', 'start', 'quiesce', 'dispose', 'status', 'stopReason', 'hasStopped', 'structuralSmoke', 'missionPreflight'] as const
  for (const name of surface) {
    if (typeof (gen as unknown as Record<string, unknown>)[name] !== 'function') result.failures.push(`missing method ${name}`)
  }
  if (typeof gen.id !== 'string' || gen.id.length === 0) result.failures.push('missing generation id')
  if (typeof gen.rungId !== 'string') result.failures.push('missing rung id')
  if (result.failures.length > 0) {
    result.ok = false
    throw new Error(`structural smoke failed: ${result.failures.join('; ')}`)
  }
  return result
}

/** MISSION preflight: goal exists / candidates generatable. Never gates reload. */
function runMissionPreflight(gen: ResidentGeneration): { ok: boolean; reason: string | null; goalCount: number } {
  try {
    return gen.missionPreflight()
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), goalCount: 0 }
  }
}

/**
 * Per-generation seed for `snapshotRevision`. Captured when the context is built
 * and refreshed by the host right before start(), so a generation that replaces a
 * quiescing one is seeded from the post-flush revision while the quiescing
 * generation keeps its own older lineage (and is rejected if it proposes later).
 */
interface GenerationSeed {
  revision: number
}

function makeGenerationContext(
  b: Bot,
  pending: PendingProposals,
  seed: GenerationSeed = { revision: state.revision },
  buildHash: string | null = generationHash,
  sourceSha: string | null = generationSourceSha,
): GenerationContext {
  const generationWorldKey = currentWorldKey()
  const availabilityAtCreate = modelAvailability.snapshot()
  pending.worldKey = generationWorldKey
  return {
    runId,
    bootSourceSha,
    sourceSha,
    buildHash,
    recoveryPolicyAuthority: availabilityAtCreate.state === 'degraded'
      ? availabilityAtCreate.recoveryAuthority
      : null,
    m2SnapshotDir: DATA,
    bot: b,
    log: (event, detail = {}) => {
      log(event, detail)
      if (event === 'MODEL_UNAVAILABLE') {
        const failure = modelAvailability.recordUnavailable({
          generationId: typeof detail.generationId === 'string' ? detail.generationId : null,
          context: typeof detail.context === 'string' ? detail.context : 'unknown',
          attempts: typeof detail.attempts === 'number' ? detail.attempts : 0,
          error: typeof detail.error === 'string' ? detail.error : 'model authority unavailable',
          authority: typeof detail.provider === 'string' && typeof detail.model === 'string'
            ? { provider: detail.provider, model: detail.model }
            : null,
        })
        log('MODEL_AVAILABILITY', {
          runId,
          generationId: typeof detail.generationId === 'string' ? detail.generationId : null,
          ...modelAvailability.snapshot(),
          attempt: failure.attempt,
          retryDelayMs: failure.delayMs,
        })
        try { writeAcceptance() } catch { /* availability log remains durable */ }
      } else if (event === 'JEV_HEADS') {
        const previousState = modelAvailability.snapshot().state
        const authority = typeof detail.provider === 'string' && typeof detail.model === 'string'
          ? { provider: detail.provider, model: detail.model }
          : null
        const response = modelAvailability.recordPolicyResponse(
          authority,
          typeof detail.source === 'string' ? detail.source : null,
        )
        if (!response.accepted) {
          if (previousState === 'degraded' && response.reason !== null) {
            const retry = modelAvailability.recordRecoveryRejected(response.reason, authority)
            log('MODEL_RECOVERY_AUTHORITY_REJECTED', {
              runId,
              generationId: typeof detail.generationId === 'string' ? detail.generationId : null,
              reason: response.reason,
              expected: modelAvailability.snapshot().recoveryAuthority,
              actual: authority,
              retryAt: retry?.retryAt ?? modelAvailability.snapshot().retryAt,
              retryDelayMs: retry?.delayMs ?? null,
            })
            if (retry !== null) scheduleGenerationRestart('model-unavailable', retry.delayMs)
          }
          return
        }
        if (response.recovered) {
          log('MODEL_RECOVERED', {
            runId,
            generationId: typeof detail.generationId === 'string' ? detail.generationId : null,
            provider: authority?.provider ?? null,
            model: authority?.model ?? null,
            recoveredAt: modelAvailability.snapshot().recoveredAt,
          })
          if (deferredModelReloadTrigger !== null) {
            const deferredTrigger = deferredModelReloadTrigger
            deferredModelReloadTrigger = null
            scheduleReload(`model-recovered:${deferredTrigger}`)
          }
        }
        if (response.recovered || previousState === 'unknown') {
          log('MODEL_AVAILABILITY', { runId, generationId: detail.generationId ?? null, ...modelAvailability.snapshot() })
          try { writeAcceptance() } catch { /* success event remains durable */ }
        }
      }
    },
    lease,
    resources: new GenerationResourceRegistry(),
    worldMemory: cloneMemory(keyedMemory()),
    worldKey: generationWorldKey,
    proposeWorldMemory: (delta) => {
      if (pending.speculative) {
        stageWorldMemory(pending, delta)
        return
      }
      applyWorldMemoryDelta(delta, generationWorldKey)
    },
    proposeLedger: (proposal) => {
      if (pending.speculative) {
        stageLedgerProposal(pending, proposal)
        return
      }
      onGenerationLedgerProposal(proposal, 'generation')
    },
    get snapshotRevision(): number {
      return seed.revision
    },
    proposeLedgerReconciliation: (proposal) => {
      if (pending.speculative) {
        stageLedgerReconciliation(pending, proposal)
        return
      }
      archiveReconciledLedger(proposal.reason)
      saveState('ledger-reconcile')
    },
    ledgerSnapshot: state.ledger,
    ledgerPath: LEDGER,
    logDir: JEV_LOGS,
    goalItem: GOAL_ITEM,
    goalCount: GOAL_COUNT,
    resetReason: pendingResetReason,
    deathRecovery: pendingResetReason === 'death' ? lastDeathRecoveryContext : null,
  }
}

function registerGenerationResources(gen: ResidentGeneration, ctx: GenerationContext): void {
  if (ctx.resources instanceof GenerationResourceRegistry) generationRegistries.set(gen.id, ctx.resources)
}

/**
 * Remove a superseded generation and everything it owned, then assert the host
 * listener counts returned to baseline. controller.stop() clears the controller's
 * own listeners/timers; the registry removes any generation-registered resource
 * stop() may miss. If the reclaim leaves a leak the counts are kept and a WARN is
 * logged instead of silently accepting it (#13).
 */
function disposeGeneration(gen: ResidentGeneration): GenerationResourceCounts {
  if (listenerBaselineGeneration === gen) clearListenerBaselineTimer()
  try {
    gen.dispose()
  } catch (error) {
    log('ERROR', { where: 'generation.dispose', id: gen.id, message: error instanceof Error ? error.message : String(error) })
  }
  const registry = generationRegistries.get(gen.id)
  const tracked = registry === undefined ? { listeners: 0, timers: 0 } : registry.dispose()
  generationRegistries.delete(gen.id)
  const watch = generationStopWatch.get(gen.id)
  if (watch !== undefined) {
    clearInterval(watch)
    generationStopWatch.delete(gen.id)
  }
  const hostListeners = listenerCounts()
  log('LISTENERS', {
    phase: 'after_dispose',
    generationId: gen.id,
    listeners: hostListeners,
    baseline: listenerBaseline,
    hostBaseline: listenerHostBaseline,
    tracked,
  })
  log('GENERATION_DISPOSED', { id: gen.id, listeners: tracked.listeners, timers: tracked.timers, hostListeners: hostListeners.physicsTick ?? 0 })
  if (listenerLeak()) {
    log('WARN', { where: 'generation-dispose', id: gen.id, reason: 'listener-count-did-not-return-to-baseline', listeners: hostListeners, baseline: listenerBaseline, tracked })
  }
  return tracked
}

function ownershipPorts(): OwnershipPorts {
  return {
    log,
    lease: leaseManager,
    ownership: state,
    getLive: () => generation,
    setLive: (next) => {
      generation = next as ResidentGeneration | null
    },
  }
}

function makeSwapPorts(previousModule: GenerationModule | null): SwapPorts {
  return {
    ...ownershipPorts(),
    afterQuiesce: (target) => log('LISTENERS', { phase: 'after_quiesce', generationId: target.id, listeners: listenerCounts() }),
    buildResume: () => {
      if (previousModule === null || bot === null) return null
      const trigger = `rollback:${currentBundle ?? 'previous-module'}`
      if (!gateModelRecoveryStart(trigger, 'rollback')) return null
      const pending = newPendingProposals()
      const ctx = makeGenerationContext(bot, pending)
      const resumed = previousModule.createGeneration(ctx)
      pending.generationId = resumed.id
      pendingByGeneration.set(resumed.id, pending)
      registerGenerationResources(resumed, ctx)
      const authorityCheck = inspectGenerationAuthority(resumed, trigger)
      if (!authorityCheck.admission.allowed) {
        const retryDelayMs = logRejectedGenerationAuthority(
          resumed.id, trigger, authorityCheck.authority, authorityCheck.admission, true,
        )
        disposeGeneration(resumed)
        discardStagedProposals(resumed.id, 'rollback-model-authority-rejected')
        if (retryDelayMs !== null) scheduleGenerationRestart('model-unavailable', retryDelayMs)
        else scheduleGenerationRestart('generation-stopped', GEN_RESTART_MS)
        return null
      }
      return resumed
    },
    dispose: (target: SwapGeneration) => disposeGeneration(target as ResidentGeneration),
    smoke: (target: SwapGeneration) => {
      runStructuralSmoke(target as ResidentGeneration)
    },
    persist: (event: string) => saveState(event),
    revision: () => state.revision,
  }
}

function watchGenerationStop(gen: ResidentGeneration): void {
  const guard = setInterval(() => {
    if (generation !== gen) {
      clearInterval(guard)
      generationStopWatch.delete(gen.id)
      return
    }
    if (!gen.hasStopped()) return
    clearInterval(guard)
    generationStopWatch.delete(gen.id)
    const stopped = gen.stopReason()
    generation = null
    state.lastGenerationId = gen.id
    state.generationId = null
    if (leaseManager.isActive(gen.id)) revokeLease('generation-stopped')
    disposeGeneration(gen)
    if (stopped === 'wedge') stats.wedge = true
    if (stopped === 'goal-complete') stats.goalComplete = true
    if (shuttingDown || frozen || deathResetPending) return
    log('RECOVERY', { reason: 'generation-stopped', stopped })
    state.recoveries += 1
    if (stopped === 'goal-complete') archiveLedger('goal-complete')
    saveState('generation-stop')
    if (stopped === 'model-unavailable') {
      const snapshot = modelAvailability.snapshot()
      const retryAtMs = snapshot.retryAt === null ? Date.now() + GEN_RESTART_MS : Date.parse(snapshot.retryAt)
      const delayMs = Math.max(0, retryAtMs - Date.now())
      log('RECOVERY', { reason: 'model-unavailable', generationId: gen.id, retryDelayMs: delayMs, retryAt: snapshot.retryAt })
      scheduleGenerationRestart('model-unavailable', delayMs)
    } else {
      scheduleGenerationRestart('generation-stopped')
    }
  }, 2000)
  generationStopWatch.set(gen.id, guard)
}

type RecoveryStartPath = 'generation' | 'reload' | 'rollback'

/** Every path that can commit a fresh generation shares the provider backoff. */
function gateModelRecoveryStart(trigger: string, path: RecoveryStartPath): boolean {
  const recoveryGate = modelRecoveryStartGate(modelAvailability.snapshot())
  if (!recoveryGate.allowed) {
    const availability = modelAvailability.snapshot()
    const detail = {
      runId,
      trigger,
      path,
      reason: 'model-recovery-backoff',
      backoffReason: recoveryGate.reason,
      deferMs: recoveryGate.delayMs,
      retryAt: availability.retryAt,
      consecutiveFailures: availability.consecutiveFailures,
      lastFailure: availability.lastFailure,
    }
    log(path === 'reload' ? 'RELOAD_DEFERRED' : 'GENERATION_START_SUPPRESSED', detail)
    scheduleGenerationRestart('model-unavailable', recoveryGate.delayMs)
    return false
  }
  if (recoveryGate.reason === 'retry-due') {
    // Direct lifecycle wakes and reload/rollback paths record the same durable
    // transition as the scheduled retry before constructing a generation.
    modelAvailability.recordRetryStarted()
    log('MODEL_RETRY_STARTED', { runId, trigger, path, ...modelAvailability.snapshot() })
    try { writeAcceptance() } catch { /* retry event remains in the resident log */ }
  }
  return true
}

function inspectGenerationAuthority(gen: ResidentGeneration, trigger: string): {
  authority: { provider: string; model: string }
  admission: ReturnType<ModelAvailabilityTracker['admitGenerationAuthority']>
} {
  const status = gen.status()
  const authority = { provider: status.policyProvider, model: status.policyModel }
  const admission = modelAvailability.admitGenerationAuthority(authority)
  if (admission.allowed) {
    log('GENERATION_MODEL_AUTHORITY', {
      runId,
      generationId: gen.id,
      trigger,
      provider: authority.provider,
      model: authority.model,
      recovery: admission.reason === 'same-recovery-authority',
    })
  }
  return { authority, admission }
}

function logRejectedGenerationAuthority(
  generationId: string,
  trigger: string,
  authority: { provider: string; model: string },
  admission: Exclude<ReturnType<ModelAvailabilityTracker['admitGenerationAuthority']>, { allowed: true }>,
  countRecoveryAttempt: boolean,
): number | null {
  const before = modelAvailability.snapshot()
  const retry = countRecoveryAttempt && before.state === 'degraded'
    ? modelAvailability.recordRecoveryRejected(admission.reason, authority)
    : null
  log('MODEL_RECOVERY_AUTHORITY_REJECTED', {
    runId,
    generationId,
    trigger,
    reason: admission.reason,
    expected: admission.expected,
    actual: authority,
    retryAt: retry?.retryAt ?? before.retryAt,
    retryDelayMs: retry?.delayMs ?? null,
    started: false,
  })
  return retry?.delayMs ?? null
}

async function startGeneration(trigger: string): Promise<boolean> {
  // `freeze` is a lifecycle invariant, not merely a restart-timer hint. Direct
  // spawn/respawn/control paths all funnel through this function, so enforcing it
  // here prevents a reconnect from silently reviving actuation while frozen.
  if (frozen) {
    log('GENERATION_START_SUPPRESSED', { trigger, reason: 'frozen' })
    return false
  }
  if (!gateModelRecoveryStart(trigger, 'generation')) return false
  if (bot === null || bot.entity === undefined) {
    log('ERROR', { where: 'startGeneration', message: 'no spawned bot', trigger })
    return false
  }
  if (generation !== null) {
    // Never run two generations on one bot: a respawn/hot path that starts a
    // generation while one is alive would double the bot listeners and race the
    // actuation lease. Dispose the old one first.
    const old = generation
    generation = null
    try {
      await old.quiesce()
    } catch {
      // best effort
    }
    if (leaseManager.isActive(old.id)) revokeLease('replaced-by-new-generation')
    log('LISTENERS', { phase: 'after_quiesce', generationId: old.id, listeners: listenerCounts() })
    disposeGeneration(old)
  }
  const mod = await loadGenerationModule(false)
  if (mod === null) {
    scheduleGenerationRestart('module-unavailable')
    return false
  }
  // A death re-creates the player entity and re-synchronizes the inventory
  // window asynchronously. Decide the reset from the SETTLED inventory: a
  // momentary empty read (or the client's retained pre-death window) is not
  // durable truth. `keep_inventory` is per-world on Paper, so code cannot infer
  // either direction - it must observe. The generation below then reads this
  // settled bot inventory synchronously; WHICH rung follows stays with the ladder.
  const resetReason = pendingResetReason
  if (shouldSettleRespawnInventory(resetReason)) {
    const settled = await settleInventoryAfterRespawn(() => inventorySummary(bot as Bot), {
      settleWindowMs: RESPAWN_INVENTORY_SETTLE_MS,
      pollIntervalMs: RESPAWN_INVENTORY_POLL_MS,
    })
    log('LADDER_INVENTORY_SETTLE', {
      reason: resetReason,
      readings: settled.readings,
      changed: settled.observedChange,
      empty: settled.empty,
      itemCount: Object.keys(settled.counts).length,
      waitedMs: settled.waitedMs,
      counts: settled.counts,
    })
  }
  const pending = newPendingProposals()
  const ctx = makeGenerationContext(bot, pending)
  const gen = mod.createGeneration(ctx)
  pending.generationId = gen.id
  pendingByGeneration.set(gen.id, pending)
  registerGenerationResources(gen, ctx)
  const authorityCheck = inspectGenerationAuthority(gen, trigger)
  if (!authorityCheck.admission.allowed) {
    const retryDelayMs = logRejectedGenerationAuthority(
      gen.id, trigger, authorityCheck.authority, authorityCheck.admission, true,
    )
    disposeGeneration(gen)
    discardStagedProposals(gen.id, 'model-recovery-authority-rejected')
    if (retryDelayMs !== null) scheduleGenerationRestart('model-unavailable', retryDelayMs)
    else scheduleGenerationRestart('generation-stopped', GEN_RESTART_MS)
    return false
  }
  pendingResetReason = null
  gen.attach()
  try {
    runStructuralSmoke(gen)
  } catch (error) {
    discardStagedProposals(gen.id, 'structural-smoke-failed')
    throw error
  }
  const preflight = runMissionPreflight(gen)
  log('MISSION_PREFLIGHT', { id: gen.id, ok: preflight.ok, goals: preflight.goalCount, reason: preflight.reason })
  commitOwner(ownershipPorts(), gen)
  const listenersBeforeStart = listenerCounts()
  listenerHostBaseline = { ...listenersBeforeStart }
  log('LISTENERS', { phase: 'before_start', generationId: gen.id, listeners: listenersBeforeStart })
  try {
    gen.start()
  } catch (error) {
    generation = null
    state.lastGenerationId = gen.id
    state.generationId = null
    if (leaseManager.isActive(gen.id)) revokeLease('start-failed')
    disposeGeneration(gen)
    discardStagedProposals(gen.id, 'start-failed')
    throw error
  }
  log('LISTENERS', { phase: 'after_start', generationId: gen.id, listeners: listenerCounts() })
  lastActionId = null
  if (!baselineCaptured) {
    scheduleListenerBaseline(gen, listenersBeforeStart)
  }
  state.generations += 1
  commitStagedProposals(gen.id, 'generation-start')
  log('GENERATION_START', { id: gen.id, trigger, rung: gen.rungId, rungIndex: gen.rungIndex, generations: state.generations })
  watchGenerationStop(gen)
  return true
}

function scheduleGenerationRestart(reason: string, delayMs = GEN_RESTART_MS): void {
  if (generationRestartTimer !== null || shuttingDown || frozen || deathResetPending) return
  generationRestartTimer = setTimeout(() => {
    generationRestartTimer = null
    if (shuttingDown || frozen) return
    if (generation !== null) return
    if (reason === 'model-unavailable') {
      modelAvailability.recordRetryStarted()
      log('MODEL_RETRY_STARTED', { runId, ...modelAvailability.snapshot() })
      try { writeAcceptance() } catch { /* retry event remains durable */ }
    }
    void startGeneration(`recovery:${reason}`)
  }, delayMs)
}

function scheduleGenerationConnectionRetry(trigger: string, reason: string): void {
  if (generationConnectionRetryTimer !== null || shuttingDown) return
  generationConnectionRetryTimer = setTimeout(() => {
    generationConnectionRetryTimer = null
    if (shuttingDown) return
    log('CONNECT_RETRY', { trigger, delayMs: GEN_RESTART_MS, previousRefusal: reason })
    void connectWhenGenerationReady(`retry:${trigger}`)
  }, GEN_RESTART_MS)
}

function connectWhenGenerationReady(trigger: string): Promise<boolean> {
  if (generationConnectionAttempt !== null) return generationConnectionAttempt
  const attempt = connectAfterGenerationValidation({
    load: () => loadGenerationModule(false),
    validate: (candidate) => generationModuleReadinessError(candidate, CONTRACT_VERSION),
    connect: () => connect(),
    refused: (reason) => {
      log('CONNECT_REFUSED', { trigger, reason, generationHash })
      scheduleGenerationConnectionRetry(trigger, reason)
    },
  })
  generationConnectionAttempt = attempt.finally(() => {
    generationConnectionAttempt = null
  })
  return generationConnectionAttempt
}

function inventorySummary(b: Bot): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    for (const item of b.inventory.items()) out[item.name] = (out[item.name] ?? 0) + item.count
  } catch {
    // entity/inventory not readable at the death moment
  }
  return out
}

/**
 * A read-only, run-bound inventory snapshot returned with `report`.
 * Historical milestone observations are useful for proving that a rung was once
 * reached; acceptance also needs the inventory the player holds at gate time.
 */
function currentInventoryObservation(): Record<string, unknown> | null {
  if (bot === null || bot.entity === undefined) return null
  const atMs = Date.now()
  const dimension = normalizeDimension(bot.game?.dimension)
  return {
    record: 'current-inventory-observation',
    schemaVersion: 1,
    runId,
    sourceSha: bootSourceSha,
    generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
    observedAtMs: atMs,
    observedAt: new Date(atMs).toISOString(),
    worldKey: { ...currentWorldKey(), dimension },
    dimension,
    counts: inventorySummary(bot),
  }
}

function blockNameAt(b: Bot, x: number, y: number, z: number): string {
  try {
    return b.blockAt(new Vec3(x, y, z))?.name ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const STATE_HAZARDS = new Set([
  'cactus', 'campfire', 'fire', 'lava', 'magma_block', 'powder_snow',
  'pointed_dripstone', 'soul_campfire', 'soul_fire', 'sweet_berry_bush',
])

/** Read-only host-side world truth for the external world-player-state tool. */
const WORLD_CACHE_KEY_LIMIT = 128

interface ChunkColumnCoordinate {
  chunkX: number
  chunkZ: number
}

function chunkColumnKey(column: ChunkColumnCoordinate): string {
  return `${column.chunkX},${column.chunkZ}`
}

function worldCacheDiagnosticTargets(b: Bot, radius: number): ChunkColumnCoordinate[] {
  const position = b.entity === undefined ? null : b.entity.position
  const targets = new Map<string, ChunkColumnCoordinate>()
  if (position !== null) {
    const minBlockX = Math.floor(position.x) - radius
    const maxBlockX = Math.floor(position.x) + radius
    const minBlockZ = Math.floor(position.z) - radius
    const maxBlockZ = Math.floor(position.z) + radius
    for (let chunkX = Math.floor(minBlockX / 16); chunkX <= Math.floor(maxBlockX / 16); chunkX += 1) {
      for (let chunkZ = Math.floor(minBlockZ / 16); chunkZ <= Math.floor(maxBlockZ / 16); chunkZ += 1) {
        const column = { chunkX, chunkZ }
        targets.set(chunkColumnKey(column), column)
      }
    }
  }
  const world = b.world as unknown as {
    getColumns?: () => Array<{ chunkX?: unknown; chunkZ?: unknown }>
  } | undefined
  try {
    const loaded = typeof world?.getColumns === 'function' ? world.getColumns() : []
    const playerChunk = position === null
      ? null
      : { chunkX: Math.floor(position.x / 16), chunkZ: Math.floor(position.z / 16) }
    const ordered = loaded.map((column) => ({ chunkX: Number(column.chunkX), chunkZ: Number(column.chunkZ) }))
      .filter((column) => Number.isFinite(column.chunkX) && Number.isFinite(column.chunkZ))
      .map((column) => ({ chunkX: Math.floor(column.chunkX), chunkZ: Math.floor(column.chunkZ) }))
      .sort((left, right) => {
        if (playerChunk === null) return 0
        const leftDistance = (left.chunkX - playerChunk.chunkX) ** 2 + (left.chunkZ - playerChunk.chunkZ) ** 2
        const rightDistance = (right.chunkX - playerChunk.chunkX) ** 2 + (right.chunkZ - playerChunk.chunkZ) ** 2
        return leftDistance - rightDistance
      })
    for (const column of ordered.slice(0, WORLD_CACHE_KEY_LIMIT)) {
      targets.set(chunkColumnKey(column), column)
    }
  } catch {
    // The caller will expose column-list availability as unknown.
  }
  return [...targets.values()].slice(0, WORLD_CACHE_KEY_LIMIT)
}

function liveWorldCacheSnapshot(
  b: Bot,
  radius: number,
  verticalRadius: number,
  capturedAt: string,
  provenance: ReturnType<NonNullable<ResidentGeneration['worldProbeProvenance']>> | null,
): Record<string, unknown> {
  const position = b.entity === undefined ? null : b.entity.position
  const world = b.world as unknown as {
    getColumns?: () => Array<{ chunkX?: unknown; chunkZ?: unknown }>
  } | undefined
  let rawColumns: Array<{ chunkX?: unknown; chunkZ?: unknown }> | null = null
  try {
    if (typeof world?.getColumns === 'function') rawColumns = world.getColumns()
  } catch {
    rawColumns = null
  }

  const columns = new Map<string, ChunkColumnCoordinate>()
  for (const column of rawColumns ?? []) {
    const chunkX = Number(column.chunkX)
    const chunkZ = Number(column.chunkZ)
    if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) continue
    const normalized = { chunkX: Math.floor(chunkX), chunkZ: Math.floor(chunkZ) }
    columns.set(chunkColumnKey(normalized), normalized)
  }
  const playerChunk = position === null
    ? null
    : { chunkX: Math.floor(position.x / 16), chunkZ: Math.floor(position.z / 16) }
  const requestedColumns = new Map<string, ChunkColumnCoordinate>()
  if (position !== null) {
    const minBlockX = Math.floor(position.x) - radius
    const maxBlockX = Math.floor(position.x) + radius
    const minBlockZ = Math.floor(position.z) - radius
    const maxBlockZ = Math.floor(position.z) + radius
    for (let chunkX = Math.floor(minBlockX / 16); chunkX <= Math.floor(maxBlockX / 16); chunkX += 1) {
      for (let chunkZ = Math.floor(minBlockZ / 16); chunkZ <= Math.floor(maxBlockZ / 16); chunkZ += 1) {
        const column = { chunkX, chunkZ }
        requestedColumns.set(chunkColumnKey(column), column)
      }
    }
  }

  const loadedForDiagnostic = [...columns.values()]
    .sort((left, right) => {
      if (playerChunk === null) return 0
      const leftDistance = (left.chunkX - playerChunk.chunkX) ** 2 + (left.chunkZ - playerChunk.chunkZ) ** 2
      const rightDistance = (right.chunkX - playerChunk.chunkX) ** 2 + (right.chunkZ - playerChunk.chunkZ) ** 2
      return leftDistance - rightDistance
    })
    .slice(0, WORLD_CACHE_KEY_LIMIT)
  const provenanceByKey = new Map<string, Record<string, unknown>>()
  for (const column of provenance?.columns ?? []) {
    provenanceByKey.set(chunkColumnKey(column), {
      kind: column.kind,
      dimension: column.dimension,
      liveDimension: column.liveDimension,
      reason: column.reason,
    })
  }
  const requested = [...requestedColumns.values()].map((column) => ({
    ...column,
    loaded: columns.has(chunkColumnKey(column)),
    provenance: provenanceByKey.get(chunkColumnKey(column)) ?? null,
  }))
  const loaded = loadedForDiagnostic.map((column) => ({
    ...column,
    provenance: provenanceByKey.get(chunkColumnKey(column)) ?? null,
  }))
  const requestedLoaded = requested.filter((column) => column.loaded).length
  const requestedAttributable = requested.filter((column) =>
    column.loaded && column.provenance?.kind === 'attributable').length
  const requestedForeign = requested.filter((column) =>
    column.loaded && column.provenance?.kind === 'foreign').length
  const requestedUnknownProvenance = requested.filter((column) =>
    column.loaded && (column.provenance === null || column.provenance.kind === 'unknown')).length
  const binding = {
    runId,
    generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
    worldKey: currentWorldKey(),
  }
  const refusalByCause = {
    columnNotLoaded: requested.length - requestedLoaded,
    unknownProvenance: requestedUnknownProvenance,
    foreignDimension: requestedForeign,
    attributable: requestedAttributable,
  }
  const refusedColumnCount = requested.length - requestedAttributable
  const unboundReason = provenance === null
    ? 'generation-provenance-view-unavailable'
    : binding.generationId === null
      ? 'generation-identity-unavailable'
      : null
  return {
    schemaVersion: 1,
    kind: 'resident-world-cache-diagnostic',
    readOnly: true,
    capturedAt,
    binding,
    readability: {
      status: unboundReason !== null
        ? 'unbound'
        : refusedColumnCount === 0 ? 'all-requested-columns-attributable'
          : requestedAttributable > 0 ? 'partial' : 'no-requested-columns-attributable',
      unboundReason,
      requestedColumnCount: requested.length,
      attributableColumnCount: requestedAttributable,
      refusedColumnCount,
      refusalByCause,
      unknownIsNotAir: true,
    },
    playerChunk,
    request: {
      radius,
      verticalRadius,
      bounds: position === null ? null : {
        min: { x: Math.floor(position.x) - radius, y: Math.floor(position.y) - verticalRadius, z: Math.floor(position.z) - radius },
        max: { x: Math.floor(position.x) + radius, y: Math.floor(position.y) + verticalRadius, z: Math.floor(position.z) + radius },
      },
      columnCount: requested.length,
      loadedCount: requestedLoaded,
      unknownCount: requested.length - requestedLoaded,
      columns: requested,
    },
    loadedColumns: {
      count: rawColumns === null ? null : columns.size,
      keys: loaded,
      keysLimit: WORLD_CACHE_KEY_LIMIT,
      keysTruncated: rawColumns !== null && columns.size > loaded.length,
      available: rawColumns !== null,
    },
    dimensionProvenance: provenance === null ? {
      status: 'unavailable',
      liveDimension: null,
      taggedColumns: null,
      loadsTagged: null,
      attachAdopted: null,
      refusals: null,
      unloads: null,
      loadEvents: null,
      unloadEvents: null,
      lastColumnLoadAt: null,
      lastColumnUnloadAt: null,
      lastLocalColumnUnloadAt: null,
    } : {
      status: 'observed',
      liveDimension: provenance.liveDimension.length > 0 ? provenance.liveDimension : null,
      taggedColumns: provenance.taggedColumns,
      loadsTagged: provenance.loadsTagged,
      attachAdopted: provenance.attachAdopted,
      refusals: provenance.refusals,
      unloads: provenance.unloads,
      loadEvents: provenance.loadEvents,
      unloadEvents: provenance.unloadEvents,
      lastColumnLoadAt: provenance.lastColumnLoadAt,
      lastColumnUnloadAt: provenance.lastColumnUnloadAt,
      lastLocalColumnUnloadAt: provenance.lastLocalColumnUnloadAt,
    },
  }
}

function liveStateSnapshot(
  b: Bot,
  status: GenerationStatus | null,
  radius: number,
  verticalRadius: number,
  worldCache: Record<string, unknown>,
  capturedAt = new Date().toISOString(),
): Record<string, unknown> {
  const entity = b.entity
  const position = entity === undefined ? null : { x: entity.position.x, y: entity.position.y, z: entity.position.z }
  const truth = status?.truth === undefined
    ? {
        position,
        health: b.health ?? null,
        food: b.food ?? null,
        dimension: normalizeDimension(b.game?.dimension),
        onGround: entity?.onGround ?? null,
        inventory: inventorySummary(b),
      }
    : { ...status.truth, position }
  const center = position === null ? null : new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
  const counts: Record<string, number> = {}
  const hazards: Array<Record<string, unknown>> = []
  const portals: Array<Record<string, number>> = []
  const entityCacheAvailable = b.entities !== null && typeof b.entities === 'object'
  const cachedEntities = entityCacheAvailable ? Object.values(b.entities) : []
  const requestedColumns = (worldCache.request as { columns?: Array<{
    chunkX: number
    chunkZ: number
    loaded: boolean
    provenance: { kind?: string } | null
  }> } | undefined)?.columns ?? []
  const readableColumns = new Map(requestedColumns.map((column) => [chunkColumnKey(column),
    column.loaded === true && column.provenance?.kind === 'attributable',
  ]))
  const probeBlockAt = (x: number, y: number, z: number): string => {
    const column = { chunkX: Math.floor(x / 16), chunkZ: Math.floor(z / 16) }
    // This external probe is a truth surface too: do not report a cached block as
    // current-dimension fact unless the generation's provenance view attributes
    // the owning column. Missing diagnostics stay UNKNOWN, never air.
    if (readableColumns.get(chunkColumnKey(column)) !== true) return 'unknown'
    return blockNameAt(b, x, y, z)
  }
  let unknown = 0
  if (center !== null) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -verticalRadius; dy <= verticalRadius; dy += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const x = center.x + dx
          const y = center.y + dy
          const z = center.z + dz
          const name = probeBlockAt(x, y, z)
          if (name === 'unknown') {
            unknown += 1
            continue
          }
          counts[name] = (counts[name] ?? 0) + 1
          if (STATE_HAZARDS.has(name)) hazards.push({ name, position: { x, y, z } })
          if (name === 'nether_portal') portals.push({ x, y, z })
        }
      }
    }
  }
  const support = center === null
    ? { name: null, position: null }
    : { name: probeBlockAt(center.x, center.y - 1, center.z), position: { x: center.x, y: center.y - 1, z: center.z } }
  const sampleBounds = center === null ? null : {
    min: { x: center.x - radius, y: center.y - verticalRadius, z: center.z - radius },
    max: { x: center.x + radius, y: center.y + verticalRadius, z: center.z + radius },
  }
  const supportWithinSample = support.position !== null && sampleBounds !== null
    && support.position.x >= sampleBounds.min.x && support.position.x <= sampleBounds.max.x
    && support.position.y >= sampleBounds.min.y && support.position.y <= sampleBounds.max.y
    && support.position.z >= sampleBounds.min.z && support.position.z <= sampleBounds.max.z
  const entities: Array<Record<string, unknown>> = []
  if (center !== null) {
    for (const candidate of cachedEntities) {
      const candidatePosition = candidate.position
      if (candidatePosition === undefined) continue
      const distance = Math.hypot(candidatePosition.x - center.x, candidatePosition.y - center.y, candidatePosition.z - center.z)
      if (distance > radius) continue
      entities.push({
        id: candidate.id,
        username: candidate.username ?? null,
        name: candidate.name ?? candidate.mobType ?? null,
        type: candidate.type ?? null,
        kind: candidate.kind ?? null,
        distance: Number(distance.toFixed(3)),
        position: { x: candidatePosition.x, y: candidatePosition.y, z: candidatePosition.z },
        health: Number.isFinite(candidate.health) ? candidate.health : null,
      })
    }
  }
  entities.sort((a, b2) => Number(a.distance ?? Infinity) - Number(b2.distance ?? Infinity))
  const entityCache = {
    source: 'mineflayer-bot.entities',
    available: entityCacheAvailable,
    completeness: 'client-side-loaded-entity-cache-only',
    capturedAt,
    runId,
    generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
    worldKey: currentWorldKey(),
    playerEntityId: entity?.id ?? null,
    totalLoadedEntities: entityCacheAvailable ? cachedEntities.length : null,
    nearbyRadius: radius,
    nearbyEntityCount: entities.length,
    nearbyNonSelfEntityCount: entity === undefined
      ? entities.length
      : entities.filter((candidate) => candidate.id !== entity.id).length,
  }
  return {
    capturedAt,
    runId,
    generationHash,
    generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
    worldKey: currentWorldKey(),
    truth,
    world: {
      dimension: normalizeDimension(b.game?.dimension),
      version: b.version ?? null,
      serverBrand: b.game?.serverBrand ?? null,
      levelType: b.game?.levelType ?? null,
      timeOfDay: b.time?.timeOfDay ?? null,
      day: b.time?.day ?? null,
      raining: typeof b.isRaining === 'boolean' ? b.isRaining : null,
      thunderState: b.thunderState ?? null,
    },
    area: {
      radius,
      verticalRadius,
      blocks: {
        counts,
        unknown,
        hazards,
        portals,
        portalInteriorCount: portals.length,
        obsidianCount: counts.obsidian ?? 0,
        support,
        supportEvidence: {
          source: 'current-player-footing-probe',
          status: supportWithinSample
            ? support.name === 'unknown' ? 'refused-or-unavailable' : 'observed-within-sample'
            : 'outside-requested-sample',
          capturedAt,
          playerPosition: position,
          sampleBounds,
          position: support.position,
          coordinateIsCurrentPlayerFooting: supportWithinSample,
          refusal: support.name === 'unknown'
            ? (worldCache.readability as { unboundReason?: string | null }).unboundReason ?? 'column-unloaded-or-provenance-refused'
            : null,
        },
      },
      entities,
      entityCache,
    },
    worldCache,
  }
}

/** Best-effort death cause from the pre-death position and surroundings. */
function inferDeathCause(b: Bot, pos: Vec3Json | null, healthBefore: number | null): string {
  if (pos === null) return 'unknown'
  if (pos.y <= -64) return 'void'
  const x = Math.floor(pos.x)
  const feet = Math.floor(pos.y)
  const z = Math.floor(pos.z)
  for (const [dx, dy, dz] of [
    [0, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const) {
    const name = blockNameAt(b, x + dx, feet + dy, z + dz)
    if (name.includes('lava')) return 'lava'
    if (name.includes('water')) return 'water'
  }
  if (healthBefore !== null && healthBefore > 0) return 'damage'
  return 'unknown'
}

function registerDeathHazard(pos: Vec3Json, reason: string): DeathHazard {
  const memory = keyedMemory()
  const hazard = mergeHazard(memory.hazards, {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    reason,
    count: 1,
    source: 'production',
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
  })
  saveState('death-hazard')
  return hazard
}

function nearbyHostilesAtDeath(b: Bot, pos: Vec3Json | null): DeathRecoveryContext['nearbyHostiles'] {
  if (pos === null) return []
  const out: DeathRecoveryContext['nearbyHostiles'] = []
  for (const candidate of Object.values(b.entities)) {
    if (candidate.id === b.entity?.id || candidate.isValid === false || candidate.position === undefined) continue
    const name = String(candidate.name ?? candidate.mobType ?? candidate.kind ?? 'unknown')
    const kind = typeof candidate.kind === 'string' ? candidate.kind : undefined
    if (!isHostileEntityName(name, kind)) continue
    const distance = Math.hypot(candidate.position.x - pos.x, candidate.position.y - pos.y, candidate.position.z - pos.z)
    if (distance > DEATH_HOSTILE_RADIUS) continue
    out.push({ name, distance: Number(distance.toFixed(2)) })
  }
  out.sort((a, b2) => a.distance - b2.distance)
  return out.slice(0, 8)
}

interface DeathRecoveryInput {
  cause: string
  source: HazardSource
  telemetry: DeathTelemetry
  rehearsalMode?: RehearsalMode
}

/** Shared death/recovery pipeline: log DEATH, register the hazard, drop the
 * generation, archive the ledger, and force a fresh ladder computation. The
 * inventory is pre-captured by the caller (#34) and a `simulation` source never
 * touches the durable hazard set (#26). */
function beginDeathRecovery(b: Bot, input: DeathRecoveryInput): { pos: Vec3Json | null; lost: Record<string, number> } {
  const entity = b.entity
  const pos: Vec3Json | null = entity === undefined ? null : { x: entity.position.x, y: entity.position.y, z: entity.position.z }
  const lost = input.telemetry.lostInventory
  const simulated = input.source === 'simulation'
  const now = Date.now()
  if (!simulated) {
    while (recentDeathTimes.length > 0 && now - (recentDeathTimes[0] ?? now) > DEATH_RECOVERY_WINDOW_MS) recentDeathTimes.shift()
    recentDeathTimes.push(now)
    lastDeathRecoveryContext = {
      occurredAt: now,
      position: pos === null ? null : { ...pos },
      dimension: state.dimension,
      cause: input.cause,
      lostInventory: { ...lost },
      itemsLost: input.telemetry.itemsLost,
      nearbyHostiles: nearbyHostilesAtDeath(b, pos),
      recentDeathCount: recentDeathTimes.length,
      recentDeathWindowMs: DEATH_RECOVERY_WINDOW_MS,
    }
  }
  log('DEATH', {
    pos: pos === null ? '?' : fmtPos(pos),
    dimension: state.dimension,
    lostInventory: lost,
    itemsLost: input.telemetry.itemsLost,
    capturedBeforeDrop: input.telemetry.capturedBeforeDrop,
    cause: input.cause,
    healthBefore: lastHealth,
    simulated,
    ...(input.rehearsalMode === undefined ? {} : { rehearsalMode: input.rehearsalMode }),
  })
  lastDeathAt = now
  lastSeenDeathPosition = pos
  if (pos !== null) {
    if (shouldRegisterHazard(input.source)) {
      registerDeathHazard(pos, input.cause)
    } else {
      const rehearsal = recordRehearsalHazard(pos, input.cause)
      log('HAZARD_SKIPPED', {
        source: 'simulation',
        reason: input.cause,
        pos: fmtPos(pos),
        rehearsalCount: rehearsal.count,
        durableHazards: keyedMemory().hazards.length,
      })
    }
  }
  deathResetPending = true
  pendingResetReason = 'death'
  const oldGeneration = generation
  generation = null
  revokeLease(simulated ? 'death-simulated' : 'death')
  if (oldGeneration !== null) {
    try {
      oldGeneration.dispose()
    } catch {
      // best effort
    }
  }
  archiveLedger(simulated ? 'death-simulated' : 'death')
  saveState(simulated ? 'death-simulated' : 'death')
  log('LADDER_RESET', {
    reason: 'death',
    // The HOST cannot see the reset's inventory basis: it is read by the next
    // generation from the SETTLED post-respawn inventory. `lost` is the pre-loss
    // telemetry (the DEATH marker's `lostInventory`), so deriving `invEmpty` from
    // it stated the opposite of a genuine post-drop empty reset. Report the
    // basis honestly and let the generation's LADDER_RESET own `invEmpty`/rung.
    inventoryBasis: 'pending-respawn',
    lostItems: input.telemetry.itemsLost,
    cause: input.cause,
    simulated,
    ...(input.rehearsalMode === undefined ? {} : { rehearsalMode: input.rehearsalMode }),
  })
  return { pos, lost }
}

function handleBotDeath(b: Bot): void {
  const entity = b.entity
  const pos: Vec3Json | null = entity === undefined ? null : { x: entity.position.x, y: entity.position.y, z: entity.position.z }
  const cause = inferDeathCause(b, pos, lastHealth)
  // #34: capture from the last live observation; `b.inventory` is already cleared.
  const telemetry = preLossInventory.captureAtDeath(() => inventorySummary(b))
  beginDeathRecovery(b, { cause, source: 'production', telemetry })
}

interface RehearsalSnapshot {
  ledger: string | null
  /** #40: the simdeath rehearsal must snapshot/restore the typed class-A ledger. */
  ledgerMirror: GoalQueueSnapshot | null
  milestone: string | null
  milestoneIndex: number
  pendingResetReason: string | null
  deathResetPending: boolean
  hazards: Record<string, DeathHazard[]>
  durableHazardCount: number
}

function snapshotRehearsalState(): RehearsalSnapshot {
  let ledger: string | null = null
  try {
    if (existsSync(LEDGER)) ledger = readFileSync(LEDGER, 'utf8')
  } catch {
    // best effort: a missing ledger restore is reported as ledgerRestored=false
  }
  const hazards: Record<string, DeathHazard[]> = {}
  for (const [key, memory] of Object.entries(state.worldMemoryByKey)) {
    hazards[key] = normalizeWorldMemory(memory).hazards.map((hazard) => ({ ...hazard }))
  }
  return {
    ledger,
    ledgerMirror: state.ledger,
    milestone: state.milestone,
    milestoneIndex: state.milestoneIndex,
    pendingResetReason,
    deathResetPending,
    hazards,
    durableHazardCount: keyedMemory().hazards.length,
  }
}

function restoreRehearsalState(snapshot: RehearsalSnapshot): { ledger: boolean; hazards: boolean; hazardsRestoredTo: number } {
  let ledger = false
  if (snapshot.ledger !== null) {
    try {
      writeFileSync(LEDGER, snapshot.ledger)
      ledger = true
    } catch {
      // best effort
    }
  }
  state.ledger = snapshot.ledgerMirror
  state.milestone = snapshot.milestone
  state.milestoneIndex = snapshot.milestoneIndex
  let hazards = true
  for (const [key, list] of Object.entries(snapshot.hazards)) {
    const memory = state.worldMemoryByKey[key]
    if (memory === undefined) continue
    memory.hazards = list.map((hazard) => ({ ...hazard }))
  }
  if (keyedMemory().hazards.length !== snapshot.durableHazardCount) hazards = false
  pendingResetReason = snapshot.pendingResetReason
  deathResetPending = snapshot.deathResetPending
  return { ledger, hazards, hazardsRestoredTo: keyedMemory().hazards.length }
}

function connect(): void {
  if (shuttingDown) return
  const readinessError = generationModuleReadinessError(generationModule, CONTRACT_VERSION)
  if (readinessError !== null) {
    // This guard is deliberately at the sole createBot boundary as well as at
    // BOOT/reconnect scheduling, so a future caller cannot bypass validation.
    log('CONNECT_REFUSED', { trigger: 'connect-guard', reason: readinessError, generationHash })
    scheduleGenerationConnectionRetry('connect-guard', readinessError)
    return
  }
  log('CONNECT', { host: HOST, port: PORT, username: USERNAME, version: VERSION })
  let created: Bot
  try {
    created = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION, auth: 'offline' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('ERROR', { where: 'createBot', message })
    scheduleReconnect('error', 0)
    return
  }
  bot = created
  created.loadPlugin(pathfinderModule.pathfinder)
  created.loadPlugin(collectBlockPlugin)

  created.on('spawn', () => {
    reconnecting = false
    connectedSince = Date.now()
    disconnectReasonSeen = null
    disconnectDetail = null
    if (reconnectScheduledAt !== null) {
      log('RECONNECT_SUCCESS', {
        downtimeMs: Date.now() - reconnectScheduledAt,
        attempt: reconnectLedger.currentAttempt(),
        reconnects: reconnectLedger.reconnects,
      })
      reconnectScheduledAt = null
    }
    const wasDeath = deathResetPending
    deathResetPending = false
    // #34: a new life starts a new inventory; never attribute the previous
    // life's items to the next death.
    preLossInventory.reset()
    pendingResetReason = wasDeath ? 'death' : null
    const entity = created.entity
    const game = created.game as unknown as { dimension?: string; levelName?: string } | undefined
    if (entity !== undefined && startPosition === null) {
      startPosition = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
    }
    const observedDimension = normalizeDimension(game?.dimension)
    if (observedDimension !== state.dimension) {
      log('WORLD_KEY_CHANGED', { from: state.dimension, to: observedDimension, worldEpoch: state.worldEpoch })
      state.dimension = observedDimension
    }
    if (game?.levelName !== undefined) state.levelName = game.levelName
    clearListenerBaselineTimer()
    baselineCaptured = false
    listenerBaseline = {}
    listenerHostBaseline = {}
    log('SPAWN', {
      pos: entity === undefined ? '?' : fmtPos({ x: entity.position.x, y: entity.position.y, z: entity.position.z }),
      version: created.version,
      health: created.health,
      username: created.username,
      dimension: state.dimension,
      worldEpoch: state.worldEpoch,
      respawn: wasDeath,
      listeners: listenerBaseline,
    })
    saveState('spawn')
    lastHeartbeatAt = Date.now()
    void startGeneration(wasDeath ? 'respawn' : 'spawn')
  })

  created.on('health', () => {
    if (created.health > 0) {
      lastHealth = created.health
      // #34: freshest pre-death observation, taken while the bot is still alive
      // (the fatal update_health carries 0 and is skipped).
      preLossInventory.observe(inventorySummary(created))
    }
  })

  created.on('death', () => handleBotDeath(created))

  created.on('kicked', (reason: unknown) => {
    const text = typeof reason === 'string' ? reason : fmtValue(reason)
    disconnectReasonSeen = 'kicked'
    disconnectDetail = text
    log('ERROR', { where: 'bot.kicked', reason: text })
    revokeLease('kicked')
  })
  created.on('error', (error: Error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (disconnectReasonSeen === null) {
      disconnectReasonSeen = 'error'
      disconnectDetail = message
    }
    log('ERROR', { where: 'bot.error', message })
    revokeLease('error')
  })
  created.on('end', (reason: unknown) => {
    const detail = typeof reason === 'string' ? reason : reason === undefined || reason === null ? 'unknown' : fmtValue(reason)
    const classified: DisconnectReason = disconnectReasonSeen ?? 'end'
    const uptimeMs = connectedSince > 0 ? Date.now() - connectedSince : 0
    const entity = created.entity
    log('DISCONNECT', {
      reason: classified,
      detail,
      kickedReason: disconnectReasonSeen === 'kicked' ? disconnectDetail : null,
      uptimeMs,
      generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
      pos: entity === undefined ? '?' : fmtPos({ x: entity.position.x, y: entity.position.y, z: entity.position.z }),
      health: lastHealth,
      dimension: state.dimension,
    })
    revokeLease(classified)
    const old = generation
    generation = null
    if (old !== null) state.lastGenerationId = old.id
    state.generationId = null
    if (old !== null) disposeGeneration(old)
    connectedSince = 0
    scheduleReconnect(classified, uptimeMs)
  })
}

function scheduleReconnect(reason: DisconnectReason, uptimeMs: number): void {
  if (shuttingDown || reconnecting) return
  reconnecting = true
  const episode = reconnectLedger.noteDisconnect(reason, uptimeMs)
  syncReconnectStats()
  reconnectScheduledAt = Date.now()
  log('RECONNECT', { n: episode.n, reason, backoffMs: episode.backoffMs, uptimeMs: episode.uptimeMs })
  setTimeout(() => {
    if (shuttingDown) return
    reconnecting = false
    void connectWhenGenerationReady(`reconnect:${reason}`)
  }, episode.backoffMs)
}

// ---------------------------------------------------------------------------
// observation loop: ACTION / INVENTORY / MILESTONE / HEARTBEAT
// ---------------------------------------------------------------------------
setInterval(() => {
  if (generation === null || bot === null || bot.entity === undefined) return
  if (frozen) return
  let status: GenerationStatus
  try {
    status = generation.status()
  } catch (error) {
    log('ERROR', { where: 'observe.status', message: error instanceof Error ? error.message : String(error) })
    return
  }

  lastStatus = status
  const truth = status.truth
  // #34: keep the live-inventory observation fresh while the bot is alive.
  if (truth.health !== null && truth.health > 0) preLossInventory.observe(truth.inventory)
  // Milestone predicate evidence: the generation evaluates the ladder's own
  // predicates from live inventory + durable world memory; the HOST owns the
  // run-scoped, monotonic write. Absent on older generations -> no-op.
  if (Array.isArray(status.milestonePredicates) && status.milestonePredicates.length > 0) {
    if (milestonePredicateRecorder === null) {
      milestonePredicateRecorder = new MilestonePredicateRecorder({
        runId,
        sourceSha: bootSourceSha,
        dir: DATA,
        log: (event, detail) => log(event, detail),
      })
    }
    try {
      milestonePredicateRecorder.observe(status.milestonePredicates, { generationId: generation.id })
    } catch (error) {
      log('ERROR', { where: 'observe.milestonePredicates', message: error instanceof Error ? error.message : String(error) })
    }
  }
  const action = status.currentAction
  if (action !== null && action.id !== lastActionId) {
    lastActionId = action.id
    state.actions += 1
    log('ACTION', {
      n: state.actions,
      id: action.id,
      kind: action.kind,
      phase: action.phase,
      generationId: generation.id,
      pos: fmtPos(truth.position),
      rung: status.rungId,
    })
  } else if (action === null) {
    lastActionId = null
  }

  const stableInv = Object.keys(truth.inventory)
    .sort()
    .map((name) => `${name}:${truth.inventory[name] ?? 0}`)
    .join(',')
  const invHash = createHash('sha1').update(stableInv).digest('hex').slice(0, 12)
  if (invHash !== lastInventoryHash) {
    lastInventoryHash = invHash
    log('INVENTORY', { items: shortInv(truth.inventory), pos: fmtPos(truth.position) })
  }

  if (status.rungIndex > state.milestoneIndex) {
    state.milestoneIndex = status.rungIndex
    state.milestone = status.rungId
    // Frontier advance, NOT completion: `status.rungId` is the first UNSATISFIED
    // rung, so labelling it `done=true` claimed a rung was complete while its
    // items were still absent (observed live: `MILESTONE name=ender_pearls
    // done=true` with zero ender_pearl). This HOST marker stays frontier
    // telemetry. Completion claims come from the planner's milestone evidence
    // stream (#392), which records `done=true` only when the rung's OWN predicate
    // holds at that observation (`reason=predicate_satisfied`); otherwise it
    // records the typed `reason=frontier_advanced_without_predicate` /
    // `frontier_regressed_without_predicate` with the rung's own facts. Since
    // #392 that stream is on the planner side, so this marker needs no
    // compensation and must not be read as a completion.
    log('MILESTONE', { name: status.rungId, frontier: true, index: status.rungIndex, queueDone: status.queue.done, inventory: shortInv(truth.inventory) })
    saveState('milestone')
  }

  if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
    lastHeartbeatAt = Date.now()
    log('HEARTBEAT', {
      pos: fmtPos(truth.position),
      health: truth.health,
      running: status.running,
      rung: status.rungId,
      queue: status.queue.current?.description ?? 'none',
      depth: status.queue.depth,
      done: status.queue.done,
      action: status.currentAction?.kind ?? 'idle',
      inv: shortInv(truth.inventory),
    })
    commitHostLedger(goalQueueSnapshotFromState(status.queue, status.ledgerBasis), 'heartbeat')
  }
}, OBSERVE_MS)

// ---------------------------------------------------------------------------
// source watcher -> hot reload
// ---------------------------------------------------------------------------
function sourceFiles(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        stack.push(full)
      } else if (entry.name.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  return out
}

function signatureOfSource(): string {
  const hash = createHash('sha1')
  for (const root of [JEV_SRC, HERE]) {
    for (const full of sourceFiles(root).sort()) {
      try {
        const info = statSync(full)
        hash.update(`${full}:${info.mtimeMs}:${info.size}\n`)
      } catch {
        // file disappeared mid-edit; ignore
      }
    }
  }
  const config = process.env.BUDDY_SYSTEM2_CONFIG ?? join(HERE, 'system2.config.json')
  try {
    const info = statSync(config)
    hash.update(`${config}:${info.mtimeMs}:${info.size}\n`)
  } catch {
    // config absent; default-off is not a reload trigger
  }
  return hash.digest('hex')
}

setInterval(() => {
  const sig = signatureOfSource()
  if (sig !== lastSrcSignature) {
    const first = lastSrcSignature === ''
    lastSrcSignature = sig
    if (!first) scheduleReload('source-changed')
  }
}, OBSERVE_MS)

function scheduleReload(trigger: string): void {
  if (reloadTimer !== null) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    requestReload(trigger)
  }, RELOAD_DEBOUNCE_MS)
}

function requestReload(trigger: string): void {
  if (reloadArbiter === null) {
    reloadArbiter = new ReloadArbiter(
      (nextTrigger) => performReload(nextTrigger),
      () => !shuttingDown,
      (event, detail) => log(event, detail),
    )
  }
  reloadArbiter.request(trigger)
}

function depVersion(pkg: string): string {
  try {
    const raw = readFileSync(join(MC_AI, 'jev-agent', 'node_modules', pkg, 'package.json'), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function serverSeed(): string | null {
  try {
    // M2 reproducibility trials pass their exact staged config only to this
    // child process. The default path remains the resident's historical source.
    const propertiesPath = process.env.BUDDY_SERVER_PROPERTIES_PATH ?? '/home/s0u7a/mc-server/server.properties'
    const match = /^level-seed=(.*)$/m.exec(readFileSync(propertiesPath, 'utf8'))
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

function gitCommit(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: MC_AI, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function writeAcceptance(): string {
  const counts = listenerCounts()
  const expected = expectedListenerCounts()
  const record: AcceptanceRecord = {
    record: 'acceptance',
    runId,
    ts: new Date().toISOString(),
    // #395: the run's source identity is the boot commit, never the live checkout.
    ...acceptanceProvenance(bootSourceSha, gitCommit()),
    generationHash,
    generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
    modelAvailability: modelAvailability.snapshot(),
    contractVersion: CONTRACT_VERSION,
    stateSchemaVersion: state.schemaVersion,
    stateRevision: state.revision,
    dependencies: {
      mineflayer: depVersion('mineflayer'),
      'minecraft-protocol': depVersion('minecraft-protocol'),
      'minecraft-data': depVersion('minecraft-data'),
      'mineflayer-pathfinder': depVersion('mineflayer-pathfinder'),
      vec3: depVersion('vec3'),
    },
    serverId: state.serverId,
    dimension: state.dimension,
    levelName: state.levelName,
    worldEpoch: state.worldEpoch,
    seed: serverSeed(),
    botUsername: USERNAME,
    startPosition,
    mode: lastStatus?.policyKind === 'typesafe' ? 'llm' : 'deterministic',
    goalComplete: stats.goalComplete,
    wedge: stats.wedge,
    reconnects: stats.reconnects,
    reloads: state.reloads,
    reloadsChangedHash: stats.reloadsChangedHash,
    reloadsSkippedUnchanged: stats.reloadsSkippedUnchanged,
    reloadsFailed: stats.reloadsFailed,
    freezeCycles: stats.freezeCycles,
    listenerBaseline,
    listenerExpected: expected,
    listenerCurrent: counts,
    listenerLeak: listenerLeak(),
    worldMemoryKeys: Object.keys(state.worldMemoryByKey),
    // #379/#388/#378/#381: the run's durability markers (write-failure, quarantine,
    // lock-reclaim/loss, fatal-shutdown) as counts plus the exact marker names.
    durability: durability.acceptance(),
  }
  const path = join(DATA, `acceptance-${runId}.json`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}

/**
 * Swap order (atomic): build -> import -> attach -> structural smoke -> preflight
 * -> quiesce old -> ACTION LEASE SWITCH + snapshot generationId (one commit) ->
 * new start -> dispose old. Before the commit the candidate cannot act; a failed
 * start rolls back to a fresh generation from the previous module and disposes
 * every superseded instance (generation-swap.ts).
 */
async function performReload(trigger: string): Promise<void> {
  const started = Date.now()
  if (bot === null || bot.entity === undefined) {
    stats.reloadsFailed += 1
    log('RELOAD', { ok: false, trigger, reason: 'no live bot' })
    return
  }
  if (!frozen && !gateModelRecoveryStart(trigger, 'reload')) {
    deferredModelReloadTrigger = trigger
    return
  }
  let candidate: ResidentGeneration | null = null
  try {
    const built = await buildGeneration()
    if (built.outfile === currentBundle && generationModule !== null) {
      stats.reloadsSkippedUnchanged += 1
      log('RELOAD', { ok: true, trigger, skipped: 'unchanged', ms: Date.now() - started })
      return
    }
    const mod = (await import(`${pathToFileURL(built.outfile).href}?v=${built.hash}`)) as GenerationModule
    const readinessError = generationModuleReadinessError(mod, CONTRACT_VERSION)
    if (readinessError !== null) throw new Error(readinessError)
    const previousModule = generationModule
    const nextSeed: GenerationSeed = { revision: state.revision }
    const nextPending = newPendingProposals()
    const candidateSourceSha = gitCommit()
    const ctx = makeGenerationContext(bot, nextPending, nextSeed, built.hash, candidateSourceSha)
    candidate = mod.createGeneration(ctx)
    nextPending.generationId = candidate.id
    pendingByGeneration.set(candidate.id, nextPending)
    registerGenerationResources(candidate, ctx)
    if (!frozen) {
      const authorityCheck = inspectGenerationAuthority(candidate, `reload:${trigger}`)
      if (!authorityCheck.admission.allowed) {
        const retryDelayMs = logRejectedGenerationAuthority(
          candidate.id,
          `reload:${trigger}`,
          authorityCheck.authority,
          authorityCheck.admission,
          generation === null,
        )
        disposeGeneration(candidate)
        discardStagedProposals(candidate.id, 'reload-model-authority-rejected')
        candidate = null
        stats.reloadsFailed += 1
        if (modelAvailability.snapshot().state === 'degraded') deferredModelReloadTrigger = trigger
        log('RELOAD_REJECTED', {
          trigger,
          action: 'keep-previous-generation',
          reason: authorityCheck.admission.reason,
          retryDelayMs,
        })
        if (retryDelayMs !== null) scheduleGenerationRestart('model-unavailable', retryDelayMs)
        else if (generation === null) scheduleGenerationRestart('reload-failed')
        return
      }
    }
    candidate.attach()
    let smoke: StructuralSmokeResult
    try {
      smoke = runStructuralSmoke(candidate)
    } catch (smokeError) {
      discardStagedProposals(candidate.id, 'structural-smoke-failed')
      throw smokeError
    }
    log('SMOKE', { id: candidate.id, ok: smoke.ok, checks: smoke.checks.length, failures: smoke.failures })
    if (frozen) {
      // Frozen: validate and remember the new module, but do NOT swap/start it.
      // `resume` commits and starts exactly this module.
      discardStagedProposals(candidate.id, 'frozen-deferred')
      disposeGeneration(candidate)
      candidate = null
      generationModule = mod
      currentBundle = built.outfile
      generationHash = built.hash
      generationSourceSha = candidateSourceSha
      stats.reloadsChangedHash += 1
      log('RELOAD', { ok: true, trigger, deferred: 'frozen', ms: Date.now() - started, hash: built.hash, sourceSha: gitCommit(), contractVersion: mod.CONTRACT_VERSION })
      return
    }
    state.reloads += 1
    state.generations += 1
    saveState('reload-attempt')
    const preflight = runMissionPreflight(candidate)
    log('MISSION_PREFLIGHT', { id: candidate.id, ok: preflight.ok, goals: preflight.goalCount, reason: preflight.reason, trigger })
    // #49 + main: refresh the candidate's snapshotRevision to the host's current
    // revision right before the atomic commit, so a stale proposal is rejected.
    // `swapGeneration` is the single owner of live generation + lease + snapshot
    // generationId (and of rollback/disposal); `state.lastGenerationId` is set by
    // `commitOwner` to the superseded id, which test-reload-lifecycle pins.
    nextSeed.revision = state.revision
    log('LISTENERS', { phase: 'before_start', generationId: candidate.id, listeners: listenerCounts() })
    const outcome = await swapGeneration(makeSwapPorts(previousModule), candidate)
    candidate = null
    const outcomeGenerationId = 'generationId' in outcome ? outcome.generationId : null
    log('LISTENERS', {
      phase: 'after_start',
      generationId: outcomeGenerationId,
      listeners: listenerCounts(),
      expected: expectedListenerCounts(),
      outcome: outcome.status,
    })
    if (outcome.status !== 'committed') {
      if (outcome.status === 'rolled-back') {
        discardStagedProposals(outcome.from, 'reload-rolled-back-candidate')
        commitStagedProposals(outcome.generationId, 'reload-rollback')
      } else {
        discardStagedProposals(outcome.from, 'reload-failed-closed')
        for (const id of pendingByGeneration.keys()) discardStagedProposals(id, 'reload-failed-closed')
      }
      stats.reloadsFailed += 1
      const resumed = outcome.status === 'rolled-back' ? outcome.generationId : null
      log('RELOAD_REJECTED', {
        trigger,
        action: 'keep-previous-generation',
        rollback: outcome.status,
        resumed,
        generationId: resumed,
        leaseOwner: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
        snapshotGenerationId: state.generationId,
        reason: outcome.reason,
      })
      log('RELOAD', { ok: false, trigger, ms: Date.now() - started, message: outcome.reason })
      return
    }
    generationModule = mod
    currentBundle = built.outfile
    generationHash = built.hash
    generationSourceSha = candidateSourceSha
    lastActionId = null
    stats.reloadsChangedHash += 1
    commitStagedProposals(outcome.generationId, 'reload-commit')
    const counts = listenerCounts()
    log('RELOAD', {
      ok: true,
      trigger,
      ms: Date.now() - started,
      hash: built.hash,
      sourceSha: gitCommit(),
      id: outcome.generationId,
      generations: state.generations,
      listeners: counts,
      listenerLeak: listenerLeak(),
    })
    log('ACCEPTANCE', { path: writeAcceptance(), runId })
    const live = generation
    if (live !== null) watchGenerationStop(live)
  } catch (error) {
    if (candidate !== null) {
      if (generation === candidate) {
        generation = null
        state.lastGenerationId = candidate.id
        state.generationId = null
      }
      try {
        disposeGeneration(candidate)
      } catch {
        // best effort
      }
      discardStagedProposals(candidate.id, 'reload-failed')
    }
    stats.reloadsFailed += 1
    const message = error instanceof Error ? error.message : String(error)
    log('ERROR', { where: 'performReload', trigger, message })
    log('RELOAD_REJECTED', { trigger, message, action: 'keep-previous-generation' })
    log('RELOAD', { ok: false, trigger, ms: Date.now() - started, message })
    if (generation === null && !shuttingDown && !frozen && !deathResetPending) scheduleGenerationRestart('reload-failed')
  }
}

// ---------------------------------------------------------------------------
// control channel: unix socket, 0600
// ---------------------------------------------------------------------------
interface ControlRequest {
  id?: string
  cmd?: string
  args?: Record<string, unknown>
  /** `simdeath` destructive opt-in: {cmd:'simdeath', hard:true} or 'simdeath --hard'. */
  hard?: boolean
}

function controlReply(socket: Socket, request: ControlRequest, ok: boolean, data: unknown): void {
  socket.write(`${JSON.stringify({ id: request.id ?? null, ok, data })}\n`)
}

function freezeReport(reason: string, status: unknown): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(FREEZE_DIR, `freeze-${stamp}.json`)
  const payload = {
    record: 'freeze',
    ts: new Date().toISOString(),
    reason,
    bot: USERNAME,
    runId,
    generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
    worldKey: currentWorldKey(),
    reconcileKey: worldKeyString(currentWorldKey()),
    state,
    status,
    recentDecisions: state.ledger,
    listeners: listenerCounts(),
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}

async function handleControl(request: ControlRequest, socket: Socket): Promise<void> {
  const cmd = request.cmd ?? ''
  if (cmd === 'state') {
    if (bot === null || bot.entity === undefined) {
      controlReply(socket, request, false, { error: 'no live bot' })
      return
    }
    const rawRadius = Number(request.args?.radius ?? 8)
    const rawVerticalRadius = Number(request.args?.verticalRadius ?? 4)
    const radius = Number.isFinite(rawRadius) ? Math.max(1, Math.min(16, Math.floor(rawRadius))) : 8
    const verticalRadius = Number.isFinite(rawVerticalRadius) ? Math.max(1, Math.min(8, Math.floor(rawVerticalRadius))) : 4
    const status = generation === null ? null : generation.status()
    const targets = worldCacheDiagnosticTargets(bot, radius)
    let provenance: ReturnType<NonNullable<ResidentGeneration['worldProbeProvenance']>> | null = null
    try {
      if (generation?.worldProbeProvenance !== undefined) provenance = generation.worldProbeProvenance(targets)
    } catch {
      provenance = null
    }
    const capturedAt = new Date().toISOString()
    const cache = liveWorldCacheSnapshot(bot, radius, verticalRadius, capturedAt, provenance)
    controlReply(socket, request, true, liveStateSnapshot(bot, status, radius, verticalRadius, cache, capturedAt))
    return
  }
  if (cmd === 'report' || cmd === 'status') {
    const status = generation === null ? null : generation.status()
    const memory = keyedMemory()
    const inventoryObservation = currentInventoryObservation()
    syncReconnectStats()
    controlReply(socket, request, true, {
      runId,
      currentInventoryObservation: inventoryObservation,
      frozen,
      connected: bot !== null && bot.entity !== undefined,
      generations: state.generations,
      reloads: state.reloads,
      recoveries: state.recoveries,
      milestone: state.milestone,
      worldKey: currentWorldKey(),
      generationId: leaseManager.activeId.length > 0 ? leaseManager.activeId : null,
      generationHash,
      contractVersion: CONTRACT_VERSION,
      lease: leaseManager.snapshot(),
      reconnect: reconnectLedger.report(),
      hostLock: hostLockReport(),
      // #379/#388/#378/#381: same run-scoped durability mirror as the acceptance record.
      durability: durability.acceptance(),
      stats,
      worldMemory: {
        craftingTables: memory.craftingTables.length,
        furnaces: memory.furnaces.length,
        discoveredOres: memory.discoveredOres,
        traversalFailures: memory.traversalFailures.length,
        knownTraversals: memory.knownTraversals.length,
        hazards: memory.hazards.length,
        hardHazards: memory.hazards.filter((h) => h.count >= 2).length,
      },
      listeners: listenerCounts(),
      listenerBaseline,
      listenerExpected: expectedListenerCounts(),
      listenerLeak: listenerLeak(),
      acceptancePath: join(DATA, `acceptance-${runId}.json`),
      status,
      modelAvailability: modelAvailability.snapshot(),
    })
    return
  }
  if (cmd === 'reload') {
    requestReload('control')
    controlReply(socket, request, true, { scheduled: true })
    return
  }
  if (cmd === 'freeze') {
    frozen = true
    stats.freezeCycles += 1
    let path: string | null = null
    if (generation !== null) {
      const status = generation.status()
      path = freezeReport('control', status)
      await generation.quiesce()
      revokeLease('freeze')
    }
    log('FREEZE', { reason: 'control', report: path, freezeCycles: stats.freezeCycles })
    writeAcceptance()
    controlReply(socket, request, true, { frozen: true, report: path, runId })
    return
  }
  if (cmd === 'resume') {
    frozen = false
    const ok = await startGeneration('control:resume')
    log('RESUME', { ok, reconnect: false })
    writeAcceptance()
    controlReply(socket, request, true, { frozen: false, started: ok })
    return
  }
  if (cmd === 'reground') {
    // Operator recovery for semantic queue corruption. This is deliberately
    // frozen-only: clearing class-A semantic state while a generation can still
    // propose would let its delayed snapshot immediately resurrect the queue.
    // World epoch/memory and live server truth are untouched; the next explicit
    // resume rebuilds the queue from the current grounded frontier.
    if (!frozen) {
      controlReply(socket, request, false, { error: 'reground requires frozen=true' })
      return
    }
    const previousGoals = state.ledger?.goals.length ?? 0
    const previousBasis = state.ledger?.basis ?? null
    archiveLedger('control-reground')
    state.ledger = null
    saveState('control-reground')
    // Fence delayed proposals from the quiesced generation. A generation born
    // after resume is seeded from this new revision and remains admissible.
    ledgerRevision = state.revision
    log('LEDGER_REGROUND', {
      reason: 'control',
      previousGoals,
      previousBasis,
      revision: state.revision,
      worldKey: currentWorldKey(),
    })
    writeAcceptance()
    controlReply(socket, request, true, {
      frozen: true,
      ledgerCleared: true,
      previousGoals,
      revision: state.revision,
      runId,
    })
    return
  }
  if (cmd === 'simdeath' || cmd === 'simdeath --hard') {
    if (bot === null || bot.entity === undefined) {
      controlReply(socket, request, false, { error: 'no live bot' })
      return
    }
    const liveBot = bot
    const mode: RehearsalMode =
      cmd === 'simdeath --hard'
        ? 'hard'
        : parseRehearsalMode({ ...(request.args ?? {}), ...(request.hard === true ? { hard: true } : {}) })
    // #34: capture BEFORE any toss/clear so lostInventory is the real pre-loss set.
    const telemetry = capturePreLossInventory(() => inventorySummary(liveBot))
    // #26: the default (soft) rehearsal snapshots durable progress and restores it
    // afterwards, so a rehearsal can never cost the resident its ladder.
    const snapshot = mode === 'soft' ? snapshotRehearsalState() : null
    const old = generation
    generation = null
    if (old !== null) {
      try {
        await old.quiesce()
      } catch {
        // best effort
      }
      if (leaseManager.isActive(old.id)) revokeLease('simdeath')
      old.dispose()
    } else {
      revokeLease('simdeath')
    }
    if (mode === 'hard') {
      for (const item of liveBot.inventory.items()) {
        try {
          await liveBot.toss(item.type, null, item.count)
        } catch {
          // best effort: keep dropping the rest
        }
      }
      await delay(600)
    }
    const { pos, lost } = beginDeathRecovery(liveBot, {
      cause: mode === 'hard' ? 'simulated-hard' : 'simulated',
      source: 'simulation',
      telemetry,
      rehearsalMode: mode,
    })
    let restored: { ledger: boolean; hazards: boolean; hazardsRestoredTo: number } | null = null
    if (snapshot !== null) {
      restored = restoreRehearsalState(snapshot)
      log('SIMDEATH_RESTORE', {
        mode,
        ledgerRestored: restored.ledger,
        hazardsRestored: restored.hazards,
        hazardsBefore: snapshot.durableHazardCount,
        hazardsAfter: restored.hazardsRestoredTo,
        milestoneRestored: state.milestone,
        milestoneIndex: state.milestoneIndex,
      })
    }
    deathResetPending = false
    saveState(mode === 'hard' ? 'simdeath-hard' : 'simdeath-soft')
    log('SIMDEATH', {
      mode,
      destructive: mode === 'hard',
      simulated: true,
      pos: pos === null ? '?' : fmtPos(pos),
      lostInventory: telemetry.lostInventory,
      itemsLost: telemetry.itemsLost,
      capturedBeforeDrop: telemetry.capturedBeforeDrop,
      ledgerRestored: restored?.ledger ?? false,
      hazardsRestored: restored?.hazards ?? true,
    })
    setTimeout(() => {
      if (!shuttingDown) void startGeneration(mode === 'hard' ? 'simdeath-hard' : 'simdeath-soft')
    }, 800)
    controlReply(socket, request, true, {
      simulated: true,
      mode,
      destructive: mode === 'hard',
      remaining: Object.keys(lost).length,
      itemsLost: telemetry.itemsLost,
      capturedBeforeDrop: telemetry.capturedBeforeDrop,
      ledgerRestored: restored?.ledger ?? false,
      hazardsRestored: restored?.hazards ?? true,
    })
    return
  }
  if (cmd === 'worldreset') {
    const reset = await resetWorldEpoch({
      getActive: () => generation,
      detachActive: (active) => {
        generation = null
        state.lastGenerationId = active.id
        state.generationId = null
      },
      revokeLease: (reason) => revokeLease(reason),
      disposeActive: (active) => disposeGeneration(active as ResidentGeneration),
      incrementEpoch: () => {
        state.worldEpoch += 1
        return state.worldEpoch
      },
      initializeMemory: () => {
        archiveLedger('worldreset')
        keyedMemory()
        state.ledger = null
        pendingResetReason = 'worldreset'
      },
      persist: () => saveState('worldreset'),
      startGeneration: () => startGeneration('worldreset'),
    })
    log('WORLD_EPOCH', { worldEpoch: reset.epoch, worldKey: currentWorldKey(), generationStarted: reset.started })
    controlReply(socket, request, true, { worldEpoch: reset.epoch, worldKey: currentWorldKey(), generationStarted: reset.started })
    return
  }
  if (cmd === 'acceptance') {
    const path = writeAcceptance()
    controlReply(socket, request, true, { path })
    return
  }
  if (cmd === 'leakcheck') {
    controlReply(socket, request, true, {
      listeners: listenerCounts(),
      listenerBaseline,
      listenerExpected: expectedListenerCounts(),
      listenerLeak: listenerLeak(),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
    })
    return
  }
  if (cmd === 'gc') {
    const maybeGc = (globalThis as { gc?: () => void }).gc
    if (typeof maybeGc === 'function') maybeGc()
    controlReply(socket, request, true, { gc: typeof maybeGc === 'function' })
    return
  }
  if (cmd === 'milestone' || cmd === 'goal') {
    // The live frontier owns what is outstanding work: serve the generation's
    // projection, and fall back to the static M2 seed only until a generation has
    // reported one (measured live `run-mubhn83u`: the frontier was `blaze_rods`
    // while this reply still advertised the satisfied `iron_ingot x3` rung).
    controlReply(
      socket,
      request,
      true,
      milestoneReport({
        milestone: state.milestone,
        milestoneIndex: state.milestoneIndex,
        ledgerMirror: state.ledger,
        status: lastStatus,
        fallback: { goalItem: GOAL_ITEM, goalCount: GOAL_COUNT },
      }),
    )
    return
  }
  if (cmd === 'quit') {
    controlReply(socket, request, true, { quitting: true })
    log('QUIT', { reason: 'control' })
    await shutdown('control-quit')
    return
  }
  controlReply(socket, request, false, { error: `unknown command: ${cmd}` })
}

function startControlServer(): void {
  if (existsSync(SOCK)) {
    try {
      rmSync(SOCK)
    } catch {
      // ignore
    }
  }
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) {
          try {
            const request = JSON.parse(line) as ControlRequest
            void handleControl(request, socket)
          } catch (error) {
            socket.write(`${JSON.stringify({ id: null, ok: false, data: { error: error instanceof Error ? error.message : String(error) } })}\n`)
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => undefined)
  })
  server.on('error', (error: Error) => log('ERROR', { where: 'control.server', message: error.message }))
  server.listen(SOCK, () => {
    try {
      chmodSync(SOCK, 0o600)
    } catch {
      // ignore
    }
    log('CONTROL', { socket: SOCK })
  })
  controlServer = server
}

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------
/**
 * #384: the graceful order is fixed by `runShutdownSequence`: quiesce, evidence,
 * persist, dispose, disconnect, CLOSE the control server (awaited, bounded), and
 * only then release the host lock. A second resident can no longer boot into a
 * host whose control socket is still accepting commands, and a throwing step never
 * skips the close/release/exit tail.
 */
async function shutdown(reason: string): Promise<void> {
  await runShutdownSequence({
    log,
    alreadyShuttingDown: () => shuttingDown,
    markShuttingDown: () => {
      shuttingDown = true
    },
    quiesce: async () => {
      clearListenerBaselineTimer()
      if (generationConnectionRetryTimer !== null) {
        clearTimeout(generationConnectionRetryTimer)
        generationConnectionRetryTimer = null
      }
      reloadArbiter?.stop()
      log('SHUTDOWN', { reason })
      const active = generation
      if (active !== null) {
        try {
          await active.quiesce()
        } finally {
          if (leaseManager.isActive(active.id)) revokeLease('shutdown')
        }
      }
    },
    writeAcceptance: () => {
      let acceptance: string | null = null
      try {
        acceptance = writeAcceptance()
      } catch {
        acceptance = null
      }
      log('ACCEPTANCE', { path: acceptance, runId })
      return acceptance
    },
    persistState: () => saveState('shutdown'),
    disposeGeneration: () => {
      if (generation !== null) {
        const active = generation
        generation = null
        disposeGeneration(active)
      }
    },
    disconnect: () => {
      try {
        bot?.quit(reason)
      } catch {
        // ignore
      }
    },
    closeServer: () => closeControlServer(controlServer, { socketPath: SOCK }),
    releaseLock: () => releaseHostLock(),
    exit: (code) => process.exit(code),
    exitCode: shutdownExitCodeForReason(reason),
    exitDelayMs: 800,
  })
}

// ---------------------------------------------------------------------------
// fatal handlers (#381: log-only is not enough)
// ---------------------------------------------------------------------------
const fatalHandlers = createFatalHandlers({
  log,
  durability,
  markShuttingDown: () => {
    shuttingDown = true
  },
  revokeLease: (reason) => revokeLease(reason),
  onFatal: () => {
    // Evidence first: the acceptance record must show the fatal shutdown.
    try {
      writeAcceptance()
    } catch {
      // ignore
    }
  },
  exit: (code) => process.exit(code),
})
process.on('uncaughtException', (error: Error) => fatalHandlers.uncaughtException(error))
process.on('unhandledRejection', (reason: unknown) => fatalHandlers.unhandledRejection(reason))
process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('exit', () => releaseHostLock())

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
state.firstSeenAt = state.firstSeenAt || Date.now()
// #380: the lock is acquired FIRST; only the owner commits the boot snapshot, so a
// losing resident cannot overwrite the winner's durable state with its own base.
const boot = openResidentBoot({ lock: hostLock, saveBootState: () => saveState('boot'), log })
if (!boot.ok) {
  log('BOOT_REFUSED', { reason: boot.reason, path: LOCK_PATH, holderPid: boot.lock.holderPid })
  process.exit(1)
}
log('BOOT', {
  pid: process.pid,
  runId,
  source: bootSourceSha,
  runtime: 'bun',
  runtimeVersion: Bun.version,
  bundle: currentBundle ?? 'none',
  milestone: state.milestone,
  generations: state.generations,
  reloads: state.reloads,
  contractVersion: CONTRACT_VERSION,
  schemaVersion: state.schemaVersion,
  revision: state.revision,
  worldEpoch: state.worldEpoch,
  worldKey: currentWorldKey(),
  cleanRunServerConfig: cleanRunServerConfigAtBoot({ runId, bootSourceSha }),
  frozen,
})
startControlServer()
void connectWhenGenerationReady('boot')
