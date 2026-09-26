# PBF ownership map and bounded-AI-improvement roadmap

Status: living document for the Packages-by-Feature migration. It records
where code actually lives today, the mechanically enforced boundaries, and the
ordered remaining work. Update it as packages change; do not let it drift into
aspirational fiction.

## 1. Canonical package addresses (current)

| Package | Contents | Notes |
|---|---|---|
| `packages/jev-agent/src/reach/` | Reach feature: `transition`, `controller`, `controller-plane`, `scheduler`, `mission-runtime`, `mission-projection`, `ports`, `safety`, `route-policy`, `jev-composition`, `mechanical-waypoint`, `kernel-shadow-map` | Backend-independent. `kernel-shadow-map` is the Reach-slice kernel gate (`KernelReachAuthority` + shadow map). |
| `packages/jev-agent/src/minecraft/` | Backend implementations of consumer ports: `reach-runtime-adapter`, `reach-mission-projection` | Only package allowed raw Mineflayer outside the flat allowlist. |
| `packages/jev-agent/src/jev/` | Jev decision policy: `client` (legacy policy+harness+logging), `authority` (auditable live-policy kernel), `semantic-projection` (#437 epoch/packet machinery) | Root `src/jev.ts` stays a thin facade. |
| `packages/jev-agent/src/system2/` | Sparse reasoning service: `service`, `payload`, `authority`, `escalation`, `causal-history`, `handoff` | Exception-driven; no motor commands. |
| `packages/jev-agent/src/legacy/` | Quarantined controller planes behind Host contracts | Temporary layer; each file's deletion condition is documented in its header. Not a permanent home. |
| `packages/kernel/v4.1/` | The authority kernel (`kernel.ts`) + contract docs | `src/vtr/` was removed once empty: no cross-feature mechanism currently lives in jev-agent. |
| flat `packages/jev-agent/src/*.ts` | Transitional modules (see §2) | Awaiting canonical addresses as host contracts shed backend types. |

## 2. Flat-file classification (transitional remainder)

These files still live at `src/` root. The owner column is the canonical
target; moving each requires its consumers to reach it through typed ports or
to accept the edge as transitional.

- **App/composition shell** — `controller-legacy.ts`, `controller.ts`,
  `index.ts`, `controller-shared.ts`, `jev.ts` (facade). `controller-legacy`
  is the integration shell (~5.3k lines) with a documented shrink condition;
  `controller-shared` owns the options contract (`JevAgentOptions`,
  `SensorOptionSlice`, `CandidateOptionSlice`, drain grace).
- **Minecraft mechanical substrate** (backend impl not yet behind ports —
  `executor.ts`, `state.ts`, `candidates.ts`, `containerAccess.ts`,
  `craftWindow.ts`, `worldMemory.ts`, `positionFactCache.ts`). Target:
  `minecraft/` once callers cross ports; today they are the transitional
  mechanical layer the legacy plane still consumes directly.
- **Legacy decision/goal plane** (quarantine-bound as V4 slices retire it) —
  `goalQueue.ts`, `optionSpec.ts`, `optionSpec-legacy.ts`, `goalSuccess.ts`,
  `predicateGoal.ts`, `protectedGoals.ts`, `causal.ts`, `scheduler.ts`,
  `decisionlog.ts`, `gating.ts`, `policy.ts`, `abandonPolicy.ts`,
  `betaAuthority.ts`, `betaHysteresis.ts`, `candidateCommitment.ts`,
  `failureMemory.ts`, `localOscillation.ts`, `oscillation.ts`,
  `repeatedOutcomeEscalation.ts`, `replanThrottle.ts`, `strategicStall.ts`,
  `prereqOption.ts`, `protectionConflict.ts`, `modelFailure.ts`,
  `shadowMetrics.ts`, `skillCommitment.ts`, `skillCandidate.ts`,
  `actionPostcondition.ts`, `actuationPort.ts`, `placementGuard.ts`,
  `routePlaceDeclaration.ts`, `reachability.ts`. Deletion condition: the V4.1.2
  migration phases in `AGENTS.md` §8 — each family retires when its Transition
  slice is proven and cut over.
- **Mechanics features** (real feature cohesion; targets `navigation/`,
  `mining/`, `survival/`, `crafting/`/`inventory/`) — movement/vertical:
  `walkSkill.ts`, `bridgeRoute.ts`, `locomotion.ts`, `hopPolicy.ts`,
  `levelScan.ts`, `pillar*.ts`, `descendPlan.ts`, `descentScaffold.ts`,
  `stepLanding.ts`, `verticalPlan.ts`, `wallEntry.ts`, `zeroProgressRoute.ts`,
  `moveFailMemory.ts`, `bodyGeometry.ts`; mining: `digRoute.ts`, `digTruth.ts`,
  `blockSafety.ts`; survival: `threat.ts`, `air.ts`, `envHazard.ts`,
  `criticalDamage.ts`, `foodSources.ts`, `combatClosure.ts`, `gearPlan.ts`;
  crafting/inventory: `crafting.ts`, `gameData.ts`, `resourceClass.ts`,
  `toolChoice.ts`; portal: `netherPortalPlan.ts`.

Constraint on the last two groups: canonical feature packages must not
reference backend types (`Bot`, `this.bot`, `mineflayer`). Files whose
public surface still carries backend types cannot move until Phase-4 port
tightening lands — that is the blocker, not the filename.

## 3. Mechanically enforced boundaries

- `packages/jev-agent/test-package-boundaries.mts` — static import-direction guard:
  `reach → {minecraft, legacy}` forbidden; `vtr → {reach, minecraft, legacy,
  system2, jev, flat}` forbidden; `minecraft → legacy`, `legacy → minecraft`,
  `system2 → {minecraft, legacy}`, `jev → {minecraft, legacy}` forbidden;
  raw Mineflayer/`Bot`/`this.bot` allowed only in `minecraft/` and the flat
  allowlist (type-only `Bot` tolerated inside quarantined `legacy/` Host
  interfaces while they narrow).
- `packages/jev-agent/test-vtr-reach-production.mts` — authority seams:
  `KernelReachAuthority` required by construction; one mutation path
  (kernel `issueStepEffect` → adapter `dispatch`); one terminal path
  (kernel `terminalize`); SUCCESS only through kernel `VERIFY_SUCCESS` on
  observed proof; legacy same-Mission MOVE withholding; raw-client reads
  confined to the adapter.
- Backend-free scan inside the production test covers `src/reach/` (and
  `src/vtr/` if it reappears) for `mineflayer`/`Bot`/`this.bot`.

Frozen V4.1.2 areas (do not open without runtime evidence): kernel authority
path, contract/commit admission, VERIFY_SUCCESS semantics, transition
controller ownership, lease/generation fencing.

## 4. Remaining structural work (ordered)

1. Phase 4 — inside correct packages: narrow `ReachPlaneHost` (currently
   ~60 members; every member must justify itself), drop dead delegates whose
   callers are gone, migrate `Object.create(JevController.prototype)` fixtures
   (13 files) toward explicit adapters, reduce accidental exports.
2. Flat remainder → canonical addresses per §2, gated on port tightening.
3. `legacy/` burn-down: each plane file carries a deletion condition; remove
   as slices retire (never leave permanent dual authority).

## 5. Bounded-AI-improvement readiness

Goal: a weaker future model can change one feature safely.

- Allowed-path story: a feature task touches its package + its focused tests;
  `test-package-boundaries.mts` fails any boundary crossing automatically.
- Frozen zones are listed in §3 and guarded by authority anchors in
  `test-vtr-reach-production.mts` + the package guard.
- Verification ladder per change: typecheck → focused fixture → package
  guard → legacy/buddy-driver suites → (authority-sensitive) live proof.
- Improvement loop roadmap (not implemented here):
  observe (run artifacts/journal) → classify (failure taxonomy vs typed
  terminal outcomes) → hypothesize (single causal boundary) → patch (one
  package, one reason to change) → test (deterministic fixture + comparator)
  → compare (legacy-baseline vs VTR on same seed/geometry) → keep/revert →
  record (evidence archive under `vtr-evidence-archive/`).
- Next enablers, in order: deterministic fixture coverage per feature
  package; failure-taxonomy regression corpus (`docs/development/
  REGRESSION-CORPUS.md` extension); automated comparator/adoption gates on
  live evidence; then bounded continuous improvement with V4.1.2 frozen.
