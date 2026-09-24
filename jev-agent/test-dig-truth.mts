// test-dig-truth.mts - regression fixture for the measured M3 dig stall.
//
// LIVE EVIDENCE (m3-live, source f13aac2 and cb3e4ed, run-mubbsnde-1jzm5):
// every `MINE:*_9` on the verified obsidian column (25..28, 66..70, 9) died as
// `dig_timeout` after exactly 15000ms with `progressDelta=0`, holding a diamond
// pickaxe (`TOOL_CHOICE block=obsidian tool=pickaxe tier=4`):
//   decisions.jsonl: {"actionId":"MINE:b28_67_9",...,"durationMs":15001,
//                     "progress":0,"status":"failed","failureCode":"dig_timeout"}
//   run.jsonl:       action#63 MINE:b28_67_9 FAILED
//                    {"failure":"dig_timeout","message":"dig timed out after 15000ms"}
//   mirrored CAUSAL: verified=false status=failed resource=obsidian progressDelta=0
// The candidate was reachable and the block was real (read-only scan), so the
// boundary is the mechanism, not the approach.
//
// TWO independent multipliers priced the same dig far above the flat budget:
//   * `incorrect_for_wooden_tool` (obsidian / iron_ore / diamond_ore /
//     ancient_debris) has no non-wooden tool entry in minecraft-data 3.116.0, so
//     prismarine-block falls back to speed 1 -> obsidian 75000ms, not 9375ms;
//   * the stale `onGround=false` parity quirk adds the vanilla /5 (375000ms) -
//     the half cb3e4ed grounds away (75000ms grounded is STILL past 15000ms).
// This fixture pins the break-speed DATA (the half that was still wrong after
// cb3e4ed), the truth oracle that detects it, the schedule-derived cancel
// budget, the bounded race, and the typed `DIG_FAILED` marker. Fail-before: the
// repair/plan/budget helpers do not exist on the pre-fix source (red);
// pass-after: the registry is repaired to the physically correct schedule and
// the budget covers it.
//
// Run: bun test ./test-dig-truth.mts
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { EventLogger } from './src/jev.ts'
import { Executor, ExecutorError, defaultExecutorOptions } from './src/executor.ts'
import type { Candidate } from './src/candidates.ts'
import { liveStructureCellKey } from './src/blockSafety.ts'
import { selectClearanceTool, selectDigTool } from './src/toolChoice.ts'
import {
  DIG_BUDGET_MAX_MS,
  DIG_BUDGET_SLACK_MS,
  correctDigSpeedMaterials,
  expectedDigTimeMs,
  formatDigBudget,
  formatDigFailed,
  formatDigSpeedRepaired,
  planDigTime,
  runBoundedDig,
  toolMaterialSpeed,
} from './src/digTruth.ts'
import type { DigMechanism } from './src/digTruth.ts'

const require = createRequire(import.meta.url)
const mcData = require('minecraft-data')('1.21.11')
const BlockFactory = require('prismarine-block')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}
const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const DIAMOND_PICKAXE = mcData.itemsByName.diamond_pickaxe.id as number
const OBSIDIAN_HARDNESS = 50
const TRUE_OBSIDIAN_MS = 9400 // ceil(1 / (8 / 50 / 30)) = 188 ticks = 9400ms (real value 9375ms)
const FLAT_BUDGET_MS = defaultExecutorOptions.digTimeoutMs

/** A registry clone so the in-place repair never leaks between cases. */
function freshRegistry(): Record<string, unknown> {
  return { ...mcData, materials: JSON.parse(JSON.stringify(mcData.materials)) }
}

interface RegistryBlockLike {
  digTime: (...args: unknown[]) => number
  hardness: number
  harvestTools?: Record<number, boolean> | null
  canHarvest: (type: number) => boolean
  position?: unknown
}

function blockOn(registry: Record<string, unknown>, name: string): RegistryBlockLike {
  const factory = BlockFactory(registry) as { fromStateId: (id: number, biome: number) => RegistryBlockLike }
  const blocks = (registry as { blocksByName: Record<string, { defaultState: number } | undefined> }).blocksByName
  const entry = blocks[name]
  if (entry === undefined) throw new Error(`block ${name} missing from the registry`)
  return factory.fromStateId(entry.defaultState, 0)
}

