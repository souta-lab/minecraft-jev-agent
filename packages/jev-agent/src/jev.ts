// jev.ts - public AI authority facade.
//
// The historical Jev implementation remains available in jev-legacy.ts for
// deterministic/offline compatibility and shared DTO/logging helpers. Live Jev
// model authority is owned by the small auditable kernel in jev-authority.ts.

export * from './jev/client.ts'
export {
  AuthorityJevPolicy,
  AUTHORITY_PRIMARY_INSTRUCTIONS,
  authorityDecisionMeta,
  buildAuthorityQuestions,
} from './jev/authority.ts'
export type { AuthorityDecisionMeta, AuthorityTaggedJevResult } from './jev/authority.ts'

import { FatalModelError } from './modelFailure.ts'
import {
  abandonRequested as legacyAbandonRequested,
  createJevPolicy as createLegacyJevPolicy,
  resolveJevApiKey,
} from './jev/client.ts'
import type { JevPolicy, JevPolicyOptions, JevResult } from './jev/client.ts'
import { AuthorityJevPolicy, AUTHORITY_PRIMARY_INSTRUCTIONS, buildAuthorityQuestions } from './jev/authority.ts'
import type { AuthorityTaggedJevResult } from './jev/authority.ts'

/** Neutral public prompt: evidence is not silently upgraded into a hard ranking rule. */
export const PRIMARY_INSTRUCTIONS = AUTHORITY_PRIMARY_INSTRUCTIONS

/** Public question builder used by tests/tools now matches the real model path. */
export const buildQuestions = buildAuthorityQuestions

/**
 * Public beta adoption gate.
 *
 * The real authority policy stamps the exact Option instance's threshold and the
 * raw P(abandon=true) onto the JevResult. This function consumes that stamped
 * event-boundary decision verbatim. A caller-supplied threshold remains only for
 * explicit compatibility/tests; legacy/fallback results without authority
 * metadata use the historical global threshold helper.
 */
export function abandonRequested(result: JevResult, threshold?: number): boolean {
  if (threshold !== undefined) return legacyAbandonRequested(result, threshold)
  const tagged = result as Partial<AuthorityTaggedJevResult>
  const decision = tagged.authorityDecision
  if (decision !== undefined) {
    const raw = result.answers.abandon_option?.probability
    return (
      typeof raw === 'number' &&
      Number.isFinite(raw) &&
      raw === decision.betaProbability &&
      decision.betaAdopt
    )
  }
  return legacyAbandonRequested(result)
}

/**
 * Single swap point. Deterministic local policy is explicit-only; every normal
 * run receives the new AuthorityJevPolicy and a missing key is fatal.
 */
export function createJevPolicy(options: JevPolicyOptions): JevPolicy {
  if (options.forceFallback === true) return createLegacyJevPolicy(options)
  const resolve = options.resolveKey ?? resolveJevApiKey
  const key = resolve()
  if (key === null) {
    throw new FatalModelError('jev-policy-key', 1, 'no gateway key resolved and forceFallback was not set')
  }
  return new AuthorityJevPolicy(options, key)
}
