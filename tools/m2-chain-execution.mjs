#!/usr/bin/env bun
// m2-chain-execution: the M2 chain driven through the REAL candidate layer and
// the REAL Executor, offline, with a fake body.
//
// WHY THIS EXISTS
// ---------------
// tools/m2-chain-rehearsal.mjs proves the PORTAL half by projecting the typed
// plan onto the marker names the executor emits, and by feeding a synthetic log
// to the real tools/m2-gate.mjs. That is a plan/profile proof: it never runs an
// Executor action and never observes an inventory change. The operator's
// acceptance asks for the WHOLE chain - mine iron -> smelt -> craft the pickaxe
// -> mine 3 diamond -> craft the diamond pickaxe -> obtain 10 obsidian from a
// legal source -> place the frame -> light it -> verify it - inside ONE run on a
// NEW SEED with NO assists, so the links between the portal half and the
// material half have to be rehearsed too, not asserted.
//
// WHAT THIS DOES
// --------------
// One fake body, one world model, ONE Executor instance and ONE run-scoped
// JSONL log. For every link:
//
//   1. the REAL sensor (`state.ts#buildWorldState`) reads the fake world;
//   2. the REAL candidate layer (`candidates.ts#generateGroundedCandidates`)
//      grounds the candidate for the link from that sensor state;
//   3. the REAL Executor (`executor.ts#Executor.claim`) executes it, actuating
//      through the allowlisted `ActuationPort` where the Executor uses the port
//      and through the fake body's own Mineflayer surface where it does not;
//   4. the INVENTORY DELTA and the run-scoped marker lines that link emitted
//      are measured, never assumed.
//
// The fixture supplies WORLD TRUTH only (which cells hold which blocks, what
// the body carries, what a furnace/crafting window answers). It never
// hand-builds a Candidate, never hand-writes a marker, and never reorders a
// link: a link with no grounded candidate, or whose Executor action fails, is
// reported as the FIRST UNDRIVABLE LINK with the typed reason that refused it.
//
// NOT REHEARSED HERE
// ------------------
// The tool bootstrap (logs -> planks -> crafting_table -> pickaxe) is owned by
// the tool-bootstrap lane and is NOT touched: the chain below starts from a
// post-bootstrap body that already holds a pickaxe. That first link is named as
// unrehearsed in the report, exactly once.
//
// Exit: 0 = every link driven, 1 = a link could not be driven.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateGroundedCandidates, defaultCandidateOptions } from '../packages/jev-agent/src/candidates.ts'
import { createRecipeIndex } from '../packages/jev-agent/src/crafting.ts'
import { emptyGoalQueueState } from '../packages/jev-agent/src/goalQueue.ts'
import { Executor, defaultExecutorOptions } from '../packages/jev-agent/src/executor.ts'
import { EventLogger, JsonlWriter } from '../packages/jev-agent/src/jev.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from '../packages/jev-agent/src/state.ts'
import {
  OBSIDIAN,
  OVERWORLD,
  orderedPlacementCells,
  portalFrameLayout,
  validatePortalFrame,
} from '../packages/jev-agent/src/netherPortalPlan.ts'

const require = createRequire(import.meta.url)
// `minecraft-data` is a jev-agent dependency, not a root one: resolve it from
// the package that declares it, never from the tools directory by accident.
const jevRequire = createRequire(new URL('../packages/jev-agent/package.json', import.meta.url))
const Vec3 = require('vec3')
const registry = jevRequire('minecraft-data')('1.21.11')
const RECIPES = createRecipeIndex(registry)

/** The candidate layer needs a recipe index; the default is `recipes: null`. */
export const CHAIN_CANDIDATE_OPTIONS = Object.freeze({ ...defaultCandidateOptions, recipes: RECIPES })

// ---------------------------------------------------------------------------
// world truth: blocks, inventory, stations, drops
// ---------------------------------------------------------------------------

const FLOOR_Y = 63
const FEET_Y = FLOOR_Y + 1
/** The frame origin and body cell the frame lane already proved (test-frame-build.mts). */
export const CHAIN_FRAME_ORIGIN = Object.freeze({ x: 10, y: FEET_Y, z: 0 })
export const CHAIN_FRAME_STAND = Object.freeze({ x: CHAIN_FRAME_ORIGIN.x + 1.5, y: FEET_Y, z: -1.5 })

/**
 * The post-bootstrap body. It HAS a pickaxe (the tool-bootstrap lane's output)
 * and the stations a smelt/craft needs. Every material below is either a world
 * block or a starting item: this rehearsal produces none of them by fiat.
 */
export const CHAIN_START_INVENTORY = Object.freeze({
  stone_pickaxe: 1,
  crafting_table: 1,
  furnace: 1,
  coal: 8,
  // Two sticks per pickaxe: the iron pickaxe and the diamond pickaxe both need
  // them, and planks -> sticks belongs to the tool-bootstrap link below.
  stick: 4,
  cobblestone: 16,
})