function obsidianOn(registry: Record<string, unknown>): RegistryBlockLike {
  return blockOn(registry, 'obsidian')
}

// --- (a) FAIL-BEFORE: the mechanism's own schedule cannot fit the flat budget -

addCase('(a) the client prices diamond-pickaxe obsidian at 75000ms, not 9375ms', () => {
  const block = obsidianOn(freshRegistry())
  const judged = block.digTime(DIAMOND_PICKAXE, false, false, false, [])
  const truth = expectedDigTimeMs({
    hardness: OBSIDIAN_HARDNESS,
    canHarvest: block.canHarvest(DIAMOND_PICKAXE),
    toolSpeed: toolMaterialSpeed('diamond_pickaxe'),
    onGround: true,
    inWater: false,
  })
  return {
    pass: judged === 75000 && truth === TRUE_OBSIDIAN_MS && judged > FLAT_BUDGET_MS,
    detail: `client=${judged}ms truth=${truth}ms flatBudget=${FLAT_BUDGET_MS}ms -> the flat budget aborts every obsidian dig`,
  }
})

addCase('(a) the stale airborne flag multiplies that wrong schedule by 5 (375000ms)', () => {
  const block = obsidianOn(freshRegistry())
  const grounded = block.digTime(DIAMOND_PICKAXE, false, false, false, [])
  const airborne = block.digTime(DIAMOND_PICKAXE, false, false, true, [])
  return {
    pass: airborne === grounded * 5 && airborne > FLAT_BUDGET_MS && grounded > FLAT_BUDGET_MS,
    detail: `grounded=${grounded}ms airborne=${airborne}ms (grounding alone leaves ${grounded}ms > ${FLAT_BUDGET_MS}ms)`,
  }
})

// --- (b) PASS-AFTER: the repair makes the mechanism's schedule tell the truth -

addCase('(b) repair prices obsidian at the true 9400ms and is idempotent', () => {
  const registry = freshRegistry()
  const block = obsidianOn(registry)
  const before = block.digTime(DIAMOND_PICKAXE, false, false, false, [])
  const added = correctDigSpeedMaterials(registry)
  const after = block.digTime(DIAMOND_PICKAXE, false, false, false, [])
  const again = correctDigSpeedMaterials(registry)
  return {
    pass: before === 75000 && added === 4 && after === 9400 && again === 0,
    detail: `${before}ms -> repaired(${added}) -> ${after}ms, second repair=${again}; ${formatDigSpeedRepaired(added)}`,
  }
})

addCase('(b) the repair does not move blocks the library already prices correctly', () => {
  const registry = freshRegistry()
  const stone = blockOn(registry, 'stone')
  const before = stone.digTime(DIAMOND_PICKAXE, false, false, false, [])
  correctDigSpeedMaterials(registry)
  const after = stone.digTime(DIAMOND_PICKAXE, false, false, false, [])
  return {
    pass: before === 300 && after === 300,
    detail: `stone before=${before}ms after=${after}ms (unchanged)`,
  }
})

addCase('(b) the truth oracle matches the repaired library for stone, iron_ore and obsidian', () => {
  const registry = freshRegistry()
  correctDigSpeedMaterials(registry)
  const oracle = (name: string): { lib: number; truth: number } => {
    const block = blockOn(registry, name)
    return {
      lib: block.digTime(DIAMOND_PICKAXE, false, false, false, []),
      truth: expectedDigTimeMs({
        hardness: block.hardness,
        canHarvest: block.canHarvest(DIAMOND_PICKAXE),
        toolSpeed: toolMaterialSpeed('diamond_pickaxe'),
        onGround: true,
        inWater: false,
      }),
    }
  }
  const stone = oracle('stone')
  const iron = oracle('iron_ore')
  const obs = oracle('obsidian')
  return {
    pass:
      stone.lib === stone.truth &&
      iron.lib === iron.truth &&
      obs.lib === obs.truth &&
      iron.lib === 600 &&
      obs.lib === 9400,
    detail: `stone ${stone.lib}/${stone.truth} iron_ore ${iron.lib}/${iron.truth} obsidian ${obs.lib}/${obs.truth}`,
  }
})

