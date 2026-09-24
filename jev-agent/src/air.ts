/**
 * Mineflayer's `oxygenLevel` / Minecraft `air_supply` breath scale. The
 * project's sensor exposes remaining bubbles on the vanilla 0..20 scale and,
 * for modern named metadata, binds that value to the bot's own Entity metadata.
 *
 * Keep these constants separate from the sensor implementation so scheduler,
 * executor, and semantic projection can all use the same mechanically sensed
 * scale without importing the full world-state module.
 */
export const MAX_AIR = 20

const SELF_AIR_PROJECTION = Symbol.for('jev-agent.self-air-projection.v1')

type MineflayerAirProjectionTarget = {
  oxygenLevel?: number
  entity?: {
    metadata?: Record<string, unknown> | null
  } | null
  registry?: {
    entitiesByName?: Record<string, { metadataKeys?: unknown } | undefined>
  }
  supportFeature?: (feature: string) => boolean
}

export type SelfAirProjectionBinding =
  | 'self-entity-metadata'
  | 'mineflayer-legacy-self-filter'
  | 'already-bound'
  | 'unavailable-self-air-metadata-key'
  | 'unavailable-nonconfigurable-property'

/**
 * The modern Mineflayer metadata path updates `bot.entity.metadata` for the
 * entity named by each packet, but Mineflayer 4.39 also assigns every entity's
 * `air_supply` to the bot-level `oxygenLevel`. Project code must only read the
 * body's own metadata. Keep the public scalar API safe for all existing
 * consumers by projecting it from the self Entity and ignoring writes from
 * Mineflayer's unscoped metadata handler.
 *
 * Older Mineflayer versions use `plugins/breath.js`, whose listener already
 * checks the packet entity id against `bot.entity.id`; leave that path alone.
 */
export function bindSelfAirMetadataProjection(bot: object): SelfAirProjectionBinding {
  const target = bot as MineflayerAirProjectionTarget
  if (Reflect.get(bot, SELF_AIR_PROJECTION) === true) return 'already-bound'

  let namedEntityMetadata = false
  try {
    namedEntityMetadata = target.supportFeature?.('mcDataHasEntityMetadata') === true
  } catch {
    // An unsupported/unknown feature surface retains Mineflayer's legacy
    // self-filtered breath listener rather than guessing at packet semantics.
  }
  if (!namedEntityMetadata) return 'mineflayer-legacy-self-filter'

  const metadataKeys = target.registry?.entitiesByName?.player?.metadataKeys
  const airSupplyIndex = Array.isArray(metadataKeys) ? metadataKeys.indexOf('air_supply') : -1
  if (airSupplyIndex < 0) return 'unavailable-self-air-metadata-key'

  const descriptor = Object.getOwnPropertyDescriptor(bot, 'oxygenLevel')
  if (descriptor?.configurable === false) return 'unavailable-nonconfigurable-property'

  Object.defineProperty(bot, 'oxygenLevel', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get: () => airSupplyToOxygenLevel(Reflect.get(target.entity?.metadata ?? {}, String(airSupplyIndex))),
    // Mineflayer's metadata handler writes this scalar for remote entities too.
    // The self entity's metadata was updated first and remains the source of
    // truth, so accepting the write would reintroduce the provenance leak.
    set: (_value: number | undefined) => undefined,
  })
  Object.defineProperty(bot, SELF_AIR_PROJECTION, {
    configurable: false,
    enumerable: false,
    value: true,
  })
  return 'self-entity-metadata'
}

/** Match Mineflayer's 0..20 normalization of Minecraft's raw air supply. */
export function airSupplyToOxygenLevel(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value / 15) : undefined
}

/**
 * Normalize the projected optional breath value without asserting a value.
 * Missing, malformed, and out-of-scale values remain unknown; in particular,
 * callers must not feed raw 0..300 server ticks here.
 */
export function observedAir(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AIR ? value : null
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
