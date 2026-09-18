// pillarJump.ts - the ground correction and verified takeoff shared by the
// control walk (`walkByControls`) and PILLAR_UP.
//
// This Leaf 26.1 server ships no collision shapes for the running client
// version, so prismarine-physics reports `entity.onGround = false` while a
// solid block (or a partial mount such as a snow layer / slab) is underfoot,
// and prismarine-physics gates every jump on that flag
// (node_modules/prismarine-physics/index.js:721-725): `setControlState('jump')`
// is silently discarded. The correction patches the flag from the block grid on
// every `physicsTick`, and the takeoff wait re-asserts it while `jump` is held
// so a clientbound `position` packet - which resets `onGround = false` in
// mineflayer/lib/plugins/physics.js - cannot win the race and turn the jump
// back into a no-op.
import { resolvePillarStep } from './verticalPlan.ts'

/** The entity slice a jump needs. */
export interface JumpEntityLike {
  position: { x: number; y: number; z: number }
  velocity: { y: number }
  onGround: boolean
}

/** The bot slice a jump needs: physics toggle, jump control, physicsTick. */
export interface JumpBotLike {
  entity: JumpEntityLike
  physicsEnabled: boolean
  setControlState(control: 'jump', state: boolean): void
  on(event: 'physicsTick', listener: () => void): unknown
  removeListener(event: 'physicsTick', listener: () => void): unknown
}

/** Reports whether the block at (x,y,z) is a full solid block. */
export type SolidAt = (x: number, y: number, z: number) => boolean

/**
 * A rise smaller than this is physics jitter, not a takeoff. The first
 * simulated tick of a jump moves the body ~0.34 blocks, so any real takeoff
 * clears it many times over.
 */
export const TAKEOFF_RISE = 0.02

/** Bounded takeoff window: physics ticks at 20 Hz, so 600 ms is ~12 ticks. */
export const PILLAR_TAKEOFF_BUDGET_MS = 600

/** Poll interval: fast enough to catch the first simulated tick of the jump. */
export const PILLAR_TAKEOFF_POLL_MS = 15

/**
 * Patch mineflayer's stale `onGround` flag from the block grid. The feet cell
 * (a partial mount such as a slab or snow layer lives in it) or the cell below
 * must be a full solid block - the same contiguous scan `resolvePillarStep`
 * uses for the pillar footing, so any step the executor would place a block on
 * can also launch. Returns true when the flag was corrected.
 */
export function correctStandingOnGround(bot: { entity: JumpEntityLike }, isSolid: SolidAt): boolean {
  const { x, y, z } = bot.entity.position
  const fx = Math.floor(x)
  const fz = Math.floor(z)
  const pose = resolvePillarStep({ feetY: y, isSolid: (yy) => isSolid(fx, yy, fz) })
  if (pose === null) return false
  bot.entity.onGround = true
  return true
}

/** Install the correction on every physicsTick; the returned function removes it. */
export function installGroundCorrection(bot: JumpBotLike, isSolid: SolidAt): () => void {
  const onPhysicsTick = (): void => {
    correctStandingOnGround(bot, isSolid)
  }
  bot.on('physicsTick', onPhysicsTick)
  return () => bot.removeListener('physicsTick', onPhysicsTick)
}

export interface PillarJumpDeps {
  isSolid: SolidAt
  /** bounded takeoff window */
  budgetMs: number
  /** poll interval while jump is held */
  pollMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface PillarJumpOutcome {
  /** true only when velocity/position prove the body left the ground */
  airborne: boolean
  /** highest rise (blocks) observed during the attempt */
  peakRise: number
  /** poll iterations spent before takeoff or the deadline */
  samples: number
}

/**
 * The control-walk jump mechanism, bounded and VERIFIED: force physics on,
 * install the ground correction for the duration, hold `jump`, and return only
 * once `velocity.y > 0` or the body has risen off the launch point. A silent
 * no-op can no longer be mistaken for a jump - the caller gets
 * `airborne: false` and raises a typed error.
 */
export async function jumpWithGroundCorrection(bot: JumpBotLike, deps: PillarJumpDeps): Promise<PillarJumpOutcome> {
  const savedPhysics = bot.physicsEnabled
  const startY = bot.entity.position.y
  let peakRise = 0
  let samples = 0
  let airborne = false
  // Same correction as the control walk, kept for the whole attempt so a
  // clientbound position packet cannot reset onGround between two ticks.
  const uninstall = installGroundCorrection(bot, deps.isSolid)
  bot.physicsEnabled = true
  try {
    // Ground the body before the jump control is set: the next physics tick
    // reads `entity.onGround` and applies `velocity.y = 0.42`.
    correctStandingOnGround(bot, deps.isSolid)
    bot.setControlState('jump', true)
    const deadline = deps.now() + deps.budgetMs
    while (deps.now() < deadline) {
      correctStandingOnGround(bot, deps.isSolid)
      samples += 1
      const rise = bot.entity.position.y - startY
      if (rise > peakRise) peakRise = rise
      if (bot.entity.velocity.y > 0 || rise > TAKEOFF_RISE) {
        airborne = true
        break
      }
      await deps.sleep(deps.pollMs)
    }
    return { airborne, peakRise, samples }
  } finally {
    bot.setControlState('jump', false)
    uninstall()
    bot.physicsEnabled = savedPhysics
  }
}

/** One line per real PILLAR_UP step: the live proof the climb started. */
export function formatPillarUpStep(step: number, fromY: number, toY: number, placed: string): string {
  return `PILLAR_UP_STEP step=${step} from_y=${fromY} to_y=${toY} placed=${placed}`
}
