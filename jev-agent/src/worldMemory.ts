// worldMemory.ts - terrain-search memory shared across ticks (#3/#4).
//
// Keeps three things the per-tick sensor cannot: the dig direction chosen once a
// tunnel is started (so it is not flipped into a zigzag), the last six dig
// positions (to detect oscillation), and the count of successful DESCEND actions
// that produced no resource progress (to cap runaway descents). It also records
// the deepest known stone/ore level so a staircase has positive evidence to aim
// at instead of "target === null therefore down".
import type { Vec3Json } from './state.ts'

export type DigDir = 'E' | 'W' | 'N' | 'S'
export type DigMode = 'down' | 'level'

export interface DigStep {
  x: number
  y: number
  z: number
  dir: DigDir
  mode: DigMode
  target: string | null
  atMs: number
}

export const DIG_PATH_CAP = 8
export const DESCEND_NO_PROGRESS_LIMIT = 4
const DIG_OSCILLATE_WINDOW = 6
const DIG_OSCILLATE_NET = 2.5

export interface DigMemorySnapshot {
  digDir: DigDir | null
  digDirCount: number
  digDepth: number
  digOscillate: boolean
  knownStoneY: number | null
  lastTunnel: Vec3Json | null
  descendNoProgress: number
  descendLimitReached: boolean
}

/** Net displacement across the last window of digs. Pure. */
export function netDisplacementOf(steps: readonly DigStep[]): number {
  if (steps.length < 2) return 0
  const first = steps[0]
  const last = steps[steps.length - 1]
  if (first === undefined || last === undefined) return 0
  return Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z)
}

/** Traveled distance summed over consecutive digs. Pure. */
export function traveledDistanceOf(steps: readonly DigStep[]): number {
  let total = 0
  for (let index = 1; index < steps.length; index += 1) {
    const a = steps[index - 1]
    const b = steps[index]
    if (a === undefined || b === undefined) continue
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  return total
}

/**
 * A zigzag trench travels back and forth: little net displacement despite many
 * steps. Requires a full window before firing so a real staircase is not
 * misread as oscillation. Pure.
 */
export function isOscillatingSteps(steps: readonly DigStep[]): boolean {
  if (steps.length < DIG_OSCILLATE_WINDOW) return false
  const net = netDisplacementOf(steps)
  const traveled = traveledDistanceOf(steps)
  return net < DIG_OSCILLATE_NET && traveled > net + 2
}

/** Increment the no-progress budget on a verified-but-useless descent. Pure. */
export function descendBudget(previous: number, resourceProgressed: boolean): { noProgress: number; limitReached: boolean } {
  const noProgress = resourceProgressed ? 0 : previous + 1
  return { noProgress, limitReached: noProgress >= DESCEND_NO_PROGRESS_LIMIT }
}

export class DigMemory {
  dir: DigDir | null = null
  dirCount = 0
  depth = 0
  knownStoneY: number | null = null
  lastTunnel: Vec3Json | null = null
  descendNoProgress = 0
  private staircase = false
  private recent: DigStep[] = []

  observeStoneY(y: number): void {
    if (this.knownStoneY === null || y < this.knownStoneY) this.knownStoneY = y
  }

  record(step: DigStep): void {
    if (this.dir === step.dir) this.dirCount += 1
    else {
      this.dir = step.dir
      this.dirCount = 1
    }
    if (step.mode === 'down') this.depth += 1
    this.lastTunnel = { x: step.x, y: step.y, z: step.z }
    this.recent.push(step)
    while (this.recent.length > DIG_OSCILLATE_WINDOW) this.recent.shift()
    this.staircase = false
  }

  isOscillating(): boolean {
    return this.staircase || isOscillatingSteps(this.recent)
  }

  netDisplacement(): number {
    return netDisplacementOf(this.recent)
  }

  /** Called on detected oscillation: drop the path and force a straight staircase. */
  markStaircase(): void {
    this.dir = null
    this.dirCount = 0
    this.recent = []
    this.staircase = true
  }

  /** Called on verified resource progress: clear strategy-level descent budgets. */
  markResourceProgress(): void {
    this.descendNoProgress = 0
    this.dir = null
    this.dirCount = 0
    this.depth = 0
    this.staircase = false
    this.recent = []
  }

  /** Stop extending the current tunnel (no-progress cap hit -> lateral search). */
  resetPath(): void {
    this.dir = null
    this.dirCount = 0
    this.staircase = false
    this.recent = []
  }

  markDescend(resourceProgressed: boolean): { noProgress: number; limitReached: boolean } {
    const budget = descendBudget(this.descendNoProgress, resourceProgressed)
    this.descendNoProgress = budget.noProgress
    return budget
  }

  snapshot(): DigMemorySnapshot {
    return {
      digDir: this.dir,
      digDirCount: this.dirCount,
      digDepth: this.depth,
      digOscillate: this.isOscillating(),
      knownStoneY: this.knownStoneY,
      lastTunnel: this.lastTunnel,
      descendNoProgress: this.descendNoProgress,
      descendLimitReached: this.descendNoProgress >= DESCEND_NO_PROGRESS_LIMIT,
    }
  }

  reset(): void {
    this.dir = null
    this.dirCount = 0
    this.depth = 0
    this.knownStoneY = null
    this.lastTunnel = null
    this.descendNoProgress = 0
    this.staircase = false
    this.recent = []
  }
}
