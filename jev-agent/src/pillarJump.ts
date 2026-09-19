// pillarJump.ts - the ground correction and the verified takeoff shared by the
// control walk (`walkByControls`) and the PILLAR_UP step (`pillarApex.ts`).
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
//
// M2 apex control (main d8a7a72, live `PILLAR_UP jump never left the ground at
// y=10.75 rise=0 samples=40` 41x): the flag correction alone did not launch the
// live body, for two structural reasons. (1) mineflayer emits `physicsTick`
// AFTER `simulatePlayer().apply()` (physics.js `tickPhysics`), so the
// correction patches the flag for the NEXT tick while a clientbound position
// packet zeroes velocity and resets `onGround` in between. (2) when
// `shouldUsePhysics` is false the physics loop early-returns before the emit,
// so no corrective tick ever arrives. The takeoff is therefore now verified by
// a POSITION rise (never by a velocity this code itself may have written) and,
// once the flag race has lost for `PILLAR_TAKEOFF_IMPULSE_MS`, backed by the
// exact vanilla impulse (`vel.y = Math.fround(0.42)`, prismarine-physics
// index.js:726). The same live run also proved the placement needs a verified
// apex window rather than a `velocity.y <= 0.01` predicate; that state machine
// lives in `pillarApex.ts`.
import { resolvePillarStep } from './verticalPlan.ts'

export interface Vec3Like {
  x: number
  y: number
  z: number
}

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
  /** Clear a stale horizontal/pathfinder push before a pure vertical hop. */
  clearControlStates?: () => void
  /**
   * `physicsTick` observes the physics loop. `forcedMove` is emitted by
   * mineflayer's clientbound `position` handler AFTER it resets
   * `entity.onGround = false` and zeroes the velocity (physics.js), so it is
   * the last hook that can re-ground the body before the next jump gate read.
   */
  on(event: 'physicsTick' | 'forcedMove', listener: () => void): unknown
  removeListener(event: 'physicsTick' | 'forcedMove', listener: () => void): unknown
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
 * The exact vanilla jump impulse: prismarine-physics sets
 * `vel.y = Math.fround(0.42)` for a grounded jump (index.js:726). Applied only
 * after the flag race has demonstrably lost, so a healthy physics loop never
 * sees it.
 */
export const PILLAR_TAKEOFF_IMPULSE_MS = 100

/** Minimum spacing between explicit impulses: one per 20 Hz physics tick. */
export const PILLAR_TAKEOFF_IMPULSE_INTERVAL_MS = 50

export const JUMP_IMPULSE_VY = Math.fround(0.42)

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

/**
 * Install the correction on every physicsTick; the returned function removes
 * it. `onTick` observes the physics loop itself (`grounded` is the correction
 * verdict), so a caller can tell "the loop never ran" from "the loop ran but
 * the body never left the ground".
 */
