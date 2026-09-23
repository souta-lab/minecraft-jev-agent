#!/usr/bin/env bun
// clean-run-environment: the CHECKED-IN descriptor for one clean M3 acceptance
// run, plus the validator that decides whether a descriptor is allowed to
// authorise one.
//
// Why this exists
// ---------------
// The operator requirement is that the FINAL M3 PASS is proved on a NEW SEED /
// NEW WORLD with NO assists (`keepInventory` and friends). The existing stack
// cannot express that: `tools/m3-gate.mjs` decides `nether_reached` +
// `ender_eye>=12` + model authority, `tools/milestone-run-artifact.mjs` records
// the operator environment verbatim, and `tools/m3-acceptance-bundle.mjs`
// composes them - none of them asks whether the world itself was a clean world.
// The live world (`level-name=world`, `level-seed=2024`, `keepInventory=true`,
// operator grants/summons/terrain edits) can therefore PASS the M3 gate and
// still be worthless as M3 evidence.
//
// This module is the missing question, and it is deliberately SEPARATE:
//   * it never re-judges a milestone (no gate predicate is re-implemented here);
//   * it never upgrades a verdict (a clean descriptor cannot turn UNKNOWN into
//     PASS, and a clean run still needs the canonical gate's own PASS);
//   * it is DATA-DRIVEN: the descriptor states the expected clean world, and the
//     validator only checks that the statement is (a) complete, (b) free of
//     assists, and (c) not contradicted by the run's own evidence.
//
// The descriptor is ALSO a valid `--environment <json>` record for
// `tools/milestone-run-artifact.mjs` / `tools/m3-acceptance-bundle.mjs`
// (`readEnvironmentFile` reads `values` / `worldChanges`), so ONE file is the
// operator's environment record and the clean-run premise at the same time.
//
// Verdicts
//   CLEAN      every required condition PASS: this descriptor may authorise a
//              clean run.
//   NOT_CLEAN  at least one required condition FAIL: an assist was declared, the
//              world is reused, the SHA/seed is not frozen, or the run's own
//              evidence contradicts the declaration.
//   UNKNOWN    an input is missing/unreadable; nothing is assumed.
// The clean-run question is answered ONLY here; `CLEAN` is a premise, never a
// milestone verdict.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const RECORD = 'clean-run-environment'
export const SCHEMA_VERSION = 1
export const CHECK_RECORD = 'clean-run-environment-check'

/**
 * Level names this harness must NEVER write into or reuse. They are the live
 * world's three dimensions; a clean run gets a name that cannot collide with
 * them (see `LEVEL_NAME_RE` + the `world` prefix rule).
 */
export const PROTECTED_LEVEL_NAMES = Object.freeze(['world', 'world_nether', 'world_the_end'])

/** A level name that is safe to create: lowercase, no path separators, <= 32 chars. */
export const LEVEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/

/** Git object name (SHA-1 hex). A frozen run SHA is 40 hex chars. */
export const SHA_RE = /^[0-9a-f]{40}$/

/** A Minecraft version string such as `1.21.11`. */
export const VERSION_RE = /^\d+\.\d+(\.\d+)?$/

/**
 * The gamerules whose NON-DEFAULT value would most directly fake an M3 run. The
 * descriptor must state every key below explicitly (omission is a FAIL, not a
 * default), and it must justify every rule it declares - the full rule set of a
 * build is DATA (`values.gamerules` + `cleanRun.gamerulePolicy.defaults`), not a
 * list baked into this file.
 *
 * Names are the 1.21.11 gamerule ids (snake_case), verified from the server's own
 * `level.dat` and from `GameRules.<clinit>` in both the running Leaf jar and the
 * pure vanilla jar by the measurement recorded in
 * a local read-only measurement (gitignored `runs/m3-clean-measure/`, re-derivable
 * from the named jar + class). Legacy camelCase names
 * (`keepInventory`, `doDaylightCycle`, ...) are accepted as ALIASES on the run
 * evidence side only (see GAMERULE_ALIASES) so an old log marker cannot hide a
 * deviation behind a naming difference.
 */
export const MANDATORY_ASSIST_RULES = Object.freeze({
  keep_inventory: 'items survive death; the body never re-acquires a lost kit. PROVED ON in the live world (LADDER_INVENTORY_SETTLE reason=death itemCount=27 with the diamond_sword surviving), so it is the assist this harness exists to exclude.',
  advance_time: 'false pins the overworld clock (the live world runs it false). Spawn timing, enderman behaviour and visibility all change with the day/night cycle.',
  spawn_mobs: 'false suppresses natural mob spawning, so there are no endermen (pearls) and no blazes (rods) - the two inputs of M3.',
  spawn_monsters: 'false suppresses hostile spawning specifically; with M3 built on hostile-mob drops this is the single most load-bearing spawn rule.',
  mob_drops: 'false removes mob drops, i.e. exactly the ender pearls and blaze rods the milestone is made of.',
  block_drops: 'false removes block drops (obsidian, flint, wood, stone); the whole M2->M3 material chain assumes blocks drop items.',
  ender_pearls_vanish_on_death: 'false lets the body keep its ender pearls through a death - a direct assist towards the 12-eye predicate.',
  immediate_respawn: 'true removes the death screen/respawn delay; the run must pay the normal cost of dying.',
  fall_damage: 'false makes the most common embodied failure (a fall) free, removing the survival pressure the acceptance proves.',
  natural_health_regeneration: 'false removes passive healing; a deviation (harder or easier) must never enter the acceptance world silently.',
  lava_source_conversion: 'true creates infinite lava sources - a free obsidian/cobblestone factory, directly assisting the M2->M3 chain.',
  players_nether_portal_default_delay: 'a shortened portal delay makes Nether transit faster than the vanilla rule - a direct assist to the M3 route.',
  random_tick_speed: 'any other value changes crop growth, fire spread, ice/snow melt and leaf decay - it rewrites world physics for the run.',
})

/** The gamerule keys the descriptor MUST state explicitly. */
export const REQUIRED_GAMERULES = Object.freeze(Object.keys(MANDATORY_ASSIST_RULES))

/**
 * server.properties / server-config values that are not gamerules but would
 * equally assist (or break) a clean M3 run. `allowed` is the clean set.
 */
