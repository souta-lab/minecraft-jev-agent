/**
 * Fixture transition provenance for Executor.claim() call sites.
 *
 * Every actuation request is a subordinate mechanical leg of a kernel-admitted
 * transition contract. Mechanical fixtures do not run the kernel; they bind a
 * deterministic fixture transition identity derived from the candidate so that
 * re-claiming the same candidate keeps ownership while a different candidate
 * is rejected by the authority-conflict gate exactly as production intends.
 */
import type { Candidate } from './src/candidates.ts'
import type { ClaimResult, ExecutionClaimContext, Executor } from './src/executor.ts'

export function fixtureClaimContext(candidate: Candidate): ExecutionClaimContext {
  const id = typeof candidate?.id === 'string' && candidate.id.length > 0 ? candidate.id : 'fixture-action'
  return {
    transitionId: `fixture-transition:${id}`,
    transitionContractHash: `fixture-contract:${id}`,
    authorityLabel: 'fixture',
  }
}

/** Claim `candidate` on `executor` under deterministic fixture transition provenance. */
export function fixtureClaim(executor: Executor, candidate: Candidate): ClaimResult {
  return executor.claim(candidate, fixtureClaimContext(candidate))
}
