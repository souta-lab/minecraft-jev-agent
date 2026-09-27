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
import { createRequire } from 'node:module'

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
const fromProbed = opt('from-probed', null) === null ? null : resolve(opt('from-probed', null))
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
  server = spawn('java', ['-Xmx2G', '-DPaper.IgnoreJavaVersion=true', '-jar', LEAF_JAR, '--nogui'], { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'] })
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

const ANSI_RE = /\[[0-9;]*m/gu
const stripAnsi = (s) => s.replace(ANSI_RE, '')

/** Send a console command and capture the next log lines until a marker resolves. */
function command(cmd, { expect = null, timeoutMs = 30000 } = {}) {
  const baseline = serverLog.length
  server.stdin.write(`${cmd}\n`)
  return new Promise((resolveP) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const tail = stripAnsi(serverLog.slice(baseline))
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

/**
 * True when the column is passable at feet and head height (spawn-safe).
 * Uses #minecraft:replaceable (air + plants + snow layers + replaceables)
 * rather than literal air — a grass-covered floor must not fail clearance.
 * Fluids are excluded explicitly so water/lava columns never pass.
 */
async function columnClear(x, y, z) {
  const feet = await command(`execute positioned ${x} ${y} ${z} if block ~ ~ ~ #minecraft:replaceable unless block ~ ~ ~ minecraft:water unless block ~ ~ ~ minecraft:lava run say FEET_OK`, { expect: /FEET_OK|Test failed|Failed to execute/u, timeoutMs: 8000 })
  if (!feet.includes('FEET_OK')) return false
  const head = await command(`execute positioned ${x} ${y} ${z} if block ~ ~1 ~ #minecraft:replaceable unless block ~ ~1 ~ minecraft:water unless block ~ ~1 ~ minecraft:lava run say HEAD_OK`, { expect: /HEAD_OK|Test failed|Failed to execute/u, timeoutMs: 8000 })
  return head.includes('HEAD_OK')
}

async function probeColumn(x, z, wantBiome) {
  // Chunk must exist for positioned-over to resolve the heightmap.
  await command(`forceload add ${x} ${z} ${x} ${z}`)
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
      for (const b of [...NORMAL_BIOMES, ...STRESS_BIOMES, 'minecraft:river', 'minecraft:frozen_ocean', 'minecraft:stony_peaks', 'minecraft:jagged_peaks', 'minecraft:pale_garden']) {
        const p = await command(`execute positioned ${x} ${y} ${z} if biome ~ ~ ~ ${b} run say BIOME_IS_${b.replace('minecraft:', '')}`, { expect: /BIOME_IS_|Test failed|Failed to execute/u, timeoutMs: 8000 })
        const bm = /BIOME_IS_(\w+)/u.exec(p)
        if (bm !== null) { biome = bm[1]; break }
      }
    } else biome = wantBiome.replace('minecraft:', '')
  }
  // Clearance: the declared column must be canopy-free AND standable —
  // vanilla spawn resolves Y via motion_blocking (leaves count) plus a
  // standability search, so overhead canopy shifts the actual spawn column
  // even when the ground column itself is clear (seen live: declared
  // 0,84,0 forest -> resident landed 1.5,91,-8.5 on leaves). A column is
  // clean iff motion_blocking height == motion_blocking_no_leaves height
  // (nothing overhead), the surface is survivable, and air at feet/head.
  let clear = false
  if (y !== null && surfaceBlock !== null) {
    const spiral = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2], [3, 0], [0, 3], [-3, 0], [0, -3], [3, 3], [-3, -3], [3, -3], [-3, 3], [4, 0], [0, 4], [-4, 0], [0, -4]]
    for (const [dx, dz] of spiral) {
      const cx = x + dx; const cz = z + dz
      const mb = await heightAt(cx, cz, 'motion_blocking')
      const nl = await heightAt(cx, cz, 'motion_blocking_no_leaves')
      if (mb === null || nl === null || mb !== nl || Math.abs(nl - y) > 3) continue
      const ground = await command(`execute positioned ${cx} ${nl} ${cz} if block ~ ~-1 ~ minecraft:${surfaceBlock} run say SAME_GROUND`, { expect: /SAME_GROUND|Test failed|Failed to execute/u, timeoutMs: 8000 })
      if (!ground.includes('SAME_GROUND')) continue
      if (!(await columnClear(cx, nl, cz))) continue
      x = cx; z = cz; y = nl; clear = true
      break
    }
  }
  await command(`forceload remove ${x} ${z}`)
  return { x, z, surfaceY: y, surfaceBlock, biome, columnClear: clear }
}

/** Heightmap Y at a column via a marker summon + data get (returns null if unresolved). */
async function heightAt(x, z, heightmap) {
  const cand = await command(`execute positioned ${x} 0 ${z} positioned over ${heightmap} run summon minecraft:marker ~ ~ ~ {Tags:["cohort_scan"]}`, { expect: /Summoned new Marker/u })
  if (!/Summoned new Marker/u.test(cand)) return null
  const data = await command('data get entity @e[tag=cohort_scan,limit=1] Pos', { expect: /entity data:/u })
  await command('kill @e[tag=cohort_scan]')
  const m = POS_RE.exec(data)
  return m === null ? null : Math.floor(Number(m[2]))
}

const displacement = (v, p) => Math.hypot(v.x - (p.x + 0.5), v.z - (p.z + 0.5))

/**
 * Deterministic canopy census of the spawn chunk: the engine's random
 * in-chunk spawn search can land on ANY standable column, so a single
 * canopy column anywhere in the chunk condemns the fixture. A column has
 * canopy iff motion_blocking > motion_blocking_no_leaves (a leaf is the
 * topmost motion-blocker). Early-exits after maxFind canopy columns.
 */
async function chunkCanopyScan(x, z, maxFind = 5) {
  const cx = Math.floor(x / 16) * 16; const cz = Math.floor(z / 16) * 16
  await command(`forceload add ${cx} ${cz} ${cx + 15} ${cz + 15}`)
  await new Promise((r) => setTimeout(r, 400))
  const canopy = []
  let scanned = 0
  for (let dx = 0; dx < 16 && canopy.length < maxFind; dx += 1) {
    for (let dz = 0; dz < 16 && canopy.length < maxFind; dz += 1) {
      const colX = cx + dx; const colZ = cz + dz
      const mb = await heightAt(colX, colZ, 'motion_blocking')
      const nl = await heightAt(colX, colZ, 'motion_blocking_no_leaves')
      scanned += 1
      if (mb !== null && nl !== null && mb > nl) canopy.push(`${colX},${colZ}`)
    }
  }
  await command(`forceload remove ${cx} ${cz} ${cx + 15} ${cz + 15}`)
  // complete=true only when the whole 256-column chunk was scanned.
  return { canopyCount: canopy.length, scannedColumns: scanned, complete: canopy.length < maxFind, canopy }
}

/**
 * Authoritative fixture verification: a real client join resolves the spawn
 * the same way the capability resident does (worldspawn + standability
 * search). Vanilla then picks a RANDOM standable column inside the spawn
 * chunk, so the honest predicate is "the chunk yields survivable landings":
 * after the join we probe the actual landing column's ground block + head
 * clearance via console commands. Read-only: the throwaway bot only observes.
 */
async function verifyJoin(x, y, z) {
  await command('gamerule spawnRadius 0')
  await command(`setworldspawn ${x} ${y} ${z}`)
  await new Promise((r) => setTimeout(r, 400))
  const require_ = createRequire(join(REPO_ROOT, 'package.json'))
  const mineflayer = require_('mineflayer')
  const bot = await new Promise((resolveBot, reject) => {
    const b = mineflayer.createBot({ host: '127.0.0.1', port: SCAN_PORT, username: `scan_${Math.floor(Math.random() * 10000)}`, version: '1.21.11', auth: 'offline' })
    const to = setTimeout(() => { try { b.end() } catch { /* */ } reject(new Error('join timeout')) }, 30000)
    b.once('spawn', () => { clearTimeout(to); resolveBot(b) })
    b.once('error', reject)
    b.once('kicked', (r) => reject(new Error(`kicked: ${r}`)))
  })
  const pos = bot.entity.position
  const verified = { x: pos.x, y: pos.y, z: pos.z, onGround: bot.entity.onGround }
  bot.end()
  await new Promise((r) => setTimeout(r, 300))
  // What did the landing column actually stand on?
  const fx = Math.floor(pos.x); const fy = Math.floor(pos.y); const fz = Math.floor(pos.z)
  for (const block of [...OK_SURFACE, ...BAD_SURFACE, 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'dark_oak_leaves']) {
    const probe = await command(`execute positioned ${fx} ${fy} ${fz} if block ~ ~-1 ~ minecraft:${block} run say LAND_${block}`, { expect: /LAND_|Test failed|Failed to execute/u, timeoutMs: 8000 })
    if (probe.includes(`LAND_${block}`)) { verified.groundBlock = block; break }
  }
  verified.headroomClear = await columnClear(fx, fy, fz)
  // Open-sky check: the landing column's motion-blocking height equals the
  // feet level exactly when nothing solid sits above the landing (no canopy,
  // cave roof, or overhang). Null (unresolved) is tolerated, not trusted.
  const mb = await heightAt(fx, fz, 'motion_blocking')
  verified.skyAbove = mb === null ? null : mb <= fy
  await new Promise((r) => setTimeout(r, 300))
  return verified
}

/**
 * Spawn-verify each chosen column. A candidate is accepted after two clean
 * landings on ordinary survivable ground inside the spawn chunk; a landing
 * on water/leaves/void or a >12-block vertical drop rejects the column.
 * Rejected columns are never re-picked, and a replacement gets a fresh
 * object so verify evidence never goes stale.
 */
async function verifyCohort(chosen, probed) {
  const remaining = [...probed]
  const rejected = new Set()
  const landOk = (v) => v.error === undefined && OK_SURFACE.includes(v.groundBlock ?? '') && v.headroomClear === true && v.skyAbove !== false
  const isNormal = (p) => p.surfaceY !== null && OK_SURFACE.includes(p.surfaceBlock ?? '') && p.columnClear === true && (p.verifyRejections ?? 0) === 0
  const condemn = (candidate) => {
    rejected.add(`${candidate.x},${candidate.z}`)
    const rec = remaining.find((p) => p.x === candidate.x && p.z === candidate.z)
    if (rec !== undefined) rec.verifyRejections = (rec.verifyRejections ?? 0) + 1
  }
  const pickAlt = (i, candidate) => {
    const altOk = (p) => !rejected.has(`${p.x},${p.z}`) && p.claimed !== true && isNormal(p) && chosen.every((q) => q === chosen[i] || Math.hypot(q.x - p.x, q.z - p.z) >= 256)
    // Prefer the same biome family; fall back to any survivable column —
    // slot identity is fixture metadata, biome diversity is best-effort.
    const alt = remaining.find((p) => altOk(p) && (p.biome ?? 'unknown') === (candidate.biome ?? 'unknown')) ?? remaining.find((p) => altOk(p))
    if (alt !== undefined) alt.claimed = true
    return alt
  }
  for (let i = 0; i < chosen.length; i += 1) {
    let candidate = chosen[i]
    let altsLeft = 6
    let joins = 0
    while (!candidate.spawnOk && joins < 10) {
      // Deterministic canopy census first — the engine picks a random
      // standable column in the spawn chunk, so canopy fraction bounds the
      // dirty-landing risk. Accept only a fully scanned chunk with <=4
      // canopy columns (~1.6% worst-case risk); tree-biome chunks with real
      // canopy are condemned without spending joins.
      if (candidate.chunkCanopy === undefined && isNormal(candidate)) {
        candidate.chunkCanopy = await chunkCanopyScan(candidate.x, candidate.z)
        const cc = candidate.chunkCanopy
        process.stdout.write(`canopy-scan ${candidate.wantBiome} @ ${candidate.x},${candidate.z} canopy=${cc.canopyCount}${cc.complete ? '' : '+'} scanned=${cc.scannedColumns}\n`)
        if (!(cc.complete && cc.canopyCount <= 4)) {
          condemn(candidate)
          const alt = altsLeft > 0 ? pickAlt(i, candidate) : undefined
          if (alt === undefined) break
          altsLeft -= 1
          candidate = { ...alt, cohort: 'normal', replacedFrom: `${candidate.x},${candidate.z}` }
          chosen[i] = candidate
          continue
        }
      }
      const v = await verifyJoin(candidate.x, candidate.surfaceY, candidate.z).catch((e) => ({ error: e.message }))
      joins += 1
      const horiz = v.error === undefined ? displacement(v, candidate) : null
      const vert = v.error === undefined ? v.y - (candidate.surfaceY + 1) : null
      const clean = landOk(v) && horiz <= 18 && Math.abs(vert) <= 12
      candidate.spawnVerified = v
      candidate.spawnDisplacement = horiz
      candidate.spawnVerticalDelta = vert
      candidate.spawnOkCount = (candidate.spawnOkCount ?? 0) + (clean ? 1 : 0)
      process.stdout.write(`spawn-verify ${candidate.wantBiome} @ ${candidate.x},${candidate.surfaceY},${candidate.z} -> ${v.error !== undefined ? `ERR ${v.error}` : `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)} ground=${v.groundBlock ?? '?'} headroom=${v.headroomClear} sky=${v.skyAbove} disp=${horiz.toFixed(1)} dY=${vert.toFixed(1)} ${clean ? 'OK' : 'REJECT'}`}\n`)
      if (candidate.spawnOkCount >= 2) { candidate.spawnOk = true; break }
      if (!clean) {
        // A dirty/unsafe landing condemns the whole column — persistently.
        condemn(candidate)
        const alt = altsLeft > 0 ? pickAlt(i, candidate) : undefined
        if (alt === undefined) break
        altsLeft -= 1
        candidate = { ...alt, cohort: 'normal', replacedFrom: `${candidate.x},${candidate.z}` }
        chosen[i] = candidate
      }
    }
    candidate.spawnOk = candidate.spawnOk === true
  }
}

