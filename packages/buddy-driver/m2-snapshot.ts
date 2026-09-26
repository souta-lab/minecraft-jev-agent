// m2-snapshot.ts — RUN-SCOPED M2 evidence captured by the resident AT MARKER TIME.
//
// The M2 gap (run-mu8ps36q-xegj): PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE and
// the live 3-condition inventory (charcoal>=1 / iron_ingot>=3 / iron_pickaxe>=1)
// all happened in the SAME run, but `m2-acceptance` ran AFTER the resident exited,
// so the live control-socket query returned UNKNOWN and the run could never PASS.
//
// Fix: whenever an M2 marker fires, the resident reads the bot's LIVE inventory at
// that instant and atomically (temp file + rename) writes/updates ONE durable,
// run-scoped snapshot file. The snapshot is run-scoped by BOTH its filename and an
// explicit `runId` field, so a snapshot for run A can never satisfy `--run B`.
//
// This module is pure bookkeeping + fs; it never touches the socket and never
// reconstructs values from the jsonl/log afterwards.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Counts } from './planner.ts'

export const M2_SNAPSHOT_SCHEMA_VERSION = 2
export const M2_SNAPSHOT_RECORD = 'm2-snapshot'

/**
 * The IRON-age marker set, in its accepted order. Superseded by the portal chain
 * below and kept ONLY as a legacy record (`legacyChain`), so no history is lost.
 */
export const M2_LEGACY_MARKERS = ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'] as const

/**
 * The required M2 marker set, in the one and only accepted order: the NETHR GATE
 * chain (build -> light -> verify), which is the same order `tools/m2-gate.mjs`
 * evaluates as `m2_chain`.
 *
 * This used to be the legacy IRON set, and the consequence was measured: every
 * run-scoped snapshot in `data/resident/` carried
 * `chain: { status: "INCOMPLETE", required: [PREREQ_OPTION, FURNACE_READY, SMELT_DONE] }`
 * while the run that ACTUALLY built, lit and verified a portal
 * (`run-mubhx20x-pie2`: PORTAL_BLOCK_PLACED x9 -> PORTAL_FRAME_READY blocks=10 shape=ok
 * -> PORTAL_LIT -> PORTAL_VERIFIED=true, in runs/supervisor-live10.out and its own
 * snapshot) reported a chain that had nothing to do with what it did. The
 * operator's M2 premise is exactly this chain, so the run-scoped artifact must
 * carry it.
 */
export const M2_REQUIRED_MARKERS = [
  'PORTAL_BLOCK_PLACED',
  'PORTAL_FRAME_READY',
  'PORTAL_LIT',
  'PORTAL_VERIFIED',
] as const
export type M2RequiredMarker = (typeof M2_REQUIRED_MARKERS)[number]

/** Current M2 (diamond -> Nether gate) markers captured by the same recorder. */
export const M2_PORTAL_MARKERS = [
  'PORTAL_BLOCK_PLACED',
  'PORTAL_FRAME_READY',
  'PORTAL_LIT',
  'PORTAL_VERIFIED',
  'PORTAL_LIGHT_REFUSED',
] as const
export type M2PortalMarker = (typeof M2_PORTAL_MARKERS)[number]

/** Bound on recorded marker occurrences so a pathological repeat cannot grow the file without limit. */
export const M2_SNAPSHOT_MAX_SEQUENCE = 64

const REQUIRED_MARKER_SET: ReadonlySet<string> = new Set<string>([
  ...M2_REQUIRED_MARKERS,
  ...M2_LEGACY_MARKERS,
  ...M2_PORTAL_MARKERS,
])

export function isRequiredM2Marker(event: string): event is M2RequiredMarker | M2PortalMarker {
  return REQUIRED_MARKER_SET.has(event)
}

export function isPortalM2Marker(event: string): event is M2PortalMarker {
  return (M2_PORTAL_MARKERS as readonly string[]).includes(event)
}

