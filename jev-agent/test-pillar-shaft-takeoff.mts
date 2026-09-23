// test-pillar-shaft-takeoff.mts - "start a vertical climb from a cramped shaft
// toward a target above".
//
// LIVE WITNESS (run-mubj6ucc-si3e, source 1889acc, run.jsonl 18:27-18:29Z):
//   PILLAR_FAIL step=apex reason=no_rise y=53.42 rise=0.42 samples=47
//     traceTicks=1 horizontalLeak=true endOnGround=true endCollidedHorizontally=true
//     forcedRepositions=11   (x10, plus refused=76 / apex_missed=26)
//   PILLAR_TAKEOFF launchVel=...,-0.078,...
// The body launched (one tick, rise 0.42), the persistent PILLAR_UP ground
// correction re-grounded it at 53.84, and the apex window observed ZERO further
// physics ticks: the arc never integrated, so `no_rise` was reported as if the
// column could not be climbed. `damage_taken` x360 / health 1 / food 0.
//
// This fixture proves, offline:
//   (1) the climb correction is suppressed for the whole flight, so it never
//       re-grounds a body that is above its support (the takeoff window still
//       grounds the launch through its own correction);
//   (2) an idle physics loop during the apex is the typed `physics_stalled`
//       obstruction, not `no_rise` (the live symptom);
//   (3) a clientbound position reset storm during the apex is the typed
//       `flight_reset` obstruction, not `no_rise` (a transient server fact must
//       not condemn the column);
//   (4) a healthy simulated loop still completes the pillar step: takeoff, apex,
//       place, landing.
//
// Run: bun test ./test-pillar-shaft-takeoff.mts
import { installClimbGroundCorrection } from './src/pillarJump.ts'
import type { SolidAt } from './src/pillarJump.ts'
import { pillarStepUp } from './src/pillarApex.ts'
import type { PillarStepPlan } from './src/pillarApex.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const FEET_X = 23
const FEET_Z = 9
const SUPPORT_Y = 52
const SUPPORT_TOP = SUPPORT_Y + 1 // 53
/** A full solid support at (FEET_X, 52, FEET_Z); the shaft above is air. */
const isSolid: SolidAt = (x, y, z) => x === FEET_X && z === FEET_Z && y === SUPPORT_Y

type Behavior = 'arc' | 'reset' | 'stall'

/**
 * A scripted prismarine-physics stand-in. It reproduces the jump gate
 * (`jump` only applies while `onGround`), gravity integration, the floor clamp,
 * and the clientbound `forcedMove` reset. After `scriptedTicks` the loop either
 * keeps running (`arc`), is idle (`stall`), or only emits server resets
 * (`reset`).
 */
function makeScriptedBot(behavior: Behavior, scriptedTicks = 1) {
  let ticks = 0
  let floorTop = SUPPORT_TOP
  let placed = false
  const listeners = new Map<string, Set<() => void>>()
  const emit = (event: string): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener()
  }
  const entity = {
    position: { x: FEET_X + 0.5, y: SUPPORT_TOP, z: FEET_Z + 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: false,
  }
  const bot = {
    entity,
    physicsEnabled: true,
    controlJump: false,
    setControlState(control: string, state: boolean): void {
      if (control === 'jump') bot.controlJump = state
    },
    clearControlStates(): void {
      bot.controlJump = false
    },
    on(event: string, listener: () => void): void {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event: string, listener: () => void): void {
      listeners.get(event)?.delete(listener)
    },
    markPlaced(): void {
      placed = true
      floorTop = floorTop + 1
    },
    tick(): void {
      ticks += 1
      if (behavior === 'stall' && ticks > scriptedTicks) return
      if (behavior === 'reset' && ticks > scriptedTicks) {
        entity.onGround = false
        entity.velocity.y = 0
        emit('forcedMove')
        return
      }
      // The physics engine recomputes onGround from the actual support.
      entity.onGround = entity.position.y <= floorTop + 1e-9 && entity.velocity.y <= 0
      if (bot.controlJump && entity.onGround) {
        entity.velocity.y = 0.42
        entity.onGround = false
      } else if (!entity.onGround) {
        entity.velocity.y -= 0.08
      } else {
        entity.velocity.y = 0
      }
      if (!entity.onGround) entity.position.y += entity.velocity.y
      if (entity.position.y <= floorTop && entity.velocity.y <= 0) {
        entity.position.y = floorTop
        entity.velocity.y = 0
        entity.onGround = true
      }
      emit('physicsTick')
    },
  }
  return bot
}

