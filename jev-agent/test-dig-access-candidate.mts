// test-dig-access-candidate.mts - CANDIDATE_GENERATION defect.
//
// Frozen run run-mu8zc40y-124ev (source 4b24c07), boundary = third log
// acquisition (`collect 3 x log`) with haveCount=2. The candidate generator
// emitted ONLY exploration `MOVE:p3_69_5` / `MOVE:p4_69_4` and silently skipped
// 13 blocked logs (`canDig=false`, no walk-up access). Jev selected the moves
// repeatedly, the executor reported `status=done` with `progressDelta=0`, and
// `MOVE_EFFICIENCY` collapsed to 2-4% with `progress_stall`. No productive log
// candidate was ever offered.
//
// Root cause: a dig target with no walk-up access was dropped from the pool
// instead of being given an ACCESS/stand candidate derived from the SAME #244
// interaction-stand geometry the station path already uses. When a stand from
// which the block becomes diggable exists, walking to it must be an explicit
// dig prerequisite. When NO reachable stand exists the target must be retired
// explicitly (a typed withheld refusal recorded in the suppression memory),
// never silently skipped every tick.
//
// Pure: no bot, no network, no model. The access stand is a fact the caller
// supplies through `CandidateOptions.reachability.digApproach`; the controller
// wires it to the live #244 `interactionStandCandidates` probe, tests inject it.
//
// Run: node --test test-dig-access-candidate.mts
import { readFileSync } from 'node:fs'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { StateFingerprintMemory } from './src/moveFailMemory.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey, formatDigAccessRetired } from './src/reachability.ts'
import type { DigApproachFact } from './src/reachability.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, Vec3Json, WorldState } from './src/state.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const runtimeControllerSource = (): string =>
  `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`

// --- world builders ------------------------------------------------------------

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_ACCESS',
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

function goal(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string): QueuedGoal {
  return {
    id: `g-${targetItem}`,
    kind: 'collect',
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  position: Vec3Json
  blocks: BlockState[]
  inventory?: InventoryState
  goal: GoalState
  standable?: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: overrides.blocks,
    terrain: { standable: overrides.standable ?? [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: overrides.goal,
    goalQueue: queueWith(queuedGoal(overrides.goal.targetItem ?? 'log')),
    recentEvents: [],
    signals: signals(),
  }
}

/**
 * The live #244 stand geometry, injected: for the fixture block it returns the
 * passable+supported cell one block east and one block up - the stance
 * `findAdjacentStandable` never samples, so the sensor reports
 * `hasAdjacentStandable=false` while a real, in-reach access stand exists.
 */
const BLOCK: Vec3Json = { x: 10, y: 64, z: 0 }
const ACCESS_STAND: Vec3Json = { x: 11, y: 65, z: 0 }
const BOT: Vec3Json = { x: 16.5, y: 64, z: 0.5 }

/** A blocked log: out of reach, no walk-up access, hand-harvestable. */
function blockedLog(): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position: BLOCK,
    distance: Math.hypot(BOT.x - BLOCK.x, BOT.y - BLOCK.y, BOT.z - BLOCK.z),
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
  }
}

/** A blocked log beyond the ordinary walkable vertical gap. */
function highBlockedLog(): BlockState {
  const position = { ...BLOCK, y: 69 }
  return {
    ...blockedLog(),
    position,
    distance: Math.hypot(BOT.x - position.x, BOT.y - position.y, BOT.z - position.z),
  }
}

/** A blocked stone: out of reach, no walk-up access, needs the held pickaxe. */
function blockedStone(): BlockState {
  return {
    kind: 'stone',
    name: 'stone',
    position: BLOCK,
    distance: Math.hypot(BOT.x - BLOCK.x, BOT.y - BLOCK.y, BOT.z - BLOCK.z),
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 0,
  }
}

type DigProbe = (block: Vec3Json) => DigApproachFact

function optionsWith(probe: DigProbe | null, memory: StateFingerprintMemory | null = null): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: { memory, digApproach: probe } }
}

