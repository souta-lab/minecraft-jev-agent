import { describe, expect, it } from 'bun:test'
import { DigMemory } from './src/worldMemory.ts'

describe('DigMemory world scope', () => {
  it('retains useful path memory in one world and clears absolute coordinates across dimension/world epochs', () => {
    const memory = new DigMemory()
    const overworld = { dimension: 'minecraft:overworld', worldEpoch: 12 }

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

    const nether = { dimension: 'minecraft:the_nether', worldEpoch: 12 }
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
    const replacementWorld = { dimension: nether.dimension, worldEpoch: 13 }
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
})
