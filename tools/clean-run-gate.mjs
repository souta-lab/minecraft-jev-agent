#!/usr/bin/env bun
// clean-run-gate: decide whether ONE acceptance bundle came from a CLEAN world
// (new seed / new world / no assists), WITHOUT re-judging the milestone.
//
//   bun tools/clean-run-gate.mjs --environment <descriptor.json>
//   bun tools/clean-run-gate.mjs --environment <descriptor.json> \
//     --bundle-dir <bundle dir> --run <runId> [--out <bundle dir>]
//
// Why a separate gate
// -------------------
// `tools/m3-gate.mjs` answers "did this run reach the Nether and hold 12 eyes of
// ender with model authority?" It CANNOT answer "was the world a clean world?" -
// and a PASS from the current world (`level-seed=2024`, `keepInventory=true`,
// operator grants/summons/flooding) is worthless as M3 evidence. This gate is
// the missing question, and it is additive on purpose:
//
//   * it never re-evaluates a milestone predicate (no M2/M3 mechanics here);
//   * it never touches bundle.json - the canonical verdict stays exactly what
//     `tools/m3-acceptance-bundle.mjs` wrote;
//   * it reads that verdict and only ever REQUIRES it (`PASS` + `liveAcceptance`
//     + `--evidence-class live`), never produces it.
//
// The combined answer is therefore one line a reviewer can act on:
//
//   CLEAN_RUN_M3 status=ACCEPTED
//     = descriptor CLEAN
//     + every required run-evidence condition PASS
//     + bundle.git.dirty === false + this run's complete source window binds to
//       the same frozen commit, including any applied hot reloads
//     + the bundle's own acceptanceVerdict.status === PASS
//     + bundle.liveAcceptance === true (which itself requires host.lock + a HOST
//       acceptance record + BOOT SHA == tree HEAD + `--evidence-class live`)
//
// Exit: 0 = CLEAN (and ACCEPTED when a bundle was given), 1 = NOT_CLEAN /
//       NOT_ACCEPTED, 2 = UNKNOWN (a required input is missing/unreadable).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  SCHEMA_VERSION,
  checkConsoleGameruleEvidence,
  checkRunEvidence,
  extractRunWindow,
  loadCleanEnvironment,
  observedDeviations,
  observedWorlds,
  sha256Text,
  validateCleanEnvironment,
} from './clean-run-environment.mjs'

export const RECORD = 'clean-run-gate'
export const GATE_LINE = 'CLEAN_RUN_GATE'
export const CONDITION_LINE = 'CLEAN_RUN_CONDITION'
export const ARTIFACT_LINE = 'CLEAN_RUN_ARTIFACT'
export const M3_LINE = 'CLEAN_RUN_M3'
export const RESULT_LINE = 'CLEAN_RUN_RESULT'
/**
 * The conditions that make a clean-run ACCEPTANCE. `descriptor` is the premise,
 * `run` the evidence, `bundle` the canonical milestone verdict. Kept as one
 * frozen list so the markdown summary and the exit code cannot drift.
 */
export const ACCEPTANCE_RULES = Object.freeze([
  'descriptor.status === CLEAN',
  'every required run-evidence condition === PASS',
  'run.preparationFreshness === PASS (exact pre-run manifest and attempt ledger precede this BOOT)',
  'bundle.git.dirty === false',
  'descriptor frozen sourceSha === clean bundle.git.head === this run BOOT sourceSha',
  'the run-scoped source window is complete and every applied reload names the same sourceSha',
  'bundle.acceptanceVerdict.status === PASS',
  'bundle.liveAcceptance === true',
  'bundle.evidenceClass === live',
])

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/i

