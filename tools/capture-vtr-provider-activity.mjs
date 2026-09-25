#!/usr/bin/env bun
// Read-only coverage monitor for a single VTR live run. Start this before the
// resident, then send SIGINT after the run's terminal event and collector
// snapshot. It observes existing files only; it never creates provider logs.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROVIDER_CAPTURE_SCHEMA = 'vtr-provider-activity-capture/v2'
export const PROVIDER_JOURNALS = Object.freeze(['jev-calls', 'jev-decisions', 'system2-journal', 'mercury-calls'])
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
    lifecycleLog: path.join(root, 'data', 'vtr-reach-lifecycle.jsonl'),
    journals: {
      'jev-calls': path.join(logDir, 'jev-calls.jsonl'),
      'jev-decisions': path.join(logDir, 'decisions.jsonl'),
      'system2-journal': path.join(logDir, 'system2.jsonl'),
      'mercury-calls': path.join(logDir, 'mercury-calls.jsonl'),
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
    return `${value.serverId}|${value.dimension.replace(/^minecraft:/u, '')}|${value.worldEpoch}`
  } catch {
    return null
  }
}

function parseJournalRecords(bytes) {
  if (!bytes || bytes.length === 0) return { rows: [], malformedRows: 0 }
  const text = bytes.toString('utf8')
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '')
  const rows = []
  let malformedRows = 0
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      if (row === null || typeof row !== 'object' || Array.isArray(row)) malformedRows += 1
      else rows.push(row)
    } catch {
      malformedRows += 1
    }
  }
  return { rows, malformedRows }
}

function nonNegativeInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function deterministicFallbackCall(row) {
  return row?.policy === 'fallback' && typeof row.model === 'string' && /^deterministic(?:-|$)/iu.test(row.model)
}

function lifecycleWorldKey(value) {
  if (typeof value === 'string') {
    const parts = value.split('|')
    if (parts.length !== 3) return value
    return `${parts[0]}|${parts[1].replace(/^minecraft:/u, '')}|${parts[2]}`
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.serverId !== 'string' || !value.serverId || typeof value.dimension !== 'string' || !value.dimension || !Number.isSafeInteger(value.worldEpoch)) return null
  return `${value.serverId}|${value.dimension.replace(/^minecraft:/u, '')}|${value.worldEpoch}`
}

