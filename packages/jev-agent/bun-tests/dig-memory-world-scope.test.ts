import { describe, expect, it } from 'bun:test'
import { DigMemory } from '../src/worldMemory.ts'

describe('DigMemory world scope', () => {
  it('retains useful path memory in one world and clears coordinates when its full world key changes', () => {
    const memory = new DigMemory()
    const overworld = { serverId: 'server-a', dimension: 'minecraft:overworld', worldEpoch: 12 }

    expect(memory.bindScope(overworld)).toMatchObject({ changed: true, previous: null })
    memory.observeStoneY(24)
    memory.record({ x: 14, y: 30, z: -8, dir: 'E', mode: 'down', target: 'iron_ore', atMs: 1 })
    memory.markDescend(false)

    // Repeated observations during ordinary same-world ticks must preserve the
    // selected heading, known terrain level, and bounded descent history.
    expect(memory.bindScope(overworld).changed).toBe(false)
    expect(memory.snapshot()).toMatchObject({
      digDir: 'E',
      digDirCount: 1,
      digDepth: 1,
      knownStoneY: 24,
      lastTunnel: { x: 14, y: 30, z: -8 },
      descendNoProgress: 1,
    })

    const nether = { serverId: 'server-a', dimension: 'minecraft:the_nether', worldEpoch: 12 }
    expect(memory.bindScope(nether)).toMatchObject({
      changed: true,
      previous: overworld,
      current: nether,
    })
    expect(memory.snapshot()).toMatchObject({
      digDir: null,
      digDirCount: 0,
      digDepth: 0,
      knownStoneY: null,
      lastTunnel: null,
      descendNoProgress: 0,
      descendLimitReached: false,
    })

    memory.observeStoneY(12)
    memory.record({ x: 2, y: 18, z: 4, dir: 'N', mode: 'level', target: 'quartz', atMs: 2 })
    const replacementWorld = { serverId: nether.serverId, dimension: nether.dimension, worldEpoch: 13 }
    expect(memory.bindScope(replacementWorld)).toMatchObject({
      changed: true,
      previous: nether,
      current: replacementWorld,
    })
    expect(memory.snapshot()).toMatchObject({
      digDir: null,
      knownStoneY: null,
      lastTunnel: null,
      descendNoProgress: 0,
    })
  })

  it('clears absolute coordinate memory when the server changes at the same dimension and epoch', () => {
    const memory = new DigMemory()
    const original = { serverId: 'server-a', dimension: 'minecraft:overworld', worldEpoch: 12 }
    const replacement = { serverId: 'server-b', dimension: 'minecraft:overworld', worldEpoch: 12 }

    memory.bindScope(original)
    memory.observeStoneY(24)
    memory.record({ x: 14, y: 30, z: -8, dir: 'E', mode: 'down', target: 'iron_ore', atMs: 1 })
    memory.markDescend(false)

    expect(memory.bindScope(replacement)).toMatchObject({
      changed: true,
      previous: original,
      current: replacement,
    })
    expect(memory.snapshot()).toMatchObject({
      digDir: null,
      digDirCount: 0,
      digDepth: 0,
      knownStoneY: null,
      lastTunnel: null,
      descendNoProgress: 0,
      descendLimitReached: false,
    })

    // A stable complete world key retains only memory learned inside that key.
    memory.record({ x: -5, y: 72, z: 9, dir: 'N', mode: 'level', target: 'oak_log', atMs: 2 })
    expect(memory.bindScope(replacement).changed).toBe(false)
    expect(memory.snapshot().lastTunnel).toEqual({ x: -5, y: 72, z: 9 })
  })
})
