// goalSuccess.ts - code-owned "does this row's success ALREADY hold in the world?"
//
// This is the ADDITIONAL retirement path for the M3 blocker measured live in
// `run-muchajde-1qhat` (main f252804) and, before it, in the restore window of
// `run-mubhx20x-pie2`:
//
//   goal=place:nether_portal:1 actionable=1 count=2 limit=6     <- the queue head
//   m3_predicate portal_verified: PASS  source=host-observe:rung:nether_portal
//   SYSTEM2_PLAN_REQUEST_REASON reason=queue_empty              <- re-summoned behind it
//
// The gate stood built, lit and verified, and the ladder already recorded the
// `nether_portal` rung as achieved (an INHERITED portal, M2 PASS on the
// durable/standard basis), yet a row whose postcondition is "the portal exists"
// kept the queue head. No existing completion path could fire, because every one
// of them (the `markDone()` callers in controller-legacy.ts `syncQueue`) requires
// THIS generation to have run the action sequence: a `goto` within 2.5 m, a stale
// smelt prerequisite, the portal's own ignite/verify postcondition, or the
// per-tick spatial `predicateForGoal` level predicate. When the world truth is
// already true, the row is permanent.
//
// One question, one answer, tri-state:
//
//   satisfied    the row's own postcondition provably holds -> DONE (Code owns DONE)
//   unsatisfied  the loaded world positively says it does not hold -> unchanged
//   unknown      the world did not say anything (unloaded/absent probe) -> unchanged
//
// UNKNOWN is never satisfaction (issue #59), so an unevaluable predicate leaves
// the row exactly as it was. This module never invents, reorders or replaces a
// goal: it is deterministic world truth (CAN/TRUE/DONE), never a WHAT decision
// (see buddy-driver/AGENTS.md section 2).
//
// The predicate families below are keyed on the row's OWN code-owned predicate
// (the `targetPredicate` the Option compiler wrote, or the row's placement
// geometry) - never on a goal id - so a future kind is covered by adding one
// evaluator, not by special-casing a string.
import {
  NETHER_PORTAL,
  OBSIDIAN,
  OVERWORLD,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  isPortalIgnitionPostconditionMet,
  validatePortalFrame,
} from './netherPortalPlan.ts'
import { normalizeDimension } from './predicateGoal.ts'

/** The marker the queue mirrors when a row is retired because its predicate already holds. */
export const GOAL_RETIRED_PREDICATE = 'GOAL_RETIRED_PREDICATE'

/** The marker the queue mirrors when the installed probe itself fails. */
export const GOAL_SUCCESS_PROBE_ERROR = 'GOAL_SUCCESS_PROBE_ERROR'

export type GoalSuccessStatus = 'satisfied' | 'unsatisfied' | 'unknown'

/** The code-owned predicate families this module can evaluate today. */
export type GoalSuccessPredicateId = 'portal_lit' | 'portal_entered' | 'placement_cells'

/** Where a satisfying fact came from - evidence must never blur these. */
export type GoalSuccessSource =
  | 'live-block-read'
  | 'durable-verified-record'
  | 'live-dimension'
  | 'no-record'
  | 'world-unobservable'

export interface GoalSuccessCell {
  x: number
  y: number
  z: number
}

/**
 * A portal site the RUN itself verified, in the geometry-only envelope the
 * durable world memory already carries (`KnownResource` kind `portal`:
 * origin + widthAxis + recorded frame edge cells). The record is a proof that
 * the site WAS verified in its own dimension; its revocation is owned by the
 * world-memory sync (`syncKnownPortalSites`), never by this module.
 */
export interface RecordedPortalSite {
  dimension: string | null
  origin: GoalSuccessCell
  widthAxis: 'x' | 'z'
  frame: readonly GoalSuccessCell[]
}

/**
 * Cells a VERIFIED run record proves are already filled with a named block. The
 * only producer today is a verified portal frame record (a validated portal
 * frame IS obsidian at those cells), but the shape is block-generic: a future
 * verified structure record adds one entry, not a new retirement path.
 *
 * Deliberately narrow: a record only becomes DONE evidence when the run verified
 * the structure from live block truth and the world-memory sync has not revoked
 * it. Unverified/stale station memory (#31) is never trusted here.
 */
export interface GoalSuccessBlockRecord {
  block: string
  dimension: string | null
  cells: readonly GoalSuccessCell[]
}

