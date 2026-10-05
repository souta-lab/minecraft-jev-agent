// system2Authority.ts - causal validity contract for asynchronous System2 plans.
//
// A System2 request is a read of semantic state, not a lease to mutate that
// state later.  The response may be applied only while the identity it read is
// still current.  This module is deliberately pure so the request/apply race is
// regression-tested without a Mineflayer connection or a model call.

import { modelAuthorityIdentityMismatch } from '../modelFailure.ts'
import type { ModelAuthorityIdentity, ModelAuthorityMismatch } from '../modelFailure.ts'

export interface System2RecoveryFenceInput {
  expectedAuthority: ModelAuthorityIdentity
  actualAuthority: ModelAuthorityIdentity | null
  expectedSourceSha: string | null
  actualSourceSha: string | null
  intentSource: string | null
}

export interface System2RecoveryFenceRejection {
  reason: ModelAuthorityMismatch
  expectedAuthority: ModelAuthorityIdentity
  actualAuthority: ModelAuthorityIdentity | null
  expectedSourceSha: string | null
  actualSourceSha: string | null
  intentSource: string | null
}

export type System2RecoveryFenceResult<T> =
  | { applied: true; value: T }
  | { applied: false; rejection: System2RecoveryFenceRejection }

/**
 * A recovered System2 generation must apply a fresh answer from the same
 * configured provider/model and exact source. Cached plans carry semantic
 * authority from an older call and are refused BEFORE any queue mutation.
 */
export function applySystem2RecoveryFence<T>(
  input: System2RecoveryFenceInput,
  apply: () => T,
): System2RecoveryFenceResult<T> {
  const identityMismatch = modelAuthorityIdentityMismatch(input.expectedAuthority, input.actualAuthority)
  let reason = identityMismatch
  if (reason === null) {
    if (input.expectedSourceSha === null || !/^[a-f0-9]{40}$/i.test(input.expectedSourceSha)) reason = 'expected-source-missing'
    else if (input.actualSourceSha === null || !/^[a-f0-9]{40}$/i.test(input.actualSourceSha)) reason = 'actual-source-missing'
    else if (input.expectedSourceSha.toLowerCase() !== input.actualSourceSha.toLowerCase()) reason = 'source-mismatch'
    else if (input.intentSource !== 'intent' && input.intentSource !== 'enrichment' && input.intentSource !== 'ungrounded') reason = 'response-source-mismatch'
  }
  if (reason !== null) {
    return {
      applied: false,
      rejection: {
        reason,
        expectedAuthority: input.expectedAuthority,
        actualAuthority: input.actualAuthority,
        expectedSourceSha: input.expectedSourceSha,
        actualSourceSha: input.actualSourceSha,
        intentSource: input.intentSource,
      },
    }
  }
  return { applied: true, value: apply() }
}

export interface System2RequestContext {
  requestId: string
  queueRevision: number
  optionInstanceId: string | null
  optionTemplateId: string | null
  worldEpoch: number
  stateFingerprint: string
  /** World/blocker fingerprint used to compare System2 causal outcomes. */
  semanticStateFingerprint?: string
  /**
   * Semantic inputs that must remain stable while the asynchronous answer is in
   * flight. Unlike `stateFingerprint`, this intentionally excludes body position
   * and other movement-only facts; the response is recompiled against the live
   * Option snapshot before the queue is mutated.
   */
  objectiveFingerprint?: string
  inventoryFingerprint?: string
  dimension?: string | null
  /** Exact block-state mutation revision, omitted when the scheduler cannot prove it. */
  worldTopologyRevision?: number
  /** Stable sensed-world facts, excluding body-relative distance/reachability. */
  worldFactsFingerprint?: string
  /** Threat identities and safety state, excluding movement-only distance changes. */
  threatFingerprint?: string
  /** Hunger, health, equipment and active body capabilities not represented in inventory counts. */
  survivalFingerprint?: string
  authorityEpoch: number
}

export interface System2ApplyState {
  queueRevision: number
  optionInstanceId: string | null
  optionTemplateId: string | null
  worldEpoch: number
  stateFingerprint: string
  objectiveFingerprint?: string
  inventoryFingerprint?: string
  dimension?: string | null
  worldTopologyRevision?: number
  worldFactsFingerprint?: string
  threatFingerprint?: string
  survivalFingerprint?: string
  authorityEpoch: number
  /** An in-flight physical action owns the body; a plan must not replace it. */
  actionInFlight: boolean
}

