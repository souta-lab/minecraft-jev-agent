// test-beta-authority.mts - the beta abandon-vote gate (V4.1.2).
//
// The decision policy's vote to end the current Option is policy input: it is
// adopted only when the deterministic prerequisite guard clears it. There is
// no shadow/authority selector: no env switch, no option, no resolver.
import * as jevModule from './src/jev.ts'
import { betaAuthorityDecision, formatJevHeads } from './src/betaAuthority.ts'
import { betaShadowDecision, formatBetaShadow } from './src/jev.ts'
import type { GoalLike } from './src/placementGuard.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const smeltGoal: GoalLike = { kind: 'smelt', targetItem: 'iron_ingot' }
const collectGoal: GoalLike = { kind: 'collect', targetItem: 'diamond' }

addCase('there is no beta authority selector to resolve', () => {
  const exported = Object.keys(jevModule)
  const pass = !exported.includes('resolveBetaAuthority')
  return { pass, detail: `resolveBetaAuthority exported=${exported.includes('resolveBetaAuthority')}` }
})

addCase('an unprotected beta=1 is adopted and the heads line reports the replan', () => {
  const vote = betaAuthorityDecision({
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  const heads = formatJevHeads('MINE:b10_64_0', 1, vote.adopt)
  const telemetry = formatBetaShadow(betaShadowDecision({ optionId: 'collect:diamond', beta: 1, actualReplan: vote.adopt }))
  return {
    pass: vote.adopt === true && heads.endsWith('-> replan') && telemetry.endsWith('actual=abandon'),
    detail: `adopt=${vote.adopt} ${heads} | ${telemetry}`,
  }
})

addCase('a vote below threshold is never adopted', () => {
  const vote = betaAuthorityDecision({
    abandonRequested: false,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  return { pass: vote.adopt === false, detail: `adopt=${vote.adopt}` }
})

addCase('the prerequisite guard protects the unplaced furnace path from beta=1', () => {
  const place = betaAuthorityDecision({
    abandonRequested: true,
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  const craft = betaAuthorityDecision({
    abandonRequested: true,
    actionId: 'CRAFT:furnace',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  const retrieve = betaAuthorityDecision({
    abandonRequested: true,
    actionId: 'RETRIEVE:known:station:furnace:b29_61_35',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  return {
    pass:
      place.adopt === false && craft.adopt === false && retrieve.adopt === false &&
      place.protection.protect && craft.protection.protect && retrieve.protection.protect,
    detail: `place=${place.adopt}/${place.protection.protect} craft=${craft.adopt}/${craft.protection.protect} retrieve=${retrieve.adopt}/${retrieve.protection.protect}`,
  }
})

addCase('prerequisite protection releases once the furnace is placed', () => {
  const vote = betaAuthorityDecision({
    abandonRequested: true,
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [smeltGoal],
    placedFurnaceCount: 1,
  })
  return {
    pass: vote.adopt === true && vote.protection.protect === false,
    detail: `adopt=${vote.adopt} protected=${vote.protection.protect}`,
  }
})

let failures = 0
process.stdout.write('beta abandon-vote gate (no selector)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} beta-authority cases passed\n`)
if (failures > 0) process.exit(1)