export function m2SnapshotFileName(runId: string): string {
  return `m2-snapshot-${runId}.json`
}

export function m2SnapshotPath(runId: string, dir: string): string {
  return `${dir}/${m2SnapshotFileName(runId)}`
}

export interface M2SnapshotMarker {
  name: string
  atMs: number
  at: string
  inventory: Counts
  blocks?: number
  shape?: string
  verified?: boolean
  dimension?: string
  pos?: [number, number, number]
  /**
   * Provenance of the observation, when a marker can be produced by more than one
   * route. `PORTAL_VERIFIED` is emitted by the ignition action (no source) and by
   * the durable-site recheck (`durable-site-recheck`), which reads the run's own
   * recorded frame/interior cells back as live world truth in a later generation.
   * Optional, so snapshots written before this field still parse.
   */
  source?: string
}

/** A verified durable terminal observation captured after the required chain. */
export interface M2SnapshotTerminal {
  actionId: 'CRAFT:iron_pickaxe'
  verified: true
  status: 'done'
  atMs: number
  at: string
  inventory: Counts
}

export interface M2SnapshotChain {
  status: 'VALID' | 'INCOMPLETE'
  required: readonly string[]
  observed: readonly string[]
}

export interface M2InitialInventoryObservation {
  runId: string
  atMs: number
  at: string
  generationId: string | null
  bootSourceSha: string | null
  buildHash: string | null
  worldEpoch: number | null
  worldKey: string | null
}

export interface M2Snapshot {
  schemaVersion: number
  record: typeof M2_SNAPSHOT_RECORD
  runId: string
  generationId: string | null
  bootSourceSha: string | null
  buildHash: string | null
  worldEpoch: number | null
  worldKey: string | null
  atMs: number
  at: string
  /** Inventory captured when this resident run first initialized. */
  initialInventory?: Counts
  /** Exact HOST generation and world identity for the first inventory sample. */
  initialInventoryObservation?: M2InitialInventoryObservation
  markers: M2SnapshotMarker[]
  sequence: string[]
  chain: M2SnapshotChain
  /**
   * The superseded IRON-age chain (`PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE`),
   * still evaluated from the same sequence so a historical reader loses nothing
   * when `chain` became the portal chain the M2 premise and the canonical gate use.
   */
  legacyChain: M2SnapshotChain
  inventory: Counts
  terminal: M2SnapshotTerminal | null
}

/**
 * Ordered-subsequence check with the same semantics as m2-watch's deriveFrontier:
 * the FIRST PREREQ_OPTION, then the FIRST FURNACE_READY after it, then the FIRST
 * SMELT_DONE after that. `sequence` holds the required-marker occurrences in
 * arrival order, so a chain broken by a fresh PREREQ_OPTION after SMELT_DONE is
 * not silently promoted to VALID.
 */
export function orderedM2Chain(
  sequence: readonly string[],
  required: readonly string[] = M2_REQUIRED_MARKERS,
): M2SnapshotChain {
  const observed: string[] = []
  let cursor = 0
  for (const marker of sequence) {
    const want = required[cursor]
    if (want === undefined) break
    if (marker !== want) continue
    observed.push(marker)
    cursor += 1
  }
  return {
    status: cursor === required.length ? 'VALID' : 'INCOMPLETE',
    required: [...required],
    observed,
  }
}

function isCounts(value: unknown): value is Counts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  for (const count of Object.values(value)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) return false
  }
  return true
}

function isSnapshotMarker(value: unknown): value is M2SnapshotMarker {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<M2SnapshotMarker>
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.atMs === 'number' &&
    typeof candidate.at === 'string' &&
    isCounts(candidate.inventory) &&
    (candidate.blocks === undefined || (typeof candidate.blocks === 'number' && Number.isFinite(candidate.blocks))) &&
    (candidate.shape === undefined || typeof candidate.shape === 'string') &&
    (candidate.verified === undefined || typeof candidate.verified === 'boolean') &&
    (candidate.dimension === undefined || typeof candidate.dimension === 'string') &&
    (candidate.pos === undefined || (Array.isArray(candidate.pos) && candidate.pos.length === 3 && candidate.pos.every((entry) => typeof entry === 'number' && Number.isFinite(entry))))
  )
}

