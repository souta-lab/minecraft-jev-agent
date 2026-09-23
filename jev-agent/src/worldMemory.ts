// worldMemory.ts - terrain-search memory shared across ticks (#3/#4).
//
// Keeps per-world descent evidence the per-tick sensor cannot: the currently
// selected direction/mode (so a safe Skill continuation is stable), the last six
// dig positions (to detect recurrence), and the count of successful DESCEND
// actions that produced no resource progress (to bound a trajectory). It also
// records the deepest known stone/ore level as positive evidence for descent.
import type { Vec3Json } from './state.ts'

export type DigDir = 'E' | 'W' | 'N' | 'S' | 'D'
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
  digMode: DigMode | null
  digDirCount: number
  digDepth: number
  digOscillate: boolean
  knownStoneY: number | null
  lastTunnel: Vec3Json | null
  descendNoProgress: number
  descendLimitReached: boolean
}

/** The coordinate system DigMemory describes. Both fields are host/world facts. */
export interface DigMemoryScope {
  dimension: string
  worldEpoch: number
}

export interface DigMemoryScopeChange {
  changed: boolean
  previous: DigMemoryScope | null
  current: DigMemoryScope
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
  const noProgress = resourceProgressed ? 0 : Math.min(previous + 1, DESCEND_NO_PROGRESS_LIMIT)
  return { noProgress, limitReached: noProgress >= DESCEND_NO_PROGRESS_LIMIT }
}

export class DigMemory {
  dir: DigDir | null = null
  mode: DigMode | null = null
  dirCount = 0
  depth = 0
  knownStoneY: number | null = null
  lastTunnel: Vec3Json | null = null
  descendNoProgress = 0
  private recent: DigStep[] = []
  private scope: DigMemoryScope | null = null

  /**
   * Fence coordinate and descent history to the world in which it was learned.
   * Dimension transfers and host world-epoch changes invalidate old positions;
   * repeated reads from the same world leave useful tunnel/search memory intact.
   */
  bindScope(scope: DigMemoryScope): DigMemoryScopeChange {
    const current = { ...scope }
    const previous = this.scope === null ? null : { ...this.scope }
    if (previous?.dimension === current.dimension && previous.worldEpoch === current.worldEpoch) {
      return { changed: false, previous, current }
    }
    this.clearMemory()
    this.scope = current
    return { changed: true, previous, current }
  }

  observeStoneY(y: number): void {
    if (this.knownStoneY === null || y < this.knownStoneY) this.knownStoneY = y
  }

  record(step: DigStep): void {
    if (this.dir === step.dir && this.mode === step.mode) this.dirCount += 1
    else {
      this.dir = step.dir
      this.dirCount = 1
    }
    this.mode = step.mode
    if (step.mode === 'down') this.depth += 1
    this.lastTunnel = { x: step.x, y: step.y, z: step.z }
    this.recent.push(step)
    while (this.recent.length > DIG_OSCILLATE_WINDOW) this.recent.shift()
  }

  isOscillating(): boolean {
    return isOscillatingSteps(this.recent)
  }

  netDisplacement(): number {
    return netDisplacementOf(this.recent)
  }

  /** Called on verified resource progress: clear strategy-level descent budgets. */
  markResourceProgress(): void {
    this.descendNoProgress = 0
    this.dir = null
    this.mode = null
    this.dirCount = 0
    this.depth = 0
    this.recent = []
  }

  /** Clear the selected path after a verified body relocation starts a new local route. */
  resetPath(): void {
    this.dir = null
    this.mode = null
    this.dirCount = 0
    this.recent = []
  }

  /**
   * Begin a policy-selected recovery trajectory after the previous one reached
   * a typed terminal boundary. This resets only trajectory-local recurrence and
   * no-progress budgets; observed world facts such as knownStoneY and lastTunnel
   * remain available to ground the new choice.
   */
  beginSelectedRecoveryPath(): void {
    this.resetPath()
    this.depth = 0
    this.descendNoProgress = 0
  }

  /**
   * Clear the no-progress budget after verified world progress. When a verified
   * move leaves a capped tunnel, the controller also resets the path so the new
   * column gets its own bounded search; the known stone level remains useful.
   */
  resetDescendBudget(): void {
    this.descendNoProgress = 0
  }

  markDescend(resourceProgressed: boolean): { noProgress: number; limitReached: boolean } {
    const budget = descendBudget(this.descendNoProgress, resourceProgressed)
    this.descendNoProgress = budget.noProgress
    return budget
  }

  snapshot(): DigMemorySnapshot {
    return {
      digDir: this.dir,
      digMode: this.mode,
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
    this.clearMemory()
    this.scope = null
  }

  private clearMemory(): void {
    this.dir = null
    this.mode = null
    this.dirCount = 0
    this.depth = 0
    this.knownStoneY = null
    this.lastTunnel = null
    this.descendNoProgress = 0
    this.recent = []
  }
}
