// Shared kernel-authority construction for the standalone jev-agent runner
// scripts (m1/m2/demo, data/verify-*, data probes). These scripts are not the
// production buddy-driver host, but JevController still requires the real
// session-backed KernelTransitionAuthority. World identity matches the standalone
// defaults (serverId 'local', worldEpoch 0); Reach is only gated when a
// script explicitly configures vtrMission.
import { createKernelAuthoritySession } from '../buddy-driver/kernel-authority-session.ts'
import type { KernelTransitionAuthority } from './src/reach/kernel-authority-map.ts'

export function createStandaloneKernelAuthority(generationId: string): KernelTransitionAuthority {
  return createKernelAuthoritySession({
    world: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 0 },
    generationId,
    journalPath: null,
  }).authority
}
