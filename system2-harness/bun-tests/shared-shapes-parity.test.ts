// system2-harness/bun-tests/shared-shapes-parity.test.ts - #438/#439 shared-shape
// parity, pinned to GOLDEN VECTORS computed from the #438 implementation
// (`jev-harness/canonical.ts` as it stands in lane task/jev-harness).
//
// Why golden vectors rather than importing the other package: `jev-harness` has
// not landed on main, so a cross-worktree import would be an untracked dependency
// on someone else's working directory. Freezing the values here makes the
// agreement checkable forever: if either harness changes a hash rule, the other
// harness's corpus stops being readable, and this test says so by name.
//
// The vectors were produced by running the #438 module directly:
//   canonicalJson({b:1,a:[2,3],c:{d:null,e:'x'}}) -> {"a":[2,3],"b":1,"c":{"d":null,"e":"x"}}
//   sha256Hex('system2-harness')                  -> 78a68b72c23ff6db5fa93904c797fc7840af49fccef0618c5c3452cbb5700d53
//   projectionHash(system2.state@1, {b:2,a:1})    -> 77449b0256950356d93536c856278efd1e8de622d065cf20a739708d5fea0380
// ...and every rejection case below was observed to throw NonCanonicalValueError.

import { describe, expect, test } from 'bun:test'
import {
  NonCanonicalValueError,
  assertPlainData,
  canonicalJson,
  deepFreeze,
  epistemicEntry,
  hashId,
  projectionHash,
  projectionVersionKey,
  sha256Hex,
  stableSeed,
} from '../canonical.ts'
import { NOT_OBSERVED, UNKNOWN, UnknownFactError, epistemicToJson, isKnown, known, notObserved, requireKnown, sensorError } from '../epistemic.ts'

const HASH_438 = '78a68b72c23ff6db5fa93904c797fc7840af49fccef0618c5c3452cbb5700d53'
const PROJECTION_HASH_438 = '77449b0256950356d93536c856278efd1e8de622d065cf20a739708d5fea0380'

describe('canonicalJson parity with #438', () => {
  test('sorted keys, undefined members dropped, UTF-8 JSON', () => {
    expect(canonicalJson({ b: 1, a: [2, 3], c: { d: null, e: 'x' } })).toBe('{"a":[2,3],"b":1,"c":{"d":null,"e":"x"}}')
    expect(canonicalJson({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}')
    // Insertion order can never change a hash.
    expect(canonicalJson({ z: 1, a: 2 })).toBe(canonicalJson({ a: 2, z: 1 }))
    expect(canonicalJson({ negativeZero: -0 })).toBe('{"negativeZero":0}')
  })

  test('non-canonical values throw NonCanonicalValueError, exactly as #438 does', () => {
    const cases: readonly unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      [1, undefined],
      () => 1,
      Symbol('s'),
      new Date(0),
      new Map(),
      new Set(),
    ]
    for (const value of cases) {
      expect(() => canonicalJson(value)).toThrow(NonCanonicalValueError)
    }
    class Probe {
      readonly x = 1
    }
    expect(() => canonicalJson(new Probe())).toThrow(NonCanonicalValueError)
    // `undefined` at the top level is rejected too (use null or an epistemic state).
    expect(() => canonicalJson(undefined)).toThrow(NonCanonicalValueError)
  })

  test('hashing primitives match the #438 corpus byte-for-byte', () => {
    expect(sha256Hex('system2-harness')).toBe(HASH_438)
    expect(hashId('abc')).toBe('ba7816bf8f01cfea')
    expect(hashId('abc')).toHaveLength(16)
    expect(hashId('abc', 8)).toBe('ba7816bf')
    expect(stableSeed('portal:P17')).toBe(1960393293)
    // Full sha256, no truncation: a projection hash is a real digest.
    expect(projectionHash({ projectionId: 'system2.state', version: 1, payload: { b: 2, a: 1 } })).toBe(PROJECTION_HASH_438)
    expect(projectionHash({ projectionId: 'system2.state', version: 1, payload: { b: 2, a: 1 } })).toHaveLength(64)
    expect(projectionVersionKey({ projectionId: 'system2.state', version: 1, payload: {} })).toBe('system2.state@1')
  })

  test('deepFreeze freezes the whole tree; assertPlainData returns the value', () => {
    const frozen = deepFreeze({ a: { b: [1, 2] } })
    expect(Object.isFrozen(frozen) && Object.isFrozen(frozen.a) && Object.isFrozen(frozen.a.b)).toBe(true)
    const value = { ok: true }
    expect(assertPlainData(value, 'probe')).toBe(value)
    expect(() => assertPlainData({ bad: new Date(0) }, 'probe')).toThrow(NonCanonicalValueError)
  })
})

describe('Epistemic parity with #438', () => {
  test('the four discriminators serialize exactly as the shared shape says', () => {
    expect(epistemicEntry(known(3))).toEqual({ state: 'known', value: 3 })
    expect(epistemicEntry(UNKNOWN)).toEqual({ state: 'unknown' })
    expect(epistemicEntry(NOT_OBSERVED)).toEqual({ state: 'not_observed' })
    expect(epistemicEntry(sensorError('lidar blind'))).toEqual({ state: 'sensor_error', detail: 'lidar blind' })
    // epistemicToJson (the #439 accessor) is the same shape.
    expect(epistemicToJson(known('verified'))).toEqual({ state: 'known', value: 'verified' })
    expect(epistemicToJson(notObserved())).toEqual({ state: 'not_observed' })
  })

  test('no defaulting API exists: unknown cannot silently become a value', async () => {
    expect(isKnown(known(1))).toBe(true)
    expect(isKnown(UNKNOWN)).toBe(false)
    expect(requireKnown(known(1), 'probe')).toBe(1)
    expect(() => requireKnown(UNKNOWN, 'probe')).toThrow(UnknownFactError)
    expect(() => requireKnown(notObserved(), 'probe')).toThrow(UnknownFactError)
    expect(() => requireKnown(sensorError('blind'), 'probe')).toThrow(UnknownFactError)
    // The runtime export surface is pinned EXACTLY: a helper that returned a
    // default (`unwrapOr`, `getOrElse`, `valueOf`, …) would make fabricated
    // certainty expressible, so it cannot appear without failing this list.
    const epistemicModule: Record<string, unknown> = await import('../epistemic.ts')
    expect(Object.keys(epistemicModule).sort()).toEqual(
      ['NOT_OBSERVED', 'UNKNOWN', 'UnknownFactError', 'describeEpistemic', 'epistemicToJson', 'isKnown', 'known', 'notObserved', 'requireKnown', 'sensorError'].sort(),
    )
  })
})
