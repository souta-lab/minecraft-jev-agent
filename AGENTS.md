# AGENTS.md — V4 Migration Contract

## 0. Canonical architecture

`NEW-ARCHITECTURE-V4.md` is the normative architecture for this repository.

V4 supersedes the old assumption that #11 / #308 Grounded Option OS is the final architecture.
#11, #308, Option/Jev/System2 issues and historical docs remain valuable evidence, but they are not constitutional authority when they conflict with V4.

Reality precedence:
1. current source and live server truth
2. current deterministic tests / probes
3. exact-run evidence
4. `NEW-ARCHITECTURE-V4.md`
5. current migration docs/issues
6. historical architecture/status docs

Do not bend current code toward stale documentation. Update, supersede, or historicalize stale docs.

## 1. Project mission

Build a general Minecraft agent that can autonomously drive verified world-state transitions for long periods without human feedback.

The architecture target is **Verified Transition Runtime (VTR)** with **Jev as the production-default fast decision policy**:
Mission predicates -> Verified World Model -> Causal Transition Graph -> Transition Scheduler (Jev-first policy) -> VTR admission/commit -> Persistent Transition Controllers -> Minecraft Runtime Adapter + VERIFY -> verified facts -> frontier re-derivation.

M2/M3/M4 are proof corpora, not the production brain. M3 remains an important live integration gate, but an M3 PASS obtained by preserving the wrong control architecture is not project completion.
## 2. V4 constitution

> The agent owns verified world-state transitions, not individual semantic actions. A controller may change tactics, temporary targets, and mechanical realization while the desired predicate, admissible side effects, and risk/resource contract remain unchanged. Higher-level reasoning is required only when that contract itself must change.

VTR is the stable control kernel, not a temporary migration architecture. Jev is the repository's primary fast System-One decision implementation on top of that kernel; VTR being policy-provider-independent does **not** mean Jev is project-optional or should be engineered out of the normal production path. New intelligence should normally enter through Jev decision policy, Transition scheduling/routing, Verified World Model estimation, controller policy/capability implementation, or sparse System2 reasoning — not by inventing a new cross-layer authority model. Change the VTR constitution only when current-source tests and runtime evidence demonstrate that its contract/ownership/verification model is itself insufficient.

Operational interpretation:
- Code may choose among tactics inside one Transition Contract.
- Deterministic choice is allowed when its objective/cost/risk model is explicit, grounded, bounded, and testable.
- Do not surrender Transition ownership back to Jev/System2 merely because execution needs a different path, witness, local tactic, bridge, staircase, detour, equip, pickup, or retry mode already inside the contract. A controller may consult Jev for a bounded in-contract choice without ending or recommitting the Transition; Jev policy consultation is not an authority handoff.
- Return to the scheduler/reasoner when the desired predicate, mutation envelope, resource/risk budget, or dependency assumptions must change.
- Exact coordinates/entities are usually witnesses, not semantic identity. Preserve the predicate contract when a valid witness changes.

## 3. Canonical V4 layers

1. **Mission** — desired predicates, not benchmark rung order.
2. **Verified World Model** — TRUE/FALSE/UNKNOWN facts with provenance, worldKey, dimension and epoch.
3. **Causal Transition Graph** — known ways to establish predicates and their real prerequisites/effects.
4. **Transition Scheduler + Decision Policy** — enumerate grounded enabled Transitions; production defaults to Jev for meaningful choice/ranking/scoring, while deterministic no-choice fast paths are allowed.
5. **VTR Admission + Commit** — stale-fence the proposal, validate requires/effects/budgets/identity, and establish one authoritative Transition owner.
6. **Persistent Transition Controllers** — closed-loop ownership until verified SUCCESS or typed terminal boundary; may use Jev internally for bounded policy choices without relinquishing ownership.
7. **Viability Runtime** — health/hunger/air/threat and other mission-crossing survival invariants.
8. **Minecraft Runtime Adapter + VERIFY** — backend-specific gameplay observation/actuation behind typed ports plus deterministic postcondition truth.
9. **Sparse System2 Reasoning Service** — graph/contract synthesis and repair only where the known graph/controllers/Jev policy cannot resolve the problem.
10. **Durable Fact Store + Transition Journal** — world facts and causal experience, not a mutable agenda as truth.
## 4. Concepts to keep, demote, or retire

