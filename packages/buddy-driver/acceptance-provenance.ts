// #395: acceptance provenance must be immutable and causal.
//
// The resident is long-lived while the checkout it was started from keeps moving
// (DSH/OMP/humans update the repo and hot-reload generation bundles). Reading
// `git rev-parse HEAD` at write time therefore binds the acceptance artifact to a
// commit that may never have been loaded or executed by this run: runId from boot,
// generationHash from the loaded bundle, gitCommit from whatever HEAD says now.
//
// This helper keeps the two facts apart and names them:
//   gitCommit    - the run's source identity: the boot commit, immutable.
//   checkoutHead - the mutable working checkout at write time, explicitly separate.
// When no boot identity was captured (older entry points, fixtures), the checkout is
// the only available source, so it is used and the checkout field says so.
export interface AcceptanceProvenance {
  readonly gitCommit: string | null
  readonly checkoutHead: string | null
}

export function acceptanceProvenance(
  bootSourceSha: string | null | undefined,
  checkoutHead: string | null,
): AcceptanceProvenance {
  const boot = typeof bootSourceSha === 'string' && bootSourceSha.length > 0 ? bootSourceSha : null
  return { gitCommit: boot ?? checkoutHead, checkoutHead }
}
