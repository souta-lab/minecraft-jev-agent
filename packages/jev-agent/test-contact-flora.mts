// test-contact-flora.mts - contact-damage flora (sweet_berry_bush, cactus) must
// be refused at the LOCOMOTION-ADMISSION boundary, not only in the semantic
// hazard projection.
//
// Measured hole (portal-p27 live audit, source bff16303): the semantic hazard
// scan (`state.ts HAZARDS`) and the bridge exclusions (`BRIDGE_UNSAFE_BLOCKS`)
// already named both plants, but the three mechanical stance layers did not:
//
//   * stock mineflayer-pathfinder `blocksToAvoid` = {fire, cobweb, web, lava};
//     a passable empty-bbox block reads `safe` to the planner, so a MOVE leg
//     could route the body's feet through a berry bush;
//   * `botStandColumnHazardAt` (packet-mode route legs) only asked
//     `envHazardKindOfBlock` - fire/lava classes, no flora;
//   * the descent probes' `clear()` admits flora, so a `level` step could land
//     the body's feet inside a bush cell it never digs.
//
// For a 1-HP body whose forage target is literally a berry forest, one damage
// tick inside the plant is a death. The refusal is strictly own-cell: standing
// NEXT to a bush is how the body harvests it, so neighbours stay admitted.
// Cells above a dig target are NOT refused either - cutting the support pops
// the plant before transit.
//
// Run: bun ./test-contact-flora.mts
import { createRequire } from 'node:module'
import { ENV_CONTACT_BLOCKS, envContactDamageBlock } from './src/envHazard.ts'
import { botStandColumnHazardAt } from './src/path-probes.ts'
import type { PathProbesHost } from './src/path-probes.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { AgentSignals, Vec3Json, WorldState } from './src/state.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

/** Minecraft truth for the few blocks these fixtures need. */
const BLOCKS: Record<string, { boundingBox: string; diggable: boolean }> = {
  air: { boundingBox: 'empty', diggable: false },
  water: { boundingBox: 'empty', diggable: false },
  sweet_berry_bush: { boundingBox: 'empty', diggable: true },
  cactus: { boundingBox: 'block', diggable: true },
  dirt: { boundingBox: 'block', diggable: true },
  grass_block: { boundingBox: 'block', diggable: true },
  stone: { boundingBox: 'block', diggable: true },
  lava: { boundingBox: 'empty', diggable: false },
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
const nameAt = (grid: Map<string, string>, x: number, y: number, z: number): string =>
  grid.get(key(x, y, z)) ?? 'air'

type Bot = Parameters<typeof buildWorldState>[0]

function gridBot(grid: Map<string, string>, position: Vec3Json): Bot {
  const pos = new Vec3(position.x, position.y, position.z)
  const blockAt = (point: { x: number; y: number; z: number }) => {
    const x = Math.floor(point.x)
    const y = Math.floor(point.y)
    const z = Math.floor(point.z)
    const name = nameAt(grid, x, y, z)
    const shape = BLOCKS[name] ?? BLOCKS.air
    return { name, ...shape, position: new Vec3(x, y, z) }
  }
  return {
    username: 'AI_FLORA',
    entity: { id: 1, position: pos, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 1,
    food: 0,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => [] },
    blockAt,
    canSeeBlock: () => true,
    findBlocks: () => [],
  } as never
}

function signals(): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
  }
}

function perceive(grid: Map<string, string>, position: Vec3Json): WorldState {
  return buildWorldState(gridBot(grid, position), {
    tick: 1,
    goal: makeGoal('food', 1),
    goalQueue: emptyGoalQueueState(),
    focusItem: null,
    recentEvents: [],
    signals: signals(),
  }, defaultSensorOptions)
}

// --- (a) vocabulary + registry liveness -------------------------------------

check(
  '(a1) ENV_CONTACT_BLOCKS names live 1.21.11 block names',
  [...ENV_CONTACT_BLOCKS].every((name) => registry.blocksByName[name] !== undefined),
  `set=${[...ENV_CONTACT_BLOCKS].join(',')} missing=${[...ENV_CONTACT_BLOCKS].filter((name) => registry.blocksByName[name] === undefined).join(',')}`,
)

