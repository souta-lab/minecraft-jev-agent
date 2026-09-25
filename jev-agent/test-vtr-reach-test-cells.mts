import type { JevReachRouteDecisionRecord } from './src/jev-reach-vtr-composition.ts'
import type { WorldState } from './src/state.ts'

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
