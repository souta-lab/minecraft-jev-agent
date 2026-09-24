#!/usr/bin/env bun
// m3-acceptance-bundle: ONE command that turns an exact resident runId into ONE
// run-scoped acceptance bundle a reviewer can decide from.
//
//   bun tools/m3-acceptance-bundle.mjs --run <runId> [--root <tree>] [--out <dir>]
//
// What it does (and, deliberately, does NOT do):
//   1. runs the CANONICAL M3 gate (the evaluator MILESTONE-CONTRACT.json names:
//      tools/m3-gate.mjs `runM3Gate`) and records its exact argv, stdout lines and
//      exit code;
//   2. regenerates the run artifact (tools/milestone-run-artifact.mjs
//      `buildRunArtifact`) with the operator environment record, and embeds the
//      artifact's own gate verdicts, evidence classes and operator-decision premise;
//   3. collects the #436/#437 Skill-closure metrics (tools/skill-closure-metrics.mjs);
//   4. emits a per-condition PASS/FAIL/UNKNOWN matrix with ONE authoritative source
//      per condition and an explicit CONSISTENCY check between the gate and the
//      artifact, so a delivered bundle can never contain two different answers for
//      the same condition;
//   5. requires the same-run M2 gate to PASS on the run's BOOT source SHA before
//      M3 can be accepted; operator-decision premises remain diagnostic only;
//   6. states the HOST `acceptance` evidence class precisely when it is absent
//      (writer, triggers, what it attests) and NEVER fabricates it.
//
// It re-implements no gate predicate: every verdict comes from the existing tools,
// invoked through their exported APIs. Nothing here touches the control socket
// except the same read-only `report` probe the gates themselves use, and only when
// it is not disabled (`--no-control-socket`).
//
// Socket policy (why the bundle cannot disagree with itself)
// ---------------------------------------------------------
// A gate invoked with a LIVE `report` reply brackets the current run's window with
// `now`; the SAME gate invoked file-only refuses an unbounded window and reports
// `run_window_unbounded`. That is how a gate and an artifact read minutes apart can
// legitimately differ. This tool therefore reads the socket binding ONCE and pins it
// into BOTH runs, then asserts that the gate's conditions and the artifact's
// embedded conditions are identical. A contradiction is reported as UNKNOWN with
// exit 2 - never quietly reconciled towards PASS.
//
// Evidence classes
// ----------------
// `--evidence-class live|fixture|undeclared` (default `undeclared`) declares the
// provenance of the tree the bundle judged. A PASS is only reported as a LIVE
// acceptance (`liveAcceptance: true`) when the class is `live` AND the objective
// live signals hold (host lock present, a HOST `acceptance-<runId>.json` record
// present, the run's BOOT SHA equal to the tree's HEAD). A synthetic run therefore
// can never be presented as a live PASS.
//
// Exit: 0 = every required condition PASS (and no contradiction), 1 = a gate FAIL,
//       2 = UNKNOWN / missing input / contradiction. The bundle is still written on
//       exit 2 so a reviewer can see exactly which condition is undecided and why.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RUN_ID_RE, readPolicySocketBinding, runM2Gate } from './m2-gate.mjs'
import { M3_REQUIRED_CONDITIONS, M3_RUN_RESULT, runM3Gate } from './m3-gate.mjs'
import {
  ACCEPTANCE_WRITER,
  RECORD as ARTIFACT_RECORD,
  SCHEMA_VERSION as ARTIFACT_SCHEMA_VERSION,
  buildRunArtifact,
  derivePaths,
} from './milestone-run-artifact.mjs'

export const RECORD = 'm3-acceptance-bundle'
export const SCHEMA_VERSION = 1
export const EVIDENCE_CLASSES = Object.freeze(['live', 'fixture', 'undeclared'])
/** The contract evaluator this bundle treats as authoritative for M3. */
export const CANONICAL_M3_EVALUATOR = 'tools/m3-gate.mjs'
export const METRICS_TOOL = 'tools/skill-closure-metrics.mjs'
export const ARTIFACT_TOOL = 'tools/milestone-run-artifact.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSourceSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null
}

/**
 * Contract facts that a delivered M3 run artifact must carry. The gates decide
 * whether gameplay predicates passed; this check only ensures the required
 * audit record is present and bound to the same run/source before the bundle
 * can call that run accepted.
 */