/** The live/code-owned world facts one evaluation may read. No model, no clock. */
export interface GoalSuccessWorldProbe {
  /** the body's live dimension, or null when the world is not observable */
  dimension: string | null
  /** live block name at a cell, or null when the cell is unreadable/unloaded */
  blockAt: (cell: GoalSuccessCell) => string | null
  /** the run's durable verified-portal records for this world */
  recordedPortalSites: readonly RecordedPortalSite[]
  /** cells a verified run record already proves are filled with a named block */
  verifiedBlockRecords: readonly GoalSuccessBlockRecord[]
}

/**
 * The `portal` entries of the known-resource envelope the controller already
 * carries (`KnownResource`), structurally. `kind === 'portal'` is the durable
 * verified-site record; every other kind is ignored here.
 */
export interface RecordedPortalResource {
  kind?: string
  position: { x: number; y: number; z: number }
  dimension?: string
  widthAxis?: 'x' | 'z'
  frameCells?: readonly { x: number; y: number; z: number }[]
}

/**
 * Project the known-resource envelope's durable portal records into the probe
 * shape. Pure: it neither adds nor revokes a record - `syncKnownPortalSites`
 * (the world-memory sync) owns that from live block truth.
 */
export function recordedPortalSitesFromKnownResources(
  resources: readonly RecordedPortalResource[] | undefined,
): RecordedPortalSite[] {
  const sites: RecordedPortalSite[] = []
  for (const resource of resources ?? []) {
    if (resource.kind !== 'portal') continue
    sites.push({
      dimension: resource.dimension ?? null,
      origin: { x: resource.position.x, y: resource.position.y, z: resource.position.z },
      widthAxis: resource.widthAxis ?? 'x',
      frame: (resource.frameCells ?? []).map((cell) => ({ x: cell.x, y: cell.y, z: cell.z })),
    })
  }
  return sites
}

/**
 * The block records the durable envelope already proves: a portal record's
 * validated frame cells hold the frame block (`obsidian`). Reads the SAME
 * envelope as the portal records above, so a row and the rung that emitted it
 * can never disagree about which world fact was verified.
 */
export function verifiedBlockRecordsFromKnownResources(
  resources: readonly RecordedPortalResource[] | undefined,
): GoalSuccessBlockRecord[] {
  const records: GoalSuccessBlockRecord[] = []
  for (const site of recordedPortalSitesFromKnownResources(resources)) {
    if (site.frame.length === 0) continue
    records.push({ block: OBSIDIAN, dimension: site.dimension, cells: site.frame })
  }
  return records
}

export interface GoalSuccessEvidence {
  status: GoalSuccessStatus
  predicate: GoalSuccessPredicateId
  source: GoalSuccessSource
  /** one readable line naming the observed world fact behind the verdict */
  detail: string
}

/** The row fields this module reads. Structural so the pure module stays queue-free. */
export interface GoalSuccessCandidate {
  kind?: string
  targetItem?: string | null
  targetPredicate?: string | null
  dimension?: string | null
  placementCells?: readonly GoalSuccessCell[] | null
}

/** Exact audit line: the goal, the predicate, and the world fact that satisfied it. */
export function formatGoalSuccessRetirement(
  goal: { id: string; kind: string; targetItem: string | null },
  evidence: GoalSuccessEvidence,
): string {
  const item = goal.targetItem ?? 'none'
  return (
    `${GOAL_RETIRED_PREDICATE} id=${goal.id} kind=${goal.kind} item=${item}` +
    ` predicate=${evidence.predicate} source=${evidence.source} detail="${evidence.detail}"`
  )
}

/** Exact audit line for a probe that threw: the row is left exactly as it was. */
export function formatGoalSuccessProbeError(goalId: string, message: string): string {
  return `${GOAL_SUCCESS_PROBE_ERROR} id=${goalId} message="${message}" action=not_retired`
}

function cellKey(cell: GoalSuccessCell): string {
  return `${cell.x},${cell.y},${cell.z}`
}

/**
 * Are live block reads at these coordinates meaningful for this row? A
 * coordinate only means anything in the dimension it was recorded in, so a
 * KNOWN dimension mismatch makes the live half unobservable - it is never a
 * disproof. (Same guard as `detectPortalVerification`.)
 */
function liveReadAllowed(goalDimension: string | null | undefined, liveDimension: string | null): boolean {
  if (liveDimension === null) return false
  if (typeof goalDimension !== 'string' || goalDimension.length === 0) return true
  return normalizeDimension(goalDimension) === normalizeDimension(liveDimension)
}

/**
 * Does a durable record's dimension cover a row's dimension? An unknown on
 * either side is not a proven conflict; a KNOWN mismatch is.
 */
