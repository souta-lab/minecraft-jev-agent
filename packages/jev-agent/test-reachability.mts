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
import { applyReachabilityGate, blockId, craftIngredientPrereq, craftStationGap, defaultCandidateOptions, deriveReachabilityAbilities, formatCraftIngredientPrereq, formatCraftStationGap, formatSmeltInputPrereq, generateGroundedCandidates, optionsWithWithheldStationRetirements, smeltInputPrereq } from './src/candidates.ts'
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
  pillarFootingPlacement?: WorldState['pillarFootingPlacement']
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
    ...(overrides.pillarFootingPlacement === undefined ? {} : { pillarFootingPlacement: overrides.pillarFootingPlacement }),
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
  const ironOre: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 45, y: 31, z: 37 } }
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
    signals: signals({ knownResources: [{ name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 45, y: 31, z: 37 } }] }),
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
const KNOWN_LOG: KnownResource = { name: 'oak_log', kind: 'log', dimension: 'minecraft:overworld', position: FAR_ABOVE }

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
      knownResources: [{ name: 'oak_log', kind: 'log', dimension: 'minecraft:overworld', position: { x: 0, y: 60, z: 12 } }],
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

// (8b) unreachableMove parity: a plan-less walk claim to a >4-high target is a
//      guaranteed executor-side refuse, so a body-level ascend affordance must
//      not admit it (live gen-muubxz60: `retrieve_known` to dy=42 committed
//      whenever a natural ledge made ascend.available true, then died at
//      MOVE_UNREACHABLE inside the epoch's own validity check) ------------------
{
  const abilities: ReachabilityAbilities = {
    ascend: { available: true, missing: [] },
    descend: { available: false, missing: [] },
  }
  const world: ReachabilityWorld = {
    self: BOT,
    approach: { x: 0, y: 110, z: 0 },
    reach: 4.5,
    hazardAtTarget: false,
    footingSolid: true,
    headroomClear: true,
  }
  const retrieve: ReachabilityTarget = {
    candidateId: 'RETRIEVE:known:oak_log:b0_110_0',
    kind: 'RETRIEVE',
    position: FAR_ABOVE,
    barrier: null,
  }
  const routeless = evaluateReachability(retrieve, world, {}, abilities, 'unknown')
  check(
    'a plan-less retrieve to a >4-high target is needs_ascend even when the body can ascend',
    !routeless.reachable && routeless.reason === 'needs_ascend',
    JSON.stringify(routeless),
  )
  check(
    'the refusal names the plan the claim does not carry',
    routeless.missingCapabilities.some((capability) => capability.kind === 'ascend_plan'),
    JSON.stringify(routeless.missingCapabilities),
  )
  const move: ReachabilityTarget = { candidateId: 'MOVE:p0_110_0', kind: 'MOVE', position: FAR_ABOVE, barrier: null }
  const routelessMove = evaluateReachability(move, world, {}, abilities, 'unknown')
  check(
    'a plan-less move to a >4-high target is needs_ascend under the same bound',
    !routelessMove.reachable && routelessMove.reason === 'needs_ascend',
    JSON.stringify(routelessMove),
  )
  const routeOwned: ReachabilityTarget = { ...retrieve, carriesRoute: true }
  const owned = evaluateReachability(routeOwned, world, {}, abilities, 'unknown')
  check(
    'a retrieve carrying its own route contract is admitted on the plan',
    owned.reachable && owned.reason === 'reachable',
    JSON.stringify(owned),
  )
  const otherKind: ReachabilityTarget = { candidateId: 'STEP:p0_110_0', kind: 'STEP', position: FAR_ABOVE, barrier: null }
  const stepped = evaluateReachability(otherKind, world, {}, abilities, 'unknown')
  check(
    'a non-MOVE/RETRIEVE kind keeps the body-level verdict (its own executor bound)',
    stepped.reachable && stepped.reason === 'reachable',
    JSON.stringify(stepped),
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
      knownResources: [{ name: 'furnace', kind: 'station', dimension: 'minecraft:overworld', position: { x: 29, y: 61, z: 35 } }],
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
    'the live refusal names the binding headroom cell without inventing a harvest-tool need',
    missing.length === 1 && missing[0] === 'headroom',
    JSON.stringify(withheld?.result.missingCapabilities ?? []),
  )
  check(
    'the live marker pair matches the required observability format',
    withheld !== undefined &&
      formatReachability(
        { candidateId: id, kind: 'RETRIEVE', position: { x: 29, y: 61, z: 35 }, barrier: null },
        withheld.result,
      ) === 'REACHABILITY target=29,61,35 reachable=false reason=needs_ascend missing=[headroom@39,10,33]' &&
      formatCandidateWithheld(id, withheld.result.reason) === `CANDIDATE_WITHHELD reason=needs_ascend candidate=${id}`,
    withheld === undefined
      ? 'no withheld record'
      : formatReachability(
          { candidateId: id, kind: 'RETRIEVE', position: { x: 29, y: 61, z: 35 }, barrier: null },
          withheld.result,
        ),
  )
}