export type System2DiscardReason =
  | 'queue_revision_changed'
  | 'option_instance_changed'
  | 'option_template_changed'
  | 'world_epoch_changed'
  | 'objective_changed'
  | 'inventory_changed'
  | 'dimension_changed'
  | 'world_topology_changed'
  | 'world_facts_changed'
  | 'threat_state_changed'
  | 'survival_state_changed'
  | 'state_fingerprint_changed'
  | 'authority_epoch_changed'
  | 'action_in_flight'

export interface System2ApplyDecision {
  apply: boolean
  reasons: System2DiscardReason[]
}

/** Control-plane actions do not own the body and must not block a System2 plan apply. */
export function system2BodyOwned(actionKind: string | null): boolean {
  return actionKind !== null && actionKind !== 'WAIT' && actionKind !== 'ESCALATE'
}

/**
 * Direction-aware inventory freshness. A plan's basis is the resource floor it
 * was authored against: pickups landing while the model answers cannot break
 * that basis, only losses/consumption can. Portal-p3 evidence (2026-09-27):
 * raw fingerprint equality churned on every cobblestone pickup and discarded
 * the very explore/iron plans whose execution produced those gains. Fingerprints
 * are `item=count` CSV; an unparsable or absent current side falls back to the
 * conservative changed-verdict.
 */
function parseInventoryCounts(fingerprint: string): Map<string, number> {
  const counts = new Map<string, number>()
  if (fingerprint.length === 0) return counts
  for (const entry of fingerprint.split(',')) {
    const sep = entry.lastIndexOf('=')
    if (sep <= 0) continue
    const count = Number(entry.slice(sep + 1))
    if (Number.isFinite(count)) counts.set(entry.slice(0, sep), count)
  }
  return counts
}

function inventoryBasisLost(requestFingerprint: string, currentFingerprint: string | undefined): boolean {
  if (currentFingerprint === requestFingerprint) return false
  if (currentFingerprint === undefined) return true
  const requested = parseInventoryCounts(requestFingerprint)
  const current = parseInventoryCounts(currentFingerprint)
  for (const [item, count] of requested) {
    if ((current.get(item) ?? 0) < count) return true
  }
  return false
}

/**
 * The world-facts basis a plan's goals directly name: resource/station names
 * plus whether the *_log family is a named source. The apply fence only needs
 * "could a lost fact have been part of the authored basis"; which names enter
 * the set is computed by the plan layer (`planWorldFactsBasis`).
 */
export interface PlanWorldFactsBasis {
  readonly names: ReadonlySet<string>
  readonly logLike: boolean
}

interface WorldFactsFingerprint {
  resources?: ReadonlyArray<{ name?: unknown }>
  stations?: ReadonlyArray<unknown>
  furnaces?: ReadonlyArray<unknown>
}

function parseWorldFactsFingerprint(fingerprint: string): WorldFactsFingerprint | null {
  try {
    const parsed: unknown = JSON.parse(fingerprint)
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as WorldFactsFingerprint
  } catch {
    return null
  }
}

function worldFactNameReferenced(name: unknown, basis: PlanWorldFactsBasis): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  return basis.names.has(name) || (basis.logLike && (name.endsWith('_log') || name.endsWith('_wood')))
}

/**
 * Direction-aware, plan-scoped world-facts freshness. The fingerprint protects
 * plan authorship: a plan must not apply when the durable facts it was authored
 * against have been lost. Raw equality cannot express that — it discards on
 * ANY remembered-cell churn, including cells no goal references. Measured live
 * (portal-p24, run-muvh4ofl / gen-muviaewk, 2026-10-07): `opt=none` over-harvest
 * falsified remembered coal_ore/stone/gravel cells on each verified dig while
 * the model answered, and consecutive `queue_empty` responses landed
 * `world_facts_changed` even though the smelt/furnace goals never named the
 * churned cells.
 *
 * Verdict: only a LOST basis entry the plan names can void it. Newly-remembered
 * entries never can — added supply cannot break an authored premise (same
 * direction as `inventoryBasisLost`). Churn on facts the plan does not name
 * re-grounds at offer time instead.
 */
