/**
 * Map live HOST/G generation projections to the stable metadata fields in a
 * run-scoped AcceptanceRecord. Keep this pure so the mapping is testable
 * without starting Mineflayer or the resident control socket.
 */
export interface AcceptanceMetadataBot {
  version?: string | null
  game?: { difficulty?: string | null } | null
}

export interface AcceptanceMetadataStatus {
  policyModel?: string | null
  system2Model?: string | null
}

export interface AcceptanceMetadata {
  serverVersion: string | null
  difficulty: string | null
  jevModel: string | null
  system2Model: string | null
}

export function acceptanceMetadata(
  bot: AcceptanceMetadataBot | null,
  status: AcceptanceMetadataStatus | null,
): AcceptanceMetadata {
  return {
    serverVersion: bot?.version ?? null,
    difficulty: bot?.game?.difficulty ?? null,
    jevModel: status?.policyModel ?? null,
    system2Model: status?.system2Model ?? null,
  }
}