export function evaluateRequiredM3ArtifactEvidence(artifact, expectedRunId) {
  const sourceSha = normalizeSourceSha(artifact?.run?.boot?.sourceSha)
  const dimensions = artifact?.environment?.dimensions
  const predicates = artifact?.milestonePredicates
  const authority = artifact?.authority
  const terminal = artifact?.inventory?.final
  const transitions = Array.isArray(dimensions?.transitions) ? dimensions.transitions : []
  const predicateEntries = Array.isArray(predicates?.predicates) ? predicates.predicates : []
  const normalizedDimension = (value) => typeof value === 'string' ? value.replace(/^minecraft:/, '').toLowerCase() : null
  const isVerifiedNetherTransition = (transition) => {
    const from = normalizedDimension(transition?.from)
    const to = normalizedDimension(transition?.to)
    const dimension = normalizedDimension(transition?.dimension)
    return transition?.source === 'live-world' &&
      Number.isFinite(transition?.atMs) &&
      transition?.runId === expectedRunId &&
      normalizeSourceSha(transition?.sourceSha) === sourceSha &&
      from !== null && from !== 'unknown' && from !== 'the_nether' &&
      to === 'the_nether' && dimension === to
  }
  const transitionToNether = transitions.find(isVerifiedNetherTransition) ?? null
  const netherPredicate = predicateEntries.find((entry) => entry?.id === 'nether_reached')
  const predicateTransition = netherPredicate?.evidence?.transition
  const predicateLineageMatches = transitionToNether !== null &&
    netherPredicate?.satisfied === true &&
    netherPredicate.source === 'log:DIMENSION_TRANSITION:dimension' &&
    netherPredicate.observedAtMs === transitionToNether.atMs &&
    isVerifiedNetherTransition(predicateTransition) &&
    predicateTransition.from === transitionToNether.from &&
    predicateTransition.to === transitionToNether.to &&
    predicateTransition.dimension === transitionToNether.dimension &&
    predicateTransition.source === transitionToNether.source &&
    predicateTransition.runId === transitionToNether.runId &&
    normalizeSourceSha(predicateTransition.sourceSha) === normalizeSourceSha(transitionToNether.sourceSha)
  const predicateScopeMatches = predicates?.runId === expectedRunId
    && normalizeSourceSha(predicates?.sourceSha) === sourceSha
    && predicateLineageMatches
  const terminalInventoryPresent = terminal?.status === 'PRESENT'
    && terminal?.runId === expectedRunId
    && normalizeSourceSha(terminal?.sourceSha) === sourceSha
    && terminal?.counts !== null
    && typeof terminal?.counts === 'object'
    && !Array.isArray(terminal.counts)
    && Number.isInteger(terminal.counts.ender_eye)
    && terminal.counts.ender_eye >= 12
  const fallbackAbsent = authority?.fallback?.hiddenDeterministicFallback === 'none_observed'
    && authority?.fallback?.deterministicFallbackEnabled === false
    && authority?.fallback?.fallbackCount === 0
    && authority?.fallback?.otherCount === 0
    && authority?.fallback?.unclassifiableCount === 0
  const system2Decisions = authority?.system2?.decisions
  const system2AllModel = Number.isFinite(authority?.system2?.count)
    && authority.system2.count > 0
    && Number.isFinite(authority?.system2?.modelCount)
    && authority.system2.modelCount === authority.system2.count
    && Array.isArray(system2Decisions)
    && authority.system2.disagreements?.length === 0
  const system2IdentityVerified = authority?.system2?.identityStatus === 'verified'
  const checks = [
    { id: 'sourceSha', present: sourceSha !== null && artifact?.runId === expectedRunId },
    { id: 'minecraftVersion', present: typeof artifact?.run?.serverVersion === 'string' && artifact.run.serverVersion.length > 0 },
    { id: 'environment.difficulty', present: artifact?.environment?.difficulty?.value !== undefined && artifact.environment.difficulty.value !== null },
    { id: 'environment.mobSpawning', present: artifact?.environment?.mobSpawning?.value !== undefined && artifact.environment.mobSpawning.value !== null },
    { id: 'environment.gamerules', present: artifact?.environment?.gamerules?.value !== undefined && artifact.environment.gamerules.value !== null },
    { id: 'inventory.initial', present: artifact?.inventory?.boot?.counts !== null && typeof artifact?.inventory?.boot?.counts === 'object' },
    { id: 'inventory.final', present: terminalInventoryPresent },
    { id: 'dimensionTransition.toNether', present: transitionToNether !== null },
    { id: 'milestonePredicates', present: predicateScopeMatches },
    { id: 'authority.jev', present: authority?.jev?.attested === true },
    { id: 'authority.system2', present: authority?.system2?.attested === true },
    { id: 'authority.system2GenerationIdentity', present: system2IdentityVerified },
    { id: 'authority.system2NoFallback', present: system2AllModel },
    { id: 'authority.noHiddenFallback', present: fallbackAbsent },
  ]
  return {
    status: checks.every((check) => check.present) ? 'PASS' : 'UNKNOWN',
    runId: expectedRunId,
    sourceSha,
    checks,
    missing: checks.filter((check) => !check.present).map((check) => check.id),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = {
    run: null,
    root: null,
    out: null,
    environment: null,
    operatorDecisions: undefined,
    evidenceClass: 'undeclared',
    requireAcceptance: false,
    noControlSocket: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--run') out.run = argv[++i] ?? null
    else if (arg === '--root') out.root = argv[++i] ?? null
    else if (arg === '--out') out.out = argv[++i] ?? null
    else if (arg === '--environment') out.environment = argv[++i] ?? null
    else if (arg === '--operator-decisions') out.operatorDecisions = argv[++i] ?? null
    else if (arg === '--evidence-class') out.evidenceClass = argv[++i] ?? null
    else if (arg === '--require-acceptance') out.requireAcceptance = true
    else if (arg === '--no-control-socket') out.noControlSocket = true
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

export function usage() {
  return [
    'm3-acceptance-bundle — ONE run-scoped acceptance bundle for an exact runId',
    '',
    'Usage:',
    '  bun tools/m3-acceptance-bundle.mjs --run <runId> [--root <tree>] [--out <dir>]',
    '  bun tools/m3-acceptance-bundle.mjs --run <runId> --evidence-class live',
    '  bun tools/m3-acceptance-bundle.mjs --help',
    '',
    'Required:',
    '  --run <runId>             exact resident runId (shape run-[A-Za-z0-9-]+); no runId => exit 2',
    '',
    'Options:',
    `  --root <tree>             resident tree that produced the run (default ${REPO_ROOT})`,
    '  --out <dir>               bundle directory (default <root>/runs/m3-live/acceptance-bundle-<runId>)',
    '  --environment <path>      operator environment record (difficulty/gamerules/configurationChanges/worldChanges JSON)',
    '  --operator-decisions <p>  operator decision file (default <repo>/OPERATOR-DECISIONS.json)',
    '  --evidence-class <c>      live|fixture|undeclared (default undeclared; only live can yield liveAcceptance)',
    '  --require-acceptance      treat a MISSING HOST acceptance-<runId>.json as a blocking gap (exit 2)',
    '  --no-control-socket       never query the resident control socket (deterministic, file-only)',
    '  --json                    print the bundle JSON to stdout instead of the human summary',
    '',
    'Outputs (one directory):',
    '  bundle.json               the whole bundle, self-contained',
    '  bundle.md                 the reviewer summary (per-condition verdicts)',
    '  artifact-<runId>.json     the regenerated tools/milestone-run-artifact.mjs artifact',
    '  metrics.json              the tools/skill-closure-metrics.mjs report',
    '  commands/*.txt            exact argv + captured output of every step',
    '',
    'Exit: 0 = all required conditions PASS, 1 = gate FAIL, 2 = UNKNOWN/missing/contradiction.',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function gitProvenance(root) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
    reason: head.status === 0 ? null : 'not_a_git_tree',
  }
}

/** One input the bundle needs, with an explicit PRESENT/MISSING verdict. */
function inputRecord({ id, path, required, reason = null, present = null }) {
  const exists = present === null ? typeof path === 'string' && path !== '' && existsSync(path) : present
  return { id, path: path ?? null, required: required === true, status: exists ? 'PRESENT' : 'MISSING', reason: exists ? null : reason ?? 'file_not_found' }
}

function conditionRow({ id, verdict, source, reason = null, detail = null, blocking = true }) {
  return { id, verdict, source, reason, detail, blocking: blocking === true }
}

// ---------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------

/**
 * Build ONE acceptance bundle for `runId`. Pure composition: every verdict is
 * produced by the canonical gate or the artifact tool, never here.
 */
export async function buildAcceptanceBundle({
  runId = null,
  root = REPO_ROOT,
  outDir = null,
  overrides = {},
  evidenceClass = 'undeclared',
  requireAcceptance = false,
  noControlSocket = false,
  gates = { M2: runM2Gate, M3: runM3Gate },
  // The AUTHORITATIVE gate runner. Injectable so a test can prove that a
  // contradictory verdict is surfaced rather than reconciled; production always
  // uses the canonical evaluator.
  runGate = runM3Gate,
  readSocket = readPolicySocketBinding,
  spawn = spawnSync,
  now = () => new Date(),
  write = () => {},
} = {}) {
  const generatedAt = now().toISOString()
  const resolvedRoot = resolve(root)
  const resolvedOut = outDir ?? join(resolvedRoot, 'runs', 'm3-live', `acceptance-bundle-${runId ?? 'unscoped'}`)
  const git = existsSync(resolvedRoot) ? gitProvenance(resolvedRoot) : { head: null, branch: null, dirty: null, reason: 'root_missing' }
  const scoped = typeof runId === 'string' && RUN_ID_RE.test(runId)
  const declaredClass = EVIDENCE_CLASSES.includes(evidenceClass) ? evidenceClass : 'undeclared'

  const finish = (bundle, exitCode) => {
    bundle.exitCode = exitCode
    return { bundle, exitCode }
  }

  if (!scoped) {
    return finish(
      {
        record: RECORD,
        schemaVersion: SCHEMA_VERSION,
        generatedAt,
        runId: runId ?? null,
        root: resolvedRoot,
        outDir: resolvedOut,
        git,
        evidenceClass: declaredClass,
        liveAcceptance: false,
        acceptanceVerdict: { status: 'UNKNOWN', reason: runId === null || runId === undefined ? 'exact_run_scope_required' : `invalid_run_id ${String(runId)}` },
        conditions: [],
        inputs: [],
        commands: [],
        consistency: [],
        residual: ['an exact --run <runId> is mandatory; no evidence can be attributed without it'],
      },
      2,
    )
  }

  const paths = derivePaths(resolvedRoot, {
    ...overrides,
    ...(noControlSocket ? { controlSocketPath: null } : {}),
  })
  const commands = []
  const commandTexts = []

  const runStep = async ({ id, argv, fn }) => {
    const startedMs = now().getTime()
    const lines = []
    let result = null
    let error = null
    let code = 2
    try {
      const returned = await fn((line) => lines.push(String(line)))
      result = returned?.result ?? null
      code = returned?.code ?? 2
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
      lines.push(`${id.toUpperCase()}_ERROR ${error}`)
    }
    const text = lines.join('\n')
    commandTexts.push({ id, text })
    const record = {
      id,
      // The EXACT equivalent CLI invocation. The bundle executes the same tool
      // through its exported API so that ONE pinned socket binding feeds both the
      // gate and the artifact (see the header); the argv below is what a reviewer
      // reruns, and `execution` says which of the two produced this output.
      argv,
      execution: 'in-process (exported API, pinned socket binding)',
      exitCode: code,
      durationMs: now().getTime() - startedMs,
      stdout: text,
      stdoutSha256: sha256(text),
      error,
    }
    commands.push(record)
    return { record, result, code, text }
  }

  // ---- inputs (loud about anything the bundle cannot read) -----------------
  const inputs = [
    inputRecord({ id: 'log', path: paths.logPath, required: true, reason: 'no run-scoped log: no BOOT boundary, no inventory sample' }),
    inputRecord({ id: 'decisions', path: paths.decisionsPath, required: true, reason: 'no Jev decision stream: the model-authority evidence cannot be counted' }),
    inputRecord({ id: 'runnerOut', path: paths.runnerOutPath, required: false, reason: 'no runner.out: authority markers must come from buddy.log' }),
    inputRecord({ id: 'snapshotDir', path: paths.snapshotDir, required: false, reason: 'no snapshot/predicate directory' }),
    inputRecord({ id: 'operatorDecisions', path: paths.operatorDecisions, required: false, reason: 'no operator decision file: the milestone premise is then unrecorded' }),
    inputRecord({ id: 'environment', path: paths.environment, required: false, reason: 'no --environment record: config-change rationale is unavailable and difficulty/gamerules/worldChanges are then derived from the log only' }),
    inputRecord({ id: 'metricsTool', path: join(REPO_ROOT, METRICS_TOOL), required: true, reason: 'the #436/#437 metrics tool is missing from this checkout' }),
  ]
  const missingRequired = inputs.filter((input) => input.required && input.status === 'MISSING')
  for (const input of missingRequired) {
    write(`M3_BUNDLE_INPUT_MISSING id=${input.id} path=${input.path ?? 'none'} reason=${input.reason ?? 'unknown'}\n`)
  }

  // ---- ONE socket binding, pinned into both consumers ----------------------
  let socketBinding = null
  let socketProbe = 'skipped'
  if (!noControlSocket && typeof paths.controlSocketPath === 'string' && paths.controlSocketPath !== '') {
    try {
      socketBinding = await readSocket(paths.controlSocketPath)
      socketProbe = socketBinding === null ? 'no_reply' : socketBinding.runId === runId ? 'matched' : `run_mismatch observed=${String(socketBinding.runId)}`
    } catch (thrown) {
      socketProbe = `error ${thrown instanceof Error ? thrown.message : String(thrown)}`
      socketBinding = null
    }
  } else if (noControlSocket) {
    socketProbe = 'disabled'
  } else {
    socketProbe = 'no_socket_path'
  }
  const pinnedBinding = socketBinding !== null && socketBinding.runId === runId ? socketBinding : null
  const socketArgs = noControlSocket || paths.controlSocketPath === null ? ['--no-control-socket'] : ['--control-socket', paths.controlSocketPath]

  // ---- step 1: the artifact (embeds both delegated gate verdicts) ----------
  const artifactPath = join(resolvedOut, `artifact-${runId}.json`)
  const artifactStep = await runStep({
    id: 'artifact',
    argv: [
      'bun',
      ARTIFACT_TOOL,
      '--run',
      runId,
      '--root',
      resolvedRoot,
      '--json',
      '--out',
      artifactPath,
      ...(paths.environment === null ? [] : ['--environment', paths.environment]),
      ...(paths.operatorDecisions === null ? ['--no-operator-decisions'] : ['--operator-decisions', paths.operatorDecisions]),
      ...socketArgs,
    ],
    fn: async (capture) => {
      const built = await buildRunArtifact({
        runId,
        root: resolvedRoot,
        overrides: {
          ...overrides,
          ...(noControlSocket ? { controlSocketPath: null } : {}),
        },
        gates,
        readSocket: async () => pinnedBinding,
      })
      const artifact = built.artifact
      // The in-process assembler prints nothing; emit the facts a reader would need
      // from the CLI form so commands/01-artifact.txt is a real record, not an empty
      // file. These are copies of fields the artifact itself computed.
      capture(`ARTIFACT status=${String(artifact?.status ?? 'UNKNOWN')} complete=${String(artifact?.complete ?? false)} runId=${runId}`)
      capture(`ARTIFACT verdicts M2=${String(artifact?.verdicts?.M2?.status ?? 'UNKNOWN')} reason=${String(artifact?.verdicts?.M2?.reason ?? 'unknown')}`)
      capture(`ARTIFACT verdicts M3=${String(artifact?.verdicts?.M3?.status ?? 'UNKNOWN')} reason=${String(artifact?.verdicts?.M3?.reason ?? 'unknown')}`)
      for (const gap of Array.isArray(artifact?.missingEvidence) ? artifact.missingEvidence : []) capture(`ARTIFACT missingEvidence ${gap}`)
      return { result: artifact, code: built.exitCode }
    },
  })
  const artifact = artifactStep.result
  const requiredArtifactEvidence = evaluateRequiredM3ArtifactEvidence(artifact, runId)

  // ---- step 2: the canonical M3 gate, on the SAME pinned evidence ----------
  const bootSourceSha = artifact?.run?.boot?.sourceSha ?? null
  const gateStep = await runStep({
    id: 'm3-gate',
    argv: [
      'bun',
      CANONICAL_M3_EVALUATOR,
      '--run',
      runId,
      '--log',
      String(paths.logPath),
      '--snapshot-dir',
      String(paths.snapshotDir),
      '--decisions',
      String(paths.decisionsPath),
      '--runner-out',
      String(paths.runnerOutPath ?? paths.logPath),
      ...socketArgs,
    ],
    fn: async (capture) => {
      let gateResult = null
      const code = await runGate({
        expectedRunId: runId,
        logPath: paths.logPath,
        snapshotDir: paths.snapshotDir,
        decisionsPath: paths.decisionsPath,
        runnerOutPath: paths.runnerOutPath,
        controlSocketPath: paths.controlSocketPath ?? undefined,
        policySocket: pinnedBinding,
        sourceSha: bootSourceSha,
        json: false,
        write: capture,
        onResult: (result) => {
          gateResult = result
        },
      })
      return { result: gateResult, code }
    },
  })
  const gate = gateStep.result
  const gateConditions = isPlainObject(gate?.conditions) ? gate.conditions : {}

  // ---- step 3: #436/#437 metrics, reusing the existing tool ----------------
  const metricsPath = join(resolvedOut, 'metrics.json')
  const metricsStep = await runStep({
    id: 'skill-closure-metrics',
    argv: ['bun', METRICS_TOOL, '--run', runId, '--root', resolvedRoot],
    fn: async (capture) => {
      const spawned = spawn(process.execPath, [join(REPO_ROOT, METRICS_TOOL), '--run', runId, '--root', resolvedRoot], { encoding: 'utf8' })
      const stdout = spawned.stdout ?? ''
      const stderr = spawned.stderr ?? ''
      // The spawned tool's own stdout IS this command's captured output.
      for (const entry of stdout.split('\n')) if (entry !== '') capture(entry)
      if (stderr.trim() !== '') write(`${stderr.trimEnd()}\n`)
      let parsed = null
      try {
        parsed = JSON.parse(stdout)
      } catch {
        parsed = null
      }
      return { result: { report: parsed, raw: stdout }, code: spawned.status ?? 2 }
    },
  })

  // ---- consistency: the gate and the artifact must agree -------------------
  const artifactConditions = isPlainObject(artifact?.verdicts?.M3?.conditions) ? artifact.verdicts.M3.conditions : {}
  const consistency = []
  const disagreements = []
  for (const id of M3_REQUIRED_CONDITIONS) {
    const gateValue = gateConditions[id] ?? 'UNKNOWN'
    const artifactValue = artifactConditions[id] ?? 'UNKNOWN'
    if (gateValue !== artifactValue) disagreements.push(`${id}: gate=${gateValue} artifact=${artifactValue}`)
  }
  consistency.push({
    check: 'gate_vs_artifact_conditions',
    severity: 'error',
    ok: disagreements.length === 0,
    detail:
      disagreements.length === 0
        ? `tools/m3-gate.mjs and the artifact's embedded verdict agree on all ${M3_REQUIRED_CONDITIONS.length} required conditions`
        : `CONTRADICTION ${disagreements.join('; ')} (both were fed the same pinned socket binding: ${socketProbe})`,
  })
  const gateBound = artifact?.gateEvidence?.authority?.gateBound === true
  const gateAuthoritySource = artifact?.gateEvidence?.authority?.source ?? null
  consistency.push({
    check: 'authority_evidence_bound',
    severity: 'note',
    ok: gateBound,
    detail: gateBound
      ? `model-authority evidence was bound to this run from ${String(gateAuthoritySource)}`
      : `model-authority evidence is UNBOUND (${String(artifact?.gateEvidence?.authority?.reason ?? 'unknown')}); a separately-invoked gate with a LIVE socket report may judge differently - pinning avoids that, an unbounded file-only window does not`,
  })
  consistency.push({
    check: 'socket_binding',
    severity: 'note',
    ok: true,
    detail:
      pinnedBinding === null
        ? `no matching control-socket report (${socketProbe}); every verdict below is from the run's own files only`
        : `pinned ONE read-only report runId=${String(pinnedBinding.runId)} (${socketProbe}) into both the gate and the artifact`,
  })

  // ---- the per-condition verdict matrix ------------------------------------
  const conditions = []
  const contradictionIds = new Set(disagreements.map((entry) => entry.split(':')[0]))
  for (const id of M3_REQUIRED_CONDITIONS) {
    const gateValue = gateConditions[id] ?? 'UNKNOWN'
    const contradicted = contradictionIds.has(id)
    conditions.push(
      conditionRow({
        id: `M3.${id}`,
        verdict: contradicted ? 'UNKNOWN' : gateValue,
        source: CANONICAL_M3_EVALUATOR,
        reason: contradicted
          ? `gate/artifact contradiction: gate=${gateValue} artifact=${artifactConditions[id] ?? 'UNKNOWN'}`
          : gateValue === 'PASS'
            ? 'gate condition PASS'
            : gate?.reason ?? 'gate condition not proven',
        detail: id === 'ender_eye_ready' && isPlainObject(gate?.facts?.eyes) ? gate.facts.eyes : null,
      }),
    )
  }
  // A full M3 acceptance requires the fresh run to prove its own M2 chain first.
  // An operator decision that permits inheriting a prior M2 state is useful context,
  // but it cannot substitute for this run's source-bound build -> light -> verify.
  const premise = artifact?.verdicts?.M2?.operatorDecisionPremise ?? null
  const m2Gate = artifact?.verdicts?.M2 ?? null
  const expectedSourceSha = normalizeSourceSha(artifact?.run?.boot?.sourceSha)
  const m2SourceSha = normalizeSourceSha(m2Gate?.sourceSha)
  const m2RunMatches = artifact?.runId === runId && m2Gate?.gateRunId === runId
  const m2SourceMatches = expectedSourceSha !== null && m2SourceSha !== null && m2SourceSha === expectedSourceSha
  const m2IdentityMatches = m2RunMatches && m2SourceMatches
  const m2WrapperStatus = ['PASS', 'FAIL', 'UNKNOWN'].includes(m2Gate?.status) ? m2Gate.status : 'UNKNOWN'
  const m2EvaluatorStatus = ['PASS', 'FAIL', 'UNKNOWN'].includes(m2Gate?.gateStatus) ? m2Gate.gateStatus : null
  const m2StatusMatches = m2EvaluatorStatus !== null && m2EvaluatorStatus === m2WrapperStatus
  const m2ReportedStatus = m2StatusMatches ? m2WrapperStatus : 'UNKNOWN'
  const m2AcceptanceStatus = m2IdentityMatches && m2StatusMatches ? m2ReportedStatus : 'UNKNOWN'
  let m2AcceptanceReason
  if (!m2RunMatches) {
    m2AcceptanceReason = `same-run M2 gate identity unavailable or mismatched: expected runId=${runId}, artifact runId=${String(artifact?.runId ?? 'unknown')}, evaluator runId=${String(m2Gate?.gateRunId ?? 'unknown')}`
  } else if (!m2SourceMatches) {
    m2AcceptanceReason = `same-run M2 source SHA unavailable or mismatched: expected BOOT sourceSha=${expectedSourceSha ?? 'invalid'}, M2 sourceSha=${m2SourceSha ?? 'invalid'}`
  } else if (!m2StatusMatches) {
    m2AcceptanceReason = `M2 evaluator/wrapper verdict mismatch: evaluator=${String(m2EvaluatorStatus ?? 'missing')} wrapper=${m2WrapperStatus}`
  } else if (m2ReportedStatus === 'PASS') {
    m2AcceptanceReason = `same-run M2 gate PASS on BOOT sourceSha=${expectedSourceSha}; build, light, and verify are proven before M3 acceptance`
  } else {
    m2AcceptanceReason = `same-run M2 gate ${m2ReportedStatus}: ${String(m2Gate?.reason ?? 'no M2 gate reason')}`
  }
  if (m2AcceptanceStatus !== 'PASS' && premise?.thisRunInherits === true) {
    m2AcceptanceReason += '; an inherited M2 premise does not substitute for this run\'s M2 gate PASS'
  }
  conditions.push(
    conditionRow({
      id: 'M2.premise',
      verdict: m2AcceptanceStatus,
      source: 'tools/m2-gate.mjs',
      reason: m2AcceptanceReason,
      detail: {
        gateStatus: m2WrapperStatus,
        evaluatorStatus: m2EvaluatorStatus,
        gateReason: m2Gate?.reason ?? null,
        gateRunId: m2Gate?.gateRunId ?? null,
        expectedRunId: runId,
        gateSourceSha: m2SourceSha,
        gateSourceShaReason: m2Gate?.sourceShaReason ?? null,
        expectedSourceSha,
        runMatches: m2RunMatches,
        sourceMatches: m2SourceMatches,
        statusMatches: m2StatusMatches,
        requiredStages: m2Gate?.conditions ?? null,
        thisRunInherits: premise?.thisRunInherits ?? false,
        thisRunMust: premise?.thisRunMust ?? 'build',
        recordedRunScope: premise?.decisions?.[0]?.runScope ?? null,
        recordedScope: premise?.decisions?.[0]?.decisionScope ?? null,
        recordedSource: premise?.source ?? null,
        recordedSha256: premise?.sha256 ?? null,
      },
      blocking: true,
    }),
  )
  conditions.push(
    conditionRow({
      id: 'artifact.requiredEvidence',
      verdict: requiredArtifactEvidence.status,
      source: ARTIFACT_TOOL,
      reason: requiredArtifactEvidence.missing.length === 0
        ? 'the required same-run M3 audit facts are present and source-bound'
        : `required run-scoped evidence is missing or mismatched: ${requiredArtifactEvidence.missing.join(', ')}`,
      detail: requiredArtifactEvidence,
      blocking: true,
    }),
  )
  // ---- evidence classes (diagnostic; never a fabricated fact) --------------
  const acceptanceClass = artifact?.acceptance?.evidenceClass ?? null
  const acceptancePresent = artifact?.acceptance?.present === true
  conditions.push(
    conditionRow({
      id: 'evidence.acceptance',
      verdict: acceptancePresent ? 'PRESENT' : requireAcceptance ? 'MISSING' : 'MISSING_NON_BLOCKING',
      source: ACCEPTANCE_WRITER.source,
      reason: acceptancePresent
        ? 'the HOST acceptance record is present for this run'
        : `${String(artifact?.acceptance?.reason ?? 'acceptance_artifact_missing')}: written by ${ACCEPTANCE_WRITER.symbol} on ${ACCEPTANCE_WRITER.firesOn.join('/')}; it attests HOST state and never asserts a milestone PASS`,
      detail: {
        path: artifact?.acceptance?.path ?? null,
        attests: ACCEPTANCE_WRITER.attests,
        safeTriggers: ACCEPTANCE_WRITER.safeTriggers,
        fabricatable: ACCEPTANCE_WRITER.fabricatable,
        milestoneQuestionAnsweredBy: acceptanceClass?.milestoneQuestionAnsweredBy ?? 'milestoneAcceptance',
      },
      blocking: requireAcceptance,
    }),
  )
  for (const entry of Array.isArray(artifact?.evidenceClasses) ? artifact.evidenceClasses : []) {
    if (entry.id === 'acceptance') continue
    conditions.push(
      conditionRow({
        id: `evidence.${entry.id}`,
        verdict: entry.status,
        source: entry.source ?? null,
        reason: entry.reason,
        blocking: false,
      }),
    )
  }
  const metricsCode = metricsStep.code
  conditions.push(
    conditionRow({
      id: 'metrics.skillClosure',
      verdict: metricsCode === 0 ? 'PRESENT' : 'MISSING',
      source: METRICS_TOOL,
      reason: metricsCode === 0 ? 'the #436/#437 Skill-closure metrics report was produced' : metricsStep.text.trim() || `exit ${metricsCode}`,
      blocking: false,
    }),
  )

  // ---- overall verdict ------------------------------------------------------
  const blocking = conditions.filter((condition) => condition.blocking)
  const gateStatus = gate?.status ?? 'UNKNOWN'
  let acceptanceStatus = 'PASS'
  let acceptanceReason = 'every required M3 condition is PASS and the gate/artifact verdicts agree'
  // A contradiction is ALWAYS named in the reason, whichever branch decides the
  // status: a reviewer must never have to read the consistency section to learn that
  // two tools disagreed about the same condition.
  const contradictionNote = disagreements.length > 0 ? `gate/artifact contradiction: ${disagreements.join('; ')}` : null
  if (gateStatus === 'FAIL') {
    acceptanceStatus = 'FAIL'
    acceptanceReason = `the canonical M3 gate reported FAIL reason=${String(gate?.reason ?? 'unknown')}${contradictionNote === null ? '' : `; ${contradictionNote}`}`
  } else if (gateStatus !== 'PASS') {
    acceptanceStatus = 'UNKNOWN'
    acceptanceReason = `the canonical M3 gate reported ${gateStatus} reason=${String(gate?.reason ?? 'unknown')}${contradictionNote === null ? '' : `; ${contradictionNote}`}`
  } else if (contradictionNote !== null) {
    acceptanceStatus = 'UNKNOWN'
    acceptanceReason = contradictionNote
  } else if (blocking.some((condition) => condition.verdict !== 'PASS')) {
    const unmetBlocking = blocking.filter((condition) => condition.verdict !== 'PASS')
    acceptanceStatus = unmetBlocking.some((condition) => condition.verdict === 'FAIL') ? 'FAIL' : 'UNKNOWN'
    acceptanceReason = `unmet blocking condition(s): ${unmetBlocking
      .map((condition) => `${condition.id}=${condition.verdict} (${String(condition.reason ?? 'no reason supplied')})`)
      .join('; ')}`
  } else if (missingRequired.length > 0) {
    acceptanceStatus = 'UNKNOWN'
    acceptanceReason = `missing required input(s): ${missingRequired.map((input) => input.id).join(', ')}`
  }
  const exitCode = acceptanceStatus === 'FAIL' ? 1 : acceptanceStatus === 'PASS' ? 0 : 2

  // ---- live signals: a synthetic tree can never be a live PASS -------------
  const hostLockPath = join(resolvedRoot, 'buddy-driver', 'data', 'resident', 'host.lock')
  const liveSignals = [
    { id: 'hostLock', ok: existsSync(hostLockPath), detail: hostLockPath },
    { id: 'acceptanceRecord', ok: acceptancePresent, detail: artifact?.acceptance?.path ?? null },
    { id: 'sourceTreeClean', ok: git.dirty === false, detail: `dirty=${String(git.dirty)}` },
    {
      id: 'bootSourceMatchesTreeHead',
      ok: bootSourceSha !== null && git.head !== null && bootSourceSha === git.head,
      detail: `boot=${String(bootSourceSha)} treeHead=${String(git.head)}`,
    },
  ]
  const liveAcceptance = acceptanceStatus === 'PASS' && declaredClass === 'live' && liveSignals.every((signal) => signal.ok)

  const bundle = {
    record: RECORD,
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    runId,
    root: resolvedRoot,
    outDir: resolvedOut,
    git,
    evidenceClass: declaredClass,
    liveAcceptance,
    liveSignals,
    acceptanceVerdict: { status: acceptanceStatus, reason: acceptanceReason },
    // The canonical gate's own machine result, verbatim.
    gate: {
      tool: CANONICAL_M3_EVALUATOR,
      status: gateStatus,
      reason: gate?.reason ?? null,
      conditions: gateConditions,
      facts: isPlainObject(gate?.facts) ? gate.facts : null,
      resultLine: (gateStep.text.split('\n').find((line) => line.startsWith(M3_RUN_RESULT)) ?? null),
    },
    conditions,
    artifact: {
      tool: ARTIFACT_TOOL,
      record: ARTIFACT_RECORD,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      path: artifactPath,
      // The whole regenerated artifact, so ONE bundle carries artifact + gate +
      // metrics without a second lookup. It is also written to `path`.
      document: isPlainObject(artifact) ? artifact : null,
      status: artifact?.status ?? 'UNKNOWN',
      complete: artifact?.complete ?? false,
      missingEvidence: artifact?.missingEvidence ?? [],
      missingEvidenceDetail: artifact?.missingEvidenceDetail ?? [],
      evidenceClasses: artifact?.evidenceClasses ?? [],
      operatorDecisionPremise: premise,
      gateEvidence: artifact?.gateEvidence ?? null,
      requiredEvidence: requiredArtifactEvidence,
    },
    consistency,
    socketProbe,
    socketBinding: pinnedBinding === null ? null : { runId: pinnedBinding.runId ?? null, frozen: pinnedBinding.frozen ?? null },
    metrics: {
      tool: METRICS_TOOL,
      status: metricsCode === 0 ? 'PRESENT' : 'MISSING',
      report: metricsStep.result?.report ?? null,
    },
    inputs,
    missingRequiredInputs: missingRequired.map((input) => input.id),
    commands: commands.map((command) => ({ ...command, stdout: undefined, stdoutLines: command.stdout.split('\n').length })),
    residual: [],
  }
  // Honest residual: what this bundle still cannot decide on its own.
  if (!acceptancePresent) {
    bundle.residual.push(
      `HOST acceptance-<runId>.json is absent (${String(artifact?.acceptance?.reason ?? 'unknown')}); it is a HOST lifecycle attestation and no tool may fabricate it. Safe triggers: ${ACCEPTANCE_WRITER.safeTriggers.join('; ')}`,
    )
    bundle.residual.push(
      'a periodic (observe-loop) acceptance refresh is NOT implemented in this SHA, so the only non-disruptive way to make the record exist is one of the triggers above (the read-only `acceptance` control query refreshes it without changing run state)',
    )
  }
  if (declaredClass !== 'live') {
    bundle.residual.push(
      `evidence class is "${declaredClass}", so even a PASS is NOT a live acceptance; rerun with --evidence-class live on the resident tree that produced the run`,
    )
  }
  if (!gateBound) {
    bundle.residual.push(
      `model-authority evidence could not be bound to runId=${runId} from the run's own files (${String(artifact?.gateEvidence?.authority?.reason ?? 'unknown')}); if the resident is still live, a matching read-only report is the only non-fabricated way to bind it`,
    )
  }
  if (!liveSignals.every((signal) => signal.ok)) {
    bundle.residual.push(`live signal(s) not satisfied: ${liveSignals.filter((signal) => !signal.ok).map((signal) => `${signal.id} (${String(signal.detail)})`).join('; ')}`)
  }
  for (const input of inputs) {
    if (!input.required && input.status === 'MISSING') bundle.residual.push(`optional input ${input.id} is MISSING: ${input.reason}`)
  }
  bundle.residual.push('this bundle is a READER: it never fabricates evidence and never turns UNKNOWN into PASS')

  // ---- write the bundle ----------------------------------------------------
  if (typeof resolvedOut === 'string' && resolvedOut !== '') {
    try {
      mkdirSync(join(resolvedOut, 'commands'), { recursive: true })
      writeFileSync(join(resolvedOut, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
      writeFileSync(join(resolvedOut, 'bundle.md'), bundleMarkdown(bundle), 'utf8')
      if (isPlainObject(artifact)) writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
      if (metricsStep.result?.raw) writeFileSync(metricsPath, metricsStep.result.raw, 'utf8')
      for (const [index, entry] of commandTexts.entries()) {
        writeFileSync(join(resolvedOut, 'commands', `${String(index + 1).padStart(2, '0')}-${entry.id}.txt`), `${entry.text}\n`, 'utf8')
      }
      bundle.outputs = {
        bundleJson: join(resolvedOut, 'bundle.json'),
        bundleMarkdown: join(resolvedOut, 'bundle.md'),
        artifact: isPlainObject(artifact) ? artifactPath : null,
        metrics: metricsStep.result?.raw ? metricsPath : null,
        commands: commands.map((command, index) => join(resolvedOut, 'commands', `${String(index + 1).padStart(2, '0')}-${command.id}.txt`)),
      }
    } catch (thrown) {
      write(`M3_BUNDLE_WRITE_FAILED dir=${resolvedOut} reason=${thrown instanceof Error ? thrown.message : String(thrown)}\n`)
      return finish(bundle, 2)
    }
  }
  return finish(bundle, exitCode)
}

/** The human reviewer summary. One line per condition, verdict first. */
export function bundleMarkdown(bundle) {
  const lines = []
  lines.push(`# M3 acceptance bundle — ${bundle.runId}`)
  lines.push('')
  lines.push(`- generatedAt: ${bundle.generatedAt}`)
  lines.push(`- root: ${bundle.root}`)
  lines.push(`- tree HEAD: ${String(bundle.git?.head)} (branch ${String(bundle.git?.branch)}, dirty=${String(bundle.git?.dirty)})`)
  lines.push(`- evidenceClass: ${bundle.evidenceClass} — liveAcceptance: ${String(bundle.liveAcceptance)}`)
  lines.push(`- VERDICT: **${bundle.acceptanceVerdict.status}** — ${bundle.acceptanceVerdict.reason}`)
  lines.push('')
  lines.push('## Conditions')
  lines.push('')
  lines.push('| condition | verdict | blocking | source | reason |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const condition of bundle.conditions) {
    lines.push(
      `| ${condition.id} | ${condition.verdict} | ${condition.blocking ? 'yes' : 'no'} | ${condition.source ?? ''} | ${String(condition.reason ?? '').replace(/\|/g, '\\|')} |`,
    )
  }
  lines.push('')
  lines.push('## Consistency (one verdict per condition)')
  lines.push('')
  for (const check of bundle.consistency) {
    const label = check.ok ? 'OK' : check.severity === 'error' ? 'FAIL' : 'NOTE'
    lines.push(`- ${label} ${check.check}: ${check.detail}`)
  }
  lines.push('')
  lines.push('## Operator decision premise (per run)')
  lines.push('')
  const premise = bundle.artifact?.operatorDecisionPremise
  if (premise === null || premise === undefined) {
    lines.push('- no artifact premise available')
  } else {
    lines.push(`- present: ${String(premise.present)} — thisRunInherits: ${String(premise.thisRunInherits)} — thisRunMust: ${premise.thisRunMust}`)
    lines.push(`- ${premise.consequence}`)
  }
  lines.push('')
  lines.push('## Commands run (exact argv, captured output)')
  lines.push('')
  for (const command of bundle.commands) {
    lines.push(`- exit=${command.exitCode} sha256=${command.stdoutSha256.slice(0, 16)} :: ${command.argv.join(' ')}`)
  }
  lines.push('')
  lines.push('## Residual (what still needs a live run)')
  lines.push('')
  for (const entry of bundle.residual) lines.push(`- ${entry}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function runCli({
  argv = process.argv.slice(2),
  write = (line) => process.stdout.write(line),
  writeError = (line) => process.stderr.write(line),
  build = buildAcceptanceBundle,
} = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    writeError(`M3_BUNDLE_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
    return { exitCode: 2, bundle: null }
  }
  if (args.help) {
    write(usage())
    return { exitCode: 0, bundle: null }
  }
  if (args.evidenceClass !== null && !EVIDENCE_CLASSES.includes(args.evidenceClass)) {
    writeError(`M3_BUNDLE_ERROR --evidence-class must be one of ${EVIDENCE_CLASSES.join('|')}\n`)
    return { exitCode: 2, bundle: null }
  }
  const { bundle, exitCode } = await build({
    runId: args.run,
    root: args.root ?? REPO_ROOT,
    outDir: args.out,
    overrides: {
      ...(args.environment === null ? {} : { environment: args.environment }),
      ...(args.operatorDecisions === undefined ? {} : { operatorDecisions: args.operatorDecisions }),
    },
    evidenceClass: args.evidenceClass,
    requireAcceptance: args.requireAcceptance,
    noControlSocket: args.noControlSocket,
    write: writeError,
  })
  if (args.json) {
    write(`${JSON.stringify(bundle)}\n`)
  } else {
    write(bundleMarkdown(bundle))
  }
  // The result line goes to stderr under --json so stdout stays machine-parseable
  // (the same contract tools/milestone-run-artifact.mjs keeps).
  const resultLine =
    `M3_BUNDLE_RESULT runId=${bundle.runId ?? 'none'} status=${bundle.acceptanceVerdict.status} ` +
    `reason=${JSON.stringify(bundle.acceptanceVerdict.reason)} evidenceClass=${bundle.evidenceClass} liveAcceptance=${String(bundle.liveAcceptance)} ` +
    `out=${bundle.outDir}\n`
  if (args.json) writeError(resultLine)
  else write(resultLine)
  for (const condition of bundle.conditions) {
    if (condition.blocking && condition.verdict !== 'PASS') {
      writeError(`M3_BUNDLE_UNMET ${condition.id} verdict=${condition.verdict} reason=${condition.reason ?? 'unknown'}\n`)
    }
  }
  for (const input of bundle.inputs ?? []) {
    if (input.required && input.status === 'MISSING') writeError(`M3_BUNDLE_INPUT_MISSING id=${input.id} path=${input.path ?? 'none'}\n`)
  }
  return { exitCode, bundle }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const result = await runCli()
  process.exitCode = result.exitCode
}
