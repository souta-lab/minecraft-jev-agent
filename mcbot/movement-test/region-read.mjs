#!/usr/bin/env node
// movement-test/region-read.mjs
//
// Minimal read-only Minecraft Anvil (.mca) reader for the live Leaf world.
// Used only to inspect terrain geometry (pit walls / step-ups) without touching
// the server. Parses the region header, inflates zlib chunks, decodes the
// paletted block_states of every section and exposes a getBlock(x,y,z).
//
// Usage (as a library):
//   import { openWorld } from './region-read.mjs'
//   const world = openWorld('/home/s0u7a/mc-server/world/dimensions/minecraft/overworld/region')
//   world.blockName(x, y, z)
//
// Usage (CLI scan):
//   node region-read.mjs scan <x> <y> <z> [radius]
//   node region-read.mjs column <x> <z>

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import nbtPkg from '/home/s0u7a/mc-ai/mcbot/movement-test/variants/G/mineflayer-src/node_modules/prismarine-nbt/nbt.js'

const nbt = nbtPkg.default ?? nbtPkg

const REGION_DIR = '/home/s0u7a/mc-server/world/dimensions/minecraft/overworld/region'
const SECTOR = 4096

function parseChunk (buf) {
  const len = buf.readUInt32BE(0)
  const comp = buf.readUInt8(4)
  const data = buf.subarray(5, 4 + len)
  if (comp === 1) return zlib.gunzipSync(data)
  if (comp === 2) return zlib.inflateSync(data)
  if (comp === 3) return data
  throw new Error(`unsupported compression ${comp}`)
}

async function readRegionChunk (regionPath, cx, cz) {
  const fd = fs.openSync(regionPath, 'r')
  try {
    const header = Buffer.alloc(SECTOR)
    fs.readSync(fd, header, 0, SECTOR, 0)
    const idx = ((cx & 31) + (cz & 31) * 32)
    const off = header.readUIntBE(idx * 4, 3)
    const cnt = header.readUInt8(idx * 4 + 3)
    if (off === 0 || cnt === 0) return null
    const raw = Buffer.alloc(cnt * SECTOR)
    fs.readSync(fd, raw, 0, cnt * SECTOR, off * SECTOR)
    return parseChunk(raw)
  } finally { fs.closeSync(fd) }
}

function longToBigInt (v) {
  if (typeof v === 'bigint') return v
  if (Array.isArray(v)) { // [high, low]
    const hi = BigInt(v[0] >>> 0); const lo = BigInt(v[1] >>> 0)
    return (hi << 32n) | lo
  }
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  throw new Error('unknown long repr ' + typeof v)
}

export function openWorld (regionDir = REGION_DIR) {
  const cache = new Map()
  async function getChunk (cx, cz) {
    const key = `${cx},${cz}`
    if (cache.has(key)) return cache.get(key)
    const rx = Math.floor(cx / 32); const rz = Math.floor(cz / 32)
    const regionPath = path.join(regionDir, `r.${rx}.${rz}.mca`)
    let parsed = null
    if (fs.existsSync(regionPath)) {
      const raw = await readRegionChunk(regionPath, cx, cz)
      if (raw) { parsed = (await nbt.parse(raw)).parsed }
    }
    const chunk = parsed ? buildChunk(parsed) : null
    cache.set(key, chunk)
    return chunk
  }
  return {
    getChunk,
    async blockName (x, y, z) {
      const cx = x >> 4; const cz = z >> 4
      const chunk = await getChunk(cx, cz)
      if (!chunk) return null
      const sec = chunk.sections[y >> 4]
      if (!sec) return null
      return sec.get((x & 15), (y & 15), (z & 15))
    },
    async blockId (x, y, z) {
      const cx = x >> 4; const cz = z >> 4
      const chunk = await getChunk(cx, cz)
      if (!chunk) return null
      const sec = chunk.sections[y >> 4]
      if (!sec || sec.ids == null) return null
      return sec.ids[((y & 15) * 16 + (z & 15)) * 16 + (x & 15)]
    },
  }
}

function tagValue (t) {
  if (t == null) return null
  if (typeof t !== 'object') return t
  return 'value' in t ? t.value : t
}
function compound (t) { return tagValue(t) }
function listItems (t) {
  const v = tagValue(t)
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (v && Array.isArray(v.value)) return v.value
  return []
}

function buildChunk (parsed) {
  const root = compound(parsed)
  const sectionsRaw = listItems(root?.sections)
  const sections = []
  for (const s of sectionsRaw) {
    const sv = compound(s)
    const Y = Number(tagValue(sv.Y) ?? 0)
    const bs = compound(sv.block_states)
    if (!bs) { sections[Y] = null; continue }
    const palette = listItems(bs.palette).map((p) => {
      const pv = compound(p)
      const name = pv.Name != null ? String(tagValue(pv.Name)) : null
      return name
    })
    const dataRaw = bs.data != null ? tagValue(bs.data) : null
    sections[Y] = makeSection(palette, dataRaw)
  }
  for (let i = 0; i < sections.length; i++) if (sections[i] === undefined) sections[i] = null
  return { sections }
}

function makeSection (palette, dataRaw) {
  const size = palette.length
  const bits = Math.max(4, Math.ceil(Math.log2(Math.max(1, size))))
  const mask = (1n << BigInt(bits)) - 1n
  const perLong = Math.floor(64 / bits)
  let longs = null
  if (dataRaw != null && size > 1) {
    longs = (dataRaw.value ?? dataRaw).map(longToBigInt)
  }
  const ids = new Uint16Array(4096)
  function get (lx, ly, lz) {
    if (size === 0) return null
    if (size === 1 || longs == null) return palette[0]
    const i = (ly * 16 + lz) * 16 + lx
    const li = Math.floor(i / perLong)
    const shift = BigInt((i % perLong) * bits)
    const v = Number((longs[li] >> shift) & mask)
    return palette[v] ?? `?${v}`
  }
  if (longs != null) { for (let i = 0; i < 4096; i++) ids[i] = 0 }
  return { palette, get, ids, bits, size }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [, , cmd, ...rest] = process.argv
  const world = openWorld()
  if (cmd === 'column') {
    const x = Number(rest[0]); const z = Number(rest[1])
    for (let y = 100; y >= 40; y--) {
      const n = await world.blockName(x, y, z)
      if (n && !/air|water|short_grass|tall_grass|fern|poppy|dandelion|_flower|sapling|vine/.test(n)) {
        if (y < 99) process.stdout.write(`${y}:${n} `)
      }
    }
    console.log()
  } else if (cmd === 'scan') {
    const x = Number(rest[0]); const y = Number(rest[1]); const z = Number(rest[2]); const r = Number(rest[3] ?? 8)
    console.log(`surface heights around (${x},${y},${z}) r=${r} (value = top solid y):`)
    for (let dz = -r; dz <= r; dz++) {
      let row = ''
      for (let dx = -r; dx <= r; dx++) {
        let top = null
        for (let yy = y + 6; yy >= y - 10; yy--) {
          const n = await world.blockName(x + dx, yy, z + dz)
          if (n && !/air|leaves|log|water|short_grass|tall_grass|fern|poppy|dandelion|_flower|sapling|vine/.test(n)) { top = yy; break }
        }
        row += top == null ? ' ?? ' : String(top).padStart(3, ' ')
      }
      console.log(String(dz).padStart(3), row)
    }
  } else {
    console.log('commands: column <x> <z> | scan <x> <y> <z> [radius]')
  }
}
