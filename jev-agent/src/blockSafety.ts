/** World blocks that are durable stations, not disposable route terrain. */
export const PROTECTED_STATION_BLOCKS: ReadonlySet<string> = new Set([
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
])

export function isProtectedStationBlock(name: string): boolean {
  const normalized = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
  return PROTECTED_STATION_BLOCKS.has(normalized)
}
