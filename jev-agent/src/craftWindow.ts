// craftWindow.ts - STOCK-FIRST crafting-table interaction.
//
// `mineflayer@4.39.0` `bot.craft(recipe, count, table)` opens the table window
// itself and, on 1.17.1+ servers, relies on the module-global `stateId` closure
// for every `window_click`. The server keeps syncing the player inventory
// (window 0) while our crafting window is open, and mineflayer adopts those
// packet stateIds globally, so a craft click can be silently ignored by the
// server: `bot.craft` resolves with no error and no item (upstream
// PrismarineJS/mineflayer#3906). The executor would then report `gained 0` and
// wedge.
//
// This module owns the window explicitly: it opens the table via
// `bot.openBlock`, force-resyncs the window with `bot._syncWindow` (a
// stateId=-1 no-op click that makes the server resend the full window state)
// immediately before each click, and polls the inventory. The recipe placement
// is the same algorithm as mineflayer's `craft.js`, but we never trust a click
// whose stateId may have been overwritten by window-0 traffic.
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Window } from 'prismarine-windows'
import type { Item } from 'prismarine-item'

const require = createRequire(import.meta.url)
const createItem = require('prismarine-item') as (registry: object) => new (
  type: number,
  count: number,
  metadata?: number | null,
) => Item

export interface CraftCell {
  id: number
  metadata?: number | null
  count?: number
}

/** The subset of a prismarine-recipe `Recipe` this module needs. */
export interface CraftRecipeLike {
  requiresTable?: boolean
  result: { id: number; count: number; metadata?: number | null }
  inShape?: CraftCell[][]
  ingredients?: CraftCell[]
  outShape?: Array<Array<{ id: number; count?: number; metadata?: number | null }>>
}

type SyncableBot = Bot & { _syncWindow?: (window: Window) => Promise<void> }

/** Craft one `recipe` at a placed crafting table, opening/closing the window. */
export async function craftAtTable(bot: Bot, table: Block, recipe: CraftRecipeLike): Promise<void> {
  const win = await bot.openBlock(table)
  try {
    if (typeof win.type !== 'string' || !win.type.startsWith('minecraft:crafting')) {
      throw new Error(`crafting: non craftingTable window ${String(win.type)}`)
    }
    await craftInWindow(bot as SyncableBot, win, recipe)
  } finally {
    try {
      await bot.closeWindow(win)
    } catch {
      // the server already closed the window
    }
  }
}

async function craftInWindow(bot: SyncableBot, win: Window, recipe: CraftRecipeLike): Promise<void> {
  const Item = createItem(bot.registry)
  const w = 3
  const h = 3
  const gridSlot = (x: number, y: number): number => 1 + x + w * y

  // Refresh the per-window stateId the server validates our clicks against.
  const sync = async (): Promise<void> => {
    const fn = bot._syncWindow
    if (fn !== undefined) await fn.call(bot, win)
  }
  const click = async (slot: number, mouseButton: number, mode: number): Promise<void> => {
    await sync()
    await bot.clickWindow(slot, mouseButton, mode)
  }

  const unusedRecipeSlots = (): number[] => {
    const result: number[] = []
    if (recipe.inShape !== undefined) {
      for (let y = 0; y < recipe.inShape.length; y += 1) {
        const row = recipe.inShape[y] ?? []
        let x = 0
        for (; x < row.length; x += 1) if ((row[x]?.id ?? -1) === -1) result.push(gridSlot(x, y))
        for (; x < w; x += 1) result.push(gridSlot(x, y))
      }
      for (let y = recipe.inShape.length; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) result.push(gridSlot(x, y))
      }
    } else {
      for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) result.push(gridSlot(x, y))
    }
    return result
  }
  const extraSlots = unusedRecipeSlots()
  let originalSourceSlot: number | null = null

  const ensureHolding = async (cell: CraftCell): Promise<void> => {
    const metadata = cell.metadata ?? null
    if (
      win.selectedItem !== null &&
      win.selectedItem.type === cell.id &&
      (metadata === null || win.selectedItem.metadata === metadata)
    ) {
      return
    }
    const sourceItem = win.findInventoryItem(cell.id, metadata, false)
    if (sourceItem === null) throw new Error(`missing ingredient id=${cell.id}`)
    if (originalSourceSlot === null) originalSourceSlot = sourceItem.slot
    await click(sourceItem.slot, 0, 0)
  }

  const putAway = async (slot: number): Promise<void> => {
    const start = win.inventoryStart
    const end = win.inventoryEnd
    const item = win.slots[slot]
    const resultSlot = slot === win.craftingResultSlot
    const room =
      item !== null &&
      item !== undefined &&
      (win.findItemRange(start, end, item.type, item.metadata, true, item.nbt) !== null ||
        win.firstEmptySlotRange(start, end) !== null)
    if (room && !resultSlot) {
      await bot.clickWindow(slot, 0, 1)
    } else {
      await click(slot, 0, 0)
      await bot.putSelectedItemRange(start, end, win, null)
    }
  }

  const grabResult = async (): Promise<void> => {
    if (win.selectedItem !== null) throw new Error('crafting: cursor not empty before grabbing the result')
    const item = new Item(recipe.result.id, recipe.result.count, recipe.result.metadata ?? null)
    win.updateSlot(0, item)
    await putAway(0)
  }

  const updateOutShape = async (): Promise<void> => {
    if (recipe.outShape === undefined) {
      for (let i = 1; i <= w * h; i += 1) win.updateSlot(i, null as unknown as Item)
      return
    }
    const slotsToClick: number[] = []
    for (let y = 0; y < recipe.outShape.length; y += 1) {
      const row = recipe.outShape[y] ?? []
      for (let x = 0; x < row.length; x += 1) {
        const cell = row[x] ?? { id: -1 }
        const slot = gridSlot(x, y)
        let item: Item | null = null
        if (cell.id !== -1) {
          item = new Item(cell.id, cell.count ?? 1, cell.metadata ?? null)
          slotsToClick.push(slot)
        }
        win.updateSlot(slot, item as unknown as Item)
      }
    }
    for (const slot of slotsToClick) await putAway(slot)
  }

  // --- place the recipe, exactly like mineflayer's craft.js ---
  if (recipe.inShape !== undefined) {
    for (let y = 0; y < recipe.inShape.length; y += 1) {
      const row = recipe.inShape[y] ?? []
      for (let x = 0; x < row.length; x += 1) {
        const cell = row[x]
        if (cell === undefined || cell.id === -1) continue
        await ensureHolding(cell)
        await click(gridSlot(x, y), 1, 0)
      }
    }
  } else if (recipe.ingredients !== undefined) {
    for (const cell of recipe.ingredients) {
      if (cell.id === -1) continue
      const dest = extraSlots.pop()
      if (dest === undefined) throw new Error('crafting: no free grid slot for shapeless ingredient')
      await ensureHolding(cell)
      await click(dest, 1, 0)
    }
  } else {
    throw new Error('crafting: recipe has neither inShape nor ingredients')
  }

  const start = win.inventoryStart
  const end = win.inventoryEnd
  await bot.putSelectedItemRange(start, end, win, originalSourceSlot)
  await grabResult()
  await updateOutShape()
}