function blockKey(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

const itemId = (name) => registry.itemsByName?.[name]?.id ?? null
const itemName = (id) => registry.itemsById?.[id]?.name ?? RECIPES.itemName(id) ?? null

/** A mineflayer-compatible recipe view over minecraft-data, with a real delta. */
function recipesFor(counts, type, _metadata, minCount = 1, table = null) {
  const variants = registry.recipes?.[type] ?? []
  return variants
    .map((raw) => {
      const cells = raw.inShape !== undefined ? raw.inShape.flat() : (raw.ingredients ?? [])
      const need = new Map()
      for (const cell of cells) {
        if (cell === null || cell === undefined || cell === -1) continue
        const id = typeof cell === 'number' ? cell : cell.id
        if (id === -1) continue
        const n = typeof cell === 'number' ? 1 : (cell.count ?? 1)
        need.set(id, (need.get(id) ?? 0) + n)
      }
      const requiresTable =
        raw.inShape !== undefined
          ? raw.inShape.length > 2 || (raw.inShape[0]?.length ?? 0) > 2
          : (raw.ingredients?.length ?? 0) > 4
      // `craftWindow.ts#craftInWindow` reads `cell.id` and skips `-1`, exactly
      // like mineflayer's own `craft.js` (`ingredient.id === -1`). An EMPTY cell
      // is therefore the `{id:-1}` sentinel, never `null`: a null cell makes the
      // placement loop throw before any click.
      const shapeCell = (cell) => {
        if (cell === null || cell === undefined) return { id: -1, count: 0, metadata: null }
        const id = typeof cell === 'number' ? cell : cell.id
        if (id === -1 || id === undefined) return { id: -1, count: 0, metadata: null }
        return { id, count: typeof cell === 'number' ? 1 : (cell.count ?? 1), metadata: null }
      }
      return {
        result: { id: raw.result.id, count: raw.result.count ?? 1 },
        delta: [...need.entries()].map(([id, count]) => ({ id, count: -count })),
        requiresTable,
        inShape: raw.inShape === undefined ? undefined : raw.inShape.map((row) => row.map(shapeCell)),
        ingredients: raw.ingredients === undefined ? undefined : raw.ingredients.map(shapeCell),
        outShape: null,
      }
    })
    .filter((recipe) => (table === null ? recipe.requiresTable === false : recipe.requiresTable === true))
    .filter((recipe) => (recipe.result.count ?? 0) >= minCount)
    .filter((recipe) => recipe.delta.every((entry) => (counts.get(itemName(entry.id)) ?? 0) >= -entry.count))
}

/**
 * The mutable world the fake body sees. Both the body surface and the
 * allowlisted actuation port mutate THIS object, so a side effect can never
 * diverge between the client view and the actuation view.
 */
function createWorld({ inventory = CHAIN_START_INVENTORY, sensingRadius = 20, smeltOutput = 'iron_ingot' } = {}) {
  const grid = new Map()
  for (let x = -sensingRadius; x <= sensingRadius; x += 1) {
    for (let z = -sensingRadius; z <= sensingRadius; z += 1) {
      grid.set(`${x},${FLOOR_Y},${z}`, 'stone')
      // Loaded open space above the floor. An unmodelled cell is NOT air (see
      // #382): mineflayer returns null for an unloaded point, and a stand search
      // correctly refuses it, so a fixture that leaves the air out has no
      // interaction stands at all.
      for (let y = FLOOR_Y + 1; y <= FLOOR_Y + 8; y += 1) grid.set(`${x},${y},${z}`, 'air')
    }
  }
  const counts = new Map()
  for (const [name, count] of Object.entries(inventory)) if (count > 0) counts.set(name, count)

  const world = {
    grid,
    counts,
    lit: false,
    smeltOutput,
    held: null,
    placeCalls: [],
    digCalls: [],
    craftCalls: [],
    activateCalls: [],
    /** Fixture-only: put the body's feet at a world cell (world truth, not an action). */
    placeBody(feet) {
      bot.entity.position.set(feet.x, feet.y, feet.z)
    },
    /** Fixture-only: put a block into the world (world truth, not an action). */
    setBlock(cell, name) {
      grid.set(blockKey(cell), name)
    },
    count(name) {
      return counts.get(name) ?? 0
    },
    /** The name of the block in a world cell, or null when nothing is modelled. */
    nameAt(cell) {
      return grid.get(blockKey(cell)) ?? null
    },
    give(name, n) {
      if (n === 0) return
      counts.set(name, (counts.get(name) ?? 0) + n)
    },
    take(name, n) {
      const have = counts.get(name) ?? 0
      const removed = Math.min(have, n)
      if (removed > 0) counts.set(name, have - removed)
      return removed
    },
    /** Consume a recipe's delta and add its result: the world's craft truth. */
    craftTruth(recipe, count = 1) {
      world.craftCalls.push({ result: recipe?.result ?? null, count })
      for (const entry of recipe?.delta ?? []) {
        const name = itemName(entry.id)
        if (name === null) continue
        if (entry.count < 0) world.take(name, -entry.count * count)
        else world.give(name, entry.count * count)
      }
      const resultName = itemName(recipe?.result?.id)
      if (resultName !== null) world.give(resultName, (recipe?.result?.count ?? 1) * count)
    },
    /** Mine truth: the block leaves the world and its drop lands in the inventory. */
    digTruth(block) {
      const name = block?.name ?? null
      if (name === null) throw new Error('digTruth: no block')
      world.digCalls.push({ name, position: { x: block.position.x, y: block.position.y, z: block.position.z } })
      grid.delete(blockKey(block.position))
      const drop = DROPS[name] ?? name
      world.give(drop, 1)
      return drop
    },
    /**
     * Place truth: the carried block moves from the inventory into the world.
     * A placement that does not consume the carried item would make the frame's
     * obsidian delta a fiction.
     */
    placeTruth(refBlock, face) {
      const cell = {
        x: refBlock.position.x + face.x,
        y: refBlock.position.y + face.y,
        z: refBlock.position.z + face.z,
      }
      const item = world.held
      world.placeCalls.push({ ...cell, item })
      if (item === null) throw new Error('placeTruth: nothing held')
      if (world.count(item) <= 0) throw new Error(`placeTruth: no ${item} carried`)
      grid.set(blockKey(cell), item)
      world.take(item, 1)
      return cell
    },
  }

  // --- the fake body's Mineflayer surface -----------------------------------
  const position = new Vec3(0.5, FEET_Y, 0.5)
  const blockAt = (p) => {
    if (p === null || p === undefined) return null
    const name = grid.get(blockKey(p))
    if (name === undefined) return null
    return {
      name,
      boundingBox: name === 'air' ? 'empty' : 'block',
      position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
      diggable: true,
      harvestTools: name === 'crafting_table' ? undefined : harvestToolsFor(name),
    }
  }
  const inventoryItems = () =>
    [...counts.entries()]
      .filter(([, count]) => count > 0)
      .map(([name, count], slot) => ({ name, count, slot, type: itemId(name) ?? 0, metadata: null }))

  const bot = {
    username: 'AI_M2CHAIN',
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      offset: (x, y, z) => position.offset(x, y, z),
      clone: () => position.clone(),
      distanceTo: (other) => position.distanceTo(other),
    },
    game: { gameMode: 'survival', dimension: OVERWORLD, minY: -64, height: 384 },
    time: { isDay: true, timeOfDay: 6000 },
    health: 20,
    food: 20,
    physicsEnabled: true,
    entities: {},
    currentWindow: null,
    collectBlock: undefined,
    _client: { write: () => true },
    get heldItem() {
      return world.held === null ? null : { name: world.held, type: itemId(world.held) ?? 0, count: 1, metadata: null }
    },
    inventory: {
      items: inventoryItems,
      count: (id) => world.count(itemName(id) ?? ''),
    },
    blockAt,
    canSeeBlock: () => true,
    findBlocks: (options) => {
      const origin = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
      const out = []
      for (const [key, name] of grid) {
        if (!options.matching({ name })) continue
        const [x, y, z] = key.split(',').map(Number)
        const v = new Vec3(x, y, z)
        if (v.distanceTo(origin) <= options.maxDistance) out.push(v)
      }
      return out.slice(0, options.count)
    },
    canDigBlock: () => true,
    digTime: () => 50,
    dig: async (block) => {
      world.digTruth(block)
    },
    stopDigging: () => undefined,
    placeBlock: async (refBlock, face) => {
      world.placeTruth(refBlock, face)
    },
    lookAt: async () => undefined,
    equip: async (item) => {
      world.held = item?.name ?? null
    },
    /** The player-grid (2x2) arm of `runCraft`, when no port is supplied. */
    craft: async (recipe, count) => world.craftTruth(recipe, count ?? 1),
    recipesFor: (type, metadata, minCount, table) => recipesFor(counts, type, metadata, minCount, table),
    openFurnace: async () => createFurnaceWindow(world),
    openBlock: async () => {
      // Mineflayer installs the opened window on the bot; `craftInWindow` reads
      // it back through `bot.currentWindow` / `bot.clickWindow`.
      bot.currentWindow = createCraftWindow(world)
      return bot.currentWindow
    },
    closeWindow: async () => {
      bot.currentWindow = null
    },
    _syncWindow: async () => undefined,
    clickWindow: async (slot, button, mode) => {
      craftWindowClick(world, bot, slot, button, mode)
    },
    putSelectedItemRange: async (start, end) => {
      craftWindowPutAway(world, bot, start, end)
    },
    putSelectedItem: async () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    activateBlock: async () => {
      world.lit = true
      for (const cell of portalFrameLayout(CHAIN_FRAME_ORIGIN, 'x').interior) grid.set(blockKey(cell), 'nether_portal')
    },
    pathfinder: {
      movements: null,
      setMovements: (movements) => {
        bot.pathfinder.movements = movements
      },
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'noPath', path: [] }),
    },
  }

  // --- the allowlisted actuation port ---------------------------------------
  const port = {
    generationId: 'gen-m2-chain-rehearsal',
    assertLease: () => undefined,
    pathTo: () => undefined,
    stopPath: () => undefined,
    setControls: () => undefined,
    clearControls: () => undefined,
    lookAt: async () => undefined,
    dig: async (block) => {
      world.digTruth(block)
    },
    placeBlock: async (refBlock, face) => {
      world.placeTruth(refBlock, face)
    },
    activateItem: async () => undefined,
    activateBlock: async (block) => {
      world.activateCalls.push(`${block.position.x},${block.position.y},${block.position.z}`)
      world.lit = true
      for (const cell of portalFrameLayout(CHAIN_FRAME_ORIGIN, 'x').interior) grid.set(blockKey(cell), 'nether_portal')
    },
    equip: async (item) => {
      world.held = item?.name ?? null
    },
    collect: async () => undefined,
    craft: async (recipe, count) => world.craftTruth(recipe, count ?? 1),
    openContainer: async () => {
      throw new Error('the rehearsal port models no container')
    },
    withdrawFromContainer: async () => {
      throw new Error('the rehearsal port models no container')
    },
    writeMovementPacket: () => undefined,
    setPose: (pose) => {
      position.set(pose.x, pose.y, pose.z)
    },
  }

  return { world, bot, port }
}

