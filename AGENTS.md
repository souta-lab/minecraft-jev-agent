# AGENTS.md — V4.1.2 Authority Constitution

## PERMANENT ARCHITECTURE LOCK — read this first

**V4.1.2 is the one permanent canonical architecture of this project. It is never to be replaced, reopened, superseded, version-bumped, or redesigned in this repository.**

The validated architecture checkpoint is commit **`092a5b38`** (see `docs/development/P8-CLOSURE-REPORT.md`). Later commits — including docs-only commits — do not redefine the constitution.

- There will be **no V4.1.3, V4.2, V5, successor architecture, architecture tournament, or architecture migration** in this repo.
- **No future counterexample, benchmark result, performance issue, model preference, refactor opportunity, or agent suggestion authorizes reopening the architecture.** "Freeze" here means permanently locked, not "temporarily pending evidence." There is no trigger, threshold, or process by which it unlocks.
- If a future defect appears, fix it **within** V4.1.2 ownership/authority semantics. If it cannot be fixed without changing the constitution, record it as a **permanent known limitation** and work around it at the capability/policy/mechanic/observability/proof layer. Do **not** invent a successor architecture.
- **Allowed work:** implementation bug fixes; missing mechanics that preserve existing ownership (a new Kernel command/state/timeout is allowed when authority ownership stays unchanged); observability/proof hardening; semantics-preserving PBF/refactors; scenario/test improvements; Minecraft capability improvements.
- **Forbidden work:** moving authority ownership; changing the Kernel/Jev/System2/controller/backend constitutional split; adding shadow/fallback/alternate authority or a second terminalization path; redesigning SUCCESS ownership; architecture selectors; proposing or prototyping a successor architecture.
- **P-series evidence, benchmark/Benchmaxx pressure, speed targets, model behavior, and capability failures can NEVER authorize an architecture change.** They may justify implementation, policy, mechanics, observability, proof, or capability fixes only inside the existing V4.1.2 constitution. If a p-run appears to require changing constitutional ownership/authority/verification semantics, mark that route forbidden and find an in-constitution fix or record a permanent limitation.
- Historical documents describing earlier architectures or past successor research are preserved as records only; **current governance documents override them**. Unrelated external "V5"-style labels (e.g. vendored docs, milestone usernames) are not project architecture versions.

**Primary project objective from now on: measurable Minecraft capability** — task success rate, time/actions to success, deaths, recovery, stalls, replans, resource waste, Jev decision quality, System2 cost, and cross-seed/biome/novel-state robustness — not architecture exploration.

## 0. Canonical architecture

The canonical production architecture is **V4.1.2 Concurrent Verified Transition Runtime / authority kernel**.

Normative references, in precedence order:

1. current source and live server truth
2. `packages/kernel/kernel.ts` implementation + `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md`, `docs/architecture/v4.1/V4.1.2-HARDENING.md`, `docs/architecture/v4.1/INVARIANTS.md`, `docs/architecture/v4.1/KERNEL-EVENTS.md`
3. `docs/architecture/v4.1/RESOURCE-AUTHORITY-INVENTORY.md` + the static mutation scan — the authority-closure source of truth for every mutating surface
4. `docs/history/architecture/NEW-ARCHITECTURE-V4.md`, `docs/history/architecture/NEW-ARCHITECTURE-V4.1.md`, `docs/history/architecture/NEW-ARCHITECTURE-V4.1.1.md` — semantic lineage docs
5. current deterministic tests / probes / exact-run evidence
6. historical docs/issues (#11, #308, Option/Jev/System2 history) — evidence only, never constitutional authority

If this file disagrees with the V4.1.2 implementation or current V4.1.2 docs, **the implementation and V4.1.2 docs are canonical — fix AGENTS.md**, not the implementation.

Research context: `docs/history/investigations/minecraft-ai-frontier-report-2026-09-28.md`

## 1. Project mission

Build a general Minecraft agent that autonomously drives verified world-state transitions for long periods without human feedback.

The runtime target is the V4.1.2 authority kernel:

```text
Mission / System2 / Jev / controller proposals
                  |
                  v
        typed KernelCommand
                  |
                  v
applyKernelCommand(KernelState, command)
                  |
       +----------+-----------+
       |                      |
       v                      v
 new KernelState       deterministic KernelEvent[]
       |
       v
transition-scoped adapter capability
       |
       v
Mineflayer / server side effect
```

`KernelCommand -> applyKernelCommand() -> KernelState + KernelEvent[]` is the **only** runtime authority state transition path. No semantic caller directly mutates ATR state, leases, effect commits, revisions, budgets, Mission authority, trusted facts, or journal sequence.

M2/M3/M4 are proof corpora, not the production brain. An M3 PASS that preserves the wrong control architecture is not project completion.


## 1A. Unattended capability campaign mode

This repository is expected to support **multi-day autonomous capability campaigns with no routine human approval loop**. When a task explicitly requests unattended operation (for example a ~7 day capability campaign), the agent must keep doing useful, reversible, constitution-preserving work instead of stopping for ordinary decisions.

Operating rules:

- **Never ask for routine permission.** Investigation, bounded product edits in open zones, tests, clean live runs, server/test-world restarts, evidence analysis, disposable worktrees, small validated commits, and pushes of proven KEEP changes are pre-authorized when they serve the campaign.
- When several valid choices exist, choose the **most conservative reversible option that yields information**. Record the choice; do not wait for a human preference.
- `ESCALATE` in `EXPERIMENT-PROTOCOL.md` means **stop that candidate, preserve its evidence, mark it deferred/escalated, and move to another permitted hypothesis or lane** during unattended operation. It never grants permission to touch a frozen zone, and it is not by itself a reason to stop the campaign.
- If one lane is blocked by provider outage, flaky infra, missing credentials, a frozen surface, or repeated REVERTs, **switch to another independent capability/measurement/fix lane**. Only idle when all useful in-constitution lanes are exhausted or the execution environment itself prevents further work.
- Never weaken a gate, acceptance rule, clean-run premise, seed attestation, VERIFY requirement, or evidence schema to make a candidate win. Never use `/give`, `/tp`, `/setblock`, assisted inventory/world edits, or reused dirty worlds as capability evidence; such commands are fixture-only.
- Keep accepted/sealed evidence. Transient failed runs, disposable worktrees, caches, and generated artifacts may be pruned only after their machine-readable summary and causal evidence are preserved. Never delete user worlds or sealed acceptance archives.
- Never force-push or rewrite shared history. Before each push: fetch, confirm the candidate is based on current `origin/main` or cleanly rebased, run required gates, review the diff, commit a small coherent KEEP checkpoint, and push normally. If remote integration conflicts, preserve the candidate on a named branch/worktree and continue another lane rather than destroying work.
- Maintain resumable state under `runs/capability-campaign/` (current rung, exact base SHA, seed cohort, latest experiment/result paths, active failure clusters, blocked/deferred lanes). After each accepted KEEP, also leave a concise durable summary in the normal experiment-result/docs trail so a restarted agent can reconstruct the campaign without chat history.

### Capability optimization doctrine

The permanent diagnostic ladder is:

`wood -> stone tools -> iron -> food/survival -> cave recovery -> smelting -> portal -> Nether traversal -> fortress/blaze -> pearls -> stronghold -> End`

This is an **evaluation/decomposition ladder, not a sequence of mandatory promotion gates and not a giant deterministic planner**. Improve generic mechanics/policy/controller behavior that causes the measured failure. Do not encode the expected route as production authority.

### Portal-first campaign objective

Until V4.1.2 has produced its first clean verified autonomous Nether portal entry, the campaign's **primary optimization target is the end-to-end portal objective**, not independent robustness of wood, stone, iron, food, or smelting. The pre-portal rungs are diagnostic checkpoints inside the portal run.

- Run the longest honest portal-directed attempt that current capability can support. When it fails, identify the earliest/highest-impact blocking checkpoint, make the smallest generic fix, and **return immediately to a portal-directed run**.
- Do **not** require `4/5` robustness, a full holdout promotion, or exhaustive polish of each pre-portal checkpoint before allowing the agent to attempt later checkpoints. A checkpoint only needs to work well enough to expose the next real blocker.
- The first verified portal entry is a **possibility proof**, not a robustness claim. It must be from a clean unassisted run, bind exact source/world/run identity, satisfy normal authority/VERIFY rules, and use no benchmark-specific production hard-coding.
- After the first portal success, switch the primary objective to **portal reliability** across the declared dev+holdout cohort. The default robust criterion is at least `4/5` clean portal successes including at least one holdout success when five trials are practical.
- After portal reliability is established, switch the primary objective to **portal speed/efficiency**: minimize verified time-to-portal while tracking deaths, stalls, recovery quality, mechanical actions, resource waste, replans, Jev/System2 usage, and regressions.
- After speed work is healthy, enter **Generalize**: prove the capability transfers beyond the exact training/evaluation setup to unseen seeds, ordinary biomes/terrain, changed local state, and equivalent goals expressed through different natural-language instructions. The long-term direction is an interactive agent that can receive a user request in chat, interpret the requested Minecraft outcome, compose existing generic capabilities, execute it autonomously, report progress/results, and ask only when genuinely blocked by missing intent or unavailable capability.
- Generalization must come from reusable mechanics, world understanding, planning/decomposition, recovery, and instruction interpretation—not seed coordinates, memorized benchmark routes, phrase-specific hacks, or hidden task selectors.
- Pre-portal checkpoint metrics remain useful for localization and regression, but they must not become local optimization targets that delay the next end-to-end portal attempt.
- Once portal reliability/speed/generalization work is healthy, continue the same pattern beyond the portal toward Nether traversal and later milestones.

### P-series end-to-end development loop

Portal-first capability development uses a monotonically increasing end-to-end attempt series: `portal-p1`, `portal-p2`, `portal-p3`, ... . **The p-number is the development spine.** Do not treat these as disposable run names.

#### Durable p-evolution log

Maintain a compact, append-only evolution ledger at `runs/capability-campaign/P-SERIES.md`, with machine-readable detail continuing in `state.json.portalAttempts` and each immutable run directory. Add one entry for every completed/stopped `portal-pN` before launching `pN+1`. Each entry must record at least: exact SHA/config/fixture, terminal depth/outcome, milestone times, key inventory/tool progression, Jev/System2 counts+latency when available, deaths/stalls/model cost, earliest causal blocker, what was learned, the KEEP/REVERT/defer decision, fix SHA or unchanged-control reason, and the explicit hypothesis/expected signature for the next p-run. Never rewrite old entries to make later behavior look better; append corrections with provenance. The ledger exists so a future `continue` can reconstruct the actual evolutionary path from p1 onward without chat history.

#### Anti-benchmaxxing / BENCHMAXX discipline

Treat the p-series as an instrument for improving **general Minecraft capability**, not a public leaderboard to game. `BENCHMAXX` here means optimizing a measured run in ways that raise its score/depth while reducing transfer to unseen worlds, tasks, wording, or states; that is forbidden. Never encode seed coordinates, remembered block/resource locations, p-specific action sequences, exact benchmark wording, fixture-specific branches, hidden task selectors, or model prompts tuned only to one known p-run. Improvements should arise from generic world-state reasoning, prerequisite/resource accounting, planning/decomposition, recovery, survival, navigation, interaction mechanics, and instruction interpretation. Periodically challenge a mature capability with unseen seeds/terrain/state and semantically equivalent natural-language goals so apparent p-series gains cannot survive only by benchmark familiarity. A faster/deeper p-run is evidence only when the causal change is generic and constitutional.

- Every `pN` is an immutable evidence point bound to its exact source SHA, seed/world/start fixture, mission/accept predicate, model/provider configuration, run artifacts, and verified outcome. Never overwrite or silently rerun an old p-number with different code.
- After each `pN`, audit both capability and AI behavior: milestone/checkpoint times, inventory/tool progression, deaths/damage/food, stalls and repeated actions, resource over-collection/waste, Jev decisions/latency/rejections, System2 intents/applied/discarded plans/latency, recovery behavior, authority/effect failures, and the earliest causal blocker.
- `pN+1` must explicitly inherit the useful evidence from `pN`. State what `pN` taught us, what causal behavior is being changed, and what observable signature should improve. Prefer the smallest generic fix that unlocks deeper end-to-end progress.
- Keep the comparison legible: preserve prior artifacts, record the exact delta between adjacent p-runs, and compare time-to-checkpoint as well as final depth. A later p that reaches farther but introduces pathological deaths, loops, model cost, or authority violations is not automatically better.
- Do not spend the interval between p-runs polishing tooling. Once the causal question is answered and focused guards are green, launch the next p-run. The normal rhythm is **run pN -> inspect evidence -> smallest causal fix -> run pN+1**.
- **Quick-fix exception — do not wait for Minecraft action/run completion.** When a live `pN` exposes a small, high-confidence, generic defect whose fix is local, reversible, constitution-preserving, and covered by focused guards, begin and apply the quick fix immediately instead of waiting for the current Minecraft action, subgoal, death cycle, or whole p-run to terminate. Keep the same major p-number and increment only the minor version (`pN` -> `pN.1` -> `pN.2`) as soon as each quick fix is applied. Never use manual Minecraft actions, teleports, inventory edits, or other gameplay assists as a quick fix.
- **Minor p-versions are same-world hot iterations by default.** `pN.1`, `pN.2`, ... must normally keep the existing Leaf server and exact Minecraft world alive, stop/replace only the resident/runtime needed for the code change, and reconnect the new exact-SHA resident into that same world state. Do not regenerate the world, reset inventory/world progress, or restart the full capability run merely to test a quick fix. A fresh world/server episode is a new major version (`pN+1`) unless an infrastructure failure makes the server restart unavoidable; such an infra restart is not clean same-world minor evidence unless the identical world bytes/state are preserved and explicitly recorded.
- **Speed is the point of minor versions.** A minor SHA should usually get roughly **10–15 minutes maximum** of live evaluation, or less when its target signature is proved/falsified earlier. If the same typed blocker repeats enough to establish causality, patch immediately and advance the minor version rather than letting one SHA run for an hour. Long wall-clock Minecraft progress may continue for hours inside one major episode, but it should accumulate across fast `pN.x` hot iterations, not by idling on one known-defective SHA. Extend a minor beyond ~15 minutes only when the bot is actively traversing a genuinely new frontier and no actionable repeated blocker has appeared; record why.
- **Minimize blocking waits in development tooling.** `sleep`, shell `wait`, long blocking reads, and oversized tool/process timeouts are last resorts, not monitoring strategy. Never insert a long fixed delay merely to let Minecraft, a test, a model call, or a background process "make progress." Start long-lived work asynchronously, inspect immediately available evidence, do non-conflicting useful work, and re-check state with short non-blocking polls when there is a concrete reason. A 10–15 minute evaluation window does **not** authorize `sleep 600` or equivalent idle tool calls.
- **`sleep` seconds must be the minimum physically necessary.** Prefer zero sleep. For process startup/port/socket/file-settle races, use readiness/state checks; if a fixed sleep is unavoidable, start with roughly **1–3 seconds**, rarely exceed **5 seconds**, and treat anything above **10 seconds** as exceptional and explicitly justified. Commands such as `sleep 60`, `sleep 240`, `sleep 420`, `sleep 1500`, or repeated minute-scale sleeps are forbidden for routine campaign observation.
- **Timeouts are safety ceilings, not planned waiting periods.** Set tool/process timeout values close to the expected command runtime and prefer early-return/state-detection behavior. Do not make a tool call block for minutes just because the underlying run may last minutes or hours. Background long tests/runs when safe, keep their PID/session/artifact path, and inspect their current output later. Use `wait` only when a downstream operation has a true hard dependency that cannot be checked through process/file/socket/readiness state.
- **Optimize human/tool latency as a first-class campaign cost.** Interactive tool calls spent sleeping are lost development time. While a live run is naturally accumulating evidence, analyze existing logs, prepare the smallest likely fix, run focused tests, inspect another non-conflicting lane, or return control rather than occupying the tool channel with a timer.
- **Live-run observation itself must be non-blocking.** Do not use fixed `sleep` merely to watch a resident, server, model call, or log advance; commands such as `sleep 20 && tail ...`, `sleep 50`, `sleep 60`, `sleep 75`, `sleep 90`, and longer are forbidden observation patterns. The 1–3 second fixed-sleep allowance above is only for a concrete startup/kill/socket/file-settle race when no readiness check exists. For campaign progress, inspect current evidence once, then do useful non-conflicting work or return control and poll later. Never chain a timer to `tail` as a monitoring loop.
- **One minor version = one causal production delta.** Do not bundle an unrelated regression repair, cleanup, or second blocker fix into the same `pN.x` merely to save a reconnect. If a previously shipped minor is found to have introduced an independent regression, preserve that provenance and repair it as its own causal boundary before/after the current blocker as appropriate. A commit may contain tests/docs required to prove its one production delta, but not two independent behavior changes.
- **A safety restriction is not automatically capability closure.** A change that prevents a death by shrinking reachable state/action space (for example refusing an entire terrain/medium/action class the agent still lacks mechanics for) may be kept as a temporary safety guard, but must be labelled `SAFETY_GUARD`/partial rather than "blocker solved". Unless the restricted state is intrinsically invalid or constitutionally impossible, continue toward the reusable mechanic that makes it traversable/recoverable. Prefer adding grounded mechanics (with bounded feasibility/breath/resource proofs) over permanently blacklisting ordinary Minecraft states. Never claim generalization from a fix whose main effect is to avoid the frontier.
- **Same-world hot-swap provenance must move atomically with the resident.** Before a new `pN.x` resident is treated as active evidence, update the campaign's active-run machine state to the exact active minor, SHA, runtime/worktree, resident PID, stdout/log path, swap timestamp, and unchanged world/server identity; then verify the first live log carries that exact `sourceSha`. `active-run.json`, observer/status tooling, and evidence summaries must never continue pointing at `pN` after the real resident is `pN.x`. If current tooling cannot represent a minor swap faithfully, make the smallest tooling fix immediately rather than relying on human memory or filename inference.
- **Runtime resource hygiene is part of iteration speed.** Default to one active Leaf server for the current major episode. After advancing to a new major, stop obsolete resident/server processes once their world bytes and evidence are safely on disk; keeping an old world does not require keeping its JVM alive. Concurrent old servers are exceptional and require a current named hypothesis, an explicit evidence purpose, and a prompt end condition. Never keep p17/p18-style historical servers alive just for passive "maybe useful" observation. On constrained hosts, treat RAM/swap/CPU pressure as development latency and reclaim obsolete processes promptly.
- **Full-suite ownership is singular.** At most one full repository/package regression sweep should run at a time. Subagents should run focused, non-overlapping tests/audits for their lane; the parent/integrator owns the final full sweep once the causal delta is ready. Do not launch duplicate `bun test bun-tests/`, duplicate whole-package sweeps, or recursive legacy sweeps in parallel. Cancel stale/redundant full-suite processes. For shared candidate/planner/prerequisite changes, include the nearest cross-package seam/invariant fixture in the focused set so a p14-style regression is caught without repeatedly paying the entire repository sweep.
- **Shared lifecycle/host-contract changes require their seam fixtures in the focused gate.** If a change makes scheduler/decision-epoch/controller/executor lifecycle code read a new host field, changes lease/terminal handoff behavior, or expands a structural host interface, run the direct lifecycle/terminal fixtures that instantiate partial/fake hosts before landing it. Update those fixtures in the same causal commit when the production contract legitimately gained a required field; never carry an unknown-red structural fixture for multiple p-versions merely because the feature-local test passed. In particular, changes around `requestDecision`, scheduler preemption/defer, controller completion, or executor settlement must include the relevant VTR mechanical-step/terminal authority seam checks.
- Same-p quick fixes must preserve provenance. Represent each same-episode quick fix as a minor p-version: `pN.1`, `pN.2`, ... . Record every minor version in `P-SERIES.md` and machine-readable state with: pre-fix SHA, post-fix SHA, timestamp, observed defect/signature, exact code delta, guards run, resident reconnect boundary, same-world identity, and the first live evidence after reconnect. A major episode containing multiple quick-fix SHAs is **not** one exact-SHA capability proof; metrics and claims must be attributed to the correct minor segment. The integer part (`pN`) is the continuous world/evolution episode; the minor version marks each resident-code/SHA boundary.
- Major p-number advancement is for a materially new experiment episode: fresh world/fixture, changed experimental premise, non-quick/broad causal change, or a clean exact-SHA end-to-end proof run. A quick fix must stay genuinely quick: one narrow causal defect, no architecture change, no authority/ownership/verification change, no broad refactor, no benchmark-specific behavior, and no measurement-framework detour.
- AI inefficiencies are valid p-series defects even when the run is technically progressing. Examples include gathering far beyond the amount needed for the next tool, rebuilding resources unnecessarily, repeating already-satisfied subgoals, failing to upgrade tools when prerequisites are present, or choosing a much slower acquisition strategy without a state-based reason. Fix these as generic planning/grounding behavior, never as a hard-coded benchmark route.

For each diagnostic checkpoint or selected blocker:

1. Predeclare the task predicate, metrics, development seed cohort, and holdout seed cohort **before** candidate tuning. Prefer at least 3 development seeds + 2 holdout seeds when live-run cost permits; if less is practical, record the sample-size limitation explicitly.
2. Establish a clean exact-SHA baseline. Existing milestone/clean-run rules remain authoritative where applicable.
3. Cluster failures by typed first cause (`GROUNDING_REFUSAL`, `VERIFY_FAIL`, `LEASE_DENY`, `STALE_FENCE`, `BUDGET_EXHAUST`, `MODEL_UNAVAILABLE`, `MECHANICAL_FAIL`, `NO_PROGRESS`, `AUTHORITY_VIOLATION`, `INFRA`) and by repeated concrete signature.
4. Pick the **highest-impact frequent causal cluster that is fixable in an open zone**. One experiment = one hypothesis = one causal change.
5. Run deterministic/focused tests first, then the smallest live development cohort that can falsify the hypothesis, then the full declared development cohort.
6. A candidate can KEEP only if architecture/authority guards stay green and it improves the declared primary metric or preserves it while improving declared secondary metrics, without a material regression on already-earned lower rungs. Track model/System2 cost: a candidate that merely buys success with unbounded model calls is not an automatic win.
7. Before the first portal possibility proof, use the smallest live sample that falsifies or supports the blocker fix; **do not burn a full holdout campaign merely to promote an intermediate checkpoint**. Holdouts remain evaluation-only and become mandatory for the portal reliability phase.
8. As soon as a blocker is sufficiently improved to expose later portal progress, **resume the end-to-end portal attempt** while retaining a small regression sample for the fixed behavior. Do not spend days polishing an intermediate checkpoint for tiny metric gains while the portal remains unachieved.

Core live metrics, when observable: verified task success, wall-clock time-to-success, mechanical actions/steps, deaths, damage/food/air emergencies, recovery success, stall count/duration, resource waste, replans, candidate refusals, Jev decisions/rejections, System2 invocation count/rate/token-or-cost proxy, model-unavailable events, and cross-seed/biome/novel-state failures. Prefer verified world predicates over log vibes.

### Test-surface discipline — capability first

This repository already has a large test surface. **Do not let capability work turn into test-suite growth for its own sake.** Tests exist to protect real capability and constitutional invariants; they are not the product.

- **Do not create a new test file by default.** New test files are exceptional and require a concrete observed failure that cannot be covered cleanly in an existing relevant test/scenario/fixture.
- Add regression coverage only for a **real reproduced bug or failure that the candidate actually fixes**, and only when deterministic coverage materially prevents recurrence.
- Prefer one minimal case in an existing relevant test, scenario registry entry, or fixture over a new bespoke harness, test family, or framework.
- Do not write broad speculative tests for hypothetical edge cases during capability campaigns. The architecture red-team phase is over.
- A live failure does **not** automatically require a unit test. Clean reproducible live evidence plus existing guards may be sufficient when that is the more faithful proof.
- Reuse existing clean-run, seed-cohort, experiment-result, scenario-registry, and package-test machinery. Do not build a second measurement framework unless a measured blocker proves the existing one insufficient.
- Track test files and test LOC added by each KEEP. If test/tooling surface starts growing faster than production capability value, **stop adding tests, consolidate duplicated coverage, and return effort to Minecraft behavior**.
- Spend the clear majority of productive campaign time on live Minecraft runs, failure clustering, production behavior fixes, recovery quality, holdout validation, and capability progression—not test authoring.
- Never weaken or delete constitutional/authority/proof coverage merely to reduce test count. Consolidation is allowed only when equivalent protection remains mechanically enforced.

A good capability KEEP should normally have a small proof footprint relative to the production behavior/evidence it protects. "More tests" is not a success metric; **better verified Minecraft capability with unchanged V4.1.2 safety is the metric.**

## 1B. Canonical unattended campaign program

This section makes the former long `/goal-mode` prompt durable. **A future goal prompt may be only `continue`.** In that case, do not treat the short prompt as a new underspecified task: read this `AGENTS.md`, `runs/capability-campaign/state.json`, git/process/world state, and referenced experiment records, then resume the next falsifiable campaign action.

Context compaction, a new Devin session, a subagent finishing, a status report, a commit, or one successful rung are **not completion**. Reload durable state and continue while useful in-constitution work exists.

### Campaign bootstrap / P0

At the beginning of a fresh unattended campaign or after a hard reset of campaign state:

1. Fetch first; confirm the working tree and exact `HEAD`/`origin/main` relationship. Never force-push or rewrite shared history.
2. Record campaign start time, start SHA, disk free space, active server/resident state, and model/provider availability **without printing secret values**.
3. Create or resume `runs/capability-campaign/state.json` and `STATUS.md`. They must identify at least: campaign id, `startedAt`, start/trusted/last-KEEP SHAs, current rung/status, task predicate, promotion criterion, dev seeds, holdout seeds, baseline/result refs, active failure clusters, falsified hypotheses, active experiment/worktree/processes, blocked/deferred lanes, and next actions.
4. Inspect and reuse current clean-run/live-run tooling, supervisor/watchdog, world-state tools, experiment-result schema, and existing capability evidence. Do not build a second framework unless a measured blocker proves the existing one insufficient.
5. Establish a reproducible capability-run protocol before tuning behavior. Live evidence must bind exact source SHA, world/seed, task predicate, run identity, and final verified outcome.
6. Isolate campaign worlds from sealed acceptance evidence and user worlds. Never let two mutating experiments own the same server/world concurrently.

### Portal-first evaluation, reliability, and promotion

Before the first verified portal entry, predeclare the **portal objective** and use wood/stone/iron/food/cave/smelting only as diagnostic checkpoint predicates. Holdout locations remain evaluation-only; never tune specifically against their coordinates or outcomes.

The campaign has four ordered phases:

1. **Possibility:** achieve one clean verified autonomous Nether portal entry as fast as practical. Intermediate checkpoints do not need `4/5` promotion. Fix the blocking failure, then rerun toward portal.
2. **Reliability:** after one portal success, run the declared dev+holdout portal cohort. When no stricter gate applies, robust portal promotion requires focused checks green, zero `AUTHORITY_VIOLATION`, at least **4/5 clean portal successes** including at least one holdout success when five trials are practical, no material regression, and no pathological System2/model-call increase.
3. **Speed:** after reliable portal success, optimize verified time-to-portal and efficiency without weakening reliability, safety, authority, or proof. Compare exact-SHA runs and keep slower-but-safer behavior unless the faster candidate preserves the declared reliability criterion.
4. **Generalize:** after portal behavior is reliable and reasonably efficient, test transfer to unseen seeds/terrain/state and to semantically equivalent goals phrased differently in natural language. Prefer end-to-end instruction-following trials where the requested outcome is supplied as user-style text and the agent must interpret, decompose, execute, recover, and report using the same generic capability stack. Generalization evidence must not rely on benchmark-specific route scripts, coordinate memorization, wording-specific branches, or architecture changes.

If run cost or infrastructure prevents five valid reliability trials, label confidence **LOW** and do not call portal capability robust. A single portal success proves possibility, not robustness.

The first frontier for a new campaign is therefore an **honest end-to-end portal-directed run from a clean start**. Wood is the first diagnostic checkpoint, not the campaign's terminal objective. Historical portal evidence from older architectures is a useful speed/capability reference but does not count as V4.1.2 proof. Measure current production behavior again whenever protocol/source meaningfully changes.

For failed runs, capture the **first causal failure**, not just the last error. Prioritize repeated clusters by frequency × severity × downstream blocking value, subject to the permanent architecture lock and open-zone rules. Do not keep polishing instrumentation once it answers the causal question well enough to run the next experiment.

### Measurement stop rule — gameplay must dominate

Measurement, cohort selection, observer work, and harness repair are support work, not the product. **Do not spend hours proving that a start coordinate or measurement fixture is perfect when a simple, honest fixture is already good enough to run Minecraft.**

- Time-box measurement/tooling setup. As a default, if a setup task has consumed roughly **15 minutes or 2–3 failed refinement iterations** without unlocking a new gameplay run, stop refining it, record the known limitation, and use the simplest trustworthy protocol that preserves provenance and safety.
- For a normal capability cohort, a start only needs to be an **ordinary playable start**, not exhaustively certified. Reject clearly invalid or pathological fixtures such as open water/ocean, lava, sealed/enclosed spawn, extreme lethal cliff/void exposure, or a spawn correction that immediately strands the bot.
- **Trees and canopy are expected Minecraft terrain, especially for wood acquisition. Do not reject forest, birch forest, taiga, dark forest, or another normal biome merely because trees/leaves exist.** A real traversal/access failure after a valid ordinary start is product evidence, not a reason to keep searching for an easier fixture.
- For the wood normal cohort, once **5 sufficiently separated, predeclared, ordinary playable starts** are available, freeze the cohort and start the sequential runs. Do not keep searching for a theoretically nicer biome mix, exhaustively scan every column/chunk, or repeatedly re-certify starts after the cohort is adequate.
- Prefer a quick surface/headroom/hazard sanity check plus one real spawn check over exhaustive canopy/chunk certification. Additional fixture proof requires a concrete observed contamination problem.
- When fixture/setup complexity begins dominating a work session, **stop infrastructure work and return to live gameplay, failure clustering, and production fixes**. Over a capability campaign, gameplay/evaluation time must clearly exceed measurement-framework time.
- Never discard a valid gameplay failure merely because a more convenient start could have been chosen. Normal terrain difficulty belongs in capability evidence; only fixture-invalid conditions belong in fixture filtering.

### Bounded experiment contract

For each selected failure cluster:

1. State one falsifiable hypothesis and the exact expected metric or failure-signature change.
2. Isolate risky candidates in a `cap-<rung>-<experiment>` branch/worktree based on an exact trusted SHA.
3. Add only the minimum deterministic regression needed for a **real reproduced failure**; obey the test-surface discipline above.
4. Make the smallest generic V4.1.2-conformant production change. No seed coordinates, benchmark route scripts, or hard-coded action sequences.
5. Run focused checks, touched-package typecheck, and applicable architecture/authority guards.
6. Commit the candidate before provenance-sensitive live evaluation so evidence binds an exact SHA.
7. Use progressive sampling: smallest dev run that can falsify -> full declared dev cohort -> holdout/promotion cohort.
8. If the hypothesis fails causally, REVERT/DEFER early rather than burning the full cohort.
9. KEEP only when declared capability evidence improves (or primary holds while a declared secondary materially improves), no new failure class/authority violation appears, and lower-rung regressions remain acceptable. Ambiguous/noisy results require more evidence, not guessing.
10. Before production-code integration: fetch, reconcile safely, inspect the diff, run the required focused/full gates and typecheck, then push a small coherent KEEP normally.
11. Update experiment records and campaign state, retire disposable worktrees when safe, and immediately continue to the next cluster/rung.

Verdicts mean:

- **KEEP** — causal evidence + declared metrics support the candidate; required guards are green.
- **REVERT** — regression, new failure class, worse verified success, unbounded retries/model use, or falsified hypothesis.
- **DEFER/ESCALATE** — frozen surface, constitutional impossibility, unavailable dependency, or exhausted bounded hypotheses. Preserve evidence and switch lanes; this does not authorize architecture change and does not require waiting for the operator.
- **INFRA** — only with evidence. Reproduce against a control/base when practical; infrastructure failures do not count as product wins or losses.

A candidate that wins by weakening verification, changing the task after baseline, using assists, hiding failures, or silently changing evidence semantics is an automatic REVERT.

### Long-run reliability / self-recovery

- Use bounded timeouts for tests, servers, probes, and live runs. A hung process is an infrastructure failure to diagnose, not a reason to wait forever.
- Reuse the resident supervisor/watchdog and clean-run process controls; do not invent unsafe process control when existing mechanisms suffice.
- Periodically check free disk, stale/zombie servers, worktree count, run-artifact growth, and port/world ownership.
- Preserve sealed accepted evidence and committed experiment records. Prune only disposable/reproducible artifacts after their causal summary is durable. Never delete user worlds or accepted VTR archives.
- On disk pressure, remove transient caches/build output/completed disposable worktrees/reproducible failed runs first and record what was removed.
- Capability-run retention is automatic: keep the newest **10 p-series versions** with full raw worlds/logs; for older completed failed `portal-p*` runs, preserve `plan.json`, `result.json`, `P-SERIES.md` provenance, `server.log`, a `retention-summary.json`, and gzip-compressed resident AI logs, then delete only the reproducible raw `server/` world. Never prune the active/incomplete run, an `OBJECTIVE_SATISFIED`/accepted run, a sealed archive, or a run carrying `.retention-protect`.
- On provider outage, record `MODEL_UNAVAILABLE`; do not add fallback authority or change semantics. Switch to mechanical, deterministic, observability, recovery, or provider-independent lanes until service returns.
- If run identity, source binding, server configuration, or world provenance becomes uncertain, invalidate the run and start clean. Never repair evidence by hand.

### Git/main health and time allocation

`main` represents validated KEEP checkpoints, not speculative candidates. Never reset away unrelated work, delete another lane's unmerged branch/worktree, amend pushed shared commits, or force-push. Push each validated coherent KEEP so a machine/session failure loses little work.

Spend the clear majority of productive time on **measured gameplay capability**. Campaign infrastructure/tooling should normally remain below roughly one quarter of productive effort unless a concrete blocker requires more. Prefer cheap deterministic reproduction before expensive live repetition. While long gates/runs execute, use only non-conflicting work for analysis or next-experiment preparation.

### Campaign memory / resume contract

Update `runs/capability-campaign/state.json` after each baseline cohort, candidate verdict, KEEP integration, rung promotion, and blocker/lane switch. Store evidence paths instead of giant pasted logs.

After a restart, durable state must make these questions answerable without chat memory:

- What exact SHA is trusted main, and what exact SHA did each live run boot?
- What rung/predicate/promotion criterion is active?
- Which seeds are dev vs holdout, and which outcomes have already influenced tuning?
- What is the current baseline distribution and best accepted candidate distribution?
- What are the top failure clusters, their counts/signatures, and already-falsified hypotheses?
- What candidate/worktree/process/world is active now?
- What was the last fully green KEEP SHA, and which earlier-rung regressions must be sampled next?
- Which lanes are blocked/deferred, and why?

If the goal/session says only `continue`, **reconcile AGENTS.md + state.json + git log/status + actual processes/world identity first, then resume the next falsifiable action. Do not ask the operator to restate the campaign.**

### Anti-gaming / anti-overfitting

- Never change a seed cohort after seeing candidate results merely to improve the score.
- Never count a run twice or discard a valid failed run because it is inconvenient.
- Never call a gameplay failure `INFRA` without evidence.
- Never make success easier by changing the predicate, acceptance criterion, world premise, or postcondition after baseline.
- Never encode known seed coordinates, block locations, benchmark action sequences, or the capability ladder as a giant production script.
- Never turn System2 into a continuous motor/planner loop; its sparse WHAT role remains constitutional.
- Never hide retries/stalls by resetting counters or minting a fresh transition without causal justification.
- Prefer improvements that generalize across seeds, biomes, target instances, partial states, and novel recovery situations.

### End-of-campaign condition

For a campaign explicitly requested to run for about seven days, use `state.json.startedAt` as the clock. Near the end, finish the current bounded experiment safely and integrate it only if it satisfies KEEP. Then write a durable final campaign report containing:

- campaign start/end time and start/final `origin/main` SHAs;
- every KEEP grouped by capability rung and measured causal failure;
- baseline vs final per-rung metrics, seed cohorts, sample sizes, confidence limits, and holdout results;
- capability frontier reached and the first unsolved rung;
- top remaining failure clusters and next falsifiable experiments;
- regressions found/fixed;
- Jev/System2 usage and cost trend where observable;
- reproducible run/evidence/result paths;
- infrastructure failures distinguished from product failures;
- confirmation that V4.1.2 remained untouched and architecture guards stayed green.

Do not stop early merely because one rung passes. Until the explicit campaign end condition or a genuine all-lanes blocker, completion of one slice means **continue**.

## 2. Role constitution

- **Jev** — the production-default fast System-One decision policy. Semantic/tactical decision **only**: choose/rank/score among grounded enabled Transitions and in-contract tactics. Jev does **not** own world truth, SUCCESS, the actuation lease, resource authority, or effect authorization. A Jev output is policy input that the kernel validates; it is never permission for a primitive call.
- **System2** — sparse synthesis, repair, and decomposition (graph/contract synthesis beyond the known graph, genuinely new causal hypotheses, long-horizon decomposition). System2 is **not** a live mechanics loop and emits no motor commands.
- **Kernel** — sole authority for lifecycle transitions, resource leases, effect commits, verified facts, revisions, budgets, Mission frontier, and journal sequencing. Canonicalizes and hashes contracts; callers never supply a trusted `contractHash`.
- **Transition Controllers** — persistent owners of one committed contract until VERIFY SUCCESS, typed terminal boundary, or contract invalidation. They request authority through KernelCommands; they do not mutate kernel state directly.
- **Viability Runtime** — parallel runtime for mission-crossing survival invariants (health, hunger, air, lethal threat). It SUSPENDs the same Transition, stabilizes, takes fresh facts, revalidates, and RESUMEs that same Transition — it never silently replaces the mission predicate.
- **Runtime Adapter / ActuationPort** — the only boundary where production mutation reaches the raw client.
- **VERIFY** — the sole authority that establishes SUCCESS. Only verified facts are authoritative; facts retain TRUE / FALSE / UNKNOWN.
- **HOST** — connection, generation identity, durable state, lease issuance, evidence. Not gameplay policy.

## 3. Mission / ATR lifecycle

Transition lifecycle states:

```text
ENABLED -> RUNNABLE -> ACTIVE <-> SUSPENDED
                     |     \-> OBSERVING
                     v
                  BLOCKED -> TERMINAL
```

- `ENABLED` — requires satisfied, not yet scheduled.
- `RUNNABLE` — committed candidate awaiting activation.
- `ACTIVE` — owns the contract; may dispatch permitted effects under current leases.
- `SUSPENDED` — safe-yielded for viability/preemption; resumable on the same contract.
- `OBSERVING` — dispatched effects awaiting reconciliation/verification.
- `BLOCKED` — typed failure/infeasibility inside the contract.
- `TERMINAL` — SUCCESS or typed terminal outcome, journaled and fenced.

Replayed or audited history can **never** be promoted into live authority. Crash ambiguity resolves to `UNKNOWN`; automatic re-execution of an ambiguous effect is forbidden.

## 4. Resource and effect authority

- Semantic ownership and **physical actuation/resource leases are separate**. Holding a contract does not imply holding a lease.
- `ResourceId` is **structured and hierarchical** (domain/path). Resource **bundles are atomic** — all claims in a bundle acquire or none do. Overlap/conflict rules are explicit and kernel-enforced.
- Every mutating call requires **all** of:
  - an `ACTIVE` transition with a current contract,
  - current world + dimension + epoch + generation binding,
  - a current lease covering the claimed resources,
  - an allowed effect permit.
- Irreversible effects use **kernel-owned single-use `EffectCommitToken`s**. A token is bound to transition, contract hash, generation, and effect; it cannot be replayed or reused.
- World, dimension, epoch, and generation **revisions fence** stale Jev decisions, leases, effect tokens, ResumeProofs, and preemption transactions. Nothing stale may act.
- Preemption uses the **safe-yield protocol**, bounded critical sections, multi-victim atomicity, and priority inheritance.

## 5. Mutation boundary

- All production mutation must cross the canonical **Runtime Adapter / ActuationPort** boundary.
- New raw `bot`, `_client`, pathfinder, entity, window, or plugin mutation bypasses are **prohibited**. Extend the adapter/inventory instead.
- VTR core (Mission, World Model, Graph, Scheduler, Controllers, Viability, Jev, System2) must not receive, retain, import, or call a raw Mineflayer `Bot` or backend-specific live client.
- HOST may own the raw client for lifecycle/lease/adapter wiring only; it must not perform semantic/mechanical actions outside the adapter.

## 6. Migration/cutover status — CLOSED

The V4.1.2 migration, authority cutover, adversarial closure, and proof hardening are **complete historical work**. The validated architectural checkpoint is `092a5b38`; the permanent lock is defined at the top of this file.

- Kernel authority is production authority; old SHADOW-only/cutover instructions are not active work.
- Reach Phase-0/deletion/evidence lineage remains preserved as proof history, not as the next milestone.
- Sealed VTR evidence archives and their validators remain protected evidence infrastructure.
- Do not reopen migration, dual-authority, or successor-architecture projects. If a capability run exposes a correctness bug, fix it inside V4.1.2 or record a permanent known limitation.

## 7. Capability evidence rules

Capability claims require real task evidence, not architecture evidence. Architecture guards prove constitutional preservation; they do **not** prove the bot is good at Minecraft.

For capability work:

- prefer clean, reproducible, exact-SHA live runs on predeclared seed cohorts;
- keep fixture/mechanical probes separate from autonomous task success;
- never count assisted worlds, seeded inventory, teleporting, setblock scaffolds, or manual intervention as autonomous capability;
- compare candidates against a same-protocol baseline and preserve run identity/source/seed provenance;
- retain earlier-rung regression checks as the ladder advances;
- treat `AUTHORITY_VIOLATION` as an automatic candidate rejection, never as a performance tradeoff.

### Measurement protocol v2 — sequential single-world cohorts (2026-09-27)

Ordinary capability cohorts are **sequential and single-world**:

- **Max one live mutating capability server at a time.** `tools/capability-run.mjs` enforces this via `runs/capability-campaign/active-run.json` + a process-table guard; `--allow-concurrent` is an explicit override only.
- **One canonical seed/world family** (declared in `state.json`) with a **predeclared coordinate cohort** (`runs/capability-campaign/cohort-v2.json`, generated by `tools/cohort-scan.mjs`). Coordinates are chosen before candidate results, separated far enough that one trial's mutations cannot contaminate another, and never cherry-picked after seeing performance.
- **Start placement is fixture setup, not capability**: `--start x,y,z` is applied via `setworldspawn` + `spawnRadius 0` after level prepare and before resident join — before the measured clock/run authority. No operator assists after the run begins.
- Exact-state comparisons regenerate a fresh world from the canonical seed per run; the server does not persist between cohort runs.
- The **normal cohort** excludes ocean-only starts, extreme mountain/cliff traps, deep caves, tiny islands. Pathological terrain lives in a separately named **stress cohort**, never in the normal promotion denominator.
- **Protocol versions are evidence labels**: v1 = per-run fresh seeds, parallel worlds (pre-2026-09-27 results); v2 = canonical seed + declared start coordinate, sequential. Never mix v1 results into a v2 denominator.
- Canonical observer: `http://127.0.0.1:4173/api/ai-summary` (`tools/buddy-observer.mjs`, registry mode) follows `active-run.json` across sequential turnovers; HTTP 200 with `available=false` + `no_active_campaign_run` when idle. Read-only.

## 8. Legacy/evidence lineage

The accepted Reach and clean-run evidence described in `docs/history/` and `docs/development/P8-CLOSURE-REPORT.md` is historical proof infrastructure. Preserve sealed artifacts and provenance. Historical baseline tricks, legacy authority paths, migration selectors, and shadow-mode instructions are **not** templates for new capability code.

## 9. Development rules

- Every new code change or review must state **how it conforms to V4.1.2**. Do not regress toward Option/Jev-π/β authority, GoalQueue-as-truth, or benchmark-shaped production policy.
- New authority enters only through `KernelCommand`s. New intelligence enters through Jev decision policy, scheduler/routing, Verified World Model estimation, controller in-contract tactics, or sparse System2 — never a new cross-layer authority path.
- Compatibility adapters must name the authoritative side and a deletion condition. Do not add a second mutable semantic source of truth.
- Prefer deleting an authority crossing over adding retry/cooldown/fence around it.
- Never silently fall back to deterministic semantics when Jev/System2 is unavailable; use explicit typed policy-unavailable paths or explicitly configured test/offline policy.
- Do not weaken verification or evidence gates to make success easier. `action done` is not Transition SUCCESS.
- Preserve fail-closed effect boundaries for irreversible world mutation.

## 10. Work classification

Classify active capability work into exactly one bucket:

- **A. CAPABILITY_CRITICAL** — directly improves or measures the lowest unsolved capability rung or a regression on an already-earned rung.
- **B. CAPABILITY_CORRECTNESS** — in-constitution truth, mechanics, controller, recovery, lifecycle-use, durability, provenance, or verification bugs that invalidate capability results.
- **C. MEASUREMENT_PROOF** — deterministic scenarios, live probes, seed cohorts, result records, comparators, observability, and regression tests needed to trust A/B.
- **D. CAMPAIGN_INFRA** — bounded work that keeps unattended experimentation running: watchdogs, resumable state, run cleanup, disk recovery, flaky-test isolation, reproducibility tooling.
- **E. DEFER** — architecture work (forbidden), cosmetic cleanup, unrelated refactors, speculative features without a measured failure, or micro-optimization on a solved rung while a later rung is blocked.

Prefer A/B/C. D is justified only when it removes a real campaign blocker. Never convert E into work merely because the primary experiment is difficult.

## 11. Testing and proof hierarchy

For each migrated Transition family require, as applicable:

1. pure contract/state-machine tests
2. deterministic mechanical fixture
3. no-LLM live probe for CAN/HOW/DONE
4. integration test through the real VTR scheduler/runtime
5. legacy-vs-VTR double-authority exclusion
6. stale world/epoch/lease/generation-fencing tests
7. target/witness substitution tests
8. progress and budget exhaustion tests
9. provider-outage test when model independence is claimed
10. fresh exact-source live evidence

A capability probe PASS proves mechanics only. It does not prove autonomous composition.
A benchmark PASS proves an end-to-end outcome only. It does not prove architectural generality.
A green shadow journal proves observation coverage only. It does not grant authority.

## 12. Capability improvement loop

For autonomous capability work, use this loop:

```text
clean origin/main + exact base SHA
-> select the lowest unsolved rung / highest-severity regression
-> predeclare task predicate + metrics + dev/holdout seeds
-> establish or load same-protocol baseline
-> cluster first causal failures
-> choose one open-zone hypothesis
-> deterministic/focused regression first
-> implement the smallest generic V4.1.2-conformant change
-> architecture/authority guards + focused tests
-> development-seed live cohort
-> compare against baseline
-> REVERT, DEFER/ESCALATE-and-switch-lane, or KEEP
-> holdout cohort for promising KEEP
-> small coherent commit + push
-> retain lower-rung regression sample
-> next failure cluster or next rung
```

Do not shotgun speculative fixes into one run. Do not infer success from movement or plausible logs: name the verified predicate that changed. A lucky single-seed run is evidence of possibility, not robustness.

## 13. Runtime evidence to inspect

At minimum, make it possible to answer:

- active Mission predicate frontier
- active Transition type / instance / contract hash
- `requires` and `ensures`
- controller-local progress
- temporary target/witness changes
- resource/risk budget consumption
- viability interruptions and resume/re-evaluation
- deterministic postcondition verification
- terminal outcome and reason
- world/dimension/epoch/generation identity
- model calls and why they were necessary
- any legacy Option/GoalQueue/Jev π/β authority participation, separately from kernel-admitted Jev decision frames
- whether two authority paths could actuate simultaneously
- shadow counters: `mutationsObserved`, `mutationsMapped`, `mutationsAttributedToTransition`, `mutationsUnguarded`, `kernelDenied`, blockers, `coverageComplete`

Model calls per verified Transition and mechanical steps per model call are important measurements.

## 14. Parallel work / subagents

Use subagents and independent disposable worktrees aggressively when they increase throughput, especially during unattended campaigns. **Subagents are an explicit default throughput tool, not an optional afterthought.** When a task naturally decomposes into independent investigation, implementation, test/evidence, or audit lanes, launch subagents proactively instead of doing every lane serially.

- **Use up to 3 subagents concurrently and actively aim for 2–3-way parallelism when there are 2–3 genuinely independent useful lanes.** Do not create filler work merely to reach three; a tiny single-lane quick fix should stay single-lane.
- The parent agent remains the integrator/decision owner: assign each subagent a narrow non-overlapping question or artifact, keep one mutation owner per subsystem, collect results promptly, reconcile conflicts personally, and land only the validated causal change.
- Prefer subagents for work that can proceed while Minecraft/live tests accumulate evidence: log/root-cause analysis, independent code-path audit, focused test/proof review, alternative generic hypotheses, or preparation of the next non-conflicting fix.
- Never idle waiting for a subagent if another useful non-conflicting lane exists. Check completed/available subagent results opportunistically; do not replace parallelism with long `sleep`, `wait`, or blocking tool calls.

Rules:

- one mutation owner per subsystem/experiment;
- do not give multiple agents the same implementation; independent audits and alternate hypotheses are fine;
- keep `main` clean; prefer disposable `cap-*` worktrees for risky candidates and integrate only validated KEEP results;
- while long live runs/tests execute, continue a separate non-conflicting useful lane (analysis, fixture, observability, next failure cluster, docs/result synthesis);
- personally reconcile subagent findings before landing code;
- never reset/overwrite concurrent worktrees or another lane's unmerged work;
- retire stale disposable worktrees after preserving results; do not let week-long operation exhaust disk.

Good parallel capability lanes include:

- A. current-rung baseline/holdout live execution and metrics
- B. failure-cluster/root-cause analysis from completed runs
- C. focused mechanical/controller candidate in a disposable worktree
- D. regression/scenario additions for the observed failure
- E. Jev ranking/projection quality inside grounded candidates
- F. sparse System2 quality/cost and provider-failure behavior
- G. recovery/viability robustness
- H. reproducibility/clean-run/campaign watchdog and disk hygiene

Never create an architecture-design lane.

## 15. Issues, commits, and integration

Do not create one issue/PR per tiny symptom. A durable issue is justified by a repeated causal failure cluster, a capability acceptance criterion, a reproducibility blocker, or a correctness defect that spans experiments.

For unattended work, do not wait for PR review when the campaign explicitly authorizes direct integration. A KEEP checkpoint may be committed and pushed to `main` after required tests/evidence are green, the diff is reviewed, `origin/main` integration is safe, and the commit is small/coherent. Never force-push.

Commit messages and experiment records should name: rung/scenario, hypothesis or failure cluster, result/verdict, and the relevant evidence path. REVERT/ESCALATE candidates should normally remain out of main; preserve only their result record/root-cause evidence when useful.

## 16. Long-horizon capability and M3

M3 (`ender_eye >= 12` under its canonical run-scoped gate) is a valuable long-horizon composition test, but it is **one capability benchmark, not the project architecture and not the only objective**. Use the capability ladder to expose missing mechanics and policy weaknesses earlier and more cheaply.

A fresh M3 PASS matters only when it comes from an honest clean-run premise with production V4.1.2 authority visible in the artifact. Continue changed-seed, partial-start, benchmark-absent, and unsupported-predicate testing before calling a behavior robust. Do not optimize production policy around the expected M3 route or hard-code a speedrun script.

## 17. Explicit anti-goals

Do NOT solve migration by:

- renaming Option to Transition while keeping the same per-action control loop;
- wrapping GoalQueue in another canonical ledger;
- making β smarter instead of removing generic model-owned termination;
- ending/recommitting the active Transition and bouncing every tactical recovery to a new Jev authority epoch merely because it is "semantic" — bounded Jev consultation inside the same controller contract is allowed;
- creating a giant deterministic benchmark planner;
- moving the legacy mega-controller into smaller files without changing causal ownership;
- increasing candidate count/model context as a substitute for controller closure;
- adding unbounded retries or arbitrary N-failure policy switches;
- weakening Guard/VERIFY/evidence to get a green run;
- treating shadow-observer replay as live authority;
- keeping both old and new authority indefinitely.

## 18. Turn/work-session discipline and autonomy

At the start of a substantial task, form concrete TODOs covering as many of audit, implementation, tests, probes/live validation, integration and deletion as the task allows.
Do not end merely because a plan was written, an issue was filed, a subagent was launched, one interface was added, or one local test passed. A status report is not completion. If the requested goal is still unmet and useful work is available, continue.

Work autonomously toward the requested goal. Do not wait for step-by-step permission for ordinary investigation, code edits, tests, live runs, log/evidence audits, issue triage, branch/worktree maintenance, necessary restarts/configuration changes, or other reversible engineering work that is causally useful to the goal. Preserve concurrent work and do not overwrite another lane's unmerged changes.

Also pursue indirect but useful work when it materially increases the probability or speed of reaching the goal: observability/probe tooling, generic refactors that unblock the slice, repository/GitHub hygiene, workspace cleanup, evidence tooling, model/policy investigation, and disk-space/ENOSPC recovery are legitimate work. Do not use "indirect progress" as an excuse for unrelated cleanup while a clearer causal blocker is available.

Architecture autonomy is narrower: the V4.1.2 authority constitution is **permanently locked** (see PERMANENT ARCHITECTURE LOCK). Routine implementation and policy evolution may proceed autonomously inside it, but changing the contract/ownership/verification constitution itself is categorically forbidden — not merely gated on evidence. No evidence, defect, or result can authorize it; an unfixable-by-constitution defect is a permanent known limitation, worked around at the capability/policy/mechanic/observability layer.

Continue until the current requested milestone is actually proven, or until an external blocker makes further useful work impossible. If blocked, leave exact evidence and the next falsifiable experiment.

The current and permanent milestone family is **measurable Minecraft capability**. Start at the lowest rung without a robust current baseline (initially wood acquisition), improve one measured causal failure cluster at a time, retain regression coverage, and advance toward End. Architecture/migration work is not a fallback task when capability work is hard.

When a capability slice is proven KEEP, land it as a small validated checkpoint, preserve its experiment evidence, and immediately continue to the next highest-value failure cluster or ladder rung. During unattended campaigns, completion of one slice is a trigger to continue, not to wait for an operator.
