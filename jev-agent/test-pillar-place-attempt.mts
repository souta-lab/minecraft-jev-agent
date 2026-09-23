// test-pillar-place-attempt.mts - WHEN the PILLAR_UP placement is attempted.
//
// Measured live defect (the 791-record live window,
// /home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/buddy.log:
// `place/refused` 410, `apex/apex_missed` 277, everything else 104):
//
//   place/refused 410:  placeY == floor(launchY) for 405 - the step fills the
//                       cell the body's feet occupy; fail-time `rise` 0 (the body
//                       had fallen back to its launch height) for 222/399 and
//                       `endVelocityY` -0.0784 (the first post-landing gravity
//                       tick) for 54.
//   apex/apex_missed 277: `traceMaxRise >= the exact clearance` for 258 - the arc
//                       PROVED it cleared the cell and no attempt was ever made;
//                       fail-time `peakRise` 0.736 and `endVelocityY` -0.304.
//   nether_portal 29/410: at exactly two cells, body column inside the portal,
//                       and >= 12 were refused with the body still 1.2 above its
//                       launch - i.e. ABOVE the cell top. Those cannot be an
//                       occupancy race at all: the DESTINATION was not fillable.
//
// One mechanism explains the first two: the gate's clearance predicate was
// evaluated on ONE sampled position, the demand was EXACTLY `placeCell.y + 1`
// (zero margin), and the packet reached the server several position updates
// later, because
//
//   mineflayer `placeBlock` -> `_genericPlace` awaits `bot.lookAt`
//   (node_modules/mineflayer/lib/plugins/generic_place.js:37) -> `bot.look`
//   awaits `lookingTask.promise` (lib/plugins/physics.js:386), resolved by the
//   `move` event emitted inside `tickPhysics` -> `updatePosition`
//   (physics.js:91-93,116). A promise continuation cannot run inside that
//   synchronous catch-up loop (physics.js:74-79, PHYSICS_CATCHUP_TICKS = 4), and
//   every tick of the frame sent the position packet the server validates the
//   placement against.
//
// The third shape is not timing at all and is refused before any attempt.
//
// This file models the gap with no free parameter of its own: a placement issued
// through the look handshake advances exactly one physics frame, and the arc model
// is pinned against the live jumpTrace values.
//
//   bun run pillar-place-attempt-test
import {
  formatPillarFail,
  pillarPlaceCellCleared,
  pillarPlaceHandshakeBudget,
  pillarTrajectoryDelta,
  pillarWorstPlaceDelta,
  pillarStepUp,
  PILLAR_GRAVITY_PER_TICK,
  PILLAR_DRAG_PER_TICK,
  PILLAR_PLACE_LOOK_HANDSHAKE_TICKS,
  requiredApexRise,
} from './src/pillarApex.ts'
import type { PillarFail, PillarStepUpDeps } from './src/pillarApex.ts'
import { evaluatePillarStep, pillarPlaceCellFillable, resolvePillarStep } from './src/verticalPlan.ts'
import type { PillarPlaceCellProbe } from './src/verticalPlan.ts'
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

const X = 6
const Z = -1
/** The live frame cadence: mineflayer's physics loop runs every 50 ms. */
const FRAME_MS = 50
const POLL_MS = 15

interface Cell {
  x: number
  y: number
  z: number
}

interface ArcWorldInput {
  /** live feet Y at the launch (fractional when the body was already mid-arc) */
  startY: number
  /** live footing cell the block is placed on; null means there is no footing */
  supportY: number | null
  /**
   * Physics ticks one server frame runs synchronously. mineflayer's catch-up
   * loop allows up to PHYSICS_CATCHUP_TICKS = 4 (physics.js:18,74-79); the live
   * traces recorded 4-tick frames (`...t1 ...t2 ...t3 ...t4` at one `atMs`).
   */
  frameTicks: number
  /**
   * How the placement packet is issued:
   *   'look'      - `bot.placeBlock`: mineflayer awaits the look handshake, so
   *                 the packet is written only after the next WHOLE frame;
   *   'same-tick' - the placement is written inside the gate's own tick.
   */
  placePath: 'look' | 'same-tick'
  /** bottom face of a solid block above the body: clamps the arc like a ceiling */
  ceilingBottomY?: number
}