/**
 * The blocks whose primary drop differs from their own name, for the cells this
 * rehearsal mines. Read from minecraft-data where it is authoritative; the
 * fallback table covers the four ores the chain touches.
 */
const DROPS = (() => {
  const out = {}
  for (const name of ['iron_ore', 'deepslate_iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'obsidian', 'stone']) {
    const dropId = registry.blocksByName?.[name]?.drops?.[0]?.drop ?? registry.blocksByName?.[name]?.drops?.[0]
    const resolved = typeof dropId === 'number' ? itemName(dropId) : null
    if (resolved !== null) out[name] = resolved
  }
  out.iron_ore = 'raw_iron'
  out.deepslate_iron_ore = 'raw_iron'
  out.diamond_ore = 'diamond'
  out.deepslate_diamond_ore = 'diamond'
  out.obsidian = 'obsidian'
  out.stone = 'cobblestone'
  return out
})()

/** The harvest contract the dig legality gate reads, straight from minecraft-data. */
function harvestToolsFor(name) {
  const block = registry.blocksByName?.[name]
  if (block === undefined) return undefined
  const tools = {}
  for (const itemName of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'wooden_shovel', 'stone_shovel', 'iron_shovel', 'diamond_shovel', 'shears']) {
    const id = itemId(itemName)
    if (id !== null) tools[id] = true
  }
  // A block with no material requirement (dirt/leaves) must keep `undefined` so
  // the legality gate returns early, exactly like the live registry.
  if (name === 'stone' || name === 'cobblestone') return { [itemId('wooden_pickaxe')]: true, [itemId('stone_pickaxe')]: true, [itemId('iron_pickaxe')]: true, [itemId('diamond_pickaxe')]: true, [itemId('netherite_pickaxe')]: true }
  if (name === 'iron_ore' || name === 'deepslate_iron_ore') return { [itemId('stone_pickaxe')]: true, [itemId('iron_pickaxe')]: true, [itemId('diamond_pickaxe')]: true, [itemId('netherite_pickaxe')]: true }
  if (name === 'diamond_ore' || name === 'deepslate_diamond_ore' || name === 'obsidian') return { [itemId('iron_pickaxe')]: true, [itemId('diamond_pickaxe')]: true, [itemId('netherite_pickaxe')]: true }
  void block
  return undefined
}

