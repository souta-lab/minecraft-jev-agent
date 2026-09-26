# AI Authority Kernel

> **Superseded.** The Jev π/β / WHAT authority split below is the pre-kernel model; the current authority constitution is the V4.1.2 kernel (root `AGENTS.md`, `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md`). Retained as lineage evidence.

This document is normative for the resident AI path introduced by the authority overhaul.

## One owner per decision

| Decision | Authority | Code may do |
| --- | --- | --- |
| WHAT high-level intent/Option comes next | System 2 model | enumerate grounded plans, expose facts, reject impossible representations |
| WHICH grounded local action executes now | Jev pi | enumerate candidates, compute reachability/cost/safety facts, guard unsafe actions |
| WHETHER the current Option ends | Jev beta | evaluate code-owned predicates and verified outcomes, expose them to beta |
| HOW an action is executed | Skill / executor | deterministic mechanics, pathfinding, interaction protocol |
| CAN / TRUE / SAFE / DONE | code | authoritative world truth, feasibility, safety, verification |
| durable lifecycle / actuation lease | HOST | persistence, restart, lease ownership |

A fact is not a policy. Distance, cost, failure count, stall count, remembered coordinates, readiness, and capability gaps may all be computed deterministically and supplied to a model. Real-model code must not turn one of those facts into an implicit universal ranking or a hidden semantic selector.

## Runtime split

`packages/buddy-driver/planner-legacy.ts` and `packages/jev-agent/src/jev-legacy.ts` preserve the pre-overhaul implementations for compatibility and explicit offline baselines. They are not the normal resident model path.

The public `PlannerBrain` defaults to model authority. `BUDDY_PLANNER=deterministic|off|fallback|none` is the explicit baseline escape hatch. Missing credentials are a fatal configuration/model failure, not permission to switch authority.

The public `createJevPolicy()` defaults to the model-authoritative Jev kernel. `forceFallback=true` is the only deterministic local policy escape hatch.

Jev beta is authoritative by default. `BUDDY_BETA_AUTHORITY=shadow|off|0` is an explicit experiment/debug override.

## Forbidden patterns in the real-model path

The following are architecture regressions:

- `queue_empty -> deterministic ladder` before System 2 gets the choice;
- capability gap -> force-select a recovery plan;
- stall -> replace the model-selected plan with a body-change plan;
- unknown/malformed model choice -> `options[0]` or another deterministic semantic fallback;
- anti-flap -> choose the cheapest different candidate;
- prompt rules such as "always prefer candidates with fewer failures";
- model/provider failure -> deterministic semantic fallback.

The correct pattern is always:

```text
code enumerates grounded alternatives + facts
        -> model chooses semantic alternative
        -> deterministic guard validates CAN/SAFE
        -> executor performs HOW
        -> verifier records TRUE/DONE
```

If no grounded semantic alternative exists, fail/escalate loudly with evidence. Do not fabricate authority in code.

## Migration note

Legacy deterministic mechanics are intentionally retained instead of deleted wholesale. A large amount of the old implementation is valuable reusable Minecraft truth/mechanics. The overhaul changes *who is allowed to choose*, not whether deterministic mechanics exist.
