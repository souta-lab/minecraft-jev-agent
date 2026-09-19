// ============================================================================
// INTENTIONALLY RED / NON-ACCEPTANCE.
//
// This fixture is NOT an acceptance gate and MUST NOT be used as green
// evidence. It pins the pre-repair invariant (a clean takeoff has no horizontal
// leak) that the exact-RC live run violated, so it is expected to FAIL until a
// fresh exact-RC run captures the same-attempt telemetry and a minimal actuator
// repair is justified separately. It is deliberately excluded from acceptance
// evidence and is only run explicitly with:
//   npm run pillar-takeoff-evidence-red
// The green, acceptance-relevant fixture is test-pillar-takeoff-instrumentation.mts.
// ============================================================================
// Diagnostic fixture for the exact RC boundary:
// PILLAR_FAIL step=takeoff reason=no_rise with physics ticks and explicit
// impulses, while the launch position is held by server-like corrections.
//
// This is intentionally a red evidence fixture on the current RC. It does not
// change the actuator. It records the missing launch/end facts needed before a
// minimal repair can be justified.
import { jumpWithGroundCorrection } from './src/pillarJump.ts'
import type { JumpBotLike, SolidAt } from './src/pillarJump.ts'

type DiagnosticEntity = JumpBotLike['entity'] & {
  velocity: { x: number; y: number; z: number }
}

const launch = { x: 39.32297162555042, y: 11.353123796061132, z: 32.30812804413992 }
const entity: DiagnosticEntity = {
  position: { ...launch },
  velocity: { x: 0.18, y: 0, z: -0.14 },
  onGround: false,
}

const controls = { forward: true, back: false, left: false, right: false, jump: false }
const serverPositions: Array<{ x: number; y: number; z: number }> = []
const listeners = new Set<() => void>()
let clock = 0

const bot: JumpBotLike = {
  entity,
  physicsEnabled: false,
  setControlState(control, state) {
    if (control === 'jump') controls.jump = state
  },
  clearControlStates() {
    controls.forward = false
    controls.back = false
    controls.left = false
    controls.right = false
  },
  on(_event, listener) {
    listeners.add(listener)
  },
  removeListener(_event, listener) {
    listeners.delete(listener)
  },
}

const isSolid: SolidAt = (x, y, z) => x === 39 && y === 10 && z === 32

const outcome = await jumpWithGroundCorrection(bot, {
  isSolid,
  budgetMs: 600,
  pollMs: 15,
  sleep: async (ms) => {
    clock += ms
    // Simulate the observed server-held position: physics ticks occur, but the
    // body is corrected back to launchY before the next client sample.
    serverPositions.push({ ...entity.position })
    entity.position.y = launch.y
    entity.velocity.y = -0.1552320045166016
    entity.onGround = false
    for (const listener of listeners) listener()
  },
  now: () => clock,
})

const end = {
  x: entity.position.x,
  y: entity.position.y,
  z: entity.position.z,
  vx: entity.velocity.x,
  vy: entity.velocity.y,
  vz: entity.velocity.z,
}
const report = {
  launchVelocity: { x: 0.18, y: 0, z: -0.14 },
  endVelocity: { x: end.vx, y: end.vy, z: end.vz },
  forwardAfterClear: controls.forward,
  forcedRepositions: serverPositions.length,
  outcome,
  launchPosition: launch,
  endPosition: { x: end.x, y: end.y, z: end.z },
}
process.stdout.write(`${JSON.stringify(report)}\n`)

const horizontalLeak = Math.hypot(end.vx, end.vz) > 0
const pass =
  outcome.failure === 'no_rise' &&
  outcome.ticks > 0 &&
  outcome.impulses > 0 &&
  outcome.peakRise === 0 &&
  controls.forward === false &&
  !horizontalLeak

if (!pass) {
  process.stderr.write(`FAIL takeoff horizontal-velocity invariant: ${JSON.stringify({ horizontalLeak, report })}\n`)
  process.exit(1)
}
process.stdout.write('PASS takeoff horizontal-velocity invariant\n')
