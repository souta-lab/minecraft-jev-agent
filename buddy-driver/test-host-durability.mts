// test-host-durability.mts - P0 durability fixtures (#378/#379/#380/#381/#384/#388).
//
// Every fault is REAL, never a mock of the algorithm under test:
//   - a read-only state directory makes the atomic write fail with EACCES;
//   - a state file that is unparseable / carries a NEWER schemaVersion;
//   - a lock file whose pid is provably dead, and two real OS processes racing;
//   - a generated child process that really throws (uncaught) or really rejects;
//   - a real unix-socket control server with a client that holds the connection.
// Each row has the fault-injected case AND the ordinary case, so a passing suite
// also proves the no-fault path is unchanged.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import type { Server } from 'node:net'
import type { AcceptanceRecord, AgentSnapshot, LedgerProposalEnvelope } from './resident-types.ts'
import { emptyWorldMemory } from './resident-types.ts'
import { AGENT_SNAPSHOT_SCHEMA_VERSION, emptyAgentSnapshot } from './state-snapshot.ts'
import { commitPendingProposals, newPendingProposals, stageLedgerProposal, writeSnapshotAtomic } from './proposal-staging.ts'
import { commitLedgerProposal } from './ledger-guard.ts'
import { ActuationLeaseManager } from './resident-safety.ts'
import {
  FATAL_SHUTDOWN,
  HOST_LOCK_LOST,
  HOST_LOCK_RECLAIMED,
  HostDurabilityLedger,
  HostLock,
  STATE_QUARANTINED,
  STATE_QUARANTINE_FAILED,
  STATE_WRITE_FAILED,
  closeControlServer,
  createFatalHandlers,
  createStateWriter,
  durableWriteLanded,
  loadStateWithQuarantine,
  openResidentBoot,
  runShutdownSequence,
  shutdownExitCodeForReason,
} from './host-durability.ts'

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

addCase('#471 OS signal shutdowns are restartable while control-quit stays clean', () => {
  const pass =
    shutdownExitCodeForReason('SIGINT') === 130 &&
    shutdownExitCodeForReason('SIGTERM') === 143 &&
    shutdownExitCodeForReason('control-quit') === 0
  return {
    pass,
    detail: `SIGINT=${shutdownExitCodeForReason('SIGINT')} SIGTERM=${shutdownExitCodeForReason('SIGTERM')} control-quit=${shutdownExitCodeForReason('control-quit')}`,
  }
})

interface Captured {
  events: Array<{ event: string; detail: Record<string, unknown> }>
  log: (event: string, detail?: Record<string, unknown>) => void
}

function capture(): Captured {
  const events: Captured['events'] = []
  return { events, log: (event, detail) => events.push({ event, detail: detail ?? {} }) }
}

const HERE = import.meta.dir
let dirSeq = 0
function tmpDir(tag: string): string {
  dirSeq += 1
  return mkdtempSync(join(tmpdir(), `hostdur-${tag}-${dirSeq}-`))
}

const ledgerSnap = (counter: number): { counter: number; goals: never[] } => ({ counter, goals: [] })

