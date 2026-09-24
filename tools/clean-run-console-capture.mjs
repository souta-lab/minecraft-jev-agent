#!/usr/bin/env bun
// Issue only read-only seed/gamerule queries to the exact Leaf process started
// by clean-run-server-launch.mjs. Responses are sliced from that process's
// private stdout log and bound to the resident BOOT run/source.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { scanRunLines } from './m2-gate.mjs'
import { canonicalGameruleKey, consoleGameruleEvidenceSet } from './clean-run-environment.mjs'
import { sha256Text } from './clean-run-server-config.mjs'

const SHA_RE = /^[a-f0-9]{40}$/i
const RUN_ID_RE = /^run-[A-Za-z0-9-]+$/

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseArgs(argv) {
  const options = { descriptor: null, attestation: null, residentLog: null, runId: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--environment') options.descriptor = argv[++index] ?? null
    else if (arg === '--attestation') options.attestation = argv[++index] ?? null
    else if (arg === '--resident-log') options.residentLog = argv[++index] ?? null
    else if (arg === '--run') options.runId = argv[++index] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  if ([options.descriptor, options.attestation, options.residentLog, options.runId].some((value) => value === null)) {
    throw new Error('environment, attestation, resident-log, and run are required')
  }
  return options
}

export function expectedConsoleQueries(descriptor) {
  const rules = descriptor?.values?.gamerules
  const dimensions = descriptor?.cleanRun?.gameruleScope?.dimensions
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !Array.isArray(dimensions) || dimensions.length === 0) {
    throw new Error('descriptor does not declare gamerules and a per-dimension scope')
  }
  const evidenceSet = consoleGameruleEvidenceSet(descriptor)
  if (evidenceSet.invalidExclusions.length > 0) throw new Error(`invalid console gamerule exclusions: ${evidenceSet.invalidExclusions.join('; ')}`)
  const exclusions = new Set(Object.keys(evidenceSet.excluded))
  const queries = []
  for (const dimension of dimensions) {
    if (typeof dimension !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(dimension)) throw new Error('descriptor dimension is invalid')
    for (const [rule, expected] of Object.entries(evidenceSet.selected)) {
      if (exclusions.has(rule)) continue
      if (!/^[a-z0-9_]+$/.test(rule)) throw new Error(`descriptor gamerule id is invalid for console query: ${rule}`)
      const canonical = canonicalGameruleKey(rule)
      const command = `execute in ${dimension} run gamerule ${rule}`
      queries.push({ kind: 'gamerule', dimension, rule: canonical, descriptorRule: rule, expected, command })
    }
  }
  return { exclusions: [...exclusions], queries }
}

function parseValue(value) {
  const text = String(value).trim().replace(/^[."']+|[."']+$/g, '').trim()
  if (/^true$/i.test(text)) return true
  if (/^false$/i.test(text)) return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(text)) return text
  return undefined
}

export function parseGameruleConsoleResponse(line) {
  const match = /(?:\b(?:game\s*rule|gamerule)\s+)?['"]?([A-Za-z][A-Za-z0-9_:-]*)['"]?\s*(?:=|:|is currently set to:)\s*(.*?)\s*$/i.exec(String(line).trim())
  if (match === null) return null
  const value = parseValue(match[2])
  if (value === undefined) return null
  return { rule: canonicalGameruleKey(match[1]), value }
}

export function parseSeedConsoleResponse(line) {
  const text = String(line).trim()
  const match = /(?:^|\b)Seed:\s*\[?(-?\d+)\]?\s*$/i.exec(text)
  if (match === null) return null
  return { seed: match[1] }
}

function extractResponses(bytes, offset, query) {
  if (bytes.length < offset) throw new Error('Leaf stdout log was truncated after startup')
  const suffix = bytes.subarray(offset)
  const text = suffix.toString('utf8')
  let charOffset = 0
  const responses = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      if (query.kind === 'seed') {
        const parsed = parseSeedConsoleResponse(trimmed)
        if (parsed !== null) {
          const byteStart = offset + Buffer.byteLength(text.slice(0, charOffset), 'utf8')
          responses.push({ value: parsed.seed, line: trimmed, byteStart, byteEnd: byteStart + Buffer.byteLength(line, 'utf8') })
        }
      } else {
        const parsed = parseGameruleConsoleResponse(trimmed)
        if (parsed !== null && parsed.rule === query.rule) {
          const byteStart = offset + Buffer.byteLength(text.slice(0, charOffset), 'utf8')
          responses.push({ value: parsed.value, line: trimmed, byteStart, byteEnd: byteStart + Buffer.byteLength(line, 'utf8') })
        }
      }
    }
    charOffset += line.length + 1
  }
  return responses
}