/** Map a probed/verified column to its cohort record entry. */
const cohortEntry = (p, i, kind) => ({
  id: `${kind === 'normal' ? 'v2-n' : 'v2-s'}${i + 1}`, seed,
  start: { x: p.x, y: p.surfaceY, z: p.z },
  biome: p.biome ?? null,
  locatedBiome: (p.wantBiome ?? '').replace('minecraft:', '') || null,
  surfaceBlock: p.surfaceBlock, terrainClass: terrainClass(p), cohort: kind,
  role: kind === 'normal' ? (i < 3 ? 'dev' : 'holdout') : 'stress',
  spawnVerified: p.spawnVerified ?? null,
  spawnDisplacement: p.spawnDisplacement ?? null,
  spawnVerticalDelta: p.spawnVerticalDelta ?? null,
  spawnOkCount: p.spawnOkCount ?? null,
  spawnOk: p.spawnOk ?? null,
  chunkCanopy: p.chunkCanopy ?? null,
  ...(p.replacedFrom !== undefined ? { replacedFrom: p.replacedFrom } : {}),
})

/** Re-run selection on an already-scanned file — no server boot. */
function reselect(path) {
  const existing = JSON.parse(readFileSync(path, 'utf8'))
  const { normal, stress } = selectCohort(existing.probedAll, SEPARATION_BLOCKS)
  existing.normal = normal.map((p, i) => cohortEntry(p, i, 'normal'))
  existing.stress = stress.map((p, i) => cohortEntry(p, i, 'stress'))
  existing.reselectedAt = new Date().toISOString()
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`)
  process.stdout.write(`reselected: normal=${existing.normal.length} stress=${existing.stress.length}\n`)
  return existing
}

/** Transient verify state is stripped; only the rejection count persists. */
const sanitizeProbed = (p) => ({ wantBiome: p.wantBiome, x: p.x, z: p.z, surfaceY: p.surfaceY, surfaceBlock: p.surfaceBlock, biome: p.biome, columnClear: p.columnClear ?? null, verifyRejections: p.verifyRejections ?? 0 })

/**
 * Reselect from an existing scan's probedAll AND spawn-verify the picks —
 * boots the throwaway server for real client joins but skips the initial
 * biome sweep. Families with too few normal-eligible candidates are topped
 * up with fresh locate/probe passes from extra origins first, so verify
 * has alternates to fall back to. Use to repair a cohort file.
 */
async function reverify(path) {
  const existing = JSON.parse(readFileSync(path, 'utf8'))
  existing.probedAll = (existing.probedAll ?? []).map(sanitizeProbed)
  launchServer()
  await waitFor(/Done \(/u)
  await command('forceload remove all')

  // Top-up underpopulated families so failed slots have replacements.
  const EXTRA_ORIGINS = [[3000, 3000], [-3000, -3000], [9000, 9000], [-9000, -9000], [3000, -9000], [-9000, 3000], [9000, 0], [0, 9000]]
  const eligible = (biomeName) => existing.probedAll.filter((p) => (p.biome ?? 'unknown') === biomeName && p.surfaceY !== null && OK_SURFACE.includes(p.surfaceBlock ?? '') && p.columnClear === true && (p.verifyRejections ?? 0) === 0).length
  for (const biome of NORMAL_BIOMES) {
    const name = biome.replace('minecraft:', '')
    for (const [ox, oz] of EXTRA_ORIGINS) {
      if (eligible(name) >= 5) break
      const out = await command(`execute positioned ${ox} 64 ${oz} run locate biome ${biome}`, { expect: /nearest|[Cc]ould not find/u, timeoutMs: 60000 })
      const m = LOCATE_RE.exec(out)
      if (m === null) continue
      const x = Number(m[2]); const z = Number(m[3])
      if (existing.probedAll.some((p) => Math.round(p.x / 64) === Math.round(x / 64) && Math.round(p.z / 64) === Math.round(z / 64))) continue
      const p = await probeColumn(x, z, biome)
      existing.probedAll.push({ wantBiome: biome, ...p })
      process.stdout.write(`topup-probe ${biome} @ ${p.x},${p.surfaceY ?? '?'},${p.z} surface=${p.surfaceBlock ?? 'unknown'} biome=${p.biome ?? 'unknown'} clear=${p.columnClear}\n`)
    }
  }

  const { normal, stress } = selectCohort(existing.probedAll, SEPARATION_BLOCKS)
  await verifyCohort(normal, existing.probedAll)
  existing.normal = normal.map((p, i) => cohortEntry(p, i, 'normal'))
  existing.stress = stress.map((p, i) => cohortEntry(p, i, 'stress'))
  existing.probedAll = existing.probedAll.map(sanitizeProbed)
  existing.reverifiedAt = new Date().toISOString()
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`)
  process.stdout.write(`reverified: normal=${existing.normal.length} stress=${existing.stress.length} ok=${normal.filter((p) => p.spawnOk).length}\n`)
}