check(
  '(a2) envContactDamageBlock: flora true, everything else false',
  envContactDamageBlock('sweet_berry_bush') === true &&
    envContactDamageBlock('cactus') === true &&
    envContactDamageBlock('lava') === false &&
    envContactDamageBlock('fire') === false &&
    envContactDamageBlock('oak_log') === false &&
    envContactDamageBlock('air') === false &&
    envContactDamageBlock(null) === false &&
    envContactDamageBlock(undefined) === false,
  'bush/cactus -> true; lava/fire/log/air/null/undefined -> false',
)

// --- (b) stance-column probe ------------------------------------------------

/** Flat floor: dirt at y=69, air above; bushes planted exactly where placed. */
function floorWith(cells: Array<[number, number, number, string]>): Map<string, string> {
  const grid = new Map<string, string>()
  for (let dx = -4; dx <= 4; dx += 1) {
    for (let dz = -4; dz <= 4; dz += 1) grid.set(key(10 + dx, 69, 10 + dz), 'dirt')
  }
  for (const [x, y, z, name] of cells) grid.set(key(x, y, z), name)
  return grid
}

const feet = { x: 10, y: 70, z: 10 }

check(
  '(b1) a berry bush in the stance feet cell is hazardous',
  botStandColumnHazardAt({ bot: gridBot(floorWith([[11, 70, 10, 'sweet_berry_bush']]), feet) } as PathProbesHost, 11, 70, 10) === true,
  'stance feet cell (11,70,10) holds sweet_berry_bush',
)

check(
  '(b2) a cactus in the stance feet cell is hazardous',
  botStandColumnHazardAt({ bot: gridBot(floorWith([[11, 70, 10, 'cactus']]), feet) } as PathProbesHost, 11, 70, 10) === true,
  'stance feet cell (11,70,10) holds cactus',
)

check(
  '(b3) a neighbouring bush does NOT make the stance hazardous (forage adjacency)',
  botStandColumnHazardAt({ bot: gridBot(floorWith([[11, 70, 10, 'sweet_berry_bush']]), feet) } as PathProbesHost, 10, 70, 10) === false,
  'bush one cell east of the stance: admitted - standing next to a bush is how the body harvests it',
)

check(
  '(b4) a bush two cells up does not trigger the own-column check',
  botStandColumnHazardAt(
    { bot: gridBot(floorWith([[10, 69, 11, 'dirt'], [10, 72, 10, 'sweet_berry_bush']]), feet) } as PathProbesHost,
    10, 70, 10,
  ) === false,
  'bush floating at feet+2 (unloaded support is still not an own-column hazard)',
)

// --- (c) descent step: `level` landing cell holds flora ---------------------

/**
 * Body at (10,70,10) on a dirt floor; the east step's landing cell (11,70,10)
 * is a berry bush on undug ground. `clear()` admits the bush (empty bounding
 * box) so the level step would land the body's feet inside contact damage.
 */
const bushLanding = floorWith([[11, 70, 10, 'sweet_berry_bush']])
const bushState = perceive(bushLanding, feet)
const eastLevel = (bushState.descent ?? []).find((option) => option.dir === 'E' && option.mode === 'level')

check(
  '(c1) a level step whose landing feet cell is a berry bush is refused hazard',
  eastLevel !== undefined &&
    eastLevel.safe === false &&
    eastLevel.refusal === 'hazard' &&
    eastLevel.reason.includes('damages on contact'),
  `east level option: ${eastLevel === undefined ? 'absent' : `safe=${eastLevel.safe} refusal=${eastLevel.refusal} reason="${eastLevel.reason}"`}`,
)

check(
  '(c2) the same geometry without flora stays admitted',
  (() => {
    const plain = (perceive(floorWith([]), feet).descent ?? []).find((option) => option.dir === 'E' && option.mode === 'level')
    return plain !== undefined && plain.safe === true
  })(),
  `east level on plain dirt: ${(() => {
    const plain = (perceive(floorWith([]), feet).descent ?? []).find((option) => option.dir === 'E' && option.mode === 'level')
    return plain === undefined ? 'absent' : `safe=${plain.safe} reason="${plain.reason}"`
  })()}`,
)

if (failures > 0) {
  process.stdout.write(`${failures} FAIL\n`)
  process.exit(1)
}
process.stdout.write('ALL PASS\n')