export async function collectConsoleQueries({ queries, seed, issueCommandAndCapture }) {
  const seedResponse = await issueCommandAndCapture({ kind: 'seed', command: 'seed' })
  if (String(seedResponse.value) !== String(seed)) throw new Error('Leaf seed query does not match the descriptor seed')
  const responses = []
  for (const query of queries) {
    const response = await issueCommandAndCapture(query)
    const expected = typeof query.expected === 'string' ? String(query.expected) : query.expected
    const observed = typeof query.expected === 'string' ? String(response.value) : response.value
    if (observed !== expected) throw new Error(`Leaf gamerule response contradicts descriptor for ${query.dimension}/${query.rule}`)
    responses.push({ ...query, response })
  }
  return { seed: seedResponse, responses }
}

function validateLaunchBinding({ descriptorPath, descriptorText, descriptor, attestationPath, attestationText, attestation, runId, residentLogPath, residentLogText }) {
  if (!RUN_ID_RE.test(runId)) throw new Error('run id is invalid')
  if (attestation?.record !== 'clean-run-leaf-startup-attestation' || attestation.schemaVersion !== 1) throw new Error('Leaf startup attestation is missing or invalid')
  const descriptorSha256 = sha256Text(descriptorText)
  const descriptorMeta = attestation.descriptor ?? {}
  if (
    resolve(String(descriptorMeta.path ?? '')) !== resolve(descriptorPath) || descriptorMeta.sha256 !== descriptorSha256 ||
    descriptorMeta.sourceSha !== descriptor?.values?.sourceSha || !SHA_RE.test(String(descriptorMeta.sourceSha ?? ''))
  ) throw new Error('Leaf startup attestation does not bind the current descriptor and source SHA')
  const attestationSha256 = sha256Text(attestationText)
  const processInfo = attestation.process ?? {}
  const consoleInfo = attestation.console ?? {}
  const consoleDir = resolve(dirname(attestationPath), 'server-console')
  const fifoPath = resolve(String(consoleInfo.inputPath ?? ''))
  const stdoutLogPath = resolve(String(consoleInfo.stdoutLogPath ?? ''))
  const commandTranscriptPath = resolve(String(consoleInfo.commandTranscriptPath ?? ''))
  const capturePath = resolve(String(consoleInfo.capturePath ?? ''))
  if (
    consoleInfo.mode !== 'run-private-fifo-and-log' || fifoPath !== resolve(consoleDir, 'server-console.fifo') ||
    stdoutLogPath !== resolve(consoleDir, 'leaf-server.log') || commandTranscriptPath !== resolve(consoleDir, 'commands.jsonl') ||
    capturePath !== resolve(consoleDir, 'capture.json')
  ) throw new Error('Leaf console paths are not bound to the private run directory')
  const dirStat = lstatSync(consoleDir)
  const fifoStat = lstatSync(fifoPath)
  const outputStat = lstatSync(stdoutLogPath)
  if (
    !dirStat.isDirectory() || dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o777) !== 0o700 ||
    !fifoStat.isFIFO() || fifoStat.uid !== process.getuid?.() || (fifoStat.mode & 0o777) !== 0o600 ||
    !outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.uid !== process.getuid?.() || (outputStat.mode & 0o777) !== 0o600
  ) throw new Error('Leaf console objects are not private owner-only files')
  if (!Number.isInteger(processInfo.pid) || processInfo.pid < 1 || !/^[a-f0-9]{64}$/.test(String(processInfo.commandLineSha256 ?? ''))) {
    throw new Error('Leaf process identity is missing from startup attestation')
  }
  const currentCmdline = readFileSync(`/proc/${processInfo.pid}/cmdline`)
  const cmdArgs = currentCmdline.toString('utf8').split('\0').filter(Boolean)
  if (cmdArgs.length < 2 || sha256Bytes(Buffer.from(cmdArgs.join('\0'))) !== processInfo.commandLineSha256) {
    throw new Error('Leaf process command line no longer matches startup attestation')
  }
  const runWindow = scanRunLines(runId, residentLogText.split(/\r?\n/))
  if (runWindow.status !== 'valid' || runWindow.sourceSha !== descriptorMeta.sourceSha) {
    throw new Error('resident BOOT run/source boundary does not bind this console capture')
  }
  return {
    descriptorSha256,
    attestationSha256,
    sourceSha: descriptorMeta.sourceSha,
    runId,
    processInfo,
    fifoPath,
    stdoutLogPath,
    commandTranscriptPath,
    capturePath,
    residentLogPath: resolve(residentLogPath),
  }
}

