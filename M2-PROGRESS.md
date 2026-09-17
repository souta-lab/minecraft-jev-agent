# M2 (iron age) progress — SPEED PROTOCOL run
Started: 2026-09-17 ~10:14 UTC. Timebox: 45 min. Bots: AI_M2a / AI_M2b (never AI_Bot/s0u7a).

## S0 — recon (started)
- repo is /home/s0u7a/mc-ai/jev-agent (not ~/jev-agent)
- server leaf-26.1.2 on 25565 UP; s0u7a client in-world; peaceful
- target files: src/candidates.ts pickExplore (line 783), src/controller.ts stall logic (line 1367)

## S1 — typecheck + tests + wedge detector (done, implementation)
- Fixed incomplete previous-attempt wiring: GoalKind += place|smelt; executor runSmelt + runDescend;
  policy guardSmelt + guardDescend; FailureCode += smelt_error|smelt_timeout.
- `npm run typecheck` -> clean (exit 0).
- Tests: guard 12/12, gating 6/6, loop 7/7, m1 5/5.
- Wedge detector in controller: aborts on same chosen action id >5 (wedgeRepeatLimit) or goal progress 0 >60s
  (wedgeStallMs); logs `ABORT: wedge detected (...)`, stop reason=wedge.
- pickExplore already prefers nearest standable + walks toward the focused resource; move band widened to 48m
  with chained MOVE (targetBlockX/Y/Z meta) from the prior attempt.
- Launching M1 4/4 run AI_M2a --seconds 200 -> logs/m2-s1-m1/

### S1 run 1 (AI_M2a) — wedge detector proved itself
- run aborted in 4679ms: `ABORT: wedge detected (action id MOVE:p32_64_-58 chosen 6x (limit 5))`.
- root cause: pickExplore offered a standable spot ~1.0m away; the MOVE executor considers that
  already-reached (feet within 1.5m) so the bot never travelled, and the same spot was re-chosen.
- fix: pickExplore now only considers spots >1.5m away (a genuinely useful target), still preferring
  the spot that reduces distance to the focused resource.
- S2 read-only probe (AI_M2b) raw: iron_ore nearest (19,57,-61) d=13.1 adj=none columnTopSolid=62;
  deepslate_iron_ore y=7; diamond_ore (56,4,-70) y=4 d=65 + deepslate y=-5..-11; lava n=0, water n=16.
  => M2 requires vertical MINE descent (no standable adjacent to any ore under canDig=false).

## OPERATOR NOTE (from the human watching the game, 19:2x JST)
The bot has been observed **repeatedly jumping at a spot it cannot climb** — i.e. the wedge loop is still happening because the wedge detector has NOT been implemented yet. DO THIS FIRST, before any further runs:
1. Implement the wedge detector in the runner (same action id / same failure > 5 times, or progress 0 for > 60 s) -> log `ABORT: wedge detected (<reason>)` and exit immediately.
2. Ensure `MOVE_FAILURE_LIMIT` actually blacklists unclimbable MOVE targets (it did not prevent this loop).
3. Re-run only after both are in place, with `--seconds 200` (S1) / 300 (S3).
Report the S1 time and the wedge-abort counts in this file.

## OPERATOR NOTE #2 (19:21 JST) — root cause of the jump-loop
Evidence from your own S1 probe `logs/m2-s1-m1b/`:
  action order: MOVE:p32_64_-59 -> MOVE:p33_65_-58 -> MOVE:p34_65_-58 -> MOVE:b40_78_-50 x4 -> "ABORT: wedge detected" (tick 9)
  `[m1] FINAL INVENTORY={}`  -> M1 4/4 NOT achieved; the run died on an unclimbable target.
So the wedge detector now bounds the loop (good), but **selection still offers an unreachable target**.

REQUIRED FIX (do this before further runs):
1. Strengthen the pre-move reachability check: `canComputePath`/NO_PATH guard must treat a route that needs climbing **more than 1 block** (or any route the physics cannot follow with `canDig=false`) as **unreachable**, and reject that candidate at generation time (not after 4 executor attempts).
2. If the only route to a target requires >1-block climbing, either (a) do not offer it, or (b) offer the **chained MOVE** through a walkable intermediate standable spot (nearest-first explore).
3. Re-run M1 with `--seconds 200`; acceptance: 4/4 subgoals, `FINAL INVENTORY` contains oak_log>=3, crafting_table>=1, wooden_pickaxe>=1, cobblestone>=16, `llm.called==false`, and **no action id repeated more than 2 times**.
4. Report the S1 wall-clock and the wedge-abort count in this file. Then proceed to S2 (smelting + descent) and S3 (M2 ladder).

## S2 — smelting + descent capability (landed, unit-level green)
- Added executor `runSmelt` (openFurnace -> putInput/putFuel -> poll outputItem -> takeOutput -> close,
  single-action epoch/AbortController held) and `runDescend` (dig the pre-validated staircase block, then
  best-effort step onto the standable spot). Added policy `guardSmelt` / `guardDescend`; FailureCode
  `smelt_error|smelt_timeout`. Movement pathfinder stays canDig=false (descending is MINE/DESCEND only).
- GoalQueue: `place`/`smelt` kinds; smelt is inventory-counted, place completes when the item leaves the
  inventory. `planFromJson` extended with place/smelt.
- `npm run typecheck` clean. Tests unaffected: guard 12/12, gating 6/6, loop 7/7, m1 5/5.

## S3 — M2 ladder run (bounded, aborted on wedge)
- Runner `m2.mts` (cap --seconds 300) with `M2_PLAN_JSON` (14 subgoals), username AI_M2a.
- Result: `stopped=wedge success=false durationMs=65802 ticks=6`, queue advanced **0/14**.
- Raw: `VERIFIED MINE:b28_65_-56 removed=true gained=0 goal=0/3 progress=0%` (x3 more, gained=0 always).
- ABORT: wedge detected (`goal progress stayed 0 for >60000ms`).
- EXACT BLOCKER (first subgoal): birch logs ARE reachable and diggable (4 verified digs, block removed=true)
  but the drop is never collected (`gained=0`, `itemsCollected=0`, FINAL INVENTORY={}), so the
  inventory-counted `collect` subgoal cannot complete. This is the known drop-pickup limitation, now the
  binding blocker at subgoal 1. A secondary blocker: the same MOVE re-chosen on intermittent `path_stuck`.
- Earlier M1 attempts from the same spawn: nearest standable-adjacent oak is 13 blocks up a tree
  (path_stuck); the only other oaks have adj=none. Reachable trees at spawn are birch_log. Probe
  (logs/m2-s2-resource-probe.log): iron_ore nearest (19,57,-61) d=13.1 adj=none (buried -> needs DESCEND);
  diamond deepslate y=-5..-11; lava n=0.

## OPERATOR NOTE #3 (19:2x JST) — why the bot looks aimless (verified with your own logs)
Evidence (`logs/m2-s3-ladder/decisions.jsonl`):
- Jev IS driving: 10/10 decisions `source:"jev"`, real calls (latencyMs 549/629/850, inputTokens ~3.15k) — no fallback.
- Candidates show the bot mining a **birch_log trunk column** (same x,z; y ascending 65..68) plus a `MOVE` to a birch at 12.9 m.
- BUT the M2 plan's first subgoal is **`oak_log x3`** while the nearby wood is **birch_log**.

