# AGENTS.md — V4.1.2 Single-Agent Capability Constitution

## 0. Mission and precedence

Build one general Minecraft agent that autonomously drives **verified world-state transitions** for long periods without human gameplay assistance and ultimately reaches the End across unseen worlds/states/instructions.

Until first success, the campaign objective is the **FIRST CLEAN VERIFIED AUTONOMOUS NETHER ENTRY**. Everything else is subordinate to that objective.

Precedence, highest first:
1. live server/world truth and current source;
2. V4.1.2 Kernel/architecture contracts;
3. this file;
4. deterministic tests/probes/exact-run evidence;
5. campaign history/issues/docs.

If this file conflicts with current V4.1.2 implementation/contracts, repair this file; never bend runtime truth to documentation.

## 1. Permanent architecture lock

**V4.1.2 Concurrent Verified Transition Runtime is permanent.** Validated checkpoint: `092a5b38`. Canonical contracts: `packages/kernel/kernel.ts`, `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md`, and `docs/architecture/v4.1/{V4.1.2-HARDENING,INVARIANTS,KERNEL-EVENTS}.md`.

Never create or revive V4.1.3/V4.2/V5, alternate terminalization, shadow/fallback authority, second SUCCESS owner, selector architecture, architecture tournament, or a parallel semantic authority path.

The sole production authority path is:
`proposal -> typed KernelCommand -> applyKernelCommand(KernelState, command) -> KernelState + KernelEvent[] -> transition-scoped adapter capability -> Mineflayer/server effect`.

Fixed ownership:
- **Jev:** tactical/semantic WHICH/WHETHER among grounded enabled choices.
- **System2:** sparse WHAT synthesis, repair, decomposition, and causal hypotheses.
- **Kernel:** sole lifecycle/resource/effect/trusted-fact/revision/budget/Mission/journal/SUCCESS authority.
- **Transition Controller:** realizes one admitted transition until VERIFY success, typed terminal, or invalidation.
- **Viability Runtime:** suspend/stabilize/revalidate/resume without silently replacing mission intent.
- **Runtime Adapter / ActuationPort:** sole production mutation boundary.
- **VERIFY:** sole SUCCESS authority; trusted truth is TRUE/FALSE/UNKNOWN.
- **HOST:** connection/generation/durable-state/evidence owner, not gameplay policy.

Lifecycle remains `ENABLED -> RUNNABLE -> ACTIVE <-> SUSPENDED`, with observing/blocked/terminal states governed by the Kernel. Crash ambiguity becomes UNKNOWN.

## 2. Project-scoped blanket authorization

This repository/campaign is **pre-authorized for unattended engineering execution**. Routine project work must not stop for operator approval.

Do not ask for confirmation before ordinary repository/campaign actions. Do not choose a slower path merely because a direct project-scoped action changes state. When a technically valid next action is known, take it and continue.

The following are pre-approved when they serve this repository/campaign:
- inspect project files, run artifacts, logs, local campaign config, processes, databases, services, and temporary artifacts;
- create/edit/rename/remove project files, generated artifacts, caches, fixtures, disposable worktrees, and campaign-owned test state;
- run shell commands, tests, builds, compilers, linters, formatters, migrations, diagnostics, package managers, and repository tooling;
- install/update/remove project dependencies and ordinary development tooling required by the campaign;
- update project-local hooks/config, goal-mode state, campaign tooling, local process wiring, and user-level services used by this campaign;
- start/stop/restart/reload campaign-owned servers, residents, supervisors, observers, test processes, and Devin sessions;
- create/remove branches/worktrees and perform normal fetch/rebase/cherry-pick/merge/commit/push flows for validated KEEP work;
- repair stale campaign registry/state/provenance after exact identity checks;
- run fresh experiments, major rollovers, and same-world minor reloads when required by the experiment contract.

Use exact identity checks, focused tests, backups where useful, reversible commits, and provenance to manage engineering risk. **Do not convert engineering caution into an approval request.**

Ask the operator only when progress truly requires information unavailable to the agent, such as a missing external credential or genuinely ambiguous product intent. Continue every independent useful task while such a dependency exists.

Project-integrity invariants still apply: no cheating/benchmaxxing evidence, no frozen-architecture ownership change, no unrelated user-data mutation, no loss of sealed evidence, and no fabricated/weakened VERIFY or provenance.