// ---------------------------------------------------------------------------
// the two windows the real Executor opens (furnace, crafting table)
// ---------------------------------------------------------------------------

/**
 * The narrow furnace window `executeFurnaceSmelt` is designed to be driven with
 * (executor.ts:1475-1492). One placed input + one fuel smelts into one output on
 * the next observation; the output must be TAKEN before the next one appears,
 * exactly like a real furnace window.
 */
function createFurnaceWindow(world) {
  let input = null
  let fuel = null
  let pending = null
  /**
   * Vanilla burns one fuel item per `burnTicks / 10` smelts: coal and charcoal
   * smelt EIGHT items of a batch, not one. A fixture that spends one coal per
   * item would make the real `SMELT:iron_ingot` batch of three inputs look like a
   * furnace that stopped after one - a false failure of the chain, not a
   * finding about the code.
   */
  const FUEL_SMELTS = { coal: 8, charcoal: 8, oak_planks: 1, stick: 1, oak_log: 1, lava_bucket: 100 }
  let burnLeft = 0
  const slot = (entry) => (entry === null ? null : { name: entry.name, type: itemId(entry.name) ?? 0, count: entry.count, metadata: null })
  const cookOne = () => {
    if (pending !== null) return
    if (input === null || input.count <= 0) return
    if (burnLeft <= 0) {
      if (fuel === null || fuel.count <= 0) return
      fuel.count -= 1
      burnLeft = FUEL_SMELTS[fuel.name] ?? 1
    }
    input.count -= 1
    burnLeft -= 1
    pending = { name: world.smeltOutput, count: 1 }
  }
  return {
    inputItem: () => slot(input),
    fuelItem: () => slot(fuel),
    outputItem: () => {
      cookOne()
      return slot(pending)
    },
    putInput: async (type, _metadata, count) => {
      const name = itemName(type)
      world.take(name, count)
      input = { name, count: (input?.count ?? 0) + count }
    },
    putFuel: async (type, _metadata, count) => {
      const name = itemName(type)
      world.take(name, count)
      fuel = { name, count: (fuel?.count ?? 0) + count }
    },
    takeOutput: async () => {
      if (pending === null) return
      world.give(pending.name, pending.count)
      pending = null
    },
    close: () => undefined,
  }
}

const CRAFT_INV_START = 10
const CRAFT_INV_END = 46

/**
 * The crafting-table window protocol `craftWindow.ts#craftInWindow` drives:
 * grid slots 1..9, result slot 0, player inventory 10..45. The window is a
 * PROJECTION of the world inventory; the world stays the single truth and the
 * recipe delta is applied there when the result is grabbed.
 */
function createCraftWindow(world) {
  const win = {
    type: 'minecraft:crafting',
    id: 1,
    inventoryStart: CRAFT_INV_START,
    inventoryEnd: CRAFT_INV_END,
    craftingResultSlot: 0,
    selectedItem: null,
    slots: new Array(CRAFT_INV_END).fill(null),
    findInventoryItem: (type, metadata) => findInRange(win, CRAFT_INV_START, CRAFT_INV_END, type, metadata),
    findItemRange: (start, end, type, metadata) => findInRange(win, start, end, type, metadata),
    firstEmptySlotRange: (start, end) => {
      for (let slot = start; slot < end; slot += 1) if (win.slots[slot] === null) return slot
      return null
    },
    updateSlot: (slot, item) => {
      win.slots[slot] = item ?? null
    },
  }
  projectInventory(world, win)
  return win
}

function findInRange(win, start, end, type, metadata) {
  for (let slot = start; slot < end; slot += 1) {
    const item = win.slots[slot]
    if (item === null || item === undefined) continue
    if (item.type !== type) continue
    if (metadata !== null && metadata !== undefined && item.metadata !== metadata) continue
    return { ...item, slot }
  }
  return null
}

/** Mirror the world inventory into the window's player slots (the client view). */
function projectInventory(world, win) {
  for (let slot = CRAFT_INV_START; slot < CRAFT_INV_END; slot += 1) win.slots[slot] = null
  let slot = CRAFT_INV_START
  for (const [name, count] of world.counts) {
    if (count <= 0) continue
    win.slots[slot] = { name, type: itemId(name) ?? 0, metadata: null, count }
    slot += 1
    if (slot >= CRAFT_INV_END) break
  }
}

/**
 * A faithful-enough click model for the four gestures `craftInWindow` uses:
 * left-click a slot with an empty cursor (pick the stack up), right-click an
 * empty grid slot holding a stack (place one), shift-click (quick-move into the
 * player inventory), and the result-slot grab that produces the item.
 */
function craftWindowClick(world, bot, slot, button, mode) {
  const win = bot.currentWindow
  if (win === null || win === undefined) return
  if (mode === 1) {
    const item = win.slots[slot]
    if (item === null || item === undefined) return
    const target = win.findItemRange(CRAFT_INV_START, CRAFT_INV_END, item.type, item.metadata)
    if (target !== null) target.count += item.count
    else {
      const empty = win.firstEmptySlotRange(CRAFT_INV_START, CRAFT_INV_END)
      if (empty !== null) win.slots[empty] = { ...item, slot: empty }
    }
    win.slots[slot] = null
    return
  }
  if (slot === win.craftingResultSlot) {
    if (win.selectedItem !== null) return
    // THE production moment: the recipe's delta leaves the inventory and the
    // result enters the cursor.
    const recipe = bot.pendingCraftRecipe
    if (recipe !== null && recipe !== undefined) {
      world.craftTruth(recipe, 1)
      projectInventory(world, win)
      win.selectedItem = {
        name: itemName(recipe.result.id),
        type: recipe.result.id,
        metadata: null,
        count: recipe.result.count ?? 1,
      }
    }
    return
  }
  const item = win.slots[slot] ?? null
  if (button === 1) {
    // right click: move exactly one item between the cursor and the slot
    if (win.selectedItem === null && item !== null) {
      const half = { ...item, count: 1 }
      item.count -= 1
      if (item.count <= 0) win.slots[slot] = null
      win.selectedItem = half
      return
    }
    if (win.selectedItem !== null && item === null) {
      const one = { ...win.selectedItem, count: 1 }
      win.slots[slot] = one
      win.selectedItem.count -= 1
      if (win.selectedItem.count <= 0) win.selectedItem = null
      return
    }
    return
  }
  // left click: swap the whole stack with the cursor
  win.slots[slot] = win.selectedItem
  win.selectedItem = item
}

