import { createTrustedCapability, type TrustedCapability } from './authority-secret.ts'

/** Host/test only. Production semantic callers must not import this module. */
export const trustedVerifier = (id: string): TrustedCapability => createTrustedCapability('VERIFIER', id)
export const trustedWorldAdapter = (id: string): TrustedCapability => createTrustedCapability('WORLD_ADAPTER', id)
export const trustedWitnessValidator = (id: string): TrustedCapability => createTrustedCapability('WITNESS_VALIDATOR', id)
export const trustedContractCompiler = (id: string): TrustedCapability => createTrustedCapability('CONTRACT_COMPILER', id)
export const trustedMissionAuthority = (id: string): TrustedCapability => createTrustedCapability('MISSION', id)
export const trustedScheduler = (): TrustedCapability => createTrustedCapability('SCHEDULER', 'scheduler')
export const trustedDispatcher = (): TrustedCapability => createTrustedCapability('DISPATCHER', 'runtime')
export const trustedJournalRecovery = (): TrustedCapability => createTrustedCapability('JOURNAL', 'recovery')
export const trustedProgressEvaluator = (id: string): TrustedCapability => createTrustedCapability('PROGRESS', id)
export const trustedController = (transitionId: string, contractHash: string, generationId: string): TrustedCapability =>
  createTrustedCapability('CONTROLLER', `${transitionId}|${contractHash}|${generationId}`)
