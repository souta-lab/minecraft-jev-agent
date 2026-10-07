// jev/tier-transition.ts - one-way paid -> free Typed Decision Plane continuity.
//
// Operator-mandated paid-tier continuity, implemented at the POLICY boundary so
// each tier keeps its own calibrated options, provenance and journal identity.
// Two complete AuthorityJevPolicy instances are constructed (paid and free,
// each against its own backend profile); the wrapper delegates decide() to the
// active one. Only a typed credit/entitlement exhaustion on the paid tier
// commits the one-way transition: the SAME grounded JevRequest is retried once
// through the free policy and every later decision is served there. Auth,
// bad_request, model_identity and every transient class (rate_limited, server,
// network, timeout) propagate unchanged - a transient outage still reaches the
// policy's own bounded retry and the host's generation-recovery fence.
//
// The transition is provenance-visible in both evidence planes (a durable
// `jev-tier-transition` journal record plus the mirrored
// DECISION_TIER_TRANSITION marker) and sticky for the rest of the process: the
// caller also flips BUDDY_DECISION_PROFILE so later generations construct the
// free profile directly. Model-recovery identity fencing is preserved: the
// wrapper advertises the committed edge via authoritySuccessionAllowed(), and
// the host tracker updates its pinned identity only on the observed transition
// event - every other provider/model identity still mismatches.

import {
  DECISION_PROFILES,
  DecisionUnavailableError,
  createDirectDecisionBackend,
  profileLowConfidenceFloor,
} from '../../../jev-harness/providers/systemone-direct.ts'
import type {
  DecisionAvailability,
  DecisionBackendProfile,
  DecisionCredential,
  DirectDecisionBackend,
} from '../../../jev-harness/providers/systemone-direct.ts'
import { FatalModelError } from '../modelFailure.ts'
import type { ModelAuthorityIdentity } from '../modelFailure.ts'
import { AuthorityJevPolicy } from './authority.ts'
import type { JevPolicy, JevPolicyOptions, JevRequest, JevResult } from './client.ts'

/**
 * The availability classes that prove the PAID tier itself is exhausted:
 * credit/billing/quota exhaustion and paid-entitlement refusal. Auth failure is
 * a credential defect (the same key serves the free profile), bad_request and
 * model_identity are request defects, and rate_limited/server/network/timeout
 * are transient - none of those can be helped by another tier.
 */
const PAID_TIER_EXHAUSTION = new Set<DecisionAvailability>(['credit', 'entitlement'])

/** Provenance detail emitted once, at the transition commit point. */
export interface DecisionTierTransition {
  readonly providerId: string
  readonly fromProfileId: string
  readonly toProfileId: string
  readonly fromModelId: string
  readonly toModelId: string
  readonly availability: DecisionAvailability
  readonly status: number | null
}

/**
 * Delegating JevPolicy over one paid and one free AuthorityJevPolicy. Identity
 * getters (`model`, `provider`, `profileId`, `lowConfidenceThreshold`) resolve
 * against the ACTIVE inner policy, so after the committed transition every
 * result, journal record and live stamp carries the free profile's own
 * identity and calibration - nothing from the paid policy leaks across.
 */
export class TierTransitionJevPolicy implements JevPolicy {
  private active: JevPolicy
  private transition: DecisionTierTransition | null = null

  constructor(
    private readonly paid: JevPolicy,
    private readonly free: JevPolicy,
    private readonly paidProfile: DecisionBackendProfile,
    private readonly freeProfile: DecisionBackendProfile,
    /**
     * Reads (and clears) the last typed transport failure observed on the paid
     * tier for the in-flight decide(). The AuthorityJevPolicy wraps provider
     * failures in FatalModelError, so the typed availability is captured at the
     * paid policy's evaluate seam where it is still typed.
     */
    private readonly takePaidFailure: () => DecisionUnavailableError | null,
    private readonly onTransition?: (transition: DecisionTierTransition) => void,
  ) {
    this.active = paid
  }

  get kind() {
    return this.active.kind
  }
  get model(): string {
    return this.active.model
  }
  get provider(): string | undefined {
    return this.active.provider
  }
  get profileId(): string | undefined {
    return this.active.profileId
  }

  /**
   * The SERVING profile's measured floor: env override, then the active
   * profile's own calibration, then the historical default. After the
   * transition this is the free profile's floor - the paid profile's measured
   * 0.2 never carries across.
   */
  get lowConfidenceThreshold(): number {
    return profileLowConfidenceFloor(this.active === this.free ? this.freeProfile : this.paidProfile, process.env)
  }

