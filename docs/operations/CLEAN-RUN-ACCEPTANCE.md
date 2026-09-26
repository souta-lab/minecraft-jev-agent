# Clean-run M3 acceptance — the recipe

**What this is.** The operator requirement is: *Nether 到達を live で証明する
(M3達成は new seed new world、keepinv などの補助ゼロで証明すること。実験は今のワールドで良い。)*
The M3 gate (`tools/m3-gate.mjs`) answers *"did this run reach the Nether and hold 12
eyes of ender with model authority?"*. It cannot answer *"was the world a clean
world?"* — the live world has `level-seed=2024`, `keep_inventory=true`,
`advance_time=false` in the overworld, operator-granted supplies, summoned mobs
and flooded terrain, and an M3 PASS there is worthless as M3 evidence.

This document is the **ordered procedure for one clean attempt** and the reviewer
checklist for its evidence. It is a recipe, **not a claim of success**. The current
operator descriptor names `m3clean-c1`, seed `4500764503965322344`; the preparation
manifest must record that no `level.dat` existed before first boot. After boot,
`level.dat` is expected, and final acceptance must bind the same run's HOST world
name/seed and BOOT source SHA to the descriptor. Earlier experimental worlds are
separate and are not evidence for this attempt.

Components:

```text
/home/s0u7a/mc-server/m3-clean-run/environment-m3easy-template.json   active fresh c1 descriptor (read-only input template)
tools/clean-run-environment.mjs            descriptor schema + clean validator + run-evidence checks
tools/clean-run-prepare.mjs                offline preparation of the clean world (--dry-run / --apply)
tools/clean-run-server-launch.mjs           Leaf/JVM/JAR argv attestation + allowlisted private console relay and stdout capture
tools/clean-run-console-capture.mjs         run-bound read-only console query and response capture
tools/clean-run-resident-control.mjs        legacy resident's native Unix-socket quit request and HOST-lock release wait
tools/clean-run-acceptance-refresh.mjs      native Unix-socket acceptance refresh and run/source verification
tools/clean-run-runner-output.mjs           inactive-only immutable archive rotation + fresh owner-only runner.out creation
tools/clean-run-gate.mjs                   the clean verdict, combined with the canonical bundle
tools/test-clean-run-harness.mjs           18 offline checks (assisted descriptors are refused)
runs/m3-clean-measure/                     read-only measurement that grounds the gamerule table
```

---

## 1. The descriptor: every field, and why it is there

`/home/s0u7a/mc-server/m3-clean-run/environment-m3easy-template.json` is **one file with two jobs**: it is the
`--environment` record `tools/m3-acceptance-bundle.mjs` feeds to the artifact
(`readEnvironmentFile` reads `values`, `configurationChanges`, and `worldChanges`),
and it is the clean-run premise `tools/clean-run-gate.mjs` validates after
`clean-run-prepare.mjs` freezes it. The checked-in descriptor is a reusable
template. The active c1 template stays unchanged; it describes `m3clean-c1` with
seed `4500764503965322344` and records Easy difficulty as a reasoned configuration
change. Prepare derives the pinned Java runtime policy into the resolved
descriptor and binds that resolved file to the manifest. The older checked-in
`tools/fixtures/m3-clean-environment.json` is not the active attempt input.