## 3. One-agent execution model

The campaign uses **one lead agent only**. Project config keeps `subagents_enabled=false`.

Never spawn, resume, read, poll, or wait for subagents/sidekicks. The lead agent owns the whole causal chain:
`live evidence -> diagnosis -> code inspection -> implementation -> focused proof -> commit -> integration -> reload -> first fresh evidence -> next blocker`.

Allowed concurrency is mechanical only: background tests/builds/probes may run while the same lead agent continues useful work. There is one reasoning owner and one mutation owner.

If several tasks are useful, execute them sequentially by **Mission leverage**.

## 4. Mission scoreboard: capability only counts when it converts

Diagnostic frontier:
`wood -> stone tools -> iron -> survival/food -> smelting -> diamond/obsidian -> portal -> Nether -> blaze/pearls -> stronghold -> End`.

This is diagnostic decomposition, not a scripted route.

Every minor records one `campaignDelta`:
- `ADVANCE`: new verified high-water frontier;
- `RETENTION`: same frontier is materially preserved better while continuing forward;
- `RECOVERY`: previous frontier is materially regained faster/cheaper after loss;
- `LOCAL_ONLY`: local capability improved without frontier/retention/recovery gain;
- `REGRESSION`: mission capability worsened.

Tests passing, a marker disappearing, or one mechanic succeeding remains `LOCAL_ONLY` until it converts into Mission behavior.

Track **high-water** separately from **current rung**. Death/reset never erases high-water. Returning to wood after iron creates **recovery debt**; while debt exists, restoring the frontier is primary. Never infer attainment from a rung label alone: a runtime `rung=X` may name the **first unsatisfied** rung. Count a frontier only from verified inventory/postcondition/VERIFY evidence and the current runtime contract.

Primary scoreboard:
- high-water/current gap;
- time/actions to first reach and re-reach frontier;
- deaths/resets before conversion;
- retained inventory/tool/station progress;
- portal construction/light/entry state;
- verified Nether entry.

Commit count, test count, minor count, lines changed, or local mechanism sophistication are not progress metrics.

After **3 consecutive `LOCAL_ONLY` KEEP minors**, conversion failure itself becomes the primary blocker. A fourth local minor requires a direct live-evidence link to `ADVANCE`, `RETENTION`, or `RECOVERY`.

**Conversion debt is measured from the last source-bound Mission delta, not from minor labels.** `ARMED`, `PENDING`, test-only, observability-only, signature-only confirmation, or a verified local action that does not improve frontier/retention/recovery does **not** reset the debt. Splitting one causal cluster across follow-up commits/minors does not reset it either.

While recovery debt is open, default work is re-attainment. A code change must either directly improve the current recovery path or be required to make that path's evidence trustworthy. Log dedupe, fixture polish, broad refactor, and unrelated correctness cleanup are `E DEFER` unless they are themselves blocking diagnosis/provenance.

After **3 source-changing non-converting fixes** since the last `ADVANCE`/`RETENTION`/`RECOVERY`, stop patching and perform a Mission conversion checkpoint before any fourth gameplay change. Record current high-water/current state, deaths since the last Mission delta, verification debt, and why the same world is more informative than a fresh major. Same-world continuation requires one explicit frontier-conversion hypothesis and one bounded falsification window. If that window closes without a Mission delta, seal/roll unless fresh causal evidence establishes a new reason that this exact world state is uniquely informative.

### 4.1 Survival is an affordance set, not a RETREAT button

Reason about survival at the **affordance-class** level. A typed failure such as `no_grounded_escape`, `path_stuck`, or `no_safe_step` proves only that one class of action is unavailable; it does **not** prove that the body has no survivable action.

Before declaring `CAPABILITY_LOST`, accepting a bare-hand combat loop, or repeatedly respawning into the same threat, inspect grounded options across the capabilities already present in V4.1.2:
- **locomotion escape:** retreat, step, wade, climb, alternate grounded route, known-safe route;
- **vertical escape:** jump/ascent/pillar or other verified height gain that breaks contact;
- **terrain shaping:** mine/burrow/descend, create headroom, place footing, wall, closure, roof, bridge, or other bounded geometry that changes reachability;
- **defensible positioning:** use terrain/choke/obstacle/distance so the threat cannot maintain damaging contact;
- **combat:** only when grounded evidence says fighting is more survivable than disengagement or world modification;
- **temporal avoidance:** sleep/time-skipping when the capability and resources are actually grounded. Add a new bed/sleep surface only when live evidence shows hostile phase itself remains the earliest blocker after existing affordances are exhausted.