function loopbackPortFromWorldKey(worldKey) {
  const serverId = typeof worldKey === 'string' ? worldKey.split('|', 1)[0] : null
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(String(serverId ?? ''))
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function validProcessExitObservation(row, observation) {
  return observation?.schema === 'vtr-process-exit-observation/v1' &&
    observation.source === 'child-close-event' && observation.state === 'exited' &&
    observation.pid === row?.pid && observation.exitCode === row?.exitCode &&
    Number.isSafeInteger(observation.pid) && Number.isSafeInteger(observation.exitCode) &&
    Number.isFinite(Date.parse(observation.observedAt ?? ''))
}

function validListenerClosureObservation(row, observation, expectedPort) {
  const processExitAt = Date.parse(row?.processExitObservation?.observedAt ?? '')
  const observedAt = Date.parse(observation?.observedAt ?? '')
  return observation?.schema === 'vtr-listener-closure-observation/v1' &&
    observation.source === 'tcp-connect-probe' && observation.state === 'closed' &&
    observation.host === '127.0.0.1' && observation.port === expectedPort &&
    observation.result === 'connection-refused' && Number.isFinite(observedAt) &&
    Number.isFinite(processExitAt) && observedAt >= processExitAt
}

function assessLifecycle({ records, malformedRows, identity, transitionId, contractHash, boundaries, shutdownCount, state, startedAtMs, bootAtMs, readyAtMs, terminalAtMs, endedAtMs }) {
  const problems = []
  const events = { terminalConsumed: null, residentStopped: null, serverStopped: null }
  const add = (problem) => { if (!problems.includes(problem)) problems.push(problem) }
  if (!Array.isArray(records)) add('lifecycle-log-missing-or-unreadable')
  if (malformedRows !== 0) add('lifecycle-log-malformed')
  if (state.firstObservedAt === null || Date.parse(state.firstObservedAt) > bootAtMs) add('lifecycle-log-not-observed-before-boot')
  if (state.missingAfterSeen || state.invalid || state.replaced || state.truncated) add('lifecycle-log-not-continuous')
  const rows = Array.isArray(records) ? records : []
  const expectedNames = ['terminal-consumed', 'resident-stopped', 'server-stopped']
  for (const name of expectedNames) {
    const matched = rows.filter((row) => row?.event === name)
    if (matched.length !== 1) add(`${name}-count-${matched.length}`)
    else events[name === 'terminal-consumed' ? 'terminalConsumed' : name === 'resident-stopped' ? 'residentStopped' : 'serverStopped'] = matched[0]
  }
  if (rows.some((row) => row?.schema !== 'vtr-reach-probe-lifecycle/v1')) add('lifecycle-schema-unrecognized')
  for (const [name, row] of Object.entries(events)) {
    if (!row) continue
    if (row.actor !== 'probe-harness') add(`${name}-actor-unrecognized`)
    if (!identity || !identity.sourceSha || !identity.runId || !identity.generationId) add(`${name}-identity-unavailable`)
    else if (row.sourceSha?.toLowerCase?.() !== identity.sourceSha || row.runId !== identity.runId ||
        row.generationId !== identity.generationId || lifecycleWorldKey(row.worldKey) !== identity.worldKey) {
      add(`${name}-identity-mismatch`)
    }
    const eventAt = Date.parse(row.ts ?? '')
    if (!Number.isFinite(eventAt)) add(`${name}-timestamp-missing`)
    if (name !== 'terminalConsumed') {
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0) add(`${name}-pid-invalid`)
      if (row.status !== 'stopped' && row.status !== 'exited') add(`${name}-status-not-stopped`)
      if (!Number.isSafeInteger(row.exitCode)) add(`${name}-exit-code-missing`)
      const stoppedAt = Date.parse(row.stoppedAt ?? '')
      if (!Number.isFinite(stoppedAt) || stoppedAt !== eventAt) add(`${name}-stoppedAt-mismatch`)
      if (!validProcessExitObservation(row, row.processExitObservation)) add(`${name}-process-exit-observation-invalid`)
      if (name === 'serverStopped') {
        const port = loopbackPortFromWorldKey(identity?.worldKey)
        if (port === null || !validListenerClosureObservation(row, row.listenerClosureObservation, port) ||
            Date.parse(row.listenerClosureObservation?.observedAt ?? '') !== stoppedAt) {
          add('serverStopped-listener-closure-observation-invalid')
        }
      }
    }
  }
  const consumedAt = Date.parse(events.terminalConsumed?.ts ?? '')
  const residentAt = Date.parse(events.residentStopped?.stoppedAt ?? '')
  const serverAt = Date.parse(events.serverStopped?.stoppedAt ?? '')
  const shutdownAt = Date.parse(boundaries.shutdownAt ?? '')
  const ordered = Number.isFinite(terminalAtMs) && Number.isFinite(consumedAt) && Number.isFinite(shutdownAt) &&
    Number.isFinite(residentAt) && Number.isFinite(serverAt) && Number.isFinite(endedAtMs) &&
    terminalAtMs <= consumedAt && consumedAt <= shutdownAt && shutdownAt <= residentAt && residentAt <= serverAt && serverAt <= endedAtMs
  if (!ordered) add('lifecycle-event-order-invalid')
  if (shutdownCount !== 1) add(`host-shutdown-count-${shutdownCount}`)
  if (transitionId === null || contractHash === null || !events.terminalConsumed) add('terminal-consumed-transition-identity-unavailable')
  else if (events.terminalConsumed.transitionId !== transitionId || events.terminalConsumed.contractHash !== contractHash ||
      events.terminalConsumed.outcomeKind !== 'SUCCESS' || !Array.isArray(events.terminalConsumed.evidenceIds) || events.terminalConsumed.evidenceIds.length === 0) {
    add('terminal-consumed-outcome-binding-mismatch')
  }
  if (!(startedAtMs <= bootAtMs && bootAtMs <= readyAtMs && readyAtMs <= terminalAtMs && terminalAtMs <= endedAtMs)) {
    add('capture-window-does-not-cover-run')
  }
  const identityContradiction = problems.some((problem) => /identity-mismatch|outcome-binding-mismatch|transition-mismatch/u.test(problem))
  return { complete: problems.length === 0, identityContradiction, problems, events }
}

