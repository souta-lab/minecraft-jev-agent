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
// (`readEnvironmentFile` reads `values` / `configurationChanges` / `worldChanges`), so ONE file is the
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
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertExactLeafArgv, compareRuntimeServerProperties, expectedLeafLaunchIdentity, expectedLeafServerArgs, EXPECTED_JAVA_EXECUTABLE, parseServerProperties } from './clean-run-server-config.mjs'
import { validateConsoleRelayJournal } from './clean-run-console-relay.mjs'

export const RECORD = 'clean-run-environment'
export const SCHEMA_VERSION = 2
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
export function validateCleanEnvironment(
  document,
  {
    descriptorPath = null,
    descriptorSha256 = null,
    worldContainer = null,
    expectedMilestone = 'M3',
    requireTargetWorldAbsent = true,
  } = {},
) {
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

  // 1. the descriptor must be for THIS milestone. M3 acceptance callers keep the
  // default; the M2 reproducibility stager explicitly selects M2 so its peaceful
  // contract can never be mistaken for an M3 acceptance environment.
  const supportedMilestone = expectedMilestone === 'M2' || expectedMilestone === 'M3'
  conditions.push(
    condition({
      id: 'descriptor.milestone',
      verdict: supportedMilestone && cleanRun.milestone === expectedMilestone ? 'PASS' : 'FAIL',
      reason: supportedMilestone && cleanRun.milestone === expectedMilestone
        ? `declared for ${expectedMilestone}`
        : `cleanRun.milestone must be ${JSON.stringify(expectedMilestone)} (supported: M2 or M3), got ${String(cleanRun.milestone)}`,
    }),
  )

  const runtimePolicy = isPlainObject(cleanRun.runtimePolicy) ? cleanRun.runtimePolicy : {}
  const runtimePolicyValid =
    runtimePolicy.javaExecutable === EXPECTED_JAVA_EXECUTABLE &&
    typeof runtimePolicy.javaVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(runtimePolicy.javaVersion) &&
    runtimePolicy.paperIgnoreJavaVersion === true
  conditions.push(condition({
    id: 'descriptor.runtimePolicy',
    verdict: runtimePolicyValid ? 'PASS' : 'FAIL',
    reason: runtimePolicyValid
      ? `Java executable=${runtimePolicy.javaExecutable}, version=${runtimePolicy.javaVersion}, Paper.IgnoreJavaVersion=true are declared and will be checked against the prepared manifest and Leaf startup attestation`
      : `cleanRun.runtimePolicy must declare pinned javaExecutable=${EXPECTED_JAVA_EXECUTABLE}, an exact Java version, and paperIgnoreJavaVersion=true`,
    detail: runtimePolicy,
  }))

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

  // 3. Before a run, the target must not already have level data. Once the
  // server has booted the exact prepared target, level.dat is expected; the
  // final run gate proves freshness from the pre-run prepare manifest instead
  // of requiring the generated world to remain absent.
  const containerPath = worldContainer ?? (typeof cleanRun.worldContainer === 'string' ? cleanRun.worldContainer : null)
  const scanned = scanWorldContainer(containerPath, levelName)
  const generatedBeforeRun = scanned.generated.length > 0
  conditions.push(
    condition({
      id: 'descriptor.worldNotGenerated',
      verdict: !requireTargetWorldAbsent ? 'UNKNOWN' : generatedBeforeRun ? 'FAIL' : 'PASS',
      required: requireTargetWorldAbsent,
      reason:
        !requireTargetWorldAbsent
          ? 'post-run validation permits the target level.dat; pre-run absence must be proven by the run-bound clean-run prepare manifest'
          : generatedBeforeRun
          ? `world already GENERATED under ${String(containerPath)}: ${scanned.generated.join(', ')} (level.dat/level.dat_old exists, so the world has been booted and can never be a clean-run target)`
          : scanned.containerReadable
            ? `${worldDirNames(levelName ?? '').join(', ')} contain no level.dat under ${containerPath}${scanned.staged.length > 0 ? ` (staged by clean-run-prepare, not yet generated: ${scanned.staged.join(', ')})` : ''}`
            : `world container ${String(containerPath)} is absent, so no world can exist there yet (clean-run-prepare refuses to write into a missing root without --create-server-root)`,
      detail: { phase: requireTargetWorldAbsent ? 'pre-run' : 'post-run', required: requireTargetWorldAbsent, container: containerPath, ...scanned },
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

  // 5. difficulty / mob spawning: M2 is measured on the existing peaceful
  // baseline; M3 needs hostile mobs for pearls and blaze rods.
  const difficulty = values.difficulty
  const difficultyAllowed = expectedMilestone === 'M2' ? difficulty === 'peaceful' : ['easy', 'normal', 'hard'].includes(difficulty)
  conditions.push(
    condition({
      id: 'descriptor.difficulty',
      verdict: difficultyAllowed ? 'PASS' : 'FAIL',
      reason:
        expectedMilestone === 'M2'
          ? difficultyAllowed
            ? 'difficulty=peaceful (the repository M2 policy permits peaceful and does not change difficulty before M3)'
            : `difficulty=${String(difficulty)} refused for M2: the M2 reproduction contract requires peaceful`
          : difficultyAllowed
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
          ? expectedMilestone === 'M2'
            ? 'mobSpawning=true and spawn_mobs/spawn_monsters remain at vanilla defaults; M2 keeps difficulty=peaceful, so this does not enable hostile spawns before M3'
            : 'hostile spawning is declared ON. NOTE: this build does NOT read the server.properties key `spawn-monsters` (0 occurrences in DedicatedServerProperties); the enforceable gate is the spawn_mobs / spawn_monsters GAMERULE, which descriptor.gamerulesClean checks'
          : `values.mobSpawning must be true, got ${String(values.mobSpawning)} (and it is only a declaration: this build gates hostile spawning on the spawn_mobs / spawn_monsters gamerule)`,
    }),
  )

  // 5b. gamerules are PER DIMENSION in this build (each level.dat owns its own
  // set; the live world proves it: keep_inventory=true everywhere while
  // advance_time=false only in the overworld). A clean run must assert the rules
  // in every dimension so the descriptor's full scope is judged.
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
          ? `gamerules are declared PER DIMENSION for ${scopeDimensions.join(', ')}; the staged datapack asserts the declared defaults in all three dimensions`
          : `cleanRun.gameruleScope must declare perDimension=true and all of ${requiredDimensions.join(', ')} (got perDimension=${String(scope?.perDimension)}, dimensions=${JSON.stringify(scopeDimensions)}); a single-dimension gamerule set would leave other dimensions unjudged`,
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
  const consoleRuleEvidence = consoleGameruleEvidenceSet(document)
  conditions.push(
    condition({
      id: 'descriptor.consoleGameruleExclusions',
      verdict: consoleRuleEvidence.invalidExclusions.length > 0 ? 'FAIL' : Object.keys(consoleRuleEvidence.excluded).length > 0 ? 'UNKNOWN' : 'PASS',
      required: consoleRuleEvidence.invalidExclusions.length > 0,
      reason: consoleRuleEvidence.invalidExclusions.length > 0
        ? `console gamerule exclusions are invalid: ${consoleRuleEvidence.invalidExclusions.join('; ')}`
        : Object.keys(consoleRuleEvidence.excluded).length > 0
          ? `these declared gamerules are unavailable for observation and are not claimed as observed: ${Object.keys(consoleRuleEvidence.excluded).join(', ')}`
          : 'no gamerules are excluded from run-scoped console observation',
      detail: { excluded: consoleRuleEvidence.excluded, invalid: consoleRuleEvidence.invalidExclusions },
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

  // Configuration selected before first world generation is documented
  // separately from later edits to world data. The descriptor must explicitly
  // carry an array (empty when none occurred); each entry names the exact
  // setting, from/to values, reason, and expected effect. The run artifact binds
  // these entries to its descriptor hash and BOOT identity.
  const rawConfigurationChanges = document.configurationChanges
  const configurationChanges = Array.isArray(rawConfigurationChanges) ? rawConfigurationChanges : []
  const invalidConfigurationChanges = []
  if (!Array.isArray(rawConfigurationChanges)) {
    invalidConfigurationChanges.push('configurationChanges must be explicitly declared as an array (use [] when no pre-run configuration changed)')
  }
  for (const [index, entry] of configurationChanges.entries()) {
    if (!isPlainObject(entry)) {
      invalidConfigurationChanges.push(`[${index}] must be an object`)
      continue
    }
    if (typeof entry.setting !== 'string' || entry.setting.trim() === '') invalidConfigurationChanges.push(`[${index}].setting is missing`)
    if (!Object.prototype.hasOwnProperty.call(entry, 'from') || !Object.prototype.hasOwnProperty.call(entry, 'to')) {
      invalidConfigurationChanges.push(`[${index}] must state from and to`)
    } else if (JSON.stringify(entry.from) === JSON.stringify(entry.to)) {
      invalidConfigurationChanges.push(`[${index}] from and to are identical`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') invalidConfigurationChanges.push(`[${index}].reason is missing`)
    if (typeof entry.expectedImpact !== 'string' || entry.expectedImpact.trim() === '') invalidConfigurationChanges.push(`[${index}].expectedImpact is missing`)
    if (
      typeof entry.setting === 'string' && entry.setting.trim() !== '' &&
      JSON.stringify(readPath(document, entry.setting)) !== JSON.stringify(entry.to)
    ) {
      invalidConfigurationChanges.push(`[${index}].to does not match ${entry.setting}`)
    }
  }
  conditions.push(
    condition({
      id: 'descriptor.configurationChangesDocumented',
      verdict: invalidConfigurationChanges.length === 0 ? 'PASS' : 'FAIL',
      reason:
        invalidConfigurationChanges.length === 0
          ? `${configurationChanges.length} pre-run configuration change(s) are documented separately from world edits`
          : `configuration change record is incomplete or inconsistent: ${invalidConfigurationChanges.join('; ')}`,
      detail: { configurationChanges, invalid: invalidConfigurationChanges },
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
        ? [`CLEAN means the ${expectedMilestone} descriptor is admissible: it still says nothing about whether the actual run obeyed it (that is what run-evidence conditions and the canonical ${expectedMilestone} gate decide)`]
        : [`a NOT_CLEAN/UNKNOWN descriptor must not be used as the environment record of an ${expectedMilestone} acceptance run`],
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

/** Parse the operator-captured, dimension-labelled server-console transcript. */
export function parseConsoleGameruleTranscript(text) {
  const metadata = {}
  const dimensions = {}
  const errors = []
  let currentDimension = null
  for (const [index, rawLine] of String(text ?? '').split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const section = /^\[dimension=([^\]]+)\]$/i.exec(line)
    if (section !== null) {
      currentDimension = section[1].trim()
      if (Object.prototype.hasOwnProperty.call(dimensions, currentDimension)) errors.push(`duplicate dimension section ${currentDimension} at line ${index + 1}`)
      dimensions[currentDimension] ??= {}
      continue
    }
    if (/^\[dimension=/i.test(line)) {
      errors.push(`malformed dimension section at line ${index + 1}`)
      currentDimension = null
      continue
    }
    if (currentDimension === null) {
      const field = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line)
      if (field === null) {
        errors.push(`unexpected content before the first dimension section at line ${index + 1}`)
        continue
      }
      if (Object.prototype.hasOwnProperty.call(metadata, field[1])) errors.push(`duplicate metadata field ${field[1]}`)
      else metadata[field[1]] = field[2].trim()
      continue
    }
    // Accept the id/value output forms used by Minecraft server consoles, with
    // optional INFO prefixes, and the query form "Gamerule <id> is currently
    // set to: <value>". The gate compares ids and values, never display names.
    const entry = /(?:\b(?:game\s*rule|gamerule)\s+)?['"]?([A-Za-z][A-Za-z0-9_:-]*)['"]?\s*(?:=|:|is currently set to:)\s*(.*?)\s*$/i.exec(line)
    if (entry === null) continue
    const key = canonicalGameruleKey(entry[1])
    const valueText = entry[2].replace(/^[."']+|[."']+$/g, '').trim()
    const value = parseConsoleGameruleValue(valueText)
    if (value === undefined) {
      errors.push(`unreadable value for ${entry[1]} at line ${index + 1}`)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(dimensions[currentDimension], key)) {
      errors.push(`duplicate gamerule ${key} in ${currentDimension}`)
      continue
    }
    dimensions[currentDimension][key] = value
  }
  return { metadata, dimensions, errors }
}

/** Exact descriptor query set plus explicitly declared unavailable rules. */
export function consoleGameruleEvidenceSet(descriptor) {
  const rules = isPlainObject(descriptor?.values?.gamerules) ? descriptor.values.gamerules : {}
  const policy = isPlainObject(descriptor?.cleanRun?.gamerulePolicy) ? descriptor.cleanRun.gamerulePolicy : {}
  const exclusions = isPlainObject(policy.notRegisteredInWorld) ? policy.notRegisteredInWorld : {}
  const defaults = isPlainObject(policy.defaults) ? policy.defaults : {}
  const required = new Set([...REQUIRED_GAMERULES, ...(Array.isArray(policy.requiredRules) ? policy.requiredRules.filter((key) => typeof key === 'string') : [])])
  const invalidExclusions = []
  for (const [rule, rationale] of Object.entries(exclusions)) {
    if (!Object.hasOwn(rules, rule) && !Object.hasOwn(defaults, rule)) invalidExclusions.push(`${rule}:not_declared`)
    if (typeof rationale !== 'string' || rationale.trim() === '') invalidExclusions.push(`${rule}:rationale_missing`)
    if (required.has(rule)) invalidExclusions.push(`${rule}:required_rule_cannot_be_excluded`)
  }
  return {
    selected: Object.fromEntries(Object.entries(rules).filter(([rule]) => !Object.hasOwn(exclusions, rule))),
    excluded: exclusions,
    invalidExclusions: [...new Set(invalidExclusions)],
  }
}

function parseConsoleGameruleValue(raw) {
  const value = String(raw).trim().replace(/^[."']+|[."']+$/g, '').trim()
  if (/^true$/i.test(value)) return true
  if (/^false$/i.test(value)) return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)) return value
  return undefined
}

/** Bind and validate the console transcript against the exact accepted run. */
export function checkConsoleGameruleEvidence({ descriptor, artifact, runId = null, descriptorSha256 = null, path = null, text = null, fileSha256 = null, capture = null, captureSha256 = null, captureError = null, commandJournalText = null, serverLogBuffer = null, relayJournalText = null, readError = null }) {
  const mechanism = descriptor?.cleanRun?.gameruleMechanism ?? {}
  const required = mechanism.primary === 'console'
  const baseDetail = { path, fileSha256, mechanism: mechanism.primary ?? null }
  if (!isPlainObject(artifact)) {
    return condition({ id: 'run.consoleGamerulesVerified', verdict: 'UNKNOWN', required: false, reason: 'no run artifact was supplied; console gamerule evidence is evaluated only for an exact run', detail: baseDetail })
  }
  if (!required) {
    return condition({
      id: 'run.consoleGamerulesVerified', verdict: 'UNKNOWN', required: true,
      reason: `final live acceptance requires machine-captured Leaf console gamerules; cleanRun.gameruleMechanism.primary=${String(mechanism.primary ?? '(unset)')} does not select that evidence`,
      detail: baseDetail,
    })
  }
  if (text === null) {
    return condition({
      id: 'run.consoleGamerulesVerified', verdict: 'UNKNOWN', required: true,
      reason: `required operator console gamerule transcript is unavailable${readError === null ? '' : `: ${readError}`}`,
      detail: baseDetail,
    })
  }

  // Editable/pasted console output is no longer an acceptance source. The
  // capture record is generated only by clean-run-console-capture.mjs after it
  // observes each read-only response in the run-private Leaf stdout log.
  if (!isPlainObject(capture) || typeof captureSha256 !== 'string' || commandJournalText === null || !Buffer.isBuffer(serverLogBuffer) || typeof relayJournalText !== 'string') {
    return condition({
      id: 'run.consoleGamerulesVerified', verdict: 'UNKNOWN', required: true,
      reason: `machine-captured Leaf console query evidence is unavailable${captureError === null ? '' : `: ${captureError}`}`,
      detail: { path, fileSha256, captureSha256, captureError },
    })
  }

  const parsed = parseConsoleGameruleTranscript(text)
  const metadata = parsed.metadata
  const missingMetadata = []
  const mismatches = []
  const expectedMetadata = {
    record: 'm3-clean-gamerule-verification',
    schemaVersion: '1',
    runId,
    descriptorSha256,
    levelName: descriptor?.values?.levelName ?? null,
    seed: descriptor?.values?.levelSeed === undefined ? null : String(descriptor.values.levelSeed),
    sourceSha: descriptor?.values?.sourceSha ?? null,
  }
  for (const [key, expected] of Object.entries(expectedMetadata)) {
    const actual = metadata[key]
    if (expected === null || expected === undefined || actual === undefined || actual === '' || /^<.*>$/.test(actual)) {
      missingMetadata.push(key)
    } else if (String(actual) !== String(expected)) {
      mismatches.push(`${key}=${JSON.stringify(actual)} expected ${JSON.stringify(String(expected))}`)
    }
  }
  const capturedAt = metadata.capturedAt
  if (capturedAt === undefined || capturedAt === '' || /^<.*>$/.test(capturedAt)) missingMetadata.push('capturedAt')
  else if (!Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) mismatches.push(`capturedAt=${JSON.stringify(capturedAt)} is not a canonical ISO-8601 UTC timestamp`)

  const bootSourceSha = artifact?.run?.boot?.sourceSha ?? null
  if (bootSourceSha === null) missingMetadata.push('artifact.run.boot.sourceSha')
  else if (metadata.sourceSha !== undefined && metadata.sourceSha !== bootSourceSha) mismatches.push(`sourceSha=${JSON.stringify(metadata.sourceSha)} does not match BOOT source ${JSON.stringify(bootSourceSha)}`)
  if (runId === null) missingMetadata.push('requested runId')
  else if (artifact.runId !== runId) mismatches.push(`artifact.runId=${JSON.stringify(artifact.runId)} does not match requested runId=${JSON.stringify(runId)}`)

  const scope = descriptor?.cleanRun?.gameruleScope ?? {}
  const requiredDimensions = Array.isArray(scope.dimensions) ? scope.dimensions.filter((dimension) => typeof dimension === 'string') : []
  const evidenceSet = consoleGameruleEvidenceSet(descriptor)
  const expectedRules = evidenceSet.selected
  const knownRules = new Set(Object.keys(expectedRules).map(canonicalGameruleKey))
  const differences = [...parsed.errors]
  for (const dimension of requiredDimensions) {
    const observed = parsed.dimensions[dimension]
    if (observed === undefined) {
      differences.push(`missing dimension listing ${dimension}`)
      continue
    }
    for (const [rule, expected] of Object.entries(expectedRules)) {
      const key = canonicalGameruleKey(rule)
      if (!Object.prototype.hasOwnProperty.call(observed, key)) differences.push(`${dimension} missing ${key}`)
      else {
        const actual = observed[key]
        const matches = typeof expected === 'string' ? String(actual) === expected : actual === expected
        if (!matches) differences.push(`${dimension} ${key}=${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`)
      }
    }
    for (const [rule, actual] of Object.entries(observed)) {
      if (!knownRules.has(canonicalGameruleKey(rule))) differences.push(`${dimension} contains unclassified gamerule ${rule}=${JSON.stringify(actual)}`)
    }
  }
  for (const dimension of Object.keys(parsed.dimensions)) {
    if (!requiredDimensions.includes(dimension)) differences.push(`unexpected dimension listing ${dimension}`)
  }
  if (requiredDimensions.length === 0) differences.push('descriptor declares no per-dimension gamerule scope')

  const captureMismatches = []
  const captureMissing = []
  const boot = artifact?.run?.boot ?? null
  const startup = boot?.cleanRunServerConfig ?? null
  const boundDescriptorPath = typeof startup?.descriptorPath === 'string' ? resolve(startup.descriptorPath) : null
  const expectedCapturePath = boundDescriptorPath === null ? null : join(dirname(boundDescriptorPath), 'server-console', 'capture.json')
  const expectedServerLogPath = boundDescriptorPath === null ? null : join(dirname(boundDescriptorPath), 'server-console', 'leaf-server.log')
  const expectedCommandJournalPath = boundDescriptorPath === null ? null : join(dirname(boundDescriptorPath), 'server-console', 'commands.jsonl')
  const expectedRelayJournalPath = boundDescriptorPath === null ? null : join(dirname(boundDescriptorPath), 'server-console', 'leaf-console-relay.jsonl')
  if (capture.record !== 'clean-run-console-capture' || capture.schemaVersion !== 2 || capture.status !== 'complete') captureMismatches.push('capture record/schema/status is invalid')
  for (const [key, expected] of Object.entries({
    runId,
    sourceSha: bootSourceSha,
    'descriptor.sha256': descriptorSha256,
    'descriptor.path': boundDescriptorPath,
    'startupAttestation.path': startup?.attestationPath ?? null,
    'startupAttestation.sha256': startup?.attestationSha256 ?? null,
    'process.pid': startup?.process?.pid ?? null,
    'process.commandLineSha256': startup?.process?.commandLineSha256 ?? null,
    'console.relayJournalPath': startup?.console?.relayJournalPath ?? null,
  })) {
    const [root, child] = key.includes('.') ? key.split('.', 2) : [null, key]
    const actual = root === null ? capture[child] : capture[root]?.[child]
    if (expected === null || expected === undefined) captureMissing.push(key)
    else if (String(actual) !== String(expected)) captureMismatches.push(`${key} does not match run/BOOT startup binding`)
  }
  if (expectedCapturePath !== null && resolve(String(capture.capturePath ?? '')) !== resolve(expectedCapturePath)) captureMismatches.push('capture path is not the descriptor sibling server-console/capture.json')
  if (expectedServerLogPath !== null && resolve(String(capture.console?.stdoutLogPath ?? '')) !== resolve(expectedServerLogPath)) captureMismatches.push('Leaf stdout path is not the descriptor sibling server-console/leaf-server.log')
  if (expectedCommandJournalPath !== null && resolve(String(capture.commandTranscript?.path ?? '')) !== resolve(expectedCommandJournalPath)) captureMismatches.push('command journal path is not the descriptor sibling server-console/commands.jsonl')
  if (expectedRelayJournalPath !== null && resolve(String(capture.console?.relayJournalPath ?? '')) !== resolve(expectedRelayJournalPath)) captureMismatches.push('console relay journal path is not the descriptor sibling server-console/leaf-console-relay.jsonl')
  if (capture.transcript?.sha256 !== fileSha256 || capture.transcript?.path !== path) captureMismatches.push('capture transcript digest/path does not match the transcript file')
  if (capture.commandTranscript?.sha256 !== sha256Text(commandJournalText)) captureMismatches.push('command journal digest does not match its file')
  if (capture.commandTranscript?.queryCount !== Object.keys(expectedRules).length * requiredDimensions.length + 1) captureMismatches.push('command journal query count does not match descriptor scope')
  if (capture.capturedAt !== metadata.capturedAt || capture.residentLog?.sourceSha !== bootSourceSha) captureMismatches.push('capture timestamp/resident BOOT source is not bound to the transcript')
  if (capture.requiredDimensions?.length !== requiredDimensions.length || requiredDimensions.some((dimension, index) => capture.requiredDimensions[index] !== dimension)) captureMismatches.push('captured dimension list differs from descriptor scope')
  const seedLine = typeof capture.seed?.line === 'string' ? Buffer.from(capture.seed.line, 'utf8') : null
  const seedStart = capture.seed?.byteStart
  const seedEnd = capture.seed?.byteEnd
  const seedResponse = typeof capture.seed?.line === 'string' ? /^\[Server thread\/INFO\]: Seed:\s*\[?(-?\d+)\]?$/i.exec(capture.seed.line) : null
  if (seedLine === null || !Number.isInteger(seedStart) || !Number.isInteger(seedEnd) || seedEnd - seedStart !== seedLine.length || !hasLeafLogLineBoundaries(serverLogBuffer, seedStart, seedEnd) || sha256BytesForGate(seedLine) !== capture.seed?.lineSha256) {
    captureMismatches.push('captured seed response range/hash is invalid')
  } else if (!serverLogBuffer.subarray(seedStart, seedEnd).equals(seedLine) || seedResponse === null || seedResponse[1] !== String(capture.seed?.value)) {
    captureMismatches.push('captured seed response is not present in the Leaf stdout log')
  }
  if (!Number.isInteger(capture.seed?.byteOffsetBefore) || capture.seed.byteStart < capture.seed.byteOffsetBefore || capture.seed.relaySequence !== 0) captureMismatches.push('captured seed response is not causally bound to its first query attempt')
  if (String(capture.seed?.value ?? '') !== String(descriptor?.values?.levelSeed ?? '')) captureMismatches.push('captured Leaf seed differs from descriptor')

  const captureResponses = Array.isArray(capture.responses) ? capture.responses : []
  const expectedResponseCount = requiredDimensions.length * Object.keys(expectedRules).length
  if (captureResponses.length !== expectedResponseCount || capture.observedRuleCount !== expectedResponseCount) captureMismatches.push(`capture has ${captureResponses.length} responses; expected ${expectedResponseCount}`)
  const responseKeys = new Set()
  const journalRows = []
  for (const [index, raw] of captureResponses.entries()) {
    if (!isPlainObject(raw)) {
      captureMismatches.push(`capture response ${index} is malformed`)
      continue
    }
    const dimension = String(raw.dimension ?? '')
    const rule = canonicalGameruleKey(String(raw.rule ?? ''))
    const key = `${dimension}\0${rule}`
    if (responseKeys.has(key)) captureMismatches.push(`duplicate captured response ${dimension}/${rule}`)
    responseKeys.add(key)
    const expectedValue = expectedRules[raw.descriptorRule]
    if (!requiredDimensions.includes(dimension) || expectedValue === undefined || canonicalGameruleKey(raw.descriptorRule) !== rule) captureMismatches.push(`unexpected captured response ${dimension}/${rule}`)
    else if ((typeof expectedValue === 'string' ? String(raw.value) : raw.value) !== expectedValue) captureMismatches.push(`captured response value contradicts descriptor at ${dimension}/${rule}`)
    const responseLine = typeof raw.line === 'string' ? Buffer.from(raw.line, 'utf8') : null
    if (responseLine === null || !Number.isInteger(raw.byteStart) || !Number.isInteger(raw.byteEnd) || raw.byteEnd - raw.byteStart !== responseLine.length || !hasLeafLogLineBoundaries(serverLogBuffer, raw.byteStart, raw.byteEnd) || sha256BytesForGate(responseLine) !== raw.lineSha256) {
      captureMismatches.push(`captured response range/hash is invalid for ${dimension}/${rule}`)
    } else if (!serverLogBuffer.subarray(raw.byteStart, raw.byteEnd).equals(responseLine)) captureMismatches.push(`captured response is absent from Leaf stdout log for ${dimension}/${rule}`)
    const parsedResponse = /^\[Server thread\/INFO\]: Gamerule\s+([A-Za-z][A-Za-z0-9_:-]*)\s+is currently set to:\s*(.*?)\s*$/i.exec(String(raw.line ?? ''))
    if (parsedResponse === null || canonicalGameruleKey(parsedResponse[1]) !== rule) captureMismatches.push(`captured output line does not name ${dimension}/${rule}`)
    else {
      const lineValueText = parsedResponse[2].replace(/^[."']+|[."']+$/g, '').trim()
      const lineValue = /^true$/i.test(lineValueText) ? true : /^false$/i.test(lineValueText) ? false : /^-?\d+(?:\.\d+)?$/.test(lineValueText) ? Number(lineValueText) : lineValueText
      if (lineValue !== raw.value) captureMismatches.push(`captured output line value differs from recorded value at ${dimension}/${rule}`)
    }
    const expectedCommand = `execute in ${dimension} run gamerule ${raw.descriptorRule}`
    if (raw.command !== expectedCommand) captureMismatches.push(`captured command is not a read-only ${dimension}/${rule} query`)
    if (!Number.isInteger(raw.byteOffsetBefore) || raw.byteStart < raw.byteOffsetBefore || raw.relaySequence !== index + 1) captureMismatches.push(`captured response is not causally bound to its query attempt for ${dimension}/${rule}`)
  }
  for (const dimension of requiredDimensions) {
    for (const [descriptorRule] of Object.entries(expectedRules)) {
      if (!responseKeys.has(`${dimension}\0${canonicalGameruleKey(descriptorRule)}`)) captureMismatches.push(`capture missing ${dimension}/${descriptorRule}`)
    }
  }
  for (const line of String(commandJournalText).split(/\r?\n/).filter(Boolean)) {
    try { journalRows.push(JSON.parse(line)) } catch { captureMismatches.push('command journal contains invalid JSON'); break }
  }
  const expectedQueries = [
    { kind: 'seed', command: 'seed', dimension: null, descriptorRule: null, rule: null },
    ...requiredDimensions.flatMap((dimension) => Object.keys(expectedRules).map((descriptorRule) => ({
      kind: 'gamerule', command: `execute in ${dimension} run gamerule ${descriptorRule}`,
      dimension, descriptorRule, rule: canonicalGameruleKey(descriptorRule),
    }))),
  ]
  const expectedQueryCount = expectedQueries.length
  if (captureResponses.length !== expectedResponseCount || journalRows.length !== expectedQueryCount * 2) {
    captureMismatches.push(`command journal/capture must contain exactly ${expectedQueryCount} ordered queries`)
  }
  const expectedCommands = new Set(expectedQueries.map((query) => query.command))
  for (const row of journalRows) {
    if (row?.event === 'console-query-attempt' && !expectedCommands.has(row.command)) {
      captureMismatches.push(`non-query console command recorded: ${String(row.command ?? '(missing)')}`)
    }
  }
  let previousResponseEnd = -1
  let previousRelayOffset = -1
  const seenRanges = new Set()
  for (let index = 0; index < expectedQueryCount; index += 1) {
    const expectedQuery = expectedQueries[index]
    const captureRow = index === 0 ? capture.seed : captureResponses[index - 1]
    const attempt = journalRows[index * 2]
    const response = journalRows[index * 2 + 1]
    if (!isPlainObject(attempt) || !isPlainObject(response) || attempt.event !== 'console-query-attempt' || response.event !== 'console-query-response') {
      captureMismatches.push(`command journal order is invalid for query ${index}`)
      continue
    }
    for (const entry of [attempt, response]) {
      if (entry.runId !== runId || entry.sourceSha !== bootSourceSha || entry.descriptorSha256 !== descriptorSha256 || entry.startupAttestationSha256 !== startup?.attestationSha256 || entry.leafPid !== startup?.process?.pid) {
        captureMismatches.push(`command journal query ${index} is not bound to this run/descriptor/Leaf process`)
      }
    }
    if (
      attempt.kind !== expectedQuery.kind || attempt.command !== expectedQuery.command ||
      attempt.dimension !== expectedQuery.dimension || attempt.descriptorRule !== expectedQuery.descriptorRule || attempt.rule !== expectedQuery.rule ||
      response.kind !== expectedQuery.kind || response.command !== expectedQuery.command ||
      response.dimension !== expectedQuery.dimension || response.descriptorRule !== expectedQuery.descriptorRule || response.rule !== expectedQuery.rule
    ) captureMismatches.push(`journal query ${index} does not match the canonical seed/dimension/rule order`)
    if (
      !Number.isInteger(attempt.byteOffsetBefore) || attempt.byteOffsetBefore < previousResponseEnd ||
      !hasLeafLogLineStart(serverLogBuffer, attempt.byteOffsetBefore) ||
      !Number.isInteger(attempt.relayOffsetBefore) || attempt.relayOffsetBefore < previousRelayOffset ||
      attempt.relaySequence !== index || response.relaySequence !== index || response.byteOffsetBefore !== attempt.byteOffsetBefore
    ) captureMismatches.push(`journal query ${index} has missing, regressing, or incorrectly bound log/relay offsets`)
    previousRelayOffset = Number.isInteger(attempt.relayOffsetBefore) ? attempt.relayOffsetBefore : previousRelayOffset
    const start = captureRow?.byteStart
    const end = captureRow?.byteEnd
    const rangeKey = `${String(start)}:${String(end)}`
    if (seenRanges.has(rangeKey)) captureMismatches.push(`Leaf output range ${rangeKey} was reused for more than one query`)
    seenRanges.add(rangeKey)
    if (
      !Number.isInteger(start) || !Number.isInteger(end) || start < attempt.byteOffsetBefore || start < previousResponseEnd || end <= start || end > serverLogBuffer.length ||
      !hasLeafLogLineBoundaries(serverLogBuffer, start, end)
    ) captureMismatches.push(`Leaf output range is not monotonic, in-bounds, or after query ${index}`)
    if (
      response.byteStart !== start || response.byteEnd !== end || response.responseByteStart !== start || response.responseByteEnd !== end ||
      response.value !== captureRow?.value || response.responseLine !== captureRow?.line || response.responseLineSha256 !== captureRow?.lineSha256 ||
      response.byteOffsetBefore !== attempt.byteOffsetBefore
    ) captureMismatches.push(`journal response ${index} does not exactly bind captured bytes/value/query attempt`)
    if (Number.isInteger(end)) previousResponseEnd = end
  }
  const relayValidation = validateConsoleRelayJournal(relayJournalText, {
    leafPid: startup?.process?.pid,
    expectedCommands: expectedQueries.map((query) => query.command),
  })
  if (!relayValidation.valid) captureMismatches.push(relayValidation.reason)
  if (
    capture.console?.relayJournalSha256 !== sha256Text(relayJournalText) ||
    capture.console?.relayJournalBytes !== Buffer.byteLength(relayJournalText) ||
    capture.console?.relayCommandCount !== expectedQueryCount
  ) captureMismatches.push('console relay journal changed after capture or does not bind every read-only command')
  for (const rule of Object.keys(evidenceSet.excluded)) {
    // Excluded gamerules are explicitly unavailable in this world and must not
    // be represented as observed console values.
    if (captureResponses.some((entry) => entry?.descriptorRule === rule)) captureMismatches.push(`excluded gamerule ${rule} was incorrectly claimed as observed`)
  }
  if (evidenceSet.invalidExclusions.length > 0) captureMismatches.push(`descriptor gamerule exclusions are invalid: ${evidenceSet.invalidExclusions.join(', ')}`)

  const uniqueMissingMetadata = [...new Set(missingMetadata)]
  const bindingReady = uniqueMissingMetadata.length === 0
  const verdict = mismatches.length > 0 || captureMismatches.length > 0 ? 'FAIL' : !bindingReady || captureMissing.length > 0 ? 'UNKNOWN' : differences.length > 0 ? 'FAIL' : 'PASS'
  const reason = verdict === 'PASS'
    ? `machine-captured Leaf console responses are bound to run ${String(runId)}, descriptor ${String(descriptorSha256)}, BOOT source ${String(bootSourceSha)}, and all ${requiredDimensions.length} dimension listings match ${Object.keys(expectedRules).length} queryable gamerules`
    : verdict === 'FAIL'
      ? `machine-captured Leaf console evidence contradicts or incompletely verifies the descriptor: ${[...mismatches, ...differences, ...captureMismatches].join('; ')}`
      : `machine-captured Leaf console evidence is not fully bound yet; missing metadata: ${[...uniqueMissingMetadata, ...captureMissing].join(', ')}${differences.length === 0 ? '' : `; listing issues: ${differences.join('; ')}`}`
  return condition({
    id: 'run.consoleGamerulesVerified', verdict, required: true, reason,
    detail: { ...baseDetail, metadata, captureSha256, requiredDimensions, expectedRuleCount: Object.keys(expectedRules).length, excludedRules: Object.keys(evidenceSet.excluded), excludedRuleEvidence: Object.fromEntries(Object.keys(evidenceSet.excluded).map((rule) => [rule, 'UNKNOWN:declared_not_registered_in_world'])), observedRulesByDimension: Object.fromEntries(Object.entries(parsed.dimensions).map(([dimension, rules]) => [dimension, Object.keys(rules).length])), missingMetadata: uniqueMissingMetadata, mismatches, differences, captureMismatches, bootSourceSha },
  })
}

function sha256BytesForGate(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hasLeafLogLineStart(buffer, offset) {
  return Number.isInteger(offset) && offset >= 0 && offset <= buffer.length && (offset === 0 || buffer[offset - 1] === 0x0a)
}

function hasLeafLogLineBoundaries(buffer, start, end) {
  if (!hasLeafLogLineStart(buffer, start) || !Number.isInteger(end) || end <= start || end >= buffer.length) return false
  return buffer[end] === 0x0a || (buffer[end] === 0x0d && buffer[end + 1] === 0x0a)
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
  const env = document !== null && isPlainObject(document.environment) ? document.environment : {}

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
  const recordedDescriptorSha = typeof envFile?.sha256 === 'string' ? envFile.sha256 : null
  const descriptorShaMatches = recordedDescriptorSha !== null && descriptorSha256 !== null && recordedDescriptorSha === descriptorSha256
  const descriptorBindingMatches = samePath && descriptorShaMatches
  conditions.push(
    condition({
      id: 'run.environmentRecordIsThisDescriptor',
      verdict: recordedPath === null || recordedDescriptorSha === null ? 'UNKNOWN' : descriptorBindingMatches ? 'PASS' : 'FAIL',
      reason:
        recordedPath === null
          ? 'the artifact records no --environment file, so the run has no environment record to bind to this descriptor'
          : recordedDescriptorSha === null
            ? 'the artifact does not carry the environment descriptor SHA-256, so the exact descriptor bytes cannot be verified'
            : descriptorBindingMatches
              ? `the artifact read the same descriptor path and sha256=${descriptorSha256} that this gate validated`
              : `artifact descriptor path/hash (${String(recordedPath)}, ${recordedDescriptorSha}) does not match the validated descriptor (${String(descriptorPath)}, ${String(descriptorSha256)})`,
      detail: { recordedPath, descriptorPath, recordedValuesSha256: recordedValuesSha, recordedDescriptorSha256: recordedDescriptorSha, descriptorSha256 },
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
  const observedServerVersion = document?.run?.serverVersion
  const expectedServerVersion = values.serverVersion
  conditions.push(
    condition({
      id: 'run.serverVersionMatchesDescriptor',
      verdict: typeof observedServerVersion !== 'string' || typeof expectedServerVersion !== 'string'
        ? 'UNKNOWN'
        : observedServerVersion === expectedServerVersion ? 'PASS' : 'FAIL',
      reason:
        typeof observedServerVersion !== 'string' || typeof expectedServerVersion !== 'string'
          ? `run-observed Minecraft server version (${String(observedServerVersion ?? 'missing')}) or descriptor version (${String(expectedServerVersion ?? 'missing')}) is unavailable`
          : observedServerVersion === expectedServerVersion
            ? `run-observed Minecraft server version ${observedServerVersion} matches the clean descriptor`
            : `run-observed Minecraft server version ${observedServerVersion} differs from descriptor version ${expectedServerVersion}`,
      detail: { observed: observedServerVersion ?? null, expected: expectedServerVersion ?? null },
      required: true,
    }),
  )

  const configurationChangesDeclared = Array.isArray(descriptor?.configurationChanges)
  const expectedConfigurationChanges = configurationChangesDeclared ? descriptor.configurationChanges : []
  const recordedConfigurationChanges = isPlainObject(env.configurationChanges) ? env.configurationChanges : null
  const recordedChanges = Array.isArray(recordedConfigurationChanges?.changes) ? recordedConfigurationChanges.changes : null
  const recordedConfigurationChangesBound = recordedConfigurationChanges !== null
    && recordedConfigurationChanges.runId === runId
    && recordedConfigurationChanges.sourceSha === bootSha
    && recordedConfigurationChanges.descriptorSha256 === descriptorSha256
    && typeof recordedConfigurationChanges.source === 'string'
    && descriptorPath !== null
    && resolve(recordedConfigurationChanges.source) === resolve(descriptorPath)
  const configurationChangesMatch = configurationChangesDeclared
    ? recordedConfigurationChangesBound && JSON.stringify(recordedChanges) === JSON.stringify(expectedConfigurationChanges)
    : false
  conditions.push(
    condition({
      id: 'run.configurationChangesBound',
      verdict: configurationChangesMatch ? 'PASS' : recordedConfigurationChanges === null ? 'UNKNOWN' : 'FAIL',
      reason:
        configurationChangesMatch
          ? expectedConfigurationChanges.length === 0
            ? 'the descriptor declares no pre-run configuration changes; worldChanges remains a separate record'
            : `${expectedConfigurationChanges.length} configuration change(s) match the exact descriptor hash and are bound to runId=${String(runId)} sourceSha=${String(bootSha)}`
          : recordedConfigurationChanges === null
            ? `the descriptor declares ${expectedConfigurationChanges.length} configuration change(s), but the run artifact did not preserve the explicit configurationChanges list and its rationale/expected impact`
            : 'the run artifact configuration-change rationale does not match the descriptor path/hash, runId, BOOT source SHA, or exact change entries',
      detail: {
        runId: recordedConfigurationChanges?.runId ?? null,
        sourceSha: recordedConfigurationChanges?.sourceSha ?? null,
        descriptorSha256: recordedConfigurationChanges?.descriptorSha256 ?? null,
        expected: expectedConfigurationChanges,
        observed: recordedChanges,
      },
      required: true,
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
  const bootWorldKey = isPlainObject(document?.run?.boot?.worldKey) ? document.run.boot.worldKey : null
  const worldIdentityAvailable = record !== null &&
    typeof record.serverId === 'string' && record.serverId.length > 0 &&
    typeof bootWorldKey?.serverId === 'string' && bootWorldKey.serverId.length > 0
  const worldIdentityMatches = worldIdentityAvailable &&
    record.serverId === bootWorldKey.serverId
  conditions.push(
    condition({
      id: 'run.acceptanceWorldIdentity',
      verdict: !worldIdentityAvailable ? 'UNKNOWN' : worldIdentityMatches ? 'PASS' : 'FAIL',
      reason: !worldIdentityAvailable
        ? 'the HOST acceptance record and BOOT do not both carry a serverId'
        : worldIdentityMatches
          ? `HOST acceptance serverId=${record.serverId} matches the run BOOT server identity`
          : `HOST acceptance serverId=${record.serverId} differs from BOOT serverId=${bootWorldKey.serverId}`,
      detail: { accepted: record === null ? null : { serverId: record.serverId ?? null, levelName: record.levelName ?? null, seed: record.seed ?? null }, boot: bootWorldKey },
      required: true,
    }),
  )
  const finalInventory = isPlainObject(document.inventory?.final) ? document.inventory.final : null
  const finalWorldKey = isPlainObject(finalInventory?.worldKey) ? finalInventory.worldKey : null
  const finalWorldIdentityMatches = worldIdentityMatches &&
    finalInventory?.status === 'PRESENT' &&
    finalInventory?.runId === runId &&
    typeof finalInventory?.sourceSha === 'string' && finalInventory.sourceSha.toLowerCase() === String(bootSha ?? '').toLowerCase() &&
    finalWorldKey?.serverId === record.serverId &&
    typeof finalInventory?.dimension === 'string' && finalInventory.dimension.length > 0 && finalWorldKey?.dimension === finalInventory.dimension
  conditions.push(
    condition({
      id: 'run.finalInventoryWorldIdentity',
      verdict: !worldIdentityAvailable || finalInventory?.status !== 'PRESENT' ? 'UNKNOWN' : finalWorldIdentityMatches ? 'PASS' : 'FAIL',
      reason: !worldIdentityAvailable || finalInventory?.status !== 'PRESENT'
        ? 'final HOST inventory or accepted server/world identity is unavailable'
        : finalWorldIdentityMatches
          ? `final HOST inventory matches accepted serverId=${record.serverId}; dimension=${finalInventory.dimension} may differ from BOOT because dimension transitions are part of the run`
          : 'final HOST inventory is not bound to the accepted server/world identity or its own dimension field',
      detail: { final: finalInventory === null ? null : { runId: finalInventory.runId ?? null, sourceSha: finalInventory.sourceSha ?? null, dimension: finalInventory.dimension ?? null, worldKey: finalWorldKey }, accepted: record === null ? null : { serverId: record.serverId ?? null, levelName: record.levelName ?? null, seed: record.seed ?? null } },
      required: true,
    }),
  )

  // 3. The actual Leaf startup must be bound to this run, descriptor, and staged
  // server.properties. Operator records and the resident's seed-reader path are
  // not observations of the server process's effective `--config` argument.
  const startupAttestation = artifact?.run?.boot?.cleanRunServerConfig ?? null
  const startupAttestationCondition = cleanRunServerConfigCondition({
    descriptor,
    artifact,
    runId,
    descriptorPath,
    descriptorSha256,
    startupAttestation,
  })
  conditions.push(startupAttestationCondition)

  // 4. The difficulty/spawn facts are read from the same verified startup bytes.
  // Descriptor-sourced environment values remain useful context, but cannot pass
  // these run conditions without the runtime attestation above.
  for (const [id, key, expected] of [
    ['run.difficultyNotContradicted', 'difficulty', values.difficulty],
    ['run.mobSpawningNotContradicted', 'mobSpawning', values.mobSpawning],
  ]) {
    const fact = isPlainObject(env[key]) ? env[key] : null
    const propertyKey = key === 'difficulty' ? 'difficulty' : 'spawn-monsters'
    const observedRuntimeValue = startupAttestationCondition.verdict === 'PASS'
      ? startupAttestation?.config?.properties?.[propertyKey] ?? null
      : null
    const expectedRuntimeValue = key === 'difficulty' ? expected : String(expected)
    const logContradiction = fact?.runScoped === true && fact.value !== expected
    const mismatch = observedRuntimeValue !== null && String(observedRuntimeValue) !== String(expectedRuntimeValue)
    conditions.push(
      condition({
        id,
        verdict: logContradiction || mismatch ? 'FAIL' : observedRuntimeValue === null ? 'UNKNOWN' : 'PASS',
        reason:
          logContradiction
            ? `run-scoped log fact ${key}=${JSON.stringify(fact.value)} contradicts the descriptor's ${JSON.stringify(expected)}`
            : observedRuntimeValue === null
            ? `${key} is UNKNOWN until a verified Leaf startup attestation records the actual server.properties values${fact === null ? '' : `; descriptive artifact fact is ${JSON.stringify(fact.value)} from ${String(fact.source)}`}`
            : mismatch
              ? `Leaf startup config ${propertyKey}=${JSON.stringify(observedRuntimeValue)} contradicts the descriptor's ${JSON.stringify(expectedRuntimeValue)}`
              : `Leaf startup config ${propertyKey}=${JSON.stringify(observedRuntimeValue)} matches the descriptor (attestation ${startupAttestation.attestationSha256})`,
        detail: { fact, attestedRuntimeValue: observedRuntimeValue, propertyKey, expected: expectedRuntimeValue },
        required: true,
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
  const bootEvidence = isPlainObject(document.inventory?.bootEvidence) ? document.inventory.bootEvidence : null
  const bootSourceSha = document?.run?.boot?.sourceSha ?? null
  const bootEvidenceBound = boot?.source === 'snapshot' &&
    bootEvidence?.status === 'verified' &&
    bootEvidence?.runId === runId &&
    bootEvidence?.bootSourceSha === bootSourceSha &&
    bootEvidence?.snapshotBootSourceSha === bootSourceSha
  const nonZero = bootCounts === null ? [] : Object.entries(bootCounts).filter(([, count]) => typeof count === 'number' && count > 0)
  conditions.push(
    condition({
      id: 'run.bootInventoryEmpty',
      verdict: bootCounts === null || !bootEvidenceBound ? 'UNKNOWN' : nonZero.length === 0 ? 'PASS' : 'FAIL',
      reason:
        bootCounts === null || !bootEvidenceBound
          ? `generation-entry initialInventory is not bound to this run's exact BOOT source${bootEvidence?.reason ? `: ${bootEvidence.reason}` : ''}`
          : nonZero.length === 0
            ? `the run-scoped generation-entry inventory is empty (${String(boot?.source)} at ${String(boot?.ts)})`
            : `the run started with items it cannot have on a fresh world: ${nonZero.map(([item, count]) => `${item}x${count}`).join(', ')} (granted kit)`,
      detail: { boot, bootEvidence, expectedRunId: runId, expectedBootSourceSha: bootSourceSha },
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

function cleanRunServerConfigCondition({ descriptor, artifact, runId, descriptorPath, descriptorSha256, startupAttestation }) {
  const unknown = (reason, detail = null) => condition({
    id: 'run.serverConfigAttestation', verdict: 'UNKNOWN', required: true, reason, detail,
  })
  const fail = (reason, detail = null) => condition({
    id: 'run.serverConfigAttestation', verdict: 'FAIL', required: true, reason, detail,
  })
  if (!isPlainObject(startupAttestation)) return unknown('BOOT has no Leaf startup attestation; a descriptor and BUDDY_SERVER_PROPERTIES_PATH do not prove Leaf startup argv/config')
  if (startupAttestation.status === 'unavailable') {
    return unknown(`Leaf startup attestation could not be verified: ${String(startupAttestation.reason ?? 'reason_missing')}`, startupAttestation)
  }
  if (startupAttestation.status === 'rejected') {
    return fail(`Leaf startup attestation rejected the run: ${String(startupAttestation.reason ?? 'reason_missing')}`, startupAttestation)
  }
  if (startupAttestation.status !== 'verified') {
    return fail(`Leaf startup attestation reports ${String(startupAttestation.status)}: ${String(startupAttestation.reason ?? 'reason_missing')}`, startupAttestation)
  }
  if (startupAttestation.runId !== runId) return fail(`attestation runId=${String(startupAttestation.runId)} differs from requested runId=${String(runId)}`)
  const boot = artifact?.run?.boot ?? null
  if (startupAttestation.bootSourceSha !== boot?.sourceSha) return fail('attestation BOOT source SHA differs from the artifact BOOT source SHA')
  if (descriptorPath === null) return unknown('clean-run descriptor path is unavailable for startup attestation binding')
  if (startupAttestation.descriptorPath !== resolve(String(descriptorPath ?? ''))) return fail('attested descriptor path differs from the clean-run gate input')
  if (startupAttestation.descriptorSha256 !== descriptorSha256) return fail('attested descriptor SHA-256 differs from the clean-run gate input')

  const expectedPropertiesPath = descriptorPath === null ? null : resolve(dirname(descriptorPath), 'server.properties.clean')
  const expectedManifestPath = descriptorPath === null ? null : resolve(dirname(descriptorPath), 'manifest.json')
  const expectedAttestationPath = descriptorPath === null ? null : resolve(dirname(descriptorPath), 'server-start-attestation.json')
  const config = startupAttestation.config
  const processInfo = startupAttestation.process
  const consoleInfo = startupAttestation.console
  const preparedManifest = startupAttestation.preparedManifest
  const attestedManifestPath = startupAttestation.manifestPath
  if (startupAttestation.attestationPath !== expectedAttestationPath) return fail('Leaf launch attestation path is not the descriptor sibling server-start-attestation.json')
  if (!/^[0-9a-f]{64}$/.test(String(startupAttestation.attestationSha256 ?? ''))) return fail('Leaf launch attestation SHA-256 is missing or malformed')
  const propertiesPath = config?.path
  if (expectedPropertiesPath === null || propertiesPath !== expectedPropertiesPath || processInfo?.configArg !== expectedPropertiesPath) {
    return fail('Leaf `--config` and attested file path must be the descriptor sibling server.properties.clean', { expectedPropertiesPath, propertiesPath, configArg: processInfo?.configArg })
  }
  if (attestedManifestPath !== expectedManifestPath) return fail('startup attestation does not reference the sibling prepared manifest', { expectedManifestPath, attestedManifestPath })
  if (processInfo?.universeArg !== resolve(String(descriptor?.cleanRun?.worldContainer ?? '')) || processInfo?.levelNameArg !== descriptor?.values?.levelName) {
    return fail('Leaf startup `--universe` or `--level-name` differs from the descriptor', { process: processInfo, worldContainer: descriptor?.cleanRun?.worldContainer, levelName: descriptor?.values?.levelName })
  }
  if (processInfo?.serverJar !== String(descriptor?.values?.serverImplementation ?? '').split(/[\\/]/).at(-1)) {
    return fail('Leaf startup server jar differs from descriptor serverImplementation', { serverJar: processInfo?.serverJar, serverImplementation: descriptor?.values?.serverImplementation })
  }
  if (!Number.isInteger(processInfo?.pid) || !/^[0-9a-f]{64}$/.test(String(processInfo?.commandLineSha256 ?? ''))) {
    return fail('startup process identity is incomplete', processInfo ?? null)
  }
  let expectedLaunchIdentity
  try {
    expectedLaunchIdentity = expectedLeafLaunchIdentity(descriptor, descriptor?.cleanRun?.worldContainer)
    assertExactLeafArgv(processInfo?.argv?.slice?.(1), expectedLeafServerArgs(descriptor, expectedPropertiesPath, descriptor?.cleanRun?.worldContainer), 'attested Leaf')
  } catch (error) {
    return fail(`Leaf startup identity is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  const runtime = startupAttestation.runtime
  if (
    JSON.stringify(runtime?.java ?? null) !== JSON.stringify(expectedLaunchIdentity.java) ||
    runtime?.paperIgnoreJavaVersion !== expectedLaunchIdentity.paperIgnoreJavaVersion ||
    runtime?.paperIgnoreJavaVersion !== true ||
    !processInfo?.argv?.includes?.('-DPaper.IgnoreJavaVersion=true')
  ) return fail('Leaf JVM version output/hash or Paper.IgnoreJavaVersion flag differs from the descriptor policy', { expected: { java: expectedLaunchIdentity.java, paperIgnoreJavaVersion: expectedLaunchIdentity.paperIgnoreJavaVersion }, observed: runtime ?? null })
  if (
    processInfo?.executable !== EXPECTED_JAVA_EXECUTABLE ||
    processInfo?.executableRealpath !== expectedLaunchIdentity.java.realpath ||
    processInfo?.executableSha256 !== expectedLaunchIdentity.java.sha256 ||
    processInfo?.serverJarPath !== expectedLaunchIdentity.serverJar.path ||
    processInfo?.serverJarRealpath !== expectedLaunchIdentity.serverJar.realpath ||
    processInfo?.serverJarSha256 !== expectedLaunchIdentity.serverJar.sha256
  ) return fail('Leaf Java executable or server JAR identity differs from the prepared runtime', { expectedLaunchIdentity, process: processInfo })
  const expectedConsoleDir = resolve(dirname(expectedAttestationPath ?? descriptorPath), 'server-console')
  const expectedConsole = {
    directory: expectedConsoleDir,
    inputPath: resolve(expectedConsoleDir, 'server-console.fifo'),
    stdoutLogPath: resolve(expectedConsoleDir, 'leaf-server.log'),
    commandTranscriptPath: resolve(expectedConsoleDir, 'commands.jsonl'),
    capturePath: resolve(expectedConsoleDir, 'capture.json'),
    relayJournalPath: resolve(expectedConsoleDir, 'leaf-console-relay.jsonl'),
  }
  if (
    consoleInfo?.mode !== 'run-private-fifo-and-log' ||
    resolve(String(consoleInfo?.directory ?? '')) !== expectedConsole.directory ||
    resolve(String(consoleInfo?.inputPath ?? '')) !== expectedConsole.inputPath ||
    resolve(String(consoleInfo?.stdoutLogPath ?? '')) !== expectedConsole.stdoutLogPath ||
    resolve(String(consoleInfo?.commandTranscriptPath ?? '')) !== expectedConsole.commandTranscriptPath ||
    resolve(String(consoleInfo?.capturePath ?? '')) !== expectedConsole.capturePath ||
    resolve(String(consoleInfo?.relayJournalPath ?? '')) !== expectedConsole.relayJournalPath
  ) return fail('Leaf console input/output is not bound to the run-private console directory')
  try {
    const directoryStat = lstatSync(expectedConsoleDir)
    const fifoStat = lstatSync(expectedConsole.inputPath)
    const outputStat = lstatSync(expectedConsole.stdoutLogPath)
    const relayStat = lstatSync(expectedConsole.relayJournalPath)
    if (
      !directoryStat.isDirectory() || directoryStat.uid !== process.getuid?.() || (directoryStat.mode & 0o777) !== 0o700 ||
      !fifoStat.isFIFO() || fifoStat.uid !== process.getuid?.() || (fifoStat.mode & 0o777) !== 0o600 ||
      !outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.uid !== process.getuid?.() || (outputStat.mode & 0o777) !== 0o600 ||
      !relayStat.isFile() || relayStat.isSymbolicLink() || relayStat.uid !== process.getuid?.() || (relayStat.mode & 0o777) !== 0o600
    ) return fail('Leaf console FIFO/log are not private owner-only objects')
  } catch {
    return unknown('Leaf console FIFO/log are unavailable for run-scoped command capture', expectedConsole)
  }
  const bootMs = Date.parse(String(boot?.ts ?? ''))
  const processStartedMs = Date.parse(String(processInfo?.startedAt ?? ''))
  if (!Number.isFinite(bootMs) || !Number.isFinite(processStartedMs) || processStartedMs > bootMs) {
    return fail('attested Leaf process did not start before this run BOOT', { bootAt: boot?.ts ?? null, processStartedAt: processInfo?.startedAt ?? null })
  }

  let manifest
  let propertiesText
  let startupText
  let startupRecord
  try {
    const manifestText = readFileSync(expectedManifestPath, 'utf8')
    manifest = JSON.parse(manifestText)
    propertiesText = readFileSync(expectedPropertiesPath, 'utf8')
    startupText = readFileSync(expectedAttestationPath, 'utf8')
    startupRecord = JSON.parse(startupText)
    if (sha256Text(manifestText) !== startupAttestation.manifestSha256) return fail('prepared manifest changed after the HOST bound the startup attestation')
    if (sha256Text(startupText) !== startupAttestation.attestationSha256) return fail('Leaf startup attestation file changed after the HOST bound it to BOOT')
    if (sha256Text(propertiesText) !== config?.sha256) return fail('staged server.properties changed after Leaf startup')
  } catch {
    return unknown('prepared manifest, Leaf startup attestation, or staged server.properties is unavailable to verify at acceptance time', { expectedAttestationPath, expectedManifestPath, expectedPropertiesPath })
  }
  if (
    startupRecord?.record !== 'clean-run-leaf-startup-attestation' ||
    startupRecord?.schemaVersion !== 2 ||
    startupRecord?.descriptor?.path !== startupAttestation.descriptorPath ||
    startupRecord?.descriptor?.sha256 !== startupAttestation.descriptorSha256 ||
    startupRecord?.descriptor?.sourceSha !== boot?.sourceSha ||
    startupRecord?.config?.path !== config?.path ||
    startupRecord?.config?.sha256 !== config?.sha256 ||
    JSON.stringify(startupRecord?.runtime ?? null) !== JSON.stringify(runtime ?? null) ||
    startupRecord?.process?.pid !== processInfo?.pid ||
    startupRecord?.process?.commandLineSha256 !== processInfo?.commandLineSha256 ||
    JSON.stringify(startupRecord?.process?.argv ?? null) !== JSON.stringify(processInfo?.argv ?? null) ||
    startupRecord?.process?.executable !== processInfo?.executable ||
    startupRecord?.process?.executableRealpath !== processInfo?.executableRealpath ||
    startupRecord?.process?.executableSha256 !== processInfo?.executableSha256 ||
    startupRecord?.process?.serverJarPath !== processInfo?.serverJarPath ||
    startupRecord?.process?.serverJarRealpath !== processInfo?.serverJarRealpath ||
    startupRecord?.process?.serverJarSha256 !== processInfo?.serverJarSha256 ||
    startupRecord?.console?.mode !== consoleInfo?.mode ||
    startupRecord?.console?.directory !== consoleInfo?.directory ||
    startupRecord?.console?.inputPath !== consoleInfo?.inputPath ||
    startupRecord?.console?.stdoutLogPath !== consoleInfo?.stdoutLogPath ||
    startupRecord?.console?.commandTranscriptPath !== consoleInfo?.commandTranscriptPath ||
    startupRecord?.console?.capturePath !== consoleInfo?.capturePath
    || startupRecord?.console?.relayJournalPath !== consoleInfo?.relayJournalPath
  ) return fail('run BOOT binding disagrees with the persisted Leaf startup attestation')
  const preparedResolvedPath = resolve(String(manifest?.resolved?.path ?? ''))
  const stagedEntry = Array.isArray(manifest?.files)
    ? manifest.files.find((entry) => typeof entry?.path === 'string' && resolve(entry.path) === expectedPropertiesPath)
    : null
  if (
    manifest?.record !== 'clean-run-prepare' ||
    preparedResolvedPath !== resolve(descriptorPath) ||
    manifest?.target?.levelName !== descriptor?.values?.levelName ||
    String(manifest?.target?.levelSeed ?? '') !== String(descriptor?.values?.levelSeed ?? '') ||
    manifest?.target?.sourceSha !== boot?.sourceSha ||
    stagedEntry?.sha256 !== config?.sha256 ||
    JSON.stringify(manifest?.serverLaunch ?? null) !== JSON.stringify(expectedLaunchIdentity) ||
    preparedManifest?.stagedPropertiesSha256 !== stagedEntry?.sha256
  ) return fail('prepared manifest target or staged file hash differs from the run descriptor/Leaf startup')

  const diskProperties = parseServerProperties(propertiesText)
  const runtimeComparison = compareRuntimeServerProperties(descriptor, diskProperties)
  if (!runtimeComparison.agrees) {
    return fail('actual staged Leaf config contradicts or omits descriptor server values', {
      missing: runtimeComparison.missing,
      mismatches: runtimeComparison.mismatches,
    })
  }
  const attestedComparison = compareRuntimeServerProperties(descriptor, config?.properties ?? {})
  if (!attestedComparison.agrees) {
    return fail('run-bound startup properties do not match descriptor values', {
      missing: attestedComparison.missing,
      mismatches: attestedComparison.mismatches,
    })
  }
  const diskProjection = Object.fromEntries(Object.keys(attestedComparison.expected).map((key) => [key, diskProperties[key] ?? null]))
  const attestedPropertyKeys = Object.keys(config?.properties ?? {})
  if (attestedPropertyKeys.length !== Object.keys(diskProjection).length || attestedPropertyKeys.some((key) => !Object.hasOwn(diskProjection, key))) {
    return fail('startup attestation contains unexpected properties outside the safe acceptance whitelist', { attestedPropertyKeys })
  }
  if (JSON.stringify(config?.properties) !== JSON.stringify(diskProjection)) {
    const valueMismatches = Object.keys(diskProjection).filter((key) => config?.properties?.[key] !== diskProjection[key])
    return fail('startup attested property values differ from the staged bytes', { valueMismatches })
  }
  return condition({
    id: 'run.serverConfigAttestation',
    verdict: 'PASS',
    required: true,
    reason: `Leaf process ${processInfo.pid} used --config ${expectedPropertiesPath}; startup SHA-256 matches the prepared manifest and exact descriptor/run BOOT binding`,
    detail: {
      runId,
      bootSourceSha: boot?.sourceSha ?? null,
      descriptorPath: startupAttestation.descriptorPath,
      descriptorSha256: startupAttestation.descriptorSha256,
      process: processInfo,
      runtime,
      console: expectedConsole,
      config: { path: config.path, sha256: config.sha256, properties: diskProjection },
      manifest: { path: expectedManifestPath, sha256: startupAttestation.manifestSha256, stagedPropertiesSha256: stagedEntry.sha256 },
    },
  })
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
