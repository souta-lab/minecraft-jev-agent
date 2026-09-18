// resident-types.ts - the HOST <-> RELOADABLE-GENERATION contract.
//
// The host owns the Mineflayer connection, the reconnect loop, the log, the
// durable state store and the FILE WRITES. The generation owns one version of the
// jev-agent intelligence (controller + planner), bundled as ONE hash-stamped ESM
// file and swapped atomically on hot reload.
//
// BOUNDARY RULE (P1): the host <-> generation contract is DATA-ONLY. No Block,
// Entity, Vec3, Window, Recipe or Bot instance is ever persisted or handed across
// as durable state. Positions cross the boundary as `Vec3Json` ({x,y,z}) and the
// consumer rehydrates with `new Vec3(...)` where it needs vector methods. A plain
// `{x,y,z}` object has `Object` as its prototype and therefore NO `.floored()`,
// `.offset()` etc. - that is the entire class of `pos.floored is not a function`.
//
// This file is imported with `import type` only, so the host's native TypeScript
// stripping removes it completely (no runtime import, no cycle).
import type { Bot } from 'mineflayer'
import type { GoalQueueSnapshot, GoalQueueState } from '../jev-agent/src/goalQueue.ts'

/** Bump when the host/generation interface changes incompatibly. */
export const CONTRACT_VERSION = 2

export interface Vec3Json {
  x: number
  y: number
  z: number
}

/** Server identity + dimension + world epoch. A world reset with the same seed is
 * still a different world, so stale coordinates must never leak across epochs. */
export interface WorldKey {
  serverId: string
  dimension: string
  worldEpoch: number
}

export function worldKeyString(key: WorldKey): string {
  return `${key.serverId}|${key.dimension}|${key.worldEpoch}`
}

/**
 * Thin traversal-failure memory. Never repeat hop-hop-hop on the same face:
 * record (obstacleSignature, from, toward, wallHeight, failureKind, attempts).
 * The order is: stock pathfinder detour -> STEP/stair-cut if the resource policy
 * allows -> suppress the candidate and replan.
 */
export interface TraversalFailure {
  obstacleSignature: string
  from: Vec3Json
  toward: Vec3Json
  wallHeight: number
  failureKind: string
  attempts: number
  lastSeenAt: number
}

/**
 * Provenance of a death hazard. `production` hazards come from real deaths and
 * may be persisted / consulted by candidate filtering. `simulation` hazards come
 * from the operator `simdeath` rehearsal and MUST stay in a separate,
 * non-durable namespace so a rehearsal can never poison a safe coordinate (#26).
 */
export type HazardSource = 'production' | 'simulation'

/** A coordinate that killed the bot. Registered on death; a coordinate that
 * kills twice is excluded permanently from dig/descent candidates. */
export interface DeathHazard {
  x: number
  y: number
  z: number
  /** best-effort inferred cause: void | lava | water | fall | suffocation | unknown */
  reason: string
  /** how many deaths happened at/next to this coordinate */
  count: number
  firstSeenAt: number
  lastSeenAt: number
  /** provenance tag. Absent is treated as `production` for old durable state;
   * `simulation` entries are refused by the production merge path (#26). */
  source?: HazardSource
}

/** Durable world model that must survive reloads/reconnects. Inventory and
 * position are NOT mirrored here - they are SERVER TRUTH, live on the bot, and
 * are re-observed from sensors after every reload/reconnect, never restored from
 * JSON. This holds only DURABLE SEMANTIC knowledge the bot cannot re-derive
 * cheaply. All coordinates are DTOs. */
export interface KnownResourceJson {
  /** block name at the remembered cell, e.g. "iron_ore" or "oak_log" */
  name: string
  /** broad class: ore (underground), log (surface tree), station */
  kind: 'ore' | 'log' | 'station'
  x: number
  y: number
  z: number
  /** world the cell was scanned in; a coordinate is only valid for this key (#14) */
  dimension?: string
  worldEpoch?: number
  /** epoch ms when the cell was last observed to exist */
  lastSeenAt?: number
}

