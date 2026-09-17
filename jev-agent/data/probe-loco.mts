// probe-loco.mts - RE-DIAGNOSIS of the terrain-contact locomotion stall with the
// collision-shape data PROVEN present (minecraft-data@3.116.0 ships
// blockCollisionShapes for pc/26.1 and prismarine-physics reads `block.shapes`;
// the probe prints the shape of the block underfoot).
//
// No server commands are used (the bots are not opped). The rig is built by the
// bot through normal gameplay:
//   * dig a surface block -> hold dirt -> `bot.placeBlock()` a 1-block step
//   * dig the block underfoot -> the bot is inside a 1-block pit
// Then the STOCK mineflayer-pathfinder is asked to plan + follow with normal
// Movements (canDig=false, allowParkour=true, allow1by1towers=true) and every
// pathfinder event plus the resulting position change is printed.
//
// Run: npx tsx data/probe-loco.mts --username AI_P2
import mineflayer from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderModule

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback
}

const username = opt('username', 'AI_P2')
const host = opt('host', '127.0.0.1')
const port = Number(opt('port', '25565'))
const scanRadius = Number(opt('scan', '16'))

const bot = mineflayer.createBot({ host, port, username, auth: 'offline' })
bot.loadPlugin(pathfinder)

const t0 = Date.now()
const log = (...args: unknown[]): void => {
  process.stdout.write(`[loco +${((Date.now() - t0) / 1000).toFixed(2)}s] ${args.join(' ')}\n`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const fmt = (p: { x: number; y: number; z: number }): string =>
  `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`

let forced = 0
bot.on('forcedMove', () => {
  forced += 1
})

function wireEvents(): void {
  bot.on('path_update', (p: { status: string; path?: unknown[] }) => {
    log(`EV path_update status=${p.status} nodes=${p.path?.length ?? 0}`)
  })
  bot.on('goal_reached', () => log('EV goal_reached'))
  bot.on('path_reset', (reason: string) => log(`EV path_reset reason=${reason}`))
  bot.on('goal_updated', () => log('EV goal_updated'))
}

async function waitArrival(timeoutMs: number): Promise<'reached' | 'noPath' | 'stuck' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false
    const done = (outcome: 'reached' | 'noPath' | 'stuck' | 'timeout'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onUpdate)
      bot.removeListener('path_reset', onReset)
      resolve(outcome)
    }
    const onReached = (): void => done('reached')
    const onUpdate = (p: { status: string }): void => {
      if (p.status === 'noPath') done('noPath')
      else if (p.status === 'timeout') done('timeout')
    }
    const onReset = (reason: string): void => {
      if (reason === 'stuck') done('stuck')
    }
    const timer = setTimeout(() => done('timeout'), timeoutMs)
    bot.on('goal_reached', onReached)
    bot.on('path_update', onUpdate)
    bot.on('path_reset', onReset)
  })
}

async function waitSettled(maxMs: number): Promise<void> {
  const started = Date.now()
  let last = bot.entity?.position.clone()
  let stable = Date.now()
  while (Date.now() - started < maxMs) {
    await sleep(200)
    const cur = bot.entity?.position
    if (cur === undefined) continue
    if (last !== undefined && cur.distanceTo(last) < 0.05) {
      if (Date.now() - stable >= 600) return
    } else {
      stable = Date.now()
    }
    last = cur.clone()
  }
}

async function goto(x: number, y: number, z: number, label: string): Promise<boolean> {
  forced = 0
  const before = bot.entity.position.clone()
  log(`--- ${label}: GoalBlock(${x},${y},${z}) from ${fmt(before)} ---`)
  const outcome = waitArrival(20000)
  bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z))
  const result = await outcome
  const after = bot.entity.position.clone()
  const reached =
    Math.hypot(after.x - (x + 0.5), after.z - (z + 0.5)) <= 1.0 && Math.abs(after.y - y) <= 0.75
  log(
    `RESULT ${label}: outcome=${result} reached=${reached} start=${fmt(before)} end=${fmt(after)} dxz=${Math.hypot(after.x - before.x, after.z - before.z).toFixed(2)} dy=${(after.y - before.y).toFixed(2)} forcedMove=${forced}`,
  )
  bot.pathfinder.setGoal(null)
  await sleep(400)
  return reached
}