function worldFactsBasisLost(
  requestFingerprint: string,
  currentFingerprint: string | undefined,
  basis: PlanWorldFactsBasis | null | undefined,
): boolean {
  if (currentFingerprint === requestFingerprint) return false
  if (currentFingerprint === undefined) return true
  // No plan scope (older callers): keep the historical strict verdict.
  if (basis === null || basis === undefined) return true
  const request = parseWorldFactsFingerprint(requestFingerprint)
  const current = parseWorldFactsFingerprint(currentFingerprint)
  if (request === null || current === null) return true
  const currentEntries = new Set<string>()
  for (const resource of current.resources ?? []) currentEntries.add(`r:${JSON.stringify(resource)}`)
  for (const station of current.stations ?? []) currentEntries.add(`s:crafting_table:${JSON.stringify(station)}`)
  for (const station of current.furnaces ?? []) currentEntries.add(`s:furnace:${JSON.stringify(station)}`)
  for (const resource of request.resources ?? []) {
    if (currentEntries.has(`r:${JSON.stringify(resource)}`)) continue
    if (worldFactNameReferenced(resource.name, basis)) return true
  }
  if (basis.names.has('crafting_table')) {
    for (const station of request.stations ?? []) {
      if (!currentEntries.has(`s:crafting_table:${JSON.stringify(station)}`)) return true
    }
  }
  if (basis.names.has('furnace')) {
    for (const station of request.furnaces ?? []) {
      if (!currentEntries.has(`s:furnace:${JSON.stringify(station)}`)) return true
    }
  }
  return false
}

/**
 * Prove that a response still describes the state it was requested against.
 * Every mismatch is retained in the result: a discard is evidence, and the
 * reason must not be hidden behind a generic "stale" label.
 */
export function evaluateSystem2Apply(
  request: System2RequestContext,
  current: System2ApplyState,
  planBasis?: PlanWorldFactsBasis | null,
): System2ApplyDecision {
  const reasons: System2DiscardReason[] = []
  if (current.queueRevision !== request.queueRevision) reasons.push('queue_revision_changed')
  if (current.optionInstanceId !== request.optionInstanceId) reasons.push('option_instance_changed')
  if (current.optionTemplateId !== request.optionTemplateId) reasons.push('option_template_changed')
  if (current.worldEpoch !== request.worldEpoch) reasons.push('world_epoch_changed')
  if (
    request.objectiveFingerprint !== undefined &&
    current.objectiveFingerprint !== request.objectiveFingerprint
  ) reasons.push('objective_changed')
  if (
    request.inventoryFingerprint !== undefined &&
    inventoryBasisLost(request.inventoryFingerprint, current.inventoryFingerprint)
  ) reasons.push('inventory_changed')
  if (request.dimension !== undefined && current.dimension !== request.dimension) reasons.push('dimension_changed')
  if (
    request.worldTopologyRevision !== undefined &&
    current.worldTopologyRevision !== request.worldTopologyRevision
  ) reasons.push('world_topology_changed')
  if (
    request.worldFactsFingerprint !== undefined &&
    worldFactsBasisLost(request.worldFactsFingerprint, current.worldFactsFingerprint, planBasis)
  ) reasons.push('world_facts_changed')
  if (
    request.threatFingerprint !== undefined &&
    current.threatFingerprint !== request.threatFingerprint
  ) reasons.push('threat_state_changed')
  if (
    request.survivalFingerprint !== undefined &&
    current.survivalFingerprint !== request.survivalFingerprint
  ) reasons.push('survival_state_changed')
  const hasGranularSemanticFence =
    request.objectiveFingerprint !== undefined ||
    request.inventoryFingerprint !== undefined ||
    request.dimension !== undefined ||
    request.worldTopologyRevision !== undefined ||
    request.worldFactsFingerprint !== undefined ||
    request.threatFingerprint !== undefined ||
    request.survivalFingerprint !== undefined
  // Older embedders have only the broad fingerprint. Keep their historical
  // stale-result fence; production callers with explicit semantic identity use
  // those fields so body-only movement does not invalidate a plan.
  if (!hasGranularSemanticFence && current.stateFingerprint !== request.stateFingerprint) {
    reasons.push('state_fingerprint_changed')
  }
  if (current.authorityEpoch !== request.authorityEpoch) reasons.push('authority_epoch_changed')
  if (current.actionInFlight) reasons.push('action_in_flight')
  return { apply: reasons.length === 0, reasons }
}

