# M3 acceptance runbook — one command, one bundle

Canonical procedure for accepting an M3 run (`nether_reached` + `ender_eye >= 12`)
on a frozen SHA. The command surface is `tools/m3-acceptance-bundle.mjs`; this file
is the operator-facing summary. `bun tools/m3-acceptance-bundle.mjs --help` is the
same contract from the tool itself.

> **A run is accepted from ONE artifact, not from a conversation.** The bundle
> carries the canonical gate result, the regenerated artifact (with its operator
> decision premise and evidence classes) and the #436/#437 metrics, plus the exact
> argv and captured output of every step.

## 0. Preconditions

```text
frozen SHA          the tree that PRODUCED the run (--root), not the tree you read this in
exact runId         run-<base36>-<base36>; there is no "latest run" shortcut
bun 1.4.2+          bun install --frozen-lockfile in the checkout you run the tool from
```

Do not run the bundle against the shared main tree while the resident runs from a
worktree: `--root` must name the tree that owns `buddy-driver/buddy.log`,
`buddy-driver/logs/jev/decisions.jsonl` and `buddy-driver/data/resident/`.

`tools/m2-gate.mjs` takes the same `--root <resident-tree>` and resolves the run's
log, snapshot dir, decisions and authority stream from it. By default it also treats
this repository's other git worktrees as declared resident homes (newest resident
evidence first), so a run's own evidence is findable without naming a private path;
`--no-discover` restricts it to the declared root alone. Every candidate stays
runId-scoped, and the file that answered is reported on the `m2_evidence_roots:` line.

## 1. The command

```bash
cd <frozen-sha-checkout>
bun install --frozen-lockfile

bun tools/m3-acceptance-bundle.mjs \
  --run <runId> \
  --root <resident-tree> \
  --environment <operator-environment.json> \
  --evidence-class live
```

Everything it writes lands in ONE directory (default
`<root>/runs/m3-live/acceptance-bundle-<runId>/`):

```text
bundle.json              the whole bundle, self-contained (includes the artifact document)
bundle.md                reviewer summary: one row per condition, verdict first
artifact-<runId>.json    the regenerated tools/milestone-run-artifact.mjs artifact
metrics.json             the tools/skill-closure-metrics.mjs report (#436/#437)
commands/NN-<id>.txt     exact argv-equivalent step + captured output
```

Exit codes: `0` every required condition PASS (and gate/artifact agree), `1` the
canonical gate FAILed, `2` UNKNOWN / missing input / contradiction. **A bundle is
still written on exit 2** — that is the point: the undecided condition is named.

## 2. Read the bundle in this order

1. `bundle.md` → `VERDICT` line + the condition table.
2. `M3.ender_eye_ready`, `M3.model_authority`, `M3.nether_reached` — the three
   contract conditions, each with exactly one authoritative source
   (`tools/m3-gate.mjs`, the evaluator `MILESTONE-CONTRACT.json` names for M3).
3. `M2.premise` — what the recorded operator decision covers for THIS run:
   `thisRunMust: inherit|build`, the decision's own `runScope` and its verbatim
   `scope`. The M2 gate verdict is never rewritten and an operator decision never
   turns an UNKNOWN into a PASS.
4. `evidence.acceptance` — the HOST `acceptance-<runId>.json` class. Absent stays
   absent, with the writer and the safe triggers named; it never asserts a milestone.
5. `consistency[]` — `gate_vs_artifact_conditions` must be `OK`. A contradiction is
   reported as UNKNOWN (exit 2), never reconciled towards PASS.
6. `residual[]` — what still needs a live run.

## 3. The HOST acceptance record (evidence class `acceptance`)

`buddy-driver/agent-runner.mts` `writeAcceptance()` writes
`buddy-driver/data/resident/acceptance-<runId>.json` on: a committed generation
reload, `control:freeze`, `control:resume`, `control:reground`, the read-only
`acceptance` control query, and a clean shutdown. It is **not** written at boot, so
a run that has hit none of those has no record yet.

To make it exist for the current run deterministically without disturbing the run,
send the one read-only query that also refreshes it:

```bash
printf '{"id":"acceptance-refresh","cmd":"acceptance"}\n' \
  | socat - UNIX-CONNECT:<root>/buddy-driver/data/resident/control.sock
```

