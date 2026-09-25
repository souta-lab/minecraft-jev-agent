# V4.1 Architecture Invariants

Each invariant is intended to become a pure/property/adapter test. `M` = already exercised by `model.test.ts`; `P` = required during production migration.

| ID | Invariant | Proof hook |
|---|---|---|
| I01 | At most one `EXCLUSIVE_WRITE` lease exists per resource at a scheduler epoch. | M: exclusive conflict |
| I02 | A Transition may actuate only while lifecycle is `ACTIVE`. | M: effect token currentness |
| I03 | `SUSPENDED`, `BLOCKED`, and `OBSERVING` hold no actuation resource leases. | M |
| I04 | Suspension preserves `transitionId` and `contractHash`. | M |
| I05 | Temporary lease ids and generation ids are not semantic contract identity. | M/P hash fixture |
| I06 | World server/dimension/epoch mismatch forbids resume. | M |
| I07 | Generation change requires fresh revalidation before rebind. | M |
| I08 | An older fact revision cannot authorize a newer effect/decision. | M |
| I09 | Action/mechanical completion cannot emit Transition `SUCCESS`. | API shape/P |
| I10 | Only deterministic VERIFY over the desired predicate can emit `SUCCESS`. | M |
| I11 | Verification may credit `self`, `shared`, or `external` but never invent causal authorship. | M |
| I12 | A terminal Transition cannot reacquire resources or actuate. | M/P |
| I13 | Resource bundles are granted atomically: all claims or none. | M |
| I14 | Normal acquisition never holds resource A while waiting for B. | M/deadlock property |
| I15 | Claim ordering is canonical and independent of proposal order. | M/property |
| I16 | A preemption transaction revokes the old exclusive lease before granting the new one. | M/P journal order |
| I17 | Viability preemption cannot mutate Mission predicates or another Transition contract. | P |
| I18 | Viability effects must be inside its own declared effect envelope. | P adapter guard |
| I19 | Viability resources are released after stabilization/terminal handoff. | P |
| I20 | A passive observer cannot issue Minecraft mutation calls. | P allowlist audit |
| I21 | `memory.worldModel:APPEND` accepts only merge-defined append operations. | P/property |
| I22 | Active observation that moves/looks/interacts claims the corresponding physical resource. | P |
| I23 | One Transition cannot debit another Transition's resource/risk budget. | P ledger property |
| I24 | Suspension pauses active-time accounting but not explicit wall deadline accounting. | P clock fixture |
| I25 | Every non-preemptible critical section has a finite configured bound. | P static/runtime audit |
| I26 | Jev output never directly calls an actuator or grants a resource lease. | P firewall |
| I27 | Jev cannot emit world truth or Transition `SUCCESS`. | P type/import firewall |
| I28 | A Jev result with stale frame hash/scheduler epoch/generation/fact/registry/Mission revision is dropped. | M |
| I29 | Jev candidate/tactic ids must be members of the grounded frame. | P closed-world test |
| I30 | Provider confidence/probability cannot bypass deterministic Guard/VERIFY. | P harness parity |
| I31 | Jev outage cannot invalidate already-committed mechanics that need no new semantic decision. | P outage fixture |
| I32 | New semantic ambiguity during Jev outage becomes typed blocked/policy-unavailable, not silent semantic fallback. | P |
| I33 | System2 is never invoked from mechanical-tick code. | P static import/call graph |
| I34 | System2 output cannot enter the graph until deterministic grounding and stale fencing pass. | P harness |
| I35 | An irreversible effect requires a current effect permit and current short-lived commit token. | M/P |
| I36 | Cancellation/fact revision change invalidates an unused irreversible-effect token. | M |
| I37 | Completed irreversible effects remain journaled after cancellation; cancellation cannot erase them. | P |
| I38 | Exact witness substitution cannot change desired predicate identity or effect envelope. | P |
| I39 | Background fairness aging cannot outrank a current deterministic Viability emergency. | M/P priority property |
| I40 | A runnable/background Transition cannot starve forever under a finite sequence of ordinary nonurgent peers. | M/property |
| I41 | Equal-priority preemption requires material fact change or residency expiry; every-tick ping-pong is forbidden. | P scheduler property |
| I42 | Priority inheritance ends when the blocking bounded critical section releases its resource. | P |
| I43 | OBSERVING long-running processes do not retain body locomotion merely to wait. | M/P |
| I44 | Dimension transfer revokes old-dimension leases/effect tokens before new-dimension actuation. | P portal fixture |
| I45 | World-model facts always carry world identity, fact revision, observation time, and provenance. | P schema test |
| I46 | Unknown, not-observed, stale, and sensor-error states are never silently coerced to false/zero/default. | P epistemic parity |
| I47 | Global journal event order is monotonic and each Transition's causal sequence is monotonic. | P replay property |
| I48 | Replay never re-queries Jev/System2 when an authoritative recorded decision artifact exists. | P replay harness |
| I49 | Scheduler tie-breaking is stable under identical verified inputs. | M/property |
| I50 | Runtime nondeterminism must become explicit evidence input before changing semantic scheduler state. | P replay/live comparison |

## Model coverage now

`model.test.ts` directly exercises I01, I03-I08, I10-I11, I13-I16, I28, I35-I36, I39-I40, I43, and I49. Migration phases must convert the remaining P invariants into adapter/static/live tests before claiming the corresponding production family is V4.1-conformant.
