// test-dimension-observer.mts - fixture for the emitter, not the gate.
//
// Proves the three properties the run-scoped Nether-arrival evidence depends on:
//   (a) generation start logs the current dimension exactly once;
//   (b) a dimension CHANGE logs exactly one transition line with from/to, and no
//       repeat while the dimension stays constant;
//   (c) a run whose dimension never changes logs nothing beyond (a).
// It also pins the one normalisation rule: mineflayer's bare `the_nether` and the
// namespaced `minecraft:the_nether` are the same dimension, logged canonically.
import { test, expect } from 'bun:test'
import {
  canonicalDimensionId,
  createDimensionObserver,
  normalizeDimensionId,
  type DimensionLog,
} from './dimension-observer.ts'

interface Emitted {
  readonly event: string
  readonly detail: Record<string, unknown>
}

function recorder(): { log: DimensionLog; lines: Emitted[] } {
  const lines: Emitted[] = []
  return {
    log: (event, detail) => {
      lines.push({ event, detail: detail ?? {} })
    },
    lines,
  }
}

test('(a) generation start logs the current dimension once, canonically, with the runId', () => {
  const { log, lines } = recorder()
  // Mineflayer reports the BARE id; the observation must still be canonical.
  createDimensionObserver(log, 'run-fixture-1', 'the_nether')
  expect(lines).toHaveLength(1)
  expect(lines[0]?.event).toBe('DIMENSION_OBSERVED')
  expect(lines[0]?.detail).toEqual({
    dimension: 'minecraft:the_nether',
    runId: 'run-fixture-1',
    reason: 'generation-start',
    source: 'live-world',
  })
})

test('(a) a generation that starts before the game packet is honest about unknown', () => {
  const { log, lines } = recorder()
  createDimensionObserver(log, 'run-fixture-1', undefined)
  expect(lines).toHaveLength(1)
  expect(lines[0]?.event).toBe('DIMENSION_OBSERVED')
  expect(lines[0]?.detail['dimension']).toBe('unknown')
})

test('(b) a change logs exactly one transition with from/to; repeats log nothing extra', () => {
  const { log, lines } = recorder()
  const observer = createDimensionObserver(log, 'run-fixture-2', 'overworld')
  expect(observer.current()).toBe('minecraft:overworld')
  // Overworld first (a duplicate observation must NOT re-log the transition).
  expect(observer.observe('minecraft:overworld', 'status')).toBe('minecraft:overworld')
  expect(observer.observe('overworld', 'status')).toBe('minecraft:overworld')
  expect(lines).toHaveLength(1)
  // The transfer.
  expect(observer.observe('the_nether', 'status')).toBe('minecraft:the_nether')
  // Still the Nether across many ticks: no repeats.
  for (let i = 0; i < 5; i += 1) observer.observe('the_nether', 'status')
  const transitions = lines.filter((line) => line.event === 'DIMENSION_TRANSITION')
  expect(transitions).toHaveLength(1)
  expect(transitions[0]?.detail).toEqual({
    from: 'minecraft:overworld',
    to: 'minecraft:the_nether',
    dimension: 'minecraft:the_nether',
    runId: 'run-fixture-2',
    reason: 'status',
    source: 'live-world',
  })
})

test('(b) every field the run-scoped gate reads is present on the transition line', () => {
  const { log, lines } = recorder()
  const observer = createDimensionObserver(log, 'run-fixture-3', 'overworld')
  observer.observe('the_nether', 'system2-grounding')
  const line = lines.find((entry) => entry.event === 'DIMENSION_TRANSITION')
  // `dimension=` is the exact field m3-gate's DIMENSION_RE scans for; both the
  // bare and namespaced forms are accepted there, and this is the namespaced one.
  expect(line?.detail['dimension']).toBe('minecraft:the_nether')
  expect(line?.detail['from']).toBe('minecraft:overworld')
  expect(line?.detail['to']).toBe('minecraft:the_nether')
  expect(line?.detail['reason']).toBe('system2-grounding')
})

test('(c) a constant dimension logs nothing beyond the opening observation', () => {
  const { log, lines } = recorder()
  const observer = createDimensionObserver(log, 'run-fixture-4', 'minecraft:overworld')
  for (let i = 0; i < 10; i += 1) observer.observe('overworld', 'status')
  expect(lines.map((line) => line.event)).toEqual(['DIMENSION_OBSERVED'])
})

test('normalisation: one rule for log form and equality form', () => {
  expect(canonicalDimensionId('the_nether')).toBe('minecraft:the_nether')
  expect(canonicalDimensionId('minecraft:the_nether')).toBe('minecraft:the_nether')
  expect(canonicalDimensionId('  Overworld ')).toBe('minecraft:overworld')
  expect(canonicalDimensionId(undefined)).toBe('')
  expect(normalizeDimensionId('the_nether')).toBe('the_nether')
  expect(normalizeDimensionId('minecraft:the_nether')).toBe('the_nether')
  expect(normalizeDimensionId('')).toBe('')
})
