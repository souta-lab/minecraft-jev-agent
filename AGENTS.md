# AGENTS.md — V4.1.2 Authority Constitution

## 0. Canonical architecture

The canonical production architecture is **V4.1.2 Concurrent Verified Transition Runtime / authority kernel**.

Normative references, in precedence order:

1. current source and live server truth
2. `architecture/v4.1/kernel.ts` implementation + `NEW-ARCHITECTURE-V4.1.2.md`, `architecture/v4.1/V4.1.2-HARDENING.md`, `architecture/v4.1/INVARIANTS.md`, `architecture/v4.1/KERNEL-EVENTS.md`
3. `architecture/v4.1/RESOURCE-AUTHORITY-INVENTORY.md` + the static mutation scan — the authority-closure source of truth for every mutating surface
4. `NEW-ARCHITECTURE-V4.md`, `NEW-ARCHITECTURE-V4.1.md`, `NEW-ARCHITECTURE-V4.1.1.md` — semantic lineage docs
5. current deterministic tests / probes / exact-run evidence
6. historical docs/issues (#11, #308, Option/Jev/System2 history) — evidence only, never constitutional authority

If this file disagrees with the V4.1.2 implementation or current V4.1.2 docs, **the implementation and V4.1.2 docs are canonical — fix AGENTS.md**, not the implementation.

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

## 6. Phase-1 status: SHADOW ONLY

- **Kernel authority is OFF.** The Phase-1 shadow observer replays production lifecycle/mutation facts into the executable kernel and journals `kernel-shadow.jsonl`. It **never gates or reroutes production behavior**.
- Current counters/gates: unmapped mutations, unguarded mutations, unattributed mutations, lease-uncovered mutations, and kernel-denied conditions are **hard migration blockers** — recorded, not silently accepted.
- Static mutation scan (current): 134 production files, 27 distinct surfaces, **0 unmapped** — a coverage gate, not live conformance proof.

## 7. Authority-cutover conditions (all required)

Do not enable V4.1.2 production authority until **every** condition holds:

- static conformance: full mutation-surface inventory mapped
- adapter conformance: every mutation crosses ActuationPort
- live conformance from an actual Reach run:
  - `coverageComplete == true`
  - `mutationsObserved > 0`
  - `mutationsMapped == mutationsObserved`
  - `mutationsAttributedToTransition == mutationsObserved` (host control-plane writes like `bot.chat`/`/tell` require an explicit typed authority/resource/effect category with documented rationale — never fake-attributed to Reach)
  - `mutationsUnguarded == 0`, `kernelDenied == 0`, hard blockers == 0
- no double authority (shadow + legacy never both actuate)
- world/generation fencing proof
- crash/replay proof

## 8. Reach Phase-0 / legacy deletion

- Reach **Phase-0 archive validation is FAIL** (latest attempt `9ddbadd`: capture PASS, archive validation failed on missing/invalid evidence).
- **Legacy Reach authority deletion is prohibited** until a fresh Phase-0 archive validates.
- Runtime multi-leg SUCCESS evidence and archive sealing are **distinct** proofs; do not conflate them.
- Preserve `/home/s0u7a/vtr-evidence-archive` and the `9ddbadd` attempt root.

## 9. Development rules

- Every new code change or review must state **how it conforms to V4.1.2**. Do not regress toward Option/Jev-π/β authority, GoalQueue-as-truth, or benchmark-shaped production policy.
- New authority enters only through `KernelCommand`s. New intelligence enters through Jev decision policy, scheduler/routing, Verified World Model estimation, controller in-contract tactics, or sparse System2 — never a new cross-layer authority path.
- Compatibility adapters must name the authoritative side and a deletion condition. Do not add a second mutable semantic source of truth.
- Prefer deleting an authority crossing over adding retry/cooldown/fence around it.
- Never silently fall back to deterministic semantics when Jev/System2 is unavailable; use explicit typed policy-unavailable paths or explicitly configured test/offline policy.
- Do not weaken verification or evidence gates to make success easier. `action done` is not Transition SUCCESS.
- Preserve fail-closed effect boundaries for irreversible world mutation.

## 10. Work classification

Classify active work into exactly one bucket:

- **A. V4_MIGRATION_CRITICAL** — directly establishes/unblocks the next V4.1.2 milestone (currently: live conformance proof → authority cutover).
- **B. V4_CORRECTNESS_BLOCKER** — truth, safety, lifecycle, durability, provenance, effect-envelope, or evidence defects that would invalidate V4.1.2 results.
- **C. PROOF** — tests, no-LLM probes, live validation, ablation, exact-run artifacts for A/B.
- **D. DEFER** — cosmetic cleanup, unrelated mechanics, speculative features, legacy perfection.

Prefer A/B/C. Record why when evidence reorders the migration plan.

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

## 12. Live loop

For migration work, prefer this loop:

```text
exact origin/main SHA
-> inspect current kernel/legacy ownership boundary
-> tests/typecheck/probes
-> run the smallest causal experiment that can distinguish hypotheses
-> identify the first contract/fact/controller failure
-> implement the generic V4.1.2-conformant fix
-> regression + no-double-authority tests
-> integrate
-> fresh exact-source run/probe
-> compare world-state progress, model-call rate, controller closure and typed outcomes
-> remove superseded compatibility authority when evidence is sufficient
```

Do not treat "the bot moved" as progress. Ask which verified predicate changed and which Transition owned it.
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
- world/dimension/epoch/generation identity
- model calls and why they were necessary
- any legacy Option/GoalQueue/Jev π/β authority participation, separately from kernel-admitted Jev decision frames
- whether two authority paths could actuate simultaneously
- shadow counters: `mutationsObserved`, `mutationsMapped`, `mutationsAttributedToTransition`, `mutationsUnguarded`, `kernelDenied`, blockers, `coverageComplete`

Model calls per verified Transition and mechanical steps per model call are important measurements.

## 14. Parallel work / subagents

Use subagents and independent worktrees aggressively when available for large migration tasks.

Rules:

- one mutation owner per subsystem/blocker;
- do not give multiple agents the same implementation;
- parallelize audits, tests, probes, history analysis, contract design and independent controller families;
- while subagents run, continue a separate useful lane yourself;
- review and integrate subagent results yourself;
- never reset/overwrite concurrent worktrees or another lane's unmerged work;
- retire superseded worktrees instead of accumulating them indefinitely.

Good parallel lanes for V4.1.2 Phase-1 → cutover:

- A. live conformance proof harness and kernel-shadow instrumentation
- B. host control-plane mutation authority model (`bot.chat`/`/tell` class)
- C. verified world-model / fact-frontier audit
- D. no-LLM probe harness and fixtures
- E. legacy authority/double-actuation audit
- F. viability runtime design/evidence
- G. tests and property/invariant checks
- H. live metrics / exact-run evidence
- I. issue/history reconciliation
- J. deletion map for superseded Option/Jev/GoalQueue/legacy-Reach authority

## 15. Issues and PRs

Do not create one issue/PR per tiny symptom.
Create or reuse an issue when there is a distinct causal boundary, migration invariant, durable acceptance criterion, or live-evidenced failure.

Migration issues should describe:

- old authority being replaced
- new kernel/contract owner
- compatibility period
- proof required before deletion
- deletion/retirement condition

Historical #11-era issues should be relabeled/reframed/superseded when their requested direction conflicts with V4.1.2. Do not blindly finish them because they are open.

## 16. M3 and generality under V4.1.2

M3 remains `ender_eye >= 12` under the canonical run-scoped gate unless the milestone contract itself changes.
Use M3 as an integration proof that migrated Transition families compose across long-horizon acquisition, crafting/stations, survival, navigation/search, Nether transition, hostile-mob drops, and durable recovery.

Do not optimize the architecture around the expected M3 route.
A fresh M3 PASS is valuable only if production intent remains benchmark-independent and kernel-admitted authority is visible in the run artifact.

After a credible V4.1.2 path reaches M3, test changed seeds, partial-start states, benchmark-absent missions and unsupported predicates before calling the architecture general.

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

Architecture autonomy is narrower: the V4.1.2 authority constitution is frozen by default. Routine implementation and policy evolution may proceed autonomously inside it, but changing the contract/ownership/verification constitution itself requires runtime evidence, not taste, novelty, or convenience.

Continue until the current requested milestone is actually proven, or until an external blocker makes further useful work impossible. If blocked, leave exact evidence and the next falsifiable experiment.

The current milestone is **live V4.1.2 conformance proof** (shadow counters in §7 on a real Reach run), then Phase-0 archive re-validation, then authority cutover — not "finish #11" and not "M3 at any cost".

When a migrated slice is proven and cutover conditions are met, remove or disable the semantic authority it replaces instead of leaving a permanent dual-control architecture.