export const REQUIRED_SERVER_CONFIG = Object.freeze({
  levelType: Object.freeze({ allowed: ['minecraft:normal'], why: 'a flat/amplified/large-biomes world is a tuned world: flat removes terrain entirely, the others change resource distribution.' }),
  gamemode: Object.freeze({ allowed: ['survival'], why: 'creative/spectator would grant flight and instant break - the strongest possible assist.' }),
  forceGamemode: Object.freeze({ allowed: [false], why: 'true forces every joining player into the server gamemode, i.e. it can silently re-tune the body.' }),
  hardcore: Object.freeze({ allowed: [false], why: 'hardcore makes death terminal for the world; it also changes the intended run contract and risks destroying evidence.' }),
  bonusChest: Object.freeze({ allowed: [false], why: 'a bonus chest is literally granted items at world start.' }),
  allowCheats: Object.freeze({ allowed: [false], why: 'command access is the generic assist: /give, /summon, /tp, /effect. The live world has already been shaped with commands; a clean run must not have them.' }),
  generateStructures: Object.freeze({ allowed: [true], why: 'false removes fortresses (blaze rods) and strongholds - it makes M3 impossible rather than clean.' }),
  spawnAnimals: Object.freeze({ allowed: [true], why: 'false removes passive mobs (food/leather); the world must be a normal world.' }),
  botOperator: Object.freeze({ allowed: [false], why: 'an opped body can run commands as itself; the acceptance bot must have no command authority.' }),
  enableCommandBlock: Object.freeze({ allowed: [false], why: 'command blocks are a persistent automation/intervention surface inside the world.' }),
  pvp: Object.freeze({ allowed: [true], why: 'a non-default PvP rule is a server-mechanics change (and the body is the only player).' }),
  allowNether: Object.freeze({ allowed: [true], why: 'false removes the Nether entirely - M3 is defined by reaching it.' }),
  allowFlight: Object.freeze({ allowed: [false], why: 'true lets a client fly without being kicked (the live world runs allow-flight=true); the vanilla default is false.' }),
  spawnProtection: Object.freeze({ allowed: [0], why: 'non-zero spawn protection forbids non-operator block breaking near the world spawn, i.e. it can silently forbid the body first actions (the live world runs 0).' }),
  whiteList: Object.freeze({ allowed: [false], why: 'an enabled white list would keep the bot out of the world entirely: a hard prerequisite, not an assist.' }),
})

/** Non-gamerule config keys whose CLEAN value is a specific string, not a boolean. */
export const REQUIRED_SERVER_CONFIG_STRINGS = Object.freeze({
  serverVersion: Object.freeze({ re: VERSION_RE, why: 'the acceptance run must state the exact Minecraft version it was run on.' }),
  serverId: Object.freeze({ re: /^[^\s]+:\d+$/, why: 'the host:port the resident connects to is part of the world identity (worldKey.serverId).' }),
  serverImplementation: Object.freeze({ re: /^[^\s]+$/, why: 'the exact server build (jar) is part of the run environment.' }),
})