export interface ResidentWorldMemory {
  /** placed crafting_table stations discovered by scanning the loaded world */
  craftingTables: Vec3Json[]
  /** placed furnace stations discovered by scanning the loaded world */
  furnaces: Vec3Json[]
  /** "x,y,z:block" -> times mined (depletion model, best-effort) */
  mined: Record<string, number>
  /** ore block names seen at least once in the world state */
  discoveredOres: string[]
  /** remembered coordinates of known resources (issue #43): ores and trees, so a
   * retrieval skill can navigate back when the resource is out of scan range */
  knownResources: KnownResourceJson[]
  /** thin 2-block-wall / stuck memory; suppress repeat attempts */
  traversalFailures: TraversalFailure[]
  /** death coordinates; a coordinate that kills twice is excluded (hard hazard) */
  hazards: DeathHazard[]
}

export function emptyWorldMemory(): ResidentWorldMemory {
  return {
    craftingTables: [],
    furnaces: [],
    mined: {},
    discoveredOres: [],
    knownResources: [],
    traversalFailures: [],
    hazards: [],
  }
}

/** Fill in any missing collection on a (possibly older) memory object. This is
 * the ONE normalisation point: call it before any read so a partially-written
 * mirror can never surface `undefined` to a `craftingTables`/`furnaces` read. */
export function normalizeWorldMemory(memory: ResidentWorldMemory): ResidentWorldMemory {
  memory.craftingTables = Array.isArray(memory.craftingTables) ? memory.craftingTables : []
  memory.furnaces = Array.isArray(memory.furnaces) ? memory.furnaces : []
  memory.mined = memory.mined ?? {}
  memory.discoveredOres = Array.isArray(memory.discoveredOres) ? memory.discoveredOres : []
  memory.knownResources = Array.isArray(memory.knownResources) ? memory.knownResources : []
  memory.traversalFailures = Array.isArray(memory.traversalFailures) ? memory.traversalFailures : []
  memory.hazards = Array.isArray(memory.hazards) ? memory.hazards : []
  return memory
}

/**
 * Issue #48: a class-A mutation proposal is never bare data. It carries the
 * revision it was based on AND the generation that produced it, so the host can
 * reject a stale/superseded proposal and no caller can silently bypass the guard.
 */
export interface LedgerProposalEnvelope {
  ledger: GoalQueueSnapshot
  /** class-A snapshot revision the generating generation was constructed from */
  baseRevision: number
  /** generation id that produced the proposal */
  generationId: string
}

/**
 * Issue #5: the generation may not archive/rename the host-owned ledger. It
 * reports the inconsistency and the HOST archives it at the commit point.
 */
export interface LedgerReconciliationProposal {
  generationId: string
  reason: string
}

/** What the generation proposes; the HOST is the only writer that commits it. */
export interface WorldMemoryDelta {
  craftingTables?: Vec3Json[]
  furnaces?: Vec3Json[]
  discoveredOres?: string[]
  knownResources?: KnownResourceJson[]
  /** cells proven gone (mined/replaced); the host drops them from the durable store (#14) */
  removeKnownResources?: KnownResourceJson[]
  mined?: Record<string, number>
  traversalFailures?: TraversalFailure[]
  hazards?: DeathHazard[]
}

/**
 * Issue #40: every durable artifact is exactly ONE of four state classes. This
 * distinction is the contract that keeps reload/rollback semantics exact.
 *
 *   A. Authoritative mission state - HOST transactional (single writer, atomic
 *      write, typed). Enough to resume correctly after a process restart with no
 *      planner/model cache: mission/ledger, worldEpoch, world memory (known
 *      resources, hazards, traversal/failure memory), milestone + generation
 *      bookkeeping, schema/revision metadata.
 *   B. Server truth - NEVER persisted as authority; always re-observed from the
 *      live Mineflayer bot after reload/reconnect (position/health/food/inventory/
 *      entities/open windows). See `ServerTruth`.
 *   C. Disposable optimization state - planner/advisor/Mercury caches, compiled
 *      generation bundles, replay indexes. Losing them may cost latency only and
 *      MUST NOT change correctness.
 *   D. Append-only evidence - JSONL calls/actions/outcomes/acceptance/freeze
 *      reports. Evidence only; never read back as state.
 */
