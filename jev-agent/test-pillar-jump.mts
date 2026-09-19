// test-pillar-jump.mts - M2 PILLAR_UP jump regression.
//
// The live failure: PILLAR_UP planned 552x, PILLAR_UP_STEP 0, every attempt
// ending in `PILLAR_UP jump never left the ground` while the body sat at a
// fractional y (10.25-10.5) over a footing at feet-1 and the server shipped no
// collision shapes (onGround=false). The pre-fix correction probed only 0.1
// below the raw feet, so it landed in the feet cell (a non-solid partial mount)
// and never patched the flag: `setControlState('jump')` was a silent no-op.
//
// These cases drive the production `pillarJump.ts` mechanism with a fake bot
// that reproduces the prismarine-physics jump gate and the clientbound
// `onGround=false` rubber-band - no live server.
//
//   npm run pillar-jump-test
import {
  correctStandingOnGround,
  formatPillarUpStep,
  jumpWithGroundCorrection,
  PILLAR_TRACE_MAX_IMPULSES,
  PILLAR_TRACE_MAX_TICKS,
  TAKEOFF_RISE,
} from './src/pillarJump.ts'
import type { SolidAt } from './src/pillarJump.ts'

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

const FEET_X = 39
const FEET_Z = 34

/** A solid footing at `solidAtY`; the feet cell may hold a non-solid mount. */
function footingAt(solidAtY: number | null): SolidAt {
  return (x, y, z) => x === FEET_X && z === FEET_Z && y === solidAtY
}

/**
 * Fake bot driven by the real production jump path. It reproduces two live
 * conditions: the prismarine-physics gate (`jump` only applies while
 * `onGround`) and a clientbound position packet that resets `onGround=false`
 * before every other simulate - so the physicsTick correction must actively
 * re-ground the body between ticks for the jump to ever fire.
 */
function createFakeBot(input: { y: number; gate?: boolean; floorTop?: number }) {
  const gateOpen = input.gate !== false
  const floorTop = input.floorTop ?? Number.NEGATIVE_INFINITY
  const entity = {
    position: { x: FEET_X + 0.5, y: input.y, z: FEET_Z + 0.5 },
    velocity: { y: 0 },
    onGround: false,
  }
  const controls: boolean[] = []
  const listeners = new Set<() => void>()
  const stats = { ticks: 0, maxListeners: 0, physicsEnabledDuringJump: false, jumpApplied: 0, clearControlStates: 0 }
  const bot = {
    entity,
    physicsEnabled: false,
    setControlState(_control: 'jump', state: boolean): void {
      controls.push(state)
    },
    clearControlStates(): void {
      stats.clearControlStates += 1
    },
    on(_event: 'physicsTick', listener: () => void): void {
      listeners.add(listener)
    },
    removeListener(_event: 'physicsTick', listener: () => void): void {
      listeners.delete(listener)
    },
    listenerCount(): number {
      return listeners.size
    },
    jumpTransitions(): readonly boolean[] {
      return controls
    },
    stats,
    tick(): void {
      stats.ticks += 1
      if (stats.ticks === 1) stats.physicsEnabledDuringJump = bot.physicsEnabled
      stats.maxListeners = Math.max(stats.maxListeners, listeners.size)
      // Clientbound position packet (mineflayer physics.js): onGround=false.
      if (stats.ticks % 2 === 1) entity.onGround = false
      const jumpHeld = controls.length > 0 && controls[controls.length - 1] === true
      if (gateOpen && jumpHeld && entity.onGround) {
        // prismarine-physics jump gate (index.js:721-725): velocity.y = 0.42.
        entity.velocity.y = 0.42
        entity.onGround = false
        stats.jumpApplied += 1
      } else {
        entity.velocity.y -= 0.08
      }
      entity.position.y += entity.velocity.y
      if (entity.position.y < floorTop && entity.velocity.y <= 0) {
        entity.position.y = floorTop
        entity.velocity.y = 0
      }
      entity.onGround = false
      for (const listener of listeners) listener()
    },
  }
  return bot
}

/** Drives the fake bot with an injected clock so the bounded wait is instant. */
function jumpDeps(bot: ReturnType<typeof createFakeBot>, isSolid: SolidAt) {
  let clock = 0
  return {
    isSolid,
    budgetMs: 600,
    pollMs: 15,
    sleep: async (ms: number): Promise<void> => {
      clock += ms
      bot.tick()
    },
    now: () => clock,
  }
}

