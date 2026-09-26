// test-column-dig.mts - "obtain a resource whose supporting column is reachable".
//
// LIVE SHAPE this pins (run-mublvgjx-yldu, source cc658cb; world save proves the
// geometry): an empty-inventory body at feet (2.5,67.0,18.5) faces a floating
// oak_log at (2,72,17) - the column below it, (2,67..71,17), is OPEN air and the
// floor (2,66,17) is grass, so (2,67,17) is a standable landing one block north
// of the body. Mining the log drops it straight down into the body's pickup
// volume and the trunk can be worked upward. The generator only offered a
// withheld `ACCESS:b2_72_17` (`needs_ascend`, missing `placeable_block`) plus
// WAIT, so `MINE 0` held for six minutes and `LOCAL_CAPABILITY_GAP attempts`
// passed 131 with no typed escalation.
//
// The rule is general - "the resource cell's own column has a reachable base
// whose drop falls to a floor the body can occupy" - and reads only the column
// at the target's own (x,z), the block kind and the sensor's standable cells. No
// tree/pillar/wall special case.
//
// Run: bun run column-dig-test
import { readFileSync } from 'node:fs'
import { altitudeRouteOnOffer, defaultCandidateOptions, formatLogRoute, formatSurfaceAscentRefused, generateGroundedCandidates, logRouteOf } from './src/candidates.ts'
import type { CandidateOptions } from './src/candidates.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_COLUMN',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
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
    ...overrides,
  }
}

function logBlock(position: Vec3Json, overrides: Partial<BlockState> = {}): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position,
    distance: Math.hypot(position.x - LIVE_FEET.x, position.y - LIVE_FEET.y, position.z - LIVE_FEET.z),
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
    visible: true,
    ...overrides,
  }
}

/**
 * The `surface` goal the live ladder emitted: `recover vertical access to
 * y>=80 and collect 1 x log`. The target Y is the highest remembered log + 1.
 */
function surfaceGoal(targetY = 80): GoalState {
  return {
    id: 'g49:surface:log',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

interface WorldInput {
  position: Vec3Json
  blocks: BlockState[]
  standable: Vec3Json[]
  inventory?: InventoryState
  knownResources?: KnownResource[]
  targetY?: number
}

function worldState(input: WorldInput): WorldState {
  const goal = surfaceGoal(input.targetY ?? 80)
  return {
    schemaVersion: 1,
    tick: 41,
    timestampMs: 1_700_000_000_000,
    self: self(input.position),
    inventory: input.inventory ?? inventory({ leaf_litter: 4 }),
    entities: [],
    blocks: input.blocks,
    terrain: { standable: input.standable },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal,
    goalQueue: {
      depth: 1,
      empty: false,
      hasImpossible: false,
      done: 0,
      current: {
        id: goal.id,
        kind: 'surface',
        description: goal.description,
        targetItem: 'log',
        requiredCount: 1,
        startCount: 0,
        haveCount: 0,
        status: 'active',
        origin: 'llm',
        createdAt: 0,
        updatedAt: 0,
        detail: null,
        targetY: input.targetY ?? 80,
      },
      goals: [],
    },
    recentEvents: [],
    signals: signals({ knownResources: input.knownResources ?? [] }),
  }
}

/** The live controller wires `digApproach`/`pathProbe`; this fixture has no stand. */
function options(): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    reachability: { pathProbe: () => 'unknown', digApproach: () => ({ approach: null, path: null }) },
  }
}

const LIVE_FEET: Vec3Json = { x: 2.5, y: 67, z: 18.5 }
const LIVE_LANDING: Vec3Json = { x: 2, y: 67, z: 17 }
const LIVE_STANDABLE: Vec3Json[] = [LIVE_FEET, LIVE_LANDING, { x: 4, y: 66, z: 17 }]

