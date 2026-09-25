const TRUSTED = new WeakSet<object>()

export type TrustedSource = 'VERIFIER' | 'WORLD_ADAPTER' | 'WITNESS_VALIDATOR' | 'CONTRACT_COMPILER' | 'MISSION' | 'SCHEDULER' | 'CONTROLLER' | 'DISPATCHER' | 'JOURNAL' | 'PROGRESS'
export interface TrustedCapability { readonly source: TrustedSource; readonly id: string }

export function createTrustedCapability(source: TrustedSource, id: string): TrustedCapability {
  const capability = Object.freeze({ source, id })
  TRUSTED.add(capability)
  return capability
}
export function isTrustedCapability(value: unknown, source: TrustedSource, id: string): boolean {
  return typeof value === 'object' && value !== null && TRUSTED.has(value) &&
    (value as TrustedCapability).source === source && (value as TrustedCapability).id === id
}
