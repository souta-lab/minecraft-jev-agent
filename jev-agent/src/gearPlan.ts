// gearPlan.ts - the grounded EQUIP affordance (armor) and the combat
// weapon-in-hand condition.
//
// Observed live gap: the bot owns diamond gear but fights bare-handed and
// walks around unarmoured. Every pre-existing equip site targets the main hand
// only (`executor.ts` `bot.equip(item, 'hand')`), there is no armor destination
// anywhere and no candidate that turns a carried armor piece into a worn one.
//
// This module owns ONLY mechanical truth:
//   * which inventory item belongs to which armor slot;
//   * whether a carried piece is strictly better than what is worn;
//   * which carried sword/axe out-damages the item currently in hand.
//
// It is CAN enumeration, never ranking: it reports every armor piece that is
// strictly better than the currently worn piece for its slot, and it never
// chooses an objective. Jev still owns WHICH grounded action to take; the
// Executor owns that the action's post-condition (armor actually worn / weapon
// actually held) holds. Deterministic tie-breaks below exist only so the same
// state produces the same mechanics, not to express a preference between
// equally valid pieces.
//
// This module is dependency-free so candidates.ts / policy.ts / executor.ts can
// share one definition of armor and weapon truth.

/** One of the four worn armor destinations the executor can equip to. */
export type ArmorSlot = 'head' | 'torso' | 'legs' | 'feet'

/** Slot order is fixed so candidate enumeration is deterministic. */
export const ARMOR_SLOTS: readonly ArmorSlot[] = ['head', 'torso', 'legs', 'feet']

/**
 * The Mineflayer equip destination for each armor slot (same spelling as the
 * standard armor destination values).
 */
export const ARMOR_DESTINATION: Readonly<Record<ArmorSlot, ArmorSlot>> = {
  head: 'head',
  torso: 'torso',
  legs: 'legs',
  feet: 'feet',
}

/**
 * Mineflayer player-window slot index per destination. Window 0 slots 5-8 are
 * armor, head to feet (mineflayer/lib/plugins/inventory.js comments this
 * mapping). `bot.inventory.items()` iterates 9..44, so a WORN piece is
 * deliberately absent from `inventory.counts` - only carried pieces are there.
 */
export const ARMOR_SLOT_INDEX: Readonly<Record<ArmorSlot, number>> = {
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
}

/**
 * Armor material tiers, weakest first. Distinct values per material so "strictly
 * better than worn" is decidable; a material absent from this table is refused
 * (fail closed: code cannot prove it is better).
 */
const ARMOR_MATERIAL_TIER: Readonly<Record<string, number>> = {
  leather: 1,
  golden: 2,
  chainmail: 3,
  turtle: 4,
  iron: 5,
  diamond: 6,
  netherite: 7,
}

const ARMOR_SUFFIX_SLOT: ReadonlyArray<readonly [string, ArmorSlot]> = [
  ['_helmet', 'head'],
  ['_chestplate', 'torso'],
  ['_leggings', 'legs'],
  ['_boots', 'feet'],
]

/** The armor slot an item name belongs to, or null when it is not armor. */
export function armorSlotFor(itemName: string): ArmorSlot | null {
  if (itemName === 'turtle_helmet') return 'head'
  for (const [suffix, slot] of ARMOR_SUFFIX_SLOT) {
    if (itemName.endsWith(suffix)) return slot
  }
  return null
}

/** The material tier of an armor item, or null when it cannot be proven. */
export function armorTier(itemName: string): number | null {
  const slot = armorSlotFor(itemName)
  if (slot === null) return null
  const material = itemName === 'turtle_helmet' ? 'turtle' : itemName.slice(0, itemName.lastIndexOf('_'))
  return ARMOR_MATERIAL_TIER[material] ?? null
}

/**
 * The minimum carried-armor state the affordance reads. `null` means the slot
 * is empty (nothing worn there).
 */
export type ArmorWorn = Partial<Record<ArmorSlot, { name: string } | null>>

export interface ArmorEquipOffer {
  slot: ArmorSlot
  /** the carried piece to put on */
  itemName: string
  /** the piece currently worn in that slot, or null */
  replaced: string | null
  wornTier: number
  itemTier: number
}

/**
 * Every carried armor piece that is STRICTLY better than what is worn in its
 * slot. A slot with no better piece yields no offer, so equal/worse armor never
 * causes churn. Deterministic order: slot order, then item name.
 */
