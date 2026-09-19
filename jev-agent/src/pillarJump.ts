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
  /** prismarine-physics sets this when the tick's move was blocked vertically. */
  isCollidedVertically?: boolean
}

/** The bot slice a jump needs: physics toggle, jump control, physicsTick. */
export interface JumpBotLike {
  entity: JumpEntityLike
  physicsEnabled: boolean
  setControlState(control: 'jump', state: boolean): void
  /** Clear a stale horizontal/pathfinder push before a pure vertical hop. */
  clearControlStates?: () => void
  /**
   * prismarine-physics autojump cooldown (mineflayer `bot.jumpTicks`). The ONLY
   * code that INCREASES it is the jump-fire branch (`entity.jumpTicks =
   * physics.autojumpCooldown`), so a per-tick increase is a sound, purely
   * observable signal that the jump gate fired. Optional so structural fakes
   * that do not model the cooldown stay assignable.
   */
  jumpTicks?: number
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
 * Bounds on the observation-only vertical trace. The bounded takeoff window is
 * ~12 physics ticks (600 ms at 20 Hz), so 24 keeps the whole live attempt while
 * capping a pathological loop. The impulse interval is 50 ms, so 12 is a full
 * window. Caps mean the trace can never bloat the run log.
 */
export const PILLAR_TRACE_MAX_TICKS = 24
export const PILLAR_TRACE_MAX_IMPULSES = 12
/** Hard cap on the compact one-line encoding so a single record stays small. */
export const PILLAR_TRACE_MAX_LINE = 1600

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
 * the body never left the ground". `afterMoveOnGround` is `entity.onGround` as
 * the completed `simulatePlayer` left it, captured BEFORE this callback's
 * correction overwrites it (observation only). `onForcedMoveGround` observes
 * the correction that follows a clientbound position reset.
 */
export function installGroundCorrection(
  bot: JumpBotLike,
  isSolid: SolidAt,
  onTick?: (grounded: boolean, afterMoveOnGround: boolean) => void,
  onForcedMoveGround?: (grounded: boolean) => void,
): () => void {
  const onPhysicsTick = (): void => {
    const afterMoveOnGround = bot.entity.onGround
    const grounded = correctStandingOnGround(bot, isSolid)
    onTick?.(grounded, afterMoveOnGround)
  }
  // A clientbound `position` packet resets `onGround = false` and zeroes the
  // velocity, then emits `forcedMove` (physics.js position handler). It can
  // arrive after the last `physicsTick` correction and before the next
  // `simulatePlayer`, so a physicsTick-only correction loses the gate race and
  // `setControlState('jump')` stays a silent no-op. Re-ground on the packet
  // event too; this does not count as a physics tick.
  const onForcedMove = (): void => {
    const grounded = correctStandingOnGround(bot, isSolid)
    onForcedMoveGround?.(grounded)
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

/**
 * One physics tick of the vertical takeoff trace. Every field is read from
 * observable client state; nothing here is written to the bot.
 */
export interface PillarVerticalTickSample {
  /** 1-based physicsTick index within the attempt */
  tick: number
  /**
   * `entity.onGround` as presented to the jump gate at the start of this tick.
   * The gate reads the flag BEFORE the tick's move, so this is the value
   * left by the previous tick's correction / packet observer (or by the pre-jump
   * correction for tick 1).
   */
  onGroundAtGate: boolean
  /** `entity.onGround` right after the completed move, before re-grounding */
  onGroundAfterMove: boolean
  jumpTicksBefore: number
  jumpTicksAfter: number
  /**
   * True when `jumpTicks` increased across this tick. The only code that
   * increases it is the prismarine-physics jump-fire branch (0 -> autojumpCooldown),
   * so this is the sound, observable proof that the gate fired - even when the
   * move that follows immediately clamps the impulse back to 0.
   */
  gateFired: boolean
  velocityYBefore: number
  velocityYAfter: number
  positionYBefore: number
  positionYAfter: number
  /** `entity.isCollidedVertically` after the tick's move */
  collidedVerticallyAfter: boolean
}

/** One explicit post-race vanilla impulse written by the polling loop. */
export interface PillarImpulseSample {
  /** physicsTick index the impulse was written after */
  tick: number
  /** the exact `velocity.y` written */
  velocityY: number
}

/**
 * The mutually-exclusive cause the traced attempt supports.
 *  - `no_physics_tick`: the loop never ran, so nothing can be discriminated.
 *  - `gate_never_fired`: no tick shows a `jumpTicks` increase.
 *  - `gate_fired_move_clamped`: the gate fired, but the same tick's move blocked
 *    the rise (collision/overlap with the support block).
 *  - `rise_observed`: a tick shows the gate fired AND the body rose.
 *  - `inconclusive`: the gate fired but neither clamp nor rise was observed.
 */
export type PillarVerticalDiscriminator =
  | 'no_physics_tick'
  | 'gate_never_fired'
  | 'gate_fired_move_clamped'
  | 'rise_observed'
  | 'inconclusive'

/**
 * Bounded, observation-only per-tick vertical trace of one takeoff attempt.
 * Sized so a PILLAR_FAIL record stays small: at most `PILLAR_TRACE_MAX_TICKS`
 * tick samples and `PILLAR_TRACE_MAX_IMPULSES` impulse samples.
 */
export interface PillarVerticalTrace {
  tickSamples: PillarVerticalTickSample[]
  impulseSamples: PillarImpulseSample[]
  /** physicsTick events observed during the attempt */
  ticksObserved: number
  /** ticks whose `jumpTicks` increased (gate fires) */
  gateFires: number
  /** ticks whose move reported `isCollidedVertically` */
  collidedVerticallyTicks: number
  /** explicit vanilla impulses written by the polling loop */
  impulseWrites: number
  /** highest `velocity.y` seen after a tick (0 when the loop never ran) */
  maxVelocityYAfterTick: number
  /** highest rise after a tick, in blocks */
  maxRise: number
  /** tick samples dropped once the cap was reached */
  tickSamplesDropped: number
  /** impulse samples dropped once the cap was reached */
  impulseSamplesDropped: number
  /** which of the two mutually-exclusive live causes the trace supports */
  discriminator: PillarVerticalDiscriminator
}

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
  /** bounded within-attempt vertical trace (observation only, additive) */
  trace: PillarVerticalTrace
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
  // Observation-only vertical trace state. `gateOnGround` tracks the flag value
  // the NEXT jump-gate read will see: it is refreshed at every correction point,
  // including the `forcedMove` observer that re-grounds after a clientbound
  // reset. The `prev*` values are the last observed pre-tick state.
  const tickSamples: PillarVerticalTickSample[] = []
  const impulseSamples: PillarImpulseSample[] = []
  let tickSamplesDropped = 0
  let impulseSamplesDropped = 0
  let gateFires = 0
  let collidedVerticallyTicks = 0
  let impulseWrites = 0
  let clampedAfterGateTicks = 0
  let maxVelocityYAfterTick = Number.NEGATIVE_INFINITY
  let maxRise = 0
  let gateOnGround = bot.entity.onGround
  let prevVelocityY = bot.entity.velocity.y
  let prevPositionY = bot.entity.position.y
  let prevJumpTicks = bot.jumpTicks ?? 0
  const recordTick = (grounded: boolean, afterMoveOnGround: boolean): void => {
    ticks += 1
    groundedOnce = groundedOnce || grounded
    const jumpTicksAfter = bot.jumpTicks ?? prevJumpTicks
    const gateFired = jumpTicksAfter > prevJumpTicks
    const velocityYAfter = bot.entity.velocity.y
    const positionYAfter = bot.entity.position.y
    const collidedVerticallyAfter = bot.entity.isCollidedVertically === true
    if (gateFired) gateFires += 1
    if (collidedVerticallyAfter) collidedVerticallyTicks += 1
    if (gateFired && collidedVerticallyAfter) clampedAfterGateTicks += 1
    if (velocityYAfter > maxVelocityYAfterTick) maxVelocityYAfterTick = velocityYAfter
    const rise = positionYAfter - startY
    if (rise > maxRise) maxRise = rise
    const sample: PillarVerticalTickSample = {
      tick: ticks,
      onGroundAtGate: gateOnGround,
      onGroundAfterMove: afterMoveOnGround,
      jumpTicksBefore: prevJumpTicks,
      jumpTicksAfter,
      gateFired,
      velocityYBefore: prevVelocityY,
      velocityYAfter,
      positionYBefore: prevPositionY,
      positionYAfter,
      collidedVerticallyAfter,
    }
    if (tickSamples.length < PILLAR_TRACE_MAX_TICKS) tickSamples.push(sample)
    else tickSamplesDropped += 1
    gateOnGround = bot.entity.onGround
    prevVelocityY = velocityYAfter
    prevPositionY = positionYAfter
    prevJumpTicks = jumpTicksAfter
  }
  // Leaf rejects a jump packet that still carries a blocked horizontal push.
  // PILLAR_UP is a pure vertical actuator; a prior pathfinder/control-walk
  // action must not leak `forward`/`back`/strafe into its takeoff.
  bot.clearControlStates?.()
  // Same correction as the control walk, kept for the whole attempt so a
  // clientbound position packet cannot reset onGround between two ticks.
  const uninstall = installGroundCorrection(
    bot,
    deps.isSolid,
    (grounded, afterMoveOnGround) => recordTick(grounded, afterMoveOnGround),
    () => {
      // The packet zeroed velocity and reset onGround; the forcedMove correction
      // has just re-ground the body, so refresh what the next gate/move reads.
      gateOnGround = bot.entity.onGround
      prevVelocityY = bot.entity.velocity.y
      prevPositionY = bot.entity.position.y
      prevJumpTicks = bot.jumpTicks ?? 0
    },
  )
  bot.physicsEnabled = true
  try {
    // Ground the body before the jump control is set: the next physics tick
    // reads `entity.onGround` and applies `velocity.y = 0.42`.
    groundedNow = correctStandingOnGround(bot, deps.isSolid)
    groundedOnce = groundedOnce || groundedNow
    gateOnGround = bot.entity.onGround
    bot.setControlState('jump', true)
    const deadline = startedAt + deps.budgetMs
    while (deps.now() < deadline) {
      groundedNow = correctStandingOnGround(bot, deps.isSolid)
      groundedOnce = groundedOnce || groundedNow
      gateOnGround = bot.entity.onGround
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
        impulseWrites += 1
        const impulseSample: PillarImpulseSample = { tick: ticks, velocityY: JUMP_IMPULSE_VY }
        if (impulseSamples.length < PILLAR_TRACE_MAX_IMPULSES) impulseSamples.push(impulseSample)
        else impulseSamplesDropped += 1
        lastImpulseAt = now
        prevVelocityY = JUMP_IMPULSE_VY
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
  const discriminator: PillarVerticalDiscriminator =
    ticks === 0
      ? 'no_physics_tick'
      : gateFires === 0
        ? 'gate_never_fired'
        : airborne
          ? 'rise_observed'
          : clampedAfterGateTicks > 0
            ? 'gate_fired_move_clamped'
            : 'inconclusive'
  const trace: PillarVerticalTrace = {
    tickSamples,
    impulseSamples,
    ticksObserved: ticks,
    gateFires,
    collidedVerticallyTicks,
    impulseWrites,
    maxVelocityYAfterTick: ticks === 0 ? 0 : maxVelocityYAfterTick,
    maxRise,
    tickSamplesDropped,
    impulseSamplesDropped,
    discriminator,
  }
  return { airborne, peakRise, samples, ticks, impulses, failure, trace }
}

/** Three-decimal rounding for the compact trace line. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Compact, bounded one-line encoding of a vertical trace for the mirrored
 * markers. The per-tick body is capped by `PILLAR_TRACE_MAX_LINE` so even a
 * pathological loop cannot bloat a single log record.
 */
export function formatVerticalTraceCompact(trace: PillarVerticalTrace): string {
  const head =
    `disc=${trace.discriminator} ticks=${trace.ticksObserved} gate=${trace.gateFires}` +
    ` clamp=${trace.collidedVerticallyTicks} imp=${trace.impulseWrites}` +
    ` maxVy=${round3(trace.maxVelocityYAfterTick)} maxRise=${round3(trace.maxRise)}`
  let body = ''
  for (const s of trace.tickSamples) {
    const part =
      `${s.tick}:og${s.onGroundAtGate ? 1 : 0}${s.onGroundAfterMove ? 1 : 0}` +
      ` jt${s.jumpTicksBefore}>${s.jumpTicksAfter} g${s.gateFired ? 1 : 0}` +
      ` vy${round3(s.velocityYBefore)}>${round3(s.velocityYAfter)}` +
      ` py${round3(s.positionYBefore)}>${round3(s.positionYAfter)}` +
      ` cv${s.collidedVerticallyAfter ? 1 : 0}`
    if (body.length + part.length + 1 > PILLAR_TRACE_MAX_LINE) {
      body += ' +more'
      break
    }
    body += (body.length === 0 ? '' : ' ') + part
  }
  return `${head} | ${body}`
}

/** One line per real PILLAR_UP step: the live proof the climb started. */
export function formatPillarUpStep(step: number, fromY: number, toY: number, placed: string): string {
  return `PILLAR_UP_STEP step=${step} from_y=${fromY} to_y=${toY} placed=${placed}`
}
