// #382: one passability rule, and it fails closed.
//
// Mineflayer returns null for an UNLOADED point, so `null` is "unknown", not "empty".
// The sensor was fail-closed while the executor accepted null as passable, which let a
// body step into space the world model had never observed. The executor now delegates
// to this shared rule.
import { isPassable } from './src/state.ts'

const cases: Array<{ name: string; pass: boolean; detail: string }> = []
const addCase = (name: string, run: () => { pass: boolean; detail: string }): void => {
  try {
    cases.push({ name, ...run() })
  } catch (error) {
    cases.push({ name, pass: false, detail: `threw ${String(error).slice(0, 120)}` })
  }
}

addCase('(a) an unloaded/unknown cell (null) is NOT passable', () => {
  return { pass: isPassable(null) === false, detail: `isPassable(null)=${isPassable(null)}` }
})

addCase('(b) an empty-bounding-box block is passable', () => {
  const air = isPassable({ boundingBox: 'empty' })
  return { pass: air === true, detail: `air=${air}` }
})

addCase('(c) a solid block is not passable', () => {
  const stone = isPassable({ boundingBox: 'block' })
  return { pass: stone === false, detail: `stone=${stone}` }
})

addCase('(d) the rule is fail-closed for every non-empty shape', () => {
  const shapes = ['block', 'empty', 'unknown']
  const results = shapes.map((boundingBox) => isPassable({ boundingBox }))
  return {
    pass: results[0] === false && results[1] === true && results[2] === false,
    detail: `block=${results[0]} empty=${results[1]} unknown=${results[2]}`,
  }
})

let failed = 0
for (const testCase of cases) {
  if (!testCase.pass) failed += 1
  console.log(`${testCase.pass ? 'PASS' : 'FAIL'} ${testCase.name} :: ${testCase.detail}`)
}
console.log(`\n${cases.length - failed}/${cases.length} passable-fail-closed cases passed`)
if (failed > 0) process.exit(1)