function craftWindowPutAway(world, bot, start, end) {
  const win = bot.currentWindow
  if (win === null || win === undefined) return
  if (win.selectedItem === null) return
  const item = win.selectedItem
  const target = win.findItemRange(start, end, item.type, item.metadata)
  if (target !== null) target.count += item.count
  else {
    const empty = win.firstEmptySlotRange(start, end)
    if (empty !== null) win.slots[empty] = { ...item, slot: empty }
  }
  win.selectedItem = null
  void world
}

// ---------------------------------------------------------------------------
// the ordered chain
// ---------------------------------------------------------------------------

const IRON_ORE_CELLS = Object.freeze([
  { x: 2, y: FEET_Y, z: 0 },
  { x: 2, y: FEET_Y, z: 1 },
  { x: 1, y: FEET_Y, z: 1 },
])
const FURNACE_CELL = Object.freeze({ x: -3, y: FEET_Y, z: 0 })
const TABLE_CELL = Object.freeze({ x: -8, y: FEET_Y, z: 0 })
const ORE_STAND = Object.freeze({ x: 0.5, y: FEET_Y, z: 0.5 })
const FURNACE_STAND = Object.freeze({ x: -1.5, y: FEET_Y, z: 0.5 })
const TABLE_STAND = Object.freeze({ x: -6.5, y: FEET_Y, z: 0.5 })

/**
 * Ten hazard-free obsidian cells inside ONE pickup envelope of ORE_STAND.
 * `mineCandidates` only offers a MINE when the cell is pickup-adjacent
 * (`PICKUP_MINE_HORIZONTAL = 2.75` measured centre-to-centre from the feet cell),
 * so a cell outside that ring is a MOVE, not a mine - and an obsidian source a
 * body cannot pick up is not a completed link.
 */
const OBSIDIAN_CELLS = Object.freeze([
  { x: 1, y: FEET_Y, z: 0 },
  { x: -1, y: FEET_Y, z: 0 },
  { x: 0, y: FEET_Y, z: 1 },
  { x: 0, y: FEET_Y, z: -1 },
  { x: 1, y: FEET_Y, z: 1 },
  { x: -1, y: FEET_Y, z: 1 },
  { x: 1, y: FEET_Y, z: -1 },
  { x: -1, y: FEET_Y, z: -1 },
  { x: 2, y: FEET_Y, z: 0 },
  { x: 0, y: FEET_Y, z: 2 },
])
/** Three diamond cells within one interaction envelope of ORE_STAND. */
const DIAMOND_CELLS = Object.freeze([
  { x: 2, y: FEET_Y, z: 0 },
  { x: 2, y: FEET_Y, z: 1 },
  { x: 1, y: FEET_Y, z: 1 },
])

/**
 * The chain, link by link. `candidate` selects the candidate the REAL candidate
 * layer must have grounded; `prepare` writes world truth (never an action);
 * `delta` is the inventory change the link must produce.
 */