KEEP / strengthen:
- Resident HOST, hot reload, leases and atomic generation swap
- worldKey/worldEpoch and run/source provenance
- minecraft-data mechanics truth
- Guard and deterministic VERIFY
- typed outcomes and causal evidence
- durable world facts
- executor/mechanical capabilities
- Jev System-One policy client/harness, typed batched questions, calibrated-confidence provenance, and decision logging
- live no-LLM capability probes

DEMOTE:
- System2 -> sparse graph/contract repair service, not always-on WHAT authority
- legacy Jev π/β *authority split* -> compatibility evidence only; Jev itself remains the production-default fast decision policy
- candidate sets -> scheduler/controller-local grounded affordances, not the universal brain interface
- GoalQueue -> compatibility/debug projection only
- RUNGS -> benchmark/evaluation or explicit baseline only

RETIRE as canonical authority:
- Jev π as universal WHICH owner
- Jev β as universal WHETHER/termination owner
- Option/OptionLedger as the fundamental runtime unit
- GoalQueue ordering as semantic truth
- fixed strategy menus and benchmark-shaped production policy
- cross-layer retry/oscillation counters that substitute for Transition-local progress/failure contracts

Do not expand legacy authority merely to make migration easier.
## 5. Transition Contract requirements

Every production Transition must make its control contract explicit enough to test independently.

At minimum define or make inspectable:
- `requires`: predicates needed to start
- `ensures`: predicates the Transition owns establishing
- `invariants`: facts that must remain valid while running
- admissible world/body effects
- resource and risk budget
- Transition-specific progress definition
- controller state
- allowed witness/target substitution
- typed terminal failures / infeasibility conditions
- world/dimension/epoch identity
- deterministic verification of SUCCESS

A Transition may internally perform many mechanical actions and tactical changes.
`action done` is not Transition success. Only the declared verified predicate closes SUCCESS.

Progress is local to the Transition type:
- navigation: verified closing/reachability/frontier progress
- search: new relevant observation / frontier coverage / hypothesis elimination
- acquisition: inventory/postcondition progress
- construction: verified structure predicates
- combat: encounter objective plus viability margin

Never use body motion alone as generic semantic progress. Never normalize missing/undefined progress into success evidence.
## 6. Viability is parallel control, not a queued side quest

Health, hunger, air, immediate lethal threat, fall/lava/fire escape, and essential self-protection are mission-crossing invariants.

The viability runtime may temporarily stabilize the body without replacing the mission predicate.
After stabilization, re-evaluate the active Transition against fresh world truth.
Do not require GoalQueue head ownership or System2 availability for obvious bounded survival control.
Do not encode seed/incident-specific survival scripts; use grounded state, explicit risk and deterministic postconditions.

## 7. Jev decision plane and System2 after V4

**Jev is the primary production fast decision policy for this repository.** VTR is deliberately capable of running deterministic probes and continuing already-committed mechanics without a model, but that portability is a kernel property, not a statement that Jev is unimportant.

Use Jev at explicit **decision epochs**, not at every primitive mechanical step. Good Jev responsibilities are:
- choose/rank among grounded enabled Transition proposals when more than one meaningfully valid route remains;
- score risk, uncertainty, or expected value over grounded alternatives;
- arbitrate bounded tactics inside an active Transition when the desired predicate/effect/risk/resource contract is unchanged;
- interpret typed terminal outcomes and choose the next grounded contract;
- decide whether uncertainty/failure warrants sparse System2 escalation.

Prefer one versioned, stale-fenced **Jev Decision Frame** with batched typed questions over independent universal π and β authority calls. The frame should consume a bounded semantic projection: Mission frontier, verified facts, enabled Transition ids/contracts, relevant budgets and typed outcomes. Jev outputs grounded ids/scores/booleans/probabilities; VTR admission validates the result before commit.

Jev does **not** own world truth, deterministic SUCCESS, raw Minecraft client access, the actuation lease, or generic Transition termination. A Jev choice is policy input to VTR/controller ownership, not permission for one primitive Mineflayer call.

