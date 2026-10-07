// Local rising MOVE: stock diagonal edges choose one clear orthogonal side,
// but driving the diagonal sweeps through the blocked opposite corner. Use
// the production pinned movements and actual stock A* on translated geometry.
import { test, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import { computePathFacts } from './src/path-probes.ts'
import type { PathProbesHost } from './src/path-probes.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(registry)
const Move = require('mineflayer-pathfinder/lib/move')
const AStar = require('mineflayer-pathfinder/lib/astar')
const { goals } = require('mineflayer-pathfinder')
const start = { x: 0, y: 64, z: 0 }
const target = { x: 1, y: 65, z: -1 }

function scene(clearOppositeCorner = false, closeCorridor = false, rise = 1) {
  const cells = new Map<string, string>()
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  const destination = { ...target, y: start.y + rise }
  // The east corridor permits an ordinary two-leg route. The north corner
  // remains solid, even though the destination has clear feet/head + support.
  for (const [x, y, z] of [[0,64,0],[0,65,0],[0,66,0],[1,64,0],[1,65,0],[1,66,0],[1,destination.y,-1],[1,destination.y+1,-1]]) {
    cells.set(key(x!,y!,z!), 'air')
  }
  if (clearOppositeCorner) {
    cells.set(key(0,destination.y,-1), 'air')
    cells.set(key(0,destination.y+1,-1), 'air')
  }
  if (closeCorridor) cells.set(key(1,65,0), 'stone')
  const bot = Object.assign(new EventEmitter(), {
    registry,
    game: { dimension: 'minecraft:overworld', minY: -64 },
    health: 1, food: 0, physicsEnabled: false,
    entity: { position: new Vec3(0.5,64,0.5), yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: {}, inventory: { items: () => [], count: () => 0 },
    blockAt: (p: Vec3) => {
      const x=Math.floor(p.x), y=Math.floor(p.y), z=Math.floor(p.z)
      const name=cells.get(key(x,y,z)) ?? 'stone'
      const block=Block.fromStateId(registry.blocksByName[name].minStateId,0)
      block.position=new Vec3(x,y,z)
      return block
    },
    pathfinder: {
      movements: null as any,
      setMovements: (m: any) => { bot.pathfinder.movements=m },
      getPathTo: (m: any, goal: any, timeout: number) => {
        const astar=new AStar(new Move(start.x,start.y,start.z,0,0),m,goal,timeout,timeout,8)
        return astar.compute()
      },
    },
  })
  new Executor(bot as unknown as Bot, new EventLogger(null,false), { ...defaultExecutorOptions }).ensureMovements()
  const movements=bot.pathfinder.movements
  const neighbors=movements.getNeighbors(new Move(start.x,start.y,start.z,0,0))
  const plan=bot.pathfinder.getPathTo(movements,new goals.GoalBlock(destination.x,destination.y,destination.z),750)
  const host={ bot, routeCrossesDimensionTransfer: () => 'clear' } as unknown as PathProbesHost
  const fact=computePathFacts(host,destination)
  const bodyClear = (center: { x: number; y: number; z: number }): boolean => {
    for (let x = Math.floor(center.x - 0.3); x <= Math.floor(center.x + 0.3 - 1e-6); x++) {
      for (let y = Math.floor(center.y); y <= Math.floor(center.y + 1.8 - 1e-6); y++) {
        for (let z = Math.floor(center.z - 0.3); z <= Math.floor(center.z + 0.3 - 1e-6); z++) {
          if (bot.blockAt(new Vec3(x, y, z)).boundingBox !== 'empty') return false
        }
      }
    }
    return true
  }
  return { neighbors, plan, fact, bodyClear, destination }
}

const isTarget = (p: { x: number; y: number; z: number }) => p.x===target.x && p.y===target.y && p.z===target.z

test('blocked rising diagonal becomes the existing orthogonal route, not an impossible direct edge', () => {
  const { neighbors, plan, fact, bodyClear }=scene()
  // A real 0.6 x 1.8 body intersects the north corner along the diagonal;
  // the east jump column and the destination remain occupiable.
  expect(bodyClear({ x: 0.8, y: 65, z: 0.2 })).toBe(false)
  expect(bodyClear({ x: 1.5, y: 65, z: 0.5 })).toBe(true)
  expect(bodyClear({ x: 1.5, y: 65, z: -0.5 })).toBe(true)
  expect(neighbors.some(isTarget)).toBe(false)
  expect(plan.status).toBe('success')
  expect(plan.path.some((p: { x: number; y: number; z: number }) => p.x===1 && p.y===64 && p.z===0)).toBe(true)
  expect(isTarget(plan.path.at(-1))).toBe(true)
  expect(fact.probe).toBe('reachable')
})

test('a genuinely open diagonal rise stays a legal direct mechanical edge', () => {
  const { neighbors, plan, fact }=scene(true)
  expect(neighbors.some(isTarget)).toBe(true)
  expect(plan.status).toBe('success')
  expect(fact.probe).toBe('reachable')
})

test('without a clear side route the same supported destination is typed no_path', () => {
  const { neighbors, plan, fact }=scene(false,true)
  expect(neighbors.some(isTarget)).toBe(false)
  expect(plan.status).toBe('noPath')
  expect(fact.probe).toBe('no_path')
})

test('a blocked level diagonal uses the legal orthogonal turn instead of crossing the opposite wall', () => {
  const { neighbors, plan, fact, bodyClear, destination } = scene(false, false, 0)
  const matches = (p: { x: number; y: number; z: number }) => p.x===destination.x && p.y===destination.y && p.z===destination.z
  expect(bodyClear({ x: 0.8, y: 64, z: 0.2 })).toBe(false)
  expect(bodyClear({ x: 1.5, y: 64, z: 0.5 })).toBe(true)
  expect(bodyClear({ x: 1.5, y: 64, z: -0.5 })).toBe(true)
  expect(neighbors.some(matches)).toBe(false)
  expect(plan.status).toBe('success')
  expect(plan.path.some((p: { x: number; y: number; z: number }) => p.x===1 && p.y===64 && p.z===0)).toBe(true)
  expect(matches(plan.path.at(-1))).toBe(true)
  expect(fact.probe).toBe('reachable')
})

test('open level diagonals remain legal; sealing both side routes stays typed no_path', () => {
  const open = scene(true, false, 0)
  expect(open.neighbors.some((p: { x: number; y: number; z: number }) => p.x===1 && p.y===64 && p.z===-1)).toBe(true)
  expect(open.fact.probe).toBe('reachable')
  const sealed = scene(false, true, 0)
  expect(sealed.plan.status).toBe('noPath')
  expect(sealed.fact.probe).toBe('no_path')
})
