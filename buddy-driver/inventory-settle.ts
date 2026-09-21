// inventory-settle.ts - a death/respawn reset must decide the resume rung from
// the SETTLED post-respawn inventory, never from a single momentary observation.
//
// On death the client and server replace the player entity and re-synchronize
// the player-inventory window asynchronously. A read taken the instant the bot
// reports `spawn` can therefore show either the client's retained window or the
// server's freshly (re)written window, depending only on packet order and on
// whether the death actually dropped the items (keepInventory is per-world on
// Paper: the overworld and the nether/end can disagree). Neither momentary
// reading is durable truth:
//
//   * a momentary EMPTY read is not positive evidence that the ladder's
//     materials are gone - it must not drop the frontier to wood, and
//   * a momentary NON-EMPTY read is not positive evidence that the materials
//     survived - it must not resume a rung the body cannot execute.
//
// The settled reading is the LAST observation taken after a bounded settle
// window has elapsed; earlier contradictory observations are recorded for
// evidence but never used. This keeps the authority split intact: code owns the
// settled observation; the ladder still owns WHICH rung to pursue from it, and
// this module never ranks rungs or selects goals.

export type InventoryCounts = Record<string, number>

export interface InventorySettleResult {
  /** the settled observation; the only value the reset decision may use */
  counts: InventoryCounts
  /** how many observations were taken inside the settle window */
  readings: number
  /** true when two consecutive observations over the window disagreed */
  observedChange: boolean
  /** true when the settled observation holds no item at all (raw, before usability) */
  empty: boolean
  /** wall-clock time spent settling */
  waitedMs: number
}

export interface InventorySettleOptions {
  /** how long to keep observing before the last reading is accepted as settled */
  settleWindowMs: number
  /** delay between observations */
  pollIntervalMs: number
  /** injectable clock (tests); defaults to Date.now */
  now?: () => number
  /** injectable sleep (tests); defaults to setTimeout */
  sleep?: (ms: number) => Promise<void>
}

/**
 * True when a death/respawn reset must settle the inventory before the rung is
 * derived. Only the death path re-creates the player entity and rewrites the
 * inventory window; an ordinary read or an `inventory-resume` is untouched.
 */
export function shouldSettleRespawnInventory(reason: string | null): boolean {
  return reason === 'death'
}

/** Comparisons are count-exact: a changed stack size is a changed observation. */
export function sameInventoryCounts(a: InventoryCounts, b: InventoryCounts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return false
  }
  return true
}

/**
 * Pure settlement: the LAST reading is the settled one. Earlier readings only
 * contribute the `observedChange` flag, so a contradictory pair of observations
 * is visible in evidence without either one deciding the reset.
 */
export function settledInventoryBasis(
  readings: readonly InventoryCounts[],
  waitedMs = 0,
): InventorySettleResult {
  const last = readings.length === 0 ? {} : (readings[readings.length - 1] ?? {})
  let observedChange = false
  for (let i = 1; i < readings.length; i += 1) {
    if (!sameInventoryCounts(readings[i - 1] ?? {}, readings[i] ?? {})) observedChange = true
  }
  return {
    counts: { ...last },
    readings: readings.length,
    observedChange,
    empty: Object.keys(last).length === 0,
    waitedMs,
  }
}

/**
 * Observe the live inventory across the settle window. Always runs the full
 * window: an early stable reading can be the stale one in EITHER direction, so
 * stopping at the first stable observation would reintroduce the momentary-read
 * hazard this module exists to remove.
 */
export async function collectSettledInventory(
  read: () => InventoryCounts,
  options: InventorySettleOptions,
): Promise<InventoryCounts[]> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
  const start = now()
  const readings: InventoryCounts[] = [read()]
  while (now() - start < options.settleWindowMs) {
    await sleep(options.pollIntervalMs)
    readings.push(read())
  }
  return readings
}

/** Collect the live inventory over the settle window and return the settled basis. */
export async function settleInventoryAfterRespawn(
  read: () => InventoryCounts,
  options: InventorySettleOptions,
): Promise<InventorySettleResult> {
  const now = options.now ?? Date.now
  const start = now()
  const readings = await collectSettledInventory(read, options)
  return settledInventoryBasis(readings, now() - start)
}

/** Default death/respawn settle window and poll interval (bounded, once per death). */
export const RESPAWN_INVENTORY_SETTLE_MS = 1000
export const RESPAWN_INVENTORY_POLL_MS = 100
