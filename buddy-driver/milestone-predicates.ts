// milestone-predicates.ts — RUN-SCOPED milestone predicate evidence, HOST side.
//
// The operator's M3 PASS definition requires the run-scoped artifact to carry
// "milestone predicate evidence": for each M2/M3 predicate, what was decided, when
// it was first observed, and from which evidence source. tools/milestone-run-artifact.mjs
// can derive that section from the log + m2 snapshot, but reconstruction is weaker
// than a live observation: the live generation owns `world` (e.g. `portalVerified`,
// the normalized dimension) that a log line may not repeat, and an evidence section
// produced AT observation time is auditable in a way a post-hoc derivation is not.
//
// This module is the HOST/durability half and is deliberately dependency-free
// apart from node:fs — the HOST must not pull the planner/jev graph into its own
// process. The generation-side evaluator lives in `milestone-predicate-eval.ts`
// and hands finished observations to `MilestonePredicateRecorder`, which persists
// them to ONE run-scoped, atomically-written file
// (`milestone-predicates-<runId>.json`).
//
// Run isolation / reload survival:
//   * the file is run-scoped by BOTH its filename and its `runId` field;
//   * a hot reload creates a new recorder that REUSES the existing file for the
//     same runId and MERGES monotonically: a predicate once observed `true` keeps
//     its first observation and can never be overwritten by a later generation's
//     `false`/unknown. A stale generation therefore cannot erase proven evidence;
//   * `sourceSha` is the run's BOOT source SHA, so a predicate observation can be
//     rejected against the wrong build by the artifact assembler.
//
// Pure bookkeeping + fs: this module never touches the socket or the model.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const MILESTONE_PREDICATE_RECORD = 'milestone-predicates'
export const MILESTONE_PREDICATE_SCHEMA_VERSION = 1

export type MilestonePredicateId = 'portal_verified' | 'nether_reached' | 'blaze_rods' | 'ender_pearls' | 'ender_eyes'

/** The canonical run-scoped predicate ids this recorder accepts. */
export const MILESTONE_PREDICATE_IDS: readonly string[] = ['portal_verified', 'nether_reached', 'blaze_rods', 'ender_pearls', 'ender_eyes']

export interface MilestonePredicateObservation {
  id: string
  milestone: 'M2' | 'M3'
  /** true = observed satisfied; false = observed not satisfied; null = not observed yet. */
  satisfied: boolean | null
  observedAtMs: number | null
  observedAt: string | null
  /** evidence source label, e.g. `host-observe:rung:ender_eyes`. */
  source: string
  evidence: Record<string, unknown>
}


export function milestonePredicateFileName(runId: string): string {
  return `${MILESTONE_PREDICATE_RECORD}-${runId}.json`
}

export function milestonePredicatePath(runId: string, dir: string): string {
  return `${dir}/${milestonePredicateFileName(runId)}`
}

interface RecorderFile {
  schemaVersion: number
  record: typeof MILESTONE_PREDICATE_RECORD
  runId: string
  sourceSha: string | null
  generationId: string | null
  updatedAtMs: number
  updatedAt: string
  observationCount: number
  predicates: MilestonePredicateObservation[]
}

export interface MilestonePredicateRecorderOptions {
  runId: string
  /** The run's BOOT source SHA; never a per-generation value. */
  sourceSha: string | null
  dir: string
  /** Injectable clock (ms). */
  now?: () => number
  log?: (event: string, detail?: Record<string, unknown>) => void
  /** Minimum interval between forced rewrites while nothing changes. */
  refreshMs?: number
}

function isObservation(value: unknown): value is MilestonePredicateObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<MilestonePredicateObservation>
  return typeof candidate.id === 'string' && (candidate.satisfied === true || candidate.satisfied === false || candidate.satisfied === null)
}

function readRecorderFile(runId: string, dir: string): RecorderFile | null {
  const path = milestonePredicatePath(runId, dir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RecorderFile>
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.record !== MILESTONE_PREDICATE_RECORD) return null
    if (parsed.runId !== runId) return null
    return {
      schemaVersion: MILESTONE_PREDICATE_SCHEMA_VERSION,
      record: MILESTONE_PREDICATE_RECORD,
      runId,
      sourceSha: typeof parsed.sourceSha === 'string' ? parsed.sourceSha : null,
      generationId: typeof parsed.generationId === 'string' ? parsed.generationId : null,
      updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      observationCount: typeof parsed.observationCount === 'number' ? parsed.observationCount : 0,
      predicates: Array.isArray(parsed.predicates) ? parsed.predicates.filter(isObservation) : [],
    }
  } catch {
    return null
  }
}