This is **not** a scripted priority route. The agent chooses among grounded affordance classes from current facts. The invariant is that **world modification is a first-class survival action**. In Minecraft, inability to walk away is not equivalent to inability to escape.

Prefer composition of already-proven primitives before adding a new executor surface. If `MINE`, `PLACE`, `DESCEND`, `PILLAR_UP`, footing placement, headroom acquisition, or local water locomotion can solve the state, reuse them under the existing authority path instead of inventing a parallel survival mechanism.

### 4.2 Repeated death is a strategic failure, not more sample size

A death/reset is evidence about `RETENTION` and `RECOVERY`, not merely another mechanical outcome. Two deaths with the same causal fingerprint (same local threat class/context, same missing affordance, same effective response, no material intervening change) decide the hypothesis. **Do not treat a third unchanged death as useful evidence.**

The runtime may physically respawn, but the engineering loop must immediately change strategy, implement the smallest causal fix, or explicitly seal/roll the episode. A spawn-camp or recovery trap outranks ordinary resource progression until the body reaches a stable survivable state.

After a frontier loss, first establish survival, then repay recovery debt. Do not repeatedly rebuild resources into a state that is predictably killed before conversion.

Cumulative death pressure matters even when individual fingerprints differ. **Three additional deaths without a source-bound Mission delta force the same conversion checkpoint before another gameplay minor.** Source reloads, new minor numbers, or different mob names do not reset that count. If accumulated world scars (death-zone unions, shafts/tunnels, abandoned stations/drops, hostile clustering caused by the episode) dominate candidate generation, treat the episode state itself as a confound: prefer a fresh major unless the next hypothesis explicitly needs those scars to be falsifiable.

## 5. P-series: one causal defect at a time

`portal-pN` = major episode. `pN.x` = same-world narrow causal hot iteration. Keep `runs/capability-campaign/P-SERIES.md` append-only, machine state in `state.json.portalAttempts`, and immutable run evidence.

Use `pN+1` for materially new experiment premises, fresh-world requirements, broad/non-quick causal changes, or clean exact-SHA end-to-end proof.

Use `pN.x` for **one causal production defect** while preserving the same major world/server/player/connection/durable state whenever possible.

A minor ends when the hypothesis is decided, not when a timer expires. **10–15 minutes is a hard ceiling for unchanged-fingerprint dwell, never a target.**

Exit rules:
- one decisive typed mechanical/VERIFY/authority failure is enough;
- two identical post-change failures with unchanged causal facts are enough;
- three unchanged `WAIT`/`ESCALATE`/System2/no-progress cycles on one state fingerprint are churn; **there is no fourth**;
- once the next defect is exposed, close/stamp the current minor and open the next immediately;
- once a narrow fix path is known, drive focused proof + exact commit + fresh live evidence in the same work batch when mechanically possible.

A guard that only reduces reachable state is `SAFETY_GUARD/PARTIAL`, not solved capability.

### 5.1 Verification debt and lane closure

An `ARMED`/unmeasured fix is **verification debt**, not a second active blocker. Keep exactly one current causal blocker. When live state moves on, stamp the old fix `ARMED` or `DEFERRED` with its falsification signature and continue the Mission; do not keep re-reading or re-chasing it by elapsed time. Never promote an armed fix to `CONFIRMED` without source-bound fresh evidence.

Do not accumulate a stack of unmeasured patches and call it progress. Before opening a **third consecutive unconfirmed minor**, perform one conversion checkpoint: either (a) fresh live truth now exercises an older fix, (b) the scene has moved on and the older fix is explicitly deferred while the new earliest blocker is pursued, or (c) same-world information value is genuinely lower and the major is honestly sealed/rolled. Do not roll merely to manufacture a rare old recurrence.

Once the causal defect and owning lane are known, read required governance/issue routing **once for that lane**. Do not repeatedly re-read unchanged routing, issue text, or architecture docs between edit/test steps. Re-open them only if scope/ownership actually changes or a contradiction appears.