export const CHAIN_LINKS = Object.freeze([
  {
    id: 'L1_mine_iron_ore',
    goal: { item: 'raw_iron', count: 3, kind: 'collect' },
    class: 'mine a block whose harvest truth is known',
    source: 'three sensed iron_ore cells',
    prepare: (ctx) => {
      ctx.world.placeBody(ORE_STAND)
      ctx.world.setBlock(IRON_ORE_CELLS[0], 'iron_ore')
    },
    arm: (ctx, attempt) => ctx.world.setBlock(IRON_ORE_CELLS[attempt], 'iron_ore'),
    candidate: (candidates) => candidates.find((c) => c.kind === 'MINE' && c.targetName === 'iron_ore') ?? null,
    repeats: 3,
    delta: { raw_iron: 3 },
  },
  {
    id: 'L2_smelt_three_iron_ingot',
    goal: { item: 'iron_ingot', count: 3, kind: 'smelt' },
    class: 'smelt an input',
    source: 'a placed furnace + carried coal + 3 carried raw_iron',
    prepare: (ctx) => {
      ctx.world.setBlock(FURNACE_CELL, 'furnace')
      ctx.world.placeBody(FURNACE_STAND)
    },
    candidate: (candidates) => candidates.find((c) => c.kind === 'SMELT' && c.itemName === 'iron_ingot') ?? null,
    delta: { iron_ingot: 3, raw_iron: -3, coal: -1 },
  },
  {
    id: 'L3_craft_iron_pickaxe',
    goal: { item: 'iron_pickaxe', count: 1, kind: 'craft' },
    class: 'obtain a tool',
    source: 'a placed crafting_table + 3 iron_ingot + 2 stick',
    prepare: (ctx) => {
      ctx.world.setBlock(TABLE_CELL, 'crafting_table')
      ctx.world.placeBody(TABLE_STAND)
    },
    candidate: (candidates) => candidates.find((c) => c.kind === 'CRAFT' && c.itemName === 'iron_pickaxe') ?? null,
    delta: { iron_pickaxe: 1, iron_ingot: -3, stick: -2 },
  },
  {
    id: 'L4_mine_three_diamond',
    goal: { item: 'diamond', count: 3, kind: 'collect' },
    class: 'mine a block whose harvest truth is known',
    source: 'three sensed diamond_ore cells',
    prepare: (ctx) => {
      ctx.world.placeBody(ORE_STAND)
      ctx.world.setBlock(DIAMOND_CELLS[0], 'diamond_ore')
    },
    arm: (ctx, attempt) => ctx.world.setBlock(DIAMOND_CELLS[attempt], 'diamond_ore'),
    candidate: (candidates) => candidates.find((c) => c.kind === 'MINE' && c.targetName === 'diamond_ore') ?? null,
    repeats: 3,
    delta: { diamond: 3 },
  },
  {
    id: 'L5_craft_diamond_pickaxe',
    goal: { item: 'diamond_pickaxe', count: 1, kind: 'craft' },
    class: 'obtain a tool',
    source: 'a placed crafting_table + 3 diamond + 2 stick',
    prepare: (ctx) => {
      ctx.world.setBlock(TABLE_CELL, 'crafting_table')
      ctx.world.placeBody(TABLE_STAND)
    },
    candidate: (candidates) => candidates.find((c) => c.kind === 'CRAFT' && c.itemName === 'diamond_pickaxe') ?? null,
    delta: { diamond_pickaxe: 1, diamond: -3, stick: -2 },
  },
  {
    id: 'L6_mine_ten_obsidian',
    goal: { item: OBSIDIAN, count: 10, kind: 'collect' },
    class: 'mine a block whose harvest truth is known',
    source: 'ten sensed obsidian cells (a legal, hazard-free source block)',
    prepare: (ctx) => {
      ctx.world.placeBody(ORE_STAND)
      ctx.world.setBlock(OBSIDIAN_CELLS[0], OBSIDIAN)
    },
    arm: (ctx, attempt) => ctx.world.setBlock(OBSIDIAN_CELLS[attempt], OBSIDIAN),
    candidate: (candidates) => candidates.find((c) => c.kind === 'MINE' && c.targetName === OBSIDIAN) ?? null,
    repeats: 10,
    delta: { obsidian: 10 },
  },
  {
    id: 'L7_place_portal_frame',
    // The REAL compiled goal: `portalStepToPlannedGoal(build_portal_frame)`
    // targets the OBSIDIAN cells of the frame, never the non-item
    // `nether_portal` (test-frame-build.mts case 1).
    goal: { item: OBSIDIAN, count: 10, kind: 'place' },
    class: 'place a structure from a plan',
    source: 'the 10 obsidian cells of the frame geometry',
    prepare: (ctx) => {
      ctx.world.placeBody(CHAIN_FRAME_STAND)
      const layout = portalFrameLayout(CHAIN_FRAME_ORIGIN, 'x')
      // A real site may already carry the four corners; the 10-cell ring is the
      // geometry the portal module validates.
      for (const corner of layout.corners) ctx.world.setBlock(corner, OBSIDIAN)
      ctx.placementCells = orderedPlacementCells(layout.frame)
    },
    candidate: (candidates) => candidates.find((c) => c.kind === 'PLACE') ?? null,
    delta: { obsidian: -10 },
  },
  {
    id: 'L8_light_and_verify_portal',
    goal: { item: 'nether_portal', count: 1, kind: 'place' },
    class: 'light and verify a structure',
    source: 'carried flint_and_steel + the frame the PREVIOUS link actually placed',
    prepare: (ctx) => {
      ctx.world.placeBody(CHAIN_FRAME_STAND)
      ctx.world.give('flint_and_steel', 1)
      // WORLD TRUTH, not the plan: the frame is read back out of the grid the
      // placement link mutated, so a frame that was never placed cannot be lit.
      const layout = portalFrameLayout(CHAIN_FRAME_ORIGIN, 'x')
      const placed = layout.frame.filter((cell) => ctx.world.nameAt(cell) === OBSIDIAN)
      ctx.frameCellsPlaced = placed.length
      ctx.portalFrame = validatePortalFrame({ blocks: placed, widthAxis: 'x' })
    },
    candidate: (candidates) => candidates.find((c) => c.kind === 'IGNITE') ?? null,
    delta: {},
  },
])

// ---------------------------------------------------------------------------
// driving one link
// ---------------------------------------------------------------------------

function sensorInputFor(link, ctx) {
  const goal = makeGoal(link.goal.item, link.goal.count)
  const current = {
    id: `g1:${link.goal.kind}:${link.goal.item}`,
    kind: link.goal.kind,
    description: `${link.goal.kind} ${link.goal.count} x ${link.goal.item}`,
    targetItem: link.goal.item,
    requiredCount: link.goal.count,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...(ctx.placementCells === undefined ? {} : { placementCells: ctx.placementCells }),
  }
  return {
    tick: ctx.tick,
    goal,
    goalQueue: { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] },
    focusItem: link.goal.item,
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: [],
    },
  }
}

function candidateOptionsFor(ctx) {
  return ctx.portalFrame === undefined
    ? CHAIN_CANDIDATE_OPTIONS
    : { ...CHAIN_CANDIDATE_OPTIONS, portalFrame: ctx.portalFrame }
}

/**
 * Drive one link: sense -> ground -> execute. Never throws for a mechanical
 * failure: the failure IS the measurement.
 */
async function driveLink(link, ctx) {
  const state = buildWorldState(ctx.bot, sensorInputFor(link, ctx), defaultSensorOptions)
  const grounded = generateGroundedCandidates(state, candidateOptionsFor(ctx))
  const candidate = link.candidate(grounded.candidates)
  if (candidate === null) {
    return {
      id: link.id,
      driven: false,
      refusal: 'no_candidate',
      typedReason:
        `the REAL candidate layer grounded no ${link.goal.kind} candidate for ${link.goal.item} ` +
        `(presented=${grounded.candidates.map((c) => c.id).join(',') || 'none'})`,
      presented: grounded.candidates.map((c) => c.id),
      withheld: grounded.withheld.map((w) => `${w.candidate.id}:${w.result.reason ?? 'none'}`),
    }
  }

  const before = Object.fromEntries(ctx.world.counts)
  ctx.tick += 1
  const markCount = ctx.markers.length
  // The 3x3 craft arm opens a window; the recipe the executor resolved is what
  // the window's result slot produces (see craftWindowClick).
  if (candidate.kind === 'CRAFT') {
    const itemIdValue = itemId(candidate.itemName)
    const resolved = ctx.bot.recipesFor(itemIdValue, null, 1, candidate.meta?.requiresTable === true ? {} : null)[0]
    ctx.bot.pendingCraftRecipe = resolved ?? null
  }
  const result = await ctx.executor.claim(candidate).completion
  ctx.bot.pendingCraftRecipe = null
  ctx.bot.currentWindow = null
  const after = Object.fromEntries(ctx.world.counts)
  const delta = {}
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[name] ?? 0) - (before[name] ?? 0)
    if (change !== 0) delta[name] = change
  }
  // Re-read the run log: the lines this link emitted are the evidence, so they
  // are measured from the sink, never assumed from the action's own result.
  const runMarkers = readMarkers(ctx.logPath)
  const markers = runMarkers.slice(markCount)
  ctx.markers = runMarkers
  return {
    id: link.id,
    driven: result.status === 'done' && result.verified === true,
    candidateId: candidate.id,
    candidateKind: candidate.kind,
    result,
    delta,
    markers,
    before,
    after,
  }
}