export function armorEquipOffers(
  armor: ArmorWorn | undefined,
  counts: Readonly<Record<string, number>>,
): ArmorEquipOffer[] {
  const offers: ArmorEquipOffer[] = []
  const names = Object.keys(counts).sort()
  for (const slot of ARMOR_SLOTS) {
    const worn = armor?.[slot] ?? null
    const wornTier = worn === null ? 0 : armorTier(worn.name) ?? 0
    for (const name of names) {
      if ((counts[name] ?? 0) <= 0) continue
      if (armorSlotFor(name) !== slot) continue
      const tier = armorTier(name)
      if (tier === null || tier <= wornTier) continue
      offers.push({ slot, itemName: name, replaced: worn?.name ?? null, wornTier, itemTier: tier })
    }
  }
  return offers
}

export interface ArmorRefusal {
  slot: ArmorSlot
  /** the carried piece that was NOT offered */
  itemName: string
  /** what is worn in the slot, or null */
  worn: string | null
  reason: 'not_better'
}

/**
 * The carried armor pieces that produce NO offer because they are not strictly
 * better than what is worn. Surfaced as an explicit refusal so "nothing better
 * is held" is an observable fact rather than silence.
 */
export function armorEquipRefusals(
  armor: ArmorWorn | undefined,
  counts: Readonly<Record<string, number>>,
): ArmorRefusal[] {
  const out: ArmorRefusal[] = []
  const names = Object.keys(counts).sort()
  for (const slot of ARMOR_SLOTS) {
    const worn = armor?.[slot] ?? null
    const wornTier = worn === null ? 0 : armorTier(worn.name) ?? 0
    for (const name of names) {
      if ((counts[name] ?? 0) <= 0) continue
      if (armorSlotFor(name) !== slot) continue
      const tier = armorTier(name)
      if (tier === null || tier > wornTier) continue
      out.push({ slot, itemName: name, worn: worn?.name ?? null, reason: 'not_better' })
    }
  }
  return out
}

/** The greppable EQUIP_ARMOR post-condition marker. */
export function formatArmorEquip(offer: { slot: ArmorSlot; itemName: string; replaced: string | null }): string {
  return `EQUIP_ARMOR slot=${offer.slot} item=${offer.itemName} from=inventory replaced=${offer.replaced ?? 'none'}`
}

/** The greppable refusal when a carried armor piece is not better than worn. */
export function formatArmorRefusal(refusal: ArmorRefusal): string {
  return `EQUIP_ARMOR_REFUSED slot=${refusal.slot} item=${refusal.itemName} worn=${refusal.worn ?? 'none'} reason=${refusal.reason}`
}

/**
 * Base melee attack damage for the carried weapons the combat condition knows.
 * Static table (minecraft-data exposes no attack-damage attribute): swords and
 * axes only, which is exactly what "use a sword when fighting" asks for.
 */
const WEAPON_DAMAGE: Readonly<Record<string, number>> = {
  wooden_sword: 4,
  golden_sword: 4,
  stone_sword: 5,
  iron_sword: 6,
  diamond_sword: 7,
  netherite_sword: 8,
  wooden_axe: 7,
  golden_axe: 7,
  stone_axe: 9,
  iron_axe: 9,
  diamond_axe: 9,
  netherite_axe: 10,
}

/** Base melee damage of an item, or null when it is not a known weapon. */
export function weaponDamage(itemName: string): number | null {
  return WEAPON_DAMAGE[itemName] ?? null
}

export interface WeaponEquipOffer {
  /** the carried weapon that out-damages what is in hand */
  itemName: string
  damage: number
  /** the item currently in hand, or null for an empty hand */
  replaced: string | null
  heldDamage: number
}

/**
 * The single carried sword/axe that is STRICTLY better than the item in hand,
 * or null when the hand already holds an equal-or-better weapon (so combat
 * never churns the held item). The deterministic (damage, name) order is a
 * mechanical total order, not a preference among semantically distinct goals.
 */
export function bestWeaponOffer(
  heldItemName: string | null,
  counts: Readonly<Record<string, number>>,
): WeaponEquipOffer | null {
  const heldDamage = heldItemName === null ? 0 : weaponDamage(heldItemName) ?? 0
  let best: { name: string; damage: number } | null = null
  for (const name of Object.keys(counts).sort()) {
    if ((counts[name] ?? 0) <= 0) continue
    const damage = weaponDamage(name)
    if (damage === null) continue
    if (best === null || damage > best.damage) best = { name, damage }
  }
  if (best === null || best.damage <= heldDamage) return null
  return { itemName: best.name, damage: best.damage, replaced: heldItemName, heldDamage }
}

/** The greppable EQUIP_WEAPON marker (combat weapon-in-hand post-condition). */
export function formatWeaponEquip(offer: WeaponEquipOffer): string {
  return `EQUIP_WEAPON item=${offer.itemName} replaced=${offer.replaced ?? 'none'} reason=combat`
}

/** The greppable refusal when the hand already holds the best carried weapon. */
export function formatWeaponRefusal(heldItemName: string | null): string {
  return `EQUIP_WEAPON_REFUSED item=${heldItemName ?? 'none'} reason=no_better_weapon`
}
