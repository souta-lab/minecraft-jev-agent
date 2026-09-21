#!/usr/bin/env bun
// Standalone launcher for the "Fabulously Optimized" Fabric instance.
//
// Resolves the Minecraft client jar, Minecraft libraries, Fabric Loader
// libraries and LWJGL natives (reusing the PrismLauncher caches when the files
// are already there, downloading the rest), then starts KnotClient with an
// offline account. Nothing inside the PrismLauncher config is modified.
//
// Usage: bun launch.mjs [--instance DIR] [--mc-version V] [--vanilla]
//                        [--fabric-version V] [--game-dir DIR] [--mods-dir DIR]
//                        [--data-dir DIR] [--server HOST:PORT]
//                        [--username NAME] [--uuid UUID] [--dry-run]
//                        [--download-assets] [--assets-dir DIR] [--java PATH]
//                        [--memory 4G] [--kill-after SECONDS]
//
// --instance DIR reads DIR/mmc-pack.json (PrismLauncher/Modrinth pack format)
// for the Minecraft and Fabric Loader versions and uses DIR/minecraft as the
// game directory, so any Prism instance can be launched with an offline
// account without going through PrismLauncher's account handling.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PRISM_DIR = path.join(os.homedir(), '.local/share/PrismLauncher')
const PRISM_LIBRARIES = path.join(PRISM_DIR, 'libraries')
const PRISM_ASSETS = path.join(PRISM_DIR, 'assets')

const DEFAULT_INSTANCE_NAME = 'Fabulously Optimized'
const DEFAULT_DATA_DIR = path.join(SCRIPT_DIR, 'data')
const DEFAULT_MC_VERSION = '26.2'
const DEFAULT_GAME_DIR = path.join(PRISM_DIR, 'instances', DEFAULT_INSTANCE_NAME, 'minecraft')
const DEFAULT_FABRIC_LOADER = '0.19.5'

// Per-run configuration, overridden from the CLI in main().
let DATA_DIR = DEFAULT_DATA_DIR
let MC_VERSION = DEFAULT_MC_VERSION
let GAME_DIR = DEFAULT_GAME_DIR
let MODS_DIR = path.join(GAME_DIR, 'mods')
let FABRIC_LOADER = DEFAULT_FABRIC_LOADER
let USE_FABRIC = true
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const fabricProfileUrl = () => `https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${FABRIC_LOADER}/profile/json`
const FABRIC_MAVEN = 'https://maven.fabricmc.net'
const ASSET_OBJECTS_URL = 'https://resources.download.minecraft.net'
const USER_AGENT = 'mc-ai-launcher/1.0 (standalone offline launcher)'

const OS_NAME = { linux: 'linux', darwin: 'osx', win32: 'windows' }[process.platform] ?? process.platform
const OS_ARCH = { x64: 'x86_64', arm64: 'arm64', ia32: 'x86' }[process.arch] ?? process.arch

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let logFile = null