export type StateClass = 'A' | 'B' | 'C' | 'D'

/**
 * THE authoritative mission snapshot (class A). Exactly one of these is persisted
 * to `buddy-state.json`; the HOST is its only writer. Generations PROPOSE
 * mutations (world-memory deltas, ledger) and the host commits them atomically
 * (tmp -> rename) with schema/revision validation. No field typed `unknown` is
 * authoritative restore state.
 */
export interface AgentSnapshot {
  /** schema version of this JSON file (independent of CONTRACT_VERSION) */
  schemaVersion: number
  /** monotonically increasing commit revision; bumped on every committed write */
  revision: number
  /** incremented when the world instance changes (world reset / explicit reset) */
  worldEpoch: number
  /** generation id the host last committed as action owner */
  generationId: string | null
  bot: string
  /** server identity this state was written for, e.g. "127.0.0.1:25565" */
  serverId: string
  /** dimension of the last observed world, e.g. "minecraft:overworld" */
  dimension: string
  /** last observed level name, when the server exposes one */
  levelName: string | null
  firstSeenAt: number
  updatedAt: number
  /** highest ladder rung index the bot has satisfied */
  milestoneIndex: number
  /** id of that rung (e.g. "iron_pickaxe") */
  milestone: string | null
  /** last committed goal-queue state - the durable mission ledger (class A). A
   * generation proposes it via `GenerationContext.proposeLedger`; the host commits.
   * `buddy-ledger.json` is a DERIVED compatibility mirror of this, never authority. */
  ledger: GoalQueueSnapshot | null
  /** durable semantic memory, namespaced by server|dimension|worldEpoch */
  worldMemoryByKey: Record<string, ResidentWorldMemory>
  /** how many generations have been attached in this process lifetime */
  generations: number
  /** how many hot reloads were performed */
  reloads: number
  /** how many times the host recovered after the controller stopped */
  recoveries: number
  lastGenerationId: string | null
  /** monotonic action counter for ACTION log lines */
  actions: number
}

/** Back-compat alias: the single class-A snapshot persisted to buddy-state.json. */
export type ResidentState = AgentSnapshot

/** SERVER TRUTH: re-observed from the live bot after every reload/reconnect. Never persisted. */
export interface ServerTruth {
  position: Vec3Json | null
  health: number | null
  food: number | null
  dimension: string | null
  onGround: boolean | null
  inventory: Record<string, number>
}

/**
 * The actuation lease. The HOST owns `activeGenerationId`; a generation may only
 * perform side-effecting bot calls while it is the active owner. The swap commit
 * point is the lease switch: before it the new generation cannot act, after it
 * the old generation cannot act. `id` is the generation's own id.
 */
export interface ActuationLease {
  /** the id the host currently considers the action owner ('' when none) */
  readonly activeId: string
  isActive(id: string): boolean
  assertActive(id: string, what: string): void
}

/** A read-only projection of the running generation, used by host logging/control. */
export interface GenerationStatus {
  running: boolean
  policyKind: string
  policyModel: string
  system2Model: string
  queue: GoalQueueState
  currentAction: { id: string; kind: string; phase: string; startedAt: number } | null
  /** SERVER TRUTH, DTO only */
  truth: ServerTruth
  /** number of goals this generation's planner will seed on start() (may be 0) */
  plannedGoals: number
  /** index of the first unsatisfied ladder rung (progress frontier) */
  rungIndex: number
  /** id of that rung */
  rungId: string
  /** true once start() has run and no irreversible action can happen before the lease */
  ready: boolean
  contractVersion: number
}

/** Structural smoke result: must PASS with an EMPTY plan and no completed goals. */
export interface StructuralSmokeResult {
  ok: boolean
  checks: string[]
  failures: string[]
}

