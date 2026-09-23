// Regression for #442: a 0/0 locomotion window is idle evidence, never 100%.
import assert from 'node:assert/strict'
import { betaAbandonProgressObserved, JevController } from './src/controller-legacy.ts'
import { MoveFailMemory } from './src/moveFailMemory.ts'
import {
  formatLocomotionObservation,
  isEfficientLocomotionProgress,
  NO_LOCOMOTION_OBSERVATION,
  observeLocomotion,
} from './src/locomotion.ts'

const stationaryPosition = { x: 27.5, y: 61, z: 15.54 }
const stationary = observeLocomotion(Array.from({ length: 40 }, () => stationaryPosition))
assert.equal(stationary.kind, 'idle')
assert.equal(isEfficientLocomotionProgress(stationary, 20), false)
assert.equal(
  betaAbandonProgressObserved('body_or_search_progress', { progress: 'body', progressKinds: ['body'] } as never, stationary),
  false,
  'a stationary window cannot reset beta-abandon deferral as body progress',
)
const stationaryLine = formatLocomotionObservation(stationary)
assert.match(stationaryLine, /idle=true/)
assert.match(stationaryLine, /efficiency=n\/a/)
assert.doesNotMatch(stationaryLine, /100%/)

const straight = observeLocomotion(Array.from({ length: 40 }, (_, index) => ({ x: index * 0.25, y: 64, z: 0 })))
assert.equal(straight.kind, 'moving')
assert.equal(straight.efficiency, 100)
assert.equal(isEfficientLocomotionProgress(straight, 20), true)
assert.equal(
  betaAbandonProgressObserved('body_or_search_progress', { progress: 'body', progressKinds: ['body'] } as never, straight),
  true,
  'verified straight locomotion still counts as body progress for beta deferral',
)

const a = { x: 0, y: 64, z: 0 }
const b = { x: 1, y: 64, z: 0 }
const returningLoop = observeLocomotion([
  ...Array.from({ length: 39 }, (_, index) => (index % 2 === 0 ? a : b)),
  a,
])
assert.equal(returningLoop.kind, 'moving')
assert.equal(returningLoop.efficiency, 0)
assert.equal(isEfficientLocomotionProgress(returningLoop, 20), false)
assert.equal(
  betaAbandonProgressObserved('body_or_search_progress', { progress: 'body', progressKinds: ['body'] } as never, returningLoop),
  false,
  'recurrent movement is distinct from idle and does not count as efficient body progress',
)

const recordMoveSuccess = (JevController.prototype as unknown as {
  recordMoveSuccess: (candidate: unknown) => void
}).recordMoveSuccess
function moveFailureMemoryAfterSuccess(observation: typeof stationary): MoveFailMemory {
  const target = { x: 3, y: 64, z: 7 }
  const memory = new MoveFailMemory({ failureLimit: 1, cooldownMs: 30_000, now: () => 1_000 })
  memory.blacklist('overworld', target, 'no_progress')
  const fakeController = {
    lastLocomotionObservation: observation,
    moveFailMemory: memory,
    resetDescendBudgetAfterWorldChange: (): void => {},
    currentDimension: (): string => 'overworld',
    logger: { info: (..._args: unknown[]): void => {} },
    tickCounter: 0,
    lastMoveTarget: null,
    notifyMoveFailureMemory: (): void => {},
  }
  recordMoveSuccess.call(fakeController, { id: 'MOVE:p3_64_7', kind: 'MOVE', target })
  return memory
}
assert.equal(
  moveFailureMemoryAfterSuccess(stationary).isBlacklisted('overworld', { x: 3, y: 64, z: 7 }),
  true,
  'a stationary window cannot clear move failure memory through the efficiency path',
)
assert.equal(
  moveFailureMemoryAfterSuccess(straight).isBlacklisted('overworld', { x: 3, y: 64, z: 7 }),
  false,
  'an efficient verified reach continues to clear move failure memory',
)
assert.equal(
  moveFailureMemoryAfterSuccess(returningLoop).isBlacklisted('overworld', { x: 3, y: 64, z: 7 }),
  true,
  'a returning movement loop cannot clear move failure memory',
)

const notYetObserved = observeLocomotion(Array.from({ length: 39 }, () => stationaryPosition))
assert.equal(notYetObserved.kind, 'unobserved')
assert.equal(isEfficientLocomotionProgress(notYetObserved, 20), false)
assert.equal(
  betaAbandonProgressObserved('body_or_search_progress', { progress: 'body', progressKinds: ['body'] } as never),
  false,
  'missing locomotion samples are not treated as perfect efficiency',
)
assert.equal(isEfficientLocomotionProgress(NO_LOCOMOTION_OBSERVATION, 20), false)

assert.equal(
  betaAbandonProgressObserved('body_or_search_progress', { progress: 'search', progressKinds: ['search'] } as never, stationary),
  true,
  'verified semantic search progress remains independent of locomotion efficiency',
)

process.stdout.write('locomotion progress (#442): stationary, efficient walk, return loop, and unobserved cases PASS\n')
