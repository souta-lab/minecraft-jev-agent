#!/usr/bin/env bun
// Read-only acceptance validator for a run-scoped VTR Reach capability archive.
// It never repairs, normalizes in place, or writes to the archive/repository.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { gunzipSync, inflateSync } from 'node:zlib'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseNbt } from 'prismarine-nbt'
import { eventMessage, persistentActionIdentity, persistentSkillStartProof } from './vtr-reach-evidence-events.mjs'

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCOMPLETE: 2, USAGE: 64 })
const CHECK_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCOMPLETE: 'INCOMPLETE' })
const SHA_RE = /^[0-9a-f]{40}$/i
const RUN_ID_RE = /^run-[a-z0-9]+-[a-z0-9]+$/i

const HELP = `Usage: bun tools/validate-vtr-reach-evidence.mjs --archive <directory> [--repo <exact-source-checkout>]

Read-only validation of a run-scoped VTR Reach live-probe archive.
Prints a JSON report and never changes the archive or repository.

Results:
  PASS        every Reach-probe evidence check is bound and complete
  INCOMPLETE  evidence is coherent but one or more required proofs/artifacts are absent
  FAIL        a present artifact contradicts the run or fails an integrity check

Exit codes: 0 PASS, 1 FAIL, 2 INCOMPLETE, 64 invalid arguments.

The Reach probe is distinct from the full P0 migration acceptance. The latter
also requires archived passing no-double-authority fixture results and a
run-scoped legacy-vs-VTR comparison. Expected supplemental paths:
  proofs/no-double-authority.json
  comparison/legacy-baseline.json

Raw no-LLM journals must also be archived, including empty files when no call
occurred:
  runner/jev-calls.jsonl
  runner/jev-decisions.jsonl
  runner/system2.jsonl
The v2 comparator output reports structured alignment only. Its summary-only
output is never full migration acceptance evidence.
`

function parseArgs(argv) {
  const out = { archive: null, repo: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--archive' || arg === '--repo') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`)
      out[arg === '--archive' ? 'archive' : 'repo'] = value
      i += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return out
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function walkFiles(root) {
  const files = []
  const symlinks = []
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        symlinks.push(relative(root, full).split(sep).join('/'))
      } else if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) files.push(relative(root, full).split(sep).join('/'))
    }
  }
  visit(root)
  return { files: files.sort(), symlinks: symlinks.sort() }
}

function readText(root, path) {
  return readFileSync(join(root, path), 'utf8')
}

function readJson(root, path) {
  return JSON.parse(readText(root, path))
}

