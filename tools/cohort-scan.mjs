#!/usr/bin/env bun
// cohort-scan: predeclare the protocol-v2 coordinate cohort on the canonical
// capability seed. Boots ONE throwaway Leaf server, probes terrain through
// console commands only (no client, no agent), classifies each candidate
// column, and writes runs/capability-campaign/cohort-v2.json.
//
//   bun tools/cohort-scan.mjs [--seed 20260927] [--out runs/capability-campaign/cohort-v2.json]
//
// This is fixture generation, not agent capability: it runs entirely before
// any measured run, on a throwaway world that is deleted afterwards. The
// chosen coordinates are then passed to capability-run.mjs --start, which
// replays them via setworldspawn + spawnRadius 0 before resident join.
//
// Terrain classes:
//   normal  — solid survivable surface (grass/dirt/snow/sand/stone family)
//   stress  — water/lava/ice/void-adjacent or otherwise non-normal starts
// Coordinates are spaced >= SEPARATION_BLOCKS apart so one trial's local
// mutations cannot contaminate another's region files.
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_DIR, '..')
const LEAF_JAR = '/home/s0u7a/mc-server/leaf-1.21.11-178.jar'
const SEPARATION_BLOCKS = 512
const SCAN_PORT = 26690

// The normal cohort spans common survivable overworld biomes that contain or
// neighbor trees (the wood rung needs log sources). Multiple search origins
// give separated candidates inside the same biome family.
const NORMAL_BIOMES = ['minecraft:forest', 'minecraft:birch_forest', 'minecraft:taiga', 'minecraft:plains', 'minecraft:dark_forest']
const STRESS_BIOMES = ['minecraft:snowy_plains', 'minecraft:ocean']
const ORIGINS = [[0, 0], [6000, 0], [-6000, 0], [0, 6000], [0, -6000]]

// Surface blocks that count as an ordinary survivable start.
const OK_SURFACE = ['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'sand', 'red_sand', 'gravel', 'stone', 'snow_block', 'mud']
const BAD_SURFACE = ['water', 'lava', 'ice', 'packed_ice', 'blue_ice', 'cactus']

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const seed = String(opt('seed', '20260927'))
const outPath = resolve(opt('out', join(REPO_ROOT, 'runs/capability-campaign/cohort-v2.json')))
const scanDir = join(REPO_ROOT, 'runs/capability-campaign/scans', `cohort-scan-${seed}`)
const serverDir = join(scanDir, 'server')

// Server lifecycle + all world mutation live inside run() so that importing
// this module (tests, tooling) never launches a process.
let server = null
let serverLog = ''
function launchServer() {
  if (!existsSync(LEAF_JAR)) throw new Error(`leaf jar missing: ${LEAF_JAR}`)
  rmSync(scanDir, { recursive: true, force: true })
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, 'eula.txt'), 'eula=true\n')
  writeFileSync(join(serverDir, 'server.properties'), [
    'eula=true', 'online-mode=false', 'difficulty=peaceful', 'spawn-monsters=false',
    `server-port=${SCAN_PORT}`, 'level-type=minecraft:normal', `level-seed=${seed}`,
    'level-name=world', 'sync-chunk-writes=false', 'view-distance=10', 'simulation-distance=6',
    'generate-structures=true', 'max-world-size=29999984',
  ].join('\n') + '\n')
  server = spawn('java', ['-Xmx2G', '-jar', LEAF_JAR, 'nogui'], { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => { serverLog += d })
  server.stderr.on('data', (d) => { serverLog += d })
}

