// test-simdeath.mts - regression tests for #26 (rehearsal hazard isolation) and
// #34 (pre-loss telemetry timing). Pure: imports only simdeath helpers, no bot,
// no network, no file IO.
import {
  capturePreLossInventory,
  createPreLossInventoryTracker,
  parseRehearsalMode,
  partitionHazardsBySource,
  recordRehearsalHazard,
  rehearsalHazardsSnapshot,
  resetRehearsalHazards,
  shouldRegisterHazard,
  summarizeInventory,
} from './simdeath.ts'
import type { DeathHazard } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const production = (x: number, y: number, z: number, count = 1): DeathHazard => ({
  x,
  y,
  z,
  reason: 'fall',
  count,
  source: 'production',
  firstSeenAt: 1,
  lastSeenAt: 2,
})

addCase('#26: only production may register a durable hazard', () => {
  const productionAllowed = shouldRegisterHazard('production')
  const simulationAllowed = shouldRegisterHazard('simulation')
  return {
    pass: productionAllowed && !simulationAllowed,
    detail: `production=${productionAllowed} simulation=${simulationAllowed}`,
  }
})

addCase('#26: partition never lets a simulation hazard into the production half', () => {
  const simulated: DeathHazard = { ...production(1, 2, 3), source: 'simulation', reason: 'simulated' }
  const { production: prod, simulation } = partitionHazardsBySource([production(10, 64, 10), simulated])
  const prodIds = prod.map((h) => `${h.x},${h.y},${h.z}`)
  return {
    pass: prod.length === 1 && simulation.length === 1 && prod.every((h) => h.source !== 'simulation') && !prodIds.includes('1,2,3'),
    detail: `production=[${prodIds.join(' ')}] simulation=${simulation.length}`,
  }
})

addCase('#26: rehearsal namespace is separate and never merged into the durable set', () => {
  resetRehearsalHazards()
  const durable: DeathHazard[] = [production(0, 64, 0)]
  const before = durable.length
  recordRehearsalHazard({ x: 5.2, y: 63.9, z: 5.4 }, 'simulated')
  recordRehearsalHazard({ x: 5.1, y: 63.8, z: 5.1 }, 'simulated')
  const rehearsal = rehearsalHazardsSnapshot()
  const atCoord = rehearsal.find((h) => h.x === 5 && h.y === 64 && h.z === 5)
  const staysOut = durable.every((h) => h.source !== 'simulation') && durable.length === before
  resetRehearsalHazards()
  return {
    pass: rehearsal.length === 1 && atCoord?.count === 2 && atCoord.source === 'simulation' && staysOut,
    detail: `rehearsal=${rehearsal.length} count=${atCoord?.count} source=${atCoord?.source} durable=${durable.length}`,
  }
})

addCase('#26: two simulated deaths leave a production hazard count unchanged', () => {
  const durable: DeathHazard[] = [production(7, 64, 7, 2)]
  const countBefore = durable.length
  for (let i = 0; i < 2; i += 1) {
    const { production: prod } = partitionHazardsBySource([{ ...production(7, 64, 7), source: 'simulation' }])
    for (const hazard of prod) {
      const existing = durable.find((h) => h.x === hazard.x && h.y === hazard.y && h.z === hazard.z)
      if (existing === undefined) durable.push(hazard)
      else existing.count += hazard.count
    }
  }
  const permanent = durable.find((h) => h.x === 7 && h.y === 64 && h.z === 7)
  return {
    pass: durable.length === countBefore && permanent?.count === 2,
    detail: `before=${countBefore} after=${durable.length} count=${permanent?.count}`,
  }
})

addCase('#34: inventory is captured before the drop so itemsLost is meaningful', () => {
  let inventory: Record<string, number> = { stone_pickaxe: 1, raw_iron: 2, oak_log: 3 }
  const telemetry = capturePreLossInventory(() => inventory)
  inventory = {}
  const lostNames = Object.keys(telemetry.lostInventory).sort()
  return {
    pass:
      telemetry.capturedBeforeDrop &&
      telemetry.itemsLost === 6 &&
      lostNames.join(',') === 'oak_log,raw_iron,stone_pickaxe' &&
      telemetry.lostInventory['raw_iron'] === 2,
    detail: `capturedBeforeDrop=${telemetry.capturedBeforeDrop} itemsLost=${telemetry.itemsLost} lost=[${lostNames.join(',')}]`,
  }
})

