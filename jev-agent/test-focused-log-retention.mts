// The log sensor shares one bounded near-field list across resource types. A
// crowded stand of unrelated logs must not evict the exact log named by the
// current Mission before the VTR reach scheduler can ground a route to it.
import { generateGroundedCandidates } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import { envelopeForCandidate } from './src/skillCommitment.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { AgentSignals, SensorInput, Vec3Json, WorldState } from './src/state.ts'
import { isMissionReachSourceCandidate } from './src/runtime-adapters/minecraft-reach-mission-projection.ts'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')
const cellKey = (position: Vec3Json): string =>
  `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`

function focusedLogFixture(): { state: WorldState; target: Vec3Json } {
  const botPosition = new Vec3(0.5, 64, -0.5)
  const world = new Map<string, string>()
  for (let x = -2; x <= 10; x += 1) {
    for (let z = -5; z <= 5; z += 1) world.set(`${x},62,${z}`, 'stone')
  }
  // More than the default 16-log sensor cap, all closer to the body than the
  // single mission source. These logs are real, but none can satisfy the
  // exact stripped_mangrove_log predicate.
  const decoys: Vec3Json[] = []
  for (let x = 1; x <= 4; x += 1) {
    for (let z = 0; z <= 4; z += 1) {
      if (decoys.length === 17) break
      decoys.push({ x, y: 63, z })
      world.set(cellKey(decoys.at(-1)!), 'oak_log')
    }
    if (decoys.length === 17) break
  }
  const target = { x: 6, y: 63, z: -1 }
  world.set(cellKey(target), 'stripped_mangrove_log')

  const blockAt = (position: { x: number; y: number; z: number }) => {
    const name = world.get(cellKey(position))
    if (name === undefined) return { name: 'air', boundingBox: 'empty', diggable: false }
    return { name, boundingBox: 'block', diggable: true }
  }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance: number
    count: number
  }): unknown[] => {
    const origin = new Vec3(Math.floor(botPosition.x), Math.floor(botPosition.y), Math.floor(botPosition.z))
    const found: unknown[] = []
    for (const [key, name] of world) {
      if (!options.matching({ name })) continue
      const [x, y, z] = key.split(',').map(Number)
      const position = new Vec3(x, y, z)
      if (position.distanceTo(origin) <= options.maxDistance) found.push(position)
    }
    return found.slice(0, options.count)
  }
  const bot = {
    username: 'AI_FOCUSED_LOG_SENSOR',
    entity: { id: 1, position: botPosition, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => [{ name: 'cobblestone', count: 1, slot: 36 }] },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
  } as never
  const signals: AgentSignals = {
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
  const input: SensorInput = {
    tick: 1,
    goal: makeGoal('stripped_mangrove_log', 1),
    goalQueue: emptyGoalQueueState(),
    focusItem: 'stripped_mangrove_log',
    recentEvents: [],
    signals,
  }
  return { state: buildWorldState(bot, input, defaultSensorOptions), target }
}

const { state, target } = focusedLogFixture()
const observedTarget = state.blocks.find(
  (block) => block.name === 'stripped_mangrove_log' && cellKey(block.position) === cellKey(target),
)
const grounded = generateGroundedCandidates(state)
const targetMove = grounded.candidates.find(
  (candidate) =>
    candidate.kind === 'MOVE' &&
    candidate.meta.targetBlockName === 'stripped_mangrove_log' &&
    candidate.meta.targetBlockX === target.x &&
    candidate.meta.targetBlockY === target.y &&
    candidate.meta.targetBlockZ === target.z,
)
const retainedLogs = state.blocks.filter((block) => block.kind === 'log')
const retainedDecoys = retainedLogs.filter((block) => block.name === 'oak_log').length

const vtrWitness = targetMove !== undefined && isMissionReachSourceCandidate(
  targetMove,
  state,
  'stripped_mangrove_log',
  ['stripped_mangrove_log'],
)
const envelope = targetMove === undefined ? null : envelopeForCandidate(targetMove)
const locomotionOnly = envelope !== null &&
  targetMove?.kind === 'MOVE' &&
  !targetMove.id.startsWith('BRIDGE:') &&
  targetMove.meta.mayPlaceBlocks !== true &&
  (envelope.mayDigBlocks?.length ?? 0) === 0 &&
  envelope.mayDigGroundedRoute !== true &&
  (envelope.mayPlaceBlocks?.length ?? 0) === 0 &&
  envelope.mayPlaceGroundedRoute !== true
const boundedLogCount = retainedLogs.length === defaultSensorOptions.maxLogs && retainedDecoys === defaultSensorOptions.maxLogs - 1

if (observedTarget === undefined || targetMove === undefined || !vtrWitness || !locomotionOnly || !boundedLogCount) {
  process.stderr.write(
    `FAIL focused log survives bounded sensing and grounds an admissible VTR MOVE: sensed=${String(observedTarget !== undefined)} vtrWitness=${vtrWitness} locomotionOnly=${locomotionOnly} boundedLogs=${boundedLogCount} candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}], withheld=[${grounded.withheld.map((entry) => `${entry.candidate.id}:${entry.result.reason}`).join(',')}]\n`,
  )
  process.exit(1)
}

process.stdout.write(
  `PASS focused log survives bounded sensing and grounds an admissible VTR MOVE: retained=${observedTarget.name}@${cellKey(observedTarget.position)} candidate=${targetMove.id} retainedLogs=${retainedLogs.length} unrelatedLogs=${retainedDecoys}\n`,
)