| field | value (template) | why it is there |
| --- | --- | --- |
| `cleanRun.milestone` | `M3` | a descriptor may only authorise the milestone it was written for |
| `cleanRun.requirement` | the operator sentence, verbatim | the acceptance criterion itself, not a paraphrase |
| `cleanRun.worldContainer` | `/home/s0u7a/mc-server` | the world CONTAINER; all three dimensions of the target world live under it. It is passed explicitly as the server's `--universe`. The resident's `BUDDY_SERVER_PROPERTIES_PATH` supplies the HOST's seed read only; it is not evidence of the Leaf process configuration. The shared `<container>/server.properties` is not changed. |
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
| `values.difficulty` / `mobSpawning` / `spawnAnimals` | `easy` / `true` / `true` for the current attempt | Easy is the lowest non-peaceful difficulty and is explicitly documented under `configurationChanges`; hostile mobs and drops remain enabled. `peaceful` is refused. **`spawn-monsters` is a DEAD key in this build** (0 occurrences in `DedicatedServerProperties`): it is declared for the artifact's environment record and written for diff readability only. Hostile spawning is actually gated by the `spawn_mobs` / `spawn_monsters` **gamerules**, which the descriptor declares and the gate judges |
| `cleanRun.runtimePolicy` | derived during prepare from `/usr/lib/jvm/java-21-openjdk-amd64/bin/java -version` | the external c1 template remains unchanged; the resolved descriptor records the exact executable, version and `Paper.IgnoreJavaVersion=true` policy |
| `values.levelName` | `m3clean-c1` for the current attempt | a NEW name: lowercase, not `world*`, not a protected name, and not a previous world |
| `values.levelSeed` | `4500764503965322344` for the current attempt | a NEW seed; prepare checks it against every earlier M3 attempt regardless of target name |
| `values.serverVersion` / `serverImplementation` / `serverId` | `1.21.11` / `leaf-1.21.11-178.jar` / `127.0.0.1:25565` | the world identity: `serverId` is half of the resident's `worldKey` |
| `values.sourceSha` | `null` → the frozen 40-hex commit | the run's BOOT `source=` must equal it |
| `values.server` | 15 non-gamerule requirements | `levelType=minecraft:normal` (flat/amplified is a tuned world), `gamemode=survival`, `forceGamemode=false`, `hardcore=false`, `bonusChest=false` (granted items), `allowCheats=false`, `generateStructures=true` (no fortresses/strongholds = M3 impossible), `spawnAnimals=true`, `botOperator=false`, `enableCommandBlock=false`, `pvp=true`, `allowNether=true`, `allowFlight=false`, `spawnProtection=0` (non-zero spawn protection forbids a non-op body from breaking blocks near spawn), `whiteList=false` |
| `values.gamerules` | the 58 in-world rules at defaults | `keep_inventory=false`, `advance_time=true`, `spawn_mobs=true`, `mob_drops=true`, `block_drops=true`, `ender_pearls_vanish_on_death=true`, `immediate_respawn=false`, `fall_damage=true`, `natural_health_regeneration=true`, `lava_source_conversion=false`, `players_nether_portal_default_delay=80`, `random_tick_speed=3`, … (full list + justification in the file) |
| `assists` | four empty arrays | granted items / summoned mobs / pre-built structures / operator world edits. Non-empty ⇒ NOT_CLEAN. Absent arrays ⇒ FAIL (absence is not a claim of none) |
| `configurationChanges` | one reasoned difficulty change for the current attempt | schema v2 carries each `setting/from/to/reason/expectedImpact` into run evidence and binds it to the descriptor hash, runId, and BOOT SHA. These server settings are separate from world edits and do not grant resources or route knowledge |
| `worldChanges` | `[]` | the artifact carries it verbatim; a clean world has no post-creation change |

The validator (`tools/clean-run-environment.mjs`) is pure and offline. It never
re-judges a milestone: it decides only whether the descriptor is admissible
(`CLEAN`), inadmissible (`NOT_CLEAN`), or undecidable (`UNKNOWN`).

## 2. Preparation (offline, no server start)

```bash
cd <frozen-checkout>            # the tree that WILL produce the run
<absolute-bun> install --frozen-lockfile
ENV=/home/s0u7a/mc-server/m3-clean-run/environment-m3easy-template.json

# 2a. see exactly what would happen. Writes nothing.
<absolute-bun> tools/clean-run-prepare.mjs \
  --environment "$ENV" \
  --root "$PWD" --dry-run

# 2b. stage it
<absolute-bun> tools/clean-run-prepare.mjs \
  --environment "$ENV" \
  --root "$PWD" --apply
```

The active descriptor currently names `m3clean-c1` with seed
`4500764503965322344`; the old b1 seed `-4187923615481` is reserved and must
remain rejected even when assigned a different level name. Preparation writes only
the resolved descriptor with the derived runtime policy; it does not mutate the
external c1 template.

`--apply` writes these staged files inside the container and nowhere else:

```text
<container>/<levelName>/                         the new world dir (empty; the server generates level.dat on first boot)
<container>/<levelName>/datapacks/m3-clean-gamerules/   the gamerule datapack (skipped loudly when datapackPackFormat is null)
<container>/m3-clean-run/<levelName>-<fingerprint>/environment-resolved.json      the descriptor the bundle AND the clean gate must both consume
<container>/m3-clean-run/<levelName>-<fingerprint>/server.properties.clean        the PROPOSED clean server.properties
<container>/m3-clean-run/<levelName>-<fingerprint>/server-properties.diff.txt     every key it changes
<container>/m3-clean-run/<levelName>-<fingerprint>/manifest.json                  descriptor/resolved-descriptor sha, world/seed/source SHA, file hashes, guards, property checks
<container>/m3-clean-run/attempts.json                  append-only attempt ledger (a reused seed is refused)
<container>/m3-clean-run/<levelName>-<fingerprint>/operator-commands.txt          the ordered commands, printed
<container>/m3-clean-run/<levelName>-<fingerprint>/ACCEPTANCE-RECIPE.md           a copy of this file, next to the evidence
```

The Leaf launcher creates `server-start-attestation.json`, a mode-0700
`server-console/` directory, a mode-0600 FIFO and output log. After BOOT, the
console capture helper creates `commands.jsonl`, `capture.json`, and the
machine-generated `gamerule-verification.txt` in that run directory.

Guarantees, printed as `CLEAN_RUN_PREPARE_GUARD` lines: the resident/operator tree
HEAD equals the frozen source SHA; no server start/stop, no deletion or move of
any file, no write inside `world` / `world_nether` / `world_the_end`, no
`--server-root` that is a world directory or inside the target world, and no
overwrite of the shared `server.properties` (`--overwrite-properties` is refused
for both M2 and M3). It refuses: a descriptor that is not CLEAN, a target world that already has a
`level.dat`, an existing level-name directory it did not stage, any seed already
reserved in this milestone's append-only ledger regardless of level name, an
unfrozen SHA, a protected level name, and an opped bot. A second `--apply` on an
ungenerated world is an `IDEMPOTENT_NOOP` only when target name, seed, original
descriptor SHA, resolved descriptor SHA, source SHA and Leaf launch identity all
match the staged manifest exactly.

## 3. The run, in order

In these commands, replace `<absolute-bun>` with the absolute Bun executable path
from the operator checkout (for this host, `/home/s0u7a/.local/bin/bun`). User
systemd services have a PATH that does not include Bun, so service commands use an
absolute executable path too.

