// system-one-policy.ts - deterministic FALLBACK-only System One wrapper.
//
// The stock deterministic fallback policy has no DESCEND branch, so a stalled
// fallback goal whose only productive candidate is a staircase/tunnel step can
// collapse to WAIT and wedge. This wrapper exists only for the explicit
// deterministic baseline (`BUDDY_POLICY=fallback`). It must never wrap the real
// TypeSafe Jev policy: replacing a Jev WAIT with a code-selected DESCEND would
// make deterministic code a second semantic action authority and violate #11.
import type { JevPolicy, JevRequest, JevResult } from '../jev-agent/src/jev.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
import { isInDeathZone } from '../jev-agent/src/moveFailMemory.ts'
import type { DeathHazard } from './resident-types.ts'

/**
 * Hard-hazard membership is AREA-scoped (isInDeathZone): the summed death count
 * within DEATH_ZONE_RADIUS must reach DEATH_ZONE_DEATHS. The old gate —
 * `count>=2` at the exact rounded cell — never fired against a swarm pocket
 * that kills at scattered coordinates: measured portal-p6 had 9 deaths over
 * ~15 m and every cell merged at count=1, so objectives kept routing the body
 * back into the lethal area.
 */
function nearHardHazard(
  hazards: readonly DeathHazard[],
  pos: { x: number; y: number; z: number },
  dimension: string,
): DeathHazard | null {
  return isInDeathZone(hazards, pos, dimension)
}

export function pickDescend(request: JevRequest, hazards: readonly DeathHazard[]): Candidate | null {
  const dimension = request.state.self.dimension
  for (const candidate of request.candidates) {
    if (candidate.kind !== 'DESCEND') continue
    if (candidate.target !== null && nearHardHazard(hazards, candidate.target, dimension) !== null) continue
    return candidate
  }
  return null
}

function excludeHardHazardCandidates(
  candidates: readonly Candidate[],
  hazards: readonly DeathHazard[],
  dimension: string,
): readonly Candidate[] {
  if (hazards.length === 0) return candidates
  return candidates.filter(
    (candidate) => candidate.target === null || nearHardHazard(hazards, candidate.target, dimension) === null,
  )
}

export class DescendAwarePolicy implements JevPolicy {
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

  // Report the wrapped policy's kind, not a hardcoded one: JevController.policyKind
  // (controller.ts:1408) and agent-runner's llm/deterministic pick read it.
  get kind(): JevPolicy['kind'] {
    return this.inner.kind
  }

  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const safeRequest: JevRequest = {
      ...request,
      candidates: excludeHardHazardCandidates(request.candidates, this.hazards, request.state.self.dimension),
    }
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
          note: 'descend-aware deterministic-baseline override (fallback policy had no DESCEND branch)',
        },
      },
    }
  }
}

/**
 * Install the deterministic DESCEND helper only when the controller is already
 * using the explicit fallback policy. A real TypeSafe Jev policy keeps complete
 * WHICH authority; code may filter hard hazards, but must not replace Jev's
 * semantic WAIT with a different valid action.
 */
export function installDescendAwarePolicy(
  controller: object,
  hazards: readonly DeathHazard[],
  log: (event: string, detail?: Record<string, unknown>) => void,
): void {
  const holder = controller as { jev?: JevPolicy }
  if (holder.jev === undefined) return
  if (holder.jev.kind !== 'fallback') return
  holder.jev = new DescendAwarePolicy(holder.jev, hazards, log)
}
