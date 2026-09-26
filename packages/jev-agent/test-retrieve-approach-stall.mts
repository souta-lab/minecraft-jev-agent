// test-retrieve-approach-stall.mts - EXECUTOR retrieve-to-station-stall regression.
//
// Live M2 defect (run-mu8rgrpd-ydkf at main 4164a9c): a grounded, guard-accepted
// RETRIEVE toward a remembered station was not rejected up front. The executor
// logged stock `GoalNear -> stuck`, then `no jump headroom`, then `packet
// locomotion blocked`; it never reached the target, so the station never became
// usable and the M2 chain could not advance. `runRetrieve` swallowed the typed
// `pathToNear` error and still returned a soft `done`, so no typed failure
// reached the controller's move-failure memory / retirement machinery - the
// exact blocked route could be re-selected indefinitely.
//
// `classifyRetrieveApproach` is the RETRIEVE analogue of `classifyMoveArrival`:
// the same stall signals now classify as `stalled`, and `runRetrieve` throws the
// original typed ExecutorError instead of reporting a soft done.
//
// Run: bun test ./test-retrieve-approach-stall.mts
//      bun --test test-retrieve-approach-stall.mts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyRetrieveApproach, ExecutorError, isAtRequiredLevel, RETRIEVE_ARRIVAL_RADIUS, shouldAbortUnproductivePillar } from './src/executor.ts'
import type { RetrieveApproachInput } from './src/executor.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/**
 * The pre-fix `runRetrieve` success formula, reproduced verbatim: a >0.01 m
 * distance decrease (`closed`), a lower vertical gap, or any vertical leg step
 * was enough to report the retrieve as a verified `done`. It is kept here so the
 * regression documents exactly which decision was wrong.
 */
function legacyRetrieveVerified(input: RetrieveApproachInput): boolean {
  const closed = input.distanceAfter < input.distanceBefore - 0.01
  const verticalProgress =
    Math.abs(input.endY - input.targetY) < Math.abs(input.startY - input.targetY) - 0.01
  return closed || verticalProgress || input.verticalStep
}

/** The live stall body shape: same level as the target, no vertical plan step. */
function blockedStall(distanceAfter: number): RetrieveApproachInput {
  return {
    distanceBefore: 9,
    distanceAfter,
    startY: 64,
    endY: 64,
    targetY: 64,
    verticalStep: false,
    approachFailed: true,
  }
}

addCase('a blocked GoalNear stall with a sub-metre creep is NOT a verified retrieve', () => {
  const input = blockedStall(8.9)
  const legacy = legacyRetrieveVerified(input)
  const fixed = classifyRetrieveApproach(input)
  const pass = legacy === true && fixed.outcome === 'stalled' && fixed.verified === false
  return {
    pass,
    detail: `legacyVerified=${legacy} outcome=${fixed.outcome} verified=${fixed.verified} before=${input.distanceBefore} after=${input.distanceAfter}`,
  }
})

addCase('a blocked GoalNear stall that closes no distance is stalled, never a soft done', () => {
  const input = blockedStall(9)
  const legacy = legacyRetrieveVerified(input)
  const fixed = classifyRetrieveApproach(input)
  const pass = legacy === false && fixed.outcome === 'stalled' && fixed.arrived === false && fixed.closed === false
  return {
    pass,
    detail: `legacyVerified=${legacy} (soft done) outcome=${fixed.outcome} arrived=${fixed.arrived} closed=${fixed.closed}`,
  }
})

addCase('a reachable target arrives and is a verified success (happy path)', () => {
  const input: RetrieveApproachInput = {
    distanceBefore: 12,
    distanceAfter: RETRIEVE_ARRIVAL_RADIUS,
    startY: 59,
    endY: 60,
    targetY: 61,
    verticalStep: false,
    approachFailed: false,
  }
  const fixed = classifyRetrieveApproach(input)
  const pass = fixed.outcome === 'arrived' && fixed.arrived && fixed.verified
  return { pass, detail: `outcome=${fixed.outcome} arrived=${fixed.arrived} verified=${fixed.verified}` }
})

addCase('a bounded vertical chunk that has not arrived is progress, not a failure', () => {
  const input: RetrieveApproachInput = {
    distanceBefore: 56,
    distanceAfter: 55,
    startY: 7,
    endY: 12,
    targetY: 63,
    verticalStep: true,
    approachFailed: false,
  }
  const fixed = classifyRetrieveApproach(input)
  const pass = fixed.outcome === 'progressed' && fixed.verticalProgress && fixed.verified === true
  return { pass, detail: `outcome=${fixed.outcome} verticalProgress=${fixed.verticalProgress} verified=${fixed.verified}` }
})

addCase('a horizontal close without arrival is progress but not a verified success', () => {
  const input: RetrieveApproachInput = {
    distanceBefore: 6,
    distanceAfter: 4,
    startY: 64,
    endY: 64,
    targetY: 64,
    verticalStep: false,
    approachFailed: false,
  }
  const fixed = classifyRetrieveApproach(input)
  const pass = fixed.outcome === 'progressed' && fixed.closed && fixed.verified === false
  return { pass, detail: `outcome=${fixed.outcome} closed=${fixed.closed} verified=${fixed.verified}` }
})