const validStateText = (revision: number, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION, revision, worldMemoryByKey: {}, ledger: null, ...extra }, null, 2)}\n`

/** A pid that is provably not alive: a child we spawned and reaped. */
async function deadPid(): Promise<number> {
  const child = spawn('/bin/true', [], { stdio: 'ignore' })
  const pid = child.pid ?? 999999
  await new Promise<void>((resolve) => child.on('close', () => resolve()))
  return pid
}

async function runChild(scriptPath: string, args: string[] = [], timeoutMs = 5000): Promise<{ out: string; code: number | null; signal: string | null; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += String(c)))
    child.stderr.on('data', (c) => (out += String(c)))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ out, code, signal, ms: Date.now() - started })
    })
  })
}

// ===========================================================================
// #379 - a failed durable write must be representable and reported
// ===========================================================================

addCase('#379(a) fault-injected: the real atomic write fails (EACCES) -> revision does NOT advance and STATE_WRITE_FAILED is reported', () => {
  const dir = tmpDir('379a')
  const path = join(dir, 'buddy-state.json')
  try {
    const state = emptyAgentSnapshot({ revision: 7, generationId: 'gen-1', bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, state)
    const before = readFileSync(path, 'utf8')
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const writer = createStateWriter({
      path,
      state: () => state,
      log: cap.log,
      durability,
      expectedSchemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
      write: writeSnapshotAtomic,
    })
    const updatedAt = state.updatedAt
    chmodSync(dir, 0o500)
    let outcome
    try {
      outcome = writer.save('reload-commit')
    } finally {
      chmodSync(dir, 0o700)
    }
    const after = readFileSync(path, 'utf8')
    const failed = cap.events.find((e) => e.event === STATE_WRITE_FAILED)
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    const pass =
      outcome.ok === false &&
      outcome.revision === 7 &&
      outcome.durableRevision === 7 &&
      outcome.error !== null &&
      state.revision === 7 &&
      state.updatedAt === updatedAt &&
      before === after &&
      failed !== undefined &&
      failed.detail.action === 'not-committed' &&
      failed.detail.attemptedRevision === 8 &&
      durability.acceptance().writeFailures === 1 &&
      leftovers.length === 0
    return {
      pass,
      detail: `ok=${outcome.ok} inMemoryRevision=${state.revision} diskRevision=${(JSON.parse(after) as AgentSnapshot).revision} bytesUnchanged=${before === after} marker=${String(failed?.detail.action)} tmpLeftovers=${leftovers.length}`,
    }
  } finally {
    try {
      chmodSync(dir, 0o700)
    } catch {
      void 0
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#379(b) fault-injected: the commit point reports writes=0 / writeOk=false instead of the old writes=1', () => {
  const dir = tmpDir('379b')
  const path = join(dir, 'buddy-state.json')
  try {
    const state = emptyAgentSnapshot({ revision: 10, generationId: 'gen-x', bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, state)
    const before = readFileSync(path, 'utf8')
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const writer = createStateWriter({ path, state: () => state, log: cap.log, durability, write: writeSnapshotAtomic })
    const pending = newPendingProposals()
    pending.generationId = 'gen-x'
    stageLedgerProposal(pending, { ledger: ledgerSnap(9), baseRevision: 10, generationId: 'gen-x' } satisfies LedgerProposalEnvelope)
    chmodSync(dir, 0o500)
    let result
    try {
      result = commitPendingProposals(
        {
          pending,
          memory: emptyWorldMemory(),
          state,
          guard: { revision: 10, committedGenerationId: 'gen-x', activeGenerationId: 'gen-x' },
          log: cap.log,
          save: (event) => writer.save(event),
        },
        'generation-start',
      )
    } finally {
      chmodSync(dir, 0o700)
    }
    const after = readFileSync(path, 'utf8')
    const pass =
      result.ledgerApplied === true &&
      result.writes === 0 &&
      result.writeOk === false &&
      typeof result.writeError === 'string' &&
      state.revision === 10 &&
      before === after &&
      durability.acceptance().writeFailures === 1
    return {
      pass,
      detail: `ledgerApplied=${result.ledgerApplied} writes=${result.writes} writeOk=${result.writeOk} revision=${state.revision} bytesUnchanged=${before === after}`,
    }
  } finally {
    try {
      chmodSync(dir, 0o700)
    } catch {
      void 0
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#379(c) ordinary case: a real writable commit lands once, reports writes=1 and advances the revision', () => {
  const dir = tmpDir('379c')
  const path = join(dir, 'buddy-state.json')
  try {
    const state = emptyAgentSnapshot({ revision: 10, generationId: 'gen-ok', bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, state)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const writer = createStateWriter({ path, state: () => state, log: cap.log, durability, write: writeSnapshotAtomic })
    const pending = newPendingProposals()
    pending.generationId = 'gen-ok'
    stageLedgerProposal(pending, { ledger: ledgerSnap(4), baseRevision: 10, generationId: 'gen-ok' } satisfies LedgerProposalEnvelope)
    const result = commitPendingProposals(
      {
        pending,
        memory: emptyWorldMemory(),
        state,
        guard: { revision: 10, committedGenerationId: 'gen-ok', activeGenerationId: 'gen-ok' },
        log: cap.log,
        save: (event) => writer.save(event),
      },
      'generation-start',
    )
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentSnapshot
    const pass =
      result.writes === 1 &&
      result.writeOk === true &&
      result.writeError === null &&
      state.revision === 11 &&
      parsed.revision === 11 &&
      parsed.ledger?.counter === 4 &&
      durability.acceptance().writeFailures === 0
    return { pass, detail: `writes=${result.writes} revision=${parsed.revision} ledgerCounter=${parsed.ledger?.counter}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#379(d) fault-injected: a failed ledger commit does NOT advance ledgerRevision (fail-closed lineage)', () => {
  const dir = tmpDir('379d')
  const path = join(dir, 'buddy-state.json')
  try {
    const state = emptyAgentSnapshot({ revision: 10, generationId: 'gen-x', bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, state)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const writer = createStateWriter({ path, state: () => state, log: cap.log, durability, write: writeSnapshotAtomic })
    let ledgerRevision = 5
    const persist: { ok: boolean } = { ok: true }
    let decision
    chmodSync(dir, 0o500)
    try {
      decision = commitLedgerProposal(
        state,
        { ledger: ledgerSnap(9), baseRevision: 10, generationId: 'gen-x' } satisfies LedgerProposalEnvelope,
        { revision: state.revision, ledgerRevision, generationId: 'gen-x' },
        cap.log,
        (event) => {
          persist.ok = writer.save(event).ok
        },
        'test',
      )
    } finally {
      chmodSync(dir, 0o700)
    }
    if (decision.ok && persist.ok) ledgerRevision = state.revision
    const pass = decision.ok === true && persist.ok === false && ledgerRevision === 5 && state.revision === 10
    return { pass, detail: `decision.ok=${decision.ok} persisted=${persist.ok} ledgerRevision=${ledgerRevision} stateRevision=${state.revision}` }
  } finally {
    try {
      chmodSync(dir, 0o700)
    } catch {
      void 0
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// #388 - unreadable / newer state is quarantined, never silently replaced
// ===========================================================================

addCase('#388(a) fault-injected: unparseable JSON is quarantined byte-for-byte and the boot commit cannot destroy it', () => {
  const dir = tmpDir('388a')
  const path = join(dir, 'buddy-state.json')
  try {
    const original = '{ this is not json at all\n'
    writeFileSync(path, original)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const base = emptyAgentSnapshot({ bot: 'AI_M1DW' })
    const outcome = loadStateWithQuarantine({ statePath: path, base, log: cap.log, durability, stamp: 'TEST-STAMP' })
    const quarantined = readdirSync(dir).filter((f) => f.startsWith('state-quarantine-'))
    const quarantineBytes = quarantined.length === 1 ? readFileSync(join(dir, quarantined[0] as string), 'utf8') : null
    const statePathGoneAfterLoad = !existsSync(path)
    // the boot commit then writes fresh defaults; the rejected bytes must survive
    const writer = createStateWriter({ path, state: () => outcome.snapshot, log: cap.log, durability, write: writeSnapshotAtomic })
    const saved = writer.save('boot')
    const afterBoot = JSON.parse(readFileSync(path, 'utf8')) as AgentSnapshot
    const marker = cap.events.find((e) => e.event === STATE_QUARANTINED)
    const record = durability.acceptance()
    const pass =
      outcome.blocked === false &&
      outcome.quarantine?.ok === true &&
      quarantineBytes === original &&
      statePathGoneAfterLoad &&
      saved.ok === true &&
      afterBoot.revision === 1 &&
      afterBoot.milestone === null &&
      quarantineBytes === original &&
      onlyOneQuarantine(dir) &&
      marker !== undefined &&
      marker.detail.action === 'quarantined-defaults-not-persisted' &&
      record.stateQuarantines === 1 &&
      record.stateQuarantinePath === join(dir, quarantined[0] ?? '') &&
      record.markers.includes(STATE_QUARANTINED)
    return {
      pass,
      detail: `blocked=${outcome.blocked} quarantineFile=${quarantined[0] ?? 'none'} bytesPreserved=${quarantineBytes === original} bootRevision=${afterBoot.revision} markers=[${record.markers.join(',')}]`,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#388(b) fault-injected: a NEWER schemaVersion is quarantined with the version recorded', () => {
  const dir = tmpDir('388b')
  const path = join(dir, 'buddy-state.json')
  try {
    const newer = `${JSON.stringify({ schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION + 96, revision: 41, worldMemoryByKey: {}, ledger: null })}\n`
    writeFileSync(path, newer)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const outcome = loadStateWithQuarantine({ statePath: path, base: emptyAgentSnapshot({ bot: 'AI_M1DW' }), log: cap.log, durability, stamp: 'NEWER' })
    const marker = cap.events.find((e) => e.event === STATE_QUARANTINED)
    const rejected = cap.events.find((e) => e.event === 'STATE_REJECTED')
    const quarantineBytes = quarantinedBytes(dir)
    const pass =
      outcome.blocked === false &&
      outcome.snapshot.revision === 0 &&
      quarantineBytes === newer &&
      marker !== undefined &&
      marker.detail.foundVersion === AGENT_SNAPSHOT_SCHEMA_VERSION + 96 &&
      typeof marker.detail.reason === 'string' &&
      String(marker.detail.reason).includes('newer than supported') &&
      rejected !== undefined &&
      durability.acceptance().stateQuarantines === 1
    return { pass, detail: `quarantineReason=${String(marker?.detail.reason)} foundVersion=${String(marker?.detail.foundVersion)} bytesPreserved=${quarantineBytes === newer}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#388(c) ordinary case: a valid current-schema file loads with NO quarantine and NO marker', () => {
  const dir = tmpDir('388c')
  const path = join(dir, 'buddy-state.json')
  try {
    const text = validStateText(41, { milestone: 'nether_portal', bot: 'AI_M1DW' })
    writeFileSync(path, text)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const outcome = loadStateWithQuarantine({ statePath: path, base: emptyAgentSnapshot({ bot: 'AI_M1DW' }), log: cap.log, durability, stamp: 'OK' })
    const loaded = cap.events.find((e) => e.event === 'STATE_LOADED')
    const pass =
      outcome.blocked === false &&
      outcome.quarantine === null &&
      outcome.snapshot.revision === 41 &&
      outcome.snapshot.milestone === 'nether_portal' &&
      readFileSync(path, 'utf8') === text &&
      noQuarantine(dir) &&
      loaded !== undefined &&
      durability.acceptance().stateQuarantines === 0 &&
      durability.acceptance().markers.length === 0
    return { pass, detail: `revision=${outcome.snapshot.revision} milestone=${String(outcome.snapshot.milestone)} bytesUnchanged=${readFileSync(path, 'utf8') === text} quarantine=false markers=[]` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#388(d) ordinary case: legacy schemaVersion 1 still MIGRATES (no quarantine, bytes untouched)', () => {
  const dir = tmpDir('388d')
  const path = join(dir, 'buddy-state.json')
  try {
    const text = `${JSON.stringify({ schemaVersion: 1, revision: 4, worldMemoryByKey: {}, ledger: null })}\n`
    writeFileSync(path, text)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const outcome = loadStateWithQuarantine({ statePath: path, base: emptyAgentSnapshot({ bot: 'AI_M1DW' }), log: cap.log, durability, stamp: 'LEGACY' })
    const migrated = cap.events.find((e) => e.event === 'STATE_MIGRATED')
    const pass =
      outcome.blocked === false &&
      outcome.quarantine === null &&
      outcome.snapshot.revision === 4 &&
      outcome.snapshot.schemaVersion === AGENT_SNAPSHOT_SCHEMA_VERSION &&
      readFileSync(path, 'utf8') === text &&
      noQuarantine(dir) &&
      migrated !== undefined &&
      durability.acceptance().stateQuarantines === 0
    return { pass, detail: `migrated=${migrated !== undefined} revision=${outcome.snapshot.revision} schemaVersion=${outcome.snapshot.schemaVersion} bytesUnchanged=${readFileSync(path, 'utf8') === text}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#388(e) fault-injected: when the file can NOT be moved aside the host is BLOCKED (refuses to replace it)', () => {
  const dir = tmpDir('388e')
  const path = join(dir, 'buddy-state.json')
  try {
    const original = `${JSON.stringify({ schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION + 1, revision: 77 })}\n`
    writeFileSync(path, original)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    chmodSync(dir, 0o500)
    let outcome
    try {
      outcome = loadStateWithQuarantine({ statePath: path, base: emptyAgentSnapshot({ bot: 'AI_M1DW' }), log: cap.log, durability, stamp: 'BLOCKED' })
    } finally {
      chmodSync(dir, 0o700)
    }
    const failed = cap.events.find((e) => e.event === STATE_QUARANTINE_FAILED)
    const pass =
      outcome.blocked === true &&
      outcome.quarantine?.ok === false &&
      readFileSync(path, 'utf8') === original &&
      failed !== undefined &&
      failed.detail.action === 'refuse-state-commit' &&
      noQuarantine(dir)
    return { pass, detail: `blocked=${outcome.blocked} marker=${String(failed?.detail.action)} originalBytesStillAtStatePath=${readFileSync(path, 'utf8') === original}` }
  } finally {
    try {
      chmodSync(dir, 0o700)
    } catch {
      void 0
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// #378 - the lock is exclusive and reclaimable only when provably stale
// ===========================================================================

addCase('#378(a) two REAL processes race a stale lock: exactly one wins (pre-fix: both won)', async () => {
  const dir = tmpDir('378a')
  const childPath = join(dir, 'lock-child.mts')
  writeFileSync(
    childPath,
    `import { HostLock } from ${JSON.stringify(join(HERE, 'host-durability.ts'))}
const lock = new HostLock({ path: process.argv[2], log: () => {} })
const outcome = lock.acquire()
process.stdout.write(JSON.stringify(outcome) + '\\n')
await new Promise((r) => setTimeout(r, 400))
`,
  )
  try {
    const rounds: string[] = []
    let allExactlyOne = true
    for (let round = 0; round < 3; round += 1) {
      const lockPath = join(dir, `host.lock.${round}`)
      writeFileSync(lockPath, `${await deadPid()}\n`)
      const [a, b] = await Promise.all([runChild(childPath, [lockPath]), runChild(childPath, [lockPath])])
      const parsed = [a, b].map((r) => JSON.parse(r.out.trim().split('\n').at(-1) ?? '{}') as { ok?: boolean; reason?: string; holderPid?: number })
      const winners = parsed.filter((p) => p.ok === true).length
      const losers = parsed.filter((p) => p.ok === false && p.reason === 'held-by').length
      const filePid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
      const winnerPid = parsed.find((p) => p.ok === true)?.holderPid ?? null
      const ok = winners === 1 && losers === 1 && filePid === winnerPid
      if (!ok) allExactlyOne = false
      rounds.push(`r${round}:winners=${winners},reasons=[${parsed.map((p) => p.reason).join('|')}],filePid=${filePid},winnerPid=${String(winnerPid)}`)
    }
    return { pass: allExactlyOne, detail: rounds.join(' ') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#378(b) fault-injected: a provably dead holder is reclaimed with HOST_LOCK_RECLAIMED', async () => {
  const dir = tmpDir('378b')
  const lockPath = join(dir, 'host.lock')
  try {
    const stale = await deadPid()
    writeFileSync(lockPath, `${stale}\n`)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const lock = new HostLock({ path: lockPath, log: cap.log, durability, isAlive: (pid) => pid !== stale })
    const outcome = lock.acquire()
    const reclaimed = cap.events.find((e) => e.event === HOST_LOCK_RECLAIMED)
    const pass =
      outcome.ok === true &&
      outcome.reason === 'reclaimed' &&
      outcome.reclaimedFrom === stale &&
      readFileSync(lockPath, 'utf8').trim() === String(process.pid) &&
      reclaimed !== undefined &&
      reclaimed.detail.stalePid === stale &&
      durability.acceptance().lockReclaims === 1 &&
      noStaleLeftovers(dir)
    return { pass, detail: `reason=${outcome.reason} reclaimedFrom=${String(outcome.reclaimedFrom)} lockPid=${readFileSync(lockPath, 'utf8').trim()} marker=${reclaimed !== undefined}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#378(c) fault-injected: a LIVE holder is never displaced and the lock bytes stay identical', () => {
  const dir = tmpDir('378c')
  const lockPath = join(dir, 'host.lock')
  try {
    const live = 424242
    const original = `${live}\n`
    writeFileSync(lockPath, original)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const lock = new HostLock({ path: lockPath, log: cap.log, durability, isAlive: (pid) => pid === live })
    const outcome = lock.acquire()
    const lost = cap.events.find((e) => e.event === HOST_LOCK_LOST)
    const heldBy = cap.events.find((e) => e.event === 'HOST_LOCK held-by')
    const pass =
      outcome.ok === false &&
      outcome.reason === 'held-by' &&
      outcome.holderPid === live &&
      readFileSync(lockPath, 'utf8') === original &&
      heldBy !== undefined &&
      lost !== undefined &&
      durability.acceptance().lockLosses === 1 &&
      noStaleLeftovers(dir)
    return { pass, detail: `ok=${outcome.ok} holderPid=${String(outcome.holderPid)} bytesUnchanged=${readFileSync(lockPath, 'utf8') === original} lost=${lost !== undefined}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#378(d) fault-injected: a reclaim that captures a FRESH live claim restores it and loses the race', () => {
  const dir = tmpDir('378d')
  const lockPath = join(dir, 'host.lock')
  try {
    const stalePid = 424243
    const freshPid = 424244
    writeFileSync(lockPath, `${stalePid}\n`)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const lock = new HostLock({
      path: lockPath,
      log: cap.log,
      durability,
      maxAttempts: 3,
      // The second writer claims the lock between our staleness read and the
      // take-away rename: this is the exact interleaving that made the old
      // check-then-write reclaim let both residents win.
      isAlive: (pid) => {
        if (pid === stalePid) {
          writeFileSync(lockPath, `${freshPid}\n`)
          return false
        }
        return pid === freshPid
      },
    })
    const outcome = lock.acquire()
    const lost = cap.events.find((e) => e.event === HOST_LOCK_LOST)
    const pass =
      outcome.ok === false &&
      outcome.reason === 'held-by' &&
      outcome.holderPid === freshPid &&
      readFileSync(lockPath, 'utf8').trim() === String(freshPid) &&
      lost !== undefined &&
      lost.detail.reason === 'reclaim-verify-found-live-holder' &&
      durability.acceptance().lockLosses === 1 &&
      durability.acceptance().lockReclaims === 0 &&
      noStaleLeftovers(dir)
    return {
      pass,
      detail: `ok=${outcome.ok} holderPid=${String(outcome.holderPid)} lockPid=${readFileSync(lockPath, 'utf8').trim()} lostReason=${String(lost?.detail.reason)} staleLeftovers=${String(!noStaleLeftovers(dir))}`,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#378(f) fault-injected: a non-empty lock file with no parseable pid is NOT reclaimed (fail closed)', () => {
  const dir = tmpDir('378f')
  const lockPath = join(dir, 'host.lock')
  try {
    const garbage = 'not-a-pid\n'
    writeFileSync(lockPath, garbage)
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const lock = new HostLock({ path: lockPath, log: cap.log, durability, maxAttempts: 3, isAlive: () => false })
    const outcome = lock.acquire()
    const lost = cap.events.find((e) => e.event === HOST_LOCK_LOST)
    const pass =
      outcome.ok === false &&
      outcome.reason === 'held-by' &&
      readFileSync(lockPath, 'utf8') === garbage &&
      lost !== undefined &&
      lost.detail.reason === 'unreadable-lock' &&
      durability.acceptance().lockReclaims === 0 &&
      durability.acceptance().lockLosses === 1
    return { pass, detail: `ok=${outcome.ok} reason=${String(lost?.detail.reason)} bytesUnchanged=${readFileSync(lockPath, 'utf8') === garbage} reclaims=${durability.acceptance().lockReclaims}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#378(e) ordinary case: exclusive create -> release -> re-acquire, with the marker lines tools already consume', () => {
  const dir = tmpDir('378e')
  const lockPath = join(dir, 'host.lock')
  try {
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const lock = new HostLock({ path: lockPath, log: cap.log, durability, isAlive: () => false })
    const first = lock.acquire()
    const held = existsSync(lockPath) && readFileSync(lockPath, 'utf8').trim() === String(process.pid)
    const report = lock.report()
    lock.release()
    const releasedEvent = cap.events.find((e) => e.event === 'HOST_LOCK released')
    const goneAfterRelease = !existsSync(lockPath)
    const second = lock.acquire()
    const pass =
      first.ok === true &&
      first.reason === 'acquired' &&
      held &&
      report.acquiredByThisProcess &&
      report.singleInstance &&
      releasedEvent !== undefined &&
      goneAfterRelease &&
      second.ok === true &&
      second.reason === 'acquired' &&
      durability.acceptance().lockReclaims === 0 &&
      durability.acceptance().lockLosses === 0
    lock.release()
    return { pass, detail: `first=${first.reason} reportSingleInstance=${report.singleInstance} releasedMarker=${releasedEvent !== undefined} second=${second.reason}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// #380 - the boot commit runs only under the lock
// ===========================================================================

addCase('#380(a) reproduced mechanism: the PRE-FIX order (save-then-lock) lets a losing resident clobber the winner', () => {
  const dir = tmpDir('380a')
  const path = join(dir, 'buddy-state.json')
  const lockPath = join(dir, 'host.lock')
  try {
    const cap = capture()
    // The loser loaded the state BEFORE the winner's latest commit (rev 12, ledger 5).
    const loserSnapshot = emptyAgentSnapshot({ revision: 12, bot: 'AI_M1DW', ledger: null })
    writeSnapshotAtomic(path, loserSnapshot)
    // The winner then commits rev 13 with a NEWER ledger (counter 9).
    const winnerState = emptyAgentSnapshot({ revision: 13, bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, winnerState)
    const winnerBytes = readFileSync(path, 'utf8')
    const winnerLock = new HostLock({ path: lockPath, log: cap.log, isAlive: () => true })
    winnerLock.acquire()
    const loserWriter = createStateWriter({ path, state: () => loserSnapshot, log: cap.log, write: writeSnapshotAtomic })
    // PRE-FIX agent-runner.mts order: saveState('boot') ran BEFORE acquireHostLock().
    loserWriter.save('boot')
    const clobbered = readFileSync(path, 'utf8')
    const pass = clobbered !== winnerBytes && (JSON.parse(clobbered) as AgentSnapshot).revision === 13
    winnerLock.release()
    return { pass, detail: `winnerBytesOverwritten=${clobbered !== winnerBytes} diskRevisionAfterLoserBoot=${(JSON.parse(clobbered) as AgentSnapshot).revision}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#380(b) fixed: openResidentBoot refuses the loser and leaves the winner state byte-identical', () => {
  const dir = tmpDir('380b')
  const path = join(dir, 'buddy-state.json')
  const lockPath = join(dir, 'host.lock')
  try {
    const cap = capture()
    const durability = new HostDurabilityLedger()
    const loserSnapshot = emptyAgentSnapshot({ revision: 12, bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, loserSnapshot)
    const winnerState = emptyAgentSnapshot({ revision: 13, bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, winnerState)
    const winnerBytes = readFileSync(path, 'utf8')
    const winnerLock = new HostLock({ path: lockPath, log: cap.log, isAlive: () => true })
    winnerLock.acquire()
    const loserLock = new HostLock({ path: lockPath, log: cap.log, durability, pid: 999001, isAlive: (pid) => pid === process.pid })
    const loserWriter = createStateWriter({ path, state: () => loserSnapshot, log: cap.log, durability, write: writeSnapshotAtomic })
    const boot = openResidentBoot({ lock: loserLock, saveBootState: () => loserWriter.save('boot'), log: cap.log })
    const pass =
      boot.ok === false &&
      boot.reason === 'lock-held-by' &&
      boot.bootSave === null &&
      readFileSync(path, 'utf8') === winnerBytes &&
      loserSnapshot.revision === 12 &&
      durability.acceptance().lockLosses === 1
    winnerLock.release()
    return { pass, detail: `ok=${boot.ok} reason=${boot.reason} bootSave=${String(boot.bootSave)} bytesUnchanged=${readFileSync(path, 'utf8') === winnerBytes}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#380(c) ordinary case: the lock owner commits the boot revision exactly once', () => {
  const dir = tmpDir('380c')
  const path = join(dir, 'buddy-state.json')
  const lockPath = join(dir, 'host.lock')
  try {
    const cap = capture()
    const snapshot = emptyAgentSnapshot({ revision: 3, bot: 'AI_M1DW' })
    writeSnapshotAtomic(path, snapshot)
    const lock = new HostLock({ path: lockPath, log: cap.log, isAlive: () => false })
    const writer = createStateWriter({ path, state: () => snapshot, log: cap.log, write: writeSnapshotAtomic })
    let saves = 0
    const boot = openResidentBoot({
      lock,
      saveBootState: () => {
        saves += 1
        return writer.save('boot')
      },
      log: cap.log,
    })
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentSnapshot
    const pass = boot.ok === true && saves === 1 && boot.bootSave?.ok === true && parsed.revision === 4 && lock.acquired
    lock.release()
    return { pass, detail: `ok=${boot.ok} saves=${saves} diskRevision=${parsed.revision}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// #381 - a fatal revokes the actuation lease and exits non-zero
// ===========================================================================

function fatalChildSource(trigger: string): string {
  return `import { ActuationLeaseManager } from ${JSON.stringify(join(HERE, 'resident-safety.ts'))}
import { FATAL_SHUTDOWN, createFatalHandlers } from ${JSON.stringify(join(HERE, 'host-durability.ts'))}
const lease = new ActuationLeaseManager()
const log = (event, detail) => process.stdout.write(event + ' ' + JSON.stringify(detail ?? {}) + '\\n')
lease.acquire('gen-live', log)
const handlers = createFatalHandlers({
  log,
  markShuttingDown: () => log('SHUTTING_DOWN', {}),
  revokeLease: (reason) => lease.revoke(reason, log),
  exit: (code) => { log('EXIT', { code }); process.exit(code) },
})
process.on('uncaughtException', (error) => handlers.uncaughtException(error))
process.on('unhandledRejection', (reason) => handlers.unhandledRejection(reason))
log('LEASE_ACTIVE', { activeId: lease.activeId })
${trigger}
`
}

addCase('#381(a) fault-injected: a real uncaught exception revokes the lease and exits 1', async () => {
  const dir = tmpDir('381a')
  const script = join(dir, 'fatal-child.mts')
  try {
    writeFileSync(script, fatalChildSource("setTimeout(() => log('STILL_RUNNING', {}), 1500)\nthrow new Error('injected uncaught fatal')"))
    const run = await runChild(script, [], 4000)
    const pass =
      run.code === 1 &&
      run.out.includes('LEASE_ACQUIRED') &&
      run.out.includes('LEASE_REVOKED') &&
      run.out.includes('fatal:uncaughtException') &&
      run.out.includes(FATAL_SHUTDOWN) &&
      run.out.includes('lease-revoked-exit-nonzero') &&
      !run.out.includes('STILL_RUNNING')
    return { pass, detail: `exitCode=${String(run.code)} leaseRevoked=${run.out.includes('LEASE_REVOKED')} fatalMarker=${run.out.includes(FATAL_SHUTDOWN)} ranAfterFatal=${run.out.includes('STILL_RUNNING')}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#381(b) fault-injected: a real unhandled rejection is fatal too', async () => {
  const dir = tmpDir('381b')
  const script = join(dir, 'reject-child.mts')
  try {
    writeFileSync(script, fatalChildSource("setTimeout(() => log('STILL_RUNNING', {}), 1500)\nvoid Promise.reject(new Error('injected rejection'))"))
    const run = await runChild(script, [], 4000)
    const pass =
      run.code === 1 &&
      run.out.includes('LEASE_REVOKED') &&
      run.out.includes('fatal:unhandledRejection') &&
      run.out.includes(FATAL_SHUTDOWN) &&
      !run.out.includes('STILL_RUNNING')
    return { pass, detail: `exitCode=${String(run.code)} reason=unhandledRejection fatalMarker=${run.out.includes(FATAL_SHUTDOWN)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#381(c) ordinary case: a handled rejection does NOT fire the fatal path', async () => {
  const dir = tmpDir('381c')
  const script = join(dir, 'handled-child.mts')
  try {
    writeFileSync(script, fatalChildSource("void Promise.reject(new Error('handled')).catch(() => log('HANDLED', {}))\nsetTimeout(() => { log('NO_FATAL', { activeId: lease.activeId }); process.exit(0) }, 250)"))
    const run = await runChild(script, [], 4000)
    const pass = run.code === 0 && run.out.includes('NO_FATAL') && !run.out.includes(FATAL_SHUTDOWN) && run.out.includes('LEASE_ACQUIRED')
    return { pass, detail: `exitCode=${String(run.code)} noFatal=${!run.out.includes(FATAL_SHUTDOWN)} leaseStillActive=${run.out.includes('NO_FATAL')}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================
// #384 - the server closes before the lock is released
// ===========================================================================

addCase('#384(a) the control server is closed (awaited) BEFORE the lock is released; the socket is gone', async () => {
  const dir = tmpDir('384a')
  const sock = join(dir, 'control.sock')
  const lockPath = join(dir, 'host.lock')
  let server: Server | null = null
  try {
    server = createServer(() => undefined)
    await new Promise<void>((resolve) => (server as Server).listen(sock, () => resolve()))
    const cap = capture()
    const lock = new HostLock({ path: lockPath, log: cap.log, isAlive: () => false })
    lock.acquire()
    const order: string[] = []
    const outcome = await runShutdownSequence({
      log: cap.log,
      alreadyShuttingDown: () => false,
      markShuttingDown: () => order.push('mark'),
      quiesce: () => { order.push('quiesce') },
      writeAcceptance: () => {
        order.push('acceptance')
        return 'acceptance.json'
      },
      persistState: () => {
        order.push('persist')
        return durableWriteLanded('shutdown', 4)
      },
      disposeGeneration: () => order.push('dispose'),
      disconnect: () => order.push('disconnect'),
      closeServer: async () => {
        order.push('closeServer:start')
        const closed = await closeControlServer(server, { socketPath: sock })
        order.push('closeServer:done')
        return closed
      },
      releaseLock: () => {
        order.push('releaseLock')
        lock.release()
      },
      exit: (code) => order.push(`exit:${code}`),
      exitDelayMs: 0,
    })
    const connectable = await isConnectable(sock)
    const pass =
      outcome.ran === true &&
      outcome.serverClosed === true &&
      outcome.lockReleased === true &&
      order.indexOf('closeServer:done') < order.indexOf('releaseLock') &&
      order.indexOf('releaseLock') < order.indexOf('exit:0') &&
      !existsSync(sock) &&
      !existsSync(lockPath) &&
      connectable === false
    return { pass, detail: `order=[${order.join('>')}] socketGone=${!existsSync(sock)} lockGone=${!existsSync(lockPath)} socketConnectable=${connectable}` }
  } finally {
    if (server !== null) await new Promise<void>((resolve) => (server as Server).close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#384(b) fault-injected: an open control client cannot delay the close past the bound, and the lock still releases', async () => {
  const dir = tmpDir('384b')
  const sock = join(dir, 'control.sock')
  const lockPath = join(dir, 'host.lock')
  let server: Server | null = null
  let client: ReturnType<typeof connect> | null = null
  try {
    server = createServer(() => undefined)
    await new Promise<void>((resolve) => (server as Server).listen(sock, () => resolve()))
    client = connect(sock)
    await new Promise<void>((resolve) => client?.on('connect', () => resolve()))
    const cap = capture()
    const lock = new HostLock({ path: lockPath, log: cap.log, isAlive: () => false })
    lock.acquire()
    const order: string[] = []
    const started = Date.now()
    const outcome = await runShutdownSequence({
      log: cap.log,
      alreadyShuttingDown: () => false,
      markShuttingDown: () => order.push('mark'),
      quiesce: () => { order.push('quiesce') },
      writeAcceptance: () => 'acceptance.json',
      persistState: () => durableWriteLanded('shutdown', 1),
      disposeGeneration: () => undefined,
      disconnect: () => undefined,
      closeServer: () => closeControlServer(server, { socketPath: sock, timeoutMs: 150 }),
      releaseLock: () => {
        order.push('releaseLock')
        lock.release()
      },
      exit: (code) => order.push(`exit:${code}`),
      exitDelayMs: 0,
    })
    const elapsed = Date.now() - started
    const pass = outcome.ran && outcome.lockReleased && order.includes('releaseLock') && !existsSync(lockPath) && elapsed < 2000
    return { pass, detail: `serverClosed=${outcome.serverClosed} elapsedMs=${elapsed} lockReleased=${outcome.lockReleased} order=[${order.join('>')}]` }
  } finally {
    client?.destroy()
    if (server !== null) await new Promise<void>((resolve) => (server as Server).close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('#384(c) ordinary case: a re-entrant shutdown call is a no-op (one exit, one release)', async () => {
  const cap = capture()
  const order: string[] = []
  let down = false
  const steps = {
    log: cap.log,
    alreadyShuttingDown: () => down,
    markShuttingDown: () => {
      down = true
      order.push('mark')
    },
    quiesce: () => { order.push('quiesce') },
    writeAcceptance: () => 'acceptance.json',
    persistState: () => durableWriteLanded('shutdown', 1),
    disposeGeneration: () => undefined,
    disconnect: () => undefined,
    closeServer: async () => {
      order.push('closeServer')
      return true
    },
    releaseLock: () => order.push('releaseLock'),
    exit: (code: number) => order.push(`exit:${code}`),
    exitDelayMs: 0,
  }
  const first = await runShutdownSequence(steps)
  const second = await runShutdownSequence(steps)
  const pass =
    first.ran === true &&
    second.ran === false &&
    order.filter((step) => step === 'exit:0').length === 1 &&
    order.filter((step) => step === 'releaseLock').length === 1
  return { pass, detail: `first.ran=${first.ran} second.ran=${second.ran} exits=${order.filter((s) => s === 'exit:0').length} releases=${order.filter((s) => s === 'releaseLock').length}` }
})

addCase('#384(d) fault-injected: a throwing shutdown step never skips close/release/exit', async () => {
  const cap = capture()
  const order: string[] = []
  const outcome = await runShutdownSequence({
    log: cap.log,
    alreadyShuttingDown: () => false,
    markShuttingDown: () => order.push('mark'),
    quiesce: () => {
      throw new Error('injected quiesce failure')
    },
    writeAcceptance: () => {
      throw new Error('injected acceptance failure')
    },
    persistState: () => {
      throw new Error('injected persist failure')
    },
    disposeGeneration: () => {
      throw new Error('injected dispose failure')
    },
    disconnect: () => {
      throw new Error('injected disconnect failure')
    },
    closeServer: async () => {
      order.push('closeServer')
      return true
    },
    releaseLock: () => order.push('releaseLock'),
    exit: (code: number) => order.push(`exit:${code}`),
    exitDelayMs: 0,
  })
  const errors = cap.events.filter((e) => e.event === 'ERROR').length
  const pass = outcome.ran && outcome.serverClosed && outcome.lockReleased && order.join('>') === 'mark>closeServer>releaseLock>exit:0' && errors >= 5
  return { pass, detail: `order=[${order.join('>')}] errors=${errors}` }
})

addCase('#384(e) shutdown awaits bounded generation quiescence before writing or disposing', async () => {
  const cap = capture()
  const order: string[] = []
  let releaseQuiesce: () => void = () => {}
  const quiesceGate = new Promise<void>((resolve) => { releaseQuiesce = resolve })
  const shutdown = runShutdownSequence({
    log: cap.log,
    alreadyShuttingDown: () => false,
    markShuttingDown: () => order.push('mark'),
    quiesce: async () => { order.push('quiesce:start'); await quiesceGate; order.push('quiesce:terminal') },
    writeAcceptance: () => { order.push('acceptance'); return 'acceptance.json' },
    persistState: () => { order.push('persist'); return durableWriteLanded('shutdown', 1) },
    disposeGeneration: () => order.push('dispose'),
    disconnect: () => order.push('disconnect'),
    closeServer: async () => { order.push('closeServer'); return true },
    releaseLock: () => order.push('releaseLock'),
    exit: (code) => order.push(`exit:${code}`),
    exitDelayMs: 0,
  })
  await Promise.resolve()
  const held = order.join('>') === 'mark>quiesce:start'
  releaseQuiesce()
  const outcome = await shutdown
  const expected = 'mark>quiesce:start>quiesce:terminal>acceptance>persist>dispose>disconnect>closeServer>releaseLock>exit:0'
  const pass = held && outcome.ran && order.join('>') === expected
  return { pass, detail: `held=${held} order=${order.join('>')}` }
})

// ===========================================================================
// mirrored markers / acceptance record
// ===========================================================================

addCase('mirror: the five durability outcomes are counted AND named in the acceptance record shape', () => {
  const durability = new HostDurabilityLedger()
  durability.record(STATE_WRITE_FAILED, { event: 'boot' })
  durability.record(STATE_QUARANTINED, { reason: 'unparseable JSON' })
  durability.record(HOST_LOCK_RECLAIMED, { stalePid: 1 })
  durability.record(HOST_LOCK_LOST, { holderPid: 2 })
  durability.record(FATAL_SHUTDOWN, { where: 'uncaughtException' })
  durability.setQuarantinePath('/tmp/state-quarantine.json')
  const record = durability.acceptance()
  const typed: AcceptanceRecord = {
    record: 'acceptance',
    runId: 'run-test',
    ts: new Date().toISOString(),
    gitCommit: null,
    generationHash: null,
    generationId: null,
    contractVersion: 3,
    stateSchemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
    stateRevision: 1,
    dependencies: {},
    serverId: '127.0.0.1:25565',
    dimension: 'minecraft:overworld',
    levelName: null,
    worldEpoch: 1,
    seed: null,
    botUsername: 'AI_M1DW',
    startPosition: null,
    mode: 'llm',
    goalComplete: false,
    wedge: false,
    reconnects: 0,
    reloads: 0,
    reloadsChangedHash: 0,
    reloadsSkippedUnchanged: 0,
    reloadsFailed: 0,
    freezeCycles: 0,
    listenerBaseline: {},
    listenerExpected: {},
    listenerCurrent: {},
    listenerLeak: false,
    worldMemoryKeys: [],
    durability: record,
  }
  // the same marker names the host logs must be what the acceptance record shows
  const expectedMarkers = [FATAL_SHUTDOWN, HOST_LOCK_LOST, HOST_LOCK_RECLAIMED, STATE_QUARANTINED, STATE_WRITE_FAILED].sort()
  const pass =
    record.writeFailures === 1 &&
    record.stateQuarantines === 1 &&
    record.lockReclaims === 1 &&
    record.lockLosses === 1 &&
    record.fatalShutdowns === 1 &&
    JSON.stringify(record.markers) === JSON.stringify(expectedMarkers) &&
    record.stateQuarantinePath === '/tmp/state-quarantine.json' &&
    typed.durability?.fatalShutdowns === 1
  return { pass, detail: `markers=[${record.markers.join(',')}] counts=w${record.writeFailures}/q${record.stateQuarantines}/r${record.lockReclaims}/l${record.lockLosses}/f${record.fatalShutdowns}` }
})

addCase('mirror: agent-runner writes the durability mirror into the acceptance record and the control report', () => {
  const source = readFileSync(join(HERE, 'agent-runner.mts'), 'utf8')
  const acceptanceIndex = source.indexOf('durability: durability.acceptance(),')
  const reportIndex = source.indexOf('durability: durability.acceptance(),', acceptanceIndex + 1)
  const bootSaveIndex = source.indexOf("saveBootState: () => saveState('boot')")
  const bootLogIndex = source.indexOf("log('BOOT', {")
  const pass =
    acceptanceIndex > 0 &&
    reportIndex > acceptanceIndex &&
    bootSaveIndex > 0 &&
    bootSaveIndex < bootLogIndex &&
    source.includes('openResidentBoot({ lock: hostLock') &&
    source.includes('await shutdown(') &&
    !source.includes("saveState('boot')\nlog('BOOT'")
  return { pass, detail: `acceptanceMirror=${acceptanceIndex > 0} reportMirror=${reportIndex > acceptanceIndex} bootSaveUnderLock=${bootSaveIndex > 0 && bootSaveIndex < bootLogIndex}` }
})

function noQuarantine(dir: string): boolean {
  return readdirSync(dir).every((f) => !f.startsWith('state-quarantine-'))
}
function onlyOneQuarantine(dir: string): boolean {
  return readdirSync(dir).filter((f) => f.startsWith('state-quarantine-')).length === 1
}
function quarantinedBytes(dir: string): string | null {
  const files = readdirSync(dir).filter((f) => f.startsWith('state-quarantine-'))
  return files.length === 1 ? readFileSync(join(dir, files[0] as string), 'utf8') : null
}
function noStaleLeftovers(dir: string): boolean {
  return readdirSync(dir).every((f) => !f.includes('.stale-'))
}
async function isConnectable(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(sock)
    c.on('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.on('error', () => resolve(false))
  })
}

let failures = 0
process.stdout.write('host durability contract (#378/#379/#380/#381/#384/#388)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  let observed: { pass: boolean; detail: string }
  try {
    observed = await testCase.run()
  } catch (error) {
    observed = { pass: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} host-durability cases passed\n`)
if (failures > 0) process.exit(1)