Apply **causal compression**. If 3 consecutive code-changing minors touch the same owning subsystem/invariant while the Mission state does not convert, treat them as one unresolved causal cluster rather than three successes. Before another patch, state the violated cross-layer invariant and either fix that invariant at its ownership boundary or make the major-episode decision. Do not indefinitely discover one more local exception in the same lane.

Before opening a new capability surface, perform a **capability-reuse check**: search the current runtime for already-verified primitives that can be composed to satisfy the missing affordance. Repeated campaign history has shown that local primitives often exist while the semantic layer fails to present them in the context where they matter. That presentation/composition gap is usually a smaller and more general defect than implementing another bespoke mechanic.

Treat cross-layer contradictions as high-value defects. Examples: sensing says an escape is impossible while live geometry supports one; a goal needs a resource while scaffolding consumes it; a critical survival trigger arrives while a grounded answer is in flight; a source change is evaluated using an older source's verdict. Resolve the contradiction at the narrowest ownership boundary rather than compensating downstream.

Decision triggers must follow **meaningful state-boundary crossings**, not only object birth or periodic heartbeats. If a hostile moves from outside to inside reaction range, health crosses a critical band, breathable space disappears, or another safety predicate becomes newly true, that crossing is new evidence and may require immediate re-evaluation. Conversely, a critical trigger must not erase an already-grounded survivable answer merely because it arrived mid-action; re-ground or preserve it under normal lease/generation rules.

## 6. Portal-first experiment policy

Until first verified Nether entry, optimize the **longest honest portal-directed attempt**.

Phases:
1. **Possibility:** first clean autonomous exact-provenance Nether entry.
2. **Reliability:** declared dev+holdout cohort; default practical target >=4/5 clean successes including >=1 holdout.
3. **Speed:** reduce verified time/actions/deaths/stalls/cost without sacrificing correctness.
4. **Generalize:** unseen seeds/terrain/partial states/semantically equivalent instructions with the same generic mechanics.

Experiment contract:
1. predeclare predicate/metric/cohort before tuning;
2. establish exact-SHA baseline when comparison matters;
3. cluster **first causal failures**, not downstream noise;
4. pick the highest-impact open causal cluster;
5. one hypothesis -> one causal change -> one expected signature;
6. run minimum focused deterministic proof, then the smallest live sample that can falsify;
7. KEEP/REVERT/DEFER immediately on evidence;
8. commit before provenance-sensitive live evaluation.

Useful typed clusters include `GROUNDING_REFUSAL`, `VERIFY_FAIL`, `LEASE_DENY`, `STALE_FENCE`, `BUDGET_EXHAUST`, `MODEL_UNAVAILABLE`, `MECHANICAL_FAIL`, `NO_PROGRESS`, `AUTHORITY_VIOLATION`, `INFRA`.

## 7. Anti-benchmaxxing

Forbidden: seed coordinates, memorized resource locations, p-specific action sequences, fixture-specific branches, benchmark wording hacks, hidden task selectors, giant scripted ladders, cohort changes after outcomes, discarded valid failures, weakened predicates/VERIFY, or identity resets that hide retries.

Improvements must come from reusable mechanics, verified world-state reasoning, prerequisite/resource accounting, navigation, survival/recovery, planning/decomposition, interaction mechanics, or instruction interpretation.

## 8. Live runtime, hot reload, and provenance

Production live worktrees must be clean. Never dirty-edit the resident worktree. Implement/test elsewhere, commit exact SHA, move live worktree to that SHA, then reload.

Canonical reload:
`build -> import -> structural smoke -> quiesce old -> atomic generation/lease commit -> start new -> dispose old`.

Require exact new `sourceSha`/hash/generation evidence and `reconnects=0`. Restart HOST only for real host/contract/schema need or unhealthy/dead resident.

Fresh code requires fresh evidence. Same-SHA restart may retain durable failure memory; older-SHA source-dependent retirement/failure may not suppress evaluation of changed code.

Provenance binds major `runId`, `activeMinor`/`segmentId`, `generationSourceSha`, build hash, generation id, world/server identity, runtime PIDs, reload/restart boundary, reconnect count, and `hostBootSha` separately from generation SHA.

`active-run.json`, `state.json`, observer, P-SERIES, and live generation must agree. If provenance is uncertain, evidence is UNKNOWN until identity is reconciled. **Known registry/state drift may not survive into the next minor or source reload.** Repair stale run/minor/source ownership in the same bookkeeping batch once discovered; do not let `state.json` or `active-run.json` trail multiple accepted generations and then reconstruct final proof from memory.