addCase('#34: an empty pre-loss inventory is still flagged as captured-before-drop', () => {
  const telemetry = capturePreLossInventory(() => ({}))
  return {
    pass: telemetry.capturedBeforeDrop && telemetry.itemsLost === 0 && Object.keys(telemetry.lostInventory).length === 0,
    detail: `capturedBeforeDrop=${telemetry.capturedBeforeDrop} itemsLost=${telemetry.itemsLost}`,
  }
})

addCase('#34: post-toss snapshot would be wrong; capture-before proves non-empty', () => {
  const before = capturePreLossInventory(() => ({ raw_iron: 8 }))
  const afterToss = summarizeInventory({})
  return {
    pass: before.itemsLost === 8 && afterToss.itemsLost === 0 && before.lostInventory['raw_iron'] === 8,
    detail: `before=${before.itemsLost} afterToss=${afterToss.itemsLost}`,
  }
})

// #34 regression (live bug): the production `death` handler read the bot
// inventory after the server had dropped/cleared it, so the DEATH marker logged
// `lostInventory={} itemsLost=0 capturedBeforeDrop=true` while the bot was
// actually holding diamonds/armour. Reproduced offline: observe while alive,
// then read the cleared inventory at death.
addCase('#34: a cleared death-time read must not erase the last live inventory', () => {
  const tracker = createPreLossInventoryTracker()
  tracker.observe({ diamond: 3, diamond_sword: 1, diamond_pickaxe: 1, diamond_helmet: 1 })
  const telemetry = tracker.captureAtDeath(() => ({}))
  const lostNames = Object.keys(telemetry.lostInventory).sort()
  return {
    pass:
      telemetry.capturedBeforeDrop &&
      telemetry.itemsLost === 6 &&
      lostNames.join(',') === 'diamond,diamond_helmet,diamond_pickaxe,diamond_sword',
    detail: `capturedBeforeDrop=${telemetry.capturedBeforeDrop} itemsLost=${telemetry.itemsLost} lost=[${lostNames.join(',')}]`,
  }
})

addCase('#34: capturedBeforeDrop is false when only an empty post-loss read is available', () => {
  const tracker = createPreLossInventoryTracker()
  const telemetry = tracker.captureAtDeath(() => ({}))
  return {
    pass: !telemetry.capturedBeforeDrop && telemetry.itemsLost === 0 && Object.keys(telemetry.lostInventory).length === 0,
    detail: `capturedBeforeDrop=${telemetry.capturedBeforeDrop} itemsLost=${telemetry.itemsLost}`,
  }
})

addCase('#34: a non-empty death-time read proves the snapshot predates the drop', () => {
  const tracker = createPreLossInventoryTracker()
  const telemetry = tracker.captureAtDeath(() => ({ raw_iron: 8 }))
  return {
    pass: telemetry.capturedBeforeDrop && telemetry.itemsLost === 8 && telemetry.lostInventory['raw_iron'] === 8,
    detail: `capturedBeforeDrop=${telemetry.capturedBeforeDrop} itemsLost=${telemetry.itemsLost}`,
  }
})

addCase('#34: reset drops the previous life so its items are not re-attributed', () => {
  const tracker = createPreLossInventoryTracker()
  tracker.observe({ diamond: 3 })
  tracker.reset()
  const telemetry = tracker.captureAtDeath(() => ({}))
  return {
    pass: !telemetry.capturedBeforeDrop && telemetry.itemsLost === 0 && Object.keys(telemetry.lostInventory).length === 0,
    detail: `capturedBeforeDrop=${telemetry.capturedBeforeDrop} itemsLost=${telemetry.itemsLost}`,
  }
})

addCase('simdeath defaults to the non-destructive soft mode; hard is explicit', () => {
  const def = parseRehearsalMode(undefined)
  const empty = parseRehearsalMode({})
  const hard = parseRehearsalMode({ hard: true })
  const mode = parseRehearsalMode({ mode: 'hard' })
  const soft = parseRehearsalMode({ hard: false })
  return {
    pass: def === 'soft' && empty === 'soft' && hard === 'hard' && mode === 'hard' && soft === 'soft',
    detail: `default=${def} hard=${hard} mode=${mode} soft=${soft}`,
  }
})

addCase('#34: summarizeInventory ignores zero and negative counts', () => {
  const summary = summarizeInventory({ stone: 0, dirt: -3, cobblestone: 5 })
  return {
    pass: summary.itemsLost === 5 && Object.keys(summary.lostInventory).join(',') === 'cobblestone',
    detail: `itemsLost=${summary.itemsLost} lost=${JSON.stringify(summary.lostInventory)}`,
  }
})

let failures = 0
process.stdout.write('simdeath rehearsal isolation (#26) + telemetry timing (#34)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} simdeath cases passed\n`)
if (failures > 0) process.exit(1)
