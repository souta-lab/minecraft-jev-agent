# AGENT-TODO — CURRENT ENTRYPOINT ONLY

This file is intentionally small.

Historical incident instructions used to live here. They are preserved in Git history and in their closed GitHub issues, but they MUST NOT steer current autonomous work. In particular, the old instruction to keep the resident on a deterministic fallback until a later planner phase is obsolete and contradicted the intended #11 authority split.

## Current source of truth

Before changing runtime code:

1. read repository-root `ISSUE-ROUTING.json`;
2. work only on `NOW` unless the orchestrator explicitly promotes another issue;
3. read the owning issue's latest comments/evidence;
4. run the lane guard / current-status tooling described by the root `AGENTS.md`;
5. treat closed issues and old branches as historical evidence, not TODOs.

## Authority reset (2026-09-20)

Until issue #221 is resolved:

```text
Code      = CAN / TRUE / SAFE / DONE
Jev pi    = WHICH grounded local action
Jev beta  = WHETHER the current Option should end
System2   = WHAT intent/Option comes next
Skill     = HOW the selected action is mechanically executed
HOST      = durable state / lifecycle / actuation lease
```

Allowed deterministic work:
- sensing/world truth;
- safety and feasibility;
- recipe/tool legality;
- path/geometry/physics mechanics;
- craft/smelt transactions;
- durable state/lifecycle;
- typed postconditions and verification;
- mechanically necessary prerequisite expansion where there is no semantic alternative.

Do NOT add deterministic semantic ranking/retry/goal-ordering rules to make M2 advance. The deterministic policy/ladder may remain as an explicitly selected baseline for fixtures/A-B/rollback, but a fallback-only run is not Jev/System2 evidence.

## Current work

The machine-readable current work queue is `../ISSUE-ROUTING.json`.

Do not duplicate it here.