## 9. No idle, no polling, no approval stalls

Time passes as a side effect of useful work.

Status/audit requests are read-only by intent: observe without mutating lifecycle, world, inventory, or generation. Inspect unfamiliar helper source/`--help` before using it for status.

Forbidden campaign behavior:
- `sleep`, timer loops, delay loops, timeout-as-delay;
- blocking command observation;
- repeated unchanged heartbeat/log/process/status polling;
- waiting for a background process when another useful action exists;
- ending a turn after one observation/search/tiny edit/status;
- watching a live run after its causal hypothesis is already decided;
- asking for routine project authorization.

Long commands/tests/runs may stay background; inspect them only at natural work boundaries with non-blocking snapshots.

If live evidence is unchanged, switch **in the same turn** to root cause, code inspection, focused test, provenance repair, or the next Mission-leverage task.

Repeated physical outcomes are subject to the same rule. Do not watch additional deaths, path failures, pickup failures, or combat contacts after the causal fingerprint is already decided. Count **new causal information**, not event volume.

### 9.1 Unattended tool/session liveness

Treat the engineering toolchain itself as a bounded resource. Inspection commands must be finite and non-interactive; prefer small single-purpose reads/searches over giant compound pipelines, and give naturally long tests/builds an explicit bounded execution path when available.

A terminal/tool UI that still says `Running` is **not evidence that useful work is running**. If the OS child for a normally short command is already gone, or a normally sub-minute command has had no child/output/state change for several minutes, classify it as `DEVIN_TOOL_STALE` rather than waiting. If control is available, cancel that stale tool **once** and resume from durable evidence; do not rerun the whole discovery batch just to recreate context. Legitimate long tests/runs are distinguished by a live child process, CPU/output/progress, or an explicit background contract.

An explicit model/API usage limit is `MODEL_RATE_LIMITED`, **not** `DEVIN_TOOL_STALE`. Preserve WIP and the live Minecraft campaign, record the provider's reset/retry time when supplied, and back off until that boundary. Do not repeatedly restart Devin during the same rate-limit window and do not silently switch to a different/paid model merely to bypass the limit. When the boundary passes, retry the existing session once; only use ordinary stale-tool recovery if the post-limit session itself becomes stale.

A Devin/session restart is an infrastructure boundary, not permission to discard WIP or restart reasoning from zero. Preserve dirty files, read `git diff` before editing, and continue the same causal batch unless fresh live truth invalidates it. Never reset or overwrite surviving WIP merely because the previous UI died.

Maintain `/home/s0u7a/.config/devin/mc-ai-handoff.md` as a **non-authoritative crash note** containing: current run + exact source, verified high-water/current debt, current causal hypothesis, dirty files, last completed proof step, and the next concrete action. Update it when a causal defect becomes decided, before a naturally long/risky tool step, and after commit/reload. On restart read it after git status, then reconcile against live truth. Live process/world/source evidence always overrides the note.

## 10. Kernel/resource/mutation invariants

Semantic transition ownership and physical resource/actuation leases are separate. `ResourceId` is structured/hierarchical and bundles acquire atomically. Every mutation requires current ACTIVE contract, current world/dimension/epoch/generation binding, covering current lease, and allowed effect permit. Irreversible effects require kernel-owned single-use `EffectCommitToken` bound to transition/contract hash/generation/effect.

World/dimension/epoch/generation revisions fence stale Jev/System2 decisions, leases, tokens, ResumeProofs, and preemption transactions.

Active-goal resources are protected resources. Generic route/scaffold/support actions may consume a goal-relevant resource class only from **verified surplus above the protected requirement**. Protection is class/alias based (for example semantically equivalent log species), not item-name hacks or seed-specific rules.

All production mutation crosses Runtime Adapter/ActuationPort. Core semantic components must not retain raw Mineflayer mutation authority.

`action done` != SUCCESS. Only VERIFY establishes SUCCESS.

## 11. Testing and proof discipline

Proof ladder when applicable:
`contract/state-machine -> deterministic mechanical fixture -> no-LLM live probe -> scheduler/runtime integration -> stale-fence/authority exclusion -> fresh exact-source live evidence`.