DEFECT: goal item tag (`oak_log`) does not match available wood (`birch_log`) -> chopping birch never advances the subgoal, so the bot keeps chopping and the behaviour reads as aimless.
REQUIRED FIX (before any further M2 run):
1. Generalise wood goals: a `collect` goal for wood must accept any `*_log` (oak/birch/spruce/jungle/acacia/dark_oak/mangrove/cherry/pale_oak), OR resolve the goal item to the wood type actually available during plan instantiation.
2. Count subgoal progress by that category, not by a single hard-coded item id.
3. Then re-run: subgoal 1 must complete after ~3 logs of the available type; report per-subgoal inventory.
Also confirm the plan's other items (cobblestone, iron_ore, diamond) use category/availability resolution the same way.

## OPERATOR NOTE #4 (human watching in-game, 19:3x JST) — jumping with a ceiling overhead
Observed live: the bot tries to jump even when there is clearly a block above it (no headroom), i.e. the jump cannot succeed and it loops/repeats.
This is a defect in OUR custom actuator (`walkByControls` pre-contact jump / hop recovery), not in the decision layer.
REQUIREMENTS:
1. Any jump must be gated on **headroom >= 2 blocks** above the bot (check the 1-2 blocks above the current position in the world model). No jump without headroom.
2. The hop/pinned-recovery path must not jump when headroom is insufficient — instead mark the target unreachable (`NO_PATH`-style) and let candidate selection choose another route/target; never repeat a hopeless jump (the wedge detector must not be the thing that stops it).
3. If the stock `mineflayer-pathfinder` (with correct collision shapes, which DO exist in minecraft-data 26.1) can handle steps/pits, prefer it and DELETE our actuator entirely — that removes this bug class.
4. Evidence required: a run where the bot is next to a low ceiling and (a) does not jump, (b) re-targets within <=2 attempts; plus the headroom-gate code line.

## AUDIT S0 (10:43)
- recon started: spec read (P0-1..P2 + A-H + pickup/stock-first rule); collision shapes CONFIRMED present in pc/26.1 (1168 blocks/5128 shapes); mineflayer-collectblock@1.6.0 installed; server 25565 open.

