// generation-swap.ts - the atomic generation-ownership transaction (#49).
//
// The host has three things that must never disagree at a stable lifecycle
// point: the attached generation, the actuation-lease owner, and the
// authoritative `AgentSnapshot.generationId`. `commitOwner` is the single place
// that advances all three together, and `swapGeneration` is the only reload
// path: commit the candidate, start it, and on failure roll back to a fresh
// generation built from the previous module. Superseded instances are always
// disposed and the rollback record carries every id plus the state revision.
import type { GenerationResourceCounts } from './resident-types.ts'

export type SwapLog = (event: string, detail?: Record<string, unknown>) => void

/** Minimal generation surface the swap transaction needs. */
export interface SwapGeneration {
  readonly id: string
  attach(): void
  start(): void
  quiesce(): Promise<void>
  dispose(): void
}

export interface LeasePort {
  readonly activeId: string
  acquire(id: string, log?: SwapLog): void
  revoke(reason: string, log?: SwapLog): void
}

/** The authoritative fields `AgentSnapshot` stores for generation ownership. */
export interface OwnershipFields {
  generationId: string | null
  lastGenerationId: string | null
}

export interface OwnershipPorts {
  log: SwapLog
  lease: LeasePort
  ownership: OwnershipFields
  getLive(): SwapGeneration | null
  setLive(generation: SwapGeneration | null): void
}

export interface SwapPorts extends OwnershipPorts {
  /** Host evidence hook after the incumbent has quiesced and before ownership commits. */
  afterQuiesce?: (generation: SwapGeneration) => void
  /** construct a fresh generation from the previously-loaded module (rollback) */
  buildResume(): SwapGeneration | null
  /** dispose a superseded generation; returns tracked resources still live */
  dispose(generation: SwapGeneration): GenerationResourceCounts
  /** structural smoke for the resumed generation; throws on failure */
  smoke(generation: SwapGeneration): void
  /** persist the class-A snapshot at this commit point */
  persist(event: string): void
  /** current snapshot commit revision, for the rollback record */
  revision(): number
}

export type SwapOutcome =
  | { status: 'committed'; generationId: string }
  | { status: 'rolled-back'; generationId: string; from: string; reason: string }
  | { status: 'failed-closed'; from: string; reason: string }

/**
 * The one atomic ownership commit. Live reference, snapshot fields and lease
 * advance here, so `getLive().id == lease.activeId == ownership.generationId`
 * holds before and after the call.
 */
export function commitOwner(ports: OwnershipPorts, generation: SwapGeneration): void {
  ports.setLive(generation)
  ports.ownership.lastGenerationId = ports.ownership.generationId
  ports.ownership.generationId = generation.id
  ports.lease.acquire(generation.id, ports.log)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failClosed(ports: SwapPorts, from: string, resumedId: string | null, reason: string): SwapOutcome {
  ports.setLive(null)
  ports.lease.revoke('rollback-failed', ports.log)
  ports.ownership.lastGenerationId = resumedId ?? from
  ports.ownership.generationId = null
  ports.persist('reload-fail-closed')
  ports.log('ROLLBACK_FAIL_CLOSED', {
    from,
    resumed: resumedId,
    reason,
    leaseOwner: ports.lease.activeId,
    snapshotGenerationId: ports.ownership.generationId,
    revision: ports.revision(),
  })
  ports.log('RELOAD_ROLLBACK', {
    from,
    resumed: resumedId,
    reason,
    generationId: null,
    leaseOwner: ports.lease.activeId,
    snapshotGenerationId: ports.ownership.generationId,
    revision: ports.revision(),
  })
  return { status: 'failed-closed', from, reason }
}

/**
 * Quiesce the incumbent, commit the candidate, start it, and on any failure
 * restore a single owner. Returns the outcome; the caller decides logging of
 * the surrounding RELOAD attempt. Throws only for programmer errors.
 */
export async function swapGeneration(ports: SwapPorts, next: SwapGeneration): Promise<SwapOutcome> {
  const previous = ports.getLive()
  if (previous !== null) {
    try {
      await previous.quiesce()
    } catch (error) {
      ports.log('ERROR', { where: 'swap.quiesce', id: previous.id, message: messageOf(error) })
    }
    ports.afterQuiesce?.(previous)
  }
  commitOwner(ports, next)
  try {
    next.start()
  } catch (startError) {
    const reason = messageOf(startError)
    ports.setLive(null)
    ports.lease.revoke('reload-start-failed', ports.log)
    ports.dispose(next)
    if (previous === null) return failClosed(ports, next.id, null, reason)

    let resumed: SwapGeneration | null = null
    try {
      resumed = ports.buildResume()
      if (resumed === null) throw new Error('no previous module available to resume')
      resumed.attach()
      ports.smoke(resumed)
      commitOwner(ports, resumed)
      resumed.start()
    } catch (rollbackError) {
      if (resumed !== null) ports.dispose(resumed)
      return failClosed(ports, next.id, resumed?.id ?? null, messageOf(rollbackError))
    }
    ports.dispose(previous)
    ports.persist('reload-rollback')
    ports.log('RELOAD_ROLLBACK', {
      from: next.id,
      resumed: resumed.id,
      reason,
      generationId: resumed.id,
      leaseOwner: ports.lease.activeId,
      snapshotGenerationId: ports.ownership.generationId,
      revision: ports.revision(),
    })
    return { status: 'rolled-back', generationId: resumed.id, from: next.id, reason }
  }
  if (previous !== null) ports.dispose(previous)
  return { status: 'committed', generationId: next.id }
}
