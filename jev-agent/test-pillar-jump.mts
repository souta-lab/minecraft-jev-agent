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
import { correctStandingOnGround, formatPillarUpStep, jumpWithGroundCorrection, TAKEOFF_RISE } from './src/pillarJump.ts'
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
function createFakeBot(input: { y: number }) {
  const entity = {
    position: { x: FEET_X + 0.5, y: input.y, z: FEET_Z + 0.5 },
    velocity: { y: 0 },
    onGround: false,
  }
  const controls: boolean[] = []
  const listeners = new Set<() => void>()
  const stats = { ticks: 0, maxListeners: 0, physicsEnabledDuringJump: false, jumpApplied: 0 }
  const bot = {
    entity,
    physicsEnabled: false,
    setControlState(_control: 'jump', state: boolean): void {
      controls.push(state)
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
      if (jumpHeld && entity.onGround) {
        // prismarine-physics jump gate (index.js:721-725): velocity.y = 0.42.
        entity.velocity.y = 0.42
        entity.onGround = false
        stats.jumpApplied += 1
      } else {
        entity.velocity.y -= 0.08
      }
      entity.position.y += entity.velocity.y
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

addCase('a real step emits the live marker sequence (PILLAR_UP_STEP step=1 ...)', () => {
  const step = formatPillarUpStep(1, 10, 11, 'cobblestone')
  const pass = step === 'PILLAR_UP_STEP step=1 from_y=10 to_y=11 placed=cobblestone'
  return { pass, detail: step }
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