```bash
# 3.1 OPERATOR / H4: stop the current resident through its own control socket,
#     then wait for it to exit. Stop the current Leaf server gracefully from its
#     console and wait for that process to exit before starting the clean world.
#     Do NOT copy, replace, or restore <container>/server.properties.
#     Keep this ordering: resident stopped -> server stopped -> clean server started.
#     For the managed unit, use systemctl --user stop ai-buddy-resident.service.
#     If a legacy direct resident remains, use the repository helper, which sends
#     only the implementation's native cmd=quit and waits for socket + HOST lock:
if test -S <frozen-tree>/packages/buddy-driver/data/resident/control.sock; then \
  <absolute-bun> <frozen-tree>/tools/clean-run-resident-control.mjs --root <frozen-tree>
fi

# 3.2 start Leaf with the exact service command printed in
#     <run-dir>/operator-commands.txt [OPERATOR ACTION — H4]. Use the target-specific
#     runDir printed by clean-run-prepare under <container>/m3-clean-run/.
#     The transient service keeps launcher and Leaf in one systemd cgroup, so the
#     private FIFO relay survives closing the operator terminal. Keep the
#     --console-input/--stdout-log paths and both `--` separators:
systemd-run --user --unit=ai-buddy-clean-leaf --collect --no-block \
  --property=Restart=no \
  --property=KillMode=mixed \
  --property=TimeoutStopSec=30s \
  --property=WorkingDirectory=<container> \
  -- <absolute-bun> <frozen-checkout>/tools/clean-run-server-launch.mjs \
  --environment <run-dir>/environment-resolved.json \
  --properties <run-dir>/server.properties.clean \
  --attestation <run-dir>/server-start-attestation.json \
  --manifest <run-dir>/manifest.json \
  --cwd <container> \
  --console-input <run-dir>/server-console/server-console.fifo \
  --stdout-log <run-dir>/server-console/leaf-server.log \
  -- /usr/lib/jvm/java-21-openjdk-amd64/bin/java \
  -Xmx1G -Xms1G -DPaper.IgnoreJavaVersion=true -jar leaf-1.21.11-178.jar --nogui \
  --config <run-dir>/server.properties.clean \
  --universe <container> --level-name <levelName>
#     Do not replace the wrapper with direct java, a shell background job, or /dev/null stdin. It
#     verifies --config/--universe/--level-name and staged properties before spawn,
#     then records actual /proc argv, PID, Java -version output, Java/JAR hashes,
#     config/manifest hashes and the effective Paper.IgnoreJavaVersion flag. Its private
#     FIFO relay forwards only the exact ordered read-only queries generated for this
#     descriptor; direct Leaf stdin is not available. There is no --seed flag; the staged config supplies the seed
#     on first world creation. Stop this service only after stopping the resident:
#     systemctl --user stop ai-buddy-clean-leaf.service. The shared server.properties remains untouched. The
#     wrapper refuses --bonusChest because this Leaf build has no matching properties key.

# 3.3 start the resident only after the clean server is ready, from the same
#     FROZEN checkout used by --root. This checkout must be fresh so its durable
#     state is empty. The helper checks host.lock, control.sock and the resident
#     user-systemd unit. If inactive, it preserves an existing regular single-link
#     runner.out as owner-read-only under runs/clean-run-runner-archives, then
#     creates a fresh mode-0600 runner.out. Symlinks and hard links are refused.
#     Then run the user-systemd command printed as
#     step 6 in operator-commands.txt. StandardOutput/StandardError append to this
#     exact runner.out path so BOOT, generation identity, and authority lines reach
#     the run-scoped evidence readers (`--property=StandardOutput=append:<frozen-checkout>/packages/buddy-driver/runner.out`
#     and matching StandardError); the external provider env file is not output.
<absolute-bun> <frozen-checkout>/tools/clean-run-runner-output.mjs --root <frozen-checkout>
#     The service sets BUDDY_SERVER_PROPERTIES_PATH for HOST seed reading
#     and BUDDY_SERVER_START_ATTESTATION_PATH / BUDDY_CLEAN_RUN_DESCRIPTOR_PATH so BOOT
#     can recheck the separate Leaf launch record. Seed-reader configuration alone
#     never proves Leaf startup argv/config. BOOT must report source=<the frozen sha>
#     and include a verified launch record.

# 3.4 after the resident BOOT, run the machine capture helper from the frozen
#     checkout. It sends only `seed` and per-dimension read-only gamerule queries to
#     the private FIFO, then records actual Leaf log response byte offsets and hashes.
#     It never accepts pasted responses.
<absolute-bun> <frozen-checkout>/tools/clean-run-console-capture.mjs \
  --environment <run-dir>/environment-resolved.json \
  --attestation <run-dir>/server-start-attestation.json \
  --resident-log <frozen-checkout>/packages/buddy-driver/buddy.log --run <RUN_ID>
#     All declared/queryable gamerules are checked in each required dimension.
#     A missing/ambiguous response exits UNKNOWN; any mismatch fails closed.
#     max_minecart_speed is explicitly unavailable in this world and remains UNKNOWN,
#     never represented as an observed value.

# 3.5 continue the M3 attempt that began with resident startup; progress to Nether
#     arrival + 12 eyes. Keep the runId recorded from BOOT for the final bundle.

# 3.6 refresh the HOST acceptance record with the read-only control query
#     (it is the only attestation of levelName + seed; it is NOT written at boot)
<absolute-bun> <frozen-tree>/tools/clean-run-acceptance-refresh.mjs \
  --run <RUN_ID> --source-sha <EXACT_SOURCE_SHA> --root <frozen-tree>

# 3.7 the canonical bundle, with the RESOLVED descriptor as the environment record
<absolute-bun> tools/m3-acceptance-bundle.mjs --run <RUN_ID> \
  --root <frozen-tree> \
  --environment <run-dir>/environment-resolved.json \
  --evidence-class live
#     outputs land in <frozen-tree>/runs/m3-live/acceptance-bundle-<RUN_ID>/
#     bundle.json / bundle.md / artifact-<RUN_ID>.json / metrics.json / commands/

# 3.8 the clean verdict, written NEXT TO the bundle (additive: bundle.json is never modified)
<absolute-bun> tools/clean-run-gate.mjs \
  --environment <run-dir>/environment-resolved.json \
  --bundle-dir <frozen-tree>/runs/m3-live/acceptance-bundle-<RUN_ID> \
  --run <RUN_ID> \
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
| Java runtime | `cleanRun.runtimePolicy` declares the pinned executable, exact version string, and `Paper.IgnoreJavaVersion=true`. The manifest binds executable path/hash and full `java -version` output/hash; Leaf startup, HOST and the gate recheck that identity and the effective JVM flag. |
| tree HEAD | `bundle.git.head` + `liveSignals.bootSourceMatchesTreeHead` |
| `worldKey` | `BOOT ... worldKey={"serverId":…,"dimension":…,"worldEpoch":…}` → `artifact.run.worldKey` (it is the world memory namespace: `serverId|dimension|worldEpoch`; it does NOT contain the seed) |
| level name + seed | the HOST `acceptance-<runId>.json` (`levelName`, `seed`) → `artifact.acceptance.record`; the clean gate compares both against the descriptor (`run.levelNameAttested`, `run.seedAttested`). `seed` comes from `serverSeed()` via `BUDDY_SERVER_PROPERTIES_PATH`; that is only HOST seed evidence, not proof of the server's runtime config |
| Leaf ops/launch/config | wrapper-produced `server-start-attestation.json` records the observed Leaf PID/argv, Java version/executable, JAR path/hash, effective `Paper.IgnoreJavaVersion` flag, `--config` path, safe property projection, config/manifest hashes and run-private console paths. HOST rechecks the descriptor, BOOT SHA, manifest, property bytes and live `/proc` argv into `artifact.run.boot.cleanRunServerConfig`; the gate rechecks those bindings from disk and requires `run.serverConfigAttestation=PASS` |
| gamerules | `clean-run-console-capture.mjs` records seed plus each queryable declared gamerule response from the private Leaf stdout log, including byte offsets and hashes, and writes `commands.jsonl`, `capture.json`, and `gamerule-verification.txt`. The gate checks command safety, response bytes, hashes, exact runId, descriptor SHA, startup attestation/PID, BOOT source SHA, and every dimension/rule. A pasted file cannot PASS. Rules explicitly excluded as unavailable (currently `max_minecart_speed`) remain UNKNOWN and are never described as observed |
| initial inventory | `artifact.inventory.boot` comes only from the generation-entry `initialInventory` snapshot whose `runId` and `bootSourceSha` match this run's BOOT. A periodic `INVENTORY` line cannot stand in for that starting state. `run.bootInventoryEmpty` requires this source-bound snapshot to be empty |
| model authority / no fallback | `artifact.authority.system2.identityStatus` must be `verified`: each same-run decision is joined to its `generationId`, source SHA, build hash, actual provider/model, and configured System2 provider/model. M3 requires every recorded System2 decision to count as model-backed. The run-scoped Jev decision log must contain only classifiable decisions, at least one `source=jev`, no fallback/other/unclassifiable sources, and `GENERATION_READY` must bind typesafe Jev policy with planner mode `llm` and deterministic fallback disabled. Missing, malformed, stub-only, or unknown-source evidence stays UNKNOWN |
| no world changes | `artifact.environment.worldChanges` must be `null` (`run.noWorldChanges`) |
| nothing granted | the exact-run generation-entry inventory snapshot must be empty (`run.bootInventoryEmpty`, from `artifact.inventory.boot`); a later periodic inventory sample is not starting-inventory evidence |
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
   `run.seedAttested`, `run.bootSourceSha`, `run.bootInventoryEmpty` all PASS. Check
   that `artifact.inventory.bootEvidence` says `verified` and carries the same
   `runId` and BOOT source SHA; a periodic `INVENTORY` row cannot replace it.
5. `clean-run.md` → `run.serverConfigAttestation` and `run.consoleGamerulesVerified` PASS. Inspect `capture.json`, `commands.jsonl`, and the transcript generated by the helper; confirm Leaf PID/argv/JVM version/JAR/config hashes, `Paper.IgnoreJavaVersion`, and captured `seed` equal the descriptor. The unavailable `max_minecart_speed` must remain UNKNOWN, not observed.
6. `bundle.md` / `artifact-<runId>.json` → Jev is bound to the run, `authority.system2.identityStatus=verified`, each System2 decision joins to its same-run generation/source/build and effective/configured provider-model identity, policy/planner facts are `typesafe` / `typesafe-ai/jev` / `llm`, deterministic fallback is disabled, and decision-source completeness is known with no fallback or unclassifiable records.
7. `bundle.json` → `git.head` == the frozen SHA, `git.dirty` false (or explained),
   `run.worldKey` is the new world's namespace.
8. `commands/*.txt` → the exact argv and captured output of the artifact, the M3
   gate and the metrics step; `clean-run.json` for the machine-readable verdict.
9. Anything `UNKNOWN` in `clean-run.md`'s residual section is a named gap: it must
   be resolved or explicitly accepted, never silently ignored.

## 6. Honest residual (what this harness cannot decide)

- **First-boot evidence is phase-bound.** Preparation must record the target's
  missing `level.dat` before the server starts. The server then generates the
  world from `level-seed`; final acceptance expects `level.dat` to exist and uses
  the run-bound HOST world name/seed plus the preparation manifest to establish
  that it is the prepared target. The operator's console `seed` output remains a
  cross-check.
- **The clean world has not been booted.** The server must generate it from
  `level-seed` on first start; that the world is genuinely new is proved by the
  absence of `level.dat` at prepare time (checked) plus the operator's console
  `seed` output, not by an automated boot.
- **The Leaf process config and console queries are captured by a run-private wrapper.**
  The gate requires the wrapper's startup record to match the live process argv,
  staged properties bytes, descriptor, prepared manifest and BOOT source. Console
  responses must match captured byte ranges in the Leaf process log and the
  machine-generated command journal. Missing or ambiguous output stays UNKNOWN;
  pasted output cannot satisfy acceptance.
- **`serverSeed()` defaults** to `<container>/server.properties`. The M3 recipe
  sets `BUDDY_SERVER_PROPERTIES_PATH` to the staged config so HOST can report the
  seed, but this does not attest Leaf startup. Only the wrapper's observed
  `--config` argv + properties hash + BOOT-bound startup record can pass the
  runtime configuration condition.
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
- **Gamerule values are per dimension.** The machine helper queries each declared
  rule in every required dimension and verifies genuine responses from the Leaf
  stdout log. `max_minecart_speed` is explicitly unavailable under this world's
  feature flags, so it is excluded from queries and shown as UNKNOWN rather than
  claimed as an observed default.
- **The live world's durable resident state** (ledger / known resources) is
  namespaced by `worldKey`, which contains no seed: a new world on the same
  `serverId` and epoch could still match old memory. The recipe avoids this by
  running the resident from a FRESH worktree of the frozen SHA.
- **The clean gate is an addition, not a replacement.** Canonical gate verdicts
  remain binding and are never re-implemented here. `tools/milestone-run-artifact.mjs`
  now carries additive schema 9 evidence: source-bound initial inventory,
  foreign-run marker filtering, and verified System2 generation/call identity.
  Those artifact changes feed the canonical gates but do not replace their
  verdicts. An M3 PASS without `clean-run.json` is still only an M3 PASS.
- Fixtures prove the wiring, not the world: the clean-run, console-capture and
  server-config tests run entirely offline under temporary fixture directories.
  Synthetic output exists only to exercise acceptance plumbing; it is not live
  evidence and cannot be used for M3 acceptance.
