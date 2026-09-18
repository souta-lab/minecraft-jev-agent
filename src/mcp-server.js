#!/usr/bin/env node
'use strict'

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')
const { McBot } = require('./bot')

const bot = new McBot()

const server = new McpServer(
  { name: 'minecraft-bedrock', version: '1.0.0' },
  { instructions: 'Control AI_Bot on the local Minecraft Bedrock Dedicated Server (1.26.45) at 127.0.0.1:19132. The bot is an operator; use mc_tp to move it, mc_setblock/mc_fill to build, mc_give for items, and mc_command for anything else in-game.' }
)

function ok (text) {
  return { content: [{ type: 'text', text: String(text) }] }
}

function fail (error) {
  return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }
}

/** Ensure the bot is spawned, waiting for connect/auto-reconnect. */
async function ready () {
  if (!await bot.ensureConnected(10000)) {
    throw new Error(`Bot not connected (state: ${bot.state}) - is the Bedrock server running?`)
  }
}

async function handle (fn) {
  try {
    return ok(await fn())
  } catch (error) {
    return fail(error)
  }
}

server.registerTool('mc_status', {
  title: 'Minecraft bot status',
  description: 'Get the bot connection state, current position (x,y,z), health, dimension, gamemode, online players and the tail of the server message log.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => handle(async () => {
  await bot.ensureConnected(8000) // status is still useful while connecting
  const snap = bot.snapshot()
  const tail = bot.log(5).map((m) => `${m.time} [${m.kind}] ${m.text}`)
  return `${JSON.stringify(snap, null, 2)}\n\nRecent log:\n${tail.join('\n')}`
}))

server.registerTool('mc_command', {
  title: 'Run in-game command',
  description: 'Run any Minecraft Bedrock command as the bot (leading slash optional, e.g. "time set day", "weather clear", "summon cow"). Returns the server response text. Note: commands like "say" produce no response.',
  inputSchema: { command: z.string().describe('Command to run, with or without a leading slash') },
}, async ({ command }) => handle(async () => `${await bot.runCommand(command)}`))

server.registerTool('mc_chat', {
  title: 'Send chat message',
  description: 'Send a plain chat message to all players on the server.',
  inputSchema: { message: z.string().describe('Chat text to send') },
}, async ({ message }) => handle(async () => {
  await bot.chat(message)
  return `chat sent: ${message}`
}))

server.registerTool('mc_tp', {
  title: 'Teleport',
  description: 'Teleport the bot (or another player) to exact coordinates. The bot position in mc_status updates to the server-authoritative result.',
  inputSchema: {
    x: z.number().describe('X coordinate'),
    y: z.number().describe('Y coordinate'),
    z: z.number().describe('Z coordinate'),
    player: z.string().optional().describe('Player to move (default: the bot itself)'),
  },
}, async ({ x, y, z: zc, player }) => handle(async () => `${await bot.tp(x, y, zc, player)}`))

server.registerTool('mc_setblock', {
  title: 'Place a block',
  description: 'Place a single block at exact coordinates, replacing whatever is there (e.g. block "stone", "oak_planks", "glass").',
  inputSchema: {
    x: z.number().describe('X coordinate'),
    y: z.number().describe('Y coordinate'),
    z: z.number().describe('Z coordinate'),
    block: z.string().describe('Block id, e.g. stone, oak_planks, minecraft:glass'),
  },
}, async ({ x, y, z: zc, block }) => handle(async () => `${await bot.setblock(x, y, zc, block)}`))

server.registerTool('mc_fill', {
  title: 'Fill a region',
  description: 'Fill a rectangular region (inclusive corners) with a block, e.g. for building a floor or wall. Keep regions small unless intended - the volume limit is 32768 blocks.',
  inputSchema: {
    x1: z.number().describe('Corner 1 X'),
    y1: z.number().describe('Corner 1 Y'),
    z1: z.number().describe('Corner 1 Z'),
    x2: z.number().describe('Corner 2 X'),
    y2: z.number().describe('Corner 2 Y'),
    z2: z.number().describe('Corner 2 Z'),
    block: z.string().describe('Block id, e.g. stone, oak_planks, minecraft:glass'),
  },
}, async (c) => handle(async () => `${await bot.fill(c.x1, c.y1, c.z1, c.x2, c.y2, c.z2, c.block)}`))

server.registerTool('mc_give', {
  title: 'Give items',
  description: 'Give items to the bot (or another player), e.g. item "iron_pickaxe" or "diamond" with a count.',
  inputSchema: {
    item: z.string().describe('Item id, e.g. diamond, iron_ingot, minecraft:stone'),
    count: z.number().int().positive().optional().describe('Item count (default 1)'),
    player: z.string().optional().describe('Receiving player (default: the bot itself)'),
  },
}, async ({ item, count, player }) => handle(async () => `${await bot.give(item, count === undefined ? 1 : count, player)}`))

server.registerTool('mc_players', {
  title: 'List online players',
  description: 'List the usernames of players currently online on the server, as tracked from the server player list.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => handle(async () => {
  await ready()
  return JSON.stringify(bot.players())
}))

server.registerTool('mc_log', {
  title: 'Recent server messages',
  description: 'Return the most recent server/chat messages received by the bot (ring buffer).',
  inputSchema: { lines: z.number().int().min(1).max(200).optional().describe('How many entries to return (default 20)') },
  annotations: { readOnlyHint: true },
}, async ({ lines }) => handle(async () => {
  const entries = bot.log(lines === undefined ? 20 : lines)
  return entries.length ? entries.map((m) => `${m.time} [${m.kind}] ${m.text}`).join('\n') : 'no messages yet'
}))

async function main () {
  bot.connect().catch((error) => {
    process.stderr.write(`minecraft-mcp: initial connect failed: ${error.message}\n`)
  })
  // Exit when the MCP client goes away (stdin EOF), so no orphan server is left behind.
  process.stdin.on('end', () => {
    bot.close()
    process.exit(0)
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('minecraft-mcp: MCP stdio server ready\n')
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    bot.close()
    process.exit(0)
  })
}

main().catch((error) => {
  process.stderr.write(`minecraft-mcp: fatal: ${error.message}\n`)
  process.exit(1)
})
