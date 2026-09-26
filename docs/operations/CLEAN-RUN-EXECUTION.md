# CLEAN-RUN EXECUTION — the ordered steps for the real M3 attempt

**Requirement, verbatim:** *「M3達成はnew seed new world、keepinvなどの補助ゼロで証明すること。実験は今のワールドで良い。」*

`CLEAN-RUN-ACCEPTANCE.md` is the recipe and the descriptor reference. This file is
the **execution order**: the exact commands, the fail-closed checks a reviewer
makes, and what is still unverified until a server is actually booted.

Status of this lane: the staged tree below was produced as a **rehearsal into a
scratch container** (`--server-root /home/s0u7a/mc-server/m3-clean-run-rehearsal`),
so the live world/properties were never touched. Step 2 of the real attempt
re-stages into the real container `/home/s0u7a/mc-server`. **Do not boot the
rehearsal tree**: the descriptor names `/home/s0u7a/mc-server` as the world
container. A rehearsal must not create its level under a scratch root or attest
the live world's seed.

**Do not name a rehearsal container `<container>/m3-clean-run`.** That path is not
free: the real attempt's run directory is *exactly* `<container>/m3-clean-run`, so a
rehearsal staged there puts a nested `m3-clean-run/` + `m3clean-b1/` inside the live
run directory the reviewer will read, and a copy of the secret-bearing
`server.properties`. Use a distinct name (`m3-clean-run-rehearsal` here).

Every server / resident start-stop in this file is an **operator action (H4)**.
No harness tool performs one.

```text
rehearsal facts (this lane, all verified offline)
  frozen sha        35638640e842595f5d8a100774a2273ccfddf49b   (latest origin/main 67388ac + task/clean-run-harness 1ff9dfb)
                    the REHEARSAL froze this sha; step 1 re-resolves the lane tip
                    (docs-only commits move it, e.g. 9ce165d) and step 2 re-stages
                    whenever it changes - the descriptor must freeze the SAME commit
                    that the run boots, so never reuse a resolved descriptor across shas
  levelName         m3clean-b1          levelSeed  -4187923615481
  staged tree       /home/s0u7a/mc-server/m3-clean-run-rehearsal/  (REHEARSAL ONLY - do not boot)
  dry-run plan      11 actions, 6 guards PASS, writes nothing
  apply             9 applied / 0 unchanged ; second apply = IDEMPOTENT_NOOP (1 ledger row)
  staged-tree check 33/33 PASS (pack format, 174 mcfunction lines, frozen sha, manifest hashes)
```

---

## 1. Freeze the tree (one fresh checkout for the whole run)

```bash
# the commit the run must boot. Re-resolve it at attempt time; it must be a commit
# that contains tools/clean-run-*.mjs (task/clean-run-execute or main after merge).
FROZEN=$(git -C /home/s0u7a/mc-ai rev-parse task/clean-run-execute)

# a FRESH worktree: its data/resident must be EMPTY, so no ledger / known-resource
# memory from the live world can leak into the run (worldKey carries no seed).
git -C /home/s0u7a/mc-ai worktree add /home/s0u7a/mc-ai-worktrees/m3-clean-run "$FROZEN"
cd /home/s0u7a/mc-ai-worktrees/m3-clean-run
bun install --frozen-lockfile
git rev-parse HEAD          # must print $FROZEN
```

## 2. Prepare the clean world — dry-run first, then apply

```bash
cd /home/s0u7a/mc-ai-worktrees/m3-clean-run

# 2a. READ the plan before doing it: expect `actions=11`, 7 guards PASS, status=PLANNED.
#     --root "$PWD" is REQUIRED for a correct printed recipe: it freezes git HEAD of
#     THIS tree and makes every printed command name THIS tree. If --source-sha is
#     used without --root, the tool checks its own checkout and refuses when that
#     tree's HEAD does not match the frozen SHA.
bun tools/clean-run-prepare.mjs \
  --environment tools/fixtures/m3-clean-environment.json \
  --root "$PWD" --server-root /home/s0u7a/mc-server --dry-run

# 2b. the same argv with --apply
bun tools/clean-run-prepare.mjs \
  --environment tools/fixtures/m3-clean-environment.json \
  --root "$PWD" --server-root /home/s0u7a/mc-server --apply
```

Staged (all inside `/home/s0u7a/mc-server`, never inside `world*`):

```text
/home/s0u7a/mc-server/m3clean-b1/datapacks/m3-clean-gamerules/{pack.mcmeta,data/...}   the gamerule datapack
/home/s0u7a/mc-server/m3-clean-run/{environment-resolved.json,manifest.json,attempts.json,
                                    server.properties.clean,server-properties.diff.txt,
                                    operator-commands.txt,gamerule-verification.txt?}
```

Before 2b, confirm the two real targets are absent: `/home/s0u7a/mc-server/m3clean-b1`
(no `level.dat`) and `/home/s0u7a/mc-server/m3-clean-run` (no `manifest.json`).