function isSnapshotTerminal(value: unknown): value is M2SnapshotTerminal {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<M2SnapshotTerminal>
  return (
    candidate.actionId === 'CRAFT:iron_pickaxe' &&
    candidate.verified === true &&
    candidate.status === 'done' &&
    typeof candidate.atMs === 'number' &&
    typeof candidate.at === 'string' &&
    isCounts(candidate.inventory)
  )
}

/** Parse and validate a snapshot file body. Returns null for anything malformed. */
export function parseM2Snapshot(value: unknown): M2Snapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<M2Snapshot>
  if (candidate.record !== M2_SNAPSHOT_RECORD) return null
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) return null
  if (typeof candidate.atMs !== 'number' || typeof candidate.at !== 'string') return null
  if (!Array.isArray(candidate.markers) || !candidate.markers.every(isSnapshotMarker)) return null
  if (!Array.isArray(candidate.sequence) || !candidate.sequence.every((name) => typeof name === 'string')) return null
  if (!isCounts(candidate.inventory)) return null
  if (candidate.terminal !== undefined && candidate.terminal !== null && !isSnapshotTerminal(candidate.terminal)) return null
  const chain = orderedM2Chain(candidate.sequence)
  const legacyChain = orderedM2Chain(candidate.sequence, M2_LEGACY_MARKERS)
  return {
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : M2_SNAPSHOT_SCHEMA_VERSION,
    record: M2_SNAPSHOT_RECORD,
    runId: candidate.runId,
    generationId: typeof candidate.generationId === 'string' ? candidate.generationId : null,
    bootSourceSha: typeof candidate.bootSourceSha === 'string' ? candidate.bootSourceSha : null,
    buildHash: typeof candidate.buildHash === 'string' ? candidate.buildHash : null,
    worldEpoch: typeof candidate.worldEpoch === 'number' ? candidate.worldEpoch : null,
    worldKey: typeof candidate.worldKey === 'string' ? candidate.worldKey : null,
    atMs: candidate.atMs,
    at: candidate.at,
    ...(isCounts(candidate.initialInventory) ? { initialInventory: { ...candidate.initialInventory } } : {}),
    ...(isInitialInventoryObservation(candidate.initialInventoryObservation)
      ? { initialInventoryObservation: { ...candidate.initialInventoryObservation } }
      : {}),
    markers: candidate.markers.map((marker) => ({ ...marker, inventory: { ...marker.inventory } })),
    sequence: [...candidate.sequence],
    chain,
    legacyChain,
    inventory: { ...candidate.inventory },
    terminal: isSnapshotTerminal(candidate.terminal) ? { ...candidate.terminal, inventory: { ...candidate.terminal.inventory } } : null,
  }
}

function isInitialInventoryObservation(value: unknown): value is M2InitialInventoryObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<M2InitialInventoryObservation>
  return (
    typeof candidate.runId === 'string' && candidate.runId.length > 0 &&
    typeof candidate.atMs === 'number' && Number.isFinite(candidate.atMs) &&
    typeof candidate.at === 'string' &&
    (candidate.generationId === null || typeof candidate.generationId === 'string') &&
    (candidate.bootSourceSha === null || typeof candidate.bootSourceSha === 'string') &&
    (candidate.buildHash === null || typeof candidate.buildHash === 'string') &&
    (candidate.worldEpoch === null || typeof candidate.worldEpoch === 'number') &&
    (candidate.worldKey === null || typeof candidate.worldKey === 'string')
  )
}

