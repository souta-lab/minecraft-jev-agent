// Read-only CPU replica for the resident decision loop's SENSING and
// CANDIDATE phases. It connects a second, non-actuating bot to the live world
// and repeatedly runs the SAME pure functions the controller runs each tick:
//
//   buildWorldState(bot, input, sensorOptions)          <- jev-agent/src/state.ts
//   generateGroundedCandidates(state, candidateOptions) <- jev-agent/src/candidates.ts
//
// with `reachability.pathProbe` wired to the real pathfinder exactly like
// `Controller.reachabilityGateOptions()` does, so the per-candidate path probe
// cost is included.
//
// It NEVER moves, digs, places, eats, attacks or talks to the live resident.
// It is a measurement instrument, not an agent.
//
//   bun tools/cpu-replica.mts [--user AI_M2CPU] [--loops 20] [--warmup 3]
//
// Output: one JSON line per iteration on stdout, plus a summary.
import mineflayer from 'mineflayer'
import pathfinderModule, { goals } from 'mineflayer-pathfinder'
import { plugin as collectBlockPlugin } from 'mineflayer-collectblock'
import { buildWorldState, defaultSensorOptions, type SensorInput } from './src/state.ts'
import { defaultCandidateOptions, generateGroundedCandidates, type CandidateOptions } from './src/candidates.ts'
import type { KnownResource } from './src/state.ts'

const argv = process.argv.slice(2)
function arg(name: string, fallback: string): string {
  const i = argv.indexOf(name)
  const next = i >= 0 ? argv[i + 1] : undefined
  return next !== undefined && next !== '' ? next : fallback
}
const USER = arg('--user', 'AI_M2CPU')
const LOOPS = Number(arg('--loops', '20'))
const WARMUP = Number(arg('--warmup', '3'))
const PATH_PROBE_TIMEOUT_MS = 750
// `--revision N` turns on the cross-build scan cache with the given world
// revision. The replica never mutates the world, so a constant revision is the
// faithful model of a stalled body that has not changed any block. `--revision
// off` (the default) measures the uncached path.
const REVISION = arg('--revision', 'off')
const worldRevision = REVISION === 'off' ? null : Number(REVISION)
// The live body carries cobblestone, so `scanPrerequisiteStone` is false live.
// Passing the same inventory here keeps the replica's scan set faithful instead
// of over-measuring the stone/prerequisite scans a bare bot would trigger.
const INV = arg('--inv', 'cobblestone:402,oak_log:1,birch_log:3,stick:2,diamond_pickaxe:1')
const fakeInventory = {
  slots: [] as unknown[],
  items: () =>
    INV.split(',')
      .filter((s) => s !== '')
      .map((entry, i) => {
        const [name, count] = entry.split(':')
        return { name, count: Number(count ?? 1), slot: 36 + i }
      }),
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: USER, version: '1.21.11', auth: 'offline' })
bot.loadPlugin(pathfinderModule.pathfinder)
bot.loadPlugin(collectBlockPlugin)

bot.on('error', (e: Error) => console.error('[replica] error', e.message))
bot.on('kicked', (r: unknown) => console.error('[replica] kicked', JSON.stringify(r)))

function makeInput(tick: number, focusItem: string): SensorInput {
  const current = {
    id: 'g2:surface:log',
    kind: 'surface' as const,
    description: 'recover vertical access to y>=86 and collect 1 x log',
    targetItem: focusItem,
    requiredCount: 1,
    targetY: 86,
    dimension: null,
    optionInstanceId: 'surface:log:strategy=return_to_surface#y86',
    optionTemplateId: 'surface:log:strategy=return_to_surface',
    status: 'active' as const,
    haveCount: 0,
  }
  return {
    tick,
    goal: {
      id: 'collect:iron_ingot',
      description: 'collect 3 x iron_ingot',
      targetItem: 'iron_ingot',
      requiredCount: 3,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: Date.now(),
    },
    goalQueue: {
      depth: 1,
      current: current as never,
      empty: false,
      hasImpossible: false,
      done: 1,
      goals: [current as never],
      revision: 1,
    },
    focusItem,
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 1,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: [] as KnownResource[],
    },
  }
}

