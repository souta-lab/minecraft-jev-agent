# Clean-run M3 acceptance — the recipe

**What this is.** The operator requirement is: *Nether 到達を live で証明する
(M3達成は new seed new world、keepinv などの補助ゼロで証明すること。実験は今のワールドで良い。)*
The M3 gate (`tools/m3-gate.mjs`) answers *"did this run reach the Nether and hold 12
eyes of ender with model authority?"*. It cannot answer *"was the world a clean
world?"* — the live world has `level-seed=2024`, `keep_inventory=true`,
`advance_time=false` in the overworld, operator-granted supplies, summoned mobs
and flooded terrain, and an M3 PASS there is worthless as M3 evidence.

This document is the **ordered procedure for one clean attempt** and the reviewer
checklist for its evidence. It is a recipe, **not a claim of success**: the clean
world has not been booted yet (no server start in this lane), so the gamerule
mechanism and the fresh-world boot remain unverified until the operator runs it.

Components:

```text
tools/fixtures/m3-clean-environment.json   the checked-in descriptor (a TEMPLATE until the SHA is frozen)
tools/clean-run-environment.mjs            descriptor schema + clean validator + run-evidence checks
tools/clean-run-prepare.mjs                offline preparation of the clean world (--dry-run / --apply)
tools/clean-run-gate.mjs                   the clean verdict, combined with the canonical bundle
tools/test-clean-run-harness.mjs           13 offline checks (assisted descriptors are refused)
runs/m3-clean-measure/                     read-only measurement that grounds the gamerule table
```

---

## 1. The descriptor: every field, and why it is there

`tools/fixtures/m3-clean-environment.json` is **one file with two jobs**: it is the
`--environment` record `tools/m3-acceptance-bundle.mjs` feeds to the artifact
(`readEnvironmentFile` reads `values` and `worldChanges`), and it is the clean-run
premise `tools/clean-run-gate.mjs` validates. One file, so the premise and the
environment record can never be two different documents.

