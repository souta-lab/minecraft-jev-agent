# M2 run-scoped evidence — does THIS run build/light/verify the portal?

Artifact owner: `tools/m2-gate.mjs` + `tools/test-m2-gate.mjs` (this lane).
Question answered: **from artifacts alone, did one run build, light and verify the
Nether gate?** Answer for the current live run: **no — the run inherited a portal
that already existed; it did not build one. Verdict UNKNOWN / `inherited_portal`.**

This file is a run artifact (the `runs/` tree is normally gitignored; this single
report is force-added so the PR carries the evidence).

---

## 1. What the gate requires for a PASS (`tools/m2-gate.mjs`)

`--run <runId>` is mandatory; `<runId>` must match `^run-[A-Za-z0-9-]+$`. Every
fact is bound to that single run.

**Evidence sources (at least one must be R-bound and non-empty):**

| Source | Binding rule |
| --- | --- |
| run-scoped snapshot `m2-snapshot-<R>.json` in `--snapshot-dir` | `record` must be `m2-snapshot` and body `runId` must equal `R` |
| resident log `--log` | a `BOOT ... runId=R` line opens R; lines after it belong to R until the next BOOT. A marker that merely carries `runId=R` without a real BOOT boundary is refused (`run_boundary_missing`). |

**Four gameplay stages, all from R-bound markers:**

1. `diamond_ready` — an R inventory sample with `diamond >= 3` **and** an R
   inventory sample with `diamond_pickaxe >= 1`.
2. `portal_materials_ready` — an R inventory sample with `flint_and_steel >= 1`
   **and** one with `obsidian >= 10`.
3. `portal_built` — inside **one** source's ordered portal events:
   `PORTAL_BLOCK_PLACED` then later `PORTAL_FRAME_READY shape=ok blocks>=10`
   (10 = the 10 edge blocks).
4. `portal_lit` — after that frame: `PORTAL_LIT` whose `dimension` normalizes to
   `minecraft:overworld` (a `PORTAL_LIT` with no dimension field does **not**
   count as overworld), then later `PORTAL_VERIFIED=true`.

**Real-authority requirement (same R), checked only when all four stages pass:**