/**
 * Interpret decision journals separately from provider evaluation journals.
 * Jev and Mercury records store cumulative attempts, so retries sharing a
 * callId are grouped by their maximum counter instead of being double-counted.
 * `null` means the raw rows do not establish a count.
 */
export function classifyProviderActivity(recordsByJournal) {
  const unknown = []
  let positiveProviderActivityObserved = false
  const records = recordsByJournal ?? {}
  const getRows = (name) => Array.isArray(records[name]) ? records[name] : null

  const jevRows = getRows('jev-calls')
  const jevDecisionRows = getRows('jev-decisions')
  const system2Rows = getRows('system2-journal')
  const mercuryRows = getRows('mercury-calls')

  const jevAttemptsByCall = new Map()
  const jevDecisionCallIds = new Set()
  const jevCallRowsById = new Map()
  const classifiedJevCallIds = new Set()
  const jevOutcomeRowsById = new Map()
  if (jevRows === null) unknown.push('missing-or-malformed:jev-calls')
  else for (const row of jevRows) {
    if (row.record === 'jev-outcome') {
      const outcomeCallId = typeof row.callId === 'string' && row.callId.length > 0 ? row.callId : null
      if (outcomeCallId === null) unknown.push('missing-call-id:jev-outcome')
      else jevOutcomeRowsById.set(outcomeCallId, (jevOutcomeRowsById.get(outcomeCallId) ?? 0) + 1)
      const attempts = nonNegativeInteger(row.providerAttempts ?? row.providerEvaluateAttempts ?? row.detail?.providerAttempts ?? row.detail?.providerEvaluateAttempts)
      if (attempts !== null && attempts > 0) positiveProviderActivityObserved = true
      continue
    }
    if (!['jev-call', 'jev-retry'].includes(row.record)) {
      unknown.push(`unclassified-decision-record:jev-calls:${String(row.record ?? 'missing-record')}`)
      const unclassifiedAttempts = nonNegativeInteger(row.providerAttempts ?? row.providerEvaluateAttempts ?? row.detail?.providerAttempts ?? row.detail?.providerEvaluateAttempts)
      if (unclassifiedAttempts !== null && unclassifiedAttempts > 0) positiveProviderActivityObserved = true
      continue
    }
    const callId = typeof row.callId === 'string' && row.callId.length > 0 ? row.callId : null
    if (callId === null) unknown.push('missing-call-id:jev-calls')
    else jevDecisionCallIds.add(callId)
    if (callId !== null && row.record === 'jev-call') {
      jevCallRowsById.set(callId, (jevCallRowsById.get(callId) ?? 0) + 1)
    }
    let attempts = nonNegativeInteger(row.providerAttempts)
    if (attempts === null && row.providerAttempts === undefined && row.record === 'jev-call' && deterministicFallbackCall(row)) attempts = 0
    if (attempts === null) {
      unknown.push(`unclassified-provider-attempts:jev-calls:${callId ?? 'unknown'}`)
      continue
    }
    if (callId !== null && row.record === 'jev-call') classifiedJevCallIds.add(callId)
    if (attempts > 0) positiveProviderActivityObserved = true
    if (callId === null) continue
    jevAttemptsByCall.set(callId, Math.max(jevAttemptsByCall.get(callId) ?? 0, attempts))
  }
  for (const [callId, outcomeCount] of jevOutcomeRowsById) {
    if (outcomeCount !== 1) unknown.push(`duplicate-jev-outcome-call-id:${callId}`)
    const callCount = jevCallRowsById.get(callId) ?? 0
    if (callCount !== 1 || !classifiedJevCallIds.has(callId)) {
      unknown.push(`orphan-or-unclassified-jev-outcome:${callId}`)
    }
  }
  for (const [callId, callCount] of jevCallRowsById) {
    if (callCount !== 1) unknown.push(`duplicate-jev-call-id:${callId}`)
  }

  const mercuryAttemptsByCall = new Map()
  if (mercuryRows === null) unknown.push('missing-or-malformed:mercury-calls')
  else for (const row of mercuryRows) {
    if (row.record !== 'mercury-call') {
      unknown.push(`unclassified-provider-record:mercury-calls:${String(row.record ?? 'missing-record')}`)
      const unclassifiedAttempts = nonNegativeInteger(row.attempts ?? row.providerAttempts ?? row.detail?.attempts ?? row.detail?.providerAttempts)
      if (unclassifiedAttempts !== null && unclassifiedAttempts > 0) positiveProviderActivityObserved = true
      continue
    }
    const callId = typeof row.callId === 'string' && row.callId.length > 0 ? row.callId : null
    const attempts = nonNegativeInteger(row.attempts)
    if (callId === null || attempts === null) {
      unknown.push(`unclassified-provider-attempts:mercury-calls:${callId ?? 'unknown'}`)
      if (attempts !== null && attempts > 0) positiveProviderActivityObserved = true
      continue
    }
    if (attempts > 0) positiveProviderActivityObserved = true
    mercuryAttemptsByCall.set(callId, Math.max(mercuryAttemptsByCall.get(callId) ?? 0, attempts))
  }

  const system2PlanRows = system2Rows?.filter((row) => row.record === 'system2-plan') ?? null
  const mercuryCallIds = mercuryRows === null ? null : new Set(mercuryRows.map((row) => row?.callId).filter((value) => typeof value === 'string' && value.length > 0))
  for (const row of system2PlanRows ?? []) {
    const attempts = nonNegativeInteger(row.providerAttempts ?? row.providerEvaluateAttempts ?? row.detail?.providerAttempts ?? row.detail?.providerEvaluateAttempts)
    if (attempts !== null && attempts > 0) positiveProviderActivityObserved = true
    const localProvenance = ['local', 'cache', 'deterministic', 'stub'].includes(String(row.provenance ?? row.source ?? '').toLowerCase()) ||
      ['local', 'cache', 'deterministic', 'stub'].includes(String(row.provider ?? '').toLowerCase())
    const explicitlyLocalStub = row.stub === true && localProvenance
    const callId = typeof row.callId === 'string' && row.callId.length > 0 ? row.callId : null
    const correlatedProviderCall = callId !== null && mercuryCallIds !== null && mercuryCallIds.has(callId)
    if (!explicitlyLocalStub && !correlatedProviderCall) {
      unknown.push(`unclassified-system2-plan-authority:${callId ?? String(row.provider ?? 'unknown')}`)
    }
  }
  if (system2Rows !== null && system2PlanRows.length !== system2Rows.length) {
    unknown.push('unclassified-decision-record:system2-journal')
    for (const row of system2Rows) {
      if (row.record === 'system2-plan') continue
      const attempts = nonNegativeInteger(row.providerAttempts ?? row.providerEvaluateAttempts ?? row.detail?.providerAttempts ?? row.detail?.providerEvaluateAttempts)
      if (attempts !== null && attempts > 0) positiveProviderActivityObserved = true
    }
  }
  if (jevDecisionRows === null) unknown.push('missing-or-malformed:jev-decisions')

  const jevProviderEvaluateAttempts = jevRows === null || unknown.some((entry) => entry.includes('jev-calls') || entry.includes('jev-outcome'))
    ? null
    : [...jevAttemptsByCall.values()].reduce((sum, attempts) => sum + attempts, 0)
  const system2ProviderEvaluateAttempts = mercuryRows === null || unknown.some((entry) =>
    entry.includes('mercury-calls') || entry.includes('system2-journal') || entry.startsWith('unclassified-system2-plan-authority:'))
    ? null
    : [...mercuryAttemptsByCall.values()].reduce((sum, attempts) => sum + attempts, 0)
  const networkModelCalls = jevProviderEvaluateAttempts === null || system2ProviderEvaluateAttempts === null
    ? null
    : jevProviderEvaluateAttempts + system2ProviderEvaluateAttempts

  return {
    decisions: {
      jevDecisionFrames: jevRows === null ? null : jevDecisionCallIds.size,
      jevDecisionRecords: jevDecisionRows === null ? null : jevDecisionRows.length,
      system2DecisionInvocations: system2PlanRows === null ? null : system2PlanRows.length,
    },
    providers: {
      jevEvaluateAttempts: jevProviderEvaluateAttempts,
      system2EvaluateAttempts: system2ProviderEvaluateAttempts,
      networkModelCalls,
    },
    positiveProviderActivityObserved,
    unknown: [...new Set(unknown)],
  }
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
 * metadata; `finish()` hashes actual current journal bytes and returns the v2
 * package contract. Callers must arm it before the resident starts.
 */
export class VtrProviderActivityWatch {
  constructor({ hostLog, journals, lifecycleLog, now = () => Date.now(), maxPollGapMs = DEFAULT_MAX_POLL_GAP_MS }) {
    if (typeof hostLog !== 'string' || !hostLog) throw new Error('hostLog is required')
    if (typeof lifecycleLog !== 'string' || !lifecycleLog) throw new Error('lifecycleLog is required')
    if (!journals || typeof journals !== 'object') throw new Error('journals map is required')
    for (const name of PROVIDER_JOURNALS) {
      if (typeof journals[name] !== 'string' || !journals[name]) throw new Error(`journal path is required: ${name}`)
    }
    this.hostLog = path.resolve(hostLog)
    this.lifecycleLog = path.resolve(lifecycleLog)
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
    this.boundaries = { bootAt: null, generationReadyAt: null, transitionId: null, contractHash: null, terminalAt: null, shutdownAt: null }
    this.identity = null
    this.bootCount = 0
    this.generationReadyCount = 0
    this.terminalCount = 0
    this.shutdownCount = 0
    this.journalState = Object.fromEntries(PROVIDER_JOURNALS.map((name) => [name, {
      path: this.journals[name], firstObservedAt: null, initializedAt: null,
      lastObservedAt: null, inode: null, previousSize: null,
      missingAfterSeen: false, replaced: false, truncated: false, invalid: false,
      nonEmptyObserved: false,
    }]))
    this.lifecycleState = {
      path: this.lifecycleLog, firstObservedAt: null, lastObservedAt: null,
      inode: null, previousSize: null, missingAfterSeen: false,
      replaced: false, truncated: false, invalid: false,
    }
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
    this.observeLifecycleLog(atMs)
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
    if (event.name === 'SHUTDOWN') {
      this.shutdownCount += 1
      if (this.shutdownCount > 1) this.problem('multiple-host-shutdown-boundaries')
      this.boundaries.shutdownAt = iso(event.at)
      if (this.boundaries.terminalAt && event.at < Date.parse(this.boundaries.terminalAt)) this.problem('host-shutdown-before-transition-terminal')
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
    if (event.name === 'VTR_TRANSITION_COMMIT') {
      const transitionId = field(event.fields, 'transitionId') ?? field(event.fields, 'id')
      const contractHash = field(event.fields, 'contractHash')
      if (!transitionId || !contractHash) this.problem('transition-commit-identity-incomplete')
      else if (this.boundaries.transitionId !== null && (this.boundaries.transitionId !== transitionId || this.boundaries.contractHash !== contractHash)) this.problem('transition-commit-identity-changed')
      else {
        this.boundaries.transitionId = transitionId
        this.boundaries.contractHash = contractHash
      }
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
      const transitionId = field(event.fields, 'transitionId') ?? field(event.fields, 'id')
      if (transitionId && this.boundaries.transitionId && transitionId !== this.boundaries.transitionId) this.problem('terminal-transition-mismatch')
      if (this.boundaries.generationReadyAt && event.at < Date.parse(this.boundaries.generationReadyAt)) this.problem('terminal-before-generation-ready')
    }
  }

  observeLifecycleLog(atMs) {
    const state = this.lifecycleState
    const observed = statRegular(state.path)
    if (observed.invalid) {
      state.invalid = true
      this.problem('lifecycle-log-not-regular')
      return
    }
    if (!observed.stat) {
      if (state.inode !== null) {
        state.missingAfterSeen = true
        this.problem('lifecycle-log-disappeared')
      }
      return
    }
    const inode = inodeOf(observed.stat)
    if (state.firstObservedAt === null) {
      state.firstObservedAt = iso(atMs)
      state.inode = inode
    } else if (state.inode !== inode) {
      state.replaced = true
      this.problem('lifecycle-log-replaced')
    }
    if (state.previousSize !== null && observed.stat.size < state.previousSize) {
      state.truncated = true
      this.problem('lifecycle-log-truncated')
    }
    state.previousSize = observed.stat.size
    state.lastObservedAt = iso(atMs)
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
    if (typeof atMs === 'string') {
      reason = atMs
      atMs = this.now()
    }
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
        records[name] = parseJournalRecords(snapshot.bytes)
      }
    }
    const windowStartMs = this.startedAtMs
    const bootAtMs = Date.parse(this.boundaries.bootAt ?? '')
    const readyAtMs = Date.parse(this.boundaries.generationReadyAt ?? '')
    const terminalAtMs = Date.parse(this.boundaries.terminalAt ?? '')
    const lifecycleSnapshot = safeReadSnapshot(this.lifecycleLog)
    const lifecycleRecords = lifecycleSnapshot.ok ? parseJournalRecords(lifecycleSnapshot.bytes) : { rows: null, malformedRows: null }
    if (!lifecycleSnapshot.ok && lifecycleSnapshot.reason !== 'missing') this.problem(`lifecycle-final-read:${lifecycleSnapshot.reason}`)
    const lifecycleAssessment = assessLifecycle({
      records: lifecycleRecords.rows,
      malformedRows: lifecycleRecords.malformedRows,
      identity: this.identity,
      transitionId: this.boundaries.transitionId,
      contractHash: this.boundaries.contractHash,
      boundaries: this.boundaries,
      shutdownCount: this.shutdownCount,
      state: this.lifecycleState,
      startedAtMs: windowStartMs,
      bootAtMs,
      readyAtMs,
      terminalAtMs,
      endedAtMs: atMs,
    })
    let coverageComplete = this.identity !== null && this.identity.generationId !== null
      && this.bootCount === 1 && this.generationReadyCount === 1 && this.terminalCount === 1
      && Number.isFinite(bootAtMs) && Number.isFinite(readyAtMs) && Number.isFinite(terminalAtMs)
      && windowStartMs <= bootAtMs && bootAtMs <= readyAtMs && readyAtMs <= terminalAtMs && terminalAtMs <= atMs
      && lifecycleAssessment.complete
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
        rows: records[name].rows === null ? null : records[name].rows.length,
        malformedRows: records[name].malformedRows,
        initializedAt: state.initializedAt,
        closedAt: bytes === null ? null : endedAt,
        firstObservedAt: state.firstObservedAt,
        lastObservedAt: state.lastObservedAt,
        fileCreatedAt: bytes === null || !snapshot.stat ? null : iso(snapshot.stat.birthtimeMs),
        fileModifiedAt: bytes === null || !snapshot.stat ? null : iso(snapshot.stat.mtimeMs),
      }
    }
    const recordsByJournal = Object.fromEntries(PROVIDER_JOURNALS.map((name) => [
      name,
      records[name].rows === null || records[name].malformedRows > 0 ? null : records[name].rows,
    ]))
    const classified = classifyProviderActivity(recordsByJournal)
    const activity = { ...classified.decisions, ...classified.providers }
    const identityComplete = this.identity !== null && this.identity.generationId !== null
    const anyBytes = PROVIDER_JOURNALS.some((name) => this.journalState[name].nonEmptyObserved || rawJournals[name]?.length > 0)
    const providerActivityDetected = classified.positiveProviderActivityObserved === true ||
      [activity.jevEvaluateAttempts, activity.system2EvaluateAttempts]
        .some((count) => Number.isSafeInteger(count) && count > 0)
    const identityContradiction = this.problems.some((problem) => [
      'multiple-boot-boundaries', 'multiple-run-identities', 'generation-source-mismatch',
      'generation-identity-changed', 'multiple-generation-ready-boundaries', 'multiple-transition-terminals',
      'transition-commit-identity-changed', 'terminal-transition-mismatch',
    ].includes(problem)) || lifecycleAssessment.identityContradiction
    const status = providerActivityDetected || identityContradiction
      ? 'FAIL'
      : coverageComplete && identityComplete && classified.unknown.length === 0 ? 'OBSERVED' : 'INCOMPLETE'
    return {
      schema: PROVIDER_CAPTURE_SCHEMA,
      status,
      identity: this.identity,
      window: {
        startedAt: this.startedAt,
        endedAt,
        coverageComplete,
        bootAt: this.boundaries.bootAt,
        generationReadyAt: this.boundaries.generationReadyAt,
        terminalAt: this.boundaries.terminalAt,
        shutdownAt: this.boundaries.shutdownAt,
        terminalConsumedAt: lifecycleAssessment.events.terminalConsumed?.ts ?? null,
        residentStoppedAt: lifecycleAssessment.events.residentStopped?.stoppedAt ?? null,
        serverStoppedAt: lifecycleAssessment.events.serverStopped?.stoppedAt ?? null,
        lifecycleComplete: lifecycleAssessment.complete,
        maxObservedPollGapMs: this.maxObservedPollGapMs,
        maxPollGapMs: this.maxPollGapMs,
      },
      activity,
      activityBasis: 'decision journals are counted separately; provider attempts are read from Jev cumulative providerAttempts and Mercury cumulative attempts grouped by callId',
      activityClassification: classified,
      journals,
      lifecycle: {
        path: this.lifecycleLog,
        bytes: lifecycleSnapshot.ok ? lifecycleSnapshot.bytes.length : null,
        sha256: lifecycleSnapshot.ok ? createHash('sha256').update(lifecycleSnapshot.bytes).digest('hex') : null,
        rows: lifecycleRecords.rows === null ? null : lifecycleRecords.rows.length,
        malformedRows: lifecycleRecords.malformedRows,
        initializedAt: this.lifecycleState.firstObservedAt,
        closedAt: lifecycleSnapshot.ok ? endedAt : null,
        firstObservedAt: this.lifecycleState.firstObservedAt,
        lastObservedAt: this.lifecycleState.lastObservedAt,
        status: lifecycleAssessment.complete ? 'OBSERVED' : 'INCOMPLETE',
        problems: lifecycleAssessment.problems,
        events: lifecycleAssessment.events,
      },
      capture: {
        method: 'read-only-poll',
        reason,
        hostLog: this.hostLog,
        lifecycleLog: this.lifecycleLog,
        armedAt: this.startedAt,
        finishedAt: endedAt,
        problems: [...this.problems],
        observedNonEmptyJournal: anyBytes,
        observedProviderActivity: providerActivityDetected,
      },
    }
  }
}

