// Regression proof that the controller's failure-memory gate agrees with the
// policy reachability gate for generated vertical movement plans.
import { controllerUnreachableMoveReason } from './src/controller.ts'
import type { Candidate } from './src/candidates.ts'
import type { Vec3Json, WorldState } from './src/state.ts'

const position: Vec3Json = { x: 25, y: 52, z: 36 }
const state = { self: { position } } as WorldState

const base = {
  kind: 'MOVE',
  target: { x: 33, y: 68, z: 27 },
  meta: {},
} as Candidate

const plain = controllerUnreachableMoveReason(base, state)
if (plain === null || plain.dy !== 16) {
  throw new Error(`plain far movement must be charged, got ${JSON.stringify(plain)}`)
}

const vertical = controllerUnreachableMoveReason(
  {
    ...base,
    meta: { vertical: 'pillar', pillarToY: 68, pillarSteps: 16, pillarPlaceName: 'cobblestone' },
  } as Candidate,
  state,
)
if (vertical !== null) {
  throw new Error(`vertical plan must not be charged, got ${JSON.stringify(vertical)}`)
}

process.stdout.write('PASS  controller vertical-plan reachability parity\n')
