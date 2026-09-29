# AGENTS.md — V4.1.2 Authority Constitution + Capability Campaign

## 0. Permanent architecture lock and precedence

**V4.1.2 Concurrent Verified Transition Runtime is the one permanent architecture.** Validated checkpoint: `092a5b38` (`docs/development/P8-CLOSURE-REPORT.md`). Never create/reopen V4.1.3/V4.2/V5, a successor architecture, architecture tournament/migration, selector, shadow/fallback authority, second terminalization path, or alternate SUCCESS owner. No benchmark result, capability failure, model preference, refactor, or future evidence can unlock this rule.

Fix defects **inside** V4.1.2 ownership/authority semantics. Allowed: implementation fixes, missing mechanics, policy/planning/recovery improvements, observability/proof hardening, semantics-preserving PBF/refactors, scenarios/tests, and new Kernel state/commands/timeouts when ownership is unchanged. If a defect truly requires changing constitutional ownership, record a permanent limitation and work around it at capability/policy/mechanics/observability/proof level.

Canonical sources, highest first: (1) current source/live server truth; (2) `packages/kernel/kernel.ts` plus `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md`, `docs/architecture/v4.1/{V4.1.2-HARDENING,INVARIANTS,KERNEL-EVENTS}.md`; (3) `RESOURCE-AUTHORITY-INVENTORY.md` + static mutation scan; (4) historical V4/V4.1/V4.1.1 lineage docs; (5) deterministic tests/probes/exact-run evidence; (6) older issues/docs as evidence only. If AGENTS conflicts with current V4.1.2 implementation/docs, fix AGENTS. Research context: `docs/history/investigations/minecraft-ai-frontier-report-2026-09-28.md`.

Production authority path is uniquely:
`proposal -> typed KernelCommand -> applyKernelCommand(KernelState, command) -> KernelState + KernelEvent[] -> transition-scoped adapter capability -> Mineflayer/server effect`.
No semantic caller directly mutates ATR state, leases, effect commits, revisions, budgets, Mission authority, trusted facts, or journal sequence. M2/M3/M4 are proof corpora, not the production brain.

## 1. Mission, roles, and success

Build a general Minecraft agent that autonomously drives **verified world-state transitions** for long periods without human feedback and ultimately reaches End-game goals across unseen worlds/states/instructions.

Roles are fixed:
- **Jev:** fast System-One semantic/tactical WHICH/WHETHER choice among grounded enabled transitions/tactics; no truth, SUCCESS, lease, effect, lifecycle, or primitive authority.
- **System2:** sparse WHAT synthesis/repair/decomposition/new causal hypotheses; never a motor loop.
- **Kernel:** sole lifecycle/resource/effect/trusted-fact/revision/budget/Mission/journal/SUCCESS authority; canonicalizes contracts/hashes.
- **Transition Controller:** owns one admitted contract until VERIFY success, typed terminal, or invalidation; requests KernelCommands only.
- **Viability Runtime:** preserves mission-crossing survival via SUSPEND/stabilize/fresh facts/revalidate/RESUME of the same contract; never silently replaces mission intent.
- **Runtime Adapter / ActuationPort:** only production mutation boundary to raw Mineflayer/backend.
- **VERIFY:** sole SUCCESS authority; only verified facts count; truth is TRUE/FALSE/UNKNOWN.
- **HOST:** connection, generation identity, durable state, lease issuance, evidence; not gameplay policy.

ATR lifecycle: `ENABLED -> RUNNABLE -> ACTIVE <-> SUSPENDED`, with `ACTIVE -> OBSERVING`, `BLOCKED -> TERMINAL`. Replayed/audited history never becomes live authority. Crash ambiguity becomes UNKNOWN; never auto-reexecute an ambiguous effect.

## 2. Unattended/YOLO campaign operating contract

Campaign operation is explicitly autonomous and fully permissioned for ordinary engineering. Do **not** ask for routine approval for investigation, edits, tests, branches/worktrees, commits/pushes of validated KEEP changes, process/server/test-world lifecycle, config changes, evidence analysis, or other reversible work serving the goal. Choose the highest-information-value valid action and continue. Questions are allowed only for genuinely user-only input (e.g. unavailable credentials or missing intent whose alternatives materially change the requested goal); keep all independent work moving meanwhile. Never park in a chooser or end with “shall I…?”.

