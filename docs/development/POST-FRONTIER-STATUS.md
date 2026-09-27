# Post-frontier program status

Historical control checkpoint: `51af6bed` (program start). V4.1.2 sole architecture; Phase-0 gate satisfied at `d781f54`.

Current HEAD: `846b38cd` == origin/main, clean tree.

## Program orders (in priority order)

1. [done] Legacy Reach deletion slice — `674d61d4`; preserve sealed evidence + comparator capability
2. [done] Kernel/concurrency crash adversarial exploration — `c6d614ad` (K3–K19) + `1554d8c6` (hardening + K20–K33)
3. [done] Red-team validators/comparators/packaging — `76be08fb` + `e1ad56e7`
4. [done] Deterministic scenario lab — `45da2131` (10 kernel traces + 6 regression pointers, registry digest-pinned)
5. [done] Machine-checkable feature authority map — `846b38cd` (9 domains + control; union coverage, dispatch table, surface envelopes, canonical resource/effect derivation all test-bound)
6. [in progress] PBF/god-surface reduction — host-cast coupling mapped; carcass deletion + binding gate
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

### P3 — validator/comparator red-team (done)
- Independent audit found 9+ false-PASS surfaces in `tools/validate-vtr-reach-evidence.mjs`; all fixed in `76be08fb`:
  kernel journal rows bound to run generation + strict seq + gated-command causal brackets + non-vacuous verify-attempts; KERNEL_AUTHORITY_MODE/READY/SUMMARY lines bound to generation and ALL summary lines checked; committed contract content re-hashed (v2 semantic set) against claimed contractHash/DPI/EI; per-row run/source/generation/world identity binding on contract-bound rows; no-double-authority milestone recomputes SKILL_START counts instead of trusting self-reported metrics; second runner journal bound; fail-closed aggregation (status = strictest verdict); fixed `{status:...}` detail-key collisions that rendered FAILs as arrays.
- `e1ad56e7`: dispatch stepIds bound to reserved mechanical steps; comparison baseline bound to **mainline ancestry** (`merge-base --is-ancestor`) instead of momentary origin/main equality — sealed archives no longer expire when main advances; staleness reported as evidence detail; equality fallback retained when no repo available.
- Real-archive reconciliation: `d781f54` attempt = **142/142 PASS**; `83f44e5` attempt = **139 PASS / 0 FAIL / 3 INCOMPLETE** (kernel-authority artifacts legitimately absent pre-authority — honest INCOMPLETE, not fabricated PASS).
- Negative coverage: 18 fail-closed variants in `test-package-vtr-reach-live-archive.mjs` + mainline-ancestry test in `vtr-reach-comparison-proof.test.mjs` (21/21). Aggregation meta-guards pin status-enum coverage, checkCount, no duplicate ids.
- Two comparison-proof tests updated to fail-closed aggregation semantics (status = strictest; exit fails closed).
- Residual: legacy-side comparison helper internals (`compare-vtr-reach.mjs`) not yet audited line-by-line — P8 input.
- Exact-SHA worktrees recreated: `/home/s0u7a/vtr-src-d781f54`, `/home/s0u7a/vtr-src-83f44e5`.

### P4 — deterministic scenario lab (done, committed `45da2131`)
- `packages/kernel/scenarios.ts`: 10 typed real-reducer traces from historical failures (sc-k-quiesce-generation … sc-k-crash-replay).
- `kernel.scenarios.test.ts` executes each through `applyKernelCommand`; `tools/emit-scenario-registry.mjs` regenerates `docs/development/SCENARIO-REGISTRY.json` (stable ids, origins, expected/forbidden events, per-def SHA-256); registry integrity pinned in test. 11/11 pass; EXPERIMENT-PROTOCOL §4 points at the machine-readable registry.

### Kernel hardening (done, `1554d8c6`)
- Fixed real authority/audit bugs from an independent kernel audit: `command.to` validated on PAUSE_ACTIVE/ACK_PAUSE_YIELD (arbitrary lifecycle injection closed); malformed commands fail closed at the public boundary; `{ok:false}` returns caller-visible input state; APPEND_RECORD requires resource subsumption; replay revalidates full contract semantics; terminal/preemption cleanup no longer rewrites durable COMMITTED/STALE→CANCELED; typed validation for RECONCILE_EFFECT.observation + VERIFY_SUCCESS.causalCredit; invariants reject unknown lifecycles + TERMINAL-without-outcome. 140/140 kernel tests.
- Characterized (pinned, P8 input): pending-terminal stickiness, cancel/deadline race, DISPATCHING non-expiry, generation-ID re-arm, conflict-scoped resumability, VERIFY_SUCCESS w/o mechanical effects, unbounded ttlMs, OBSERVING pause semantics, non-ACTIVE verify acceptance, contract-lifetime effect usage, victim preempt-back rule, transition-ID non-reuse.

### Verification snapshot at e1ad56e7
- bun-tests gate suite: 174/174 (incl. tool fixtures). kernel: 140/140. buddy-driver+jev-agent consumer suites: 78/78 (previous run). `bun x tsc --noEmit` clean.
- Real archives: d781f54 142/142; 83f44e5 139/0/3.
- Next: P5 feature authority map → P6 PBF reduction → P7 bounded-experiment demo → P8 red-team (inputs: F-K3..K14 findings, kernel semantic findings, comparison-helper audit residue).

### P5 — feature authority map (done, `846b38cd`)
- `docs/development/FEATURE-AUTHORITY-MAP.json`: 9 ordered feature domains + non-actuating control domain; every one of 18 CandidateKinds assigned exactly once; per-domain owner/dispatch/admission/kernel-admission/surface-envelope/resource-domain/effect/observation/verification/cancellation/terminalization.
- `bun-tests/feature-authority-map.test.ts` binds it mechanically (7 checks, 456 assertions): CandidateKind union coverage; runActionBody dispatch table extracted and compared (fallthrough-aware); every declared surface resolves via `mapMutationSurface`; resourceDomains/effects equal canonical derivation; transitive `this.*` helper-closure spelling scan proves dispatch-reachable mutation spellings never escape declared envelopes; every `this.bot.*` call covered by a domain or the pinned read-only allowlist; kernel-admission flags honest (only navigation may claim reach modules).

### P6 — PBF/god-surface reduction, slice 1 (in progress)
- Finding: `private` on JevController is theater — ~340 members are reachable through `this as unknown as XHost` structural casts to 16 extracted-plane host interfaces. That coupling IS the god-surface; deleting fields is unsafe without host-interface accounting (verified: 106/107 naive dead-field candidates were live host members).
- Deleted carcasses: `furnacePrereqCandidateOptions`, `uncertainStreaks`, and 4 write-only System2PlaneHost members (`waitReplans`, `wedgeRepeats`, `wedgeWindowFingerprint`, `wedgeWindowId`) whose writes minted unread dynamic properties.
- `bun-tests/host-surface.test.ts`: binding-integrity gate — every Host member must resolve to a real JevController declaration (a host member with no backing reads `undefined` at runtime through the cast — now a test failure); every member must be referenced somewhere; structural casts enumerated + ratcheted; exposed-private count ratcheted (may shrink, must not grow past ceiling).
- jev-agent suite: 207/207; typecheck clean.
