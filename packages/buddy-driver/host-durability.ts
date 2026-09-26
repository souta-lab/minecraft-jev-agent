// host-durability.ts - HOST-layer durability primitives.
//
// The HOST's durable-commit claims used to be unrepresentable failures:
//
//   #379  saveState() bumped the revision and swallowed the write error, while
//         `commitPendingProposals` typed `save` as `(event)=>void` and reported
//         `writes: 1`; a PASS could rest on a ledger that never landed.
//   #388  loadState() returned the default snapshot for an unparseable or
//         NEWER-schema file and the boot save then overwrote it: the durable
//         memory the M2/M3 gates read was destroyed with no quarantine.
//   #378  the lock was check-then-write with no exclusive create, so two
//         residents could both win; stale reclaim was not race-safe.
//   #380  saveState('boot') ran BEFORE acquireHostLock, so a losing resident
//         overwrote the winner's state.
//   #381  fatal handlers only logged: the lease stayed active and the process
//         did not exit non-zero.
//   #384  releaseHostLock() ran ~800 ms before exit with no server close.
//
// Every primitive here takes its side-effecting dependency by injection (`write`,
// `isAlive`, `exit`, `closeServer`) so a fixture can drive a REAL failing
// dependency (read-only directory, injected dead pid, two OS processes) instead of
// re-implementing the algorithm under test. Markers are mirrored into
// `HostDurabilityRecord` so the run's acceptance record shows them.
import { existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Server } from 'node:net'
import type { AgentSnapshot, HostDurabilityEventJson, HostDurabilityRecord } from './resident-types.ts'
import type { SnapshotLog } from './state-snapshot.ts'
import { bumpRevision, restoreAgentSnapshot, validateAgentSnapshot } from './state-snapshot.ts'

// ---------------------------------------------------------------------------
// markers (mirrored into the acceptance record; greppable in buddy.log)
// ---------------------------------------------------------------------------
/** A durable write was attempted and did NOT land. */
export const STATE_WRITE_FAILED = 'STATE_WRITE_FAILED'
/** An unreadable/newer-schema state file was moved aside and recorded. */
export const STATE_QUARANTINED = 'STATE_QUARANTINED'
/** The rejected state file could NOT be moved aside: the host refuses to boot. */
export const STATE_QUARANTINE_FAILED = 'STATE_QUARANTINE_FAILED'
/** A provably stale host lock was taken over (exclusive create won after verify). */
export const HOST_LOCK_RECLAIMED = 'HOST_LOCK_RECLAIMED'
/** A live holder / foreign pid was found: this resident does not own the lock. */
export const HOST_LOCK_LOST = 'HOST_LOCK_LOST'
/** A fatal handler revoked the actuation lease and exited non-zero. */
export const FATAL_SHUTDOWN = 'FATAL_SHUTDOWN'

/** Run-scoped marker ledger: counts + the exact marker names observed. */
export class HostDurabilityLedger {
  private readonly counts = new Map<string, number>()
  private last: HostDurabilityEventJson | null = null
  private quarantinePath: string | null = null

  record(marker: string, detail: Record<string, unknown> = {}): void {
    this.counts.set(marker, (this.counts.get(marker) ?? 0) + 1)
    this.last = { marker, at: new Date().toISOString(), detail }
  }

  setQuarantinePath(path: string | null): void {
    this.quarantinePath = path
  }

  count(marker: string): number {
    return this.counts.get(marker) ?? 0
  }

  acceptance(): HostDurabilityRecord {
    return {
      writeFailures: this.count(STATE_WRITE_FAILED),
      stateQuarantines: this.count(STATE_QUARANTINED),
      lockReclaims: this.count(HOST_LOCK_RECLAIMED),
      lockLosses: this.count(HOST_LOCK_LOST),
      fatalShutdowns: this.count(FATAL_SHUTDOWN),
      markers: [...this.counts.keys()].sort(),
      lastEvent: this.last === null ? null : { ...this.last, detail: { ...this.last.detail } },
      stateQuarantinePath: this.quarantinePath,
    }
  }
}

