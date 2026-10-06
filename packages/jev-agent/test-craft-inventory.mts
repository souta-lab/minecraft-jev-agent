// Player-grid regression: optimistic Mineflayer slots are not a server commit.
// Reproduce the p26 rollback shape without a server or a decision provider.
import assert from 'node:assert/strict'
import type { Bot } from 'mineflayer'
import { craftInInventory } from './src/craftWindow.ts'
import type { CraftRecipeLike } from './src/craftWindow.ts'

const recipe: CraftRecipeLike = { result: { id: 36, count: 4 }, ingredients: [{ id: 134 }] }

// Separate server/client views. A stale click produces optimistic client slots
// while the server retains the log; a full resync is the authoritative reply.
function fixture(reject = false) {
  const server = { logs: 1, planks: 0, revision: 7 }
  const client = { logs: 1, planks: 0, revision: 6 }
  let attempted = false
  const bot = {
    currentWindow: null,
    inventory: { type: 'minecraft:inventory' },
    supportFeature: () => true,
    _syncWindow: async () => { Object.assign(client, server) },
    craft: async () => {
      attempted = true
      if (!reject && client.revision === server.revision) {
        server.logs -= 1
        server.planks += 4
        server.revision += 1
      }
      client.logs -= 1
      client.planks += 4
    },
  } as unknown as Bot
  return { bot, client, server, attempted: () => attempted }
}

const accepted = fixture()
await craftInInventory(accepted.bot, recipe)
assert.equal(accepted.server.planks, 4, 'stale player-grid state must be reconciled before stock crafting')
assert.deepEqual(accepted.client, accepted.server, 'the next prerequisite must see the acknowledged output')

const rejected = fixture(true)
await craftInInventory(rejected.bot, recipe)
assert.equal(rejected.server.planks, 0)
assert.equal(rejected.client.planks, 0, 'a rejected craft must not expose optimistic gain to VERIFY')
assert.equal(rejected.client.logs, 1, 'rollback must preserve the authoritative ingredient count')

const unsupported = fixture()
delete (unsupported.bot as unknown as { _syncWindow?: unknown })._syncWindow
await assert.rejects(craftInInventory(unsupported.bot, recipe), /resync/i)
assert.equal(unsupported.attempted(), false, 'missing modern-protocol acknowledgement support refuses before mutation')

const failed = fixture(true)
failed.bot.craft = async () => {
  failed.client.planks = 4
  throw new Error('server attempt failed')
}
await assert.rejects(craftInInventory(failed.bot, recipe), /server attempt failed/)
assert.deepEqual(failed.client, failed.server, 'a thrown craft reconciles its partial optimistic state too')

process.stdout.write('PASS player-grid stale state, authoritative rollback, unavailable resync, and failed-attempt cleanup\n')
