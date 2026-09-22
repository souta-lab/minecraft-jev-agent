// jev-harness/candidates.ts - the closed-world candidate registry (#438 section 3/14/20).
//
// Rules enforced here:
//   I3  a decoded id must exist in the EXACT request's candidate set;
//   #14 candidate serialization is canonical, recorded, and permutation-testable;
//   #20 the harness may expose deterministic facts, never a hidden preference.

import type {
  CandidateFactValue,
  CandidateId,
  CandidateProbability,
  CandidateTargetIdentity,
  GroundedSemanticCandidate,
} from './contract.ts'
import { canonicalJson, sha256Hex, stableSeed } from './canonical.ts'

export class DuplicateCandidateIdError extends Error {
  constructor(readonly candidateId: CandidateId) {
    super(`duplicate candidate id ${JSON.stringify(candidateId)} in one request candidate set`)
    this.name = 'DuplicateCandidateIdError'
  }
}

export class InvalidCandidateError extends Error {
  constructor(candidateId: CandidateId, reason: string) {
    super(`invalid candidate ${JSON.stringify(candidateId)}: ${reason}`)
    this.name = 'InvalidCandidateError'
  }
}

/**
 * Hidden-preference field ban (#438 section 20).
 *
 * A field whose name says "this is the one the code would like" is policy hidden
 * from code review. The harness is a policy boundary, not a hiding place: such a
 * field must be an explicitly authorized, model-visible fact, not a ranking hint.
 */
const BANNED_PREFERENCE_FIELDS: readonly string[] = [
  'priority',
  'priorities',
  'recommended',
  'recommend',
  'preferred',
  'preference',
  'prefer',
  'best',
  'rank',
  'ranking',
  'weight',
  'defaultchoice',
  'default',
  'shouldchoose',
  'hiddenpriority',
  'm3preferred',
  'm3priority',
  'tryfirst',
  'score',
]

export class HiddenPreferenceFieldError extends Error {
  constructor(candidateId: CandidateId, field: string) {
    super(
      `candidate ${JSON.stringify(candidateId)} carries hidden preference field ${JSON.stringify(field)}: ` +
        '#438 section 20 forbids priority=/recommended=/M3Preferred=-style fields in candidate serialization',
    )
    this.name = 'HiddenPreferenceFieldError'
  }
}

function normalizeFieldName(field: string): string {
  return field.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

/** True when a fact key looks like a hidden preference field. */
export function isHiddenPreferenceField(field: string): boolean {
  const normalized = normalizeFieldName(field)
  if (normalized.startsWith('prefer')) return true
  return BANNED_PREFERENCE_FIELDS.includes(normalized)
}

/**
 * Validate one candidate. Throws: a preference field or a non-plain-data value is
 * a code bug at request construction time, and must fail loudly rather than be
 * silently stripped (stripping would make the hidden policy invisible).
 */
export function assertCandidateLegal(candidate: GroundedSemanticCandidate): void {
  const id = candidate.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidCandidateError(String(id), 'candidate id must be a non-empty string')
  }
  if (typeof candidate.skillKind !== 'string' || candidate.skillKind.length === 0) {
    throw new InvalidCandidateError(id, 'skillKind must be a typed non-empty string')
  }
  if (candidate.postcondition !== null && typeof candidate.postcondition !== 'string') {
    throw new InvalidCandidateError(id, 'postcondition must be a string or null')
  }
  for (const field of Object.keys(candidate.facts)) {
    if (isHiddenPreferenceField(field)) throw new HiddenPreferenceFieldError(id, field)
  }
  for (const [field, fact] of Object.entries(candidate.facts)) {
    if (typeof fact !== 'object' || fact === null || typeof (fact as { kind?: unknown }).kind !== 'string') {
      throw new InvalidCandidateError(id, `fact ${JSON.stringify(field)} must be a typed CandidateFactValue`)
    }
    const kind = (fact as { kind: string }).kind
    if (kind === 'number' && !Number.isFinite((fact as { value?: unknown }).value as number)) {
      throw new InvalidCandidateError(id, `fact ${JSON.stringify(field)} is a non-finite number`)
    }
    if (kind === 'number' && typeof (fact as { value?: unknown }).value !== 'number') {
      throw new InvalidCandidateError(id, `fact ${JSON.stringify(field)} number kind without number value`)
    }
    if (kind === 'boolean' && typeof (fact as { value?: unknown }).value !== 'boolean') {
      throw new InvalidCandidateError(id, `fact ${JSON.stringify(field)} boolean kind without boolean value`)
    }
    if (kind === 'string' && typeof (fact as { value?: unknown }).value !== 'string') {
      throw new InvalidCandidateError(id, `fact ${JSON.stringify(field)} string kind without string value`)
    }
  }
  if (candidate.target !== null) assertTargetLegal(id, candidate.target)
  // The candidate must be plain data all the way down (no live entity objects).
  canonicalJson(candidate as unknown)
}

