// jev-harness/decoding.ts - strict response decoding (#438 section 10).
//
// "Jev is a typed decision model. Treat that as a hard contract."
//
// There is deliberately NO prose salvage here: no regex, no fuzzy matching, no
// case folding, no trim, no substring search, no "close enough" semantic parser,
// no LLM-like reinterpretation of a free-form answer. A malformed answer is
// `invalid_response`, and the caller must fail closed.
//
// Primitive contracts (provider spellings are lower-case and provider-specific;
// the decoder is the only place allowed to know them):
//   choice  -> `{ choice: <id> }` and <id> must be in the EXACT request set (I3)
//   boolean -> `{ probability: p }` with p finite and 0 <= p <= 1   (repo: beta)
//   score   -> `{ score: s }` with s finite and min <= s <= max

import type { ScoreScale } from './contract.ts'

export type DecodeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string }

export function decodeOk<T>(value: T): DecodeResult<T> {
  return { ok: true, value }
}

export function decodeFail<T>(detail: string): DecodeResult<T> {
  return { ok: false, detail }
}

const MAX_SHAPE_CHARS = 240

/** Bounded, non-authoritative description of a raw answer, for failure details. */
export function describeRawShape(raw: unknown): string {
  if (raw === undefined) return 'undefined'
  if (raw === null) return 'null'
  const type = typeof raw
  if (type !== 'object') return `${type}:${truncate(String(raw))}`
  if (Array.isArray(raw)) return `array(len=${raw.length})`
  const keys = Object.keys(raw as Record<string, unknown>).sort()
  return `object(keys=${keys.join(',') || '<none>'})`
}

function truncate(value: string): string {
  return value.length <= MAX_SHAPE_CHARS ? value : `${value.slice(0, MAX_SHAPE_CHARS)}...`
}

function member(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined
  return (source as Record<string, unknown>)[key]
}

export type ChoiceDecode =
  | { readonly kind: 'selected'; readonly candidateId: string }
  | { readonly kind: 'abstain'; readonly reason: 'provider_abstained' | 'provider_no_decision' }

/**
 * Choice decoding.
 *
 * `allowedIds` MUST be the candidate set of the exact request being answered
 * (I3). A perfectly valid id from another request/epoch is still invalid here.
 */
export function decodeChoice(
  raw: unknown,
  allowedIds: ReadonlySet<string>,
  options: { readonly allowAbstention: boolean } = { allowAbstention: false },
): DecodeResult<ChoiceDecode> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return decodeFail(`choice answer is not an object (${describeRawShape(raw)})`)
  }
  const choice = member(raw, 'choice')
  if (choice === null || choice === undefined) {
    if (options.allowAbstention) {
      const abstained = member(raw, 'abstention')
      if (abstained === true) return decodeOk({ kind: 'abstain', reason: 'provider_abstained' })
      return decodeFail(`choice answer missing 'choice' and the head declares provider abstention only via abstention=true`)
    }
    return decodeFail(`choice answer missing 'choice' (${describeRawShape(raw)})`)
  }
  if (typeof choice !== 'string') {
    return decodeFail(`choice answer 'choice' is ${typeof choice}, not a string id`)
  }
  if (choice !== choice.trim()) {
    return decodeFail(`choice id ${JSON.stringify(choice)} is not verbatim (whitespace salvage is disabled)`)
  }
  if (!allowedIds.has(choice)) {
    return decodeFail(
      `choice id ${JSON.stringify(choice)} is not in this request's candidate set (closed-world selection, #438 section 3)`,
    )
  }
  return decodeOk({ kind: 'selected', candidateId: choice })
}

/** Boolean/beta decoding: the repo concept is a probability, never a provider spelling. */
export function decodeBooleanProbability(raw: unknown): DecodeResult<number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return decodeFail(`boolean answer is not an object (${describeRawShape(raw)})`)
  }
  const probability = member(raw, 'probability')
  if (typeof probability !== 'number') {
    return decodeFail(
      `boolean answer 'probability' is ${typeof probability}, not a number (${describeRawShape(raw)}); ` +
        'a missing probability is not 0 or 0.5',
    )
  }
  if (!Number.isFinite(probability)) return decodeFail(`boolean probability is non-finite (${String(probability)})`)
  if (probability < 0 || probability > 1) {
    return decodeFail(`boolean probability ${probability} is outside the declared range [0,1]`)
  }
  return decodeOk(probability)
}

/** Score decoding against the head's declared ordered scale. */
export function decodeScore(raw: unknown, scale: ScoreScale): DecodeResult<number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return decodeFail(`score answer is not an object (${describeRawShape(raw)})`)
  }
  const score = member(raw, 'score')
  if (typeof score !== 'number') {
    return decodeFail(`score answer 'score' is ${typeof score}, not a number (${describeRawShape(raw)})`)
  }
  if (!Number.isFinite(score)) return decodeFail(`score is non-finite (${String(score)})`)
  if (score < scale.min || score > scale.max) {
    return decodeFail(`score ${score} is outside the declared scale ${scale.id} [${scale.min},${scale.max}]`)
  }
  return decodeOk(score)
}

/** Optional raw distribution on a boolean/score answer. Never fabricated when absent. */
export function decodeOptionalProbabilityMap(raw: unknown): Readonly<Record<string, number>> | null {
  const map = member(raw, 'probabilities')
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    out[key] = value
  }
  return out
}

/**
 * Choice distributions must cover only the request's closed world. A provider
 * distribution keyed by an unknown id makes the whole answer invalid: it means
 * the model answered a different question (#438 section 3).
 */
export function decodeChoiceDistribution(
  raw: unknown,
  allowedIds: ReadonlySet<string>,
): DecodeResult<Readonly<Record<string, number>>> {
  const map = member(raw, 'probabilities')
  if (map === undefined || map === null) return decodeOk({})
  if (typeof map !== 'object' || Array.isArray(map)) {
    return decodeFail(`choice 'probabilities' is not an object (${describeRawShape(map)})`)
  }
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (!allowedIds.has(key)) {
      return decodeFail(`choice distribution mentions unknown candidate id ${JSON.stringify(key)}`)
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return decodeFail(`choice distribution probability for ${JSON.stringify(key)} is not a finite number`)
    }
    out[key] = value
  }
  return decodeOk(out)
}

/** Provider-reported calibrated confidence (#438 section 12). Shape-checked, never trusted. */
export function decodeCalibratedConfidence(providerMetadata: unknown, questionId: string): number | null {
  const typesafe = member(providerMetadata, 'typesafe')
  const confidence = member(typesafe, 'confidence')
  const value = member(confidence, questionId)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
