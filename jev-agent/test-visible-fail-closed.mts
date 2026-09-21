// #376: an observation failure is not evidence of visibility.
//
// `blockVisible` used to return true when `bot.canSeeBlock` threw, which manufactured
// line of sight - and therefore MINE/MOVE affordances - for blocks the sensor never
// actually saw. It now fails closed, like every other observation boundary.
import { blockVisible } from './src/state.ts'

const cases: Array<{ name: string; pass: boolean; detail: string }> = []
const addCase = (name: string, run: () => { pass: boolean; detail: string }): void => {
  try {
    cases.push({ name, ...run() })
  } catch (error) {
    cases.push({ name, pass: false, detail: `threw ${String(error).slice(0, 120)}` })
  }
}

const CELL = { position: { x: 3, y: 40, z: 7 } }
const throwing = { canSeeBlock: () => { throw new Error('no loaded chunk') } } as never
const seeing = { canSeeBlock: () => true } as never
const blind = { canSeeBlock: () => false } as never
let calls = 0
const counting = { canSeeBlock: () => { calls += 1; return true } } as never

addCase('(a) a throwing canSeeBlock is NOT visible (fail closed)', () => {
  const visible = blockVisible(throwing, CELL, true)
  return { pass: visible === false, detail: `visible=${visible} expected=false` }
})

addCase('(b) real answers pass through unchanged', () => {
  const yes = blockVisible(seeing, CELL, true)
  const no = blockVisible(blind, CELL, true)
  return { pass: yes === true && no === false, detail: `yes=${yes} no=${no}` }
})

addCase('(c) out of reach is false without asking the world', () => {
  calls = 0
  const visible = blockVisible(counting, CELL, false)
  return { pass: visible === false && calls === 0, detail: `visible=${visible} calls=${calls}` }
})

let failed = 0
for (const testCase of cases) {
  if (!testCase.pass) failed += 1
  console.log(`${testCase.pass ? 'PASS' : 'FAIL'} ${testCase.name} :: ${testCase.detail}`)
}
console.log(`\n${cases.length - failed}/${cases.length} visible-fail-closed cases passed`)
if (failed > 0) process.exit(1)