export function parseArgs(argv) {
  const out = { runtimeDir: null, hostLog: null, lifecycleLog: null, journals: {}, output: null, pollMs: 250, maxPollGapMs: DEFAULT_MAX_POLL_GAP_MS, timeoutMs: null, force: false, help: false }
  const options = new Map([
    ['--runtime-dir', 'runtimeDir'], ['--host-log', 'hostLog'], ['--lifecycle-log', 'lifecycleLog'], ['--jev-calls', 'jev-calls'],
    ['--jev-decisions', 'jev-decisions'], ['--system2-journal', 'system2-journal'], ['--mercury-calls', 'mercury-calls'],
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
  if (!out.runtimeDir && !(out.hostLog && out.lifecycleLog && PROVIDER_JOURNALS.every((name) => out.journals[name]))) {
    throw new Error('supply --runtime-dir, or --host-log --lifecycle-log with all four decision/provider journal paths')
  }
  if (!out.output) throw new Error('--output is required')
  if (out.runtimeDir) {
    const defaults = runtimePaths(out.runtimeDir)
    out.hostLog ??= defaults.hostLog
    out.lifecycleLog ??= defaults.lifecycleLog
    out.journals = { ...defaults.journals, ...out.journals }
  }
  out.output = path.resolve(out.output)
  const inputPaths = [out.hostLog, out.lifecycleLog, ...PROVIDER_JOURNALS.map((name) => out.journals[name])].map((item) => path.resolve(item))
  if (inputPaths.includes(out.output)) throw new Error('output must not overwrite the host log or a provider journal')
  return out
}

export const HELP = `Usage: bun tools/capture-vtr-provider-activity.mjs --runtime-dir <buddy-driver-dir> --output <provider-activity-capture.json> [options]

Arm before starting the resident. The helper tails new buddy.log records and
polls Jev decision/call, System2 plan, and Mercury provider-attempt journals
without creating or modifying them. After the run reaches
VTR_TRANSITION_OUTCOME, the harness consumes it, and the resident/server stop
events are appended to the lifecycle transcript, send SIGINT (Ctrl-C) to this
process. It writes a vtr-provider-activity-capture/v2 artifact.
Decision invocations are counted separately from provider evaluate attempts;
non-empty decision journals can still establish zero provider activity.
Missing/malformed/unclassified journals, identity conflicts, and polling gaps
remain INCOMPLETE. Positive provider attempts are FAIL.
This evidence is sampled by polling and assumes append-only journals: an
observed replacement, disappearance, or truncation is INCOMPLETE, while a
transient mutation that begins and ends entirely between polls is not claimed
to be independently witnessed.

Options: --poll-ms <n> --max-poll-gap-ms <n> --timeout-ms <n> --force
For nonstandard paths use --host-log, --lifecycle-log, --jev-calls, --jev-decisions,
--system2-journal and --mercury-calls together instead of --runtime-dir.`

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { process.stdout.write(`${HELP}\n`); return 0 }
  const outputState = statRegular(args.output)
  if (outputState.invalid) throw new Error(`output must be a regular file path, not a symlink or directory: ${args.output}`)
  if (outputState.stat && !args.force) throw new Error(`output already exists (use --force to replace): ${args.output}`)
  const watch = new VtrProviderActivityWatch({
    hostLog: args.hostLog,
    journals: args.journals,
    lifecycleLog: args.lifecycleLog,
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
        && capture.activity.networkModelCalls === 0
        && capture.activity.jevEvaluateAttempts === 0
        && capture.activity.system2EvaluateAttempts === 0 ? 0 : 1
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
