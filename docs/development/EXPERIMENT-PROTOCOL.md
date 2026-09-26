# EXPERIMENT-PROTOCOL.md — bounded improvement under a frozen architecture

Purpose: let a substantially weaker worker improve this repository through
**bounded experiments** without reopening architecture questions. The V4.1.2
constitution (root `AGENTS.md`) is closed; this document is the only contract a
worker needs to change product code safely.

If a change cannot be expressed as an experiment under this protocol, it is not
a bounded improvement — stop and escalate (§7).

## 1. The loop

```text
pick a scenario from §4
-> branch from an exact committed SHA (baseSha)
-> change only §3 open-zone code
-> run the scenario's command
-> emit a result record (§5 schema) per scenario execution
-> run bun test bun-tests/v412-architecture.test.ts (must stay green)
-> compare against the base record (§5 comparator)
-> KEEP (merge), REVERT (discard), or ESCALATE (stop and ask)
```

One experiment = one hypothesis = one scenario family. Do not batch unrelated
changes into one candidate; the comparator cannot attribute them.

## 2. Frozen zones — never touched by a bounded experiment

A diff that modifies any of these forces `verdict=ESCALATE` in the result
record (`frozenZoneTouched=true`); the experiment is not allowed to land:

| Path / surface | Why frozen |
|---|---|
| `packages/kernel/` | Sole authority state-transition path (`KernelCommand -> applyKernelCommand`). Semantics are constitutional. |
| `packages/jev-agent/src/reach/kernel-authority-map.ts` + `controller-transitions.ts` admit/activate/terminalize | VTR admission/commit surface. |
| `packages/jev-agent/src/minecraft/` adapter boundary | Only raw-client mutation boundary (AGENTS.md §5). |
| `AGENTS.md`, `docs/architecture/v4.1/`, `ISSUE-ROUTING.json`, `MILESTONE-CONTRACT.json` | Constitution + routing; changes are governance, not experiments. |
| `bun-tests/v412-architecture.test.ts`, `packages/jev-harness/bun-tests/`, `packages/system2-harness/bun-tests/` | The guardrails themselves. A weakened guard to get green is an anti-goal. |
| Gate thresholds (`tools/m2-gate.mjs`, `tools/m3-gate.mjs`, `tools/milestone-predicates.mjs`, `tools/m2-policy-evidence.mjs`) | Acceptance semantics; evidence must never be made easier. |
| `GENERATION_READY` / `SYSTEM2_AUTHORITY_*` / `decisions.jsonl` provenance fields | The authority-provenance contract every gate consumes. Additive fields allowed; renaming/removing fields is frozen. |
| `packages/buddy-driver/agent-runner.mts` lease/generation ownership | HOST lifecycle authority. |

The mechanical check is human judgment today: `git diff --stat` against the
table. When in doubt, treat the path as frozen.

## 3. Open zones — what a bounded experiment may change

| Zone | Examples of allowed work |
|---|---|
| Mechanical substrate internals (`executor.ts`, `state.ts`, `candidates.ts` internals) | better reachability, memory dedup, geometry fixes — same observable contract |
| Candidate ranking inside the *grounded* set | ordering heuristics; never adding/removing grounding |
| Controller in-contract tactics (`controller.ts` tick mechanics) | local recovery inside the committed contract |
| Jev prompts/projection *content* within registered heads | rewording, repacking; never a new head or new authority |
| `planner-ladder.ts` mechanics | rung predicates/goals data, deterministic helpers — the ladder is a baseline fixture, not production semantic authority |
| `mercury-system2.ts` internals | repair quality, backoff, payload shaping |
| Tests, tools, docs | always open |

## 4. Scenario registry

An experiment measures itself against deterministic scenarios. Pick the row
whose surface the diff touches; run the full row.

| Surface | Command (from repo root) |
|---|---|
| Architecture invariants (always run) | `bun test bun-tests/` |
| jev-agent behavior battery | `cd packages/jev-agent && bun test` |
| buddy-driver battery | `cd packages/buddy-driver && bun test` |
| Jev harness | `cd packages/jev-harness && bun test bun-tests/` |
| System2 harness | `cd packages/system2-harness && bun test bun-tests/` |
| Typecheck | `cd packages/<pkg> && bun x tsc --noEmit` |
| M2/M3 evidence oracles | `bun tools/test-m2-*.mjs tools/test-m3-chain-rehearsal.mjs` (each) |
| VTR Reach capability probes | `cd packages/jev-agent && bun test ./test-vtr-*.mts` |

A scenario run emits a result record (§5). Keep `runs/` artifacts; name them in
`evidence`.

## 5. Result schema and comparator

Every scenario execution writes one JSON record conforming to
`docs/development/experiment-result.schema.json`, validated by
`bun tools/validate-experiment-result.mjs <file>`.

Comparator rules (against the same scenario's record at `baseSha`):

- **KEEP** iff: status=PASS on every scenario the diff touches, the
  architecture guard stays green, every metric the scenario declares is
  equal-or-better, and `failureClass` is `none` or a class already present at
  baseSha.
- **REVERT** iff: any touched scenario regresses (FAIL where base PASSed),
  a new failureClass appears, or any declared metric degrades.
- **ESCALATE** iff: frozen zone touched, new `AUTHORITY_VIOLATION`, UNKNOWN on
  a previously-PASS scenario without an explained infra cause, or the
  hypothesis requires an interface not listed in §3.

Metrics are compared on the same SHA basis only — never compare a candidate
record against a stale base.

## 6. Failure taxonomy

`failureClass` is one of the canonical classes below. Map the first-emitted
typed marker; do not invent free-text classes:

| failureClass | Meaning | Typical markers |
|---|---|---|
| GROUNDING_REFUSAL | candidate space rejected the action (typed refusal) | `SURFACE_ASCENT_REFUSED`, `no_attack_stand`, `KERNEL_TRANSITION_DENIED stage=compile` |
| VERIFY_FAIL | action ran, postcondition not verified | `SKILL_END ... failure=verify_failed`, `PORTAL_ENTRY_ROUTE_BLOCKED` |
| LEASE_DENY | resource bundle/lease not granted | `KERNEL_TRANSITION_DENIED stage=admit`, `ACTUATION_AUTHORITY_CONFLICT` |
| STALE_FENCE | stale epoch/generation/worldKey fenced a result | `STALE_JEV_RESULT_DROPPED`, `KERNEL_TRANSITION_DENIED stage=activate` |
| BUDGET_EXHAUST | bounded retry/step budget spent | `TARGET_LOST`, `retrieval budget exhausted` markers |
| MODEL_UNAVAILABLE | provider/System2 unavailable; typed unavailable path taken | `SYSTEM2_*` timeout/unavailable lines |
| MECHANICAL_FAIL | physics/actuation failure with a valid contract | `PATH_CALLBACK ... outcome=stuck`, `PILLAR_FAIL` |
| NO_PROGRESS | ticks elapsed, no verified predicate moved | `no_grounded_threat_response`, stall observers |
| AUTHORITY_VIOLATION | an action ran without provenance; always escalates | guard/test failures, `unclassifiable` evidence |
| INFRA | fixture/environment failure, not product | socket timeouts, missing files |

## 7. Escalation

Stop and escalate when the experiment needs: a frozen-zone change, a new
authority path, a new env var/CLI switch, a schema/provenance-contract change,
or two consecutive REVERTs on the same hypothesis. Escalation output: the two
result records + the diff + one paragraph naming which frozen surface the
hypothesis depends on.
