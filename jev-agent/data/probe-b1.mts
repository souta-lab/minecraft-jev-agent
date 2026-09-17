// probe-b1.mts - isolate the 1.21.11 drop-pickup regression.
//
// No server commands. Gameplay only:
//   1. dig the block directly underfoot -> a dirt drop spawns at the bot's feet
//   2. watch entitySpawn / item entities, automatic pickup, inventory delta
//   3. run stock `mineflayer-collectblock` on a fresh drop and time it
//   4. run a manual control-walk nudge onto the drop and time it
//
// Run: npx tsx data/probe-b1.mts --username AI_B1P
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import type { Entity } from 'prismarine-entity'

const { pathfinder } = pathfinderModule

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback
}
const username = opt('username', 'AI_B1P')

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username, auth: 'offline' })
bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlockPlugin)

const t0 = Date.now()
const log = (...args: unknown[]): void => {
  process.stdout.write(`[b1 +${((Date.now() - t0) / 1000).toFixed(2)}s] ${args.join(' ')}\n`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const fmt = (p: { x: number; y: number; z: number }): string =>
  `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`

let forced = 0
bot.on('forcedMove', () => { forced += 1 })

function inventorySnapshot(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

function itemEntities(): Entity[] {
  return Object.values(bot.entities).filter(
    (e) => e !== undefined && (e.name === 'item' || e.name === 'Item' || e.name === 'item_stack'),
  ) as Entity[]
}

function describeEntity(e: Entity): string {
  let name = '?'
  try {
    const item = e.getDroppedItem()
    name = item === null ? 'null' : `${item.name}x${item.count}`
  } catch (error) {
    name = `decode-error:${error instanceof Error ? error.message : String(error)}`
  }
  return `id=${e.id} name=${e.name} pos=${fmt(e.position)} dropped=${name} d=${bot.entity.position.distanceTo(e.position).toFixed(2)}`
}

bot.on('entitySpawn', (e: Entity) => {
  if (e.name === 'item' || e.name === 'Item' || e.name === 'item_stack') {
    log(`EVENT entitySpawn ITEM ${describeEntity(e)}`)
  }
})
bot.on('entityGone', (e: Entity) => {
  if (e.name === 'item' || e.name === 'Item' || e.name === 'item_stack') {
    log(`EVENT entityGone ITEM id=${e.id}`)
  }
})
bot.on('path_update', (p: { status: string; path?: unknown[] }) => log(`EV path_update status=${p.status} nodes=${p.path?.length ?? 0}`))
bot.on('goal_reached', () => log('EV goal_reached'))
bot.on('path_reset', (reason: string) => log(`EV path_reset reason=${reason}`))

async function digBelow(): Promise<void> {
  const p = bot.entity.position
  const below = bot.blockAt(p.clone().offset(0, -1, 0).floor())
  if (below === null) { log('no block below'); return }
  log(`dig below ${below.name} at (${below.position.x},${below.position.y},${below.position.z}) bot=${fmt(p)}`)
  try {
    await bot.lookAt(below.position.offset(0.5, 0.5, 0.5), true)
    await bot.dig(below, 'ignore')
    log('dig below done')
  } catch (error) {
    log(`dig below error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function waitAndReport(label: string, ms: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    await sleep(400)
    const items = itemEntities()
    log(`${label} t+${Date.now() - start}ms items=${items.length} inv=${JSON.stringify(inventorySnapshot())}`)
    for (const e of items) log(`  ${describeEntity(e)}`)
  }
}

async function tryCollectBlock(label: string, budgetMs: number): Promise<void> {
  const items = itemEntities()
  if (items.length === 0) { log(`${label}: no item entities`); return }
  const target = items[0]
  if (target === undefined) return
  log(`${label}: stock collectblock on ${describeEntity(target)} budget=${budgetMs}ms`)
  const started = Date.now()
  let outcome = 'resolved'
  try {
    await Promise.race([
      bot.collectBlock.collect(target, { ignoreNoPath: true }),
      sleep(budgetMs).then(() => { outcome = 'TIMEOUT'; }),
    ])
  } catch (error) {
    outcome = `threw:${error instanceof Error ? error.message : String(error)}`
  }
  log(`${label}: outcome=${outcome} elapsed=${Date.now() - started}ms inv=${JSON.stringify(inventorySnapshot())}`)
  bot.pathfinder.stop()
  bot.pathfinder.setGoal(null)
}

async function tryNudge(label: string, budgetMs: number): Promise<void> {
  const items = itemEntities()
  if (items.length === 0) { log(`${label}: no item entities`); return }
  const target = items[0]
  if (target === undefined) return
  const started = Date.now()
  log(`${label}: control nudge toward ${describeEntity(target)} budget=${budgetMs}ms`)
  let forward = true
  while (Date.now() - started < budgetMs) {
    const live = itemEntities()
    if (live.length === 0) { log(`${label}: item gone (picked up)`); break }
    const drop = live[0]
    if (drop === undefined) break
    const dx = drop.position.x - bot.entity.position.x
    const dz = drop.position.z - bot.entity.position.z
    const d = Math.hypot(dx, dz)
    if (d > 0.4) {
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', forward)
    } else {
      bot.setControlState('forward', false)
    }
    forward = !forward
    await sleep(120)
  }
  bot.setControlState('forward', false)
  log(`${label}: done elapsed=${Date.now() - started}ms inv=${JSON.stringify(inventorySnapshot())} forced=${forced}`)
}

bot.once('spawn', async () => {
  try {
    await sleep(6000)
    const p = bot.entity.position
    log(`spawned at ${fmt(p)} yaw=${bot.entity.yaw.toFixed(2)} inv=${JSON.stringify(inventorySnapshot())}`)
    log('=== SCENARIO 1: dig block underfoot, watch automatic pickup ===')
    await digBelow()
    await waitAndReport('auto-pickup', 3000)
    log(`after s1 inv=${JSON.stringify(inventorySnapshot())} forced=${forced}`)

    log('=== SCENARIO 2: stock collectblock on a fresh drop (dig a second block underfoot) ===')
    const before = JSON.stringify(inventorySnapshot())
    log(`inv before s2=${before}`)
    await digBelow()
    await sleep(700)
    await tryCollectBlock('collectblock', 5000)
    log(`after s2 inv=${JSON.stringify(inventorySnapshot())} forced=${forced}`)

    log('=== SCENARIO 3: manual control nudge onto a fresh drop ===')
    await digBelow()
    await sleep(700)
    await tryNudge('nudge', 5000)
    log(`after s3 inv=${JSON.stringify(inventorySnapshot())} forced=${forced}`)
    log('PROBE COMPLETE')
  } catch (error) {
    log(`probe error: ${error instanceof Error ? error.stack : String(error)}`)
  } finally {
    bot.quit('probe done')
    setTimeout(() => process.exit(0), 800)
  }
})
bot.on('error', (e) => log(`error ${e.message}`))
bot.on('kicked', (r) => log(`kicked ${JSON.stringify(r)}`))