const standExists: DigProbe = () => ({ approach: ACCESS_STAND, path: 'reachable' })
const standNoPath: DigProbe = () => ({ approach: ACCESS_STAND, path: 'no_path' })
const noStand: DigProbe = () => ({ approach: null, path: null })

function accessCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.id.startsWith('ACCESS:'))
}

async function main(): Promise<void> {
  process.stdout.write('dig access candidate: a blocked dig target gets an access stand, or is retired\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (a) RED: blocked log + a reachable #244 access stand => an ACCESS candidate
  // IS offered (today the log is pushed to tunnelTargets and never surfaced).
  {
    const state = worldState({ position: BOT, blocks: [blockedLog()], goal: goal('log') })
    const grounded = generateGroundedCandidates(state, optionsWith(standExists))
    const access = grounded.candidates.find((candidate) => candidate.id === 'ACCESS:b10_64_0')
    await check(
      '(a) a blocked log with a reachable access stand yields an ACCESS MOVE to that stand',
      access !== undefined &&
        access.kind === 'MOVE' &&
        access.meta.digAccess === true &&
        access.target !== null &&
        access.target.x === ACCESS_STAND.x &&
        access.target.y === ACCESS_STAND.y &&
        access.target.z === ACCESS_STAND.z &&
        access.meta.targetBlockX === BLOCK.x &&
        access.meta.targetBlockY === BLOCK.y &&
        access.meta.targetBlockZ === BLOCK.z,
      `access=${access === undefined ? 'none' : `${access.id} -> ${access.target?.x},${access.target?.y},${access.target?.z}`} candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
    await check(
      '(a) the access candidate is explicitly a dig prerequisite (not a plain walk-up MOVE)',
      access !== undefined &&
        access.affordance?.feasible === true &&
        !(access.id === 'MOVE:b10_64_0'),
      `affordance=${JSON.stringify(access?.affordance ?? null)}`,
    )
  }

  // (a2) A stand that exists but has NO canDig=false path is not a reachable
  // access: no ACCESS MOVE may be offered for it.
  {
    const state = worldState({ position: BOT, blocks: [blockedLog()], goal: goal('log') })
    const grounded = generateGroundedCandidates(state, optionsWith(standNoPath))
    const access = accessCandidates(grounded.candidates)
    await check(
      '(a2) a stand with no canDig=false path never becomes an ACCESS MOVE',
      access.length === 0,
      `access=[${access.map((c) => c.id).join(',')}] candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
  }

  // (b) RED: a blocked dig target with NO reachable access is not offered AND is
  // retired explicitly - the withheld refusal is recorded in the suppression
  // memory so the same target does not re-appear as a fresh offer every tick.
  {
    const memory = new StateFingerprintMemory()
    const state = worldState({
      position: BOT,
      blocks: [blockedStone()],
      inventory: inventory({ wooden_pickaxe: 1 }),
      goal: goal('cobblestone'),
    })
    const first = generateGroundedCandidates(state, optionsWith(noStand, memory))
    const firstId = 'ACCESS:b10_64_0'
    const firstAccess = first.candidates.find((candidate) => candidate.id === firstId)
    const firstWithheld = first.withheld.find((entry) => entry.candidate.id === firstId)
    await check(
      '(b) a dig target with no reachable access is not offered, but is explicitly withheld',
      firstAccess === undefined &&
        firstWithheld !== undefined &&
        firstWithheld.result.reason === 'no_standable_approach' &&
        firstWithheld.result.missingCapabilities.map(capabilityKey).includes('standable_approach'),
      `presented=${firstAccess?.id ?? 'none'} withheld=${firstWithheld?.result.reason ?? 'none'} missing=[${(firstWithheld?.result.missingCapabilities ?? []).map(capabilityKey).join(',')}]`,
    )
    await check(
      '(b) the retirement is recorded in the state-fingerprint memory',
      firstWithheld !== undefined && memory.check(firstId, firstWithheld.fingerprint).known === true,
      `memory.size=${memory.size()} known=${firstWithheld === undefined ? 'n/a' : memory.check(firstId, firstWithheld.fingerprint).known}`,
    )

    // Second tick, unchanged world: the retirement is durable, not re-offered.
    const second = generateGroundedCandidates(state, optionsWith(noStand, memory))
    const secondAccess = second.candidates.find((candidate) => candidate.id === firstId)
    const secondWithheld = second.withheld.find((entry) => entry.candidate.id === firstId)
    await check(
      '(b) the retired target does not re-appear as an offer on the next tick (suppressed)',
      secondAccess === undefined && secondWithheld !== undefined && secondWithheld.suppressed === true,
      `presented=${secondAccess?.id ?? 'none'} suppressed=${secondWithheld?.suppressed ?? 'none'}`,
    )
  }

  // (b2) A dig-access refusal must retain the target's independent vertical
  // capability facts.  Without this, an elevated log is reduced to only
  // `standable_approach`, no placeable-block prerequisite is generated, and
  // the policy is left with WAIT despite a mechanically actionable recovery.
  {
    const state = worldState({ position: BOT, blocks: [highBlockedLog()], goal: goal('log') })
    const grounded = generateGroundedCandidates(state, optionsWith(noStand))
    const id = 'ACCESS:b10_69_0'
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === id)
    const missing = (withheld?.result.missingCapabilities ?? []).map(capabilityKey)
    await check(
      '(b2) elevated dig-access refusal preserves vertical prerequisite facts',
      withheld !== undefined &&
        withheld.result.reason === 'needs_ascend' &&
        missing.includes('placeable_block') &&
        missing.includes('standable_approach'),
      `reason=${withheld?.result.reason ?? 'none'} missing=[${missing.join(',')}] candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
  }

  // (c) The retirement marker names the coordinate and the mechanical fact.
  {
    const line = formatDigAccessRetired(BLOCK, 'no_interaction_stand')
    await check(
      '(c) DIG_ACCESS_RETIRED is a typed, coordinate-naming marker',
      line === 'DIG_ACCESS_RETIRED reason=no_interaction_stand target=10,64,0',
      line,
    )
  }

  // (d) Regression: an ordinary walk-up log (sensor adjacency fact present) still
  // yields the existing `MOVE:<block>` candidate, never an ACCESS injection.
  {
    const reachableLog = blockedLog()
    reachableLog.inReach = false
    reachableLog.hasAdjacentStandable = true
    reachableLog.adjacentStandable = { x: 10, y: 63, z: 0 }
    const state = worldState({ position: BOT, blocks: [reachableLog], goal: goal('log') })
    const grounded = generateGroundedCandidates(state, optionsWith(null))
    const plain = grounded.candidates.find((candidate) => candidate.id === 'MOVE:b10_64_0')
    await check(
      '(d) a normal walk-up log keeps the existing MOVE:<block> candidate',
      plain !== undefined && accessCandidates(grounded.candidates).length === 0,
      `candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
  }

  // (e) Wiring: the generator derives the stand and the controller mirrors the
  // typed retirement; the shared #244 face geometry lives in reachability.ts.
  {
    const candidates = source('./src/candidates.ts')
    const controller = runtimeControllerSource()
    const reach = source('./src/reachability.ts')
    const executor = source('./src/executor.ts')
    const wired =
      candidates.includes('function digAccessFor') &&
      candidates.includes('function digAccessMove') &&
      candidates.includes('function digAccessRetirement') &&
      candidates.includes('digApproach') &&
      candidates.includes('ACCESS:') &&
      controller.includes('digApproach') &&
      controller.includes('formatDigAccessRetired') &&
      reach.includes('export function formatDigAccessRetired') &&
      reach.includes('export function interactionFaceDistance') &&
      executor.includes("from './reachability.ts'")
    await check(
      '(e) dig-access generation, #244 stand geometry and retirement logging are wired',
      wired,
      `derive=${candidates.includes('function digAccessFor')} probe=${candidates.includes('digApproach')} ctl=${controller.includes('digApproach')} marker=${controller.includes('formatDigAccessRetired')} face=${reach.includes('export function interactionFaceDistance')}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`dig-access-candidate: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
