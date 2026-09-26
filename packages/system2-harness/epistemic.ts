// system2-harness/epistemic.ts - unknown != false; absence != proof (#439 section 18).
//
// SHARED SHAPE (#438/#439): the discriminators and the "no defaulting API"
// property match `jev-harness/contract.ts` section 6 exactly. Do not add
// `valueOf()`/`unwrapWithDefault()`/`?? false` helpers here: the entire point is
// that fabricating certainty is inexpressible.
//
// The failure mode this prevents (#439 section 18):
//   `portal verified` / `portal known absent` / `portal not currently observed`
//   / `portal sensor unavailable` are four different facts. Collapsing the last
//   two into `[]`/`false` tells the model a structure disappeared when in truth
//   nobody looked.

export type Epistemic<T> =
  | { readonly state: 'known'; readonly value: T }
  | { readonly state: 'unknown' }
  | { readonly state: 'not_observed' }
  | { readonly state: 'sensor_error'; readonly detail: string }

export class UnknownFactError extends Error {
  constructor(context: string, state: string) {
    super(`epistemic fact is not known (${state}) where a value is required: ${context}`)
    this.name = 'UnknownFactError'
  }
}

export const UNKNOWN: Epistemic<never> = Object.freeze({ state: 'unknown' })
export const NOT_OBSERVED: Epistemic<never> = Object.freeze({ state: 'not_observed' })

export function known<T>(value: T): Epistemic<T> {
  return { state: 'known', value }
}

export function notObserved<T = never>(): Epistemic<T> {
  return NOT_OBSERVED as Epistemic<T>
}

export function sensorError<T = never>(detail: string): Epistemic<T> {
  return { state: 'sensor_error', detail }
}

export function isKnown<T>(fact: Epistemic<T>): fact is { state: 'known'; value: T } {
  return fact.state === 'known'
}

/** The only sanctioned way to read an epistemic fact. Throws instead of defaulting. */
export function requireKnown<T>(fact: Epistemic<T>, context: string): T {
  if (fact.state !== 'known') throw new UnknownFactError(context, fact.state)
  return fact.value
}

/**
 * Serialize an epistemic fact without fabricating certainty. JSON keeps the
 * discriminator; a consumer that wants `false` must say so explicitly and is
 * then visibly wrong in review/diff.
 */
export function epistemicToJson(fact: Epistemic<unknown>): Record<string, unknown> {
  switch (fact.state) {
    case 'known':
      return { state: 'known', value: fact.value }
    case 'sensor_error':
      return { state: 'sensor_error', detail: fact.detail }
    case 'unknown':
      return { state: 'unknown' }
    case 'not_observed':
      return { state: 'not_observed' }
  }
}

/** Human-readable epistemic label for projections/logs. Never a boolean. */
export function describeEpistemic(fact: Epistemic<unknown>): string {
  switch (fact.state) {
    case 'known':
      return `known:${canonicalScalar(fact.value)}`
    case 'sensor_error':
      return `sensor_error:${fact.detail}`
    case 'unknown':
      return 'unknown'
    case 'not_observed':
      return 'not_observed'
  }
}

function canonicalScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? 'unserializable'
}
