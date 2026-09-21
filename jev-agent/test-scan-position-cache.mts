// test-scan-position-cache.mts - the cross-build `findBlocks` cache contract.
//
// `buildWorldState` may reuse a `findBlocks` POSITION list across builds only
// when the caller supplies an exact world-mutation revision (`SensorOptions.
// worldRevision`, produced by `DecisionScheduler.worldRevision`). This suite
// locks the contract that makes that safe:
//
//   1. no revision            -> the cache is off; every build scans;
//   2. same revision + cell   -> reuse, and the perceived state is unchanged;
//   3. same revision + cell,
//      moved body             -> position-dependent facts (distance, inReach)
//                                are STILL re-derived from the live body, so a
//                                cache hit can never serve a stale distance;
//   4. changed revision       -> a world change is always seen (no stale hit);
//   5. changed floored cell   -> the search centre moved, so it rescans.
//
// Run: bun test-scan-position-cache.mts
import { createRequire } from 'node:module'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { SensorInput, Vec3Json, WorldState } from './src/state.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const GROUND_Y = 46

type Bot = Parameters<typeof buildWorldState>[0]

/** Minimal world double: one mutable set of log cells over a stone floor. */
function fakeWorldBot(): { bot: Bot; logCells: Set<string>; calls: () => number; moveTo: (x: number, y: number, z: number) => void } {
  const position = new Vec3(29.12, 47.75, 34.19)
  const logCells = new Set<string>(['30,47,34', '31,47,35'])
  let findBlocksCalls = 0
  const cell = (p: { x: number; y: number; z: number }): string =>
    `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const blockAt = (p: { x: number; y: number; z: number }) => {
    const here = cell(p)
    if (logCells.has(here)) {
      return { name: 'oak_log', boundingBox: 'block', diggable: true, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    }
    if (Math.floor(p.y) === GROUND_Y) {
      return { name: 'stone', boundingBox: 'block', diggable: true, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
    }
    return { name: 'air', boundingBox: 'empty', diggable: false, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }
  }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance: number
    count: number
  }): unknown[] => {
    findBlocksCalls += 1
    const origin = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    const out: unknown[] = []
    for (const entry of logCells) {
      const [x, y, z] = entry.split(',').map(Number)
      if (!options.matching({ name: 'oak_log' })) continue
      const block = new Vec3(x, y, z)
      if (block.distanceTo(origin) <= options.maxDistance) out.push(block)
    }
    return out.slice(0, options.count)
  }
  const bot = {
    username: 'AI_CACHE',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
    time: { isDay: true },
    // cobblestone makes `selectPlaceableBlock` non-null, so the (uncached)
    // prerequisite stone scans stay out of the measurement.
    inventory: { items: () => [{ name: 'cobblestone', count: 1, slot: 36 }], slots: [] },
    entities: {},
    blockAt,
    findBlocks,
  } as never
  return {
    bot,
    logCells,
    calls: () => findBlocksCalls,
    moveTo: (x, y, z) => {
      position.set(x, y, z)
    },
  }
}

function input(tick: number): SensorInput {
  return {
    tick,
    goal: makeGoal('log', 1),
    goalQueue: emptyGoalQueueState(),
    focusItem: 'log',
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 1,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: [],
    },
  }
}

const logDistances = (state: WorldState): number[] =>
  state.blocks.filter((block) => block.kind === 'log').map((block) => block.distance)

addCase('(1) with no worldRevision the cache is off and every build scans', () => {
  const { bot, calls } = fakeWorldBot()
  buildWorldState(bot, input(1), { ...defaultSensorOptions })
  const afterFirst = calls()
  buildWorldState(bot, input(2), { ...defaultSensorOptions })
  const afterSecond = calls()
  return {
    pass: afterFirst > 0 && afterSecond > afterFirst,
    detail: `findBlocks calls: build1=${afterFirst} build2=${afterSecond} (must increase)`,
  }
})

addCase('(2) same revision + same floored cell reuses the position list', () => {
  const { bot, calls } = fakeWorldBot()
  const options = { ...defaultSensorOptions, worldRevision: 7 }
  const first = buildWorldState(bot, input(1), options)
  const afterFirst = calls()
  const second = buildWorldState(bot, input(2), options)
  const afterSecond = calls()
  const same = JSON.stringify(first.blocks) === JSON.stringify(second.blocks)
  return {
    pass: afterSecond === afterFirst && same && afterFirst > 0,
    detail: `calls build1=${afterFirst} build2=${afterSecond}; identical blocks=${same}`,
  }
})

addCase('(3) a cache hit still re-derives distance/inReach from the live body', () => {
  const { bot, calls, moveTo } = fakeWorldBot()
  const options = { ...defaultSensorOptions, worldRevision: 11 }
  const first = buildWorldState(bot, input(1), options)
  const afterFirst = calls()
  // Move inside the SAME block cell: the findBlocks search centre is unchanged,
  // but the body is closer to the logs.
  moveTo(29.6, 47.75, 34.19)
  const second = buildWorldState(bot, input(2), options)
  const afterSecond = calls()
  const firstDistances = logDistances(first)
  const secondDistances = logDistances(second)
  const moved = JSON.stringify(firstDistances) !== JSON.stringify(secondDistances)
  const closer = secondDistances.every((d, i) => d < (firstDistances[i] ?? Number.POSITIVE_INFINITY))
  return {
    pass: afterSecond === afterFirst && moved && closer,
    detail: `calls build1=${afterFirst} build2=${afterSecond}; distances ${JSON.stringify(firstDistances)} -> ${JSON.stringify(secondDistances)}`,
  }
})

addCase('(4) a changed worldRevision is always re-scanned (no stale hit)', () => {
  const { bot, logCells, calls } = fakeWorldBot()
  const base = { ...defaultSensorOptions }
  buildWorldState(bot, input(1), { ...base, worldRevision: 21 })
  const afterFirst = calls()
  // A new log appears in the world; only the revision can witness that.
  logCells.add('32,47,34')
  const second = buildWorldState(bot, input(2), { ...base, worldRevision: 22 })
  const afterSecond = calls()
  const seen = second.blocks.some(
    (block) => block.kind === 'log' && block.position.x === 32 && block.position.y === 47 && block.position.z === 34,
  )
  return {
    pass: afterSecond > afterFirst && seen,
    detail: `calls build1=${afterFirst} build2=${afterSecond}; new log sensed=${seen}`,
  }
})

addCase('(5) a changed floored cell rescans the new search centre', () => {
  const { bot, calls, moveTo } = fakeWorldBot()
  const options = { ...defaultSensorOptions, worldRevision: 31 }
  buildWorldState(bot, input(1), options)
  const afterFirst = calls()
  moveTo(29.6, 47.75, 35.4) // floor z 34 -> 35
  buildWorldState(bot, input(2), options)
  const afterSecond = calls()
  return {
    pass: afterSecond > afterFirst,
    detail: `calls build1=${afterFirst} build2=${afterSecond} (must increase)`,
  }
})

let failures = 0
process.stdout.write('cross-build findBlocks position cache contract\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} scan-cache cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
