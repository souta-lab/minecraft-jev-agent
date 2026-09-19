# M2 evidence-gate audit — 2026-09-20

This note records why the audit branch changes the M2 evidence gate without changing runtime gameplay semantics.

## Confirmed defects in the post-#209 gate

1. **Consumable intermediate false negative**
   - M2 ends at a durable `diamond_pickaxe`.
   - Correct progression may consume `charcoal` as fuel and `iron_ingot` to craft the iron pickaxe.
   - Therefore a final snapshot cannot truthfully require `charcoal>=1 AND iron_ingot>=3 AND iron_pickaxe>=1 AND diamond_pickaxe>=1` simultaneously.

2. **Generic SMELT marker ambiguity**
   - A generic `SMELT_DONE` can be charcoal or iron.
   - Historical acceptance must distinguish `SMELT_DONE item=charcoal` from `SMELT_DONE item=iron_ingot`.

3. **Run scope is not source scope**
   - The resident `runId` is a host-process lifetime.
   - Changed-hash hot reloads can occur within the same `runId`.
   - Combining historical markers from multiple generation hashes is not one exact-source acceptance run.

4. **Milestone wrapper drift**
   - The live M2 gate requires an exact `--run`, but the machine contract/wrapper still delegated using `--since`.

## Correct split

```text
same exact run + one generation source hash

historical evidence (m2-watch):
  PREREQ_OPTION
  -> FURNACE_READY
  -> SMELT_DONE item=charcoal
  -> SMELT_DONE item=iron_ingot

terminal live state (m2-acceptance):
  diamond_pickaxe >= 1
```

`m2-live-gate` joins both children by the same exact run id. `m2-watch` returns UNKNOWN if that run contains more than one successful generation hash. `--since` remains diagnostic-only.

## Non-claims

- No M2 PASS is claimed by this audit.
- No current live run is claimed to satisfy the new gate.
- No runtime authority, planner, candidate, executor, or Option behavior is changed here.
- GitHub Actions runner-allocation failures remain infrastructure UNKNOWN, not test evidence.