  /** The committed one-way edge, or null while the paid tier still serves. */
  get committedTransition(): DecisionTierTransition | null {
    return this.transition
  }

  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    try {
      return await this.active.decide(request, signal)
    } catch (error) {
      const failure = this.active === this.paid ? this.takePaidFailure() : null
      if (failure === null || !PAID_TIER_EXHAUSTION.has(failure.availability)) throw error
      this.transition = {
        providerId: this.paidProfile.providerId,
        fromProfileId: this.paidProfile.profileId,
        toProfileId: this.freeProfile.profileId,
        fromModelId: this.paidProfile.modelId,
        toModelId: this.freeProfile.modelId,
        availability: failure.availability,
        status: failure.status ?? null,
      }
      this.active = this.free
      this.onTransition?.(this.transition)
      return this.free.decide(request, signal)
    }
  }

  /**
   * Recovery-fence legality for the committed edge only: after transition,
   * {provider, toModel} is the declared successor of the pinned
   * {provider, fromModel}. Every other identity still mismatches.
   */
  authoritySuccessionAllowed(expected: ModelAuthorityIdentity, actual: ModelAuthorityIdentity): boolean {
    const transition = this.transition
    if (transition === null) return false
    return (
      expected.provider === transition.providerId &&
      expected.model === transition.fromModelId &&
      actual.provider === transition.providerId &&
      actual.model === transition.toModelId
    )
  }
}

/**
 * Build the tiered policy for a direct profile that declares
 * `paidExhaustionFallbackProfileId`. Each inner policy owns its profile's
 * calibration (explicit option overrides still win) and journals with its own
 * backend identity, so post-transition calls stamp d1:free/liquid-direct-d1-free
 * everywhere - not the paid outer identity.
 */
export function createTieredJevPolicy(
  profile: DecisionBackendProfile,
  credential: DecisionCredential,
  options: JevPolicyOptions,
  onTransition?: (transition: DecisionTierTransition) => void,
): JevPolicy {
  const fallbackId = profile.paidExhaustionFallbackProfileId
  const fallback = fallbackId === undefined ? undefined : DECISION_PROFILES[fallbackId]
  if (
    fallbackId === undefined ||
    fallback === undefined ||
    fallback.wireDialect !== 'typesafe-systemone/v1' ||
    fallback.baseURL === null
  ) {
    throw new FatalModelError(
      'jev-policy-profile',
      1,
      `profile ${profile.profileId} declares an unusable free-tier fallback ${JSON.stringify(fallbackId ?? null)}`,
    )
  }
  const transport = {
    timeoutMs: options.timeoutMs,
    ...(options.decisionFetch === undefined ? {} : { fetch: options.decisionFetch }),
  }
  const paidBackend = createDirectDecisionBackend(profile, credential, transport)
  const freeBackend = createDirectDecisionBackend(fallback, credential, transport)

  // Typed-exhaustion probe: decide() wraps provider failures in FatalModelError,
  // so the typed availability is captured here where it still exists.
  let lastPaidFailure: DecisionUnavailableError | null = null
  const probedPaidEvaluate = (async (args: Parameters<DirectDecisionBackend['evaluate']>[0]) => {
    try {
      return await paidBackend.evaluate(args)
    } catch (error) {
      if (error instanceof DecisionUnavailableError) lastPaidFailure = error
      throw error
    }
  }) as DirectDecisionBackend['evaluate']

  const key = { key: '', origin: paidBackend.keyOrigin }
  const paidPolicy = new AuthorityJevPolicy(
    { abandonThreshold: profile.abandonThreshold, ...options, model: profile.modelId },
    key,
    { evaluate: probedPaidEvaluate, backend: { profileId: profile.profileId, providerId: profile.providerId } },
  )
  // Free tier uses its own calibration slot; absent fields resolve to the
  // profile/defaults, never to the paid profile's measured values.
  const freePolicy = new AuthorityJevPolicy(
    { abandonThreshold: fallback.abandonThreshold, ...options, model: fallback.modelId },
    key,
    { evaluate: freeBackend.evaluate, backend: { profileId: fallback.profileId, providerId: fallback.providerId } },
  )
  return new TierTransitionJevPolicy(
    paidPolicy,
    freePolicy,
    profile,
    fallback,
    () => {
      const failure = lastPaidFailure
      lastPaidFailure = null
      return failure
    },
    onTransition,
  )
}
