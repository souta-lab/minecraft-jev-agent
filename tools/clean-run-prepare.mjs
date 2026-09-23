#!/usr/bin/env bun
// clean-run-prepare: stage ONE clean Minecraft world for an M2 or M3 run.
//
//   bun tools/clean-run-prepare.mjs --environment tools/fixtures/m3-clean-environment.json --dry-run
//   bun tools/clean-run-prepare.mjs --environment tools/fixtures/m3-clean-environment.json \
//     --source-sha <frozen-40-hex> --seed -4187923615481 --apply
//
// What it does
// ------------
//   1. loads the clean-run descriptor and REFUSES unless it validates CLEAN
//      (tools/clean-run-environment.mjs);
//   2. freezes the exact source SHA (--source-sha, or --root <checkout> = git HEAD)
//      into a RESOLVED descriptor, because the run must boot exactly that commit;
//   3. stages the new world's directory with a gamerule datapack (when the pack
//      format is known) and writes the clean server.properties as a PROPOSAL next
//      to the live one - it never overwrites the shared server.properties;
//   4. writes the manifest / attempts ledger / resolved descriptor / copy of the
//      acceptance recipe next to the world, so the operator has one directory to
//      hand to the reviewer;
//   5. prints the exact ordered operator commands (start server, verify gamerules,
//      start the resident on the frozen SHA, run, gate, bundle).
//
// What it deliberately does NOT do
// --------------------------------
//   * it never starts, stops or restarts a Minecraft server or the resident;
//   * it never deletes or moves ANY file (there is no destructive operation in
//     this tool, by construction - see the `no_destructive_operation` guard);
//   * it never writes inside `world`, `world_nether`, `world_the_end` (the
//     protected live worlds) - every planned path is checked before it is used;
//   * it refuses a level name that already exists (unless this same descriptor
//     staged it and the world was never generated), a reused seed, a
//     placeholder/absent source SHA, and any descriptor that is not CLEAN.
//
// `--dry-run` is the default: it prints exactly what it would do, including every
// file path and content hash, and writes nothing.
//
// Exit: 0 = planned / applied / idempotent no-op, 1 = REFUSED (not clean), 2 = usage.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PROTECTED_LEVEL_NAMES, loadCleanEnvironment, validateCleanEnvironment, worldDataExists, worldDirNames } from './clean-run-environment.mjs'

export const RECORD = 'clean-run-prepare'
export const SCHEMA_VERSION = 1
export const PLAN_LINE = 'CLEAN_RUN_PREPARE_ACTION'
export const GUARD_LINE = 'CLEAN_RUN_PREPARE_GUARD'
export const REFUSED_LINE = 'CLEAN_RUN_PREPARE_REFUSED'
export const RESULT_LINE = 'CLEAN_RUN_PREPARE_RESULT'

/** The staged directory name (never a world name, never `world*`). */
export const RUN_DIR_NAME = 'm3-clean-run'
/** M2 trials use their own staged directory so the M3 acceptance files stay intact. */
export const M2_RUN_DIR_NAME = 'm2-clean-run'
/** The datapack namespace + path inside the new world. */
export const DATAPACK_DIR = 'datapacks/m3-clean-gamerules'
export const DATAPACK_NAMESPACE = 'm3clean'
export const M2_DATAPACK_DIR = 'datapacks/m2-repro-gamerules'
export const M2_DATAPACK_NAMESPACE = 'm2repro'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

/** descriptor `values.server` key -> server.properties key. */
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