/**
 * Fake bot for the live packet race. The server holds the body, so a
 * clientbound `position` packet resets `onGround = false` and zeroes the
 * velocity after the poll's correction/impulse and before the next
 * `simulatePlayer` reads the jump gate. Mineflayer emits `forcedMove`
 * synchronously after that reset (physics.js position handler) - the last
 * client-side hook before the next tick. The physics order is the real one:
 * `apply()` (gate + move) first, then the `physicsTick` correction, so a
 * `physicsTick`-only correction always lands one tick too late.
 */
function createHeldPositionBot(input: { y: number }) {
  const entity = {
    position: { x: FEET_X + 0.5, y: input.y, z: FEET_Z + 0.5 },
    velocity: { y: 0 },
    onGround: false,
  }
  const listeners = new Map<string, Set<() => void>>()
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  const controls: boolean[] = []
  const stats = { ticks: 0, packetResets: 0, jumpApplied: 0, clearControlStates: 0 }
  const bot = {
    entity,
    physicsEnabled: false,
    jumpTicks: 0,
    jumpQueued: false,
    setControlState(_control: 'jump', state: boolean): void {
      controls.push(state)
      if (state) bot.jumpQueued = true
    },
    clearControlStates(): void {
      stats.clearControlStates += 1
    },
    on(event: string, listener: () => void): void {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event: string, listener: () => void): void {
      listeners.get(event)?.delete(listener)
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0
    },
    stats,
    jumpTransitions(): readonly boolean[] {
      return controls
    },
    /** Clientbound position packet: reset flag + zero velocity, then forcedMove. */
    packet(): void {
      stats.packetResets += 1
      entity.onGround = false
      entity.velocity.y = 0
      bot.jumpTicks = 0
      emit('forcedMove')
    },
    /** prismarine-physics tickPhysics: apply (gate + move), then emit physicsTick. */
    tick(): void {
      stats.ticks += 1
      const jumpHeld = controls.length > 0 && controls[controls.length - 1] === true
      if ((jumpHeld || bot.jumpQueued) && entity.onGround && bot.jumpTicks === 0) {
        entity.velocity.y = 0.42 // prismarine-physics index.js:726
        bot.jumpTicks = 10
        entity.onGround = false
        stats.jumpApplied += 1
      } else if (bot.jumpTicks > 0) {
        bot.jumpTicks -= 1
      }
      bot.jumpQueued = false
      entity.position.y += entity.velocity.y
      entity.velocity.y = (entity.velocity.y - 0.08) * 0.98
      if (entity.position.y < input.y && entity.velocity.y <= 0) {
        entity.position.y = input.y
        entity.velocity.y = 0
      }
      entity.onGround = false
      emit('physicsTick')
    },
  }
  return bot
}

/** Drives the held-position bot: a packet reset every poll, a tick every 50 ms. */
function heldPositionDeps(bot: ReturnType<typeof createHeldPositionBot>, isSolid: SolidAt) {
  let clock = 0
  let lastTickAt = 0
  return {
    isSolid,
    budgetMs: 600,
    pollMs: 15,
    sleep: async (ms: number): Promise<void> => {
      clock += ms
      // The server's correction packet lands after the poll wrote the impulse
      // and before simulatePlayer reads the gate.
      bot.packet()
      while (clock - lastTickAt >= 50) {
        lastTickAt += 50
        bot.tick()
      }
    },
    now: () => clock,
  }
}

/**
 * Fake bot that reproduces the exact LIVE `no_rise` signature while modelling
 * no clientbound `position` packet at all (the live run had forcedMove NEVER
 * observed). The block-grid correction grounds the body every tick, the poll
 * writes explicit impulses after 100 ms, and the move is blocked vertically by
 * the support block, so `peakRise` stays 0 and `isCollidedVertically` stays
 * true. The ONLY variable between the two modes is the jump gate:
 *
 *   - `gate_never_fired`        (A): `jumpTicks` is stuck above 0, so the
 *                                    prismarine gate branch can never fire.
 *   - `gate_fired_move_clamped` (B): the gate fires (0 -> 10) but the same
 *                                    tick's move clamps the impulse to 0.
 */