export function installGroundCorrection(
  bot: JumpBotLike,
  isSolid: SolidAt,
  onTick?: (grounded: boolean) => void,
): () => void {
  const onPhysicsTick = (): void => {
    const grounded = correctStandingOnGround(bot, isSolid)
    onTick?.(grounded)
  }
  // A clientbound `position` packet resets `onGround = false` and zeroes the
  // velocity, then emits `forcedMove` (physics.js position handler). It can
  // arrive after the last `physicsTick` correction and before the next
  // `simulatePlayer`, so a physicsTick-only correction loses the gate race and
  // `setControlState('jump')` stays a silent no-op. Re-ground on the packet
  // event too; this does not count as a physics tick.
  const onForcedMove = (): void => {
    correctStandingOnGround(bot, isSolid)
  }
  bot.on('physicsTick', onPhysicsTick)
  bot.on('forcedMove', onForcedMove)
  return () => {
    bot.removeListener('physicsTick', onPhysicsTick)
    bot.removeListener('forcedMove', onForcedMove)
  }
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

/** Why the takeoff could not be verified. */
export type TakeoffFailure = 'no_physics_tick' | 'no_support' | 'no_rise'

export interface PillarJumpOutcome {
  /** true only when a POSITION rise proves the body left the ground */
  airborne: boolean
  /** highest rise (blocks) observed during the attempt */
  peakRise: number
  /** poll iterations spent before takeoff or the deadline */
  samples: number
  /** physicsTick events observed during the attempt (0 => the loop is idle) */
  ticks: number
  /** explicit vanilla impulses applied after the flag race lost */
  impulses: number
  /** why takeoff failed; null once airborne */
  failure: TakeoffFailure | null
}

/**
 * The control-walk jump mechanism, bounded and VERIFIED: force physics on,
 * install the ground correction for the duration, hold `jump`, and return only
 * once the body has risen off the launch point. A silent no-op can no longer be
 * mistaken for a jump - the caller gets `airborne: false` plus a typed failure
 * (`no_physics_tick` / `no_support` / `no_rise`).
 *
 * `velocity.y > 0` is deliberately NOT accepted as proof of takeoff: this
 * function itself writes the impulse below, and a dead physics loop would then
 * look airborne forever. Only a position change over `TAKEOFF_RISE` counts.
 */
export async function jumpWithGroundCorrection(bot: JumpBotLike, deps: PillarJumpDeps): Promise<PillarJumpOutcome> {
  const savedPhysics = bot.physicsEnabled
  const startY = bot.entity.position.y
  const startedAt = deps.now()
  let peakRise = 0
  let samples = 0
  let airborne = false
  let groundedOnce = false
  let groundedNow = false
  let ticks = 0
  let impulses = 0
  let lastImpulseAt = Number.NEGATIVE_INFINITY
  // Leaf rejects a jump packet that still carries a blocked horizontal push.
  // PILLAR_UP is a pure vertical actuator; a prior pathfinder/control-walk
  // action must not leak `forward`/`back`/strafe into its takeoff.
  bot.clearControlStates?.()
  // Same correction as the control walk, kept for the whole attempt so a
  // clientbound position packet cannot reset onGround between two ticks.
  const uninstall = installGroundCorrection(bot, deps.isSolid, (grounded) => {
    ticks += 1
    groundedOnce = groundedOnce || grounded
  })
  bot.physicsEnabled = true
  try {
    // Ground the body before the jump control is set: the next physics tick
    // reads `entity.onGround` and applies `velocity.y = 0.42`.
    groundedNow = correctStandingOnGround(bot, deps.isSolid)
    groundedOnce = groundedOnce || groundedNow
    bot.setControlState('jump', true)
    const deadline = startedAt + deps.budgetMs
    while (deps.now() < deadline) {
      groundedNow = correctStandingOnGround(bot, deps.isSolid)
      groundedOnce = groundedOnce || groundedNow
      samples += 1
      const rise = bot.entity.position.y - startY
      if (rise > peakRise) peakRise = rise
      if (rise > TAKEOFF_RISE) {
        airborne = true
        break
      }
      // The flag race lost (physicsTick fires after the gate read, or the loop
      // is idle): assert the exact vanilla impulse while the body is grounded.
      const now = deps.now()
      if (
        groundedNow &&
        now - startedAt >= PILLAR_TAKEOFF_IMPULSE_MS &&
        now - lastImpulseAt >= PILLAR_TAKEOFF_IMPULSE_INTERVAL_MS
      ) {
        bot.entity.velocity.y = JUMP_IMPULSE_VY
        impulses += 1
        lastImpulseAt = now
      }
      await deps.sleep(deps.pollMs)
    }
  } finally {
    bot.setControlState('jump', false)
    uninstall()
    bot.physicsEnabled = savedPhysics
  }
  const failure: TakeoffFailure | null = airborne
    ? null
    : ticks === 0
      ? 'no_physics_tick'
      : !groundedOnce
        ? 'no_support'
        : 'no_rise'
  return { airborne, peakRise, samples, ticks, impulses, failure }
}

/** One line per real PILLAR_UP step: the live proof the climb started. */
export function formatPillarUpStep(step: number, fromY: number, toY: number, placed: string): string {
  return `PILLAR_UP_STEP step=${step} from_y=${fromY} to_y=${toY} placed=${placed}`
}