// (9b) live y54 portal ascent: current AABB blocker must close CAN ----------------
{
  const base = {
    position: { x: 10.6, y: 54, z: 25.4 },
    inventory: inventory({ cobblestone: 290 }),
    // Live restart shape: there IS a clear adjacent step at y55, but the
    // candidate itself carries an explicit pillar plan in the current column.
    // That alternate fact must not make the concrete pillar action executable.
    standable: [{ x: 10, y: 54, z: 25 }, { x: 11, y: 55, z: 25 }],
  }
  const blocker = { x: 10, y: 55, z: 24 }
  const blockedState = worldState({
    ...base,
    headroomCuts: [{ pos: blocker, name: 'stone', safe: true, reason: 'safe', currentFootprint: true }],
    blocks: [
      {
        kind: 'stone',
        name: 'stone',
        position: blocker,
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
  const blocked = deriveReachabilityAbilities(blockedState, { x: 26, y: 67, z: 9 })
  const headroom = blocked.ascend.missing.find((capability) => capability.kind === 'headroom')
  check(
    'live y54 adjacent AABB blocker closes ascent CAN at the exact executor blocker cell',
    !blocked.ascend.available &&
      headroom?.kind === 'headroom' &&
      headroom.cell?.x === 10 &&
      headroom.cell?.y === 55 &&
      headroom.cell?.z === 24,
    `available=${blocked.ascend.available} missing=[${blocked.ascend.missing.map(capabilityKey).join(',')}]`,
  )

  const stableNeighbourOnly = worldState({
    ...base,
    headroomCuts: [{ pos: blocker, name: 'stone', safe: true, reason: 'safe', currentFootprint: false }],
  })
  const unblocked = deriveReachabilityAbilities(stableNeighbourOnly, { x: 26, y: 67, z: 9 })
  check(
    'adjacent clearance candidates kept only for id stability do not falsely close current ascent CAN',
    unblocked.ascend.available && !unblocked.ascend.missing.some((capability) => capability.kind === 'headroom'),
    `available=${unblocked.ascend.available} missing=[${unblocked.ascend.missing.map(capabilityKey).join(',')}]`,
  )

  const unknownState = worldState({
    ...base,
    headroomCuts: [{
      pos: { x: 10, y: 56, z: 25 },
      name: 'unknown',
      safe: false,
      reason: 'cell is unloaded/unknown',
      currentFootprint: true,
    }],
  })
  const unknown = deriveReachabilityAbilities(unknownState, { x: 26, y: 67, z: 9 })
  check(
    'an unknown current-footprint headroom cell closes CAN without inventing a clearance action',
    !unknown.ascend.available &&
      unknown.ascend.missing.some(
        (capability) => capability.kind === 'headroom' && capability.cell?.x === 10 && capability.cell?.y === 56 && capability.cell?.z === 25,
      ),
    `available=${unknown.ascend.available} missing=[${unknown.ascend.missing.map(capabilityKey).join(',')}]`,
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

  const tableBelow: KnownResource = { name: 'crafting_table', kind: 'station', dimension: 'minecraft:overworld', position: { x: 40, y: 29, z: 35 } }
  const tableAbove: KnownResource = { name: 'crafting_table', kind: 'station', dimension: 'minecraft:overworld', position: { x: 20, y: 65, z: 27 } }
  const feet = { x: Math.floor(bot.x), y: Math.floor(bot.y), z: Math.floor(bot.z) }

  // (a) planks + sticks held, and the ONLY remembered table is unreachable (below
  // and above) because its own route needs the very pickaxe being crafted. A
  // withheld station retrieve is a cell that CANNOT be reached right now, so it
  // is not usable and must not block the local table craft: the station ladder
  // offers `CRAFT:crafting_table` (2x2, materials held) and the goal keeps its
  // own typed withholding for the station. This is the dc54ff4 recovery, restored
  // for the retired-station case and pinned live by test-tool-recovery
  // (run-mubobiq6-12onv: the body idled forever with table materials in hand).
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
      // The mirrored gap reads the SAME withheld set the gate derived the
      // recovery from, so the offered craft and the logged fact agree.
      const gap = craftStationGap(state, optionsWithWithheldStationRetirements(craftOptions, grounded.withheld))
      check(
        `(a) an unreachable remembered table no longer suppresses the local table craft ${scenario.label}`,
        duplicateTable !== undefined && gap === null,
        `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] recovery=${duplicateTable?.id ?? 'none'} gap=${gap === null ? 'none' : formatCraftStationGap(gap)}`,
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
      signals: signals({ knownResources: [{ name: 'crafting_table', kind: 'station', dimension: 'minecraft:overworld', position: { x: 32, y: 48, z: 37 } }] }),
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
      signals: signals({ knownResources: [{ name: 'crafting_table', kind: 'station', dimension: 'minecraft:overworld', position: table }] }),
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
        knownResources: [{ name: 'oak_log', kind: 'log', dimension: 'minecraft:overworld', position: { x: 30, y: 48, z: 50 } }],
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
  const furnaceOnly: KnownResource[] = [{ name: 'furnace', kind: 'station', dimension: 'minecraft:overworld', position: { x: 29, y: 61, z: 35 } }]
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

  // (b) a safe step cut is a clearance route even without its harvest tool or a
  // placeable block. The route does not need the block's drop: it only opens the
  // supported step, matching the clearance contract in test-vertical-plan.
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
    const retrieve = grounded.candidates.find((candidate) => candidate.id.includes('station:furnace'))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id.includes('station:furnace'))
    check(
      '(12b) a safe clearance staircase stays feasible without a pickaxe or pillar block',
      retrieve !== undefined &&
        retrieve.affordance?.feasible === true &&
        retrieve.meta.vertical === 'staircase-up' &&
        retrieve.meta.upDigX === 32 &&
        retrieve.meta.upDigY === 35 &&
        retrieve.meta.upDigZ === 37 &&
        withheld === undefined,
      retrieve === undefined
        ? `withheld=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map(capabilityKey).join(',')}]`
        : `vertical=${String(retrieve.meta.vertical)} dig=${String(retrieve.meta.upDigX)},${String(retrieve.meta.upDigY)},${String(retrieve.meta.upDigZ)} affordance=${JSON.stringify(retrieve.affordance)}`,
    )
  }

  // (b2) with both a safe stone cut and a held placeable, the grounded staircase
  // remains the plan returned by the shared vertical solver. The pure planner
  // pins this mechanically grounded route; this gate must not turn it into a
  // false tool refusal or silently change its geometry.
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
      '(12b2) the same safe stone cut with a held placeable remains feasible via staircase-up',
      retrieve !== undefined &&
        retrieve.affordance?.feasible === true &&
        retrieve.meta.vertical === 'staircase-up' &&
        retrieve.meta.upDigX === 32 &&
        retrieve.meta.upDigY === 35 &&
        retrieve.meta.upDigZ === 37 &&
        withheld === undefined,
      retrieve === undefined
        ? `withheld=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map(capabilityKey).join(',')}]`
        : `vertical=${String(retrieve.meta.vertical)} dig=${String(retrieve.meta.upDigX)},${String(retrieve.meta.upDigY)},${String(retrieve.meta.upDigZ)} affordance=${JSON.stringify(retrieve.affordance)}`,
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
          { name: 'crafting_table', kind: 'station', dimension: 'minecraft:overworld', position: { x: 31, y: 63, z: 37 } },
          { name: 'furnace', kind: 'station', dimension: 'minecraft:overworld', position: { x: 29, y: 61, z: 35 } },
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
    const ore: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: below }
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
  // cut is stone at (39,12,31). The cut is a supported clearance staircase and
  // needs no drop, so the RETRIEVE must remain executable without inventing a
  // safe_column:no_tool refusal.
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
      signals: signals({ knownResources: [{ name: 'oak_log', kind: 'log', dimension: 'minecraft:overworld', position: { x: 27, y: 65, z: 19 } }] }),
      goal: goal({ id: 'collect:log', description: 'collect 1 x log', targetItem: 'log', requiredCount: 1 }),
      goalQueue: queueWith(liveLogGoal),
    })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const id = 'RETRIEVE:known:log:b27_65_19'
    const retrieve = grounded.candidates.find((candidate) => candidate.id === id)
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === id)
    const missing = grounded.withheld.flatMap((entry) => entry.result.missingCapabilities.map(capabilityKey))
    check(
      '(12g) the measured ascent boundary is feasible via clearance staircase without safe_column:no_tool',
      retrieve !== undefined &&
        retrieve.affordance?.feasible === true &&
        retrieve.affordance.reason === 'reachable' &&
        retrieve.meta.vertical === 'staircase-up' &&
        retrieve.meta.upDigX === 39 &&
        retrieve.meta.upDigY === 12 &&
        retrieve.meta.upDigZ === 31 &&
        retrieve.meta.logRoute === 'ascend_then_mine' &&
        withheld === undefined &&
        !missing.some((key) => key.startsWith('safe_column')),
      retrieve === undefined
        ? `not presented; withheld=${withheld?.result.reason ?? 'none'} missing=[${missing.join(',')}]`
        : `vertical=${String(retrieve.meta.vertical)} dig=${String(retrieve.meta.upDigX)},${String(retrieve.meta.upDigY)},${String(retrieve.meta.upDigZ)} route=${String(retrieve.meta.logRoute)} affordance=${JSON.stringify(retrieve.affordance)} withheld=${withheld?.result.reason ?? 'none'}`,
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
  const rememberedLog: KnownResource = { name: 'birch_log', kind: 'log', dimension: 'minecraft:overworld', position: { x: 31, y: 63, z: 37 } }
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
// downward landing in the current sensor slice. A same-level DescentOption is a
// recovery MOVE only when its target is also in the canonical usable-stand set
// that the MOVE guard enforces. A merely `safe` probe can have collidable leaf
// support, which is not a legal destination under that contract.
{
  const feet: Vec3Json = { x: -15.5, y: 71, z: 3.47 }
  const furnace: KnownResource = { name: 'furnace', kind: 'station', dimension: 'minecraft:overworld', position: { x: 8, y: 65, z: 24 } }
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
    landingUsable: true,
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

  const canopyState = worldState({
    position: feet,
    inventory: inventory({ oak_log: 1, oak_planks: 3, stick: 2 }),
    descent: [{ ...levelStep, landingUsable: false }],
    signals: signals({ knownResources: [furnace] }),
    goal: goal({ id: 'smelt:charcoal', targetItem: 'charcoal', description: 'smelt 1 x charcoal', requiredCount: 1 }),
    goalQueue: queueWith(smelt),
  })
  const canopyGrounded = generateGroundedCandidates(canopyState, optionsWith(null))
  const canopyRecovery = canopyGrounded.candidates.find(
    (candidate) => candidate.kind === 'MOVE' && candidate.meta.verticalRecovery === 'safe_level_step',
  )
  check(
    '(15d) a safe level probe without a canonical usable landing is not offered as MOVE',
    canopyRecovery === undefined,
    `landingUsable=${canopyState.descent?.[0]?.landingUsable} candidates=[${canopyGrounded.candidates.map((candidate) => candidate.id).join(',')}]`,
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

// (17) THE LIVE M3 SHAPE: a body FAR above a target that requires descending ---
//
// Live run-muc3qbug-18vg3 (main 35dfd29, m3-live): the body stood at
// (119.7,75,-14.5) with the lit Nether gate at (27,67,9) - ~96 blocks away and
// 8 blocks BELOW - while `option=front_enter_nether`. `state.descent` is built
// from the body's OWN four cardinal cells, so a surface cell with no safe
// dig-down step made the gate `reachable=false reason=needs_descend
// missing=["descend_plan"]`, and because the fingerprint does not move with the
// body the same proof then held forever (`suppressed=true`). Every offered
// MOVE/MINE stayed local, so the body mined leaves under the enter-nether
// option instead of walking to its own gate.
//
// The general rule this fixture pins: a vertical gap is a LOCAL affordance only
// while the body is at the destination column or cannot travel at all. A body
// with a walkable frontier gets the far-below target as a travel leg; a descent
// that is genuinely impossible stays a TYPED refusal naming the missing
// precondition and the cell.
{
  const FEET: Vec3Json = { x: 119.7, y: 75, z: -14.5 }
  const GATE: Vec3Json = { x: 27, y: 67, z: 9 }
  // The body stands on open ground: a connected walking component that reaches
  // the 5x5 scan edge and is larger than the stranded pocket bound, plus the
  // distant standable cells the wider world offers. A bare few-cell list is a
  // closed pocket under the component test (`canTravel` would then be false).
  const FRONTIER: Vec3Json[] = [
    FEET,
    { x: 118, y: 75, z: -14 },
    { x: 118, y: 75, z: -15 },
    { x: 117, y: 75, z: -14 },
    { x: 117, y: 75, z: -15 },
    { x: 118, y: 75, z: -13 },
    { x: 119, y: 75, z: -13 },
    { x: 120, y: 75, z: -14 },
    { x: 120, y: 75, z: -15 },
    { x: 121, y: 75, z: -15 },
    { x: 117, y: 75, z: -13 },
    { x: 110, y: 74, z: -12 },
    { x: 100, y: 73, z: -10 },
  ]
  const gateMove = (target: Vec3Json): Candidate => ({
    id: `MOVE:${blockId('p', target)}`,
    kind: 'MOVE',
    label: `walk to the lit gate at (${target.x},${target.y},${target.z})`,
    targetName: null,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 7, x: target.x, y: target.y, z: target.z },
  })
  // Every cardinal step is refused by the ABSENT LANDING SUPPORT: the canopy
  // shape the live sensor reported (the body stands on a leaf/ledge cell whose
  // neighbours have no solid support one block down).
  const noSupportDown = (dir: DescentOption['dir'], dx: number, dz: number): DescentOption => ({
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: Math.floor(FEET.x) + dx, y: 74, z: Math.floor(FEET.z) + dz },
    wall: { x: Math.floor(FEET.x) + dx, y: 75, z: Math.floor(FEET.z) + dz },
    head: { x: Math.floor(FEET.x) + dx, y: 76, z: Math.floor(FEET.z) + dz },
    floor: { x: Math.floor(FEET.x) + dx, y: 74, z: Math.floor(FEET.z) + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: false,
    reason: 'no solid support at (118,73,-14)',
    refusal: 'no_support',
    digName: 'oak_leaves',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  })
  const pool = [noSupportDown('E', 1, 0), noSupportDown('W', -1, 0), noSupportDown('N', 0, -1)]

  // (17a) the live shape: far below + a walkable frontier -> OFFERED, never
  // withheld, and no suppression proof is recorded for the unchanged shape.
  {
    const memory = new StateFingerprintMemory({ maxEntries: 16 })
    const state = worldState({ position: FEET, standable: FRONTIER, descent: pool })
    const first = applyReachabilityGate([gateMove(GATE)], state, optionsWith(memory))
    const second = applyReachabilityGate([gateMove(GATE)], state, optionsWith(memory))
    const id = gateMove(GATE).id
    const presented = first.candidates.some((candidate) => candidate.id === id)
    check(
      '(17a) the live shape: a target 8 blocks below and ~96 blocks away is PRESENTED as a travel leg',
      presented &&
        first.withheld.length === 0 &&
        second.candidates.some((candidate) => candidate.id === id) &&
        second.withheld.length === 0,
      `presented=${presented} withheld=[${first.withheld.map((entry) => `${entry.candidate.id}:${entry.result.reason}`).join(',')}] second=${second.withheld.length}`,
    )
    check(
      '(17a) the unchanged far-descent shape records NO suppression proof',
      !memory.check(id, 'any').known && memory.size() === 0,
      `known=${memory.check(id, 'any').known} size=${memory.size()}`,
    )
  }

  // (17b) the SAME target from a body confined to its own column: the local
  // descent pool IS the binding affordance, so the refusal stands - and it now
  // names the mechanical precondition and the cell instead of a bare token.
  {
    const state = worldState({ position: FEET, standable: [FEET], descent: pool })
    const grounded = applyReachabilityGate([gateMove(GATE)], state, optionsWith(null))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === gateMove(GATE).id)
    const keys = withheld?.result.missingCapabilities.map(capabilityKey) ?? []
    check(
      '(17b) a stranded body above a far target keeps needs_descend with a TYPED missing precondition',
      withheld !== undefined &&
        withheld.result.reason === 'needs_descend' &&
        keys.length === 1 &&
        keys[0] === `descend_plan:no_support@${Math.floor(FEET.x) + 1},74,${Math.floor(FEET.z)}:oak_leaves`,
      `reason=${withheld?.result.reason ?? 'none'} missing=[${keys.join(',')}]`,
    )
    check(
      '(17b) the refusal is bounded and named, and the withheld record still carries the body change to make',
      withheld?.suppressed === false &&
        grounded.withheld.length === 1 &&
        withheld?.result.missingCapabilities[0]?.kind === 'descend_plan',
      `suppressed=${withheld?.suppressed ?? 'none'} withheld=${grounded.withheld.length}`,
    )
  }

  // (17c) a genuinely impossible target below: the hazard fact refuses it
  // truthfully, at any range.
  {
    const state = worldState({
      position: FEET,
      standable: FRONTIER,
      descent: pool,
      blocks: [
        {
          kind: 'hazard',
          name: 'lava',
          position: { x: 27, y: 68, z: 9 },
          distance: 96,
          diggable: false,
          inReach: false,
          hasAdjacentStandable: false,
          adjacentStandable: null,
          yield: null,
          harvestTool: null,
          harvestTier: null,
        },
      ],
    })
    const grounded = applyReachabilityGate([gateMove(GATE)], state, optionsWith(null))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === gateMove(GATE).id)
    check(
      '(17c) a target below with lava at it is hazard_blocked, not offered and not silently dropped',
      withheld !== undefined &&
        withheld.result.reason === 'hazard_blocked' &&
        !grounded.candidates.some((candidate) => candidate.id === gateMove(GATE).id),
      `reason=${withheld?.result.reason ?? 'none'} offered=${grounded.candidates.map((candidate) => candidate.id).join(',')}`,
    )
  }

  // (17d) bedrock under the body: the typed refusal names `unbreakable` and the
  // block, so the dead end is actionable (no tool can fix bedrock).
  {
    const bedrock = { ...noSupportDown('E', 1, 0), safe: false, reason: 'bedrock floor is not breakable', refusal: 'unbreakable' as const, digName: 'bedrock', diggable: false }
    const state = worldState({ position: FEET, standable: [FEET], descent: [bedrock] })
    const grounded = applyReachabilityGate([gateMove(GATE)], state, optionsWith(null))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === gateMove(GATE).id)
    const keys = withheld?.result.missingCapabilities.map(capabilityKey) ?? []
    check(
      '(17d) a bedrock descent refusal names unbreakable + the block + the cell',
      keys[0] === `descend_plan:unbreakable@${Math.floor(FEET.x) + 1},74,${Math.floor(FEET.z)}:bedrock`,
      `missing=[${keys.join(',')}]`,
    )
  }

  // (17e) the substitute pool: when a below target IS withheld, the acquisition
  // pass must offer a candidate that ADVANCES toward that target (travel to the
  // descent cell), not only local work.
  {
    const NEAR_GATE: Vec3Json = { x: 0, y: 30, z: 10 }
    const BODY: Vec3Json = { x: 0, y: 60, z: 0 }
    const FRONTIER_NEAR: Vec3Json[] = [BODY, { x: 0, y: 60, z: 3 }, { x: 0, y: 60, z: 6 }]
    const state = worldState({ position: BODY, standable: FRONTIER_NEAR, descent: [] })
    const grounded = applyReachabilityGate([gateMove(NEAR_GATE)], state, optionsWith(null))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === gateMove(NEAR_GATE).id)
    const approach = grounded.candidates.find(
      (candidate) => candidate.meta.verticalRecovery === 'descend_approach',
    )
    const advances =
      approach?.target !== null &&
      approach?.target !== undefined &&
      Math.hypot(approach.target.x - NEAR_GATE.x, approach.target.y - NEAR_GATE.y, approach.target.z - NEAR_GATE.z) <=
        Math.hypot(BODY.x - NEAR_GATE.x, BODY.y - NEAR_GATE.y, BODY.z - NEAR_GATE.z) - 1
    check(
      '(17e) a withheld descent target yields a travel leg that advances toward it',
      withheld?.result.reason === 'needs_descend' &&
        approach !== undefined &&
        approach.kind === 'MOVE' &&
        approach.meta.missingCapability === 'descend_plan' &&
        advances === true,
      `withheld=${withheld?.result.reason ?? 'none'} approach=${approach === undefined ? 'none' : `${approach.id}->${approach.target?.x},${approach.target?.y},${approach.target?.z}`}`,
    )
  }
}