function assertTargetLegal(candidateId: CandidateId, target: CandidateTargetIdentity): void {
  if (typeof target.identity !== 'string' || target.identity.length === 0) {
    throw new InvalidCandidateError(candidateId, 'target.identity must be a non-empty string')
  }
  if (target.facts !== undefined) {
    for (const field of Object.keys(target.facts)) {
      if (isHiddenPreferenceField(field)) throw new HiddenPreferenceFieldError(candidateId, field)
    }
  }
}

export function assertCandidateSet(candidates: readonly GroundedSemanticCandidate[]): void {
  const seen = new Set<CandidateId>()
  for (const candidate of candidates) {
    assertCandidateLegal(candidate)
    if (seen.has(candidate.id)) throw new DuplicateCandidateIdError(candidate.id)
    seen.add(candidate.id)
  }
}

/**
 * Canonical order (#438 section 14).
 *
 * The canonical order is by candidate id ONLY. It deliberately does not use
 * insertion order (which encodes the generating code's preference) and it does
 * not sort by any gameplay fact. Nothing in the harness may sort by a
 * hand-authored preference; `permuted` exists so evaluation can detect
 * first-item bias instead.
 */
export type CandidateOrderingKind = 'canonical' | 'as_requested' | 'permuted'

export interface CandidateOrdering {
  readonly kind: CandidateOrderingKind
  /** Required for `permuted`; recorded in the artifact so replay reproduces it. */
  readonly salt?: string
}

export interface OrderedCandidates {
  readonly candidates: readonly GroundedSemanticCandidate[]
  readonly ordering: CandidateOrderingKind
  readonly salt: string | null
}

export function canonicalOrder(
  candidates: readonly GroundedSemanticCandidate[],
): readonly GroundedSemanticCandidate[] {
  return [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Deterministic permutation: the same salt + the same candidate set always
 * produces the same serialization order, so a permuted evaluation run is still
 * replayable and the artifact can record what the model saw.
 */
export function permutedOrder(
  candidates: readonly GroundedSemanticCandidate[],
  salt: string,
): readonly GroundedSemanticCandidate[] {
  const base = canonicalOrder(candidates)
  const decorated = base.map((candidate, index) => ({
    candidate,
    key: stableSeed(`${salt}|${candidate.id}`),
    index,
  }))
  decorated.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key))
  return decorated.map((entry) => entry.candidate)
}

export function applyOrdering(
  candidates: readonly GroundedSemanticCandidate[],
  ordering: CandidateOrdering | undefined,
): OrderedCandidates {
  assertCandidateSet(candidates)
  const kind = ordering?.kind ?? 'canonical'
  switch (kind) {
    case 'canonical':
      return { candidates: canonicalOrder(candidates), ordering: 'canonical', salt: null }
    case 'as_requested':
      return { candidates: [...candidates], ordering: 'as_requested', salt: null }
    case 'permuted': {
      const salt = ordering?.salt ?? 'default-salt'
      return { candidates: permutedOrder(candidates, salt), ordering: 'permuted', salt }
    }
  }
}

