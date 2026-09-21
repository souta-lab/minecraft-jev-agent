// world-truth-plane: read a live world plane straight from the region files.
//
// WHY THIS EXISTS: a run's *inference* about a structure (did the agent mine it? is the portal lit?)
// is not world truth. A misread log window once produced exactly that error here - a portal reported
// as destroyed while the world held a complete, lit gate - because the agent's own actions and its
// sensor window were the only evidence consulted. This reader answers the question from the save
// file itself: read-only, no bot, no RCON, no operator teleport.
//
// usage: bun tools/world-truth-plane.mjs --region <r.x.z.mca> --chunk-x <n> --chunk-z <n>
//                                      [--y-min <n>] [--y-max <n>] [--z <n>] [--x-min <n>] [--x-max <n>]
//                                      [--highlight block[,block...]]
import { readFileSync } from 'node:fs'
import { gunzipSync, inflateSync } from 'node:zlib'
import { parse } from 'prismarine-nbt'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const num = (name, fallback) => {
  const raw = arg(name)
  return raw === null ? fallback : Number(raw)
}

const region = arg('region')
if (region === null) throw new Error('--region is required')
const chunkX = num('chunk-x', 0)
const chunkZ = num('chunk-z', 0)
const yMin = num('y-min', 0)
const yMax = num('y-max', 255)
const zPlane = num('z', null)
const xMin = num('x-min', chunkX * 16)
const xMax = num('x-max', chunkX * 16 + 15)
const highlight = new Set((arg('highlight', 'nether_portal,obsidian') ?? '').split(',').filter(Boolean))

const buf = readFileSync(region)
const entry = (chunkX & 31) + (chunkZ & 31) * 32
const offset = buf.readUIntBE(entry * 4, 3)
const sectors = buf.readUInt8(entry * 4 + 3)
if (offset === 0 || sectors === 0) {
  console.log(`chunk ${chunkX},${chunkZ} is not present in ${region}`)
  process.exit(0)
}
const start = offset * 4096
const length = buf.readUInt32BE(start)
const compression = buf.readUInt8(start + 4)
const raw = buf.subarray(start + 5, start + 4 + length)
const payload = compression === 1 ? gunzipSync(raw) : compression === 2 ? inflateSync(raw) : raw
const { parsed } = await parse(payload, 'big')
const level = parsed.value.Level?.value ?? parsed.value
const sections = level.sections?.value?.value ?? level.sections?.value ?? []

const found = new Map()
for (const section of sections) {
  const sectionY = section.Y?.value
  if (sectionY === undefined) continue
  const paletteRaw = section.block_states?.value?.palette?.value?.value ?? section.block_states?.value?.palette?.value ?? []
  const names = paletteRaw.map((p) => String(p.Name?.value ?? '?').replace('minecraft:', ''))
  const data = section.block_states?.value?.data?.value ?? null
  const bits = Math.max(4, Math.ceil(Math.log2(Math.max(2, names.length))))
  const perLong = Math.floor(64 / bits)
  const mask = (1n << BigInt(bits)) - 1n
  const at = (x, y, z) => {
    const idx = (y * 16 + z) * 16 + x
    const li = Math.floor(idx / perLong)
    const shift = BigInt((idx % perLong) * bits)
    const word = data?.[li]
    if (word === undefined) return names[0] ?? '?'
    return names[Number((BigInt.asUintN(64, BigInt(word)) >> shift) & mask)] ?? '?'
  }
  for (let localY = 0; localY < 16; localY++) {
    const worldY = sectionY * 16 + localY
    if (worldY < yMin || worldY > yMax) continue
    for (let x = xMin; x <= xMax; x++) {
      for (let z = zPlane === null ? chunkZ * 16 : zPlane; z <= (zPlane === null ? chunkZ * 16 + 15 : zPlane); z++) {
        const name = at(x & 15, localY, z & 15)
        if (name === 'air' || name === 'cave_air' || name === 'void_air') continue
        found.set(`${x},${worldY},${z}`, name)
      }
    }
  }
}

const counts = new Map()
for (const name of found.values()) counts.set(name, (counts.get(name) ?? 0) + 1)
const highlighted = [...found.entries()].filter(([, name]) => highlight.has(name)).sort()
console.log(`chunk ${chunkX},${chunkZ} blocks in x[${xMin}..${xMax}] y[${yMin}..${yMax}]${zPlane === null ? '' : ` z=${zPlane}`}: ${found.size}`)
console.log('counts:', [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join(' '))
for (const name of highlight) {
  const cells = highlighted.filter(([, value]) => value === name).map(([key]) => key)
  console.log(`${name}: ${cells.length}${cells.length > 0 ? ` -> ${cells.slice(0, 24).join(' ')}` : ''}`)
}