## AUDIT S1 (10:54) — implementation + tests
- Schema migrated: CORE(action,goal_progress,plan_still_valid,situation_understood)+trigger sets(danger,should_retreat,goal_blocked,strategy_change_needed); need_llm/need_replan removed; target question removed (action authoritative).
- Boolean 0.30/0.70 bands; semantic escalation strong/uncertain/consecutive. policyEpoch/candidateSetHash/currentActionEpoch/criticalStateVersion + fresh-sensor guard re-validation + critical-during-flight discard.
- Monotonic ledger confirmed; resourceClass resolver (log/planks/stone/fuel/food/pickaxe) wired into scanner+counting; replan ops continue/patch/replace/abort; wedge requires zero verified progress.
- Stock-first: mineflayer-collectblock loaded (plugin) + used before the custom nudge; headroom>=2 gate on every jump (hasJumpHeadroom).
- Docs: ARCHITECTURE.md rewritten to match code (collision shapes exist; cost measured; #4063 open-PR caveat).
- typecheck clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit A-H 8/8.
- Live run AI_A1 --fallback 61s: connected, collectblock loaded, headroom gate active (jumps=1 forcedRepositions=0), semantic escalation fired; wedge abort at 61s before first dig -> pickup line not reached (open).

## AUDIT S2 (10:58) — live A2 (AI_A1, fallback, 170s cap, wedge-stall 400s)
- PICKUP (stock-first): `[executor] stock collectblock item=birch_log gained=1` (x2); `[verify] blockRemoved=true dropObserved=true birch_log_in_inventory=3 (gained 1)`; verifiedDigs=2 itemsCollected=2. Custom nudge used only when stock hit its budget.
- RESOURCE ABSTRACTION (live F): `subgoal COMPLETE [collect 3 x log] -> [craft 1 x crafting_table] inventory={"birch_log":3}` on a birch-only world.
- MONOTONIC LEDGER (live E): logs later consumed -> `FINAL INVENTORY={"birch_planks":2,"crafting_table":1}`, completed collect stayed done, queue advanced to wooden_pickaxe.
- HEADROOM: `[executor] no jump headroom at (38,70,-35): target unreachable (no hopeless jump)` x7; jumps=0 on those; immediate re-target to other MOVE candidates (wedge later bounded it).
- WEDGE (P1-5 live): `ABORT: wedge detected (action id MOVE:p40_71_-35 chosen 6x with no verified progress (limit 5))`.
- SEMANTIC ESCALATION (live): `strong semantic signal: goal_blocked P(true)=1 >= 0.7; strategy_change_needed P(true)=1 >= 0.7; plan_still_valid low (1)`.
- Final suite: typecheck clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit A-H+P2 9/9.

## AUDIT S3 — STOCK-FIRST MOVEMENT ADOPTED + R2/R3 attempt
### A. Stock-first MOVE (user's standing rule)
- Default actuation is now `pathfinder`. `Executor.pathTo` calls `stockPathTo` (`bot.pathfinder.setGoal`,
  Movements `canDig=false`, `allowParkour=false`, `allow1by1towers=false`, `scafoldingBlocks=[]`) FIRST and
  falls back to the control walk (`walkByControls`, headroom>=2 gate) then the packet stepper only on
  stuck/noPath/timeout. `runMove` now goes through `pathTo` (stock) instead of calling `walkByControls` first.
  `pathToNear` (furnace/pickup approach) has the same stock-first fallback.
- Live stock evidence (AI_R2S4, `logs/stock-move/run5.log`):
  - 1-block PIT: `reached=true moved=5.179m forcedRepositions=0`; events `path_update status=success nodes=5`
    then `goal_reached`. Parkour and tower modes: same reach, `forcedRepositions=0` (no effect).
  - 1-block STEP: `reached=false` in all 3 modes. `path_update status=success nodes=5` -> `path_reset
    reason=stuck`; moved 1.175m and stopped at the face (dy=0); `forcedRepositions=82` (parkour 89, tower 21).
    Reproduced on 4 independent fresh spawns (`run3.log`, `run4.log`, `run5.log`, `step-probe.log` forced=116).
    `getPathTo` returns a valid 5-node path including the climb node, so PLANNING is fine; the failing part is
    EXECUTION (the server rejects the pathfinder's jump-into-block contact; our actuator's pre-contact jump
    avoids it). => keep our actuator ONLY as a documented fallback; stock stays primary. allowParkour/
    allow1by1towers neither help nor hurt -> stay false.
- `need_llm` (A5): confirmed a controller-internal escalation LABEL (`system2.LlmSummonReason` +
  `controller.ESCALATION_TO_SUMMON.low_confidence`), NOT a Jev question (`src/jev.ts:299-300`). The live run
  shows `[escalate] ... summon=need_llm` and `[system2] LLM summon suppressed reason=need_llm`; no `need_llm`
  question appears in any Jev answer set. No fix needed.
- `m2.mts`: relabeled `[m1]`->`[m2]` (21 sites), default `--username AI_R2`, objective `iron_ingot>=3`,
  actuation `pathfinder`, plus Jev cost math ($0.04/1M input, output free) and wedge-abort reporting.

### B. R2 vertical descent / R3 smelting — NOT reached (exact blocker)
Run `logs/m2-r2r3/`, console `logs/m2-r2r3-console.log`:
- First MOVE was driven by stock pathfinder and WORKED: `MOVE:b20_63_-72 start=(22.5,63,-63.5)
  end=(20.5,62.92,-70.5) moved=7.28m`, `trigger=path_completed ... mode=pathfinder`.
- `MINE:b20_63_-72` verified: `blockRemoved=true gained=2 goal=2/3 progress=67%` (stock collectblock, then the
  control nudge when `collectblock budget exhausted`).
- BLOCKER: after that dig the bot ended in a 1-block depression at y=62; every following MOVE target required a
  1-block step up. Stock: `stock pathfinder GoalBlock failed (pathfinder GoalBlock -> stuck)`. Control-walk
  fallback: `control locomotion budget exhausted` and `no jump headroom at (21,63,-72): target unreachable
  (no hopeless jump)` (correctly refuses the hopeless jump). Packet stepper: `packet locomotion blocked before
  (21.5,63,-73.5)`. All candidates shared the climb -> wedge abort at 61.5s. Subgoal 1 stalled 2/3 logs
  (`FINAL INVENTORY={"birch_log":2}`), so R2 DESCEND and R3 SMELT were never offered.
- Run totals: stopped=wedge success=false durationMs=76543 ticks=7; decisions=6 with_llm_called_true=0;
  runtimeCalls=0 planCalls=1; Jev calls=6 latency p50=694 p95=758; tokens input=16437 output=1172 mean=2740/call;
  cost total=$0.000657 mean=$0.000110/call; escalations pathfinder_stuck x3, progress_stall x3, low_confidence x2,
  same_failure_3x x2; wedgeAborts=1; verifiedDigs=1 itemsCollected=2.
- Per-subgoal inventory: g1 `collect 3 x log`: before `{}` -> after `{"birch_log":2}` (incomplete).

### S3 verification
- typecheck clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit 9/9.
- audit case H now also asserts stock pathfinder primary (`stockPathTo` + `setGoal`), control-walk fallback,
  and `actuation: 'pathfinder'` defaults (still 9/9 total).
- Docs: ARCHITECTURE.md section 9.2 rewritten to stock-first; MILESTONES.md M2 updated.

## AUDIT S4 (2026-09-17 ~11:2x UTC) — locomotion headroom/step-up fix; R2/R3 still blocked
Root cause (measured): the "no jump headroom" veto was an off-by-one. `Executor.hasJumpHeadroom()` used
`Math.round(feet)`, so with feet ≈62.9 under a birch canopy it checked cells 64/65 (65 = leaf) instead of
63/64, and refused every jump. Live probe of the blocker column (21,-72): grass top 62 (feet 62),
air 62..64, canopy leaves 65..68 — the step's landing is clear, only the current column had a leaf at +3.

Fix (`src/executor.ts`, all tests green):
  - `headroomAt(x, feetY, z)` uses `Math.floor(feet)` and checks `feet+1`/`feet+2`; `hasJumpHeadroom()` delegates.
  - For a detected 1-2 block rise, headroom is checked AT THE LANDING column (`climb.top + 1`):
    `jumpAllowed = landingHeadroom || currentHeadroom`; still a hard precondition for every jump.
  - Climb detection now runs BEFORE the pinned/standing-still recovery. The in-loop replan alone exceeded the
    250 ms standing-still window, so previously the recovery hop hijacked the pre-contact jump on every iteration.
  - Run-up: if the AABB is within 1.1 m of the step, back off 220 ms, then pre-contact jump (never
    jump + blocked-forward). Depression escape (goal +0.5..2.5 above feet) aims at the step edge and backs off longer.
  - Hopeless-jump bound: 4 pre-contact jumps with < 0.05 m movement -> return false (candidate re-targets;
    the wedge detector is not what stops it).

Step-climb evidence (AGENT level, `movement-agent-test.mts`, digs a 1-deep pit under the bot, drives Executor MOVE):
  - AI_DEP7 `climbedOut=true rose=2.20m moved=7.76m`, pre-contact jumps #1..#15 (rise=1; y 63 -> 64 -> 65).
  - AI_DEP8 `climbedOut=true rose=1.31m`, y progression 62.00 -> 62.93 -> 63.31, jumps firing.
  - m2 `logs/m2-r2r3-fix3/`: `pre-contact jump#1..N headroom=[cur=false land=true]`, y 62 -> 64 -> 66 (1-block
    steps climbed). Before the fix jumps=0 (the `standingStill` hijack + false headroom veto).
  - forcedRepositions during the agent climb: 73 (AI_DEP7) / 117 (AI_DEP8); no `ABORT: wedge` from the climb action.

R2/R3 NOT reached — EXACT next blocker (candidate reachability, not locomotion):
  - fresh runs `logs/m2-r2r3-fix2/`, `logs/m2-r2r3-fix3/` offer only MOVE candidates whose log stand-spots are
    in TREE CANOPIES (anchors y=67..78: `MOVE:b19_68_-52` stand (18,68,-53); `MOVE:b28_66_-36` stand (27,66,-36)).
  - the bot climbs the 1-block steps (y 62 -> 64 -> 66) but the final rise to the canopy target is a 2-block
    vertical face (impossible for a vanilla client); `collect 3 x log` stays 0/3, `goal progress stayed 0 for 63s`
    -> `ABORT: wedge detected`. No ground log with walk-up access is offered near the depleted spawn area.
  - `DESCEND`/`SMELT` are gated behind subgoal 1, so `iron_ore` is never offered; FINAL INVENTORY={}.
  - Run totals: stopped=wedge success=false durationMs=63346 ticks=4; decisions=3 with_llm_called_true=0;
    runtimeCalls=0 planCalls=1; Jev calls=3 latency p50=697 p95=821; input tokens=8050 mean=2683/call;
    cost total=$0.000322 mean=$0.000107/call; wedgeAborts=1; verifiedDigs=0 itemsCollected=0.
  - Per-subgoal inventory: g1 `collect 3 x log`: before `{}` -> after `{}` (never reached a log).

Verification: `npm run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit-test 9/9
(audit case H updated to assert the new `headroomAt`/`landingHeadroom`/`jumpAllowed` wiring).
Temp probe files (`probe-dep*.mjs`) created for the diagnosis were deleted; `~/mc-ai/mcbot/movement-test/`
was read/executed but not modified.

## MIGRATION STAGE (2026-09-17 ~20:40 JST) — Leaf 26.1.2 -> 1.21.11

GOAL: prove the version-gap hypothesis (stock Mineflayer works on 1.21.11) and drop the locomotion hack.

S0 server migrate (done)
- Leaf 1.21.11 build #178 discovered via `api.leafmc.one/v2/projects/leaf/versions/1.21.11/builds/178`
  (channel `default`); jar `leaf-1.21.11-178.jar`, sha256 verified
  `b01c2f6037f97a4e1cd1d23dc6574ebb4839de12395b62aa465fac63db263627`.
- stopped the 26.1.2 JVM gracefully; moved `leaf-26.1.2-3.jar` -> `jars/`; archived `world` ->
  `world-26.1.2-backup`; fresh world. server.properties unchanged except motd=`AI Sandbox 1.21.11`
  (online-mode=false, peaceful, spawn-protection=0, view-distance=8, max-players=10, port 25565).
- start.sh now uses `/usr/lib/jvm/java-21-openjdk-amd64/bin/java`; `Done (15.402s)!`; 25565 owned by
  the new JVM.
- World seed: default and -4172144997902289642 spawned in TREELESS badlands/mangrove (0 logs within
  160 blocks). Regenerated with `level-seed=2024` (dense oak/birch, 397 logs within 96, nearest 2 m).

S1 agent migrate (done)
- removed `github:PrismarineJS/mineflayer#fc480ee8...`; reinstalled from registry. `npm ls`:
  mineflayer@4.39.0, minecraft-protocol@1.68.0, minecraft-data@3.116.0, mineflayer-pathfinder@2.4.5.
  No `github:`/SHA in package.json or package-lock.json. `npm run typecheck` clean.

S2 hypothesis test (FALSIFIED)
- flat raw walk: 10.53 m, `forcedRepositions=0`.
- stock pathfinder 1-block step: `path_update success` -> `path_reset stuck`, `dy=0`, forced 103..137
  (AI_SCAN2, AI_F1, AI_121S, AI_121P).
- => `walkByControls` + packet stepper RETAINED. Root cause is not the Minecraft version.
- side finding: a desynced bot rubber-bands every tick; once stuck the position is persisted to
  playerdata (Paper caches it), so a reconnect resumes stuck.

S3 M1 on 1.21.11 (`logs/m1-121/`, console `logs/m1-121-console.log`)
- 3/4 subgoals in order: collect 3 oak_log -> crafting_table -> wooden_pickaxe -> cobblestone started.
- FINAL INVENTORY={"wooden_pickaxe":1,"oak_planks":3,"stick":2}; llm.called==false (0/15);
  runtimeCalls=0 planCalls=1; Jev calls=16, p50=585ms p95=913ms, input 45302.
- blocker: cobblestone target 26.05 m away, every MOVE `path_stuck` / `packet locomotion blocked
  before (-1.5,72,10.5)`; `ABORT: wedge detected (goal progress stayed 0 for 62994ms)`.

S4 tests (retargeted)
- test-m1.mts registry 26.1 -> 1.21.11; test-audit.mts P2 rewritten from "SHA is locked" to
  "stock published release (no git pin) + 1.21.11 findings documented".
- typecheck clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit 9/9.

S5 launched the client check
- `node launch/launch.mjs --mc-version 1.21.11 --vanilla --server localhost:25565 --username s0u7a
  --dry-run` -> exit 0 (documented in launch/README.md). No client launched for real.

M2 (furnace/charcoal -> iron_ore -> iron ingot x3 -> iron_pickaxe): NOT reached (gated behind M1).

## MOVEMENT PATCH STAGE (2026-09-17) — local desync fix; step climb still open

GOAL: remove the git pin dependency by porting the two PR #4063 movement fixes locally, verify at
harness level, and re-run M1/M2.

S1 patch (done)
- `patches/mineflayer-4.39.0-locomotion.patch` (5 hunks, each commented `[jev-agent patch]`):
  `sendTeleportReply()` answers a clientbound teleport **without** writing the server target into
  `lastSent`; `updatePosition` uses vanilla `dx*dx+dy*dy+dz*dz > 4e-8 || positionReminder >= 20`.
- `scripts/apply-movement-patch.mjs` applies it idempotently + verifies 4 invariants; wired into
  `postinstall`; `npm run movement-patch:check`. Reversible: `npm ci --ignore-scripts`.
- applied: `applied 5 hunk(s), 0 already present; verified 4/4 checks`; second run `0 hunk(s), 5
  already present`. `node --check physics.js` OK.

S2 harness verification (bare mineflayer, `movement-patch-test.mts` + `movement-ab.mjs`)
- baseline `AI_MVB`: stock step `reached=false dy=0.00 forced=162` (`path_reset stuck`).
- patched `AI_MVX`: step `reached=false forced=295`; full PR build `variants/G` `AI_MVG1`:
  `reached=false forced=285`. So the two-hunk subset and the full PR both fail the step.
- matched pinned window `AI_MVAB` (same saved stuck position, 18 s): stock variant A `forced=339`,
  patched `forced=266` -> the patch damps the storm (339 -> 266) but does not restore climbing.
- EXACT RESIDUAL: the server rejects a movement packet combining a jump with a blocked forward push
  (harness README §9.1); the stock pathfinder only jumps at contact. No movement-packet patch fixes
  this. Actuator `walkByControls` + packet stepper **RETAINED** (stock-first unchanged).
- EXPLORED AND REJECTED (general pathfinder-layer fix): `mineflayer-pathfinder@2.4.5` sets
  `forward=true` then `jump=true` into a step (`canSprintJump`/`canWalkJump`), i.e. the rejected
  jump+blocked-forward packet. Patched index.js to release `forward` for a pure hop when
  `isCollidedHorizontally`. Measured (bare mineflayer, AI_MVJ1, `logs/mv-patch/ab-pathfinder-fix.log`):
  step `dy` 0.00 -> **0.34** and forced **266 -> 150**, far leg moved **0.03 -> 7.64 m** — partial
  only, still `path_reset stuck` (needs the harness recipe's hop + airborne forward push, and the
  pre-contact jump timing is geometry-aware). Reverted to keep the diff at the two prescribed fixes;
  the experiment is recorded here and the actuator already handles the climb better.

S3 M1 on 1.21.11 with the patch (`logs/m1-121c/`, `m1-121d/`, `m1-121e/`)
- all three: `stopped=wedge success=false`, 0 subgoals done, `llm.called==false` 0/N,
  runtimeCalls=0, planCalls=1; Jev p50 ~640-755 ms, ~2.6-2.8k input tokens/call.
- blockers (non-movement): `logs/m1-121c` offered a MOVE stand spot behind a 2-block rise
  (`ray rise=2`, impossible) -> 1 oak_log then wedge 61.6 s; `logs/m1-121d/` and `m1-121e/`
  verified 3 digs with `gained=0` (drop never picked up) -> `FINAL INVENTORY={}`.

S4 suite: `npm run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit 9/9.

S5 M2 attempt (`logs/m2-mv/`, console `logs/m2-mv-console.log`, username AI_M2MV, 200 s)
- 3/14 subgoals completed in order: `collect 3 x log` -> `craft crafting_table` -> `craft
  wooden_pickaxe` (verifiedDigs=3, itemsCollected=3).
- `llm.called==false` on 0/20 decisions; runtimeCalls=0 planCalls=1; Jev 20 calls p50=723 ms
  p95=1035 ms; input 68487 tokens; cost total $0.002739 (mean $0.000137/call).
- EXACT BLOCKER: subgoal 4 `collect 8 x cobblestone` -> `ABORT: wedge detected (goal progress 0 for
  66185 ms)`, `wedgeAborts=1`, `path_stuck` x12. Every stone MOVE fails both actuations, e.g.
  `MOVE:b12_71_24`: stock `pathfinder GoalBlock -> stuck`; control-walk `no jump headroom` then
  `packet locomotion blocked before (2.5,68,11.5)`. Also `MOVE:b-17_70_28` blocked before
  `(-6.5,69,16.5)` and `MOVE:b-17_65_27` before `(-13.5,66,18.5)`.
- => the SAME residual as the harness step test: the routes to stone need a climb the Leaf server
  rejects (jump + blocked-forward). iron_ore/iron_ingot/iron_pickaxe never reached.
M2 iron legs (furnace/charcoal -> iron_ore -> iron_ingot x3 -> iron_pickaxe): NOT reached — blocked at
the cobblestone prerequisite by the residual step-climb rejection.

## B1/B2/B3 BLOCKER FIXES (2026-09-17 ~22:xx JST) — pickup FIXED, stair-cut pipeline landed

### B1 DROP PICKUP (REGRESSED on 1.21.11): FIXED
Root cause (measured live, `data/probe-b1.mts`, `logs/probe-b1.log`):
  - automatic pickup DOES work on 1.21.11 (dug the block underfoot; the item spawned at 0.53 m and
    `entityGone` fired within 500 ms, `inv={dirt:1}`);
  - `mineflayer-collectblock@1.6.0` is installed and registered (`bot.loadPlugin(collectBlockPlugin)`
    in every runner; `bot.collectBlock` is defined), BUT its entity path is
    `pathfinder.goto(GoalFollow(entity, 0))` then `waitForPickup`. On Leaf 1.21.11 that dynamic goal
    never resolves: the pathfinder burns `path_reset stuck` and re-paths forever, so `collect(...)`
    hung until the executor's race timer threw `collectblock budget exhausted`. The OLD code used
    `verifyTimeoutMs` (8000 ms) as the collectblock budget, so the whole settle window was consumed
    and the `while (Date.now() - startedAt < verifyTimeoutMs)` fallback never executed a single nudge
    (`settledMs` 8400 at `gained=0`) — the exact `logs/m1-121d/`, `m1-121e/` signature.
  - secondary: `entity.getDroppedItem()` throws on 1.21.11 (`metadata[8]` has no `present` slot), so
    the item-name filter is bypassed; the nearest-to-target rule still selects the right drop.

Fix (`src/executor.ts`):
  - stock `collectblock` is now given its own SMALL bounded slice (`STOCK_COLLECT_BUDGET_MS = 2500`)
    and is skipped entirely for a drop already inside the pickup volume; the control nudge gets its
    own reserved `PICKUP_NUDGE_TOTAL_MS = 4000` window (`nudgeDeadline = min(settleDeadline, now + 4000)`);
  - the nudge targets the drop with `directBearing` (no pathfinder plan) and a `PICKUP_APPROACH_RADIUS`
    of 0.7 m, and `arrived()` uses HORIZONTAL distance when `requireLevel` is off (a drop legitimately
    sits one level below; the old 3-D test made the bot hop at the ledge forever);
  - the drop search radius is 4 m from the mined block, and the pathfinder goal is cleared after
    collectblock (it leaves its own `canDig=true` Movements installed).

Live evidence (`logs/m1-fix-ready-console.log`, `logs/m2-fix-ready-console.log`):
  - `pickup oak_log distance=1.8 nudges=2 drop=yes gained=1`, `distance=1.63/1.93/1.56 ... gained=1`,
    and M1/M2 subgoal 1 completes with REAL pickups: `VERIFIED MINE:b1_73_-4 removed=true gained=1`.
  - `stock collectblock item=oak_log gained=0` still appears only for the genuinely far drop.

### B2 2-BLOCK-RISE STAND SPOTS: stair-cut (`STEP`) candidate + fast-fail
  - `src/state.ts`: new sensor field `stepCuts: StepCut[]` (`buildStepCuts`). For each cardinal
    direction it finds the highest solid in the column, and when the rise is >= 2 it offers the CUT of
    the upper face block (the cell the bot will stand in): requires a diggable block, a solid landing
    below, two clear cells above the new step, and no lava/water in the column. Cutting the upper block
    turns a 2-block face into a 1-block step (jump apex 1.2522 -> climbable).
  - `src/candidates.ts`: new `STEP` kind. When the collect subgoal yields MOVE candidates (i.e. the
    stand spot is not directly minable) and a safe cut exists, up to 2 `STEP:<dir>:b<x>_<y>_<z>`
    candidates are emitted instead of leaving the un-executable MOVE as the only route.
  - `src/policy.ts`: `guardStep` (the cut must still be in `state.stepCuts` and `safe`, no hazard, in
    reach at the dig phase); `STEP` joins `ACTING_KINDS`.
  - `src/executor.ts`: `runStep` walks near then digs exactly that block (explicit guarded `bot.dig`, no
    `canDig=true`) and verifies removal. The actuator also now FAILS FAST on a genuine 2-block face
    (`2-block face ... rise=2 is unclimbable: needs a STEP cut`) so a MOVE at such a face never burns
    the budget nor causes a wedge; the failure feeds `failedCandidates` and the agent re-targets.
  - `src/jev.ts`: the deterministic fallback prefers `STEP` before `MOVE`.
  - Also fixed the spurious MOVE arrival: a MOVE that ended still pinned is no longer "arrived" even
    when the stand spot is within the old loose 1.5 m tolerance (the m1-121c `0.93 m short` case).

Live evidence: `data/step-cut-test.mts` (`logs/step-cut-test3.log`, AI_STEP3) dug a 2-deep pit and ran
the sensor->guard->executor path against real 2-block faces:
  `stepCuts=[E safe, W unsafe(no headroom), N safe, S safe]` -> `guard ok=true` ->
  `STEP:E:b0_71_-8 status=done blockRemoved=true before=grass_block after=air removedNow=true` ->
  `resulting 1-block step at (0,71,-8): landing=true headroom=true`. `wedge=done` (no wedge).
Deterministic pipeline proof: `data/step-pipeline-test.mts` 4/4 (STEP emitted for a blocked MOVE,
guard accepts a fresh safe cut, rejects a vanished face `TARGET_GONE`, rejects an unsafe cut
`NO_SUPPORT`). Real runs also show STEP candidates offered live, e.g.
`STEP:E:b0_77_-4`, `STEP:S:b1_74_-4`, `STEP:N:b12_73_4`, `STEP:S:b13_73_24`.

### B3 STEP EXECUTION: verified (already implemented in S4; re-measured)
`src/executor.ts#walkByControls` keeps (a) `scanAhead` over 0.8/1.2/1.6/2.0/2.4/2.8 m, (b) the
pre-contact jump while forward is free, (c) `jump` never sent with a blocked forward push (the
pre-contact branch requires `!pinned`), (d) headroom measured at the LANDING column
(`jumpAllowed = landingHeadroom || currentHeadroom`), (e) depression escape aimed at the step edge.
Live evidence (`logs/m1-fix-ready-console.log`):
  - `pre-contact jump#1 ray rise=1 dist=2 at y=68 →(11,68,8) headroom=[cur=true land=true]`,
    `#2..#4`; arrival `climbed=5.27m jumps=4 recoveries=5 forcedRepositions=22`
    start=(15.5,66,20.7) end=(13.63,71.25,23.51).
  - `movement-agent-test.mts` (`logs/b3-agent-test.log`, AI_B3): pit escape `rose=2.25m climbedOut=true`
    y-progression 67 -> 67.52 -> 67.75 -> 68.42 -> 69.18, `forcedRepositions=76`; anchored walk
    `moved=2.94m forcedRepositions=0`.

### Suite after the fixes
`npm run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit 9/9;
`movement-patch:check` ok (`0 hunk(s), 5 already present; verified 4/4`);
`npm run step-pipeline-test` 4/4.

### M1 re-run (AI_M1F, `logs/m1-fix-ready/`, 190 s): 3/4 subgoals IN ORDER, wedge at cobblestone
  - subgoals 1-3 COMPLETE with real pickups: `collect 3 x oak_log` (3 x `gained=1`), `crafting_table`,
    `wooden_pickaxe`; `llm.called==false` 0/21, runtimeCalls=0 planCalls=1, guardRejections=0.
  - EXACT blocker (subgoal 4 `collect 16 x cobblestone`): the nearest stone is ~22 m away and the
    long MOVE over broken terrain fails — stock `pathfinder GoalBlock -> stuck`; control-walk
    `budget exhausted before (12,70,25)` / `packet locomotion blocked before (11.5,66,20.5)`, and
    `MOVE:b16_67_24` moved 0.16 m. FINAL INVENTORY `{wooden_pickaxe:1,crafting_table:1,
    oak_planks:3,stick:2}` (cobblestone 0). The locally-depleted post-many-runs world has no
    walk-up stone within the MOVE band; this is a navigation/terrain limit, not decision-making
    (Jev-only, 0 LLM calls) and not pickup (B1 is fixed).

### M2 re-run (AI_M2F, `logs/m2-fix-ready/`, 190 s): 2/14 subgoals, wedge at wooden_pickaxe
  - subgoal 1 `collect 3 x log` COMPLETE via 3 real pickups (`gained=1` at 1.63/1.93/1.56 m), then
    `craft 1 x crafting_table` COMPLETE; `llm.called==false` 0/18, runtimeCalls=0 planCalls=1,
    Jev 19 calls p50 538 ms, cost $0.001837.
  - EXACT blocker (subgoal 3 `craft wooden_pickaxe`): the table IS placed at (-2,73,7) but
    `runCraft` cannot walk to it — stock `GoalNear -> stuck`, control-walk `packet locomotion blocked
    before (-2,73,7)`; 5 failures, `ABORT: wedge detected`. FINAL INVENTORY
    `{crafting_table:1,oak_planks:6,stick:4}`. iron_ore/iron_ingot/iron_pickaxe not reached (gated
    behind subgoal 3) — the same local-navigation/terrain residual, not drop pickup and not the
    2-block face (STEP is available and was offered in these runs).

### DESCEND GUARD FIX — the actual cobblestone blocker — and M1 4/4
`logs/m1-fix-run2/` (AI_M1G) exposed the real reason the M4 cobblestone leg always wedged:
`DESCEND:down:E:b-11_70_-9` was generated as the ONLY candidate, then the guard rejected it every tick
with `TARGET_GONE: no block at (-11,70,-9) in the current state` (5x) -> `all_candidates_invalid` ->
`ABORT: wedge detected (chosen 6x)`. Root cause: `guardDescend` validated the dig cell with
`findBlock(state.blocks)`, but `state.blocks` only contains log/stone/ore/hazard blocks — the descent
digs arbitrary terrain (dirt/grass/gravel), so EVERY terrain DESCEND was generated and then made
permanently unexecutable.
Fix (`src/policy.ts`): `guardDescend` now matches the dig cell against the sensor's own
`state.descent` options (`floor`/`wall`/`head`) and requires the step to be `safe`, exactly as
`guardStep` matches `state.stepCuts`. Deterministic proof: `data/step-pipeline-test.mts` is now
**6/6** (adds: guard accepts a DESCEND whose terrain dig cell is in the sensor descent list; guard
rejects a DESCEND whose step disappeared).

M1 with the fix (`logs/m1-fix-run4-console.log`, AI_M1J, 195 s): **4/4 goal-complete** —
`stopped=goal-complete success=true durationMs=181605 ticks=38`, subgoals planned=4 done=4 in order
(`collect 3 x oak_log` -> `crafting_table` -> `wooden_pickaxe` -> `collect 16 x cobblestone` ->
`plan complete`), `llm.called==false` **0/37**, runtimeCalls=0 planCalls=1, **wedge 0**,
guardRejections=0, verifiedDigs=23, itemsCollected=20. FINAL INVENTORY
`{cobblestone:16, wooden_pickaxe:1, oak_planks:3, stick:2, oak_log:1, dirt:3}`; the
cobblestone leg is 16 verified `cobblestone_in_inventory=N (gained 1)` digs
(`MINE:b10_60_23` progress=100%). The only harness acceptance FAIL is the pre-existing
"simultaneous final inventory" check (a genuine non-pre-seeded run consumes oak_log into
planks/table/pickaxe and the placed table stays in the world) — the four subgoals themselves are
all inventory-verified complete.

### M2 re-run after the fixes (AI_M2G, `logs/m2-fix-run2/`, 195 s): 4/14 subgoals, zero wedge
With the B1/B2/B3 + DESCEND-guard fixes, M2 advanced from 2/14 to **4/14** and no longer wedges
(`wedgeAborts=0`, `stopped=max-runtime`):
  - `collect 3 x log` COMPLETE (birch_log 2 + oak_log 1, real pickups) ->
    `craft crafting_table` COMPLETE -> `craft wooden_pickaxe` COMPLETE ->
    `collect 8 x cobblestone` COMPLETE (cobblestone 9) -> `craft furnace` STARTED.
  - `llm.called==false` **0/28**, runtimeCalls=0 planCalls=1, Jev 32 calls p50 576 ms p95 780 ms,
    cost total $0.003790 (mean $0.000118/call), verifiedDigs=12, itemsCollected=12.
  - Per-subgoal inventory at completion (from the queue timeline): log `{birch_log:2,oak_log:1}` ->
    crafting_table `{birch_log:1,crafting_table:1,oak_log:1}` ->
    wooden_pickaxe `{birch_planks:2,crafting_table:1,oak_planks:1,stick:2,wooden_pickaxe:1}` ->
    cobblestone `{...cobblestone:9}`. FINAL INVENTORY
    `{birch_planks:2,crafting_table:1,oak_planks:1,stick:2,wooden_pickaxe:1,cobblestone:6}`.
  - EXACT blocker (subgoal 5 `craft 1 x furnace`): the table is placed at (11,66,19) but `runCraft`
    cannot walk to it — stock `GoalNear -> stuck`, control-walk `packet locomotion blocked before
    (10.5,66,20.5)`; the run hit the 195 s runtime cap before the furnace was crafted.
    `charcoal`/`iron_ore`/`iron_ingot`/`iron_pickaxe` were never offered (gated behind the furnace).
    This is the same local navigation-to-station residual, not drop pickup, not the 2-block face
    (STEP is available), and not the wedge detector (0 wedge aborts). M2 acceptance self-check: 4/5.




## PLACED-BLOCK APPROACH FIX (2026-09-17, ~23:xx JST) — `craft furnace` station unblocked

### Diagnosis (AI_M2G, `logs/m2-fix-run2-console.log`)
4/14, wedge 0, `llm.called==false` 0/28. Blocker: `runCraft` for the furnace could not walk to the
placed table at (11,66,19). Stock `GoalNear -> stuck`; the control-walk fallback hopped at a genuine
2-block face (`climb=ray@9,68,22`) until `budget exhausted`; the packet stepper blocked at
`(10.5,66,20.5)`. The bot had mined a shaft at (8-9,23) and the station was up the 2-block face.
`pathToNear` is the wrong primitive for a station (its arrival test is the full 3D centre and it uses
the plan-based walk, which routed east into the 3-tall wall at (9,22) rather than NE around it).

### Fix (`src/executor.ts`, `src/state.ts`)
`approachPlacedBlock(block, label, ...)`, used by `runCraft` and `runSmelt`:
- bounded stock slice (`GoalNear`, `PLACED_STOCK_BUDGET_MS=3000`) toward the nearest interaction stand;
- reserved `directBearing` nudge window (`PLACED_NUDGE_TOTAL_MS=5000`, 1800 ms/attempt) with the
  verified pre-contact jump (the drop-pickup recipe);
- arrival = HORIZONTAL distance to the block (`<= 2.8 m`) + interaction-face reachability
  (`blockFaceDistance`: eyes clamped to the block AABB `<= reach`), not the 3D centre;
- a blocking 2-block face is stair-cut with the `stepCuts` safety predicates
  (`findApproachStepCut`: diggable, solid landing, 2 clear cells above, no hazard/unbreakable, only
  toward the station, `<= 3` cuts), then re-nudged. `canDig=false` unchanged; the only dig is the
  explicit `bot.dig` of a safety-checked face block; no tunnelling;
- fails fast with `path_stuck` + `horizontal/face` reason (never wedges). The pinned/standing recovery
  branch also fails fast on a genuine 2-block face now (previously hopped until budget).
- `state.ts` exports `PROBE_HAZARDS`/`PROBE_FLUIDS`/`UNBREAKABLE` so the cut mirror matches `buildStepCuts`.

### Agent-level proof (new `data/placed-approach-test.mts`, AI_PA12)
`spawn feet=(4.5,68,8.5) surfaceTop=67 -> dug 2 -> pit feet=(4.5,66,8.5) -> station (8,67,8)`:
```
stock pathfinder GoalNear for test_station -> noPath; direct-bearing nudge fallback
control locomotion 2-block face at (5,67,8) rise=2 is unclimbable: needs a STEP cut
approach test_station: stair-cut grass_block at (5,67,8) ok=true cuts=1
control locomotion pre-contact jump#1 ray rise=1 dist=1.2 at y=67 ->(6,67,8)
approach test_station arrival horizontal=3.54m->2.33m face=2.95m cuts=1
[pa] end feet=(5.72,68.25,8.5) climbed=2.25 horizontalToStation=2.33 error=-
[pa] SUMMARY approachOk=true climbedOut=true depthDug=2
```

### Live M1/M2 regression runs (fresh offline identities)
- M1 `AI_M1K` (`logs/m1-approach-console.log`, 200 s): subgoals 1-3 COMPLETE in order with real pickups
  (`collect 3 x oak_log` -> `crafting_table` -> `wooden_pickaxe`), `llm.called==false` 0/23, but the
  `collect 16 x cobblestone` leg stalls: nearest walk-up stone is 25.85 m away and every MOVE fails
  (`packet locomotion blocked before (6.5,75,-23.5)`); `stopped=wedge`. The craft-approach path was
  already-arrived (placed table 0.68 m away), so the changed code is inert here.
- M1 `AI_M1L` (`logs/m1-approach2-console.log`): 0/4 — nearest remaining oak is unreachable
  (`MOVE:p1_76_-2 path_stuck` x2), `FINAL INVENTORY={}`.
- M2 `AI_M2H` (`logs/m2-approach-console.log`): 0/14, subgoal 1 `collect 3 x log` = 2/3 (2 oak_log),
  the 3rd dug log's drop is uncollectable (`no jump headroom`), `stopped=wedge`.
- M2 `AI_M2K` (`logs/m2-approach2-console.log`): 0/14, `MINE:b13_71_4` in reach but the canopy face at
  (12,73,4) is a 2-block face; `MOVE:b13_72_-3` blocks at `(14.5,72,2.5)`. `FINAL INVENTORY={}`.

### Exact next blocker
World depletion: 20+ prior runs have consumed the logs within the 48-block scan radius of world spawn.
The only remaining log candidates are tree-canopy columns behind 2-block faces (the pre-existing canopy
residual), so `collect 3 x log` cannot complete and the furnace/smelt legs are never offered. This is
environmental (finite, unrefillable world) and independent of the placed-block approach, which the live
runs never reach. Fresh-world repeat (or restored world) is required to demonstrate the full M2 ladder
live; the approach fix itself is proven by `data/placed-approach-test.mts`.

### Suite after the fix
`npm run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1-test 5/5, audit-test 9/9,
step-pipeline-test 6/6; `movement-patch:check` ok (`0 hunk(s), 5 already present; verified 4/4`).




## WORLD RESET + M1/M2 ON FRESH SEED 2024 (2026-09-17 ~22:36-23:20 JST)

### A. World reset (safe)
- `kill <leaf pid>` -> graceful save (`All dimensions are saved`), port 25565 released.
- `world` / `world_nether` / `world_the_end` -> `world-depleted-20260917-223756/`.
- Restart with the SAME `server.properties` (`level-seed=2024`, offline-mode=false, peaceful,
  spawn-protection=0, `:25565`, Java 21 `/usr/lib/jvm/java-21-openjdk-amd64`):
  `[22:38:32 INFO] Done (13.198s)!` and `:25565` LISTEN owned by the fresh java pid.

### B. Read-only seed scan — new `data/seed-scan.mts`, `logs/seed-scan-2024.log`
- oak_log: 512 (cap), 207-212 with adjacent standable, **107-116 walk-up <=3**. Nearest oak 2.5 m,
  `plan=success(cost=4)`.
- stone: 32-49 exposed, 2-30 exposed+standable (spawn offset dependent). Nearest reachable
  (12,71,24) d=17.5 m `plan=success(cost=26)`; descent stone (31,54,1) d=25.7 m `plan=partial`.
- iron_ore nearest (11,55,3) d=13.2 dy=-13 (buried).
- VERDICT trees(a)=ok stone(b)=ok.

### C. M1 regression — PASS 4/4 (`logs/m1-fresh2-console.log`, AI_M1N, 240 s)
- `stopped=goal-complete success=true ticks=45`; 4/4 subgoals in order;
  `llm.called==false` **0/40**; runtimeCalls=0 planCalls=1; **wedgeAborts=0**; verifiedDigs=22,
  itemsCollected=22.
- Per-subgoal: 3 log -> crafting_table -> wooden_pickaxe -> cobblestone 18 -> plan complete.
- (First attempt `logs/m1-fresh-console.log` AI_M1M = 3/4: cobblestone MOVE arrived 0.75 below the
  stand spot and wedged; a retry on the same fresh world passed. Spawn is randomised within ~10 m.)

### D. M2 ladder — best 5/14 (`logs/m2-fresh2-console.log`, AI_M2S, 196 s)
- Timeline: `collect 3 x log` (3) -> `crafting_table` -> `wooden_pickaxe` -> `collect 8 x cobblestone`
  -> **`craft furnace`** -> `place furnace` START. FINAL INVENTORY
  `{furnace:1, wooden_pickaxe:1, crafting_table:1, oak_planks:3, stick:2, oak_sapling:1, dirt:2}`.
- `llm.called==false` 0/41, runtimeCalls=0 planCalls=1, verifiedDigs=15, itemsCollected=11, wedge 1.
- `charcoal` / `iron_ingot` / `iron_pickaxe` were **never offered** (subgoal 7+ behind the place leg).

### E. Fixes landed while driving M2
1. `src/candidates.ts` — self-placed station fallback. `craftCandidates` now returns a
   `PLACE:crafting_table` candidate at a nearby grounded `state.placementSpots` entry when
   `op.requiresTable && !tableInReach && holdsTable && failedCandidates[CRAFT:<item>] > 0`.
   New helper `placeStationCandidate`. Before: a natural village table out of reach caused
   `path_stuck` retries -> `ABORT: wedge (CRAFT:wooden_pickaxe chosen 6x)`
   (`logs/m2-fresh-console.log`).
2. `src/controller.ts` — place-goal completion inversion. `syncGoalToQueue` computed
   `complete = have >= required`, so holding the furnace made `goal "place 1 x furnace"` look complete
   and `guardPlace` rejected every candidate `ALREADY_DONE` (`logs/m2-fresh2-console.log`, ~44212).
   Fixed: for `kind === 'place'`, complete only when `have <= 0` (the item left the inventory).
3. `src/system2.ts` — `M2_PLAN_JSON` collect cobblestone `8 -> 12`. Furnace consumes all 8, so
   `craft stone_pickaxe` (3) had `no satisfiable recipe`. Verified: post-change plan logs
   `collect 12 x cobblestone`.

### F. Remaining exact blockers (bounded attempts, <=200 s each)
- (a) Canopy-pocket trap: `[executor] no jump headroom at (-12,67,12): target unreachable (no hopeless
  jump)` repeats; a 2-tall space under leaves blocks every jump, so the bot cannot make a 1-block step
  out. Seen in `logs/m2-AI_M2Z-console.log`.
- (b) Geometry-sensitive pickup: `[executor] pickup oak_log distance=1.75 nudges=1..16 drop=yes
  gained=0` (`logs/m2-AI_M2Y-console.log`, log at (1,76,-4)).
- (c) Budget: the cobblestone leg alone took ~180 s of the 200 s cap in the 5/14 run; the
  smelt/iron legs cannot fit in a single attempt.
- Attempts: `logs/m2-fresh` 2/14, `logs/m2-fresh2` 5/14, `logs/m2-fresh3` 0/14, `m2-fresh4` 0/14,
  `m2-fresh5` 0/14, `m2-AI_M2W/X/Y` 3/14 (cobblestone), `m2-AI_M2Z` 2/14 (craft after self-placed
  table but trapped in canopy). All runs `llm.called==false` on every decision.

### G. Suite
`npm run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1-test 5/5, audit-test 9/9,
step-pipeline-test 6/6, `movement-patch:check` ok (`0 hunk(s), 5 already present; verified 4/4`).

## THREE-BLOCKER FIX ROUND (2026-09-18 ~00:xx JST) — canopy clearance + pickup + phased ledger

### 1. Canopy-pocket trap -> ceiling-clear MINE (FIXED, live-proven)
- `src/state.ts`: new sensor field `headroomCuts: HeadroomCut[]` (`buildHeadroomCuts`). When the bot's own
  column lacks a 2-block jump headroom, it emits every solid cell at feet+1/feet+2 in a 3x3 footprint
  (own column first) that is diggable and not unbreakable/hazard/fluid. Never the feet/support cell, so
  it cannot remove the bot's own support. The 3x3 keeps the candidate id stable across the 1-block shuffle
  of the escape (a 1-column scan went stale -> `chosen candidate MINE:b0_74_-6 vanished between the Jev
  answer and execution` -> the controller fell through to a hopeless MOVE and wedged).
- `src/candidates.ts`: `headroomCandidates` emits `MINE:bX_Y_Z` with `meta.clearance=true` and the label
  "mine the <name> ceiling block ... to open jump headroom and escape the pocket". Only offered when the
  current goal has no in-reach MINE. Route-opening candidates (ceiling clear, then STEP) are now ordered
  BEFORE MOVE.
- `src/policy.ts` `guardMine`: a target not in `state.blocks` is validated against the sensor's own
  `headroomCuts` (safe flag, hazard probe, reach) exactly like `guardStep` uses `stepCuts`.
- `src/executor.ts` `runMine`: `meta.clearance` mines skip `collectDrop` and verify by `blockRemoved`
  alone (leaves drop nothing), so a ceiling clear is `VERIFIED ... removed=true gained=0`.
- `src/jev.ts` fallback: clearance mines are tried after STEP/MOVE, never before a real goal MINE.
- LIVE EVIDENCE (`logs/m2-phase1d-console.log`, AI_M2P4):
  `candidates ... ["MINE:b-1_74_-6","STEP:W:b-2_74_-6","MOVE:b-6_72_-3"]`
  `action=MINE:b-1_74_-6 | mine the oak_leaves ceiling block at (-1,74,-6) to open jump headroom`
  -> `executor action#2 MINE:b-1_74_-6` -> `VERIFIED MINE:b-1_74_-6 removed=true gained=0`
  -> `STEP:W:b-2_74_-6` executed. (`no jump headroom at (0,72,-6)` -> candidate -> dig -> route opened.)

### 2. Geometry-sensitive pickup (MITIGATED)
- `src/executor.ts`: `PICKUP_SAME_LEVEL_RADIUS = 1.15` for a drop within 1 m of the feet (automatic
  pickup fires ~1.3 m); `PICKUP_NUDGE_TOTAL_MS` 4000 -> 6000; a stalled nudge rotates to a perpendicular
  bearing around the drop (`pickupAim`, after 3 stalled nudges); and same-level pickup passes
  `ignoreFaceVeto` so the "unclimbable 2-block face" fail-fast (which was vetoing every nudge toward a
  ground drop) no longer blocks the approach. The outer nudge deadline still bounds the attempt.
- RESIDUAL (observed `logs/m2-phase1c-console.log`): `pickup birch_log distance=1.77..2.1 nudges=2
  gained=0` when the drop landed ~1.7 m ABOVE the bot on canopy leaves; the item is out of the vertical
  pickup slab and the bot is in the same pocket the ceiling fix addresses.

### 3. Budget -> subgoal-grouped phases with a durable ledger
- `src/goalQueue.ts`: `GoalQueueSnapshot` + `snapshot()`/`restore()`.
- `src/controller.ts`: `ledgerPath` (default null) and `stopAfterSubgoals` (0 = full plan). The
  bootstrap always calls the planner once (so `planCalls==1` and `llm.called==false` still hold), then
  restores the ledger if present; `finish()` writes it. `stopAfterSubgoals` stops the run successfully
  at a phase boundary. `m2.mts`: `--ledger <path>` and `--stop-after <n>`; run phases with `--no-clean`
  and the SAME offline username so the inventory persists too.
- Evidence of restore: `logs/m2-phase1b-console.log`: `[system2] phase ledger restored: 0 subgoal(s)
  already done; current=collect 3 x log {"done":0,"total":14}`.

### Live ladder result this round
- `logs/m2-phase1e-console.log` (AI_M2P5, 170 s, ceiling fix active): **2/14** in order
  `collect 3 x log` (3 logs picked) -> `craft crafting_table`; `llm.called==false` 0/19, runtimeCalls=0
  planCalls=1, FINAL INVENTORY `{crafting_table:1, oak_planks:6, stick:4}`. The ceiling-clear path is
  what got the 3 logs (the earlier identical runs wedged at 0/14 on `no jump headroom`).
- EXACT next blocker: `craft 1 x wooden_pickaxe` at a station — the bot has the materials (6 planks,
  4 sticks) but `bot.craft(recipe, 1, table)` gains 0 and `runCraft` throws
  `craft wooden_pickaxe gained 0 (after=0)` -> repeated -> `ABORT: wedge detected (goal progress stayed
  0 for 64546ms)`. The same failure hit the M1 regression attempts (`logs/m1-phase-check-console.log`,
  AI_M1R, 2/4). This is the craft-at-station interaction (opening the crafting window at a table the
  agent reached via `approachPlacedBlock`'s 2.8 m horizontal arrival), not pickup, not the canopy, and
  not the 2-block face.
- World note: the seed-2024 world's surface stone is now fully mined out
  (`data/seed-scan.mts` -> `stone-like exposed+standable=0`; trees still `walkUp<=3=91`, nearest oak
  (-6,72,-3) `plan=success`). M1's cobblestone leg therefore also needs the DESCEND path; the M1
  re-runs this round failed environmentally (placed-table craft; canopy pocket) rather than by the
  three fixes above.

### Suite after this round
`npm run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1-test 5/5, audit-test 9/9,
step-pipeline-test 6/6; `movement-patch:check` ok (`0 hunk(s), 5 already present; verified 4/4`).