No meaningful choice means no Jev call is required. An already-active controller may continue through a short Jev outage when its contract still determines the next mechanical work. If a genuine new policy decision is required and Jev is unavailable, fail/suspend through an explicit typed policy-unavailable path or an explicitly configured test/offline policy; never silently switch to an undeclared semantic fallback.

System2 remains the sparse reasoning layer and is appropriate when:
- a Mission needs initial predicate/transition decomposition that current code cannot derive;
- no known Transition can establish an unsatisfied predicate;
- a contract must be synthesized, repaired, or replaced beyond the known graph;
- repeated typed failures require a genuinely new causal hypothesis;
- genuinely different long-horizon alternatives cannot be grounded sufficiently for Jev to decide over.

Provider outage must not kill mechanical continuity that does not require a new policy epoch.
Never replay stale Jev/System2 decisions across changed world/generation/contract identity.
Never hide a model failure with an undeclared benchmark-specific semantic fallback.
## 8. Migration strategy: strangler with real vertical slices

Do not attempt a flag-day rewrite.
Do not spend months perfecting Option/Jev/β before VTR exists.
Do not decompose the mega-controller under unchanged semantics merely for cleanliness.

Build VTR beside the legacy semantic plane, move one complete causal path at a time, prove it, then remove the replaced authority.

### Current P0 migration milestone

Create the smallest production VTR vertical slice that proves the new control model end-to-end.

Preferred first slice: **Reach / Navigation Transition**, using the existing `walkSkill`/movement machinery as substrate.

The slice must demonstrate:
1. a Mission/desired predicate produces an enabled Transition without benchmark RUNGS deciding WHAT;
2. one first-class Transition Contract is committed and journaled;
3. one controller owns repeated walk/path/jump and permitted bounded terrain adaptation for the same `ensures` predicate;
4. temporary waypoint/target changes do not require a new Jev authority epoch when the contract is unchanged; an optional Jev in-controller policy query may choose among grounded tactics without ending the Transition;
5. SUCCESS is deterministic predicate verification;
6. terminal block/budget/world-change outcomes are typed and return to the scheduler, not β;
7. the active Transition can continue through a short Jev/System2 outage when no new policy/contract decision is required;
8. GoalQueue/Option may be mirrored for compatibility/evidence but cannot be the authority for this slice;
9. a no-LLM live probe proves the controller mechanically;
10. an integration fixture proves the VTR path and legacy path do not both actuate.

Do not declare V4 migrated after interfaces/types only. The first milestone requires a real production execution path.
### Subsequent migration order

After the first vertical slice is real and measured, prefer this order unless evidence gives a stronger dependency:
1. Search Transition with information/frontier progress
2. Acquisition Transition with witness substitution and pickup closure
3. Craft/Station Transition family
4. Viability Runtime and bounded combat/escape ownership
5. Portal/dimension Transition
6. Fact-derived frontier / queue independence
7. Jev-first V4 Decision Policy integration plus sparse System2 graph repair
8. remove replaced GoalQueue/Option/β/legacy authority
9. multi-seed long-run proof including M3, then M4 without benchmark policy branches

Migration is allowed to change these phases when runtime evidence proves a better dependency order. Record why.

## 9. Work classification

Classify active work into exactly one bucket:

A. **V4_MIGRATION_CRITICAL**
   Directly establishes or unblocks the next production VTR vertical slice.

B. **V4_CORRECTNESS_BLOCKER**
   Truth, safety, lifecycle, durability, provenance, effect-envelope or evidence defects that would invalidate VTR results.

C. **PROOF**
   Tests, no-LLM probes, live validation, ablation, benchmark-independence and exact-run artifacts for A/B.

D. **DEFER**
   Cosmetic cleanup, unrelated M3/M4 mechanics, speculative feature families, or legacy perfection that does not unblock migration.

Prefer A/B/C. Do not let “M3 critical” pull the architecture back to #11 semantics.
## 10. Implementation rules