async function main() {
  if (fromProbed !== null) {
    if (args.includes('--verify')) await reverify(fromProbed)
    else reselect(fromProbed)
    return
  }
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

  let { normal: chosen, stress } = selectCohort(probed, SEPARATION_BLOCKS)

  // Real-join fixture verification: measure where the engine actually puts a
  // fresh spawn at each declared column (worldspawn + standability search).
  // Displaced columns are demoted to the next eligible probed candidate.
  await verifyCohort(chosen, probed)

  const cohort = {
    record: 'capability-cohort',
    protocolVersion: 'v2',
    schemaVersion: 1,
    canonicalSeed: seed,
    generatedAt: new Date().toISOString(),
    separationBlocks: SEPARATION_BLOCKS,
    note: 'Predeclared fixture coordinates; chosen before any candidate results. Y is the motion_blocking_no_leaves surface (first standable air is Y). capability-run --start places the spawn fixture pre-run.',
    normal: chosen.map((p, i) => cohortEntry(p, i, 'normal')),
    stress: stress.map((p, i) => cohortEntry(p, i, 'stress')),
    probedAll: probed.map((p) => ({ wantBiome: p.wantBiome, x: p.x, z: p.z, surfaceY: p.surfaceY, surfaceBlock: p.surfaceBlock, biome: p.biome, columnClear: p.columnClear ?? null })),
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(cohort, null, 2)}\n`)
  process.stdout.write(`cohort written: ${outPath} normal=${cohort.normal.length} stress=${cohort.stress.length}\n`)
}

/**
 * Deterministic selection from scanned candidates: round-robin across biome
 * families so the normal cohort covers distinct terrain, then separation
 * >=512 blocks. First 3 normal entries are the dev runs, last 2 are the
 * declared holdout pair — order is fixed before any candidate result.
 */
function selectCohort(probed, separation) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  const isNormal = (p) => p.surfaceY !== null && OK_SURFACE.includes(p.surfaceBlock ?? '') && p.columnClear === true && (p.verifyRejections ?? 0) === 0
  const byBiome = new Map()
  for (const p of probed.filter(isNormal)) {
    const key = p.biome ?? 'unknown'
    if (!byBiome.has(key)) byBiome.set(key, [])
    byBiome.get(key).push(p)
  }
  const chosen = []
  const farEnough = (p) => chosen.every((q) => distance(p, q) >= separation)
  let progressed = true
  while (chosen.length < 5 && progressed) {
    progressed = false
    for (const list of byBiome.values()) {
      const next = list.find((p) => farEnough(p))
      if (next !== undefined) {
        chosen.push({ ...next, cohort: 'normal' })
        list.splice(list.indexOf(next), 1)
        progressed = true
        if (chosen.length >= 5) break
      }
    }
  }
  const stress = []
  for (const p of probed.filter((q) => !isNormal(q) || STRESS_BIOMES.includes(q.wantBiome))) {
    if (stress.every((q) => distance(p, q) >= separation) && chosen.every((q) => distance(p, q) >= separation)) {
      stress.push({ ...p, cohort: 'stress' })
    }
    if (stress.length >= 2) break
  }
  return { normal: chosen, stress }
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
