# Post-frontier program status

Control checkpoint: `51af6bed` (main == origin/main, clean). V4.1.2 sole architecture; Phase-0 gate satisfied at `d781f54`.

## Program orders (in priority order)

1. [in progress] Legacy Reach deletion slice — dedicated, reviewed; preserve sealed evidence + comparator capability
2. [ ] Kernel/concurrency crash adversarial exploration (cancel/preempt/restart/rebind/world+generation change, stale completions, duplicate irreversible effects, orphan transitions)
3. [ ] Red-team validators/comparators/packaging — fail-closed negative tests
4. [ ] Deterministic scenario lab expansion from real historical failures
5. [ ] Machine-checkable feature authority map (9 domains)
6. [ ] PBF/god-surface reduction along ownership boundaries
7. [ ] One demonstrated bounded experiment (KEEP/REVERT/ESCALATE, machine-readable)
8. [ ] V4.1.2 architecture red-team (after 2–5 strengthen evidence)

## Working log

### $(date) — P1 survey
- HEAD `51af6bed` == origin/main, clean tree.
- `src/reach/*` = canonical VTR Reach family (NOT legacy).
- Strangler: `filterLegacyReachCandidates` (controller.ts ~2156) permanently withholds mission-source MOVEs while `options.vtrMission` set (always set in production).
- `vtrReachProbe` only via `BUDDY_VTR_REACH_PROBE=1` (probe harness sets it).
- Baseline trick: `BUDDY_MISSION_ITEM=dirt` + human `collect oak_log` → `human-intent-owns-scheduler` decline → legacy authority run.
- Subagent dispatched: full executable legacy-Reach surface map.

### P1 — legacy Reach deletion slice (in progress)
- Audit verdict: executable legacy same-predicate locomotion scheduling already fully deleted by permanent withhold; no residual dispatch/commitment path (`inFlightOffered` reads the filtered set; only two `executor.claim` sites exist, both kernel-admitted).
- Deliberately retained + documented in `reach-mission-projection.ts` docstring + AGENTS §8: mission-source MINE/RETRIEVE/PICKUP (unmigrated collection — Reach `admissibleEffects` is locomotion-only), remembered-source approach legs (unmigrated exploration), `legacy-reach-handoff`/`isMissionReachWalkAction` (fail-closed revocation), `vtrReachProbe` (evidence harness), all sealed-evidence tooling.
- Added test pin: withhold stays locomotion-scoped (MINE/RETRIEVE/PICKUP for the mission item still cross) in `test-vtr-reach-mission-authority.mts`.
- Dead-module removal: `src/betaHysteresis.ts` + `test-beta-hysteresis.mts` (production-dead repo-wide, orphaned by selector deletion). `skillCandidate.ts` RETAINED — live deterministic-baseline planner vocabulary.