function observationChanged(a: MilestonePredicateObservation | undefined, b: MilestonePredicateObservation): boolean {
  if (a === undefined) return true
  if (a.satisfied !== b.satisfied || a.observedAtMs !== b.observedAtMs || a.source !== b.source) return true
  return JSON.stringify(a.evidence ?? null) !== JSON.stringify(b.evidence ?? null)
}

export interface ObserveMeta {
  generationId?: string | null
  atMs?: number
}

/**
 * Run-scoped predicate recorder. One instance per generation, but the on-disk
 * file is per RUN: a hot reload reuses it and merges monotonically, so a `true`
 * observation survives every later generation.
 */
export class MilestonePredicateRecorder {
  private readonly options: MilestonePredicateRecorderOptions
  readonly path: string
  private state: RecorderFile

  constructor(options: MilestonePredicateRecorderOptions) {
    this.options = options
    this.path = milestonePredicatePath(options.runId, options.dir)
    const existing = readRecorderFile(options.runId, options.dir)
    const now = options.now ?? Date.now
    this.state =
      existing === null
        ? {
            schemaVersion: MILESTONE_PREDICATE_SCHEMA_VERSION,
            record: MILESTONE_PREDICATE_RECORD,
            runId: options.runId,
            sourceSha: options.sourceSha,
            generationId: null,
            updatedAtMs: 0,
            updatedAt: new Date(0).toISOString(),
            observationCount: 0,
            predicates: [],
          }
        : existing
  }

  /** The merged, monotonic view (defensive copy). */
  current(): RecorderFile {
    return {
      ...this.state,
      predicates: this.state.predicates.map((predicate) => ({ ...predicate, evidence: { ...predicate.evidence } })),
    }
  }

  private merge(observation: MilestonePredicateObservation): boolean {
    const index = this.state.predicates.findIndex((candidate) => candidate.id === observation.id)
    const existing = index === -1 ? undefined : this.state.predicates[index]
    // `true` is sticky and keeps its FIRST observation: a later generation can
    // never downgrade proven evidence.
    if (existing?.satisfied === true) return false
    if (observation.satisfied === null) {
      // Keep the latest "not yet observed" context (e.g. last dimension), but never
      // let it replace a real observation.
      if (existing === undefined) {
        this.state.predicates.push({ ...observation })
        return true
      }
      if (existing.satisfied === null && observationChanged(existing, observation)) {
        this.state.predicates[index] = { ...observation }
        return true
      }
      return false
    }
    if (existing === undefined) {
      this.state.predicates.push({ ...observation })
      return true
    }
    if (existing.satisfied === false && observation.satisfied === true) {
      this.state.predicates[index] = { ...observation }
      return true
    }
    // Existing false, incoming false: keep the EARLIEST observation.
    if (existing.satisfied === false && observation.satisfied === false) {
      const existingAt = existing.observedAtMs ?? Infinity
      const incomingAt = observation.observedAtMs ?? Infinity
      if (incomingAt < existingAt) {
        this.state.predicates[index] = { ...observation }
        return true
      }
      return false
    }
    // Existing null, incoming real observation.
    this.state.predicates[index] = { ...observation }
    return true
  }

  /**
   * Record one observation pass. Returns true when the persisted file changed.
   * `observationCount` counts passes; the file is rewritten on a real change or
   * once per `refreshMs` so a stable run stops churning the disk.
   */
  observe(observations: readonly MilestonePredicateObservation[], meta: ObserveMeta = {}): boolean {
    if (observations.length === 0) return false
    const now = this.options.now ?? Date.now
    const atMs = typeof meta.atMs === 'number' && Number.isFinite(meta.atMs) ? meta.atMs : now()
    let changed = this.state.predicates.length === 0
    for (const observation of observations) {
      if (!MILESTONE_PREDICATE_IDS.includes(observation.id)) continue
      if (this.merge(observation)) changed = true
    }
    this.state.observationCount += 1
    if (meta.generationId !== undefined) this.state.generationId = meta.generationId
    if (this.options.sourceSha !== null) this.state.sourceSha = this.options.sourceSha
    const refreshMs = this.options.refreshMs ?? 30000
    const stale = atMs - this.state.updatedAtMs >= refreshMs
    if (!changed && !stale) return false
    this.state.updatedAtMs = atMs
    this.state.updatedAt = new Date(atMs).toISOString()
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`)
      renameSync(tmp, this.path)
    } catch (error) {
      this.options.log?.('ERROR', {
        where: 'milestone-predicates',
        path: this.path,
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
    this.options.log?.('MILESTONE_PREDICATES', {
      path: this.path,
      runId: this.state.runId,
      generationId: this.state.generationId,
      observationCount: this.state.observationCount,
      satisfied: this.state.predicates.filter((predicate) => predicate.satisfied === true).map((predicate) => predicate.id),
    })
    return true
  }
}
