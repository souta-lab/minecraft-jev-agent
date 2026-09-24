#!/usr/bin/env bun
// Offline contract tests for descriptor-driven, read-only Leaf console capture.
// Synthetic stdout bytes are fixtures only; they are never live evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { checkConsoleGameruleEvidence, consoleGameruleEvidenceSet } from './clean-run-environment.mjs'
import { collectConsoleQueries, expectedConsoleQueries } from './clean-run-console-capture.mjs'
import { sha256Text } from './clean-run-server-config.mjs'

const TEMPLATE = new URL('./fixtures/m3-clean-environment.json', import.meta.url)
const RUN_ID = 'run-console-capture-fixture'
const SOURCE_SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const temporaryRoot = mkdtempSync(join(tmpdir(), 'clean-run-console-capture-'))
const descriptor = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
descriptor.values.levelName = 'm3clean-console-fixture'
descriptor.values.levelSeed = '-4187923615481'
descriptor.values.sourceSha = SOURCE_SHA
descriptor.cleanRun.sourceSha.state = 'FROZEN'
const descriptorPath = resolve(join(temporaryRoot, 'environment-resolved.json'))
const descriptorText = `${JSON.stringify(descriptor, null, 2)}\n`
const descriptorSha256 = sha256Text(descriptorText)
const serverConsoleDir = join(temporaryRoot, 'server-console')
const transcriptPath = join(temporaryRoot, 'gamerule-verification.txt')
const capturePath = join(serverConsoleDir, 'capture.json')
const journalPath = join(serverConsoleDir, 'commands.jsonl')
const leafLogPath = join(serverConsoleDir, 'leaf-server.log')
const startupPath = join(temporaryRoot, 'server-start-attestation.json')
const startupSha256 = 'c'.repeat(64)
const commandLineSha256 = 'd'.repeat(64)
const PID = 4321
const startup = {
  status: 'verified',
  runId: RUN_ID,
  bootSourceSha: SOURCE_SHA,
  descriptorPath,
  descriptorSha256,
  attestationPath: startupPath,
  attestationSha256: startupSha256,
  process: { pid: PID, commandLineSha256 },
}
const artifact = {
  record: 'milestone-run-artifact',
  runId: RUN_ID,
  run: { runId: RUN_ID, boot: { sourceSha: SOURCE_SHA, ts: '2026-09-24T00:00:00.000Z', cleanRunServerConfig: startup } },
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function makeMachineEvidence({ omitCaptureResponse = false, tamperOutput = false, injectMutatingCommand = false } = {}) {
  const { selected, excluded } = consoleGameruleEvidenceSet(descriptor)
  const dimensions = descriptor.cleanRun.gameruleScope.dimensions
  const { queries } = expectedConsoleQueries(descriptor)
  let serverLog = Buffer.alloc(0)
  const addLine = (line) => {
    const bytes = Buffer.from(line, 'utf8')
    const byteStart = serverLog.length
    serverLog = Buffer.concat([serverLog, bytes, Buffer.from('\n')])
    return { line, byteStart, byteEnd: byteStart + bytes.length, lineSha256: hashBytes(bytes) }
  }
  const seedResponse = addLine(`[Server thread/INFO]: Seed: [${descriptor.values.levelSeed}]`)
  const seed = { value: String(descriptor.values.levelSeed), ...seedResponse }
  const responses = []
  const commands = []

  const recordQuery = (query, response) => {
    const base = {
      runId: RUN_ID,
      sourceSha: SOURCE_SHA,
      descriptorSha256,
      startupAttestationSha256: startupSha256,
      leafPid: PID,
      kind: query.kind,
      command: query.command,
      dimension: query.dimension ?? null,
      rule: query.rule ?? null,
      descriptorRule: query.descriptorRule ?? null,
    }
    commands.push({ ...base, event: 'console-query-attempt', at: '2026-09-24T00:00:01.000Z' })
    commands.push({
      ...base,
      event: 'console-query-response',
      value: response.value,
      responseLine: response.line,
      byteStart: response.byteStart,
      byteEnd: response.byteEnd,
      responseLineSha256: response.lineSha256,
      completedAt: '2026-09-24T00:00:02.000Z',
    })
  }
  recordQuery({ kind: 'seed', command: 'seed' }, { ...seed, command: 'seed' })

  for (const query of queries) {
    const line = `[Server thread/INFO]: Gamerule ${query.descriptorRule} is currently set to: ${String(query.expected)}`
    const response = { value: query.expected, ...addLine(line), command: query.command }
    responses.push({
      dimension: query.dimension,
      rule: query.rule,
      descriptorRule: query.descriptorRule,
      expected: query.expected,
      command: query.command,
      ...response,
    })
    recordQuery(query, response)
  }

  const capturedResponses = omitCaptureResponse ? responses.slice(1) : responses
  let commandRows = commands
  if (injectMutatingCommand) {
    commandRows = [...commands, {
      runId: RUN_ID,
      sourceSha: SOURCE_SHA,
      descriptorSha256,
      startupAttestationSha256: startupSha256,
      leafPid: PID,
      kind: 'mutating',
      event: 'console-query-attempt',
      command: 'give @s diamond',
    }]
  }
  const commandJournalText = `${commandRows.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  const capturedAt = '2026-09-24T00:00:03.000Z'
  const metadata = [
    'record=m3-clean-gamerule-verification',
    'schemaVersion=1',
    `runId=${RUN_ID}`,
    `descriptorSha256=${descriptorSha256}`,
    `levelName=${descriptor.values.levelName}`,
    `seed=${descriptor.values.levelSeed}`,
    `sourceSha=${SOURCE_SHA}`,
    `capturedAt=${capturedAt}`,
  ]
  const transcriptLines = [...metadata]
  for (const dimension of dimensions) {
    transcriptLines.push('', `[dimension=${dimension}]`)
    for (const response of responses.filter((entry) => entry.dimension === dimension)) transcriptLines.push(response.line)
  }
  const transcriptText = `${transcriptLines.join('\n')}\n`
  const transcriptSha = sha256Text(transcriptText)
  const capture = {
    record: 'clean-run-console-capture',
    schemaVersion: 1,
    status: 'complete',
    runId: RUN_ID,
    sourceSha: SOURCE_SHA,
    descriptor: { path: descriptorPath, sha256: descriptorSha256 },
    startupAttestation: { path: startupPath, sha256: startupSha256 },
    process: { pid: PID, commandLineSha256 },
    residentLog: { path: join(temporaryRoot, 'buddy.log'), sourceSha: SOURCE_SHA },
    capturePath,
    console: { stdoutLogPath: leafLogPath },
    commandTranscript: { path: journalPath, sha256: sha256Text(commandJournalText), queryCount: responses.length + 1 },
    seed,
    requiredDimensions: dimensions,
    observedRuleCount: capturedResponses.length,
    excludedRules: Object.keys(excluded),
    responses: capturedResponses,
    transcript: { path: transcriptPath, sha256: transcriptSha },
    capturedAt,
  }
  let outputBuffer = serverLog
  if (tamperOutput) {
    outputBuffer = Buffer.from(serverLog)
    const offset = responses[0].byteStart
    outputBuffer[offset] = outputBuffer[offset] === 0x5b ? 0x58 : 0x5b
  }
  return {
    transcriptText,
    fileSha256: transcriptSha,
    capture,
    captureSha256: sha256Text(`${JSON.stringify(capture, null, 2)}\n`),
    commandJournalText,
    serverLogBuffer: outputBuffer,
  }
}

function evaluate(evidence) {
  return checkConsoleGameruleEvidence({
    descriptor,
    artifact,
    runId: RUN_ID,
    descriptorSha256,
    path: transcriptPath,
    text: evidence.transcriptText,
    fileSha256: evidence.fileSha256,
    capture: evidence.capture,
    captureSha256: evidence.captureSha256,
    commandJournalText: evidence.commandJournalText,
    serverLogBuffer: evidence.serverLogBuffer,
  })
}

try {
  const { selected, excluded } = consoleGameruleEvidenceSet(descriptor)
  const { queries, exclusions } = expectedConsoleQueries(descriptor)
  assert.equal(exclusions.length, Object.keys(excluded).length)
  assert.equal(queries.length, Object.keys(selected).length * descriptor.cleanRun.gameruleScope.dimensions.length)
  assert.equal(queries.some((query) => query.descriptorRule === 'max_minecart_speed'), false)
  assert.ok(queries.every((query) => /^execute in minecraft:[a-z0-9_]+ run gamerule [a-z0-9_]+$/.test(query.command)))

  const expected = new Map(queries.map((query) => [query.command, query.expected]))
  const collected = await collectConsoleQueries({
    queries,
    seed: descriptor.values.levelSeed,
    issueCommandAndCapture: async (query) => ({
      value: query.kind === 'seed' ? descriptor.values.levelSeed : expected.get(query.command),
      line: query.kind === 'seed' ? `Seed: [${descriptor.values.levelSeed}]` : `Gamerule ${query.descriptorRule} is currently set to: ${String(query.expected)}`,
    }),
  })
  assert.equal(collected.responses.length, queries.length)
  await assert.rejects(() => collectConsoleQueries({
    queries,
    seed: descriptor.values.levelSeed,
    issueCommandAndCapture: async () => ({ value: 'wrong', line: 'no answer' }),
  }), /seed query does not match/)

  const complete = makeMachineEvidence()
  const passed = evaluate(complete)
  assert.equal(passed.verdict, 'PASS', passed.reason)
  assert.equal(passed.detail.expectedRuleCount, Object.keys(selected).length)
  assert.deepEqual(passed.detail.excludedRuleEvidence, { max_minecart_speed: 'UNKNOWN:declared_not_registered_in_world' })

  const missing = checkConsoleGameruleEvidence({
    descriptor, artifact, runId: RUN_ID, descriptorSha256, path: transcriptPath,
    text: complete.transcriptText, fileSha256: complete.fileSha256,
  })
  assert.equal(missing.verdict, 'UNKNOWN', 'editable pasted output without machine capture must not PASS')

  const incomplete = evaluate(makeMachineEvidence({ omitCaptureResponse: true }))
  assert.equal(incomplete.verdict, 'FAIL')
  assert.match(incomplete.reason, /capture has .* responses/)

  const tampered = evaluate(makeMachineEvidence({ tamperOutput: true }))
  assert.equal(tampered.verdict, 'FAIL')
  assert.match(tampered.reason, /absent from Leaf stdout log/)

  const mutating = evaluate(makeMachineEvidence({ injectMutatingCommand: true }))
  assert.equal(mutating.verdict, 'FAIL')
  assert.match(mutating.reason, /non-query console command/)

  console.log(`PASS clean-run Leaf console capture (${queries.length} per-dimension gamerule queries, seed, output hashes, missing/mutating response refusals)`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