Full permissions do **not** authorize cheating capability evidence, architecture changes, force-push/history destruction, deleting user worlds/sealed archives, or overwriting another lane's unmerged work. Record unresolved non-blocking assumptions/questions in `STATUS.md`/campaign state and keep moving.

### No idle / no polling / substantial-turn rule

Time must pass as a side effect of useful work, never as the work itself.
- **No fixed-time waiting, ever.** `sleep` is mechanically denied for every duration. Do not bypass with `/bin/sleep`, `/usr/bin/sleep`, Python/Node timers, `timeout` used as delay, blocking `tail -f`/reads, busy loops, timer polling, or equivalents.
- **No blocking command observation.** Long-running shells/tests/runs go background; `get_output` is snapshot-only. Inspect once, then work another lane. A timeout is a safety ceiling, never a planned wait.
- **No blocking subagent wait.** Launch independent subagents in background; `read_subagent` is non-blocking only. Check opportunistically at natural work boundaries.
- **No duplicate status polling.** Do not re-run the same normalized heartbeat/log/process/status command unless intervening work or a concrete event gives a causal reason to expect a changed result.
- **Do not micro-turn.** A turn must do a substantial work batch before stopping: e.g. causal analysis + implementation + focused verification, or multiple independent useful actions. One observation/search/subagent launch/tiny edit/status report is not a turn's completion.
- If live evidence is unchanged, switch immediately to log/root-cause analysis, code audit, focused regression, next-fix preparation, provenance repair, or another non-conflicting lane **in the same turn**. Yield only when every useful lane is genuinely blocked.
- Status/commit/subagent completion/context compaction is not goal completion. Continue until the requested milestone is proven or external conditions make every useful lane impossible.

Live observation/audit must be read-only by construction. Never call ambiguous helpers that may `quit/stop/kill`, mutate control sockets/lifecycle/world/inventory, reload generation, or send server commands just to obtain status; inspect source/`--help` first. State-changing lifecycle actions must be deliberate and separately targeted.

## 3. Capability direction: portal first, then reliability/speed/generalization

Diagnostic ladder: `wood -> stone tools -> iron -> food/survival -> cave recovery -> smelting -> portal -> Nether traversal -> fortress/blaze -> pearls -> stronghold -> End`. This is a diagnostic decomposition, **not** a production route script or mandatory promotion ladder.

Until first clean verified autonomous Nether entry, optimize the **end-to-end portal objective**. Pre-portal rungs are checkpoints only: run the longest honest portal-directed attempt, identify the earliest/highest-impact blocker, make the smallest generic fix, return immediately to portal. Do not require full robustness at intermediate rungs.

Ordered phases:
1. **Possibility:** first clean unassisted exact-provenance verified Nether entry.
2. **Reliability:** declared dev+holdout cohort; default robust criterion when five valid trials are practical is **>=4/5 clean portal successes including >=1 holdout**, focused guards green, zero authority violations, no material regression/pathological model-cost growth.
3. **Speed:** minimize verified time-to-portal/actions while preserving reliability/safety/authority/proof; track deaths, stalls, recovery, waste, replans, Jev/System2 use.
4. **Generalize:** unseen seeds/terrain/partial states and semantically equivalent natural-language goals; same generic mechanics/composition, no benchmark memorization.

One portal success proves possibility, not robustness. If infrastructure prevents five valid reliability trials, label confidence LOW. Major rollover is pre-authorized: once a pN premise/timeout is resolved and the next honest experiment needs a fresh world, seal its evidence and launch pN+1 without asking. After portal work is healthy, continue the same pattern toward Nether and End.

## 4. P-series is the development spine

Use immutable `portal-pN` major episodes and `pN.x` same-world causal hot iterations. Maintain append-only `runs/capability-campaign/P-SERIES.md`, machine state in `state.json.portalAttempts`, and immutable run artifacts. Never rewrite old evidence; append corrections with provenance.