/** MISSION preflight: separate from reload; hot reload never depends on a goal existing. */
export interface MissionPreflightResult {
  ok: boolean
  reason: string | null
  goalCount: number
}

/** Machine-readable acceptance record emitted per run. */
export interface AcceptanceRecord {
  record: 'acceptance'
  runId: string
  ts: string
  gitCommit: string | null
  generationHash: string | null
  generationId: string | null
  contractVersion: number
  stateSchemaVersion: number
  stateRevision: number
  dependencies: Record<string, string>
  serverId: string
  dimension: string
  levelName: string | null
  worldEpoch: number
  seed: string | null
  botUsername: string
  startPosition: Vec3Json | null
  mode: string
  goalComplete: boolean
  wedge: boolean
  reconnects: number
  reloads: number
  reloadsChangedHash: number
  reloadsSkippedUnchanged: number
  reloadsFailed: number
  freezeCycles: number
  listenerBaseline: Record<string, number>
  listenerCurrent: Record<string, number>
  listenerLeak: boolean
  worldMemoryKeys: string[]
}

/**
 * One generation of the reloadable intelligence. `quiesce()` must cancel every
 * in-flight action, stop the scheduler and persist the goal-queue ledger, while
 * leaving the Mineflayer connection untouched.
 */
export interface ResidentGeneration {
  readonly id: string
  readonly startedAt: number
  readonly rungIndex: number
  readonly rungId: string
  /** register listeners only (no timers, no side effects). Called before start(). */
  attach(): void
  /** begin scheduling. MUST assert the actuation lease for this id first. */
  start(): void
  /** stop timers/actions and persist; resolves after the in-flight action settles (bounded). */
  quiesce(): Promise<void>
  /** best-effort synchronous teardown. */
  dispose(): void
  status(): GenerationStatus
  /** structural validity of the module surface + frozen-data pure functions. */
  structuralSmoke(): StructuralSmokeResult
  /** mission-level preflight (goal exists, candidates generatable); never gates reload. */
  missionPreflight(): MissionPreflightResult
  /** controller stop reason, once it has stopped; null while running. */
  stopReason(): string | null
  /** true after the controller stopped for any reason */
  hasStopped(): boolean
}

export interface GenerationContext {
  bot: Bot
  /** structured log line: host prefixes the ISO timestamp; detail is JSON. */
  log: (event: string, detail?: Record<string, unknown>) => void
  /** the actuation lease; the generation asserts it before side effects. */
  lease: ActuationLease
  /** read-only durable semantic memory for the current world key (a COPY). */
  worldMemory: ResidentWorldMemory
  /** the world key this generation runs under. */
  worldKey: WorldKey
  /** the class-A revision this generation was constructed from (#48 lineage). */
  snapshotRevision: number
  /** the generation stages memory deltas; the HOST commits them at the commit point. */
  proposeWorldMemory(delta: WorldMemoryDelta): void
  /**
   * Issue #40/#48: the generation PROPOSES its authoritative ledger (class A); the
   * HOST validates lineage/revision and commits it atomically. Never a bare write.
   */
  proposeLedger(proposal: LedgerProposalEnvelope): void
  /**
   * Issue #5: report that the derived ledger mirror is inconsistent; the HOST
   * archives it at the commit point. The generation must never rename it.
   */
  proposeLedgerReconciliation(proposal: LedgerReconciliationProposal): void
  /** class-A ledger the HOST committed; the generation restores from THIS, not cache/logs. */
  ledgerSnapshot: GoalQueueSnapshot | null
  /** goal-queue ledger path handed to the controller (derived compatibility mirror). */
  ledgerPath: string
  /** jsonl log dir handed to the controller. */
  logDir: string
  /** configured objective seed. */
  goalItem: string
  goalCount: number
  /** why this generation was created fresh (e.g. "death"); drives LADDER_RESET. */
  resetReason: string | null
}

export interface GenerationModule {
  CONTRACT_VERSION: number
  createGeneration(ctx: GenerationContext): ResidentGeneration
}
