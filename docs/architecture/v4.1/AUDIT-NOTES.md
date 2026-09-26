# V4.1 Fresh-Context Audit Notes

## Environment record

- repository root: `/home/s0u7a/vtr-worktrees/v41-architecture-redesign-sol-20260925-2100`
- source/base: `origin/main`
- source SHA: `355a26796c4891ecf68ab8ef70cfdd2b626df225`
- branch: `arch/v4.1-concurrent-transition-runtime-sol-20260925-2100`
- initial status: clean
- protected existing Reach integration: `/home/s0u7a/vtr-worktrees/vtr-reach-acceptance-integration-20260925`
- Reach integration inspected read-only at `ed6e4ddb6a57e20b72a833e9e2b3e69227f09e34`

The original `/home/s0u7a/mc-ai` working tree was not modified. It was dirty at audit start and was therefore unsuitable as the V4.1 work area.

## Repository surfaces re-read

- `AGENTS.md`
- historical `docs/history/architecture/ARCHITECTURE.md`, `docs/operations/RESIDENT-MODE.md`, `docs/decision/PLANNERS.md`
- V4 design document (untracked in the original working tree): `docs/history/architecture/NEW-ARCHITECTURE-V4.md`
- legacy controller/scheduler/executor/GoalQueue/Option implementation
- Jev harness contract, identity fencing, calibration/result algebra, batch harness
- HOST world epoch and generation/lease swap logic
- world memory, combat, crafting, smelting/container, portal, search/acquisition-related mechanics
- current Reach VTR contract/controller/mission runtime/scheduler/safety/runtime adapter and acceptance delta

## Jev usage search — required before redesign

Repository search found the actual production/harness pattern rather than relying on naming alone:

- `packages/jev-harness/contract.ts`: typed `choice`, `boolean`, `score`; model answer is a proposal and never Guard/TRUE/DONE authority.
- `packages/jev-harness/harness.ts`: `evaluateBatch`, closed candidate sets, projection hashing, typed failure algebra, stale re-verification, artifact provenance.
- `packages/jev-harness/identity.ts`: decision/world/generation stale fencing.
- historical/runtime docs and controller code: Jev π for grounded local choice, β for historical Option termination, and batched decision questions.
- `docs/history/architecture/ARCHITECTURE.md`: AI SDK call shape `experimental_evaluate({ model: 'typesafe-ai/jev', state, questions })`.

External example search on 2026-09-25 found the same call shape in multiple public implementations: shared state plus a map of typed questions, including several questions in one call, with structured probability/choice/score results. Examples inspected included `jev-cli`, `jev-playground`, and `jev-evals` public repositories.

Architecture conclusion: V4.1 keeps Jev strong as a batched fast typed decision plane, but does not infer that batch evaluation should own truth, leases, mechanical ticks, or generic termination.

## Findings that forced changes from V4

1. Reach VTR currently refuses a second active Reach owner (`ReachController.commit`), proving a single-active bias.
2. Reach safety currently terminalizes through `SAFETY_INTERRUPT`, which cannot represent recoverable mechanical preemption with semantic continuity.
3. Reach identity currently includes generation/lease in its runtime identity checks; V4.1 separates stable semantic contract identity from runtime binding so reload/preemption can preserve the contract while still failing closed before actuation.
4. HOST already demonstrates the value of atomic generation/lease ownership and stale fencing; V4.1 generalizes that discipline to resource bundles rather than discarding it.
5. Legacy scheduler/event logic already shows that decision epochs should be event-driven rather than fixed-frequency Jev calls.

## Concurrent-worktree note

The protected Reach acceptance worktree was observed at `ed6e4ddb6a57e20b72a833e9e2b3e69227f09e34` during the architecture audit and later at `eaec89bb3b29e925f70dceb86e073249e62993b2` during final validation. That advance occurred outside this V4.1 worktree. No files, branches, commits, resets, or leases in the Reach acceptance worktree were modified by this redesign.

## V4.1.2 production-hardening audit — 2026-09-25/26

- worktree: `/home/s0u7a/vtr-worktrees/v412-production-hardening-20260925`
- branch: `arch/v4.1.2-production-hardening-20260925`
- base: `d231942c92592ecc05771966089aa44f1ba4ea5e` (V4.1.1 hardening)
- production Reach/runtime: inspected read-only; no migration authority enabled
- original dirty `/home/s0u7a/mc-ai`: not modified by this work

A concurrent worker produced a second V4.1.2 kernel split inside this dedicated worktree while the first reducer prototype was being built. The files were detected before destructive cleanup, independently tested/typechecked, then audited. The stronger split was adopted as the single canonical kernel; `model.ts` was reduced to a compatibility facade so two authority implementations do not coexist.

Required Jev example search was repeated before/while hardening. Repository examples confirmed bounded structured state + typed choice/boolean/score questions with code-side stale fencing. Public search confirmed the Vercel AI/TypeSafe provider pattern using `experimental_evaluate`, shared `state`, typed `questions`, and Choice/Score/Boolean evaluation. V4.1.2 therefore treats Jev as bounded decision advice over a kernel-built projection, never as truth/lease/effect/termination authority.
The five adversarial review passes found and closed issues beyond the supplied audit list: unsafe budget/deadline terminalization across bounded critical sections; pause/VERIFY/Mission safe-yield bypasses; replay rebranding risk; witness revision non-advancement; duplicate predicate snapshots; stale priority inheritance; latest-vs-earliest critical deadline; untrusted VERIFY invocation; post-preemption-ACK new-work race; lower-class fairness/urgency class crossing; unrelated fact effect reconciliation; and same-binding Jev frame staleness after effect/progress changes.

Production mutation inventory was rebuilt from `packages/jev-agent/src/actuationPort.ts`, `packages/buddy-driver/resident-safety.ts`, and direct mutator sites in `packages/jev-agent/src/executor.ts`. Two concrete production blockers are especially important: direct `bot.attack(entity)` is not represented in ActuationPort and is absent from `MUTATING_BOT_METHODS`; direct `bot.openFurnace(block)` is also absent from both. `consume` is generation-guarded but not ActuationPort-exposed, while pathfinder movement configuration remains a hidden locomotion mutation. These are migration gates in `RESOURCE-AUTHORITY-INVENTORY.md`, not assumed solved by the pure kernel.