/**
 * The live jump arc, exactly as prismarine-physics integrates it and exactly as
 * the live `jumpTrace` recorded it: each tick advances the position by the
 * current velocity, then applies gravity and drag.
 */
function createArcWorld(input: ArcWorldInput) {
  const solids: Cell[] = input.supportY === null ? [] : [{ x: X, y: input.supportY, z: Z }]
  const entity = {
    position: { x: X + 0.5, y: input.startY, z: Z + 0.5 },
    velocity: { y: 0 },
    onGround: input.supportY !== null,
  }
  const listeners = new Map<string, Set<() => void>>()
  const stats = {
    ticks: 0,
    frames: 0,
    placeCalls: 0,
    /** the body's own feet Y at the moment the placement was written */
    attemptFeetY: [] as number[],
    faces: [] as Vec3Like[],
  }
  const solidAt = (x: number, y: number, z: number): boolean =>
    solids.some((cell) => cell.x === x && cell.y === y && cell.z === z)
  const highestFloorTopBelow = (y: number): number => {
    let top = Number.NEGATIVE_INFINITY
    for (const cell of solids) {
      if (cell.x !== X || cell.z !== Z) continue
      const cellTop = cell.y + 1
      if (cellTop <= y + 1e-9 && cellTop > top) top = cellTop
    }
    return top
  }
  const tick = (): void => {
    stats.ticks += 1
    entity.onGround = false
    const prevY = entity.position.y
    entity.position.y += entity.velocity.y
    if (input.ceilingBottomY !== undefined && entity.position.y + 1.8 > input.ceilingBottomY) {
      entity.position.y = input.ceilingBottomY - 1.8
      entity.velocity.y = 0
    }
    const floorTop = highestFloorTopBelow(prevY)
    if (entity.position.y < floorTop) {
      entity.position.y = floorTop
      entity.velocity.y = 0
      entity.onGround = true
    }
    entity.velocity.y = (entity.velocity.y - PILLAR_GRAVITY_PER_TICK) * PILLAR_DRAG_PER_TICK
    for (const listener of listeners.get('physicsTick') ?? []) listener()
  }
  return {
    entity,
    stats,
    /** the shared registry `tick()` emits into and the bot slice listens on */
    listeners,
    isSolid: solidAt as SolidAt,
    blockPlacedAt: (x: number, y: number, z: number): boolean => solidAt(x, y, z),
    /** one server frame: `frameTicks` physics ticks back to back */
    frame(): void {
      stats.frames += 1
      for (let index = 0; index < input.frameTicks; index += 1) tick()
    },
    /** the frame that applies the vanilla jump impulse (`vy = 0.42`) */
    launch(): void {
      entity.onGround = true
      entity.velocity.y = Math.fround(0.42)
      this.frame()
    },
    /**
     * mineflayer's placement, with its own await modelled:
     *   'look'      -> the look handshake resolves only after the next whole
     *                  frame, so the server validates the position of that
     *                  frame's LAST tick;
     *   'same-tick' -> the packet is written inside the gate's tick.
     * The server refuses a placement whose destination cell the player's own
     * AABB ([feet, feet + 1.8]) still intersects.
     */
    place(face: Vec3Like): boolean {
      stats.placeCalls += 1
      stats.faces.push(face)
      if (input.placePath === 'look') this.frame()
      const attemptFeetY = entity.position.y
      stats.attemptFeetY.push(attemptFeetY)
      const destY = (input.supportY ?? 0) + face.y
      const inside = attemptFeetY < destY + 1 && attemptFeetY + 1.8 > destY
      if (inside) return false
      solids.push({ x: X + face.x, y: destY, z: Z + face.z })
      return true
    },
  }
}

type ArcWorld = ReturnType<typeof createArcWorld>

