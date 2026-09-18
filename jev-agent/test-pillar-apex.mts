// test-pillar-apex.mts - M2 PILLAR_UP apex placement regression.
//
// The live failure this locks (main d8a7a72, after the takeoff correction
// landed): PILLAR_UP executed ~900x, PILLAR_UP_STEP stayed 0, one place DID
// consume an item (cobblestone 63 -> 62), and every attempt ended in
// `PILLAR_UP made no progress`. The place was gated on `velocity.y <= 0.01` -
// true while standing, at the vertex and while falling - and the landing test
// was an unverified absolute window. `pillarStepUp` (pillarJump.ts) now
// verifies each sub-step and names the failed one.
//
// These cases drive the production timing with an injected fake bot: a body
// whose onGround flag is reset by a clientbound position packet on every tick
// and whose jump gate NEVER fires, so a takeoff can only come from the verified
// impulse (its own regression is in test-pillar-jump.mts). No live server.
//
//   npm run pillar-apex-test
import { formatPillarFail, pillarStepUp, PILLAR_APEX_MIN_RISE } from './src/pillarApex.ts'
import type { PillarStepUpDeps } from './src/pillarApex.ts'
import { formatPillarUpStep } from './src/pillarJump.ts'
import type { SolidAt, Vec3Like } from './src/pillarJump.ts'

interface CaseResult {
  pass: boolean
  detail: string
}

