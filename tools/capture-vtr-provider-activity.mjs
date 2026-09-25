#!/usr/bin/env bun
// Read-only coverage monitor for a single VTR live run. Start this before the
// resident, then send SIGINT after the run's terminal event and collector
// snapshot. It observes existing files only; it never creates provider logs.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROVIDER_CAPTURE_SCHEMA = 'vtr-provider-activity-capture/v1'
export const PROVIDER_JOURNALS = Object.freeze(['jev-calls', 'jev-decisions', 'system2-journal'])
const DEFAULT_MAX_POLL_GAP_MS = 5000
const MAX_HOST_LOG_DELTA_BYTES = 16 * 1024 * 1024
const MAX_PROVIDER_JOURNAL_BYTES = 128 * 1024 * 1024
const READ_ONLY_NOFOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
const SHA40_RE = /^[0-9a-f]{40}$/iu
const RUN_ID_RE = /^run-[a-z0-9]+-[a-z0-9]+$/iu

export function runtimePaths(runtimeDir) {
  const root = path.resolve(runtimeDir)
  const logDir = path.join(root, 'logs', 'jev')
  return {
    hostLog: path.join(root, 'buddy.log'),
    journals: {
      'jev-calls': path.join(logDir, 'jev-calls.jsonl'),
      'jev-decisions': path.join(logDir, 'jev-decisions.jsonl'),
      'system2-journal': path.join(logDir, 'system2.jsonl'),
    },
  }
}

function iso(value) {
  return new Date(value).toISOString()
}

function statRegular(pathname) {
  try {
    const stat = fs.lstatSync(pathname)
    if (stat.isSymbolicLink() || !stat.isFile()) return { invalid: true, stat: null }
    return { invalid: false, stat }
  } catch (error) {
    if (error?.code === 'ENOENT') return { invalid: false, stat: null }
    return { invalid: true, stat: null }
  }
}

function inodeOf(stat) {
  return `${stat.dev}:${stat.ino}`
}

function eventFromLine(line) {
  const match = /^\[([^\]]+)\]\s+([A-Z][A-Z0-9_]*)\b\s*(.*)$/u.exec(line)
  if (!match) return null
  const at = Date.parse(match[1])
  if (!Number.isFinite(at)) return null
  return { at, name: match[2], fields: match[3] }
}

