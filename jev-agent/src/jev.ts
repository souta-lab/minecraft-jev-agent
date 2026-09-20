// jev.ts - public AI authority facade.
//
// The historical Jev implementation remains available in jev-legacy.ts for
// deterministic/offline compatibility and shared DTO/logging helpers. Live Jev
// model authority is owned by the small auditable kernel in jev-authority.ts.

export * from './jev-legacy.ts'
export { AuthorityJevPolicy, AUTHORITY_PRIMARY_INSTRUCTIONS, buildAuthorityQuestions } from './jev-authority.ts'

import { FatalModelError } from './modelFailure.ts'
import {
  createJevPolicy as createLegacyJevPolicy,
  resolveJevApiKey,
} from './jev-legacy.ts'
import type { JevPolicy, JevPolicyOptions } from './jev-legacy.ts'
import { AuthorityJevPolicy, AUTHORITY_PRIMARY_INSTRUCTIONS, buildAuthorityQuestions } from './jev-authority.ts'

/** Neutral public prompt: evidence is not silently upgraded into a hard ranking rule. */
export const PRIMARY_INSTRUCTIONS = AUTHORITY_PRIMARY_INSTRUCTIONS

/** Public question builder used by tests/tools now matches the real model path. */
export const buildQuestions = buildAuthorityQuestions

/**
 * Jev beta owns WHETHER the current Option ends by default. Shadow beta remains
 * available only as an explicit experiment/debug switch.
 */
export function resolveBetaAuthority(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = (env.BUDDY_BETA_AUTHORITY ?? '').trim().toLowerCase()
  if (raw === '' || raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes' || raw === 'authority') return true
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no' || raw === 'shadow') return false
  throw new Error(`invalid BUDDY_BETA_AUTHORITY=${JSON.stringify(env.BUDDY_BETA_AUTHORITY)}; expected authority|shadow`)
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