function depsFor(bot: ReturnType<typeof makeScriptedBot>) {
  let clock = 0
  return {
    isSolid,
    budgetMs: 600,
    pollMs: 15,
    apexBudgetMs: 600,
    placeSettleMs: 100,
    landingBudgetMs: 600,
    // Pure in-memory clock: the placement is written in the caller's own tick, so
    // the clearance sample IS the position this fixture's world model validates.
    placeHandshakeTicks: 0,
    sleep: async (ms: number): Promise<void> => {
      clock += ms
      bot.tick()
    },
    now: () => clock,
    place: async (): Promise<void> => {
      bot.markPlaced()
    },
    blockPlaced: (): boolean => {
      // the placed block occupies the plan's place cell; the bot flag is the oracle
      return true
    },
    ensureOwned: (): void => undefined,
  }
}

const plan: PillarStepPlan = {
  feetCell: { x: FEET_X, y: SUPPORT_TOP, z: FEET_Z },
  placeCell: { x: FEET_X, y: SUPPORT_TOP, z: FEET_Z },
  support: { x: FEET_X, y: SUPPORT_Y, z: FEET_Z },
}

/** Read through a function so TypeScript cannot narrow the mutable entity flag. */
function onGroundOf(bot: ReturnType<typeof makeScriptedBot>): boolean {
  return bot.entity.onGround
}

// ---------------------------------------------------------------------------
// (1) the climb correction never re-grounds a body that is above its support
// ---------------------------------------------------------------------------
{
  const bot = makeScriptedBot('arc')
  let jumping = true
  bot.entity.position.y = SUPPORT_TOP + 0.42
  bot.entity.onGround = false
  const uninstall = installClimbGroundCorrection(bot, isSolid, () => jumping)
  bot.entity.onGround = false
  bot.tick() // emits physicsTick -> correction runs while jumping
  const duringFlight: boolean = onGroundOf(bot)
  jumping = false
  bot.entity.position.y = SUPPORT_TOP
  bot.entity.onGround = false
  bot.tick()
  const settled: boolean = onGroundOf(bot)
  uninstall()
  check(
    '(1) the climb correction is suppressed in flight and grounds a settled body',
    duringFlight === false && settled === true,
    `duringFlight(onGround)=${duringFlight} settled(onGround)=${settled}`,
  )
}

// ---------------------------------------------------------------------------
// (2) an idle physics loop during the apex is typed `physics_stalled`
// ---------------------------------------------------------------------------
{
  const bot = makeScriptedBot('stall', 1)
  const outcome = await pillarStepUp(bot, depsFor(bot), plan)
  const reason = outcome.ok ? null : outcome.fail.reason
  check(
    '(2) an idle physics loop during the apex is the typed physics_stalled obstruction, not no_rise',
    !outcome.ok && outcome.fail.step === 'apex' && reason === 'physics_stalled',
    `ok=${outcome.ok} step=${outcome.ok ? '-' : outcome.fail.step} reason=${reason ?? '-'} detail=${outcome.ok ? '-' : outcome.fail.detail ?? '-'}`,
  )
}

// ---------------------------------------------------------------------------
// (3) a server position-reset storm during the apex is typed `flight_reset`
// ---------------------------------------------------------------------------
{
  const bot = makeScriptedBot('reset', 1)
  const outcome = await pillarStepUp(bot, depsFor(bot), plan)
  const reason = outcome.ok ? null : outcome.fail.reason
  check(
    '(3) a server position-reset storm during the apex is the typed flight_reset obstruction, not no_rise',
    !outcome.ok && outcome.fail.step === 'apex' && reason === 'flight_reset',
    `ok=${outcome.ok} step=${outcome.ok ? '-' : outcome.fail.step} reason=${reason ?? '-'} detail=${outcome.ok ? '-' : outcome.fail.detail ?? '-'}`,
  )
}

// ---------------------------------------------------------------------------
// (4) a healthy simulated loop still completes the step
// ---------------------------------------------------------------------------
{
  const bot = makeScriptedBot('arc')
  let jumping = true
  const uninstall = installClimbGroundCorrection(bot, isSolid, () => jumping)
  const outcome = await pillarStepUp(bot, depsFor(bot), plan)
  jumping = false
  uninstall()
  check(
    '(4) a healthy shaft loop still completes the pillar step (takeoff, apex, place, landing)',
    outcome.ok && Math.abs(bot.entity.position.y - (SUPPORT_TOP + 1)) <= 0.2 && bot.entity.position.y > SUPPORT_TOP,
    `ok=${outcome.ok} y=${bot.entity.position.y} ${outcome.ok ? `apexRise=${outcome.apexRise}` : `reason=${outcome.fail.reason}`}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