Each major record binds exact SHA/config/seed/world/start/mission+accept/model-provider/run identity and records terminal depth/outcome, checkpoint times, inventory/tool progression, Jev/System2 count+latency, deaths/stalls/cost, earliest causal blocker, learning, KEEP/REVERT/DEFER, fix SHA/control reason, and next hypothesis/signature.

### Major vs minor
- `pN+1`: materially new experiment episode — normally fresh world/fixture, changed premise, broad/non-quick causal change, or clean exact-SHA end-to-end proof.
- `pN.x`: **same major world/server/player/connection/host durable state by default**, one narrow causal production delta, no architecture/authority/verification change, no broad refactor or benchmark-specific behavior.
- One minor = one causal production defect. Required test/docs proving that defect may share the commit; unrelated fixes get separate minors.
- A safety restriction that merely shrinks reachable state is `SAFETY_GUARD/PARTIAL`, not capability closure; pursue the reusable mechanic unless the state is intrinsically invalid.
- AI inefficiency (over-collection, rebuilding satisfied resources, bad upgrades, needless slow strategy, repeated satisfied subgoals) is a valid generic capability defect.

### Fast hot iteration
Minor evaluation is normally **10–15 minutes maximum**, often less when its target signature proves/falsifies earlier. Repeated typed blocker with enough causal evidence => patch immediately; do not let one SHA idle for an hour. Long major-world progression may accumulate across many fast minors.

For reloadable generation changes, preserve the resident HOST/Mineflayer connection and use canonical generation reload: `build -> import -> structural smoke -> quiesce old -> atomic lease/generation commit -> start new -> dispose old`. Require changed hash plus `GENERATION_READY`/status carrying exact new `sourceSha`, `reconnects=0`. HOST restart/reconnect only for genuine HOST/contract/schema change, dead/unhealthy resident, or explicit infra condition.

Use one stable live resident worktree per major (`src-live` style). **Never edit production source dirty in the live resident worktree.** Implement/test elsewhere, commit exact one-cause SHA, require live worktree clean, move it to that SHA, then reload. Dirty live reload invalidates exact-SHA evidence.

Hot-swap provenance moves atomically with generation: keep major `runId` as episode/directory identity; use `activeMinor`/`segmentId` for pN.x; record generation SHA/hash/id, runtime/worktree, HOST PID, resident log, swap time, reconnect count, unchanged world/server, and distinguish `hostBootSha` from `generationSourceSha`. `active-run.json`, observer/state and evidence must agree. Registry writes are atomic/CAS-like on exact claim/segment so stale pN cleanup cannot unlink/overwrite pN.x.

## 5. Anti-benchmaxxing and experiment contract

`BENCHMAXX` means improving measured depth/score by reducing transfer. Forbidden: seed coordinates, memorized resource/block locations, p-specific action sequences, exact benchmark wording hacks, fixture-specific branches, hidden task selectors, giant ladder scripts, or tuning prompts only to known runs. Improvements must come from reusable mechanics, world-state reasoning, prerequisite/resource accounting, planning/decomposition, survival/recovery/navigation, interaction mechanics, and instruction interpretation.

For each selected blocker/checkpoint:
1. Predeclare predicate, metrics, dev cohort and holdout cohort **before tuning**; prefer >=3 dev + >=2 holdout when practical, otherwise record sample-size limitation.
2. Establish clean same-protocol exact-SHA baseline.
3. Cluster **first causal failures** by typed cause/signature: `GROUNDING_REFUSAL`, `VERIFY_FAIL`, `LEASE_DENY`, `STALE_FENCE`, `BUDGET_EXHAUST`, `MODEL_UNAVAILABLE`, `MECHANICAL_FAIL`, `NO_PROGRESS`, `AUTHORITY_VIOLATION`, `INFRA`.
4. Choose highest-impact frequent open-zone cluster. One experiment = one falsifiable hypothesis = one causal change + explicit expected signature/metric.
5. Minimum deterministic/focused regression first; then smallest dev live sample that can falsify; full dev cohort only when warranted; holdout for portal reliability/promotion, not intermediate polishing before first portal.
6. KEEP only if architecture/authority guards remain green and declared primary improves (or holds while declared secondary materially improves) without material lower-rung regression or unbounded model/System2 cost.
7. REVERT early on causal falsification/regression/new failure/authority violation. DEFER/ESCALATE on frozen/constitutionally impossible/unavailable dependency/exhausted bounded hypotheses, preserve evidence and switch lanes. INFRA requires evidence/control reproduction when practical.
8. Commit before provenance-sensitive live evaluation; after KEEP update records/state, integrate safely, and immediately continue.