// --- (c) the cancel budget is derived from the mechanism's own schedule -------

addCase('(c) a 9400ms obsidian schedule already fits the configured floor', () => {
  const plan = planDigTime(9400, FLAT_BUDGET_MS)
  return {
    pass: plan.budgetMs === FLAT_BUDGET_MS && plan.extended === false,
    detail: formatDigBudget(plan),
  }
})

addCase('(c) a schedule past floor - slack grows the budget to schedule + slack', () => {
  const plan = planDigTime(14_000, FLAT_BUDGET_MS)
  return {
    pass: plan.budgetMs === 14_000 + DIG_BUDGET_SLACK_MS && plan.budgetMs > plan.libraryMs && plan.extended,
    detail: formatDigBudget(plan),
  }
})

addCase('(c) a cheap dig keeps the configured floor', () => {
  const plan = planDigTime(300, FLAT_BUDGET_MS)
  return {
    pass: plan.budgetMs === FLAT_BUDGET_MS && plan.extended === false,
    detail: formatDigBudget(plan),
  }
})

addCase('(c) the ceiling still bounds a very slow schedule', () => {
  const slow = planDigTime(40_000, FLAT_BUDGET_MS)
  const huge = planDigTime(400_000, FLAT_BUDGET_MS)
  return {
    pass: slow.budgetMs === 42_000 && huge.budgetMs === DIG_BUDGET_MAX_MS,
    detail: `slow(40000)=${slow.budgetMs}ms huge(400000)=${huge.budgetMs}ms max=${DIG_BUDGET_MAX_MS}ms`,
  }
})

addCase('(c) an infinite schedule keeps the floor so the typed dig_error surfaces', () => {
  const plan = planDigTime(Number.POSITIVE_INFINITY, FLAT_BUDGET_MS)
  return {
    pass:
      plan.libraryMs === Number.POSITIVE_INFINITY &&
      plan.budgetMs === FLAT_BUDGET_MS &&
      plan.extended === false,
    detail: formatDigBudget(plan),
  }
})

// --- (d) the bounded race: timeout only when the mechanism overruns -----------

/** A mechanism whose dig resolves only if its own schedule fits the budget. */
function fakeMechanism(scheduleMs: number, budgetMs: number, mode: 'finish' | 'hang' | 'abort'): DigMechanism {
  let stop: (() => void) | null = null
  return {
    digTime: () => scheduleMs,
    dig: () =>
      new Promise<void>((resolve, reject) => {
        stop = () => reject(new Error('Digging aborted'))
        if (mode === 'abort') {
          reject(new Error('Digging aborted'))
          return
        }
        if (mode === 'hang') return
        if (scheduleMs <= budgetMs) resolve()
      }),
    stopDigging: () => {
      stop?.()
    },
  }
}

addCase('(d) a schedule inside the budget completes (obsidian after the repair)', async () => {
  const plan = planDigTime(9400, FLAT_BUDGET_MS)
  const race = await runBoundedDig(fakeMechanism(9400, plan.budgetMs, 'finish'), plan.budgetMs)
  return {
    pass: race.outcome === 'done' && race.scheduledMs === 9400,
    detail: `outcome=${race.outcome} scheduled=${race.scheduledMs}ms elapsed=${race.elapsedMs}ms`,
  }
})

addCase('(d) a schedule past the budget is cancelled as a timeout (the pre-fix shape)', async () => {
  const race = await runBoundedDig(fakeMechanism(600, 60, 'hang'), 60)
  return {
    pass: race.outcome === 'timeout' && race.scheduledMs === 600,
    detail: `schedule=600ms budget=60ms outcome=${race.outcome} elapsed=${race.elapsedMs}ms`,
  }
})

addCase('(d) a mechanism rejection is an error, never a silent success', async () => {
  const race = await runBoundedDig(fakeMechanism(20, 500, 'abort'), 500)
  return {
    pass: race.outcome === 'error' && race.error === 'Digging aborted',
    detail: `outcome=${race.outcome} error=${race.error}`,
  }
})

