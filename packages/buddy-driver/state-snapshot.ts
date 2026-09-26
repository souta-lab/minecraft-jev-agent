// state-snapshot.ts - issue #40 class-A snapshot schema, migration and the
// single-writer commit rules. This is the HOST layer: pure functions, no bot,
// no network, so the schema contract is unit-testable without a live server.
import type { GoalQueueSnapshot, GoalQueueState, LedgerBasis, PlanIdentity } from '../jev-agent/src/goalQueue.ts'
import type { AgentSnapshot, ResidentWorldMemory } from './resident-types.ts'
import { normalizeWorldMemory } from './resident-types.ts'

/** Bump when the persisted snapshot shape changes incompatibly. */
export const AGENT_SNAPSHOT_SCHEMA_VERSION = 3

/**
 * Class B (server truth) field names. These are NEVER persisted as authority and
 * are stripped + re-observed if a hand-edited/legacy file contains them.
 */
export const SERVER_TRUTH_FIELDS = [
  'position',
  'health',
  'food',
  'onGround',
  'inventory',
  'entities',
  'openWindows',
  'openContainer',
  'heldItem',
] as const

/** Class C (disposable) artifacts: deletion may cost latency, never correctness. */
export const DISPOSABLE_CACHE_FIELDS = ['plannerCache', 'advisorCache', 'mercuryCache', 'bundle', 'replayIndex'] as const

/** Class D (append-only evidence): never read back as state. */
export const EVIDENCE_LOG_FIELDS = ['recentDecisions', 'log', 'logs', 'events'] as const

export type SnapshotLog = (event: string, detail?: Record<string, unknown>) => void

export interface SnapshotValidation {
  ok: boolean
  snapshot: AgentSnapshot | null
  foundVersion: number | null
  migratedFrom: number | null
  rejected: string | null
  serverTruthKeysFound: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asInt(value: unknown, fallback: number): number {
  return Math.trunc(asNumber(value, fallback))
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function normalizeDimension(dimension: unknown): string {
  const value = typeof dimension === 'string' && dimension.length > 0 ? dimension : 'minecraft:overworld'
  return value.includes(':') ? value : `minecraft:${value}`
}

function isQueuedGoal(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.status === 'string' &&
    typeof value.description === 'string'
  )
}

export function isGoalQueueSnapshot(value: unknown): value is GoalQueueSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.counter !== 'number' || !Array.isArray(value.goals)) return false
  return value.goals.every(isQueuedGoal)
}

export function goalQueueSnapshotFromState(state: GoalQueueState, basis?: LedgerBasis): GoalQueueSnapshot {
  let counter = 0
  for (const goal of state.goals) {
    const match = /^g(\d+):/.exec(goal.id)
    const parsed = match?.[1] === undefined ? Number.NaN : Number(match[1])
    if (Number.isFinite(parsed)) counter = Math.max(counter, parsed)
  }
  return { counter, goals: state.goals.map((goal) => ({ ...goal })), ...(basis === undefined ? {} : { basis }) }
}

function sanitizeLedgerBasis(value: unknown): LedgerBasis | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.worldKey !== 'string' ||
    value.worldKey.length === 0 ||
    typeof value.frontierRungId !== 'string' ||
    value.frontierRungId.length === 0 ||
    typeof value.frontierRungIndex !== 'number' ||
    !Number.isInteger(value.frontierRungIndex)
  ) {
    return undefined
  }
  return {
    worldKey: value.worldKey,
    frontierRungId: value.frontierRungId,
    frontierRungIndex: value.frontierRungIndex,
  }
}

function sanitizeGoalQueueSnapshot(value: GoalQueueSnapshot): GoalQueueSnapshot {
  const planIdentity = sanitizePlanIdentity(value.planIdentity)
  return {
    counter: Math.max(0, asInt(value.counter, 0)),
    goals: value.goals.map((goal) => ({ ...goal })),
    ...(sanitizeLedgerBasis(value.basis) === undefined ? {} : { basis: sanitizeLedgerBasis(value.basis) }),
    ...(planIdentity === undefined ? {} : { planIdentity }),
  }
}

/**
 * #plan-reconciliation: the plan/objective identity a durable queue was authored
 * under must survive the host round-trip, or a restore cannot tell a superseded
 * row from a current one. Unknown/malformed shapes are dropped (never guessed).
 */
function sanitizePlanIdentity(value: unknown): PlanIdentity | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.rungId !== 'string' || value.rungId.length === 0) return undefined
  if (typeof value.rungIndex !== 'number' || !Number.isInteger(value.rungIndex)) return undefined
  return {
    rungId: value.rungId,
    rungIndex: value.rungIndex,
    objectiveItem: typeof value.objectiveItem === 'string' ? value.objectiveItem : null,
    objectiveCount:
      typeof value.objectiveCount === 'number' && Number.isFinite(value.objectiveCount)
        ? Math.max(0, Math.floor(value.objectiveCount))
        : 0,
  }
}