function createClampedPillarBot(input: { mode: 'gate_never_fired' | 'gate_fired_move_clamped'; y?: number }) {
  const startY = input.y ?? 10.5
  const entity = {
    position: { x: FEET_X + 0.5, y: startY, z: FEET_Z + 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: false,
    isCollidedVertically: false,
  }
  const listeners = new Map<string, Set<() => void>>()
  const emit = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  const controls: boolean[] = []
  const stats = { ticks: 0, gateFires: 0, forcedMoves: 0 }
  const bot = {
    entity,
    physicsEnabled: false,
    // (A) pins the autojump cooldown above zero so the gate's `jumpTicks === 0`
    // branch is unreachable even though the correction grounded the body.
    jumpTicks: input.mode === 'gate_never_fired' ? 5 : 0,
    setControlState(_control: 'jump', state: boolean): void {
      controls.push(state)
    },
    clearControlStates(): void {},
    on(event: string, listener: () => void): void {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event: string, listener: () => void): void {
      listeners.get(event)?.delete(listener)
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0
    },
    stats,
    jumpTransitions(): readonly boolean[] {
      return controls
    },
    /**
     * One prismarine-physics tick: gate (index.js:721-727), then the blocked
     * move. The support block overlaps the body, so the vertical move is
     * clamped every tick (`dy !== oldVelY` -> `vel.y = 0`,
     * `isCollidedVertically = true`) regardless of the impulse.
     */
    tick(): void {
      stats.ticks += 1
      const jumpHeld = controls.length > 0 && controls[controls.length - 1] === true
      if (jumpHeld && entity.onGround && bot.jumpTicks === 0) {
        entity.velocity.y = Math.fround(0.42) // prismarine-physics index.js:726
        bot.jumpTicks = 10
        stats.gateFires += 1
      } else if (jumpHeld && bot.jumpTicks > 0 && input.mode !== 'gate_never_fired') {
        bot.jumpTicks -= 1
      }
      // moveEntity: gravity, then the overlap blocks the vertical move.
      entity.velocity.y = (entity.velocity.y - 0.08) * 0.98
      entity.position.y = startY
      if (entity.velocity.y > 0) entity.velocity.y = 0
      entity.isCollidedVertically = true
      entity.onGround = false
      emit('physicsTick')
    },
  }
  return bot
}

/** Drives the clamped fake: a physics tick every 50 ms, NO position packet. */
function clampedPillarDeps(bot: ReturnType<typeof createClampedPillarBot>, isSolid: SolidAt) {
  let clock = 0
  let lastTickAt = 0
  return {
    isSolid,
    budgetMs: 600,
    pollMs: 15,
    sleep: async (ms: number): Promise<void> => {
      clock += ms
      while (clock - lastTickAt >= 50) {
        lastTickAt += 50
        bot.tick()
      }
    },
    now: () => clock,
  }
}

function runCase(testCase: Case): Promise<CaseResult> {
  return Promise.resolve(testCase.run())
}

addCase('the correction grounds a fractional body over a footing at feet-1 (the live y=10.5 case)', () => {
  const bot = createFakeBot({ y: 10.5 })
  const isSolid = footingAt(9)
  // The pre-fix predicate: probe 0.1 below the raw feet -> feet cell -> the
  // non-solid partial mount, so `onGround` was never patched.
  const legacyProbe = isSolid(FEET_X, Math.floor(bot.entity.position.y - 0.1), FEET_Z)
  const corrected = correctStandingOnGround(bot, isSolid)
  const pass = corrected && bot.entity.onGround && legacyProbe === false
  return {
    pass,
    detail: `y=${bot.entity.position.y} legacy-0.1-probe=${legacyProbe} corrected=${corrected} onGround=${bot.entity.onGround}`,
  }
})

addCase('without a solid footing the correction is a no-op and the jump gate never fires', () => {
  const bot = createFakeBot({ y: 10.5 })
  const corrected = correctStandingOnGround(bot, footingAt(null))
  bot.tick()
  const pass = corrected === false && bot.stats.jumpApplied === 0 && bot.entity.velocity.y < 0
  return {
    pass,
    detail: `corrected=${corrected} jumpApplied=${bot.stats.jumpApplied} vy=${bot.entity.velocity.y}`,
  }
})

addCase('the pillar jump path installs the correction and a simulated onGround=false body produces takeoff', async () => {
  const bot = createFakeBot({ y: 10.5 })
  const outcome = await jumpWithGroundCorrection(bot, jumpDeps(bot, footingAt(9)))
  const transitions = bot.jumpTransitions()
  const pass =
    outcome.airborne &&
    outcome.peakRise > TAKEOFF_RISE &&
    bot.stats.jumpApplied === 1 &&
    bot.stats.maxListeners >= 1 &&
    bot.listenerCount() === 0 &&
    bot.stats.physicsEnabledDuringJump === true &&
    bot.physicsEnabled === false &&
    transitions[0] === true &&
    transitions[transitions.length - 1] === false
  return {
    pass,
    detail: `airborne=${outcome.airborne} rise=${outcome.peakRise} samples=${outcome.samples} jumpApplied=${bot.stats.jumpApplied} listeners(max=${bot.stats.maxListeners},after=${bot.listenerCount()}) physicsDuring=${bot.stats.physicsEnabledDuringJump}->after=${bot.physicsEnabled} controls=[${transitions.join(',')}]`,
  }
})

addCase('the pillar jump clears stale horizontal controls before takeoff', async () => {
  const bot = createFakeBot({ y: 10.5 })
  const outcome = await jumpWithGroundCorrection(bot, jumpDeps(bot, footingAt(9)))
  const pass = outcome.airborne && bot.stats.clearControlStates === 1
  return {
    pass,
    detail: `airborne=${outcome.airborne} clearControlStates=${bot.stats.clearControlStates}`,
  }
})

addCase('the takeoff impulse launches a body whose jump gate never fires (the live flag race)', async () => {
  // The real race: physicsTick fires after physics already read onGround, and a
  // clientbound position packet can reset it in between. `gate: false` models a
  // gate that loses every tick; only the verified impulse can launch the body.
  const bot = createFakeBot({ y: 10.5, gate: false, floorTop: 10 })
  const outcome = await jumpWithGroundCorrection(bot, jumpDeps(bot, footingAt(9)))
  const pass =
    outcome.airborne &&
    outcome.impulses >= 1 &&
    outcome.ticks >= 1 &&
    outcome.peakRise > TAKEOFF_RISE &&
    outcome.failure === null &&
    bot.stats.jumpApplied === 0
  return {
    pass,
    detail: `airborne=${outcome.airborne} rise=${outcome.peakRise} impulses=${outcome.impulses} ticks=${outcome.ticks} samples=${outcome.samples} gateFires=${bot.stats.jumpApplied} failure=${outcome.failure}`,
  }
})

addCase('with no solid footing the bounded wait reports a no-op instead of hanging', async () => {
  const bot = createFakeBot({ y: 10.5 })
  const outcome = await jumpWithGroundCorrection(bot, jumpDeps(bot, footingAt(null)))
  const expectedSamples = Math.ceil(600 / 15) + 1
  const pass =
    !outcome.airborne &&
    outcome.peakRise <= 0 &&
    outcome.samples >= 1 &&
    outcome.samples <= expectedSamples &&
    bot.stats.jumpApplied === 0 &&
    bot.listenerCount() === 0 &&
    bot.physicsEnabled === false
  return {
    pass,
    detail: `airborne=${outcome.airborne} rise=${outcome.peakRise} samples=${outcome.samples}/${expectedSamples} jumpApplied=${bot.stats.jumpApplied} listeners=${bot.listenerCount()}`,
  }
})

addCase('a clientbound position reset between ticks cannot discard the takeoff (forcedMove re-grounds)', async () => {
  // The live race: the server holds the body, so every clientbound `position`
  // packet resets onGround=false and zeroes velocity AFTER the physicsTick
  // correction and BEFORE the next simulatePlayer reads the jump gate. A
  // physicsTick-only correction always loses that race; only re-grounding on
  // the forcedMove hook (emitted right after the reset) lets the gate fire.
  const bot = createHeldPositionBot({ y: 10.5 })
  const outcome = await jumpWithGroundCorrection(bot, heldPositionDeps(bot, footingAt(9)))
  const pass =
    outcome.airborne &&
    outcome.peakRise > TAKEOFF_RISE &&
    outcome.failure === null &&
    bot.stats.jumpApplied >= 1 &&
    bot.stats.packetResets >= 1 &&
    bot.listenerCount('physicsTick') === 0 &&
    bot.listenerCount('forcedMove') === 0
  return {
    pass,
    detail: `airborne=${outcome.airborne} rise=${outcome.peakRise} packets=${bot.stats.packetResets} gateFires=${bot.stats.jumpApplied} ticks=${outcome.ticks} failure=${outcome.failure} listeners(physicsTick=${bot.listenerCount('physicsTick')},forcedMove=${bot.listenerCount('forcedMove')})`,
  }
})

addCase('a real step emits the live marker sequence (PILLAR_UP_STEP step=1 ...)', () => {
  const step = formatPillarUpStep(1, 10, 11, 'cobblestone')
  const pass = step === 'PILLAR_UP_STEP step=1 from_y=10 to_y=11 placed=cobblestone'
  return { pass, detail: step }
})

addCase('the live no_rise signature is discriminated: (A) gate never fired vs (B) gate fired then clamped', async () => {
  // Both variants reproduce the exact live signature: physics ticks and explicit
  // impulses, yet peakRise stays 0 and the move reports isCollidedVertically,
  // with NO forcedMove. Only the vertical trace may tell them apart.
  const gateNever = createClampedPillarBot({ mode: 'gate_never_fired' })
  const gateClamped = createClampedPillarBot({ mode: 'gate_fired_move_clamped' })
  const a = await jumpWithGroundCorrection(gateNever, clampedPillarDeps(gateNever, footingAt(9)))
  const b = await jumpWithGroundCorrection(gateClamped, clampedPillarDeps(gateClamped, footingAt(9)))

  const liveA =
    !a.airborne &&
    a.failure === 'no_rise' &&
    a.impulses > 0 &&
    a.ticks > 0 &&
    a.peakRise === 0 &&
    gateNever.entity.isCollidedVertically === true &&
    gateNever.stats.forcedMoves === 0
  const liveB =
    !b.airborne &&
    b.failure === 'no_rise' &&
    b.impulses > 0 &&
    b.ticks > 0 &&
    b.peakRise === 0 &&
    gateClamped.entity.isCollidedVertically === true &&
    gateClamped.stats.forcedMoves === 0

  const bGateSample = b.trace.tickSamples.find((s) => s.gateFired)
  const aGateSample = a.trace.tickSamples.find((s) => s.gateFired)
  const pass =
    liveA &&
    liveB &&
    // (A): the gate was never observed to fire, and no tick shows a jumpTicks rise.
    a.trace.discriminator === 'gate_never_fired' &&
    a.trace.gateFires === 0 &&
    aGateSample === undefined &&
    a.trace.tickSamples.every((s) => !s.gateFired) &&
    a.trace.impulseWrites === a.impulses &&
    // (B): the gate fired (jumpTicks 0 -> 10) but the same tick's move clamped it.
    b.trace.discriminator === 'gate_fired_move_clamped' &&
    b.trace.gateFires >= 1 &&
    b.trace.collidedVerticallyTicks > 0 &&
    bGateSample !== undefined &&
    bGateSample.jumpTicksBefore === 0 &&
    bGateSample.jumpTicksAfter === 10 &&
    bGateSample.collidedVerticallyAfter === true &&
    bGateSample.positionYAfter === bGateSample.positionYBefore &&
    b.trace.impulseWrites === b.impulses &&
    b.trace.impulseSamples.every((s) => s.velocityY === Math.fround(0.42)) &&
    // Both traces stay bounded.
    a.trace.tickSamples.length <= PILLAR_TRACE_MAX_TICKS &&
    b.trace.impulseSamples.length <= PILLAR_TRACE_MAX_IMPULSES
  return {
    pass,
    detail:
      `A(airborne=${a.airborne} reason=${a.failure} rise=${a.peakRise} ticks=${a.ticks} impulses=${a.impulses} disc=${a.trace.discriminator} gate=${a.trace.gateFires}) ` +
      `B(airborne=${b.airborne} reason=${b.failure} rise=${b.peakRise} ticks=${b.ticks} impulses=${b.impulses} disc=${b.trace.discriminator} gate=${b.trace.gateFires} clamp=${b.trace.collidedVerticallyTicks} gateTick=${bGateSample === undefined ? 'none' : `${bGateSample.jumpTicksBefore}->${bGateSample.jumpTicksAfter}`})`,
  }
})

let failures = 0
process.stdout.write('M2 pillar jump - verified takeoff from a stale onGround flag\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await runCase(testCase)
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} pillar-jump cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