function dimensionAllows(recordDimension: string | null, goalDimension: string | null | undefined): boolean {
  if (recordDimension === null) return true
  if (typeof goalDimension !== 'string' || goalDimension.length === 0) return true
  return normalizeDimension(recordDimension) === normalizeDimension(goalDimension)
}

/** Is every cell of `cells` already in the verified record's `recorded` set? */
function cellsCoveredBy(cells: readonly GoalSuccessCell[], recorded: readonly GoalSuccessCell[]): boolean {
  if (cells.length === 0 || recorded.length === 0) return false
  const known = new Set(recorded.map(cellKey))
  return cells.every((cell) => known.has(cellKey(cell)))
}

/**
 * The predicate family this row carries, or null when the row has no checkable
 * success predicate. A null answer means "no opinion": the row keeps every
 * existing completion path untouched.
 */
export function goalSuccessPredicateFor(goal: GoalSuccessCandidate): GoalSuccessPredicateId | null {
  if (goal.targetPredicate === PORTAL_LIT_PREDICATE) return 'portal_lit'
  if (goal.targetPredicate === PORTAL_ENTERED_PREDICATE) return 'portal_entered'
  const cells = goal.placementCells ?? null
  if (goal.kind === 'place' && typeof goal.targetItem === 'string' && goal.targetItem.length > 0 && cells !== null && cells.length > 0) {
    return 'placement_cells'
  }
  return null
}

/**
 * Evaluate one row's success predicate against current world truth. Pure and
 * total: it returns null only when the row carries no checkable predicate.
 */
export function evaluateGoalSuccess(
  goal: GoalSuccessCandidate,
  probe: GoalSuccessWorldProbe,
): GoalSuccessEvidence | null {
  switch (goalSuccessPredicateFor(goal)) {
    case 'portal_lit':
      return evaluatePortalLit(goal, probe)
    case 'portal_entered':
      return evaluatePortalEntered(goal, probe)
    case 'placement_cells':
      return evaluatePlacementCells(goal, probe)
    default:
      return null
  }
}

/**
 * `portal_lit` (the `light:nether_portal` and `verify:nether_portal` steps both
 * compile to this one row): the ignition postcondition - every interior cell of a
 * valid frame is `nether_portal` - already holds.
 *
 * Two code-owned halves, strongest first, each named in the evidence:
 *
 *   1. live-block-read: re-read the recorded frame's OWN interior cells through
 *      the live block lookup, in the row's own dimension. A cell that cannot be
 *      read (unloaded chunk / no body) is not a disproof, it is unobservable.
 *   2. durable-verified-record: the run already verified a portal site in this
 *      dimension (`PORTAL_VERIFIED` / `world.knownPortalSites`, the same truth
 *      the ladder's `nether_portal` rung and the M3 `portal_verified` gate read,
 *      and the basis the operator ruled M2 PASS on). A body in the Nether cannot
 *      read overworld chunks, so without this half the stale row would survive
 *      exactly in the measured case.
 *
 * No record and nothing readable is UNKNOWN - never "the portal is gone".
 */
function evaluatePortalLit(goal: GoalSuccessCandidate, probe: GoalSuccessWorldProbe): GoalSuccessEvidence {
  const expectedDimension = typeof goal.dimension === 'string' && goal.dimension.length > 0 ? goal.dimension : OVERWORLD
  const sites = probe.recordedPortalSites.filter(
    (site) =>
      site.dimension === null ||
      typeof site.dimension !== 'string' ||
      site.dimension.length === 0 ||
      normalizeDimension(site.dimension) === normalizeDimension(expectedDimension),
  )
  if (sites.length === 0) {
    return {
      status: 'unknown',
      predicate: 'portal_lit',
      source: 'no-record',
      detail: `no portal site recorded for dimension=${expectedDimension}`,
    }
  }
  const readable = liveReadAllowed(expectedDimension, probe.dimension)
  let readableSites = 0
  if (readable) {
    for (const site of sites) {
      const validation = validatePortalFrame({
        blocks: site.frame.map((cell) => ({ ...cell })),
        widthAxis: site.widthAxis,
      })
      if (validation.shape !== 'ok') continue
      const reads = validation.interior.map((cell) => probe.blockAt(cell))
      // One unreadable cell makes this site unobservable, not disproved.
      if (reads.some((name) => name === null)) continue
      readableSites += 1
      const lit = isPortalIgnitionPostconditionMet(validation.interior, (cell) => probe.blockAt(cell), NETHER_PORTAL)
      if (lit) {
        return {
          status: 'satisfied',
          predicate: 'portal_lit',
          source: 'live-block-read',
          detail:
            `portal interior=${NETHER_PORTAL}x${validation.interior.length} frame=${validation.blocks}` +
            ` origin=${cellKey(site.origin)} dimension=${probe.dimension ?? 'unknown'}`,
        }
      }
    }
  }
  // The run's own verified record is a positive proof of this row's outcome.
  const recorded = sites.find((site) => (site.frame?.length ?? 0) > 0) ?? sites[0]
  if (recorded !== undefined) {
    return {
      status: 'satisfied',
      predicate: 'portal_lit',
      source: 'durable-verified-record',
      detail:
        `verified portal site recorded origin=${cellKey(recorded.origin)} frame=${recorded.frame.length}` +
        ` dimension=${recorded.dimension ?? expectedDimension}`,
    }
  }
  return {
    status: 'unknown',
    predicate: 'portal_lit',
    source: 'world-unobservable',
    detail: `recorded portal sites=${sites.length} readable=${readableSites} liveDimension=${probe.dimension ?? 'unknown'}`,
  }
}