export function findPersistedServerTruthKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  return SERVER_TRUTH_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(raw, field))
}

/**
 * Guard used before a persisted field could be consumed as server truth. The host
 * logs and strips; tests assert this throws so a regression is loud.
 */
export function assertServerTruthNotRestored(raw: unknown): string[] {
  const found = findPersistedServerTruthKeys(raw)
  if (found.length > 0) {
    throw new Error(`issue #40: persisted class-B server truth must never be restored from disk: ${found.join(', ')}`)
  }
  return found
}

export function emptyAgentSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  const now = Date.now()
  return {
    ...overrides,
    schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
    revision: asInt(overrides.revision, 0),
    worldEpoch: Math.max(1, asInt(overrides.worldEpoch, 1)),
    generationId: overrides.generationId ?? null,
    bot: overrides.bot ?? '',
    serverId: overrides.serverId ?? '',
    dimension: normalizeDimension(overrides.dimension),
    levelName: overrides.levelName ?? null,
    firstSeenAt: asNumber(overrides.firstSeenAt, now),
    updatedAt: asNumber(overrides.updatedAt, now),
    milestoneIndex: asInt(overrides.milestoneIndex, -1),
    milestone: overrides.milestone ?? null,
    ledger: null,
    worldMemoryByKey: {},
    generations: asInt(overrides.generations, 0),
    reloads: asInt(overrides.reloads, 0),
    recoveries: asInt(overrides.recoveries, 0),
    lastGenerationId: overrides.lastGenerationId ?? null,
    actions: asInt(overrides.actions, 0),
  }
}

function memoryScore(memory: ResidentWorldMemory): number {
  return memory.craftingTables.length + memory.furnaces.length + memory.discoveredOres.length + memory.moveFailures.length
}

export function normalizeAgentSnapshot(raw: Record<string, unknown>, now = Date.now()): AgentSnapshot {
  const base = emptyAgentSnapshot({
    bot: asString(raw.bot, ''),
    serverId: asString(raw.serverId, ''),
    dimension: normalizeDimension(raw.dimension),
    worldEpoch: Math.max(1, asInt(raw.worldEpoch, 1)),
    firstSeenAt: asNumber(raw.firstSeenAt, now),
  })

  const collected: Record<string, ResidentWorldMemory> = {}
  if (isRecord(raw.worldMemoryByKey)) {
    for (const [key, value] of Object.entries(raw.worldMemoryByKey)) {
      if (!isRecord(value)) continue
      collected[key] = normalizeWorldMemory(value as unknown as ResidentWorldMemory)
    }
  }
  if (isRecord(raw.worldMemory) && Object.keys(collected).length === 0) {
    const legacyKey = `${base.serverId}|${base.dimension}|${base.worldEpoch}`
    collected[legacyKey] = normalizeWorldMemory(raw.worldMemory as unknown as ResidentWorldMemory)
  }

  const worldMemoryByKey: Record<string, ResidentWorldMemory> = {}
  for (const [key, memory] of Object.entries(collected)) {
    const parts = key.split('|')
    const version = parts[2]
    const canonical = parts.length === 3 && parts[1] !== undefined && version !== undefined ? `${parts[0] ?? ''}|${normalizeDimension(parts[1])}|${version}` : key
    const existing = worldMemoryByKey[canonical]
    if (existing === undefined || memoryScore(memory) > memoryScore(existing)) worldMemoryByKey[canonical] = memory
  }

  return {
    ...base,
    schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
    revision: Math.max(0, asInt(raw.revision, 0)),
    worldEpoch: base.worldEpoch,
    generationId: asStringOrNull(raw.generationId),
    levelName: asStringOrNull(raw.levelName),
    updatedAt: asNumber(raw.updatedAt, now),
    milestoneIndex: asInt(raw.milestoneIndex, -1),
    milestone: asStringOrNull(raw.milestone),
    ledger: isGoalQueueSnapshot(raw.ledger) ? sanitizeGoalQueueSnapshot(raw.ledger) : null,
    worldMemoryByKey,
    generations: Math.max(0, asInt(raw.generations, 0)),
    reloads: Math.max(0, asInt(raw.reloads, 0)),
    recoveries: Math.max(0, asInt(raw.recoveries, 0)),
    lastGenerationId: asStringOrNull(raw.lastGenerationId),
    actions: Math.max(0, asInt(raw.actions, 0)),
  }
}

