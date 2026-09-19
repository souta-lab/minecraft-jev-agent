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

export const M2_SNAPSHOT_SCHEMA_VERSION = 1
export const M2_SNAPSHOT_RECORD = 'm2-snapshot'

/**
 * The required M2 marker set, in the one and only accepted order. This is the
 * same set m2-watch enforces; it is deliberately NOT configurable here so the
 * snapshot can never be written against a weaker chain.
 */
export const M2_REQUIRED_MARKERS = ['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'] as const
export type M2RequiredMarker = (typeof M2_REQUIRED_MARKERS)[number]

/** Bound on recorded marker occurrences so a pathological repeat cannot grow the file without limit. */
export const M2_SNAPSHOT_MAX_SEQUENCE = 64

const REQUIRED_MARKER_SET: ReadonlySet<string> = new Set<string>(M2_REQUIRED_MARKERS)

export function isRequiredM2Marker(event: string): event is M2RequiredMarker {
  return REQUIRED_MARKER_SET.has(event)
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
}

export interface M2SnapshotChain {
  status: 'VALID' | 'INCOMPLETE'
  required: readonly string[]
  observed: readonly string[]
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
  markers: M2SnapshotMarker[]
  sequence: string[]
  chain: M2SnapshotChain
  inventory: Counts
}

/**
 * Ordered-subsequence check with the same semantics as m2-watch's deriveFrontier:
 * the FIRST PREREQ_OPTION, then the FIRST FURNACE_READY after it, then the FIRST
 * SMELT_DONE after that. `sequence` holds the required-marker occurrences in
 * arrival order, so a chain broken by a fresh PREREQ_OPTION after SMELT_DONE is
 * not silently promoted to VALID.
 */
export function orderedM2Chain(sequence: readonly string[]): M2SnapshotChain {
  const observed: string[] = []
  let cursor = 0
  for (const marker of sequence) {
    const want = M2_REQUIRED_MARKERS[cursor]
    if (want === undefined) break
    if (marker !== want) continue
    observed.push(marker)
    cursor += 1
  }
  return {
    status: cursor === M2_REQUIRED_MARKERS.length ? 'VALID' : 'INCOMPLETE',
    required: [...M2_REQUIRED_MARKERS],
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
  const chain = orderedM2Chain(candidate.sequence)
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
    markers: candidate.markers.map((marker) => ({ ...marker, inventory: { ...marker.inventory } })),
    sequence: [...candidate.sequence],
    chain,
    inventory: { ...candidate.inventory },
  }
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
            atMs: 0,
            at: new Date(0).toISOString(),
            markers: [],
            sequence: [],
            chain: orderedM2Chain([]),
            inventory: {},
          }
        : existing
  }

  /** The current in-memory snapshot (a defensive copy). */
  current(): M2Snapshot {
    return {
      ...this.snapshot,
      markers: this.snapshot.markers.map((marker) => ({ ...marker, inventory: { ...marker.inventory } })),
      sequence: [...this.snapshot.sequence],
      chain: { ...this.snapshot.chain, required: [...this.snapshot.chain.required], observed: [...this.snapshot.chain.observed] },
      inventory: { ...this.snapshot.inventory },
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
  recordMarker(event: string): M2SnapshotMarker | null {
    if (!isRequiredM2Marker(event)) return null
    const now = this.options.now ?? Date.now
    const atMs = now()
    const marker: M2SnapshotMarker = {
      name: event,
      atMs,
      at: new Date(atMs).toISOString(),
      inventory: this.readInventory(),
    }
    // Exactly ONE retained sample per marker, pinned to the occurrence that
    // ADVANCES the ordered chain: the first PREREQ_OPTION, the first
    // FURNACE_READY after it, then the first SMELT_DONE after that. Those are
    // the observations the causal chain is about, so they are the samples kept.
    //
    // A repeat of an already-retained marker (e.g. a second FURNACE_READY once
    // the furnace has burnt its fuel) must NOT overwrite the earlier live
    // inventory. Overwriting is what lost the FURNACE_READY-time `charcoal>=1`
    // observation, leaving only the later fuel-consumed state.
    const cursor = orderedM2Chain(this.snapshot.sequence).observed.length
    const advancesChain = M2_REQUIRED_MARKERS[cursor] === event
    const index = this.snapshot.markers.findIndex((entry) => entry.name === event)
    if (advancesChain) {
      // The chain-participating occurrence is authoritative for this marker: it
      // replaces an out-of-order earlier sample of the same name when present.
      if (index === -1) this.snapshot.markers.push(marker)
      else this.snapshot.markers[index] = marker
    } else if (index === -1) {
      // No chain sample for this name yet: retain the occurrence as evidence,
      // but never let a later repeat overwrite it (first observation wins).
      this.snapshot.markers.push(marker)
    }
    if (this.snapshot.sequence.length < M2_SNAPSHOT_MAX_SEQUENCE) this.snapshot.sequence.push(event)
    this.snapshot.chain = orderedM2Chain(this.snapshot.sequence)
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
}
