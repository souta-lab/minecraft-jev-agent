// system-one-policy.ts - a deterministic System One policy wrapper.
//
// The stock fallback policy has no DESCEND branch, so a stalled goal whose only
// productive candidate is a staircase/tunnel step collapses to WAIT and wedges.
// This wrapper delegates to the stock fallback and, only when it would WAIT,
// promotes a fresh, non-hazard DESCEND candidate instead. It never touches
// action authority semantics: it is still a local, deterministic rule policy,
// and the existing guard re-validates the candidate before execution.
import type { JevPolicy, JevRequest, JevResult } from '../jev-agent/src/jev.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
import type { DeathHazard } from './resident-types.ts'

function nearHardHazard(hazards: readonly DeathHazard[], pos: { x: number; y: number; z: number }): DeathHazard | null {
  const x = Math.round(pos.x)
  const y = Math.round(pos.y)
  const z = Math.round(pos.z)
  for (const hazard of hazards) {
    if (hazard.count < 2) continue
    if (Math.abs(x - hazard.x) <= 1 && Math.abs(y - hazard.y) <= 1 && Math.abs(z - hazard.z) <= 1) return hazard
  }
  return null
}

export function pickDescend(request: JevRequest, hazards: readonly DeathHazard[]): Candidate | null {
  for (const candidate of request.candidates) {
    if (candidate.kind !== 'DESCEND') continue
    if (candidate.target !== null && nearHardHazard(hazards, candidate.target) !== null) continue
    return candidate
  }
  return null
}

function excludeHardHazardCandidates(candidates: readonly Candidate[], hazards: readonly DeathHazard[]): readonly Candidate[] {
  if (hazards.every((hazard) => hazard.count < 2)) return candidates
  return candidates.filter((candidate) => candidate.target === null || nearHardHazard(hazards, candidate.target) === null)
}

export class DescendAwarePolicy implements JevPolicy {
  readonly kind = 'fallback' as const
  readonly model: string
  private readonly inner: JevPolicy
  private readonly hazards: readonly DeathHazard[]
  private readonly log: (event: string, detail?: Record<string, unknown>) => void

  constructor(inner: JevPolicy, hazards: readonly DeathHazard[], log: (event: string, detail?: Record<string, unknown>) => void) {
    this.inner = inner
    this.hazards = hazards
    this.log = log
    this.model = `${inner.model}+descend-aware`
  }

  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const safeRequest: JevRequest = { ...request, candidates: excludeHardHazardCandidates(request.candidates, this.hazards) }
    const result = await this.inner.decide(safeRequest, signal)
    const action = result.answers.action
    if (action === undefined || action.value !== 'WAIT') return result
    const descend = pickDescend(safeRequest, this.hazards)
    if (descend === null) return result
    const depth = descend.target === null ? null : descend.target.y
    this.log('EXPLORE', {
      kind: descend.meta.mode === 'down' ? 'descend' : 'branch',
      target: descend.targetName ?? request.state.goal.targetItem ?? 'unknown',
      depth,
      id: descend.id,
      mode: descend.meta.mode,
    })
    return {
      ...result,
      answers: {
        ...result.answers,
        action: {
          ...action,
          value: descend.id,
          probabilities: { [descend.id]: 1 },
          note: 'descend-aware fallback override (stock policy had no DESCEND branch)',
        },
      },
    }
  }
}

/** Wrap the controller's own System One policy in place. The controller type is
 * imported read-only, so the private field is addressed through a narrow cast;
 * no jev-agent file is modified. */
export function installDescendAwarePolicy(
  controller: object,
  hazards: readonly DeathHazard[],
  log: (event: string, detail?: Record<string, unknown>) => void,
): void {
  const holder = controller as { jev?: JevPolicy }
  if (holder.jev === undefined) return
  holder.jev = new DescendAwarePolicy(holder.jev, hazards, log)
}
