// Regressions for the wade-bound movement policy (wadePolicy.ts): the stock
// planner's cheap liquid entry is only legal when the destination is a
// bounded wade - water feet over a solid floor with the head in air - so a
// deep-water route degrades to a typed refusal instead of a drowning
// (portal-p19.2: ASCEND:breath fired and the body still bottom-walked to
// death, because every vertical move refuses a liquid node).
//
// Run: bun test ./test-wade-policy.mts
import { filterSubmersionDestinations, isBoundedWadeDestination } from './src/wadePolicy.ts'
import type { WadeProbeBlock } from './src/wadePolicy.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const air: WadeProbeBlock = { name: 'air', liquid: false, physical: false }
const water: WadeProbeBlock = { name: 'water', liquid: true, physical: false }
const lava: WadeProbeBlock = { name: 'lava', liquid: true, physical: false }
const stone: WadeProbeBlock = { name: 'stone', liquid: false, physical: true }
const unnamedFluid: WadeProbeBlock = { liquid: true, physical: false }

// --- isBoundedWadeDestination -------------------------------------------

check(
  'a one-block wade is a legal liquid destination',
  isBoundedWadeDestination(water, air, stone) === true,
  'feet=water head=air below=stone',
)
check(
  'an unnamed liquid over a solid floor still wades (fixtures need no name)',
  isBoundedWadeDestination(unnamedFluid, air, stone) === true,
  'feet=liquid(unnamed) head=air below=stone',
)
check(
  'a submerged head cell is never a wade',
  isBoundedWadeDestination(water, water, stone) === false,
  'feet=water head=water below=stone',
)
check(
  'surface water over deeper water is not a wade - the body sinks through',
  isBoundedWadeDestination(water, air, water) === false,
  'feet=water head=air below=water',
)
check(
  'lava is never wadeable even at proven depth 1',
  isBoundedWadeDestination(lava, air, stone) === false,
  'feet=lava head=air below=stone',
)
check(
  'an unobserved head cell is not a wade (no proof the head stays dry)',
  isBoundedWadeDestination(water, null, stone) === false,
  'feet=water head=unloaded below=stone',
)
check(
  'an unobserved floor under water is not a wade (no proof it bottoms out)',
  isBoundedWadeDestination(water, air, null) === false,
  'feet=water head=air below=unloaded',
)
check(
  'a dry feet cell is not a wade question at all',
  isBoundedWadeDestination(air, water, water) === false,
  'feet=air (callers skip the check before asking)',
)

// --- filterSubmersionDestinations ----------------------------------------

// A flat world: plains floor at y=63, a 1-deep stream at z=10, a 3-deep pond
// at z=20, lava trench at z=30.
const world = new Map<string, WadeProbeBlock>()
function put(x: number, y: number, z: number, block: WadeProbeBlock): void {
  world.set(`${x},${y},${z}`, block)
}
for (const x of [0, 1, 2]) {
  put(x, 63, 0, stone) // floor under the dry approach
  // stream crossing at z=10: water at feet level only, stone bed below,
  // air at the head cell (columns load together, so the head is observed)
  put(x, 63, 10, stone)
  put(x, 64, 10, water)
  put(x, 65, 10, air)
  // pond at z=20: water fills feet AND head, bed at y=61; the surface move
  // (feet y64) has a dry observed head (y65 air) but deeper water below
  put(x, 61, 20, stone)
  put(x, 62, 20, water)
  put(x, 63, 20, water)
  put(x, 64, 20, water)
  put(x, 65, 20, air)
  // lava trench at z=30: lava feet over solid bed
  put(x, 63, 30, stone)
  put(x, 64, 30, lava)
}
const probe = (x: number, y: number, z: number): WadeProbeBlock | null => world.get(`${x},${y},${z}`) ?? null

const moves = [
  { x: 1, y: 64, z: 0 },   // dry grass-level step
  { x: 1, y: 64, z: 10 },  // stream wade
  { x: 1, y: 64, z: 20 },  // pond surface cell - head is water at y65? no:
  { x: 1, y: 62, z: 20 },  // pond bed cell - submerged
  { x: 1, y: 64, z: 30 },  // lava trench
  { x: 1, y: 64, z: 40 },  // fully unobserved
]
const kept = filterSubmersionDestinations(moves, probe)
const keptKeys = kept.map((m) => `${m.x},${m.y},${m.z}`).sort()
check(
  'dry and wade destinations survive; submerged, lava and unknown stay out',
  keptKeys.join('|') === '1,64,0|1,64,10|1,64,40',
  `kept=[${keptKeys.join('|')}] (pond surface y64 has air head but water below; pond bed y62 submerged; lava refused; far cell y64,z40 is dry-unknown -> kept because its feet cell is not liquid)`,
)
check(
  'the pond surface cell is refused (water below -> head submerges on entry)',
  !keptKeys.includes('1,64,20') && !keptKeys.includes('1,62,20') && !keptKeys.includes('1,64,30'),
  `kept=[${keptKeys.join('|')}]`,
)
check(
  'filtering never reorders or duplicates survivors',
  kept.map((m) => `${m.z}`).join(',') === '0,10,40',
  `z order=${kept.map((m) => m.z).join(',')}`,
)

if (failures > 0) {
  process.stdout.write(`${failures} FAILED\n`)
  process.exit(1)
}
