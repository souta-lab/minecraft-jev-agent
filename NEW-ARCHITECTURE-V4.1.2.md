# Minecraft Jev Agent Architecture V4.1.2

## Production-Grade Executable Authority Kernel

V4.1.2 keeps the semantic architecture of V4.1/V4.1.1 — concurrent verified Transitions, persistent controllers, explicit resource/effect ownership, deterministic VERIFY, bounded Jev, sparse System2 — and hardens the executable model into one authority kernel suitable for production shadow-wiring.

It does **not** enable VTR authority in the existing Reach runtime. The migration boundary remains closed until the Mineflayer adapter/resource inventory gates pass.

## 1. Constitutional rule

The semantic/runtime authority split is:

```text
Mission / System2 / Jev / controller proposals
                  |
                  v
        typed KernelCommand
                  |
                  v
applyKernelCommand(KernelState, command)
                  |
       +----------+-----------+
       |                      |
       v                      v
  new KernelState       deterministic event(s)
       |
       v
transition-scoped adapter capability
       |
       v
Mineflayer / server side effect
```

No semantic caller directly mutates ATR state, leases, effect commits, revisions, budgets, Mission authority, trusted facts, or journal sequence.
## 2. Identity and authority

V4.1.2 preserves the key V4.1 correction:

```text
semantic contract identity
  != runtime generation
  != world/fact/Mission binding
  != resource lease incarnation
  != effect commit incarnation
```

A canonical Transition contract contains its family/class, bounded urgency, world identity, desired predicate, requires/ensures/invariants, structured claims, effect permits, budgets, progress/controller/verification/terminal definitions, and optional witness validation definition. The kernel canonicalizes and hashes these semantic fields; callers do not choose a trusted `contractHash`.

Runtime-branded capability sources are separated by role: contract compiler, verifier, witness validator, deterministic progress evaluator, Mission authority, scheduler, transition-scoped controller, dispatcher, world/runtime adapter, and journal recovery. A plain object with the same fields is not authority.

Controller capability identity includes transition id, contract hash, and generation. A controller cannot debit another Transition, dispatch another Transition's commit, or keep authority across generation replacement.

## 3. Kernel-owned state

`KernelState` owns the immutable contract store and Transition-to-contract binding; ATR lifecycle state; structured resource leases; effect commits and permit usage; accepted verified facts; witness proofs; progress records; preemption transactions; Mission frontier; append stores; budget usage; world/generation/time; monotonic fact/registry/Mission/scheduler/material/budget/lease/effect revisions; and journal sequencing.

Public state snapshots and canonical contracts are recursively frozen. Runtime provenance is additionally branded in memory, so a structurally copied state cannot be fed back into the live reducer.

`model.ts` is only a compatibility re-export of this kernel. V4.1.1's independent mutation helpers are intentionally absent from the public surface.