- decisions window (bracketed by R's BOOT) has `>=1` `source=jev` decision and
  `0` fallback decisions;
- generation reports `policyKind=typesafe`, `policyModel=typesafe-ai/jev`,
  `plannerMode=llm`, `deterministicFallbackEnabled=false`;
- `>=1` model-authored System2 authority decision and `>=1` System2 portal plan.
- The live control-socket `report` keyed by R is the strongest binding; the
  generation log (`runner.out`) is the file fallback and needs a bounded window.

**Known failure → FAIL (exit 1):** `PORTAL_FRAME_READY shape=bad`,
`PORTAL_LIGHT_REFUSED`, `PORTAL_VERIFIED=false`.

**What a run that inherits a pre-existing portal legitimately lacks:** the whole
`PORTAL_BLOCK_PLACED → PORTAL_FRAME_READY shape=ok → PORTAL_LIT(overworld) →
PORTAL_VERIFIED=true` chain — i.e. exactly the markers that make `portal_built`
and `portal_lit` PASS. It may additionally lack `portal_materials_ready` if it
resumed past the rung. `diamond_ready` can still be PASS from the inherited
inventory. `PORTAL_TRUTH verified=true source=live-world` (live world / durable
memory truth) and `PORTAL_FRAME_PROGRESS blocks=10` (grounding saw the existing
frame) are **not** gate evidence.

---

## 2. Case (b): inherited portal — before and after this change

Semantics are unchanged: a PASS still requires the full run-scoped chain. The
change only names case (b).

**Before** — `PORTAL_TRUTH` was not parsed at all, so a run whose portal came
from live-world / durable memory reported the same anonymous reason as a run with
no portal evidence:

```
M2_RUN_RESULT status=UNKNOWN reason=m2_stages_incomplete:portal_materials_ready,portal_built,portal_lit ...
```

**After** (`tools/m2-gate.mjs`):

- `PORTAL_TRUTH` is parsed (`{ verified, reason, source }`) and added to
  `PORTAL_MARKERS`;
- `detectInheritedPortal(events, chain)` treats as an inheritance claim either a
  `PORTAL_TRUTH verified=true` (live-world / durable-memory verdict) or a
  `PORTAL_VERIFIED=true` with **no** `placed → validated-frame` chain;
- when R has such a claim and `framePass === false`, the verdict is
  `status=UNKNOWN`, `code=2`, `reason=inherited_portal` — never PASS — with the
  missing stages still reported:

```
m2_inherited_portal: true observations=1 kinds=live_world_truth
m2_missing: portal_materials_ready,portal_built,portal_lit
M2_RUN_RESULT status=UNKNOWN reason=inherited_portal ...
```

`--json` carries `inheritedPortal: { detected, observations[] }` and
`facts.inheritedPortal` / `facts.missing`.

The gate is **not** weakened: a run that emits its own real chain still PASSes
even if a `PORTAL_TRUTH` line is also present (`detectInheritedPortal` returns
`null` once `chain.frameVerified === true`). Fixtures 24–29 in
`tools/test-m2-gate.mjs` cover the live-run shape, the chainless
`PORTAL_VERIFIED=true` shape, the do-not-block-a-real-chain direction, and the
`verified=false` negative.

---

## 3. Live verdict for the resident's current run

| Field | Value |
| --- | --- |
| runId | `run-muaxgdyk-15kc9` (bound by the single BOOT in `buddy.log`, and confirmed by the read-only control-socket `report`) |
| source SHA (BOOT) | `7164b92586fec83c340f5ce874dd81416d4247b2` — `fix(obsidian): name-scan obsidian so collect:obsidian has a grounded route (#322)`; an ancestor of current `origin/main` `d8d53c2` |
| host | `pid=1939257`, `runtime=bun 1.4.2`, `bundle=none`, `contractVersion=3`, `schemaVersion=3`, `worldEpoch=1`, worldKey `127.0.0.1:25565\|minecraft:overworld\|1` |
| difficulty / mobs | `difficulty=normal`, `spawn-monsters=true`, `spawn-animals=true`, `spawn-npcs=true`, `gamemode=survival`, `pvp=true`, `level-name=world`, `level-seed=2024`, `online-mode=false` (`/home/s0u7a/mc-server/server.properties`) |
| acceptance record | `mode=llm`, `gitCommit=d8d53c298cdebbde33a14f20e43136263269c666`, `generationHash=e6be1812c804`, `generationId=gen-muayzjsm-fl6t39`, `goalComplete=false`, `wedge=false`, `reloads=8`, `reconnects=4` |
| evidence sources | `log` only — `data/resident/m2-snapshot-run-muaxgdyk-15kc9.json` was announced by `M2_SNAPSHOT_INIT` but does not exist on disk |
| gate command | `bun tools/m2-gate.mjs --run run-muaxgdyk-15kc9 --log <live>/buddy.log --snapshot-dir <live>/data/resident --decisions <live>/logs/jev/decisions.jsonl --runner-out <live>/buddy.log --control-socket <live>/data/resident/control.sock` |

**Verdict line (exit 2):**

```
M2_RUN_RESULT status=UNKNOWN reason=inherited_portal runId=run-muaxgdyk-15kc9 diamond=PASS materials=UNKNOWN frame=UNKNOWN lit=UNKNOWN
```

Supporting output:

```
m2_evidence: valid sources=log
diamond_ready: PASS
portal_materials_ready: UNKNOWN
portal_built: UNKNOWN
portal_lit: UNKNOWN
policy: VERIFIED reason=current_m2_authority_verified
m2_facts: diamond=true diamond_pickaxe=true flint_and_steel=false obsidian=false frame=false lit=false
m2_inherited_portal: true observations=1 kinds=live_world_truth
m2_missing: portal_materials_ready,portal_built,portal_lit
```

Policy facts (from the socket report, keyed by runId): `policyKind=typesafe`,
`policyModel=typesafe-ai/jev`, `plannerMode=llm`,
`deterministicFallbackEnabled=false`, `jevDecisions=1263`,
`fallbackDecisions=0`, `system2ModelDecisions=10`, `system2PortalPlans=5`.
So the run's *authority* was real; its *portal build chain* is what is missing.

### Exact marker lines relied on (`<live>/buddy.log`)

```
1:   BOOT pid=1939257 runId=run-muaxgdyk-15kc9 source=7164b92586fec83c340f5ce874dd81416d4247b2 runtime=bun runtimeVersion=1.4.2 bundle=none milestone=null generations=0 reloads=0 contractVersion=3 schemaVersion=3 revision=1 worldEpoch=1 worldKey={...}
8:   M2_SNAPSHOT_INIT enabled=true runId=run-muaxgdyk-15kc9 dir=.../data/resident path=.../data/resident/m2-snapshot-run-muaxgdyk-15kc9.json
12:  LADDER_RESUME rung=ender_pearls rungIndex=13 reason=inventory-resume invEmpty=false inventory={"apple":1,"diamond":3,"diamond_sword":1,"diamond_chestplate":1,"diamond_leggings":2,"birch_sapling":1,"dirt":7,"diamond_pickaxe":1,...}
15:  GENERATION_READY id=gen-muaxgeg2-2krjz3 rungIndex=13 rungId=ender_pearls goals=[...]
21:  GENERATION_START id=gen-muaxgeg2-2krjz3 trigger=spawn rung=ender_pearls rungIndex=13 generations=1
23:  PORTAL_FRAME_PROGRESS blocks=0 source=system2-grounding
40:  PORTAL_TRUTH verified=true reason=status source=live-world
116: PORTAL_TRUTH verified=true reason=status source=live-world
172: PORTAL_TRUTH verified=true reason=status source=live-world
239: PORTAL_TRUTH verified=true reason=status source=live-world
338: PORTAL_TRUTH verified=true reason=status source=live-world
814: PORTAL_FRAME_PROGRESS blocks=10 source=system2-grounding
1021: PORTAL_FRAME_PROGRESS blocks=10 source=system2-grounding
1615: PORTAL_FRAME_PROGRESS blocks=10 source=system2-grounding
2155: PORTAL_FRAME_PROGRESS blocks=10 source=system2-grounding
```

- `PORTAL_BLOCK_PLACED` count in the whole log: **0**
- `PORTAL_LIT` count: **0**
- `PORTAL_VERIFIED=<true|false>` count: **0**
- `diamond_ready` PASS comes from `LADDER_RESUME`/`INVENTORY` samples containing
  `"diamond":3` and `"diamond_pickaxe":1` (e.g. lines 12 and 42).
- `portal_materials_ready` UNKNOWN: **0** inventory samples contain `obsidian`
  or `flint_and_steel` — the run resumed above that rung and never held them.
- `MILESTONE` frontier names observed: `ender_pearls` and `blaze_rods`
  (rung index 13). The `nether_portal` rung is already behind this run.

IMPLEMENTED basis for `PORTAL_TRUTH`
(`buddy-driver/generation-entry.ts`, live worktree, read-only):

```
890:  const refreshLiveFacts = (reason: string): void => {
899:    const liveVerified = syncPortalSiteMemory(reason)
900:    const next = liveVerified.length > 0
901:    if (next === world.portalVerified) return
902:    world.portalVerified = next
903:    ctx.log('PORTAL_TRUTH', { verified: next, reason, source: 'live-world' })
```

So `PORTAL_TRUTH verified=true source=live-world` is the resident reporting that
the live world / durable site memory already holds a verified portal. It is a
truth observation, not a build chain.

---

## 4. What the resident must do for a case (a) PASS on a future run

A future run must produce the **whole chain inside one runId**:

1. Start with the `nether_portal` rung unmet so the ladder actually performs the
   build/light/verify actions (today `PORTAL_TRUTH verified=true` at boot comes
   from the durable verified-portal-site memory restored by
   `syncPortalSiteMemory`, #328). Practically: clear/invalidate that durable
   portal-site record and the live-world verified-site scan for the run's world
   epoch (or run in a fresh world epoch), so the rung is not already satisfied.
   Building a **fresh portal at a new site** also works and is less destructive.
2. In that same run, have the run place obsidian
   (`PORTAL_BLOCK_PLACED`), validate a frame (`PORTAL_FRAME_READY shape=ok
   blocks>=10`), hold `flint_and_steel` + `obsidian>=10`
   (`portal_materials_ready`), ignite in the overworld
   (`PORTAL_LIT ... dimension=minecraft:overworld`), and pass verification
   (`PORTAL_VERIFIED=true`) — all emitted by `netherPortalPlan.ts`.
3. Keep the real authority path for the same runId: `typesafe-ai/jev`,
   `plannerMode=llm`, no deterministic fallback decisions, and at least one
   model-authored System2 portal plan (the current run already satisfies this).
4. Re-run the gate on that runId; `inherited_portal` must be absent and the line
   must read `status=PASS reason=diamond_to_nether_gate_verified`.

Note that simply re-verifying the existing world portal with `PORTAL_TRUTH` can
never produce a PASS: the gate needs the runtime's own placement → frame →
ignite → verify chain, not a live-world truth read.

---

## 5. Commands and results

Run in worktree `/home/s0u7a/mc-ai-worktrees/m2-run-scoped` (branch
`task/m2-run-scoped`, based on `origin/main` `d8d53c2`):

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | 293 packages, exit 0 |
| `bun tools/test-m2-gate.mjs` | `m2-gate-test 29/29 PASS` (checks 1–23 = pre-existing suite, all still green; 24–29 = new inherited-portal fixtures) |
| `bun run typecheck` | exit 0 (`jev-agent` + `buddy-driver` tsc) |
| `bun run bun-residue-check` | `BUN_RESIDUE_CHECK PASS trackedFiles=327 nodeCompatibilityImports=allowed` |
| `bun run milestone-status:check` | `MILESTONE_CONTRACT status=PASS schemaVersion=1` |
| `bun run milestone-status-test` | `milestone-status-test 10/10 PASS` |
| `bun test --timeout=120000 --max-concurrency=1 ./bun-tests` | 23 pass / 0 fail |
| live gate on `run-muaxgdyk-15kc9` | `status=UNKNOWN reason=inherited_portal`, exit 2 |

## 6. Limits / open items

- The live verdict is a read of a **still-running** resident at
  `2026-09-21T08:20Z`; if later events in the same runId emit a real build chain,
  the gate must be re-run (the reason would become PASS/FAIL/`m2_stages_incomplete`).
- Evidence is log-only: the announced `m2-snapshot-run-muaxgdyk-15kc9.json` is
  not on disk, so `sources=log`.
- `runner.out` does not exist in the live worktree; the policy window was bounded
  by the runId-keyed control-socket `report` and the facts were read from
  `buddy.log` (the same BOOT/GENERATION_READY/SYSTEM2_AUTHORITY_DECISION lines).
  This is read-only and does not disturb the resident.
- `inherited_portal` is an explicit UNKNOWN reason, not a new acceptance level:
  M2 still requires the run-scoped chain for PASS.
