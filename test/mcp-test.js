#!/usr/bin/env bun
'use strict'

// Drives src/mcp-server.js over stdio and exercises every MCP tool.
// Run: bun test/mcp-test.js
const path = require('path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const X = 190
const Y = 70
const Z = 190

async function main () {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'src', 'mcp-server.js')],
    stderr: 'inherit',
  })
  const client = new Client({ name: 'mc-test-client', version: '1.0.0' })
  await client.connect(transport)
  console.log('connected to mcp-server over stdio\n')

  const { tools } = await client.listTools()
  console.log('TOOLS:', tools.map((t) => t.name).join(', '))

  let failures = 0
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content || []).map((c) => c.text).join('\n')
    console.log(`\n=== ${name} ${JSON.stringify(args)} ===`)
    console.log(text)
    if (result.isError) failures++
    return result
  }

  await call('mc_status')
  await call('mc_command', { command: 'time query daytime' })
  await call('mc_tp', { x: X, y: Y, z: Z })
  await call('mc_status')
  await call('mc_setblock', { x: X + 2, y: Y + 1, z: Z, block: 'stone' })
  await call('mc_command', { command: `execute if block ${X + 2} ${Y + 1} ${Z} stone` })
  await call('mc_fill', { x1: X + 4, y1: Y + 1, z1: Z, x2: X + 6, y2: Y + 1, z2: Z + 2, block: 'glass' })
  await call('mc_command', { command: `execute if block ${X + 5} ${Y + 1} ${Z + 1} glass` })
  await call('mc_give', { item: 'iron_ingot', count: 2 })
  await call('mc_chat', { message: 'hello from the MCP test' })
  await call('mc_players')
  await call('mc_log', { lines: 5 })

  await transport.close()
  console.log(`\nMCP test finished, tool errors: ${failures}`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(`MCP test failed: ${error.message}`)
  process.exit(1)
})