/**
 * `candidateSetHash` (#438 section 5/18).
 *
 * Order-independent by construction: the hash is taken over the CANONICAL order
 * and every field the model can see. A raw reordering must not change decision
 * semantics, so it must not change this hash either; the serialization order that
 * was actually used is recorded separately as `candidateOrdering`/`salt`.
 */
export function candidateSetHash(candidates: readonly GroundedSemanticCandidate[]): string {
  assertCandidateSet(candidates)
  const payload = canonicalOrder(candidates).map(serializeCandidate)
  return sha256Hex(canonicalJson(payload))
}

/** The exact per-candidate payload the model sees, in canonical key order. */
export function serializeCandidate(candidate: GroundedSemanticCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    skillKind: candidate.skillKind,
    target: candidate.target,
    postcondition: candidate.postcondition,
    facts: candidate.facts,
  }
}

export function numberFact(value: number): CandidateFactValue {
  if (!Number.isFinite(value)) return { kind: 'unknown' }
  return { kind: 'number', value }
}

export function booleanFact(value: boolean): CandidateFactValue {
  return { kind: 'boolean', value }
}

export function stringFact(value: string): CandidateFactValue {
  return { kind: 'string', value }
}

export const unknownFact: CandidateFactValue = { kind: 'unknown' }
export const notObservedFact: CandidateFactValue = { kind: 'not_observed' }

/**
 * Human-readable criteria text generated from typed facts (#438 section 21).
 * The authoritative identity stays `id`/`skillKind`/`target`/`postcondition`;
 * this string is only what the provider prompt shows.
 */
export function candidateCriteriaText(candidate: GroundedSemanticCandidate): string {
  if (candidate.description !== undefined && candidate.description.length > 0) return candidate.description
  const facts = Object.entries(candidate.facts)
    .map(([key, fact]) => {
      if (fact.kind === 'unknown') return `${key}=unknown`
      if (fact.kind === 'not_observed') return `${key}=not_observed`
      return `${key}=${String(fact.value)}`
    })
    .sort()
  const target = candidate.target === null ? '' : ` target=${candidate.target.kind}:${candidate.target.identity}`
  const postcondition = candidate.postcondition === null ? '' : ` done=${candidate.postcondition}`
  const evidence = facts.length === 0 ? '' : ` [${facts.join(' ')}]`
  return `${candidate.skillKind}${target}${postcondition}${evidence}`
}

/** Build the provider-facing choice criteria map in serialization order. */
export function choiceCriteria(
  ordered: readonly GroundedSemanticCandidate[],
): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const candidate of ordered) criteria[candidate.id] = candidateCriteriaText(candidate)
  return criteria
}

/**
 * Deterministic distribution over the EXACT request candidate set. Ids the model
 * did not return get probability 0, ids outside the set are rejected upstream.
 * This is a projection of the raw provider distribution onto the closed world,
 * never an invention (#438 section 3/9).
 */
export function distributionOver(
  candidates: readonly GroundedSemanticCandidate[],
  probabilities: Readonly<Record<string, number>>,
): readonly CandidateProbability[] {
  const out: CandidateProbability[] = []
  for (const candidate of candidates) {
    const probability = probabilities[candidate.id]
    if (probability !== undefined && !Number.isFinite(probability)) {
      throw new InvalidCandidateError(candidate.id, 'non-finite probability in provider distribution')
    }
    out.push({ candidateId: candidate.id, probability: probability ?? 0 })
  }
  return out
}

export function candidateIds(candidates: readonly GroundedSemanticCandidate[]): readonly CandidateId[] {
  return candidates.map((candidate) => candidate.id)
}
