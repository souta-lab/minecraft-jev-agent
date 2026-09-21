// #405: the generic exploration fallback must not re-offer a cell the body has
// already occupied. Without a visited identity a reached cell immediately became
// "walk toward unexplored terrain" again, so the walk cycled between the same few
// cells (live: MOVE:p35_67_11 -> p36_67_10 -> p38_67_10 -> ... with ~0 net gain).
//
// The rule lives in one pure helper so the filter cannot drift from the cell
// identity the candidate id uses (`blockId('p', spot)` = `p<x>_<y>_<z>`).
import { exploreNoveltySpots, exploredCellKey } from './src/candidates.ts'

const cases: Array<{ name: string; pass: boolean; detail: string }> = []
const addCase = (name: string, run: () => { pass: boolean; detail: string }): void => {
  try {
    cases.push({ name, ...run() })
  } catch (error) {
    cases.push({ name, pass: false, detail: `threw ${String(error).slice(0, 120)}` })
  }
}

const SPOTS = [
  { x: 35, y: 67, z: 11 },
  { x: 36, y: 67, z: 10 },
  { x: 38, y: 67, z: 10 },
  { x: 30, y: 66, z: 9 },
]

addCase('(a) with no visited set every standable spot stays available', () => {
  const kept = exploreNoveltySpots(SPOTS, undefined)
  const empty = exploreNoveltySpots(SPOTS, new Set<string>())
  return {
    pass: kept.length === SPOTS.length && empty.length === SPOTS.length,
    detail: `undefined=${kept.length} emptySet=${empty.length} expected=${SPOTS.length}`,
  }
})

addCase('(b) a visited cell is dropped and the rest keep their order', () => {
  const kept = exploreNoveltySpots(SPOTS, new Set(['p36_67_10']))
  return {
    pass:
      kept.length === 3 &&
      !kept.some((spot) => spot.x === 36 && spot.z === 10) &&
      kept[0]?.x === 35 &&
      kept[2]?.x === 30,
    detail: `kept=${kept.map((s) => `${s.x},${s.y},${s.z}`).join(' | ') || 'none'}`,
  }
})

addCase('(c) everything visited means no novel frontier, not a re-walk', () => {
  const all = new Set(SPOTS.map((spot) => `p${spot.x}_${spot.y}_${spot.z}`))
  const kept = exploreNoveltySpots(SPOTS, all)
  return { pass: kept.length === 0, detail: `kept=${kept.length} (caller must type the exhaustion)` }
})

addCase('(d) one shared key makes a fractional body cell and its block cell identical', () => {
  // The controller records a fractional body position; the filter reads standable
  // block cells. Flooring in ONE exported helper is what keeps them equal.
  const bodyKey = exploredCellKey({ x: 36.5, y: 67.2, z: 10.5 })
  const spotKey = exploredCellKey({ x: 36, y: 67, z: 10 })
  const kept = exploreNoveltySpots([{ x: 36, y: 67, z: 10 }], new Set([bodyKey]))
  const wrong = exploreNoveltySpots([{ x: 36, y: 67, z: 10 }], new Set(['p37_67_11']))
  return {
    pass: bodyKey === spotKey && bodyKey === 'p36_67_10' && kept.length === 0 && wrong.length === 1,
    detail: `bodyKey=${bodyKey} spotKey=${spotKey} filtered=${kept.length === 0} unrelatedKept=${wrong.length === 1}`,
  }
})

let failed = 0
for (const testCase of cases) {
  if (!testCase.pass) failed += 1
  console.log(`${testCase.pass ? 'PASS' : 'FAIL'} ${testCase.name} :: ${testCase.detail}`)
}
console.log(`\n${cases.length - failed}/${cases.length} explore-novelty cases passed`)
if (failed > 0) process.exit(1)