/** The assist declarations the descriptor must make, each of which must be EMPTY. */
export const ASSIST_DECLARATIONS = Object.freeze([
  'grantedItems',
  'summonedMobs',
  'prebuiltStructures',
  'operatorWorldEdits',
])

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function condition({ id, verdict, reason = null, required = true, detail = null }) {
  return { id, verdict, required: required === true, reason, detail }
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Read + parse a descriptor. Never throws: a bad file is an UNKNOWN input. */
export function loadCleanEnvironment(path) {
  if (typeof path !== 'string' || path === '') return { path: null, sha256: null, document: null, text: null, error: 'no_path' }
  if (!existsSync(path)) return { path, sha256: null, document: null, text: null, error: 'file_not_found' }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (thrown) {
    return { path, sha256: null, document: null, text: null, error: `read_failed ${thrown instanceof Error ? thrown.message : String(thrown)}` }
  }
  try {
    return { path, sha256: sha256Text(text), document: JSON.parse(text), text, error: null, mtime: statSync(path).mtime.toISOString() }
  } catch (thrown) {
    return { path, sha256: sha256Text(text), document: null, text, error: `parse_failed ${thrown instanceof Error ? thrown.message : String(thrown)}` }
  }
}

/** The value of a dotted path, or undefined. */
export function readPath(object, dotted) {
  let cursor = object
  for (const part of String(dotted).split('.')) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** The live world's three directories for a level name (Bukkit/Paper layout). */
export function worldDirNames(levelName) {
  return [String(levelName), `${String(levelName)}_nether`, `${String(levelName)}_the_end`]
}

/**
 * Is this level name already GENERATED (has a `level.dat`) under `container`?
 * A directory that only holds staged files (a datapack written by
 * clean-run-prepare) is `staged`, not `generated`: the server still has to
 * create the world. An absent container is reported as unreadable, which can
 * never be mistaken for "the world exists".
 */
/**
 * Does this world directory already hold world data? Mirrors the server's own
 * `hasWorldData()`: `level.dat` OR `level.dat_old` (a crash-recovered world has
 * only the latter, and regenerating level data in place is NOT a fresh world).
 */
export function worldDataExists(worldDir) {
  return existsSync(join(worldDir, 'level.dat')) || existsSync(join(worldDir, 'level.dat_old'))
}

export function scanWorldContainer(containerPath, levelName) {
  const out = { containerReadable: false, generated: [], staged: [], scanned: [] }
  if (typeof containerPath !== 'string' || containerPath === '' || !existsSync(containerPath)) return out
  out.containerReadable = true
  if (typeof levelName !== 'string' || levelName === '') return out
  for (const dir of worldDirNames(levelName)) {
    const path = join(containerPath, dir)
    if (!existsSync(path)) continue
    out.scanned.push(dir)
    if (worldDataExists(path)) out.generated.push(dir)
    else out.staged.push(dir)
  }
  return out
}

/**
 * The worlds a clean level name must not collide with. Returns the offending
 * names, empty when the name is safe by construction.
 */
export function levelNameProblems(levelName, previousLevelName = null) {
  const problems = []
  if (typeof levelName !== 'string' || levelName === '') return ['missing']
  if (!LEVEL_NAME_RE.test(levelName)) problems.push('shape_invalid')
  if (PROTECTED_LEVEL_NAMES.includes(levelName)) problems.push('protected_level_name')
  if (levelName.startsWith('world')) problems.push('world_prefix_namespace')
  if (previousLevelName !== null && levelName === previousLevelName) problems.push('same_as_previous_world')
  return problems
}

/** Seeds a clean run must not reuse: the live world's seed, empty, or `0`. */
export function seedProblems(levelSeed, previousLevelSeed = null) {
  const problems = []
  if (typeof levelSeed !== 'string' || levelSeed.trim() === '') return ['missing']
  const normalized = levelSeed.trim()
  if (normalized === '0') problems.push('zero_seed')
  if (previousLevelSeed !== null && normalized === String(previousLevelSeed).trim()) problems.push('same_as_previous_seed')
  return problems
}

// ---------------------------------------------------------------------------
// descriptor validation (the offline premise)
// ---------------------------------------------------------------------------

/**
 * Decide whether ONE descriptor may authorise a clean M3 run. Pure: it reads the
 * descriptor (+ optionally a world container to prove the target does not exist
 * yet) and never touches a run, a gate or the network.
 */
export function validateCleanEnvironment(document, { descriptorPath = null, descriptorSha256 = null, worldContainer = null } = {}) {
  const conditions = []
  const parseOk = isPlainObject(document)
  conditions.push(
    condition({
      id: 'descriptor.parse',
      verdict: parseOk ? (document.record === RECORD && document.schemaVersion === SCHEMA_VERSION ? 'PASS' : 'FAIL') : 'UNKNOWN',
      reason: parseOk
        ? document.record === RECORD && document.schemaVersion === SCHEMA_VERSION
          ? `record=${RECORD} schemaVersion=${SCHEMA_VERSION}`
          : `expected record=${RECORD} schemaVersion=${SCHEMA_VERSION}, got record=${String(document.record)} schemaVersion=${String(document.schemaVersion)}`
        : 'descriptor did not parse as a JSON object',
      detail: { path: descriptorPath, sha256: descriptorSha256 },
    }),
  )
  if (!parseOk) {
    return { record: CHECK_RECORD, schemaVersion: SCHEMA_VERSION, descriptorPath, descriptorSha256, status: 'UNKNOWN', conditions, assists: [], residual: ['the descriptor could not be read; nothing was assumed'] }
  }

  const cleanRun = isPlainObject(document.cleanRun) ? document.cleanRun : {}
  const values = isPlainObject(document.values) ? document.values : {}
  const gamerules = isPlainObject(values.gamerules) ? values.gamerules : {}
  const gamerulePolicy = isPlainObject(cleanRun.gamerulePolicy) ? cleanRun.gamerulePolicy : {}
  const defaults = isPlainObject(gamerulePolicy.defaults) ? gamerulePolicy.defaults : {}
  const previous = isPlainObject(cleanRun.previousWorld) ? cleanRun.previousWorld : {}
  const assists = isPlainObject(document.assists) ? document.assists : null

  // 1. the descriptor must be for THIS milestone
  conditions.push(
    condition({
      id: 'descriptor.milestone',
      verdict: cleanRun.milestone === 'M3' ? 'PASS' : 'FAIL',
      reason: cleanRun.milestone === 'M3' ? 'declared for M3' : `cleanRun.milestone must be "M3", got ${String(cleanRun.milestone)}`,
    }),
  )

  // 2. a NEW level name that cannot collide with the protected worlds
  const levelName = values.levelName
  const nameProblems = levelNameProblems(levelName, previous.levelName ?? null)
  conditions.push(
    condition({
      id: 'descriptor.levelNameNew',
      verdict: typeof levelName !== 'string' || levelName === '' ? 'FAIL' : nameProblems.length === 0 ? 'PASS' : 'FAIL',
      reason:
        typeof levelName !== 'string' || levelName === ''
          ? 'values.levelName is missing'
          : nameProblems.length === 0
            ? `levelName=${levelName} is a new, unprotected name (not ${PROTECTED_LEVEL_NAMES.join('/')}, not a world* prefix, not the previous world)`
            : `levelName=${levelName} refused: ${nameProblems.join(', ')}`,
      detail: { levelName: levelName ?? null, protected: PROTECTED_LEVEL_NAMES, previousLevelName: previous.levelName ?? null },
    }),
  )

  // 3. the target world must never have been GENERATED before. A directory that
  // only holds what clean-run-prepare staged (no level.dat) is still fresh; a
  // directory with a level.dat is a world that has already been played and can
  // never be a clean-run target.
  const containerPath = worldContainer ?? (typeof cleanRun.worldContainer === 'string' ? cleanRun.worldContainer : null)
  const scanned = scanWorldContainer(containerPath, levelName)
  conditions.push(
    condition({
      id: 'descriptor.worldNotGenerated',
      verdict: scanned.generated.length > 0 ? 'FAIL' : 'PASS',
      reason:
        scanned.generated.length > 0
          ? `world already GENERATED under ${String(containerPath)}: ${scanned.generated.join(', ')} (level.dat/level.dat_old exists, so the world has been booted and can never be a clean-run target)`
          : scanned.containerReadable
            ? `${worldDirNames(levelName ?? '').join(', ')} contain no level.dat under ${containerPath}${scanned.staged.length > 0 ? ` (staged by clean-run-prepare, not yet generated: ${scanned.staged.join(', ')})` : ''}`
            : `world container ${String(containerPath)} is absent, so no world can exist there yet (clean-run-prepare refuses to write into a missing root without --create-server-root)`,
      detail: { container: containerPath, ...scanned },
    }),
  )

  // 4. a NEW seed (not the live world's 2024, not empty, not 0)
  const levelSeed = values.levelSeed
  const seedIssues = seedProblems(levelSeed, previous.levelSeed ?? null)
  conditions.push(
    condition({
      id: 'descriptor.levelSeedNew',
      verdict: seedIssues.length === 0 ? 'PASS' : 'FAIL',
      reason:
        seedIssues.length === 0
          ? `levelSeed=${String(levelSeed)} differs from the previous world's seed (${String(previous.levelSeed)})`
          : `levelSeed=${String(levelSeed)} refused: ${seedIssues.join(', ')}`,
      detail: { levelSeed: levelSeed ?? null, previousLevelSeed: previous.levelSeed ?? null },
    }),
  )

  // 5. difficulty / mob spawning: the M3 premise needs hostile mobs
  const difficulty = values.difficulty
  conditions.push(
    condition({
      id: 'descriptor.difficulty',
      verdict: ['easy', 'normal', 'hard'].includes(difficulty) ? 'PASS' : 'FAIL',
      reason: ['easy', 'normal', 'hard'].includes(difficulty)
        ? `difficulty=${difficulty} (hostile mobs can spawn; peaceful is refused because M3 needs endermen and blazes)`
        : `difficulty=${String(difficulty)} refused: must be easy|normal|hard, never peaceful`,
    }),
  )
  conditions.push(
    condition({
      id: 'descriptor.mobSpawning',
      verdict: values.mobSpawning === true ? 'PASS' : 'FAIL',
      reason:
        values.mobSpawning === true
          ? 'hostile spawning is declared ON. NOTE: this build does NOT read the server.properties key `spawn-monsters` (0 occurrences in DedicatedServerProperties); the enforceable gate is the spawn_mobs / spawn_monsters GAMERULE, which descriptor.gamerulesClean checks'
          : `values.mobSpawning must be true, got ${String(values.mobSpawning)} (and it is only a declaration: this build gates hostile spawning on the spawn_mobs / spawn_monsters gamerule)`,
    }),
  )

  // 5b. gamerules are PER DIMENSION in this build (each level.dat owns its own
  // set; the live world proves it: keep_inventory=true everywhere while
  // advance_time=false only in the overworld). A clean run must assert the rules
  // in every dimension, because the M3 route dies in the Nether.
  const scope = isPlainObject(cleanRun.gameruleScope) ? cleanRun.gameruleScope : null
  const scopeDimensions = Array.isArray(scope?.dimensions) ? scope.dimensions : []
  const requiredDimensions = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end']
  const missingDimensions = requiredDimensions.filter((dimension) => !scopeDimensions.includes(dimension))
  conditions.push(
    condition({
      id: 'descriptor.gameruleScope',
      verdict: scope?.perDimension === true && missingDimensions.length === 0 ? 'PASS' : 'FAIL',
      reason:
        scope?.perDimension === true && missingDimensions.length === 0
          ? `gamerules are declared PER DIMENSION for ${scopeDimensions.join(', ')}; the staged datapack asserts every rule in all three (keep_inventory=false must hold in the Nether, where the M3 route dies)`
          : `cleanRun.gameruleScope must declare perDimension=true and all of ${requiredDimensions.join(', ')} (got perDimension=${String(scope?.perDimension)}, dimensions=${JSON.stringify(scopeDimensions)}); a single-dimension gamerule set can leave keep_inventory=true in the Nether and fake the run`,
      detail: { perDimension: scope?.perDimension ?? null, dimensions: scopeDimensions, missing: missingDimensions },
    }),
  )

  // 5c. the gamerule mechanism: since 1.21.9 a data pack must declare
  // min_format/max_format - a bare pack_format no longer declares support, so a
  // pack written that way can be rejected or ignored and the rules never set.
  const mechanism = isPlainObject(cleanRun.gameruleMechanism) ? cleanRun.gameruleMechanism : {}
  const datapackFormat = isPlainObject(mechanism.datapackFormat) ? mechanism.datapackFormat : null
  const legacyFormat = typeof mechanism.datapackPackFormat === 'number' ? mechanism.datapackPackFormat : null
  const formatShaped = datapackFormat !== null && datapackFormat.min !== undefined && datapackFormat.max !== undefined
  conditions.push(
    condition({
      id: 'descriptor.datapackFormat',
      verdict: formatShaped ? 'PASS' : datapackFormat === null && legacyFormat !== null ? 'FAIL' : 'UNKNOWN',
      required: datapackFormat !== null || legacyFormat !== null,
      reason: formatShaped
        ? `the gamerule datapack declares min_format=${JSON.stringify(datapackFormat.min)} max_format=${JSON.stringify(datapackFormat.max)} (1.21.9+ requires this pair; this build's data format is 94.1)`
        : datapackFormat === null && legacyFormat !== null
          ? `only the legacy datapackPackFormat=${legacyFormat} is set: since 1.21.9 a bare pack_format does not declare data-pack support, so the gamerule pack may be rejected or ignored and the rules never applied`
          : 'no datapackFormat is declared: the gamerule datapack is skipped and the console `gamerule` listing is the only mechanism',
      detail: { datapackFormat, legacyFormat },
    }),
  )

  // 6. the non-gamerule server config requirements
  const server = isPlainObject(values.server) ? values.server : {}
  const configFailures = []
  const configMissing = []
  for (const [key, rule] of Object.entries(REQUIRED_SERVER_CONFIG)) {
    if (server[key] === undefined) {
      configMissing.push(key)
      continue
    }
    if (!rule.allowed.includes(server[key])) configFailures.push(`${key}=${JSON.stringify(server[key])} (must be ${rule.allowed.map((entry) => JSON.stringify(entry)).join('|')})`)
  }
  for (const [key, rule] of Object.entries(REQUIRED_SERVER_CONFIG_STRINGS)) {
    if (typeof values[key] !== 'string' || !rule.re.test(values[key])) configFailures.push(`${key}=${JSON.stringify(values[key] ?? null)} (must match ${String(rule.re)})`)
  }
  conditions.push(
    condition({
      id: 'descriptor.serverConfig',
      verdict: configMissing.length > 0 ? 'FAIL' : configFailures.length === 0 ? 'PASS' : 'FAIL',
      reason:
        configMissing.length > 0
          ? `values.server is missing required keys: ${configMissing.join(', ')}`
          : configFailures.length === 0
            ? `all ${Object.keys(REQUIRED_SERVER_CONFIG).length} server-config requirements are at their clean values`
            : `server config refused: ${configFailures.join('; ')}`,
      detail: { server, missing: configMissing, failures: configFailures, requirements: REQUIRED_SERVER_CONFIG },
    }),
  )

  // 7. every assist-relevant gamerule stated explicitly (the mandatory subset,
  // plus whatever the descriptor itself declares as required for its version)
  const declaredRequired = Array.isArray(gamerulePolicy.requiredRules) ? gamerulePolicy.requiredRules.filter((rule) => typeof rule === 'string') : []
  const requiredRules = [...new Set([...REQUIRED_GAMERULES, ...declaredRequired])]
  const missingRules = requiredRules.filter((rule) => gamerules[rule] === undefined)
  conditions.push(
    condition({
      id: 'descriptor.gamerulesPresent',
      verdict: missingRules.length === 0 ? 'PASS' : 'FAIL',
      reason:
        missingRules.length === 0
          ? `all ${requiredRules.length} required gamerules are stated explicitly (${REQUIRED_GAMERULES.length} mandatory + ${declaredRequired.length} declared by the descriptor)`
          : `gamerules not stated (an omitted rule is not a default): ${missingRules.join(', ')}`,
      detail: { mandatory: REQUIRED_GAMERULES, declaredRequired, missing: missingRules },
    }),
  )

  // 8. every declared gamerule at its declared default, and keepInventory=false
  const deviations = []
  const unclassified = []
  for (const [rule, value] of Object.entries(gamerules)) {
    if (defaults[rule] === undefined) {
      unclassified.push(rule)
      continue
    }
    if (value !== defaults[rule]) deviations.push(`${rule}=${JSON.stringify(value)} (default ${JSON.stringify(defaults[rule])})`)
  }
  const keepInventoryExplicit = gamerules.keep_inventory === false
  conditions.push(
    condition({
      id: 'descriptor.gamerulesClean',
      verdict: deviations.length === 0 && keepInventoryExplicit ? 'PASS' : 'FAIL',
      reason:
        deviations.length === 0 && keepInventoryExplicit
          ? `every declared gamerule equals its declared default (${Object.keys(gamerules).length} rules, including keep_inventory=false)`
          : `gamerule assist(s) refused: ${[...(keepInventoryExplicit ? [] : ['keep_inventory is not explicitly false']), ...deviations].join('; ')}`,
      detail: { deviations, keepInventory: gamerules.keep_inventory ?? null, defaultCount: Object.keys(defaults).length, declaredCount: Object.keys(gamerules).length },
    }),
  )
  conditions.push(
    condition({
      id: 'descriptor.gamerulesClassified',
      verdict: unclassified.length === 0 ? 'PASS' : 'FAIL',
      reason:
        unclassified.length === 0
          ? 'every declared gamerule has a declared default, so every declared value was judged'
          : `declared gamerule(s) with NO declared default cannot be judged (fail closed): ${unclassified.join(', ')}`,
      detail: { unclassified },
    }),
  )

  // 8b. EVERY declared rule must be justified IN THE DESCRIPTOR (not only in
  // code), because the descriptor is the artifact a reviewer reads.
  const justifications = isPlainObject(gamerulePolicy.assistIfChanged) ? gamerulePolicy.assistIfChanged : {}
  const unjustified = Object.keys(gamerules).filter((rule) => typeof justifications[rule] !== 'string' || justifications[rule].trim() === '')
  conditions.push(
    condition({
      id: 'descriptor.gameruleJustifications',
      verdict: unjustified.length === 0 ? 'PASS' : 'FAIL',
      reason:
        unjustified.length === 0
          ? `all ${Object.keys(gamerules).length} declared gamerules carry a justification in cleanRun.gamerulePolicy.assistIfChanged`
          : `declared gamerule(s) without a justification in cleanRun.gamerulePolicy.assistIfChanged: ${unjustified.join(', ')}`,
      detail: { missing: unjustified, mandatory: REQUIRED_GAMERULES },
    }),
  )

  // 9. no assists declared
  const declaredAssists = []
  const missingDeclarations = []
  for (const key of ASSIST_DECLARATIONS) {
    if (assists === null || !Array.isArray(assists[key])) {
      missingDeclarations.push(key)
      continue
    }
    if (assists[key].length > 0) declaredAssists.push(`${key} (${assists[key].length}): ${JSON.stringify(assists[key]).slice(0, 300)}`)
  }
  conditions.push(
    condition({
      id: 'descriptor.noAssists',
      verdict: missingDeclarations.length > 0 || declaredAssists.length > 0 ? 'FAIL' : 'PASS',
      reason:
        missingDeclarations.length > 0
          ? `assists.${missingDeclarations.join('/')} must be present as empty arrays (absence is not a claim of none)`
          : declaredAssists.length === 0
            ? 'grantedItems / summonedMobs / prebuiltStructures / operatorWorldEdits are all declared EMPTY'
            : `assists declared: ${declaredAssists.join('; ')}`,
      detail: { declared: assists, empty: declaredAssists.length === 0 },
    }),
  )

  // 10. no world changes recorded (the artifact carries this verbatim)
  const worldChanges = Array.isArray(document.worldChanges) ? document.worldChanges : []
  conditions.push(
    condition({
      id: 'descriptor.noWorldChanges',
      verdict: worldChanges.length === 0 ? 'PASS' : 'FAIL',
      reason:
        worldChanges.length === 0
          ? 'worldChanges is empty: no post-creation environment change belongs to this world'
          : `${worldChanges.length} world change(s) recorded; a clean run must have none`,
      detail: { worldChanges },
    }),
  )

  // 11. the exact source SHA must be FROZEN (a template can never authorise a run)
  const sourceShaState = isPlainObject(cleanRun.sourceSha) ? cleanRun.sourceSha.state : null
  const sourceSha = values.sourceSha
  conditions.push(
    condition({
      id: 'descriptor.sourceSha',
      verdict: sourceShaState === 'FROZEN' && typeof sourceSha === 'string' && SHA_RE.test(sourceSha) ? 'PASS' : 'FAIL',
      reason:
        sourceShaState === 'FROZEN' && typeof sourceSha === 'string' && SHA_RE.test(sourceSha)
          ? `sourceSha=${sourceSha} is frozen; the run must boot EXACTLY this commit`
          : `sourceSha is not frozen (state=${String(sourceShaState)}, value=${JSON.stringify(sourceSha ?? null)}); freeze it with clean-run-prepare --source-sha <40-hex> (or --root <frozen tree>) and re-validate — a stale/placeholder pin must never authorise a run`,
      detail: { sourceSha: sourceSha ?? null, state: sourceShaState, policy: isPlainObject(cleanRun.sourceSha) ? cleanRun.sourceSha.policy ?? null : null },
    }),
  )

  const failed = conditions.filter((entry) => entry.required && entry.verdict === 'FAIL')
  const unknown = conditions.filter((entry) => entry.required && entry.verdict === 'UNKNOWN')
  const status = failed.length > 0 ? 'NOT_CLEAN' : unknown.length > 0 ? 'UNKNOWN' : 'CLEAN'
  return {
    record: CHECK_RECORD,
    schemaVersion: SCHEMA_VERSION,
    descriptorPath,
    descriptorSha256,
    generatedAt: new Date().toISOString(),
    status,
    exitCode: status === 'NOT_CLEAN' ? 1 : status === 'UNKNOWN' ? 2 : 0,
    milestone: cleanRun.milestone ?? null,
    levelName: levelName ?? null,
    levelSeed: levelSeed ?? null,
    conditions,
    failed: failed.map((entry) => entry.id),
    residual:
      status === 'CLEAN'
        ? ['CLEAN means the DESCRIPTOR is admissible: it still says nothing about whether the actual run obeyed it (that is what run-evidence conditions and the canonical M3 gate decide)']
        : ['a NOT_CLEAN/UNKNOWN descriptor must not be used as the environment record of an M3 acceptance bundle'],
  }
}

// ---------------------------------------------------------------------------
// run-evidence conditions (the descriptor against the run's own records)
// ---------------------------------------------------------------------------

/**
 * The run's OWN window inside a shared log: a `BOOT ... runId=R` opens R and the
 * next BOOT for another run closes it (the same boundary rule tools/m2-gate.mjs
 * uses). Lines before the first BOOT belong to no run and are excluded, so a
 * death that happened in a different run can never be attributed to this one.
 */
export function extractRunWindow(text, runId) {
  const out = []
  let active = null
  for (const line of String(text ?? '').split('\n')) {
    if (/\bBOOT\b(?!_)/.test(line)) {
      const match = /\brunId=(run-[A-Za-z0-9-]+)/.exec(line)
      if (match !== null) active = match[1]
    }
    if (active !== null && active === runId) out.push(line)
  }
  return out.join('\n')
}

/**
 * The run-scoped ENVIRONMENT marker the resident emits uses shorthand names for
 * a few rules (`advanceTime=false` is the live world's permanent night). They
 * must be normalised before comparison, otherwise an assisted run could hide
 * behind a naming difference - the exact silent-acceptance hole this module
 * exists to close.
 */
export const GAMERULE_ALIASES = Object.freeze({
  // legacy camelCase ids (pre-1.21.x names and the resident's shorthand)
  keepInventory: 'keep_inventory',
  doDaylightCycle: 'advance_time',
  advanceTime: 'advance_time',
  doWeatherCycle: 'advance_weather',
  advanceWeather: 'advance_weather',
  doMobSpawning: 'spawn_mobs',
  spawnMobs: 'spawn_mobs',
  spawnMonsters: 'spawn_monsters',
  doMobLoot: 'mob_drops',
  doTileDrops: 'block_drops',
  doEntityDrops: 'entity_drops',
  enderPearlsVanishOnDeath: 'ender_pearls_vanish_on_death',
  doImmediateRespawn: 'immediate_respawn',
  fallDamage: 'fall_damage',
  fireDamage: 'fire_damage',
  drowningDamage: 'drowning_damage',
  freezeDamage: 'freeze_damage',
  naturalRegeneration: 'natural_health_regeneration',
  mobGriefing: 'mob_griefing',
  doInsomnia: 'spawn_phantoms',
  doPatrolSpawning: 'spawn_patrols',
  doTraderSpawning: 'spawn_wandering_traders',
  doWardenSpawning: 'spawn_wardens',
  randomTickSpeed: 'random_tick_speed',
  spawnRadius: 'respawn_radius',
  playersSleepingPercentage: 'players_sleeping_percentage',
  doFireTick: 'fire_spread_radius_around_player',
  lavaSourceConversion: 'lava_source_conversion',
  waterSourceConversion: 'water_source_conversion',
  universalAnger: 'universal_anger',
  doLimitedCrafting: 'limited_crafting',
  commandBlocksEnabled: 'command_blocks_work',
  commandBlockOutput: 'command_block_output',
  maxCommandChainLength: 'max_command_sequence_length',
  maxEntityCramming: 'max_entity_cramming',
  spectatorsGenerateChunks: 'spectators_generate_chunks',
  globalSoundEvents: 'global_sound_events',
  projectilesCanBreakBlocks: 'projectiles_can_break_blocks',
  blockExplosionDropDecay: 'block_explosion_drop_decay',
  mobExplosionDropDecay: 'mob_explosion_drop_decay',
  tntExplosionDropDecay: 'tnt_explosion_drop_decay',
  snowAccumulationHeight: 'max_snow_accumulation_height',
  playersNetherPortalDefaultDelay: 'players_nether_portal_default_delay',
  playersNetherPortalCreativeDelay: 'players_nether_portal_creative_delay',
  announceAdvancements: 'show_advancement_messages',
  sendCommandFeedback: 'send_command_feedback',
  showDeathMessages: 'show_death_messages',
  logAdminCommands: 'log_admin_commands',
  forgiveDeadPlayers: 'forgive_dead_players',
  doVinesSpread: 'spread_vines',
  // separator spellings a marker might use
  'advance-time': 'advance_time',
  'spawn-mobs': 'spawn_mobs',
  'spawn-monsters': 'spawn_monsters',
  'keep-inventory': 'keep_inventory',
  'spawn-animals': 'spawn-animals',
})

/**
 * Canonical gamerule name for a marker key: legacy aliases are mapped, and a
 * namespaced id (`minecraft:keep_inventory`, the form 1.21.11 stores) loses its
 * namespace. Anything else is returned unchanged and reported as unclassified.
 */
export function canonicalGameruleKey(key) {
  const normalized = String(key).includes(':') ? String(key).split(':').pop() : String(key)
  return GAMERULE_ALIASES[normalized] ?? normalized
}

/** `LADDER_INVENTORY_SETTLE reason=death ... itemCount=N ... counts={...}` lines. */
export function parseInventorySettleLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!/LADDER_INVENTORY_SETTLE/.test(line)) continue
    if (!/\breason=death\b/.test(line)) continue
    const itemCount = /(?:^|\s)itemCount=(-?\d+)/.exec(line)
    const empty = /(?:^|\s)empty=(true|false)/.exec(line)
    const counts = /(?:^|\s)counts=(\{.*\})\s*$/.exec(line)
    out.push({
      line: line.trim().slice(0, 400),
      itemCount: itemCount === null ? null : Number(itemCount[1]),
      empty: empty === null ? null : empty[1] === 'true',
      counts: counts === null ? null : counts[1],
    })
  }
  return out
}