function appendOwnerOnlyJsonLine(path, object) {
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(object)}\n`, 'utf8')
  } finally {
    // fsync is intentionally used for the command/response journal before the
    // next console line is sent.
    fsyncSync(fd)
    closeSync(fd)
  }
  chmodSync(path, 0o600)
}

function atomicWrite(path, text) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

function gameruleTranscript({ descriptor, runId, sourceSha, descriptorSha256, seed, responses, capturedAt }) {
  const lines = [
    'record=m3-clean-gamerule-verification',
    'schemaVersion=1',
    `runId=${runId}`,
    `descriptorSha256=${descriptorSha256}`,
    `levelName=${descriptor.values.levelName}`,
    `seed=${seed}`,
    `sourceSha=${sourceSha}`,
    `capturedAt=${capturedAt}`,
  ]
  const byDimension = new Map()
  for (const { dimension, rule, response } of responses) {
    if (!byDimension.has(dimension)) byDimension.set(dimension, [])
    const responseParsed = parseGameruleConsoleResponse(response.line)
    if (responseParsed === null || responseParsed.rule !== rule) throw new Error(`captured response cannot be parsed for ${dimension}/${rule}`)
    byDimension.get(dimension).push(response.line)
  }
  for (const dimension of descriptor.cleanRun.gameruleScope.dimensions) {
    lines.push('', `[dimension=${dimension}]`, ...(byDimension.get(dimension) ?? []))
  }
  return `${lines.join('\n')}\n`
}

export async function runConsoleCapture({ descriptorPath, attestationPath, residentLogPath, runId }) {
  const resolvedDescriptor = resolve(descriptorPath)
  const resolvedAttestation = resolve(attestationPath)
  const descriptorText = readFileSync(resolvedDescriptor, 'utf8')
  const descriptor = JSON.parse(descriptorText)
  const attestationText = readFileSync(resolvedAttestation, 'utf8')
  const attestation = JSON.parse(attestationText)
  const residentLogText = readFileSync(residentLogPath, 'utf8')
  const binding = validateLaunchBinding({
    descriptorPath: resolvedDescriptor,
    descriptorText,
    descriptor,
    attestationPath: resolvedAttestation,
    attestationText,
    attestation,
    runId,
    residentLogPath,
    residentLogText,
  })
  const { exclusions, queries } = expectedConsoleQueries(descriptor)
  const transcriptPath = resolve(dirname(resolvedDescriptor), 'gamerule-verification.txt')
  const capturePath = binding.capturePath
  const commandTranscriptPath = binding.commandTranscriptPath
  if (existsSync(capturePath) || existsSync(commandTranscriptPath)) throw new Error('a console capture already exists for this run; refusing to mix attempts')
  const existingTranscript = readFileSync(transcriptPath, 'utf8')
  if (!existingTranscript.includes('runId=<fill-after-BOOT>')) throw new Error('gamerule verification file is not the untouched prepare template')
  const serverLogPath = binding.stdoutLogPath
  const serverLogStat = lstatSync(serverLogPath)
  if (!serverLogStat.isFile()) throw new Error('Leaf stdout capture is not a regular file')

  const issueCommandAndCapture = async (query) => {
    const command = query.command
    // This helper generates every command itself from read-only query forms.
    // There is no command argument from the caller, so /give, /tp, gamerule
    // setters, difficulty changes, and arbitrary console input cannot enter.
    if (query.kind === 'seed' && command !== 'seed') throw new Error('invalid seed query')
    if (query.kind === 'gamerule' && !/^execute in minecraft:[a-z0-9_]+ run gamerule [a-z0-9_]+$/.test(command)) throw new Error('invalid gamerule query')
    const before = readFileSync(serverLogPath)
    const offset = before.length
    const attempt = {
      event: 'console-query-attempt',
      kind: query.kind,
      runId,
      sourceSha: binding.sourceSha,
      descriptorSha256: binding.descriptorSha256,
      startupAttestationSha256: binding.attestationSha256,
      leafPid: binding.processInfo.pid,
      command,
      dimension: query.dimension ?? null,
      rule: query.rule ?? null,
      descriptorRule: query.descriptorRule ?? null,
      stdoutLogPath: serverLogPath,
      byteOffsetBefore: offset,
      at: new Date().toISOString(),
    }
    appendOwnerOnlyJsonLine(commandTranscriptPath, attempt)
    const fifoFd = openSync(binding.fifoPath, constants.O_WRONLY)
    try {
      writeFileSync(fifoFd, `${command}\n`, 'utf8')
    } finally {
      closeSync(fifoFd)
    }
    const deadline = Date.now() + 5000
    let response = null
    let currentBytes = null
    while (Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      currentBytes = readFileSync(serverLogPath)
      const responseRows = extractResponses(currentBytes, offset, query)
      if (responseRows.length > 1) throw new Error(`Leaf returned ambiguous duplicate responses for ${query.kind === 'seed' ? 'seed' : `${query.dimension}/${query.rule}`}`)
      response = responseRows[0] ?? null
      if (response !== null) break
    }
    if (response === null || currentBytes === null) {
      appendOwnerOnlyJsonLine(commandTranscriptPath, {
        ...attempt,
        event: 'console-query-response-missing',
        completedAt: new Date().toISOString(),
      })
      throw new Error(`Leaf did not return a verifiable response for ${query.kind === 'seed' ? 'seed' : `${query.dimension}/${query.rule}`}`)
    }
    // Let the current command finish logging before assigning its response
    // range. A duplicated response is ambiguous and therefore refused.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    currentBytes = readFileSync(serverLogPath)
    const responseRows = extractResponses(currentBytes, offset, query)
    if (responseRows.length !== 1 || responseRows[0].line !== response.line) throw new Error('Leaf response was missing or ambiguous while capturing')
    const responseBytes = currentBytes.subarray(response.byteStart, response.byteEnd)
    const completed = {
      ...attempt,
      event: 'console-query-response',
      completedAt: new Date().toISOString(),
      value: response.value,
      responseLine: response.line,
      byteStart: response.byteStart,
      byteEnd: response.byteEnd,
      responseLineSha256: sha256Bytes(responseBytes),
    }
    appendOwnerOnlyJsonLine(commandTranscriptPath, completed)
    return {
      value: response.value,
      line: response.line,
      byteStart: response.byteStart,
      byteEnd: response.byteEnd,
      lineSha256: completed.responseLineSha256,
      command,
    }
  }

  const { seed, responses } = await collectConsoleQueries({
    queries,
    seed: descriptor.values.levelSeed,
    issueCommandAndCapture,
  })
  const capturedAt = new Date().toISOString()
  const text = gameruleTranscript({
    descriptor,
    runId,
    sourceSha: binding.sourceSha,
    descriptorSha256: binding.descriptorSha256,
    seed: String(seed.value),
    responses,
    capturedAt,
  })
  const transcriptSha256 = sha256Text(text)
  const capture = {
    record: 'clean-run-console-capture',
    schemaVersion: 1,
    status: 'complete',
    runId,
    sourceSha: binding.sourceSha,
    descriptor: { path: resolvedDescriptor, sha256: binding.descriptorSha256 },
    startupAttestation: { path: resolvedAttestation, sha256: binding.attestationSha256 },
    process: { pid: binding.processInfo.pid, commandLineSha256: binding.processInfo.commandLineSha256 },
    residentLog: { path: binding.residentLogPath, sourceSha: binding.sourceSha },
    capturePath: capturePath,
    console: { directory: dirname(binding.fifoPath), fifoPath: binding.fifoPath, stdoutLogPath: serverLogPath, commandTranscriptPath },
    commandTranscript: { path: commandTranscriptPath, sha256: sha256Text(readFileSync(commandTranscriptPath, 'utf8')), queryCount: responses.length + 1 },
    seed: { value: String(seed.value), line: seed.line, byteStart: seed.byteStart, byteEnd: seed.byteEnd, lineSha256: seed.lineSha256 },
    requiredDimensions: descriptor.cleanRun.gameruleScope.dimensions,
    observedRuleCount: responses.length,
    excludedRules: exclusions,
    responses: responses.map(({ dimension, rule, descriptorRule, expected, command, response }) => ({
      dimension, rule, descriptorRule, expected, command,
      value: response.value,
      line: response.line,
      byteStart: response.byteStart,
      byteEnd: response.byteEnd,
      lineSha256: response.lineSha256,
    })),
    transcript: { path: transcriptPath, sha256: transcriptSha256 },
    capturedAt,
  }
  atomicWrite(transcriptPath, text)
  atomicWrite(capturePath, `${JSON.stringify(capture, null, 2)}\n`)
  process.stdout.write(`CLEAN_RUN_CONSOLE_CAPTURE status=complete runId=${runId} rules=${responses.length} dimensions=${descriptor.cleanRun.gameruleScope.dimensions.length} capture=${capturePath}\n`)
  return capture
}

if (import.meta.main) {
  try {
    const result = await runConsoleCapture(parseArgs(process.argv.slice(2)))
    process.stdout.write(`CLEAN_RUN_CONSOLE_CAPTURE_SHA256 sha256=${sha256Text(`${JSON.stringify(result, null, 2)}\n`)}\n`)
  } catch (error) {
    process.stderr.write(`CLEAN_RUN_CONSOLE_CAPTURE status=UNKNOWN reason=${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