interface FlatArea {
  cx: number
  cz: number
  gy: number
}

/** Blocks whose drop can be placed back (so the probe can build a step by hand). */
const PLACEABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'sand', 'red_sand', 'gravel', 'stone', 'cobblestone'])

/** Find the closest flat area whose cells are all solid with top block at the same y. */
function findFlatArea(): FlatArea | null {
  const feet = bot.entity.position
  const bx = Math.floor(feet.x)
  const bz = Math.floor(feet.z)
  const by = Math.floor(feet.y)
  let best: FlatArea | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (let cx = bx - scanRadius; cx <= bx + scanRadius; cx += 1) {
    for (let cz = bz - scanRadius; cz <= bz + scanRadius; cz += 1) {
      let gy: number | null = null
      let ok = true
      for (let dx = -1; dx <= 2 && ok; dx += 1) {
        for (let dz = -1; dz <= 2 && ok; dz += 1) {
          const top = surfaceTop(cx + dx, cz + dz, by)
          if (top === null) {
            ok = false
            break
          }
          if (gy === null) gy = top
          else if (top !== gy) ok = false
          if (ok) {
            const a = bot.blockAt(bot.entity.position.clone().set(cx + dx, top + 1, cz + dz))
            const b = bot.blockAt(bot.entity.position.clone().set(cx + dx, top + 2, cz + dz))
            if (a === null || a.boundingBox !== 'empty' || b === null || b.boundingBox !== 'empty') ok = false
          }
        }
      }
      if (!ok || gy === null) continue
      if (gy < by - 6 || gy > by + 6) continue
      const centerBlock = bot.blockAt(bot.entity.position.clone().set(cx, gy, cz))
      const matBlock = bot.blockAt(bot.entity.position.clone().set(cx + 1, gy, cz))
      const stepRef = bot.blockAt(bot.entity.position.clone().set(cx - 1, gy, cz))
      if (centerBlock === null || !PLACEABLE.has(centerBlock.name)) continue
      if (matBlock === null || !PLACEABLE.has(matBlock.name)) continue
      if (stepRef === null || stepRef.boundingBox !== 'block') continue
      const d = Math.hypot(cx + 0.5 - feet.x, cz + 0.5 - feet.z)
      if (d < bestD) {
        bestD = d
        best = { cx, cz, gy }
      }
    }
  }
  return best
}

/** Highest solid block top in column, scanned around the bot's feet level. */
function surfaceTop(x: number, z: number, aroundY: number): number | null {
  for (let y = aroundY + 4; y >= aroundY - 8; y -= 1) {
    const block = bot.blockAt(bot.entity.position.clone().set(x, y, z))
    if (block !== null && block.boundingBox === 'block') return y
  }
  return null
}