/** `DEATH ... itemsLost=N lostInventory={...}` lines. */
export function parseDeathLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!/\bDEATH\b/.test(line)) continue
    const itemsLost = /(?:^|\s)itemsLost=(-?\d+)/.exec(line)
    out.push({ line: line.trim().slice(0, 400), itemsLost: itemsLost === null ? null : Number(itemsLost[1]) })
  }
  return out
}

/**
 * Check a run's OWN records against a clean descriptor. `artifact` is the
 * `tools/milestone-run-artifact.mjs` document (from the bundle or from disk);
 * `logText` is the run-scoped log the artifact itself names
 * (`artifact.sources.logPath`), read by the caller so this stays pure.
 *
 * Nothing here is a milestone verdict: these conditions only ask whether the run
 * contradicts the clean-world premise.
 */
export function checkRunEvidence({ descriptor, artifact, logText = null, runId = null, descriptorPath = null, descriptorSha256 = null }) {
  const conditions = []
  const values = isPlainObject(descriptor?.values) ? descriptor.values : {}
  const cleanRun = isPlainObject(descriptor?.cleanRun) ? descriptor.cleanRun : {}
  const gamerules = isPlainObject(values.gamerules) ? values.gamerules : {}
  const defaults = isPlainObject(cleanRun.gamerulePolicy?.defaults) ? cleanRun.gamerulePolicy.defaults : {}
  const document = isPlainObject(artifact) ? artifact : null

  conditions.push(
    condition({
      id: 'run.artifactPresent',
      verdict: document === null ? 'UNKNOWN' : 'PASS',
      reason: document === null ? 'no run artifact document was provided; the run evidence cannot be checked' : `artifact record=${String(document.record)} schemaVersion=${String(document.schemaVersion)}`,
    }),
  )
  if (document === null) return conditions

  conditions.push(
    condition({
      id: 'run.scope',
      verdict: runId === null ? 'UNKNOWN' : document.runId === runId ? 'PASS' : 'FAIL',
      reason:
        runId === null
          ? 'no --run was given, so the artifact was not checked against an exact runId'
          : document.runId === runId
            ? `artifact is scoped to runId=${runId}`
            : `artifact runId=${String(document.runId)} does not match the requested runId=${runId}`,
      required: runId !== null,
    }),
  )

  // 0. the run must have consumed THIS descriptor as its environment record.
  // Without this the clean premise and the accepted run could be two different
  // files, which is exactly the silent-acceptance failure mode to prevent.
  const envFile = isPlainObject(document.environment?.environmentFile) ? document.environment.environmentFile : null
  const recordedPath = typeof envFile?.path === 'string' ? envFile.path : null
  const samePath = recordedPath !== null && descriptorPath !== null && resolve(recordedPath) === resolve(descriptorPath)
  const recordedValuesSha = envFile === null ? null : sha256Text(JSON.stringify(envFile.values ?? null))
  conditions.push(
    condition({
      id: 'run.environmentRecordIsThisDescriptor',
      verdict: recordedPath === null ? 'UNKNOWN' : samePath ? 'PASS' : 'FAIL',
      reason:
        recordedPath === null
          ? 'the artifact records no --environment file, so the run has no environment record to bind to this descriptor'
          : samePath
            ? `the artifact read its environment from ${recordedPath} (the same file this gate validated)`
            : `the artifact read its environment from ${recordedPath}, not from ${String(descriptorPath)}: the run was NOT judged against this descriptor`,
      detail: { recordedPath, descriptorPath, recordedValuesSha256: recordedValuesSha, descriptorSha256 },
    }),
  )

  // 1. the run must have booted the FROZEN sha
  const bootSha = document?.run?.boot?.sourceSha ?? null
  conditions.push(
    condition({
      id: 'run.bootSourceSha',
      verdict: bootSha === null ? 'UNKNOWN' : bootSha === values.sourceSha ? 'PASS' : 'FAIL',
      reason:
        bootSha === null
          ? 'the run has no BOOT sourceSha, so it cannot be attributed to the frozen tree'
          : bootSha === values.sourceSha
            ? `BOOT source=${bootSha} equals the descriptor's frozen sourceSha`
            : `BOOT source=${bootSha} != descriptor sourceSha=${String(values.sourceSha)}: the run did not boot the frozen tree`,
      detail: { boot: bootSha, descriptor: values.sourceSha ?? null },
    }),
  )

  // 2. the HOST acceptance record is the only attestation of level name + seed
  const acceptance = isPlainObject(document.acceptance) ? document.acceptance : {}
  const record = isPlainObject(acceptance.record) ? acceptance.record : null
  conditions.push(
    condition({
      id: 'run.acceptanceRecord',
      verdict: acceptance.present === true && record !== null ? 'PASS' : 'UNKNOWN',
      reason:
        acceptance.present === true && record !== null
          ? `HOST acceptance record present at ${String(acceptance.path)} (written by writeAcceptance(); it attests levelName + seed)`
          : `HOST acceptance-<runId>.json is absent (${String(acceptance.reason ?? 'acceptance_artifact_missing')}); levelName/seed cannot be attested from the run itself. Refresh it with the read-only control query \`acceptance\` before bundling.`,
      detail: { path: acceptance.path ?? null, reason: acceptance.reason ?? null },
    }),
  )
  conditions.push(
    condition({
      id: 'run.levelNameAttested',
      verdict: record === null ? 'UNKNOWN' : record.levelName === values.levelName ? 'PASS' : 'FAIL',
      reason:
        record === null
          ? 'no acceptance record, so the run world name is unattested'
          : record.levelName === values.levelName
            ? `acceptance.levelName=${String(record.levelName)} equals the descriptor's new world`
            : `acceptance.levelName=${String(record.levelName)} != descriptor levelName=${String(values.levelName)}: the run did not happen in the clean world`,
      detail: { attested: record?.levelName ?? null, descriptor: values.levelName ?? null },
    }),
  )
  conditions.push(
    condition({
      id: 'run.seedAttested',
      verdict: record === null ? 'UNKNOWN' : String(record.seed) === String(values.levelSeed) ? 'PASS' : 'FAIL',
      reason:
        record === null
          ? 'no acceptance record, so the run seed is unattested'
          : String(record.seed) === String(values.levelSeed)
            ? `acceptance.seed=${String(record.seed)} equals the descriptor's new seed`
            : `acceptance.seed=${String(record.seed)} != descriptor levelSeed=${String(values.levelSeed)}: the run did not happen in the new-seed world (NOTE: serverSeed() in agent-runner.mts reads the seed from the hard-coded path <server-root>/server.properties, so a clean world served from a DIFFERENT root would be reported with the wrong seed - keep the same root)`,
      detail: { attested: record?.seed ?? null, descriptor: values.levelSeed ?? null },
    }),
  )

  // 3. the artifact's environment facts must not contradict the descriptor
  const env = isPlainObject(document.environment) ? document.environment : {}
  for (const [id, key, expected] of [
    ['run.difficultyNotContradicted', 'difficulty', values.difficulty],
    ['run.mobSpawningNotContradicted', 'mobSpawning', values.mobSpawning],
  ]) {
    const fact = isPlainObject(env[key]) ? env[key] : null
    const runScoped = fact?.runScoped === true
    conditions.push(
      condition({
        id,
        verdict: fact === null ? 'UNKNOWN' : runScoped && fact.value !== expected ? 'FAIL' : 'PASS',
        reason:
          fact === null
            ? `no ${key} fact in the artifact's environment section`
            : runScoped && fact.value !== expected
              ? `run-scoped log fact ${key}=${JSON.stringify(fact.value)} contradicts the descriptor's ${JSON.stringify(expected)} (at ${String(fact.at)})`
              : `${key}=${JSON.stringify(fact.value)} from ${String(fact.source)}${runScoped ? ' (run-scoped)' : ' (operator record: the descriptor itself)'}`,
        detail: { fact },
        required: runScoped,
      }),
    )
  }
  const gameruleFact = isPlainObject(env.gamerules) ? env.gamerules : null
  const gameruleValue = isPlainObject(gameruleFact?.value) ? gameruleFact.value : null
  const gameruleContradictions = []
  const gameruleAliased = []
  const gameruleUnclassified = []
  if (gameruleValue !== null) {
    for (const [rawRule, value] of Object.entries(gameruleValue)) {
      const rule = canonicalGameruleKey(rawRule)
      if (rule !== rawRule) gameruleAliased.push(`${rawRule}->${rule}`)
      const known = Object.prototype.hasOwnProperty.call(gamerules, rule) || Object.prototype.hasOwnProperty.call(defaults, rule)
      if (!known) {
        gameruleUnclassified.push(`${rawRule}=${JSON.stringify(value)}`)
        continue
      }
      if (Object.prototype.hasOwnProperty.call(gamerules, rule) && value !== gamerules[rule]) gameruleContradictions.push(`${rule}=${JSON.stringify(value)} != declared clean value ${JSON.stringify(gamerules[rule])}`)
      if (Object.prototype.hasOwnProperty.call(defaults, rule) && value !== defaults[rule]) gameruleContradictions.push(`${rule}=${JSON.stringify(value)} deviates from the declared default ${JSON.stringify(defaults[rule])}`)
    }
  }
  conditions.push(
    condition({
      id: 'run.gamerulesNotContradicted',
      verdict: gameruleFact === null ? 'UNKNOWN' : gameruleContradictions.length === 0 ? 'PASS' : 'FAIL',
      reason:
        gameruleFact === null
          ? 'the run recorded no ENVIRONMENT/GAMERULE marker, so the gamerule values are operator-declared only (Mineflayer cannot read gamerules; the console `gamerule` output is the human verification)'
          : gameruleContradictions.length === 0
            ? `every run-scoped gamerule fact agrees with the descriptor (source=${String(gameruleFact.source)}${gameruleAliased.length === 0 ? '' : `; normalised ${gameruleAliased.join(', ')}`})`
            : `run-scoped gamerule fact contradicts the clean descriptor: ${gameruleContradictions.join('; ')}`,
      detail: { fact: gameruleFact, aliased: gameruleAliased, unclassified: gameruleUnclassified },
      required: gameruleFact !== null && gameruleFact.runScoped === true,
    }),
  )

  // 4. the artifact must record NO operator world change
  const worldChanges = env.worldChanges ?? null
  conditions.push(
    condition({
      id: 'run.noWorldChanges',
      verdict: worldChanges === null ? 'PASS' : 'FAIL',
      reason:
        worldChanges === null
          ? 'the artifact records no world/environment change for this run'
          : `the artifact records ${String(worldChanges.count)} world change(s) from ${String(worldChanges.source)}: ${JSON.stringify(worldChanges.changes).slice(0, 300)}`,
      detail: { worldChanges },
    }),
  )

  // 5. the body must have started with NOTHING (a fresh world hands out no kit)
  const boot = isPlainObject(document.inventory) ? document.inventory.boot : null
  const bootCounts = isPlainObject(boot?.counts) ? boot.counts : null
  const nonZero = bootCounts === null ? [] : Object.entries(bootCounts).filter(([, count]) => typeof count === 'number' && count > 0)
  conditions.push(
    condition({
      id: 'run.bootInventoryEmpty',
      verdict: bootCounts === null ? 'UNKNOWN' : nonZero.length === 0 ? 'PASS' : 'FAIL',
      reason:
        bootCounts === null
          ? 'the artifact has no boot inventory sample, so "the body started with nothing" is unproven'
          : nonZero.length === 0
            ? `the run's first inventory sample is empty (${String(boot?.source)} at ${String(boot?.ts)})`
            : `the run started with items it cannot have on a fresh world: ${nonZero.map(([item, count]) => `${item}x${count}`).join(', ')} (granted kit)`,
      detail: { boot },
    }),
  )

  // 6. behavioural keepInventory: a death settle that KEPT items proves the assist
  const settles = parseInventorySettleLines(logText)
  const kept = settles.filter((entry) => (entry.itemCount ?? 0) > 0 || entry.empty === false)
  const dropped = settles.filter((entry) => entry.itemCount === 0 || entry.empty === true)
  const deaths = parseDeathLines(logText)
  const losses = deaths.filter((entry) => (entry.itemsLost ?? 0) > 0)
  conditions.push(
    condition({
      id: 'run.keepInventoryBehaviour',
      verdict: logText === null ? 'UNKNOWN' : kept.length > 0 ? 'FAIL' : dropped.length > 0 || losses.length > 0 ? 'PASS' : 'UNKNOWN',
      reason:
        logText === null
          ? 'the run log was not readable, so death/keep-inventory behaviour could not be checked'
          : kept.length > 0
            ? `a death settle kept items (${kept[0].line}): the world behaves as keepInventory=true`
            : dropped.length > 0
              ? `a death settle recorded an empty inventory after death (${dropped[0].line}): keepInventory=false is behaviourally consistent`
              : losses.length > 0
                ? `a DEATH line recorded itemsLost=${String(losses[0].itemsLost)} (${losses[0].line}): items were dropped, so keepInventory=false is behaviourally consistent`
                : 'no death and no inventory settle occurred in this run, so keepInventory=false is operator-declared only (not behaviourally observed)',
      detail: { settles, deaths: deaths.slice(0, 10), kept: kept.length, dropped: dropped.length, losses: losses.length },
      required: kept.length > 0,
    }),
  )

  return conditions
}