| field | value (template) | why it is there |
| --- | --- | --- |
| `cleanRun.milestone` | `M3` | a descriptor may only authorise the milestone it was written for |
| `cleanRun.requirement` | the operator sentence, verbatim | the acceptance criterion itself, not a paraphrase |
| `cleanRun.worldContainer` | `/home/s0u7a/mc-server` | the world CONTAINER; all three dimensions of the target world live under it. It is passed explicitly as the server's `--universe`. The resident's seed attestation reads the same staged config through `BUDDY_SERVER_PROPERTIES_PATH`; the shared `<container>/server.properties` is not changed. |
| `cleanRun.botUsername` | `AI_Buddy` | the prep step refuses if that name is in `ops.json`: command authority is the generic assist |
| `cleanRun.protectedWorldNames` | `world`, `world_nether`, `world_the_end` | the live worlds. Nothing in this harness may write inside them, and the target level name may not collide with them |
| `cleanRun.previousWorld` | `world` / `2024` + why | states exactly what the target must differ from, and records the measured assistance of the current world |
| `cleanRun.sourceSha.state` / `.policy` | `UNSET` → `FROZEN` | the run must boot EXACTLY one commit. The checked-in file deliberately carries no SHA: a stale or placeholder pin can never authorise a run, and freezing is an explicit operator act (`--source-sha`, or `--root <frozen checkout>` = git HEAD) |
| `cleanRun.gamerulePolicy.rule` | "every gamerule at its vanilla default; an omitted mandatory rule is a FAIL, not a default" | the assist rule, stated positively |
| `cleanRun.gamerulePolicy.version` | `1.21.11` | the rule names/ids are version-specific |
| `cleanRun.gamerulePolicy.defaultsSource` | measured from this build | the 59-rule default table is not authored by hand: it was read from `GameRules.<clinit>` in the running Leaf jar **and** the pure Mojang vanilla jar (59/59 identical, javap cross-check 0 mismatches) and from the live worlds' own `Data.game_rules` (58 rules). Raw evidence: `runs/m3-clean-measure/gamerule-defaults-observed.json`, `gamerules-observed.json` |
| `cleanRun.gamerulePolicy.defaults` | 59 rules | the single source of truth the gate compares the declared values against |
| `cleanRun.gamerulePolicy.requiredRules` | the 58 rules this world carries | every one is declared and judged |
| `cleanRun.gamerulePolicy.notRegisteredInWorld` | `max_minecart_speed` | registered by the build but absent from the world (its feature flag `minecart_improvements` is in the world's disabled datapack list), so the in-world command does not exist; declared, excluded from the datapack/console set |
| `cleanRun.gamerulePolicy.assistIfChanged` | one justification per rule (59) | "list the assists explicitly and justify each": a reviewer reads the reason here, and the gate fails if any declared rule has none |
| `cleanRun.gameruleScope` | `perDimension: true` + overworld/nether/end | gamerules are stored **per dimension** in this build (each `level.dat` owns its own `Data.game_rules`; the live world runs `keep_inventory=true` in all three while `advance_time=false` only in the overworld). The M3 route dies in the Nether, so a single-dimension rule set could leave `keep_inventory=true` exactly where it matters |
| `cleanRun.gameruleMechanism` | console primary, datapack secondary, `datapackFormat` = `min/max [94,1]` | Mineflayer cannot read gamerules and camelCase ids are rejected by this build. The console listings (per dimension) after first boot are the authoritative evidence; the staged datapack asserts every rule in all three dimensions at every world load. Since 1.21.9 a bare `pack_format` no longer declares data-pack support, so the pack declares `min_format`/`max_format` |
| `values.difficulty` / `mobSpawning` / `spawnAnimals` | `normal` / `true` / `true` | M3 needs hostile mobs: ender pearls and blaze rods. `peaceful` is refused. **`spawn-monsters` is a DEAD key in this build** (0 occurrences in `DedicatedServerProperties`): it is declared for the artifact's environment record and written for diff readability only. Hostile spawning is actually gated by the `spawn_mobs` / `spawn_monsters` **gamerules**, which the descriptor declares and the gate judges |
| `values.levelName` | `m3clean-b1` | a NEW name: lowercase, not `world*`, not a protected name, and not the previous world |
| `values.levelSeed` | `-4187923615481` | a NEW seed: not `2024`, not `0`, not empty |
| `values.serverVersion` / `serverImplementation` / `serverId` | `1.21.11` / `leaf-1.21.11-178.jar` / `127.0.0.1:25565` | the world identity: `serverId` is half of the resident's `worldKey` |
| `values.sourceSha` | `null` → the frozen 40-hex commit | the run's BOOT `source=` must equal it |
| `values.server` | 15 non-gamerule requirements | `levelType=minecraft:normal` (flat/amplified is a tuned world), `gamemode=survival`, `forceGamemode=false`, `hardcore=false`, `bonusChest=false` (granted items), `allowCheats=false`, `generateStructures=true` (no fortresses/strongholds = M3 impossible), `spawnAnimals=true`, `botOperator=false`, `enableCommandBlock=false`, `pvp=true`, `allowNether=true`, `allowFlight=false`, `spawnProtection=0` (non-zero spawn protection forbids a non-op body from breaking blocks near spawn), `whiteList=false` |
| `values.gamerules` | the 58 in-world rules at defaults | `keep_inventory=false`, `advance_time=true`, `spawn_mobs=true`, `mob_drops=true`, `block_drops=true`, `ender_pearls_vanish_on_death=true`, `immediate_respawn=false`, `fall_damage=true`, `natural_health_regeneration=true`, `lava_source_conversion=false`, `players_nether_portal_default_delay=80`, `random_tick_speed=3`, … (full list + justification in the file) |
| `assists` | four empty arrays | granted items / summoned mobs / pre-built structures / operator world edits. Non-empty ⇒ NOT_CLEAN. Absent arrays ⇒ FAIL (absence is not a claim of none) |
| `worldChanges` | `[]` | the artifact carries it verbatim; a clean world has no post-creation change |

The validator (`tools/clean-run-environment.mjs`) is pure and offline. It never
re-judges a milestone: it decides only whether the descriptor is admissible
(`CLEAN`), inadmissible (`NOT_CLEAN`), or undecidable (`UNKNOWN`).

## 2. Preparation (offline, no server start)

```bash
cd <frozen-checkout>            # the tree that WILL produce the run
bun install --frozen-lockfile

# 2a. see exactly what would happen. Writes nothing.
bun tools/clean-run-prepare.mjs \
  --environment tools/fixtures/m3-clean-environment.json \
  --root "$PWD" --dry-run

# 2b. stage it
bun tools/clean-run-prepare.mjs \
  --environment tools/fixtures/m3-clean-environment.json \
  --root "$PWD" --apply
```

`--apply` writes, inside the container and nowhere else:

```text
<container>/<levelName>/                         the new world dir (empty; the server generates level.dat on first boot)
<container>/<levelName>/datapacks/m3-clean-gamerules/   the gamerule datapack (skipped loudly when datapackPackFormat is null)
<container>/m3-clean-run/environment-resolved.json      the descriptor the bundle AND the clean gate must both consume
<container>/m3-clean-run/server.properties.clean        the PROPOSED clean server.properties
<container>/m3-clean-run/server-properties.diff.txt     every key it changes
<container>/m3-clean-run/manifest.json                  descriptor sha, world/seed/sha, file hashes, guards, property checks
<container>/m3-clean-run/attempts.json                  append-only attempt ledger (a reused seed is refused)
<container>/m3-clean-run/operator-commands.txt          the ordered commands, printed
<container>/m3-clean-run/ACCEPTANCE-RECIPE.md           a copy of this file, next to the evidence
```

Guarantees, printed as `CLEAN_RUN_PREPARE_GUARD` lines: the resident/operator tree
HEAD equals the frozen source SHA; no server start/stop, no deletion or move of
any file, no write inside `world` / `world_nether` / `world_the_end`, no
`--server-root` that is a world directory or inside the target world, and no
overwrite of the shared `server.properties` (`--overwrite-properties` is refused
for both M2 and M3). It refuses: a descriptor that is not CLEAN, a target world that already has a
`level.dat`, an existing level-name directory it did not stage, a reused seed, an
unfrozen SHA, a protected level name, and an opped bot. A second `--apply` on an
unstaged-but-not-generated world is an `IDEMPOTENT_NOOP`.

## 3. The run, in order

```bash
# 3.1 OPERATOR / H4: stop the current resident through its own control socket,
#     then wait for it to exit. Stop the current Leaf server gracefully from its
#     console and wait for that process to exit before starting the clean world.
#     Do NOT copy, replace, or restore <container>/server.properties.
#     Keep this ordering: resident stopped -> server stopped -> clean server started.

# 3.2 start Leaf directly with the staged properties [OPERATOR ACTION — H4].
#     start.sh does NOT forward "$@". --config selects the staged seed/config;
#     --universe and --level-name select this descriptor's new world. There is no
#     --seed flag in this build; the seed is consumed from the config only before
#     level.dat exists. The shared server.properties remains untouched.
cd <container> && setsid --fork java \
  -Xmx1G -Xms1G -DPaper.IgnoreJavaVersion=true -jar leaf-1.21.11-178.jar --nogui \
  --config <container>/m3-clean-run/server.properties.clean \
  --universe <container> --level-name <levelName> \
  </dev/null >>server.log 2>&1 &
#     do NOT pass --bonusChest (there is no properties key for it)

# 3.3 after the FIRST boot, use the server console to verify world identity:
#       list                                    -> the body's name must be allowed in
#       seed                                    -> must equal values.levelSeed
#     Paste each complete gamerule listing below its matching [dimension=...]
#     header in the prepared file:
#     <container>/m3-clean-run/gamerule-verification.txt :
#       gamerule                                -> overworld rules
#       execute in minecraft:the_nether run gamerule
#       execute in minecraft:the_end run gamerule
#     keep_inventory must be FALSE IN ALL THREE DIMENSIONS (the M3 route dies in the
#     Nether). The ids are the snake_case 1.21.11 ids; camelCase is REJECTED by this build.
#     The template binds the resolved descriptor SHA, levelName, seed and source SHA.
#     Set capturedAt when the listings are captured, then replace runId with the exact
#     BOOT runId before invoking the gate. The gate requires every declared rule in all
#     declared dimensions to match the descriptor.

# 3.4 start the resident only after the clean server is ready, from the same
#     FROZEN checkout used by --root. This checkout must be fresh so its durable
#     state is empty. The environment variable makes HOST acceptance seed
#     attestation read the staged file the server used, without changing the
#     shared server.properties.
cd <frozen-checkout>/buddy-driver && \
  BUDDY_SERVER_PROPERTIES_PATH=<container>/m3-clean-run/server.properties.clean \
  setsid --fork nohup bun agent-runner.mts </dev/null > runner.out 2>&1 &
#     the BOOT line must read source=<the frozen sha>

# 3.5 run the M3 attempt; record the runId from the BOOT line

# 3.6 refresh the HOST acceptance record with the read-only control query
#     (it is the only attestation of levelName + seed; it is NOT written at boot)
printf '{"id":"acceptance-refresh","cmd":"acceptance"}\n' \
  | socat - UNIX-CONNECT:<frozen-tree>/buddy-driver/data/resident/control.sock

# 3.7 the canonical bundle, with the RESOLVED descriptor as the environment record
bun tools/m3-acceptance-bundle.mjs --run <RUN_ID> \
  --root <frozen-tree> \
  --environment <container>/m3-clean-run/environment-resolved.json \
  --evidence-class live
#     outputs land in <frozen-tree>/runs/m3-live/acceptance-bundle-<RUN_ID>/
#     bundle.json / bundle.md / artifact-<RUN_ID>.json / metrics.json / commands/

# 3.8 the clean verdict, written NEXT TO the bundle (additive: bundle.json is never modified)
bun tools/clean-run-gate.mjs \
  --environment <container>/m3-clean-run/environment-resolved.json \
  --bundle-dir <frozen-tree>/runs/m3-live/acceptance-bundle-<RUN_ID> \
  --run <RUN_ID> \
  --gamerule-verification <container>/m3-clean-run/gamerule-verification.txt \
  --out <frozen-tree>/runs/m3-live/acceptance-bundle-<RUN_ID>
#     writes clean-run.json + clean-run.md; prints CLEAN_RUN_RESULT / CLEAN_RUN_M3
```

`CLEAN_RUN_M3 status=ACCEPTED` requires **all** of:

```text
descriptor CLEAN
+ every required run-evidence condition PASS
+ bundle.acceptanceVerdict.status === PASS          (the canonical M3 gate's own verdict, read verbatim)
+ bundle.liveAcceptance === true                    (host.lock + HOST acceptance record + BOOT SHA == tree HEAD)
+ bundle.evidenceClass === live
```

Exit codes: `0` ACCEPTED, `1` NOT_CLEAN / NOT_ACCEPTED, `2` UNKNOWN. A descriptor
with no bundle is judged as a PREMISE only (`CLEAN_RUN_M3 status=UNKNOWN`): a clean
descriptor is not an acceptance.

## 4. Where the run's identity ends up in the evidence

| fact | where a reviewer reads it |
| --- | --- |
| `runId` | `bundle.json:runId`, `artifact-<runId>.json:runId`, the filename, every `CLEAN_RUN_*` line |
| frozen SHA | `BOOT ... source=<sha>` in `buddy.log`; `artifact.run.boot.sourceSha`; the clean gate compares it to `values.sourceSha` (`run.bootSourceSha`) |
| tree HEAD | `bundle.git.head` + `liveSignals.bootSourceMatchesTreeHead` |
| `worldKey` | `BOOT ... worldKey={"serverId":…,"dimension":…,"worldEpoch":…}` → `artifact.run.worldKey` (it is the world memory namespace: `serverId|dimension|worldEpoch`; it does NOT contain the seed) |
| level name + seed | the HOST `acceptance-<runId>.json` (`levelName`, `seed`) → `artifact.acceptance.record`; the clean gate compares both against the descriptor (`run.levelNameAttested`, `run.seedAttested`). `seed` comes from `serverSeed()`, which reads `BUDDY_SERVER_PROPERTIES_PATH`; the M3 recipe points it at the same staged config passed to Leaf with `--config` |
| config (difficulty, spawn-monsters) | run-scoped `ENVIRONMENT`/`GAMERULE` markers in `buddy.log` → `artifact.environment.*` with `source: log, runScoped: true`; the clean gate compares them (`run.difficultyNotContradicted`, `run.mobSpawningNotContradicted`) |
| gamerules | descriptor values, any run-scoped marker, and the operator's per-dimension console listing in `gamerule-verification.txt`; for a console-primary descriptor, `run.consoleGamerulesVerified` must PASS after the gate binds the transcript to exact runId, resolved descriptor SHA, levelName, seed and BOOT source SHA and compares every listed rule |
| no world changes | `artifact.environment.worldChanges` must be `null` (`run.noWorldChanges`) |
| nothing granted | the run's FIRST inventory sample must be empty (`run.bootInventoryEmpty`, from `artifact.inventory.boot`) |
| keepInventory behaviour | any `LADDER_INVENTORY_SETTLE reason=death` line in the run window: `itemCount>0` ⇒ FAIL (the live world's own signal); an empty drop ⇒ positive evidence |
| clean verdict | `clean-run.json` / `clean-run.md` next to `bundle.json`, plus the `CLEAN_RUN_*` lines |

Both the descriptor path and its sha256 are checked: the artifact must have read
its environment from **this** descriptor (`run.environmentRecordIsThisDescriptor`),
so a clean premise can never be paired with a run judged against another file.

## 5. Reviewer checklist

1. `clean-run.md` → `CLEAN STATUS: **CLEAN**` and `M3 ACCEPTANCE: **ACCEPTED**`.
2. `bundle.md` → `VERDICT: **PASS**`, `evidenceClass: live`, `liveAcceptance: true`,
   and `consistency: gate_vs_artifact_conditions OK`.
3. `bundle.md` → the three M3 conditions each PASS from `tools/m3-gate.mjs`
   (`ender_eye_ready`, `nether_reached`, `model_authority`).
4. `clean-run.md` → the descriptor is the resolved one (`sourceSha` = the frozen
   commit, `levelName`/`levelSeed` = the new world); `run.levelNameAttested`,
   `run.seedAttested`, `run.bootSourceSha`, `run.bootInventoryEmpty` all PASS.
5. `clean-run.md` → `run.consoleGamerulesVerified` PASS; inspect the bound `gamerule-verification.txt` for `keep_inventory=false` and every declared default in each dimension. Separately confirm the section 3.4 console checks: `seed` equals `values.levelSeed` and the body is allowed in.
6. `bundle.json` → `git.head` == the frozen SHA, `git.dirty` false (or explained),
   `run.worldKey` is the new world's namespace.
7. `commands/*.txt` → the exact argv and captured output of the artifact, the M3
   gate and the metrics step; `clean-run.json` for the machine-readable verdict.
8. Anything `UNKNOWN` in `clean-run.md`'s residual section is a named gap: it must
   be resolved or explicitly accepted, never silently ignored.

## 6. Honest residual (what this harness cannot decide)

- **The clean world has not been booted.** The server must generate it from
  `level-seed` on first start; that the world is genuinely new is proved by the
  absence of `level.dat` at prepare time (checked) plus the operator's console
  `seed` output, not by an automated boot.
- **Gamerule values are operator-declared + console-verified.** Mineflayer has no
  run-scoped fact for most rules. The clean gate parses the saved console
  transcript, binds its metadata to this exact run and resolved descriptor, and
  checks every declared value in each required dimension. It cannot independently
  authenticate that pasted text originated from the server console.
- **`serverSeed()` defaults** to `<container>/server.properties`. The M3 recipe
  explicitly sets `BUDDY_SERVER_PROPERTIES_PATH` to the staged config used by
  Leaf, so the HOST acceptance seed matches the resolved descriptor without
  mutating shared server configuration.
- **The datapack's own execution is unverified without a boot.** Its format
  (`min_format`/`max_format` = `[94,1]`, the build's data format) and its load tag
  (`data/minecraft/tags/function/load.json`) are verified statically in this build's
  jar, and the load tag is auto-enabled even with `initial-enabled-packs=vanilla`,
  but no world has been booted, so the ordering of the load function against spawn
  preparation is untested. The console listings per dimension remain the
  authoritative gamerule evidence.
- **`spawn-monsters` proves nothing in this build** (dead key). Hostile spawning is
  gated by the `spawn_mobs` / `spawn_monsters` gamerules, and whether those actually
  yield endermen and blazes at the M3 site is only observable in the run.
- **Gamerule values are per dimension.** The gate checks the operator's console
  listing for every declared dimension and gamerule. It still cannot read a
  dimension's rule table directly; the transcript remains operator-captured evidence.
- **The live world's durable resident state** (ledger / known resources) is
  namespaced by `worldKey`, which contains no seed: a new world on the same
  `serverId` and epoch could still match old memory. The recipe avoids this by
  running the resident from a FRESH worktree of the frozen SHA.
- **The clean gate is an addition, not a modification.** `tools/m3-gate.mjs`,
  `tools/m2-gate.mjs`, `tools/milestone-run-artifact.mjs` and
  `tools/m3-acceptance-bundle.mjs` are untouched: their verdicts are read, never
  re-implemented. An M3 PASS without `clean-run.json` is still only an M3 PASS.
- Fixtures prove the wiring, not the world: `tools/test-clean-run-harness.mjs`
  runs entirely offline under `runs/clean-run-tests/` and its "simulated live"
  case exists only to exercise the ACCEPTED branch — it is not evidence.