function parseJsonl(root, path) {
  const rows = []
  const lines = readText(root, path).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    try {
      rows.push(JSON.parse(lines[index]))
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSONL (${error.message})`)
    }
  }
  return rows
}

function dimCanonical(value) {
  if (typeof value !== 'string') return null
  return value.startsWith('minecraft:') ? value.slice('minecraft:'.length) : value
}

function parseWorldKey(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('|')
  if (parts.length !== 3) return null
  const epoch = Number(parts[2])
  if (!parts[0] || !parts[1] || !Number.isInteger(epoch)) return null
  return { serverId: parts[0], rawDimension: parts[1], dimension: dimCanonical(parts[1]), worldEpoch: epoch }
}

function nbtValue(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'value')) return value.value
  return value
}

function nbtLongToBigInt(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (Array.isArray(value) && value.length === 2) {
    const hi = BigInt(value[0])
    const lo = BigInt(value[1]) & 0xffffffffn
    return (hi << 32n) | lo
  }
  return null
}

function nbtIntArrayToUuid(value) {
  if (!Array.isArray(value) || value.length !== 4) return null
  const hex = value.map((part) => (Number(part) >>> 0).toString(16).padStart(8, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function readProperties(text) {
  const props = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const index = line.search(/[:=]/)
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replaceAll('\\:', ':')
    props[key] = value
  }
  return props
}

function eventTimestamp(row) {
  const value = Date.parse(row?.ts)
  return Number.isFinite(value) ? value : null
}

function logTimestamp(line) {
  const match = /^\[([^\]]+)\]/.exec(line)
  if (!match) return null
  const value = Date.parse(match[1])
  return Number.isFinite(value) ? value : null
}

function token(line, name) {
  return new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line)?.[1] ?? null
}

function hostEventToken(line) {
  return /^\[[^\]]+\]\s+([A-Z][A-Z0-9_]*)\b/.exec(line)?.[1] ?? null
}

function firstMessageToken(message) {
  return typeof message === 'string' ? message.trim().split(/\s+/, 1)[0] ?? '' : ''
}

function transitionRowId(row) {
  return row?.detail?.transitionId ?? token(` ${String(row?.message ?? '')}`, 'transitionId') ?? token(` ${String(row?.message ?? '')}`, 'id') ?? null
}

function transitionRowContractHash(row) {
  return row?.detail?.contractHash ?? row?.detail?.outcome?.contractHash ?? token(` ${String(row?.message ?? '')}`, 'contractHash') ?? null
}

function transitionRowStepId(row, allowSingleStepFallback = false) {
  const detail = row?.detail ?? {}
  const direct = detail.stepId
  if (typeof direct === 'string' && direct.length > 0) return direct
  const intent = detail.intentId
  if (typeof intent === 'string' && intent.length > 0) return `intent:${intent}`
  const action = detail.actionId
  if (typeof action === 'string' && action.length > 0) return `action:${action}`
  if (!allowSingleStepFallback) return null
  const fallback = detail.candidate ?? token(` ${String(row?.message ?? '')}`, 'action') ?? token(` ${String(row?.message ?? '')}`, 'candidate')
  return typeof fallback === 'string' && fallback.length > 0 ? `action:${fallback}` : null
}

function assertUsageWithinBudget({ budget, usage }) {
  const problems = []
  const missing = []
  if (!budget || typeof budget !== 'object' || !usage || typeof usage !== 'object') {
    return { problems: [], missing: ['budget or usage object'] }
  }
  for (const [field, limitField] of [['mechanicalSteps', 'maxMechanicalSteps'], ['elapsedMs', 'maxElapsedMs']]) {
    if (!Number.isFinite(Number(usage[field])) || !Number.isFinite(Number(budget[limitField]))) {
      missing.push(`usage.${field}/budget.${limitField}`)
    } else if (Number(usage[field]) > Number(budget[limitField])) {
      problems.push({ field, used: Number(usage[field]), limit: Number(budget[limitField]) })
    }
  }
  for (const field of ['resources', 'risk', 'effects']) {
    if (!usage[field] || typeof usage[field] !== 'object' || Array.isArray(usage[field])) {
      missing.push(`usage.${field}`)
      continue
    }
  }
  for (const field of ['resources', 'risk']) {
    if (!budget[field] || typeof budget[field] !== 'object' || Array.isArray(budget[field])) {
      missing.push(`budget.${field}`)
      continue
    }
    for (const [name, amount] of Object.entries(usage[field] ?? {})) {
      const limit = budget[field][name]
      if (!Number.isFinite(Number(amount))) missing.push(`usage.${field}.${name}`)
      else if (!Number.isFinite(Number(limit))) problems.push({ field: `${field}.${name}`, used: Number(amount), limit: limit ?? null, reason: 'used value has no finite declared limit' })
      else if (Number(amount) > Number(limit)) problems.push({ field: `${field}.${name}`, used: Number(amount), limit: Number(limit) })
    }
  }
  const effects = Array.isArray(budget.admissibleEffects) ? budget.admissibleEffects : null
  if (!effects) missing.push('budget.admissibleEffects')
  else {
    const effectLimits = new Map(effects.map((entry) => [entry?.kind, entry?.maxUses]))
    for (const [name, amount] of Object.entries(usage.effects ?? {})) {
      const limit = effectLimits.get(name)
      if (!Number.isFinite(Number(amount))) missing.push(`usage.effects.${name}`)
      else if (!effectLimits.has(name)) problems.push({ field: `effects.${name}`, used: Number(amount), reason: 'effect is not admissible' })
      else if (limit !== null && (!Number.isFinite(Number(limit)) || Number(amount) > Number(limit))) {
        problems.push({ field: `effects.${name}`, used: Number(amount), limit: limit ?? null })
      }
    }
  }
  return { problems, missing }
}

function closeNumber(a, b, tolerance = 0.02) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance
}

async function parseLevelDat(path) {
  const compressed = readFileSync(path)
  const { parsed } = await parseNbt(gunzipSync(compressed), 'big')
  const data = parsed?.value?.Data?.value ?? parsed?.value?.Data ?? null
  if (!data) throw new Error('level.dat has no Data compound')
  const settings = nbtValue(data.WorldGenSettings)
  const seed = nbtLongToBigInt(nbtValue(settings?.seed)) ?? nbtLongToBigInt(nbtValue(data.RandomSeed))
  const rules = nbtValue(data.game_rules) ?? {}
  const readRule = (key) => nbtValue(rules[`minecraft:${key}`])
  return {
    levelName: nbtValue(data.LevelName) ?? null,
    dataVersion: nbtValue(data.DataVersion) ?? null,
    seed: seed === null ? null : seed.toString(),
    difficulty: nbtValue(data.Difficulty) ?? null,
    gameType: nbtValue(data.GameType) ?? null,
    hardcore: nbtValue(data.hardcore) ?? null,
    gameRules: {
      keepInventory: readRule('keep_inventory') ?? null,
      spawnMobs: readRule('spawn_mobs') ?? null,
      advanceTime: readRule('advance_time') ?? null,
    },
  }
}

async function parsePlayerDat(path) {
  const { parsed } = await parseNbt(gunzipSync(readFileSync(path)), 'big')
  const value = parsed?.value
  if (!value || typeof value !== 'object') throw new Error('playerdata has no compound root')
  const pos = nbtValue(nbtValue(value.Pos))
  const rawInventory = nbtValue(value.Inventory)
  const stacks = Array.isArray(rawInventory) ? rawInventory : rawInventory?.value
  const inventory = {}
  let inventoryDecodable = Array.isArray(stacks)
  if (Array.isArray(stacks)) {
    for (const rawStack of stacks) {
      const stack = rawStack?.value ?? rawStack
      const rawId = nbtValue(stack?.id)
      const rawCount = nbtValue(stack?.count ?? stack?.Count)
      if (typeof rawId !== 'string' || !Number.isFinite(Number(rawCount))) {
        inventoryDecodable = false
        continue
      }
      const id = rawId.startsWith('minecraft:') ? rawId.slice('minecraft:'.length) : rawId
      inventory[id] = (inventory[id] ?? 0) + Number(rawCount)
    }
  }
  return {
    uuid: typeof nbtValue(value.UUID) === 'string' ? nbtValue(value.UUID) : nbtIntArrayToUuid(nbtValue(value.UUID)),
    dimension: nbtValue(value.Dimension) ?? null,
    position: Array.isArray(pos) ? pos.map(Number) : null,
    health: nbtValue(value.Health) ?? null,
    air: nbtValue(value.Air) ?? null,
    inventory,
    inventoryDecodable,
  }
}

function normalizedBlockName(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim().toLowerCase().replace(/^minecraft:/u, '')
}

/** Resolve the MCA region that contains an integer world block coordinate. */
export function witnessRegionRelativePath(target) {
  if (!target || !Number.isSafeInteger(target.x) || !Number.isSafeInteger(target.y) || !Number.isSafeInteger(target.z)) return null
  const chunkX = Math.floor(target.x / 16)
  const chunkZ = Math.floor(target.z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  return `server/world/r.${regionX}.${regionZ}.mca`
}

async function readBlockName(regionPath, x, y, z) {
  const chunkX = Math.floor(x / 16)
  const chunkZ = Math.floor(z / 16)
  const regionX = Math.floor(chunkX / 32)
  const regionZ = Math.floor(chunkZ / 32)
  const expectedRegionName = `r.${regionX}.${regionZ}.mca`
  if (basename(regionPath) !== expectedRegionName) {
    throw new Error(`region file ${basename(regionPath)} does not contain x/z ${x},${z}; expected ${expectedRegionName}`)
  }
  const bytes = readFileSync(regionPath)
  const chunkIndex = (chunkX & 31) + (chunkZ & 31) * 32
  const location = bytes.readUIntBE(chunkIndex * 4, 3)
  const sectors = bytes.readUInt8(chunkIndex * 4 + 3)
  if (location === 0 || sectors === 0) return null
  const start = location * 4096
  const length = bytes.readUInt32BE(start)
  const compression = bytes.readUInt8(start + 4)
  const payload = bytes.subarray(start + 5, start + 4 + length)
  const raw = compression === 1 ? gunzipSync(payload) : compression === 2 ? inflateSync(payload) : compression === 3 ? payload : null
  if (raw === null) throw new Error(`unsupported MCA chunk compression id ${compression}`)
  const { parsed } = await parseNbt(raw, 'big')
  const level = parsed?.value?.Level?.value ?? parsed?.value
  const sections = level?.sections?.value?.value ?? level?.sections?.value ?? []
  const sectionY = Math.floor(y / 16)
  const section = sections.find((candidate) => Number(nbtValue(candidate?.Y)) === sectionY)
  if (!section) return null
  const blockStates = nbtValue(section.block_states)
  const paletteContainer = nbtValue(blockStates?.palette)
  const palette = paletteContainer?.value ?? paletteContainer
  if (!Array.isArray(palette) || palette.length === 0) return null
  const names = palette.map((entry) => {
    const name = nbtValue(entry?.Name)
    return typeof name === 'string' ? name.replace(/^minecraft:/, '') : '?'
  })
  if (names.length === 1) return names[0]
  const packed = nbtValue(blockStates?.data)
  if (!Array.isArray(packed) && !ArrayBuffer.isView(packed)) return null
  const bits = Math.max(4, Math.ceil(Math.log2(Math.max(2, names.length))))
  const perLong = Math.floor(64 / bits)
  const localX = ((x % 16) + 16) % 16
  const localY = ((y % 16) + 16) % 16
  const localZ = ((z % 16) + 16) % 16
  const index = (localY * 16 + localZ) * 16 + localX
  const longIndex = Math.floor(index / perLong)
  const shift = BigInt((index % perLong) * bits)
  if (packed[longIndex] === undefined) return null
  const word = BigInt.asUintN(64, BigInt(packed[longIndex]))
  const mask = (1n << BigInt(bits)) - 1n
  return names[Number((word >> shift) & mask)] ?? null
}

/** Independently read the committed witness and its support from its MCA region. */
export async function inspectWitnessPlane(archive, archivedFiles, target) {
  const relativePath = witnessRegionRelativePath(target)
  if (relativePath === null) return { status: 'INCOMPLETE', relativePath: null, reason: 'committed witness does not contain integer block coordinates' }
  if (!archivedFiles.includes(relativePath)) return { status: 'INCOMPLETE', relativePath, reason: 'coordinate-derived region file is absent' }
  try {
    const path = join(archive, relativePath)
    return {
      status: 'READ',
      relativePath,
      witnessBlock: await readBlockName(path, target.x, target.y, target.z),
      supportBlock: await readBlockName(path, target.x, target.y - 1, target.z),
    }
  } catch (error) {
    return { status: 'INCOMPLETE', relativePath, reason: `cannot inspect MCA witness/support facts: ${error.message}` }
  }
}

function blockFromSetblockCommand(command) {
  if (typeof command !== 'string') return null
  const match = /(?:^|\s)setblock\s+\S+\s+\S+\s+\S+\s+([a-z0-9_.:-]+)/iu.exec(command)
  return match ? normalizedBlockName(match[1]) : null
}

/** Correlate a successful post-join fixture setblock with this Mission's committed Reach sources. */
export function inspectFixtureWitnessSetup({ fixtureCommands, missionItem, desiredPredicate, witness }) {
  const missionBlock = normalizedBlockName(missionItem)
  const predicateItem = normalizedBlockName(desiredPredicate?.proposition?.item)
  const rawSources = desiredPredicate?.proposition?.sourceNames
  const sourceNames = Array.isArray(rawSources) ? [...new Set(rawSources.map(normalizedBlockName).filter(Boolean))] : []
  const committedSources = sourceNames.length > 0 ? sourceNames : [predicateItem].filter(Boolean)
  const matchingMission = missionBlock !== null && predicateItem !== null && missionBlock === predicateItem
  const setupAfterJoin = fixtureCommands.filter((row) => /execute\s+at\s+AI_Buddy\s+run\s+setblock\b/iu.test(String(row?.command ?? '')))
  const changed = setupAfterJoin.filter((row) => /Changed block at/i.test(String(row?.result ?? '')))
  const observedBlocks = changed.map((row) => ({ block: blockFromSetblockCommand(row.command), command: row.command, result: row.result }))
  const witnessCoordinatesValid = witness && Number.isSafeInteger(witness.x) && Number.isSafeInteger(witness.y) && Number.isSafeInteger(witness.z)
  if (missionBlock === null || predicateItem === null || committedSources.length === 0) {
    return { status: 'INCOMPLETE', reason: 'Mission item or committed Reach source names are absent', missionBlock, predicateItem, committedSources, observedBlocks }
  }
  if (!matchingMission) {
    return { status: 'FAIL', reason: 'Mission item and committed Reach predicate item disagree', missionBlock, predicateItem, committedSources, observedBlocks }
  }
  if (!witnessCoordinatesValid) {
    return { status: 'INCOMPLETE', reason: 'committed witness has no integer block coordinates', missionBlock, predicateItem, committedSources, observedBlocks }
  }
  if (changed.length === 0) {
    return { status: 'INCOMPLETE', reason: 'no successful post-join setblock source is recorded', missionBlock, predicateItem, committedSources, observedBlocks }
  }
  const matched = observedBlocks.find((entry) => entry.block !== null && committedSources.includes(entry.block))
  if (!matched) {
    return { status: 'INCOMPLETE', reason: 'successful post-join setblock source does not match a committed Reach source name', missionBlock, predicateItem, committedSources, observedBlocks }
  }
  return { status: 'PASS', missionBlock, predicateItem, committedSources, observedBlock: matched.block, command: matched.command, result: matched.result, witness }
}

function inventoriesEqual(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const all = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...all].every((key) => Number(left[key] ?? 0) === Number(right[key] ?? 0))
}

function parseManifest(text) {
  const entries = new Map()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (!match) throw new Error(`SHA256SUMS:${index + 1}: expected '<sha256>  <relative-path>'`)
    const path = match[2].replaceAll('\\', '/').replace(/^\.\//, '')
    if (entries.has(path)) throw new Error(`SHA256SUMS:${index + 1}: duplicate path entry ${path}`)
    entries.set(path, match[1].toLowerCase())
  }
  return entries
}

function gitOutput(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitCommitExists(repo, commit) {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function validate(archive, repo) {
  const checks = []
  const add = (id, status, detail = {}) => checks.push({ id, status, ...detail })
  const incomplete = (id, reason, detail = {}) => add(id, CHECK_STATUS.INCOMPLETE, { reason, ...detail })
  const fail = (id, reason, detail = {}) => add(id, CHECK_STATUS.FAIL, { reason, ...detail })
  const pass = (id, detail = {}) => add(id, CHECK_STATUS.PASS, detail)
  const required = [
    'probe.json',
    'runner/acceptance.json',
    'runner/buddy.log',
    'runner/generation-bundle.mjs',
    'runner/initial-snapshot.json',
    'runner/jev-run.jsonl',
    'runner/jev-calls.jsonl',
    'runner/jev-decisions.jsonl',
    'runner/system2.jsonl',
    'runner/milestone-predicates.json',
    'server/fixture-commands.jsonl',
    'server/leaf-latest.log',
    'server/server-start.json',
    'server/world/level.dat',
    'server/world/playerdata.dat',
  ]
  const present = new Set()
  for (const path of required) {
    if (existsSync(join(archive, path))) present.add(path)
    else incomplete(`required:${path}`, 'required artifact is absent')
  }

  let listing
  try {
    listing = walkFiles(archive)
    if (listing.symlinks.length > 0) fail('archive-symlinks', 'archive contains symlinks', { paths: listing.symlinks })
    else pass('archive-symlinks', { count: 0 })
  } catch (error) {
    fail('archive-walk', error.message)
    listing = { files: [], symlinks: [] }
  }

  let validJsonCount = 0
  for (const path of listing.files.filter((name) => name.endsWith('.json'))) {
    try { readJson(archive, path); validJsonCount += 1 } catch (error) { fail(`json:${path}`, error.message) }
  }
  let validJsonlCount = 0
  for (const path of listing.files.filter((name) => name.endsWith('.jsonl'))) {
    try { parseJsonl(archive, path); validJsonlCount += 1 } catch (error) { fail(`jsonl:${path}`, error.message) }
  }
  if (validJsonCount > 0) pass('archive:json-valid', { files: validJsonCount })
  if (validJsonlCount > 0) pass('archive:jsonl-valid', { files: validJsonlCount })

  if (!listing.files.includes('SHA256SUMS')) {
    incomplete('sha256-manifest', 'SHA256SUMS is absent')
  } else {
    try {
      const manifest = parseManifest(readText(archive, 'SHA256SUMS'))
      const actual = new Set(listing.files.filter((path) => path !== 'SHA256SUMS'))
      for (const path of actual) {
        if (!manifest.has(path)) fail(`sha256:${path}`, 'file is not covered by SHA256SUMS')
        else {
          const digest = sha256(readFileSync(join(archive, path)))
          if (digest !== manifest.get(path)) fail(`sha256:${path}`, 'SHA256 mismatch', { expected: manifest.get(path), observed: digest })
          else pass(`sha256:${path}`, { sha256: digest })
        }
      }
      for (const path of manifest.keys()) if (!actual.has(path)) fail(`sha256:${path}`, 'manifest entry has no archived file')
      pass('sha256-manifest-coverage', { files: actual.size })
    } catch (error) {
      fail('sha256-manifest', error.message)
    }
  }

  const docs = {}
  for (const path of ['probe.json', 'runner/acceptance.json', 'runner/initial-snapshot.json', 'runner/milestone-predicates.json', 'server/server-start.json']) {
    if (!present.has(path)) continue
    try { docs[path] = readJson(archive, path) } catch { /* parse error is already reported above */ }
  }
  let events = []
  let fixtureCommands = []
  try { if (present.has('runner/jev-run.jsonl')) events = parseJsonl(archive, 'runner/jev-run.jsonl') } catch { /* reported above */ }
  try { if (present.has('server/fixture-commands.jsonl')) fixtureCommands = parseJsonl(archive, 'server/fixture-commands.jsonl') } catch { /* reported above */ }
  const probe = docs['probe.json']
  const acceptance = docs['runner/acceptance.json']
  const snapshot = docs['runner/initial-snapshot.json']
  const predicates = docs['runner/milestone-predicates.json']
  const serverStart = docs['server/server-start.json']

  if (!probe) {
    incomplete('probe-manifest', 'probe.json is unavailable; remaining semantic checks are skipped')
  } else {
    const source = probe.source ?? {}
    const run = probe.run ?? {}
    const transition = probe.transition ?? {}
    const runId = run.runId
    const generationId = run.generationId
    const sourceSha = source.commit

    if (source.repository === 'souta-lab/minecraft-jev-agent' && SHA_RE.test(sourceSha ?? '')) pass('probe-source-identity', { sourceSha, branch: source.branch })
    else fail('probe-source-identity', 'repository or exact source SHA is invalid', { repository: source.repository ?? null, sourceSha: sourceSha ?? null })
    if (typeof source.buildHash === 'string' && /^[0-9a-f]{12}$/i.test(source.buildHash) && Number.isInteger(source.bundleBytes)) pass('probe-build-identity', { buildHash: source.buildHash, bundleBytes: source.bundleBytes })
    else fail('probe-build-identity', 'build hash or bundle byte count is invalid')
    if (typeof runId === 'string' && RUN_ID_RE.test(runId)) pass('probe-run-id', { runId })
    else fail('probe-run-id', 'runId has invalid form', { runId: runId ?? null })
    if (typeof generationId === 'string' && generationId.length > 0) pass('probe-generation-id', { generationId })
    else fail('probe-generation-id', 'generationId is missing')

    const checkBound = (id, label, observed, expected, { nullable = false } = {}) => {
      if (observed === null || observed === undefined) {
        if (nullable) incomplete(id, `${label} is null in this raw record; another run-scoped artifact must bind it`, { expected })
        else fail(id, `${label} is missing`, { expected })
      } else if (observed !== expected) fail(id, `${label} mismatch`, { expected, observed })
      else pass(id, { value: observed })
    }

    if (acceptance) {
      checkBound('source:acceptance-commit', 'acceptance.gitCommit', acceptance.gitCommit, sourceSha)
      checkBound('source:acceptance-head', 'acceptance.checkoutHead', acceptance.checkoutHead, sourceSha)
      checkBound('run:acceptance-run', 'acceptance.runId', acceptance.runId, runId)
      checkBound('run:acceptance-generation', 'acceptance.generationId', acceptance.generationId, generationId, { nullable: true })
      checkBound('world:acceptance-epoch', 'acceptance.worldEpoch', acceptance.worldEpoch, run.worldEpoch)
      checkBound('world:acceptance-level', 'acceptance.levelName', acceptance.levelName, run.levelName, { nullable: true })
      checkBound('world:acceptance-seed', 'acceptance.seed', acceptance.seed, run.seed, { nullable: true })
    }
    if (snapshot) {
      checkBound('run:snapshot-run', 'snapshot.runId', snapshot.runId, runId)
      checkBound('run:snapshot-generation', 'snapshot.generationId', snapshot.generationId, generationId)
      checkBound('source:snapshot-sha', 'snapshot.bootSourceSha', snapshot.bootSourceSha, sourceSha)
      checkBound('source:snapshot-build', 'snapshot.buildHash', snapshot.buildHash, source.buildHash)
      checkBound('world:snapshot-epoch', 'snapshot.worldEpoch', snapshot.worldEpoch, run.worldEpoch)
    }
    if (predicates) {
      checkBound('run:predicates-run', 'milestone.runId', predicates.runId, runId)
      checkBound('run:predicates-generation', 'milestone.generationId', predicates.generationId, generationId)
      checkBound('source:predicates-sha', 'milestone.sourceSha', predicates.sourceSha, sourceSha)
    }

    let bundlePath = probe.artifacts?.generationBundle ?? 'runner/generation-bundle.mjs'
    if (!listing.files.includes(bundlePath)) incomplete('build:bundle-present', 'generation bundle artifact is absent', { path: bundlePath })
    else {
      const bundle = readFileSync(join(archive, bundlePath))
      const bundleSha = sha256(bundle)
      if (bundle.length !== source.bundleBytes) fail('build:bundle-bytes', 'bundle byte length differs from probe manifest', { expected: source.bundleBytes, observed: bundle.length })
      else pass('build:bundle-bytes', { bytes: bundle.length })
      if (!bundleSha.startsWith(String(source.buildHash ?? '').toLowerCase())) fail('build:bundle-sha', 'bundle SHA prefix does not match buildHash', { expectedPrefix: source.buildHash, observedSha256: bundleSha })
      else pass('build:bundle-sha', { sha256: bundleSha })
    }

    if (repo) {
      try {
        const head = gitOutput(repo, ['rev-parse', 'HEAD'])
        if (head !== sourceSha) fail('source:repo-head', 'source checkout HEAD does not match exact run SHA', { expected: sourceSha, observed: head })
        else pass('source:repo-head', { commit: head })
        const hasCommit = gitCommitExists(repo, sourceSha)
        if (!hasCommit) fail('source:commit-object', 'source commit object is absent')
        else pass('source:commit-object', { commit: sourceSha })
        const status = gitOutput(repo, ['status', '--porcelain', '--untracked-files=all'])
        if (status.length > 0) fail('source:repo-clean', 'exact-source checkout has non-ignored changes', { status: status.split('\n') })
        else pass('source:repo-clean')
        const branch = gitOutput(repo, ['branch', '--show-current'])
        if (source.branch && branch && branch !== source.branch) fail('source:repo-branch', 'checkout branch differs from recorded run branch', { expected: source.branch, observed: branch })
        else if (!branch) incomplete('source:repo-branch', 'checkout is detached; commit identity is still checked')
        else pass('source:repo-branch', { branch })
      } catch (error) {
        fail('source:repo-access', `cannot verify source checkout: ${error.message}`)
      }
    } else {
      incomplete('source:repo-checkout', 'pass --repo to prove the exact source commit and clean checkout')
    }

    const timeFields = ['startedAt', 'generationReadyAt', 'shutdownAt']
    const times = Object.fromEntries(timeFields.map((field) => [field, Date.parse(run[field])]))
    if (timeFields.every((field) => Number.isFinite(times[field])) && times.startedAt <= times.generationReadyAt && times.generationReadyAt < times.shutdownAt) {
      pass('run:timestamps', { startedAt: run.startedAt, generationReadyAt: run.generationReadyAt, shutdownAt: run.shutdownAt })
    } else fail('run:timestamps', 'probe timestamps are invalid or out of order', { values: run })

    const contractIdentity = transition.worldIdentity ?? transition.identity
    const probeKey = parseWorldKey(run.worldKey)
    const contractKey = parseWorldKey(contractIdentity?.worldKey)
    if (!probeKey || !contractKey) fail('world:world-keys', 'run or contract worldKey is malformed', { runWorldKey: run.worldKey ?? null, contractWorldKey: contractIdentity?.worldKey ?? null })
    else if (probeKey.serverId !== contractKey.serverId || probeKey.worldEpoch !== contractKey.worldEpoch || probeKey.dimension !== contractKey.dimension) {
      fail('world:world-keys', 'run and contract world identities disagree after minecraft: namespace normalization', { run: probeKey, contract: contractKey })
    } else {
      pass('world:world-keys', { serverId: probeKey.serverId, canonicalDimension: probeKey.dimension, runDimensionSpelling: probeKey.rawDimension, contractDimensionSpelling: contractKey.rawDimension, worldEpoch: probeKey.worldEpoch })
      if (probeKey.rawDimension !== contractKey.rawDimension && !probe.worldIdentityNormalization) incomplete('world:normalization-documentation', 'world identity matches only after minecraft: namespace normalization; archive does not record this rule')
    }
    checkBound('world:run-epoch', 'contract worldEpoch', contractIdentity?.worldEpoch, run.worldEpoch)
    checkBound('world:contract-dimension', 'contract dimension', dimCanonical(contractIdentity?.dimension), dimCanonical(run.dimension))
    checkBound('world:contract-generation', 'contract generationId', contractIdentity?.generationId, generationId)
    checkBound('world:contract-lease', 'contract leaseId', contractIdentity?.leaseId, generationId)

    if (serverStart) {
      checkBound('server:level-name', 'server-start.levelName', serverStart.levelName, run.levelName)
      checkBound('server:minecraft-version', 'server-start.minecraftVersion', serverStart.minecraftVersion, run.minecraftVersion)
      checkBound('server:data-version', 'server-start.dataVersion', serverStart.dataVersion, run.dataVersion)
      checkBound('server:difficulty', 'server-start.difficulty', serverStart.difficulty, run.difficulty)
      checkBound('server:world-epoch', 'server-start.worldEpoch', serverStart.worldEpoch, run.worldEpoch)
      if (serverStart.freshWorld === true && /No existing world data, creating new world/i.test(serverStart.bootLog ?? '')) pass('server:fresh-world-attestation', { bootLog: serverStart.bootLog })
      else incomplete('server:fresh-world-attestation', 'server-start does not attest both freshWorld and the exact no-prior-world boot message')

      const launchCandidates = ['server/server.properties.launch', 'server/server.properties.clean']
      const launchPath = launchCandidates.find((path) => listing.files.includes(path) && sha256(readFileSync(join(archive, path))) === serverStart.serverPropertiesSha256)
      if (launchPath) pass('server:launch-config-sha', { path: launchPath, sha256: serverStart.serverPropertiesSha256 })
      else incomplete('server:launch-config-sha', 'recorded launch config hash is not present in an archived launch-config file', { expectedSha256: serverStart.serverPropertiesSha256, candidates: launchCandidates.filter((path) => listing.files.includes(path)).map((path) => ({ path, sha256: sha256(readFileSync(join(archive, path))) })) })
      if (typeof serverStart.serverPropertiesEffectiveSha256 === 'string') {
        const effectiveCandidates = ['server/server.properties.effective-after-boot', 'server/server.properties.clean']
        const effectivePath = effectiveCandidates.find((path) => listing.files.includes(path) && sha256(readFileSync(join(archive, path))) === serverStart.serverPropertiesEffectiveSha256)
        if (effectivePath) pass('server:effective-config-sha', { path: effectivePath, sha256: serverStart.serverPropertiesEffectiveSha256 })
        else fail('server:effective-config-sha', 'effective server config hash does not match an archived file')
      } else incomplete('server:effective-config-sha', 'post-boot effective config hash is not recorded separately')

      if (serverStart.serverJarSha256 && serverStart.serverJar) {
        if (existsSync(serverStart.serverJar)) {
          const jarSha = sha256(readFileSync(serverStart.serverJar))
          if (jarSha !== serverStart.serverJarSha256) fail('server:jar-sha', 'server JAR hash mismatch', { expected: serverStart.serverJarSha256, observed: jarSha })
          else pass('server:jar-sha', { sha256: jarSha })
        } else incomplete('server:jar-presence', 'server JAR is outside the archive and is not present at its recorded path', { path: serverStart.serverJar, recordedSha256: serverStart.serverJarSha256 })
      } else incomplete('server:jar-sha', 'server JAR path/hash is not recorded')
    }

    let launchProperties = null
    for (const path of ['server/server.properties.launch', 'server/server.properties.clean']) {
      if (!listing.files.includes(path)) continue
      try {
        const props = readProperties(readText(archive, path))
        if (!launchProperties || path.endsWith('.launch')) launchProperties = { path, props }
      } catch (error) { fail('server:properties-parse', error.message) }
    }
    if (launchProperties) {
      const p = launchProperties.props
      const expectedProps = { 'server-ip': '127.0.0.1', 'server-port': String(run.serverId?.split(':').at(-1) ?? ''), 'level-name': run.levelName, gamemode: 'survival', difficulty: run.difficulty, 'level-seed': '' }
      const mismatches = Object.entries(expectedProps).filter(([key, expected]) => p[key] !== expected).map(([key, expected]) => ({ key, expected, observed: p[key] ?? null }))
      if (mismatches.length) fail('server:launch-config-values', 'launch properties conflict with the run manifest', { path: launchProperties.path, mismatches })
      else pass('server:launch-config-values', { path: launchProperties.path, bind: `${p['server-ip']}:${p['server-port']}`, levelName: p['level-name'], gameMode: p.gamemode, difficulty: p.difficulty, seedConfigured: p['level-seed'] })
    } else incomplete('server:launch-config-values', 'no parseable server properties file is archived')

    const leafPath = 'server/leaf-latest.log'
    if (present.has(leafPath)) {
      const leaf = readText(archive, leafPath)
      const checks = [
        ['version', new RegExp(`Starting minecraft server version ${String(run.minecraftVersion).replaceAll('.', '\\.')}`)],
        ['fresh', /No existing world data, creating new world/i],
        ['level', new RegExp(`Preparing level ["']${String(run.levelName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`)],
        ['username', new RegExp(`UUID of player ${String(run.botUsername).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is ${String(run.botUuid).replaceAll('-', '\\-')}`)],
      ]
      const absent = checks.filter(([, regex]) => !regex.test(leaf)).map(([name]) => name)
      if (absent.length) incomplete('server:leaf-log-binding', 'server log is missing one or more binding lines', { absent })
      else pass('server:leaf-log-binding', { version: run.minecraftVersion, levelName: run.levelName, botUsername: run.botUsername, botUuid: run.botUuid })
    }

    if (present.has('server/world/level.dat')) {
      try {
        const level = await parseLevelDat(join(archive, 'server/world/level.dat'))
        const mismatch = []
        if (level.levelName !== run.levelName) mismatch.push({ field: 'levelName', expected: run.levelName, observed: level.levelName })
        if (level.dataVersion !== run.dataVersion) mismatch.push({ field: 'dataVersion', expected: run.dataVersion, observed: level.dataVersion })
        if (level.seed !== String(run.seed)) mismatch.push({ field: 'seed', expected: String(run.seed), observed: level.seed })
        if (level.difficulty !== 0) mismatch.push({ field: 'difficultyCode', expected: 0, observed: level.difficulty })
        if (level.gameType !== 0) mismatch.push({ field: 'gameType', expected: 0, observed: level.gameType })
        if (level.hardcore !== 0) mismatch.push({ field: 'hardcore', expected: 0, observed: level.hardcore })
        if (mismatch.length) fail('world:level-dat', 'level.dat contradicts the probe manifest', { parsed: level, mismatch })
        else pass('world:level-dat', level)
      } catch (error) { incomplete('world:level-dat', `cannot parse level.dat: ${error.message}`) }
    }

    if (present.has('server/world/playerdata.dat')) {
      try {
        const player = await parsePlayerDat(join(archive, 'server/world/playerdata.dat'))
        const expectedPos = run.finalPosition ?? probe.mission?.finalPosition
        const posMatches = Array.isArray(player.position) && expectedPos && closeNumber(player.position[0], expectedPos.x) && closeNumber(player.position[1], expectedPos.y) && closeNumber(player.position[2], expectedPos.z)
        const dimMatches = dimCanonical(player.dimension) === dimCanonical(run.dimension)
        const issues = []
        if (player.uuid !== run.botUuid) issues.push({ field: 'uuid', expected: run.botUuid, observed: player.uuid })
        if (!dimMatches) issues.push({ field: 'dimension', expected: run.dimension, observed: player.dimension })
        if (!posMatches) issues.push({ field: 'position', expected: expectedPos, observed: player.position })
        if (player.health !== 20) issues.push({ field: 'health', expected: 20, observed: player.health })
        if (!player.inventoryDecodable) issues.push({ field: 'inventory', reason: 'one or more item stacks could not be decoded' })
        if (!player.inventoryDecodable) incomplete('world:playerdata-inventory', 'player inventory encoding is not fully decoded')
        if (issues.some((issue) => issue.field !== 'inventory')) fail('world:playerdata', 'playerdata contradicts run-bound identity or state', { issues, inventory: player.inventory })
        else pass('world:playerdata', { uuid: player.uuid, dimension: player.dimension, position: player.position, health: player.health, air: player.air, inventory: player.inventory })
        if (player.inventoryDecodable && !inventoriesEqual(player.inventory, probe.mission?.finalInventory ?? {})) fail('world:final-inventory', 'playerdata inventory differs from probe final inventory', { expected: probe.mission?.finalInventory ?? {}, observed: player.inventory })
        else if (player.inventoryDecodable) pass('world:final-inventory', { inventory: player.inventory })
        if (typeof run.botUsername === 'string' && typeof player.uuid === 'string') pass('world:bot-uuid', { botUsername: run.botUsername, botUuid: player.uuid })
      } catch (error) { incomplete('world:playerdata', `cannot parse playerdata: ${error.message}`) }
    }

    const initialInventory = probe.mission?.initialInventory
    if (initialInventory && snapshot && inventoriesEqual(initialInventory, snapshot.initialInventory ?? {})) pass('world:initial-inventory', { inventory: initialInventory })
    else if (initialInventory && snapshot) fail('world:initial-inventory', 'mission and initial snapshot inventories differ', { mission: initialInventory, snapshot: snapshot.initialInventory ?? {} })

    const botLog = present.has('runner/buddy.log') ? readText(archive, 'runner/buddy.log') : ''
    const rawHostLines = botLog.split(/\r?\n/)
    const probeConfiguredLines = rawHostLines.filter((line) => hostEventToken(line) === 'VTR_REACH_PROBE_CONFIGURED')
    const probeQueueEmptyLines = rawHostLines.filter((line) => hostEventToken(line) === 'VTR_REACH_PROBE_QUEUE_EMPTY')
    const vtrAuthorityReadyLines = rawHostLines.filter((line) => hostEventToken(line) === 'GENERATION_READY' && line.includes('productionPlanAuthority=vtr-reach-probe'))
    if (botLog) {
      const boot = botLog.split(/\r?\n/).find((line) => line.includes(' BOOT ') && line.includes(`runId=${runId}`))
      if (!boot) fail('run:boot-line', 'resident log has no BOOT line for the probe runId')
      else {
        if (!boot.includes(`source=${sourceSha}`)) fail('run:boot-source', 'resident BOOT source SHA differs from manifest')
        else pass('run:boot-source', { sourceSha })
        if (!boot.includes(`connection={"host":"127.0.0.1","port":${Number(run.serverId?.split(':').at(-1))},"serverId":"${run.serverId}"}`)) incomplete('run:boot-server', 'resident BOOT connection does not exactly match parsed server identity')
        else pass('run:boot-server', { serverId: run.serverId })
      }
    }

    const commits = eventMessage(events, 'VTR_TRANSITION_COMMIT')
    const outcomes = eventMessage(events, 'VTR_TRANSITION_OUTCOME')
    const reservations = eventMessage(events, 'VTR_MECHANICAL_STEP_RESERVED')
    const actuations = eventMessage(events, 'VTR_TRANSITION_ACTUATION')
    const mechanicalOutcomes = eventMessage(events, 'VTR_MECHANICAL_OUTCOME')
    const mechanicalStepOutcomes = eventMessage(events, 'VTR_MECHANICAL_STEP_OUTCOME')
    const verifyRows = events.filter((row) => /(?:^|\s)(?:VTR_TRANSITION_VERIFY|VTR_VERIFY|TRANSITION_VERIFY)(?:\s|$)/.test(String(row?.message ?? '')))
    if (commits.length !== 1) fail('transition:commit-count', 'expected exactly one Transition commit', { count: commits.length })
    else pass('transition:commit-count', { count: commits.length })
    if (outcomes.length !== 1) fail('transition:outcome-count', 'expected exactly one terminal Transition outcome', { count: outcomes.length })
    else pass('transition:outcome-count', { count: outcomes.length })
    const commit = commits[0]?.detail
    const outcomeEvent = outcomes[0]?.detail
    const outcome = outcomeEvent?.outcome
    const contractHash = transition.contractHash
    if (commit && outcomeEvent && transition.transitionId === commit.transitionId && transition.transitionId === outcomeEvent.transitionId) pass('transition:id-chain', { transitionId: transition.transitionId })
    else fail('transition:id-chain', 'probe, commit and terminal outcome Transition ids differ', { probeId: transition.transitionId ?? null, commitId: commit?.transitionId ?? null, outcomeId: outcomeEvent?.transitionId ?? null })

    const contractBoundRows = [...commits, ...reservations, ...actuations, ...mechanicalOutcomes, ...mechanicalStepOutcomes, ...outcomes]
    const rowContractHashes = contractBoundRows.map((row) => transitionRowContractHash(row))
    const missingContractHashRows = contractBoundRows.map((row, index) => ({ row, index, hash: rowContractHashes[index] })).filter(({ hash }) => typeof hash !== 'string' || hash.length === 0)
    const conflictingContractHashRows = contractBoundRows.map((row, index) => ({ row, index, hash: rowContractHashes[index] })).filter(({ hash }) => typeof hash === 'string' && hash.length > 0 && hash !== contractHash)
    if (typeof contractHash !== 'string' || contractHash.length === 0) incomplete('transition:contract-hash-chain', 'probe contract hash is missing')
    else if (outcome?.contractHash !== contractHash || conflictingContractHashRows.length) fail('transition:contract-hash-chain', 'contract hash differs across committed, mechanical, and terminal event rows', { expected: contractHash, outcomeHash: outcome?.contractHash ?? null, conflicts: conflictingContractHashRows.map(({ row, hash }) => ({ event: firstMessageToken(row?.message), observed: hash })) })
    else if (missingContractHashRows.length) incomplete('transition:contract-hash-chain', 'one or more Transition event rows do not explicitly carry the committed contract hash', { contractHash, missingRows: missingContractHashRows.map(({ row }) => firstMessageToken(row?.message)) })
    else pass('transition:contract-hash-chain', { contractHash, rows: contractBoundRows.length })

    const committedIdentity = commit?.identity ?? commit?.worldIdentity
    if (!committedIdentity) incomplete('transition:commit-world-binding', 'commit event does not serialize its world/generation/lease identity')
    else {
      const committedKey = parseWorldKey(committedIdentity.worldKey)
      const runKey = parseWorldKey(run.worldKey)
      if (!committedKey || !runKey) fail('transition:commit-world-binding', 'commit or run worldKey is malformed')
      else if (committedKey.serverId !== runKey.serverId || committedKey.dimension !== runKey.dimension || committedKey.worldEpoch !== runKey.worldEpoch || committedIdentity.worldEpoch !== run.worldEpoch || committedIdentity.generationId !== generationId || committedIdentity.leaseId !== generationId || dimCanonical(committedIdentity.dimension) !== dimCanonical(run.dimension)) {
        fail('transition:commit-world-binding', 'commit world identity differs from the run-bound identity', { committedIdentity, runWorldKey: run.worldKey, runGenerationId: generationId })
      } else pass('transition:commit-world-binding', { worldKey: committedIdentity.worldKey, generationId: committedIdentity.generationId, leaseId: committedIdentity.leaseId })
    }

    const transitionExpectedMechanicalSteps = Number(outcomeEvent?.usage?.mechanicalSteps)
    let transitionOrderedRows = []
    const repeatedStepCounts = { reservations: reservations.length, mechanicalStepOutcomes: mechanicalStepOutcomes.length }
    if (!Number.isInteger(transitionExpectedMechanicalSteps) || transitionExpectedMechanicalSteps < 1) {
      fail('transition:event-order', 'terminal does not declare a positive integer mechanical step count', { mechanicalSteps: outcomeEvent?.usage?.mechanicalSteps ?? null })
    } else if (Object.values(repeatedStepCounts).some((count) => count > transitionExpectedMechanicalSteps)) {
      fail('transition:event-order', 'event chain contains more mechanical rows than the terminal usage count', { expectedMechanicalSteps: transitionExpectedMechanicalSteps, observed: repeatedStepCounts })
    } else if (Object.values(repeatedStepCounts).some((count) => count < transitionExpectedMechanicalSteps)) {
      incomplete('transition:event-order', 'one or more reserved/mechanical-step-outcome rows are missing for the terminal mechanical step count', { expectedMechanicalSteps: transitionExpectedMechanicalSteps, observed: repeatedStepCounts, intentActuations: actuations.length })
    } else if (commits.length !== 1 || outcomes.length !== 1 || verifyRows.length !== 1) {
      if (commits.length > 1 || outcomes.length > 1 || verifyRows.length > 1) fail('transition:event-order', 'commit, terminal, or VERIFY event is duplicated', { commits: commits.length, outcomes: outcomes.length, verifyRows: verifyRows.length })
      else incomplete('transition:event-order', 'commit, exactly one terminal outcome, or exactly one VERIFY row is absent', { commits: commits.length, outcomes: outcomes.length, verifyRows: verifyRows.length })
    } else {
      const stepOutcomeById = new Map(mechanicalStepOutcomes.map((row) => [row?.detail?.stepId, row]))
      const stepPairs = reservations.map((reserve) => ({ reserve, outcome: stepOutcomeById.get(reserve?.detail?.stepId) }))
      const commitIndex = events.indexOf(commits[0])
      const verifyIndex = events.indexOf(verifyRows[0])
      const terminalIndex = events.indexOf(outcomes[0])
      const invalidPairs = stepPairs.filter(({ reserve, outcome }) => !outcome || events.indexOf(reserve) >= events.indexOf(outcome))
      const stepIntentIds = new Set([...reservations, ...mechanicalStepOutcomes].map((row) => row?.detail?.intentId).filter((value) => typeof value === 'string'))
      const actuationIntentIds = actuations.map((row) => row?.detail?.intentId).filter((value) => typeof value === 'string')
      const duplicateActuationIntentIds = actuationIntentIds.filter((value, index, all) => all.indexOf(value) !== index)
      const unactuatedIntentIds = [...stepIntentIds].filter((intentId) => !actuationIntentIds.includes(intentId))
      const allExecutionRows = [...commits, ...actuations, ...reservations, ...mechanicalStepOutcomes, ...verifyRows, ...outcomes]
      const sortedExecutionRows = [...allExecutionRows].sort((left, right) => events.indexOf(left) - events.indexOf(right))
      transitionOrderedRows = sortedExecutionRows
      const timestamps = sortedExecutionRows.map(eventTimestamp)
      const stepOutcomesBeforeVerify = mechanicalStepOutcomes.every((row) => events.indexOf(row) < verifyIndex)
      const reasons = []
      if (actuations.length === 0) reasons.push('no VTR intent actuation was recorded')
      if (duplicateActuationIntentIds.length) reasons.push('an intent was actuated more than once')
      if (unactuatedIntentIds.length) reasons.push('mechanical steps refer to an intent with no actuation event')
      if (invalidPairs.length) reasons.push('each mechanical step must have one later typed outcome with the same stepId')
      if (commitIndex < 0 || sortedExecutionRows[0] !== commits[0]) reasons.push('commit must precede every execution row')
      if (!stepOutcomesBeforeVerify || verifyIndex <= Math.max(...mechanicalStepOutcomes.map((row) => events.indexOf(row)))) reasons.push('all per-step outcomes must precede VERIFY')
      if (terminalIndex <= verifyIndex) reasons.push('terminal outcome must follow VERIFY')
      if (timestamps.some((value) => value === null) || timestamps.some((value, index) => index > 0 && value < timestamps[index - 1])) reasons.push('execution timestamps must be present and monotonic')
      if (reasons.length) fail('transition:event-order', 'VTR intent, per-step reservation/outcome, VERIFY, and terminal ordering is inconsistent', { reasons, expectedMechanicalSteps: transitionExpectedMechanicalSteps, observed: { reservations: reservations.length, mechanicalStepOutcomes: mechanicalStepOutcomes.length, intentActuations: actuations.length, intentIds: [...stepIntentIds] } })
      else pass('transition:event-order', { markers: ['commit', 'intent-actuation', 'mechanical-step-reserved', 'mechanical-step-outcome', 'verify', 'terminal-outcome'], timestamps: sortedExecutionRows.map((row) => row.ts), mechanicalSteps: transitionExpectedMechanicalSteps, intentActuations: actuations.length })
    }

    const transitionLogMarkerGroups = [
      ['commit', 'VTR_TRANSITION_COMMIT', commits],
      ['reservation', 'VTR_MECHANICAL_STEP_RESERVED', reservations],
      ['actuation', 'VTR_TRANSITION_ACTUATION', actuations],
      ['mechanical-action-outcome', 'VTR_MECHANICAL_OUTCOME', mechanicalOutcomes],
      ['mechanical-step-outcome', 'VTR_MECHANICAL_STEP_OUTCOME', mechanicalStepOutcomes],
      ['terminal-outcome', 'VTR_TRANSITION_OUTCOME', outcomes],
    ]
    const logLines = rawHostLines
    const eventLogBindings = []
    const mirroredRows = []
    let missingEventLogBinding = false
    let mismatchedEventLogBinding = false
    for (const [name, marker, rows] of transitionLogMarkerGroups) {
      const keys = rows.map((row) => transitionRowStepId(row, rows.length === 1))
      const duplicateKeys = keys.filter((key, index) => key !== null && keys.indexOf(key) !== index)
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]
        const id = transitionRowId(row)
        if (typeof id !== 'string' || id.length === 0) {
          missingEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: 'missing event id' })
          continue
        }
        if (rows.length > 1 && (keys[rowIndex] === null || duplicateKeys.includes(keys[rowIndex]))) {
          missingEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: 'repeated event lacks a unique stepId discriminator', stepId: keys[rowIndex] })
          continue
        }
        let matching = logLines.filter((line) => hostEventToken(line) === marker && (line.includes(`transitionId=${id}`) || line.includes(`id=${id}`)))
        const directStepId = typeof row?.detail?.stepId === 'string' && row.detail.stepId.length > 0 ? row.detail.stepId : null
        const directIntentId = typeof row?.detail?.intentId === 'string' && row.detail.intentId.length > 0 ? row.detail.intentId : null
        const directActionId = typeof row?.detail?.actionId === 'string' && row.detail.actionId.length > 0 ? row.detail.actionId : null
        if (directStepId !== null) matching = matching.filter((line) => line.includes(`stepId=${directStepId}`) || line.includes(`stepId=${JSON.stringify(directStepId)}`))
        else if (directIntentId !== null) matching = matching.filter((line) => line.includes(`intentId=${directIntentId}`) || line.includes(`intentId=${JSON.stringify(directIntentId)}`))
        else if (directActionId !== null) matching = matching.filter((line) => line.includes(`actionId=${directActionId}`) || line.includes(`actionId=${JSON.stringify(directActionId)}`))
        else if (rows.length > 1) matching = []
        if (matching.length !== 1) {
          if (matching.length > 1) mismatchedEventLogBinding = true
          else missingEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: matching.length > 1 ? 'ambiguous duplicate raw log lines' : 'raw log line missing', count: matching.length, stepId: keys[rowIndex] })
          continue
        }
        const line = matching[0]
        const rawIdentity = {
          runId: token(line, 'runId'),
          generationId: token(line, 'generationId'),
          sourceSha: token(line, 'sourceSha'),
          buildHash: token(line, 'buildHash'),
        }
        const expectedIdentity = { runId, generationId, sourceSha, buildHash: source.buildHash }
        const differences = Object.keys(expectedIdentity).filter((key) => rawIdentity[key] !== expectedIdentity[key]).map((key) => ({ key, expected: expectedIdentity[key], observed: rawIdentity[key] }))
        // MirroringEventLogger tees the marker token plus JSONL detail to HOST;
        // fields carried only in the JSONL message text are not in that sink.
        const expectedRowContractHash = row?.detail?.contractHash ?? row?.detail?.outcome?.contractHash ?? null
        if (expectedRowContractHash && token(line, 'contractHash') !== expectedRowContractHash) differences.push({ key: 'contractHash', expected: expectedRowContractHash, observed: token(line, 'contractHash') })
        const rawTime = logTimestamp(line)
        const eventTime = eventTimestamp(row)
        const timestampDeltaMs = rawTime === null || eventTime === null ? null : rawTime - eventTime
        const lineIndex = logLines.indexOf(line)
        if (differences.length || timestampDeltaMs === null || timestampDeltaMs < 0) {
          mismatchedEventLogBinding = true
          eventLogBindings.push({ name, rowIndex, status: 'mismatch', differences, rawTimestamp: rawTime, eventTimestamp: eventTime, timestampDeltaMs, stepId: keys[rowIndex] })
        } else {
          const binding = { name, rowIndex, status: 'PASS', transitionId: id, stepId: keys[rowIndex], runId, generationId, sourceSha, journalTimestamp: row.ts, hostTimestamp: line.slice(1, line.indexOf(']')), timestampDeltaMs }
          eventLogBindings.push(binding)
          mirroredRows.push({ row, lineIndex, rawTime, binding })
        }
      }
    }
    const duplicateMirroredLineIndexes = mirroredRows.map((item) => item.lineIndex).filter((value, index, all) => all.indexOf(value) !== index)
    const orderedMirroredRows = [...mirroredRows].sort((left, right) => events.indexOf(left.row) - events.indexOf(right.row))
    const hostLineOrderInvalid = orderedMirroredRows.some((item, index) => index > 0 && item.lineIndex <= orderedMirroredRows[index - 1].lineIndex)
    if (duplicateMirroredLineIndexes.length || hostLineOrderInvalid) {
      mismatchedEventLogBinding = true
      eventLogBindings.push({ status: 'mismatch', reason: duplicateMirroredLineIndexes.length ? 'one host line was reused for multiple JSONL events' : 'host mirror order differs from JSONL event order', duplicateLineIndexes: duplicateMirroredLineIndexes })
    }
    if (mismatchedEventLogBinding) fail('transition:event-run-binding', 'raw Transition log lines mismatch provenance, reuse one host line, or precede/out-of-order journal emission', { bindings: eventLogBindings })
    else if (missingEventLogBinding) incomplete('transition:event-run-binding', 'raw Transition event lines are missing, duplicated, or lack unique per-step correlation', { bindings: eventLogBindings })
    else pass('transition:event-run-binding', { bindings: eventLogBindings })

    const requiredContract = ['requires', 'ensures', 'invariants', 'admissibleEffects', 'budget']
    const missingContract = requiredContract.filter((field) => !Array.isArray(transition[field]) && !(transition[field] && typeof transition[field] === 'object'))
    if (transition.desiredPredicate && missingContract.length === 0 && (transition.worldIdentity || transition.identity)) pass('transition:contract-fields', { fields: ['desiredPredicate', ...requiredContract, 'worldIdentity'] })
    else incomplete('transition:contract-fields', 'serialized contract is missing one or more first-class fields', { missing: [...missingContract, ...(!transition.desiredPredicate ? ['desiredPredicate'] : []), ...(!(transition.worldIdentity || transition.identity) ? ['worldIdentity'] : [])] })
    if (transition.controller && Array.isArray(transition.controller.allowedTactics)) pass('transition:controller-policy', { controller: transition.controller })
    else incomplete('transition:controller-policy', 'contract controller policy is not serialized with allowed tactics and substitution permissions')
    if (transition.progressDefinition || transition.progressContract || transition.progressPolicy) pass('transition:progress-contract', { value: transition.progressDefinition ?? transition.progressContract ?? transition.progressPolicy })
    else incomplete('transition:progress-contract', 'contract does not serialize the Transition-specific progress definition')

    const budgetCheck = assertUsageWithinBudget({
      budget: { ...(transition.budget ?? {}), admissibleEffects: transition.admissibleEffects },
      usage: outcomeEvent?.usage,
    })
    if (budgetCheck.problems.length) fail('transition:budget', 'terminal usage exceeds or violates the committed Transition budget/effect envelope', { problems: budgetCheck.problems })
    else if (budgetCheck.missing.length) incomplete('transition:budget', 'budget or terminal usage is too incomplete to check against the committed contract', { missing: budgetCheck.missing })
    else pass('transition:budget', { mechanicalSteps: outcomeEvent.usage.mechanicalSteps, elapsedMs: outcomeEvent.usage.elapsedMs, resources: outcomeEvent.usage.resources, risk: outcomeEvent.usage.risk, effects: outcomeEvent.usage.effects })

    const mechanicalCounts = { reservations: reservations.length, perStepOutcomes: mechanicalStepOutcomes.length, intentActuations: actuations.length }
    if (!Number.isInteger(transitionExpectedMechanicalSteps) || transitionExpectedMechanicalSteps < 1) {
      fail('transition:mechanical-counts', 'terminal mechanicalSteps is not a positive integer', { mechanicalSteps: outcomeEvent?.usage?.mechanicalSteps ?? null, observed: mechanicalCounts })
    } else if ([reservations.length, mechanicalStepOutcomes.length].some((count) => count > transitionExpectedMechanicalSteps)) {
      fail('transition:mechanical-counts', 'per-leg reservation/outcome count exceeds terminal mechanicalSteps', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
    } else if (reservations.length < transitionExpectedMechanicalSteps || mechanicalStepOutcomes.length < transitionExpectedMechanicalSteps) {
      incomplete('transition:mechanical-counts', 'per-leg reservation/outcome count is below terminal mechanicalSteps', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
    } else if (actuations.length === 0) {
      incomplete('transition:mechanical-counts', 'no VTR intent actuation was archived', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
    } else {
      pass('transition:mechanical-counts', { expected: transitionExpectedMechanicalSteps, observed: mechanicalCounts })
      const mechanicalMissing = []
      const mechanicalProblems = []
      const seenStepIds = new Set()
      const stepEvidence = []
      const persistentIdentity = persistentActionIdentity({ reservations, outcomes: mechanicalStepOutcomes, actuations, actionOutcomes: mechanicalOutcomes })
      mechanicalProblems.push(...persistentIdentity.problems.map((problem) => ({ field: 'persistent Transition action identity', ...problem })))
      const actuationByIntentId = new Map()
      for (const row of actuations) {
        const intentId = row?.detail?.intentId
        if (typeof intentId !== 'string' || intentId.length === 0) {
          mechanicalMissing.push('actuation.intentId')
          continue
        }
        if (actuationByIntentId.has(intentId)) mechanicalProblems.push({ field: 'unique actuation intentId', observed: intentId })
        else actuationByIntentId.set(intentId, row)
      }
      const outcomeStepIds = mechanicalStepOutcomes.map((row) => row?.detail?.stepId)
      const duplicateOutcomeStepIds = outcomeStepIds.filter((stepId, index, all) => typeof stepId === 'string' && all.indexOf(stepId) !== index)
      if (duplicateOutcomeStepIds.length) mechanicalProblems.push({ field: 'unique outcome stepId', observed: [...new Set(duplicateOutcomeStepIds)] })
      for (let index = 0; index < transitionExpectedMechanicalSteps; index += 1) {
        const reserveRow = reservations[index]
        const reserve = reserveRow?.detail ?? {}
        const reserveStepId = typeof reserve.stepId === 'string' && reserve.stepId.length > 0 ? reserve.stepId : null
        const matchingOutcomes = mechanicalStepOutcomes.filter((row) => row?.detail?.stepId === reserveStepId)
        const mechRow = matchingOutcomes[0] ?? null
        const mech = mechRow?.detail ?? {}
        const actionRow = typeof reserve.intentId === 'string' ? actuationByIntentId.get(reserve.intentId) : null
        const action = actionRow?.detail ?? {}
        const rowIds = [transitionRowId(reserveRow), transitionRowId(actionRow), transitionRowId(mechRow)]
        if (rowIds.some((id) => id === null)) mechanicalMissing.push(`step ${index + 1} transitionId`)
        else if (rowIds.some((id) => id !== transition.transitionId)) mechanicalProblems.push({ step: index + 1, field: 'transitionId', expected: transition.transitionId, observed: rowIds })

        if (action.authority !== 'vtr-transition-controller') mechanicalProblems.push({ step: index + 1, field: 'authority', expected: 'vtr-transition-controller', observed: action.authority ?? null })
        const actionContractHash = transitionRowContractHash(actionRow)
        if (actionContractHash !== contractHash) mechanicalProblems.push({ step: index + 1, field: 'actuation.contractHash', expected: contractHash, observed: actionContractHash ?? null })
        const reserveUsage = Number(reserve.usage?.mechanicalSteps)
        const mechUsage = Number(mech.usage?.mechanicalSteps)
        const expectedOrdinal = index + 1
        if (!Number.isFinite(reserveUsage)) mechanicalMissing.push(`step ${expectedOrdinal} reservation usage.mechanicalSteps`)
        else if (reserveUsage !== expectedOrdinal) mechanicalProblems.push({ step: expectedOrdinal, field: 'reservation mechanicalSteps', expected: expectedOrdinal, observed: reserveUsage })
        if (!Number.isFinite(mechUsage)) mechanicalMissing.push(`step ${expectedOrdinal} mechanical outcome usage.mechanicalSteps`)
        else if (mechUsage !== expectedOrdinal) mechanicalProblems.push({ step: expectedOrdinal, field: 'mechanical outcome mechanicalSteps', expected: expectedOrdinal, observed: mechUsage })

        const mechStepId = typeof mech.stepId === 'string' && mech.stepId.length > 0 ? mech.stepId : null
        const actionId = typeof action.actionId === 'string' ? action.actionId : null
        const reserveActionId = typeof reserve.actionId === 'string' ? reserve.actionId : null
        const mechActionId = typeof mech.actionId === 'string' ? mech.actionId : null
        const reserveIntentId = typeof reserve.intentId === 'string' ? reserve.intentId : null
        const mechIntentId = typeof mech.intentId === 'string' ? mech.intentId : null
        let canonicalStepId = reserveStepId
        if (!reserveStepId) {
          mechanicalMissing.push(`step ${expectedOrdinal} reservation.stepId`)
        } else if (matchingOutcomes.length === 0) {
          mechanicalMissing.push(`step ${expectedOrdinal} VTR_MECHANICAL_STEP_OUTCOME`)
        } else if (matchingOutcomes.length > 1) {
          mechanicalProblems.push({ step: expectedOrdinal, field: 'unique per-step outcome', count: matchingOutcomes.length })
        }
        if (reserveStepId && mechStepId !== null && reserveStepId !== mechStepId) mechanicalProblems.push({ step: expectedOrdinal, field: 'stepId', expected: reserveStepId, mechanicalOutcome: mechStepId })
        if (!reserveIntentId || !mechIntentId || !action.intentId) mechanicalMissing.push(`step ${expectedOrdinal} intentId correlation`)
        else if (reserveIntentId !== mechIntentId || reserveIntentId !== action.intentId) mechanicalProblems.push({ step: expectedOrdinal, field: 'intentId', reservation: reserveIntentId, outcome: mechIntentId, actuation: action.intentId })
        if (!reserveActionId || !mechActionId || !actionId) mechanicalMissing.push(`step ${expectedOrdinal} actionId correlation`)
        else if (reserveActionId !== mechActionId || reserveActionId !== actionId) mechanicalProblems.push({ step: expectedOrdinal, field: 'actionId', reservation: reserveActionId, outcome: mechActionId, actuation: actionId })
        if (transitionRowContractHash(reserveRow) !== contractHash || transitionRowContractHash(mechRow) !== contractHash) mechanicalProblems.push({ step: expectedOrdinal, field: 'step contractHash', expected: contractHash, reservation: transitionRowContractHash(reserveRow), outcome: transitionRowContractHash(mechRow) })
        if (mech.status !== 'active' && mech.status !== 'terminal' && mech.status !== 'refused') mechanicalProblems.push({ step: expectedOrdinal, field: 'typed step status', observed: mech.status ?? null })
        if (actionRow && reserveRow && events.indexOf(actionRow) >= events.indexOf(reserveRow)) mechanicalProblems.push({ step: expectedOrdinal, field: 'intent actuation order', intentId: reserveIntentId })
        if (reserveRow && mechRow && events.indexOf(reserveRow) >= events.indexOf(mechRow)) mechanicalProblems.push({ step: expectedOrdinal, field: 'reservation/outcome order', stepId: reserveStepId })

        if (canonicalStepId !== null) {
          if (seenStepIds.has(canonicalStepId)) mechanicalProblems.push({ step: expectedOrdinal, field: 'unique stepId', observed: canonicalStepId })
          seenStepIds.add(canonicalStepId)
        }
        stepEvidence.push({ ordinal: expectedOrdinal, stepId: canonicalStepId, intentId: reserveIntentId, actionId: actionId ?? mechActionId, leg: reserve.leg ?? null, status: mech.status ?? null, usage: mechUsage })
      }
      if (mechanicalProblems.length) fail('transition:mechanical-chain', 'one or more per-leg rows conflict with the active Transition, intent owner, step identity, or cumulative usage', { problems: mechanicalProblems, missing: mechanicalMissing })
      else if (mechanicalMissing.length) incomplete('transition:mechanical-chain', 'per-leg reservation/outcome rows do not fully bind unique ordered steps to the active Transition', { missing: mechanicalMissing, steps: stepEvidence })
      else pass('transition:mechanical-chain', { transitionId: transition.transitionId, contractHash, authority: 'vtr_transition', mechanicalSteps: transitionExpectedMechanicalSteps, steps: stepEvidence, actionOutcomes: mechanicalOutcomes.length })
    }

    let verifyHostCheck = null
    if (outcome?.kind === 'SUCCESS' && outcomeEvent?.boundary === 'verified-terminal' && Array.isArray(outcome.evidenceIds) && outcome.evidenceIds.some((id) => /^verify:/.test(id)) && outcome.desiredPredicateIdentity) {
      const reportedVerifyMs = Date.parse(transition.outcome?.verifiedAt ?? '')
      if (!Number.isFinite(outcome.verifiedAtMs) || reportedVerifyMs !== outcome.verifiedAtMs) {
        fail('transition:verified-success', 'probe and terminal disagree on the deterministic VERIFY timestamp', { eventVerifiedAtMs: outcome.verifiedAtMs ?? null, probeVerifiedAt: transition.outcome?.verifiedAt ?? null, probeVerifiedAtMs: reportedVerifyMs })
      } else if (verifyRows.length > 1) {
        fail('transition:verified-success', 'multiple structured VERIFY observations make the terminal evidence ambiguous', { count: verifyRows.length, evidenceIds: outcome.evidenceIds })
      } else if (verifyRows.length === 0) {
        incomplete('transition:verified-success', 'outcome contains a verify ID but the archive has no independent structured VERIFY observation bound to it', { outcome: outcome.kind, evidenceIds: outcome.evidenceIds, verifiedAtMs: outcome.verifiedAtMs })
      } else {
        const verify = verifyRows.find((row) => {
          const detail = row?.detail?.verification ?? row?.detail ?? {}
          const ids = Array.isArray(detail.evidenceIds) ? detail.evidenceIds : [detail.evidenceId].filter((value) => typeof value === 'string')
          return detail.transitionId === transition.transitionId && ids.some((id) => outcome.evidenceIds.includes(id))
        })
        if (!verify) {
          fail('transition:verified-success', 'VERIFY observations are present but none binds the committed Transition and terminal evidence id', { transitionId: transition.transitionId, verifyRows: verifyRows.length, evidenceIds: outcome.evidenceIds })
        } else {
          const detail = verify.detail?.verification ?? verify.detail ?? {}
          const verifyIdentity = detail.worldIdentity ?? detail.identity ?? detail
          const rawVerifyTruth = detail.truth ?? detail.result
          const verifyTruth = rawVerifyTruth === true || rawVerifyTruth === 'TRUE'
          const verifyEvidenceIds = Array.isArray(detail.evidenceIds) ? detail.evidenceIds : [detail.evidenceId].filter((value) => typeof value === 'string')
          const observedAtMs = Number(detail.observedAtMs ?? detail.verifiedAtMs)
          const reportedVerifiedAtMs = Number(detail.verifiedAtMs)
          const verifyEventAt = eventTimestamp(verify)
          const lastMechanicalOutcome = mechanicalStepOutcomes.at(-1)
          const mechAt = eventTimestamp(lastMechanicalOutcome)
          const terminalAt = eventTimestamp(outcomes[0])
          const verifyProblems = []
          const verifyMissing = []
          const expectedBindings = {
            transitionId: transition.transitionId,
            contractHash,
            desiredPredicateIdentity: outcome.desiredPredicateIdentity,
            runId,
            serverId: run.serverId,
            generationId,
            leaseId: generationId,
            sourceSha,
            buildHash: source.buildHash,
            worldKey: run.worldKey,
            worldEpoch: run.worldEpoch,
            dimension: dimCanonical(run.dimension),
          }
          for (const [key, expected] of Object.entries(expectedBindings)) {
            const observed = key === 'worldKey' ? (detail.worldKey ?? verifyIdentity.worldKey ?? verifyIdentity.worldIdentity?.worldKey)
              : key === 'worldEpoch' ? (detail.worldEpoch ?? verifyIdentity.worldEpoch ?? verifyIdentity.worldIdentity?.worldEpoch)
                : key === 'dimension' ? dimCanonical(detail.dimension ?? verifyIdentity.dimension ?? verifyIdentity.worldIdentity?.dimension)
                  : detail[key] ?? verifyIdentity[key] ?? verifyIdentity.worldIdentity?.[key]
            if (observed === undefined || observed === null || observed === '') verifyMissing.push(key)
            else if (key === 'worldKey') {
              const observedKey = parseWorldKey(observed)
              const expectedKey = parseWorldKey(expected)
              if (!observedKey || !expectedKey || observedKey.serverId !== expectedKey.serverId || observedKey.dimension !== expectedKey.dimension || observedKey.worldEpoch !== expectedKey.worldEpoch) verifyProblems.push({ key, expected, observed })
            } else if (observed !== expected) verifyProblems.push({ key, expected, observed })
          }
          if (rawVerifyTruth === undefined || rawVerifyTruth === null) verifyMissing.push('truth')
          else if (!verifyTruth) verifyProblems.push({ key: 'truth', expected: 'true/TRUE', observed: rawVerifyTruth })
          if (!verifyEvidenceIds.length) verifyMissing.push('evidenceIds')
          else if (!verifyEvidenceIds.every((id) => outcome.evidenceIds.includes(id))) verifyProblems.push({ key: 'evidenceIds', expected: outcome.evidenceIds, observed: verifyEvidenceIds })
          if (!Number.isFinite(observedAtMs)) verifyMissing.push('canonical observedAtMs/verifiedAtMs')
          else if (observedAtMs !== outcome.verifiedAtMs) verifyProblems.push({ key: 'canonical observedAtMs', expected: outcome.verifiedAtMs, observed: observedAtMs })
          if (Number.isFinite(reportedVerifiedAtMs) && reportedVerifiedAtMs !== outcome.verifiedAtMs) verifyProblems.push({ key: 'verifiedAtMs', expected: outcome.verifiedAtMs, observed: reportedVerifiedAtMs })
          else if (!Number.isFinite(reportedVerifiedAtMs) && detail.verifiedAtMs !== undefined) verifyMissing.push('valid verifiedAtMs')
          if (verifyEventAt === null) verifyMissing.push('event emission timestamp')
          if (mechAt === null || terminalAt === null || verifyEventAt === null) verifyMissing.push('VERIFY event ordering timestamps')
          else if (verifyEventAt < mechAt || verifyEventAt > terminalAt || events.indexOf(verify) <= events.indexOf(lastMechanicalOutcome) || events.indexOf(verify) >= events.indexOf(outcomes[0])) {
            verifyProblems.push({ key: 'event order', expected: 'mechanical outcome < VERIFY observation < terminal outcome', observed: { mechanicalAt: mechAt, verifyAt: verifyEventAt, terminalAt } })
          }

          const verifyMarker = firstMessageToken(verify.message)
          const hostVerifyLines = logLines.filter((line) => hostEventToken(line) === verifyMarker
            && (line.includes(`transitionId=${transition.transitionId}`) || line.includes(`id=${transition.transitionId}`))
            && verifyEvidenceIds.every((id) => line.includes(`evidenceId=${id}`) || line.includes(JSON.stringify(id))))
          if (hostVerifyLines.length === 0) verifyMissing.push('mirrored HOST VERIFY line bound to transition/evidence')
          else if (hostVerifyLines.length > 1) verifyProblems.push({ key: 'host VERIFY line count', expected: 1, observed: hostVerifyLines.length })
          else {
            const hostLine = hostVerifyLines[0]
            const hostProblems = []
            const hostMissing = []
            const hostIdentity = {
              runId: token(hostLine, 'runId'),
              generationId: token(hostLine, 'generationId'),
              sourceSha: token(hostLine, 'sourceSha'),
              buildHash: token(hostLine, 'buildHash'),
            }
            const expectedHostIdentity = { runId, generationId, sourceSha, buildHash: source.buildHash }
            for (const [key, expected] of Object.entries(expectedHostIdentity)) {
              if (hostIdentity[key] === null) hostMissing.push(key)
              else if (hostIdentity[key] !== expected) hostProblems.push({ key, expected, observed: hostIdentity[key] })
            }
            const hostAt = logTimestamp(hostLine)
            const hostLineIndex = logLines.indexOf(hostLine)
            if (hostAt === null || verifyEventAt === null) hostMissing.push('timestamp')
            else if (hostAt < verifyEventAt) hostProblems.push({ key: 'host timestamp precedes JSONL emission', expectedAtLeast: verifyEventAt, observed: hostAt, deltaMs: hostAt - verifyEventAt })
            const lastMechanicalHostRow = mirroredRows.find((item) => item.row === mechanicalStepOutcomes.at(-1))
            const terminalHostRow = mirroredRows.find((item) => item.row === outcomes[0])
            if (!lastMechanicalHostRow || !terminalHostRow) hostMissing.push('matching mechanical-outcome/terminal HOST mirror lines for order check')
            else if (hostLineIndex <= lastMechanicalHostRow.lineIndex || hostLineIndex >= terminalHostRow.lineIndex) hostProblems.push({ key: 'host mirror order', expected: 'mechanical outcome < VERIFY < terminal outcome', observed: { mechanicalLineIndex: lastMechanicalHostRow.lineIndex, verifyLineIndex: hostLineIndex, terminalLineIndex: terminalHostRow.lineIndex } })
            const hostDetail = { eventToken: verifyMarker, transitionId: transition.transitionId, evidenceIds: verifyEvidenceIds, hostTimestamp: hostLine.slice(1, hostLine.indexOf(']')), journalTimestamp: verify.ts, timestampDeltaMs: hostAt === null || verifyEventAt === null ? null : hostAt - verifyEventAt, hostLineIndex, identity: hostIdentity }
            if (hostProblems.length) {
              verifyProblems.push(...hostProblems.map((problem) => ({ ...problem, key: `host.${problem.key}` })))
              verifyHostCheck = { status: CHECK_STATUS.FAIL, reason: 'mirrored HOST VERIFY event conflicts with the JSONL event/run binding', detail: { ...hostDetail, problems: hostProblems } }
            } else if (hostMissing.length) {
              verifyMissing.push(...hostMissing.map((key) => `host.${key}`))
              verifyHostCheck = { status: CHECK_STATUS.INCOMPLETE, reason: 'mirrored HOST VERIFY event lacks complete provenance/timestamp data', detail: { ...hostDetail, missing: hostMissing } }
            } else verifyHostCheck = { status: CHECK_STATUS.PASS, detail: hostDetail }
          }
          if (verifyProblems.length) fail('transition:verified-success', 'structured VERIFY evidence is stale or conflicts with the Transition/run binding', { problems: verifyProblems, missing: verifyMissing })
          else if (verifyMissing.length) incomplete('transition:verified-success', 'structured VERIFY evidence is not fully bound to the exact run, source, world identity, and mirrored host event', { missing: verifyMissing, evidenceIds: verifyEvidenceIds })
          else pass('transition:verified-success', { outcome: outcome.kind, evidenceIds: verifyEvidenceIds, observedAtMs, verifiedAtMs: reportedVerifiedAtMs, predicateIdentity: outcome.desiredPredicateIdentity })
        }
      }
    } else fail('transition:verified-success', 'terminal does not prove deterministic SUCCESS with a VERIFY evidence id and predicate identity', { outcome: outcome?.kind ?? null, boundary: outcomeEvent?.boundary ?? null, evidenceIds: outcome?.evidenceIds ?? [] })
    if (verifyHostCheck?.status === CHECK_STATUS.PASS) pass('transition:verify-host-binding', verifyHostCheck.detail)
    else if (verifyHostCheck?.status === CHECK_STATUS.FAIL) fail('transition:verify-host-binding', verifyHostCheck.reason, verifyHostCheck.detail)
    else if (verifyHostCheck?.status === CHECK_STATUS.INCOMPLETE) incomplete('transition:verify-host-binding', verifyHostCheck.reason, verifyHostCheck.detail)
    else if (verifyRows.length === 0) incomplete('transition:verify-host-binding', 'no structured VERIFY row is available to corroborate against the mirrored HOST log')
    else fail('transition:verify-host-binding', 'the VERIFY row could not be uniquely matched to a mirrored HOST event with the same transition and evidence')
    if (outcome && transition.metrics?.typedTerminalOutcome === outcome.kind) pass('transition:typed-outcome-metric', { kind: outcome.kind })
    else fail('transition:typed-outcome-metric', 'typed terminal metric does not match the recorded outcome')
    if (Number(outcomeEvent?.usage?.mechanicalSteps) === transition.metrics?.mechanicalStepsPerTransition) pass('metrics:mechanical-steps', { count: outcomeEvent.usage.mechanicalSteps })
    else fail('metrics:mechanical-steps', 'metrics disagree with terminal Transition usage')
    if (transition.metrics?.duplicateAuthority === false && transition.metrics?.duplicateAuthorityConflicts === 0 && transition.metrics?.concurrentLegacyActuations === 0) pass('metrics:no-double-authority', { duplicateAuthority: false, conflicts: 0, concurrentLegacyActuations: 0, concurrentLegacyActuationsEvidence: 'probe-reported metric; raw marker scan and exact-source fixture are checked separately, no interval-level concurrency trace is present in this metric' })
    else incomplete('metrics:no-double-authority', 'probe summary does not assert zero duplicate/concurrent legacy authority')

    const skillStartRows = events.filter((row) => row?.source === 'executor' && String(row.message).startsWith('SKILL_START '))
    const skillStarts = skillStartRows.length
    const vtrSelectedSkills = skillStartRows.filter((row) => /selectedBy=vtr-transition/.test(String(row.message))).length
    const skillStartIndices = skillStartRows.map((row) => events.indexOf(row))
    const commitIndex = events.indexOf(commits[0])
    const outcomeIndex = events.indexOf(outcomes[0])
    const firstReservationIndex = reservations.length === 0 ? -1 : Math.min(...reservations.map((row) => events.indexOf(row)))
    const legAndActuationActionIds = [...new Set(
      [...reservations, ...mechanicalStepOutcomes, ...actuations]
        .map((row) => row?.detail?.actionId)
        .filter((value) => typeof value === 'string' && value.length > 0),
    )]
    const expectedActionId = legAndActuationActionIds.length === 1 ? legAndActuationActionIds[0] : null
    const skillStartProof = persistentSkillStartProof({
      skillStartRows,
      actionId: expectedActionId,
      mechanicalSteps: transitionExpectedMechanicalSteps,
      commitIndex,
      skillStartIndex: skillStartIndices[0],
      firstReservationIndex,
      outcomeIndex,
    })
    if (skillStartProof.status === 'PASS' && vtrSelectedSkills === 1) pass('authority:single-skill-owner', { skillStarts, vtrSelectedSkills, mechanicalSteps: transitionExpectedMechanicalSteps, selectedBy: 'vtr-transition', actionId: expectedActionId, proof: 'one VTR-selected skill owns at least three mechanical legs under one Transition' })
    else if (skillStartProof.status === 'INCOMPLETE') incomplete('authority:single-skill-owner', 'SKILL_START identity/order is not fully bound to the persistent per-leg action', { skillStarts, vtrSelectedSkills, mechanicalSteps: transitionExpectedMechanicalSteps, skillStartIndices, firstReservationIndex, commitIndex, outcomeIndex, actionIds: legAndActuationActionIds, proof: skillStartProof })
    else fail('authority:single-skill-owner', skillStartProof.reason ?? 'persistent Reach proof does not establish one VTR-selected action across multiple mechanical legs', { skillStarts, vtrSelectedSkills, mechanicalSteps: transitionExpectedMechanicalSteps, skillStartIndices, firstReservationIndex, commitIndex, outcomeIndex, actionIds: legAndActuationActionIds, proof: skillStartProof })
    const legacyActuationSource = '(?:selectedBy=(?:jev|legacy|option|goalqueue)|LEGACY_ACTUATION|legacyActuation=true|authority=(?:legacy|option|goalqueue)|(?:GOAL_QUEUE|OPTION)_ACTUATION)'
    const legacyActuationMatches = (botLog.match(new RegExp(legacyActuationSource, 'gi')) ?? []).length + events.filter((row) => new RegExp(legacyActuationSource, 'i').test(String(row?.message ?? ''))).length
    if (legacyActuationMatches === 0 && transition.metrics?.duplicateAuthority === false) pass('authority:no-legacy-actuation-observed', { matches: legacyActuationMatches })
    else fail('authority:no-legacy-actuation-observed', 'legacy actuation marker or conflict was observed', { matches: legacyActuationMatches })

    const policy = probe.configuredNoLlmProbe ?? {}
    const jev = policy.effectiveJev ?? {}
    const system2 = policy.effectiveSystem2 ?? {}
    const zeroValues = {
      networkModelCalls: policy.networkModelCalls,
      jevDecisionCalls: jev.decisionCalls,
      system2DecisionCalls: system2.decisionCalls,
      terminalJevCalls: outcomeEvent?.jevCalls ?? Number(/jevCalls=(\d+)/.exec(outcomes[0]?.message ?? '')?.[1]),
      terminalSystem2Calls: outcomeEvent?.system2Calls ?? Number(/system2Calls=(\d+)/.exec(outcomes[0]?.message ?? '')?.[1]),
    }
    const modelActivityPattern = /JEV_DECISION(?:_EPOCH_START|_FRAME)?|SYSTEM2_(?:PLAN|DECISION|PROVIDER|LLM)|(?:JEV|SYSTEM2)_MODEL_(?:CALL|REQUEST|RETRY|FAILURE)|(?:MODEL|PROVIDER)_(?:CALL|REQUEST|RETRY|FAILURE|UNAVAILABLE|FALLBACK)|FALLBACK_AFTER_PROVIDER_FAILURE|GatewayInternalServerError|Service temporarily unavailable|MODEL_UNAVAILABLE|HTTP 5\d\d/iu
    const modelActivityRows = events.filter((row) => modelActivityPattern.test(String(row?.message ?? '')))
    const modelActivityLogLines = botLog.split(/\r?\n/).filter((line) => modelActivityPattern.test(line))
    const anyModelDecision = modelActivityRows.length > 0 || modelActivityLogLines.length > 0
    const modelJournals = ['runner/jev-calls.jsonl', 'runner/jev-decisions.jsonl', 'runner/system2.jsonl'].map((path) => {
      if (!present.has(path)) return { path, status: 'missing', records: null }
      try {
        const rows = parseJsonl(archive, path)
        return { path, status: rows.length === 0 ? 'empty' : 'non-empty', records: rows.length }
      } catch (error) {
        return { path, status: 'invalid', error: error.message, records: null }
      }
    })
    const missingModelJournals = modelJournals.filter((entry) => entry.status === 'missing' || entry.status === 'invalid')
    const nonEmptyModelJournals = modelJournals.filter((entry) => entry.status === 'non-empty')
    const fallbackFlags = policy.fallback ?? {}
    const offlineBindings = {
      BUDDY_POLICY: policy.BUDDY_POLICY,
      BUDDY_SYSTEM2: policy.BUDDY_SYSTEM2,
      fallbackPolicyWasExplicitlyConfigured: fallbackFlags.fallbackPolicyWasExplicitlyConfigured,
      silentFallbackOnProviderFailure: fallbackFlags.silentFallbackOnProviderFailure,
      JevDecisionInvoked: fallbackFlags.JevDecisionInvoked,
      effectiveJevProvider: jev.provider,
      effectiveSystem2Provider: system2.provider,
    }
    const missingOfflineBindings = Object.entries(offlineBindings).filter(([, value]) => value === undefined || value === null).map(([key]) => key)
    const explicitlyOffline = policy.BUDDY_POLICY === 'fallback' && policy.BUDDY_SYSTEM2 === 'off' && fallbackFlags.fallbackPolicyWasExplicitlyConfigured === true && fallbackFlags.silentFallbackOnProviderFailure === false && fallbackFlags.JevDecisionInvoked === false && jev.provider === 'deterministic' && system2.provider === 'none'
    const configuredLine = probeConfiguredLines.length === 1 ? probeConfiguredLines[0] : null
    const queueEmptyLine = probeQueueEmptyLines.length === 1 ? probeQueueEmptyLines[0] : null
    const readyLine = vtrAuthorityReadyLines.length === 1 ? vtrAuthorityReadyLines[0] : null
    const explicitRuntimeFlags = {
      configuredMarkerCount: probeConfiguredLines.length,
      BUDDY_POLICY: token(configuredLine ?? '', 'jevPolicyMode'),
      BUDDY_SYSTEM2: token(configuredLine ?? '', 'system2Mode'),
      compatibilityLadder: token(configuredLine ?? '', 'compatibilityLadder'),
      ledgerRestore: token(configuredLine ?? '', 'ledgerRestore'),
      plannerBootstrap: token(configuredLine ?? '', 'plannerBootstrap'),
      queueEmptyMarkerCount: probeQueueEmptyLines.length,
      queueAuthority: token(queueEmptyLine ?? '', 'authority'),
      restoredLegacyRows: token(queueEmptyLine ?? '', 'restoredLegacyRows'),
      productionPlanAuthority: token(readyLine ?? '', 'productionPlanAuthority'),
      readyPolicy: token(readyLine ?? '', 'policy'),
      readyPolicyProvider: token(readyLine ?? '', 'policyProvider'),
      readySystem2Provider: token(readyLine ?? '', 'system2Provider'),
    }
    const missingRuntimeFlags = Object.entries(explicitRuntimeFlags).filter(([key, value]) => key.endsWith('MarkerCount') ? value === 0 : value === null).map(([key]) => key)
    const runtimeFlagsMatch = configuredLine !== null && queueEmptyLine !== null && readyLine !== null
      && explicitRuntimeFlags.BUDDY_POLICY === policy.BUDDY_POLICY
      && explicitRuntimeFlags.BUDDY_SYSTEM2 === policy.BUDDY_SYSTEM2
      && explicitRuntimeFlags.compatibilityLadder === 'observer-only'
      && explicitRuntimeFlags.ledgerRestore === 'disabled'
      && explicitRuntimeFlags.plannerBootstrap === 'disabled'
      && explicitRuntimeFlags.queueAuthority === 'vtr-transition-scheduler'
      && explicitRuntimeFlags.restoredLegacyRows === '0'
      && explicitRuntimeFlags.productionPlanAuthority === 'vtr-reach-probe'
      && explicitRuntimeFlags.readyPolicy === 'fallback'
      && explicitRuntimeFlags.readyPolicyProvider === 'deterministic'
      && explicitRuntimeFlags.readySystem2Provider === 'none'
    const missingCounters = Object.entries(zeroValues).filter(([, value]) => typeof value !== 'number' || !Number.isFinite(value) || value < 0).map(([key]) => key)
    const nonzeroCounters = Object.entries(zeroValues).filter(([, value]) => Number(value) !== 0).map(([key, value]) => ({ key, value }))
    if (missingOfflineBindings.length) incomplete('policy:offline-profile', 'required offline-policy/fallback evidence fields are absent', { missing: missingOfflineBindings, observed: offlineBindings })
    else if (!explicitlyOffline) fail('policy:offline-profile', 'no-LLM configuration conflicts with the required explicit offline policy and no-silent-fallback boundary', { observed: offlineBindings })
    else if (!runtimeFlagsMatch && missingRuntimeFlags.length) incomplete('policy:offline-profile', 'runtime VTR probe/configuration markers do not provide explicit no-LLM and empty-queue provenance', { missing: missingRuntimeFlags, observed: explicitRuntimeFlags })
    else if (!runtimeFlagsMatch) fail('policy:offline-profile', 'runtime VTR probe/configuration markers conflict with the manifest no-LLM policy', { expected: { BUDDY_POLICY: policy.BUDDY_POLICY, BUDDY_SYSTEM2: policy.BUDDY_SYSTEM2 }, observed: explicitRuntimeFlags })
    else pass('policy:offline-profile', { configuredPolicy: policy.BUDDY_POLICY, effectiveJev: jev, effectiveSystem2: system2, runtime: explicitRuntimeFlags })
    if (missingModelJournals.length) incomplete('policy:provider-journals', 'raw Jev/System2 call and decision journals are missing or invalid', { journals: modelJournals })
    else if (nonEmptyModelJournals.length) fail('policy:provider-journals', 'Jev/System2 call or decision journals contain records during a no-LLM probe', { journals: nonEmptyModelJournals })
    else pass('policy:provider-journals', { journals: modelJournals })
    if (missingCounters.length || missingModelJournals.length) incomplete('policy:zero-call-counters', 'no-LLM counters or raw provider journals are absent/incomplete', { missingCounters, missingJournals: missingModelJournals.map((entry) => entry.path) })
    else if (nonzeroCounters.length || anyModelDecision || nonEmptyModelJournals.length) fail('policy:zero-call-counters', 'model/provider activity or nonzero call counters occurred during no-LLM probe', { nonzero: nonzeroCounters, modelActivityRows: modelActivityRows.map((row) => row.message), modelActivityLogLines, journals: nonEmptyModelJournals })
    else pass('policy:zero-call-counters', { counters: zeroValues, scannedEventRows: events.length, scannedRunnerLogLines: botLog.split(/\r?\n/).length, emptyModelJournals: modelJournals.map((entry) => entry.path) })

    const allRunMessages = `${events.map((row) => String(row?.message ?? '')).join('\n')}\n${botLog}`
    const ladderAuthorityPattern = /SYSTEM2_PLAN_APPLIED|ROOT_GOAL_PROJECTED|LADDER_[A-Z0-9_]*(?:APPLIED|SELECTED|PROJECTED)|RUNGS?_[A-Z0-9_]*(?:APPLIED|SELECTED|PROJECTED)|productionPlanAuthority=(?:legacy|ladder|system2)/i
    const ladderAuthorityMarkers = allRunMessages.split(/\r?\n/).filter((line) => ladderAuthorityPattern.test(line))
    const passiveLadderRows = eventMessage(events, 'LADDER_PREREQ').length + (botLog.match(/\bLADDER_PREREQ\b/g) ?? []).length
    const probeConfiguredLine = probeConfiguredLines[0] ?? null
    const vtrAuthorityReadyLine = vtrAuthorityReadyLines[0] ?? null
    const ladderModeIsObserver = Boolean(probeConfiguredLine?.includes('compatibilityLadder=observer-only') && probeConfiguredLine.includes('plannerBootstrap=disabled') && vtrAuthorityReadyLine)
    if (ladderAuthorityMarkers.length) fail('authority:ladder-not-applied', 'raw runner evidence contains a marker that assigns WHAT selection to a ladder/System2 authority', { markers: ladderAuthorityMarkers })
    else if (!ladderModeIsObserver) incomplete('authority:ladder-not-applied', 'raw configuration/GENERATION_READY logs do not bind production authority to VTR with ladder observer-only mode', { hasProbeConfig: Boolean(probeConfiguredLine), hasVtrAuthorityReady: Boolean(vtrAuthorityReadyLine) })
    else pass('authority:ladder-not-applied', { productionAuthority: 'vtr-reach-probe', passiveLadderPrereqEvents: passiveLadderRows, ladderMode: 'observer-only', compatibilityRungMetadataPresent: /\brung(?:Index|Id)=/.test(vtrAuthorityReadyLine) })

    const terminalAt = Date.parse(outcomes[0]?.ts)
    if (Number.isFinite(terminalAt) && terminalAt <= times.shutdownAt) pass('run:terminal-before-shutdown', { terminalAt: outcomes[0].ts, shutdownAt: run.shutdownAt })
    else fail('run:terminal-before-shutdown', 'terminal outcome is absent, invalidly timed, or after shutdown')

    const worldTarget = transition.witness?.target
    const witnessRegionPath = witnessRegionRelativePath(worldTarget)
    if (witnessRegionPath === null) {
      incomplete('world:witness-plane', 'committed witness is absent or does not contain integer block coordinates')
      incomplete('required:world-witness-region', 'cannot derive the coordinate-specific MCA region without committed integer witness coordinates')
    } else {
      if (listing.files.includes(witnessRegionPath)) pass('required:world-witness-region', { path: witnessRegionPath })
      else incomplete(`required:${witnessRegionPath}`, 'MCA region containing the committed witness/support coordinates is absent', { witness: worldTarget })

      const plane = await inspectWitnessPlane(archive, listing.files, worldTarget)
      if (plane.status === 'INCOMPLETE') incomplete('world:witness-plane', plane.reason, { expectedRegion: plane.relativePath, witness: worldTarget })
      else {
        const rawSourceNames = transition.desiredPredicate?.proposition?.sourceNames
        const sourceNames = Array.isArray(rawSourceNames) ? [...new Set(rawSourceNames.map(normalizedBlockName).filter(Boolean))] : []
        const predicateItem = normalizedBlockName(transition.desiredPredicate?.proposition?.item)
        const missionItem = normalizedBlockName(probe.mission?.item)
        const expectedBlocks = sourceNames.length > 0 ? sourceNames : [predicateItem].filter(Boolean)
        if (missionItem === null || predicateItem === null) incomplete('world:witness-resource-binding', 'Mission or committed Reach predicate item is absent', { missionItem, predicateItem, sourceNames: expectedBlocks })
        else if (missionItem !== predicateItem) fail('world:witness-resource-binding', 'Mission item differs from the committed Reach predicate item', { missionItem, predicateItem, sourceNames: expectedBlocks })
        else pass('world:witness-resource-binding', { missionItem, predicateItem, sourceNames: expectedBlocks })

        const witnessBlock = normalizedBlockName(plane.witnessBlock)
        if (!expectedBlocks.includes(witnessBlock)) fail('world:witness-block', 'saved world does not contain a committed source name at the witness coordinates', { expected: expectedBlocks, observed: plane.witnessBlock, target: worldTarget, region: plane.relativePath })
        else pass('world:witness-block', { block: plane.witnessBlock, target: worldTarget, region: plane.relativePath })
        if (!plane.supportBlock || ['air', 'cave_air', 'void_air'].includes(normalizedBlockName(plane.supportBlock))) fail('world:witness-support', 'saved world lacks a solid support block beneath the witness', { observed: plane.supportBlock, position: { x: worldTarget.x, y: worldTarget.y - 1, z: worldTarget.z }, region: plane.relativePath })
        else pass('world:witness-support', { block: plane.supportBlock, position: { x: worldTarget.x, y: worldTarget.y - 1, z: worldTarget.z }, region: plane.relativePath })
      }
    }

    if (!RUN_ID_RE.test(String(runId)) || !fixtureCommands.length) incomplete('fixture:run-scoped', 'fixture command log is empty or runId is invalid')
    else {
      const witness = transition.witness?.target
      const fixtureSetup = inspectFixtureWitnessSetup({
        fixtureCommands,
        missionItem: probe.mission?.item,
        desiredPredicate: transition.desiredPredicate,
        witness,
      })
      if (fixtureSetup.status === 'PASS') pass('fixture:relative-witness-setup', { witness: transition.witness.witnessId, ...fixtureSetup })
      else if (fixtureSetup.status === 'FAIL') fail('fixture:relative-witness-setup', fixtureSetup.reason, fixtureSetup)
      else incomplete('fixture:relative-witness-setup', fixtureSetup.reason, fixtureSetup)
      const rejectedCommands = fixtureCommands.filter((row) => /Rejected:/i.test(row.result ?? '')).length
      pass('fixture:operator-command-journal', { recordedCommands: fixtureCommands.length, rejectedNoMutationAttempts: rejectedCommands })
    }
  }

  // Capability evidence is not the entire migration milestone. These two
  // run-scoped proofs are intentionally separate from a no-LLM mechanics probe.
  const fullMilestoneFiles = ['proofs/no-double-authority.json', 'comparison/legacy-baseline.json']
  const expectedLiveSourceSha = probe?.source?.commit
  for (const path of fullMilestoneFiles) {
    if (!listing.files.includes(path)) incomplete(`milestone:${path}`, 'full P0 acceptance requires this separate proof artifact')
    else {
      try {
        const proof = readJson(archive, path)
        if (path.endsWith('no-double-authority.json')) {
          if (typeof proof.sourceSha !== 'string' || !SHA_RE.test(proof.sourceSha)) incomplete(`milestone:${path}`, 'no-double-authority proof does not bind a full source SHA')
          else if (typeof expectedLiveSourceSha !== 'string' || !SHA_RE.test(expectedLiveSourceSha)) incomplete(`milestone:${path}`, 'live Transition source SHA is unavailable for binding the no-double-authority test')
          else if (proof.sourceSha.toLowerCase() !== expectedLiveSourceSha.toLowerCase()) fail(`milestone:${path}`, 'no-double-authority proof source SHA differs from the live Transition source', { expectedSourceSha: expectedLiveSourceSha, observedSourceSha: proof.sourceSha })
          else if (proof.result === 'PASS' && proof.legacyActuationCount === 0 && proof.vtrActuationCount > 0) pass(`milestone:${path}`, { sourceSha: proof.sourceSha, vtrActuationCount: proof.vtrActuationCount })
          else fail(`milestone:${path}`, 'no-double-authority proof is malformed or failed', { result: proof.result ?? null })
        } else if (proof.schema === 'vtr-reach-fixture-comparison/v2') {
          const legacySha = proof.lineage?.legacy?.sourceSha
          const vtrSha = proof.lineage?.vtr?.sourceSha
          if (typeof vtrSha !== 'string' || !SHA_RE.test(vtrSha)) incomplete(`milestone:${path}`, 'comparison artifact does not bind a full VTR source SHA')
          else if (typeof expectedLiveSourceSha !== 'string' || !SHA_RE.test(expectedLiveSourceSha)) incomplete(`milestone:${path}`, 'live Transition source SHA is unavailable for binding the comparison artifact')
          else if (vtrSha.toLowerCase() !== expectedLiveSourceSha.toLowerCase()) fail(`milestone:${path}`, 'comparison artifact VTR source SHA differs from the live Transition source', { expectedSourceSha: expectedLiveSourceSha, observedSourceSha: vtrSha })
          else if (typeof legacySha !== 'string' || !SHA_RE.test(legacySha)) incomplete(`milestone:${path}`, 'comparison artifact does not bind a full baseline source SHA')
          else if (proof.comparisonStatus === 'PASS' && (proof.alignment?.missionInput !== 'PASS' || proof.alignment?.fixture !== 'PASS' || proof.alignment?.environment !== 'PASS')) fail(`milestone:${path}`, 'comparison reports PASS while one or more structured alignment dimensions are not PASS', { alignment: proof.alignment ?? null })
          else if (proof.comparisonStatus === 'NOT_COMPARABLE') incomplete(`milestone:${path}`, 'comparison reports mission or fixture mismatch', { comparisonStatus: proof.comparisonStatus, alignment: proof.alignment ?? null })
          else if (proof.comparisonStatus !== 'PASS' || proof.alignment?.missionInput !== 'PASS' || proof.alignment?.fixture !== 'PASS' || proof.alignment?.environment !== 'PASS') incomplete(`milestone:${path}`, 'comparison does not establish exact structured Mission, fixture, and environment alignment', { comparisonStatus: proof.comparisonStatus ?? null, alignment: proof.alignment ?? null })
          else if (proof.evidenceClass !== 'summary-only' || proof.acceptanceEligible !== false || proof.acceptanceStatus !== 'NOT_ASSESSED_SUMMARY_ONLY') fail(`milestone:${path}`, 'comparator artifact misrepresents its summary-only input as raw/acceptance evidence', { evidenceClass: proof.evidenceClass ?? null, acceptanceEligible: proof.acceptanceEligible ?? null, acceptanceStatus: proof.acceptanceStatus ?? null })
          else incomplete(`milestone:${path}`, 'comparator schema reports structured alignment only; it does not archive raw comparison events and cannot qualify as migration acceptance', { comparisonStatus: proof.comparisonStatus, alignment: proof.alignment, legacySourceSha: legacySha, vtrSourceSha: vtrSha })
        } else incomplete(`milestone:${path}`, 'comparison artifact does not use vtr-reach-fixture-comparison/v2; old wrapper schemas are not acceptance evidence', { schema: proof.schema ?? null })
      } catch (error) { fail(`milestone:${path}`, error.message) }
    }
  }

  const failed = checks.some((check) => check.status === CHECK_STATUS.FAIL)
  const missing = checks.some((check) => check.status === CHECK_STATUS.INCOMPLETE)
  const status = failed ? 'FAIL' : missing ? 'INCOMPLETE' : 'PASS'
  const counts = Object.fromEntries(Object.values(CHECK_STATUS).map((value) => [value.toLowerCase(), checks.filter((check) => check.status === value).length]))
  return {
    schema: 'vtr-reach-evidence-validation/v1',
    status,
    archive,
    exactSourceCheckout: repo,
    probeStatus: failed ? 'FAIL' : missing ? 'INCOMPLETE' : 'PASS',
    migrationMilestoneStatus: status,
    counts,
    checks,
  }
}

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(error.message)
    console.error(HELP)
    process.exit(EXIT.USAGE)
  }
  if (args.help) {
    console.log(HELP)
    process.exit(EXIT.PASS)
  }
  if (!args.archive) {
    console.error('--archive is required')
    console.error(HELP)
    process.exit(EXIT.USAGE)
  }
  const archive = resolve(args.archive)
  const repo = args.repo ? resolve(args.repo) : null
  if (!existsSync(archive) || !lstatSync(archive).isDirectory()) {
    console.error(`archive directory does not exist: ${archive}`)
    process.exit(EXIT.USAGE)
  }
  if (repo && (!existsSync(repo) || !lstatSync(repo).isDirectory())) {
    console.error(`repo directory does not exist: ${repo}`)
    process.exit(EXIT.USAGE)
  }
  const report = await validate(archive, repo)
  console.log(JSON.stringify(report, null, 2))
  process.exit(EXIT[report.status] ?? EXIT.FAIL)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