bot.once('spawn', async () => {
  await sleep(9000) // let chunks load, mirroring probe-terrain.mjs
  const pos = bot.entity.position
  console.error(`[replica] user=${USER} feet=(${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)})`)

  const pathCache = new Map<string, 'reachable' | 'no_path'>()
  let probeCount = 0
  let probeMs = 0
  const canComputePath = (p: { x: number; y: number; z: number }): boolean => {
    if (bot.pathfinder === undefined) return false
    try {
      const goal = new goals.GoalBlock(p.x, p.y, p.z)
      const plan = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
      return plan.status === 'success'
    } catch {
      return false
    }
  }
  const pathProbe = (p: { x: number; y: number; z: number }): 'reachable' | 'no_path' => {
    const key = `${p.x},${p.y},${p.z}`
    const cached = pathCache.get(key)
    if (cached !== undefined) return cached
    const t0 = performance.now()
    const result = canComputePath(p) ? 'reachable' : 'no_path'
    probeMs += performance.now() - t0
    probeCount += 1
    pathCache.set(key, result)
    return result
  }

  const sensorOptions = { ...defaultSensorOptions, worldRevision }
  const candidateOptions: CandidateOptions = {
    ...defaultCandidateOptions,
    reachability: { memory: null, pathProbe },
  } as CandidateOptions

  // Count every bot.blockAt call and how many distinct cells they address.
  // This measures the headroom of a per-build block-lookup memo.
  const origBlockAt = bot.blockAt.bind(bot)
  let atCalls = 0
  const atCells = new Set<string>()

  const samples: Array<Record<string, number>> = []
  const byScan = new Map<string, number>()
  let sampleStacks = false
  for (let i = 0; i < LOOPS + WARMUP; i += 1) {
    pathCache.clear()
    probeCount = 0
    probeMs = 0
    atCalls = 0
    atCells.clear()
    sampleStacks = i === LOOPS + WARMUP - 1
    const input = makeInput(i, 'log')
    const savedBlockAt = bot.blockAt
    bot.blockAt = ((p: unknown) => {
      atCalls += 1
      const v = p as { x: number; y: number; z: number }
      atCells.add(`${v.x},${v.y},${v.z}`)
      if (sampleStacks && atCalls % 400 === 0) {
        const line = (new Error().stack ?? '').split('\n').find((l) => l.includes('/jev-agent/src/state.ts') && !l.includes('blockAtCached'))
        const fn = line?.trim().split(' ')[1] ?? '(unknown)'
        byScan.set(fn, (byScan.get(fn) ?? 0) + 1)
      }
      return origBlockAt(p as never)
    }) as typeof bot.blockAt

    const t0 = performance.now()
    const savedInventory = bot.inventory
    bot.inventory = fakeInventory as never
    let state
    try {
      state = buildWorldState(bot, input, sensorOptions)
    } finally {
      bot.inventory = savedInventory
    }
    const t1 = performance.now()
    bot.blockAt = savedBlockAt
    const grounded = generateGroundedCandidates(state, candidateOptions)
    const t2 = performance.now()

    const row = {
      i,
      sensingMs: +(t1 - t0).toFixed(2),
      candidatesMs: +(t2 - t1).toFixed(2),
      totalMs: +(t2 - t0).toFixed(2),
      pathProbes: probeCount,
      pathProbeMs: +probeMs.toFixed(2),
      blocks: state.blocks.length,
      standable: state.terrain.standable.length,
      candidates: grounded.candidates.length,
      blockAtCalls: atCalls,
      blockAtCells: atCells.size,
    }
    if (i >= WARMUP) samples.push(row)
    console.log(JSON.stringify(row))
  }

  const totalSampled = [...byScan.values()].reduce((a, b) => a + b, 0)
  if (totalSampled > 0) {
    const ranked = [...byScan.entries()].sort((a, b) => b[1] - a[1])
    console.log('[replica] BLOCKAT_CALLS_BY_SCAN (sampled 1/' + 400 + ')')
    for (const [fn, n] of ranked) console.log(`  ${((n / totalSampled) * 100).toFixed(1)}%  ${fn}  (×${n * 400} est)`)
  }

  const avg = (k: string) => +(samples.reduce((s, r) => s + (r[k] ?? 0), 0) / samples.length).toFixed(2)
  console.log(
    '[replica] SUMMARY ' +
      JSON.stringify({
        loops: samples.length,
        user: USER,
        sensingMs: avg('sensingMs'),
        candidatesMs: avg('candidatesMs'),
        totalMs: avg('totalMs'),
        pathProbes: avg('pathProbes'),
        pathProbeMs: avg('pathProbeMs'),
      }),
  )
  bot.quit()
  process.exit(0)
})
