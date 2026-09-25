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
