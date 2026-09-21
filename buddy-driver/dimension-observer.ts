// dimension-observer.ts - edge-triggered "which world is the body actually in"
// evidence for ONE generation.
//
// Why this exists: a Nether arrival is a WORLD fact, not an inventory fact, so the
// run-scoped M3 gate reads `dimension=<id>` lines from the resident log. Before
// this module that string only appeared on incidental markers (SPAWN,
// STRUCTURE_SITE_MEMORY, M2_SNAPSHOT), so a run could enter the Nether and still
// leave `nether_reached: UNKNOWN` because nothing happened to log the dimension.
// This observer makes the observation explicit: the current dimension is stated
// once at generation start and once per CHANGE. It is observation only - it never
// decides where to go and never ranks an action.
//
// Normalisation lives here, in one place. Mineflayer reports the BARE id
// (`the_nether`) while the durable world key and the portal postcondition use the
// namespaced form (`minecraft:the_nether`). `canonicalDimensionId` is the
// namespaced form the evidence records; `normalizeDimensionId` is the
// prefix-insensitive form used for equality comparisons.

/** Namespace every canonical dimension id carries. */
const NAMESPACE = 'minecraft:'

/**
 * Canonical namespaced dimension id (`minecraft:the_nether`). An absent/empty
 * observation canonicalises to `''` so "unknown" stays distinct from every real
 * dimension, matching the durable-state convention (`world.dimension === ''`).
 */
export function canonicalDimensionId(dimension: string | null | undefined): string {
  const raw = typeof dimension === 'string' ? dimension.trim().toLowerCase() : ''
  if (raw.length === 0) return ''
  return raw.startsWith(NAMESPACE) ? raw : `${NAMESPACE}${raw}`
}

/**
 * Prefix-insensitive equality form: `the_nether` and `minecraft:the_nether` are
 * the same dimension. An unobserved dimension stays `''`.
 */
export function normalizeDimensionId(dimension: string | null | undefined): string {
  return canonicalDimensionId(dimension).slice(NAMESPACE.length)
}

/** The generation's structured log, exactly as `GenerationContext.log`. */
export type DimensionLog = (event: string, detail?: Record<string, unknown>) => void

export interface DimensionObserver {
  /**
   * Record the live dimension for one generation tick and return the canonical
   * current dimension. Emits exactly ONE `DIMENSION_TRANSITION` line the first
   * time a different dimension is observed; a repeat of the same dimension
   * emits nothing.
   */
  observe(dimension: string | null | undefined, reason: string): string
  /** Canonical dimension most recently observed (`''` = unknown). */
  current(): string
}

/** The evidence field: an unobserved dimension is stated, never silently omitted. */
function evidenceDimension(dimension: string): string {
  return dimension.length === 0 ? 'unknown' : dimension
}

/**
 * Create the observer for one generation and emit the run's opening
 * `DIMENSION_OBSERVED` line. A generation that starts (or resumes via hot
 * reload) already in the Nether therefore records that fact immediately, before
 * any transition can happen.
 */
export function createDimensionObserver(
  log: DimensionLog,
  runId: string | null | undefined,
  initial: string | null | undefined,
): DimensionObserver {
  let current = canonicalDimensionId(initial)
  log('DIMENSION_OBSERVED', {
    dimension: evidenceDimension(current),
    runId: runId ?? null,
    reason: 'generation-start',
    source: 'live-world',
  })
  return {
    observe(dimension, reason) {
      const next = canonicalDimensionId(dimension)
      if (next === current) return current
      const from = current
      current = next
      log('DIMENSION_TRANSITION', {
        from: evidenceDimension(from),
        to: evidenceDimension(next),
        // `dimension=` is the canonical current field the run-scoped gates read,
        // so a transition is itself a dimension observation.
        dimension: evidenceDimension(next),
        runId: runId ?? null,
        reason,
        source: 'live-world',
      })
      return current
    },
    current: () => current,
  }
}