export function formatSystem2Discard(request: System2RequestContext, reasons: readonly System2DiscardReason[]): string {
  return `SYSTEM2_PLAN_DISCARDED request=${request.requestId} reasons=${reasons.join(',') || 'unknown'}`
}

/** One applied queue row, reduced to the fields that carry its executable meaning. */
export interface CompiledGoalRow {
  id: string
  kind: string
  targetItem: string | null
  targetY: number | null
  dimension: string | null
  description: string
}

/**
 * #system2-compile: the compact, single-line form of the rows a System2 answer
 * actually produced (`kind:target@dimension`), mirrored on the applied line.
 *
 * The measured M3 loop applied a row whose label said `explore` while its
 * executable meaning was `descend raw_iron @minecraft:overworld`, and the applied
 * line carried only the label. Naming kind/target/dimension makes the compiled
 * meaning - not the model's wording - the visible fact. Pure, bounded and
 * injection-safe so it can be asserted in a fixture.
 */
export function formatCompiledGoalRows(rows: readonly CompiledGoalRow[]): string {
  if (rows.length === 0) return 'none'
  return rows
    .map((row) => {
      const target = row.targetItem ?? (row.targetY === null ? '-' : `y${row.targetY}`)
      const dimension = row.dimension === null ? '' : `@${row.dimension.replace(/^minecraft:/, '')}`
      return `${sanitizeCompiledToken(row.kind)}:${sanitizeCompiledToken(target)}${sanitizeCompiledToken(dimension)}`
    })
    .join(',')
}

/** Bounded, separator-free token so one row can never forge another row or field. */
function sanitizeCompiledToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_:.~#-]/g, '_').slice(0, 48)
}

/** Everything the mirrored apply line reports about one System2 -> queue hand-off. */
export interface System2AppliedLine {
  requestId: string
  op: string
  /** False when the controller/GoalQueue rejected the operation or protected empty plan. */
  accepted: boolean
  /** rows the queue accepted */
  applied: number
  /** unfinished queue depth after the apply */
  depth: number
  intentSource: string
  /** model goals the compile dropped, if any */
  uncompiled: number
  intent?: string | null
  rows: readonly CompiledGoalRow[]
}

/**
 * #system2-compile: the MIRRORED one-line record of what a System2 answer became.
 *
 * It names the model's own words (`intent`), the executable meaning of every row
 * the queue took (`compiled=[kind:target@dimension]`) and the apply outcome, in a
 * form that is a single marker line so both evidence planes can carry it. The
 * measured M3 loop applied `explore`-labelled rows whose real meaning was an
 * overworld raw_iron descent, and nothing on the applied line said so.
 *
 * Pure and bounded: the intent is collapsed to one line and the row tokens are
 * sanitized, so model text can never forge a field or a second row.
 */
export function formatSystem2PlanApplied(line: System2AppliedLine): string {
  return (
    `${SYSTEM2_PLAN_APPLIED} op=${sanitizeCompiledToken(line.op)} requestId=${sanitizeCompiledToken(line.requestId)}` +
    ` accepted=${line.accepted}` +
    ` applied=${line.applied} depth=${line.depth} intentSource=${sanitizeCompiledToken(line.intentSource)}` +
    ` uncompiled=${line.uncompiled} compiled=[${formatCompiledGoalRows(line.rows)}]` +
    ` intent="${flattenProse(line.intent)}"`
  )
}

/** The mirrored marker for an applied System2 plan (see `formatSystem2PlanApplied`). */
export const SYSTEM2_PLAN_APPLIED = 'SYSTEM2_PLAN_APPLIED'

/** The mirrored marker for a goal-carrying System2 answer that produced no row. */
export const SYSTEM2_PLAN_NO_GOALS = 'SYSTEM2_PLAN_NO_GOALS'

/** One line, no quotes/backslashes, bounded - so a model sentence cannot forge fields. */
function flattenProse(text: string | null | undefined): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["\\]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
