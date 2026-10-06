# Campaign current/resume view

`runs/capability-campaign/CURRENT.json` is the one compact **generated** resume
view. It is a disposable projection, not another truth owner. Generate it at
resume and after a lifecycle/source/bookkeeping boundary:

```sh
bun tools/campaign-current.mjs --write
bun tools/test-campaign-current.mjs
```

Without `--write`, the tool only prints a finite snapshot. It reads the active
registry, checks exact campaign PID/cwd/argv identity, and asks the existing
read-only resident `report` helper once with a 2s deadline. Generation source,
build, world, body, inventory and serving identity come from that report. HOST
boot source is kept separate. Live identities override stale durable mirrors;
disagreement remains `UNKNOWN_PROVENANCE_DRIFT` until the lead reconciles it.
Freshness is explicit: inventory observation age must be within 15s. Missing,
stale, dead/recycled-PID and inactive/quiesced cases cannot become current truth.
Regenerate before trusting a cached view; no polling is required.

## Ownership and resume order

| Input/view | Ownership |
|---|---|
| Live server/resident/Kernel/VERIFY | World facts, generation, effects and SUCCESS |
| `active-run.json` | Campaign registry; exact identity must match live truth |
| `CURRENT.json` | Generated bounded view; no independent authority or hand edits |
| `state.json` | Historical campaign/attempt evidence and scoreboard; current fields are historical mirrors/hints |
| `P-SERIES.md` | Append-only causal history, read on demand |
| `STATUS.md` | Legacy/non-authoritative archive pointer |
| Crash handoff | Orientation hint, read after current truth |

Resume with AGENTS and git, then registry/process/generation truth and CURRENT.
Read large state/P-SERIES sections only when the current causal lane needs that
history. Current inventory/frontier is never inferred from historical rung
labels. The snapshot exposes scoreboard claims as historical and does not
grant Nether success from a dimension string or a durable boolean.

## Lossless history checkpoints

```sh
bun tools/campaign-current.mjs --archive-history UNIQUE_LABEL --write
```

This seals exact `P-SERIES.md`, `state.json` and old `STATUS.md` bytes in
`history/UNIQUE_LABEL/`, plus a SHA256/byte-count manifest. Existing archives
cannot be overwritten. STATUS becomes a small legacy pointer only after its
original bytes are preserved. P-SERIES remains append-only at its current
path; state remains intact. The campaign-run pruner only operates under
`runs/portal-p*`, so these `history/` archives are outside its targets.

No ledger rotation or destructive pruning is introduced. If rotation is later
needed, it requires lossless immutable segments, a complete index, reference
and prune-tool updates, and proof that every former byte is retained. Archive
or metadata work is **D/C, LOCAL_ONLY**, with no Mission delta or conversion
debt reset.
