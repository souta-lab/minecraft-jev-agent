// p27 furnace return: range=2 skipped the one-cell tunnel's turn, then the
// packet fallback cut across solid terrain. Reproduce the bend with translated
// coordinates and collision rejection, through the real admitted Executor.
// This isolates the first blocked horizontal segment; ascent has its own suite.
import { test, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import type { Candidate, Vec3Json } from './src/index.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const route: Vec3Json[] = [
  { x: 4, y: 21, z: 1 },
  { x: 3, y: 21, z: 1 },
  { x: 3, y: 21, z: 0 },
  { x: 2, y: 21, z: 0 },
  { x: 2, y: 21, z: -1 },
  { x: 1, y: 21, z: -1 },
]
const station = { x: 0, y: 21, z: -1 }

async function returnThroughTunnel(breakRoute = false) {
  const grid = new Map<string, string>()
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  for (const node of route) {
    grid.set(key(node.x, node.y, node.z), 'air')
    grid.set(key(node.x, node.y + 1, node.z), 'air')
  }
  grid.set(key(station.x, station.y, station.z), 'furnace')
  if (breakRoute) grid.set(key(3, 21, 0), 'stone')
  const nameAt = (x: number, y: number, z: number) => grid.get(key(x, y, z)) ?? 'stone'
  const position = new Vec3(4.3, 21, 1.3)
  let accepted = position.clone()
  let rejected = 0
  const visited = new Set<string>()
  const emitter = new EventEmitter()
  const bot = Object.assign(emitter, {
    registry,
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 16,
    physicsEnabled: false,
    entity: { position, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: {},
    inventory: { items: () => [], count: () => 0 },
    blockAt: (p: Vec3) => {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
      const name = nameAt(x, y, z)
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', diggable: false, position: new Vec3(x, y, z) }
    },
    _client: { write: (packet: string, pose: Vec3Json) => {
      if (packet !== 'position_look') return
      // Model the server's full 0.6 x 1.8 body collision, not just its feet cell.
      let clear = true
      for (let x = Math.floor(pose.x - 0.3); x <= Math.floor(pose.x + 0.3 - 1e-6); x++) {
        for (let y = Math.floor(pose.y); y <= Math.floor(pose.y + 1.8 - 1e-6); y++) {
          for (let z = Math.floor(pose.z - 0.3); z <= Math.floor(pose.z + 0.3 - 1e-6); z++) {
            if (nameAt(x, y, z) !== 'air') clear = false
          }
        }
      }
      if (clear) {
        accepted = new Vec3(pose.x, pose.y, pose.z)
        visited.add(key(Math.floor(pose.x), Math.floor(pose.y), Math.floor(pose.z)))
      } else rejected++
      position.set(accepted.x, accepted.y, accepted.z)
    } },
    setControlState: () => {},
    clearControlStates: () => {},
    lookAt: async () => {},
    canDigBlock: () => false,
    stopDigging: () => {},
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown) => { bot.pathfinder.movements = movements },
      setGoal: () => {},
      stop: () => {},
      getPathTo: () => ({ status: 'success', path: route.map(p => ({ ...p, x: p.x + 0.5, z: p.z + 0.5 })) }),
    },
  })
  const executor = new Executor(bot as unknown as Bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
    maxStepsPerWaypoint: 60,
  })
  // Both prior actuators already failed in the live evidence. Isolate their
  // recorded refusal; keep actual planning, packet steps, effects and VERIFY.
  ;(executor as unknown as { walkByControls: () => Promise<boolean> }).walkByControls = async () => false
  const candidate: Candidate = {
    id: 'RETRIEVE:known:station:furnace:b0_21_-1', kind: 'RETRIEVE',
    label: 'return to the remembered furnace to smelt', targetName: 'furnace',
    target: station, targetEntityId: null, itemName: null,
    requiresTool: false, toolName: null, inReach: false, hasStandableAdjacent: true,
    meta: { retrieval: 'known', resource: 'furnace', resourceKind: 'station', vertical: 'none' },
  }
  const result = await fixtureClaim(executor, candidate).completion
  return { result, rejected, visited, position }
}

test('remembered furnace return follows the first tunnel bend; final VERIFY remains required', async () => {
  const { result, rejected, visited, position } = await returnThroughTunnel()
  expect(result.failure).toBeNull()
  expect(result.verified).toBe(true)
  expect(rejected).toBe(0)
  for (const cell of ['3,21,1', '3,21,0', '2,21,0', '2,21,-1']) expect(visited.has(cell)).toBe(true)
  expect(position.y).toBe(21)
})

test('a genuinely blocked return stays typed path_stuck and cannot verify', async () => {
  const { result } = await returnThroughTunnel(true)
  expect(result.failure).toBe('path_stuck')
  expect(result.verified).toBe(false)
})