// (18) THE OPERATOR'S FROZEN BODY: a withheld ascent must name WHICH concrete HOW
// was rejected, never the bare `ascend_plan` token.
//
// Live (the floated gate; the body frozen for 2+ minutes at (22.7,66,4.5), 834
// identical lines):
//   REACHABILITY candidate=ASCEND:habitat:p29_68_8 kind=MOVE reachable=false
//     reason=needs_ascend missing=["ascend_plan"]
//     fingerprint=rv1|29,68,8|needs_ascend|missing=[ascend_plan]|gap=ascend_far|place=1|tools=[]|hazard=0|approach=1
//
// `place=1` (a pillar block IS held), `hazard=0`, no tool fact, clear headroom and
// a safe column: the ONLY unnamed precondition left was the live FOOTING, so the
// bare token was the whole evidence and the body could only retry it.
{
  const state = worldState({
    position: { x: 22.7, y: 66, z: 4.5 },
    inventory: inventory({ cobblestone: 177, dirt: 128, soul_soil: 222, oak_log: 81 }),
    // the body's own column is not in the sensed stand set (the live ledge), but
    // the sensor DOES see a walkable step one level up beside it - so the ascent
    // column is `clear`, not `refuse`, and the only unnamed fact left is support
    standable: [{ x: 23, y: 67, z: 4 }],
  })
  const target: Vec3Json = { x: 29, y: 71, z: 8 }
  const column = {
    placeable: { name: 'cobblestone', count: 177 },
    columnSafe: true,
    footingSolid: false,
    headroomClear: true,
    headroomCell: null,
  }
  const abilities = deriveReachabilityAbilities(state, target, column)
  const keys = abilities.ascend.missing.map((capability) => capabilityKey(capability))
  check(
    '(18a) a grounded pillar with no proven footing names the fact instead of the bare ascend_plan token',
    abilities.ascend.available === false &&
      keys.includes('ascend_plan:pillar:no_footing@22,66,4') &&
      !keys.includes('ascend_plan'),
    `available=${abilities.ascend.available} missing=[${keys.join(',')}]`,
  )
  const footingState = worldState({
    position: { x: 22.7, y: 66, z: 4.5 },
    inventory: inventory({ dirt: 1 }),
    standable: [{ x: 23, y: 67, z: 4 }],
    pillarFootingPlacement: {
      target: { x: 22, y: 65, z: 4 },
      reference: { x: 21, y: 65, z: 4 },
      replacedBlock: 'water',
    },
    signals: signals({ knownResources: [KNOWN_LOG] }),
  })
  const footingGrounded = generateGroundedCandidates(footingState, optionsWith(null))
  const footingPlace = footingGrounded.candidates.find((candidate) => candidate.meta.pillarFooting === true)
  const footingWithheld = footingGrounded.withheld.find((entry) => entry.candidate.id === `RETRIEVE:known:oak_log:b${FAR_ABOVE.x}_${FAR_ABOVE.y}_${FAR_ABOVE.z}`)
  check(
    '(18b) no-footing ascent exposes a verified PLACE prerequisite when the sensor proves a replaceable under-body cell',
    footingWithheld?.result.missingCapabilities.some((capability) => capabilityKey(capability).includes('ascend_plan:pillar:no_footing')) === true &&
      footingPlace?.kind === 'PLACE' &&
      footingPlace.itemName === 'dirt' &&
      footingPlace.target?.x === 22 && footingPlace.target?.y === 65 && footingPlace.target?.z === 4 &&
      footingPlace.meta.capabilityAcquisition === true &&
      String(footingPlace.meta.missingCapability).includes('ascend_plan:pillar:no_footing'),
    `place=${footingPlace?.id ?? 'none'} missing=${String(footingPlace?.meta.missingCapability ?? 'none')} withheld=${footingWithheld?.result.reason ?? 'none'}`,
  )

  check(
    '(18c) the typed key never drifts for a legacy bare token, so existing fingerprints are unchanged',
    capabilityKey({ kind: 'ascend_plan' }) === 'ascend_plan' &&
      capabilityKey({ kind: 'ascend_plan', plan: null, reason: null, cell: null }) === 'ascend_plan' &&
      capabilityKey({ kind: 'ascend_plan', plan: 'staircase-up', reason: 'plan_unavailable', cell: { x: 22, y: 66, z: 4 } }) ===
        'ascend_plan:staircase-up:plan_unavailable@22,66,4',
    `bare=${capabilityKey({ kind: 'ascend_plan' })}`,
  )
}