/** Read a snapshot file; null when missing, unreadable, malformed, or out of run scope. */
export function readM2SnapshotFile(runId: string, dir: string): M2Snapshot | null {
  const path = m2SnapshotPath(runId, dir)
  if (!existsSync(path)) return null
  try {
    const parsed = parseM2Snapshot(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed === null || parsed.runId !== runId) return null
    return parsed
  } catch {
    return null
  }
}

export function writeM2SnapshotAtomic(path: string, snapshot: M2Snapshot): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`)
  renameSync(tmp, path)
}

export interface M2SnapshotRecorderOptions {
  runId: string
  generationId: string | null
  bootSourceSha: string | null
  buildHash: string | null
  worldEpoch: number | null
  worldKey: string | null
  dir: string
  /** Reads the bot's FULL live inventory. Called at every marker; never cached across markers. */
  readInventory: () => Counts
  /** Initial run inventory captured by the HOST before the first generation starts. */
  initialInventory?: Counts
  /** Injectable clock (ms). */
  now?: () => number
  log?: (event: string, detail?: Record<string, unknown>) => void
}

/**
 * Run-scoped recorder. One instance per generation, but the on-disk snapshot is
 * per RUN: a hot reload creates a new recorder that reuses the existing file for
 * the same runId, so the ordered chain survives generation boundaries while a
 * different runId can never read it.
 */
export class M2SnapshotRecorder {
  private readonly options: M2SnapshotRecorderOptions
  readonly path: string
  private snapshot: M2Snapshot

  constructor(options: M2SnapshotRecorderOptions) {
    this.options = options
    this.path = m2SnapshotPath(options.runId, options.dir)
    const existing = readM2SnapshotFile(options.runId, options.dir)
    const initialCapturedAtMs =
      existing === null && options.initialInventory !== undefined ? (options.now ?? Date.now)() : 0
    const initialCapturedAt = new Date(initialCapturedAtMs).toISOString()
    this.snapshot =
      existing === null
        ? {
            schemaVersion: M2_SNAPSHOT_SCHEMA_VERSION,
            record: M2_SNAPSHOT_RECORD,
            runId: options.runId,
            generationId: options.generationId,
            bootSourceSha: options.bootSourceSha,
            buildHash: options.buildHash,
            worldEpoch: options.worldEpoch,
            worldKey: options.worldKey,
            atMs: initialCapturedAtMs,
            at: initialCapturedAt,
            ...(options.initialInventory === undefined ? {} : { initialInventory: { ...options.initialInventory } }),
            ...(options.initialInventory === undefined
              ? {}
              : {
                  initialInventoryObservation: {
                    runId: options.runId,
                    atMs: initialCapturedAtMs,
                    at: initialCapturedAt,
                    generationId: options.generationId,
                    bootSourceSha: options.bootSourceSha,
                    buildHash: options.buildHash,
                    worldEpoch: options.worldEpoch,
                    worldKey: options.worldKey,
                  },
                }),
            markers: [],
            sequence: [],
            chain: orderedM2Chain([]),
            legacyChain: orderedM2Chain([], M2_LEGACY_MARKERS),
            inventory: {},
            terminal: null,
          }
        : existing
    if (existing === null && options.initialInventory !== undefined) {
      // Persist the sample at generation entry, not on the first later marker.
      try {
        writeM2SnapshotAtomic(this.path, this.snapshot)
        this.options.log?.('M2_SNAPSHOT_INITIAL', {
          path: this.path,
          runId: options.runId,
          generationId: options.generationId,
          bootSourceSha: options.bootSourceSha,
          buildHash: options.buildHash,
          worldEpoch: options.worldEpoch,
          worldKey: options.worldKey,
          inventory: this.snapshot.initialInventory,
        })
      } catch (error) {
        this.options.log?.('ERROR', {
          where: 'm2-snapshot-initial',
          path: this.path,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** The current in-memory snapshot (a defensive copy). */
  current(): M2Snapshot {
    return {
      ...this.snapshot,
      ...(this.snapshot.initialInventory === undefined ? {} : { initialInventory: { ...this.snapshot.initialInventory } }),
      ...(this.snapshot.initialInventoryObservation === undefined
        ? {}
        : { initialInventoryObservation: { ...this.snapshot.initialInventoryObservation } }),
      markers: this.snapshot.markers.map((marker) => ({ ...marker, inventory: { ...marker.inventory } })),
      sequence: [...this.snapshot.sequence],
      chain: { ...this.snapshot.chain, required: [...this.snapshot.chain.required], observed: [...this.snapshot.chain.observed] },
      inventory: { ...this.snapshot.inventory },
      terminal:
        this.snapshot.terminal === null
          ? null
          : { ...this.snapshot.terminal, inventory: { ...this.snapshot.terminal.inventory } },
    }
  }

  private readInventory(): Counts {
    try {
      return { ...this.options.readInventory() }
    } catch {
      // A disconnect at the exact marker instant must not drop the marker or
      // fabricate counts: keep the previous inventory and still record the marker.
      return { ...this.snapshot.inventory }
    }
  }

  /**
   * Record a required M2 marker. Returns the per-marker entry, or null when the
   * event is not part of the required M2 chain. The marker's timestamp and the
   * FULL live inventory are read at THIS instant; the file update is atomic.
   */
  recordMarker(event: string, detail?: Record<string, unknown>): M2SnapshotMarker | null {
    if (!isRequiredM2Marker(event)) return null
    const now = this.options.now ?? Date.now
    const atMs = now()
    const marker: M2SnapshotMarker = {
      name: event,
      atMs,
      at: new Date(atMs).toISOString(),
      inventory: this.readInventory(),
    }
    if (typeof detail?.blocks === 'number' && Number.isFinite(detail.blocks)) marker.blocks = detail.blocks
    if (typeof detail?.shape === 'string') marker.shape = detail.shape
    if (typeof detail?.verified === 'boolean') marker.verified = detail.verified
    if (typeof detail?.dimension === 'string') marker.dimension = detail.dimension
    if (typeof detail?.source === 'string' && detail.source.length > 0) marker.source = detail.source
    const position = detail?.target !== null && typeof detail?.target === 'object'
      ? detail.target as { x?: unknown; y?: unknown; z?: unknown }
      : null
    if (
      position !== null &&
      typeof position.x === 'number' &&
      typeof position.y === 'number' &&
      typeof position.z === 'number'
    ) {
      marker.pos = [position.x, position.y, position.z]
    } else if (typeof detail?.at === 'string') {
      const match = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(detail.at)
      if (match !== null) marker.pos = [Number(match[1]), Number(match[2]), Number(match[3])]
    }
    // Keep the sample from the occurrence that advances the ordered chain. A
    // later repeat must not overwrite a valid chain's earlier live inventory.
    const cursor = orderedM2Chain(this.snapshot.sequence).observed.length
    const advancesChain = !isPortalM2Marker(event) && M2_REQUIRED_MARKERS[cursor] === event
    const index = this.snapshot.markers.findIndex((entry) => entry.name === event)
    if (isPortalM2Marker(event)) {
      // Portal evidence is an ordered event stream, not one slot per marker.
      // Preserve every occurrence so a later run-scoped gate can prove the
      // placed -> frame -> lit -> verified chain without reconstructing it
      // from an all-time log.
      this.snapshot.markers.push(marker)
    } else if (advancesChain) {
      if (index === -1) this.snapshot.markers.push(marker)
      else this.snapshot.markers[index] = marker
    } else if (index === -1) {
      // Preserve an out-of-order observation for diagnostics, but never let a
      // later repeat replace it before the chain chooses its occurrence.
      this.snapshot.markers.push(marker)
    }
    if (this.snapshot.sequence.length < M2_SNAPSHOT_MAX_SEQUENCE) this.snapshot.sequence.push(event)
    this.snapshot.chain = orderedM2Chain(this.snapshot.sequence)
    // Both chains are derived from the same sequence and must be refreshed together:
    // recomputing only `chain` left `legacyChain` frozen at its construction value,
    // which silently stopped the iron terminal from ever being recorded.
    this.snapshot.legacyChain = orderedM2Chain(this.snapshot.sequence, M2_LEGACY_MARKERS)
    this.snapshot.atMs = atMs
    this.snapshot.at = marker.at
    this.snapshot.inventory = { ...marker.inventory }
    this.snapshot.generationId = this.options.generationId
    this.snapshot.bootSourceSha = this.options.bootSourceSha
    this.snapshot.buildHash = this.options.buildHash
    this.snapshot.worldEpoch = this.options.worldEpoch
    this.snapshot.worldKey = this.options.worldKey
    try {
      writeM2SnapshotAtomic(this.path, this.snapshot)
    } catch (error) {
      // A full/unwritable disk must not crash the resident's action loop; the
      // missing evidence is loud rather than a silent PASS.
      this.options.log?.('ERROR', {
        where: 'm2-snapshot',
        marker: event,
        path: this.path,
        message: error instanceof Error ? error.message : String(error),
      })
      return marker
    }
    this.options.log?.('M2_SNAPSHOT', {
      marker: event,
      path: this.path,
      runId: this.snapshot.runId,
      generationId: this.snapshot.generationId,
      buildHash: this.snapshot.buildHash,
      chain: this.snapshot.chain.status,
      inventory: this.snapshot.inventory,
    })
    return marker
  }

  /**
   * Record the verified durable M2 terminal after the required marker chain.
   * This is separate from M2_REQUIRED_MARKERS: it adds no causal marker and
   * exists only so a post-smelt craft is observable after the resident exits.
   */
  recordTerminal(actionId: string, outcome: { verified: boolean; status: string }): M2SnapshotTerminal | null {
    if (actionId !== 'CRAFT:iron_pickaxe' || outcome.verified !== true || outcome.status !== 'done') return null
    // The one defined terminal is the verified `CRAFT:iron_pickaxe` (see
    // `isTerminal`), so its ordering precondition is the LEGACY iron chain - the
    // chain that terminal belongs to. `chain` is the portal chain now, and reading
    // it here would silently stop recording the iron terminal.
    if (this.snapshot.legacyChain.status !== 'VALID') return null
    const now = this.options.now ?? Date.now
    const atMs = now()
    const terminal: M2SnapshotTerminal = {
      actionId: 'CRAFT:iron_pickaxe',
      verified: true,
      status: 'done',
      atMs,
      at: new Date(atMs).toISOString(),
      inventory: this.readInventory(),
    }
    this.snapshot.terminal = terminal
    this.snapshot.atMs = atMs
    this.snapshot.at = terminal.at
    this.snapshot.inventory = { ...terminal.inventory }
    this.snapshot.generationId = this.options.generationId
    this.snapshot.bootSourceSha = this.options.bootSourceSha
    this.snapshot.buildHash = this.options.buildHash
    this.snapshot.worldEpoch = this.options.worldEpoch
    this.snapshot.worldKey = this.options.worldKey
    try {
      writeM2SnapshotAtomic(this.path, this.snapshot)
    } catch (error) {
      this.options.log?.('ERROR', {
        where: 'm2-snapshot-terminal',
        actionId,
        path: this.path,
        message: error instanceof Error ? error.message : String(error),
      })
      return terminal
    }
    this.options.log?.('M2_TERMINAL_SNAPSHOT', {
      actionId,
      path: this.path,
      runId: this.snapshot.runId,
      generationId: this.snapshot.generationId,
      buildHash: this.snapshot.buildHash,
      inventory: terminal.inventory,
    })
    return terminal
  }
}
