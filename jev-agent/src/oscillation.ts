// oscillation.ts - issue #78: escape a vertical/positional oscillation.
//
// Measured 2026-09-18 10:17 JST: the smelt prerequisite loop walked between
// `39.1,10.3,34.3` and `39.1,9.0,33.5` with no inventory or goal change, while
// the same known-station retrieve was re-selected forever. This module is a pure
// detector for that pattern; the controller logs `OSCILLATION_DETECTED` and takes
// the escape action (abandon the retrieval, force a different option, escalate).
//
// Pure and bot-free so the threshold behaviour is unit-testable.
export const OSCILLATION_LIMIT = 3

export interface OscillationState {
  /** inventory/goal signature; a change re-arms the detector */
  signature: string
  lastPosition: string
  /** canonical `a->b` pair of the two positions being swapped */
  pair: string | null
  cycles: number
}

export interface OscillationDecision {
  state: OscillationState
  detected: boolean
  /** the ready-to-log line, or null when no oscillation was detected */
  line: string | null
}

/**
 * Track the last position and the swap pair. The cycle count only grows while
 * the same canonical pair repeats and the state signature (inventory/goal) is
 * unchanged; any other position or a real state change re-arms it. Fires once
 * the pair has repeated more than `limit` times and reports the escape action.
 */
export function evaluateOscillation(input: {
  position: string
  signature: string
  previous: OscillationState | null
  limit?: number
}): OscillationDecision {
  const limit = input.limit ?? OSCILLATION_LIMIT
  const previous = input.previous
  if (previous === null || previous.signature !== input.signature) {
    return {
      state: { signature: input.signature, lastPosition: input.position, pair: null, cycles: 0 },
      detected: false,
      line: null,
    }
  }
  if (previous.lastPosition === input.position) {
    return { state: { ...previous, lastPosition: input.position }, detected: false, line: null }
  }
  const from = previous.lastPosition
  const to = input.position
  const pair = from < to ? `${from}->${to}` : `${to}->${from}`
  const cycles = previous.pair === pair ? previous.cycles + 1 : 1
  const state: OscillationState = { signature: input.signature, lastPosition: input.position, pair, cycles }
  if (cycles > limit) {
    return {
      state,
      detected: true,
      line: `OSCILLATION_DETECTED from=${from} to=${to} cycles=${cycles} action=escape`,
    }
  }
  return { state, detected: false, line: null }
}

/** Stable quantized position key so sub-block jitter does not defeat the detector. */
export function positionKey(position: { x: number; y: number; z: number }): string {
  return `${Math.round(position.x * 10) / 10},${Math.round(position.y * 10) / 10},${Math.round(position.z * 10) / 10}`
}
