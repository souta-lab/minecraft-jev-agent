/**
 * Host connection must wait until the reloadable generation has been imported
 * and its public contract has been checked. In particular, an import failure
 * must never turn into a second Mineflayer login with no controller behind it.
 */
export function generationModuleReadinessError(candidate: unknown, contractVersion: number): string | null {
  if (candidate === null || typeof candidate !== 'object') return 'generation-module-unavailable'
  const module = candidate as { CONTRACT_VERSION?: unknown; createGeneration?: unknown }
  if (module.CONTRACT_VERSION !== contractVersion) {
    return `CONTRACT_VERSION mismatch: generation=${String(module.CONTRACT_VERSION)} host=${contractVersion}`
  }
  if (typeof module.createGeneration !== 'function') return 'missing createGeneration export'
  return null
}

/**
 * Small injectable boundary so startup and reconnect safety can be exercised
 * offline without loading Mineflayer or opening a server connection.
 */
export async function connectAfterGenerationValidation<T>(ports: {
  load: () => Promise<T | null>
  validate: (candidate: T) => string | null
  connect: () => void
  refused: (reason: string) => void
}): Promise<boolean> {
  let candidate: T | null
  try {
    candidate = await ports.load()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ports.refused(`generation-module-load-failed: ${detail}`)
    return false
  }
  if (candidate === null) {
    ports.refused('generation-module-unavailable')
    return false
  }
  const invalidReason = ports.validate(candidate)
  if (invalidReason !== null) {
    ports.refused(invalidReason)
    return false
  }
  ports.connect()
  return true
}
