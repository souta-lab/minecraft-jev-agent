# Post-frontier program status

Control checkpoint: `51af6bed` (main == origin/main, clean). V4.1.2 sole architecture; Phase-0 gate satisfied at `d781f54`.

## Program orders (in priority order)

1. [done] Legacy Reach deletion slice — `674d61d4`; preserve sealed evidence + comparator capability
2. [in progress] Kernel/concurrency crash adversarial exploration (cancel/preempt/restart/rebind/world+generation change, stale completions, duplicate irreversible effects, orphan transitions)
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
- Committed `674d61d4` (unpushed until suite green). Focused: reach-authority tests 3/3, arch guard 7/7, production-seam reach subset 18/18, jev-agent typecheck clean.

### P2 — kernel adversarial exploration (in progress)
- New `packages/kernel/kernel.adversarial.test.ts`: 18 short deterministic counterexample/characterization traces (K3–K19) against the real reducer. All pass — the characterized behaviors are real. Kernel package 115/115.
- **No invariant violations found.** `assertKernelInvariants` held across every trace; no command path mutates state outside `applyKernelCommand`; capability/binding/world/generation fencing held at every probed edge.
- **Findings (semantic gaps, pinned as characterization tests — fed to P8 architecture review):**
  - F-K3 (liveness): a `preemptible` victim that never yields wedges a higher-priority preemptor indefinitely. `preemptibleYieldBudgetMs`/`hardYieldDeadlineMonoMs` are observational only; COMMIT requires READY forever. Sole recourse is REQUEST_CANCEL — destroys resumable work. (K3)
  - F-K4 (atomicity gap): `PAUSE_ACTIVE`/`ACK_PAUSE_YIELD` do not gate on `preemptionYielded` — an acknowledged victim (or its own controller, non-preemptible) can pause/yield-to-pause out of a READY transaction, releasing leases outside the atomic commit and leaving an unresolvable STALE plan. (K4, K4b)
  - F-K5 (hygiene): orphan PLANNED/READY preemption transactions are unresolvable once stale and never expire — no CANCEL/EXPIRE command; cleanup only via participant terminalization or generation change. (K5)
  - F-K6/K7 (asymmetry): cancel/terminal quiesce DISPATCHING→UNKNOWN immediately/at-yield while `ACK_PREEMPTION_YIELD` rejects in-flight dispatch. Terminalizing a verified SUCCESS with unresolved irreversible dispatch is allowed; probably intended (linearization already committed), pinned. (K6, K7)
  - F-K8: CHANGE_WORLD discards a pending verified SUCCESS → outcome `WORLD_CHANGED`; CHANGE_GENERATION honors the same pending outcome (K2). Principled asymmetry — old-world verify can't certify the new world — pinned. (K8)
  - F-K9: reconcile evidence observed while a dispatch was live becomes binding-stale after terminalization → permanent UNKNOWN unless the verifier re-attests under the live binding. Fail-closed, honest. (K9)
  - F-K13/K14 (bookkeeping): `REPORT_PROGRESS`/`ACCEPT_WITNESS_PROOF` are journaled on ENABLED/TERMINAL transitions — progress/witness records are reports, not authority. Pinned; likely intended. (K13, K14)
- **Fenced edges confirmed closed** (reordered/stale/duplicate completions, expiry accounting, generation fencing, zombie resurrection, replay+recovery): K10–K19.
- Blockers: none. Next: broad suite → commit+push P1+P2 → P3 validator/comparator red-team.
