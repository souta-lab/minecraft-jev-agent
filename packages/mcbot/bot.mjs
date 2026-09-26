#!/usr/bin/env bun
// Stock Mineflayer bot for the local Leaf (Paper fork) Minecraft 26.1.2 server.
// No account, no patches: the published mineflayer/minecraft-protocol stack
// supports MC 26.1.2 (protocol 775) out of the box.
import mineflayer from 'mineflayer'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

if (has('help')) {
  console.log(`Usage: bun bot.mjs [options]

  --host <addr>      server address        (default 127.0.0.1)
  --port <n>         server port           (default 25565)
  --username <name>  offline player name   (default AI_Bot)
  --version <ver>    force protocol version (default: auto-detect from server)
  --seconds <n>      disconnect after n s  (default 0 = stay connected)
  --help             show this help`)
  process.exit(0)
}

const host = opt('host', '127.0.0.1')
const port = Number(opt('port', 25565))
const username = opt('username', 'AI_Bot')
const version = opt('version', undefined)
const seconds = Number(opt('seconds', 0))

const bot = mineflayer.createBot({
  host,
  port,
  username,
  auth: 'offline',
  ...(version ? { version } : {})
})

bot.once('login', () => {
  console.log(`[bot] logged in as ${bot.username} -> MC ${bot.version} (protocol ${bot.protocolVersion})`)
})

bot.once('spawn', () => {
  const p = bot.entity.position
  console.log(`[bot] connected to ${host}:${port} as ${bot.username} (auth=offline)`)
  console.log(`[bot] version: MC ${bot.version}, protocol ${bot.protocolVersion}`)
  console.log(`[bot] spawn position: x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`)
  console.log(`[bot] dimension=${bot.game.dimension} gamemode=${bot.game.gameMode}`)

  bot.chat('hello from AI_Bot')

  setTimeout(() => {
    const q = bot.entity.position
    console.log(`[bot] position after 1s: ${q.x.toFixed(2)}, ${q.y.toFixed(2)}, ${q.z.toFixed(2)}`)
    console.log(`[bot] health=${bot.health ?? 'n/a'} food=${bot.food ?? 'n/a'} alive=${bot.health > 0}`)
  }, 1000)

  if (seconds > 0) {
    console.log(`[bot] will disconnect in ${seconds}s`)
    setTimeout(() => shutdown('timer elapsed'), seconds * 1000)
  }
})

bot.on('chat', (user, message) => console.log(`[chat] <${user}> ${message}`))
bot.on('error', (err) => { console.error(`[bot] error: ${err.message}`); process.exitCode = 1 })
bot.on('kicked', (reason) => console.error(`[bot] kicked: ${JSON.stringify(reason)}`))
bot.on('end', (reason) => {
  console.log(`[bot] disconnected (${reason})`)
  process.exit(process.exitCode ?? 0)
})

function shutdown (reason) {
  console.log(`[bot] quitting: ${reason}`)
  bot.quit(reason)
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
