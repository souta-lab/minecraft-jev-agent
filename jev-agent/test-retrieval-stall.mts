// test-retrieval-stall.mts - issue #45 unit proof for the stall escalation policy:
// bounded-effort drop, next-resource switch, branch-mine fallback, the exact log
// lines the acceptance harness greps, and the configurable progress window.
//
// Run: npx tsx test-retrieval-stall.mts
import {
  formatKnownResourceUnreachable,
  formatRetrieveStalled,
  planRetrievalEscalation,
  resolveRetrievalStallTicks,
  RETRIEVAL_STALL_TICKS_DEFAULT,
} from './src/verticalPlan.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const self = { x: 28, y: 55, z: 35 }
const failedTarget = { x: 36, y: 56, z: 41 }

addCase('a stall switches to the nearest other remembered ore of the same kind', () => {
  const escalation = planRetrievalEscalation({
    failedName: 'iron_ore',
    failedTarget,
    known: [
      { name: 'iron_ore', position: failedTarget },
      { name: 'iron_ore', position: { x: 50, y: 40, z: 20 } },
      { name: 'iron_ore', position: { x: 30, y: 48, z: 20 } },
      { name: 'coal_ore', position: { x: 1, y: 1, z: 1 } },
    ],
    self,
  })
  const pass = escalation.kind === 'switch-resource' && escalation.position.x === 30 && escalation.position.y === 48
  return { pass, detail: JSON.stringify(escalation) }
})

addCase('a stall with no alternative ore branch-mines at the failed target Y', () => {
  const escalation = planRetrievalEscalation({
    failedName: 'iron_ore',
    failedTarget,
    known: [{ name: 'iron_ore', position: failedTarget }],
    self,
  })
  const pass = escalation.kind === 'branch-mine' && escalation.y === 56
  return { pass, detail: JSON.stringify(escalation) }
})

addCase('a different block name is not a valid switch target', () => {
  const escalation = planRetrievalEscalation({
    failedName: 'iron_ore',
    failedTarget,
    known: [{ name: 'coal_ore', position: { x: 1, y: 1, z: 1 } }],
    self,
  })
  const pass = escalation.kind === 'branch-mine'
  return { pass, detail: JSON.stringify(escalation) }
})

addCase('the RETRIEVE_STALLED log line carries target, dist and ticks', () => {
  const line = formatRetrieveStalled(failedTarget, 9, 40)
  const pass = line === 'RETRIEVE_STALLED target=36,56,41 dist=9 ticks=40'
  return { pass, detail: line }
})

addCase('the KNOWN_RESOURCE_UNREACHABLE log line carries item, name and at', () => {
  const line = formatKnownResourceUnreachable('raw_iron', 'iron_ore', failedTarget)
  const pass = line === 'KNOWN_RESOURCE_UNREACHABLE item=raw_iron name=iron_ore at=36,56,41'
  return { pass, detail: line }
})

addCase('the stall window defaults to 40 ticks and honours the override', () => {
  const dflt = resolveRetrievalStallTicks({})
  const custom = resolveRetrievalStallTicks({ BUDDY_RETRIEVAL_STALL_TICKS: '7' })
  const invalid = resolveRetrievalStallTicks({ BUDDY_RETRIEVAL_STALL_TICKS: 'nope' })
  const pass =
    dflt === RETRIEVAL_STALL_TICKS_DEFAULT && dflt === 40 && custom === 7 && invalid === RETRIEVAL_STALL_TICKS_DEFAULT
  return { pass, detail: `default=${dflt} custom=${custom} invalid=${invalid}` }
})

let failures = 0
process.stdout.write('issue #45 - retrieval stall escalation policy\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} retrieval-stall cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
