# Definition of Done

This file defines when repository work is complete. It exists to keep these states distinct:

```text
code written != tests green != merged != verified live != issue accepted
```

A task may merge before its final evidence exists, but the issue must remain visibly open / waiting for that evidence. Never upgrade UNKNOWN to PASS because a reassuring marker or commit message exists.

## Universal gates

Every completed task must satisfy the gates that apply to its class:

1. **Scope/authority is explicit** — which subsystem and authority boundary changed is known.
2. **Implementation is landed** — when the task changes code/docs, the intended change is on current main, not only a stale lane.
3. **Required deterministic checks pass** — exact commands/results are recorded; known-red baselines use no-new-regression evidence.
4. **Evidence strength matches the claim** — a unit test cannot prove live embodied behavior; replay cannot prove a counterfactual closed loop.
5. **Repository state is reconciled** — linked issue/PR/routing state says what remains; merged work is not left looking unimplemented.
6. **No duplicate authority path is left accidentally active** — migrations identify baseline/shadow/authoritative status and rollback where relevant.
7. **Remaining gaps are explicit** — partial work is allowed; false completion is not.

## Task classes

### 1. Pure code / deterministic correctness

Examples: parser, schema validation, deterministic predicate, Minecraft-data mechanics truth, queue mutation invariant.

Done when:

```text
implementation on main
+ typecheck/static checks that apply
+ focused deterministic regression fixture
+ broader no-new-regression checks appropriate to the touched subsystem
+ issue acceptance mapped to those results
```

Live evidence is not required unless the issue explicitly asks for it.

### 2. Architecture / refactor

**Scope limit — PERMANENT ARCHITECTURE LOCK:** "architecture/refactor" work means structural work *inside* the permanently locked V4.1.2 constitution (`AGENTS.md` PERMANENT ARCHITECTURE LOCK; checkpoint `092a5b38`). It can never change authority ownership, the Kernel/Jev/System2/controller/backend split, or SUCCESS ownership, and it never produces or gates on a successor architecture.

Examples: state ownership boundary, Option/Skill contract, controller extraction, event schema.

Done when:

```text
new boundary/contract implemented or documented
+ compatibility/migration path explicit
+ authority semantics unchanged unless the issue intentionally changes them
+ focused tests for the boundary
+ dependent canonical docs/ADRs agree
+ rollout state (shadow/experimental/authoritative) explicit
```

If the architecture proposal includes later authority promotion, implementation of the schema does not by itself complete the promotion gate.

### 3. Documentation / governance / tooling

Done when:

```text
artifact exists on main
+ commands/links are valid where mechanically checkable
+ no contradictory current-policy copy is introduced
+ historical evidence is clearly separated from current operational truth
+ the artifact has one defined owner/source of truth
```

A docs-only task does not require a Minecraft live run unless the document itself claims a new live result.

### 4. Offline experiment / research

Done when:

```text
hypothesis and baseline defined
+ data/artifact produced
+ confounders and limitations recorded
+ result may be support / reject / inconclusive
+ no runtime authority is silently promoted from the experiment
```

A losing experiment can be complete. Research completion is not production acceptance.

### 5. Live/runtime defect

Examples: #78/#79-style smelt loops, listener leak, reload race, movement behavior observed on the resident.

Merge may happen after an offline regression is added, but **closure requires the live evidence named by the issue**.

Required shape:

```text
POLICY      what should happen
IMPLEMENTED what current main does
OBSERVED    bounded run-scoped live evidence
COMPLIANCE  PASS | FAIL | UNKNOWN
```

If OBSERVED is missing, compliance is UNKNOWN and the issue stays open / WAITING_LIVE.

### 6. Milestone capability

Examples: M2 iron-age completion, portal built/verified, Nether entry.

Done only when the milestone's closed-loop predicates are observed in one attributable run family, with required durability/safety invariants intact. Partial inventory, isolated action success, or unit coverage is implementation evidence, not milestone completion.

## Evidence classes and maximum claim strength

| Evidence | Can prove | Cannot prove by itself |
| --- | --- | --- |
| unit / pure fixture | local deterministic semantics | runtime integration / embodied success |
| integration fixture | module wiring under controlled inputs | real server/world behavior |
| replay | interpretation/calibration of recorded states | what the live closed loop would have done instead |
| structural smoke | contract can construct/attach | sustained behavior |
| resident reload/soak | lifecycle/durability properties exercised in process | arbitrary gameplay milestone success |
| live embodied smoke | behavior happened on a real server/world | repeatability/generalization from one run |
| closed-loop milestone | the scoped milestone completed under recorded conditions | universal reliability on unseen worlds |

## Merge-before-acceptance workflow

For work that is safe/useful to land before live proof:

```text
issue: open
implementation: landed
verification: deterministic/integration PASS
observation: UNKNOWN
compliance: UNKNOWN
routing: WAITING_LIVE
```

After the required run:

```text
observation: PASS
compliance: PASS
-> close issue
```

A failed live run creates new evidence on the existing issue first. Create a new issue only when the failure has a genuinely distinct root cause/acceptance boundary.

## Examples

### Pure contract defect

A blocked Option reaches the executable queue despite `I(o)=false`.

A pure compiler fixture can completely prove the fix if the acceptance is only about compiler output. No server run is required merely because the project is a Minecraft agent.

### #79-style runtime defect

`SMELT` once returned `status=done` with `verified=false` and no progress.

A deterministic test can prove the postcondition accounting fix, but the issue's end-to-end acceptance (`FURNACE_READY -> SMELT_DONE -> iron_ingot`) still needs the requested live closed-loop evidence. Until then: implemented, not accepted.

### #13-style lifecycle defect

A single clean listener snapshot does not prove a 20-reload soak requirement. The fixture may prove cleanup logic; the soak proves the stated sustained lifecycle claim.

## Autonomous-worker rule

Before taking new work:

```bash
bun run frontier
bun run current-status
bun run lane-guard
```

Pick only from `NOW` unless the orchestrator explicitly promotes another item. Before creating another issue, search existing open/closed issues and prefer adding evidence or a regression to the existing acceptance boundary.
