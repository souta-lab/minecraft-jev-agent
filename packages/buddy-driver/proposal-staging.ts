// proposal-staging.ts - issue #5: the speculative-generation boundary.
//
// A generation constructed for a RELOAD is SPECULATIVE until the host commits
// the lease switch. During construction it may READ and SCAN, but it must not
// mutate durable state. It only returns plain-data PROPOSALS:
//
//   createGeneration(ctx)
//     -> read/scan
//     -> ctx.proposeWorldMemory(delta)          (staged)
//     -> ctx.proposeLedger(envelope)            (staged, #48 lineage)
//     -> ctx.proposeLedgerReconciliation(...)   (staged, host archives)
//     -> NO durable write
//
// At the commit point the HOST validates the proposals (including the #48
// revision/generation-lineage guard) and commits them in ONE atomic saveState.
// A generation that attempts a durable write is a violation, detected as
// `DURABLE_WRITE_VIOLATION site=<f> caller=<g>` (fatal in strict dev/test mode).
import { renameSync, writeFileSync } from 'node:fs'
import type { GoalQueueSnapshot } from '../jev-agent/src/goalQueue.ts'
import { partitionHazardsBySource } from './simdeath.ts'
import type {
  AgentSnapshot,
  DeathHazard,
  KnownPortalSiteJson,
  KnownResourceJson,
  KnownStructureSiteJson,
  KnownTraversalJson,
  LedgerProposalEnvelope,
  LedgerReconciliationProposal,
  KnownStation,
  ResidentWorldMemory,
  TraversalFailure,
  WorldMemoryDelta,
  WorldKey,
} from './resident-types.ts'
import { mergeKnownResourcesInto, mergeKnownTraversalsInto } from './resident-types.ts'
import type { DurableWriteOutcome } from './host-durability.ts'
import { normalizeStation, stationKey } from './station-memory.ts'
import { acceptsWorldMemoryProposal } from './world-epoch.ts'

export type ProposalLog = (event: string, detail?: Record<string, unknown>) => void

/** #5 tripwire marker. Greppable in dev/test outputs. */
export const DURABLE_WRITE_VIOLATION = 'DURABLE_WRITE_VIOLATION'

export type DurableWritePhase = 'speculative' | 'host-commit'

let strictSpeculativeWrites = false

/** Test/dev hook: any speculative durable write throws instead of only logging. */
export function setStrictSpeculativeWrites(on: boolean): void {
  strictSpeculativeWrites = on
}

/**
 * The ONE gate in front of a durable write. `host-commit` is allowed; any
 * `speculative` attempt is a contract violation and is reported as
 * `DURABLE_WRITE_VIOLATION site=<f> caller=<g>`.
 */
export function guardDurableWrite(
  phase: DurableWritePhase,
  site: string,
  caller: string,
  log: ProposalLog,
): boolean {
  if (phase === 'host-commit') return true
  log(DURABLE_WRITE_VIOLATION, { site, caller, phase })
  if (strictSpeculativeWrites) {
    throw new Error(`${DURABLE_WRITE_VIOLATION} site=${site} caller=${caller}`)
  }
  return false
}

/**
 * Route a generation-path durable write through the tripwire. Returns false and
 * skips `write` when the phase is speculative, so a regression cannot touch disk.
 */