interface Case {
  name: string
  run: () => CaseResult | Promise<CaseResult>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const FEET_X = 40
const FEET_Z = 31

interface Cell {
  x: number
  y: number
  z: number
}

interface StepWorldInput {
  startY: number
  footingY: number | null
  /** velocities for the first N ticks; later ticks apply gravity */
  script?: readonly number[]
  gravity?: number
  /** false: place() resolves but no block appears in the cell */
  placeLands?: boolean
  /** true: place() rejects like a refused server placement */
  placeThrows?: boolean
}

function createStepWorld(input: StepWorldInput) {
  const solids: Cell[] = []
  if (input.footingY !== null) solids.push({ x: FEET_X, y: input.footingY, z: FEET_Z })
  const gravity = input.gravity ?? 0.08
  const entity = {
    position: { x: FEET_X + 0.5, y: input.startY, z: FEET_Z + 0.5 },
    velocity: { y: 0 },
    onGround: false,
  }
  const listeners = new Set<() => void>()
  const stats = { ticks: 0, placeCalls: 0, faces: [] as Vec3Like[] }
  const highestFloorTopBelow = (y: number): number => {
    let top = Number.NEGATIVE_INFINITY
    for (const cell of solids) {
      const cellTop = cell.y + 1
      if (cell.x === FEET_X && cell.z === FEET_Z && cellTop <= y + 1e-9 && cellTop > top) top = cellTop
    }
    return top
  }
  const bot = {
    entity,
    physicsEnabled: false,
    stats,
    setControlState(_control: 'jump', _state: boolean): void {},
    on(_event: 'physicsTick', listener: () => void): void {
      listeners.add(listener)
    },
    removeListener(_event: 'physicsTick', listener: () => void): void {
      listeners.delete(listener)
    },
    /** One physics tick: clientbound packet resets the flag, then the body moves. */
    tick(): void {
      stats.ticks += 1
      entity.onGround = false
      const scripted = input.script?.[stats.ticks - 1]
      entity.velocity.y = scripted ?? entity.velocity.y - gravity
      const prevY = entity.position.y
      entity.position.y += entity.velocity.y
      const floorTop = highestFloorTopBelow(prevY)
      if (entity.position.y < floorTop) {
        entity.position.y = floorTop
        entity.velocity.y = 0
      }
      for (const listener of listeners) listener()
    },
  }
  const isSolid: SolidAt = (x, y, z): boolean =>
    solids.some((cell) => cell.x === x && cell.y === y && cell.z === z)
  return {
    bot,
    stats,
    isSolid,
    cells: solids,
    blockPlacedAt(x: number, y: number, z: number): boolean {
      return isSolid(x, y, z)
    },
    place: async (face: Vec3Like): Promise<void> => {
      stats.placeCalls += 1
      stats.faces.push(face)
      if (input.placeThrows === true) throw new Error('server refused the placement')
      if (input.placeLands === false || input.footingY === null) return
      solids.push({ x: FEET_X + face.x, y: input.footingY + face.y, z: FEET_Z + face.z })
    },
  }
}

/**
 * Injected clock: polls every `pollMs`, physics ticks on 50 ms boundaries, so
 * the 100 ms impulse delay spans two real ticks like mineflayer's loop.
 */
function makeDeps(
  world: ReturnType<typeof createStepWorld>,
  placeY: number,
  overrides: Partial<PillarStepUpDeps> = {},
): PillarStepUpDeps {
  let clock = 0
  let lastTickAt = 0
  return {
    isSolid: world.isSolid,
    budgetMs: 600,
    pollMs: 15,
    apexBudgetMs: 700,
    placeSettleMs: 80,
    landingBudgetMs: 2000,
    sleep: async (ms: number): Promise<void> => {
      clock += ms
      while (clock - lastTickAt >= 50) {
        lastTickAt += 50
        world.bot.tick()
      }
    },
    now: () => clock,
    place: (face) => world.place(face),
    blockPlaced: () => world.blockPlacedAt(FEET_X, placeY, FEET_Z),
    ...overrides,
  }
}

function planFor(world: ReturnType<typeof createStepWorld>, footingY: number, placeY: number) {
  return {
    feetCell: { x: FEET_X, y: Math.floor(world.bot.entity.position.y), z: FEET_Z },
    placeCell: { x: FEET_X, y: placeY, z: FEET_Z },
    support: { x: FEET_X, y: footingY, z: FEET_Z },
  }
}

function runCase(testCase: Case): Promise<CaseResult> {
  return Promise.resolve(testCase.run())
}

addCase('a verified apex places the block and lands the body one level up', async () => {
  const world = createStepWorld({ startY: 10.75, footingY: 9 })
  const deps = makeDeps(world, 10)
  const plan = planFor(world, 9, 10)
  const outcome = await pillarStepUp(world.bot, deps, plan)
  const placedCell = world.blockPlacedAt(FEET_X, 10, FEET_Z)
  const face = world.stats.faces[0]
  const pass =
    outcome.ok &&
    placedCell &&
    world.stats.placeCalls === 1 &&
    face?.x === 0 &&
    face?.y === 1 &&
    face?.z === 0 &&
    outcome.apexRise >= PILLAR_APEX_MIN_RISE &&
    outcome.toY === 11
  return {
    pass,
    detail: `ok=${outcome.ok} place=${world.stats.placeCalls} face=(${face?.x},${face?.y},${face?.z}) block=${placedCell} apexRise=${outcome.ok ? outcome.apexRise.toFixed(2) : '-'} landingY=${outcome.ok ? outcome.toY : '-'} ${outcome.ok ? formatPillarUpStep(1, 10, 11, 'cobblestone') : ''}`,
  }
})

addCase('a place that does not land a block is reported as step=place', async () => {
  const world = createStepWorld({ startY: 10.75, footingY: 9, placeLands: false })
  const deps = makeDeps(world, 10)
  const outcome = await pillarStepUp(world.bot, deps, planFor(world, 9, 10))
  const marker = outcome.ok ? '' : formatPillarFail(outcome.fail)
  const pass =
    !outcome.ok &&
    outcome.fail.step === 'place' &&
    outcome.fail.reason === 'not_landed' &&
    world.stats.placeCalls === 1 &&
    marker.startsWith('PILLAR_FAIL step=place reason=not_landed ')
  return { pass, detail: `${marker} placeCalls=${world.stats.placeCalls} block=${world.blockPlacedAt(FEET_X, 10, FEET_Z)}` }
})

addCase('a body that falls before the apex is reported as step=apex', async () => {
  // Tick 1 rises just past TAKEOFF_RISE; the next ticks are a hard fall, so the
  // vertex (rise >= 0.5) is never reached.
  const world = createStepWorld({ startY: 10.75, footingY: 9, script: [0.03, -0.5, -0.9] })
  const deps = makeDeps(world, 10)
  const outcome = await pillarStepUp(world.bot, deps, planFor(world, 9, 10))
  const marker = outcome.ok ? '' : formatPillarFail(outcome.fail)
  const pass =
    !outcome.ok &&
    outcome.fail.step === 'apex' &&
    outcome.fail.reason === 'falling_before_place' &&
    outcome.fail.rise < 0 &&
    marker.startsWith('PILLAR_FAIL step=apex reason=falling_before_place ') &&
    world.stats.placeCalls === 0
  return { pass, detail: `${marker} placeCalls=${world.stats.placeCalls}` }
})

addCase('a body with no solid footing is reported as step=takeoff', async () => {
  const world = createStepWorld({ startY: 10.75, footingY: null })
  const deps = makeDeps(world, 10)
  const outcome = await pillarStepUp(world.bot, deps, planFor(world, 9, 10))
  const marker = outcome.ok ? '' : formatPillarFail(outcome.fail)
  const pass =
    !outcome.ok &&
    outcome.fail.step === 'takeoff' &&
    outcome.fail.reason === 'no_support' &&
    marker.startsWith('PILLAR_FAIL step=takeoff reason=no_support ') &&
    outcome.fail.samples >= 1
  return { pass, detail: `${marker} ticks=${world.stats.ticks}` }
})

addCase('a refused placement is reported as step=place with the server message', async () => {
  const world = createStepWorld({ startY: 10.75, footingY: 9, placeThrows: true })
  const deps = makeDeps(world, 10)
  const outcome = await pillarStepUp(world.bot, deps, planFor(world, 9, 10))
  const marker = outcome.ok ? '' : formatPillarFail(outcome.fail)
  const pass =
    !outcome.ok &&
    outcome.fail.step === 'place' &&
    outcome.fail.reason === 'refused' &&
    outcome.fail.detail === 'server refused the placement' &&
    marker.startsWith('PILLAR_FAIL step=place reason=refused ')
  return { pass, detail: `${marker} detail=${outcome.ok ? '-' : outcome.fail.detail}` }
})

addCase('a plan that does not place above the support is refused before any call', async () => {
  const world = createStepWorld({ startY: 10.75, footingY: 9 })
  const deps = makeDeps(world, 10)
  const outcome = await pillarStepUp(world.bot, deps, {
    feetCell: { x: FEET_X, y: 10, z: FEET_Z },
    placeCell: { x: FEET_X, y: 10, z: FEET_Z },
    support: { x: FEET_X + 1, y: 9, z: FEET_Z },
  })
  const pass =
    !outcome.ok &&
    outcome.fail.step === 'place' &&
    outcome.fail.reason === 'wrong_cell' &&
    world.stats.placeCalls === 0 &&
    world.stats.ticks === 0
  return { pass, detail: `${outcome.ok ? '' : formatPillarFail(outcome.fail)} placeCalls=${world.stats.placeCalls}` }
})

addCase('the PILLAR_FAIL marker carries all four sub-steps in the pinned format', () => {
  const markers = [
    formatPillarFail({ step: 'takeoff', reason: 'no_physics_tick', y: 10.75, rise: 0, samples: 40 }),
    formatPillarFail({ step: 'apex', reason: 'falling_before_place', y: 10.28, rise: -0.47, samples: 4 }),
    formatPillarFail({ step: 'place', reason: 'not_landed', y: 11.35, rise: 0.6, samples: 6 }),
    formatPillarFail({ step: 'landing', reason: 'not_on_block', y: 10.5, rise: -0.25, samples: 12 }),
  ]
  const expected = [
    'PILLAR_FAIL step=takeoff reason=no_physics_tick y=10.75 rise=0 samples=40',
    'PILLAR_FAIL step=apex reason=falling_before_place y=10.28 rise=-0.47 samples=4',
    'PILLAR_FAIL step=place reason=not_landed y=11.35 rise=0.6 samples=6',
    'PILLAR_FAIL step=landing reason=not_on_block y=10.5 rise=-0.25 samples=12',
  ]
  const pass = markers.every((marker, index) => marker === expected[index])
  return { pass, detail: markers.join(' | ') }
})

let failures = 0
process.stdout.write('M2 pillar apex - verified apex window, place and landing\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await runCase(testCase)
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} pillar-apex cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