// ---------------------------------------------------------------------------
// #379 durable write: a failed write is a first-class, reported outcome
// ---------------------------------------------------------------------------

export interface DurableWriteOutcome {
  /** true only when the snapshot bytes landed durably. */
  ok: boolean
  event: string
  /** revision in memory after the attempt (unchanged when the write failed). */
  revision: number
  /** revision that is on disk (equals `revision` on success, previous on failure). */
  durableRevision: number
  error: string | null
}

export interface StateWriterOptions {
  path: string
  state: () => AgentSnapshot
  log: SnapshotLog
  /** the durable write primitive (normally `writeSnapshotAtomic`). */
  write: (statePath: string, state: AgentSnapshot, suffix: string) => void
  suffix?: string
  durability?: HostDurabilityLedger
  /** when set, a schema mismatch is logged before the commit. */
  expectedSchemaVersion?: number
  now?: () => number
}

export interface StateWriter {
  save(event?: string): DurableWriteOutcome
}

/** Encode "this write landed at `revision`" (callers that wrote with their own primitive). */
export function durableWriteLanded(event: string, revision: number): DurableWriteOutcome {
  return { ok: true, event, revision, durableRevision: revision, error: null }
}

/**
 * The HOST's only durable-state commit primitive. Invariant: the revision advances
 * ONLY when the write landed. A failed write rolls the in-memory commit marker back
 * to the state that is still on disk, removes the half-written tmp file and returns
 * `ok: false` - so a caller can never report `writes: 1` or advance `ledgerRevision`
 * on a write that did not happen.
 */
export function createStateWriter(options: StateWriterOptions): StateWriter {
  const suffix = options.suffix ?? '.tmp'
  const now = options.now ?? (() => Date.now())
  const tmpPath = `${options.path}${suffix}`
  return {
    save(event = 'save'): DurableWriteOutcome {
      const snapshot = options.state()
      if (options.expectedSchemaVersion !== undefined && snapshot.schemaVersion !== options.expectedSchemaVersion) {
        options.log('STATE_SCHEMA_MISMATCH', {
          event,
          schemaVersion: snapshot.schemaVersion,
          expected: options.expectedSchemaVersion,
          action: 'coerce-and-commit',
        })
      }
      const previous = { revision: snapshot.revision, updatedAt: snapshot.updatedAt, schemaVersion: snapshot.schemaVersion }
      const attemptedRevision = bumpRevision(snapshot, now())
      try {
        options.write(options.path, snapshot, suffix)
      } catch (error) {
        // No durable write happened: restore the exact in-memory commit marker so
        // memory and disk agree, then report the failure instead of hiding it.
        snapshot.revision = previous.revision
        snapshot.updatedAt = previous.updatedAt
        snapshot.schemaVersion = previous.schemaVersion
        try {
          rmSync(tmpPath, { force: true })
        } catch {
          void 0
        }
        const message = error instanceof Error ? error.message : String(error)
        options.log(STATE_WRITE_FAILED, {
          event,
          path: options.path,
          revision: previous.revision,
          attemptedRevision,
          message,
          action: 'not-committed',
        })
        options.durability?.record(STATE_WRITE_FAILED, { event, message, attemptedRevision })
        return { ok: false, event, revision: previous.revision, durableRevision: previous.revision, error: message }
      }
      return { ok: true, event, revision: attemptedRevision, durableRevision: attemptedRevision, error: null }
    },
  }
}

// ---------------------------------------------------------------------------
// #388 quarantine: unreadable / newer state is moved aside, never replaced
// ---------------------------------------------------------------------------

export interface QuarantineResult {
  ok: boolean
  /** absolute path of the moved-aside file (null when the move failed). */
  path: string | null
  reason: string
}