addCase('(d) a malformed schedule read is a typed error, not an escape', async () => {
  const race = await runBoundedDig(
    {
      digTime: () => {
        throw new Error('dig time for obsidian is Infinity')
      },
      dig: () => Promise.resolve(),
      stopDigging: () => {},
    },
    500,
  )
  return {
    pass: race.outcome === 'error' && race.error === 'dig time for obsidian is Infinity',
    detail: `outcome=${race.outcome} error=${race.error}`,
  }
})

// --- (e) the typed, mirrored marker ------------------------------------------

addCase('(e) DIG_FAILED names the reason, the live tool, the tier and the block', () => {
  const line = formatDigFailed({
    reason: 'dig_timeout',
    tool: 'diamond_pickaxe',
    tier: 4,
    block: { x: 28, y: 67, z: 9 },
    expectedMs: 9400,
    elapsedMs: 15001,
  })
  return {
    pass:
      line ===
      'DIG_FAILED reason=dig_timeout tool=diamond_pickaxe tier=4 block=28,67,9 expectedMs=9400 elapsedMs=15001',
    detail: line,
  }
})

addCase('(e) a missing tool is a typed dig_no_tool, not a silent hand dig', () => {
  const choice = selectDigTool(
    { name: 'obsidian', harvestTool: 'pickaxe', harvestTier: 4, diggable: true },
    () => false,
  )
  const line = formatDigFailed({
    reason: 'dig_no_tool',
    tool: null,
    tier: 4,
    block: { x: 28, y: 67, z: 9 },
    expectedMs: null,
    elapsedMs: 0,
  })
  return {
    pass:
      choice.ok === false &&
      choice.reason === 'needs_pickaxe_tier_4' &&
      line === 'DIG_FAILED reason=dig_no_tool tool=hand tier=4 block=28,67,9 expectedMs=unknown elapsedMs=0',
    detail: `${choice.reason} | ${line}`,
  }
})

addCase('(e) clearance may remove stone by hand while strict harvest still needs a pickaxe', () => {
  const stone = { name: 'stone', harvestTool: 'pickaxe' as const, harvestTier: 0, diggable: true }
  const harvest = selectDigTool(stone, () => false)
  const clearance = selectClearanceTool(stone, () => false)
  return {
    pass:
      !harvest.ok &&
      harvest.reason === 'needs_pickaxe_tier_0' &&
      clearance.ok &&
      clearance.tool === null,
    detail: `harvest=${harvest.reason} clearance=${clearance.reason}`,
  }
})

// --- (f) the real Executor seams ---------------------------------------------

class CapturingLogger extends EventLogger {
  readonly lines: string[] = []
  constructor() {
    super(null, false)
  }
  override info(_source: string, message: string): void {
    this.lines.push(message)
  }
  override warn(_source: string, message: string): void {
    this.lines.push(message)
  }
  override error(_source: string, message: string): void {
    this.lines.push(message)
  }
}

interface FakeBot {
  entity: { position: Vec3; velocity: { y: number }; onGround: boolean }
  physicsEnabled: boolean
  registry: Record<string, unknown>
  heldItem: { name: string; type: number } | null
  inventoryItems: Array<{ name: string; type: number }>
  on(event: string, listener: () => void): void
  removeListener(event: string, listener: () => void): void
  setControlState(): void
  clearControlStates(): void
  canDigBlock(): boolean
  lookAt(): Promise<void>
  blockAt(): { name: string; boundingBox: string } | null
  inventory: { items: () => Array<{ name: string; type: number }>; count: () => number }
  /** mineflayer's own schedule, read from the (repaired) registry + held item */
  digTime(block: unknown): number
  dig: () => Promise<void>
  stopDigging(): void
}

/**
 * The minimum bot surface `Executor.digBlock` reads. `digTime` reimplements
 * mineflayer's `bot.digTime(block)` from the live registry and held item, so the
 * fixture observes the repaired data exactly as the mechanism would.
 */
