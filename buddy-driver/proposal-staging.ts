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
  KnownResourceJson,
  LedgerProposalEnvelope,
  LedgerReconciliationProposal,
  ResidentWorldMemory,
  TraversalFailure,
  Vec3Json,
  WorldMemoryDelta,
} from './resident-types.ts'

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
  worldMemory: WorldMemoryDelta[]
  ledger: LedgerProposalEnvelope | null
  ledgerReconcile: LedgerReconciliationProposal | null
}

export function newPendingProposals(): PendingProposals {
  return { speculative: true, generationId: null, worldMemory: [], ledger: null, ledgerReconcile: null }
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
  if (proposal.baseRevision > ctx.revision) {
    return { ok: false, reason: 'future-revision' }
  }
  return { ok: true, reason: null }
}

// ---------------------------------------------------------------------------
// world-memory merge (moved from agent-runner: single implementation)
// ---------------------------------------------------------------------------

function hazardKey(h: { x: number; y: number; z: number }): string {
  return `${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.z)}`
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

export function mergeStationDtos(target: Vec3Json[], found: Vec3Json[]): number {
  const seen = new Set(target.map((p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`))
  let added = 0
  for (const pos of found) {
    const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`
    if (seen.has(key)) continue
    seen.add(key)
    target.push({ x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) })
    added += 1
  }
  return added
}

export function mergeKnownResourceDtos(target: KnownResourceJson[], found: KnownResourceJson[]): number {
  const seen = new Set(target.map((resource) => `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`))
  let added = 0
  for (const resource of found) {
    const key = `${resource.name}@${Math.round(resource.x)},${Math.round(resource.y)},${Math.round(resource.z)}`
    if (seen.has(key)) continue
    if (target.length >= 256) break
    seen.add(key)
    target.push({
      name: resource.name,
      kind: resource.kind,
      x: Math.round(resource.x),
      y: Math.round(resource.y),
      z: Math.round(resource.z),
      ...(resource.dimension === undefined ? {} : { dimension: resource.dimension }),
      ...(resource.worldEpoch === undefined ? {} : { worldEpoch: resource.worldEpoch }),
      ...(resource.lastSeenAt === undefined ? {} : { lastSeenAt: resource.lastSeenAt }),
    })
    added += 1
  }
  return added
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
 * Merge ONE staged world-memory delta into the live memory. This is the only
 * merge implementation; it mutates `memory` and never writes a file.
 */
export function mergeWorldMemoryDelta(memory: ResidentWorldMemory, delta: WorldMemoryDelta, log: ProposalLog): void {
  if (delta.craftingTables !== undefined) mergeStationDtos(memory.craftingTables, delta.craftingTables)
  if (delta.furnaces !== undefined) mergeStationDtos(memory.furnaces, delta.furnaces)
  if (delta.discoveredOres !== undefined) {
    for (const ore of delta.discoveredOres) {
      if (!memory.discoveredOres.includes(ore)) memory.discoveredOres.push(ore)
    }
  }
  if (delta.knownResources !== undefined) mergeKnownResourceDtos(memory.knownResources, delta.knownResources)
  if (delta.removeKnownResources !== undefined) removeKnownResourceDtos(memory.knownResources, delta.removeKnownResources)
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
  /** host commit primitive invocations (always 1: proposals commit atomically) */
  writes: number
}

export interface CommitPendingInput {
  pending: PendingProposals
  /** live class-A memory for the current world key */
  memory: ResidentWorldMemory
  /** live class-A snapshot */
  state: AgentSnapshot
  guard: LedgerGuardContext
  log: ProposalLog
  /** HOST commit primitive: persist the whole snapshot atomically, exactly once. */
  save: (event: string) => void
  /** HOST-only archive of an inconsistent derived ledger (class-C mirror). */
  reconcileLedger?: (reason: string) => void
  /** HOST-only rewrite of the derived ledger mirror after a ledger commit. */
  writeLedgerMirror?: () => void
}

/**
 * Validate + apply staged proposals to the live snapshot/memory and commit them
 * with ONE `save(event)`. This runs ONLY at the host commit point; it refuses to
 * run under a speculative phase.
 */
export function commitPendingProposals(input: CommitPendingInput, event: string): ApplyResult {
  const { pending, memory, state, guard, log } = input
  guardDurableWrite('host-commit', 'agent-runner.mts:commitPendingProposals', pending.generationId ?? 'none', log)

  for (const delta of pending.worldMemory) mergeWorldMemoryDelta(memory, delta, log)
  const worldMemoryDeltasApplied = pending.worldMemory.length

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
  if (shouldSave) input.save(event)
  pending.speculative = false
  pending.worldMemory = []
  pending.ledger = null
  pending.ledgerReconcile = null
  return {
    worldMemoryDeltasApplied,
    ledgerApplied,
    ledgerRejected,
    reconciliationRequested,
    writes: shouldSave ? 1 : 0,
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
