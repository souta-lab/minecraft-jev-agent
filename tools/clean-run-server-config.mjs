import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// The clean-run launcher accepts one reviewed host Java runtime. Keep this
// identity in the generated recipe, prepared manifest, BOOT check, and gate.
export const EXPECTED_JAVA_EXECUTABLE = '/usr/lib/jvm/java-21-openjdk-amd64/bin/java'

export function readJavaRuntimeVersion(executable, run = spawnSync) {
  if (resolve(executable) !== EXPECTED_JAVA_EXECUTABLE) throw new Error('Java executable is not the pinned clean-run runtime')
  const result = run(executable, ['-version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`Java -version could not be obtained${result.error ? `: ${result.error.message}` : `: exit=${result.status}`}`)
  }
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  const output = `${stdout}${stderr}`
  const match = /^\s*(?:openjdk|java) version "([^"]+)"/m.exec(output)
  if (match === null) throw new Error('Java -version output has no parseable runtime version')
  const outputIdentity = JSON.stringify({ stdout, stderr })
  return {
    version: match[1],
    versionOutput: { stdout, stderr },
    versionOutputSha256: createHash('sha256').update(outputIdentity).digest('hex'),
  }
}

export function deriveJavaRuntimePolicy(executable = EXPECTED_JAVA_EXECUTABLE, run = spawnSync) {
  const runtime = readJavaRuntimeVersion(executable, run)
  return {
    javaExecutable: resolve(executable),
    javaVersion: runtime.version,
    paperIgnoreJavaVersion: true,
  }
}

export function inspectJavaRuntime(executable, declaredPolicy, run = spawnSync) {
  if (declaredPolicy?.javaExecutable !== EXPECTED_JAVA_EXECUTABLE || resolve(executable) !== EXPECTED_JAVA_EXECUTABLE) {
    throw new Error('descriptor Java executable policy does not match the pinned clean-run runtime')
  }
  if (typeof declaredPolicy?.javaVersion !== 'string' || declaredPolicy.javaVersion === '' || declaredPolicy.paperIgnoreJavaVersion !== true) {
    throw new Error('descriptor must declare javaVersion and paperIgnoreJavaVersion=true')
  }
  const runtime = readJavaRuntimeVersion(executable, run)
  if (runtime.version !== declaredPolicy.javaVersion) {
    throw new Error(`Java runtime version ${runtime.version} differs from descriptor policy ${declaredPolicy.javaVersion}`)
  }
  return {
    ...inspectRegularFile(executable),
    ...runtime,
  }
}

export function inspectRegularFile(path) {
  const absolutePath = resolve(path)
  const stat = lstatSync(absolutePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`expected a regular non-symlink file: ${absolutePath}`)
  return {
    path: absolutePath,
    realpath: realpathSync(absolutePath),
    sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
  }
}

export function expectedLeafLaunchIdentity(descriptor, container = descriptor?.cleanRun?.worldContainer) {
  const runtimePolicy = descriptor?.cleanRun?.runtimePolicy
  const implementation = descriptor?.values?.serverImplementation
  if (typeof implementation !== 'string' || implementation === '' || basename(implementation) !== implementation) {
    throw new Error('descriptor serverImplementation must be a basename')
  }
  return {
    java: inspectJavaRuntime(EXPECTED_JAVA_EXECUTABLE, runtimePolicy),
    paperIgnoreJavaVersion: runtimePolicy.paperIgnoreJavaVersion,
    serverJar: inspectRegularFile(resolve(String(container ?? ''), implementation)),
  }
}

export function expectedLeafServerArgs(descriptor, propertiesPath, container = descriptor?.cleanRun?.worldContainer) {
  const implementation = descriptor?.values?.serverImplementation
  const levelName = descriptor?.values?.levelName
  if (typeof implementation !== 'string' || implementation === '' || typeof levelName !== 'string' || levelName === '') {
    throw new Error('descriptor lacks serverImplementation or levelName')
  }
  return [
    '-Xmx1G',
    '-Xms1G',
    '-DPaper.IgnoreJavaVersion=true',
    '-jar', implementation,
    '--nogui',
    '--config', resolve(propertiesPath),
    '--universe', resolve(String(container ?? '')),
    '--level-name', levelName,
  ]
}

export function assertExactLeafArgv(actual, expected, label = 'Leaf') {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} argv contains missing, duplicate, or unsupported runtime arguments`)
  }
}

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
  'enable-rcon',
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
    'enable-rcon': 'false',
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
