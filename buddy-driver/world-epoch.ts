import type { WorldKey } from './resident-types.ts'

export interface WorldEpochGeneration {
  readonly id: string
  quiesce(): Promise<void>
  dispose(): void
}

export interface WorldEpochResetPorts {
  getActive(): WorldEpochGeneration | null
  detachActive(generation: WorldEpochGeneration): void
  revokeLease(reason: string): void
  disposeActive(generation: WorldEpochGeneration): void
  incrementEpoch(): number
  initializeMemory(): void
  persist(): void
  startGeneration(): Promise<boolean>
}

export function sameWorldKey(left: WorldKey, right: WorldKey): boolean {
  return left.serverId === right.serverId && left.dimension === right.dimension && left.worldEpoch === right.worldEpoch
}

export function acceptsWorldMemoryProposal(source: WorldKey, current: WorldKey): boolean {
  return sameWorldKey(source, current)
}

export function worldCacheNamespace(key: WorldKey): string {
  return `${key.serverId}|${key.dimension}|${key.worldEpoch}`.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export async function resetWorldEpoch(ports: WorldEpochResetPorts): Promise<{ epoch: number; started: boolean }> {
  const previous = ports.getActive()
  if (previous !== null) {
    ports.detachActive(previous)
    ports.revokeLease('worldreset')
    await previous.quiesce()
    ports.disposeActive(previous)
  }
  const epoch = ports.incrementEpoch()
  ports.initializeMemory()
  ports.persist()
  const started = await ports.startGeneration()
  return { epoch, started }
}
