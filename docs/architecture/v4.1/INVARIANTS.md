# V4.1 Architecture Invariants

> **PERMANENT ARCHITECTURE LOCK:** these invariants are permanent constitutional law for this repository (`AGENTS.md` PERMANENT ARCHITECTURE LOCK; checkpoint `092a5b38`). Tests may grow stricter; ownership semantics may not be relaxed or replaced.

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

V4.1.1 historical coverage is preserved in commit `d231942`. V4.1.2 supersedes the executable authority path with `kernel.test.ts`, `kernel.property.test.ts`, and the safe `model.ts` facade. Remaining adapter/live invariants still require production evidence before any Transition family is declared migration-safe.

## V4.1.1 hardening invariants

51. Resource conflict is defined by hierarchical path overlap, never raw key equality alone.
52. An exclusive parent claim conflicts with every descendant claim, and an exclusive descendant conflicts with its ancestors.
53. Resume accepts a typed `ResumeProof`; no boolean freshness override exists.
54. A resume proof must bind the same `transitionId` and `contractHash` as both state and contract.
55. `factRevision`, `registryRevision`, and `missionRevision` never regress across resume.
56. Resume proof covers every contract `requires` and `invariant` predicate at the bound revision.
57. VERIFY cannot close a runtime state using a different Transition contract even when the desired predicate is identical.
58. VERIFY evidence binding equals the runtime state's exact current binding and its fact uses that exact factRevision.
59. Preemption cannot revoke the victim's leases before explicit safe-yield acknowledgement.
60. A non-preemptible conflicting lease enters a bounded waiting phase with priority inheritance; deadline expiry does not force unsafe revocation.
61. Jev admission requires `frame.binding == decision.binding == live.binding` in addition to frame/epoch identity.
62. An irreversible effect token is invalid after world, generation, fact, registry, Mission, lease-fingerprint, or permit identity changes.
63. Effect token scope/kind must exactly match a permit in the current Transition contract.
64. ATR state mutation increments `registryRevision` through named mutation APIs.
65. ATR mutation cannot silently change `transitionId` or `contractHash` of an existing semantic owner.
66. Resume proof binding equals the current live binding exactly; merely being newer than the suspended state is insufficient.
67. Predicate evidence used for resume/VERIFY is true in the exact live world and exact live factRevision, with non-empty provenance/evidence identity.
68. Witness revision is monotonic across suspend/resume.
69. A non-preemptible claim cannot receive a lease unless it declares a finite positive maximum critical-section duration.
70. Preemption phase order is mechanically enforced: ACK -> revoke -> suspend -> grant; no phase may be skipped.
71. A safe-yield ACK received after its declared deadline remains a typed deadline violation and cannot silently authorize grant.
72. ATR initialization and replacement APIs reject duplicate semantic identity with a different contractHash, not only mutation callbacks.

## V4.1.2 production-authority kernel invariants