/** Real save geometry z=17: floating trunk logs at y=69,70,72 over open air. */
function liveLogs(): BlockState[] {
  return [
    logBlock({ x: 2, y: 72, z: 17 }, { inReach: true, distance: 3.42 }),
    logBlock({ x: 4, y: 72, z: 17 }, { inReach: true, distance: 3.42 }),
    logBlock({ x: 4, y: 72, z: 16 }, { inReach: true, distance: 3.6 }),
    logBlock({ x: 4, y: 70, z: 17 }, { inReach: true, distance: 2.35 }),
    logBlock({ x: 4, y: 69, z: 17 }, { inReach: true, distance: 2.27 }),
  ]
}

function liveWorld(overrides: Partial<WorldInput> = {}): WorldState {
  return worldState({
    position: LIVE_FEET,
    blocks: liveLogs(),
    standable: LIVE_STANDABLE,
    ...overrides,
  })
}

function columnDigs(candidates: readonly { id: string; meta: Record<string, unknown> }[]): string[] {
  return candidates.filter((candidate) => candidate.meta.columnDig === true).map((candidate) => candidate.id)
}

// (a) the live empty-inventory body gets a grounded column-dig route ------------
{
  const state = liveWorld()
  const grounded = generateGroundedCandidates(state, options())
  const digs = columnDigs(grounded.candidates)
  const base = grounded.candidates.find((candidate) => candidate.id === 'MINE:b2_72_17')
  const route = logRouteOf(grounded.candidates)
  await check(
    '(a) a floating log over a reachable column base yields a grounded COLUMN_DIG MINE',
    digs.includes('MINE:b2_72_17') &&
      base !== undefined &&
      base.kind === 'MINE' &&
      base.affordance?.feasible === true &&
      base.meta.columnTopY === 72,
    `digs=[${digs.join(',')}] presented=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  )
  await check(
    '(a) the column route is mirrored as a body-moving log route (never a barren WAIT)',
    route !== null && route.mode === 'mine_sensed' && route.target.y === 72 && route.candidateId === 'MINE:b2_72_17',
    `route=${route === null ? 'none' : formatLogRoute(route)}`,
  )
  await check(
    '(a) a multi-cell column contributes exactly ONE MINE, at its LOWEST reachable cell',
    digs.filter((id) => id === 'MINE:b4_69_17').length === 1 && !digs.includes('MINE:b4_70_17') && !digs.includes('MINE:b4_72_17'),
    `digs=[${digs.join(',')}]`,
  )
  // Progress: mining the base removes it, the drop falls to the landing, and the
  // body steps onto the landing. The next tick still holds a log route upward.
  const after = generateGroundedCandidates(
    liveWorld({
      position: LIVE_LANDING,
      blocks: liveLogs().filter((block) => !(block.position.x === 2 && block.position.y === 72)),
      standable: [...LIVE_STANDABLE, { x: 4, y: 69, z: 17 }],
    }),
    options(),
  )
  const progressed = after.candidates.some(
    (candidate) => candidate.kind === 'MINE' && candidate.target !== null && candidate.target.y >= 69,
  )
  await check(
    '(a) progress continues: after the base is mined the next column cell is offered',
    progressed,
    `after=[${after.candidates.map((c) => c.id).join(',')}]`,
  )
}

// (b) genuinely nothing reachable -> the one-shot typed escalation is enabled ---
{
  const state = liveWorld({ standable: [LIVE_FEET] })
  const grounded = generateGroundedCandidates(state, options())
  const refusal = grounded.surfaceAscentRefusal
  const altitudeless = !altitudeRouteOnOffer(grounded.candidates, Math.floor(LIVE_FEET.y), 80)
  await check(
    '(b) a column with no reachable landing offers no route and no false progress',
    columnDigs(grounded.candidates).length === 0 && altitudeless,
    `digs=[${columnDigs(grounded.candidates).join(',')}] presented=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  )
  await check(
    '(b) the dead end is a typed refusal (the controller turns it into one escalation)',
    refusal !== null &&
      refusal.reason === 'no_placeable' &&
      formatSurfaceAscentRefused(refusal).startsWith('SURFACE_ASCENT_REFUSED reason=no_placeable goal=g49:surface:log'),
    `refusal=${refusal === null ? 'none' : formatSurfaceAscentRefused(refusal)}`,
  )
  // A level MOVE is not an ascent: the live pace between two y=67 cells must not
  // count as an altitude route (that masking is what let attempts pass 131).
  const levelOnly = [
    {
      id: 'MOVE:p1_67_18',
      kind: 'MOVE',
      label: 'level step',
      targetName: null,
      target: { x: 1, y: 67, z: 18 },
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: {},
    },
  ]
  await check(
    '(b) level MOVEs alone do not clear the altitude dead end',
    altitudeRouteOnOffer(levelOnly as never, 67, 80) === false,
    'altitudeRouteOnOffer(level moves, 67, 80)=false',
  )
}