`freeze` (reversible) also writes it but changes actuation availability; a clean
shutdown writes it but ends the run. **No tool may create this file** — every field
is live host state, and `tools/m3-acceptance-bundle.mjs` deliberately refuses to.
If it stays absent, the bundle reports it as a non-blocking named class unless you
pass `--require-acceptance`, which makes it a blocking gap (exit 2).

## 4. Why the bundle passes `--control-socket` at most once

A gate invoked with a live `report` reply brackets the current run's window with
`now`; the same gate invoked file-only refuses an unbounded window
(`run_window_unbounded`). Two separate invocations of the same gate can therefore
legitimately disagree about `model_authority` for the same run. The bundle reads the
socket binding **once** and pins it into both the gate and the artifact, then asserts
they agree — so a delivered bundle cannot contain two answers for one condition.

Use `--no-control-socket` for a fully deterministic file-only bundle (fixtures,
reviews, archived evidence).

## 5. Fixtures and offline testing

```bash
bun run m3-acceptance-bundle-test   # synthetic trees only: never a live PASS
bun run m3-gate-test
bun run m2-gate-test
bun run m2-chain-rehearsal-test
bun run milestone-run-artifact-test
```

A synthetic run can produce `PASS`, but never `liveAcceptance: true`: that requires
`--evidence-class live` **and** the objective live signals (host lock present, a HOST
acceptance record present, the run's BOOT SHA equal to the tree HEAD).

## 6. Residual (honest limits)

- The bundle decides M3 from run-scoped evidence; it cannot decide M2 for a run that
  inherited its portal. That needs an operator decision scoped to the run's own
  `runId` — the bundle reports the premise and refuses to invent one.
- The HOST acceptance record cannot be produced offline.
- `--evidence-class` is an operator declaration; the bundle records it next to the
  objective live signals instead of trusting it.

## 7. Clean-run requirement (new seed / new world / no assists)

The bundle decides the milestone; it cannot see whether the WORLD was a clean
world. The operator requirement is that the final M3 PASS is proved on a NEW seed
/ NEW world with NO assists (`keepInventory` and friends), so an M3 PASS from the
current world (`level-seed=2024`, `keep_inventory=true` in all three dimensions,
`advance_time=false`, granted supplies, summoned mobs, flooded terrain) is not an
M3 acceptance. Read `CLEAN-RUN-ACCEPTANCE.md` for the exact ordered procedure.
Preparation must run from the fresh frozen checkout with `--root "$PWD"`; the
prep tool checks that checkout's HEAD equals the resolved source SHA and prints
the resident command for that same tree. It stages `server.properties.clean`,
never copies it over the shared `server.properties`. After stopping the old
resident and server, start Leaf with `--config <staged-properties> --universe
<container> --level-name <descriptor-level>`, verify the new seed/rules, then
start the resident from that frozen checkout with
`BUDDY_SERVER_PROPERTIES_PATH=<staged-properties>` so HOST seed attestation
reads the same config.

```bash
cd <frozen-checkout>
bun tools/clean-run-prepare.mjs --environment tools/fixtures/m3-clean-environment.json \
  --root "$PWD" --dry-run                     # stage plan; no server control
# Review the plan and operator-commands.txt, then apply the same plan:
bun tools/clean-run-prepare.mjs --environment tools/fixtures/m3-clean-environment.json \
  --root "$PWD" --apply
# ... run the attempt on the frozen SHA ...
bun tools/clean-run-gate.mjs \
  --environment <container>/m3-clean-run/environment-resolved.json \
  --bundle-dir <root>/runs/m3-live/acceptance-bundle-<runId> --run <runId> \
  --out <root>/runs/m3-live/acceptance-bundle-<runId>   # writes clean-run.json/.md next to the bundle
```

`CLEAN_RUN_M3 status=ACCEPTED` = descriptor CLEAN + run evidence consistent + this
bundle's own `PASS` + `liveAcceptance: true` + `--evidence-class live`. The gate
never re-judges a milestone and never modifies `bundle.json`; it turns an assisted
world into `NOT_ACCEPTED` even when `tools/m3-gate.mjs` legitimately PASSes it
(`bun run clean-run-harness-test` proves exactly that).