export interface QuarantineOptions {
  statePath: string
  reason: string
  log: SnapshotLog
  durability?: HostDurabilityLedger
  /** directory for the quarantine file; defaults to the state file's directory */
  dir?: string
  foundVersion?: number | null
  detail?: Record<string, unknown>
  stamp?: string
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'rejected'

/**
 * Move a rejected state file aside with the reason recorded. The original bytes
 * are preserved verbatim under `<dir>/state-quarantine-<reason>-<stamp>.json`; the
 * state path is left ABSENT so the next boot commit cannot be mistaken for the
 * rejected file. When the move itself fails the host must NOT overwrite the file:
 * `ok: false` is returned and `loadStateWithQuarantine` reports `blocked`.
 */
export function quarantineStateFile(options: QuarantineOptions): QuarantineResult {
  const dir = options.dir ?? dirname(options.statePath)
  const stamp = (options.stamp ?? new Date().toISOString()).replace(/[:.]/g, '-')
  const target = join(dir, `state-quarantine-${slug(options.reason)}-${stamp}-p${process.pid}.json`)
  try {
    renameSync(options.statePath, target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.log(STATE_QUARANTINE_FAILED, {
      reason: options.reason,
      foundVersion: options.foundVersion ?? null,
      path: options.statePath,
      target,
      message,
      action: 'refuse-state-commit',
    })
    options.durability?.record(STATE_QUARANTINE_FAILED, { reason: options.reason, message, target })
    return { ok: false, path: null, reason: options.reason }
  }
  options.log(STATE_QUARANTINED, {
    reason: options.reason,
    foundVersion: options.foundVersion ?? null,
    path: target,
    original: options.statePath,
    action: 'quarantined-defaults-not-persisted',
    ...(options.detail ?? {}),
  })
  options.durability?.record(STATE_QUARANTINED, { reason: options.reason, foundVersion: options.foundVersion ?? null, path: target })
  options.durability?.setQuarantinePath(target)
  return { ok: true, path: target, reason: options.reason }
}

export interface StateLoadOutcome {
  snapshot: AgentSnapshot
  quarantine: QuarantineResult | null
  /**
   * true when the state file was rejected AND could not be moved aside. The caller
   * MUST refuse to boot: committing defaults would silently replace the durable
   * memory that could not be preserved.
   */
  blocked: boolean
}

export interface StateLoadOptions {
  statePath: string
  base: AgentSnapshot
  log: SnapshotLog
  durability?: HostDurabilityLedger
  /** directory for the quarantine file; defaults to the state file's directory */
  dir?: string
  stamp?: string
}

/**
 * The one HOST state-load path: unparseable JSON and any schema rejection
 * (newer-than-supported, unknown, non-object) quarantine the file and fall back to
 * `base` in memory. Valid files restore exactly as before (no quarantine, no
 * marker) so the ordinary path is unchanged.
 */
export function loadStateWithQuarantine(options: StateLoadOptions): StateLoadOutcome {
  const { statePath: path, base, log } = options
  if (!existsSync(path)) return { snapshot: base, quarantine: null, blocked: false }
  const quarantine = (reason: string, foundVersion: number | null, detail?: Record<string, unknown>): QuarantineResult =>
    quarantineStateFile({
      statePath: path,
      reason,
      log,
      ...(options.durability === undefined ? {} : { durability: options.durability }),
      ...(options.dir === undefined ? {} : { dir: options.dir }),
      ...(options.stamp === undefined ? {} : { stamp: options.stamp }),
      foundVersion,
      ...(detail === undefined ? {} : { detail }),
    })

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const moved = quarantine('unreadable state file', null, { message })
    return { snapshot: base, quarantine: moved, blocked: !moved.ok }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('STATE_REJECTED', { reason: 'unparseable JSON', message, action: 'quarantine' })
    const moved = quarantine('unparseable JSON', null, { message })
    return { snapshot: base, quarantine: moved, blocked: !moved.ok }
  }

  const validation = validateAgentSnapshot(raw)
  // `restoreAgentSnapshot` keeps the class-A audit lines (STATE_LOADED /
  // STATE_MIGRATED / STATE_REJECTED) and strips class-B truth. It returns `base`
  // for a rejected file, which is exactly what we persist as the in-memory default
  // AFTER the rejected bytes have been quarantined.
  const snapshot = restoreAgentSnapshot(raw, base, log)
  if (!validation.ok) {
    const moved = quarantine(validation.rejected ?? 'rejected state', validation.foundVersion)
    return { snapshot, quarantine: moved, blocked: !moved.ok }
  }
  return { snapshot, quarantine: null, blocked: false }
}

// ---------------------------------------------------------------------------
// #378/#380 the host lock: exclusive create + race-safe stale reclaim
// ---------------------------------------------------------------------------

export type HostLockReason = 'acquired' | 'reclaimed' | 'held-by' | 'error'

export interface HostLockOutcome {
  ok: boolean
  reason: HostLockReason
  holderPid: number | null
  /** pid the lock was reclaimed from (null when this process created it) */
  reclaimedFrom: number | null
  path: string
  attempts: number
  error?: string
}

export interface HostLockReport {
  path: string
  present: boolean
  filePid: number | null
  acquiredByThisProcess: boolean
  pid: number
  singleInstance: boolean
  outcome: HostLockReason | 'none'
  reclaimedFrom: number | null
}

export interface HostLockOptions {
  path: string
  log: SnapshotLog
  durability?: HostDurabilityLedger
  pid?: number
  /**
   * Liveness probe for a lock holder. Defaults to the conservative real probe: a
   * pid that cannot be shown DEAD is treated as alive, so a lock is never
   * reclaimed on the strength of a missing injectable.
   */
  isAlive?: (pid: number) => boolean
  maxAttempts?: number
}

/**
 * Conservative liveness probe. `EPERM` means the pid exists but is not ours, so it
 * is ALIVE; only `ESRCH` (or an invalid pid) proves the holder is gone.
 */
export function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type HolderRead = { kind: 'ok'; pid: number | null; raw: string } | { kind: 'missing' } | { kind: 'error'; message: string }

/**
 * The single-instance host lock.
 *
 * Claiming is `writeFileSync(..., {flag:'wx'})`: the O_EXCL create is the mutual
 * exclusion primitive, so two residents starting at the same instant cannot both
 * win (the loser re-reads the file and sees a live holder).
 *
 * Reclaiming a stale lock is race-safe in the same way: the stale file is taken
 * away with an atomic rename, the TAKEN BYTES are re-read and verified, and only
 * then does the loop retry the exclusive create. If the rename captured a fresh
 * claim instead (another resident reclaimed in the window), the live pid is
 * detected, the lock file is restored with an exclusive hard link, and this
 * process loses with `HOST_LOCK_LOST`.
 */
export class HostLock {
  private readonly path: string
  private readonly log: SnapshotLog
  private readonly durability: HostDurabilityLedger | undefined
  private readonly pid: number
  private readonly isAlive: (pid: number) => boolean
  private readonly maxAttempts: number
  private claimed = false
  private lastOutcome: HostLockReason | 'none' = 'none'
  private reclaimedFrom: number | null = null
  private lastHolder: number | null = null
  private takeSeq = 0