export function parseArgs(argv) {
  const out = {
    environment: null,
    serverRoot: null,
    sourceSha: null,
    root: null,
    expectedMilestone: 'M3',
    seed: null,
    levelName: null,
    apply: false,
    dryRun: false,
    createServerRoot: false,
    overwriteProperties: false,
    report: null,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--environment') out.environment = argv[++i] ?? null
    else if (arg === '--server-root') out.serverRoot = argv[++i] ?? null
    else if (arg === '--source-sha') out.sourceSha = argv[++i] ?? null
    else if (arg === '--root') out.root = argv[++i] ?? null
    else if (arg === '--milestone') {
      const value = argv[++i] ?? null
      if (!['M2', 'M3'].includes(value)) throw new Error(`--milestone must be M2 or M3, got ${String(value)}`)
      out.expectedMilestone = value
    }
    else if (arg === '--seed') out.seed = argv[++i] ?? null
    else if (arg === '--level-name') out.levelName = argv[++i] ?? null
    else if (arg === '--apply') out.apply = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--create-server-root') out.createServerRoot = true
    else if (arg === '--overwrite-properties') out.overwriteProperties = true
    else if (arg === '--report') out.report = argv[++i] ?? null
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

export function usage() {
  return [
    'clean-run-prepare — stage ONE clean world for an M2 reproduction or M3 acceptance run',
    '',
    'Usage:',
    '  bun tools/clean-run-prepare.mjs --environment <descriptor.json> [--dry-run]',
    '  bun tools/clean-run-prepare.mjs --environment <descriptor.json> --source-sha <40-hex> --apply',
    '  bun tools/clean-run-prepare.mjs --environment <descriptor.json> --root <frozen-checkout> --apply',
    '  bun tools/clean-run-prepare.mjs --help',
    '',
    'Options:',
    '  --environment <p>        the clean-run descriptor (REQUIRED; must validate CLEAN)',
    '  --source-sha <40-hex>    the exact SHA the run must boot (freezes the descriptor)',
    '  --root <tree>            frozen resident checkout; its git HEAD must equal the resolved source SHA',
    '  --milestone <M2|M3>      expected descriptor contract (default: M3; M2 requires explicit selection)',
    '  --server-root <dir>      where the clean world is served from (default: descriptor cleanRun.worldContainer)',
    '  --level-name <name>      override the descriptor level name (must still be a new, unprotected name)',
    '  --seed <seed>            override the descriptor seed (must still differ from the live seed)',
    '  --apply                  perform the writes (default is --dry-run)',
    '  --create-server-root     allow --apply to create a missing --server-root directory',
    '  --overwrite-properties   legacy flag; refused because shared server.properties is never replaced',
    '  --report <path>          write the plan/result JSON to this path (never inside --server-root in dry-run)',
    '  --json                   print the plan/result JSON to stdout',
    '',
    'Guarantees: no server start/stop/restart, no deletion or move of any file, no write inside',
    'world / world_nether / world_the_end, no resident interaction, no control socket.',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// server.properties reading / writing (text-level, order-preserving)
// ---------------------------------------------------------------------------

/** Parse `key=value` lines, preserving order and escaping the `\:` Level name form. */
export function parseProperties(text) {
  const order = []
  const values = {}
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(line)
    if (match === null) continue
    order.push(match[1])
    values[match[1]] = match[2]
  }
  return { order, values }
}

/** Minecraft escapes `:` in server.properties values (`minecraft\:normal`). */
export function unescapeProperty(value) {
  return String(value ?? '').replace(/\\:/g, ':').replace(/\\\\/g, '\\')
}

export function escapeProperty(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

/** Rewrite (or append) the given keys, keeping every other line untouched. */
export function renderProperties(parsed, overrides) {
  const seen = new Set()
  const lines = []
  for (const key of parsed.order) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      lines.push(`${key}=${escapeProperty(overrides[key])}`)
      seen.add(key)
    } else {
      lines.push(`${key}=${parsed.values[key]}`)
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (seen.has(key)) continue
    lines.push(`${key}=${escapeProperty(value)}`)
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

function gitHead(root) {
  const out = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return out.status === 0 ? out.stdout.trim() : null
}

/**
 * The gamerule datapack: pack.mcmeta + minecraft:load tag + the function.
 *
 * Two measured facts about THIS build shape the file:
 *   * since 1.21.9 a data pack must declare `min_format`/`max_format`; a bare
 *     `pack_format` no longer declares support (the server's own
 *     `world/datapacks/bukkit/pack.mcmeta` uses `{"min_format":[94,1],"max_format":[94,1]}`),
 *     so a pack with only `pack_format` is rejected or ignored - a silent way to
 *     end up with a "clean" world whose rules were never set.
 *   * gamerules are PER DIMENSION (each level.dat owns its own set; the live
 *     world proves it: keep_inventory=true in all three dimensions while
 *     advance_time=false only in the overworld). A load function runs in the
 *     overworld context, so every rule is also asserted in the Nether and the End
 *     - otherwise a Nether death could still keep its inventory.
 *
 * Rules the build registers but the world does not carry (`notRegisteredInWorld`)
 * are excluded: the command would fail in-world. The console form is the bare
 * 1.21.11 snake_case rule id (camelCase is rejected by this build).
 */
export function gameruleDatapackFiles(levelName, gamerules, format, exclude = [], { milestone = 'M3' } = {}) {
  const datapackDir = milestone === 'M2' ? M2_DATAPACK_DIR : DATAPACK_DIR
  const datapackNamespace = milestone === 'M2' ? M2_DATAPACK_NAMESPACE : DATAPACK_NAMESPACE
  const excluded = new Set(exclude)
  const dimensions = format?.dimensions ?? ['minecraft:the_nether', 'minecraft:the_end']
  const sorted = Object.entries(gamerules)
    .filter(([rule]) => !excluded.has(rule))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const lines = [
    `# ${milestone.toLowerCase()} clean-run gamerules for ${levelName}: every rule is asserted at its declared vanilla default,`,
    '# in the overworld AND in every other dimension (gamerules are per-dimension in this build).',
    '# Written by tools/clean-run-prepare.mjs; the console `gamerule` listing is the human verification.',
    ...(excluded.size === 0 ? [] : [`# excluded (registered by the build but absent from this world): ${[...excluded].join(', ')}`]),
  ]
  for (const [rule, value] of sorted) {
    lines.push(`gamerule ${rule} ${String(value)}`)
    for (const dimension of dimensions) lines.push(`execute in ${dimension} run gamerule ${rule} ${String(value)}`)
  }
  const files = [
    {
      path: join(datapackDir, 'pack.mcmeta'),
      content: `${JSON.stringify({ pack: { description: `${milestone} clean-run gamerules (${levelName})`, min_format: format.min, max_format: format.max } }, null, 2)}\n`,
    },
    {
      path: join(datapackDir, 'data', 'minecraft', 'tags', 'function', 'load.json'),
      content: `${JSON.stringify({ values: [`${datapackNamespace}:set_gamerules`] }, null, 2)}\n`,
    },
    {
      path: join(datapackDir, 'data', datapackNamespace, 'function', 'set_gamerules.mcfunction'),
      content: `${lines.join('\n')}\n`,
    },
  ]
  return files
}

/** Data-pack formats a prepared world must not be written with. */
export const DEAD_PROPERTIES = Object.freeze({
  'spawn-monsters': 'this build does not read spawn-monsters at all (0 matches in DedicatedServerProperties.class): the real gate is the spawn_mobs / spawn_monsters GAMERULE. It is kept in the file only so a diff stays readable.',
  'spawn-animals': 'this build does not read spawn-animals: the real gate is the spawn_mobs class of gamerules.',
  'spawn-npcs': 'this build does not read spawn-npcs.',
})

/**
 * Build the whole plan. Pure: no writes, no server, no socket. `apply` only
 * selects the wording; `applyPlan` is what performs the writes.
 */
export function planPrepare({
  descriptorPath,
  serverRoot = null,
  sourceSha = null,
  root = null,
  enforceOperatorTreeSource = false,
  expectedMilestone = 'M3',
  seed = null,
  levelName = null,
  apply = false,
  createServerRoot = false,
  overwriteProperties = false,
} = {}) {
  const loaded = loadCleanEnvironment(descriptorPath)
  const refusals = []
  const warnings = []
  const guards = []
  if (loaded.document === null) {
    return { status: 'REFUSED', refusals: [{ reason: `descriptor_unreadable: ${String(loaded.error)}` }], warnings, guards, actions: [], operatorCommands: [], resolved: null, loaded, levelName: null, levelSeed: null, sourceSha: null, container: null }
  }

  // ---- resolve the descriptor (overrides + frozen SHA) ---------------------
  const resolvedDoc = JSON.parse(JSON.stringify(loaded.document))
  const overridesApplied = []
  if (typeof levelName === 'string' && levelName !== '') {
    resolvedDoc.values.levelName = levelName
    overridesApplied.push(`levelName=${levelName}`)
  }
  if (typeof seed === 'string' && seed !== '') {
    resolvedDoc.values.levelSeed = seed
    overridesApplied.push(`levelSeed=${seed}`)
  }
  const frozenSha = typeof sourceSha === 'string' && sourceSha !== '' ? sourceSha : root === null ? null : gitHead(root)
  if (frozenSha !== null) {
    resolvedDoc.values.sourceSha = frozenSha
    resolvedDoc.cleanRun.sourceSha.state = 'FROZEN'
    overridesApplied.push(`sourceSha=${frozenSha}${root !== null && sourceSha === null ? ` (git HEAD of ${root})` : ''}`)
  }
  if (enforceOperatorTreeSource && expectedMilestone === 'M3') {
    const operatorTree = root === null ? REPO_ROOT : resolve(root)
    const operatorTreeSha = gitHead(operatorTree)
    const operatorTreeMatchesSource = frozenSha !== null && operatorTreeSha === frozenSha
    guards.push({
      id: 'operator_tree_matches_frozen_sha',
      verdict: operatorTreeMatchesSource ? 'PASS' : 'FAIL',
      detail: operatorTreeMatchesSource
        ? `operator/resident checkout ${operatorTree} is exactly ${String(frozenSha)}`
        : `operator/resident checkout ${operatorTree} HEAD=${String(operatorTreeSha)} must equal resolved sourceSha=${String(frozenSha)}; pass --root <frozen-checkout>`,
    })
    if (!operatorTreeMatchesSource) {
      refusals.push({ reason: `operator_tree_source_mismatch: checkout=${operatorTree} HEAD=${String(operatorTreeSha)} sourceSha=${String(frozenSha)}; the resident command must run from the frozen checkout` })
    }
  }

  const container = serverRoot === null ? resolvedDoc.cleanRun?.worldContainer ?? null : resolve(serverRoot)
  const milestone = expectedMilestone
  if (serverRoot !== null && resolvedDoc.cleanRun.worldContainer !== container) {
    resolvedDoc.cleanRun.worldContainer = container
    overridesApplied.push(`worldContainer=${container}`)
  }
  const check = validateCleanEnvironment(resolvedDoc, {
    descriptorPath: loaded.path,
    descriptorSha256: loaded.sha256,
    worldContainer: container,
    expectedMilestone: milestone,
  })
  if (check.status !== 'CLEAN') {
    for (const entry of check.conditions) {
      if (entry.required && entry.verdict !== 'PASS') refusals.push({ reason: `descriptor_${entry.verdict.toLowerCase()}: ${entry.id}: ${entry.reason}` })
    }
    return {
      status: 'REFUSED',
      refusals,
      warnings,
      guards,
      actions: [],
      operatorCommands: [],
      resolved: resolvedDoc,
      check,
      loaded,
      overridesApplied,
      container: container === null ? null : resolve(container),
      levelName: resolvedDoc.values?.levelName ?? null,
      levelSeed: resolvedDoc.values?.levelSeed ?? null,
      sourceSha: resolvedDoc.values?.sourceSha ?? null,
    }
  }

  const levelName2 = resolvedDoc.values.levelName
  const levelSeed = String(resolvedDoc.values.levelSeed)
  const runDirName = milestone === 'M2' ? M2_RUN_DIR_NAME : RUN_DIR_NAME
  const datapackDir = milestone === 'M2' ? M2_DATAPACK_DIR : DATAPACK_DIR
  const runDir = join(resolve(container), runDirName)
  const worldDir = join(resolve(container), levelName2)
  const propertiesPath = join(resolve(container), 'server.properties')
  const files = []

  // ---- guards --------------------------------------------------------------
  const protectedRoots = [...new Set([...PROTECTED_LEVEL_NAMES, ...(Array.isArray(resolvedDoc.cleanRun?.protectedWorldNames) ? resolvedDoc.cleanRun.protectedWorldNames : []), ...(resolvedDoc.cleanRun?.previousWorld?.levelName ? [resolvedDoc.cleanRun.previousWorld.levelName] : [])])]
  const plannedPaths = [worldDir, runDir, join(worldDir, datapackDir), join(runDir, 'environment-resolved.json'), join(runDir, 'manifest.json'), join(runDir, 'attempts.json'), join(runDir, 'server.properties.clean'), join(runDir, 'server-properties.diff.txt'), join(runDir, 'operator-commands.txt'), join(runDir, 'ACCEPTANCE-RECIPE.md')]
  const protectedHits = plannedPaths.filter((path) => protectedRoots.some((name) => path === join(resolve(container), name) || path.startsWith(join(resolve(container), name) + sep)))
  guards.push({
    id: 'protected_world_paths',
    verdict: protectedHits.length === 0 ? 'PASS' : 'FAIL',
    detail:
      protectedHits.length === 0
        ? `none of ${plannedPaths.length} planned paths is inside ${protectedRoots.map((name) => `${name}/`).join(', ')} (container ${resolve(container)})`
        : `planned path(s) inside a protected world: ${protectedHits.join(', ')}`,
  })
  if (protectedHits.length > 0) refusals.push({ reason: `protected_world_path: ${protectedHits.join(', ')}` })
  // The container must be a world CONTAINER, never one of the worlds themselves.
  const containerInsideProtected = PROTECTED_LEVEL_NAMES.includes(basename(resolve(container)))
  guards.push({
    id: 'container_outside_protected_worlds',
    verdict: containerInsideProtected ? 'FAIL' : 'PASS',
    detail: containerInsideProtected ? `--server-root ${resolve(container)} IS a protected world directory (${basename(resolve(container))})` : `--server-root ${resolve(container)} is a world container, not a world directory`,
  })
  if (containerInsideProtected) refusals.push({ reason: 'server_root_inside_protected_world' })
  // The container must not be (inside) the TARGET world itself: staging a world
  // directory inside the world directory it is meant to create is never intended.
  const descriptorContainer = loaded.document.cleanRun?.worldContainer ?? null
  const targetWorldDirs = descriptorContainer === null ? [] : worldDirNames(levelName2 ?? loaded.document.values?.levelName ?? '').map((dir) => join(resolve(descriptorContainer), dir))
  const nestedInTargetWorld = targetWorldDirs.filter((dir) => resolve(container) === dir || resolve(container).startsWith(dir + sep))
  guards.push({
    id: 'server_root_not_inside_target_world',
    verdict: nestedInTargetWorld.length === 0 ? 'PASS' : 'FAIL',
    detail:
      nestedInTargetWorld.length === 0
        ? `--server-root ${resolve(container)} is not inside the target world directory (${targetWorldDirs.join(', ')})`
        : `--server-root ${resolve(container)} is inside the target world directory ${nestedInTargetWorld.join(', ')}`,
  })
  if (nestedInTargetWorld.length > 0) refusals.push({ reason: `server_root_inside_target_world: ${nestedInTargetWorld.join(', ')}` })
  const containerHasLevelDat = worldDataExists(resolve(container))
  guards.push({
    id: 'server_root_is_not_a_world',
    verdict: containerHasLevelDat ? 'FAIL' : 'PASS',
    detail: containerHasLevelDat ? `--server-root ${resolve(container)} contains level.dat/level.dat_old, i.e. it IS a generated world` : `--server-root ${resolve(container)} contains no world data`,
  })
  if (containerHasLevelDat) refusals.push({ reason: `server_root_is_a_world: ${resolve(container)} contains level.dat` })
  guards.push({ id: 'no_destructive_operation', verdict: 'PASS', detail: 'this tool performs no delete, no move and no chmod; every action below is mkdir or write' })
  guards.push({ id: 'no_server_control', verdict: 'PASS', detail: 'no server start/stop/restart command is executed; the start command is only PRINTED for the operator' })

  if (!existsSync(resolve(container)) && !createServerRoot) {
    refusals.push({ reason: `server_root_missing: ${resolve(container)} does not exist (pass --create-server-root to create it)` })
  }
  if (overwriteProperties) {
    refusals.push({ reason: milestone === 'M2'
      ? 'm2_shared_properties_mutation_forbidden: M2 trials use the staged server.properties.clean through the server --config argument and must never replace the shared server.properties'
      : 'm3_shared_properties_mutation_forbidden: M3 runs use the staged server.properties.clean through the server --config argument and must never replace the shared server.properties' })
  }

  // ---- the world must be new, and NOT already generated --------------------
  const scanned = worldDirNames(levelName2).map((dir) => ({ dir, path: join(resolve(container), dir), exists: existsSync(join(resolve(container), dir)), generated: worldDataExists(join(resolve(container), dir)) }))
  const generated = scanned.filter((entry) => entry.generated)
  if (generated.length > 0) {
    refusals.push({ reason: `world_already_generated: ${generated.map((entry) => `${entry.dir} (level.dat present)`).join(', ')} — a played world can never be a clean-run target; choose a NEW --level-name/--seed` })
  }
  const manifestPath = join(runDir, 'manifest.json')
  const previousManifest = existsSync(manifestPath) ? safeJson(manifestPath) : null
  const sameStagedTarget = previousManifest !== null && previousManifest?.target?.levelName === levelName2 && previousManifest?.target?.levelSeed === levelSeed && previousManifest?.descriptor?.sha256 === loaded.sha256
  if (scanned.some((entry) => entry.exists) && !sameStagedTarget && generated.length === 0) {
    refusals.push({ reason: `target_level_name_exists: ${scanned.filter((entry) => entry.exists).map((entry) => entry.dir).join(', ')} already exists (not staged by this descriptor); the harness refuses to reuse or overwrite it` })
  }

  // ---- the seed must not have been used by an earlier attempt --------------
  const attemptsPath = join(runDir, 'attempts.json')
  const attempts = existsSync(attemptsPath) ? safeJson(attemptsPath) : null
  const previousAttempts = Array.isArray(attempts?.attempts) ? attempts.attempts : []
  const reused = previousAttempts.find((entry) => entry.levelName === levelName2 && String(entry.levelSeed) === levelSeed)
  if (reused !== undefined && !(sameStagedTarget && reused.levelName === levelName2)) {
    refusals.push({ reason: `seed_already_used: levelName=${levelName2} levelSeed=${levelSeed} was prepared at ${String(reused.preparedAt)}; a new attempt needs a NEW seed (--seed)` })
  }
  if (reused !== undefined && sameStagedTarget) warnings.push(`this exact world/seed was prepared before at ${String(reused.preparedAt)}; the world has not been generated, so re-applying is an idempotent no-op (not a new attempt)`)
  if (sameStagedTarget && previousManifest?.target?.sourceSha !== undefined && frozenSha !== null && previousManifest.target.sourceSha !== frozenSha) {
    warnings.push(`the frozen sourceSha changed since this world was prepared (${String(previousManifest.target.sourceSha)} -> ${frozenSha}); the world has not been generated, so it is still clean, but every staged file is rewritten for the new SHA`)
  }

  // ---- the live properties we read (read-only) -----------------------------
  let propertiesChange = null
  let proposedProperties = null
  const propertyChecks = []
  if (existsSync(propertiesPath)) {
    let text
    try {
      text = readFileSync(propertiesPath, 'utf8')
    } catch (thrown) {
      refusals.push({ reason: `server_properties_unreadable: ${thrown instanceof Error ? thrown.message : String(thrown)}` })
      text = null
    }
    if (text !== null) {
      const parsed = parseProperties(text)
      const overrides = {
        'level-name': levelName2,
        'level-seed': levelSeed,
        difficulty: String(resolvedDoc.values.difficulty),
        'spawn-monsters': String(resolvedDoc.values.mobSpawning === true),
        motd: `${milestone} CLEAN RUN ${levelName2} seed=${levelSeed}`,
      }
      for (const [property, whyDead] of Object.entries(DEAD_PROPERTIES)) {
        if (parsed.values[property] === undefined) continue
        propertyChecks.push({ property, wanted: 'not used by this build', verdict: 'NOT_READ_BY_BUILD', detail: `${property}=${parsed.values[property]} is in the file but ${whyDead}` })
      }
      for (const [key, property] of Object.entries(SERVER_PROPERTY_MAP)) {
        const value = resolvedDoc.values.server?.[key]
        if (value === undefined) continue
        if (parsed.values[property] === undefined) {
          propertyChecks.push({
            property,
            wanted: value,
            verdict: 'KEY_ABSENT',
            detail:
              property === 'bonus-chest'
                ? `this build has no bonus-chest property; it is enforced by NEVER passing the --bonusChest launch flag (see operator-commands.txt)`
                : `${property} is not a key in this build's server.properties; it cannot be enforced by file (see operator-commands.txt)`,
          })
          continue
        }
        overrides[property] = String(value)
      }
      const changes = []
      for (const [key, value] of Object.entries(overrides)) {
        const current = parsed.values[key]
        const currentNorm = current === undefined ? undefined : unescapeProperty(current)
        if (currentNorm !== String(value)) changes.push({ key, from: currentNorm ?? null, to: String(value) })
      }
      proposedProperties = renderProperties(parsed, overrides)
      propertiesChange = { path: propertiesPath, changes, proposed: join(runDir, 'server.properties.clean'), source: propertiesPath }
      // the port must match the descriptor's serverId (worldKey identity)
      const port = parsed.values['server-port']
      const wantedPort = String(resolvedDoc.values.serverId ?? '').split(':').pop()
      if (port !== undefined && wantedPort !== '' && String(port) !== wantedPort) {
        refusals.push({ reason: `server_port_mismatch: server.properties server-port=${port} but the descriptor serverId=${String(resolvedDoc.values.serverId)} (the resident's worldKey.serverId would not match the descriptor)` })
      }
    }
  } else {
    warnings.push(`no ${propertiesPath} exists in this container; the clean properties are staged as a PROPOSAL only`)
  }

  // ---- bot must not be an operator (commands are the generic assist) -------
  const opsPath = join(resolve(container), 'ops.json')
  const bot = resolvedDoc.cleanRun?.botUsername ?? 'AI_Buddy'
  if (existsSync(opsPath)) {
    const ops = safeJson(opsPath)
    const opped = Array.isArray(ops) ? ops.some((entry) => entry?.name === bot) : false
    propertyChecks.push({ property: 'ops.json', wanted: `no entry for ${bot}`, verdict: opped ? 'FAIL' : 'PASS', detail: opped ? `${bot} IS an operator in ${opsPath}: command access is an assist` : `${bot} is not in ${opsPath}` })
    if (opped) refusals.push({ reason: `bot_is_operator: ${bot} appears in ${opsPath}` })
  } else {
    propertyChecks.push({ property: 'ops.json', wanted: `no entry for ${bot}`, verdict: 'PASS', detail: `${opsPath} does not exist, so no operator entry exists` })
  }

  if (refusals.length > 0) {
    return { status: 'REFUSED', refusals, warnings, guards, actions: [], operatorCommands: [], resolved: resolvedDoc, check, loaded, overridesApplied, container: resolve(container), propertyChecks }
  }

  // ---- actions -------------------------------------------------------------
  const actions = []
  actions.push({ kind: 'mkdir', path: worldDir, exists: existsSync(worldDir), note: 'the new world directory (the server generates level.dat/region on first boot)' })
  const mechanism = resolvedDoc.cleanRun?.gameruleMechanism ?? {}
  const legacyPackFormat = mechanism.datapackPackFormat ?? null
  const packFormat = mechanism.datapackFormat ?? (typeof legacyPackFormat === 'number' ? { min: legacyPackFormat, max: legacyPackFormat, legacy: true } : null)
  if (packFormat === null) {
    warnings.push('no datapackFormat in the descriptor: the gamerule datapack is SKIPPED. The console `gamerule` listing after first boot is then the authoritative gamerule evidence.')
  } else {
    if (packFormat.legacy === true) warnings.push('datapackFormat is missing and only the legacy datapackPackFormat number is set: since 1.21.9 a data pack must declare min_format/max_format, so this pack may be ignored by the server. Set cleanRun.gameruleMechanism.datapackFormat.')
    const notRegistered = Object.keys(resolvedDoc.cleanRun?.gamerulePolicy?.notRegisteredInWorld ?? {})
    for (const file of gameruleDatapackFiles(levelName2, resolvedDoc.values.gamerules ?? {}, packFormat, notRegistered, { milestone })) {
      files.push({ path: join(worldDir, file.path), content: file.content, note: 'gamerule datapack (asserted on every world load, per dimension)' })
    }
  }
  const resolvedForFile = { ...resolvedDoc, resolvedBy: { tool: 'tools/clean-run-prepare.mjs', from: loaded.path, fromSha256: loaded.sha256, overrides: overridesApplied, at: 'see manifest.json' } }
  files.push({ path: join(runDir, 'environment-resolved.json'), content: `${JSON.stringify(resolvedForFile, null, 2)}\n`, note: 'the descriptor the bundle and the clean-run gate must both consume' })
  if (proposedProperties !== null) {
    files.push({ path: join(runDir, 'server.properties.clean'), content: proposedProperties, note: 'staged clean server.properties (owner-only permissions; content is never printed or copied into run evidence)' })
    const diff = (propertiesChange?.changes ?? []).map((entry) => `${entry.key}: ${entry.from === null ? '(absent)' : entry.from} -> ${entry.to}`).join('\n')
    files.push({ path: join(runDir, 'server-properties.diff.txt'), content: `${diff}\n`, note: 'every key this proposal changes' })
  }
  const operatorCommands = buildOperatorCommands({ container: resolve(container), runDir, levelName: levelName2, levelSeed, sourceSha: frozenSha ?? resolvedDoc.values.sourceSha, root, recipePath: join(runDir, 'ACCEPTANCE-RECIPE.md'), milestone })
  files.push({ path: join(runDir, 'operator-commands.txt'), content: `${operatorCommands.join('\n')}\n`, note: 'the exact ordered commands for the clean attempt' })
  const recipeSource = milestone === 'M3' ? join(REPO_ROOT, 'CLEAN-RUN-ACCEPTANCE.md') : null
  if (recipeSource !== null && existsSync(recipeSource)) files.push({ path: join(runDir, 'ACCEPTANCE-RECIPE.md'), content: readFileSync(recipeSource, 'utf8'), note: 'copy of the acceptance recipe, next to the run evidence' })

  for (const file of files) {
    const exists = existsSync(file.path)
    const same = exists ? safeText(file.path) === file.content : false
    actions.push({ kind: 'write', path: file.path, bytes: Buffer.byteLength(file.content, 'utf8'), sha256: sha256Text(file.content), exists, unchanged: same, note: file.note })
  }
  actions.push({
    kind: 'write',
    path: manifestPath,
    bytes: null,
    sha256: null,
    exists: existsSync(manifestPath),
    unchanged: false,
    note: 'prep manifest (descriptor sha, resolved world/seed/sha, file hashes, guards) — written last',
  })
  actions.push({
    kind: 'write',
    path: attemptsPath,
    bytes: null,
    sha256: null,
    exists: existsSync(attemptsPath),
    unchanged: false,
    note: 'append-only attempt ledger (levelName/levelSeed/sourceSha/perparedAt) — written last',
  })
  const status = apply ? 'APPLIED' : 'PLANNED'
  return {
    status,
    refusals,
    warnings,
    guards,
    actions,
    files,
    operatorCommands,
    resolved: resolvedDoc,
    resolvedForFile,
    check,
    loaded,
    overridesApplied,
    container: resolve(container),
    worldDir,
    runDir,
    levelName: levelName2,
    levelSeed,
    sourceSha: frozenSha ?? resolvedDoc.values.sourceSha,
    propertiesChange,
    propertyChecks,
    previousManifest,
    sameStagedTarget,
  }
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function safeText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The ordered operator commands. Nothing here is executed by this tool. */
export function buildOperatorCommands({ container, runDir, levelName, levelSeed, sourceSha, root = null, recipePath, milestone = 'M3' }) {
  const tree = root === null || root === undefined ? REPO_ROOT : resolve(root)
  if (milestone === 'M2') {
    return [
      `# ==== M2 REPRODUCTION: ${levelName} (seed ${levelSeed}) on sourceSha ${String(sourceSha)} ====`,
      '# This plan never replaces the shared server.properties; the harness gives the server this staged file with --config.',
      `# Server configuration artifact: ${runDir}/server.properties.clean`,
      `cd ${container} && java -Xmx1G -Xms1G -DPaper.IgnoreJavaVersion=true -jar leaf-1.21.11-178.jar --nogui --config ${runDir}/server.properties.clean --universe ${container} --level-name ${levelName}`,
      `# Verify the generated seed is ${levelSeed}, the fresh world has no prior level.dat, and difficulty remains peaceful.`,
      `# Keep the run's BOOT source=${String(sourceSha)} and run-scoped M2 evidence with the campaign record.`,
      `# Driver checkout: ${tree}/buddy-driver`,
      `# Identity/evidence directory: ${runDir}`,
    ]
  }
  return [
    `# ==== M3 CLEAN RUN: ${levelName} (seed ${levelSeed}) on sourceSha ${String(sourceSha)} ====`,
    `# 0. this file is the plan; the recipe is ${recipePath}`,
    `# 1. OPERATOR / H4: stop the current resident through its own control socket; wait for it to exit.`,
    `# 2. OPERATOR / H4: stop the current Leaf server gracefully from its console; wait for it to exit.`,
    `#    Do not copy over, edit, or restore the shared ${container}/server.properties.`,
    `# 3. start the clean world from the staged config with both world paths explicit:`,
    `cd ${container} && setsid --fork /usr/lib/jvm/java-21-openjdk-amd64/bin/java -Xmx1G -Xms1G -DPaper.IgnoreJavaVersion=true -jar leaf-1.21.11-178.jar --nogui --config ${runDir}/server.properties.clean --universe ${container} --level-name ${levelName} </dev/null >>server.log 2>&1 &`,
    `#    --config selects the staged seed/config; --universe and --level-name select the descriptor's world. Never pass --bonusChest.`,
    `# 4. after the first boot, VERIFY the world + gamerules on the server console and paste the output into:`,
    `#    ${runDir}/gamerule-verification.txt`,
    `#    (console commands) list  /  seed  /  gamerule`,
    `#    gamerules are PER DIMENSION in this build: also run`,
    `#      execute in minecraft:the_nether run gamerule`,
    `#      execute in minecraft:the_end run gamerule`,
    `#    the gamerule ids are the snake_case ids from ${runDir}/environment-resolved.json (camelCase is`,
    `#    REJECTED by this build); keep_inventory must be false in ALL THREE dimensions because the M3 route dies in the Nether`,
    `#    reviewer check: keepInventory=false and every rule in ${runDir}/environment-resolved.json`,
    `# 5. start the resident from this run's FROZEN checkout (run prepare with --root <that checkout>):`,
    `cd ${tree}/buddy-driver && BUDDY_SERVER_PROPERTIES_PATH=${runDir}/server.properties.clean setsid --fork nohup bun agent-runner.mts </dev/null > runner.out 2>&1 &`,
    `#    the run's BOOT line must report source=${String(sourceSha)}`,
    `#    BUDDY_SERVER_PROPERTIES_PATH makes HOST seed attestation read the same staged config the server used.`,
    `# 6. run the M3 attempt (drive the agent to the Nether + 12 eyes). Record the runId from BOOT.`,
    `# 7. refresh the HOST acceptance record (read-only query; it attests levelName + seed):`,
    `printf '{"id":"acceptance-refresh","cmd":"acceptance"}\\n' | socat - UNIX-CONNECT:${tree}/buddy-driver/data/resident/control.sock`,
    `# 8. the canonical bundle, with the RESOLVED descriptor as the environment record:`,
    `bun tools/m3-acceptance-bundle.mjs --run <RUN_ID> --root ${tree} --environment ${runDir}/environment-resolved.json --evidence-class live`,
    `# 9. the clean-run gate, written NEXT TO the bundle (additive; bundle.json is never modified):`,
    `bun tools/clean-run-gate.mjs --environment ${runDir}/environment-resolved.json --bundle-dir ${tree}/runs/m3-live/acceptance-bundle-<RUN_ID> --run <RUN_ID> --out ${tree}/runs/m3-live/acceptance-bundle-<RUN_ID>`,
    `# ACCEPTED requires: descriptor CLEAN + run evidence consistent + bundle PASS + liveAcceptance=true`,
  ]
}

/** Perform the planned writes. Idempotent: identical content is left untouched. */
export function applyPlan(plan, { now = () => new Date(), write = () => {} } = {}) {
  if (plan.status === 'REFUSED') return { ...plan, applied: 0, unchanged: 0 }
  const applied = []
  const unchanged = []
  const mkdirSyncAll = (path) => mkdirSync(path, { recursive: true })
  if (!existsSync(plan.container)) mkdirSyncAll(plan.container)
  for (const action of plan.actions) {
    if (action.kind === 'mkdir') {
      if (!existsSync(action.path)) {
        mkdirSyncAll(action.path)
        applied.push(action.path)
      } else unchanged.push(action.path)
      continue
    }
    if (action.kind === 'write' && action.path.endsWith('manifest.json')) continue
    if (action.kind === 'write' && action.path.endsWith('attempts.json')) continue
    const content = plan.files.find((file) => file.path === action.path)?.content
    if (content === undefined) continue
    mkdirSyncAll(dirname(action.path))
    const privateProperties = basename(action.path) === 'server.properties.clean'
    if (safeText(action.path) === content) {
      if (privateProperties) chmodSync(action.path, 0o600)
      unchanged.push(action.path)
      continue
    }
    if (action.path.endsWith('server.properties') && existsSync(action.path)) {
      const bak = `${action.path}.clean-run-bak-${now().toISOString().replace(/[:.]/g, '-')}`
      writeFileSync(bak, readFileSync(action.path, 'utf8'), 'utf8')
      write(`CLEAN_RUN_PREPARE_BACKUP path=${bak}\n`)
    }
    if (privateProperties) {
      writeFileSync(action.path, content, { encoding: 'utf8', mode: 0o600 })
      chmodSync(action.path, 0o600)
    } else {
      writeFileSync(action.path, content, 'utf8')
    }
    applied.push(action.path)
  }
  // the manifest + ledger are written LAST, after every staged file exists
  const nowIso = now().toISOString()
  const fileHashes = (plan.files ?? []).map((file) => ({ path: file.path, sha256: sha256Text(file.content), bytes: Buffer.byteLength(file.content, 'utf8'), note: file.note }))
  const manifest = {
    record: RECORD,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso,
    mode: 'apply',
    descriptor: { path: plan.loaded.path, sha256: plan.loaded.sha256 },
    resolved: { path: join(plan.runDir, 'environment-resolved.json'), overrides: plan.overridesApplied },
    target: { levelName: plan.levelName, levelSeed: plan.levelSeed, sourceSha: plan.sourceSha, worldDir: plan.worldDir, container: plan.container, levelDatPresentAtPrepare: false },
    serverProperties: plan.propertiesChange ?? null,
    guards: plan.guards,
    propertyChecks: plan.propertyChecks ?? [],
    files: fileHashes,
    operatorCommands: plan.operatorCommands,
    warnings: plan.warnings,
  }
  mkdirSyncAll(plan.runDir)
  writeFileSync(join(plan.runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const attemptsPath = join(plan.runDir, 'attempts.json')
  const ledger = existsSync(attemptsPath) ? safeJson(attemptsPath) ?? { record: 'clean-run-attempts', schemaVersion: 1, attempts: [] } : { record: 'clean-run-attempts', schemaVersion: 1, attempts: [] }
  if (!Array.isArray(ledger.attempts)) ledger.attempts = []
  if (!ledger.attempts.some((entry) => entry.levelName === plan.levelName && String(entry.levelSeed) === plan.levelSeed)) {
    ledger.attempts.push({ levelName: plan.levelName, levelSeed: plan.levelSeed, sourceSha: plan.sourceSha, preparedAt: nowIso, worldDir: plan.worldDir, levelDatPresentAtPrepare: false })
  }
  ledger.updatedAt = nowIso
  writeFileSync(attemptsPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  return { ...plan, status: applied.length === 0 ? 'IDEMPOTENT_NOOP' : 'APPLIED', applied, unchanged, manifest }
}

export function planMarkdown(plan) {
  const lines = []
  lines.push(`# Clean-run preparation — ${plan.status}`)
  lines.push('')
  lines.push(`- descriptor: ${String(plan.loaded?.path)} (sha256 ${String(plan.loaded?.sha256)})`)
  lines.push(`- descriptor check: ${String(plan.check?.status ?? 'n/a')}`)
  lines.push(`- container: ${String(plan.container ?? plan.resolved?.cleanRun?.worldContainer)}`)
  lines.push(`- target world: levelName=${String(plan.levelName ?? plan.resolved?.values?.levelName)} levelSeed=${String(plan.levelSeed ?? plan.resolved?.values?.levelSeed)} sourceSha=${String(plan.sourceSha ?? plan.resolved?.values?.sourceSha)}`)
  lines.push('')
  if (plan.refusals.length > 0) {
    lines.push('## REFUSED')
    lines.push('')
    for (const entry of plan.refusals) lines.push(`- ${entry.reason}`)
    lines.push('')
  }
  lines.push('## Guards')
  lines.push('')
  for (const guard of plan.guards) lines.push(`- ${guard.verdict} ${guard.id}: ${guard.detail}`)
  lines.push('')
  if (plan.propertyChecks?.length > 0) {
    lines.push('## Property checks')
    lines.push('')
    for (const entry of plan.propertyChecks) lines.push(`- ${entry.verdict} ${entry.property}: ${entry.detail}`)
    lines.push('')
  }
  lines.push('## Actions (what would be done / was done)')
  lines.push('')
  for (const action of plan.actions) lines.push(`- ${action.kind} ${action.path}${action.sha256 === null || action.sha256 === undefined ? '' : ` sha256=${action.sha256.slice(0, 16)}`}${action.unchanged ? ' (UNCHANGED)' : ''} — ${String(action.note ?? '')}`)
  lines.push('')
  if (plan.warnings.length > 0) {
    lines.push('## Warnings')
    lines.push('')
    for (const entry of plan.warnings) lines.push(`- ${entry}`)
    lines.push('')
  }
  lines.push('## Operator commands (printed, never executed)')
  lines.push('')
  lines.push('```bash')
  for (const entry of plan.operatorCommands) lines.push(entry)
  lines.push('```')
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function runCli({ argv = process.argv.slice(2), write = (line) => process.stdout.write(line), writeError = (line) => process.stderr.write(line), plan = planPrepare, apply = applyPlan } = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    writeError(`CLEAN_RUN_PREPARE_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return { exitCode: 2, plan: null }
  }
  if (args.help) {
    write(usage())
    return { exitCode: 0, plan: null }
  }
  if (args.environment === null) {
    writeError('CLEAN_RUN_PREPARE_ERROR --environment <descriptor.json> is required\n')
    return { exitCode: 2, plan: null }
  }
  let result = plan({
    descriptorPath: resolve(args.environment),
    serverRoot: args.serverRoot,
    sourceSha: args.sourceSha,
    root: args.root,
    enforceOperatorTreeSource: true,
    seed: args.seed,
    levelName: args.levelName,
    apply: args.apply,
    createServerRoot: args.createServerRoot,
    overwriteProperties: args.overwriteProperties,
    expectedMilestone: args.expectedMilestone,
  })
  if (args.apply && result.status !== 'REFUSED' && result.status !== 'IDEMPOTENT_NOOP') {
    result = apply(result, { write: writeError })
  } else if (args.apply && result.status === 'IDEMPOTENT_NOOP') {
    result = apply(result, { write: writeError })
    result.status = 'IDEMPOTENT_NOOP'
  }
  const mode = args.apply ? 'apply' : 'dry-run'
  const lines = [
    `CLEAN_RUN_PREPARE mode=${mode} record=${RECORD} schemaVersion=${SCHEMA_VERSION}`,
    `CLEAN_RUN_PREPARE_DESCRIPTOR path=${String(result.loaded?.path)} sha256=${String(result.loaded?.sha256)} status=${String(result.check?.status ?? 'n/a')} levelName=${String(result.levelName ?? result.resolved?.values?.levelName)} levelSeed=${String(result.levelSeed ?? result.resolved?.values?.levelSeed)} sourceSha=${String(result.sourceSha ?? result.resolved?.values?.sourceSha)}`,
    ...result.guards.map((guard) => `${GUARD_LINE} id=${guard.id} verdict=${guard.verdict} detail=${JSON.stringify(guard.detail)}`),
    ...(result.propertyChecks ?? []).map((entry) => `${GUARD_LINE} id=property:${entry.property} verdict=${entry.verdict} detail=${JSON.stringify(entry.detail)}`),
    ...result.actions.map((action) => `${PLAN_LINE} kind=${action.kind} path=${action.path}${action.sha256 === null || action.sha256 === undefined ? '' : ` sha256=${action.sha256}`}${action.unchanged ? ' unchanged=true' : ''} note=${JSON.stringify(String(action.note ?? ''))}`),
    ...result.refusals.map((entry) => `${REFUSED_LINE} ${entry.reason}`),
    ...result.warnings.map((entry) => `CLEAN_RUN_PREPARE_WARNING ${entry}`),
  ]
  if (args.json) write(`${JSON.stringify({ record: RECORD, schemaVersion: SCHEMA_VERSION, mode, ...result })}\n`)
  else write(planMarkdown(result))
  const resultLine = `${RESULT_LINE} mode=${mode} status=${result.status} container=${String(result.container ?? 'none')} levelName=${String(result.levelName ?? 'none')} levelSeed=${String(result.levelSeed ?? 'none')} sourceSha=${String(result.sourceSha ?? 'none')} actions=${result.actions.length} applied=${(result.applied ?? []).length} unchanged=${(result.unchanged ?? []).length}${result.runDir === undefined ? '' : ` runDir=${result.runDir}`}\n`
  const target = args.json ? writeError : write
  for (const line of lines) target(`${line}\n`)
  target(resultLine)
  if (args.report !== null && args.report !== '') {
    try {
      writeFileSync(resolve(args.report), `${JSON.stringify({ record: RECORD, schemaVersion: SCHEMA_VERSION, mode, ...result, files: undefined }, null, 2)}\n`, 'utf8')
    } catch (thrown) {
      writeError(`CLEAN_RUN_PREPARE_REPORT_FAILED path=${String(args.report)} reason=${thrown instanceof Error ? thrown.message : String(thrown)}\n`)
    }
  }
  return { exitCode: result.status === 'REFUSED' ? 1 : 0, plan: result }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const outcome = await runCli()
  process.exitCode = outcome.exitCode
}