interface StepResult {
  ok: boolean
  fail: PillarFail | null
  attemptFeetY: number | null
  blockPlaced: boolean
  placeCalls: number
}

/**
 * Drive one PILLAR_UP step against the arc world with production timing: the
 * gate polls every `pollMs`, physics frames run every `FRAME_MS` and only a frame
 * moves the body - so the gate can only ever observe a completed frame, which is
 * what the live event loop guarantees.
 */
async function runStep(
  world: ArcWorld,
  placeY: number,
  frameTicks: number,
  placeHandshakeTicks: number,
): Promise<StepResult> {
  let clock = 0
  let nextFrameAt = FRAME_MS
  let launchPending = true
  const advance = (ms: number): void => {
    clock += ms
    while (clock >= nextFrameAt) {
      nextFrameAt += FRAME_MS
      if (launchPending && world.entity.onGround) {
        launchPending = false
        world.launch()
      } else {
        world.frame()
      }
    }
  }
  const deps: PillarStepUpDeps = {
    isSolid: world.isSolid,
    budgetMs: 600,
    pollMs: POLL_MS,
    apexBudgetMs: 700,
    placeSettleMs: 200,
    landingBudgetMs: 2000,
    placeHandshakeTicks,
    now: () => clock,
    sleep: async (ms: number): Promise<void> => advance(ms),
    place: async (face: Vec3Like): Promise<void> => {
      if (!world.place(face)) {
        throw new Error(`Server refused to place cobblestone at (${X}, ${placeY}, ${Z}): the block is still air`)
      }
    },
    blockPlaced: () => world.blockPlacedAt(X, placeY, Z),
  }
  const bot = {
    entity: world.entity,
    physicsEnabled: false,
    setControlState: (_control: 'jump', state: boolean): void => {
      if (state) launchPending = true
    },
    on: (event: 'physicsTick' | 'forcedMove', listener: () => void): void => {
      const set = world.listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      world.listeners.set(event, set)
    },
    removeListener: (event: 'physicsTick' | 'forcedMove', listener: () => void): void => {
      world.listeners.get(event)?.delete(listener)
    },
  }
  const outcome = await pillarStepUp(bot, deps, {
    feetCell: { x: X, y: Math.floor(world.entity.position.y), z: Z },
    placeCell: { x: X, y: placeY, z: Z },
    support: { x: X, y: placeY - 1, z: Z },
  })
  const attempts = world.stats.attemptFeetY
  return {
    ok: outcome.ok,
    fail: outcome.ok ? null : outcome.fail,
    attemptFeetY: attempts.at(-1) ?? null,
    blockPlaced: world.blockPlacedAt(X, placeY, Z),
    placeCalls: world.stats.placeCalls,
  }
}

// ---------------------------------------------------------------------------
// fidelity: the arc model must reproduce the LIVE jumpTrace values verbatim
// ---------------------------------------------------------------------------
addCase('the arc model reproduces the live jumpTrace positions exactly', () => {
  // live traceCompact (the 791-record window):
  //   `2pr0.42y0.333t1i0GABP;2pr0.753y0.248t2i0GABP;`
  //   `2pr1.001y0.165t3i0-A--;2pr1.166y0.083t4i0-A--`
  const live = [0.41999998688697815, 0.7531999805212024, 1.0013359791121417, 1.1661092609382138]
  const liveVelocity = [0.33319999363422365, 0.24813599859094576, 0.16477328182606651, 0.08307781780646721]
  const world = createArcWorld({ startY: 67, supportY: 66, frameTicks: 1, placePath: 'same-tick' })
  world.entity.onGround = true
  world.entity.velocity.y = Math.fround(0.42)
  const observed: number[] = []
  const observedVelocity: number[] = []
  for (let index = 0; index < 4; index += 1) {
    world.frame()
    observed.push(world.entity.position.y - 67)
    observedVelocity.push(world.entity.velocity.y)
  }
  // The velocities are exact (the drag is the engine's float32 `airdrag`); the
  // positions agree to ~1e-15, the residual being prismarine-physics' Vec3
  // `moveEntity` arithmetic rather than the integrator.
  const pass =
    observed.length === live.length &&
    observed.every((rise, index) => Math.abs(rise - (live[index] ?? Number.NaN)) < 1e-12) &&
    observedVelocity.every((velocity, index) => velocity === liveVelocity[index])
  return {
    pass,
    detail: `model=[${observed.join(',')}] live=[${live.join(',')}] velocityExact=${observedVelocity.every((velocity, index) => velocity === liveVelocity[index])}`,
  }
})

