// Wedge/wait-repeat pure evaluators extracted from controller.ts.
// The controller no longer applies wedge verdicts mechanically (a repeat is
// policy evidence, not a semantic veto); these functions are kept as the
// tested decision shapes for that evidence.


export interface WaitWedgeInput {
  actionId: string
  goalKey: string
  previousGoalKey: string | null
  streak: number
  waitLimit: number
  replans: number
  replanLimit: number
}

export interface WaitWedgeDecision {
  outcome: 'not-wait' | 'below-limit' | 'replan' | 'wedge'
  streak: number
  goalKey: string
  n: number
}

export function evaluateWaitWedge(input: WaitWedgeInput): WaitWedgeDecision {
  if (input.actionId !== 'WAIT') return { outcome: 'not-wait', streak: 0, goalKey: input.goalKey, n: 0 }
  const streak = input.goalKey === input.previousGoalKey ? input.streak + 1 : 1
  if (streak < input.waitLimit) return { outcome: 'below-limit', streak, goalKey: input.goalKey, n: streak }
  if (input.replans < input.replanLimit) return { outcome: 'replan', streak: 0, goalKey: input.goalKey, n: streak }
  return { outcome: 'wedge', streak: 0, goalKey: input.goalKey, n: streak }
}

export type WedgeSuppressReason = 'progressing' | 'in_flight' | 'fingerprint_changed'

export interface WedgeRepeatInput {
  actionId: string
  previousActionId: string | null
  fingerprint: string
  previousFingerprint: string | null
  inFlight: boolean
  progressed: boolean
  repeats: number
}

export interface WedgeRepeatDecision {
  outcome: 'count' | 'suppress'
  reason: WedgeSuppressReason | null
  /** next consecutive count; 0 after a suppression, 1 on a window restart. */
  repeats: number
  restarted: boolean
}

export function evaluateWedgeRepeat(input: WedgeRepeatInput): WedgeRepeatDecision {
  if (input.progressed) return { outcome: 'suppress', reason: 'progressing', repeats: 0, restarted: false }
  if (input.inFlight) return { outcome: 'suppress', reason: 'in_flight', repeats: 0, restarted: false }
  if (input.previousActionId !== input.actionId) {
    return { outcome: 'count', reason: null, repeats: 1, restarted: true }
  }
  if (input.previousFingerprint !== null && input.previousFingerprint !== input.fingerprint) {
    return { outcome: 'suppress', reason: 'fingerprint_changed', repeats: 0, restarted: false }
  }
  return { outcome: 'count', reason: null, repeats: input.repeats + 1, restarted: false }
}

export function formatWedgeSuppressed(reason: WedgeSuppressReason, candidate: string, repeats: number): string {
  return `WEDGE_SUPPRESSED reason=${reason} candidate=${candidate} repeats=${repeats}`
}

export function formatWedgeAbort(actionId: string, repeats: number, limit: number): string {
  return `action id ${actionId} chosen ${repeats}x with no verified progress (limit ${limit})`
}