const waitFor = (regex, timeoutMs = 120000) => new Promise((resolveP, reject) => {
  const started = Date.now()
  const timer = setInterval(() => {
    if (regex.test(serverLog)) { clearInterval(timer); resolveP() }
    else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timeout waiting for ${regex}`)) }
  }, 200)
})

/** Send a console command and capture the next log lines until a marker resolves. */
function command(cmd, { expect = null, timeoutMs = 30000 } = {}) {
  const baseline = serverLog.length
  server.stdin.write(`${cmd}\n`)
  return new Promise((resolveP) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const tail = serverLog.slice(baseline)
      const matched = expect === null || expect.test(tail)
      if (matched || Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolveP(tail)
      }
    }, 100)
  })
}

const LOCATE_RE = /nearest\s+minecraft:(\w+)\s+is\s+at\s+\[(-?\d+),\s*~?-?\d*,\s*(-?\d+)\]/u
const POS_RE = /entity data:\s*\[(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\]/u

async function probeColumn(x, z, wantBiome) {
  // Chunk must exist for positioned-over to resolve the heightmap.
  await command(`forceload add ${x} ${z}`)
  await new Promise((r) => setTimeout(r, 600))
  const summon = await command(`execute positioned ${x} 0 ${z} positioned over motion_blocking_no_leaves run summon minecraft:marker ~ ~ ~ {Tags:["cohort_scan"]}`, { expect: /Summoned new Marker/u })
  let y = null
  if (/Summoned new Marker/u.test(summon)) {
    const data = await command('data get entity @e[tag=cohort_scan,limit=1] Pos', { expect: /entity data:/u })
    const m = POS_RE.exec(data)
    if (m !== null) y = Math.floor(Number(m[2]))
  }
  await command('kill @e[tag=cohort_scan]')

  let surfaceBlock = null
  let biome = null
  if (y !== null) {
    for (const block of [...OK_SURFACE, ...BAD_SURFACE]) {
      const probe = await command(`execute positioned ${x} ${y} ${z} if block ~ ~-1 ~ minecraft:${block} run say SURFACE_${block}`, { expect: /SURFACE_|Test failed|Failed to execute/u, timeoutMs: 8000 })
      if (probe.includes(`SURFACE_${block}`)) { surfaceBlock = block; break }
    }
    const biomeProbe = await command(`execute positioned ${x} ${y} ${z} if biome ~ ~ ~ ${wantBiome} run say BIOME_CONFIRMED`, { expect: /BIOME_CONFIRMED|Test failed|Failed to execute/u, timeoutMs: 8000 })
    if (!biomeProbe.includes('BIOME_CONFIRMED')) {
      // Authoritative biome at the column: ask for each known family.
      for (const b of [...NORMAL_BIOMES, ...STRESS_BIOMES, 'minecraft:river', 'minecraft:frozen_ocean', 'minecraft:stony_peaks', 'minecraft:jagged_peaks']) {
        const p = await command(`execute positioned ${x} ${y} ${z} if biome ~ ~ ~ ${b} run say BIOME_IS_${b.replace('minecraft:', '')}`, { expect: /BIOME_IS_|Test failed|Failed to execute/u, timeoutMs: 8000 })
        const bm = /BIOME_IS_(\w+)/u.exec(p)
        if (bm !== null) { biome = bm[1]; break }
      }
    } else biome = wantBiome.replace('minecraft:', '')
  }
  await command(`forceload remove ${x} ${z}`)
  return { x, z, surfaceY: y, surfaceBlock, biome }
}

async function main() {
  launchServer()
  await waitFor(/Done \(/u)
  await command('forceload remove all')
  const candidates = []
  for (const biome of NORMAL_BIOMES) {
    for (const [ox, oz] of ORIGINS) {
      const out = await command(`execute positioned ${ox} 64 ${oz} run locate biome ${biome}`, { expect: /nearest|[Cc]ould not find/u, timeoutMs: 60000 })
      const m = LOCATE_RE.exec(out)
      if (m !== null) candidates.push({ wantBiome: biome, x: Number(m[2]), z: Number(m[3]) })
    }
  }
  for (const biome of STRESS_BIOMES) {
    for (const [ox, oz] of [[0, 0], [6000, 6000]]) {
      const out = await command(`execute positioned ${ox} 64 ${oz} run locate biome ${biome}`, { expect: /nearest|[Cc]ould not find/u, timeoutMs: 60000 })
      const m = LOCATE_RE.exec(out)
      if (m !== null) candidates.push({ wantBiome: biome, x: Number(m[2]), z: Number(m[3]) })
    }
  }

  // Deduplicate columns (locate from different origins can return the same forest).
  const seen = new Set()
  const unique = candidates.filter((c) => {
    const key = `${Math.round(c.x / 64)}:${Math.round(c.z / 64)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const probed = []
  for (const c of unique) {
    const p = await probeColumn(c.x, c.z, c.wantBiome)
    probed.push({ ...c, ...p })
    process.stdout.write(`probe ${c.wantBiome} @ ${p.x},${p.surfaceY ?? '?'},${p.z} surface=${p.surfaceBlock ?? 'unknown'} biome=${p.biome ?? 'unknown'}\n`)
  }

  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  const isNormal = (p) => p.surfaceY !== null && OK_SURFACE.includes(p.surfaceBlock ?? '')
  const chosen = []
  for (const p of probed.filter(isNormal)) {
    if (chosen.every((q) => distance(p, q) >= SEPARATION_BLOCKS)) chosen.push({ ...p, cohort: 'normal' })
    if (chosen.length >= 5) break
  }
  const stress = []
  for (const p of probed.filter((q) => !isNormal(q) || STRESS_BIOMES.includes(q.wantBiome))) {
    if (stress.every((q) => distance(p, q) >= SEPARATION_BLOCKS) && chosen.every((q) => distance(p, q) >= SEPARATION_BLOCKS)) {
      stress.push({ ...p, cohort: 'stress' })
    }
    if (stress.length >= 2) break
  }

  const cohort = {
    record: 'capability-cohort',
    protocolVersion: 'v2',
    schemaVersion: 1,
    canonicalSeed: seed,
    generatedAt: new Date().toISOString(),
    separationBlocks: SEPARATION_BLOCKS,
    note: 'Predeclared fixture coordinates; chosen before any candidate results. Y is the motion_blocking_no_leaves surface (first standable air is Y). capability-run --start places the spawn fixture pre-run.',
    normal: chosen.map((p, i) => ({
      id: `v2-n${i + 1}`, seed, start: { x: p.x, y: p.surfaceY, z: p.z },
      biome: p.biome, surfaceBlock: p.surfaceBlock, terrainClass: terrainClass(p), cohort: 'normal',
    })),
    stress: stress.map((p, i) => ({
      id: `v2-s${i + 1}`, seed, start: { x: p.x, y: p.surfaceY, z: p.z },
      biome: p.biome, surfaceBlock: p.surfaceBlock, terrainClass: terrainClass(p), cohort: 'stress',
    })),
    probedAll: probed.map((p) => ({ wantBiome: p.wantBiome, x: p.x, z: p.z, surfaceY: p.surfaceY, surfaceBlock: p.surfaceBlock, biome: p.biome })),
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(cohort, null, 2)}\n`)
  process.stdout.write(`cohort written: ${outPath} normal=${cohort.normal.length} stress=${cohort.stress.length}\n`)
}

function terrainClass(p) {
  if (p.surfaceBlock === null || p.surfaceBlock === undefined) return 'unknown'
  if (BAD_SURFACE.includes(p.surfaceBlock)) return p.surfaceBlock === 'water' ? 'ocean_or_lake' : 'hazard_surface'
  if (p.surfaceBlock === 'snow_block') return 'snowy_ground'
  if (['sand', 'red_sand'].includes(p.surfaceBlock)) return 'arid_ground'
  if (['stone', 'gravel'].includes(p.surfaceBlock)) return 'bare_rock'
  return 'vegetated_ground'
}

if (import.meta.main) {
  try {
    await main()
  } finally {
    try { server?.stdin.write('stop\n') } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 3000))
    try { server?.kill('SIGKILL') } catch { /* ignore */ }
    // Keep the server log tail for provenance but drop the generated world.
    try { writeFileSync(join(scanDir, 'scan-server.log'), serverLog) } catch { /* ignore */ }
    rmSync(join(scanDir, 'server'), { recursive: true, force: true })
  }
}
