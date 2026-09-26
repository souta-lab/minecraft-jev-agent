// system2-harness/optionGraph.ts - the authoritative OptionGraph and its atomic
// commit boundary (#439 sections 11/12/14).
//
// Rules:
//   * the patch is applied WHOLE and committed as ONE new revision (S13);
//   * compare-and-swap on `baseRevision`: a patch compiled against an older
//     revision is refused wholesale (`stale`), never rebased;
//   * the old graph stays authoritative until the commit succeeds;
//   * the execution/compatibility queue is DERIVED (read-only) from the graph,
//     never the authority (#439 section 12);
//   * every committed Option carries exactly one authority origin, so save/
//     reload preserves causal identity (#439 section 14, fixture 17).

import { canonicalJson, deepFreeze, hashId } from './canonical.ts'
import type {
  CompiledOption,
  OptionGraph,
  OptionGraphOption,
  OptionGraphPatch,
  OptionOrigin,
} from './contract.ts'

export type PatchApplication =
  | { readonly ok: true; readonly graph: OptionGraph }
  | { readonly ok: false; readonly reason: string }

export function emptyOptionGraph(): OptionGraph {
  return deepFreeze({ revision: 0, options: [], committedArtifactId: null })
}

function findByOptionId(options: readonly OptionGraphOption[], optionId: string): number {
  return options.findIndex((entry) => entry.option.optionId === optionId)
}

/** Pure patch application. Never mutates the input graph (#439 section 11). */
export function applyOptionGraphPatch(graph: OptionGraph, patch: OptionGraphPatch): PatchApplication {
  if (patch.baseRevision !== graph.revision) {
    return { ok: false, reason: `patch base revision ${patch.baseRevision} != graph revision ${graph.revision}` }
  }
  const options: OptionGraphOption[] = graph.options.map((entry) => ({ ...entry }))
  for (const entry of patch.entries) {
    switch (entry.op) {
      case 'add': {
        const index = findByOptionId(options, entry.option.optionId)
        if (index >= 0) {
          options[index] = { option: entry.option, status: 'active' }
        } else {
          options.push({ option: entry.option, status: 'active' })
        }
        break
      }
      case 'replace': {
        const index = findByOptionId(options, entry.targetOptionId)
        if (index < 0) return { ok: false, reason: `replace target ${entry.targetOptionId} does not exist` }
        options[index] = { option: entry.option, status: 'active' }
        break
      }
      case 'suspend': {
        const index = findByOptionId(options, entry.targetOptionId)
        if (index < 0) return { ok: false, reason: `suspend target ${entry.targetOptionId} does not exist` }
        const current = options[index]
        if (current !== undefined) options[index] = { option: current.option, status: 'suspended' }
        break
      }
      case 'resume': {
        const index = findByOptionId(options, entry.targetOptionId)
        if (index < 0) return { ok: false, reason: `resume target ${entry.targetOptionId} does not exist` }
        const current = options[index]
        if (current === undefined) break
        options[index] = entry.option === undefined ? { option: current.option, status: 'active' } : { option: entry.option, status: 'active' }
        break
      }
    }
  }
  return {
    ok: true,
    graph: deepFreeze({
      revision: graph.revision + 1,
      options,
      committedArtifactId: patch.artifactId,
    }),
  }
}

export type CommitResult =
  | { readonly status: 'committed'; readonly fromRevision: number; readonly toRevision: number; readonly graph: OptionGraph }
  | { readonly status: 'stale'; readonly currentRevision: number }
  | { readonly status: 'refused'; readonly reason: string }

/** The HOST-owned semantic transaction boundary (#439 section 11). */
export interface OptionGraphAuthority {
  snapshot(): OptionGraph
  commit(patch: OptionGraphPatch): CommitResult
}

/**
 * In-memory authority used by the harness, fixtures and replay. Production wires
 * the same interface onto the resident host's durable semantic state; the
 * harness never touches storage directly.
 */
export class InMemoryOptionGraphAuthority implements OptionGraphAuthority {
  private graph: OptionGraph

  constructor(initial: OptionGraph = emptyOptionGraph()) {
    this.graph = deepFreeze(initial)
  }

  snapshot(): OptionGraph {
    return this.graph
  }