- Prefer deleting an authority crossing over adding another retry/cooldown/fence around it.
- New production code should be V4-shaped. Do not create new Option or universal Jev π/β authority abstractions. Integrate Jev through V4 scheduler/controller decision-policy boundaries instead of recreating per-action permission/termination layers.
- Any compatibility adapter must state which side is authoritative and have a deletion condition.
- Do not add a second mutable semantic source of truth.
- Derive current work from verified facts and predicates where practical; do not persist agenda just because it is convenient.
- Reuse existing mechanics, Guard, VERIFY, lease, world identity and evidence code aggressively.
- Preserve fail-closed effect boundaries for irreversible world mutation.
- A controller can select tactics deterministically inside its declared contract; do not manufacture an LLM call solely to satisfy old authority doctrine.
- Do not hardcode benchmark order, known seed coordinates, fixed routes, or incident-specific semantic strategy.
- Do not make success easier by weakening verification or evidence gates.

### Minecraft runtime boundary

VTR core is runtime-backend independent.
- Mission, Verified World Model, Transition Graph, Scheduler/Decision Policy, Transition Controllers, Viability Runtime, Jev and System2 MUST NOT receive, retain, import, or call a raw Mineflayer `Bot` or future backend-specific live client in the final architecture.
- Gameplay observation and actuation cross typed runtime ports only. Only the Minecraft Runtime Adapter performs gameplay reads/writes against the raw client (`entity`, inventory, block lookup, pathfinder, dig/place/attack/equip/craft/container/control-state APIs, etc.).
- HOST may create/own/connect/reconnect the raw client solely for lifecycle, generation identity, lease and adapter wiring; HOST must not become gameplay policy or bypass the Runtime Adapter for semantic/mechanical actions.
- Transition Controllers express desired capabilities/effects through backend-independent ports. Verified World Model consumes typed observations/evidence, never live backend objects.
- Backend-specific types must not appear in Transition Contracts, scheduler state, durable facts, journal schema, Jev/System2 semantic projections, or model-facing contracts.
- During strangler migration, existing raw `Bot` access may survive only as an explicitly identified compatibility adapter with one authoritative side and a deletion condition. Any **new** raw-client dependency outside HOST lifecycle/Runtime Adapter is an architecture violation.

When touching legacy mega-files, ask first whether the change should instead create/move ownership into a Transition/controller boundary.
Avoid growing `controller-legacy.ts`, `planner-legacy.ts`, GoalQueue or beta machinery for defects VTR is meant to eliminate.

## 11. Testing and proof hierarchy

For each migrated Transition family require, as applicable:
1. pure contract/state-machine tests
2. deterministic mechanical fixture
3. no-LLM live probe for CAN/HOW/DONE
4. integration test through the real VTR scheduler/runtime
5. legacy-vs-VTR double-authority exclusion
6. stale world/epoch/lease tests
7. target/witness substitution tests
8. progress and budget exhaustion tests
9. provider-outage test when model independence is claimed
10. fresh exact-source live evidence

A capability probe PASS proves mechanics only. It does not prove autonomous composition.
A benchmark PASS proves an end-to-end outcome only. It does not prove architectural generality.
## 12. Live loop

For migration work, prefer this loop:

exact `origin/main` SHA
-> inspect current VTR/legacy ownership boundary
-> tests/typecheck/probes
-> run the smallest causal experiment that can distinguish hypotheses
-> identify the first contract/fact/controller failure
-> implement the generic V4 fix
-> regression + no-double-authority tests
-> integrate
-> fresh exact-source run/probe
-> compare world-state progress, model-call rate, controller closure and typed outcomes
-> remove superseded compatibility authority when evidence is sufficient

Do not treat “the bot moved” as progress. Ask which verified predicate changed and which Transition owned it.
Do not shotgun speculative fixes into one run.

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
- world/dimension/epoch identity
- model calls and why they were necessary
- any legacy Option/GoalQueue/Jev π/β authority participation, separately from V4 Jev Decision Frame calls
- whether two authority paths could actuate simultaneously

For V4 slices, model calls per verified Transition and mechanical steps per model call are important measurements.
## 14. Parallel work / subagents

Use subagents and independent worktrees aggressively when available, preferably 6-10 parallel research/proof lanes for large migration tasks.

Rules:
- one mutation owner per subsystem/blocker;
- do not give multiple agents the same implementation;
- parallelize audits, tests, probes, history analysis, contract design and independent controller families;
- while subagents run, continue a separate useful lane yourself;
- review and integrate subagent results yourself;
- never reset/overwrite concurrent worktrees or another lane's unmerged work;
- retire superseded worktrees instead of accumulating them indefinitely.