// (c) a normal body that already holds blocks keeps the existing ascend route --
{
  const state = liveWorld({ inventory: inventory({ cobblestone: 16, stone_pickaxe: 1 }) })
  const grounded = generateGroundedCandidates(state, options())
  const ascend = grounded.candidates.find((candidate) => candidate.id.startsWith('ASCEND:surface:'))
  await check(
    '(c) with placeable blocks the pillar/ascend route is unchanged and feasible',
    grounded.surfaceAscentRefusal === null &&
      ascend !== undefined &&
      ascend.kind === 'MOVE' &&
      ascend.affordance?.feasible === true &&
      ascend.meta.vertical === 'pillar',
    `refusal=${grounded.surfaceAscentRefusal === null ? 'none' : 'set'} ascend=${ascend?.id ?? 'none'} vertical=${String(ascend?.meta.vertical ?? 'none')}`,
  )
}

// (d) a reachable log at body height is unchanged (no gratuitous digging) -------
{
  const state = liveWorld({
    blocks: [logBlock({ x: 2, y: 68, z: 17 }, { inReach: true, distance: 1.5 })],
    standable: [LIVE_FEET, { x: 2, y: 68, z: 17 }],
  })
  const grounded = generateGroundedCandidates(state, options())
  const ordinary = grounded.candidates.find((candidate) => candidate.id === 'MINE:b2_68_17')
  await check(
    '(d) an in-reach pickup-adjacent log keeps the ordinary MINE with no column dig',
    ordinary !== undefined &&
      ordinary.meta.columnDig !== true &&
      columnDigs(grounded.candidates).length === 0 &&
      logRouteOf(grounded.candidates)?.mode === 'mine_sensed',
    `columnDigs=[${columnDigs(grounded.candidates).join(',')}] presented=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  )
  // A base out of interaction reach is not a route: only the live eye-reach fact
  // (`inReach`) makes the column base diggable.
  const outOfReach = generateGroundedCandidates(
    liveWorld({
      blocks: [logBlock({ x: 2, y: 80, z: 17 }, { inReach: false })],
      standable: [LIVE_FEET, LIVE_LANDING],
    }),
    options(),
  )
  await check(
    '(d) a column base outside interaction reach is not offered as a MINE',
    columnDigs(outOfReach.candidates).length === 0,
    `columnDigs=[${columnDigs(outOfReach.candidates).join(',')}]`,
  )
}

// (e) wiring: the generator owns the fact, Jev still owns the choice ------------
{
  const candidates = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
  const controller = readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')
  const evidencePlane = readFileSync(new URL('./src/grounded-evidence.ts', import.meta.url), 'utf8')
  const wired =
    candidates.includes('function columnDigBaseFor') &&
    candidates.includes('function columnDigMine') &&
    candidates.includes('function columnLandingFor') &&
    candidates.includes('export function altitudeRouteOnOffer') &&
    evidencePlane.includes('altitudeRouteOnOffer(') &&
    controller.includes('noteColumnDig')
  await check(
    '(e) the column-dig generator, the altitude-route predicate and the controller wiring are present',
    wired,
    `generator=${candidates.includes('function columnDigBaseFor')} predicate=${candidates.includes('export function altitudeRouteOnOffer')} controller=${controller.includes('noteColumnDig')}`,
  )
}

process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`column-dig: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
