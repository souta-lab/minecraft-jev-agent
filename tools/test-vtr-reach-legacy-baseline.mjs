import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectVtrReachLegacyBaseline } from './collect-vtr-reach-legacy-baseline.mjs'
import { normalizeLegacyCollectMissionCommand } from './vtr-reach-legacy-baseline.mjs'
import { inspectLegacyReachArchive } from './validate-vtr-reach-evidence.mjs'

const RUN = 'run-legacy-a1'
const GENERATION = 'gen-legacy-a1'
const BUILD = 'legacy-build-123'
const WORLD = '127.0.0.1:25565|minecraft:overworld|1'
const TARGET = { x: 6, y: 63, z: 489 }
const START = { x: 0.5, y: 63, z: 492.5 }
const ACTION = 'MOVE:b6_63_489'
const t = (offset) => new Date(Date.parse('2026-09-25T04:00:00.000Z') + offset * 1000).toISOString()

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}

function event(source, message, detail, ts) {
  return { record: 'agent-event', source, message, detail, ts }
}

function setup(root) {
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'source.txt'), 'origin-main fixture\n')
  execFileSync('git', ['-C', repo, 'add', 'source.txt'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'origin main fixture'])
  const sourceSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', sourceSha])

  const archive = join(root, 'legacy-run')
  const jevDir = join(archive, 'runner/runtime/logs/jev')
  mkdirSync(jevDir, { recursive: true })
  const firstDecision = 'decision-first'
  const nextDecision = 'decision-next'
  const firstCall = 'call-first'
  const nextCall = 'call-next'
  const first = {
    decisionId: firstDecision, callId: firstCall, ts: t(2), sourceSha, runId: RUN, generationId: GENERATION,
    chosenAction: ACTION, jev: { callId: firstCall, answers: { action: { value: ACTION }, abandon_option: { value: 0 } } },
    candidates: [{ id: ACTION, kind: 'MOVE', targetName: 'oak_log', inReach: false }],
  }
  const next = {
    decisionId: nextDecision, callId: nextCall, ts: t(7), sourceSha, runId: RUN, generationId: GENERATION,
    chosenAction: 'MINE:b6_63_489', jev: { callId: nextCall, answers: { action: { value: 'MINE:b6_63_489' }, abandon_option: { value: 0 } } },
    candidates: [{ id: 'MINE:b6_63_489', kind: 'MINE', targetName: 'oak_log', inReach: true }],
  }
  const summary = {
    schema: 'legacy-reach-comparator/v1', sourceSha, buildHash: BUILD, runId: RUN, generationId: GENERATION,
    missionInput: { kind: 'human_intent_collect', item: 'log', count: 1 },
    fixture: { block: 'oak_log', position: TARGET, initialPlayerPosition: START, sourceOffsetFromInitialPlayer: { x: 6, y: 0, z: -3 }, flatSolidGround: true },
    run: { worldKey: WORLD, worldEpoch: 1, levelName: 'legacy-test', seed: '42', minecraftVersion: '1.21.11', gameMode: 'survival', difficulty: 'peaceful' },
    sliceMetrics: { system2LlmCalls: 0, networkModelCalls: 0 },
    events: { firstDecision: { decisionId: firstDecision }, nextDecisionInRange: { decisionId: nextDecision, selected: 'MINE:b6_63_489' },
      moveActionEnd: { actionId: ACTION, timestamp: t(6), movementStepCount: 1, pathLegs: 1, pathCallback: 'completed', skillEnd: 'SUCCESS', verification: 'verified' } },
  }
  const runRows = [
    event('agent', 'jev-agent started policy=fallback provider=deterministic model=deterministic-local-fallback system2Provider=deterministic system2=unavailable',
      { policy: 'fallback', system2Provider: 'deterministic', system2Model: 'unavailable' }, t(1)),
    event('executor', `SKILL_START skill=WALK_TO actionId=${ACTION}`, { actionId: ACTION }, t(3)),
    event('executor', `SKILL_STEP skill=walk_to step=move evidence=move worldDelta=pos=${START.x},${START.y},${START.z}`, { actionId: ACTION, stepKind: 'move', count: 1 }, t(4)),
    event('executor', `SKILL_STEP skill=walk_to step=walk_leg evidence=path worldDelta=closing`, { actionId: ACTION, leg: 1, failure: null }, t(5)),
    event('executor', `MOVE ${ACTION} arrival start=(${START.x},${START.y},${START.z}) end=(5.5,63,490.5)`, { actionId: ACTION, start: START, end: { x: 5.5, y: 63, z: 490.5 } }, t(5.5)),
    event('executor', `SKILL_END skill=walk_to execution=success verification=verified outcome=SUCCESS failureCode=none`, { actionId: ACTION }, t(6)),
  ]
  const calls = [firstCall, nextCall].map((callId) => ({ record: 'jev-call', callId, policy: 'fallback', model: 'deterministic-local-fallback', latencyMs: 0 }))
  const host = [
    `[${t(3)}] SKILL_START actionId=${ACTION} runId=${RUN} generationId=${GENERATION} sourceSha=${sourceSha} buildHash=${BUILD}`,
    `[${t(5.8)}] PATH_CALLBACK phase=completed actionId=${ACTION} runId=${RUN} generationId=${GENERATION} sourceSha=${sourceSha} buildHash=${BUILD}`,
    `[${t(6)}] SKILL_END actionId=${ACTION} runId=${RUN} generationId=${GENERATION} sourceSha=${sourceSha} buildHash=${BUILD} outcome=SUCCESS failure=null`,
  ].join('\n') + '\n'

  writeJson(join(archive, 'runner/reach-slice-evidence.json'), summary)
  writeFileSync(join(archive, 'runner/runtime/buddy.log'), host)
  writeFileSync(join(jevDir, 'run.jsonl'), `${runRows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  writeFileSync(join(jevDir, 'decisions.jsonl'), `${[first, next].map((row) => JSON.stringify(row)).join('\n')}\n`)
  writeFileSync(join(jevDir, 'jev-calls.jsonl'), `${calls.map((row) => JSON.stringify(row)).join('\n')}\n`)
  writeFileSync(join(archive, 'runner/human-task-input.jsonl'), `${JSON.stringify({ event: 'chat_sent_after_intent_listener_ready', at: t(1.5), command: 'agent AI_Buddy collect oak_log 1' })}\n`)
  writeFileSync(join(archive, 'runner/block-read-run2.jsonl'), `${JSON.stringify({ tag: 'target', name: 'oak_log', position: TARGET, at: t(1) })}\n`)

  const probePath = join(root, 'vtr-probe.json')
  writeJson(probePath, {
    schema: 'vtr-reach-live-probe/v1',
    source: { commit: 'b'.repeat(40), buildHash: 'vtr-build' },
    run: { runId: 'run-vtr-b1', generationId: 'gen-vtr-b1', worldKey: '127.0.0.1:25576|minecraft:overworld|1',
      worldEpoch: 1, dimension: 'minecraft:overworld', levelName: 'vtr-test', seed: '42', minecraftVersion: '1.21.11', gameMode: 'survival', difficulty: 'peaceful' },
    mission: { id: 'mission:oak-log-1', kind: 'inventory_at_least', item: 'oak_log', count: 1 },
    fixture: { relativeResourceSource: { block: 'oak_log', position: TARGET }, transitionStartPosition: START, flatSolidGround: true, witnessChosenByProductionSensor: true },
  })
  return { repo, sourceSha, archive, probePath, summaryPath: join(archive, 'runner/reach-slice-evidence.json') }
}

test('normalizes only exact collect item/count commands against the observed witness', () => {
  assert.deepEqual(normalizeLegacyCollectMissionCommand('agent AI_Buddy collect oak_log 1', 'oak_log'), {
    mission: { kind: 'inventory_at_least', item: 'oak_log', count: 1 },
    provenance: {
      source: 'runner/human-task-input.jsonl',
      command: 'agent AI_Buddy collect oak_log 1',
      normalization: 'exact collect item/count + same raw MOVE/MINE witness => inventory_at_least',
      witnessBlock: 'oak_log',
    },
  })
  assert.equal(normalizeLegacyCollectMissionCommand('agent AI_Buddy collect log 1', 'oak_log'), null)
  assert.equal(normalizeLegacyCollectMissionCommand('agent AI_Buddy collect oak_log 2', 'oak_log').mission.count, 2)
})

test('collects exact origin/main legacy metrics, canonical Mission, relative geometry, and raw MOVE start', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-legacy-baseline-test-'))
  try {
    const fixture = setup(root)
    const output = join(root, 'collected', 'legacy-input.json')
    const result = collectVtrReachLegacyBaseline({ legacyArchive: fixture.archive, repoPath: fixture.repo, vtrProbePath: fixture.probePath, outputPath: output })
    assert.equal(result.input.sourceSha, fixture.sourceSha)
    assert.equal(result.input.sourceBinding.cleanCheckoutHead, fixture.sourceSha)
    assert.equal(result.input.sourceBinding.originMainAtCollection, fixture.sourceSha)
    assert.deepEqual(result.input.missionInput, { kind: 'inventory_at_least', item: 'oak_log', count: 1 })
    assert.deepEqual(result.input.fixture.initialPlayerPosition, START)
    assert.deepEqual(result.input.fixture.sourceOffsetFromInitialPlayer, { x: 6, y: 0, z: -3 })
    assert.equal(result.input.sliceMetrics.mechanicalMovementSteps, 1)
    assert.equal(result.input.sliceMetrics.jevDecisionFramesThroughInRangeDecision, 2)
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).sourceBinding.rawMoveStartPosition.x, 0.5)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('refuses reported starts, source pins, or raw task aliases that do not match run evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-legacy-baseline-reject-test-'))
  try {
    const fixture = setup(root)
    const summary = JSON.parse(readFileSync(fixture.summaryPath, 'utf8'))
    summary.fixture.initialPlayerPosition = { ...START, x: START.x + 1 }
    writeJson(fixture.summaryPath, summary)
    assert.throws(() => collectVtrReachLegacyBaseline({ legacyArchive: fixture.archive, repoPath: fixture.repo, vtrProbePath: fixture.probePath, outputPath: join(root, 'wrong-start.json') }), /summary fixture start differs from the raw MOVE start/)

    const second = setup(join(root, 'source-change'))
    execFileSync('git', ['-C', second.repo, 'commit', '--allow-empty', '-q', '-m', 'advance checkout'])
    execFileSync('git', ['-C', second.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD^'])
    assert.throws(() => collectVtrReachLegacyBaseline({ legacyArchive: second.archive, repoPath: second.repo, vtrProbePath: second.probePath, outputPath: join(root, 'wrong-source.json') }), /not exact origin\/main/)

    const third = setup(join(root, 'generic-alias'))
    const taskPath = join(third.archive, 'runner/human-task-input.jsonl')
    writeFileSync(taskPath, `${JSON.stringify({ event: 'chat_sent_after_intent_listener_ready', at: t(1.5), command: 'agent AI_Buddy collect log 1' })}\n`)
    assert.throws(() => collectVtrReachLegacyBaseline({ legacyArchive: third.archive, repoPath: third.repo, vtrProbePath: third.probePath, outputPath: join(root, 'alias.json') }), /does not agree with its reported task count|does not name the exact raw resource witness/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('measures nonzero legacy provider calls from raw Jev responses while no-network applies only to VTR', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-legacy-provider-test-'))
  try {
    const fixture = setup(root)
    const callsPath = join(fixture.archive, 'runner/runtime/logs/jev/jev-calls.jsonl')
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    for (const row of calls) {
      row.policy = 'typesafe'
      row.model = 'typesafe-ai/jev'
      row.response = { model: 'typesafe-ai/jev', usage: { totalTokens: 42 }, answers: {} }
      row.error = null
      row.latencyMs = 35
    }
    writeFileSync(callsPath, `${calls.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const summary = JSON.parse(readFileSync(fixture.summaryPath, 'utf8'))
    summary.sliceMetrics.jevProviderModelCalls = 2
    summary.sliceMetrics.networkModelCalls = 2
    summary.sliceMetrics.modelCallsPerMechanicalStep = 2
    writeJson(fixture.summaryPath, summary)

    const inspected = inspectLegacyReachArchive(fixture.archive)
    assert.equal(inspected.measured.jevProviderModelCalls, 2)
    assert.equal(inspected.measured.networkModelCalls, 2)
    assert.equal(inspected.measured.modelCallsPerMovementStep, 2)
    const output = join(root, 'collected', 'legacy-input.json')
    const result = collectVtrReachLegacyBaseline({ legacyArchive: fixture.archive, repoPath: fixture.repo, vtrProbePath: fixture.probePath, outputPath: output })
    assert.equal(result.input.sliceMetrics.jevProviderModelCalls, 2)
    assert.equal(result.input.sliceMetrics.networkModelCalls, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('counts raw System2 provider attempts and refuses zero counters contradicted by provider responses', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-legacy-system2-provider-test-'))
  try {
    const fixture = setup(root)
    const system2Path = join(fixture.archive, 'runner/runtime/logs/jev/system2.jsonl')
    const runPath = join(fixture.archive, 'runner/runtime/logs/jev/run.jsonl')
    const runRows = readFileSync(runPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    runRows[0].message = 'jev-agent started policy=fallback provider=deterministic model=deterministic-local-fallback system2Provider=vercel-ai-gateway system2Model=provider/repair-model'
    runRows[0].detail.system2Provider = 'vercel-ai-gateway'
    runRows[0].detail.system2Model = 'provider/repair-model'
    writeFileSync(runPath, `${runRows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const summary = JSON.parse(readFileSync(fixture.summaryPath, 'utf8'))
    const plan = { record: 'system2-plan', ts: t(6.5), provider: 'vercel-ai-gateway', model: 'provider/repair-model',
      providerEvaluateAttempts: 2, returnedGoals: [] }
    writeFileSync(system2Path, `${JSON.stringify(plan)}\n`)
    summary.sliceMetrics.system2LlmCalls = 2
    summary.sliceMetrics.networkModelCalls = 2
    summary.sliceMetrics.modelCallsPerMechanicalStep = 2
    writeJson(fixture.summaryPath, summary)
    assert.equal(inspectLegacyReachArchive(fixture.archive).measured.system2ModelCalls, 2)

    plan.providerEvaluateAttempts = 0
    writeFileSync(system2Path, `${JSON.stringify(plan)}\n`)
    summary.sliceMetrics.system2LlmCalls = 0
    summary.sliceMetrics.networkModelCalls = 0
    summary.sliceMetrics.modelCallsPerMechanicalStep = 0
    writeJson(fixture.summaryPath, summary)
    assert.throws(() => inspectLegacyReachArchive(fixture.archive), /zero provider attempts despite raw provider\/model response evidence/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects provider-call summaries that contradict raw Jev activity and unknown nonfallback calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'vtr-legacy-provider-reject-test-'))
  try {
    const fixture = setup(root)
    const callsPath = join(fixture.archive, 'runner/runtime/logs/jev/jev-calls.jsonl')
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    calls[0].policy = 'typesafe'
    calls[0].model = 'typesafe-ai/jev'
    calls[0].response = null
    calls[0].error = 'request failed with unclassified error'
    calls[0].latencyMs = 35
    writeFileSync(callsPath, `${calls.map((row) => JSON.stringify(row)).join('\n')}\n`)
    assert.throws(() => inspectLegacyReachArchive(fixture.archive), /does not establish whether a provider request occurred/)

    const contradictory = setup(join(root, 'zero-counter-contradiction'))
    const contradictoryCallsPath = join(contradictory.archive, 'runner/runtime/logs/jev/jev-calls.jsonl')
    const contradictoryCalls = readFileSync(contradictoryCallsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    contradictoryCalls[0].policy = 'typesafe'
    contradictoryCalls[0].model = 'typesafe-ai/jev'
    contradictoryCalls[0].providerAttempts = 0
    contradictoryCalls[0].response = { model: 'typesafe-ai/jev', usage: { totalTokens: 42 } }
    contradictoryCalls[0].error = null
    writeFileSync(contradictoryCallsPath, `${contradictoryCalls.map((row) => JSON.stringify(row)).join('\n')}\n`)
    assert.throws(() => inspectLegacyReachArchive(contradictory.archive), /zero provider attempts despite raw provider activity/)

    const contradicted = setup(join(root, 'summary-mismatch'))
    const changed = JSON.parse(readFileSync(contradicted.summaryPath, 'utf8'))
    changed.sliceMetrics.jevProviderModelCalls = 1
    changed.sliceMetrics.networkModelCalls = 1
    changed.sliceMetrics.modelCallsPerMechanicalStep = 1
    writeJson(contradicted.summaryPath, changed)
    assert.throws(() => inspectLegacyReachArchive(contradicted.archive), /derive jevProviderModelCalls=0, contradicting the run summary 1/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
