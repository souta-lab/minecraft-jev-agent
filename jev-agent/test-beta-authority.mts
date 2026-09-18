// test-beta-authority.mts - #22 correctness: `abandon_option` beta is
// SHADOW-ONLY by default. Pure: no bot, no network, no model.
//
// (a) with `betaAuthority: false` a beta=1 does NOT trigger a replan/abandon;
//     only the BETA_SHADOW record is written.
// (b) with `betaAuthority: true` it may replan, but only when the deterministic
//     prerequisite guard clears it.
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

addCase('#22: beta authority defaults OFF (env empty)', () => {
  const off = resolveBetaAuthority({})
  const on = resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: '1' })
  return { pass: off === false && on === true, detail: `default=${off} env1=${on}` }
})

addCase('(a) betaAuthority=false: beta=1 does NOT adopt; shadow is recorded', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: false,
    abandonRequested: true,
    actionId: 'PLACE:furnace:p29_61_35',
    goal: smeltGoal,
    placedFurnaceCount: 0,
  })
  const shadow = betaShadowDecision({ optionId: 'PLACE:furnace', beta: 1, actualReplan: vote.adopt })
  const line = formatBetaShadow(shadow)
  const expected = 'BETA_SHADOW option=PLACE:furnace beta=1 threshold=0.5 would=abandon actual=continue'
  const heads = formatJevHeads('PLACE:furnace:p29_61_35', 1, vote.adopt)
  const pass =
    vote.adopt === false &&
    vote.shadowed === true &&
    vote.protection.protect === true &&
    line === expected &&
    heads === 'JEV_HEADS action=PLACE:furnace:p29_61_35 abandon=1 -> continue'
  return { pass, detail: `adopt=${vote.adopt} shadowed=${vote.shadowed} | ${line} | ${heads}` }
})

addCase('(a) betaAuthority=false: even an unprotected beta=1 cannot adopt', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: false,
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goal: collectGoal,
    placedFurnaceCount: 0,
  })
  return { pass: vote.adopt === false && vote.shadowed === true, detail: `adopt=${vote.adopt} shadowed=${vote.shadowed}` }
})

addCase('(b) betaAuthority=true: unprotected beta=1 adopts -> replan', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goal: collectGoal,
    placedFurnaceCount: 0,
  })
  const heads = formatJevHeads('MINE:b10_64_0', 1, vote.adopt)
  const pass = vote.adopt === true && vote.shadowed === false && heads === 'JEV_HEADS action=MINE:b10_64_0 abandon=1 -> replan'
  return { pass, detail: `adopt=${vote.adopt} shadowed=${vote.shadowed} | ${heads}` }
})

addCase('(b) betaAuthority=true is still guarded: PLACE:furnace is protected', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'PLACE:furnace:p29_61_35',
    goal: smeltGoal,
    placedFurnaceCount: 0,
  })
  const expected = 'PRECONDITION_PROTECTED option=PLACE:furnace because=prerequisite_of smelt_iron_ingot'
  const pass = vote.adopt === false && vote.protection.protect === true && vote.protection.line === expected
  return { pass, detail: `adopt=${vote.adopt} line="${vote.protection.line}"` }
})

addCase('(b) betaAuthority=true: below-threshold beta never adopts', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: false,
    actionId: 'MINE:b10_64_0',
    goal: collectGoal,
    placedFurnaceCount: 0,
  })
  return { pass: vote.adopt === false && vote.shadowed === false, detail: `adopt=${vote.adopt} shadowed=${vote.shadowed}` }
})

addCase('(b) betaAuthority=true: craft/retrieve furnace prerequisites stay protected', () => {
  const craft = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'CRAFT:furnace',
    goal: smeltGoal,
    placedFurnaceCount: 0,
  })
  const retrieve = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'RETRIEVE:known:station:furnace:b29_61_35',
    goal: smeltGoal,
    placedFurnaceCount: 0,
  })
  const pass = craft.adopt === false && retrieve.adopt === false && craft.protection.protect && retrieve.protection.protect
  return { pass, detail: `craft=${craft.adopt}/${craft.protection.protect} retrieve=${retrieve.adopt}/${retrieve.protection.protect}` }
})

addCase('(b) authority releases once the furnace is placed (abandon allowed)', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'PLACE:furnace:p29_61_35',
    goal: smeltGoal,
    placedFurnaceCount: 1,
  })
  return { pass: vote.adopt === true && vote.protection.protect === false, detail: `adopt=${vote.adopt}` }
})

let failures = 0
process.stdout.write('beta shadow-only default + explicit authority (#22)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}

const defaultVote = betaAuthorityDecision({
  betaAuthority: resolveBetaAuthority({}),
  abandonRequested: true,
  actionId: 'PLACE:furnace:p29_61_35',
  goal: smeltGoal,
  placedFurnaceCount: 0,
})
const defaultShadow = betaShadowDecision({ optionId: 'PLACE:furnace', beta: 1, actualReplan: defaultVote.adopt })
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write('fixture (default resident mode, beta=1, held furnace, no placed furnace):\n')
process.stdout.write(`  ${formatJevHeads('PLACE:furnace:p29_61_35', 1, defaultVote.adopt)}\n`)
process.stdout.write(`  ${formatBetaShadow(defaultShadow)}\n`)
process.stdout.write('  (no ABANDON_REASON line: beta did not cause the abandonment)\n')
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} beta-authority cases passed\n`)
if (failures > 0) process.exit(1)