function initLogging() {
  const dir = path.join(DATA_DIR, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  logFile = path.join(dir, `launch-${stamp}.log`)
  fs.writeFileSync(logFile, '')
}

function log(message = '') {
  const line = String(message)
  process.stdout.write(`${line}\n`)
  if (logFile) fs.appendFileSync(logFile, `${line}\n`)
}

function fail(message) {
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// Files, HTTP and hashing
// ---------------------------------------------------------------------------

const exists = (p) => fs.existsSync(p)

async function sha1OfFile(file) {
  return createHash('sha1').update(await fsp.readFile(file)).digest('hex')
}

async function httpGet(url, what) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    fail(`${what ?? 'request'} failed: HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  return res
}

async function fetchJson(url, what) {
  return (await httpGet(url, what)).json()
}

async function download(url, dest, expectedSha1, what) {
  const res = await httpGet(url, what)
  const body = Buffer.from(await res.arrayBuffer())
  if (expectedSha1) {
    const got = createHash('sha1').update(body).digest('hex')
    if (got !== expectedSha1) {
      fail(`SHA1 mismatch for ${url}\n  expected ${expectedSha1}\n  got      ${got}`)
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  await fsp.writeFile(tmp, body)
  await fsp.rename(tmp, dest)
  log(`  downloaded ${path.relative(DATA_DIR, dest)} (${(body.length / 1e6).toFixed(1)} MB)`)
}

// ---------------------------------------------------------------------------
// Maven coordinates and rule evaluation
// ---------------------------------------------------------------------------

function mavenRelPath(coords) {
  const [group, artifact, version, classifier] = coords.split(':')
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
}

// Prism stores native-classifier artifacts as separate artifacts, e.g.
// org.lwjgl:lwjgl-freetype:3.4.1:natives-linux lives at
// org/lwjgl/lwjgl-freetype-natives-linux/3.4.1/lwjgl-freetype-natives-linux-3.4.1.jar
function prismNativeRelPath(coords) {
  const [group, artifact, version, classifier] = coords.split(':')
  const nativeArtifact = `${artifact}-${classifier}`
  return `${group.replace(/\./g, '/')}/${nativeArtifact}/${version}/${nativeArtifact}-${version}.jar`
}

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false
    if (rule.os.arch && rule.os.arch !== OS_ARCH) return false
    if (rule.os.version) return false // version ranges only exist for Windows in vanilla JSON
  }
  if (rule.features) {
    for (const [key, value] of Object.entries(rule.features)) {
      if ((features[key] ?? false) !== value) return false
    }
  }
  return true
}

function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action === 'allow'
  }
  return allowed
}

// ---------------------------------------------------------------------------
// Library resolution (own data dir -> Prism cache -> download)
// ---------------------------------------------------------------------------

async function resolveLibrary(lib) {
  const artifact = lib.downloads?.artifact
  const rel = artifact?.path ?? mavenRelPath(lib.name)
  const own = path.join(DATA_DIR, 'libraries', rel)
  if (exists(own)) return own

  const prism = path.join(PRISM_LIBRARIES, rel)
  if (exists(prism)) return prism

  if (lib.name.includes(':natives-')) {
    const prismNative = path.join(PRISM_LIBRARIES, prismNativeRelPath(lib.name))
    if (exists(prismNative)) return prismNative
  }

  if (!artifact?.url) fail(`No download URL for library ${lib.name}`)
  await download(artifact.url, own, artifact.sha1, `library ${lib.name}`)
  return own
}

// Fabric profile libraries carry no downloads block: build the maven URL.
async function resolveMavenLibrary(lib) {
  const rel = mavenRelPath(lib.name)
  const own = path.join(DATA_DIR, 'libraries', rel)
  if (exists(own)) return own

  const prism = path.join(PRISM_LIBRARIES, rel)
  if (exists(prism)) return prism

  const base = (lib.url ?? FABRIC_MAVEN).replace(/\/$/, '')
  await download(`${base}/${rel}`, own, undefined, `maven artifact ${lib.name}`)
  return own
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

async function loadVersionJson() {
  const dest = path.join(DATA_DIR, 'meta', `${MC_VERSION}.json`)
  if (!exists(dest)) {
    const manifest = await fetchJson(MANIFEST_URL, 'version manifest')
    const entry = manifest.versions.find((v) => v.id === MC_VERSION)
    if (!entry) fail(`Minecraft ${MC_VERSION} not found in ${MANIFEST_URL}`)
    await download(entry.url, dest, entry.sha1, `version JSON ${MC_VERSION}`)
  }
  return JSON.parse(await fsp.readFile(dest, 'utf8'))
}

// ---------------------------------------------------------------------------
// PrismLauncher instances (mmc-pack.json)
// ---------------------------------------------------------------------------

// Reads a PrismLauncher/Modrinth instance directory and extracts the Minecraft
// and Fabric Loader versions from mmc-pack.json plus the game directory.
function readInstance(dir) {
  const resolved = path.resolve(dir)
  const packPath = path.join(resolved, 'mmc-pack.json')
  if (!exists(packPath)) fail(`No mmc-pack.json in instance directory ${resolved}`)
  let pack
  try {
    pack = JSON.parse(fs.readFileSync(packPath, 'utf8'))
  } catch (error) {
    fail(`Could not parse ${packPath}: ${error.message}`)
  }
  const components = Array.isArray(pack.components) ? pack.components : []
  const versionOf = (uid) => components.find((c) => c.uid === uid)?.version ?? null
  const mcVersion = versionOf('net.minecraft')
  if (!mcVersion) fail(`Instance ${resolved} has no net.minecraft component in mmc-pack.json`)
  const fabricLoader = versionOf('net.fabricmc.fabric-loader')
  const gameDir = path.join(resolved, 'minecraft')
  if (!exists(gameDir)) fail(`Instance ${resolved} has no minecraft/ directory`)
  const slug = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return { mcVersion, fabricLoader, gameDir, dataDir: path.join(SCRIPT_DIR, `data-${slug}-${mcVersion}`) }
}

async function loadFabricProfile() {
  const dest = path.join(DATA_DIR, 'meta', `fabric-loader-${MC_VERSION}-${FABRIC_LOADER}.json`)
  if (!exists(dest)) {
    const profile = await fetchJson(fabricProfileUrl(), 'Fabric loader profile')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    await fsp.writeFile(dest, JSON.stringify(profile, null, 2))
    log(`  downloaded ${path.relative(DATA_DIR, dest)}`)
  }
  return JSON.parse(await fsp.readFile(dest, 'utf8'))
}

async function resolveLog4jConfig(versionJson) {
  const cfg = versionJson.logging?.client?.file
  if (!cfg) return null
  const dest = path.join(DATA_DIR, 'meta', cfg.id)
  if (exists(dest)) return dest
  await download(cfg.url, dest, cfg.sha1, 'log4j client config')
  return dest
}

async function resolveClientJar(versionJson) {
  const own = path.join(DATA_DIR, 'client', `${MC_VERSION}.jar`)
  if (exists(own)) return own

  const client = versionJson.downloads?.client
  if (!client) fail(`Version JSON for ${MC_VERSION} has no downloads.client`)

  const prism = path.join(PRISM_LIBRARIES, 'com/mojang/minecraft', MC_VERSION, `minecraft-${MC_VERSION}-client.jar`)
  if (exists(prism) && (await sha1OfFile(prism)) === client.sha1) return prism

  await download(client.url, own, client.sha1, `client jar ${MC_VERSION}`)
  return own
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

async function resolveAssets(versionJson, opts) {
  const indexId = versionJson.assetIndex.id
  const defaultRoot = exists(path.join(PRISM_ASSETS, 'indexes', `${indexId}.json`))
    ? PRISM_ASSETS
    : path.join(DATA_DIR, 'assets')
  const assetsDir = opts.assetsDir ?? defaultRoot

  const indexPath = path.join(assetsDir, 'indexes', `${indexId}.json`)
  if (!exists(indexPath)) {
    await download(versionJson.assetIndex.url, indexPath, versionJson.assetIndex.sha1, `asset index ${indexId}`)
  }
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'))

  const missing = []
  for (const object of Object.values(index.objects)) {
    const objectPath = path.join(assetsDir, 'objects', object.hash.slice(0, 2), object.hash)
    if (!exists(objectPath)) missing.push(object)
  }

  if (missing.length > 0 && opts.downloadAssets) {
    log(`  downloading ${missing.length} missing asset objects...`)
    for (const object of missing) {
      const sub = object.hash.slice(0, 2)
      await download(
        `${ASSET_OBJECTS_URL}/${sub}/${object.hash}`,
        path.join(assetsDir, 'objects', sub, object.hash),
        object.hash,
        `asset object ${object.hash}`,
      )
    }
  } else if (missing.length > 0) {
    log(`  WARNING: ${missing.length} asset objects missing under ${assetsDir} (re-run with --download-assets to fetch them)`)
  }

  return { assetsDir, indexId, missing: missing.length }
}

// ---------------------------------------------------------------------------
// Natives
// ---------------------------------------------------------------------------

async function extractNatives(versionJson) {
  const nativesDir = path.join(DATA_DIR, 'natives')
  const nativeJars = []
  for (const lib of versionJson.libraries) {
    if (!lib.name.includes(':natives-') || !rulesAllow(lib.rules)) continue
    nativeJars.push(await resolveLibrary(lib))
  }

  const markerPath = path.join(nativesDir, '.extracted.json')
  const marker = JSON.stringify(nativeJars.map((jar) => path.basename(jar)).sort())
  if (exists(markerPath) && (await fsp.readFile(markerPath, 'utf8')) === marker) {
    return { nativesDir, count: nativeJars.length }
  }

  await fsp.rm(nativesDir, { recursive: true, force: true })
  for (const dir of ['', 'jna', 'lwjgl', 'netty']) fs.mkdirSync(path.join(nativesDir, dir), { recursive: true })

  for (const jar of nativeJars) {
    const result = spawnSync('unzip', ['-o', '-q', jar, '-d', nativesDir, '-x', 'META-INF/*'], { encoding: 'utf8' })
    if (result.status !== 0) {
      fail(`Failed to extract natives from ${jar}: ${result.stderr || `unzip exited with ${result.status}`}`)
    }
  }
  await fsp.writeFile(markerPath, marker)
  log(`  extracted ${nativeJars.length} native jars into ${path.relative(DATA_DIR, nativesDir)}`)
  return { nativesDir, count: nativeJars.length }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    username: 's0u7a',
    uuid: null,
    mcVersion: null,
    instance: null,
    fabricVersion: null,
    vanilla: false,
    gameDir: null,
    modsDir: null,
    dataDir: null,
    server: null,
    dryRun: false,
    downloadAssets: false,
    assetsDir: null,
    java: null,
    memory: '4G',
    killAfter: null,
    help: false,
  }
  const take = (i, flag) => {
    if (i + 1 >= argv.length) fail(`Missing value for ${flag}`)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--username') opts.username = take(i++, arg)
    else if (arg === '--uuid') opts.uuid = take(i++, arg)
    else if (arg === '--mc-version') opts.mcVersion = take(i++, arg)
    else if (arg === '--instance') opts.instance = path.resolve(take(i++, arg))
    else if (arg === '--fabric-version') opts.fabricVersion = take(i++, arg)
    else if (arg === '--vanilla') opts.vanilla = true
    else if (arg === '--game-dir') opts.gameDir = path.resolve(take(i++, arg))
    else if (arg === '--mods-dir') opts.modsDir = path.resolve(take(i++, arg))
    else if (arg === '--data-dir') opts.dataDir = path.resolve(take(i++, arg))
    else if (arg === '--server') opts.server = take(i++, arg)
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--download-assets') opts.downloadAssets = true
    else if (arg === '--assets-dir') opts.assetsDir = path.resolve(take(i++, arg))
    else if (arg === '--java') opts.java = take(i++, arg)
    else if (arg === '--memory') opts.memory = take(i++, arg)
    else if (arg === '--kill-after') opts.killAfter = Number(take(i++, arg))
    else if (arg === '--help' || arg === '-h') opts.help = true
    else fail(`Unknown argument: ${arg} (try --help)`)
  }
  return opts
}

function printHelp() {
  log(`Standalone Minecraft launcher (default: "${DEFAULT_INSTANCE_NAME}", Minecraft ${DEFAULT_MC_VERSION} + Fabric ${DEFAULT_FABRIC_LOADER})

  --instance DIR       launch a PrismLauncher instance (reads DIR/mmc-pack.json for the
                       Minecraft + Fabric Loader versions, uses DIR/minecraft as the
                       game dir, and derives a per-instance --data-dir)
  --mc-version V       Minecraft version to launch (default: ${DEFAULT_MC_VERSION})
  --fabric-version V   Fabric Loader version to launch (default: ${DEFAULT_FABRIC_LOADER} for
                       the built-in target, or whatever --instance declares)
  --vanilla            launch vanilla (no Fabric loader); needs --mc-version
  --game-dir DIR       game directory (default: the "${DEFAULT_INSTANCE_NAME}" instance)
  --mods-dir DIR       mods directory to count/report (default: <game-dir>/mods)
  --data-dir DIR       launcher cache dir for this target (default: ${DEFAULT_DATA_DIR})
  --server HOST:PORT   join this server directly via --quickPlayMultiplayer
  --username NAME      offline player name (default: s0u7a)
  --uuid UUID          offline UUID override (default: derived from the username)
  --dry-run            print the java command without launching
  --download-assets    also download asset objects that are missing from the cache
  --assets-dir DIR     assets root to use (default: the PrismLauncher assets cache)
  --java PATH          java executable (default: bundled Temurin JRE, then a system
                       JDK matching the version's javaVersion.majorVersion, then Java 25)
  --memory SIZE        heap size passed as -Xmx (default: 4G)
  --kill-after SECONDS stop the game automatically after N seconds (for scripted tests)
  --help               show this help`)
}

// ---------------------------------------------------------------------------
// Offline account
// ---------------------------------------------------------------------------

function offlineUuid(username) {
  const bytes = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30 // version 3
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // IETF variant
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

function findBundledJava() {
  const javaRoot = path.join(PRISM_DIR, 'java')
  if (!exists(javaRoot)) return null
  const candidates = fs
    .readdirSync(javaRoot)
    .filter((name) => name.toLowerCase().includes('jre') || name.toLowerCase().includes('jdk'))
    .sort()
    .reverse()
    .map((name) => path.join(javaRoot, name, 'bin', 'java'))
  return candidates.find((p) => exists(p)) ?? null
}

function pickJava(opts, versionJson) {
  const major = versionJson.javaVersion?.majorVersion ?? null
  const systemJdk = (m) => [
    `/usr/lib/jvm/java-${m}-openjdk-amd64/bin/java`,
    `/usr/lib/jvm/java-${m}-openjdk/bin/java`,
  ]
  // Prefer the bundled Temurin JRE first only when it already matches the
  // version's required major (keeps the default 26.2 target unchanged). For
  // other majors, prefer a system JDK of that exact major (e.g. Java 21 for
  // 1.21.11), then fall back to the bundled JRE (a newer JRE runs older
  // versions fine).
  const candidates = [opts.java]
  if (major === 25) candidates.push(findBundledJava())
  if (major) candidates.push(...systemJdk(major))
  candidates.push(findBundledJava(), ...systemJdk(25), ...systemJdk(21))
  const found = candidates.filter(Boolean)
  for (const candidate of found) {
    if (exists(candidate)) return candidate
  }
  fail(`No suitable Java found (version needs Java ${major ?? 'unknown'}). Tried:\n${found.join('\n')}`)
}

function javaVersionOf(javaPath) {
  const result = spawnSync(javaPath, ['-version'], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = output.match(/version "([^"]+)"/)
  return match ? match[1] : 'unknown'
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

function subst(value, ctx) {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) => (key in ctx ? ctx[key] : match))
}

function collectArgs(template, ctx, features = {}) {
  const out = []
  for (const entry of template) {
    if (typeof entry === 'object' && !rulesAllow(entry.rules, features)) continue
    const values = typeof entry === 'string' ? [entry] : entry.value
    for (const value of values) out.push(subst(value, ctx))
  }
  return out
}

function countMods() {
  let count = 0
  const walk = (dir) => {
    if (!exists(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name))
      else if (entry.name.endsWith('.jar')) count++
    }
  }
  walk(MODS_DIR)
  return count
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) return printHelp()

  const instance = opts.instance ? readInstance(opts.instance) : null
  // Priority: explicit flag > --instance mmc-pack.json > built-in default.
  DATA_DIR = opts.dataDir ?? instance?.dataDir ?? DEFAULT_DATA_DIR
  MC_VERSION = opts.mcVersion ?? instance?.mcVersion ?? DEFAULT_MC_VERSION
  GAME_DIR = opts.gameDir ?? instance?.gameDir ?? DEFAULT_GAME_DIR
  const declaredFabric = opts.fabricVersion ?? instance?.fabricLoader ?? (instance ? null : DEFAULT_FABRIC_LOADER)
  FABRIC_LOADER = declaredFabric ?? DEFAULT_FABRIC_LOADER
  MODS_DIR = opts.modsDir ?? path.join(GAME_DIR, 'mods')
  USE_FABRIC = !opts.vanilla && declaredFabric !== null

  initLogging()
  for (const dir of ['meta', 'libraries', 'client', 'natives', 'logs']) {
    fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true })
  }

  if (instance) log(`instance:   ${opts.instance}`)
  log(`Minecraft ${MC_VERSION}${USE_FABRIC ? ` + Fabric Loader ${FABRIC_LOADER}` : ' (vanilla)'}`)
  log(`game dir:  ${GAME_DIR}`)
  log(`data dir:  ${DATA_DIR}`)

  const versionJson = await loadVersionJson()
  const fabricProfile = USE_FABRIC ? await loadFabricProfile() : null
  const log4jConfig = await resolveLog4jConfig(versionJson)

  log('Resolving libraries...')
  const classpath = []
  let libraryCount = 0
  for (const lib of versionJson.libraries) {
    if (!rulesAllow(lib.rules)) continue
    if (lib.name.includes(':natives-')) continue
    classpath.push(await resolveLibrary(lib))
    libraryCount++
  }
  classpath.push(await resolveClientJar(versionJson))
  let fabricJarCount = 0
  if (fabricProfile) {
    for (const lib of fabricProfile.libraries) {
      classpath.push(await resolveMavenLibrary(lib))
      fabricJarCount++
    }
    classpath.push(await resolveMavenLibrary({ name: `net.fabricmc:intermediary:${MC_VERSION}`, url: FABRIC_MAVEN }))
    fabricJarCount++
  }
  log(`  ${libraryCount} Minecraft libraries + client jar${fabricJarCount ? ` + ${fabricJarCount} Fabric jars` : ''}`)

  const { nativesDir, count: nativeCount } = await extractNatives(versionJson)
  log(`Natives: ${nativesDir} (${nativeCount} jars)`)

  const assets = await resolveAssets(versionJson, opts)
  log(`Assets: ${assets.assetsDir} (index ${assets.indexId}, ${assets.missing} objects missing)`)
  log(`Mods: ${countMods()} jars in ${MODS_DIR}`)

  const javaPath = pickJava(opts, versionJson)
  const uuid = opts.uuid ?? offlineUuid(opts.username)
  log(`Java: ${javaPath} (${javaVersionOf(javaPath)})`)
  log(`Account: ${opts.username} (offline uuid ${uuid})`)

  const ctx = {
    auth_player_name: opts.username,
    auth_uuid: uuid,
    auth_access_token: '0',
    auth_xuid: '',
    clientid: '',
    user_type: 'legacy',
    version_name: MC_VERSION,
    version_type: 'release',
    game_directory: GAME_DIR,
    assets_root: assets.assetsDir,
    assets_index_name: assets.indexId,
    natives_directory: nativesDir,
    launcher_name: 'mc-ai-launch',
    launcher_version: '1.0.0',
    classpath: classpath.join(path.delimiter),
    resolution_width: '854',
    resolution_height: '480',
  }

  const jvmArgs = [
    ...collectArgs(versionJson.arguments.jvm, ctx),
    ...collectArgs(fabricProfile?.arguments?.jvm ?? [], ctx),
    `-Xmx${opts.memory}`,
    `-Djava.library.path=${nativesDir}`,
  ]
  if (log4jConfig) jvmArgs.push(`-Dlog4j.configurationFile=${log4jConfig}`)

  const gameArgs = [
    ...collectArgs(versionJson.arguments.game, ctx),
    '--userType',
    'legacy',
  ]
  if (opts.server) gameArgs.push('--quickPlayMultiplayer', opts.server)

  const mainClass = fabricProfile ? fabricProfile.mainClass : versionJson.mainClass
  const command = [javaPath, ...jvmArgs, mainClass, ...gameArgs]

  if (opts.dryRun) {
    log('--- java command (dry run) ---')
    log(command.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' \\\n  '))
    return
  }

  log(`Launching ${mainClass}...`)
  const child = spawn(javaPath, [...jvmArgs, mainClass, ...gameArgs], {
    cwd: GAME_DIR,
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  const forward = (stream, sink) => {
    let buffered = ''
    stream.on('data', (chunk) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) sink(line)
    })
    stream.on('end', () => {
      if (buffered) sink(buffered)
    })
  }
  forward(child.stdout, log)
  forward(child.stderr, log)

  const shutdown = (signal) => {
    log(`Received ${signal}, stopping Minecraft...`)
    child.kill('SIGTERM')
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  if (opts.killAfter) {
    setTimeout(() => {
      log(`--kill-after ${opts.killAfter}s reached, stopping Minecraft...`)
      child.kill('SIGTERM')
    }, opts.killAfter * 1000)
  }

  child.on('exit', (code, signal) => {
    log(`Minecraft exited (code=${code}, signal=${signal})`)
    log(`log file: ${logFile}`)
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  log(`FATAL: ${error.message}`)
  process.exit(1)
})
