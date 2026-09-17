// probe-craft.mts - DIAGNOSTIC ONLY. Reproduce the 3x3 crafting-table craft with
// raw packet logging to find why `bot.craft(pickaxe, 1, table)` yields nothing.
//
// Run: npx tsx data/probe-craft.mts [username]
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { defaultExecutorOptions, EventLogger, Executor } from '../src/index.ts'

const USER = process.argv[2] ?? 'AI_M2DIAG'
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: USER, auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)
const { goals } = pathfinderModule as unknown as {
  goals: { GoalNear: new (x: number, y: number, z: number, range: number) => unknown }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function inv(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] ?? 0) + it.count
  return out
}

bot._client.on('packet', (data: any, meta: any) => {
  const n = meta?.name ?? meta?.state
  if (typeof n !== 'string') return
  if (['window_click', 'set_slot', 'window_items', 'open_window', 'close_window', 'craft_progress_bar', 'transaction'].includes(n)) {
    if (n === 'window_click') {
      console.log('[pkt>]', n, JSON.stringify({ windowId: data.windowId, stateId: data.stateId, slot: data.slot, mouseButton: data.mouseButton, mode: data.mode, changedSlots: data.changedSlots?.length, cursorItem: data.cursorItem?.itemId }))
      return
    }
    if (n === 'set_slot') {
      console.log('[pkt<]', n, JSON.stringify({ windowId: data.windowId, stateId: data.stateId, slot: data.slot, item: data.item?.itemId, count: data.item?.itemCount }))
      return
    }
    if (n === 'window_items') {
      console.log('[pkt<]', n, JSON.stringify({ windowId: data.windowId, stateId: data.stateId, items: data.items?.length }))
      return
    }
    console.log('[pkt]', n, JSON.stringify(data).slice(0, 300))
  }
})

bot.on('windowOpen', (w: any) => console.log('[evt] windowOpen', w.type, 'id=', w.id, 'resultSlot=', w.craftingResultSlot, 'invStart=', w.inventoryStart))
bot.on('windowClose', (w: any) => console.log('[evt] windowClose', w?.type))
bot.on('error', (e: Error) => console.log('[err]', e.message))
bot._client.on('error', (e: Error) => console.log('[client err]', e.message))

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return Promise.race([
    p.then((v) => v as T | null).catch(() => null),
    sleep(ms).then(() => { console.log('[probe] timeout', label); return null }),
  ])
}

async function collectLogs(target: number): Promise<void> {
  const deadline = Date.now() + 150000
  while ((inv().oak_log ?? 0) < target && Date.now() < deadline) {
    const positions = bot.findBlocks({ matching: (b: any) => b.name.endsWith('_log'), maxDistance: 96, count: 32 })
    if (positions.length === 0) { console.log('[probe] no logs found'); return }
    let progressed = false
    for (const pos of positions) {
      const block = bot.blockAt(pos as any)
      if (block === null) continue
      const dist = bot.entity.position.distanceTo(block.position)
      console.log('[probe] collecting', block.name, pos, 'd=', dist.toFixed(1))
      if (dist > 4.5) {
        const goal = new goals.GoalNear(pos.x, pos.y, pos.z, 1)
        bot.pathfinder.setGoal(goal)
        const reached = await withTimeout(new Promise<unknown>((res) => {
          const to = setTimeout(() => { bot.removeListener('goal_reached', h); res(null) }, 12000)
          const h = (): void => { clearTimeout(to); res(true) }
          bot.once('goal_reached', h)
        }), 13000, 'path ' + pos)
        bot.pathfinder.setGoal(null)
        if (reached === null) continue
      }
      try {
        const fresh = bot.blockAt(pos as any)
        if (fresh === null) continue
        await withTimeout(bot.dig(fresh as any) as Promise<unknown>, 15000, 'dig ' + pos)
        progressed = true
      } catch (e) {
        console.log('[probe] dig failed:', (e as Error).message)
      }
      await sleep(600)
      if ((inv().oak_log ?? 0) >= target) break
      if (progressed) break
    }
    if (!progressed) console.log('[probe] one pass done, inv=', JSON.stringify(inv()))
    await sleep(400)
  }
}