addCase('the measured fall curve: one frame of falling undoes the whole apex margin', () => {
  // The demand is exactly `placeY + 1` (zero margin). A PILLAR_UP arc clears the
  // cell top by 1.166 - 1.0 = 0.166 blocks while four position updates from rest
  // cover 0.464 - the measured asymmetry the old gate ignored.
  const fromRest = pillarTrajectoryDelta(0, PILLAR_PLACE_LOOK_HANDSHAKE_TICKS)
  const worst = pillarWorstPlaceDelta(0.08307781780646721, PILLAR_PLACE_LOOK_HANDSHAKE_TICKS)
  const pass = fromRest < -0.46 && fromRest > -0.47 && Math.abs(worst - fromRest) < 1e-12
  return {
    pass,
    detail: `fallFromRest4=${fromRest.toFixed(4)} worstDelta4=${worst.toFixed(4)} apexSurplus=${(1.1661092609382138 - 1).toFixed(4)} handshakeTicks=${PILLAR_PLACE_LOOK_HANDSHAKE_TICKS}`,
  }
})

// ---------------------------------------------------------------------------
// fixture (i): the measured shape - the place must wait for the body to leave
// the cell. Dominant live geometry: launchY == placeY (405/410 refusals).
// ---------------------------------------------------------------------------
addCase('FIXTURE (i) the measured shape lands the block and records the attempt-time Y', async () => {
  const world = createArcWorld({ startY: 67, supportY: 66, frameTicks: 4, placePath: 'same-tick' })
  const result = await runStep(world, 67, 4, 0)
  const cellTop = 68
  const cleared = result.attemptFeetY !== null && result.attemptFeetY >= cellTop
  const pass = result.ok && result.blockPlaced && result.placeCalls === 1 && cleared
  return {
    pass,
    detail: `ok=${result.ok} blockPlaced=${result.blockPlaced} attemptFeetY=${result.attemptFeetY?.toFixed(4) ?? '-'} cellTop=${cellTop} placeCalls=${result.placeCalls} ${result.fail ? formatPillarFail(result.fail) : ''}`,
  }
})

addCase('FIXTURE (i-b) the SAME step through the look handshake attempts nothing it cannot keep', async () => {
  // The measured defect, refused honestly instead of sent: with the actuator's
  // gap declared, a one-block arc cannot satisfy the contract, so the outcome is a
  // typed apex refusal BEFORE any packet - never a refused placement, never a
  // claimed rise.
  const world = createArcWorld({ startY: 67, supportY: 66, frameTicks: 4, placePath: 'look' })
  const result = await runStep(world, 67, 4, PILLAR_PLACE_LOOK_HANDSHAKE_TICKS)
  const pass =
    !result.ok &&
    result.blockPlaced === false &&
    result.placeCalls === 0 &&
    result.fail?.step === 'apex' &&
    result.fail.reason === 'apex_missed'
  return {
    pass,
    detail: `ok=${result.ok} step=${result.fail?.step ?? '-'} reason=${result.fail?.reason ?? '-'} placeCalls=${result.placeCalls} blockPlaced=${result.blockPlaced} attemptFeetY=${result.attemptFeetY?.toFixed(4) ?? 'none'} ${result.fail ? formatPillarFail(result.fail) : ''}`,
  }
})

