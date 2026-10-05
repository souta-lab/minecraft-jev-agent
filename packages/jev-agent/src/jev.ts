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
import {
  DECISION_PROFILES,
  DEFAULT_DECISION_PROFILE_ID,
  createDirectDecisionBackend,
  resolveProfileCredential,
} from '../../jev-harness/providers/systemone-direct.ts'

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

/** Explicit backend selection; unset or blank -> the committed primary profile. */
export function resolveDecisionProfileId(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.BUDDY_DECISION_PROFILE ?? '').trim()
  return raw.length > 0 ? raw : DEFAULT_DECISION_PROFILE_ID
}

/**
 * Single swap point. Deterministic local policy is explicit-only; every normal
 * run receives the AuthorityJevPolicy served by exactly ONE explicit backend
 * profile. An unknown profile or a missing credential is fatal: no other
 * profile, model or deterministic policy is ever substituted.
 */
export function createJevPolicy(options: JevPolicyOptions): JevPolicy {
  if (options.forceFallback === true) return createLegacyJevPolicy(options)
  const profileId = options.decisionProfile ?? resolveDecisionProfileId()
  const profile = DECISION_PROFILES[profileId]
  if (profile === undefined) {
    throw new FatalModelError('jev-policy-profile', 1, `unknown decision profile ${JSON.stringify(profileId)}; no other profile is substituted`)
  }
  const backend = { profileId: profile.profileId, providerId: profile.providerId }
  if (profile.wireDialect === 'ai-gateway-evaluate') {
    const key = (options.resolveKey ?? resolveJevApiKey)()
    if (key === null) {
      throw new FatalModelError('jev-policy-key', 1, 'no gateway key resolved and forceFallback was not set')
    }
    return new AuthorityJevPolicy(options, key, { backend })
  }
  const credential = options.resolveKey !== undefined ? options.resolveKey() : resolveProfileCredential(profile)
  if (credential === null) {
    throw new FatalModelError(
      'jev-policy-key',
      1,
      `no key resolved for decision profile ${profileId} (${profile.secretFile ?? 'no credential source'}) and forceFallback was not set`,
    )
  }
  const direct = createDirectDecisionBackend(profile, credential, { timeoutMs: options.timeoutMs })
  // The profile pins the model (AI_GATEWAY_MODEL addresses the gateway dialect
  // only), and the backend - not the policy - holds the credential.
  return new AuthorityJevPolicy(
    { ...options, model: profile.modelId },
    { key: '', origin: direct.keyOrigin },
    { evaluate: direct.evaluate, backend },
  )
}