function findPlaceSpot(): { ref: unknown; face: { x: number; y: number; z: number } } | null {
  const p = bot.entity.position.floored()
  const dirs = [
    { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  ]
  for (const d of dirs) {
    const target = p.offset(d.x, d.y, d.z)
    const below = target.offset(0, -1, 0)
    const at = bot.blockAt(target as never)
    const ref = bot.blockAt(below as never)
    if (at === null || at.boundingBox !== 'empty') continue
    if (ref === null || ref.boundingBox !== 'block') continue
    return { ref, face: { x: 0, y: 1, z: 0 } }
  }
  return null
}

async function main(): Promise<void> {
  await sleep(8000)
  if (process.argv.includes('--fresh')) {
    bot.chat('/clear')
    await sleep(1500)
    for (let pass = 0; pass < 5 && bot.inventory.items().length > 0; pass += 1) {
      for (const it of [...bot.inventory.items()]) {
        try { await bot.tossStack(it) } catch { break }
      }
      await sleep(400)
    }
  }
  console.log('[probe] spawn', bot.entity.position, 'inv=', JSON.stringify(inv()))
  await collectLogs(process.argv.includes('--seed') ? 4 : 1)
  console.log('[probe] after collect inv=', JSON.stringify(inv()))
  if (process.argv.includes('--seed')) { bot.quit(); return }

  const planksId = bot.registry.itemsByName['oak_planks'].id
  const stickId = bot.registry.itemsByName['stick'].id
  const pickId = bot.registry.itemsByName['wooden_pickaxe'].id
  const tableId = bot.registry.itemsByName['crafting_table'].id

  // planks until >= 9
  while ((inv().oak_planks ?? 0) < 9) {
    const r = bot.recipesFor(planksId, null, 1, null)[0]
    if (!r) { console.log('[probe] no planks recipe'); break }
    console.log('[probe] craft planks, inv=', JSON.stringify(inv()))
    await bot.craft(r, 1)
    await sleep(300)
  }
  // sticks (2 planks -> 4 sticks) need >= 2
  const stickRecipe = bot.recipesFor(stickId, null, 1, null)[0]
  if (stickRecipe && (inv().oak_planks ?? 0) >= 2 && (inv().stick ?? 0) < 2) {
    console.log('[probe] craft sticks, inv=', JSON.stringify(inv()))
    await bot.craft(stickRecipe, 1)
    await sleep(300)
  }
  // crafting table
  const tableRecipe = bot.recipesFor(tableId, null, 1, null)[0]
  console.log('[probe] table recipe requiresTable=', tableRecipe?.requiresTable, 'delta=', JSON.stringify(tableRecipe?.delta))
  if (tableRecipe && (inv().crafting_table ?? 0) === 0) {
    await bot.craft(tableRecipe, 1)
    await sleep(400)
  }
  console.log('[probe] pre-place inv=', JSON.stringify(inv()))

  // place the table
  const spot = findPlaceSpot()
  let tableBlock: any = null
  if (spot !== null && (inv().crafting_table ?? 0) > 0) {
    const tableItem = bot.inventory.items().find((i: any) => i.name === 'crafting_table')
    if (tableItem) {
      await bot.equip(tableItem, 'hand')
      await sleep(200)
      try {
        await bot.placeBlock(spot.ref, spot.face)
        await sleep(500)
      } catch (e) { console.log('[probe] placeBlock failed:', (e as Error).message) }
    }
    // find the placed table near us
    const tables = bot.findBlocks({ matching: (b: any) => b.name === 'crafting_table', maxDistance: 6, count: 4 })
    if (tables.length > 0) tableBlock = bot.blockAt(tables[0] as any)
  }
  console.log('[probe] placed table=', tableBlock?.position ?? null, 'inv=', JSON.stringify(inv()))

  if (tableBlock === null) { console.log('[probe] ABORT no table placed'); bot.quit(); return }

  const recipes = bot.recipesFor(pickId, null, 1, tableBlock)
  console.log('[probe] pickaxe recipes at table=', recipes.length)
  for (const r of recipes) {
    console.log('[probe]   recipe requiresTable=', r.requiresTable, 'result=', JSON.stringify(r.result), 'delta=', JSON.stringify(r.delta))
  }
  const recipe = recipes[0]
  if (!recipe) { console.log('[probe] ABORT no pickaxe recipe'); bot.quit(); return }

  // ---- Reproduce the AGENT's runCraft path via the real Executor ----
  const logger = new EventLogger(null, false)
  const executor = new Executor(bot, logger, { ...defaultExecutorOptions, actuation: 'pathfinder', reach: 5 })
  executor.ensureMovements()
  const candidate = {
    id: 'CRAFT:wooden_pickaxe',
    kind: 'CRAFT' as const,
    label: 'agent-path craft wooden_pickaxe at table',
    targetName: 'wooden_pickaxe',
    target: { x: tableBlock.position.x, y: tableBlock.position.y, z: tableBlock.position.z },
    targetEntityId: null,
    itemName: 'wooden_pickaxe',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { craftItem: 'wooden_pickaxe', craftCount: 1, requiresTable: true },
  }
  console.log('[probe] AGENT-PATH before inv=', JSON.stringify(inv()))
  const claim = executor.claim(candidate)
  const res = await claim.completion
  await sleep(800)
  console.log('[probe] AGENT-PATH result=', JSON.stringify({ status: res.status, detail: res.detail, gained: res.itemsGained }))
  console.log('[probe] AGENT-PATH after inv=', JSON.stringify(inv()))

  console.log('[probe] BEFORE craft inv=', JSON.stringify(inv()))
  console.log('[probe] window before=', bot.currentWindow?.type ?? 'none')
  let craftErr: string | null = null
  try {
    await bot.craft(recipe, 1, tableBlock)
  } catch (e) {
    craftErr = (e as Error).message
  }
  await sleep(1500)
  console.log('[probe] craft error=', craftErr)
  console.log('[probe] AFTER craft inv=', JSON.stringify(inv()))
  console.log('[probe] window after=', bot.currentWindow?.type ?? 'none')
  bot.quit()
}

bot.once('spawn', () => { main().catch((e) => { console.log('[probe] fatal', e); bot.quit() }) })
setTimeout(() => { console.log('[probe] hard timeout'); bot.quit() }, 210000)
