import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import { resolveResidentBootConfig } from './resident-config.ts'

describe('resident boot config', () => {
  it('keeps production defaults and resolves an isolated probe endpoint and Mission', () => {
    assert.deepEqual(resolveResidentBootConfig({}), {
      host: '127.0.0.1', port: 25565, goalItem: 'iron_ingot', goalCount: 3,
    })
    assert.deepEqual(resolveResidentBootConfig({
      BUDDY_HOST: '127.0.0.1', BUDDY_PORT: '25567',
      BUDDY_MISSION_ITEM: 'minecraft:oak_log', BUDDY_MISSION_COUNT: '1',
    }), {
      host: '127.0.0.1', port: 25567, goalItem: 'oak_log', goalCount: 1,
    })
  })

  it('rejects invalid ports, item names, and Mission counts instead of silently coercing them', () => {
    assert.throws(() => resolveResidentBootConfig({ BUDDY_PORT: '65536' }), /BUDDY_PORT/)
    assert.throws(() => resolveResidentBootConfig({ BUDDY_MISSION_ITEM: '../oak_log' }), /BUDDY_MISSION_ITEM/)
    assert.throws(() => resolveResidentBootConfig({ BUDDY_MISSION_COUNT: '1.5' }), /BUDDY_MISSION_COUNT/)
  })
})