addCase('FIXTURE (i-c) a launch that already floats high in its cell clears it and places', async () => {
  // The reported live signature: launchY 66.4363679808445, supportY 65, placeY 66.
  // The body starts 0.436 inside the cell, so the arc clears the top by 0.602.
  const world = createArcWorld({
    startY: 66.4363679808445,
    supportY: 65,
    frameTicks: 4,
    placePath: 'same-tick',
  })
  const result = await runStep(world, 66, 4, 0)
  const pass = result.ok && result.blockPlaced && result.attemptFeetY !== null && result.attemptFeetY >= 67
  return {
    pass,
    detail: `ok=${result.ok} blockPlaced=${result.blockPlaced} attemptFeetY=${result.attemptFeetY?.toFixed(4) ?? '-'} cellTop=67 ${result.fail ? formatPillarFail(result.fail) : ''}`,
  }
})

// ---------------------------------------------------------------------------
// fixture (ii): an occupied / protected plan is refused typed BEFORE any attempt
// ---------------------------------------------------------------------------
addCase('FIXTURE (ii) an already-occupied place cell is refused typed before any attempt', () => {
  // Live shape, 29/410 refusals at exactly two cells with the body column inside
  // a lit portal and >= 12 of them refused while the body was still 1.2 above its
  // launch - so the destination, not the body, was the obstruction. The candidate
  // is rejected from the registry facts alone, so no packet is ever sent.
  const portal: PillarPlaceCellProbe = { name: 'nether_portal', boundingBox: 'empty', diggable: false }
  const leaves: PillarPlaceCellProbe = { name: 'leaf_litter', boundingBox: 'block', diggable: true }
  const stone: PillarPlaceCellProbe = { name: 'cobblestone', boundingBox: 'block', diggable: true }
  const air: PillarPlaceCellProbe = { name: 'air', boundingBox: 'empty', diggable: false }
  const water: PillarPlaceCellProbe = { name: 'water', boundingBox: 'empty', diggable: true }
  const shortGrass: PillarPlaceCellProbe = { name: 'short_grass', boundingBox: 'empty', diggable: true }
  const step = evaluatePillarStep({
    placeableCount: 64,
    columnSafe: true,
    remaining: 3,
    footingSolid: true,
    footingUsable: true,
    headroomClear: true,
    placeCellFillable: pillarPlaceCellFillable(portal),
  })
  const pass =
    pillarPlaceCellFillable(portal) === false &&
    pillarPlaceCellFillable(leaves) === false &&
    pillarPlaceCellFillable(stone) === false &&
    pillarPlaceCellFillable(null) === false &&
    pillarPlaceCellFillable(air) === true &&
    pillarPlaceCellFillable(water) === true &&
    pillarPlaceCellFillable(shortGrass) === true &&
    step.ok === false &&
    step.reason === 'occupied_place_cell'
  return {
    pass,
    detail: `portal=${pillarPlaceCellFillable(portal)} leaves=${pillarPlaceCellFillable(leaves)} stone=${pillarPlaceCellFillable(stone)} unknown=${pillarPlaceCellFillable(null)} air=${pillarPlaceCellFillable(air)} water=${pillarPlaceCellFillable(water)} grass=${pillarPlaceCellFillable(shortGrass)} step=${step.ok ? 'ok' : step.reason}`,
  }
})

addCase('FIXTURE (ii-b) the other pillar refusals keep their precedence', () => {
  const base = {
    placeableCount: 64,
    columnSafe: true,
    remaining: 3,
    footingSolid: true,
    footingUsable: true,
    headroomClear: true,
    placeCellFillable: false,
  }
  const noFooting = evaluatePillarStep({ ...base, footingSolid: false })
  const canopy = evaluatePillarStep({ ...base, footingUsable: false })
  const noPlaceable = evaluatePillarStep({ ...base, placeableCount: 0 })
  const reached = evaluatePillarStep({ ...base, remaining: 0 })
  const ok = evaluatePillarStep({ ...base, placeCellFillable: true })
  const pass =
    noFooting.ok === false &&
    noFooting.reason === 'no_footing' &&
    canopy.ok === false &&
    canopy.reason === 'canopy_footing' &&
    noPlaceable.ok === false &&
    noPlaceable.reason === 'no_placeable' &&
    reached.ok === false &&
    reached.reason === 'reached' &&
    ok.ok === true
  return {
    pass,
    detail: `noFooting=${noFooting.ok ? 'ok' : noFooting.reason} canopy=${canopy.ok ? 'ok' : canopy.reason} noPlaceable=${noPlaceable.ok ? 'ok' : noPlaceable.reason} reached=${reached.ok ? 'ok' : reached.reason} fillable=${ok.ok}`,
  }
})

