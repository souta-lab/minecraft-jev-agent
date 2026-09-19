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

for (const kind of ['reuse', 'staircase', 'staircase-up', 'pillar'] as const) {
  const vertical = controllerUnreachableMoveReason(
    {
      ...base,
      kind: kind === 'reuse' ? 'RETRIEVE' : 'MOVE',
      meta: { vertical: kind },
    } as Candidate,
    state,
  )
  if (vertical !== null) {
    throw new Error(`${kind} vertical plan must not be charged, got ${JSON.stringify(vertical)}`)
  }
}

const atGapLimit = controllerUnreachableMoveReason(
  { ...base, target: { x: 33, y: 56, z: 27 } } as Candidate,
  state,
)
if (atGapLimit !== null) throw new Error(`dy=4 must remain selectable, got ${JSON.stringify(atGapLimit)}`)

const beyondGapLimit = controllerUnreachableMoveReason(
  { ...base, target: { x: 33, y: 57, z: 27 } } as Candidate,
  state,
)
if (beyondGapLimit === null || beyondGapLimit.dy !== 5) {
  throw new Error(`dy=5 must be charged, got ${JSON.stringify(beyondGapLimit)}`)
}

const unplanned = controllerUnreachableMoveReason({ ...base, meta: { vertical: 'none' } } as Candidate, state)
if (unplanned === null || unplanned.dy !== 16) {
  throw new Error(`an unplanned far move must be charged, got ${JSON.stringify(unplanned)}`)
}

process.stdout.write('PASS  controller vertical-plan reachability parity (4 plans, RETRIEVE, dy boundary)\n')
