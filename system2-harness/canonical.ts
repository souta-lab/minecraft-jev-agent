// system2-harness/canonical.ts - deterministic serialization + hashing primitives.
//
// SHARED SHAPE (#438/#439): this file mirrors `jev-harness/canonical.ts`
// symbol-for-symbol and rule-for-rule so that one reader can hash and compare
// artifacts from both harnesses, and so a later `harness-core/` extraction is a
// pure re-export move. Do not "improve" the rules here in isolation: a hash
// change in one harness and not the other silently breaks cross-harness replay.
//
// Everything the model sees must be reproducible byte-for-byte, so the harness
// owns ONE canonical JSON encoder and ONE hash function. Provider adapters may
// never re-serialize the projection themselves (#439 section 8/17/25).

import { createHash } from 'node:crypto'
import type { SemanticProjection } from './contract.ts'
import type { Epistemic } from './epistemic.ts'

export class NonCanonicalValueError extends Error {
  constructor(path: string, reason: string) {
    super(`value at ${path} cannot be canonicalized: ${reason}`)
    this.name = 'NonCanonicalValueError'
  }
}

/**
 * Deterministic JSON:
 *  - object keys sorted (insertion order must never change a hash);
 *  - `undefined` object members dropped (JSON semantics), `undefined` in an
 *    array is rejected because it silently becomes `null`;
 *  - `NaN` / `Infinity` rejected: a non-finite number in a projection is a
 *    sensor/code bug, and writing `null` there would fabricate certainty (#439
 *    section 18);
 *  - class instances, functions, symbols, Maps/Sets, Dates, live Mineflayer
 *    objects rejected (#439 section 8: projection is plain data).
 */
export function canonicalJson(value: unknown): string {
  return encode(value, '$')
}

function encode(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new NonCanonicalValueError(path, `non-finite number ${String(value)}`)
      if (Object.is(value, -0)) return '0'
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'bigint':
      throw new NonCanonicalValueError(path, 'bigint is not plain data')
    case 'function':
      throw new NonCanonicalValueError(path, 'function is not plain data')
    case 'symbol':
      throw new NonCanonicalValueError(path, 'symbol is not plain data')
    case 'undefined':
      throw new NonCanonicalValueError(path, 'undefined is not serializable (use null or an epistemic state)')
    default:
      break
  }
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index]
      if (entry === undefined) throw new NonCanonicalValueError(`${path}[${index}]`, 'undefined array entry')
      parts.push(encode(entry, `${path}[${index}]`))
    }
    return `[${parts.join(',')}]`
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
    throw new NonCanonicalValueError(path, `class instance / live object (${name}) is not plain data`)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    const entry = record[key]
    if (entry === undefined) continue
    parts.push(`${JSON.stringify(key)}:${encode(entry, `${path}.${key}`)}`)
  }
  return `{${parts.join(',')}}`
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Short, stable, collision-resistant id fragment used for artifact/decision ids. */
export function hashId(value: string, length = 16): string {
  return sha256Hex(value).slice(0, length)
}

/** Deterministic 32-bit hash of a string (FNV-1a, used for seeded permutation only). */
export function stableSeed(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Deep-freeze so an "immutable" artifact cannot be mutated through a held reference. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry)
    return value
  }
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
  return value
}

/**
 * Plain-data assertion used wherever a projection crosses the boundary. Returns
 * the same value so it can be used inline.
 */
export function assertPlainData<T>(value: T, what: string): T {
  try {
    canonicalJson(value)
  } catch (error) {
    if (error instanceof NonCanonicalValueError) {
      throw new NonCanonicalValueError(what, error.message)
    }
    throw error
  }
  return value
}

/** Hash of a semantic projection: `projectionId@version` + canonical payload. */
export function projectionHash(projection: SemanticProjection): string {
  return sha256Hex(
    canonicalJson({
      projectionId: projection.projectionId,
      version: projection.version,
      payload: projection.payload as unknown,
    }),
  )
}

/** `projectionId@version` recording string. */
export function projectionVersionKey(projection: SemanticProjection): string {
  return `${projection.projectionId}@${projection.version}`
}

/**
 * An unknown/not-observed/sensor-error fact must hash as itself, never as
 * `false`/`0`/`[]` (#439 section 18). This helper exists so projections can
 * embed epistemic facts explicitly and be tested for it.
 */
export function epistemicEntry<T>(fact: Epistemic<T>): Record<string, unknown> {
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

/**
 * Order-independent set hash. Used where a collection's *membership* is the
 * semantic fact and its order is incidental (#439 section 20: benchmark/
 * enumeration order must not change what the model sees or the cache identity).
 */
export function orderIndependentSetHash(values: readonly string[]): string {
  return sha256Hex(canonicalJson([...values].sort()))
}