// ---------------------------------------------------------------------------
// fixture (iii): a refused jump or a missed apex is typed, with no false rise
// ---------------------------------------------------------------------------
addCase('FIXTURE (iii) a jump with no footing is a typed takeoff refusal, never a place', async () => {
  const world = createArcWorld({ startY: 67, supportY: null, frameTicks: 1, placePath: 'same-tick' })
  const result = await runStep(world, 67, 1, 0)
  const pass =
    !result.ok &&
    result.placeCalls === 0 &&
    result.blockPlaced === false &&
    result.fail?.step === 'takeoff' &&
    ['no_support', 'no_rise', 'no_physics_tick'].includes(result.fail.reason)
  return {
    pass,
    detail: `ok=${result.ok} step=${result.fail?.step ?? '-'} reason=${result.fail?.reason ?? '-'} placeCalls=${result.placeCalls} blockPlaced=${result.blockPlaced} ${result.fail ? formatPillarFail(result.fail) : ''}`,
  }
})

addCase('FIXTURE (iii-b) an arc a ceiling clamps below the cell is typed, with no attempt', async () => {
  // Live shape from run-mu84l153-qry3: a ceiling clamps the arc to a 0.464 rise
  // while a one-block step needs 1.0, so the cell is never clearable.
  const world = createArcWorld({
    startY: 58,
    supportY: 57,
    frameTicks: 4,
    placePath: 'same-tick',
    ceilingBottomY: 58.464 + 1.8,
  })
  const result = await runStep(world, 58, 4, 0)
  const pass =
    !result.ok &&
    result.placeCalls === 0 &&
    result.blockPlaced === false &&
    result.fail?.step === 'apex' &&
    ['apex_missed', 'falling_before_place'].includes(result.fail.reason)
  return {
    pass,
    detail: `ok=${result.ok} step=${result.fail?.step ?? '-'} reason=${result.fail?.reason ?? '-'} placeCalls=${result.placeCalls} blockPlaced=${result.blockPlaced} ${result.fail ? formatPillarFail(result.fail) : ''}`,
  }
})

addCase('FIXTURE (iii-c) the clearance contract is exact, bounded and window-aware', () => {
  const clearsOnAscent = pillarPlaceCellCleared({ feetY: 68.166, velocityY: 0.083, placeCellY: 67, handshakeTicks: 0 })
  const exactlyOnBoundary = pillarPlaceCellCleared({ feetY: 68, velocityY: 0.083, placeCellY: 67, handshakeTicks: 0 })
  const insideCell = pillarPlaceCellCleared({ feetY: 67.999, velocityY: 0.083, placeCellY: 67, handshakeTicks: 0 })
  const windowed = pillarPlaceCellCleared({
    feetY: 68.166,
    velocityY: 0.083,
    placeCellY: 67,
    handshakeTicks: PILLAR_PLACE_LOOK_HANDSHAKE_TICKS,
  })
  // An UNDECLARED gap must fail closed to the pessimistic bound, never to
  // "zero ticks": assuming a same-tick actuator is exactly the silent
  // assumption that produced the measured refusals.
  const undeclared = pillarPlaceCellCleared({
    feetY: 68.166,
    velocityY: 0.083,
    placeCellY: 67,
    handshakeTicks: undefined as unknown as number,
  })
  const required = requiredApexRise(66.4363679808445, 66)
  const pass =
    clearsOnAscent === true &&
    exactlyOnBoundary === true &&
    insideCell === false &&
    windowed === false &&
    undeclared === false &&
    pillarPlaceHandshakeBudget(undefined as unknown as number) === PILLAR_PLACE_LOOK_HANDSHAKE_TICKS &&
    pillarPlaceHandshakeBudget(-1) === PILLAR_PLACE_LOOK_HANDSHAKE_TICKS &&
    pillarPlaceHandshakeBudget(0) === 0 &&
    pillarPlaceHandshakeBudget(2) === 2 &&
    Math.abs(required - (67 - 66.4363679808445)) < 1e-12
  return {
    pass,
    detail: `ascent=${clearsOnAscent} boundary=${exactlyOnBoundary} inside=${insideCell} windowed=${windowed} undeclared=${undeclared} requiredRise=${required.toFixed(3)}`,
  }
})