Core metrics: verified task success; time/actions/steps; deaths/damage/food/air emergencies; recovery success; stall count/duration; resource waste; replans; candidate refusals; Jev choices/rejections/latency; System2 calls/applied/discarded/latency/token-cost proxy; model-unavailable events; authority/effect failures; cross-seed/biome/novel-state failures. Prefer verified predicates over “log vibes”.

Never change seed cohort after seeing results, count a run twice, discard a valid inconvenient failure, label gameplay `INFRA` without evidence, weaken predicate/acceptance/world premise/VERIFY, hide retries by resetting identity/counters, or tune on holdout outcomes.

## 6. Measurement protocol and fixture discipline

Protocol v2 ordinary capability cohorts are **sequential single-world experiments**:
- Max one live mutating capability server; `tools/capability-run.mjs` enforces `runs/capability-campaign/active-run.json` + process guard; `--allow-concurrent` is exceptional and hypothesis-bound.
- Canonical seed/world family declared in `state.json`; predeclared coordinate cohort in `runs/capability-campaign/cohort-v2.json` from `tools/cohort-scan.mjs`; coordinates separated enough to avoid mutation contamination and never cherry-picked after results.
- `--start x,y,z` is fixture setup via spawn configuration before resident join/measured clock, not capability; no post-start operator assists.
- Exact-state comparisons regenerate fresh world from canonical seed per run; server does not persist between cohort runs.
- Normal cohort rejects clearly pathological starts (ocean-only, lava, sealed spawn, extreme lethal cliff/void/tiny island/deep cave); normal trees/canopy/ordinary terrain are **not** invalid. Pathological terrain belongs to named stress cohort.
- v1 = pre-2026-09-27 per-run fresh seeds/parallel worlds; v2 = canonical seed + declared start/sequential. Never mix denominators.
- Canonical read-only observer: `http://127.0.0.1:4173/api/ai-summary` via `tools/buddy-observer.mjs`, registry mode; idle response is HTTP 200 `available=false/no_active_campaign_run`.

Measurement/tooling supports gameplay, not vice versa. If setup consumes roughly **15 min or 2–3 failed refinements** without unlocking gameplay, use the simplest trustworthy protocol and record limitations. Once 5 sufficiently separated ordinary starts exist for a normal wood cohort, freeze it; do not hunt for prettier terrain. Never discard a valid gameplay failure because an easier start exists.

## 7. Kernel/resource/mutation invariants

Semantic contract ownership and physical resource/actuation leases are separate. `ResourceId` is structured/hierarchical; bundles acquire atomically. Every mutation requires an ACTIVE current contract, current world+dimension+epoch+generation binding, a covering current lease, and allowed effect permit. Irreversible effects require kernel-owned single-use `EffectCommitToken` bound to transition/contract hash/generation/effect.

World/dimension/epoch/generation revisions fence stale Jev/System2 decisions, leases, effect tokens, ResumeProofs and preemption transactions. Preemption uses safe-yield, bounded critical sections, multi-victim atomicity, priority inheritance.

All production mutation crosses Runtime Adapter/ActuationPort. Do not add raw `bot`, `_client`, pathfinder/entity/window/plugin mutation bypasses. VTR core (Mission/World Model/Graph/Scheduler/Controllers/Viability/Jev/System2) must not retain/call raw Mineflayer. HOST may own it only for lifecycle/lease/adapter wiring.

Migration/cutover is CLOSED historical work. Kernel authority is production authority; old SHADOW/cutover/deletion instructions are evidence history. Sealed VTR archives/validators remain protected proof infrastructure.

