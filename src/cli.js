#!/usr/bin/env node
'use strict'

const { McBot } = require('./bot')

const USAGE = `AI_Bot CLI - control the local Bedrock Dedicated Server

Usage:
  node src/cli.js status                             connection, position, health, dimension, players
  node src/cli.js cmd "<raw command>"                run an in-game command, print the server response
  node src/cli.js chat "<text>"                      send a chat message
  node src/cli.js players                            list online players
  node src/cli.js tp <x> <y> <z> [player]            teleport (default: @s)
  node src/cli.js setblock <x> <y> <z> <block>       place a block
  node src/cli.js fill <x1> <y1> <z1> <x2> <y2> <z2> <block>
  node src/cli.js give <item> [count] [player]       give items (default: 1, @s)
  node src/cli.js log [n]                            print last n server messages (default 20)
`

function requireArgs (args, count, usageLine) {
  if (args.length < count) throw new Error(`Missing arguments.\n${usageLine}`)
}

function requireNumbers (values, label) {
  const nums = values.map(Number)
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`${label} must be numbers: ${values.join(' ')}`)
  return nums
}

async function main () {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }

  const bot = new McBot()
  try {
    await bot.connect()
    await new Promise((resolve) => setTimeout(resolve, 250)) // let spawn-time packets settle

    switch (command) {
      case 'status': {
        console.log(JSON.stringify(bot.snapshot(), null, 2))
        break
      }
      case 'players': {
        console.log(JSON.stringify(bot.players(), null, 2))
        break
      }
      case 'cmd': {
        requireArgs(args, 1, 'node src/cli.js cmd "<raw command>"')
        const raw = args.join(' ')
        console.log(`> ${raw}`)
        console.log(await bot.runCommand(raw))
        break
      }
      case 'chat': {
        requireArgs(args, 1, 'node src/cli.js chat "<text>"')
        await bot.chat(args.join(' '))
        console.log('chat sent')
        break
      }
      case 'tp': {
        requireArgs(args, 3, 'node src/cli.js tp <x> <y> <z> [player]')
        const [x, y, z] = requireNumbers(args.slice(0, 3), 'x y z')
        console.log(await bot.tp(x, y, z, args[3]))
        const p = bot.snapshot().position
        console.log(`position after tp: x=${p.x} y=${p.y} z=${p.z}`)
        break
      }
      case 'setblock': {
        requireArgs(args, 4, 'node src/cli.js setblock <x> <y> <z> <block>')
        const [x, y, z] = requireNumbers(args.slice(0, 3), 'x y z')
        console.log(await bot.setblock(x, y, z, args[3]))
        break
      }
      case 'fill': {
        requireArgs(args, 7, 'node src/cli.js fill <x1> <y1> <z1> <x2> <y2> <z2> <block>')
        const coords = requireNumbers(args.slice(0, 6), 'coordinates')
        console.log(await bot.fill(...coords, args[6]))
        break
      }
      case 'give': {
        requireArgs(args, 1, 'node src/cli.js give <item> [count] [player]')
        console.log(await bot.give(args[0], args[1] === undefined ? 1 : Number(args[1]), args[2]))
        break
      }
      case 'log': {
        const n = args[0] === undefined ? 20 : Number(args[0])
        console.log(JSON.stringify(bot.log(n), null, 2))
        break
      }
      default:
        throw new Error(`Unknown command: ${command}\n\n${USAGE}`)
    }
  } finally {
    bot.close()
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`)
  process.exit(1)
})