A mechanical PASS proves mechanics, not autonomous composition. A benchmark PASS proves outcome, not architecture.

Add the smallest deterministic regression reproducing the real failure, preferably in an existing fixture. Avoid speculative test families and duplicate measurement frameworks. At most one full repo/package sweep runs at once; the single agent owns the final sweep.

## 12. Measurement protocol

Protocol v2 ordinary cohorts are sequential single-world experiments:
- at most one live mutating capability server by default;
- canonical seed/world family and predeclared starts live in campaign state/cohort files;
- `--start x,y,z` is fixture setup before resident join/measured clock, never post-start assistance;
- exact-state comparisons regenerate fresh world when required;
- ordinary starts exclude pathological spawn conditions but not normal inconvenient terrain;
- v1 is the old fresh-seed/parallel-world protocol; v2 is canonical-seed + declared-start + sequential; never mix denominators;
- canonical read-only observer is `http://127.0.0.1:4173/api/ai-summary`; idle is `available=false/no_active_campaign_run`.

Measurement tooling remains subordinate to gameplay.

## 13. Git, processes, worlds, and storage

`main` is validated KEEP checkpoints. Fetch/reconcile before push. Push small coherent KEEP commits frequently enough that a crash loses little work.

Use disposable clean worktrees for risky candidates. Never reset away unrelated work or overwrite another owner’s unmerged work.

Default one active Leaf server for current major. Stop obsolete servers/residents after evidence/world bytes are durable.

Keep newest **10 p-series versions** with full raw worlds/logs. Older failed runs may be compacted to essential provenance/log summaries, but never prune active/incomplete, accepted success, sealed archives, `.retention-protect`, or unrelated user worlds.

On provider outage record `MODEL_UNAVAILABLE`, preserve semantics, and immediately work on deterministic/mechanical/provenance/recovery tasks instead of waiting.

## 14. Resume contract

After restart or a long absence, reconcile before mutation:
`AGENTS -> git HEAD/origin/status + surviving diff -> /home/s0u7a/.config/devin/mc-ai-handoff.md -> state.json -> P-SERIES -> active-run registry -> actual processes/PIDs/ports -> world/server bytes -> latest resident generation/logs -> observer`.

Durable state may claim `active` while all processes are dead; process truth wins. Repair stale durable ownership before resuming evidence claims.

A user prompt of only `continue` means resume the next falsifiable Mission-leverage action. Never ask the operator to restate context already on disk.

Preserve same-world minor continuity when identity is valid; otherwise seal the prior episode and start the next major honestly.

## 15. Work classification

- **A CAPABILITY_CRITICAL:** advances or directly restores Mission frontier.
- **B CAPABILITY_CORRECTNESS:** fixes truth/mechanics/controller/recovery/lifecycle/durability/provenance defects invalidating capability.
- **C MEASUREMENT_PROOF:** minimal proof needed to trust A/B.
- **D CAMPAIGN_INFRA:** bounded fix for a real unattended-campaign blocker.
- **E DEFER:** cosmetics, speculative refactor, forbidden architecture work, or local polish while a higher Mission blocker exists.

Prefer A/B/C. Use D only for a concrete blocker. Product/capability work stays the clear majority; infra normally remains below roughly 25% unless a measured blocker justifies more.

## 16. Completion and anti-goals

Portal-first completion requires normal V4.1.2 authority/VERIFY evidence of an **unassisted autonomous transition into `minecraft:the_nether`** with exact source/world/run provenance and no benchmark-specific behavior or manual gameplay help.

Never reintroduce old authority under new names, smarter shadow GoalQueue/β authority, giant deterministic planners, mega-controllers without causal ownership improvement, unbounded retries, weakened VERIFY/evidence, permanent dual authority, or a one-dimensional survival policy that substitutes repeated combat for a missing escape/world-modification affordance.

M3 (`ender_eye >= 12` under the canonical run-scoped gate) remains a long-horizon composition benchmark, not the architecture or sole objective.

**Core loop:**
`Mission evidence -> first causal blocker -> smallest generic V4.1.2 fix -> focused proof -> exact commit -> same-world hot reload when valid -> first fresh evidence -> campaignDelta -> next blocker`.

**Keep Minecraft moving. Do not wait. Do not ask for routine project permission. Do not confuse local fixes with Mission progress.**