export function guardedDurableWrite(
  phase: DurableWritePhase,
  site: string,
  caller: string,
  log: ProposalLog,
  write: () => void,
): boolean {
  if (!guardDurableWrite(phase, site, caller, log)) return false
  write()
  return true
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

export interface PendingProposals {
  /** true until the host commits this generation; then proposals are live. */
  speculative: boolean
  /** set by the host once `createGeneration` has returned its id */
  generationId: string | null
  worldKey: WorldKey | null
  worldMemory: WorldMemoryDelta[]
  ledger: LedgerProposalEnvelope | null
  ledgerReconcile: LedgerReconciliationProposal | null
}

export function newPendingProposals(): PendingProposals {
  return { speculative: true, generationId: null, worldKey: null, worldMemory: [], ledger: null, ledgerReconcile: null }
}

export function stageWorldMemory(pending: PendingProposals, delta: WorldMemoryDelta): void {
  pending.worldMemory.push(delta)
}

export function stageLedgerProposal(pending: PendingProposals, proposal: LedgerProposalEnvelope): void {
  pending.ledger = proposal
}

export function stageLedgerReconciliation(pending: PendingProposals, proposal: LedgerReconciliationProposal): void {
  pending.ledgerReconcile = proposal
}

export function hasPendingProposals(pending: PendingProposals): boolean {
  return pending.worldMemory.length > 0 || pending.ledger !== null || pending.ledgerReconcile !== null
}

// ---------------------------------------------------------------------------
// #48 ledger lineage guard
// ---------------------------------------------------------------------------

export type LedgerRejectionReason =
  | 'missing-revision'
  | 'missing-generation'
  | 'stale-revision'
  | 'stale-generation'
  | 'future-revision'

export interface LedgerGuardContext {
  /** host class-A revision at commit time (pre-bump) */
  revision: number
  /** generation id the host last committed as action owner */
  committedGenerationId: string | null
  /** current lease owner ('' when none) */
  activeGenerationId: string
  ledgerRevision?: number
}

export interface LedgerGuardResult {
  ok: boolean
  reason: LedgerRejectionReason | null
}

/**
 * Issue #48: no caller may omit identity/revision and silently bypass the guard.
 * A proposal from a superseded generation is rejected; the active/committed
 * generation is accepted even if the host committed an unrelated class-A event
 * (hazard/milestone) after construction, because it is still the action owner.
 */
export function validateLedgerProposal(
  proposal: LedgerProposalEnvelope,
  ctx: LedgerGuardContext,
): LedgerGuardResult {
  if (!Number.isFinite(proposal.baseRevision) || proposal.baseRevision < 0) {
    return { ok: false, reason: 'missing-revision' }
  }
  if (typeof proposal.generationId !== 'string' || proposal.generationId.length === 0) {
    return { ok: false, reason: 'missing-generation' }
  }
  const isCurrent =
    proposal.generationId === ctx.committedGenerationId || proposal.generationId === ctx.activeGenerationId
  if (!isCurrent) {
    return { ok: false, reason: proposal.baseRevision < ctx.revision ? 'stale-revision' : 'stale-generation' }
  }
  if (ctx.ledgerRevision !== undefined && proposal.baseRevision < ctx.ledgerRevision) {
    return { ok: false, reason: 'stale-revision' }
  }
  if (proposal.baseRevision > ctx.revision) {
    return { ok: false, reason: 'future-revision' }
  }
  return { ok: true, reason: null }
}

// ---------------------------------------------------------------------------
// world-memory merge (moved from agent-runner: single implementation)
// ---------------------------------------------------------------------------

function hazardKey(h: { x: number; y: number; z: number; dimension?: string }): string {
  return `${h.dimension ?? ''}:${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.z)}`
}

/** Merge a death coordinate. The HOST is the only writer; two deaths at the same
 * rounded coordinate make the hazard permanent (`count >= 2`). */
export function mergeHazard(target: DeathHazard[], found: DeathHazard): DeathHazard {
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
      dimension: found.dimension,
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

export function mergeStationDtos(target: KnownStation[], found: KnownStation[], kind: 'crafting_table' | 'furnace'): number {
  let added = 0
  for (const pos of found) {
    const key = stationKey(pos)
    const existing = target.find((station) => stationKey(station) === key)
    if (existing !== undefined) {
      Object.assign(existing, normalizeStation({ ...existing, ...pos }, kind))
      continue
    }
    target.push(normalizeStation(pos, kind))
    added += 1
  }
  return added
}

function removeStationDtos(target: KnownStation[], gone: KnownStation[], kind: 'crafting_table' | 'furnace'): void {
  const keys = new Set(gone.filter((station) => (station.kind ?? kind) === kind).map(stationKey))
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const station = target[index]
    if (station !== undefined && keys.has(stationKey(station))) target.splice(index, 1)
  }
}

/**
 * HOST-authoritative known-resource merge. Delegates to the ONE bounded merge in
 * resident-types.ts: at the cap an old redundant coordinate is evicted first
 * (`KNOWN_RESOURCE_EVICTED`), preserving the last anchor per resource identity when possible instead of the
 * sighting being dropped for the lifetime of the world key. The insert marker
 * stays owned by the generation scan, so this path emits only capacity events.
 */
export function mergeKnownResourceDtos(target: KnownResourceJson[], found: KnownResourceJson[], log?: ProposalLog): number {
  return mergeKnownResourcesInto(target, found, { log }).added
}

export function removeKnownResourceDtos(target: KnownResourceJson[], gone: KnownResourceJson[]): number {
  const keys = new Set(gone.map((resource) => `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`))
  let removed = 0
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const resource = target[index]
    if (resource === undefined) continue
    const key = `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
    if (!keys.has(key)) continue
    target.splice(index, 1)
    removed += 1
  }
  return removed
}

/**
 * #80: durable verified-portal sites merge/remove by origin x,y,z (widthAxis is
 * part of the record). Coordinates are rounded exactly like the other durable
 * merges so a re-observed site dedups instead of duplicating.
 */
export function mergeKnownPortalSiteDtos(target: KnownPortalSiteJson[], found: KnownPortalSiteJson[]): number {
  const key = (site: KnownPortalSiteJson): string => `${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`
  const seen = new Set(target.map(key))
  let added = 0
  for (const site of found) {
    const siteKey = key(site)
    if (seen.has(siteKey)) continue
    seen.add(siteKey)
    target.push({
      x: Math.round(site.x),
      y: Math.round(site.y),
      z: Math.round(site.z),
      widthAxis: site.widthAxis === 'z' ? 'z' : 'x',
      ...(site.dimension === undefined ? {} : { dimension: site.dimension }),
      ...(site.worldEpoch === undefined ? {} : { worldEpoch: site.worldEpoch }),
      ...(site.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: site.lastVerifiedAt }),
      ...(site.frame === undefined ? {} : { frame: site.frame.map((cell) => ({ ...cell })) }),
      ...(site.interior === undefined ? {} : { interior: site.interior.map((cell) => ({ ...cell })) }),
    })
    added += 1
  }
  return added
}

export function removeKnownPortalSiteDtos(target: KnownPortalSiteJson[], gone: KnownPortalSiteJson[]): number {
  const keys = new Set(gone.map((site) => `${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`))
  let removed = 0
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const site = target[index]
    if (site === undefined) continue
    if (!keys.has(`${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`)) continue
    target.splice(index, 1)
    removed += 1
  }
  return removed
}

/**
 * M3: durable Nether-structure sites merge/remove by anchor cell x,y,z (the
 * structure kind is part of the record). Coordinates are rounded exactly like the
 * other durable merges so a re-sensed cell dedups instead of duplicating. The cap
 * is a safety bound against an unbounded host list, not a filter: a fortress has
 * far fewer sensed body cells than this within one scan.
 */
export const KNOWN_STRUCTURE_SITE_CAP = 64

export function mergeKnownStructureSiteDtos(target: KnownStructureSiteJson[], found: KnownStructureSiteJson[]): number {
  const key = (site: KnownStructureSiteJson): string => `${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`
  const seen = new Set(target.map(key))
  let added = 0
  for (const site of found) {
    const siteKey = key(site)
    if (seen.has(siteKey)) continue
    if (target.length >= KNOWN_STRUCTURE_SITE_CAP) break
    seen.add(siteKey)
    target.push({
      x: Math.round(site.x),
      y: Math.round(site.y),
      z: Math.round(site.z),
      kind: site.kind,
      ...(site.blocks === undefined ? {} : { blocks: [...site.blocks] }),
      ...(site.dimension === undefined ? {} : { dimension: site.dimension }),
      ...(site.worldEpoch === undefined ? {} : { worldEpoch: site.worldEpoch }),
      ...(site.lastSeenAt === undefined ? {} : { lastSeenAt: site.lastSeenAt }),
    })
    added += 1
  }
  return added
}

export function removeKnownStructureSiteDtos(target: KnownStructureSiteJson[], gone: KnownStructureSiteJson[]): number {
  const keys = new Set(gone.map((site) => `${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`))
  let removed = 0
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const site = target[index]
    if (site === undefined) continue
    if (!keys.has(`${Math.round(site.x)},${Math.round(site.y)},${Math.round(site.z)}`)) continue
    target.splice(index, 1)
    removed += 1
  }
  return removed
}

/**
 * #354: HOST-authoritative traversal-fact merge. Delegates to the ONE bounded
 * merge in resident-types.ts (same cap/eviction order as known resources), so
 * the staged commit point and the live runtime delta path cannot diverge. A
 * re-observed leg refreshes/supersedes the remembered outcome.
 */
export function mergeKnownTraversalDtos(
  target: KnownTraversalJson[],
  found: readonly KnownTraversalJson[],
  log?: ProposalLog,
): number {
  return mergeKnownTraversalsInto(target, found, { log }).added
}

/**
 * Merge ONE world-memory delta into the live memory. This is the only merge
 * implementation: the staged commit point AND the live `proposeWorldMemory`
 * runtime path both route through it, so the two paths can never diverge. It
 * mutates `memory` and never writes a file.
 */
export function mergeWorldMemoryDelta(memory: ResidentWorldMemory, delta: WorldMemoryDelta, log: ProposalLog): void {
  if (delta.craftingTables !== undefined) mergeStationDtos(memory.craftingTables, delta.craftingTables, 'crafting_table')
  if (delta.furnaces !== undefined) mergeStationDtos(memory.furnaces, delta.furnaces, 'furnace')
  if (delta.removeStations !== undefined) {
    removeStationDtos(memory.craftingTables, delta.removeStations, 'crafting_table')
    removeStationDtos(memory.furnaces, delta.removeStations, 'furnace')
  }
  if (delta.discoveredOres !== undefined) {
    for (const ore of delta.discoveredOres) {
      if (!memory.discoveredOres.includes(ore)) memory.discoveredOres.push(ore)
    }
  }
  // Remove proven-gone cells BEFORE merging fresh sightings. The generation
  // replica does evictStaleKnownResources then mergeKnownResources, so matching
  // that order keeps the authoritative store and the replica converged: a cell
  // re-anchored across dimension/worldEpoch (same name@x,y,z key, new stamp) is
  // dropped first and then re-inserted, instead of being suppressed as a
  // duplicate and then deleted. It also makes the capacity victim the same in
  // both stores.
  if (delta.removeKnownResources !== undefined) removeKnownResourceDtos(memory.knownResources, delta.removeKnownResources)
  if (delta.knownResources !== undefined) mergeKnownResourceDtos(memory.knownResources, delta.knownResources, log)
  if (delta.knownPortalSites !== undefined) mergeKnownPortalSiteDtos(memory.knownPortalSites, delta.knownPortalSites)
  if (delta.removeKnownPortalSites !== undefined) {
    removeKnownPortalSiteDtos(memory.knownPortalSites, delta.removeKnownPortalSites)
  }
  if (delta.knownStructureSites !== undefined) mergeKnownStructureSiteDtos(memory.knownStructureSites, delta.knownStructureSites)
  if (delta.removeKnownStructureSites !== undefined) {
    removeKnownStructureSiteDtos(memory.knownStructureSites, delta.removeKnownStructureSites)
  }
  if (delta.knownTraversals !== undefined) mergeKnownTraversalDtos(memory.knownTraversals, delta.knownTraversals, log)
  if (delta.mined !== undefined) {
    for (const [key, count] of Object.entries(delta.mined)) {
      memory.mined[key] = (memory.mined[key] ?? 0) + count
    }
  }
  if (delta.traversalFailures !== undefined) {
    memory.traversalFailures = delta.traversalFailures.map((t: TraversalFailure) => ({
      ...t,
      from: { ...t.from },
      toward: { ...t.toward },
    }))
  }
  if (delta.moveFailures !== undefined) {
    memory.moveFailures = delta.moveFailures.map((entry) => ({ ...entry }))
  }
  // The cross-action repeat ledger is REPLACED, never merged: it is bounded
  // current state (which action is and is not grounded at which cell), not an
  // accumulating log, and its eviction order is the generation's own bounded
  // policy. A deep copy keeps the durable store free of the generation's objects.
  if (delta.repeatedOutcomes !== undefined) {
    memory.repeatedOutcomes = delta.repeatedOutcomes.map((entry) => ({ ...entry }))
  }
  // #oscillation-boundary: the record is REPLACED, never merged: it is one
  // episode's evidence, and `null` is the meaningful "the situation changed"
  // clear. A deep copy keeps the durable store free of the generation's objects.
  if (delta.localOscillation !== undefined) {
    memory.localOscillation =
      delta.localOscillation === null ? null : { ...delta.localOscillation, cells: [...delta.localOscillation.cells] }
  }
  if (delta.hazards !== undefined) {
    const { production, simulation } = partitionHazardsBySource(delta.hazards)
    for (const hazard of production) mergeHazard(memory.hazards, hazard)
    for (const hazard of simulation) {
      log('HAZARD_SKIPPED', {
        source: 'simulation',
        reason: hazard.reason,
        pos: `${hazard.x},${hazard.y},${hazard.z}`,
        where: 'world-memory-delta',
      })
    }
  }
}

// ---------------------------------------------------------------------------
// host commit
// ---------------------------------------------------------------------------

export interface ApplyResult {
  worldMemoryDeltasApplied: number
  ledgerApplied: boolean
  ledgerRejected: LedgerRejectionReason | null
  reconciliationRequested: boolean
  /**
   * host commit primitive invocations that LANDED (1 when proposals committed
   * atomically, 0 when no save was needed or the save REPORTED failure). #379: a
   * failed write must not be countable as a write.
   */
  writes: number
  /** outcome of the host commit primitive when one was invoked. */
  writeOk: boolean
  writeError: string | null
}

export interface CommitPendingInput {
  pending: PendingProposals
  /** live class-A memory for the current world key */
  memory: ResidentWorldMemory
  /** live class-A snapshot */
  state: AgentSnapshot
  guard: LedgerGuardContext
  log: ProposalLog
  /**
   * HOST commit primitive: persist the whole snapshot atomically, exactly once.
   * #379: it returns a durable-write outcome (never void), so a failed write is
   * representable and `writes`/`writeOk` reflect reality.
   */
  save: (event: string) => DurableWriteOutcome
  /** HOST-only archive of an inconsistent derived ledger (class-C mirror). */
  reconcileLedger?: (reason: string) => void
  /** HOST-only rewrite of the derived ledger mirror after a ledger commit. */
  writeLedgerMirror?: () => void
  worldKey?: WorldKey
}

/**
 * Validate + apply staged proposals to the live snapshot/memory and commit them
 * with ONE `save(event)`. This runs ONLY at the host commit point; it refuses to
 * run under a speculative phase.
 */
export function commitPendingProposals(input: CommitPendingInput, event: string): ApplyResult {
  const { pending, memory, state, guard, log } = input
  guardDurableWrite('host-commit', 'agent-runner.mts:commitPendingProposals', pending.generationId ?? 'none', log)

  let worldMemoryDeltasApplied = 0
  const worldMemoryAllowed =
    pending.worldKey === null || input.worldKey === undefined || acceptsWorldMemoryProposal(pending.worldKey, input.worldKey)
  if (!worldMemoryAllowed) {
    log('WORLDMEMORY_REJECTED', { reason: 'world-key-mismatch', sourceWorldKey: pending.worldKey, currentWorldKey: input.worldKey })
  } else {
    for (const delta of pending.worldMemory) mergeWorldMemoryDelta(memory, delta, log)
    worldMemoryDeltasApplied = pending.worldMemory.length
  }

  let ledgerApplied = false
  let ledgerRejected: LedgerRejectionReason | null = null
  if (pending.ledger !== null) {
    const verdict = validateLedgerProposal(pending.ledger, guard)
    if (verdict.ok) {
      state.ledger = pending.ledger.ledger
      ledgerApplied = true
      input.writeLedgerMirror?.()
    } else {
      ledgerRejected = verdict.reason
      log('STATE_PROPOSAL_REJECTED', {
        kind: 'ledger',
        source: 'generation',
        generationId: pending.ledger.generationId,
        baseRevision: pending.ledger.baseRevision,
        revision: guard.revision,
        reason: verdict.reason,
      })
    }
  }

  let reconciliationRequested = false
  if (pending.ledgerReconcile !== null) {
    reconciliationRequested = true
    input.reconcileLedger?.(pending.ledgerReconcile.reason)
  }

  const hasProposals = hasPendingProposals(pending)
  const changed = worldMemoryDeltasApplied > 0 || ledgerApplied || reconciliationRequested
  const shouldSave = changed || !hasProposals
  const outcome = shouldSave ? input.save(event) : null
  pending.speculative = false
  pending.worldMemory = []
  pending.ledger = null
  pending.ledgerReconcile = null
  return {
    worldMemoryDeltasApplied,
    ledgerApplied,
    ledgerRejected,
    reconciliationRequested,
    // #379: only a write that LANDED counts. A reported failure is surfaced as
    // writes=0/writeOk=false instead of the old unconditional writes=1.
    writes: outcome !== null && outcome.ok ? 1 : 0,
    writeOk: outcome === null || outcome.ok,
    writeError: outcome === null ? null : outcome.error,
  }
}

/**
 * Atomic snapshot write (tmp -> rename). The HOST's single durable-write
 * primitive; exposed so the commit contract is unit-testable with a real file.
 */
export function writeSnapshotAtomic(statePath: string, state: AgentSnapshot, suffix = '.tmp'): void {
  const tmp = `${statePath}${suffix}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, statePath)
}

// Re-exported for callers that need the envelope type without importing types.
export type { LedgerProposalEnvelope, LedgerReconciliationProposal, GoalQueueSnapshot }
