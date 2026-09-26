// protectionConflict.ts - state-conditioned validity for the furnace
// precondition guard (#11 v2 section 6).
//
// Measured on main 444d387, the same option was abandoned by the deterministic
// unproductive policy and protected again by the precondition guard with no
// state change in between:
//
//   PRECONDITION_PROTECTED option=CRAFT:furnace because=prerequisite_of smelt_iron_ingot reason=action_impossible
//   JEV_HEADS action=CRAFT:furnace abandon=1 ... abandonEnforced=true attempts=3
//   ABANDON_REASON option=CRAFT:furnace reason=unreachable beta=1
//   PRECONDITION_PROTECTED option=CRAFT:furnace because=prerequisite_of smelt_iron_ingot reason=no_progress
//
// Protection and abandonment are therefore mutually exclusive under one state
// fingerprint: an option abandoned under an unchanged fingerprint must not be
// protected again, and a state change (inventory / world / topology) clears the
// abandonment with no timer. Pure, clock-free, bot-free.

/** Mirrored marker: protection and abandonment both claimed one option. */
export const PROTECTION_ABANDON_CONFLICT = 'PROTECTION_ABANDON_CONFLICT'

/** Which side of the contradiction was applied when the conflict was detected. */
export type ProtectionAbandonAction = 'protected' | 'abandoned'

export function formatProtectionAbandonConflict(
  option: string,
  action: ProtectionAbandonAction,
  reason: string,
): string {
  return `${PROTECTION_ABANDON_CONFLICT} option=${option} action=${action} reason=${reason}`
}

/** One abandonment fact: `option` was retired for `reason` under `fingerprint`. */
export interface AbandonedOption {
  readonly option: string
  readonly fingerprint: string
  readonly reason: string
}

/**
 * Abandonment facts keyed by option + state fingerprint. An entry is valid
 * exactly while the fingerprint that produced it is unchanged, so a state
 * change clears availability without any timer or retry count. Bounded so a
 * long run cannot grow it without limit.
 */
export class AbandonmentLedger {
  private readonly entries = new Map<string, AbandonedOption>()
  private readonly reportedConflicts = new Set<string>()
  private readonly maxEntries: number

  constructor(maxEntries = 128) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries))
  }

  markAbandoned(option: string, fingerprint: string, reason: string): AbandonedOption {
    const key = this.key(option, fingerprint)
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.reason === reason) return existing
    const entry: AbandonedOption = { option, fingerprint, reason }
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
    return entry
  }

  /** The abandonment reason for `option` under the SAME fingerprint, else null. */
  reasonUnder(option: string, fingerprint: string): string | null {
    return this.entries.get(this.key(option, fingerprint))?.reason ?? null
  }

  isAbandonedUnder(option: string, fingerprint: string): boolean {
    return this.reasonUnder(option, fingerprint) !== null
  }

  /** True the first time a conflict is claimed for (option, fingerprint). */
  claimConflict(option: string, fingerprint: string): boolean {
    const key = this.key(option, fingerprint)
    if (this.reportedConflicts.has(key)) return false
    this.reportedConflicts.add(key)
    return true
  }

  forget(option: string, fingerprint: string): boolean {
    return this.entries.delete(this.key(option, fingerprint))
  }

  clear(): void {
    this.entries.clear()
    this.reportedConflicts.clear()
  }

  size(): number {
    return this.entries.size
  }

  private key(option: string, fingerprint: string): string {
    return `${option}@${fingerprint}`
  }
}

/** The minimal protection shape `reconcileProtection` reads. */
export interface ProtectionLike {
  readonly protect: boolean
  readonly option: string
  readonly because: string
  readonly line: string
}

export interface ProtectionReconciliation {
  /** the protection actually in force after the abandonment fact is applied. */
  readonly protect: boolean
  /** the `PROTECTION_ABANDON_CONFLICT ...` line, or null when there is no conflict. */
  readonly conflictLine: string | null
}

/**
 * The one deterministic rule: a protection claim and a live abandonment fact
 * for the same option under the same fingerprint are mutually exclusive. The
 * abandonment wins (it is the observed fact; protection is a static relation),
 * and the contradiction is surfaced with the mirrored marker.
 */
export function reconcileProtection(input: {
  protection: ProtectionLike
  abandonedReason: string | null
  action?: ProtectionAbandonAction
}): ProtectionReconciliation {
  if (!input.protection.protect || input.abandonedReason === null) {
    return { protect: input.protection.protect, conflictLine: null }
  }
  return {
    protect: false,
    conflictLine: formatProtectionAbandonConflict(
      input.protection.option,
      input.action ?? 'abandoned',
      input.abandonedReason,
    ),
  }
}
