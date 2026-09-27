# AGENTS.md — buddy-driver scoped rules

This file contains only durable rules for work under `packages/buddy-driver/`.

Historical incidents, timestamped blockers, and old phase plans are intentionally NOT repeated here. They remain available in Git history and closed issues. Do not reconstruct current work from old incident prose.

## 1. Precedence and current work

This file inherits the repository-root `AGENTS.md`; root rules have higher precedence. In particular the root `PERMANENT ARCHITECTURE LOCK` binds all work here: V4.1.2 is permanent; no successor architecture, no reopening the authority constitution under any evidence.

Current work is selected from repository-root `ISSUE-ROUTING.json` only. Before modifying runtime code:

1. read root `AGENTS.md`;
2. read `ISSUE-ROUTING.json`;
3. read the latest evidence/comments on the owning NOW issue;
4. inspect latest `main` and active lanes;
5. do not revive a closed PR/branch as an implementation base; restart from fresh main if old work becomes relevant.

`AGENT-TODO.md` is a pointer only and must not duplicate the queue.

## 2. Authority invariant

The canonical authority model is the root `AGENTS.md` V4.1.2 constitution: `KernelCommand -> applyKernelCommand() -> KernelState + KernelEvent[]` is the only runtime authority state transition path. The legacy Jev π/β/Option split below survives only as incident context (#221), never as an authority grant:

```text
Kernel    = sole runtime authority (lifecycle / leases / effects / facts / revisions)
Code      = CAN / TRUE / SAFE / DONE (deterministic truth, verification, mechanics)
Jev       = semantic/tactical decision only (no truth, SUCCESS, lease, or effect authority)
System2   = sparse synthesis/repair/decomposition (exception-driven, no motor commands)
Skill/Adapter = HOW — actuation crosses the Runtime Adapter / ActuationPort boundary only
HOST      = durable state / lifecycle / actuation lease
```

Deterministic code MAY own:
- sensing and world/inventory truth;
- hard safety and feasibility;
- recipe/tool/harvest legality;
- path, geometry, physics and bounded movement mechanics;
- craft/smelt/station transaction mechanics;
- durable memory/lifecycle/lease ownership;
- initiation/success predicates and typed postconditions;
- mechanically necessary prerequisite expansion when no semantic choice exists.

Deterministic code MUST NOT silently own:
- ranking among multiple valid semantic actions;
- choosing a different objective because it is cheaper/earlier/less failed;
- replacing a Jev decision with another valid action except hard invalidity/safety rejection;
- choosing WHAT NEXT after System2 is unavailable;
- using a deterministic ladder as an implicit production fallback in a run claimed as Jev/System2-driven.

A deterministic policy/ladder may remain for fixtures, rollback and A/B only when explicitly selected. Label such runs `DETERMINISTIC_BASELINE`; they are not Jev/System2 acceptance evidence.

## 3. Fail closed on requested model authority

Production/model-authoritative mode must never silently degrade into deterministic semantic authority.

Required startup/effective-authority evidence should distinguish at least:

```text
requestedPolicy
resolvedPolicy
policyKeyResolved
plannerMode
resolvedSystem2
optionCompiler
```

If Jev is requested/default-required and no usable key resolves, refuse semantic action authority rather than silently instantiate the deterministic fallback.

If System2 is requested and unavailable/rate-limited, preserve the current durable objective or surface an explicit unavailable/UNKNOWN state. Do not invent a new semantic objective from the deterministic ladder unless the run explicitly selected deterministic baseline mode.

## 4. HOST / generation invariants

- HOST owns durable state, world epoch, active generation identity, and actuation lease.
- Never run two live generations against one bot.
- A generation must quiesce/dispose and release owned listeners/timers before replacement.
- Durable state is plain data; do not persist class instances or live Mineflayer objects.
- World memory is namespaced by world identity/epoch; never restore server truth such as current position/health/inventory from a stale snapshot.
- Side effects require the active actuation lease immediately before execution.
- Structural smoke and mission/product success are separate. An empty plan may pass structural smoke.
- Contract/schema version mismatches are explicit failures; do not hide them with hot reload.

## 5. Truth and progress

Do not equate body motion with completion.

```text
mechanical movement / distance closure -> may be progress
verified postcondition / reached predicate / inventory gain -> DONE evidence
```

A bounded staircase/pillar/retrieval step can be productive progress without completing the semantic goal. It must neither be charged as zero-progress failure nor be recorded as completed retrieval unless the actual postcondition is satisfied.

Keep truth/verification fixes deterministic. Do not turn them into semantic ranking rules.

## 6. System2 usage

System2 is exception-driven, not a per-tick action policy. It may choose/repair high-level goal data from grounded capabilities; it does not emit motor commands or arbitrary coordinates.

Grounding may reject impossible model output. Rejection does not grant code permission to choose a different semantic plan. Ask System2 again later, hold current work, or surface unavailable/UNKNOWN according to the owning contract.

Caches/rate limits must not silently change authority. Cache hits must replay attributable model decisions; rate exhaustion must be observable.

## 7. Operations

Detached start (when host startup is explicitly appropriate):

```bash
cd /home/s0u7a/mc-ai/packages/buddy-driver
setsid nohup bun agent-runner.mts </dev/null > runner.out 2>&1 &
```

Do not use broad `pkill -f` patterns. Intentional host/server shutdown/restart follows the root HARD STOP rules.

Hot reload may update the reloadable generation only when the contract version is compatible. A contract mismatch requires the host-level procedure defined by `docs/operations/RESIDENT-MODE.md`.

Never print or commit API keys/secrets. Secret material lives outside the repo.

## 8. Completion discipline

For a runtime fix, the loop is:

```text
fresh evidence
-> first failed boundary
-> smallest owning-layer fix
-> focused regression fixture
-> fresh live/isolated verification as required
```

Do not recursively add governance/tooling/docs work unless it directly prevents a recurrence like the #221 authority incident or is required to trust the current result.

Optimize for verified capability/failure-frontier advancement, not commit count, issue count, test count, or documentation volume.
