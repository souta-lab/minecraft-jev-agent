#!/usr/bin/env bun
// Normalize an already-stopped legacy Reach run into the comparator input.
// This is read-only with respect to the legacy archive/repository and never
// starts a Minecraft server or invents absent measurements.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectLegacyReachArchive } from './validate-vtr-reach-evidence.mjs'
import { relativeBlockOffset, samePosition } from './vtr-reach-legacy-baseline.mjs'

const SHA40_RE = /^[0-9a-f]{40}$/i
const HELP = `Usage: bun tools/collect-vtr-reach-legacy-baseline.mjs \\
  --legacy-archive <stopped-raw-run-directory> --repo <clean-exact-origin-main-checkout> \\
  --vtr-probe <probe.json> --output <legacy-input.json>

Reads a stopped legacy run and a VTR probe. Requires the legacy source SHA,
checkout HEAD, and checkout origin/main to be identical. It derives the
Mission only from the one raw human collect command and exact observed target
witness; movement/model metrics are recomputed from raw legacy journals by the
acceptance inspector. It does not run a server or emit comparison PASS.
`

function parseArgs(argv) {
  const result = { legacyArchive: null, repo: null, vtrProbe: null, output: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { result.help = true; continue }
    if (!['--legacy-archive', '--repo', '--vtr-probe', '--output'].includes(argument)) throw new Error(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    result[argument.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value
    index += 1
  }
  if (!result.help && Object.values(result).some((value, index) => index < 4 && !value)) throw new Error('--legacy-archive, --repo, --vtr-probe, and --output are required')
  return result
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function readRegularJson(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular non-symlink file: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseWorldKey(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} worldKey is missing`)
  const parts = value.split('|')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2])) throw new Error(`${label} worldKey is malformed`)
  return { server: parts[0], dimension: parts[1].replace(/^minecraft:/, ''), epoch: Number(parts[2]) }
}

function normalizedItem(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/^minecraft:/, '') : null
}

function collectVtrReachLegacyBaseline({ legacyArchive, repoPath, vtrProbePath, outputPath }) {
  const archive = resolve(legacyArchive)
  const repo = resolve(repoPath)
  const vtrPath = resolve(vtrProbePath)
  const output = resolve(outputPath)
  if (!existsSync(archive) || !existsSync(repo) || !existsSync(vtrPath)) throw new Error('legacy archive, exact-source repository, and VTR probe must all exist')

  const head = git(repo, ['rev-parse', '--verify', 'HEAD'])
  const originMain = git(repo, ['rev-parse', '--verify', 'origin/main'])
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=all'])
  if (!SHA40_RE.test(head) || !SHA40_RE.test(originMain) || head.toLowerCase() !== originMain.toLowerCase()) {
    throw new Error(`legacy checkout is not exact origin/main: HEAD=${head} origin/main=${originMain}`)
  }
  if (dirty !== '') throw new Error('legacy source checkout is dirty; exact-source binding requires a clean checkout')

  const legacy = inspectLegacyReachArchive(archive)
  const summary = legacy.summary
  if (legacy.status && legacy.status !== 'PASS') throw new Error(`legacy raw evidence inspection did not pass: ${legacy.status}`)
  const sourceSha = String(summary.sourceSha ?? '').toLowerCase()
  if (!SHA40_RE.test(sourceSha) || sourceSha !== head.toLowerCase()) {
    throw new Error(`legacy run source ${summary.sourceSha ?? 'unknown'} differs from clean origin/main checkout ${head}`)
  }

  const probe = readRegularJson(vtrPath, 'VTR probe')
  if (probe.schema !== 'vtr-reach-live-probe/v1') throw new Error(`unsupported VTR probe schema: ${probe.schema ?? 'missing'}`)
  const vtrMission = probe.mission
  const mission = legacy.mission
  if (!vtrMission || vtrMission.kind !== mission.kind || normalizedItem(vtrMission.item) !== mission.item || vtrMission.count !== mission.count) {
    throw new Error('raw legacy Mission command does not match the VTR Mission predicate')
  }

  const legacyFixture = summary.fixture
  const rawLegacyStart = legacy.measured.initialPlayerPosition
  const rawLegacyTarget = legacyFixture?.position
  const vtrFixture = probe.fixture ?? {}
  const vtrWitness = vtrFixture.relativeResourceSource ?? vtrFixture.witness ?? {}
  const vtrTarget = vtrWitness.position ?? vtrWitness.target ?? vtrWitness.blockPosition
  const vtrStart = vtrFixture.transitionStartPosition ?? vtrFixture.initialPlayerPosition
  if (normalizedItem(legacyFixture?.block) !== mission.item || normalizedItem(vtrWitness.block) !== mission.item) {
    throw new Error('raw legacy/VTR target witness block differs from the normalized Mission item')
  }
  if (!samePosition(legacyFixture.initialPlayerPosition, rawLegacyStart)) throw new Error('legacy reported fixture start is not the raw movement start')
  const oldRelative = relativeBlockOffset(rawLegacyTarget, rawLegacyStart)
  const newRelative = relativeBlockOffset(vtrTarget, vtrStart)
  if (!oldRelative || !newRelative || !samePosition(oldRelative, newRelative)) {
    throw new Error('legacy and VTR target witnesses do not have the same relative block geometry')
  }
  const oldWorld = parseWorldKey(summary.run?.worldKey, 'legacy')
  const vtrWorld = parseWorldKey(probe.run?.worldKey, 'VTR')
  const environment = {
    minecraftVersion: summary.run?.minecraftVersion === probe.run?.minecraftVersion,
    gameMode: summary.run?.gameMode === (probe.run?.gameMode ?? probe.run?.gamemode),
    difficulty: summary.run?.difficulty === probe.run?.difficulty,
    dimension: oldWorld.dimension === vtrWorld.dimension,
    seed: String(summary.run?.seed) === String(probe.run?.seed),
  }
  if (Object.values(environment).some((value) => value !== true)) {
    throw new Error(`legacy/VTR environments do not align: ${JSON.stringify(environment)}`)
  }

  const first = summary.events.firstDecision
  const next = summary.events.nextDecisionInRange
  const moveEnd = summary.events.moveActionEnd
  const measured = legacy.measured
  const outcome = `MOVE ${moveEnd.actionId} SUCCESS/verified; next raw decision selected inReach MINE ${next.selected}`
  const input = {
    schema: 'legacy-reach-comparator/v1',
    sourceSha,
    buildHash: summary.buildHash,
    runId: summary.runId,
    generationId: summary.generationId,
    sameMissionInput: true,
    missionInput: mission,
    missionNormalization: legacy.missionProvenance,
    fixture: {
      block: legacyFixture.block,
      position: rawLegacyTarget,
      initialPlayerPosition: rawLegacyStart,
      sourceOffsetFromInitialPlayer: oldRelative,
      flatSolidGround: typeof legacyFixture.flatSolidGround === 'boolean' ? legacyFixture.flatSolidGround : null,
      witnessChosenByProductionSensor: typeof legacyFixture.witnessChosenByProductionSensor === 'boolean' ? legacyFixture.witnessChosenByProductionSensor : null,
    },
    legacyPlan: { goal: `raw chat Mission: ${legacy.missionProvenance.command}`, missionInput: mission },
    run: {
      worldKey: summary.run.worldKey,
      worldEpoch: oldWorld.epoch,
      levelName: summary.run.levelName,
      seed: String(summary.run.seed),
      minecraftVersion: summary.run.minecraftVersion,
      gameMode: summary.run.gameMode,
      difficulty: summary.run.difficulty,
    },
    sliceMetrics: {
      mechanicalMovementSteps: measured.movementOperationsToInRange,
      legacyMoveActionsToInRangeEvidence: measured.moveActionsToInRange,
      jevDecisionFramesThroughInRangeDecision: measured.decisionFramesToInRange,
      jevQuestionCallsThroughInRangeDecision: measured.questionCallsToInRange,
      system2LlmCalls: measured.system2ModelCalls,
      jevProviderModelCalls: measured.jevProviderModelCalls,
      networkModelCalls: measured.networkModelCalls,
      modelCallsPerMechanicalStep: measured.modelCallsPerMovementStep,
      verifiedVtrTransitions: 0,
      legacyReachSpecificTerminal: 0,
      oldSkillOutcome: outcome,
      typedVtrTerminalOutcome: 'not-applicable/no VTR contract',
    },
    events: {
      firstDecision: { decisionId: first.decisionId },
      nextDecisionInRange: { decisionId: next.decisionId, selected: next.selected },
      moveActionEnd: {
        actionId: moveEnd.actionId,
        timestamp: moveEnd.timestamp,
        movementStepCount: measured.movementOperationsToInRange,
        pathLegs: moveEnd.pathLegs,
        pathCallback: moveEnd.pathCallback,
        skillEnd: moveEnd.skillEnd,
        verification: moveEnd.verification,
      },
    },
    sourceBinding: {
      schema: 'vtr-reach-legacy-source-binding/v1',
      sourceSha,
      cleanCheckoutHead: head,
      originMainAtCollection: originMain,
      runId: summary.runId,
      generationId: summary.generationId,
      rawMoveStartPosition: rawLegacyStart,
      relativeBlockOffset: oldRelative,
      environment,
    },
  }
  if (existsSync(output)) throw new Error(`output already exists: ${output}`)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(input, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { output, input }
}

async function main(argv) {
  let options
  try { options = parseArgs(argv) } catch (error) {
    process.stderr.write(`${error.message}\n${HELP}`)
    return 64
  }
  if (options.help) { process.stdout.write(HELP); return 0 }
  try {
    const result = collectVtrReachLegacyBaseline({
      legacyArchive: options.legacyArchive,
      repoPath: options.repo,
      vtrProbePath: options.vtrProbe,
      outputPath: options.output,
    })
    process.stdout.write(`${JSON.stringify({ status: 'COLLECTED', output: result.output, sourceSha: result.input.sourceSha, runId: result.input.runId, generationId: result.input.generationId, mission: result.input.missionInput, fixture: result.input.fixture, metrics: result.input.sliceMetrics })}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2))

export { collectVtrReachLegacyBaseline }