## 8. Development classification and proof

Classify work:
- **A CAPABILITY_CRITICAL:** improves/measures lowest unsolved rung or regression.
- **B CAPABILITY_CORRECTNESS:** truth/mechanics/controller/recovery/lifecycle/durability/provenance/verification bug invalidating capability.
- **C MEASUREMENT_PROOF:** minimal scenarios/probes/cohorts/results/observability/tests needed to trust A/B.
- **D CAMPAIGN_INFRA:** bounded work removing a real unattended-campaign blocker.
- **E DEFER:** forbidden architecture work, cosmetics, unrelated refactor, speculative feature, or polishing solved rung while later blocker exists.
Prefer A/B/C; D only for concrete blocker; never invent E because capability is hard.

Development rules: new authority only via KernelCommand; new intelligence only through Jev policy, scheduler/routing, Verified World Model, controller tactics or sparse System2. Compatibility adapters name authoritative side + deletion condition. Never silently fall back to deterministic semantics on model outage unless explicitly configured test/offline policy. `action done` != SUCCESS. Keep irreversible effects fail-closed.

Proof hierarchy as applicable: pure contract/state-machine -> deterministic mechanical fixture -> no-LLM CAN/HOW/DONE live probe -> real scheduler/runtime integration -> double-authority exclusion -> stale world/epoch/lease/generation fencing -> target/witness substitution -> progress/budget exhaustion -> provider-outage test when independence claimed -> fresh exact-source live evidence. Mechanical probe PASS proves mechanics, not autonomous composition; benchmark PASS proves outcome, not architecture; shadow journal proves observation only.

### Test-surface discipline
Tests protect observed capability and constitutional invariants; they are not the product. Do not create a test file by default. Add minimum deterministic coverage for a real reproduced failure, preferably inside an existing relevant test/scenario/fixture. Avoid speculative edge-test families and second measurement frameworks. A faithful clean live reproduction plus existing guards may be sufficient. Track test/tooling growth; if it outgrows production value, consolidate and return to Minecraft. Never weaken constitutional/proof coverage to shrink tests.

For shared scheduler/decision-epoch/controller/executor lifecycle or HOST contract changes, include direct lifecycle/terminal seam fixtures with partial/fake hosts; update those fixtures in the same causal commit. At most one full repo/package sweep runs at once; parent owns final full sweep, subagents use focused non-overlapping checks.

## 9. Parallel work and subagents

Use up to **3** genuinely independent lanes; aim for 2–3-way parallelism when useful, never filler. Parent is integrator/decision owner; one mutation owner per subsystem/experiment. Good lanes: live evidence/root cause; focused code/fixture audit; independent regression/provenance; Jev ranking; sparse System2 quality/cost; recovery/viability; bounded infra hygiene.

Subagents are throughput tools, never waiting targets. Launch background, continue parent work immediately, poll non-blockingly only at natural boundaries, reconcile personally before landing. Do not run same full suite in parallel, duplicate implementation, reset concurrent worktrees, or keep old subagents/processes alive without purpose. Never create an architecture-design lane.

## 10. Runtime/resource hygiene

Default one active Leaf server for current major. After major rollover, stop obsolete resident/server processes once world bytes/evidence are safely on disk; historical world preservation does not require a live JVM. Concurrent old servers require named current hypothesis, explicit evidence purpose, prompt end condition. Treat RAM/swap/CPU/disk pressure as development latency.

Capability retention: keep newest **10 p-series versions** with full raw worlds/logs. For older completed failed `portal-p*`, retain `plan.json`, `result.json`, `P-SERIES.md` provenance, `server.log`, `retention-summary.json`, gzip resident AI logs, then raw reproducible server world may be removed. Never prune active/incomplete, OBJECTIVE_SATISFIED/accepted, sealed archive, `.retention-protect`, or user world.

On provider outage record `MODEL_UNAVAILABLE`, preserve semantics, switch to deterministic/mechanical/observability/recovery/provider-independent work. If source/run/server/world identity is uncertain, invalidate evidence and start clean; never repair provenance by hand.

## 11. Git, worktrees, issues, integration