Good parallel lanes for V4:
A. Transition Contract/runtime core
B. first controller vertical slice
C. verified world-model / fact-frontier audit
D. no-LLM probe harness and fixtures
E. legacy authority/double-actuation audit
F. viability runtime design/evidence
G. tests and property/invariant checks
H. live metrics / exact-run evidence
I. issue/history reconciliation
J. deletion map for superseded Option/Jev/GoalQueue code

## 15. Issues and PRs

Do not create one issue/PR per tiny symptom.
Create or reuse an issue when there is a distinct causal boundary, migration invariant, durable acceptance criterion, or live-evidenced failure.

V4 migration issues should describe:
- old authority being replaced
- new Transition/contract owner
- compatibility period
- proof required before deletion
- deletion/retirement condition

Historical #11 issues should be relabeled/reframed/superseded when their requested direction conflicts with V4. Do not blindly finish them because they are open.
## 16. M3 under V4

M3 remains `ender_eye >= 12` under the canonical run-scoped gate unless the milestone contract itself changes.
Use M3 as an integration proof that migrated Transition families compose across:
- long-horizon acquisition
- crafting/stations
- survival
- navigation/search
- Nether transition
- hostile-mob drops
- durable recovery

Do not optimize the architecture around the expected M3 route.
A fresh M3 PASS is valuable only if production intent remains benchmark-independent and migrated VTR authority is visible in the run artifact.

After a credible VTR path reaches M3, test changed seeds, partial-start states, benchmark-absent missions and non-M2/M3 supported predicates before calling the architecture general.

## 17. Explicit anti-goals

Do NOT solve migration by:
- renaming Option to Transition while keeping the same per-action control loop;
- wrapping GoalQueue in another canonical ledger;
- making β smarter instead of removing generic model-owned termination;
- ending/recommitting the active Transition and bouncing every tactical recovery to a new Jev authority epoch merely because it is “semantic”; bounded Jev consultation inside the same controller contract is allowed;
- creating a giant deterministic benchmark planner;
- moving the legacy mega-controller into smaller files without changing causal ownership;
- increasing candidate count/model context as a substitute for controller closure;
- adding unbounded retries or arbitrary N-failure policy switches;
- weakening Guard/VERIFY/evidence to get a green run;
- keeping both old and new authority indefinitely.

## 18. Turn/work-session discipline and autonomy

At the start of a substantial task, form concrete TODOs covering as many of audit, implementation, tests, probes/live validation, integration and deletion as the task allows.
Do not end merely because a plan was written, an issue was filed, a subagent was launched, one interface was added, or one local test passed. A status report is not completion. If the requested goal is still unmet and useful work is available, continue.

Work autonomously toward the requested goal. Do not wait for step-by-step permission for ordinary investigation, code edits, tests, live runs, log/evidence audits, issue triage, branch/worktree maintenance, necessary restarts/configuration changes, or other reversible engineering work that is causally useful to the goal. Preserve concurrent work and do not overwrite another lane's unmerged changes.

Also pursue indirect but useful work when it materially increases the probability or speed of reaching the goal: observability/probe tooling, generic refactors that unblock the slice, repository/GitHub hygiene, workspace cleanup, evidence tooling, model/policy investigation, and disk-space/ENOSPC recovery are legitimate work. Choose such work yourself from current evidence; do not require the user to enumerate every intermediate step. Do not use "indirect progress" as an excuse for unrelated cleanup while a clearer causal blocker is available.

Architecture autonomy is narrower: VTR is frozen by default. Routine implementation and policy evolution may proceed autonomously inside the VTR constitution, but changing the contract/ownership/verification constitution itself requires the runtime-evidence threshold defined above rather than taste, novelty, or convenience.

Continue until the current requested migration milestone is actually proven, or until an external blocker makes further useful work impossible. If blocked, leave exact evidence and the next falsifiable experiment.

The default current milestone is the **P0 Reach/Navigation VTR vertical slice** in section 8, not “finish #11” and not “M3 at any cost”.

When a migrated slice is proven, remove or disable the semantic authority it replaces instead of leaving a permanent dual-control architecture.