/**
 * `portal_entered` (the dimension-transfer row): the body's own live dimension is
 * the row's target. The transfer IS the postcondition, so a body already in the
 * target dimension holds it - and an unknown dimension is never a satisfaction.
 */
function evaluatePortalEntered(goal: GoalSuccessCandidate, probe: GoalSuccessWorldProbe): GoalSuccessEvidence {
  const expected = typeof goal.dimension === 'string' && goal.dimension.length > 0 ? goal.dimension : null
  if (probe.dimension === null || expected === null) {
    return {
      status: 'unknown',
      predicate: 'portal_entered',
      source: 'world-unobservable',
      detail: `liveDimension=${probe.dimension ?? 'unknown'} target=${expected ?? 'unknown'}`,
    }
  }
  const arrived = normalizeDimension(probe.dimension) === normalizeDimension(expected)
  return {
    status: arrived ? 'satisfied' : 'unsatisfied',
    predicate: 'portal_entered',
    source: 'live-dimension',
    detail: `liveDimension=${probe.dimension} target=${expected} arrived=${arrived}`,
  }
}

/**
 * A `place` row with explicit geometry: the block this row exists to place
 * already occupies every cell it would fill (the portal frame is the measured
 * case: `place obsidian` over the 10 edge cells). Reads are dimension-guarded
 * and a single unreadable cell is UNKNOWN, never absence.
 *
 * Durable half: when the live cells cannot be read (the body is in the Nether
 * while the row belongs to the overworld - the measured cross-dimension shape),
 * a VERIFIED block record that already contains every one of the row's cells is
 * the same positive proof. It is conservative: an incomplete record simply
 * leaves the row alone.
 */
function evaluatePlacementCells(goal: GoalSuccessCandidate, probe: GoalSuccessWorldProbe): GoalSuccessEvidence {
  const cells = goal.placementCells ?? []
  const item = goal.targetItem ?? ''
  if (liveReadAllowed(goal.dimension, probe.dimension)) {
    const reads = cells.map((cell) => ({ cell, name: probe.blockAt(cell) }))
    const unreadable = reads.filter((read) => read.name === null).length
    if (unreadable === 0) {
      const missing = reads.filter((read) => read.name !== item)
      if (missing.length === 0) {
        return {
          status: 'satisfied',
          predicate: 'placement_cells',
          source: 'live-block-read',
          detail: `cells=${cells.length}/${cells.length} block=${item} origin=${cellKey(cells[0]!)}`,
        }
      }
      return {
        status: 'unsatisfied',
        predicate: 'placement_cells',
        source: 'live-block-read',
        detail: `cells=${cells.length - missing.length}/${cells.length} block=${item} missing=${cellKey(missing[0]!.cell)}:${missing[0]!.name ?? 'null'}`,
      }
    }
  }
  const record = probe.verifiedBlockRecords.find(
    (candidate) =>
      candidate.block === item &&
      dimensionAllows(candidate.dimension, goal.dimension) &&
      cellsCoveredBy(cells, candidate.cells),
  )
  if (record !== undefined) {
    return {
      status: 'satisfied',
      predicate: 'placement_cells',
      source: 'durable-verified-record',
      detail: `cells=${cells.length} block=${item} recorded=${record.cells.length} dimension=${record.dimension ?? 'unknown'}`,
    }
  }
  return {
    status: 'unknown',
    predicate: 'placement_cells',
    source: 'world-unobservable',
    detail: `cells=${cells.length} block=${item} liveDimension=${probe.dimension ?? 'unknown'}`,
  }
}
