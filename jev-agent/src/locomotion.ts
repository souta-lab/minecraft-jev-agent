/** A sampled body position; movement is measured independently of goal progress. */
export interface LocomotionPosition {
  x: number
  y: number
  z: number
}

export const LOCOMOTION_WINDOW_SIZE = 40
const LOCOMOTION_EPSILON = 0.01

/**
 * `idle` and `moving` are different observations. In particular, an undefined
 * net/traveled ratio is never promoted to 100% efficiency.
 */
export type LocomotionObservation =
  | { kind: 'unobserved'; samples: number }
  | { kind: 'idle'; samples: number; traveled: number; net: number }
  | { kind: 'moving'; samples: number; traveled: number; net: number; efficiency: number }

export const NO_LOCOMOTION_OBSERVATION: LocomotionObservation = { kind: 'unobserved', samples: 0 }

/** Measure the most recent fixed window, preserving zero-motion as typed idle. */
export function observeLocomotion(
  positions: readonly LocomotionPosition[],
  windowSize = LOCOMOTION_WINDOW_SIZE,
): LocomotionObservation {
  const window = positions.slice(-windowSize)
  if (window.length < windowSize) return { kind: 'unobserved', samples: window.length }

  const first = window[0]
  const last = window[window.length - 1]
  if (first === undefined || last === undefined) return { kind: 'unobserved', samples: window.length }

  let traveled = 0
  for (let index = 1; index < window.length; index += 1) {
    const a = window[index - 1]
    const b = window[index]
    if (a === undefined || b === undefined) continue
    traveled += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  const net = Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z)
  if (traveled <= LOCOMOTION_EPSILON) return { kind: 'idle', samples: window.length, traveled, net }
  return { kind: 'moving', samples: window.length, traveled, net, efficiency: Math.round((net / traveled) * 100) }
}

/** A body-only outcome holds beta/failure memory only with observed, efficient locomotion. */
export function isEfficientLocomotionProgress(observation: LocomotionObservation, floor: number): boolean {
  return observation.kind === 'moving' && observation.efficiency >= floor
}

/** Human/AI-readable evidence that distinguishes missing motion from a bad route. */
export function formatLocomotionObservation(observation: LocomotionObservation): string {
  if (observation.kind === 'unobserved') {
    return `idle=unknown efficiency=n/a samples=${observation.samples}/${LOCOMOTION_WINDOW_SIZE}`
  }
  const traveled = Math.round(observation.traveled * 100) / 100
  const net = Math.round(observation.net * 100) / 100
  if (observation.kind === 'idle') {
    return `idle=true efficiency=n/a traveled=${traveled} net=${net}`
  }
  return `idle=false efficiency=${observation.efficiency}% traveled=${traveled} net=${net}`
}
