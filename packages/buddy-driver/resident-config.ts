/** Host connection and human Mission inputs used by the long-lived resident. */
export interface ResidentBootConfig {
  readonly host: string
  readonly port: number
  readonly goalItem: string
  readonly goalCount: number
}

export type ResidentBootEnv = Readonly<Record<string, string | undefined>>

export function resolveResidentBootConfig(env: ResidentBootEnv): ResidentBootConfig {
  const host = env.BUDDY_HOST?.trim() || '127.0.0.1'
  const rawPort = env.BUDDY_PORT?.trim() || '25565'
  const port = Number(rawPort)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`BUDDY_PORT must be an integer from 1 to 65535 (received ${JSON.stringify(rawPort)})`)
  }
  const configuredItem = env.BUDDY_MISSION_ITEM?.trim() || 'iron_ingot'
  if (configuredItem.includes(':') && !configuredItem.startsWith('minecraft:')) {
    throw new Error(`BUDDY_MISSION_ITEM namespace is unsupported by this vanilla runtime (received ${JSON.stringify(configuredItem)})`)
  }
  const goalItem = configuredItem.startsWith('minecraft:') ? configuredItem.slice('minecraft:'.length) : configuredItem
  if (!/^[a-z0-9_.-]+$/i.test(goalItem)) {
    throw new Error(`BUDDY_MISSION_ITEM must be a Minecraft item identifier (received ${JSON.stringify(configuredItem)})`)
  }
  const rawCount = env.BUDDY_MISSION_COUNT?.trim() || '3'
  const goalCount = Number(rawCount)
  if (!Number.isSafeInteger(goalCount) || goalCount < 1) {
    throw new Error(`BUDDY_MISSION_COUNT must be a positive integer (received ${JSON.stringify(rawCount)})`)
  }
  return { host, port, goalItem, goalCount }
}