function field(fields, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}=([^\\s]+)`, 'u').exec(fields)
  return match?.[1] ?? null
}

function bootWorldKey(fields) {
  const match = /(?:^|\s)worldKey=(\{[^\n]*?\})(?:\s|$)/u.exec(fields)
  if (!match) return null
  try {
    const value = JSON.parse(match[1])
    if (typeof value.serverId !== 'string' || !value.serverId
      || typeof value.dimension !== 'string' || !value.dimension
      || !Number.isSafeInteger(value.worldEpoch)) return null
    return `${value.serverId}|${value.dimension}|${value.worldEpoch}`
  } catch {
    return null
  }
}

function countJournalRecords(bytes) {
  if (!bytes || bytes.length === 0) return { rows: 0, malformedRows: 0 }
  const text = bytes.toString('utf8')
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '')
  let malformedRows = 0
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      if (row === null || typeof row !== 'object' || Array.isArray(row)) malformedRows += 1
    } catch {
      malformedRows += 1
    }
  }
  return { rows: lines.length, malformedRows }
}

function safeReadSnapshot(pathname) {
  const before = statRegular(pathname)
  if (before.invalid || !before.stat) return { ok: false, bytes: null, stat: before.stat, reason: before.invalid ? 'not-a-regular-file' : 'missing' }
  let fd
  try {
    fd = fs.openSync(pathname, READ_ONLY_NOFOLLOW)
    const descriptorBefore = fs.fstatSync(fd)
    if (!descriptorBefore.isFile() || inodeOf(descriptorBefore) !== inodeOf(before.stat)) {
      return { ok: false, bytes: null, stat: descriptorBefore, reason: 'replaced-before-final-read' }
    }
    if (descriptorBefore.size > MAX_PROVIDER_JOURNAL_BYTES) {
      return { ok: false, bytes: null, stat: descriptorBefore, reason: 'journal-exceeds-snapshot-limit' }
    }
    const bytes = Buffer.alloc(descriptorBefore.size)
    let readOffset = 0
    while (readOffset < bytes.length) {
      const read = fs.readSync(fd, bytes, readOffset, bytes.length - readOffset, readOffset)
      if (read === 0) break
      readOffset += read
    }
    const descriptorAfter = fs.fstatSync(fd)
    const after = statRegular(pathname)
    if (after.invalid || !after.stat || inodeOf(descriptorBefore) !== inodeOf(descriptorAfter)
      || inodeOf(descriptorAfter) !== inodeOf(after.stat) || descriptorBefore.size !== descriptorAfter.size
      || descriptorBefore.mtimeMs !== descriptorAfter.mtimeMs || bytes.length !== after.stat.size || readOffset !== bytes.length) {
      return { ok: false, bytes: null, stat: after.stat ?? descriptorAfter, reason: 'changed-during-final-read' }
    }
    return { ok: true, bytes, stat: after.stat, reason: null }
  } catch {
    return { ok: false, bytes: null, stat: null, reason: 'unreadable' }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Polling read-only monitor. `poll()` observes appended host records and file
 * metadata; `finish()` hashes actual current journal bytes and returns the v1
 * package contract. Callers must arm it before the resident starts.
 */
export class VtrProviderActivityWatch {
  constructor({ hostLog, journals, now = () => Date.now(), maxPollGapMs = DEFAULT_MAX_POLL_GAP_MS }) {
    if (typeof hostLog !== 'string' || !hostLog) throw new Error('hostLog is required')
    if (!journals || typeof journals !== 'object') throw new Error('journals map is required')
    for (const name of PROVIDER_JOURNALS) {
      if (typeof journals[name] !== 'string' || !journals[name]) throw new Error(`journal path is required: ${name}`)
    }
    this.hostLog = path.resolve(hostLog)
    this.journals = Object.fromEntries(PROVIDER_JOURNALS.map((name) => [name, path.resolve(journals[name])]))
    this.now = now
    this.maxPollGapMs = maxPollGapMs
    this.startedAtMs = now()
    this.startedAt = iso(this.startedAtMs)
    this.lastPollAtMs = this.startedAtMs
    this.maxObservedPollGapMs = 0
    this.problems = []
    this.hostLineBuffer = ''
    const initialHost = statRegular(this.hostLog)
    this.hostOffset = initialHost.stat?.size ?? 0
    this.hostInode = initialHost.stat ? inodeOf(initialHost.stat) : null
    if (initialHost.invalid) this.problem('host-log-not-regular-at-arm')
    this.boundaries = { bootAt: null, generationReadyAt: null, terminalAt: null }
    this.identity = null
    this.bootCount = 0
    this.generationReadyCount = 0
    this.terminalCount = 0
    this.journalState = Object.fromEntries(PROVIDER_JOURNALS.map((name) => [name, {
      path: this.journals[name], firstObservedAt: null, initializedAt: null,
      lastObservedAt: null, inode: null, previousSize: null,
      missingAfterSeen: false, replaced: false, truncated: false, invalid: false,
      nonEmptyObserved: false,
    }]))
    this.finished = false
    this.poll(this.startedAtMs)
  }

  problem(code) {
    if (!this.problems.includes(code)) this.problems.push(code)
  }

  poll(atMs = this.now()) {
    if (this.finished) throw new Error('provider activity watch is already finished')
    if (!Number.isFinite(atMs) || atMs < this.lastPollAtMs) {
      this.problem('non-monotonic-watch-clock')
      atMs = this.lastPollAtMs
    }
    const gap = atMs - this.lastPollAtMs
    this.maxObservedPollGapMs = Math.max(this.maxObservedPollGapMs, gap)
    if (gap > this.maxPollGapMs) this.problem('polling-coverage-gap')
    this.lastPollAtMs = atMs
    this.readHostAppend()
    for (const name of PROVIDER_JOURNALS) this.observeJournal(name, atMs)
  }

  readHostAppend() {
    const current = statRegular(this.hostLog)
    if (current.invalid) {
      this.problem('host-log-not-regular')
      return
    }
    if (!current.stat) return
    const inode = inodeOf(current.stat)
    if (this.hostInode !== null && inode !== this.hostInode) {
      this.problem('host-log-replaced')
      this.hostOffset = 0
      this.hostLineBuffer = ''
    }
    if (this.hostInode === null) this.hostInode = inode
    if (current.stat.size < this.hostOffset) {
      this.problem('host-log-truncated')
      this.hostOffset = 0
      this.hostLineBuffer = ''
    }
    const delta = current.stat.size - this.hostOffset
    if (delta <= 0) return
    if (delta > MAX_HOST_LOG_DELTA_BYTES) {
      this.problem('host-log-read-gap-too-large')
      this.hostOffset = current.stat.size
      this.hostLineBuffer = ''
      return
    }
    let fd
    try {
      fd = fs.openSync(this.hostLog, READ_ONLY_NOFOLLOW)
      const opened = fs.fstatSync(fd)
      if (!opened.isFile() || inodeOf(opened) !== inode) {
        this.problem('host-log-replaced-during-read')
        return
      }
      const bytes = Buffer.alloc(delta)
      const read = fs.readSync(fd, bytes, 0, delta, this.hostOffset)
      this.hostOffset += read
      const text = bytes.subarray(0, read).toString('utf8')
      const lines = (this.hostLineBuffer + text).split('\n')
      this.hostLineBuffer = lines.pop() ?? ''
      for (const raw of lines) this.observeHostLine(raw.replace(/\r$/u, ''))
    } catch {
      this.problem('host-log-read-error')
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  observeHostLine(line) {
    const event = eventFromLine(line)
    if (!event) return
    const runId = field(event.fields, 'runId')
    if (event.name === 'BOOT') {
      this.bootCount += 1
      const sourceSha = field(event.fields, 'sourceSha') ?? field(event.fields, 'source')
      const worldKey = bootWorldKey(event.fields)
      if (this.bootCount > 1) this.problem('multiple-boot-boundaries')
      if (!RUN_ID_RE.test(runId ?? '') || !SHA40_RE.test(sourceSha ?? '') || !worldKey) {
        this.problem('boot-identity-incomplete')
        return
      }
      if (this.identity !== null) this.problem('multiple-run-identities')
      this.identity = { sourceSha: sourceSha.toLowerCase(), runId, generationId: null, worldKey }
      this.boundaries.bootAt = iso(event.at)
      if (event.at < this.startedAtMs) this.problem('boot-before-watch-armed')
      return
    }
    if (!this.identity || runId !== this.identity.runId) return
    if (event.name === 'GENERATION_READY') {
      this.generationReadyCount += 1
      const generationId = field(event.fields, 'generationId') ?? field(event.fields, 'id')
      const sourceSha = field(event.fields, 'sourceSha') ?? field(event.fields, 'source')
      if (this.generationReadyCount > 1) this.problem('multiple-generation-ready-boundaries')
      if (!generationId || !SHA40_RE.test(sourceSha ?? '')) {
        this.problem('generation-ready-identity-incomplete')
        return
      }
      if (sourceSha.toLowerCase() !== this.identity.sourceSha) this.problem('generation-source-mismatch')
      if (this.identity.generationId !== null && this.identity.generationId !== generationId) this.problem('generation-identity-changed')
      this.identity.generationId = generationId
      this.boundaries.generationReadyAt = iso(event.at)
      if (this.boundaries.bootAt && event.at < Date.parse(this.boundaries.bootAt)) this.problem('generation-ready-before-boot')
      return
    }
    if (event.name === 'VTR_TRANSITION_OUTCOME') {
      const generationId = field(event.fields, 'generationId')
      const sourceSha = field(event.fields, 'sourceSha')
      if (!generationId || !sourceSha) {
        this.problem('terminal-identity-incomplete')
        return
      }
      if (generationId !== this.identity.generationId || sourceSha.toLowerCase() !== this.identity.sourceSha) return
      this.terminalCount += 1
      if (this.terminalCount > 1) this.problem('multiple-transition-terminals')
      this.boundaries.terminalAt = iso(event.at)
      if (this.boundaries.generationReadyAt && event.at < Date.parse(this.boundaries.generationReadyAt)) this.problem('terminal-before-generation-ready')
    }
  }

  observeJournal(name, atMs) {
    const state = this.journalState[name]
    const observed = statRegular(state.path)
    if (observed.invalid) {
      state.invalid = true
      this.problem(`journal-not-regular:${name}`)
      return
    }
    if (!observed.stat) {
      if (state.inode !== null) {
        state.missingAfterSeen = true
        this.problem(`journal-disappeared:${name}`)
      }
      return
    }
    const inode = inodeOf(observed.stat)
    if (state.firstObservedAt === null) {
      state.firstObservedAt = iso(atMs)
      state.initializedAt = iso(atMs)
      state.inode = inode
    } else if (state.inode !== inode) {
      state.replaced = true
      this.problem(`journal-replaced:${name}`)
    }
    if (state.previousSize !== null && observed.stat.size < state.previousSize) {
      state.truncated = true
      this.problem(`journal-truncated:${name}`)
    }
    state.previousSize = observed.stat.size
    if (observed.stat.size > 0) state.nonEmptyObserved = true
    state.lastObservedAt = iso(atMs)
  }

  finish(atMs = this.now(), reason = 'operator-finished') {
    if (this.finished) throw new Error('provider activity watch is already finished')
    this.poll(atMs)
    if (this.hostLineBuffer.trim() !== '') this.observeHostLine(this.hostLineBuffer.replace(/\r$/u, ''))
    this.hostLineBuffer = ''
    this.finished = true
    const endedAt = iso(atMs)
    const rawJournals = {}
    const journalSnapshots = {}
    const records = {}
    for (const name of PROVIDER_JOURNALS) {
      const state = this.journalState[name]
      const snapshot = safeReadSnapshot(state.path)
      journalSnapshots[name] = snapshot
      if (!snapshot.ok) {
        if (snapshot.reason !== 'missing') this.problem(`journal-final-read:${name}:${snapshot.reason}`)
        rawJournals[name] = null
        records[name] = { rows: null, malformedRows: null }
      } else {
        rawJournals[name] = snapshot.bytes
        records[name] = countJournalRecords(snapshot.bytes)
      }
    }
    const windowStartMs = this.startedAtMs
    const bootAtMs = Date.parse(this.boundaries.bootAt ?? '')
    const readyAtMs = Date.parse(this.boundaries.generationReadyAt ?? '')
    const terminalAtMs = Date.parse(this.boundaries.terminalAt ?? '')
    let coverageComplete = this.identity !== null && this.identity.generationId !== null
      && this.bootCount === 1 && this.generationReadyCount === 1 && this.terminalCount === 1
      && Number.isFinite(bootAtMs) && Number.isFinite(readyAtMs) && Number.isFinite(terminalAtMs)
      && windowStartMs <= bootAtMs && bootAtMs <= readyAtMs && readyAtMs <= terminalAtMs && terminalAtMs <= atMs
      && this.problems.length === 0
    const journals = {}
    for (const name of PROVIDER_JOURNALS) {
      const state = this.journalState[name]
      const bytes = rawJournals[name]
      const snapshot = journalSnapshots[name]
      if (state.firstObservedAt === null || bytes === null || state.missingAfterSeen || state.invalid || state.replaced || state.truncated) coverageComplete = false
      if (state.firstObservedAt !== null && Number.isFinite(readyAtMs) && Date.parse(state.firstObservedAt) > readyAtMs) coverageComplete = false
      journals[name] = {
        bytes: bytes === null ? null : bytes.length,
        sha256: bytes === null ? null : createHash('sha256').update(bytes).digest('hex'),
        initializedAt: state.initializedAt,
        closedAt: bytes === null ? null : endedAt,
        firstObservedAt: state.firstObservedAt,
        lastObservedAt: state.lastObservedAt,
        fileCreatedAt: bytes === null || !snapshot.stat ? null : iso(snapshot.stat.birthtimeMs),
        fileModifiedAt: bytes === null || !snapshot.stat ? null : iso(snapshot.stat.mtimeMs),
      }
    }
    const jevCallRows = records['jev-calls'].rows
    const jevDecisionRows = records['jev-decisions'].rows
    const system2Rows = records['system2-journal'].rows
    const allJournalsPresent = PROVIDER_JOURNALS.every((name) => rawJournals[name] !== null)
    const activity = {
      networkModelCalls: allJournalsPresent ? jevCallRows + system2Rows : null,
      jevDecisionCalls: allJournalsPresent ? jevDecisionRows : null,
      system2DecisionCalls: allJournalsPresent ? system2Rows : null,
    }
    const identityComplete = this.identity !== null && this.identity.generationId !== null
    const anyBytes = PROVIDER_JOURNALS.some((name) => this.journalState[name].nonEmptyObserved || rawJournals[name]?.length > 0)
    const identityContradiction = this.problems.some((problem) => [
      'multiple-boot-boundaries', 'multiple-run-identities', 'generation-source-mismatch',
      'generation-identity-changed', 'multiple-generation-ready-boundaries', 'multiple-transition-terminals',
    ].includes(problem))
    const status = anyBytes || identityContradiction
      ? 'FAIL'
      : coverageComplete && identityComplete ? 'OBSERVED' : 'INCOMPLETE'
    return {
      schema: PROVIDER_CAPTURE_SCHEMA,
      status,
      identity: this.identity,
      window: {
        startedAt: this.startedAt,
        endedAt,
        coverageComplete,
        generationReadyAt: this.boundaries.generationReadyAt,
        terminalAt: this.boundaries.terminalAt,
        maxObservedPollGapMs: this.maxObservedPollGapMs,
        maxPollGapMs: this.maxPollGapMs,
      },
      activity,
      activityBasis: 'non-empty JSONL record counts from observed provider journals; any journal bytes invalidate zero-activity evidence',
      journals,
      capture: {
        method: 'read-only-poll',
        reason,
        hostLog: this.hostLog,
        armedAt: this.startedAt,
        finishedAt: endedAt,
        problems: [...this.problems],
        observedNonEmptyJournal: anyBytes,
      },
    }
  }
}

export function parseArgs(argv) {
  const out = { runtimeDir: null, hostLog: null, journals: {}, output: null, pollMs: 250, maxPollGapMs: DEFAULT_MAX_POLL_GAP_MS, timeoutMs: null, force: false, help: false }
  const options = new Map([
    ['--runtime-dir', 'runtimeDir'], ['--host-log', 'hostLog'], ['--jev-calls', 'jev-calls'],
    ['--jev-decisions', 'jev-decisions'], ['--system2-journal', 'system2-journal'],
    ['--output', 'output'], ['--poll-ms', 'pollMs'], ['--max-poll-gap-ms', 'maxPollGapMs'], ['--timeout-ms', 'timeoutMs'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { out.help = true; continue }
    if (argument === '--force') { out.force = true; continue }
    const key = options.get(argument)
    if (!key) throw new Error(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    if (['pollMs', 'maxPollGapMs', 'timeoutMs'].includes(key)) {
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${argument} must be a positive integer`)
      out[key] = parsed
    } else if (PROVIDER_JOURNALS.includes(key)) out.journals[key] = value
    else out[key] = value
    index += 1
  }
  if (out.help) return out
  if (!out.runtimeDir && !(out.hostLog && PROVIDER_JOURNALS.every((name) => out.journals[name]))) {
    throw new Error('supply --runtime-dir, or --host-log with all three provider journal paths')
  }
  if (!out.output) throw new Error('--output is required')
  if (out.runtimeDir) {
    const defaults = runtimePaths(out.runtimeDir)
    out.hostLog ??= defaults.hostLog
    out.journals = { ...defaults.journals, ...out.journals }
  }
  out.output = path.resolve(out.output)
  const inputPaths = [out.hostLog, ...PROVIDER_JOURNALS.map((name) => out.journals[name])].map((item) => path.resolve(item))
  if (inputPaths.includes(out.output)) throw new Error('output must not overwrite the host log or a provider journal')
  return out
}

