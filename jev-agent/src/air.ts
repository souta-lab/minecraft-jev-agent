/**
 * Mineflayer's `oxygenLevel` / Minecraft `air_supply` breath scale. The live
 * sensor reports remaining bubbles on the vanilla 0..20 scale.
 * (`node_modules/mineflayer/lib/plugins/entities.js` maps the server metadata
 * to `bot.oxygenLevel`), so this is world truth the sensor reads directly.
 *
 * Keep these constants separate from the sensor implementation so scheduler,
 * executor, and semantic projection can all use the same mechanically sensed
 * scale without importing the full world-state module.
 */
export const MAX_AIR = 20

/** Normalize Mineflayer's optional breath metadata without asserting a value. */
export function observedAir(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * At or below this remaining-breath value the controller must preempt other
 * work and surface. The threshold is a code-owned safety boundary; route choice
 * remains with Jev among grounded escape options.
 *
 * Measured 2026-09-21T16:59:34.792Z: the body drowned at (67.5,58.3,28.5) after
 * ~35s of `ATTACK:e4698 phase=closing-to-melee-range` chasing a salmon down a
 * water column (y 62 -> 57). Vanilla drowning damage starts at air 0 and 20 HP
 * is gone ~10s later, so half the supply is the SAFE boundary where surfacing
 * preempts the current mechanical action. Code owns WHEN the body must resurface;
 * WHICH route surfaces it stays with Jev.
 */
export const LOW_AIR_LEVEL = 10