Refusals are fail-closed and reuse-proof: an unfrozen SHA, a descriptor that is not
CLEAN, a protected/`world*` level name, a `level.dat` in the target, a seed already
in `attempts.json`, a bot in `ops.json`, a `server-port` that disagrees with
`serverId`. `--environment <template>` alone exits 1 (sourceSha UNSET) — that is
correct, not a bug: the template cannot authorise a run.

## 3. Stop the resident host and the server  [OPERATOR — H4]

Stop the existing resident through **its own** control socket and wait for its
process to exit. Then stop Leaf gracefully from its console and wait for that
process to exit. Both stops are operator actions (H4). Do not use a broad `kill`
or copy/replace the shared `/home/s0u7a/mc-server/server.properties`.

The staged clean file stays at
`/home/s0u7a/mc-server/m3-clean-run/server.properties.clean`. The server receives
it through `--config`; `agent-runner.mts` receives the same path through
`BUDDY_SERVER_PROPERTIES_PATH` when it writes the HOST acceptance record. This
keeps seed attestation aligned without changing shared server configuration.

## 4. Start the server on the clean config / level name  [OPERATOR — H4]

```bash
cd /home/s0u7a/mc-server
setsid --fork /usr/lib/jvm/java-21-openjdk-amd64/bin/java \
  -Xmx1G -Xms1G -DPaper.IgnoreJavaVersion=true -jar leaf-1.21.11-178.jar --nogui \
  --config /home/s0u7a/mc-server/m3-clean-run/server.properties.clean \
  --universe /home/s0u7a/mc-server --level-name m3clean-b1 \
  </dev/null >>server.log 2>&1 &
```

`start.sh` does not forward `"$@"`, hence the direct `java` form. There is **no
`--seed` flag** in this build: the seed is consumed only when `level.dat` does not
exist yet, which is exactly the prepared state. **Never pass `--bonusChest`** (there
is no properties key for it).

## 5. Console-verify the seed and every gamerule, per dimension

On the server console, and paste the raw output into
`/home/s0u7a/mc-server/m3-clean-run/gamerule-verification.txt`:

```text
list                                                       -> AI_Buddy must not be opped
seed                                                       -> must equal -4187923615481
gamerule                                                   -> overworld rules
execute in minecraft:the_nether run gamerule               -> nether rules
execute in minecraft:the_end run gamerule                  -> end rules
```

`keep_inventory` must be **false in all three listings** — the M3 route dies in the
Nether, and gamerules are per dimension in this build. Ids are the snake_case
1.21.11 ids; camelCase is rejected. A fresh world already carries the vanilla
defaults this descriptor declares, so a non-default value here means the world is
not fresh or something changed it.

## 6. Start the resident from the frozen worktree (empty durable state)

```bash
cd /home/s0u7a/mc-ai-worktrees/m3-clean-run/buddy-driver
ls data/resident            # must be empty/absent: a fresh worktree has no memory
BUDDY_SERVER_PROPERTIES_PATH=/home/s0u7a/mc-server/m3-clean-run/server.properties.clean \
  setsid --fork nohup bun agent-runner.mts </dev/null > runner.out 2>&1 &
grep -m1 BOOT runner.out    # source= must equal $FROZEN ; note the runId
```

## 7. Run the M3 attempt

Drive the body to ender_eye × 12 with nether reached under model authority.
Record the runId from the `BOOT` line; leave the resident running afterwards, so the
control socket still answers in step 8.

## 8. Refresh the HOST acceptance record (read-only query)

```bash
printf '{"id":"acceptance-refresh","cmd":"acceptance"}\n' \
  | socat - UNIX-CONNECT:/home/s0u7a/mc-ai-worktrees/m3-clean-run/packages/buddy-driver/data/resident/control.sock
```

This is the only attestation of `levelName` + `seed` (there is no `writeAcceptance()`
on the BOOT path). The runner reads the staged properties through
`BUDDY_SERVER_PROPERTIES_PATH`, so the record remains tied to the clean server
config without swapping the shared properties.

## 9. The canonical bundle, then the clean gate

```bash
cd /home/s0u7a/mc-ai-worktrees/m3-clean-run
RUN=<RUN_ID>
bun tools/m3-acceptance-bundle.mjs --run "$RUN" --root "$PWD" \
  --environment /home/s0u7a/mc-server/m3-clean-run/environment-resolved.json \
  --evidence-class live
bun tools/clean-run-gate.mjs \
  --environment /home/s0u7a/mc-server/m3-clean-run/environment-resolved.json \
  --bundle-dir "$PWD/runs/m3-live/acceptance-bundle-$RUN" --run "$RUN" \
  --out "$PWD/runs/m3-live/acceptance-bundle-$RUN"
```

## 10. Reviewer fail-closed checks (each is a FAIL, not a warning)

