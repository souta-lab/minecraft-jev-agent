// containerAccess.ts - the generic CONTAINER capability's code-owned truth.
//
// Measured gap (main c348bb1): `station kinds are furnace | crafting_table`
// only. A container block (chest / trapped_chest / barrel / shulker box /
// ender_chest) was therefore invisible to every sensor table, was never a
// station-approach target, could never be opened, and its contents could never
// be withdrawn. A shulker box handed over as an item could be placed and then
// was dead weight: `actuationPort.ts:63` declared a generic `openContainer`
// capability whose only consumer was the furnace-specific
// `executor.ts:6397 openFurnace`, and no code path anywhere opened a chest.
//
// This module is deliberately dependency-free (like `actuationPort.ts`): the
// name table, the truthful container reference, the observation shape and the
// evidence lines live here so `state.ts` (sensor), `candidates.ts` (grounding),
// `executor.ts` (mechanics), `skillCommitment.ts` (envelope) and the host
// consume ONE table and ONE spelling - never a second list.
//
// WHAT IS OBSERVABLE, MEASURED (mineflayer 4.39.0):
//   * `bot.openContainer(block)` (node_modules/mineflayer/lib/plugins/chest.js:14)
//     accepts exactly the block names below (the `minecraft:` prefix stripped at
//     chest.js:18); shulker boxes and ender_chest need no special path.
//   * BEFORE a window is open, the client has NO contents: the only contents
//     surface is the opened `window` (`window.containerItems()` /
//     `window.containerCount(id, meta)`), and vanilla never ships container
//     `Items` in the block-entity update tag. Contents are therefore UNKNOWN
//     until an OPEN action observed them - and UNKNOWN is never EMPTY.
//   * `withdraw` takes a NUMERIC ITEM ID (mineflayer inventory.js:275-305), so
//     the name -> id conversion belongs to the executor's window adapter.

/** One cell of the block grid; structural so this module needs no imports. */
export interface ContainerCell {
  x: number
  y: number
  z: number
}

/**
 * The container blocks this code can approach, open and transfer out of.
 *
 * The 16 colour variants are spelled out rather than derived: this set is the
 * auditable list mineflayer's own `allowedWindowTypes` (chest.js:6) accepts, and
 * a derived list would hide a typo behind a loop.
 *
 * DELIBERATELY ABSENT: the eight 1.21 `*_copper_chest` variants. They exist in
 * minecraft-data for 1.21.11 but are NOT in mineflayer 4.39.0's
 * `allowedWindowTypes`, so `bot.openContainer` throws
 * `containerToOpen is neither a block nor an entity`; forcing them through
 * `bot.openBlock` is worse (1.21.11's `open_window` carries no `slotCount`, so
 * an unrecognised menu type makes `createWindow` return null and the
 * `open_window` handler throws `TypeError: Cannot read properties of null`).
 * A container we cannot honestly open is not advertised as openable.
 */
export const CONTAINER_BLOCK_NAMES: ReadonlySet<string> = new Set([
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
  'shulker_box',
  'white_shulker_box',
  'orange_shulker_box',
  'magenta_shulker_box',
  'light_blue_shulker_box',
  'yellow_shulker_box',
  'lime_shulker_box',
  'pink_shulker_box',
  'gray_shulker_box',
  'light_gray_shulker_box',
  'cyan_shulker_box',
  'purple_shulker_box',
  'blue_shulker_box',
  'brown_shulker_box',
  'green_shulker_box',
  'red_shulker_box',
  'black_shulker_box',
])

/**
 * True for a container block name. A namespaced spelling (`minecraft:chest`)
 * is normalized, because mineflayer 4.39.0 strips the namespace before its own
 * name check (chest.js:18) and a block name read from another source may still
 * carry it.
 */
export function isContainerBlockName(name: string): boolean {
  const normalized = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
  return CONTAINER_BLOCK_NAMES.has(normalized)
}

/** Namespace-stripped block name (see `isContainerBlockName`). */
export function normalizeBlockName(name: string): string {
  return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
}

/**
 * The container an item name would place, or null when the item is not one of
 * this capability's container blocks. For every name above the item name and
 * the placed block name are identical (`shulker_box` item -> `shulker_box`
 * block), so this is the same table - never a second one.
 */
