import { createHash } from 'node:crypto'

/** Descriptor key -> server.properties key. Keep this shared with preparation and acceptance. */
export const SERVER_PROPERTY_MAP = Object.freeze({
  levelType: 'level-type',
  gamemode: 'gamemode',
  forceGamemode: 'force-gamemode',
  hardcore: 'hardcore',
  bonusChest: 'bonus-chest',
  generateStructures: 'generate-structures',
  spawnAnimals: 'spawn-animals',
  enableCommandBlock: 'enable-command-block',
  pvp: 'pvp',
  allowNether: 'allow-nether',
  allowFlight: 'allow-flight',
  spawnProtection: 'spawn-protection',
  whiteList: 'white-list',
})

export const RUNTIME_PROPERTY_KEYS = Object.freeze([
  'difficulty',
  'level-seed',
  'spawn-monsters',
  'spawn-animals',
  'server-port',
  ...Object.values(SERVER_PROPERTY_MAP).filter((key) => key !== 'bonus-chest'),
])

export function sha256Text(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

export function parseServerProperties(text) {
  const values = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    values[javaPropertiesUnescape(line.slice(0, eq).trim())] = javaPropertiesUnescape(line.slice(eq + 1).trim())
  }
  return values
}

/** Decode Java Properties escapes (the shared Leaf config parser). */
export function javaPropertiesUnescape(value) {
  const text = String(value)
  let result = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== '\\' || index + 1 >= text.length) {
      result += char
      continue
    }
    const escaped = text[++index]
    if (escaped === 't') result += '\t'
    else if (escaped === 'n') result += '\n'
    else if (escaped === 'r') result += '\r'
    else if (escaped === 'f') result += '\f'
    else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
      result += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 5), 16))
      index += 4
    } else result += escaped
  }
  return result
}

function asPropertyString(value) {
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' ? value : null
}

export function expectedRuntimeServerProperties(descriptor) {
  const values = descriptor?.values ?? {}
  const server = values.server ?? {}
  const serverPort = /:(\d+)$/.exec(String(values.serverId ?? ''))?.[1] ?? null
  const expected = {
    difficulty: asPropertyString(values.difficulty),
    'level-seed': asPropertyString(values.levelSeed),
    'spawn-monsters': asPropertyString(values.mobSpawning),
    'spawn-animals': asPropertyString(server.spawnAnimals ?? values.spawnAnimals),
    'server-port': serverPort,
  }
  for (const [descriptorKey, propertyKey] of Object.entries(SERVER_PROPERTY_MAP)) {
    // Leaf has no server.properties key for bonus chest on this version. The
    // clean-run invariant is enforced by the absence of --bonusChest in argv.
    if (propertyKey === 'bonus-chest') continue
    expected[propertyKey] = asPropertyString(server[descriptorKey])
  }
  return expected
}

export function projectRuntimeServerProperties(parsed) {
  return Object.fromEntries(RUNTIME_PROPERTY_KEYS.map((key) => [key, parsed?.[key] ?? null]))
}

export function compareRuntimeServerProperties(descriptor, parsed) {
  const expected = expectedRuntimeServerProperties(descriptor)
  const observed = projectRuntimeServerProperties(parsed)
  const missing = []
  const mismatches = []
  for (const [key, value] of Object.entries(expected)) {
    if (value === null) {
      missing.push(`${key}:descriptor_value_missing`)
    } else if (observed[key] === null || observed[key] === '') {
      missing.push(`${key}:startup_value_missing`)
    } else if (observed[key] !== value) {
      mismatches.push(`${key}=${JSON.stringify(observed[key])} expected=${JSON.stringify(value)}`)
    }
  }
  return { expected, observed, missing, mismatches, agrees: missing.length === 0 && mismatches.length === 0 }
}