73. The only production-facing authority mutation is the transactional kernel reducer; V4.1.1 helper mutation is not exported by `model.ts`.
74. `contractHash` is computed from canonical semantic fields by the kernel and a modified same-hash lookalike cannot register as canonical authority.
75. Every canonical contract is runtime-deep-frozen and bound to a registered compiler at registration.
76. `requires`, `ensures`, and `invariants` are canonical contract fields and `desiredPredicate` is a declared ensure.
77. Runtime resource authority uses structured canonical ResourceIds; unknown authority domains fail closed.
78. A live lease binds owner transition, owner contract, world, generation, scheduler grant incarnation, resource, mode, and critical-section timing.
79. Only RUNNABLE ATR members may atomically acquire their complete declared canonical bundle.
80. ACTIVE `heldLeaseIds` exactly equal Lease Store ownership; every non-ACTIVE lifecycle owns zero actuation leases.
81. No ordinary lifecycle/terminal edge force-revokes a bounded non-preemptible critical section; safe yield is required.
82. Budget/deadline/VERIFY/Mission terminalization inside a bounded critical section becomes `pendingTerminalOutcome` until safe yield.
83. A pending-terminal Transition cannot issue/dispatch new effects and retains no unused ISSUED commit.
84. Resource claim normalization rejects ambiguous overlapping modes/yield semantics and never silently replaces a live bundle.
85. `resumable=false` has executable preemption semantics and cannot silently resume the same runtime continuation.
86. A preemption plan binds the full victim set, exact lease ids, requester claim fingerprint, world, generation, binding, and scheduler epoch.
87. Multi-victim preemption changes no victim until every victim has safely yielded and the entire plan revalidates at atomic commit.
88. The earliest conflicting bounded hard-yield deadline governs multi-critical safe-yield timing.
89. Priority inheritance is applied only for a live current higher-priority waiter and changes executable scheduling opportunity for the blocking owner.
90. A stale/canceled/committed preemption contributes no inherited priority.
91. Effect commit creation is kernel-owned; dispatch is single-use and `maxCount` is debited at the dispatch linearization point.
92. Every effect permit names required physical resources that are covered by the contract claim envelope; issue/dispatch require matching live leases.
93. `DISPATCHING -> UNKNOWN` never automatically returns to ISSUED; irreversible ambiguity requires authoritative reconciliation.
94. Verifier facts and witness proofs require runtime-branded trusted source capabilities; naked booleans/structural proof objects are not truth authority.
95. A trusted fact snapshot contains at most one value per predicate and cannot regress accepted observation monotonic time.
96. Witness revision is monotonic and a witness record binds contract, world, binding, relation and validator identity/version.
97. Resume validity is derived from live ATR, Mission, trusted facts, world/binding and witness store; it cannot be self-attested by caller booleans.
98. Controller capabilities are transition+contract+generation scoped; cross-transition budget debit is forbidden.
99. APPEND accepts only registered append-store resources under a live APPEND lease; operation-id replay is idempotent and id/payload collision fails closed.
100. Jev admission accepts only kernel-built current frames and grounded RUNNABLE transition/tactic ids; world/binding/epoch/frame mismatch fails closed.
101. Jev frame identity changes when authoritative facts, witnesses, lifecycle/resource conflict state, Mission, budgets/urgency or other hashed decision inputs change.
102. Audit replay reproduces exact events but returns non-authoritative state; only trusted journal recovery may create live authority from replay.
103. Full event replay comparison detects tampered event data even if the embedded command is unchanged.
104. World identity replacement invalidates old leases/effects/preemption/facts/witnesses/model frames; generation replacement preserves semantics but invalidates mechanical authority.
105. Terminal transitions retain no live lease or ISSUED/DISPATCHING effect authority and cannot be resurrected.
106. Registry/fact/Mission/scheduler revisions are kernel-owned monotonic state and cannot be caller-adjusted independently of their mutation.
107. Seeded randomized command sequences preserve all kernel invariants and deterministic semantic replay after every accepted/rejected step.

## V4.1.2 five-pass closure invariants

108. VERIFY invocation itself requires a runtime-branded verifier capability matching the contract's registered `verificationDefinition`; causal credit cannot be asserted through an untrusted structural command.
109. A preemption safe-yield ACK is invalid while that victim has an irreversible effect in `DISPATCHING` state.
110. After a valid preemption safe-yield ACK, the victim retains no ISSUED/DISPATCHING effect and cannot issue effects, debit usage, or APPEND new work before atomic preemption commit.
111. Scheduling class order is absolute: `VIABILITY > MISSION_CRITICAL > MISSION > BACKGROUND`; fairness aging, urgency, and deadline pressure cannot cross a class boundary.
112. Contract urgency is canonical, bounded, hashed semantic input; peer urgency affects scheduling without changing authority class.
113. Deadline pressure is a bounded within-class tie-break and never creates a higher scheduling class.
114. Definite effect reconciliation requires at least one current trusted verifier fact causally bound to the exact `effectCommitId`; unrelated current facts are insufficient.
115. Accepted effect-causal facts may reference only an existing same-world effect commit.
116. Runtime progress is kernel state, not an arbitrary controller counter: each report is emitted by the contract-bound registered progress evaluator with exact next revision and monotonic observation time.
117. Jev frame identity includes live effect state/usage and runtime progress revision/value/time.
118. Jev admission re-derives the live decision projection; a self-consistent old frame is rejected after any frame-relevant same-binding mutation.
119. World, scheduler epoch, and runtime binding stale fences are evaluated before generic live-frame staleness so identity failures preserve typed stale reasons.
120. `model.ts` remains a compatibility facade over the single canonical kernel and cannot reintroduce an independent authority implementation.