  constructor(options: HostLockOptions) {
    this.path = options.path
    this.log = options.log
    this.durability = options.durability
    this.pid = options.pid ?? process.pid
    this.isAlive = options.isAlive ?? defaultPidAlive
    this.maxAttempts = options.maxAttempts ?? 4
  }

  get acquired(): boolean {
    return this.claimed
  }

  private tryExclusiveCreate(): 'created' | 'exists' | 'error' {
    try {
      writeFileSync(this.path, `${this.pid}\n`, { flag: 'wx', mode: 0o600 })
      this.claimed = true
      return 'created'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return 'exists'
      this.log('ERROR', { where: 'acquireHostLock', message: error instanceof Error ? error.message : String(error), code: code ?? null })
      return 'error'
    }
  }

  private readHolder(): HolderRead {
    try {
      const raw = readFileSync(this.path, 'utf8').trim()
      const pid = Number.parseInt(raw, 10)
      return { kind: 'ok', pid: Number.isInteger(pid) ? pid : null, raw }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Atomic take-away: rename the SPECIFIC file away, then re-read what was taken. */
  private takeAway(): { pid: number | null; raw: string; tmpPath: string } | null {
    this.takeSeq += 1
    const tmpPath = `${this.path}.stale-${this.pid}-${this.takeSeq}`
    try {
      renameSync(this.path, tmpPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.log('ERROR', { where: 'acquireHostLock.reclaim', message: error instanceof Error ? error.message : String(error), action: 'keep-current-holder' })
      }
      return null
    }
    try {
      const raw = readFileSync(tmpPath, 'utf8').trim()
      const pid = Number.parseInt(raw, 10)
      return { pid: Number.isInteger(pid) ? pid : null, raw, tmpPath }
    } catch {
      return { pid: null, raw: '', tmpPath }
    }
  }

  /** Put a live holder's lock back without clobbering a newer claim. */
  private restore(taken: { tmpPath: string }): void {
    try {
      linkSync(taken.tmpPath, this.path)
    } catch {
      if (!existsSync(this.path)) {
        try {
          renameSync(taken.tmpPath, this.path)
        } catch {
          void 0
        }
      }
    }
    try {
      rmSync(taken.tmpPath, { force: true })
    } catch {
      void 0
    }
  }

  private lose(
    holderPid: number | null,
    reason: 'held-by-live-resident' | 'reclaim-verify-found-live-holder' | 'unreadable-lock' | 'attempts-exhausted',
    attempt: number,
  ): HostLockOutcome {
    this.lastOutcome = 'held-by'
    this.lastHolder = holderPid
    this.log('HOST_LOCK held-by', { pid: holderPid, action: 'exit', attempt, reason, path: this.path })
    this.log(HOST_LOCK_LOST, { reason, holderPid, attempt, path: this.path })
    this.durability?.record(HOST_LOCK_LOST, { reason, holderPid, attempt })
    return { ok: false, reason: 'held-by', holderPid, reclaimedFrom: null, path: this.path, attempts: attempt }
  }

  acquire(): HostLockOutcome {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const created = this.tryExclusiveCreate()
      if (created === 'created') {
        const reclaimed = this.reclaimedFrom !== null
        this.lastOutcome = reclaimed ? 'reclaimed' : 'acquired'
        this.log('HOST_LOCK acquired', {
          pid: this.pid,
          path: this.path,
          attempt,
          exclusive: true,
          ...(reclaimed ? { reclaimedFrom: this.reclaimedFrom } : {}),
        })
        return { ok: true, reason: reclaimed ? 'reclaimed' : 'acquired', holderPid: this.pid, reclaimedFrom: this.reclaimedFrom, path: this.path, attempts: attempt }
      }
      if (created === 'error') {
        this.lastOutcome = 'error'
        return { ok: false, reason: 'error', holderPid: null, reclaimedFrom: null, path: this.path, attempts: attempt, error: 'exclusive create failed' }
      }

      const observed = this.readHolder()
      if (observed.kind === 'missing') continue // vanished: retry the exclusive create
      if (observed.kind === 'error') {
        this.log('ERROR', { where: 'acquireHostLock', message: observed.message, action: 'retry' })
        continue
      }
      if (observed.pid === this.pid) {
        this.claimed = true
        this.lastOutcome = 'acquired'
        this.log('HOST_LOCK acquired', { pid: this.pid, path: this.path, attempt, note: 'already-ours' })
        return { ok: true, reason: 'acquired', holderPid: this.pid, reclaimedFrom: this.reclaimedFrom, path: this.path, attempts: attempt }
      }
      if (observed.pid !== null && this.isAlive(observed.pid)) return this.lose(observed.pid, 'held-by-live-resident', attempt)
      // A non-empty lock file whose pid cannot be parsed proves NOTHING about
      // liveness: refuse to reclaim it (fail closed) instead of displacing a
      // possible live holder. An EMPTY file is the crash artifact of an exclusive
      // create that never got to write its pid, so it is reclaimable.
      if (observed.pid === null && observed.raw.length > 0) return this.lose(null, 'unreadable-lock', attempt)

      // Provably stale: take the exact file away, verify the bytes we actually
      // removed, and let the next loop iteration win the exclusive create.
      const taken = this.takeAway()
      if (taken === null) continue
      if (taken.pid !== null && taken.pid !== this.pid && this.isAlive(taken.pid)) {
        this.restore(taken)
        return this.lose(taken.pid, 'reclaim-verify-found-live-holder', attempt)
      }
      if (taken.pid === null && taken.raw.length > 0) {
        this.restore(taken)
        return this.lose(null, 'unreadable-lock', attempt)
      }
      this.reclaimedFrom = taken.pid
      this.log('HOST_LOCK stale', { pid: taken.pid, action: 'reclaim', verify: 'take-away-then-exclusive-create', attempt, path: this.path })
      this.log(HOST_LOCK_RECLAIMED, { stalePid: taken.pid, attempt, path: this.path, verified: 'take-away-then-wx' })
      this.durability?.record(HOST_LOCK_RECLAIMED, { stalePid: taken.pid, attempt })
      try {
        rmSync(taken.tmpPath, { force: true })
      } catch {
        void 0
      }
    }
    return this.lose(this.lastHolder, this.lastHolder === null ? 'attempts-exhausted' : 'held-by-live-resident', this.maxAttempts)
  }

  release(): boolean {
    if (!this.claimed) return false
    this.claimed = false
    const observed = this.readHolder()
    if (observed.kind === 'ok' && observed.pid !== null && observed.pid !== this.pid) {
      this.log(HOST_LOCK_LOST, { reason: 'release-found-foreign-holder', holderPid: observed.pid, path: this.path })
      this.durability?.record(HOST_LOCK_LOST, { reason: 'release-found-foreign-holder', holderPid: observed.pid })
    } else if (observed.kind === 'ok' && (observed.pid === this.pid || observed.pid === null)) {
      try {
        rmSync(this.path, { force: true })
      } catch {
        void 0
      }
    }
    this.log('HOST_LOCK released', { pid: this.pid })
    return true
  }

  report(): HostLockReport {
    let present = false
    let filePid: number | null = null
    try {
      if (existsSync(this.path)) {
        present = true
        const parsed = Number.parseInt(readFileSync(this.path, 'utf8').trim(), 10)
        filePid = Number.isInteger(parsed) ? parsed : null
      }
    } catch {
      present = false
    }
    return {
      path: this.path,
      present,
      filePid,
      acquiredByThisProcess: this.claimed,
      pid: this.pid,
      singleInstance: this.claimed || filePid === this.pid,
      outcome: this.lastOutcome,
      reclaimedFrom: this.reclaimedFrom,
    }
  }
}

export interface ResidentBootOptions {
  lock: HostLock
  /** persist the boot revision; called ONLY when this process owns the lock. */
  saveBootState: () => DurableWriteOutcome
  log: SnapshotLog
}

export interface ResidentBootOutcome {
  ok: boolean
  reason: 'locked' | 'lock-held-by' | 'lock-error'
  lock: HostLockOutcome
  bootSave: DurableWriteOutcome | null
}

/**
 * #380 boot order: the lock is acquired FIRST and the boot snapshot is committed
 * only by the lock owner, so a losing resident can never overwrite the winner's
 * durable state (it loaded that state as its own base before the lock).
 */
export function openResidentBoot(options: ResidentBootOptions): ResidentBootOutcome {
  const lock = options.lock.acquire()
  if (!lock.ok) {
    return { ok: false, reason: lock.reason === 'held-by' ? 'lock-held-by' : 'lock-error', lock, bootSave: null }
  }
  const bootSave = options.saveBootState()
  if (!bootSave.ok) {
    options.log('BOOT_STATE_NOT_DURABLE', {
      event: bootSave.event,
      revision: bootSave.revision,
      error: bootSave.error,
      action: 'continue-with-reported-failure',
    })
  }
  return { ok: true, reason: 'locked', lock, bootSave }
}

// ---------------------------------------------------------------------------
// #381 fatal: revoke the actuation lease and exit non-zero
// ---------------------------------------------------------------------------

export interface FatalHandlerOptions {
  log: SnapshotLog
  durability?: HostDurabilityLedger
  /** revoke the actuation lease; synchronous, side-effect only, must not throw. */
  revokeLease: (reason: string) => void
  /** mark the host as shutting down so no new generation work starts. */
  markShuttingDown: () => void
  /** last-resort non-zero exit (normally `process.exit`). */
  exit: (code: number) => void
  /** best-effort evidence/resource hook; failures are ignored. */
  onFatal?: () => void
  exitCode?: number
  pid?: number
}

export interface FatalHandlers {
  fatal(where: string, message: string): void
  uncaughtException(error: unknown): void
  unhandledRejection(reason: unknown): void
}

/**
 * A fatal is not a log line. It revokes the actuation lease FIRST (so the
 * current generation can no longer perform a side effect even if the exit is
 * delayed), records the reason, mirrors FATAL_SHUTDOWN, and exits non-zero.
 */
export function createFatalHandlers(options: FatalHandlerOptions): FatalHandlers {
  const exitCode = options.exitCode ?? 1
  const pid = options.pid ?? process.pid
  let fired = false
  const fatal = (where: string, message: string): void => {
    if (fired) return
    fired = true
    options.log('ERROR', { where, message, fatal: true })
    try {
      options.markShuttingDown()
    } catch {
      void 0
    }
    try {
      options.revokeLease(`fatal:${where}`)
    } catch (error) {
      options.log('ERROR', { where: `${where}.revokeLease`, message: error instanceof Error ? error.message : String(error) })
    }
    try {
      options.onFatal?.()
    } catch {
      void 0
    }
    options.log(FATAL_SHUTDOWN, { where, message, pid, exitCode, action: 'lease-revoked-exit-nonzero' })
    options.durability?.record(FATAL_SHUTDOWN, { where, message, exitCode })
    options.exit(exitCode)
  }
  const describe = (value: unknown): string => (value instanceof Error ? value.message : String(value))
  return {
    fatal,
    uncaughtException: (error: unknown) => fatal('uncaughtException', describe(error)),
    unhandledRejection: (reason: unknown) => fatal('unhandledRejection', describe(reason)),
  }
}

// ---------------------------------------------------------------------------
// #384 shutdown: close the control server, THEN release the lock
// ---------------------------------------------------------------------------

/**
 * Explicit control-socket quits are clean shutdowns. OS signals are not: keep
 * their conventional exit status so a process owner can distinguish an
 * unexpected signal from an intentional quit and reacquire the same authority.
 */
export function shutdownExitCodeForReason(reason: string): number {
  if (reason === 'SIGINT') return 130
  if (reason === 'SIGTERM') return 143
  return 0
}

export interface ShutdownSequenceOptions {
  log: SnapshotLog
  alreadyShuttingDown: () => boolean
  markShuttingDown: () => void
  /** Stop timers/arbiter, await active generation quiescence, and emit SHUTDOWN. */
  quiesce: () => void | Promise<void>
  /** write the acceptance record; may throw (guarded by the sequence). */
  writeAcceptance: () => string | null
  persistState: () => DurableWriteOutcome
  disposeGeneration: () => void
  disconnect: () => void
  /** resolves when the control server is closed (or the bounded wait elapsed). */
  closeServer: () => Promise<boolean>
  releaseLock: () => void
  exit: (code: number) => void
  exitCode?: number
  exitDelayMs?: number
  delay?: (ms: number) => Promise<void>
}

export interface ShutdownOutcome {
  ran: boolean
  acceptancePath: string | null
  serverClosed: boolean
  lockReleased: boolean
}

const guard = (log: SnapshotLog, where: string, step: () => void): void => {
  try {
    step()
  } catch (error) {
    log('ERROR', { where, message: error instanceof Error ? error.message : String(error) })
  }
}

const guardAsync = async (log: SnapshotLog, where: string, step: () => void | Promise<void>): Promise<void> => {
  try {
    await step()
  } catch (error) {
    log('ERROR', { where, message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The one graceful-shutdown order. Invariants:
 *   - re-entrant calls are no-ops (the first caller owns the sequence);
 *   - the control server is CLOSED (and awaited, bounded) BEFORE the lock is
 *     released, so a second resident cannot boot into a host whose socket is
 *     still accepting commands;
 *   - a throwing step never skips the close/release/exit tail.
 */
export async function runShutdownSequence(options: ShutdownSequenceOptions): Promise<ShutdownOutcome> {
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  if (options.alreadyShuttingDown()) {
    return { ran: false, acceptancePath: null, serverClosed: false, lockReleased: false }
  }
  options.markShuttingDown()
  await guardAsync(options.log, 'shutdown.quiesce', options.quiesce)

  let acceptancePath: string | null = null
  guard(options.log, 'shutdown.writeAcceptance', () => {
    acceptancePath = options.writeAcceptance()
  })
  guard(options.log, 'shutdown.persistState', () => {
    options.persistState()
  })
  guard(options.log, 'shutdown.disposeGeneration', () => options.disposeGeneration())
  guard(options.log, 'shutdown.disconnect', () => options.disconnect())

  let serverClosed = false
  try {
    serverClosed = await options.closeServer()
  } catch (error) {
    options.log('ERROR', { where: 'shutdown.closeServer', message: error instanceof Error ? error.message : String(error) })
  }

  let lockReleased = false
  guard(options.log, 'shutdown.releaseLock', () => {
    options.releaseLock()
    lockReleased = true
  })

  if ((options.exitDelayMs ?? 0) > 0) await delay(options.exitDelayMs ?? 0)
  options.exit(options.exitCode ?? 0)
  return { ran: true, acceptancePath, serverClosed, lockReleased }
}

/**
 * Close the control socket server and remove its socket file. Bounded: a client
 * that holds a control connection open cannot delay the shutdown past
 * `timeoutMs` (the lock must never be held by a process that already decided to
 * exit). Resolves `true` when the server actually closed, `false` when the
 * bounded wait elapsed first (or there was no server).
 */
export async function closeControlServer(
  server: Server | null,
  options: { timeoutMs?: number; socketPath?: string } = {},
): Promise<boolean> {
  if (server === null) return true
  const timeoutMs = options.timeoutMs ?? 500
  const forced = server as unknown as { closeAllConnections?: () => void }
  const closed = await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const done = (): void => {
      clearTimeout(timer)
      finish(true)
    }
    try {
      server.close(done)
      forced.closeAllConnections?.()
    } catch {
      clearTimeout(timer)
      finish(false)
    }
    if (typeof timer.unref === 'function') timer.unref()
  })
  if (options.socketPath !== undefined) {
    try {
      rmSync(options.socketPath, { force: true })
    } catch {
      void 0
    }
  }
  return closed
}
