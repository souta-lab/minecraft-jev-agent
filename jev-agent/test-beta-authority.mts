// test-beta-authority.mts - #11/#22 beta authority contract.
//
// Public resident semantics:
//   - beta authority is ON by default;
//   - explicit shadow/off is the rollback/A-B baseline;
//   - the historical betaAuthorityDecision helper is still tested as a legacy
//     baseline primitive, but its prerequisite-protection veto is NOT the public
//     real-Jev controller contract (controller.ts owns that strangler boundary).
import { betaAuthorityDecision, formatJevHeads } from './src/betaAuthority.ts'
import { betaShadowDecision, formatBetaShadow, resolveBetaAuthority } from './src/jev.ts'
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

addCase('#11: public beta authority defaults ON; shadow is explicit', () => {
  const defaults = resolveBetaAuthority({})
  const authority = resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: 'authority' })
  const shadow = resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: 'shadow' })
  const off = resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: '0' })
  let invalid = false
  try {
    resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: 'auto' })
  } catch {
    invalid = true
  }
  return {
    pass: defaults && authority && !shadow && !off && invalid,
    detail: `default=${defaults} authority=${authority} shadow=${shadow} off=${off} invalidThrows=${invalid}`,
  }
})

addCase('explicit shadow baseline: beta=1 does NOT adopt', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: false,
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  const shadow = betaShadowDecision({ optionId: 'collect:diamond', beta: 1, actualReplan: vote.adopt })
  const line = formatBetaShadow(shadow)
  return {
    pass: vote.adopt === false && vote.shadowed === true && line.endsWith('actual=continue'),
    detail: `adopt=${vote.adopt} shadowed=${vote.shadowed} ${line}`,
  }
})

addCase('legacy primitive baseline: authority=true permits an unprotected beta=1', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  const heads = formatJevHeads('MINE:b10_64_0', 1, vote.adopt)
  return {
    pass: vote.adopt === true && vote.shadowed === false && heads.endsWith('-> replan'),
    detail: `adopt=${vote.adopt} shadowed=${vote.shadowed} ${heads}`,
  }
})

addCase('legacy primitive baseline retains prerequisite protection for A/B only', () => {
  const place = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  const craft = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'CRAFT:furnace',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  const retrieve = betaAuthorityDecision({
    betaAuthority: true,
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

addCase('legacy primitive baseline releases prerequisite protection after placement', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: true,
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
process.stdout.write('#11 beta authority default + explicit shadow baseline\n')
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
