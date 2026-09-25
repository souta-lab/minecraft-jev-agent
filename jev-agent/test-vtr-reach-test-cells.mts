import type { JevReachRouteDecisionRecord } from './src/jev-reach-vtr-composition.ts'
import type { WorldState } from './src/state.ts'
import type { ReachActuationRequest, ReachRuntimeActionSnapshot, ReachRuntimePorts } from './src/vtr/reach-runtime-ports.ts'

/** Shared host cells for tests that construct JevController adapters via Object.create. */
export function createVtrReachTestCells(input: {
  readonly tickCounter?: number
  readonly jevCalls?: number
  readonly lastJevAt?: number
} = {}) {
  return {
    cachedWorldState: { value: null as WorldState | null },
    lastRouteDecision: { value: null as JevReachRouteDecisionRecord | null },
    counters: {
      jevCalls: { value: input.jevCalls ?? 0 },
      lastJevAt: { value: input.lastJevAt ?? 0 },
      tickCounter: { value: input.tickCounter ?? 0 },
    },
  }
}

/**
 * Installs a typed fake runtime port on Object.create-based controller fixtures.
 * The dedicated Executor integration fixture uses the real Mineflayer adapter;
 * this fake only bridges existing semantic-unit fixtures to their fake Executor.
 */
export function installVtrReachTestRuntimePorts(controller: object): void {
  const fields = controller as Record<string, any>
  const active = (): ReachRuntimeActionSnapshot | null => {
    const action = fields.executor?.current ?? null
    if (action === null) return null
    return {
      id: String(action.id),
      kind: action.kind,
      epoch: Number(action.epoch ?? 0),
      status: action.status,
      authority: action.authority,
      transitionId: action.transitionId,
      commitment: action.commitment,
    }
  }
  const ports: ReachRuntimePorts = {
    observeWorldState: () => { throw new Error('semantic fixture must provide buildReachWorldState') },
    inventoryCounts: () => ({}),
    containerContents: () => [],
    bodyAvailable: () => true,
    currentHealth: () => fields.bot?.health ?? 0,
    currentDimension: () => fields.bot?.game?.dimension ?? 'minecraft:overworld',
    reachabilityGateOptions: (tick, memory) => fields.reachabilityGateOptions?.(tick, memory) ?? {
      memory,
      pathProbe: () => 'reachable',
      dimensionTransferProbe: () => 'clear',
    },
    dispatch: (request: ReachActuationRequest) => {
      const { candidate, intent } = request
      if (candidate.id !== intent.routeId) return { status: 'route-refused', reason: 'candidate-missing' }
      if (candidate.target === null || JSON.stringify(candidate.target) !== JSON.stringify(intent.target)) {
        return { status: 'route-refused', reason: 'target-mismatch' }
      }
      try {
        const claim = fields.executor.claim(candidate, {
          liveStructureMembers: request.liveStructureMembers,
          authority: 'vtr-reach',
          transitionId: intent.transitionId,
          beforeMechanicalStep: request.beforeMechanicalStep,
          afterMechanicalStep: request.afterMechanicalStep,
        })
        return { status: 'claimed', candidate, claim, actionId: active()?.id ?? null }
      } catch (error) {
        return {
          status: 'claim-refused',
          message: error instanceof Error ? error.message : String(error),
          activeAction: active(),
        }
      }
    },
    currentAction: active,
    cancelCurrent: (reason) => fields.executor?.cancelCurrent?.(reason) ?? false,
    authorityConflictCount: () => {
      const count = fields.executor?.authorityConflictCount
      return typeof count === 'function' ? count.call(fields.executor) : Number(count ?? 0)
    },
  }
  fields.reachRuntimeAdapter = ports
}