export function containerBlockForItem(itemName: string): string | null {
  const normalized = normalizeBlockName(itemName)
  return CONTAINER_BLOCK_NAMES.has(normalized) ? normalized : null
}

/**
 * The TRUTHFUL container identity the `transfer` effect declares.
 *
 * Until now `container:` was only ever a slot ROLE (`furnace_input`), so a
 * transfer could not name the block it moved an item out of. A container
 * transfer names the exact block: `chest@12,64,-3` - the same
 * `<name>@<x>,<y>,<z>` spelling the station layer already uses for
 * `knownStationKey` (`crafting_table@40,29,35`). Two different chests are
 * therefore two different declarations, and an envelope for one can never
 * authorize a transfer out of the other.
 */
export function containerRef(blockName: string, position: ContainerCell): string {
  return `${normalizeBlockName(blockName)}@${position.x},${position.y},${position.z}`
}

/** Parse a `containerRef` back to its parts, or null when malformed. */
export function parseContainerRef(ref: string): { block: string; position: ContainerCell } | null {
  const at = ref.lastIndexOf('@')
  if (at <= 0) return null
  const block = ref.slice(0, at)
  if (!isContainerBlockName(block)) return null
  const parts = ref.slice(at + 1).split(',')
  if (parts.length !== 3) return null
  const [x, y, z] = parts.map((entry) => Number(entry))
  if (x === undefined || y === undefined || z === undefined) return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { block: normalizeBlockName(block), position: { x, y, z } }
}

/** One stack observed inside a container. */
export interface ContainerItemStack {
  name: string
  count: number
}

/**
 * One live container slot as the OPENED window reports it: the name plus the
 * NUMERIC item type. The type matters because mineflayer's `withdraw` takes an
 * item id, never a slot (inventory.js:275-305), and the opened window is the one
 * place that already knows the id - no registry lookup is needed, and no
 * name->id guess is made.
 */
export interface ContainerWindowStack {
  name: string
  type: number
  count: number
}

/** The live stacks of one item name (a container may hold it in several slots). */
export function containerWindowStacks(
  items: readonly ContainerWindowStack[],
  itemName: string,
): ContainerWindowStack[] {
  return items.filter((stack) => stack.name === itemName && stack.count > 0)
}

/** The first live stack of one item name, or null. */
export function findContainerStack(
  items: readonly ContainerWindowStack[],
  itemName: string,
): ContainerWindowStack | null {
  return items.find((stack) => stack.name === itemName && stack.count > 0) ?? null
}

/** The name/count projection of live window stacks (the observation shape). */
export function containerItemStacks(items: readonly ContainerWindowStack[]): ContainerItemStack[] {
  return items.map((stack) => ({ name: stack.name, count: stack.count }))
}

/**
 * What was OBSERVED inside one container, or nothing at all.
 *
 * The absence of an observation is UNKNOWN, never EMPTY: a container nobody
 * opened has contents nobody can see, and code must say so instead of assuming
 * zero. `items: []` is only ever written after an open action read the live
 * window and found no stacks.
 */
export interface ContainerObservation {
  /** `containerRef` of the observed block */
  container: string
  block: string
  position: ContainerCell
  /** the observed contents; empty means "opened and seen empty" */
  items: readonly ContainerItemStack[]
  /** tick/epoch stamp of the observation (0 when a fixture does not stamp one) */
  observedAt: number
}

/** The observation for one cell, or null when that container is UNKNOWN. */
export function containerObservationAt(
  observations: readonly ContainerObservation[] | undefined,
  position: ContainerCell,
): ContainerObservation | null {
  for (const observation of observations ?? []) {
    if (observation.position.x === position.x && observation.position.y === position.y && observation.position.z === position.z) {
      return observation
    }
  }
  return null
}

/** The observed count of one item in an observation (0 when absent, never a guess). */
export function observedItemCount(observation: ContainerObservation | null, itemName: string): number {
  if (observation === null) return 0
  let total = 0
  for (const stack of observation.items) {
    if (stack.name === itemName) total += Math.max(0, Math.floor(stack.count))
  }
  return total
}