  commit(patch: OptionGraphPatch): CommitResult {
    const current = this.graph
    if (patch.baseRevision !== current.revision) {
      return { status: 'stale', currentRevision: current.revision }
    }
    const applied = applyOptionGraphPatch(current, patch)
    if (!applied.ok) return { status: 'refused', reason: applied.reason }
    const fromRevision = current.revision
    this.graph = applied.graph
    return { status: 'committed', fromRevision, toRevision: applied.graph.revision, graph: applied.graph }
  }

  /**
   * Seed an option whose authority is NOT System2 (deterministic exception /
   * human intent). Used by fixtures and by the Phase F exception path; it is
   * explicit about the origin so no committed Option is ever origin-less (S14).
   */
  seed(option: CompiledOption): OptionGraph {
    const options = [...this.graph.options, { option, status: 'active' as const }]
    this.graph = deepFreeze({ revision: this.graph.revision + 1, options, committedArtifactId: this.graph.committedArtifactId })
    return this.graph
  }
}

// ---------------------------------------------------------------------------
// derived execution/compatibility queue (#439 section 12)
// ---------------------------------------------------------------------------

export interface ExecutionQueueRow {
  readonly rowIndex: number
  readonly optionId: string
  readonly optionInstanceId: string
  readonly intentText: string
  readonly originKind: OptionOrigin['kind']
  readonly desiredPredicates: readonly string[]
  readonly dependencies: readonly string[]
}

/**
 * Compatibility-only derivation. Derived rows are read-only: nothing may treat
 * them as the semantic authority, and an empty queue must not summon a ladder
 * (#439 sections 12/14, fixture 16).
 */
export function deriveExecutionQueue(graph: OptionGraph): readonly ExecutionQueueRow[] {
  return graph.options
    .filter((entry) => entry.status === 'active')
    .map((entry, rowIndex) => ({
      rowIndex,
      optionId: entry.option.optionId,
      optionInstanceId: entry.option.optionInstanceId,
      intentText: entry.option.intentText,
      originKind: entry.option.origin.kind,
      desiredPredicates: entry.option.desiredPredicates.map((spec) => spec.kind),
      dependencies: entry.option.dependencies.map((spec) => spec.kind),
    }))
}

// ---------------------------------------------------------------------------
// durable plain-data round trip (#439 section 14, fixture 17)
// ---------------------------------------------------------------------------

export interface SerializedOptionGraph {
  readonly record: 'SYSTEM2_OPTION_GRAPH'
  readonly schemaVersion: 1
  readonly graph: OptionGraph
  readonly graphHash: string
}

export function serializeOptionGraph(graph: OptionGraph): string {
  const graphHash = hashId(canonicalJson(graph as unknown as Record<string, unknown>), 32)
  const record: SerializedOptionGraph = { record: 'SYSTEM2_OPTION_GRAPH', schemaVersion: 1, graph, graphHash }
  return canonicalJson(record as unknown as Record<string, unknown>)
}

export class OptionGraphRestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OptionGraphRestoreError'
  }
}

/**
 * Restore a durable graph. Origin records are plain data and survive the round
 * trip, so a reloaded Option still links to the artifact that created it.
 */
export function restoreOptionGraph(json: string): OptionGraph {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new OptionGraphRestoreError(`graph record is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object') throw new OptionGraphRestoreError('graph record is not an object')
  const record = parsed as Partial<SerializedOptionGraph>
  if (record.record !== 'SYSTEM2_OPTION_GRAPH') throw new OptionGraphRestoreError(`unexpected record ${String(record.record)}`)
  const graph = record.graph
  if (graph === null || typeof graph !== 'object' || typeof graph.revision !== 'number' || !Array.isArray(graph.options)) {
    throw new OptionGraphRestoreError('graph record is malformed')
  }
  for (const entry of graph.options) {
    const option = entry?.option
    if (option === undefined || option.origin === undefined || option.origin.kind === undefined) {
      throw new OptionGraphRestoreError('committed Option is missing its authority origin')
    }
  }
  return deepFreeze(graph)
}

/** Every committed Option's origin, for S14 audits. */
export function originsOf(graph: OptionGraph): ReadonlyMap<string, OptionOrigin> {
  const map = new Map<string, OptionOrigin>()
  for (const entry of graph.options) map.set(entry.option.optionInstanceId, entry.option.origin)
  return map
}