// ---------------------------------------------------------------------------
// the measured frontier: world shapes in which a link has NO route
// ---------------------------------------------------------------------------

// Inside the modelled floor: a ring outside it is rejected as `unsupported_bottom`
// and would measure the wrong thing.
const FRONTIER_RING_ORIGIN = Object.freeze({ x: 6, y: FEET_Y, z: 6 })
const FRONTIER_STAND = Object.freeze({ x: 7.5, y: FEET_Y, z: 4.5 })

function frontierState({ inventory, cells, lit, focus, count, stand = FRONTIER_STAND }) {
  const { world, bot } = createWorld({ inventory })
  world.placeBody(stand)
  for (const cell of cells) world.setBlock(cell, OBSIDIAN)
  if (lit) for (const cell of portalFrameLayout(FRONTIER_RING_ORIGIN, 'x').interior) world.setBlock(cell, 'nether_portal')
  const goal = makeGoal(focus, count)
  const current = {
    id: `g1:collect:${focus}`,
    kind: 'collect',
    description: `collect ${count} x ${focus}`,
    targetItem: focus,
    requiredCount: count,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  const state = buildWorldState(
    bot,
    {
      tick: 1,
      goal,
      goalQueue: { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] },
      focusItem: focus,
      recentEvents: [],
      signals: {
        consecutiveFailures: 0,
        lastFailureCode: null,
        lastPathStatus: 'idle',
        stalledMs: 0,
        lastPolicyConfidence: null,
        maxConcurrentActions: 0,
        escalationRecommended: false,
        failedCandidates: {},
        knownResources: [],
      },
    },
    defaultSensorOptions,
  )
  const grounded = generateGroundedCandidates(state, CHAIN_CANDIDATE_OPTIONS)
  return { state, grounded, bot }
}

/**
 * The world shapes in which a chain link has NO grounded route. These are not
 * link failures of the harness: they are the measured boundary of the chain, and
 * the report names them so a live run's dead end can be recognised offline.
 *
 * Every case is the SAME question the live world asks - "is a sensed obsidian
 * block a legal source?" - answered by the real sensor + real candidate layer.
 */
export function measureChainFrontier({ write = () => {} } = {}) {
  const layout = portalFrameLayout(FRONTIER_RING_ORIGIN, 'x')
  const ring = [...layout.frame, ...layout.corners]
  // A real EDGE cell (never a corner: the four corners are optional, so removing
  // one leaves the ring fully valid and would measure the wrong shape).
  const missingEdge = layout.frame[1]
  const fragmented = layout.frame.filter((cell) => !(cell.x === missingEdge.x && cell.y === missingEdge.y && cell.z === missingEdge.z))
  const cases = []

  const measure = (id, label, options) => {
    const { state, grounded } = frontierState(options)
    const sensed = state.blocks.filter((block) => block.name === OBSIDIAN)
    const offered = grounded.candidates.map((candidate) => candidate.id)
    const excluded = state.blocks.length === 0 ? 0 : sensed.length
    const entry = {
      id,
      label,
      ring: options.lit ? 'lit' : options.cells.length >= 10 ? 'unlit_complete' : 'unlit_fragmented',
      fellTo: options.stand ?? FRONTIER_STAND,
      sensedObsidian: sensed.length,
      inReach: sensed.filter((block) => block.inReach).length,
      offered,
      withheld: grounded.withheld.map((entry) => `${entry.candidate.id}:${entry.result.reason ?? 'none'}`),
      mineOffered: offered.filter((candidateId) => candidateId.startsWith('MINE:')).length,
      frameShape: state.portalFrame?.shape ?? 'none',
      liveMembers: (state.liveStructureMembers ?? []).length,
      _excluded: excluded,
    }
    cases.push(entry)
    write(
      `M2_CHAIN_EXEC_FRONTIER case=${id} ring=${entry.ring} sensed_obsidian=${entry.sensedObsidian} in_reach=${entry.inReach} ` +
        `frame=${entry.frameShape} live_members=${entry.liveMembers} mine_candidates=${entry.mineOffered} ` +
        `offered=${offered.join('>') || 'none'}`,
    )
    return entry
  }

  measure('F1_unlit_complete_ring', 'an intact but UNLIT obsidian ring (the shape of an inherited gate or an intact ruined portal) with a diamond pickaxe', {
    inventory: { diamond_pickaxe: 1 },
    cells: ring,
    lit: false,
    focus: OBSIDIAN,
    count: 10,
  })
  measure('F2_lit_ring', 'the same ring LIT - the protected inherited portal', {
    inventory: { diamond_pickaxe: 1 },
    cells: ring,
    lit: true,
    focus: OBSIDIAN,
    count: 10,
  })
  measure('F3_unlit_fragmented_ring', 'the same ring with one required EDGE missing and unlit - a damaged ruin', {
    inventory: { diamond_pickaxe: 1 },
    cells: fragmented,
    lit: false,
    focus: OBSIDIAN,
    count: 10,
  })
  measure('F4_wrong_tool_at_source', 'ten legal scattered obsidian cells and only an iron pickaxe (obsidian needs tier 4)', {
    inventory: { iron_pickaxe: 1 },
    cells: OBSIDIAN_CELLS.map((cell) => ({ x: cell.x, y: FEET_Y, z: cell.z })),
    lit: false,
    focus: OBSIDIAN,
    count: 10,
    stand: ORE_STAND,
  })

  const deadEnds = cases.filter((entry) => entry.inReach > 0 && entry.mineOffered === 0)
  const firstDeadEnd = deadEnds[0] ?? null
  write(
    `M2_CHAIN_EXEC_FRONTIER_RESULT dead_ends=${deadEnds.map((entry) => entry.id).join(',') || 'none'} ` +
      `first=${firstDeadEnd === null ? 'none' : firstDeadEnd.id} ` +
      `detail="${firstDeadEnd === null ? 'every measured world shape with a sensed, in-reach source grounds a MINE candidate' : `${firstDeadEnd.sensedObsidian} in-reach source cells at ${firstDeadEnd.id} ground NO candidate and NO withheld route`}"`,
  )
  return { cases, deadEnds, firstDeadEnd }
}

