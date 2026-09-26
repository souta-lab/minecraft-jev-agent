// test-orphaned-smelt-prereq.mts - pure regression for the orphaned-smelt
// prerequisite retirement.
//
// Live defect (source 6ee333a): the durable queue head was a protected
// `smelt 1 x iron_ingot` row whose only dependent, `craft 1 x flint_and_steel`,
// was already `done` and had consumed the ingot. The row re-required the ingot,
// could not satisfy its own `precondition:station:furnace`, and blocked the real
// next step (`mine 10 x obsidian`) behind it:
//   CANDIDATE_STARVATION presented=1 productive=0 goal=smelt:iron_ingot:1
//     blockedBy=precondition:station:furnace repeat=36
//
//   bun ./test-orphaned-smelt-prereq.mts
import assert from 'node:assert/strict'
import { orphanedSmeltPrerequisiteReason } from './src/controller.ts'

let failures = 0
const check = (name: string, run: () => boolean, detail: () => string): void => {
  let pass = false
  let info = ''
  try {
    pass = run()
    info = detail()
  } catch (error) {
    info = `threw ${String(error)}`
  }
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${info}\n`)
}

check(
  'the orphaned smelt row is retired with an audit reason',
  () => {
    const reason = orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 1, stillWanted: false })
    return reason !== null && reason.includes('flint_and_steel=1') && reason.includes('iron_ingot')
  },
  () => `reason=${orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 1, stillWanted: false })}`,
)

check(
  'the smelt row is NOT retired while something live still wants an iron ingot',
  () => orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 1, stillWanted: true }) === null,
  () => `reason=${orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 1, stillWanted: true })}`,
)

check(
  'the smelt row is NOT retired before the dependent product is held',
  () => orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 0, stillWanted: false }) === null,
  () => `reason=${orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'iron_ingot', held: 0, stillWanted: false })}`,
)

check(
  'other protected goals keep their #55 protection',
  () =>
    orphanedSmeltPrerequisiteReason({ kind: 'collect', item: 'obsidian', held: 1, stillWanted: false }) === null &&
    orphanedSmeltPrerequisiteReason({ kind: 'smelt', item: 'gold_ingot', held: 1, stillWanted: false }) === null,
  () => 'collect:obsidian and smelt:gold_ingot both return null',
)

assert.equal(typeof orphanedSmeltPrerequisiteReason, 'function')
process.stdout.write(`${'-'.repeat(72)}\n${4 - failures}/4 orphaned-smelt-prereq cases passed\n`)
if (failures > 0) process.exit(1)
