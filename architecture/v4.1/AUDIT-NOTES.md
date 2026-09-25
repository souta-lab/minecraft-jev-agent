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
- historical `ARCHITECTURE.md`, `RESIDENT-MODE.md`, `PLANNERS.md`
- untracked V4 design document in the original working tree: `NEW-ARCHITECTURE-V4.md`
- legacy controller/scheduler/executor/GoalQueue/Option implementation
- Jev harness contract, identity fencing, calibration/result algebra, batch harness
- HOST world epoch and generation/lease swap logic
- world memory, combat, crafting, smelting/container, portal, search/acquisition-related mechanics
- current Reach VTR contract/controller/mission runtime/scheduler/safety/runtime adapter and acceptance delta

## Jev usage search — required before redesign

Repository search found the actual production/harness pattern rather than relying on naming alone:

- `jev-harness/contract.ts`: typed `choice`, `boolean`, `score`; model answer is a proposal and never Guard/TRUE/DONE authority.
- `jev-harness/harness.ts`: `evaluateBatch`, closed candidate sets, projection hashing, typed failure algebra, stale re-verification, artifact provenance.
- `jev-harness/identity.ts`: decision/world/generation stale fencing.
- historical/runtime docs and controller code: Jev π for grounded local choice, β for historical Option termination, and batched decision questions.
- `ARCHITECTURE.md`: AI SDK call shape `experimental_evaluate({ model: 'typesafe-ai/jev', state, questions })`.

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
