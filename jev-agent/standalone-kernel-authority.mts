// Shared kernel-authority construction for the standalone jev-agent runner
// scripts (m1/m2/demo, data/verify-*, data probes). These scripts are not the
// production buddy-driver host, but JevController still requires a real
// session-backed KernelReachAuthority. World identity matches the standalone
// defaults (serverId 'local', worldEpoch 0); Reach is only gated when a
// script explicitly configures vtrMission.
import { createKernelShadowSession } from '../buddy-driver/kernel-shadow-session.ts'
import type { KernelReachAuthority } from './src/reach/kernel-shadow-map.ts'

export function createStandaloneKernelAuthority(generationId: string): KernelReachAuthority {
  const session = createKernelShadowSession({
    world: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 0 },
    generationId,
    journalPath: null,
    authorityMode: 'authority',
  })
  if (session.authority === null) {
    throw new Error('V4.1.2 kernel authority session did not produce the production gate')
  }
  return session.authority
}
