// test-reachability.mts - issue #11 v2 acceptance: the affordance gate.
//
// The owner's root cause: "most of AIBuddy's problems are that it tries to go to
// places it cannot reach." This suite proves that a mechanically unreachable
// locomotion target is NOT presented as an executable candidate, that the
// refusal is typed with the missing capabilities, that grounded
// capability-acquisition candidates are offered instead, and that a proven
// target is suppressed while its state fingerprint is unchanged.
//
// Run: bun test-reachability.mts  (wired as `bun run reachability-test`)
import { createRequire } from 'node:module'
import { applyReachabilityGate, blockId, craftIngredientPrereq, craftStationGap, defaultCandidateOptions, formatCraftIngredientPrereq, formatCraftStationGap, formatSmeltInputPrereq, generateGroundedCandidates, smeltInputPrereq } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { MIRRORED_MARKERS, candidateStarvationLine, candidateStarvationMissing, ensureCraftStepActionable, goalStarvationBlockedBy } from './src/controller.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey, evaluateReachability, formatCandidateWithheld, formatReachability, reachabilityFingerprint } from './src/reachability.ts'
import type { ReachabilityAbilities, ReachabilityResult, ReachabilityTarget, ReachabilityWorld } from './src/reachability.ts'
import { moveFailureKey, StateFingerprintMemory } from './src/moveFailMemory.ts'
import { knownStationKey } from './src/prereqOption.ts'
import type { AgentSignals, BlockState, DescentOption, GoalState, InventoryState, KnownResource, SelfState, StationEntry, StepCut, Vec3Json, WorldState } from './src/state.ts'

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
  stepCuts?: WorldState['stepCuts']
  blocks?: BlockState[]
  furnaces?: WorldState['furnaces']
  craftingTables?: WorldState['craftingTables']
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
    craftingTables: overrides.craftingTables ?? [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: overrides.stepCuts ?? [],
    headroomCuts: overrides.headroomCuts ?? [],
    goal: overrides.goal ?? goal(),
    goalQueue: overrides.goalQueue ?? queueWith(queuedGoal()),
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

// (13) a smelt goal with a sensed furnace must pursue a missing visible input.
// The live failure shape had a furnace in range and no log in inventory, while
// an oak log was visible above. Before this bridge, smeltCandidates returned
// [] and retrievalCandidates intentionally skipped visible logs, so the final
// fallback selected unrelated underground MOVE targets.
{
  const log: BlockState = {
    kind: 'log',
    name: 'oak_log',
    position: { x: 33, y: 68, z: 27 },
    distance: 38.49,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 32, y: 67, z: 27 },
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
  }
  const smelt = queuedGoal({
    id: 'g-charcoal-input',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
  })
  const state = worldState({
    position: { x: 34.49, y: 31, z: 37.5 },
    inventory: inventory({ birch_planks: 2, cobblestone: 158, stick: 2, dirt: 37, stone_pickaxe: 1 }),
    blocks: [log],
    furnaces: [{ x: 37, y: 30, z: 37, source: 'sensed' }],
    goal: goal({ id: 'smelt:charcoal', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 }),
    goalQueue: queueWith(smelt),
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const inputMove = grounded.candidates.find((candidate) => candidate.id === 'MOVE:b33_68_27')
  const unrelated = grounded.candidates.find((candidate) => candidate.id.startsWith('MOVE:p'))
  const productive = grounded.candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  check(
    '(13) sensed furnace + missing visible log yields the log MINE/MOVE route',
    inputMove !== undefined &&
      inputMove.meta.targetBlockName === 'oak_log' &&
      inputMove.meta.optionSkill === 'PREREQUISITE' &&
      inputMove.meta.prerequisiteRole === 'smelt_input' &&
      inputMove.meta.vertical === 'pillar' &&
      Number(inputMove.meta.pillarSteps) > 0 &&
      unrelated === undefined &&
      productive.length > 0,
    `productive=[${productive.map((candidate) => candidate.id).join(',')}] input=${inputMove?.id ?? 'none'} vertical=${String(inputMove?.meta.vertical ?? 'none')} steps=${String(inputMove?.meta.pillarSteps ?? 0)}`,
  )
}

// (13d) a smelt input route must retain a durable remembered ore coordinate
// after the ore leaves the current sensor window. The former mine-only bridge
// returned no route here, so an active iron smelt collapsed to WAIT/ESCALATE
// even though the world memory still contained a non-stale iron_ore fact.
{
  const feet: Vec3Json = { x: 34.5, y: 31, z: 37.5 }
  const furnace: StationEntry = { x: 37, y: 30, z: 37, source: 'sensed' }
  const ironOre: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 45, y: 31, z: 37 } }
  const smelt = queuedGoal({
    id: 'g-iron-input',
    kind: 'smelt',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
  })
  const state = worldState({
    position: feet,
    inventory: inventory({ stone_pickaxe: 1, cobblestone: 32, coal: 3 }),
    furnaces: [furnace],
    signals: signals({ knownResources: [ironOre] }),
    goal: goal({ id: 'smelt:iron_ingot', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }),
    goalQueue: queueWith(smelt),
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const retrieve = grounded.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b45_31_37')
  const entry = smeltInputPrereq(state, optionsWith(null))
  const line = entry === null ? null : formatSmeltInputPrereq(entry)
  check(
    '(13d) missing iron input keeps the remembered ore prerequisite candidate',
    retrieve !== undefined &&
      retrieve.meta.optionSkill === 'PREREQUISITE' &&
      retrieve.meta.prerequisiteRole === 'smelt_input' &&
      retrieve.meta.prerequisiteItem === 'raw_iron' &&
      retrieve.affordance?.feasible === true,
    `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] retrieve=${retrieve?.id ?? 'none'}`,
  )
  check(
    '(13e) the smelt prerequisite marker agrees with the remembered route',
    line === 'SMELT_INPUT_PREREQ item=iron_ingot input=raw_iron present=false action=insert_collect',
    `line="${line ?? 'none'}"`,
  )
}

// (13f) a remembered productive route suppresses unrelated headroom digging.
// The live failure shape presented RETRIEVE:raw_iron beside MINE:dirt ceiling
// clearance, then Jev selected the dirt despite no goal relation.
{
  const feet: Vec3Json = { x: 34.5, y: 31, z: 37.5 }
  const smelt = queuedGoal({
    id: 'g-iron-input-clearance',
    kind: 'smelt',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
  })
  const state = worldState({
    position: feet,
    inventory: inventory({ stone_pickaxe: 1, cobblestone: 32, coal: 3 }),
    furnaces: [{ x: 37, y: 30, z: 37, source: 'sensed' }],
    headroomCuts: [{ pos: { x: 34, y: 32, z: 37 }, name: 'dirt', safe: true, reason: 'test-ceiling' }],
    signals: signals({ knownResources: [{ name: 'iron_ore', kind: 'ore', position: { x: 45, y: 31, z: 37 } }] }),
    goal: goal({ id: 'smelt:iron_ingot', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }),
    goalQueue: queueWith(smelt),
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const clearance = grounded.candidates.filter((candidate) => candidate.meta.clearance === true)
  const retrieve = grounded.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b45_31_37')
  check(
    '(13f) unrelated dirt clearance is withheld when the smelt retrieve route exists',
    retrieve !== undefined && clearance.length === 0,
    `retrieve=${retrieve?.id ?? 'none'} clearance=[${clearance.map((candidate) => candidate.id).join(',')}] candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
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

  const openPathMove: Candidate = {
    ...move,
    id: 'MOVE:p0_60_2',
    targetName: null,
    target: { x: 0, y: 60, z: 2 },
    requiresTool: false,
    toolName: null,
    toolTier: null,
    meta: { tick: state.tick },
  }
  const noPath = applyReachabilityGate([openPathMove], state, {
    ...defaultCandidateOptions,
    reachability: { memory: null, pathProbe: () => 'no_path' },
  })
  check(
    'a standable MOVE is withheld when the live path probe says no_path',
    noPath.candidates.every((candidate) => candidate.id !== openPathMove.id) &&
      noPath.withheld[0]?.result.reason === 'no_path',
    `presented=${noPath.candidates.map((candidate) => candidate.id).join(',') || 'none'} withheld=${noPath.withheld[0]?.result.reason ?? 'none'}`,
  )

  const verticalPlanMove: Candidate = {
    ...openPathMove,
    id: 'MOVE:p0_64_2',
    target: { x: 0, y: 64, z: 2 },
    meta: { tick: state.tick, vertical: 'pillar' },
  }
  const verticalPlan = applyReachabilityGate([verticalPlanMove], state, {
    ...defaultCandidateOptions,
    reachability: { memory: null, pathProbe: () => 'no_path' },
  })
  check(
    'an explicit vertical-plan MOVE bypasses the horizontal path probe',
    verticalPlan.candidates.some((candidate) => candidate.id === verticalPlanMove.id) &&
      verticalPlan.candidates.find((candidate) => candidate.id === verticalPlanMove.id)?.affordance?.feasible === true,
    `presented=${verticalPlan.candidates.map((candidate) => candidate.id).join(',') || 'none'} withheld=${verticalPlan.withheld.map((entry) => entry.candidate.id).join(',') || 'none'}`,
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

  // (a) planks + sticks held, and the ONLY remembered table is unreachable (below
  // and above). OPERATOR RULE (station-use-before-craft) supersedes the dc54ff4
  // "craft a local table anyway" fallback: the world model already holds that
  // station, so a duplicate `CRAFT:crafting_table` is never offered. The station
  // route keeps its own typed withholding (needs_descend / needs_ascend) and the
  // state carries the typed `CRAFT_STATION_ALREADY_KNOWN` fact instead of a
  // silent craft.
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
      const duplicateTable = productive.find((candidate) => candidate.id === 'CRAFT:crafting_table')
      const gap = craftStationGap(state, craftOptions)
      check(
        `(a) no duplicate station craft while the world model holds the table ${scenario.label}`,
        duplicateTable === undefined &&
          gap !== null &&
          gap.reason === 'known_station' &&
          gap.next === 'use_known_station',
        `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] duplicate=${duplicateTable?.id ?? 'none'} gap=${gap === null ? 'none' : formatCraftStationGap(gap)}`,
      )
      const withheldCraft = grounded.withheld.find((entry) => entry.candidate.kind === 'CRAFT')
      const duplicateWithheld = grounded.withheld.find((entry) => entry.candidate.id === 'CRAFT:crafting_table')
      check(
        `(a) the withheld route is the STATION, not a duplicate craft (table ${scenario.label})`,
        withheldCraft === undefined && duplicateWithheld === undefined,
        `withheldCraft=${withheldCraft?.candidate.id ?? 'none'} duplicateWithheld=${duplicateWithheld?.candidate.id ?? 'none'}`,
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
    const blockedBy = goalStarvationBlockedBy(null, { kind: 'craft', targetItem: 'stone_pickaxe' }, grounded.withheld)
    const missing = candidateStarvationMissing(grounded.withheld)
    const line = candidateStarvationLine(grounded.candidates, 'craft:stone_pickaxe:1', false, blockedBy, missing)
    check(
      '(b) a withheld station reason never becomes the craft goal blockedBy',
      blockedBy === 'no_productive_action' &&
        missing.length > 0 &&
        missing.every((token) => token.startsWith('RETRIEVE:known:station:crafting_table:b40_29_35:')) &&
        line !== null &&
        line.includes('blockedBy=no_productive_action') &&
        !line.includes('tool:pickaxe@0 missing') &&
        line.includes('missing=["RETRIEVE:known:station:crafting_table:b40_29_35:tool:pickaxe@0"]'),
      `blockedBy=${blockedBy} missing=[${missing.join(',')}] line="${line ?? 'none'}"`,
    )
  }

  // (e) live-shape regression: a reachable station retrieve is offered, then the
  // controller's own move-fail filter removes it. OPERATOR RULE
  // (station-use-before-craft): the local 2x2 step here would be a duplicate of
  // the station the world model already holds, so it must NOT be restored - the
  // Option reports the typed station fact and the starvation evidence carries the
  // withheld station route instead.
  {
    const state = worldState({
      position: bot,
      inventory: inventory({ birch_planks: 7, stick: 2, cobblestone: 42 }),
      goal: goal({ targetItem: 'wooden_pickaxe', description: 'craft 1 x wooden_pickaxe', requiredCount: 1 }),
      goalQueue: queueWith(craftGoal('wooden_pickaxe')),
      signals: signals({ knownResources: [{ name: 'crafting_table', kind: 'station', position: { x: 32, y: 48, z: 37 } }] }),
    })
    const grounded = generateGroundedCandidates(state, craftOptions)
    const retrieve = grounded.candidates.find((candidate) => candidate.id.includes('station:crafting_table'))
    const gap = craftStationGap(state, craftOptions)
    check(
      '(e) a reachable known table is the route and the duplicate local table craft is not offered',
      retrieve !== undefined &&
        !grounded.candidates.some((candidate) => candidate.id === 'CRAFT:crafting_table') &&
        gap !== null &&
        gap.next === 'use_known_station',
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] gap=${gap === null ? 'none' : formatCraftStationGap(gap)}`,
    )
    // simulate the controller pruning every locomotion candidate (move-fail memory);
    // the duplicate-craft backfill must NOT resurrect the withheld station craft.
    const afterControllerFilters = grounded.candidates.filter(
      (candidate) => candidate.kind !== 'MOVE' && candidate.kind !== 'RETRIEVE',
    )
    const restored = ensureCraftStepActionable(state, afterControllerFilters, craftOptions)
    check(
      '(e) the controller backfill never restores a duplicate station craft',
      !restored.some((candidate) => candidate.id === 'CRAFT:crafting_table'),
      `before=[${afterControllerFilters.map((candidate) => candidate.id).join(',')}] after=[${restored.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  // (f) live M2: a sensed table 11 blocks below is ACQUIRED, never blind-CRAFTed.
  //
  // Measured live: `CRAFT:furnace` targeted a sensed crafting_table at (40,29,35)
  // from y=40; the executor's `pathing-to-table` GoalNear failed (`noPath`) and
  // the hop loop never descended, so the candidate was abandoned as unreachable
  // and the smelt goal starved - while the reachability gate reported the SAME
  // table coordinate reachable (`RETRIEVE:known:station:crafting_table:b40_29_35
  // reachable=true`). The furnace craft's table sub-step must therefore be the
  // acquisition candidate (placespot ladder), not a blind CRAFT walk.
  {
    const feet: Vec3Json = { x: 32, y: 40, z: 37 }
    const table: Vec3Json = { x: 40, y: 29, z: 35 }
    const smeltCharcoal = queuedGoal({
      id: 'g-charcoal',
      kind: 'smelt',
      description: 'smelt 1 x charcoal',
      targetItem: 'charcoal',
      requiredCount: 1,
    })
    const downStep: DescentOption = {
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
      digName: 'dirt',
      digHarvestTool: 'pickaxe',
      digHarvestTier: 0,
      diggable: true,
    }
    const liveInventory = inventory({
      cobblestone: 67,
      stick: 2,
      birch_planks: 2,
      wooden_pickaxe: 1,
      stone_pickaxe: 1,
    })
    const withSensedTable = worldState({
      position: feet,
      inventory: liveInventory,
      signals: signals({ knownResources: [{ name: 'crafting_table', kind: 'station', position: table }] }),
      descent: [downStep],
      goal: goal({ id: 'smelt:charcoal', targetItem: 'charcoal', description: 'smelt 1 x charcoal', requiredCount: 1 }),
      goalQueue: queueWith(smeltCharcoal),
    })
    withSensedTable.craftingTables = [{ ...table, source: 'sensed' }]
    const grounded = generateGroundedCandidates(withSensedTable, craftOptions)
    const acquire = grounded.candidates.find(
      (candidate) => candidate.id === 'RETRIEVE:known:station:crafting_table:b40_29_35',
    )
    const blindCraft = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:furnace')
    const blockedBy = goalStarvationBlockedBy(null, smeltCharcoal, grounded.withheld)
    const missing = candidateStarvationMissing(grounded.withheld)
    const line = candidateStarvationLine(grounded.candidates, 'smelt:charcoal:1', false, blockedBy, missing)
    check(
      '(f) a sensed table out of reach is routed through its acquisition candidate, not CRAFT:furnace',
      acquire !== undefined &&
        acquire.meta.prereqPath === 'craft_and_place' &&
        acquire.affordance?.feasible === true &&
        blindCraft === undefined &&
        line === null,
      `acquire=${acquire?.id ?? 'none'} affordance=${JSON.stringify(acquire?.affordance ?? null)} blindCraft=${blindCraft?.id ?? 'none'} starvation=${line ?? 'none'}`,
    )

    const blacklisted = new Set([knownStationKey({ name: 'crafting_table', position: table })])
    const blockedOptions: CandidateOptions = { ...craftOptions, unreachableStations: blacklisted }
    const blockedGrounded = generateGroundedCandidates(withSensedTable, blockedOptions)
    const doomedCraft = blockedGrounded.candidates.find((candidate) => candidate.id === 'CRAFT:furnace')
    check(
      '(f) a blacklisted table cell is not re-offered as a fresh sensed CRAFT',
      doomedCraft === undefined,
      blockedGrounded.candidates.map((candidate) => candidate.id).join(',') || 'none',
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

// (12) the ascent-column capability: `safe_column` computed from real geometry ---
//
// Live starvation on main 104e689 (18:04:48, bot on a partial block at y=34.5,
// cobblestone 130, stone+wooden pickaxe held, remembered stations at y=61/63):
//   CANDIDATE_STARVATION presented=2 productive=0 goal="smelt:charcoal:1"
//   blockedBy=no_productive_action missing=["RETRIEVE:known:station:
//   crafting_table:b31_63_37:safe_column","RETRIEVE:known:station:
//   furnace:b29_61_35:safe_column"]
// The capability is now the FACT (clear or clearable adjacent column with
// support + tool + no hazard), never a bare token.
{
  const feet: Vec3Json = { x: 31, y: 34, z: 37 }
  const furnaceOnly: KnownResource[] = [{ name: 'furnace', kind: 'station', position: { x: 29, y: 61, z: 35 } }]
  const smelt = queuedGoal({
    id: 'g-charcoal',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
  })
  const charcoal = goal({ targetItem: 'charcoal', description: 'smelt 1 x charcoal', requiredCount: 1 })
  const cut: StepCut = {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: 32, y: 35, z: 37 },
    step: { x: 32, y: 35, z: 37 },
    name: 'cobblestone',
    safe: true,
    reason: 'safe',
  }

  check(
    'the safe_column capability key names the reason and the cell (never a bare token)',
    capabilityKey({ kind: 'safe_column', reason: 'no_clearance', cell: { x: 31, y: 35, z: 37 }, tool: null, tier: null }) ===
      'safe_column:no_clearance@31,35,37' &&
      capabilityKey({ kind: 'safe_column', reason: 'no_tool', cell: { x: 32, y: 35, z: 37 }, tool: 'pickaxe', tier: 0 }) ===
        'safe_column:no_tool@32,35,37:pickaxe@0',
    `no_clearance=${capabilityKey({ kind: 'safe_column', reason: 'no_clearance', cell: { x: 31, y: 35, z: 37 }, tool: null, tier: null })} no_tool=${capabilityKey({ kind: 'safe_column', reason: 'no_tool', cell: { x: 32, y: 35, z: 37 }, tool: 'pickaxe', tier: 0 })}`,
  )

  // (a) a clearable column + the held tool satisfies the capability and the
  // staircase-up clearance/ascend leg is offered; no starvation line fires.
  {
    const state = worldState({
      position: feet,
      inventory: inventory({ stone_pickaxe: 1 }),
      stepCuts: [cut],
      signals: signals({ knownResources: furnaceOnly }),
      goal: charcoal,
      goalQueue: queueWith(smelt),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const retrieve = grounded.candidates.find((candidate) => candidate.kind === 'RETRIEVE')
    const line = candidateStarvationLine(
      grounded.candidates,
      'smelt:charcoal:1',
      false,
      'no_productive_action',
      candidateStarvationMissing(grounded.withheld),
    )
    check(
      '(12a) a clearable column with the held tool is satisfied and offers the staircase-up leg',
      retrieve !== undefined &&
        retrieve.affordance?.feasible === true &&
        retrieve.meta.vertical === 'staircase-up' &&
        retrieve.meta.upDigX === 32 &&
        retrieve.meta.upDigY === 35 &&
        retrieve.meta.upDigZ === 37 &&
        line === null,
      retrieve === undefined
        ? `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] starvation=${line ?? 'none'}`
        : `meta=${JSON.stringify(retrieve.meta)} starvation=${line ?? 'none'}`,
    )
  }

  // (b) the same geometry without the tool is refused by name ONLY while no
  // placeable block is held: the cell and the required tool tier are both
  // carried, and the tool ladder stays actionable. The refusal is not weakened.
  {
    const state = worldState({
      position: feet,
      inventory: inventory({ stick: 2, birch_planks: 2 }),
      stepCuts: [cut],
      signals: signals({ knownResources: furnaceOnly }),
      goal: charcoal,
      goalQueue: queueWith(smelt),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id.includes('station:furnace'))
    const missing = withheld?.result.missingCapabilities.map(capabilityKey) ?? []
    check(
      '(12b) stone geometry without the tool and WITHOUT a placeable retains the refusal by name',
      withheld !== undefined &&
        withheld.result.reason === 'needs_ascend' &&
        missing.join(',') ===
          'placeable_block,safe_column:no_tool@32,35,37:pickaxe@0,tool:pickaxe@0',
      `missing=[${missing.join(',')}]`,
    )
  }

  // (b2) the measured live amplification (RC d54d9a8, run-mu7x7wym-onhb): the
  // same stone cut with a placeable block held (cobblestone 170) but no pickaxe
  // must NOT be blocked by `safe_column:no_tool@...:pickaxe@0`, because the
  // pillar-up mechanic needs no pickaxe at all.
  {
    const state = worldState({
      position: feet,
      inventory: inventory({ cobblestone: 170, dirt: 37, andesite: 7 }),
      stepCuts: [cut],
      signals: signals({ knownResources: furnaceOnly }),
      goal: charcoal,
      goalQueue: queueWith(smelt),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const retrieve = grounded.candidates.find((candidate) => candidate.id.includes('station:furnace'))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id.includes('station:furnace'))
    check(
      '(12b2) the same stone cut with a held placeable is feasible via the pillar plan (no pickaxe needed)',
      retrieve !== undefined &&
        retrieve.affordance?.feasible === true &&
        retrieve.meta.vertical === 'pillar' &&
        retrieve.meta.pillarPlaceName === 'cobblestone' &&
        withheld === undefined,
      retrieve === undefined
        ? `withheld=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map(capabilityKey).join(',')}]`
        : `vertical=${String(retrieve.meta.vertical)} place=${String(retrieve.meta.pillarPlaceName)} affordance=${JSON.stringify(retrieve.affordance)}`,
    )
  }

  // (c) no geometry at all refuses by name: `safe_column:no_clearance@cell`.
  {
    const state = worldState({
      position: { x: 31.5, y: 34.5, z: 37.5 },
      inventory: inventory({ dirt: 4 }),
      standable: [],
      signals: signals({ knownResources: furnaceOnly }),
      goal: charcoal,
      goalQueue: queueWith(smelt),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id.includes('station:furnace'))
    const missing = withheld?.result.missingCapabilities.map(capabilityKey) ?? []
    check(
      '(12c) absent geometry refuses as safe_column:no_clearance with the examined cell',
      withheld !== undefined && missing.join(',') === 'safe_column:no_clearance@30,35,37',
      `missing=[${missing.join(',')}]`,
    )
  }

  // (d) the live shape: the partial-block stance (standable cell one level up)
  // with cobblestone + pickaxes presents a productive ascent route.
  {
    const state = worldState({
      position: { x: 31.5, y: 34.5, z: 37.5 },
      inventory: inventory({ cobblestone: 130, stone_pickaxe: 1, wooden_pickaxe: 1 }),
      standable: [{ x: 31, y: 35, z: 37 }],
      signals: signals({
        knownResources: [
          { name: 'crafting_table', kind: 'station', position: { x: 31, y: 63, z: 37 } },
          { name: 'furnace', kind: 'station', position: { x: 29, y: 61, z: 35 } },
        ],
      }),
      goal: charcoal,
      goalQueue: queueWith(smelt),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const productive = grounded.candidates.filter(
      (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
    )
    const retrieves = productive.filter((candidate) => candidate.kind === 'RETRIEVE')
    const line = candidateStarvationLine(
      grounded.candidates,
      'smelt:charcoal:1',
      false,
      'no_productive_action',
      candidateStarvationMissing(grounded.withheld),
    )
    check(
      '(12d) the live starvation shape yields a productive ascent route (no CANDIDATE_STARVATION)',
      retrieves.length > 0 &&
        retrieves.every((candidate) => candidate.affordance?.feasible === true) &&
        line === null,
      `productive=[${productive.map((candidate) => candidate.id).join(',')}] starvation=${line ?? 'none'}`,
    )
  }

  // (e) a clear step one level up satisfies the capability without a dig plan.
  {
    const state = worldState({
      position: feet,
      inventory: inventory({ stick: 1 }),
      standable: [feet, { x: 32, y: 35, z: 37 }],
      signals: signals({ knownResources: furnaceOnly }),
      goal: charcoal,
      goalQueue: queueWith(smelt),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const retrieve = grounded.candidates.find((candidate) => candidate.kind === 'RETRIEVE')
    check(
      '(12e) a standable cell one level up is a clear ascent column (no placeable block needed)',
      retrieve !== undefined && retrieve.affordance?.feasible === true,
      retrieve === undefined
        ? `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`
        : JSON.stringify(retrieve.affordance),
    )
  }

  // (f) downward and level retrieves are unaffected by the ascend classification.
  {
    const below: Vec3Json = { x: 40, y: 29, z: 35 }
    const level: Vec3Json = { x: 40, y: 48, z: 35 }
    const downStep: DescentOption = {
      dir: 'E',
      mode: 'down',
      dx: 1,
      dz: 0,
      step: { x: 39, y: 47, z: 37 },
      wall: { x: 31, y: 48, z: 37 },
      head: { x: 31, y: 49, z: 37 },
      floor: { x: 31, y: 47, z: 37 },
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
    const oreGoal = queuedGoal({ id: 'g-ore', kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 })
    const ore: KnownResource = { name: 'iron_ore', kind: 'ore', position: below }
    const down = worldState({
      position: { x: 30, y: 48, z: 37 },
      inventory: inventory({ stone_pickaxe: 1 }),
      descent: [downStep],
      signals: signals({ knownResources: [ore] }),
      goal: goal({ id: 'collect:raw_iron', targetItem: 'raw_iron', requiredCount: 3 }),
      goalQueue: queueWith(oreGoal),
    })
    const downGrounded = generateGroundedCandidates(down, optionsWith(null))
    const downRetrieve = downGrounded.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b40_29_35')
    const levelGrounded = generateGroundedCandidates(
      worldState({
        position: { x: 30, y: 48, z: 37 },
        inventory: inventory({ stone_pickaxe: 1 }),
        signals: signals({ knownResources: [{ ...ore, position: level }] }),
        goal: goal({ id: 'collect:raw_iron', targetItem: 'raw_iron', requiredCount: 3 }),
        goalQueue: queueWith(oreGoal),
      }),
      optionsWith(null),
    )
    const levelRetrieve = levelGrounded.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b40_48_35')
    check(
      '(12f) downward and level retrieves are presented with feasible=true (unaffected)',
      downRetrieve !== undefined &&
        downRetrieve.affordance?.feasible === true &&
        levelRetrieve !== undefined &&
        levelRetrieve.affordance?.feasible === true,
      `down=${downRetrieve?.affordance?.reason ?? 'none'} level=${levelRetrieve?.affordance?.reason ?? 'none'}`,
    )
  }

  // (g) FIRST_FAILED_BOUNDARY (measured, RC d54d9a8, run-mu7x7wym-onhb):
  //   goal=collect:log:1 presented=2 productive=0 blockedBy=no_productive_action
  //   missing=["RETRIEVE:known:log:b27_65_19:safe_column:no_tool@39,12,31:pickaxe@0",
  //            "tool:pickaxe@0"]
  // Live body: pos=(39.5,11,32.3) underground, birch_planks=2 stick=2
  // cobblestone=170 dirt=37 andesite=7, NO pickaxe; log at y=65; the only upward
  // cut is stone at (39,12,31). Pillar-up needs no pickaxe, so the log RETRIEVE
  // must be offered with vertical=pillar instead of the safe_column refusal.
  {
    const liveFeet: Vec3Json = { x: 39.5, y: 11, z: 32.3 }
    const liveCut: StepCut = {
      dir: 'N',
      dx: 0,
      dz: -1,
      cut: { x: 39, y: 12, z: 31 },
      step: { x: 39, y: 12, z: 31 },
      name: 'stone',
      safe: true,
      reason: 'safe',
    }
    const liveLogGoal = queuedGoal({
      id: 'g-live-log',
      kind: 'collect',
      description: 'collect 1 x log',
      targetItem: 'log',
      requiredCount: 1,
      origin: 'mechanical',
    })
    const state = worldState({
      position: liveFeet,
      inventory: inventory({
        birch_planks: 2,
        stick: 2,
        cobblestone: 170,
        dirt: 37,
        andesite: 7,
      }),
      standable: [{ x: 39, y: 11, z: 32 }, { x: 40, y: 11, z: 32 }],
      stepCuts: [liveCut],
      signals: signals({ knownResources: [{ name: 'oak_log', kind: 'log', position: { x: 27, y: 65, z: 19 } }] }),
      goal: goal({ id: 'collect:log', description: 'collect 1 x log', targetItem: 'log', requiredCount: 1 }),
      goalQueue: queueWith(liveLogGoal),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const id = 'RETRIEVE:known:log:b27_65_19'
    const retrieve = grounded.candidates.find((candidate) => candidate.id === id)
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === id)
    const missing = grounded.withheld.flatMap((entry) => entry.result.missingCapabilities.map(capabilityKey))
    check(
      '(12g) the measured ascent boundary is feasible via pillar and NOT refused as safe_column:no_tool',
      retrieve !== undefined &&
        retrieve.affordance?.feasible === true &&
        retrieve.affordance.reason === 'reachable' &&
        retrieve.meta.vertical === 'pillar' &&
        retrieve.meta.pillarPlaceName === 'cobblestone' &&
        Number(retrieve.meta.pillarSteps) === 24 &&
        retrieve.meta.logRoute === 'ascend_then_mine' &&
        withheld === undefined &&
        !missing.some((key) => key.startsWith('safe_column')),
      retrieve === undefined
        ? `not presented; withheld=${withheld?.result.reason ?? 'none'} missing=[${missing.join(',')}]`
        : `vertical=${String(retrieve.meta.vertical)} place=${String(retrieve.meta.pillarPlaceName)} steps=${String(retrieve.meta.pillarSteps)} route=${String(retrieve.meta.logRoute)} affordance=${JSON.stringify(retrieve.affordance)} withheld=${withheld?.result.reason ?? 'none'}`,
    )
    check(
      '(12g) no safe_column/tool capability is emitted for the live log route',
      !missing.includes('tool:pickaxe@0') && !missing.some((key) => key.startsWith('safe_column')),
      `missing=[${missing.join(',')}]`,
    )
  }
}

// A coordinate blacklist restored from a previous generation must participate
// in target selection, not only in the controller's post-generation filter.
// Otherwise the nearest exploration target is regenerated, filtered out, and
// the policy is left with WAIT even though another standable target exists.
{
  const blocked: Vec3Json = { x: 2, y: 60, z: 0 }
  const alternate: Vec3Json = { x: 3, y: 60, z: 0 }
  const state = worldState({ position: BOT, standable: [BOT, blocked, alternate] })
  const grounded = generateGroundedCandidates(state, {
    ...defaultCandidateOptions,
    blacklistedMoveTargets: new Set([moveFailureKey('overworld', blocked)]),
  })
  const ids = grounded.candidates.map((candidate) => candidate.id)
  check(
    'a restored movement blacklist is applied before exploration target selection',
    !ids.includes(`MOVE:${blockId('p', blocked)}`) && ids.includes(`MOVE:${blockId('p', alternate)}`),
    `candidates=${ids.join(',')}`,
  )
}

// (13) the smelt input/fuel prerequisite is a collect route, never starvation --
//
// Measured live on 9af0096 with a REGISTERED furnace at 37,30,37 (2.7m) and no
// log held:
//   CANDIDATE_STARVATION presented=2 productive=0 goal="smelt:charcoal:1"
//   blockedBy=no_productive_action missing=[] repeat=25
// The smelt's input/fuel is now a code-owned precondition (optionSpec), and the
// candidate generator offers the same deterministic collect route, so the goal
// reports what must be collected instead of collapsing to WAIT.
{
  const liveFeet: Vec3Json = { x: 34.5, y: 32, z: 36.4 }
  const furnace: StationEntry = { x: 37, y: 30, z: 37, source: 'sensed' }
  const liveInventory = inventory({
    birch_planks: 2,
    cobblestone: 158,
    stick: 2,
    dirt: 37,
    leaf_litter: 4,
    stone_pickaxe: 1,
    coal: 7,
  })
  const log: BlockState = {
    kind: 'log',
    name: 'oak_log',
    position: { x: 33, y: 32, z: 36 },
    distance: 1.1,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 33, y: 31, z: 36 },
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
  }
  const charcoal = goal({ id: 'smelt:charcoal', targetItem: 'charcoal', description: 'smelt 1 x charcoal', requiredCount: 1 })
  const smelt = queuedGoal({
    id: 'g-charcoal',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
  })
  const live = worldState({
    position: liveFeet,
    inventory: liveInventory,
    furnaces: [furnace],
    blocks: [log],
    goal: charcoal,
    goalQueue: queueWith(smelt),
  })
  const grounded = generateGroundedCandidates(live, optionsWith(null))
  const mine = grounded.candidates.find((candidate) => candidate.id === 'MINE:b33_32_36')
  const starvation = candidateStarvationLine(grounded.candidates, 'smelt:charcoal:1', false, 'no_productive_action', [])
  const entry = smeltInputPrereq(live, optionsWith(null))
  const line = entry === null ? null : formatSmeltInputPrereq(entry)
  check(
    '(13a) the live smelt shape presents the log collect route and no starvation line',
    mine !== undefined && mine.kind === 'MINE' && mine.meta.yieldItem === 'oak_log' && starvation === null,
    `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] starvation=${starvation ?? 'none'}`,
  )
  check(
    '(13b) the mirrored SMELT_INPUT_PREREQ line names the concrete log and the inserted collect',
    line === 'SMELT_INPUT_PREREQ item=charcoal input=oak_log present=false action=insert_collect' &&
      MIRRORED_MARKERS.has('SMELT_INPUT_PREREQ'),
    `line="${line ?? 'none'}" mirrored=${MIRRORED_MARKERS.has('SMELT_INPUT_PREREQ')}`,
  )

  const held = worldState({
    position: liveFeet,
    inventory: inventory({ ...liveInventory.counts, oak_log: 1 }),
    furnaces: [furnace],
    blocks: [log],
    goal: charcoal,
    goalQueue: queueWith(smelt),
  })
  const heldGrounded = generateGroundedCandidates(held, optionsWith(null))
  const heldSmelt = heldGrounded.candidates.find((candidate) => candidate.id === 'SMELT:charcoal')
  const heldEntry = smeltInputPrereq(held, optionsWith(null))
  const heldLine = heldEntry === null ? null : formatSmeltInputPrereq(heldEntry)
  check(
    '(13c) a held log yields the SMELT candidate and the marker reports present=true',
    heldSmelt !== undefined &&
      heldLine === 'SMELT_INPUT_PREREQ item=charcoal input=oak_log present=true action=none',
    `candidates=[${heldGrounded.candidates.map((candidate) => candidate.id).join(',')}] line="${heldLine ?? 'none'}"`,
  )

  const noFuel = worldState({
    position: liveFeet,
    inventory: inventory({ raw_iron: 3, stone_pickaxe: 1 }),
    furnaces: [furnace],
    blocks: [log],
    goal: goal({ id: 'smelt:iron_ingot', targetItem: 'iron_ingot', description: 'smelt 3 x iron_ingot', requiredCount: 3 }),
    goalQueue: queueWith(
      queuedGoal({ id: 'g-iron', kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }),
    ),
  })
  const noFuelGrounded = generateGroundedCandidates(noFuel, optionsWith(null))
  const fuelMine = noFuelGrounded.candidates.find((candidate) => candidate.id === 'MINE:b33_32_36')
  const noFuelStarvation = candidateStarvationLine(noFuelGrounded.candidates, 'smelt:iron_ingot:3', false, 'no_productive_action', [])
  check(
    '(13d) a held input with no fuel is routed to the fuel producer (symmetric rule)',
    fuelMine !== undefined && fuelMine.meta.yieldItem === 'oak_log' && noFuelStarvation === null,
    `candidates=[${noFuelGrounded.candidates.map((candidate) => candidate.id).join(',')}] starvation=${noFuelStarvation ?? 'none'}`,
  )
}

// (14) the craft ingredient prerequisite is a collect route, never starvation --
//
// Measured live on main 1ded56e (the binding M2 wedge):
//   CANDIDATE_STARVATION presented=2 productive=0 goal="craft:wooden_pickaxe:1"
//   blockedBy=no_productive_action missing=["RETRIEVE:known:raw_iron:b45_13_35:tool:pickaxe@0"]
//   ABORT: wedge detected (WAIT chosen 25x)
// Live inventory birch_planks:2, stick:2, cobblestone:170 with no pickaxe: the
// recipe needs 3 planks, so the craft plan is unsatisfiable and the missing
// ingredient chain (planks <- logs) was never ordered. The generator now offers
// the same deterministic producer the option layer orders (collect log).
{
  const require = createRequire(import.meta.url)
  const recipeIndex = createRecipeIndex(require('minecraft-data')('1.21.11'))
  const craftOptions: CandidateOptions = { ...defaultCandidateOptions, recipes: recipeIndex, reachability: { memory: null } }
  const liveFeet: Vec3Json = { x: 31.5, y: 34.5, z: 37.5 }
  const liveInventory = inventory({
    birch_planks: 2,
    stick: 2,
    cobblestone: 170,
    dirt: 37,
    leaf_litter: 4,
    andesite: 7,
  })
  const pickaxeGoal = goal({
    id: 'craft:wooden_pickaxe',
    targetItem: 'wooden_pickaxe',
    description: 'craft 1 x wooden_pickaxe',
    requiredCount: 1,
  })
  const craftPick = queuedGoal({
    id: 'g-craft-pick',
    kind: 'craft',
    description: 'craft 1 x wooden_pickaxe',
    targetItem: 'wooden_pickaxe',
    requiredCount: 1,
  })
  const rememberedLog: KnownResource = { name: 'birch_log', kind: 'log', position: { x: 31, y: 63, z: 37 } }
  const remembered = worldState({
    position: liveFeet,
    inventory: liveInventory,
    standable: [{ x: 31, y: 35, z: 37 }],
    signals: signals({ knownResources: [rememberedLog] }),
    goal: pickaxeGoal,
    goalQueue: queueWith(craftPick),
  })
  const rememberedGrounded = generateGroundedCandidates(remembered, craftOptions)
  const retrieve = rememberedGrounded.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:log:b31_63_37')
  const rememberedStarvation = candidateStarvationLine(
    rememberedGrounded.candidates,
    'craft:wooden_pickaxe:1',
    false,
    goalStarvationBlockedBy(null, craftPick, rememberedGrounded.withheld),
    candidateStarvationMissing(rememberedGrounded.withheld),
  )
  check(
    '(14a) the live craft shape presents the remembered-log collect route and no starvation line',
    retrieve !== undefined &&
      retrieve.kind === 'RETRIEVE' &&
      retrieve.affordance?.feasible === true &&
      rememberedStarvation === null,
    `candidates=[${rememberedGrounded.candidates.map((candidate) => candidate.id).join(',')}] starvation=${rememberedStarvation ?? 'none'}`,
  )
  const marker = craftIngredientPrereq(remembered, craftOptions)
  const markerLine = marker === null ? null : formatCraftIngredientPrereq(marker)
  check(
    '(14b) the mirrored CRAFT_INGREDIENT_PREREQ line names the missing planks and the collect-log producer',
    markerLine === 'CRAFT_INGREDIENT_PREREQ item=wooden_pickaxe missing=birch_planks producer=collect log' &&
      MIRRORED_MARKERS.has('CRAFT_INGREDIENT_PREREQ'),
    `line="${markerLine ?? 'none'}" mirrored=${MIRRORED_MARKERS.has('CRAFT_INGREDIENT_PREREQ')}`,
  )

  const visibleLog: BlockState = {
    kind: 'log',
    name: 'oak_log',
    position: { x: 33, y: 32, z: 36 },
    distance: 1.1,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 33, y: 31, z: 36 },
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
  }
  const visible = worldState({
    position: { x: 34.5, y: 32, z: 36.4 },
    inventory: liveInventory,
    blocks: [visibleLog],
    goal: pickaxeGoal,
    goalQueue: queueWith(craftPick),
  })
  const visibleGrounded = generateGroundedCandidates(visible, craftOptions)
  const mine = visibleGrounded.candidates.find((candidate) => candidate.id === 'MINE:b33_32_36')
  const visibleStarvation = candidateStarvationLine(
    visibleGrounded.candidates,
    'craft:wooden_pickaxe:1',
    false,
    goalStarvationBlockedBy(null, craftPick, visibleGrounded.withheld),
    candidateStarvationMissing(visibleGrounded.withheld),
  )
  check(
    '(14c) a visible log is presented as the MINE route for the craft ingredient',
    mine !== undefined && mine.kind === 'MINE' && mine.meta.yieldItem === 'oak_log' && visibleStarvation === null,
    `candidates=[${visibleGrounded.candidates.map((candidate) => candidate.id).join(',')}] starvation=${visibleStarvation ?? 'none'}`,
  )

  const held = worldState({
    position: liveFeet,
    inventory: inventory({ ...liveInventory.counts, oak_log: 1 }),
    goal: pickaxeGoal,
    goalQueue: queueWith(craftPick),
  })
  const heldGrounded = generateGroundedCandidates(held, craftOptions)
  const heldCraft = heldGrounded.candidates.find((candidate) => candidate.kind === 'CRAFT')
  const heldMarker = craftIngredientPrereq(held, craftOptions)
  const heldLine = heldMarker === null ? null : formatCraftIngredientPrereq(heldMarker)
  check(
    '(14d) a held log yields the planks CRAFT step and the marker names that producer',
    heldCraft !== undefined &&
      heldCraft.id === 'CRAFT:oak_planks' &&
      heldLine === 'CRAFT_INGREDIENT_PREREQ item=wooden_pickaxe missing=oak_planks producer=craft oak_planks',
    `candidates=[${heldGrounded.candidates.map((candidate) => candidate.id).join(',')}] line="${heldLine ?? 'none'}"`,
  )
}

// (15) a bounded staircase step can leave the bot on a canopy with no safe
// downward landing in the current sensor slice. A same-level DescentOption is
// still a mechanically proven way to reposition and acquire the next descent
// observation. It must stay inside the selected furnace prerequisite envelope,
// rather than becoming an unrelated MOVE or an unsafe drop.
{
  const feet: Vec3Json = { x: -15.5, y: 71, z: 3.47 }
  const furnace: KnownResource = { name: 'furnace', kind: 'station', position: { x: 8, y: 65, z: 24 } }
  const smelt = queuedGoal({
    id: 'g-descent-recovery',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
  })
  const levelStep: DescentOption = {
    dir: 'W',
    mode: 'level',
    dx: -1,
    dz: 0,
    step: { x: -17, y: 71, z: 3 },
    wall: { x: -17, y: 71, z: 3 },
    head: { x: -17, y: 72, z: 3 },
    floor: { x: -17, y: 70, z: 3 },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: null,
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: false,
  }
  const state = worldState({
    position: feet,
    inventory: inventory({ oak_log: 1, oak_planks: 3, stick: 2 }),
    descent: [levelStep],
    signals: signals({ knownResources: [furnace] }),
    goal: goal({ id: 'smelt:charcoal', targetItem: 'charcoal', description: 'smelt 1 x charcoal', requiredCount: 1 }),
    goalQueue: queueWith(smelt),
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const retrieveId = 'RETRIEVE:known:station:furnace:b8_65_24'
  const withheld = grounded.withheld.find((entry) => entry.candidate.id === retrieveId)
  const recovery = grounded.candidates.find(
    (candidate) => candidate.kind === 'MOVE' && candidate.meta.verticalRecovery === 'safe_level_step',
  )
  check(
    '(15a) no safe down plan with a safe level step yields a reposition candidate',
    withheld !== undefined &&
      withheld.result.reason === 'needs_descend' &&
      withheld.result.missingCapabilities.some((capability) => capability.kind === 'descend_plan') &&
      recovery !== undefined &&
      recovery.target?.x === -17 &&
      recovery.target?.y === 71 &&
      recovery.target?.z === 3,
    `withheld=${withheld?.result.reason ?? 'none'} recovery=${recovery?.id ?? 'none'} candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
  check(
    '(15b) the reposition remains in the use_known_station prerequisite envelope',
    recovery !== undefined &&
      recovery.meta.capabilityAcquisition === true &&
      recovery.meta.missingCapability === 'descend_plan' &&
      recovery.meta.prerequisiteRole === 'furnace_station' &&
      recovery.meta.prereqPath === 'use_known_station',
    recovery === undefined ? 'no recovery candidate' : JSON.stringify(recovery.meta),
  )
  check(
    '(15c) no unsafe DROP/DOWN candidate is invented',
    !grounded.candidates.some((candidate) => candidate.kind === 'DESCEND' || candidate.meta.verticalRecovery === 'unsafe_drop'),
    grounded.candidates.map((candidate) => `${candidate.kind}:${candidate.id}`).join(','),
  )
}

// (16) a visible stone target below the current floor must expose the proven
// safe descent action even when ordinary MOVE candidates also exist.  The
// previous generator only called descendCandidates when the MOVE list was
// empty, so Jev received several stone MOVE targets but no way to enter the
// stone layer and looped without progress.
{
  const feet: Vec3Json = { x: 10.5, y: 78, z: -34.5 }
  const stone: BlockState = {
    kind: 'stone',
    name: 'stone',
    position: { x: 12, y: 68, z: -34 },
    distance: 10.3,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 12, y: 68, z: -35 },
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 0,
  }
  const down: DescentOption = {
    dir: 'N',
    mode: 'down',
    dx: 0,
    dz: -1,
    step: { x: 10, y: 77, z: -35 },
    wall: { x: 10, y: 78, z: -35 },
    head: { x: 10, y: 79, z: -35 },
    floor: { x: 10, y: 77, z: -35 },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'dirt',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  }
  const collect = queuedGoal({
    id: 'g-cobblestone',
    kind: 'collect',
    description: 'collect 12 x cobblestone',
    targetItem: 'cobblestone',
    requiredCount: 12,
  })
  const state = worldState({
    position: feet,
    inventory: inventory({ wooden_pickaxe: 1 }),
    blocks: [stone],
    descent: [down],
    goal: goal({ id: 'collect:cobblestone', description: 'collect 12 x cobblestone', targetItem: 'cobblestone', requiredCount: 12 }),
    goalQueue: queueWith(collect),
  })
  const grounded = generateGroundedCandidates(state, optionsWith(null))
  const moves = grounded.candidates.filter((candidate) => candidate.kind === 'MOVE')
  const descend = grounded.candidates.find((candidate) => candidate.kind === 'DESCEND')
  check(
    '(16a) underground stone target keeps MOVE and adds a safe DESCEND candidate',
    moves.length > 0 && descend !== undefined && descend.meta.safe === true && descend.meta.mode === 'down',
    `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
  check(
    '(16b) the descent candidate names the observed step geometry',
    descend !== undefined &&
      descend.target?.x === 10 &&
      descend.target?.y === 77 &&
      descend.target?.z === -35 &&
      descend.meta.stepX === 10 &&
      descend.meta.stepY === 77 &&
      descend.meta.stepZ === -35,
    descend === undefined ? 'no DESCEND candidate' : JSON.stringify(descend.meta),
  )
}

process.stdout.write(`\n${failures === 0 ? 'OK' : 'FAILURES'}: ${failures} failing check(s)\n`)
if (failures > 0) process.exit(1)