export function validateAgentSnapshot(raw: unknown, now = Date.now()): SnapshotValidation {
  const serverTruthKeysFound = findPersistedServerTruthKeys(raw)
  if (!isRecord(raw)) {
    return { ok: false, snapshot: null, foundVersion: null, migratedFrom: null, rejected: 'state is not an object', serverTruthKeysFound }
  }

  const version = raw.schemaVersion
  const foundVersion = typeof version === 'number' && Number.isInteger(version) ? version : null
  const looksLikeSnapshot = raw.worldMemory !== undefined || raw.worldMemoryByKey !== undefined || raw.ledger !== undefined

  const reject = (reason: string): SnapshotValidation => ({
    ok: false,
    snapshot: null,
    foundVersion,
    migratedFrom: null,
    rejected: reason,
    serverTruthKeysFound,
  })

  if (foundVersion === null) {
    if (!looksLikeSnapshot) return reject('missing schemaVersion')
    return {
      ok: true,
      snapshot: normalizeAgentSnapshot(raw, now),
      foundVersion: null,
      migratedFrom: 1,
      rejected: null,
      serverTruthKeysFound,
    }
  }
  if (foundVersion === AGENT_SNAPSHOT_SCHEMA_VERSION) {
    return { ok: true, snapshot: normalizeAgentSnapshot(raw, now), foundVersion, migratedFrom: null, rejected: null, serverTruthKeysFound }
  }
  if (foundVersion === 1 || foundVersion === 2) {
    return { ok: true, snapshot: normalizeAgentSnapshot(raw, now), foundVersion, migratedFrom: foundVersion, rejected: null, serverTruthKeysFound }
  }
  if (foundVersion > AGENT_SNAPSHOT_SCHEMA_VERSION) {
    return reject(`schemaVersion ${foundVersion} is newer than supported ${AGENT_SNAPSHOT_SCHEMA_VERSION}`)
  }
  return reject(`unknown schemaVersion ${foundVersion} (expected ${AGENT_SNAPSHOT_SCHEMA_VERSION})`)
}

/**
 * The only restore path for class A: validate/migrate, strip (never restore)
 * class B, and emit the class-A audit lines. `base` is used verbatim when the
 * snapshot is rejected, so a corrupt file can never poison mission state.
 */
export function restoreAgentSnapshot(raw: unknown, base: AgentSnapshot, log: SnapshotLog): AgentSnapshot {
  const result = validateAgentSnapshot(raw)
  if (result.serverTruthKeysFound.length > 0) {
    log('STATE_B_TRUTH_REJECTED', { keys: result.serverTruthKeysFound, restored: false, action: 'strip-and-reobserve' })
  }
  if (!result.ok || result.snapshot === null) {
    log('STATE_REJECTED', {
      reason: result.rejected,
      foundVersion: result.foundVersion,
      expectedVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
      action: 'default',
    })
    return base
  }
  if (result.migratedFrom !== null) {
    log('STATE_MIGRATED', {
      from: result.migratedFrom,
      to: AGENT_SNAPSHOT_SCHEMA_VERSION,
      revision: result.snapshot.revision,
      worldEpoch: result.snapshot.worldEpoch,
    })
  }
  log('STATE_LOADED', {
    schemaVersion: result.snapshot.schemaVersion,
    revision: result.snapshot.revision,
    worldEpoch: result.snapshot.worldEpoch,
    ledger: result.snapshot.ledger !== null,
  })
  return result.snapshot
}

export interface SnapshotServerRebindResult {
  snapshot: AgentSnapshot
  changed: boolean
  previousServerId: string
}

/**
 * A persisted snapshot is bound to the server identity that produced its
 * world-scoped facts. When the HOST is configured for another server, retain
 * the old keyed memory as archival state but start a new epoch with no active
 * generation, ladder milestone, or world-bound plan/ledger. The live connection
 * will establish current server truth after boot.
 */
export function rebindSnapshotServerIdentity(snapshot: AgentSnapshot, serverId: string): SnapshotServerRebindResult {
  if (snapshot.serverId === serverId) return { snapshot, changed: false, previousServerId: snapshot.serverId }

  const previousServerId = snapshot.serverId
  return {
    changed: true,
    previousServerId,
    snapshot: {
      ...snapshot,
      serverId,
      worldEpoch: Math.max(1, snapshot.worldEpoch) + 1,
      generationId: null,
      lastGenerationId: snapshot.generationId ?? snapshot.lastGenerationId,
      dimension: 'minecraft:overworld',
      levelName: null,
      milestoneIndex: -1,
      milestone: null,
      ledger: null,
    },
  }
}

/** Bump the commit revision and stamp the current schema. HOST-only commit step. */
export function bumpRevision(snapshot: AgentSnapshot, now = Date.now()): number {
  snapshot.schemaVersion = AGENT_SNAPSHOT_SCHEMA_VERSION
  snapshot.revision = Math.max(0, asInt(snapshot.revision, 0)) + 1
  snapshot.updatedAt = now
  return snapshot.revision
}