// ---------------------------------------------------------------------------
// fixture (iv): the ordinary pillar is unchanged
// ---------------------------------------------------------------------------
addCase('FIXTURE (iv) an ordinary grounded pillar step still places and rises by one', async () => {
  const world = createArcWorld({ startY: 67, supportY: 66, frameTicks: 1, placePath: 'same-tick' })
  const result = await runStep(world, 67, 1, 0)
  const pass = result.ok && result.blockPlaced && result.placeCalls === 1 && (result.attemptFeetY ?? 0) >= 68
  return {
    pass,
    detail: `ok=${result.ok} blockPlaced=${result.blockPlaced} placeCalls=${result.placeCalls} attemptFeetY=${result.attemptFeetY?.toFixed(4) ?? '-'} cellTop=68 ${result.fail ? formatPillarFail(result.fail) : ''}`,
  }
})

addCase('FIXTURE (iv-b) resolvePillarStep still maps a grounded body to the cell above its support', () => {
  const grounded = resolvePillarStep({ feetY: 67, isSolid: (y) => y === 66 })
  const fractional = resolvePillarStep({ feetY: 66.4363679808445, isSolid: (y) => y === 65 })
  const airborne = resolvePillarStep({ feetY: 67, isSolid: (y) => y === 64 })
  const pass =
    grounded !== null &&
    grounded.footingY === 66 &&
    grounded.placeY === 67 &&
    grounded.landingY === 68 &&
    fractional !== null &&
    fractional.footingY === 65 &&
    fractional.placeY === 66 &&
    airborne === null
  return {
    pass,
    detail: `grounded=${grounded === null ? 'null' : `${grounded.footingY}/${grounded.placeY}`} fractional=${fractional === null ? 'null' : `${fractional.footingY}/${fractional.placeY}`} airborne=${airborne === null ? 'null' : 'resolved'}`,
  }
})

// ---------------------------------------------------------------------------
// fixture (v): the composed vertical leg is untouched by this change
// ---------------------------------------------------------------------------
addCase('FIXTURE (v) the composed vertical leg keeps the plan contract it relies on', () => {
  // `runVerticalLeg` composes the step through `pillarUp`/`pillarStepUp`; this
  // change does not touch that call path, the plan shape or `runVerticalLeg`'s
  // signature, so the portal-entry route's composed ascent is orthogonal. The
  // assertion pins the plan contract the composed leg depends on: support ==
  // placeCell - 1 on Y, face = +Y.
  const pose = resolvePillarStep({ feetY: 67.436, isSolid: (y) => y === 66 })
  const support = { x: X, y: pose?.footingY ?? -1, z: Z }
  const placeCell = { x: X, y: pose?.placeY ?? -1, z: Z }
  const face = { x: placeCell.x - support.x, y: placeCell.y - support.y, z: placeCell.z - support.z }
  const pass = face.x === 0 && face.y === 1 && face.z === 0 && placeCell.y === support.y + 1
  return { pass, detail: `footingY=${support.y} placeY=${placeCell.y} face=(${face.x},${face.y},${face.z})` }
})

let failures = 0
process.stdout.write('PILLAR_UP placement-attempt contract - when the packet may be sent\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await Promise.resolve(testCase.run())
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} pillar place-attempt cases passed\n`)
if (failures > 0) process.exit(1)
