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
import { formatPillarFail, pillarStepUp, PILLAR_APEX_MIN_RISE, shouldRelocatePillarAfterFailure } from './src/pillarApex.ts'
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
  /**
   * Model the live server rule that produced `step=place reason=refused`: a
   * placement is rejected while the player's own AABB still intersects the
   * destination cell. `place()` throws the exact live message in that case.
   */
  placeRefusesWhenBodyInside?: boolean
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
  const listeners = new Map<string, Set<() => void>>()
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
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
    on(event: 'physicsTick' | 'forcedMove', listener: () => void): void {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event: 'physicsTick' | 'forcedMove', listener: () => void): void {
      listeners.get(event)?.delete(listener)
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
      emit('physicsTick')
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
      if (input.footingY !== null) {
        const destY = input.footingY + face.y
        const feetY = entity.position.y
        // Player AABB is [feetY, feetY + 1.8]; the destination cell is
        // [destY, destY + 1]. Any overlap is refused by the server.
        const inside = feetY < destY + 1 && feetY + 1.8 > destY
        if (input.placeRefusesWhenBodyInside === true && inside) {
          throw new Error(
            `Server refused to place cobblestone at (${FEET_X}, ${destY}, ${FEET_Z}): the block is still air`,
          )
        }
      }
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

addCase('the takeoff-observed apex seeds the window and places when the feet clear the cell', async () => {
  // Live run-mu84l153-qry3: prismarine-physics catches up to four ticks per
  // frame, so the entire ascending arc completed between two takeoff polls. The
  // takeoff trace recorded a real ceiling-limited apex (rise 0.464 at vy -0.08)
  // that must seed `apexRise` so a genuine apex is no longer reported as
  // `falling_before_place`. The PLACE still needs the CURRENT feet to clear the
  // place cell: the fourth burst tick here leaves rise 0.336 (feet 11.086) and
  // vy -0.05, so the cell top at 11 is cleared and the place is sent. The
  // server-refusal model proves the packet is only sent above the cell top.
  const world = createStepWorld({
    startY: 10.75,
    footingY: 9,
    placeRefusesWhenBodyInside: true,
    script: [0.42, 0.044, -0.078, -0.05, -0.304, -0.5],
  })
  let clock = 0
  let burstDone = false
  const deps = makeDeps(world, 10, {
    // One catch-up frame: four physics ticks land inside a single 15 ms poll.
    sleep: async (ms: number): Promise<void> => {
      const start = clock
      clock += ms
      if (!burstDone && start >= 105) {
        burstDone = true
        for (let index = 0; index < 4; index += 1) world.bot.tick()
      } else if (burstDone) {
        world.bot.tick()
      }
    },
    now: () => clock,
  })
  const outcome = await pillarStepUp(world.bot, deps, planFor(world, 9, 10))
  const pass =
    outcome.ok &&
    outcome.apexRise >= 0.25 &&
    world.stats.placeCalls === 1 &&
    world.blockPlacedAt(FEET_X, 10, FEET_Z)
  return {
    pass,
    detail: `ok=${outcome.ok} reason=${outcome.ok ? '-' : outcome.fail.reason} placeCalls=${world.stats.placeCalls} apexRise=${outcome.ok ? outcome.apexRise.toFixed(3) : '-'} landingY=${outcome.ok ? outcome.toY.toFixed(3) : '-'}`,
  }
})

addCase('a below-clearance apex is never placed (live run-mu85r15x-qvje refused)', async () => {
  // Exact live signature: launchY 58.7358, supportY 57, placeY 58, landingY 59.
  // The catch-up burst peaks at rise 0.464 but the sampled state is rise 0.231
  // (feet 58.966) at vy -0.231 - still inside cell 58 [58,59]. The old gate
  // latched the takeoff-observed peak into `sawRise` and placed there; the
  // server answered `step=place reason=refused ... the block is still air`.
  // The gate must require the CURRENT rise (0.231 < clearance 0.2641) and must
  // report the missed apex instead of sending a refused placement.
  const world = createStepWorld({
    startY: 58.73584062504456,
    footingY: 57,
    placeRefusesWhenBodyInside: true,
    script: [0.42, 0.044, -0.078, -0.155, -0.304, -0.5],
  })
  let clock = 0
  let burstDone = false
  const deps = makeDeps(world, 58, {
    sleep: async (ms: number): Promise<void> => {
      const start = clock
      clock += ms
      if (!burstDone && start >= 105) {
        burstDone = true
        for (let index = 0; index < 4; index += 1) world.bot.tick()
      } else if (burstDone) {
        world.bot.tick()
      }
    },
    now: () => clock,
  })
  const outcome = await pillarStepUp(world.bot, deps, planFor(world, 57, 58))
  const marker = outcome.ok ? '' : formatPillarFail(outcome.fail)
  const pass =
    !outcome.ok &&
    outcome.fail.step === 'apex' &&
    outcome.fail.reason === 'apex_missed' &&
    world.stats.placeCalls === 0 &&
    !world.blockPlacedAt(FEET_X, 58, FEET_Z)
  return { pass, detail: `${marker} placeCalls=${world.stats.placeCalls} block=${world.blockPlacedAt(FEET_X, 58, FEET_Z)}` }
})

addCase('a grounded launch still needs the full one-block clearance (cap removed)', async () => {
  // launchY 58 (feet on the support top) means the feet must reach 59 to clear
  // the place cell 58 - a demand of 1.0. Capping the demand at
  // PILLAR_APEX_MIN_RISE 0.5 would accept this burst sample at rise 0.82
  // (feet 58.82, inside cell 58) and the server would refuse it. The exact
  // geometric demand must be used.
  const world = createStepWorld({
    startY: 58,
    footingY: 57,
    placeRefusesWhenBodyInside: true,
    script: [0.42, 0.5, 0, -0.1, -0.304, -0.5],
  })
  let clock = 0
  let burstDone = false
  const deps = makeDeps(world, 58, {
    sleep: async (ms: number): Promise<void> => {
      const start = clock
      clock += ms
      if (!burstDone && start >= 105) {
        burstDone = true
        for (let index = 0; index < 4; index += 1) world.bot.tick()
      } else if (burstDone) {
        world.bot.tick()
      }
    },
    now: () => clock,
  })
  const outcome = await pillarStepUp(world.bot, deps, planFor(world, 57, 58))
  const marker = outcome.ok ? '' : formatPillarFail(outcome.fail)
  const pass = !outcome.ok && outcome.fail.step === 'apex' && world.stats.placeCalls === 0
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

addCase('only pre-placement takeoff failures are eligible for bounded pillar relocation', () => {
  const takeoff = ['no_physics_tick', 'no_support', 'no_rise'].map((reason) =>
    shouldRelocatePillarAfterFailure({ step: 'takeoff', reason }),
  )
  const terminal = [
    shouldRelocatePillarAfterFailure({ step: 'apex', reason: 'no_rise' }),
    shouldRelocatePillarAfterFailure({ step: 'place', reason: 'refused' }),
    shouldRelocatePillarAfterFailure({ step: 'landing', reason: 'not_on_block' }),
  ]
  const pass = takeoff.every(Boolean) && terminal.every((value) => !value)
  return { pass, detail: `takeoff=${takeoff.join(',')} terminal=${terminal.join(',')}` }
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