// ---------------------------------------------------------------------------
// the whole chain, one run
// ---------------------------------------------------------------------------

function readMarkers(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null)
    .map((entry) => `${entry.level ?? 'info'}:${entry.message ?? ''}`)
}

/**
 * Run the whole chain once and report. `write` receives one line per measured
 * fact; the returned report carries `missing` (empty = every link driven) and
 * `firstUndrivable` (null when the chain is complete).
 */
export async function runExecutionChain({ write = () => {}, cleanup = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm2-chain-exec-'))
  const logPath = join(dir, 'run.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  const { world, bot, port } = createWorld({})
  const executor = new Executor(bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    actuationPort: port,
  })
  const ctx = { world, bot, port, executor, tick: 1, markers: [], logPath, placementCells: undefined, portalFrame: undefined }

  write(
    `M2_CHAIN_EXEC_START inventory=${JSON.stringify(Object.fromEntries(world.counts))} ` +
      `frameOrigin=${CHAIN_FRAME_ORIGIN.x},${CHAIN_FRAME_ORIGIN.y},${CHAIN_FRAME_ORIGIN.z} ` +
      `actuation=pathfinder port=allowlisted`,
  )
  write(
    'M2_CHAIN_EXEC_UNREHEARSED link=tool_bootstrap detail="logs -> planks -> crafting_table -> pickaxe is owned by the tool-bootstrap lane and is NOT driven here; the chain starts from a post-bootstrap body that already holds a pickaxe"',
  )

  const links = []
  let firstUndrivable = null
  const missing = []

  for (const link of CHAIN_LINKS) {
    const repeats = link.repeats ?? 1
    const attempts = []
    for (let attempt = 0; attempt < repeats; attempt += 1) {
      if (attempt === 0) link.prepare?.(ctx)
      else link.arm?.(ctx, attempt)
      ctx.markers = readMarkers(logPath)
      const observed = await driveLink(link, ctx)
      attempts.push(observed)
      if (!observed.driven) break
    }
    const driven = attempts.length === repeats && attempts.every((entry) => entry.driven)
    links.push({ id: link.id, class: link.class, source: link.source, driven, attempts })
    const failed = attempts.find((entry) => !entry.driven) ?? null
    write(
      `M2_CHAIN_EXEC_LINK id=${link.id} class="${link.class}" driven=${driven} attempts=${attempts.length}/${repeats} ` +
        `candidates=${attempts.map((entry) => entry.candidateId ?? entry.refusal).join('>')} ` +
        `status=${attempts.map((entry) => entry.result?.status ?? entry.refusal).join('>')} ` +
        `delta=${JSON.stringify(mergeDeltas(attempts.map((entry) => entry.delta ?? {})))}`,
    )
    for (const attempt of attempts) {
      for (const marker of attempt.markers ?? []) write(`M2_CHAIN_EXEC_MARKER link=${link.id} ${marker}`)
    }
    if (!driven && firstUndrivable === null) {
      firstUndrivable = {
        id: link.id,
        class: link.class,
        candidateId: failed?.candidateId ?? null,
        refusal: failed?.refusal ?? 'execution_failed',
        typedReason:
          failed?.refusal === 'no_candidate'
            ? failed.typedReason
            : `Executor action ${failed?.candidateId ?? '(none)'} ended status=${failed?.result?.status} ` +
              `verified=${failed?.result?.verified} failure=${failed?.result?.failure ?? '(none)'} ` +
              `phase=${failed?.result?.phase ?? '(none)'} detail=${failed?.result?.detail ?? '(none)'}`,
      }
      missing.push(`link_not_driven:${link.id}:${firstUndrivable.typedReason}`)
    }
  }

  const markers = readMarkers(logPath)
  // The measured frontier: world shapes in which a link still has NO route. It is
  // reported separately from `missing` because it is a boundary of the plan, not
  // a failure of the rehearsal to drive the chain.
  const frontier = measureChainFrontier({ write })
  const report = {
    result: missing.length === 0 ? 'DRIVEN' : 'GAP',
    missing,
    firstUndrivable,
    links,
    markers,
    frontier,
    logPath,
    inventory: Object.fromEntries(world.counts),
    world: {
      lit: world.lit,
      digCalls: world.digCalls.map((entry) => entry.name),
      placeCalls: world.placeCalls.length,
      craftCalls: world.craftCalls.length,
      activateCalls: world.activateCalls,
    },
  }
  write(
    `M2_CHAIN_EXEC result=${report.result} links=${links.filter((entry) => entry.driven).length}/${links.length} ` +
      `first_undrivable=${firstUndrivable === null ? 'none' : firstUndrivable.id} ` +
      `frontier_dead_ends=${frontier.deadEnds.map((entry) => entry.id).join(',') || 'none'} ` +
      `inventory=${JSON.stringify(report.inventory)} lit=${world.lit} markers=${markers.length}`,
  )
  if (cleanup) rmSync(dir, { recursive: true, force: true })
  return report
}

function mergeDeltas(deltas) {
  const out = {}
  for (const delta of deltas) for (const [name, change] of Object.entries(delta)) out[name] = (out[name] ?? 0) + change
  return out
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const report = await runExecutionChain({ write: (line) => process.stdout.write(`${line}\n`) })
  process.exitCode = report.result === 'DRIVEN' ? 0 : 1
}
