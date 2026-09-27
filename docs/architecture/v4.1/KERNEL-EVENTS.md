# V4.1.2 Kernel commands, events, and replay

> **PERMANENT ARCHITECTURE LOCK:** V4.1.2 is permanently locked (`AGENTS.md` PERMANENT ARCHITECTURE LOCK; checkpoint `092a5b38`). New commands/events are allowed only when authority ownership stays unchanged — never as steps toward a successor architecture.

## Authority rule

A production semantic caller does not mutate ATR, leases, effects, revisions, budgets, or journal state directly. It submits a typed command to `applyKernelCommand`. Privileged commands additionally carry a runtime-branded capability created by the HOST-side internal adapter.

## Command families

| Family | Representative commands | Authority source |
| --- | --- | --- |
| Contract | `REGISTER_TRANSITION` | registered contract compiler |
| Lifecycle / resources | `ADMIT_TRANSITION`, `ACQUIRE_DECLARED_RESOURCES`, `PAUSE_ACTIVE`, `RESUME_TRANSITION` | scheduler |
| Safe yield | `ACK_PAUSE_YIELD`, `ACK_PREEMPTION_YIELD`, `ACK_CANCEL_YIELD`, `ACK_TERMINAL_YIELD` | transition-scoped controller |
| Verification input | `ACCEPT_VERIFIED_SNAPSHOT` | registered verifier |
| Witness | `ACCEPT_WITNESS_PROOF` | contract-bound witness validator |
| Preemption | `START_PREEMPTION`, `COMMIT_PREEMPTION` | scheduler |
| Effect | `ISSUE_EFFECT` | transition-scoped controller |
| Dispatch | `BEGIN_EFFECT_DISPATCH` | runtime dispatcher |
| Reconcile | `RECONCILE_EFFECT` | registered verifier |
| Progress | `REPORT_PROGRESS` | registered contract-bound deterministic progress evaluator |
| Usage | `DEBIT_USAGE` | same transition's controller |
| Time/world/runtime | `ADVANCE_TIME`, `CHANGE_WORLD`, `CHANGE_GENERATION` | world/runtime adapter |
| Mission | `UPDATE_MISSION` | configured Mission authority |
| APPEND | `APPEND_RECORD` | transition-scoped controller + live APPEND lease |
| Deterministic closure | `VERIFY_SUCCESS` | contract-bound registered verifier capability; kernel still derives closure only from current accepted proofs |

## Event order

Each successful command emits one deterministic event with:

- global `eventSeq`;
- per-affected-transition `transitionSeqs` and primary `transitionSeq`;
- event kind and bounded data;
- a capability-free replay command.

Rejected commands emit no event and return the exact prior state.

## Replay modes

### Audit replay

`replayKernelEvents(initial, events)` re-applies capability-free recorded commands through the deterministic reducer. It validates contiguous event sequence and requires the full regenerated event to equal the recorded event, not only the event kind.

The returned snapshot is deliberately **not live authority**. `applyKernelCommand` rejects it as `UNTRUSTED_KERNEL_STATE`. This prevents an arbitrary caller from manufacturing a journal containing privileged commands and promoting replay output into a live kernel.

### Trusted recovery

`recoverKernelFromJournal(initial, events, capability)` performs the same deterministic replay, validates kernel invariants, and only then returns a live-branded state. The capability must be the internal `JOURNAL:recovery` capability.

Production restart additionally needs durable journal integrity/authenticity outside this pure model. The in-memory capability boundary is not a durable signature scheme.

## Irreversible effect crash semantics

Effect lifecycle is:

```text
ISSUED
  -> DISPATCHING       dispatch linearization recorded before/at adapter handoff
  -> OBSERVED          trusted facts reconcile OCCURRED or NOT_OCCURRED
  -> UNKNOWN           dispatch may have happened but authoritative result is unavailable

ISSUED -> REVOKED      cancellation/lifecycle loss before dispatch
ISSUED -> EXPIRED      token was never dispatched before monotonic expiry
```

`DISPATCHING/UNKNOWN` is never automatically turned back into `ISSUED`. A restart observes authoritative world state and reconciles. If the result remains UNKNOWN, the architecture refuses to invent exactly-once semantics or duplicate an irreversible action automatically.

## Deterministic terminal precedence

On a command boundary, preprocessing expires tokens and enforces budget/deadline state before the requested semantic command. Exact wall deadline is still valid because expiration is `now > deadline`; a later boundary records `DEADLINE_EXPIRED`.

If terminalization is required while a bounded non-preemptible lease is held, the kernel stores `pendingTerminalOutcome`, revokes unused effect commits, blocks new dispatch, and waits for `ACK_TERMINAL_YIELD`. The original outcome is preserved; a later ACK may record deadline violation but does not overwrite the pending outcome.

## Jev replay/stale boundary

Jev frames are kernel-built projections, not caller summaries. Admission first checks world, scheduler epoch, and runtime binding, then re-derives the live frame from current kernel state. Effect commit/usage, progress revision/value, lifecycle, leases/conflicts, facts, witnesses, Mission, budgets/urgency, recent outcomes, and Viability all participate in the frame identity. A self-consistent old frame therefore cannot survive a same-binding effect or progress mutation.