async function digAt(x: number, y: number, z: number): Promise<boolean> {
  const block = bot.blockAt(bot.entity.position.clone().set(x, y, z))
  if (block === null || block.boundingBox === 'empty') return false
  try {
    await bot.dig(block)
    return true
  } catch (error) {
    log(`dig failed at (${x},${y},${z}): ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

bot.once('spawn', async () => {
  try {
    wireEvents()
    log(`spawned as ${username} at ${fmt(bot.entity.position)}`)
    await sleep(2500)
    await waitSettled(4000)

    const under = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    log(
      `block-under name=${under?.name} boundingBox=${under?.boundingBox} shapes=${JSON.stringify((under as unknown as { shapes?: unknown }).shapes)?.slice(0, 60)}`,
    )

    const flat = findFlatArea()
    if (flat === null) {
      log('ABORT: no flat 4x4 area found')
      bot.quit('no-flat')
      setTimeout(() => process.exit(1), 500)
      return
    }
    const { cx, cz, gy } = flat
    log(`flat area at (${cx},${gy},${cz}); walking there`)
    await goto(cx, gy + 1, cz, 'TO-FLAT')
    await waitSettled(3000)

    const movements = new Movements(bot)
    movements.canDig = false
    movements.allowParkour = true
    movements.allow1by1towers = true
    movements.scafoldingBlocks = []
    bot.pathfinder.setMovements(movements)
    log(
      `movements: canDig=${movements.canDig} allowParkour=${movements.allowParkour} allow1by1towers=${movements.allow1by1towers} scaffolding=${JSON.stringify(movements.scafoldingBlocks)}`,
    )

    const results: Array<{ name: string; ok: boolean; detail: string }> = []

    // --- Build material: dig the surface block one cell EAST of the bot.
    const matX = cx + 1
    const matZ = cz
    const source = bot.blockAt(bot.entity.position.clone().set(matX, gy, matZ))
    log(`digging material ${source?.name ?? 'none'} at (${matX},${gy},${matZ})`)
    await digAt(matX, gy, matZ)
    await sleep(1200)
    // Pick up the drop (walk half a block toward it if needed).
    const dirt = bot.inventory.items().find((i) => PLACEABLE.has(i.name))
    log(`inventory after dig: ${JSON.stringify(bot.inventory.items().map((i) => `${i.name}x${i.count}`))}`)
    if (dirt === undefined) {
      log('ABORT: no dirt obtained for the step')
      bot.quit('no-dirt')
      setTimeout(() => process.exit(1), 500)
      return
    }

    // --- Place a 1-block step one cell WEST of the bot.
    const stepX = cx - 1
    const stepZ = cz
    const reference = bot.blockAt(bot.entity.position.clone().set(stepX, gy, stepZ))
    if (reference === null || reference.boundingBox !== 'block') {
      log('ABORT: no reference ground for the step')
      bot.quit('no-ref')
      setTimeout(() => process.exit(1), 500)
      return
    }
    await bot.equip(dirt, 'hand')
    await bot.lookAt(reference.position.offset(0.5, 0.5, 0.5), true)
    await bot.placeBlock(reference, bot.entity.position.clone().set(0, 1, 0))
    await sleep(800)
    const placed = bot.blockAt(bot.entity.position.clone().set(stepX, gy + 1, stepZ))
    log(`placed step block at (${stepX},${gy + 1},${stepZ}) -> ${placed?.name ?? 'null'} (top=${gy + 2})`)

    // --- PHASE 1: one-block step UP onto the placed block (feet gy+2).
    await goto(cx, gy + 1, cz, 'RESET-BEFORE-STEP')
    await waitSettled(2500)
    let before = bot.entity.position.clone()
    let ok = await goto(stepX, gy + 2, stepZ, 'STEP-UP-1-BLOCK')
    results.push({ name: 'step-up-1-block', ok, detail: `start=${fmt(before)} end=${fmt(bot.entity.position)}` })

    // --- PHASE 2: step DOWN into a 1-block pit (dig underfoot), then climb OUT.
    // Walk to a flat neighbour, then dig the block under the bot.
    await goto(cx, gy + 1, cz, 'PIT-PREP')
    await waitSettled(2500)
    const mineX = Math.floor(bot.entity.position.x)
    const mineZ = Math.floor(bot.entity.position.z)
    const pitY = surfaceTop(mineX, mineZ, Math.floor(bot.entity.position.y))
    if (pitY !== null) {
      log(`digging underfoot (${mineX},${pitY},${mineZ}) to create a 1-block pit`)
      await digAt(mineX, pitY, mineZ)
      await sleep(1500)
      await waitSettled(3000)
      log(`now inside the pit at ${fmt(bot.entity.position)} (surrounding top=${gy})`)
    }
    before = bot.entity.position.clone()
    ok = await goto(cx, gy + 1, cz + 1, 'PIT-OUT-1-BLOCK')
    results.push({
      name: 'climb-out-of-1-block-pit',
      ok,
      detail: `start=${fmt(before)} end=${fmt(bot.entity.position)}`,
    })

    let pass = 0
    log('==== LOCOMOTION RE-DIAGNOSIS ====')
    for (const r of results) {
      if (r.ok) pass += 1
      log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} :: ${r.detail}`)
    }
    log(`${pass}/${results.length} stock-pathfinder locomotion checks passed`)
    bot.quit('done')
    setTimeout(() => process.exit(pass === results.length ? 0 : 2), 600)
  } catch (error) {
    log(`probe failed: ${error instanceof Error ? error.stack : String(error)}`)
    bot.quit('error')
    setTimeout(() => process.exit(1), 500)
  }
})

bot.on('error', (e) => log(`bot error: ${e.message}`))
bot.on('kicked', (r) => log(`kicked: ${JSON.stringify(r)}`))

setTimeout(() => {
  log('hard timeout')
  process.exit(3)
}, 150000)