/**
 * The worlds an observed level.dat measurement reports, for the "the live world
 * is NOT the target" proof. `observed` is the JSON produced by the measurement
 * script (see CLEAN-RUN-ACCEPTANCE.md); unknown shapes yield an empty list.
 */
export function observedWorlds(observed) {
  const worlds = isPlainObject(observed?.worlds) ? observed.worlds : {}
  return Object.entries(worlds).map(([dir, entry]) => ({
    dir,
    levelName: entry?.levelName ?? null,
    seed: entry?.randomSeed === undefined || entry?.randomSeed === null ? null : String(entry.randomSeed),
    // 1.21.11 stores namespaced snake_case ids (`minecraft:keep_inventory`); they
    // are canonicalised so a level.dat measurement compares against the descriptor.
    gamerules: isPlainObject(entry?.gamerules)
      ? Object.fromEntries(Object.entries(entry.gamerules).map(([rule, fact]) => [canonicalGameruleKey(rule), isPlainObject(fact) ? fact.value : fact]))
      : {},
  }))
}

/** Deviations of an observed world from the descriptor's declared defaults. */
export function observedDeviations(observed, defaults) {
  const out = []
  for (const [rule, value] of Object.entries(observed?.gamerules ?? {})) {
    if (defaults[rule] === undefined) continue
    if (value !== defaults[rule]) out.push(`${rule}=${JSON.stringify(value)} (clean default ${JSON.stringify(defaults[rule])})`)
  }
  return out
}