addCase('runRetrieve routes the approach through the classifier and throws a typed failure on stall', () => {
  const source = readFileSync(fileURLToPath(new URL('./src/executor.ts', import.meta.url)), 'utf8')
  const usesClassifier = source.includes('classifyRetrieveApproach({')
  const preservesApproachFailure = source.includes('if (approachError !== null && !approach.arrived)')
  const throwsStall =
    source.includes("if (approach.outcome === 'stalled')") && source.includes('throw failure')
  const stillSwallows = source.includes('RETRIEVE horizontal approach failed after the vertical leg')
  const pass = usesClassifier && preservesApproachFailure && throwsStall && !stillSwallows
  return {
    pass,
    detail: `usesClassifier=${usesClassifier} preservesApproachFailure=${preservesApproachFailure} throwsStall=${throwsStall} oldSwallowGone=${!stillSwallows}`,
  }
})

addCase('a path failure after a partial vertical leg is still a typed failure until arrival', () => {
  const input: RetrieveApproachInput = {
    distanceBefore: 21,
    distanceAfter: 21.4,
    startY: 71,
    endY: 70,
    targetY: 68,
    verticalStep: true,
    approachFailed: true,
  }
  const fixed = classifyRetrieveApproach(input)
  const pass = fixed.outcome === 'progressed' && fixed.arrived === false && fixed.verified === true
  return {
    pass,
    detail: `classifier=${fixed.outcome} arrived=${fixed.arrived} verified=${fixed.verified}; runRetrieve must throw approachFailed before accepting this partial classifier result`,
  }
})

addCase('the typed stall carries the original path_stuck code, not a generic error', () => {
  const failure = new ExecutorError('path_stuck', 'packet locomotion blocked before (x,y,z)')
  const pass = failure.code === 'path_stuck' && failure.name === 'ExecutorError'
  return { pass, detail: `code=${failure.code} name=${failure.name}` }
})

addCase('a vertical waypoint one block above the body is not a completed step', () => {
  const target = { x: -1, y: 61, z: 24 }
  const stalled = { x: -0.66, y: 62, z: 23.5 }
  const reached = { x: -0.5, y: 61, z: 24 }
  const pass = !isAtRequiredLevel(stalled, target) && isAtRequiredLevel(reached, target)
  return { pass, detail: `stalled=${isAtRequiredLevel(stalled, target)} reached=${isAtRequiredLevel(reached, target)}` }
})

addCase('a same-floor adjacent cell is not a completed required-level step', () => {
  const target = { x: 55, y: 61, z: 26 }
  const adjacent = { x: 54.5, y: 61, z: 26.4 }
  const occupied = { x: 55.3, y: 61, z: 26.4 }
  const pass = !isAtRequiredLevel(adjacent, target) && isAtRequiredLevel(occupied, target)
  return {
    pass,
    detail: `adjacent=${isAtRequiredLevel(adjacent, target)} occupied=${isAtRequiredLevel(occupied, target)}`,
  }
})

addCase('a grounded entity on the target floor is a completed vertical step', () => {
  const target = { x: 29, y: 62, z: 6 }
  const grounded = { x: 29.58, y: 62.92, z: 6.5 }
  const oneFloorAbove = { x: 29.58, y: 63.92, z: 6.5 }
  const pass = isAtRequiredLevel(grounded, target) && !isAtRequiredLevel(oneFloorAbove, target)
  return { pass, detail: `grounded=${isAtRequiredLevel(grounded, target)} oneFloorAbove=${isAtRequiredLevel(oneFloorAbove, target)}` }
})

addCase('an unproductive pillar leg fails immediately instead of replaying the same jump', () => {
  const pass = shouldAbortUnproductivePillar({
    vertical: 'pillar',
    verticalStep: false,
    startY: 64,
    currentY: 64.74,
    targetY: 72,
  })
  return { pass, detail: `abort=${pass} startY=64 currentY=64.74 targetY=72` }
})

addCase('a pillar leg with durable height remains a valid bounded continuation', () => {
  const pass = !shouldAbortUnproductivePillar({
    vertical: 'pillar',
    verticalStep: true,
    startY: 64,
    currentY: 65,
    targetY: 72,
  })
  return { pass, detail: `abort=${!pass} startY=64 currentY=65 targetY=72` }
})

addCase('vertical executor steps require level-verified path completion', () => {
  const source = readFileSync(fileURLToPath(new URL('./src/executor.ts', import.meta.url)), 'utf8')
  const staircaseRequiresLevel = source.includes('await this.pathTo(step, epoch, signal, goalKind, { requireLevel: true })')
  const reuseRequiresLevel = source.includes('await this.pathToNear(tunnel, 1, epoch, signal, { requireLevel: true })')
  const pass = staircaseRequiresLevel && reuseRequiresLevel
  return { pass, detail: `staircase=${staircaseRequiresLevel} reuse=${reuseRequiresLevel}` }
})

let failures = 0
process.stdout.write('EXECUTOR retrieve-approach stall (progress loud or fail loud)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} retrieve-approach cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