{
  // A column that CAN support the climb is still available: the fix names the
  // absent fact, it does not widen or narrow what is offered.
  const state = worldState({
    position: { x: 22.7, y: 66, z: 4.5 },
    inventory: inventory({ cobblestone: 177 }),
    standable: [{ x: 23, y: 67, z: 4 }],
  })
  const supported = deriveReachabilityAbilities(state, { x: 29, y: 71, z: 8 }, {
    placeable: { name: 'cobblestone', count: 177 },
    columnSafe: true,
    footingSolid: true,
    headroomClear: true,
    headroomCell: null,
  })
  const blocked = deriveReachabilityAbilities(state, { x: 29, y: 71, z: 8 }, {
    placeable: { name: 'cobblestone', count: 177 },
    columnSafe: true,
    footingSolid: true,
    headroomClear: false,
    headroomCell: { x: 22, y: 68, z: 4 },
  })
  const blockedKeys = blocked.ascend.missing.map((capability) => capabilityKey(capability))
  check(
    '(18c) availability is unchanged, and the fact this branch already named stays named',
    supported.ascend.available === true &&
      supported.ascend.missing.length === 0 &&
      blockedKeys.includes('headroom@22,68,4') &&
      !blockedKeys.includes('ascend_plan'),
    `supported=${supported.ascend.available} blocked=[${blockedKeys.join(',')}]`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'OK' : 'FAILURES'}: ${failures} failing check(s)\n`)
if (failures > 0) process.exit(1)
