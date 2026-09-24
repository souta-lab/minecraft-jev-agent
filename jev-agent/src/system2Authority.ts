// system2Authority.ts - causal validity contract for asynchronous System2 plans.
//
// A System2 request is a read of semantic state, not a lease to mutate that
// state later.  The response may be applied only while the identity it read is
// still current.  This module is deliberately pure so the request/apply race is
// regression-tested without a Mineflayer connection or a model call.

import { modelAuthorityIdentityMismatch } from './modelFailure.ts'
import type { ModelAuthorityIdentity, ModelAuthorityMismatch } from './modelFailure.ts'

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
  authorityEpoch: number
}

export interface System2ApplyState {
  queueRevision: number
  optionInstanceId: string | null
  optionTemplateId: string | null
  worldEpoch: number
  stateFingerprint: string
  authorityEpoch: number
  /** An in-flight physical action owns the body; a plan must not replace it. */
  actionInFlight: boolean
}

export type System2DiscardReason =
  | 'queue_revision_changed'
  | 'option_instance_changed'
  | 'option_template_changed'
  | 'world_epoch_changed'
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
 * Prove that a response still describes the state it was requested against.
 * Every mismatch is retained in the result: a discard is evidence, and the
 * reason must not be hidden behind a generic "stale" label.
 */
export function evaluateSystem2Apply(
  request: System2RequestContext,
  current: System2ApplyState,
): System2ApplyDecision {
  const reasons: System2DiscardReason[] = []
  if (current.queueRevision !== request.queueRevision) reasons.push('queue_revision_changed')
  if (current.optionInstanceId !== request.optionInstanceId) reasons.push('option_instance_changed')
  if (current.optionTemplateId !== request.optionTemplateId) reasons.push('option_template_changed')
  if (current.worldEpoch !== request.worldEpoch) reasons.push('world_epoch_changed')
  if (current.stateFingerprint !== request.stateFingerprint) reasons.push('state_fingerprint_changed')
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
