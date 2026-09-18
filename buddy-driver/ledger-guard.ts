// ledger-guard.ts - issue #48: the HOST-side ledger proposal guard.
//
// The authoritative mission ledger lives in `AgentSnapshot.ledger` (class A) and
// the HOST is its only writer. A reloadable generation may only PROPOSE a ledger
// via `GenerationContext.proposeLedger`; it must carry its identity and the ledger
// lineage revision it was seeded from. A proposal is rejected (and logged) when:
//
//   - the envelope is malformed / omits identity or revision  -> invalid-proposal
//   - it was emitted by a superseded or foreign generation     -> stale (generation)
//   - a newer class-A ledger commit already exists             -> stale (revision)
//   - it claims a revision from the future / unknown lineage   -> future-revision
//
// Pure functions only: no bot, no network, no filesystem. The caller supplies the
// persist step, so the same guard is unit-testable and used verbatim by the host.
import type { AgentSnapshot, LedgerProposal } from './resident-types.ts'
import { isGoalQueueSnapshot, type SnapshotLog } from './state-snapshot.ts'

/** HOST-owned ledger lineage: the state a proposal is validated against. */
export interface LedgerLineage {
  /** current HOST commit revision (monotonic, bumped on every save) */
  revision: number
  /** revision at which the authoritative ledger was last committed by a generation */
  ledgerRevision: number
  /** the generation the HOST currently considers the committed/allowed owner */
  generationId: string | null
}

export type LedgerProposalRejectReason = 'invalid-proposal' | 'stale' | 'future-revision'

export interface LedgerProposalRejection {
  ok: false
  reason: LedgerProposalRejectReason
  /** revision the proposal was based on, or null when the envelope was unparseable */
  revision: number | null
  /** the HOST lineage revision the proposal was compared against */
  current: number
  /** which identity check failed; only set for `stale` */
  stale?: 'generation' | 'revision'
}

export interface LedgerProposalAcceptance {
  ok: true
  /** base revision the accepted proposal was based on */
  revision: number
}

export type LedgerProposalDecision = LedgerProposalAcceptance | LedgerProposalRejection

/**
 * Structural validation. A proposal that omits `generationId` or `baseRevision`
 * is malformed - it must never be treated as "no guard needed" (the #48 bypass).
 */
export function isLedgerProposal(value: unknown): value is LedgerProposal {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.generationId !== 'string' || candidate.generationId.length === 0) return false
  if (typeof candidate.baseRevision !== 'number' || !Number.isFinite(candidate.baseRevision)) return false
  return isGoalQueueSnapshot(candidate.ledger)
}

/**
 * Decide whether a proposal may overwrite the authoritative ledger. Never mutates
 * anything. The generation check runs first: once a newer generation is committed
 * (or leased), any delayed callback from an older one is stale regardless of its
 * revision number.
 */
export function evaluateLedgerProposal(proposal: unknown, lineage: LedgerLineage): LedgerProposalDecision {
  if (!isLedgerProposal(proposal)) {
    return { ok: false, reason: 'invalid-proposal', revision: null, current: lineage.ledgerRevision }
  }
  if (lineage.generationId === null || proposal.generationId !== lineage.generationId) {
    return { ok: false, reason: 'stale', revision: proposal.baseRevision, current: lineage.ledgerRevision, stale: 'generation' }
  }
  if (proposal.baseRevision < lineage.ledgerRevision) {
    return { ok: false, reason: 'stale', revision: proposal.baseRevision, current: lineage.ledgerRevision, stale: 'revision' }
  }
  if (proposal.baseRevision > lineage.revision) {
    return { ok: false, reason: 'future-revision', revision: proposal.baseRevision, current: lineage.revision }
  }
  return { ok: true, revision: proposal.baseRevision }
}

/**
 * Validate and (only on acceptance) commit a generation proposal into the HOST
 * snapshot. Rejected proposals leave `snapshot.ledger` and `snapshot.revision`
 * untouched. `persist` is the HOST's atomic write (bumps the revision).
 */
export function commitLedgerProposal(
  snapshot: AgentSnapshot,
  rawProposal: unknown,
  lineage: LedgerLineage,
  log: SnapshotLog,
  persist: (event: string) => void,
  source: string,
): LedgerProposalDecision {
  const decision = evaluateLedgerProposal(rawProposal, lineage)
  if (!decision.ok) {
    log('LEDGER_PROPOSAL_REJECTED', {
      revision: decision.revision,
      current: decision.current,
      reason: decision.reason,
      stale: decision.stale ?? null,
      source,
      kind: 'ledger',
      stateRevision: lineage.revision,
      committedGeneration: lineage.generationId,
    })
    return decision
  }
  const accepted = rawProposal as LedgerProposal
  snapshot.ledger = accepted.ledger
  persist('ledger-proposal')
  return decision
}