/**
 * The typed reasons a container interaction can be refused. Each names a
 * MEASURED fact; none of them is "nothing happened".
 */
export type ContainerRefusalReason =
  /** no interaction stand, no path to one, an unloaded cell, or the server never opened a window */
  | 'unreachable'
  /** line of sight to the container cell is blocked by another block */
  | 'occluded'
  /** no window ever opened inside the bounded wait (server refused the interaction) */
  | 'open_timeout'
  /** the cell no longer holds a container block */
  | 'missing'
  /** opened and observed empty (a typed EMPTY result, never a silent success) */
  | 'empty'
  /** contents were never observed, so no transfer can be declared */
  | 'unknown_contents'
  /** the observed stack is no longer there at execution time */
  | 'contents_changed'
  /** the destination inventory cannot accept the transfer */
  | 'no_room'

export interface ContainerRefusal {
  reason: ContainerRefusalReason
  /** `containerRef` when the block name and cell are known */
  container: string
  block: string
  position: ContainerCell
  /** the item a refused transfer was about, when there was one */
  item?: string | null
  /** the finer measured fact behind `reason`, when there is one */
  detail?: string | null
}

/** The `CONTAINER_REFUSED` observability line for one typed refusal. */
export function formatContainerRefusal(refusal: ContainerRefusal): string {
  const item = refusal.item === undefined || refusal.item === null ? '' : ` item=${refusal.item}`
  const detail = refusal.detail === undefined || refusal.detail === null ? '' : ` detail=${refusal.detail}`
  return `CONTAINER_REFUSED reason=${refusal.reason} container=${refusal.container} at=${refusal.position.x},${refusal.position.y},${refusal.position.z}${item}${detail}`
}

/**
 * The `CONTAINER_OPEN` marker: what was opened and what was seen inside.
 * `contents=known|empty` is the observed verdict; a container nobody opened
 * never reaches this marker, and an UNKNOWN container is reported by
 * `formatContainerRefusal reason=unknown_contents` instead - never as empty.
 */
export function formatContainerOpen(container: string, items: readonly ContainerItemStack[]): string {
  const rolled = rollupContainerItems(items)
  const contents = rolled.length === 0 ? 'empty' : 'known'
  const rendered = rolled.length === 0 ? 'none' : rolled.map((stack) => `${stack.name}:${stack.count}`).join(',')
  return `CONTAINER_OPEN container=${container} contents=${contents} slots=${rolled.length} items=${rendered}`
}

/** The explicit typed EMPTY observation (an empty result is never a silent success). */
export function formatContainerEmpty(container: string): string {
  return `CONTAINER_EMPTY container=${container} contents=empty items=none`
}

/**
 * The `CONTAINER_TRANSFER` marker: the exact item, what was TAKEN (the verified
 * inventory delta) and what REMAINED in the container afterwards. `remaining`
 * is re-read from the live window after the transfer, so a partial move can
 * never be reported as a complete one.
 */
export function formatContainerTransfer(container: string, itemName: string, taken: number, remaining: number): string {
  return `CONTAINER_TRANSFER container=${container} item=${itemName} taken=${taken} remaining=${remaining}`
}

/**
 * The `CONTAINER_READY` marker: a VERIFIED placement proved the block stands at
 * this cell, so the world model may remember it durably. Mirrors
 * `FURNACE_READY source=placed`: an unverified/failed placement never emits it.
 */
export function formatContainerReady(blockName: string, position: ContainerCell): string {
  return `CONTAINER_READY source=placed block=${normalizeBlockName(blockName)} at=${position.x},${position.y},${position.z}`
}

/** Same-name stacks rolled up, ordered by first appearance (a stable evidence line). */
export function rollupContainerItems(items: readonly ContainerItemStack[]): ContainerItemStack[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const stack of items) {
    const count = Math.max(0, Math.floor(stack.count))
    if (count <= 0) continue
    if (!counts.has(stack.name)) order.push(stack.name)
    counts.set(stack.name, (counts.get(stack.name) ?? 0) + count)
  }
  return order.map((name) => ({ name, count: counts.get(name) ?? 0 }))
}

/** Stable key for one observation (the container ref). */
export function containerObservationKey(observation: ContainerObservation): string {
  return observation.container
}