export const HELP = `Usage: bun tools/capture-vtr-provider-activity.mjs --runtime-dir <buddy-driver-dir> --output <provider-activity-capture.json> [options]

Arm before starting the resident. The helper tails new buddy.log records and
polls the three provider journals without creating or modifying them. After the
run reaches VTR_TRANSITION_OUTCOME and the collector snapshot is captured, send
SIGINT (Ctrl-C) to this process. It writes the vtr-provider-activity-capture/v1
artifact at --output. Missing journals, identity conflicts and polling gaps
remain INCOMPLETE; any captured provider-journal bytes are reported as activity.

Options: --poll-ms <n> --max-poll-gap-ms <n> --timeout-ms <n> --force
For nonstandard paths use --host-log, --jev-calls, --jev-decisions and
--system2-journal together instead of --runtime-dir.`

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { process.stdout.write(`${HELP}\n`); return 0 }
  const outputState = statRegular(args.output)
  if (outputState.invalid) throw new Error(`output must be a regular file path, not a symlink or directory: ${args.output}`)
  if (outputState.stat && !args.force) throw new Error(`output already exists (use --force to replace): ${args.output}`)
  const watch = new VtrProviderActivityWatch({
    hostLog: args.hostLog,
    journals: args.journals,
    maxPollGapMs: args.maxPollGapMs,
  })
  process.stdout.write(`${JSON.stringify({ event: 'armed', pid: process.pid, startedAt: watch.startedAt, output: args.output, hostLog: args.hostLog })}\n`)
  let done = false
  let timeout = null
  const timer = setInterval(() => watch.poll(), args.pollMs)
  const finish = (reason) => {
    if (done) return
    done = true
    clearInterval(timer)
    if (timeout !== null) clearTimeout(timeout)
    try {
      const capture = watch.finish(Date.now(), reason)
      fs.mkdirSync(path.dirname(args.output), { recursive: true })
      fs.writeFileSync(args.output, `${JSON.stringify(capture, null, 2)}\n`, { flag: args.force ? 'w' : 'wx' })
      process.stdout.write(`${JSON.stringify({ event: 'finished', status: capture.status, coverageComplete: capture.window.coverageComplete, output: args.output, activity: capture.activity, problems: capture.capture.problems })}\n`)
      process.exitCode = capture.status === 'OBSERVED' && capture.window.coverageComplete
        && !capture.capture.observedNonEmptyJournal && Object.values(capture.activity).every((count) => count === 0) ? 0 : 1
    } catch (error) {
      process.stderr.write(`provider activity capture failed: ${error.message}\n`)
      process.exitCode = 1
    }
  }
  process.once('SIGINT', () => finish('SIGINT'))
  process.once('SIGTERM', () => finish('SIGTERM'))
  if (args.timeoutMs !== null) timeout = setTimeout(() => finish('watch-timeout'), args.timeoutMs)
  return new Promise((resolve) => {
    const pollDone = setInterval(() => {
      if (!done) return
      clearInterval(pollDone)
      resolve(process.exitCode ?? 1)
    }, 25)
  })
}

if (import.meta.main) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`${error.message}\n${HELP}\n`)
    process.exitCode = 2
  })
}