```text
 1 CLEAN_RUN_M3 status=ACCEPTED  and  CLEAN_RUN_RESULT status=CLEAN acceptance=ACCEPTED   (exit 0)
 2 CLEAN_RUN_ARTIFACT ... bundleVerdict=PASS liveAcceptance=true evidenceClass=live
 3 clean-run.md: run.bootSourceSha == run.bootSourceMatchesTreeHead == the frozen sha
 4 clean-run.md: run.levelNameAttested == m3clean-b1 and run.seedAttested == -4187923615481
 5 clean-run.md: run.environmentRecordIsThisDescriptor (the resolved file, sha-matched), PASS
 6 clean-run.md: run.bootInventoryEmpty (first inventory sample is {}) and run.noWorldChanges
 7 clean-run.md: run.keepInventoryBehaviour - a death settle with itemCount=0, never >0
 8 clean-run.md: run.gamerulesNotContradicted / difficultyNotContradicted / mobSpawningNotContradicted
 9 bundle.json: git.head == the frozen sha; git.dirty false (or explained in the bundle)
10 gamerule-verification.txt: seed == -4187923615481; keep_inventory false in ALL THREE listings;
   the other 57 rules at the descriptor's declared defaults; the body is not opped
11 the run's console history shows no give / tp / fill / setblock / summon / effect for this run
12 clean-run.md residual: every UNKNOWN is named and either resolved or explicitly accepted
13 exit code: 0 ACCEPTED / 1 NOT_CLEAN or NOT_ACCEPTED / 2 UNKNOWN - a non-zero exit is never "close enough"
```

Staging-time checks (run before step 3, all offline):

```bash
bun tools/clean-run-prepare.mjs --environment tools/fixtures/m3-clean-environment.json --root "$PWD" --dry-run   # actions=11, 7 guards PASS, status=PLANNED
bun tools/test-clean-run-harness.mjs                                                                             # 13/13
bun -e 'const m=require("/home/s0u7a/mc-server/m3-clean-run/manifest.json");console.log(m.target,m.guards.every(g=>g.verdict==="PASS"))'
cat /home/s0u7a/mc-server/m3clean-b1/datapacks/m3-clean-gamerules/pack.mcmeta      # min_format/max_format [94,1]
grep -c 'gamerule' /home/s0u7a/mc-server/m3clean-b1/datapacks/m3-clean-gamerules/data/m3clean/function/set_gamerules.mcfunction   # 174 = 58 rules x 3 dimensions
ls /home/s0u7a/mc-server/m3clean-b1/level.dat 2>/dev/null || echo "no level.dat: still fresh"
```

## 11. Finish the clean run without restoring shared configuration

The shared `/home/s0u7a/mc-server/server.properties` was never changed, so there
is nothing to restore. When the operator ends the attempt, stop the resident
through its control socket and stop the clean Leaf server gracefully; wait for
both processes to exit. Keep the staged descriptor, properties, verification,
and run evidence with the clean-run artifact.

## 12. Unverified until a server is actually booted (no boot happened in this lane)

```text
- that the world is genuinely generated from level-seed: only the console `seed` output plus the
  absence of level.dat at prepare time proves it (this lane proved the absence, not the generation)
- that the datapack LOADS: min/max format [94,1] is verified against the jar's version.json
  (data_major=94,data_minor=1) and the live world's own bukkit pack, but no world has executed the
  load function; its ordering against spawn preparation is untested
- that the load function's bare `gamerule <rule> <value>` line really covers the OVERWORLD
  (Minecraft semantics, not observed here); the Nether/End forms are explicit `execute in ...`
- Leaf's effective defaults for a freshly generated world: the 59-rule table was measured from
  GameRules.<clinit> + the live worlds, not from a new world's level.dat
- that spawn_mobs / spawn_monsters=true actually yields endermen and blazes at the M3 site
- that the staged config remains the effective server config throughout shutdown; the shared file is not changed by this recipe
- that keep_inventory=false actually drops the inventory on a Nether death (LADDER_INVENTORY_SETTLE)
- that bot.game.levelName reports "m3clean-b1" (levelName is client-attested, not read from properties)
- where the world is SERVED FROM: the gate attests levelName + seed, not the --universe path. Stage
  into /home/s0u7a/mc-server (step 2b) so the descriptor's worldContainer names the real container
- the resident's BOOT source / worldKey on the new world, and that no old durable memory matches
```

## 13. Why a fixture can never fake this

`tools/clean-run-gate.mjs` reads the canonical bundle's own verdict and requires
`evidenceClass=live` **and** `liveAcceptance=true` (tree HEAD + `host.lock` + the HOST
acceptance record) on top of a CLEAN descriptor:

```text
descriptor CLEAN + fixture bundle (M3 gate PASS)                       -> CLEAN_RUN_M3 NOT_ACCEPTED (exit 1)
descriptor CLEAN + --evidence-class live but no host.lock / tree HEAD  -> NOT_ACCEPTED (liveSignals named)
descriptor CLEAN and no bundle at all                                  -> CLEAN_RUN_M3 UNKNOWN   (exit 2)
descriptor CLEAN + gate PASS + liveAcceptance=true + evidenceClass live -> ACCEPTED             (exit 0)
```

The last line needs the three live signals; a fixture that fabricates them proves
the wiring and nothing about the world.
