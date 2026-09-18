// test-reachability.mts - issue #11 v2 acceptance: the affordance gate.
//
// The owner's root cause: "most of AIBuddy's problems are that it tries to go to
// places it cannot reach." This suite proves that a mechanically unreachable
// locomotion target is NOT presented as an executable candidate, that the
// refusal is typed with the missing capabilities, that grounded
// capability-acquisition candidates are offered instead, and that a proven
// target is suppressed while its state fingerprint is unchanged.
//
// Run: npx tsx test-reachability.mts  (wired as `npm run reachability-test`)
import { createRequire } from 'node:module'
import { applyReachabilityGate, defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { candidateStarvationBlockedBy, candidateStarvationLine, candidateStarvationMissing } from './src/controller.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey, evaluateReachability, formatCandidateWithheld, formatReachability, reachabilityFingerprint } from './src/reachability.ts'
import type { ReachabilityAbilities, ReachabilityResult, ReachabilityTarget, ReachabilityWorld } from './src/reachability.ts'
import { StateFingerprintMemory } from './src/moveFailMemory.ts'
import type { AgentSignals, BlockState, DescentOption, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_REACH',
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

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'chop:oak_log',
    description: 'collect 2 x oak_log',
    targetItem: 'oak_log',
    requiredCount: 2,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
    ...overrides,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g1',
    kind: 'collect',
    description: 'collect 2 x oak_log',
    targetItem: 'oak_log',
    requiredCount: 2,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function queueWith(current: QueuedGoal | null): GoalQueueState {
  if (current === null) return emptyGoalQueueState()
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  position: Vec3Json
  inventory?: InventoryState
  signals?: AgentSignals
  standable?: Vec3Json[]
  headroomCuts?: WorldState['headroomCuts']
  descent?: WorldState['descent']
  blocks?: BlockState[]
  goal?: GoalState
  goalQueue?: GoalQueueState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: [],
    headroomCuts: overrides.headroomCuts ?? [],
    goal: overrides.goal ?? goal(),
    goalQueue: overrides.goalQueue ?? queueWith(queuedGoal()),
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

const BOT: Vec3Json = { x: 0, y: 60, z: 0 }
const FAR_ABOVE: Vec3Json = { x: 0, y: 110, z: 0 }
const KNOWN_LOG: KnownResource = { name: 'oak_log', kind: 'log', position: FAR_ABOVE }

function optionsWith(memory: StateFingerprintMemory | null): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: { memory } }
}

// (1) a target 50 above with no ascend ability and no blocks is NOT presented ------
{
  const state = worldState({ position: BOT, signals: signals({ knownResources: [KNOWN_LOG] }) })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const id = `RETRIEVE:known:oak_log:b${FAR_ABOVE.x}_${FAR_ABOVE.y}_${FAR_ABOVE.z}`
  const presented = grounded.candidates.some((candidate) => candidate.id === id)
  const withheld = grounded.withheld.find((entry) => entry.candidate.id === id)
  check(
    'a target 50 blocks above with no placeable block and no plan is not presented',
    !presented && withheld !== undefined && withheld.result.reason === 'needs_ascend',
    `presented=${presented} withheld=${withheld?.result.reason ?? 'none'}`,
  )
  check(
    'the refusal names the missing capability (placeable block for the pillar)',
    withheld !== undefined &&
      withheld.result.missingCapabilities.some((capability) => capability.kind === 'placeable_block'),
    withheld === undefined ? 'no withheld record' : JSON.stringify(withheld.result.missingCapabilities),
  )
  check(
    'no executable candidate for the target exists in the presented list',
    grounded.candidates.every((candidate) => candidate.id !== id),
    grounded.candidates.map((candidate) => candidate.id).join(','),
  )
  check(
    'the typed refusal escalates instead of looping (ESCALATE reason=reachability_refused)',
    grounded.candidates.some(
      (candidate) => candidate.kind === 'ESCALATE' && candidate.meta.reason === 'reachability_refused',
    ),
    grounded.candidates.map((candidate) => candidate.id).join(','),
  )
}

// (2) the same target is reachable when a placeable block + headroom exist ---------
{
  const state = worldState({
    position: BOT,
    inventory: inventory({ cobblestone: 8 }),
    signals: signals({ knownResources: [KNOWN_LOG] }),
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const id = `RETRIEVE:known:oak_log:b${FAR_ABOVE.x}_${FAR_ABOVE.y}_${FAR_ABOVE.z}`
  const presented = grounded.candidates.find((candidate) => candidate.id === id)
  check(
    'with a placeable block + headroom the same target is presented as reachable',
    presented !== undefined && presented.affordance?.feasible === true && presented.affordance.reason === 'reachable',
    presented === undefined ? 'not presented' : JSON.stringify(presented.affordance),
  )
}

// (3) a block requiring a diamond pickaxe with only a stone pickaxe ----------------
{
  const target: ReachabilityTarget = {
    candidateId: 'MINE:b1_60_1',
    kind: 'MINE',
    position: { x: 1, y: 60, z: 1 },
    barrier: {
      position: { x: 1, y: 60, z: 1 },
      name: 'diamond_ore',
      requiredTool: 'pickaxe',
      requiredTier: 4,
    },
  }
  const world: ReachabilityWorld = {
    self: BOT,
    approach: { x: 0, y: 60, z: 1 },
    reach: 4.5,
    hazardAtTarget: false,
    footingSolid: true,
    headroomClear: true,
  }
  const abilities: ReachabilityAbilities = {
    ascend: { available: false, missing: [] },
    descend: { available: false, missing: [] },
  }
  const result = evaluateReachability(target, world, inventory({ stone_pickaxe: 1 }).counts, abilities, 'reachable')
  check(
    'a diamond block with only a stone pickaxe is missing_tool',
    !result.reachable &&
      result.reason === 'missing_tool' &&
      result.missingCapabilities.some(
        (capability) => capability.kind === 'tool' && capability.tool === 'pickaxe' && capability.tier === 4,
      ),
    JSON.stringify(result),
  )

  const bareStone = evaluateReachability(
    {
      ...target,
      barrier: { position: { x: 1, y: 60, z: 1 }, name: 'stone', requiredTool: 'pickaxe', requiredTier: 0 },
    },
    world,
    inventory({}).counts,
    abilities,
    'reachable',
  )
  check(
    'a pickaxe-tier-0 barrier with NO pickaxe at all is missing_tool (rank sentinel -1)',
    !bareStone.reachable &&
      bareStone.reason === 'missing_tool' &&
      bareStone.missingCapabilities.some((capability) => capability.kind === 'tool' && capability.tier === 0),
    JSON.stringify(bareStone),
  )

  const ore: BlockState = {
    kind: 'ore',
    name: 'diamond_ore',
    position: { x: 1, y: 60, z: 1 },
    distance: 1.4,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 0, y: 60, z: 1 },
    yield: 'diamond',
    harvestTool: 'pickaxe',
    harvestTier: 4,
  }
  const state = worldState({
    position: BOT,
    inventory: inventory({ stone_pickaxe: 1 }),
    blocks: [ore],
  })
  const move: Candidate = {
    id: 'MOVE:b1_60_1',
    kind: 'MOVE',
    label: 'walk to diamond_ore',
    targetName: 'diamond_ore',
    target: { x: 0, y: 60, z: 1 },
    targetEntityId: null,
    itemName: null,
    requiresTool: true,
    toolName: 'pickaxe',
    toolTier: 4,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      targetBlockX: 1,
      targetBlockY: 60,
      targetBlockZ: 1,
      targetBlockName: 'diamond_ore',
    },
  }
  const gated = applyReachabilityGate([move], state, defaultCandidateOptions)
  check(
    'the gate withholds the candidate whose barrier needs a missing tool',
    gated.candidates.every((candidate) => candidate.id !== 'MOVE:b1_60_1') &&
      gated.withheld[0]?.result.reason === 'missing_tool',
    `withheld=${gated.withheld.map((entry) => entry.result.reason).join(',') || 'none'}`,
  )
}

// (4) a plainly reachable target is unaffected ------------------------------------
{
  const state = worldState({
    position: BOT,
    signals: signals({
      knownResources: [{ name: 'oak_log', kind: 'log', position: { x: 0, y: 60, z: 12 } }],
    }),
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const id = 'RETRIEVE:known:oak_log:b0_60_12'
  const presented = grounded.candidates.find((candidate) => candidate.id === id)
  check(
    'a level reachable target is presented with affordance.feasible=true (no regression)',
    presented !== undefined && presented.affordance?.feasible === true,
    presented === undefined ? 'not presented' : `${presented.id} ${JSON.stringify(presented.affordance)}`,
  )
}

// (5) proven-unreachable suppression while the fingerprint is unchanged ------------
{
  const memory = new StateFingerprintMemory()
  const id = `RETRIEVE:known:oak_log:b${FAR_ABOVE.x}_${FAR_ABOVE.y}_${FAR_ABOVE.z}`
  const state = worldState({ position: BOT, signals: signals({ knownResources: [KNOWN_LOG] }) })
  const first = generateGroundedCandidates(state, optionsWith(memory))
  const second = generateGroundedCandidates(state, optionsWith(memory))
  const firstRecord = first.withheld.find((entry) => entry.candidate.id === id)
  const secondRecord = second.withheld.find((entry) => entry.candidate.id === id)
  check(
    'a proven-unreachable target is not re-presented while the fingerprint is unchanged',
    firstRecord !== undefined &&
      secondRecord !== undefined &&
      secondRecord.suppressed === true &&
      second.candidates.every((candidate) => candidate.id !== id),
    `suppressed=${secondRecord?.suppressed ?? 'none'} presented=${second.candidates.some((c) => c.id === id)}`,
  )
  check(
    'the failure history stays visible while suppressed',
    memory.check(id, firstRecord?.fingerprint ?? '').known === true &&
      memory.check(id, firstRecord?.fingerprint ?? '').reason === 'needs_ascend',
    JSON.stringify(memory.check(id, firstRecord?.fingerprint ?? '')),
  )

  const changed = worldState({
    position: BOT,
    inventory: inventory({ cobblestone: 8 }),
    signals: signals({ knownResources: [KNOWN_LOG] }),
  })
  const third = generateGroundedCandidates(changed, optionsWith(memory))
  const represented = third.candidates.find((candidate) => candidate.id === id)
  check(
    'the target IS re-presented after the state fingerprint changes (block acquired)',
    represented !== undefined && represented.affordance?.feasible === true,
    represented === undefined ? 'not presented' : JSON.stringify(represented.affordance),
  )
  check(
    'the stale proof is forgotten once the target becomes reachable',
    memory.check(id, firstRecord?.fingerprint ?? '').known === false,
    `memory.size=${memory.size()}`,
  )
}

// (6) the fingerprint only tracks reachability-relevant facts ----------------------
{
  const target: ReachabilityTarget = { candidateId: 'MOVE:p0_100_0', kind: 'MOVE', position: FAR_ABOVE, barrier: null }
  const baseWorld: ReachabilityWorld = {
    self: BOT,
    approach: FAR_ABOVE,
    reach: 4.5,
    hazardAtTarget: false,
    footingSolid: true,
    headroomClear: true,
  }
  const result: ReachabilityResult = { reachable: false, reason: 'needs_ascend', missingCapabilities: [{ kind: 'placeable_block' }] }
  const fp = (selfY: number, counts: Record<string, number>): string =>
    reachabilityFingerprint({
      target,
      result,
      inventory: counts,
      world: { ...baseWorld, self: { x: 0, y: selfY, z: 0 } },
      placeableBlock: (counts.cobblestone ?? 0) > 0,
    })
  check(
    'a 1-block body shuffle does not change the fingerprint (gap bucket)',
    fp(60, {}) === fp(61, {}),
    `${fp(60, {})} vs ${fp(61, {})}`,
  )
  check(
    'acquiring a placeable block changes the fingerprint',
    fp(60, {}) !== fp(60, { cobblestone: 1 }),
    `${fp(60, {})} vs ${fp(60, { cobblestone: 1 })}`,
  )
}

// (7) memory is bounded and forgettable -------------------------------------------
{
  const memory = new StateFingerprintMemory({ maxEntries: 2, now: () => 1_000 })
  memory.record('a', 'f1', 'needs_ascend')
  memory.record('b', 'f1', 'no_path')
  memory.record('c', 'f1', 'needs_descend')
  check(
    'the fingerprint memory is bounded (oldest evicted first)',
    memory.size() === 2 && !memory.check('a', 'f1').known,
    `size=${memory.size()} aKnown=${memory.check('a', 'f1').known}`,
  )
  check(
    'an unchanged fingerprint stays suppressed, a changed one does not',
    memory.isSuppressed('c', 'f1') && !memory.isSuppressed('c', 'f2'),
    `f1=${memory.isSuppressed('c', 'f1')} f2=${memory.isSuppressed('c', 'f2')}`,
  )
  memory.forget('c')
  check('forget clears the proof', memory.size() === 1 && !memory.check('c', 'f1').known, `size=${memory.size()}`)
}

// (8) pure evaluator facts: hazard, no_path, needs_descend -------------------------
{
  const target: ReachabilityTarget = { candidateId: 'MOVE:p0_60_10', kind: 'MOVE', position: { x: 0, y: 60, z: 10 }, barrier: null }
  const world: ReachabilityWorld = {
    self: BOT,
    approach: { x: 0, y: 60, z: 10 },
    reach: 4.5,
    hazardAtTarget: false,
    footingSolid: true,
    headroomClear: true,
  }
  const abilities: ReachabilityAbilities = {
    ascend: { available: false, missing: [] },
    descend: { available: false, missing: [] },
  }
  const hazard = evaluateReachability({ ...target, position: null }, { ...world, hazardAtTarget: true }, {}, abilities, 'reachable')
  check('a non-locomotion target is feasible', hazard.reachable && hazard.reason === 'reachable', JSON.stringify(hazard))
  const noPath = evaluateReachability(target, world, {}, abilities, 'no_path')
  check(
    'a no_path probe is a typed no_path refusal with the open_path capability',
    !noPath.reachable && noPath.reason === 'no_path' && noPath.missingCapabilities[0]?.kind === 'open_path',
    JSON.stringify(noPath),
  )
  const down = evaluateReachability(
    { ...target, position: { x: 0, y: 20, z: 0 } },
    world,
    {},
    abilities,
    'reachable',
  )
  check(
    'a 40-block drop with no descent plan is needs_descend',
    !down.reachable && down.reason === 'needs_descend' && down.missingCapabilities[0]?.kind === 'descend_plan',
    JSON.stringify(down),
  )
  const noApproach = evaluateReachability(target, { ...world, approach: null }, {}, abilities, 'unknown')
  check(
    'a target with no standable approach is no_standable_approach',
    !noApproach.reachable && noApproach.reason === 'no_standable_approach',
    JSON.stringify(noApproach),
  )
  const outOfReach = evaluateReachability(target, { ...world, approach: null }, {}, abilities, 'reachable')
  check(
    'a reachable path with nowhere to stand is out_of_reach',
    !outOfReach.reachable && outOfReach.reason === 'out_of_reach',
    JSON.stringify(outOfReach),
  )
}

// (9) live-geometry replay: the measured run-mu5qd4ah-3xdh failure ----------------
{
  // Bot at y=9 with the live inventory (dirt/cobblestone held, NO pickaxe), a
  // remembered furnace at (29,61,35) (dy=52), and a cobblestone ceiling in its
  // own column that would need the missing pickaxe to clear. This is the exact
  // state that produced 245x MOVE_UNREACHABLE + 1982x locomotion blocked.
  const smeltGoal = queuedGoal({
    kind: 'smelt',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
  })
  const state = worldState({
    position: { x: 39.3, y: 9, z: 33.7 },
    goal: goal({ targetItem: 'iron_ingot', description: 'smelt 3 x iron_ingot', requiredCount: 3 }),
    goalQueue: queueWith(smeltGoal),
    inventory: inventory({
      diorite: 16,
      dirt: 92,
      raw_copper: 11,
      andesite: 33,
      raw_iron: 8,
      leaf_litter: 30,
      cobblestone: 119,
      coal: 7,
      oak_planks: 1,
    }),
    signals: signals({
      knownResources: [{ name: 'furnace', kind: 'station', position: { x: 29, y: 61, z: 35 } }],
    }),
    headroomCuts: [{ pos: { x: 39, y: 10, z: 33 }, name: 'cobblestone', safe: true, reason: 'safe' }],
    blocks: [
      {
        kind: 'stone',
        name: 'cobblestone',
        position: { x: 39, y: 10, z: 33 },
        distance: 1,
        diggable: true,
        inReach: true,
        hasAdjacentStandable: false,
        adjacentStandable: null,
        yield: 'cobblestone',
        harvestTool: 'pickaxe',
        harvestTier: 0,
      },
    ],
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const id = 'RETRIEVE:known:station:furnace:b29_61_35'
  const withheld = grounded.withheld.find((entry) => entry.candidate.id === id)
  const missing = withheld?.result.missingCapabilities.map((capability) => capability.kind) ?? []
  check(
    'live geometry (dy=52, no pickaxe, blocked headroom) is withheld as needs_ascend',
    withheld !== undefined && withheld.result.reason === 'needs_ascend',
    `presented=${grounded.candidates.some((candidate) => candidate.id === id)} withheld=${withheld?.result.reason ?? 'none'}`,
  )
  check(
    'the live refusal names BOTH the headroom cell and the missing pickaxe',
    missing.includes('headroom') && missing.includes('tool'),
    JSON.stringify(withheld?.result.missingCapabilities ?? []),
  )
  check(
    'the live marker pair matches the required observability format',
    withheld !== undefined &&
      formatReachability(
        { candidateId: id, kind: 'RETRIEVE', position: { x: 29, y: 61, z: 35 }, barrier: null },
        withheld.result,
      ) === 'REACHABILITY target=29,61,35 reachable=false reason=needs_ascend missing=[headroom@39,10,33,tool:pickaxe@0]' &&
      formatCandidateWithheld(id, withheld.result.reason) === `CANDIDATE_WITHHELD reason=needs_ascend candidate=${id}`,
    withheld === undefined
      ? 'no withheld record'
      : formatReachability(
          { candidateId: id, kind: 'RETRIEVE', position: { x: 29, y: 61, z: 35 }, barrier: null },
          withheld.result,
        ),
  )
}

// (10) marker shapes ---------------------------------------------------------------
{
  const target: ReachabilityTarget = { candidateId: 'MOVE:p0_110_0', kind: 'MOVE', position: FAR_ABOVE, barrier: null }
  const result: ReachabilityResult = { reachable: false, reason: 'needs_ascend', missingCapabilities: [{ kind: 'placeable_block' }] }
  check(
    'REACHABILITY marker has the required shape',
    formatReachability(target, result) === 'REACHABILITY target=0,110,0 reachable=false reason=needs_ascend missing=[placeable_block]',
    formatReachability(target, result),
  )
  check(
    'CANDIDATE_WITHHELD marker has the required shape',
    formatCandidateWithheld('RETRIEVE:known:oak_log:b0_110_0', 'needs_ascend') ===
      'CANDIDATE_WITHHELD reason=needs_ascend candidate=RETRIEVE:known:oak_log:b0_110_0',
    formatCandidateWithheld('RETRIEVE:known:oak_log:b0_110_0', 'needs_ascend'),
  )
}

// (11) candidate-local capability attribution (craft / mine) -----------------------
//
// Live defect (main dc54ff4): `craft:wooden_pickaxe` with planks+sticks held
// starved as `blockedBy=tool:pickaxe@0`. The only candidate was a walk to an
// unreachable remembered crafting_table; the station ladder's self-contained
// step (craft the table from planks, then craft the pickaxe) was masked by the
// station acquisition early-return, so a satisfiable-NOW craft never appeared.
{
  const require = createRequire(import.meta.url)
  const recipeIndex = createRecipeIndex(require('minecraft-data')('1.21.11'))
  const craftOptions: CandidateOptions = { ...defaultCandidateOptions, recipes: recipeIndex }
  const Y = 48.5
  const bot: Vec3Json = { x: 30.9, y: Y, z: 37.8 }

  function craftGoal(item: string): QueuedGoal {
    return queuedGoal({
      id: `g-craft-${item}`,
      kind: 'craft',
      description: `craft 1 x ${item}`,
      targetItem: item,
      requiredCount: 1,
    })
  }

  function stoneDownStep(feet: Vec3Json): DescentOption {
    return {
      dir: 'E',
      mode: 'down',
      dx: 1,
      dz: 0,
      step: { x: feet.x + 1, y: feet.y - 1, z: feet.z },
      wall: { x: feet.x + 1, y: feet.y, z: feet.z },
      head: { x: feet.x + 1, y: feet.y + 1, z: feet.z },
      floor: { x: feet.x + 1, y: feet.y - 1, z: feet.z },
      wallSolid: false,
      headSolid: false,
      floorSolid: true,
      safe: true,
      reason: 'safe',
      digName: 'stone',
      digHarvestTool: 'pickaxe',
      digHarvestTier: 0,
      diggable: true,
    }
  }

  const tableBelow: KnownResource = { name: 'crafting_table', kind: 'station', position: { x: 40, y: 29, z: 35 } }
  const tableAbove: KnownResource = { name: 'crafting_table', kind: 'station', position: { x: 20, y: 65, z: 27 } }
  const feet = { x: Math.floor(bot.x), y: Math.floor(bot.y), z: Math.floor(bot.z) }

  // (a) planks + sticks held: the craft is PRODUCTIVE even when the only
  // remembered table is unreachable (below and above).
  {
    const held = inventory({ birch_planks: 7, stick: 2 })
    const scenarios: Array<{ label: string; known: KnownResource; descent?: DescentOption[]; standable?: Vec3Json[] }> = [
      { label: 'below (descend staircase needs a pickaxe)', known: tableBelow, descent: [stoneDownStep(feet)] },
      { label: 'above (ascend needs a column)', known: tableAbove, standable: [] },
    ]
    for (const scenario of scenarios) {
      const state = worldState({
        position: bot,
        inventory: held,
        goal: goal({ targetItem: 'wooden_pickaxe', description: 'craft 1 x wooden_pickaxe', requiredCount: 1 }),
        goalQueue: queueWith(craftGoal('wooden_pickaxe')),
        signals: signals({ knownResources: [scenario.known] }),
        descent: scenario.descent,
        standable: scenario.standable,
      })
      const grounded = generateGroundedCandidates(state, craftOptions)
      const productive = grounded.candidates.filter(
        (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
      )
      const craft = productive.find((candidate) => candidate.kind === 'CRAFT')
      const blockedBy = candidateStarvationBlockedBy(grounded.withheld, null)
      const missing = candidateStarvationMissing(grounded.withheld)
      const line = candidateStarvationLine(grounded.candidates, 'craft:wooden_pickaxe:1', false, blockedBy, missing)
      check(
        `(a) craft:wooden_pickaxe with planks+sticks held is PRODUCTIVE with the table ${scenario.label}`,
        craft !== undefined && craft.id === 'CRAFT:crafting_table' && line === null,
        `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] starvation=${line ?? 'none'}`,
      )
      const withheldCraft = grounded.withheld.find((entry) => entry.candidate.kind === 'CRAFT')
      check(
        `(a) the craft candidate carries no missing capability of its own (table ${scenario.label})`,
        withheldCraft === undefined &&
          craft !== undefined &&
          (craft.affordance?.missingCapabilities.length ?? -1) === 0,
        `withheldCraft=${withheldCraft?.candidate.id ?? 'none'} craft=${craft === undefined ? 'none' : JSON.stringify(craft.affordance)}`,
      )
      const withheldTable = grounded.withheld.find((entry) => entry.candidate.id.includes('station:crafting_table'))
      check(
        `(a) the unreachable station keeps ITS OWN capability attribution (table ${scenario.label})`,
        withheldTable !== undefined && withheldTable.result.missingCapabilities.length > 0,
        withheldTable === undefined
          ? 'table retrieve not withheld'
          : `${withheldTable.candidate.id} missing=[${withheldTable.result.missingCapabilities.map(capabilityKey).join(',')}]`,
      )
    }
  }

  // (b) no planks held: the self-craft ladder cannot run, so the reachable-blocked
  // stone craft is attributed the tool ITS route needs (never suppressed).
  {
    const state = worldState({
      position: bot,
      inventory: inventory({ cobblestone: 3, stick: 2 }),
      goal: goal({ targetItem: 'stone_pickaxe', description: 'craft 1 x stone_pickaxe', requiredCount: 1 }),
      goalQueue: queueWith(craftGoal('stone_pickaxe')),
      signals: signals({ knownResources: [tableBelow] }),
      descent: [stoneDownStep(feet)],
    })
    const grounded = generateGroundedCandidates(state, craftOptions)
    const blockedBy = candidateStarvationBlockedBy(grounded.withheld, null)
    const missing = candidateStarvationMissing(grounded.withheld)
    const line = candidateStarvationLine(grounded.candidates, 'craft:stone_pickaxe:1', false, blockedBy, missing)
    check(
      '(b) a stone craft with no planks keeps blockedBy=tool:pickaxe@0 from its own route',
      blockedBy === 'tool:pickaxe@0' &&
        missing.join(',') === 'tool:pickaxe@0' &&
        line ===
          'CANDIDATE_STARVATION presented=2 productive=0 goal="craft:stone_pickaxe:1" blockedBy=tool:pickaxe@0 missing=[tool:pickaxe@0]',
      `blockedBy=${blockedBy} missing=[${missing.join(',')}] line="${line ?? 'none'}"`,
    )
  }

  // (c) a MINE candidate requires the harvest tool tier of the block IT names.
  {
    const ironOre: BlockState = {
      kind: 'ore',
      name: 'iron_ore',
      position: { x: 40, y: 47, z: 37 },
      distance: 1.4,
      diggable: true,
      inReach: true,
      hasAdjacentStandable: true,
      adjacentStandable: { x: 39, y: 48, z: 37 },
      yield: 'raw_iron',
      harvestTool: 'pickaxe',
      harvestTier: 2,
    }
    const mine: Candidate = {
      id: 'MINE:b40_47_37',
      kind: 'MINE',
      label: 'mine iron_ore',
      targetName: 'iron_ore',
      target: ironOre.position,
      targetEntityId: null,
      itemName: null,
      requiresTool: true,
      toolName: 'pickaxe',
      toolTier: 2,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: 1, x: 40, y: 47, z: 37, yieldItem: 'raw_iron' },
    }
    const bare = worldState({ position: bot, inventory: inventory({}), blocks: [ironOre] })
    const gated = applyReachabilityGate([mine], bare, craftOptions)
    const withheld = gated.withheld.find((entry) => entry.candidate.id === 'MINE:b40_47_37')
    check(
      '(c) a MINE candidate for iron_ore with no pickaxe is attributed tool:pickaxe@2',
      withheld !== undefined &&
        withheld.result.reason === 'missing_tool' &&
        withheld.result.missingCapabilities.map(capabilityKey).join(',') === 'tool:pickaxe@2' &&
        gated.candidates.every((candidate) => candidate.id !== 'MINE:b40_47_37'),
      withheld === undefined
        ? `presented=[${gated.candidates.map((candidate) => candidate.id).join(',')}]`
        : withheld.result.missingCapabilities.map(capabilityKey).join(','),
    )
    const stocked = worldState({ position: bot, inventory: inventory({ stone_pickaxe: 1 }), blocks: [ironOre] })
    const withTool = applyReachabilityGate([mine], stocked, craftOptions)
    const presented = withTool.candidates.find((candidate) => candidate.id === 'MINE:b40_47_37')
    check(
      '(c) the same MINE candidate is presented once the stone pickaxe is held',
      presented !== undefined && presented.affordance?.feasible === true,
      presented === undefined ? 'not presented' : JSON.stringify(presented.affordance),
    )
  }

  // (d) a reachable RETRIEVE is unaffected by the craft attribution work.
  {
    const state = worldState({
      position: bot,
      inventory: inventory({ birch_planks: 7, stick: 2 }),
      signals: signals({
        knownResources: [{ name: 'oak_log', kind: 'log', position: { x: 30, y: 48, z: 50 } }],
      }),
    })
    const grounded = generateGroundedCandidates(state, craftOptions)
    const id = 'RETRIEVE:known:oak_log:b30_48_50'
    const retrieve = grounded.candidates.find((candidate) => candidate.id === id)
    check(
      '(d) a reachable RETRIEVE is still presented with feasible=true and no missing capabilities',
      retrieve !== undefined &&
        retrieve.affordance?.feasible === true &&
        retrieve.affordance.missingCapabilities.length === 0 &&
        grounded.withheld.every((entry) => entry.candidate.id !== id),
      retrieve === undefined ? `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]` : JSON.stringify(retrieve.affordance),
    )
  }
}

process.stdout.write(`\n${failures === 0 ? 'OK' : 'FAILURES'}: ${failures} failing check(s)\n`)
if (failures > 0) process.exit(1)
