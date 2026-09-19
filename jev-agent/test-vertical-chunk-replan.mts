import { strict as assert } from 'node:assert'
import { shouldReplanAfterVerticalChunk, verticalStepTowardTarget } from './src/verticalPlan.ts'

assert.equal(verticalStepTowardTarget({ startY: 65, currentY: 64, targetY: 56 }), true)
assert.equal(verticalStepTowardTarget({ startY: 10, currentY: 11, targetY: 20 }), true)
assert.equal(verticalStepTowardTarget({ startY: 65, currentY: 64, targetY: 80 }), false)
assert.equal(verticalStepTowardTarget({ startY: 65, currentY: 65, targetY: 56 }), false)
assert.equal(verticalStepTowardTarget({ startY: Number.NaN, currentY: 64, targetY: 56 }), false)

assert.equal(
  shouldReplanAfterVerticalChunk({ verticalStep: true, startY: 66, currentY: 65, targetY: 56 }),
  true,
)
assert.equal(
  shouldReplanAfterVerticalChunk({ verticalStep: true, startY: 10, currentY: 11, targetY: 20 }),
  true,
)
assert.equal(
  shouldReplanAfterVerticalChunk({ verticalStep: true, startY: 66, currentY: 65, targetY: 80 }),
  false,
)
assert.equal(
  shouldReplanAfterVerticalChunk({ verticalStep: true, startY: 66, currentY: 65, targetY: 66 }),
  false,
)
assert.equal(
  shouldReplanAfterVerticalChunk({ verticalStep: true, startY: 66, currentY: 66, targetY: 56 }),
  false,
)
assert.equal(
  shouldReplanAfterVerticalChunk({ verticalStep: false, startY: 66, currentY: 65, targetY: 56 }),
  false,
)

console.log('PASS vertical chunk replan direction/boundary')