function fakeBot(registry: Record<string, unknown>, block: RegistryBlockLike): FakeBot {
  const listeners = new Map<string, Set<() => void>>()
  const bot: FakeBot = {
    entity: { position: new Vec3(28.4, 66, 10.4), velocity: { y: 0 }, onGround: true },
    physicsEnabled: false,
    registry,
    heldItem: { name: 'diamond_pickaxe', type: DIAMOND_PICKAXE },
    inventoryItems: [],
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    setControlState() {},
    clearControlStates() {},
    canDigBlock: () => true,
    lookAt: async () => {},
    blockAt: () => ({ name: 'obsidian', boundingBox: 'block' }),
    inventory: {
      items: () => bot.inventoryItems,
      count: () => 0,
    },
    digTime: (target: unknown) => {
      void block
      return (target as RegistryBlockLike).digTime(bot.heldItem?.type ?? 0, false, false, !bot.entity.onGround, [])
    },
    dig: () => Promise.resolve(),
    stopDigging() {},
  }
  return bot
}

type DigBlockCaller = {
  digBlock(block: unknown, epoch: number, signal: AbortSignal, purpose?: 'harvest' | 'clearance'): Promise<void>
}
type EquipCaller = { equipTool(candidate: Candidate, epoch: number, signal: AbortSignal): Promise<void> }

addCase('(f) the constructed Executor repairs the mechanism before the first dig', () => {
  const registry = freshRegistry()
  const block = obsidianOn(registry)
  const before = block.digTime(DIAMOND_PICKAXE, false, false, false, [])
  const bot = fakeBot(registry, block)
  const logger = new CapturingLogger()
  const executor = new Executor(bot as never, logger, defaultExecutorOptions)
  const after = (executor as unknown as { bot: FakeBot }).bot.digTime(block)
  return {
    pass: before === 75000 && after === 9400 && logger.lines.some((line) => line.startsWith('DIG_SPEED_DATA_REPAIRED')),
    detail: `${before}ms -> ${after}ms | ${logger.lines[0] ?? '(no marker)'}`,
  }
})

addCase('(f) digBlock completes the repaired obsidian dig and emits no DIG_FAILED', async () => {
  const registry = freshRegistry()
  const block = obsidianOn(registry)
  const bot = fakeBot(registry, block)
  const logger = new CapturingLogger()
  const executor = new Executor(bot as never, logger, defaultExecutorOptions)
  const live = block as RegistryBlockLike & { position: Vec3 }
  live.position = new Vec3(28, 67, 9)
  await (executor as unknown as DigBlockCaller).digBlock(live, 0, new AbortController().signal)
  const schedule = bot.digTime(live)
  const budget = planDigTime(schedule, FLAT_BUDGET_MS).budgetMs
  return {
    pass: schedule === 9400 && budget > schedule && !logger.lines.some((line) => line.startsWith('DIG_FAILED')),
    detail: `schedule=${schedule}ms budget=${budget}ms lines=${logger.lines.join(' | ') || '(none)'}`,
  }
})

addCase('(f) clearance dig bypasses the harvest-drop gate and records its intent', async () => {
  const registry = freshRegistry()
  const block = blockOn(registry, 'stone')
  const bot = fakeBot(registry, block)
  bot.heldItem = null
  bot.inventoryItems = []
  bot.digTime = () => 1
  const logger = new CapturingLogger()
  const executor = new Executor(bot as never, logger, defaultExecutorOptions)
  const live = block as RegistryBlockLike & { position: Vec3 }
  live.position = new Vec3(28, 67, 9)
  await (executor as unknown as DigBlockCaller).digBlock(live, 0, new AbortController().signal, 'clearance')
  return {
    pass:
      logger.lines.some((line) => line === 'DIG_INTENT purpose=clearance block=stone cell=28,67,9 dropRequired=false') &&
      !logger.lines.some((line) => line.startsWith('DIG_TOOL_LEGALITY')),
    detail: logger.lines.join(' | ') || '(no markers)',
  }
})