`main` is validated KEEP checkpoints, not speculative work. Fetch/reconcile before push; never force-push/rewrite shared history, reset away unrelated work, delete another lane's unmerged worktree, or amend pushed shared commits. Risky candidates use clean disposable `cap-*` worktrees from exact trusted SHA. Push small coherent validated KEEP checkpoints so crashes lose little work.

Do not create issues/PRs for tiny symptoms. Durable issue = repeated causal cluster, capability acceptance criterion, reproducibility blocker, or correctness defect spanning experiments. Direct integration is authorized for unattended KEEP work after required evidence/tests, safe `origin/main` integration, and diff review. Commit/result record names rung/scenario, causal hypothesis/failure, verdict, evidence path.

Spend clear majority of productive time on measured gameplay capability; campaign infra/tooling should normally stay below roughly **25%** unless a concrete blocker requires more.

## 12. Durable campaign state and resume

Keep `runs/capability-campaign/state.json`/`STATUS.md` resumable: campaign/start time, start/trusted/last-KEEP SHAs, active rung/predicate/promotion criterion, dev/holdout cohorts, baseline/results, failure clusters/signatures, falsified hypotheses, active experiment/worktree/process/world, blocked/deferred lanes, next actions, plus active major/minor/generation provenance.

After restart, reconcile **AGENTS + state.json + P-SERIES + git HEAD/origin/status + actual processes/world/registry** before action. A prompt of only `continue` means resume the next falsifiable action; never ask the operator to restate context.

A fresh/hard-reset campaign boot: fetch and inspect exact git state; record start SHA/time/disk/process/provider availability without secrets; create/resume durable state; reuse existing run/supervisor/observer/result tooling; establish exact-SHA/world/seed/predicate/run provenance; isolate campaign worlds from sealed/user worlds; never allow two mutating owners of one world.

For an explicitly time-bounded long campaign, finish current bounded experiment near the end and write a durable report: start/end + start/final origin SHAs; KEEP list by rung/failure; baseline/final metrics/cohorts/sample/confidence/holdout; frontier + first unsolved rung; remaining clusters/next experiments; regressions; Jev/System2 usage/cost; evidence paths; infra vs product failures; confirmation V4.1.2/guards remained intact. One rung passing is never early completion.

## 13. Runtime evidence checklist

Be able to answer: active Mission frontier; Transition type/instance/contract hash; requires/ensures; controller progress; temporary target/witness changes; resource/risk budgets; viability interruption/resume; deterministic postcondition; terminal outcome/reason; world/dimension/epoch/generation; model calls and why; any legacy Option/GoalQueue/Jev-π/β authority involvement vs kernel-admitted Jev frames; whether two authority paths could actuate; shadow counters (`mutationsObserved`, `mutationsMapped`, `mutationsAttributedToTransition`, `mutationsUnguarded`, `kernelDenied`, blockers, `coverageComplete`). Track model calls per verified Transition and mechanical steps per model call.

## 14. Explicit anti-goals

Never solve problems by: renaming Option to Transition while preserving old per-action authority; wrapping GoalQueue as another truth ledger; making β smarter instead of removing generic model-owned termination; ending/recommitting a Transition for every tactical recovery when bounded in-contract Jev consultation suffices; giant deterministic benchmark planner; moving mega-controller into files without causal-ownership improvement; candidate/context growth instead of controller closure; unbounded retries/arbitrary N-failure switches; weakened Guard/VERIFY/evidence; shadow replay as authority; permanent old+new dual authority; seed/fixture/wording-specific hacks.

M3 (`ender_eye >= 12` under canonical run-scoped gate) remains a useful long-horizon composition benchmark, not the architecture or only objective. A fresh M3 PASS matters only from honest clean V4.1.2 production evidence; continue changed-seed/partial-start/benchmark-absent/unsupported-predicate testing before calling behavior robust.

**Core loop:** `evidence -> causal defect -> smallest generic V4.1.2 fix -> focused proof -> exact commit -> generation hot reload when eligible -> first live evidence -> next blocker`. Keep it fast; keep it honest; keep Minecraft moving.