export function parseArgs(argv) {
  const out = {
    environment: null,
    bundleDir: null,
    artifact: null,
    run: null,
    root: null,
    out: null,
    worldContainer: null,
    observedWorld: null,
    gameruleVerification: null,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--environment') out.environment = argv[++i] ?? null
    else if (arg === '--bundle-dir') out.bundleDir = argv[++i] ?? null
    else if (arg === '--artifact') out.artifact = argv[++i] ?? null
    else if (arg === '--run') out.run = argv[++i] ?? null
    else if (arg === '--root') out.root = argv[++i] ?? null
    else if (arg === '--out') out.out = argv[++i] ?? null
    else if (arg === '--world-container') out.worldContainer = argv[++i] ?? null
    else if (arg === '--observed-world') out.observedWorld = argv[++i] ?? null
    else if (arg === '--gamerule-verification') out.gameruleVerification = argv[++i] ?? null
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

export function usage() {
  return [
    'clean-run-gate — may this descriptor (+ this run) be a CLEAN M3 acceptance?',
    '',
    'Usage:',
    '  bun tools/clean-run-gate.mjs --environment <descriptor.json>',
    '  bun tools/clean-run-gate.mjs --environment <descriptor.json> --bundle-dir <dir> --run <runId>',
    '  bun tools/clean-run-gate.mjs --environment <descriptor.json> --artifact <artifact.json> --run <runId>',
    '  bun tools/clean-run-gate.mjs --help',
    '',
    'Options:',
    '  --environment <p>       the clean-run descriptor (REQUIRED; the same file the bundle used)',
    '  --bundle-dir <dir>      a tools/m3-acceptance-bundle.mjs output directory (reads bundle.json)',
    '  --artifact <p>          alternatively, a milestone-run-artifact JSON to check run evidence against',
    '  --run <runId>           exact runId the evidence must be scoped to',
    `  --root <tree>           resident tree (default ${REPO_ROOT}); used only to resolve relative log paths`,
    '  --world-container <d>   override the descriptor world container for the pre-run/final target proof',
    '  --observed-world <p>    a pre-run level.dat measurement JSON: proves the target did not exist yet',
    '  --gamerule-verification <p> per-dimension console listing (default: gamerule-verification.txt beside the descriptor)',
    '  --out <dir>             write clean-run.json + clean-run.md (additive; never overwrites bundle.json)',
    '  --json                  print the whole verdict JSON to stdout',
    '',
    'Exit: 0 = CLEAN (and ACCEPTED with --bundle-dir), 1 = NOT_CLEAN / NOT_ACCEPTED, 2 = UNKNOWN.',
    '',
  ].join('\n')
}

function readJson(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return { path, document: null, error: 'file_not_found', text: null }
  try {
    const text = readFileSync(path, 'utf8')
    return { path, document: JSON.parse(text), text, error: null }
  } catch (thrown) {
    return { path, document: null, text: null, error: thrown instanceof Error ? thrown.message : String(thrown) }
  }
}

function readText(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return { path, text: null, sha256: null, error: 'file_not_found' }
  try {
    const text = readFileSync(path, 'utf8')
    return { path, text, sha256: sha256Text(text), error: null }
  } catch (thrown) {
    return { path, text: null, sha256: null, error: thrown instanceof Error ? thrown.message : String(thrown) }
  }
}

function condition({ id, verdict, reason = null, required = true, detail = null }) {
  return { id, verdict, required: required === true, reason, detail }
}

/**
 * Prove that this exact resolved descriptor was prepared before this run
 * opened, while allowing the server to create its normal level.dat afterward.
 * The prepare manifest binds the descriptor file and the append-only attempt
 * ledger; the HOST BOOT supplies the run boundary, and the acceptance record
 * independently supplies the actual level name and seed.
 */
function preparationFreshnessCondition({ descriptor, descriptorPath, descriptorSha256, artifact, runId, required }) {
  const unavailable = (reason, detail = null) => condition({
    id: 'run.preparationFreshness',
    verdict: 'UNKNOWN',
    required,
    reason,
    detail,
  })
  if (!required) {
    return unavailable('no run evidence was supplied; pre-run target absence remains the descriptor-only requirement')
  }
  if (descriptorPath === null || descriptorSha256 === null) {
    return unavailable('the resolved descriptor path/hash is unavailable')
  }
  const manifestPath = join(dirname(descriptorPath), 'manifest.json')
  const manifestRead = readJson(manifestPath)
  if (manifestRead.document === null) {
    return unavailable(`clean-run prepare manifest is unavailable: ${String(manifestRead.error)}`, { manifestPath })
  }
  const manifest = manifestRead.document
  const target = manifest?.target ?? null
  const values = descriptor?.values ?? {}
  const cleanRun = descriptor?.cleanRun ?? {}
  const container = typeof cleanRun.worldContainer === 'string' ? resolve(cleanRun.worldContainer) : null
  const expectedWorldDir = container === null || typeof values.levelName !== 'string' ? null : resolve(join(container, values.levelName))
  const resolvedPath = typeof manifest?.resolved?.path === 'string' ? resolve(manifest.resolved.path) : null
  const resolvedFile = Array.isArray(manifest?.files)
    ? manifest.files.find((entry) => typeof entry?.path === 'string' && resolve(entry.path) === resolve(descriptorPath)) ?? null
    : null
  const manifestIssues = []
  const manifestUnknown = []

  if (typeof runId !== 'string' || runId === '') {
    manifestUnknown.push('the exact requested runId is unavailable')
  } else if (artifact?.runId !== runId) {
    manifestIssues.push(`artifact runId=${String(artifact?.runId ?? null)} does not match requested runId=${runId}`)
  }
  if (typeof values.sourceSha !== 'string' || values.sourceSha === '') {
    manifestUnknown.push('the descriptor has no exact source SHA')
  } else if (artifact?.run?.boot?.sourceSha !== values.sourceSha) {
    manifestIssues.push(`BOOT source SHA=${String(artifact?.run?.boot?.sourceSha ?? null)} does not match descriptor source SHA=${values.sourceSha}`)
  }

  if (manifest.record !== 'clean-run-prepare' || manifest.schemaVersion !== 1) {
    manifestIssues.push(`unexpected prep manifest record/schema=${String(manifest.record)}/${String(manifest.schemaVersion)}`)
  }
  if (resolvedPath === null || resolvedPath !== resolve(descriptorPath)) {
    manifestIssues.push(`prep manifest resolved path=${String(resolvedPath)} does not match descriptor=${resolve(descriptorPath)}`)
  }
  if (resolvedFile === null || resolvedFile.sha256 !== descriptorSha256) {
    manifestIssues.push('prep manifest does not bind the exact resolved descriptor file hash')
  }
  if (target === null || target.levelDatPresentAtPrepare !== false) {
    manifestIssues.push(`prep manifest does not prove target absence before staging (levelDatPresentAtPrepare=${String(target?.levelDatPresentAtPrepare)})`)
  }
  if (
    target === null ||
    target.levelName !== values.levelName ||
    String(target.levelSeed) !== String(values.levelSeed) ||
    target.sourceSha !== values.sourceSha ||
    container === null ||
    typeof target.container !== 'string' ||
    resolve(target.container) !== container ||
    typeof target.worldDir !== 'string' ||
    expectedWorldDir === null ||
    resolve(target.worldDir) !== expectedWorldDir
  ) {
    manifestIssues.push('prep manifest target name/seed/source/container/world path does not match the resolved descriptor')
  }

  const prepTimeMs = typeof manifest.generatedAt === 'string' ? Date.parse(manifest.generatedAt) : Number.NaN
  const bootTimeMs = typeof artifact?.run?.boot?.ts === 'string' ? Date.parse(artifact.run.boot.ts) : Number.NaN
  if (!Number.isFinite(prepTimeMs)) manifestUnknown.push('prep manifest generatedAt is missing or invalid')
  if (!Number.isFinite(bootTimeMs)) manifestUnknown.push('the run artifact has no exact BOOT timestamp')
  if (Number.isFinite(prepTimeMs) && Number.isFinite(bootTimeMs) && prepTimeMs >= bootTimeMs) {
    manifestIssues.push(`prep manifest timestamp ${manifest.generatedAt} is not before run BOOT ${artifact.run.boot.ts}`)
  }

  const attemptLedger = manifest.attemptLedger ?? null
  if (attemptLedger === null || typeof attemptLedger.path !== 'string' || typeof attemptLedger.sha256 !== 'string') {
    manifestUnknown.push('prep manifest does not bind an attempts-ledger path and SHA-256')
  } else if (container === null || resolve(attemptLedger.path) !== resolve(join(container, 'm3-clean-run', 'attempts.json'))) {
    manifestIssues.push('prep manifest attempts ledger path is outside the M3 run ledger for this target container')
  } else {
    const ledgerRead = readJson(resolve(attemptLedger.path))
    if (ledgerRead.document === null || ledgerRead.text === null) {
      manifestUnknown.push(`bound attempts ledger is unavailable: ${String(ledgerRead.error)}`)
    } else if (sha256Text(ledgerRead.text) !== attemptLedger.sha256) {
      manifestIssues.push('attempts-ledger bytes do not match the hash recorded in the prep manifest')
    } else if (ledgerRead.document.record !== 'clean-run-attempts' || ledgerRead.document.schemaVersion !== 1 || !Array.isArray(ledgerRead.document.attempts)) {
      manifestIssues.push('bound attempts ledger has an unexpected record/schema')
    } else {
      const matchingAttempt = ledgerRead.document.attempts.some((entry) => {
        const preparedAtMs = typeof entry?.preparedAt === 'string' ? Date.parse(entry.preparedAt) : Number.NaN
        return (
          entry?.levelName === values.levelName &&
          String(entry?.levelSeed) === String(values.levelSeed) &&
          entry?.sourceSha === values.sourceSha &&
          entry?.levelDatPresentAtPrepare === false &&
          typeof entry?.worldDir === 'string' &&
          expectedWorldDir !== null &&
          resolve(entry.worldDir) === expectedWorldDir &&
          Number.isFinite(preparedAtMs) &&
          Number.isFinite(prepTimeMs) &&
          preparedAtMs <= prepTimeMs
        )
      })
      if (!matchingAttempt) manifestIssues.push('bound attempts ledger has no fresh matching target/name/seed/source attempt')
    }
  }

  const verdict = manifestIssues.length > 0 ? 'FAIL' : manifestUnknown.length > 0 ? 'UNKNOWN' : 'PASS'
  return condition({
    id: 'run.preparationFreshness',
    verdict,
    required,
    reason: verdict === 'PASS'
      ? `the exact target was absent when prepared, and its descriptor/attempt ledger were recorded before BOOT for runId=${runId} sourceSha=${values.sourceSha}`
      : verdict === 'FAIL'
        ? manifestIssues.join('; ')
        : manifestUnknown.join('; '),
    detail: {
      manifestPath,
      manifestSha256: sha256Text(manifestRead.text),
      manifestGeneratedAt: manifest.generatedAt ?? null,
      bootAt: artifact?.run?.boot?.ts ?? null,
      runId: artifact?.runId ?? null,
      requestedRunId: runId,
      bootSourceSha: artifact?.run?.boot?.sourceSha ?? null,
      resolvedPath,
      descriptorPath: resolve(descriptorPath),
      descriptorSha256,
      target: target === null ? null : {
        levelName: target.levelName ?? null,
        levelSeed: target.levelSeed ?? null,
        sourceSha: target.sourceSha ?? null,
        worldDir: target.worldDir ?? null,
        container: target.container ?? null,
        levelDatPresentAtPrepare: target.levelDatPresentAtPrepare ?? null,
      },
      attemptLedgerPath: attemptLedger?.path ?? null,
      attemptLedgerSha256: attemptLedger?.sha256 ?? null,
      issues: manifestIssues,
      unknown: manifestUnknown,
    },
  })
}

/**
 * Independently bind acceptance to a clean checkout and the exact source that
 * produced this run. `bundle.liveAcceptance` is useful, but an older or
 * incomplete bundle must not be able to omit these provenance facts and still
 * pass this additive clean-run gate.
 */
function productionSourceConditions({ bundle, artifact, descriptor, runId, runEvidenceProvided }) {
  // These conditions establish identity for an actual run. A descriptor-only
  // invocation is an explicitly supported offline judgement of the clean-run
  // premise, so missing bundle/artifact source facts must not make that premise
  // UNKNOWN. Keep the rows visible for audit, but require them once either run
  // evidence input was supplied (an unreadable supplied artifact must remain
  // UNKNOWN rather than silently becoming a descriptor-only judgement).
  const git = bundle?.git ?? null
  const dirtyCondition = condition({
    id: 'run.cleanFrozenCheckout',
    verdict: git?.dirty === false ? 'PASS' : git?.dirty === true ? 'FAIL' : 'UNKNOWN',
    required: runEvidenceProvided,
    reason:
      git?.dirty === false
        ? 'the acceptance bundle records a clean checkout (git.dirty=false)'
        : git?.dirty === true
          ? 'the acceptance bundle records a dirty checkout; live acceptance requires a frozen clean worktree'
          : 'the acceptance bundle does not record a boolean git.dirty=false, so checkout cleanliness is unproven',
    detail: { dirty: git?.dirty ?? null, head: git?.head ?? null, bundlePresent: bundle !== null },
  })

  const pinnedSha = descriptor?.values?.sourceSha ?? null
  const bundleHead = git?.head ?? null
  const bootSha = artifact?.run?.boot?.sourceSha ?? null
  const sourceBootSha = artifact?.run?.source?.bootSourceSha ?? null
  const exactFacts = { descriptor: pinnedSha, bundleHead, boot: bootSha, sourceBoot: sourceBootSha }
  const knownShas = Object.entries(exactFacts).filter(([, sha]) => typeof sha === 'string' && COMMIT_SHA_RE.test(sha))
  const distinctKnownShas = [...new Set(knownShas.map(([, sha]) => sha.toLowerCase()))]
  const invalidOrMissing = Object.entries(exactFacts).filter(([, sha]) => typeof sha !== 'string' || !COMMIT_SHA_RE.test(sha))
  let exactVerdict = 'PASS'
  let exactReason = 'descriptor pin, clean bundle HEAD, and this run BOOT/source origin all name the same exact commit'
  if (distinctKnownShas.length > 1) {
    exactVerdict = 'FAIL'
    exactReason = `source SHA mismatch: ${knownShas.map(([name, sha]) => `${name}=${sha}`).join(', ')}`
  } else if (invalidOrMissing.length > 0) {
    exactVerdict = 'UNKNOWN'
    exactReason = `exact source binding is incomplete or malformed: ${invalidOrMissing.map(([name]) => name).join(', ')}`
  } else if (bundle === null || artifact === null || runId === null) {
    exactVerdict = 'UNKNOWN'
    exactReason = 'a bundle, run artifact, and exact runId are required to bind source identity'
  }
  const exactShaCondition = condition({
    id: 'run.exactFrozenSourceSha',
    verdict: exactVerdict,
    required: runEvidenceProvided,
    reason: exactReason,
    detail: { ...exactFacts, runId },
  })

  const source = artifact?.run?.source ?? null
  const window = source?.window ?? null
  const observed = source?.observed
  const sourceWindowIssues = []
  const sourceWindowUnknown = []
  if (bundle === null) sourceWindowUnknown.push('bundle git provenance is absent')
  if (artifact === null) sourceWindowUnknown.push('run artifact is absent')
  if (typeof runId !== 'string' || runId === '') sourceWindowUnknown.push('exact runId is absent')
  if (typeof bundle?.runId !== 'string') sourceWindowUnknown.push('bundle runId is missing')
  else if (bundle.runId !== runId) sourceWindowIssues.push(`bundle runId=${bundle.runId} differs from requested runId=${String(runId)}`)
  const artifactRunIds = [artifact?.runId, artifact?.run?.runId]
  if (artifactRunIds.some((value) => typeof value === 'string' && value !== runId)) {
    sourceWindowIssues.push(`artifact run identity differs from requested runId=${String(runId)}`)
  }
  if (artifactRunIds.some((value) => typeof value !== 'string')) sourceWindowUnknown.push('artifact run identity is missing')
  if (window?.status !== 'valid') sourceWindowUnknown.push(`source window status is ${String(window?.status ?? 'missing')}`)
  if (window?.runId !== runId) {
    if (typeof window?.runId === 'string' && typeof runId === 'string') sourceWindowIssues.push(`source window belongs to runId=${window.runId}, not ${runId}`)
    else sourceWindowUnknown.push('source window runId is missing')
  }
  if (source?.windowBlind?.detected === true) sourceWindowIssues.push('the source window is explicitly marked blind to a source change')
  else if (source?.windowBlind?.detected !== false) sourceWindowUnknown.push('source-window blindness status is missing')
  if (!Array.isArray(source?.windowBlind?.reasons)) sourceWindowUnknown.push('source-window blindness reasons are missing')
  else if (source.windowBlind.detected === false && source.windowBlind.reasons.length > 0) sourceWindowIssues.push('source-window blindness reasons contradict detected=false')
  if (!Array.isArray(observed)) sourceWindowUnknown.push('observed reload markers are missing')

  const reloadCount = source?.reloadCount
  const sourceChangeCount = source?.sourceChangeCount
  if (!Number.isInteger(reloadCount) || !Number.isInteger(sourceChangeCount)) {
    sourceWindowUnknown.push('reload counts are missing or malformed')
  } else if (Array.isArray(observed) && reloadCount !== observed.length) {
    sourceWindowIssues.push(`reloadCount=${reloadCount} does not match observed marker count=${observed.length}`)
  }

  const applied = []
  if (Array.isArray(observed)) {
    for (const [index, marker] of observed.entries()) {
      if (marker === null || typeof marker !== 'object') {
        sourceWindowUnknown.push(`reload marker ${index} is malformed`)
        continue
      }
      if (marker.applied !== true && marker.applied !== false) {
        sourceWindowUnknown.push(`reload marker ${index} has no boolean applied status`)
        continue
      }
      if (!['source-change', 'unchanged', 'deferred', 'failed', 'unclassified'].includes(marker.kind)) {
        sourceWindowUnknown.push(`reload marker ${index} has unknown kind=${String(marker.kind)}`)
      }
      if (marker.kind === 'unclassified') sourceWindowUnknown.push(`reload marker ${index} cannot be classified as source-preserving`)
      if (marker.kind === 'source-change' && marker.applied !== true) sourceWindowIssues.push(`source-change marker ${index} is not marked applied`)
      if (marker.applied === true) {
        applied.push({ index, marker })
        if (marker.kind !== 'source-change' && !(marker.kind === 'deferred' && marker.appliedBy === 'resume')) {
          sourceWindowIssues.push(`applied reload marker ${index} has inconsistent kind/appliedBy evidence`)
        }
        if (typeof marker.sourceSha !== 'string' || !COMMIT_SHA_RE.test(marker.sourceSha)) {
          sourceWindowUnknown.push(`applied reload marker ${index} has no exact sourceSha`)
        } else if (typeof bootSha === 'string' && COMMIT_SHA_RE.test(bootSha) && marker.sourceSha.toLowerCase() !== bootSha.toLowerCase()) {
          sourceWindowIssues.push(`applied reload marker ${index} sourceSha=${marker.sourceSha} differs from BOOT sourceSha=${bootSha}`)
        }
        if (typeof marker.hash !== 'string' || marker.hash === '') sourceWindowUnknown.push(`applied reload marker ${index} has no generation hash`)
      }
    }
  }
  if (Number.isInteger(sourceChangeCount) && Array.isArray(observed) && sourceChangeCount !== applied.length) {
    sourceWindowIssues.push(`sourceChangeCount=${sourceChangeCount} does not match applied reload count=${applied.length}`)
  }

  const latestSourceReload = source?.latestSourceReload ?? null
  if (applied.length === 0) {
    if (source?.provenance !== 'boot' || source?.effectiveSourceShaKind !== 'git-commit-sha') {
      sourceWindowUnknown.push('with no applied reload, boot provenance and git-commit-sha effective source are required')
    }
    if (typeof bootSha === 'string' && source?.effectiveSourceSha !== bootSha) {
      sourceWindowIssues.push('effective source SHA does not equal the BOOT source SHA')
    }
    if (latestSourceReload !== null) sourceWindowIssues.push('latestSourceReload is present despite no applied reload')
  } else {
    const lastApplied = applied.at(-1).marker
    if (source?.provenance !== 'reload' || source?.effectiveSourceShaKind !== 'generation-bundle-hash') {
      sourceWindowIssues.push('applied reloads require reload provenance and generation-bundle-hash effective source kind')
    }
    if (latestSourceReload === null || latestSourceReload?.applied !== true) {
      sourceWindowUnknown.push('latest applied reload record is missing')
    } else {
      if (latestSourceReload.sourceSha !== lastApplied.sourceSha || latestSourceReload.hash !== lastApplied.hash) {
        sourceWindowIssues.push('latestSourceReload disagrees with the last applied observed marker')
      }
      if (source?.effectiveSourceSha !== latestSourceReload.hash) sourceWindowIssues.push('effective generation hash disagrees with latestSourceReload')
    }
  }
  if (source?.crossCheck?.agrees === false) sourceWindowIssues.push('read-only control report disagrees with the run source window')
  if (Array.isArray(source?.disagreements) && source.disagreements.length > 0) sourceWindowIssues.push(...source.disagreements.map((entry) => `source disagreement: ${String(entry)}`))

  const sourceWindowVerdict = sourceWindowIssues.length > 0 ? 'FAIL' : sourceWindowUnknown.length > 0 ? 'UNKNOWN' : 'PASS'
  const sourceWindowCondition = condition({
    id: 'run.sourceWindowExact',
    verdict: sourceWindowVerdict,
    required: runEvidenceProvided,
    reason:
      sourceWindowVerdict === 'PASS'
        ? 'the complete source window is bound to this run and every applied reload preserves the BOOT source commit'
        : sourceWindowVerdict === 'FAIL'
          ? sourceWindowIssues.join('; ')
          : sourceWindowUnknown.join('; '),
    detail: {
      runId,
      artifactRunId: artifact?.runId ?? null,
      windowRunId: window?.runId ?? null,
      windowStatus: window?.status ?? null,
      windowBlind: source?.windowBlind ?? null,
      reloadCount: reloadCount ?? null,
      observedCount: Array.isArray(observed) ? observed.length : null,
      sourceChangeCount: sourceChangeCount ?? null,
      appliedReloadCount: applied.length,
      provenance: source?.provenance ?? null,
      effectiveSourceSha: source?.effectiveSourceSha ?? null,
      effectiveSourceShaKind: source?.effectiveSourceShaKind ?? null,
      issues: sourceWindowIssues,
      unknown: sourceWindowUnknown,
    },
  })

  return [dirtyCondition, exactShaCondition, sourceWindowCondition]
}

/** Read the run's own log for the death/keep-inventory behaviour check. */
function readRunLog(artifact, root, runId) {
  const logPath = typeof artifact?.sources?.logPath === 'string' ? artifact.sources.logPath : null
  if (logPath === null) return { path: null, text: null, reason: 'the artifact records no log path' }
  const resolved = resolve(root ?? REPO_ROOT, logPath)
  if (!existsSync(resolved)) return { path: resolved, text: null, reason: 'the run log is not readable from here' }
  try {
    const text = readFileSync(resolved, 'utf8')
    return { path: resolved, text: runId === null ? text : extractRunWindow(text, runId), reason: null }
  } catch (thrown) {
    return { path: resolved, text: null, reason: thrown instanceof Error ? thrown.message : String(thrown) }
  }
}

/** The observed-world proof: the target world must not exist in the container. */
function observedWorldCondition(observed, values, defaults) {
  const worlds = observedWorlds(observed)
  const hits = worlds.filter((world) => (world.levelName !== null && world.levelName === values.levelName) || (world.seed !== null && String(world.seed) === String(values.levelSeed)))
  const detail = worlds.map((world) => ({
    dir: world.dir,
    levelName: world.levelName,
    seed: world.seed,
    deviationsFromCleanDefaults: observedDeviations(world, defaults),
  }))
  return condition({
    id: 'world.observedTargetAbsent',
    verdict: hits.length === 0 ? 'PASS' : 'FAIL',
    reason:
      worlds.length === 0
        ? 'the observation reports no world'
        : hits.length === 0
          ? `the observed world(s) are not the clean target: ${worlds.map((world) => `${String(world.levelName)} seed=${String(world.seed)}`).join(', ')} (the target ${String(values.levelName)} / ${String(values.levelSeed)} does not exist yet)`
          : `the target world already exists in the observation: ${hits.map((world) => `${world.dir} (levelName=${String(world.levelName)} seed=${String(world.seed)})`).join(', ')}`,
    detail: { observed: detail, hits },
  })
}

/**
 * The whole clean-run judgement. Pure composition: the descriptor validator, the
 * run-evidence checks and the bundle's own verdict - nothing is re-implemented.
 */
export async function runCleanRunGate({
  environment = null,
  bundleDir = null,
  artifactPath = null,
  runId = null,
  root = REPO_ROOT,
  out = null,
  worldContainer = null,
  observedWorldPath = null,
  gameruleVerificationPath = null,
  write = () => {},
} = {}) {
  const generatedAt = new Date().toISOString()
  const descriptorPath = environment === null ? null : resolve(environment)
  const loaded = loadCleanEnvironment(descriptorPath)
  const runEvidenceProvided = bundleDir !== null || artifactPath !== null
  const descriptorCheck = validateCleanEnvironment(loaded.document, {
    descriptorPath,
    descriptorSha256: loaded.sha256,
    worldContainer,
    requireTargetWorldAbsent: !runEvidenceProvided,
  })
  const descriptor = loaded.document
  const values = descriptor?.values ?? {}

  // ---- the run side (optional: a descriptor-only judgement is valid) --------
  let artifact = null
  let bundle = null
  let bundleError = null
  if (bundleDir !== null) {
    const read = readJson(join(resolve(bundleDir), 'bundle.json'))
    if (read.document === null) bundleError = `bundle.json unreadable: ${String(read.error)}`
    else if (read.document.record !== 'm3-acceptance-bundle') bundleError = `not an m3-acceptance-bundle: record=${String(read.document.record)}`
    else {
      bundle = read.document
      artifact = bundle.artifact?.document ?? null
      if (runId === null && typeof bundle.runId === 'string') runId = bundle.runId
    }
  } else if (artifactPath !== null) {
    const read = readJson(resolve(artifactPath))
    if (read.document === null) bundleError = `artifact unreadable: ${String(read.error)}`
    else artifact = read.document
  }
  const log = artifact === null ? { path: null, text: null, reason: 'no artifact was supplied' } : readRunLog(artifact, root, runId)

  const runConditions =
    artifact === null
      ? [
          condition({
            id: 'run.evidence',
            verdict: 'UNKNOWN',
            required: false,
            reason: bundleError ?? 'no --bundle-dir/--artifact was supplied, so only the descriptor premise was judged',
          }),
        ]
      : checkRunEvidence({
          descriptor,
          artifact,
          logText: log.text,
          runId,
          descriptorPath,
          descriptorSha256: loaded.sha256,
        })
  runConditions.push(preparationFreshnessCondition({
    descriptor,
    descriptorPath,
    descriptorSha256: loaded.sha256,
    artifact,
    runId,
    required: runEvidenceProvided,
  }))
  runConditions.push(
    ...productionSourceConditions({
      bundle,
      artifact,
      descriptor,
      runId,
      runEvidenceProvided,
    }),
  )
  const effectiveGameruleVerificationPath =
    gameruleVerificationPath ?? (descriptorPath === null ? null : join(dirname(descriptorPath), 'gamerule-verification.txt'))
  const gameruleVerification =
    artifact !== null && descriptor?.cleanRun?.gameruleMechanism?.primary === 'console' && effectiveGameruleVerificationPath !== null
      ? readText(resolve(effectiveGameruleVerificationPath))
      : { path: effectiveGameruleVerificationPath, text: null, sha256: null, error: artifact === null ? 'no_run_artifact' : null }
  runConditions.push(
    checkConsoleGameruleEvidence({
      descriptor,
      artifact,
      runId,
      descriptorSha256: loaded.sha256,
      path: gameruleVerification.path,
      text: gameruleVerification.text,
      fileSha256: gameruleVerification.sha256,
      readError: gameruleVerification.error,
    }),
  )
  if (log.reason !== null && artifact !== null) {
    runConditions.push(condition({ id: 'run.logReadable', verdict: 'UNKNOWN', required: false, reason: `death/keep-inventory behaviour not checked: ${log.reason}`, detail: { path: log.path } }))
  }
  if (observedWorldPath !== null) {
    const observed = readJson(resolve(observedWorldPath))
    if (observed.document === null) {
      runConditions.push(condition({ id: 'world.observedTargetAbsent', verdict: 'UNKNOWN', required: false, reason: `observed-world JSON unreadable: ${String(observed.error)}` }))
    } else {
      runConditions.push(observedWorldCondition(observed.document, values, descriptor?.cleanRun?.gamerulePolicy?.defaults ?? {}))
    }
  }

  // ---- the combined acceptance ---------------------------------------------
  const descriptorFailed = descriptorCheck.status === 'NOT_CLEAN'
  const runFailed = runConditions.filter((entry) => entry.required && entry.verdict === 'FAIL')
  const runUnknown = runConditions.filter((entry) => entry.required && entry.verdict === 'UNKNOWN')
  const cleanStatus = descriptorFailed || runFailed.length > 0 ? 'NOT_CLEAN' : descriptorCheck.status === 'UNKNOWN' || runUnknown.length > 0 ? 'UNKNOWN' : 'CLEAN'
  const cleanConditions = [...descriptorCheck.conditions, ...runConditions]

  const bundleVerdict = bundle?.acceptanceVerdict?.status ?? null
  const liveAcceptance = bundle?.liveAcceptance === true
  const evidenceClass = bundle?.evidenceClass ?? null
  let acceptanceStatus = 'UNKNOWN'
  let acceptanceReason
  if (bundle === null) {
    acceptanceReason =
      bundleDir === null && artifactPath === null
        ? 'no bundle was supplied: this run judged the DESCRIPTOR premise only (a clean descriptor is not an M3 acceptance)'
        : `the bundle could not be read (${String(bundleError ?? 'unknown')})`
  } else if (cleanStatus === 'NOT_CLEAN') {
    acceptanceStatus = 'NOT_ACCEPTED'
    acceptanceReason = `the world/run is NOT clean: ${[...descriptorCheck.failed, ...runFailed.map((entry) => entry.id)].join(', ')}`
  } else if (cleanStatus === 'UNKNOWN') {
    acceptanceReason = `the clean-run premise is UNKNOWN: ${[...descriptorCheck.conditions, ...runUnknown].filter((entry) => entry.required && entry.verdict === 'UNKNOWN').map((entry) => entry.id).join(', ')}`
  } else if (bundleVerdict === 'FAIL') {
    acceptanceStatus = 'NOT_ACCEPTED'
    acceptanceReason = `the canonical M3 gate FAILed: ${String(bundle.gate?.reason ?? 'unknown')}`
  } else if (bundleVerdict !== 'PASS') {
    acceptanceReason = `the canonical M3 gate reported ${String(bundleVerdict)}: ${String(bundle.gate?.reason ?? 'unknown')}`
  } else if (!liveAcceptance) {
    acceptanceStatus = 'NOT_ACCEPTED'
    acceptanceReason = `the bundle is a PASS but NOT a live acceptance (evidenceClass=${String(evidenceClass)}, liveAcceptance=false): ${(bundle.residual ?? []).filter((entry) => /live signal|evidence class/.test(String(entry))).join(' | ') || 'objective live signals not satisfied'}`
  } else {
    acceptanceStatus = 'ACCEPTED'
    acceptanceReason = 'descriptor CLEAN + clean frozen checkout + exact run source provenance + run evidence consistent + canonical M3 gate PASS + liveAcceptance=true'
  }
  const exitCode = cleanStatus === 'NOT_CLEAN' || acceptanceStatus === 'NOT_ACCEPTED' ? 1 : cleanStatus === 'UNKNOWN' || acceptanceStatus === 'UNKNOWN' ? 2 : 0

  const verdict = {
    record: RECORD,
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    descriptor: {
      path: descriptorPath,
      sha256: loaded.sha256,
      loadError: loaded.error,
      status: descriptorCheck.status,
      levelName: descriptorCheck.levelName,
      levelSeed: descriptorCheck.levelSeed,
      sourceSha: values.sourceSha ?? null,
    },
    run: {
      runId,
      artifactPath: artifactPath === null ? null : resolve(artifactPath),
      bundleDir: bundleDir === null ? null : resolve(bundleDir),
      logPath: log.path,
      gameruleVerificationPath: gameruleVerification.path === null ? null : resolve(gameruleVerification.path),
      gameruleVerificationSha256: gameruleVerification.sha256,
      bootSourceSha: artifact?.run?.boot?.sourceSha ?? null,
      acceptanceRecordPath: artifact?.acceptance?.path ?? null,
      bundleVerdict,
      liveAcceptance,
      evidenceClass,
      gitHead: bundle?.git?.head ?? null,
      gitDirty: bundle?.git?.dirty ?? null,
    },
    status: cleanStatus,
    acceptanceStatus,
    acceptanceReason,
    acceptanceRules: ACCEPTANCE_RULES,
    conditions: cleanConditions,
    failed: cleanConditions.filter((entry) => entry.required && entry.verdict === 'FAIL').map((entry) => entry.id),
    residual: [],
    exitCode,
  }
  if (loaded.error !== null) verdict.residual.push(`descriptor could not be read: ${loaded.error}`)
  if (descriptorCheck.status === 'CLEAN' && acceptanceStatus !== 'ACCEPTED') {
    verdict.residual.push('a CLEAN descriptor is a PREMISE, not an acceptance: the canonical M3 gate + liveAcceptance still decide the milestone')
  }
  for (const entry of cleanConditions) {
    if (entry.required && entry.verdict === 'UNKNOWN') verdict.residual.push(`UNKNOWN condition ${entry.id}: ${entry.reason}`)
  }
  if (artifact !== null && runConditions.find((entry) => entry.id === 'run.keepInventoryBehaviour')?.verdict === 'UNKNOWN') {
    verdict.residual.push('keepInventory=false was not behaviourally observed in this run (no death); it remains an operator declaration verified by the console `gamerule` listing')
  }
  verdict.residual.push('this gate never fabricates evidence and never turns UNKNOWN into PASS; it never re-judges M2/M3')

  // ---- output --------------------------------------------------------------
  if (out !== null && out !== '') {
    const outDir = resolve(out)
    verdict.outputs = { json: join(outDir, 'clean-run.json'), markdown: join(outDir, 'clean-run.md') }
    try {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(verdict.outputs.json, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8')
      writeFileSync(verdict.outputs.markdown, cleanRunMarkdown(verdict), 'utf8')
    } catch (thrown) {
      write(`CLEAN_RUN_WRITE_FAILED dir=${outDir} reason=${thrown instanceof Error ? thrown.message : String(thrown)}\n`)
    }
  }
  return verdict
}

/** The reviewer summary: one line per condition, verdict first. */
export function cleanRunMarkdown(verdict) {
  const lines = []
  lines.push(`# Clean-run verdict — ${verdict.run.runId ?? '(descriptor only)'}`)
  lines.push('')
  lines.push(`- descriptor: ${String(verdict.descriptor.path)} (sha256 ${String(verdict.descriptor.sha256)})`)
  lines.push(`- target world: levelName=${String(verdict.descriptor.levelName)} levelSeed=${String(verdict.descriptor.levelSeed)} sourceSha=${String(verdict.descriptor.sourceSha)}`)
  lines.push(`- canonical bundle: verdict=${String(verdict.run.bundleVerdict)} liveAcceptance=${String(verdict.run.liveAcceptance)} evidenceClass=${String(verdict.run.evidenceClass)}`)
  lines.push(`- source checkout: gitHead=${String(verdict.run.gitHead)} dirty=${String(verdict.run.gitDirty)} BOOT=${String(verdict.run.bootSourceSha)}`)
  lines.push(`- CLEAN STATUS: **${verdict.status}**`)
  lines.push(`- M3 ACCEPTANCE: **${verdict.acceptanceStatus}** — ${verdict.acceptanceReason}`)
  lines.push('')
  lines.push('## Conditions')
  lines.push('')
  lines.push('| condition | verdict | required | reason |')
  lines.push('| --- | --- | --- | --- |')
  for (const entry of verdict.conditions) {
    lines.push(`| ${entry.id} | ${entry.verdict} | ${entry.required ? 'yes' : 'no'} | ${String(entry.reason ?? '').replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  lines.push('## What ACCEPTED requires')
  lines.push('')
  for (const rule of verdict.acceptanceRules) lines.push(`- ${rule}`)
  lines.push('')
  lines.push('## Residual')
  lines.push('')
  for (const entry of verdict.residual) lines.push(`- ${entry}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function runCli({ argv = process.argv.slice(2), write = (line) => process.stdout.write(line), writeError = (line) => process.stderr.write(line), gate = runCleanRunGate } = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    writeError(`CLEAN_RUN_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return { exitCode: 2, verdict: null }
  }
  if (args.help) {
    write(usage())
    return { exitCode: 0, verdict: null }
  }
  if (args.environment === null) {
    writeError('CLEAN_RUN_ERROR --environment <descriptor.json> is required (a clean run is judged against its own descriptor)\n')
    return { exitCode: 2, verdict: null }
  }
  const verdict = await gate({
    environment: args.environment,
    bundleDir: args.bundleDir,
    artifactPath: args.artifact,
    runId: args.run,
    root: args.root ?? REPO_ROOT,
    out: args.out,
    worldContainer: args.worldContainer,
    observedWorldPath: args.observedWorld,
    gameruleVerificationPath: args.gameruleVerification,
    write: writeError,
  })
  if (args.json) write(`${JSON.stringify(verdict)}\n`)
  else write(cleanRunMarkdown(verdict))
  const lines = [
    `${GATE_LINE} descriptor=${String(verdict.descriptor.path)} sha256=${String(verdict.descriptor.sha256)} status=${verdict.status}`,
    ...verdict.conditions.map((entry) => `${CONDITION_LINE} ${entry.id} verdict=${entry.verdict} required=${String(entry.required)} reason=${JSON.stringify(entry.reason ?? null)}`),
    `${ARTIFACT_LINE} runId=${String(verdict.run.runId)} bundleVerdict=${String(verdict.run.bundleVerdict)} liveAcceptance=${String(verdict.run.liveAcceptance)} evidenceClass=${String(verdict.run.evidenceClass)}`,
    `${M3_LINE} status=${verdict.acceptanceStatus} reason=${JSON.stringify(verdict.acceptanceReason)}`,
    `${RESULT_LINE} status=${verdict.status} acceptance=${verdict.acceptanceStatus} runId=${String(verdict.run.runId)} levelName=${String(verdict.descriptor.levelName)} levelSeed=${String(verdict.descriptor.levelSeed)} out=${String(verdict.outputs?.json ?? args.out ?? 'none')}`,
  ]
  // The detailed lines go to stderr under --json so stdout stays machine-parseable.
  const target = args.json ? writeError : write
  for (const line of lines) target(`${line}\n`)
  return { exitCode: verdict.exitCode, verdict }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const result = await runCli()
  process.exitCode = result.exitCode
}