addCase('(f) direct clearance still refuses protected stations', async () => {
  const registry = freshRegistry()
  const block = blockOn(registry, 'crafting_table')
  const bot = fakeBot(registry, block)
  bot.heldItem = null
  bot.inventoryItems = []
  const logger = new CapturingLogger()
  const executor = new Executor(bot as never, logger, defaultExecutorOptions)
  const live = block as RegistryBlockLike & { position: Vec3 }
  live.position = new Vec3(28, 67, 9)
  let code: string | null = null
  try {
    await (executor as unknown as DigBlockCaller).digBlock(live, 0, new AbortController().signal, 'clearance')
  } catch (error) {
    code = error instanceof ExecutorError ? error.code : null
  }
  return {
    pass: code === 'protected_station' && !logger.lines.some((line) => line.startsWith('DIG_INTENT')),
    detail: `code=${code ?? 'none'} intent=${logger.lines.find((line) => line.startsWith('DIG_INTENT')) ?? 'none'}`,
  }
})

addCase('(f) direct clearance still refuses a live portal-frame member', async () => {
  const registry = freshRegistry()
  const block = obsidianOn(registry)
  const bot = fakeBot(registry, block)
  bot.heldItem = null
  bot.inventoryItems = []
  const logger = new CapturingLogger()
  const executor = new Executor(bot as never, logger, defaultExecutorOptions)
  const live = block as RegistryBlockLike & { position: Vec3 }
  live.position = new Vec3(28, 67, 9)
  ;(executor as unknown as { action: { liveStructureMembers: ReadonlyMap<string, string> } | null }).action = {
    liveStructureMembers: new Map([[liveStructureCellKey(live.position), 'nether_portal']]),
  }
  let code: string | null = null
  try {
    await (executor as unknown as DigBlockCaller).digBlock(live, 0, new AbortController().signal, 'clearance')
  } catch (error) {
    code = error instanceof ExecutorError ? error.code : null
  }
  return {
    pass:
      code === 'live_structure_member' &&
      logger.lines.some((line) => line.includes('LIVE_STRUCTURE_MEMBER_DIG_REFUSED structure=nether_portal')) &&
      !logger.lines.some((line) => line.startsWith('DIG_INTENT')),
    detail: `code=${code ?? 'none'} lines=${logger.lines.join(' | ') || 'none'}`,
  }
})

addCase('(f) ordinary harvest dig still refuses stone without a harvest tool', async () => {
  const registry = freshRegistry()
  const block = blockOn(registry, 'stone')
  const bot = fakeBot(registry, block)
  bot.heldItem = null
  bot.inventoryItems = []
  const logger = new CapturingLogger()
  const executor = new Executor(bot as never, logger, defaultExecutorOptions)
  const live = block as RegistryBlockLike & { position: Vec3 }
  live.position = new Vec3(28, 67, 9)
  let code: string | null = null
  try {
    await (executor as unknown as DigBlockCaller).digBlock(live, 0, new AbortController().signal)
  } catch (error) {
    code = error instanceof ExecutorError ? error.code : null
  }
  return { pass: code === 'dig_no_tool', detail: `code=${code ?? 'none'}` }
})

addCase('(f) a missing tool throws the typed dig_no_tool from the real equip seam', async () => {
  const registry = freshRegistry()
  const block = obsidianOn(registry)
  const bot = fakeBot(registry, block)
  bot.inventoryItems = [] // no pickaxe at all
  const logger = new CapturingLogger()
  const executor = new Executor(bot as never, logger, defaultExecutorOptions)
  const candidate = {
    id: 'MINE:b28_67_9',
    kind: 'MINE',
    label: 'mine obsidian at (28,67,9)',
    targetName: 'obsidian',
    target: { x: 28, y: 67, z: 9 },
    targetEntityId: null,
    itemName: null,
    requiresTool: true,
    toolName: 'pickaxe',
    toolTier: 4,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { digBlockName: 'obsidian', toolReason: 'pickaxe_required' },
  } as unknown as Candidate
  let code: string | null = null
  try {
    await (executor as unknown as EquipCaller).equipTool(candidate, 0, new AbortController().signal)
  } catch (error) {
    code = error instanceof ExecutorError ? error.code : null
  }
  return {
    pass: code === 'dig_no_tool',
    detail: `equipTool code=${code ?? 'none'} (expected dig_no_tool)`,
  }
})

// ---------------------------------------------------------------------------
let failures = 0
process.stdout.write('dig truth: the mechanism data and the cancel budget own the break\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} dig-truth cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
