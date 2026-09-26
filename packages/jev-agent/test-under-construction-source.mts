// A structure the ACTIVE plan is building is not a resource source.
//
// Live defect this pins (measured, run-mubgihcp-n79g): the agent placed four
// obsidian edges of the M2 frame, and because the frame was no longer lit the
// live-structure guard released those very cells, so `collect obsidian` kept
// offering them back - the agent mined its own construction and re-placed it,
// visible as pacing around a half-built frame with PLACE ... verify_failed.
//
// The rule is the same generic membership fact the sourcing layer already
// refuses (a plain cell set); the portal module contributes only its footprint.
// An unlit/incomplete frame is still ordinary obsidian once the build goal is
// gone, which is the legitimate-deconstruction case the M2 materials path needs.
import { underConstructionMembers } from './src/state.ts'
import { liveStructureMembersForSites } from './src/state.ts'
import { portalFrameLayout } from './src/netherPortalPlan.ts'
import type { PortalFrameSite } from './src/netherPortalPlan.ts'

const ORIGIN = { x: 25, y: 66, z: 9 }
const PLACED = [
  { x: 26, y: 66, z: 9 },
  { x: 27, y: 66, z: 9 },
  { x: 28, y: 67, z: 9 },
  { x: 28, y: 68, z: 9 },
]
/** The live shape: a frame being rebuilt, four of ten edges present, not lit. */
const SITE: PortalFrameSite = {
  origin: ORIGIN,
  widthAxis: 'x',
  safe: true,
  reachable: true,
  existingFrame: PLACED,
}

const cases: Array<{ name: string; pass: boolean; detail: string }> = []
const addCase = (name: string, run: () => { pass: boolean; detail: string }): void => {
  try {
    const result = run()
    cases.push({ name, ...result })
  } catch (error) {
    cases.push({ name, pass: false, detail: `threw ${String(error).slice(0, 120)}` })
  }
}

const footprintSize = portalFrameLayout(ORIGIN, 'x').frame.length +
  portalFrameLayout(ORIGIN, 'x').corners.length +
  portalFrameLayout(ORIGIN, 'x').interior.length

addCase('(a) a build goal protects the whole footprint of the structure being built', () => {
  const members = underConstructionMembers([SITE], { kind: 'place', targetItem: 'obsidian' })
  const keys = new Set(members.map((m) => `${m.position.x},${m.position.y},${m.position.z}`))
  return {
    pass: members.length === footprintSize && keys.size === footprintSize,
    detail: `members=${members.length} unique=${keys.size} expected=${footprintSize}`,
  }
})

addCase('(b) the same unlit frame is an ordinary source when no build goal is active', () => {
  const collect = underConstructionMembers([SITE], { kind: 'collect', targetItem: 'obsidian' })
  const none = underConstructionMembers([SITE], null)
  return {
    pass: collect.length === 0 && none.length === 0,
    detail: `collect=${collect.length} null=${none.length}`,
  }
})

addCase('(c) an incomplete frame contributes nothing to live membership on its own', () => {
  const live = liveStructureMembersForSites([SITE])
  return {
    pass: live.length === 0,
    detail: `liveMembers=${live.length} (incomplete and unlit must not be self-protected)`,
  }
})

addCase('(d) the protected footprint covers the cells the agent already placed', () => {
  const members = underConstructionMembers([SITE], { kind: 'place', targetItem: 'obsidian' })
  const keys = new Set(members.map((m) => `${m.position.x},${m.position.y},${m.position.z}`))
  const covered = PLACED.every((cell) => keys.has(`${cell.x},${cell.y},${cell.z}`))
  return { pass: covered, detail: `coveredPlaced=${covered}` }
})

let failed = 0
for (const testCase of cases) {
  if (!testCase.pass) failed += 1
  console.log(`${testCase.pass ? 'PASS' : 'FAIL'} ${testCase.name} :: ${testCase.detail}`)
}
console.log(`\n${cases.length - failed}/${cases.length} under-construction-source cases passed`)
if (failed > 0) process.exit(1)
