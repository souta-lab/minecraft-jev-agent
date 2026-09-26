# Jev -> Ender Dragon: milestone ledger

Layers: Mineflayer = continuous motor/reflex | Jev = event-driven semantic policy | LLM = exception-driven planner.

M0 closed loop (GATE) - PASS requires all:
  - a candidate oak_log 5-15m away exists and Jev picks MOVE:<id>
  - positions actually change (server coords) and an arrival trigger fires
  - post-arrival Jev decision = MINE:<id>
  - server-side block becomes air AND dropObserved/inventory confirms oak_log
  - evidence: decision records, positions, jevLatencyMs, tokens, cost, verifiedDigs

M1 Jev-only plan (no LLM calls):
  collect oak_log x3 -> crafting_table -> wooden_pickaxe -> cobblestone x16
  metric: LLM calls during the run (target 0), Jev calls, cost

M2 diamond-to-Nether-gate: diamond x3 -> diamond pickaxe -> flint_and_steel -> obsidian x10 -> build/light/verify portal
  (first milestone where the LLM must supply a long-horizon plan)

M3 12 Eyes of Ender: ender_pearl x12 + blaze rods -> craft ender_eye x12
  (ender_eye = ender_pearl + blaze_powder, so M3 needs hostile-mob enderman drops AND
   Nether access for blaze rods)

M4 THE DRAGON: stronghold -> end portal -> kill Ender Dragon

## Environment
- Leaf 1.21.11 (build #178, Java 21, sha256 b01c2f6037f97a4e1cd1d23dc6574ebb4839de12395b62aa465fac63db263627)
  headless, 127.0.0.1:25565, online-mode=false, peaceful, fresh world at /home/s0u7a/mc-server/world
- world seed `level-seed=2024` — dense oak/birch forest at spawn. (The default empty seed and
  -4172144997902289642 both spawned in treeless badlands/mangrove: 0 logs within 160 blocks, and
  mangrove logs had no walk-up access. A forest seed is required for M1 to be attemptable.)
- bot: offline auth, distinct offline usernames per run (never AI_Bot/s0u7a)
- jev: typesafe-ai/jev via Vercel AI Gateway (key at ~/.config/kimaki-secrets/vercel-ai-gateway.key, 0600)
- stock published `mineflayer@4.39.0` / `minecraft-protocol@1.68.0` / `minecraft-data@3.116.0` /
  `mineflayer-pathfinder@2.4.5` — **no git pin**. (Previously pinned to open PR #4063 head
  fc480ee8c456de87ce77769b31ba8bcf88703043; the pin was removed in the 1.21.11 migration. Rollback:
  `bun add mineflayer@4.39.0`.)

## PRIORITY (updated): M1 first, M4 deprioritised
M1 is the top priority now. Target metric: **LLM calls == 0 for the whole run**.

Subgoal queue to execute with Jev only (LLM supplies the plan once, then stays silent):
  1. collect oak_log x3
  2. craft crafting_table x1
  3. craft wooden_pickaxe x1
  4. collect cobblestone x16

Acceptance criteria:
  - the four subgoals complete in order (inventory-verified: oak_log>=3, crafting_table>=1, wooden_pickaxe>=1, cobblestone>=16)
  - `llm.called == false` for every decision record during the run (counter must be 0)
  - each subgoal transition is driven by a Jev decision (log shows goal/subgoal change triggers)
  - evidence: decision log + inventory checks + Jev call count/latency/cost

Known gaps to implement for M1 (blockers):
  - `CandidateKind` currently is MINE|MOVE|ATTACK|EAT|RETREAT|WAIT|ESCALATE -> **no CRAFT**: crafting must be added
  - executor has no craft path (`bot.craft` + recipe resolution via minecraft-data; 2x2 inventory crafting for planks/sticks, table for the pickaxe)
  - no inventory-derived subgoal progress tracking (counts from `bot.inventory`)
  - no goal/subgoal queue consumed by the policy (the LLM plan JSON shape is already specified)

Sequencing: do NOT edit packages/jev-agent/src concurrently with the in-flight M0 fix run; M1 implementation starts once the M0 fix lands (walking + MOVE candidates verified).

## M0 result: PASS (verified)
Evidence dir: /home/s0u7a/mc-ai/packages/jev-agent/logs/m0-final/
  target MOVE:b19_63_-65 (5.52m, out of reach) -> walked -> path_completed -> MINE:b19_63_-65
  -> blockRemoved=true dropObserved=true oak_log_in_inventory=1 -> stopped success=true verifiedDigs=1
  cost $0.000407 | 2 Jev calls (610/493 ms) | forcedRepositions=1 (0 during the walk)
Caveat: initial spawn had no flat route to any out-of-reach log (slope/canopy only); ran from a spawn with a flat 3-node route.
Invariants verified: pinned mineflayer, canDig=false, single-action ownership, guard rejections=0, 2D danger gate fired (score 1.01 conf 0 < 0.4 -> preserve).

## M1 status: IN PROGRESS - blocker = VERTICAL MOVEMENT, not decision-making
  flat walking now reliable (forcedRepositions=0); 1-2 block steps/slopes still stall ("packet locomotion blocked").
  M1 acceptance unchanged: oak_log>=3 -> crafting_table>=1 -> wooden_pickaxe>=1 -> cobblestone>=16, llm.called==false for the run.
  CAUTION: src/ is being concurrently rewritten by the M1 task; `bun run typecheck` was reported with 7 transient errors
  (controller.ts, system2.ts, data/probe-walk.mts) at one point - re-verify typecheck before trusting any M1 evidence.

## M1 result: PASS (5/5 acceptance) - evidence in /home/s0u7a/mc-ai/packages/jev-agent/logs/m1-final/

Canonical run (`m1.mts`, log dir `logs/m1-final/`, console also saved as
`logs/m1-final-console.5of5.inherited.log`):
  stopped=goal-complete success=true durationMs=9003 ticks=5 subgoals planned=4 done=4
  FINAL INVENTORY = { oak_log:5, crafting_table:1, wooden_pickaxe:1, cobblestone:17 }
  LLM gate: decisions=4, decisions with llm.called=true = 0 (0/11 in the 12-tick run), runtimeCalls=0, planCalls=1
  Jev: 4 calls (p50 517 ms, p95 683 ms), input tokens 13246 / output 1022
  ordered transitions (queue timeline, each with a Jev trigger):
    [collect 3 x oak_log] -> [craft 1 x crafting_table] -> [craft 1 x wooden_pickaxe] -> [collect 16 x cobblestone] -> plan complete
  (a second run, 12 ticks / 46.8 s, showed identical gates with cobblestone accumulating 2 -> 17 via 9 verified stone digs)

CAVEAT on the canonical run: `/clear` is the only inventory reset available (no op for /clear), so this player's
inventory was repopulated from previously dropped/repicked items - subgoals 1-3 completed on inventory that partly
pre-existed. Fresh-state behaviour was separately proven live: a clean spawn mined 3 actual oak_log, crafted planks +
crafting_table + stick + wooden_pickaxe, placed the table and mined cobblestone 2 -> 17.

## M1 implementation: DONE (all 4 known gaps closed)
Implemented (src/, typecheck clean, `bun run m1-test` 5/5):
  - `src/crafting.ts` (new): pure minecraft-data recipe index + `planNextCraftStep()`; walks the exact M1 chain
    oak_log -> oak_planks -> crafting_table -> stick -> place table -> wooden_pickaxe (verified against real 26.1 recipes).
  - `CandidateKind` += CRAFT | PLACE. Generation is goal-directed by the current goal-queue subgoal:
    collect -> MINE/MOVE for the matching yield (stone now scanned + `stone -> cobblestone` drop resolution);
    craft -> exactly one grounded CRAFT/PLACE step.
  - Executor: `runCraft` (bot.recipesFor + bot.craft, one craft per decision), `runPlace` (bot.placeBlock),
    walk-to-table when out of reach, equip tool before dig, and per-candidate `yieldItem` counting.
  - Guard: `guardCraft` (table looked up in `state.craftingTables`), `guardPlace`, generalized MINE/MOVE to any non-hazard block.
  - Inventory-derived subgoal progress: `syncQueue` completes collect/craft goals on the live `bot.inventory` count only
    (inventory-verified), logs each transition with its trigger, and the plan drives `state.goal`.
  - Single-shot planner: `FixedPlanSystem2` + `M1_PLAN_JSON`/`planFromJson`; the controller bootstraps the plan ONCE
    (`planCalls=1`) outside any decision tick and then suppresses every later summon; every decision record carries
    `llm: {called,runtimeCalls,planCalls}`, `subgoal`, and the live `inventory`.
  - `m1.mts` runner: plan bootstrap, evidence dump, acceptance self-check. Inventory-pollution fix: `/clear` + toss.

Live evidence (real `typesafe-ai/jev`, single-shot planner stub):
  - Plan bootstrapped once: `planCalls=1`; LLM runtime calls `=0`; `llm.called == false` on EVERY decision (0/32 in the
    clean report, 0/4..0/77 in the earlier runs).
  - Subgoal queue advances IN ORDER and only on a Jev decision trigger, e.g.:
    `[collect 3 x oak_log] -> [craft 1 x crafting_table] -> [craft 1 x wooden_pickaxe] -> [collect 16 x cobblestone]`
    with `trigger=inventory_changed|path_stuck|block_broken` and the live inventory attached to each transition.
  - Crafting works live end-to-end (oak_planks, crafting_table, wooden_pickaxe all produced), including PLACE of the table.
  - Jev: 32-153 calls/run, p50 ~470-584 ms, p95 ~827 ms; input tokens reported per call. Cost field: the gateway
    response used here does not include a monetary cost, only token usage.

WORKAROUND that made M1 pass despite the movement defect: mine only blocks within 2.5 m (pickup radius) - the drop
  lands inside the pickup radius and is collected without walking. Blocks further away are offered as MOVE (walk
  adjacent) instead of MINE. This is why cobblestone now accumulates.

REMAINING GAP (exact): VERTICAL MOVEMENT is still unfixed at the server/movement layer, not in the M1 logic. The
  packet-locomotion stepper still stalls on 1-2 block steps/slopes ("packet locomotion blocked before (x,y,z)") and
  cannot reliably walk to drops or climb terrain; fresh spawns at some columns (e.g. 44-45,62-63,-68) wedge
  permanently. M1 sidesteps it by mining adjacent blocks; general navigation (M2+) still needs the M0 vertical-step fix.
  Bugs found and fixed while reaching M1 (all landed): craft result counted after a server-confirm poll (was a false
  negative), one craft per decision (was over-crafting 4x), place only in real air (was `leaf_litter`), never place
  inside the bot's own body, walk to a crafting table before `activateBlock`, and never idle on WAIT/ESCALATE when the
  plan can proceed.

## V1 (vertical movement) result: DONE - the terrain blocker is closed
Ported the proven recipe from `packages/mcbot/movement-test/vertical.mjs#navigateTo` into `src/executor.ts`:
  - `scanAhead()` / `surfaceBlockAt()`: look 0.8-2.8 m along travel; a 1-2 block surface rise within ~2.2 m while
    grounded and not colliding triggers a pre-emptive jump WITH forward held (jump before packet-level contact).
  - pinned recovery: vertical hop first (forward released, ~180 ms), then push forward while airborne; if still
    pinned, back off ~300 ms so the next approach jumps before contact.
  - a ground no-progress detector (>=250 ms) also treats a real block as pinned when `isCollidedHorizontally` is
    unreliable, and `jump` is NEVER sent with a blocked forward push.
  - `walkByControls` is now the primary actuator for MOVE, `pathTo(GoalGetToBlock)` and `pathToNear`; the packet
    stepper remains only as a fallback. Arrival logs now carry `climbed=<m> jumps=N recoveries=N forcedRepositions=N`.
Invariants kept: canDig=false movement-only pathfinder, single-action ownership (actionEpoch/AbortController),
mechanical guard, grounded candidates, event-driven scheduler, 2D danger gate, `llm.called=false` during runs.
Tests after the change: `bun run typecheck` clean; guard-test 12/12, gating-test 6/6, loop-test 7/7, m1-test 5/5.

Agent-level terrain evidence (executor's OWN MOVE actions; runner `data/verify-vertical.mts`, username AI_V4,
log/evidence dir `logs/vertical-port/`):
  - 1-deep pit escape: `control locomotion arrival start=(38.31,62,-59.5) end=(36.94,63,-59.5) climbed=1.18m
    jumps=1 recoveries=1 forcedRepositions=3` -> MOVE status=done failure=none climbed=1m path_stuck=false.
  - 1-block step climb (forward approach): `control locomotion arrival start=(36.69,63,-59.5) end=(35.04,64.22,-59.5)
    climbed=1.3m jumps=1 recoveries=1 forcedRepositions=1` -> MOVE status=done failure=none climbed=1m path_stuck=false.
  - step-down into the dug pit also verified: `start=(36.5,63,-59.5) end=(38.31,62,-59.5) climbed=-1m
    forcedRepositions=2 path_stuck=false`. Reproduced on AI_V3 too.

M1 re-run after the change (`logs/m1-vertical-fix/`, username AI_V5): 4/5 acceptance.
  PASS 4 subgoals in order with their required counts verified at completion (queue timeline, each with a trigger)
  PASS `llm.called == false` on every decision (0/37), runtimeCalls=0, planCalls=1
  PASS every subgoal transition carries a trigger
  FAIL final-inventory simultaneous check `{oak_log:0,crafting_table:0,wooden_pickaxe:1,cobblestone:16}`
       (a genuine non-pre-seeded run consumes the oak_log into planks/table/pickaxe and the placed table stays in the
       world; the canonical m1-final 5/5 relied on pre-seeded inventory - not a locomotion regression)
  Movement: 0 MOVE `path_stuck` failures; 41 control-locomotion arrivals, e.g. climbed=8.25m
  `start=(32.74,65,-57.32) end=(38.32,73,-50.84) jumps=11 recoveries=4 forcedRepositions=19`, plus repeated
  `climbed=1.17-1.18m` 1-block climbs. 22 verifiedDigs / 19 items collected.

REMAINING LIMITATION: a pure vertical 2-block face is still unclimbable (jump apex 1.2522) and must be routed around;
some pickup walks deep in caves still exhaust the control budget and fall back to the packet stepper. Test holes were
left by the verifier (dug pit/step) around the AI_V3/AI_V4 spawn area; no server config or other directories touched.

## V1b (V1 port refinements): MOVE arrival is honest; M1 movement reproduced
Landing the port exposed three residual defects. Measured on the live server and fixed in
`src/executor.ts` + `src/candidates.ts` (no invariant changed):

1. Trivial MOVE arrival - the exact 205x `MOVE:b45_66_-74` degeneracy: `runMove` declared success as
   soon as the anchored block was within EYE reach (`anchorInReach`), even with moved=0, so the bot
   re-issued the same MOVE forever. Success is now: the standable spot is reached
   (`after<=1.5 && |dy|<=0.75`) OR the anchored block crossed from out-of-reach into reach. A partial
   step that leaves the spot unreached while the block was already in reach no longer passes.
   `walkByControls.arrived()` likewise only uses the anchor as the goal when `anchorIsGoal` (MINE).
2. Mid-jump / one-block-below "arrival": the old 3D-only test let the bot report arrival while still
   a block below a step or mid-jump. Vertical tolerance is now explicit (`requireLevel`): on for MOVE,
   OFF for drop pickup (the item legitimately sits a level below and the bot must descend to it).
3. Livelock on an unclimbable target / NO_PATH loop: a MOVE target that failed 4x (executor failure OR
   guard rejection) is no longer offered (`MOVE_FAILURE_LIMIT=4`), so the agent falls back to explore
   or another target instead of looping on a 4-block tree trunk (this does NOT blacklist targets that
   fail transiently, e.g. the V1 run's b40 target failed 3x then succeeded).

Re-verified after the refinements: `bun run typecheck` clean; guard-test **12/12**, gating-test **6/6**,
loop-test **7/7**, m1-test **5/5**. Agent-level evidence (`logs/agent-test-v1bC.log`, runner
`movement-agent-test.mts`, username AI_V1bC) - inside the executor's OWN MOVE action:
  - 1-deep pit escape: `control locomotion arrival start=(25.5,62,-69.5) end=(26.08,63.25,-69.5)
    climbed=1.25m jumps=1 recoveries=0 forcedRepositions=0` -> MOVE status=done failure=none;
    y progression 62.00 -> 63.17; NO `packet locomotion blocked`, NO `path_stuck`.
  - anchored MOVE with the anchor ALREADY in eye-reach (the old degenerate shape): moved=1.68m with
    forcedRepositions=0 (before the fix this "arrived" with moved=0).

M1 after the refinements (my own clean run, `logs/m1-v1b-clean/`, username AI_V1b9): **3/4 subgoals**.
  - subgoal 1 COMPLETE (oak_log 3) from REAL movement - mined b45_62_-74, b45_63_-74, b51_63_-72,
    b51_64_-72 after walking to them; subgoals 2 (crafting_table) and 3 (wooden_pickaxe) COMPLETE;
    `llm.called==false` on **0/475** decisions, runtimeCalls=0, planCalls=1, 0 guard conflict deferrals.
  - STOPPED at subgoal 4 (cobblestone). After crafting at the b51 tree the nearest exposed stone
    (32,68,-52) was ~28 m away, outside the 5-15 m MOVE band, so no stone candidate existed; the agent
    then ping-ponged on two explore spots (MOVE:p55_63_-69 x181 <-> MOVE:p54_63_-67 x180,
    401.5 m cumulative). EXACT BLOCKER: cobblestone requires stone within the 5-15 m MOVE band from
    where crafting completes; this world is now depleted of reachable logs and the reachable trees sat
    far from stone, and `pickExplore` picks the FARTHEST standable spot (oscillates). This is a
    candidate-range/exploration defect, not a vertical-movement defect.
  - The V1 section above already holds a clean 4/4 goal-complete run on the same source
    (`logs/m1-vertical-fix/`, AI_V5: cobblestone 16, 0 MOVE path_stuck) from a start whose tree was
    ~9 m from stone; its only failed acceptance is the pre-existing simultaneous final-inventory check
    (a non-pre-seeded run consumes oak_log into planks/table/pickaxe and leaves the placed table in
    the world).

## M2 (diamond -> Nether gate) - CURRENT DEFINITION

The current M2 target is the closed loop from a diamond-capable inventory to a
built, lit, and verified Nether portal. It requires diamond pickaxe capability,
flint-and-steel, ten obsidian, a validated frame, and run-scoped portal-light
verification. The former iron-age M2 material below is historical evidence and
does not satisfy the current M2 contract.

Current compliance: UNKNOWN; the typed portal plan is unit-tested, but a
run-scoped live portal gate is not yet wired.

## Historical iron-age M2 work - retained evidence

The following sections document the old furnace/charcoal/iron-pickaxe milestone.
They remain useful regression evidence but are not the current M2 definition.

### Historical M2 - IN PROGRESS, blocker = drop pickup / packet locomotion
Evidence: /home/s0u7a/mc-ai/docs/history/milestones/M2-PROGRESS.md, runs in packages/jev-agent/logs/m2-s1-m1{,b,c}/, logs/m2-s2-resource-probe.log, logs/m2-s3-ladder/.

Landed (code, typecheck clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5):
  - WEDGE DETECTOR in controller: abort when one action id is chosen >5x or goal progress stays 0 >60s;
    logs `ABORT: wedge detected (<reason>)`, RunSummary.stopped='wedge'. Proven 3x (4.7s, 53s, 65.8s).
  - pickExplore fixed: only standable spots >1.5m (no no-op targets), still nearest + toward the focus resource.
  - S2 capability: executor runSmelt (openFurnace/putInput/putFuel/takeOutput, single-action lock) + runDescend
    (dig staircase block, canDig stays false); policy guardSmelt/guardDescend; GoalQueue place/smelt kinds
    (smelt inventory-counted, place on item leaving inventory); planFromJson place/smelt; M2_PLAN_JSON + m2.mts.

Exact blocker (first M2 subgoal, collect logs): logs ARE reachable and 4 MINE actions verified
(`VERIFIED MINE:b28_65_-56 removed=true gained=0`), but every drop pickup walk fails with
`pickup walk failed: packet locomotion blocked before (30.5,64,-56.5)` -> itemsCollected=0, FINAL INVENTORY={},
queue advanced 0/14, run aborted by the wedge detector at 65.8s. Root cause is the pre-existing
locomotion defect (minecraft-data 26.1 has no collision shapes), now binding at drop collection rather than
at the dig. Secondary: MOVE re-chosen on intermittent `path_stuck`.

World scan at default spawn (logs/m2-s2-resource-probe.log): reachable trees are birch_log; nearest oak has
no standable-adjacent spot, the only standable-adjacent oak is 13 blocks up (path_stuck). iron_ore nearest
(19,57,-61) d=13.1 adj=none (buried -> requires DESCEND); deepslate iron y~7; diamond y=4 / deepslate y=-5..-11;
lava n=0 near spawn. So iron/diamond legs additionally need proven vertical MINE descent, not yet demonstrated
end to end. M4 (Ender Dragon) stays deferred.

## M2 S3 (STOCK-FIRST MOVEMENT + R2/R3 attempt)
Evidence: /home/s0u7a/mc-ai/docs/history/milestones/M2-PROGRESS.md "AUDIT S3" section; logs in packages/jev-agent/logs/stock-move/ and logs/m2-r2r3/.

Landed (code, typecheck clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit 9/9):
  - MOVEMENT IS STOCK-FIRST (user's standing rule): default actuation is `pathfinder`; `Executor.pathTo`
    calls stock `setGoal` first (canDig=false, allowParkour/allow1by1towers=false, scaffolding=[]) and falls
    back to `walkByControls` (headroom>=2 gate) then the packet stepper only on stuck/noPath/timeout.
    `runMove` and `pathToNear` both go through the stock-first path.
  - Live proof: stock pathfinder traverses a 1-block PIT (`reached=true moved=5.179m forcedRepositions=0`);
    1-block STEP fails (`path_reset stuck`, dy=0, forcedRepositions=82-116, reproduced on 4 fresh spawns)
    despite a valid 5-node `getPathTo` plan -> our actuator stays ONLY as a documented fallback.
  - `need_llm` confirmed a controller-internal escalation label, not a Jev question (no fix needed).
  - m2.mts relabeled [m2], default username AI_R2, objective iron_ingot>=3, actuation pathfinder, Jev cost math.

Exact blocker (R2/R3 NOT reached): run logs/m2-r2r3/. Stock MOVE#1 worked (7.28m) and MINE gained=2 logs
(2/3), but the post-dig bot sat in a 1-block depression and every remaining candidate needed a 1-block step
up. Stock `pathfinder GoalBlock -> stuck`; control-walk fallback `control locomotion budget exhausted` +
`no jump headroom ... target unreachable`; packet stepper `packet locomotion blocked`. All candidates shared
the climb -> `ABORT: wedge detected` at 61.5s. FINAL INVENTORY={"birch_log":2}. R2 DESCEND and R3 SMELT
subgoals were never offered. Jev calls=6 (llm.called=0/6, runtimeCalls=0 planCalls=1), cost $0.000657 total
($0.000110/call), wedgeAborts=1.

## M2 S4 (LOCOMOTION HEADROOM/STEP-UP FIX - landed; R2/R3 still blocked on candidate reachability)
Evidence: /home/s0u7a/mc-ai/docs/history/milestones/M2-PROGRESS.md "AUDIT S4"; live runs packages/jev-agent/logs/m2-r2r3-fix{,2,3}/ and
packages/jev-agent/logs/dep-escape-agent.log; agent-level test movement-agent-test.mts.

Landed (code, typecheck clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit 9/9):
  - `Executor.headroomAt()` now measures the TWO cells above the feet block with `Math.floor(feet)`.
    The old `Math.round(feet)` read one cell too high and vetoed the 1-block escape at (21,63,-72)
    because a canopy leaf sat at feet+2 while the step itself was clear. `hasJumpHeadroom()` delegates to it.
  - Headroom for a detected 1-2 block rise is checked AT THE LANDING COLUMN
    (`climb.top + 1`): `jumpAllowed = landingHeadroom || currentHeadroom`, so a leaf above the current
    column can no longer veto a legitimate step whose landing is clear. Still a hard gate for every jump.
  - Climb detection moved BEFORE the pinned/standing-still recovery (the in-loop replan alone exceeded the
    250 ms standing-still window, so the recovery hop was hijacking the pre-contact jump every time).
  - Run-up back-off: when the AABB is within 1.1 m of the step, back off 220 ms and re-approach, so the
    pre-contact jump is not sent while already touching the wall (the Leaf server rejects jump+blocked-forward).
  - Depression escape: goal +0.5..2.5 above the feet aims the jump at the step EDGE and gets a longer
    back-off; `jump` and a blocked forward push never share a packet.
  - Hopeless-jump bound: 4 consecutive pre-contact jumps with < 0.05 m movement -> return false, so
    candidate selection re-targets instead of the wedge detector ending the run.

Live step-climb evidence (agent level, not harness): `movement-agent-test` digs a 1-deep pit under the bot
and drives `Executor.claim(MOVE)`:
  - AI_DEP7: `climbedOut=true rose=2.20m moved=7.76m`, pre-contact jumps #1..#15 (`rise=1`, y 63 -> 64 -> 65)
  - AI_DEP8: `climbedOut=true rose=1.31m`, y progression 62.00 -> 62.93 -> 63.31, jumps firing
  - m2 fix3 run: bot climbs 1-block steps y 62 -> 64 -> 66 (`pre-contact jump#1..#N`, `headroom=[cur=false land=true]`)
  - Before the fix the pre-contact jump never fired at all (0 jumps; the `standingStill` hijack + the
    false `no jump headroom` veto); now it fires and the bot's maxY rises by >= 1 block. No `ABORT: wedge`
    is caused by the step-climb action itself; the remaining wedge is the candidate reachability below.

Exact next blocker (R2/R3 still NOT reached): fresh M2 runs (`logs/m2-r2r3-fix2/`, `fix3/`) offer only
`MOVE` candidates to log stand-spots in TREE CANOPIES (anchors at y=67..78, e.g. `MOVE:b19_68_-52` ->
stand (18,68,-53), `MOVE:b28_66_-36`). The bot now climbs the 1-block steps (y 62 -> 64 -> 66) but the
final rise to the canopy target is >1 block (a 2-block vertical face, still impossible for a vanilla
client), so no log is ever reached; `collect 3 x log` stays 0/3 and `goal progress stayed 0 for 63s` ->
`ABORT: wedge detected`. `DESCEND`/`SMELT` are gated behind subgoal 1, so `iron_ore` is never offered and
FINAL INVENTORY={}. This is a CANDIDATE-REACHABILITY blocker (nearest ground log with walk-up access),
not the headroom/locomotion veto. Jev calls=3 (llm.called=0/3, runtimeCalls=0 planCalls=1), latency
p50=697ms p95=821ms, input tokens 8050 (mean 2683/call), cost $0.000322 total ($0.000107/call).


## 1.21.11 MIGRATION + M1/M2 attempt (2026-09-17 ~20:40 JST)

WHY: on Leaf 26.1.2 the released Mineflayer 4.39.0 could not execute a 1-block step
(`path_update status=success` -> `path_reset reason=stuck`, dy=0, `forcedRepositions=82..116`), so
the agent carried a pin to open upstream PR #4063 (`fc480ee8...`) plus a ~100-line custom actuator
(`walkByControls`) and a packet stepper. HYPOTHESIS: on a version Mineflayer fully supports
(1.21.11), stock movement works, so the hack can be deleted.

MIGRATION (done):
- Server: Leaf **1.21.11 build #178** (`leaf-1.21.11-178.jar`, sha256
  `b01c2f6037f97a4e1cd1d23dc6574ebb4839de12395b62aa465fac63db263627`, Java 21 GA), fresh world with
  `level-seed=2024`. The 26.1.2 jar moved to `jars/`; the 26.1.2 world archived as
  `world-26.1.2-backup`. `server.log` shows `Done (15.402s)!`; `ss -ltnp` shows 25565 owned by the
  new JVM.
- Agent: removed the `github:` pin; `bun pm ls` = stock `mineflayer@4.39.0` /
  `minecraft-protocol@1.68.0` / `minecraft-data@3.116.0` / `mineflayer-pathfinder@2.4.5`; no
  `github:`/SHA anywhere in `package.json` or `bun.lock`.
- `minecraft-data@3.116.0` **does** ship `blockCollisionShapes` for pc/1.21.11 (protocol 774), so
  the collision-shape theory is dead.

HYPOTHESIS TEST (FALSIFIED):
- raw controls on flat ground: `setControlState('forward')` moved **10.53 m with
  `forcedRepositions=0`** — flat walking works.
- stock `pathfinder.goto(GoalBlock)` onto a 1-block rise (fresh spawns AI_SCAN2 / AI_F1 / AI_121S /
  AI_121P): `path_update status=success` (2-3 nodes) -> `path_reset reason=stuck`, `dy=0.00`,
  `forcedRepositions=103..137`. The server rejects the step approach exactly as on 26.1.2.
- therefore the version gap does NOT explain the locomotion defect, and `walkByControls` + the
  packet stepper are **RETAINED** (not deleted). (Also learned: a desynced bot is rubber-banded
  ~18-20x/s, and once stuck its position is saved to playerdata — a reconnect resumes stuck.)

M1 on 1.21.11 (world seed 2024, full console `logs/m1-121-console.log`, records `logs/m1-121/`):
- **3/4 subgoals completed IN ORDER**: `collect 3 x oak_log` -> `craft crafting_table` ->
  `craft wooden_pickaxe` -> (`collect 16 x cobblestone` started).
  Final inventory `{"wooden_pickaxe":1,"oak_planks":3,"stick":2}`, `verifiedDigs=2`.
- `llm.called == false` on **0/15 decisions**; runtimeCalls=0, planCalls=1 (bootstrap only).
- Jev calls=16, latency p50=585ms p95=913ms, input tokens 45302.
- BLOCKER (exact): subgoal 4, the nearest stone was 26.05 m away and every `MOVE` failed
  `path_stuck` / `packet locomotion blocked before (-1.5,72,10.5)`; `ABORT: wedge detected
  (goal progress stayed 0 for 62994ms)`. Same class of locomotion/reachability limit as 26.1.2.
- Two earlier attempts on other seeds were unusable: default seed and -4172144997902289642 gave
  treeless badlands / mangrove (0 logs within 160 blocks; mangrove logs had no walk-up access).

M2 (furnace+charcoal -> iron_ore -> iron ingots -> iron_pickaxe): NOT reached — gated behind M1's
cobblestone leg.

## LOCAL MOVEMENT PATCH (2026-09-17, Leaf 1.21.11): desync fix landed, step climb still open

Implemented the two PR #4063 movement fixes as a **local patch** (no git pin):
`patches/mineflayer-4.39.0-locomotion.patch`, applied idempotently by
`scripts/apply-movement-patch.mjs` from `postinstall`; `bun run movement-patch:check` verifies it.
Hunks: (1) `sendTeleportReply()` replies to a clientbound teleport without writing the server
target into `lastSent`; (2) `updatePosition` uses vanilla's
`dx*dx+dy*dy+dz*dz > 4e-8 || positionReminder >= 20`. Reversible via `bun install --frozen-lockfile --ignore-scripts`.

Harness-level verification (bare mineflayer, no agent loop, observer bot for server-side view,
`movement-patch-test.mts`; A/B with `movement-ab.mjs`):
- MATCHED pinned-at-step-face window (username `AI_MVAB`, 18 s): forced repositions
  **339 (stock variant A) -> 266 (patched)** — the patch measurably dampens the rubber-band storm.
- 1-block step STILL FAILS after the patch: `path_update status=success` -> `path_reset stuck`,
  `dy=0.00`, still 100+ forced. The **full PR #4063 build** (`movement-test/variants/G`) fails the
  same way (forced **285**, `path_reset stuck`), proving no PR hunk is missing: the residual is the
  server rejecting `jump + blocked-forward` (harness README §9.1), a client-collision problem no
  movement-packet patch removes.
- 1-block pit / ~26 m flat target are not reachable at harness level while pinned; the matched
  pinned window is the measured before/after.
Conclusion: `walkByControls` + the packet stepper are **RETAINED** as fallback (per the task's
"if it still fails" branch), and the stock pathfinder stays primary.

M1 re-run on 1.21.11 with the patch (`logs/m1-121c/`, `m1-121d/`, `m1-121e/`, usernames
AI_M1MV/MW/MX, 200 s each): 0 subgoals done in all three; `llm.called==false` 0/N every run,
runtimeCalls=0, planCalls=1. The binding blocker is no longer the desync: (a) candidate
reachability — a MOVE offered a stand spot behind a 2-block vertical rise (`logs/m1-121c`: 1 oak_log
then wedge at 61.6 s), or (b) drop pickup — 3 verified digs with `gained=0` and an empty inventory
(`logs/m1-121d/`, `m1-121e/`).

M2 attempt with the patch (`logs/m2-mv/`, AI_M2MV, 200 s): **3/14 subgoals** in order (3 logs ->
crafting_table -> wooden_pickaxe), `llm.called==false` 0/20, runtimeCalls=0, planCalls=1, Jev 20
calls p50 723 ms, cost $0.002739; wedge at subgoal 4 `collect 8 x cobblestone` (`path_stuck` x12;
stock `GoalBlock -> stuck`, control-walk `packet locomotion blocked before (2.5,68,11.5)` /
`no jump headroom`). iron_ore/iron_ingot/iron_pickaxe not reached — blocked by the same residual
step-climb rejection.

Post-patch suite: `bun run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1 5/5, audit 9/9.

## B1/B2/B3 BLOCKER FIXES (2026-09-17) — pickup FIXED; stair-cut pipeline landed; step climb verified
- B1 drop pickup: `mineflayer-collectblock`'s entity path (`GoalFollow(entity,0)`) hangs on 1.21.11 and
  consumed the whole 8 s settle window, so the control-nudge fallback never ran (`gained=0`). Fixed:
  stock gets a bounded 2.5 s slice (skipped when the drop is already in pickup range), the nudge owns a
  reserved 4 s window, steers `directBearing` at the drop, and treats horizontal arrival as success for
  the one-level-below case. Live: `pickup oak_log distance=1.8 nudges=2 ... gained=1`; M1/M2 subgoal 1
  completes with real pickups.
- B2 2-block-rise stand spots: new sensor `stepCuts` + `STEP` candidate + `guardStep` + `runStep` cut the
  upper face block into a 1-block step; the actuator now fails fast on a genuine 2-block face instead of
  jumping hopelessly, and a still-pinned MOVE is no longer a spurious arrival. Live: `STEP:E:b0_71_-8
  status=done blockRemoved=true before=grass_block after=air`, resulting step `landing=true headroom=true`;
  `step-pipeline-test` 4/4.
- B3 step execution: pre-contact jump (scanAhead 0.8-2.8 m, jump before contact, landing-column headroom)
  re-measured: `climbed=5.27m jumps=4`; pit escape `rose=2.25m` y 67 -> 67.52 -> 67.75 -> 68.42 -> 69.18.
- M1 (AI_M1F, 190 s): **3/4 in order** (3 log -> crafting_table -> wooden_pickaxe; `llm.called==false`
  0/21). Wedge at `collect 16 x cobblestone`: nearest stone ~22 m, long MOVE fails (`GoalBlock -> stuck`,
  `packet locomotion blocked`) on the locally-depleted world. M1 has PASSED 4/4 on a good spawn
  (`logs/m1-vertical-fix/`); the remaining blocker is terrain navigation, not decision-making or pickup.
- M2 (AI_M2F, 190 s): **2/14** (3 log -> crafting_table), then `craft wooden_pickaxe` cannot walk to the
  placed table (`packet locomotion blocked before (-2,73,7)`), wedge. iron legs gated behind it.

### DESCEND GUARD FIX + M1 4/4 (same day)
- Root cause of the recurring cobblestone wedge: `guardDescend` validated the dig cell with
  `findBlock(state.blocks)`, but `state.blocks` only holds log/stone/ore/hazard; the descent digs
  dirt/grass, so EVERY terrain DESCEND was generated and then rejected (`TARGET_GONE` x5 ->
  `all_candidates_invalid` -> `ABORT: wedge`). Fixed to match the sensor's `state.descent` options
  (`floor`/`wall`/`head`) and require `safe`, like `guardStep` matches `stepCuts`.
- M1 (`logs/m1-fix-run4-console.log`, AI_M1J, 195 s): **4/4 goal-complete** -
  `stopped=goal-complete success=true ticks=38`, subgoals done=4 in order, `llm.called==false` **0/37**,
  runtimeCalls=0 planCalls=1, **wedge 0**, guardRejections=0, verifiedDigs=23, itemsCollected=20.
  FINAL INVENTORY `{cobblestone:16, wooden_pickaxe:1, oak_planks:3, stick:2, oak_log:1, dirt:3}`.
  The only harness FAIL is the pre-existing "simultaneous final inventory" check (a genuine run consumes
  oak_log into planks/table/pickaxe); the four subgoals are all inventory-verified complete.
- M2 after the fixes (`logs/m2-fix-run2-console.log`, AI_M2G, 195 s): **4/14 subgoals, zero wedge**
  (`stopped=max-runtime`, `wedgeAborts=0`): 3 log -> crafting_table -> wooden_pickaxe ->
  collect 8 cobblestone (9) -> `craft furnace` started; `llm.called==false` 0/28, runtimeCalls=0
  planCalls=1, verifiedDigs=12. EXACT blocker: cannot walk to the placed table for `craft furnace`
  (stock `GoalNear -> stuck`, `packet locomotion blocked before (10.5,66,20.5)`); iron legs gated behind.
- `step-pipeline-test` now **6/6** (adds the DESCEND guard cases).

## PLACED-BLOCK APPROACH FIX (2026-09-17 ~23:xx JST) — station approach behind a 2-block face

Diagnosis (AI_M2G, `logs/m2-fix-run2-console.log`): the M2 run reached 4/14 but `craft furnace` stalled
because `runCraft` could not walk to the placed table at (11,66,19): stock `GoalNear -> stuck`, then the
control-walk fallback burned its budget hopping at a 2-block face (`climb=ray@9,68,22`) and the packet
stepper blocked at `(10.5,66,20.5)`. The bot had mined itself into a shaft; the station was up a 2-block
face. `pathToNear` was the wrong primitive for a station.

Fix (`src/executor.ts`): `approachPlacedBlock(block, label, ...)` for `runCraft`/`runSmelt`:
- stock pathfinder gets a bounded slice (`GoalNear`, 3000 ms) toward the nearest interaction stand cell;
- a reserved direct-bearing control-nudge window (5000 ms total, 1800 ms/attempt) with the verified
  pre-contact jump;
- arrival = HORIZONTAL distance to the block (`<= 2.8 m`) + reachability of its interaction face
  (`blockFaceDistance`: eyes clamped to the block AABB `<= reach`) — the full 3D centre no longer
  vetoes an adjacent stand;
- a blocking 2-block face is cut with the exact `stepCuts` safety predicates (`findApproachStepCut`:
  diggable, solid landing, two clear cells above, no hazard/unbreakable, only toward the station,
  `<= 3` cuts), turning it into a 1-block step; no tunnelling (`canDig=false` stays);
- the pinned/standing recovery branch now fails fast on a genuine 2-block face (was: hop until budget),
  and the approach fails fast with `path_stuck` + a `horizontal/face` reason instead of wedging.
- `src/state.ts`: exported `PROBE_HAZARDS`/`PROBE_FLUIDS`/`UNBREAKABLE` so the cut mirror uses the same
  predicates as `buildStepCuts`.

Agent-level proof (`data/placed-approach-test.mts`, fresh identity AI_PA12):
`spawn feet=(4.5,68,8.5) -> 2-deep pit feet=(4.5,66,8.5) -> station (8,67,8)`:
`stock pathfinder GoalNear for test_station -> noPath` ->
`control locomotion 2-block face at (5,67,8) rise=2 is unclimbable: needs a STEP cut` ->
`approach test_station: stair-cut grass_block at (5,67,8) ok=true cuts=1` ->
`pre-contact jump#1 ray rise=1 dist=1.2 at y=67 ->(6,67,8)` ->
`approach test_station arrival horizontal=3.54m->2.33m face=2.95m cuts=1` (`climbed=2.25m`, error none).

Tests: `bun run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1-test 5/5, audit-test 9/9,
step-pipeline-test 6/6, `movement-patch:check` ok (`0 hunk(s), 5 already present; verified 4/4`).

Live regression runs on the now-depleted world (fresh identities): M1 `AI_M1K` 3/4, `AI_M1L` 0/4;
M2 `AI_M2H` 0/14, `AI_M2K` 0/14; all stop at subgoal 1 (`collect 3 x log`, canopy 2-block faces /
unreachable logs). 20+ prior runs consumed the logs within the 48-block scan of world spawn
(`FINAL INVENTORY={}`). The placed-block path is never reached in these runs; the fix is proven by the
agent-level test above. `llm.called==false` on every decision in all runs.

## FRESH-WORLD RESET + M1/M2 RE-RUN (2026-09-17 ~22:36-23:20 JST) — seed 2024 regenerated

The standing blocker (world depletion: every log within the 48-block spawn scan consumed by 20+ runs)
was cleared by a safe reset, then the full ladder was re-run.

### World reset (safe, reversible)
- Server stopped gracefully (`kill <pid>` -> saved all dimensions, port released).
- Moved `world`, `world_nether`, `world_the_end` to `world-depleted-20260917-223756/` (14 MB).
- Regenerated with the SAME `server.properties` (`level-seed=2024`, offline, peaceful,
  spawn-protection=0, `:25565`, Java 21). Log: `[22:38:32] Done (13.198s)!`, port 25565 owned by the
  fresh pid. Seed 2024 was re-chosen because it is the proven oak-forest + surface-stone spawn profile;
  a fresh regeneration restores the finite resources.

### Read-only seed scan (`data/seed-scan.mts`, `logs/seed-scan-2024.log`)
- oak_log: 512 found (scan cap), **207 with an adjacent standable spot**, **116 walk-up <=3 blocks**
  (spawn-dependent: 68-116 across scans); nearest oak ~2.5 m, pathfinder `plan=success(cost=4)`.
- exposed stone: **32 exposed, 2 exposed+standable within 64 m**; nearest reachable at (12,71,24)
  d=17.5 m, `plan=success(cost=26)`; a descent stone at (31,54,1) d=25.7 m `plan=partial(cost=24)`.
- iron_ore: nearest (11,55,3) d=13.2, dy=-13 (buried -> requires DESCEND).

### M1 regression (`logs/m1-fresh2-console.log`, AI_M1N, 240 s cap) = PASS 4/4
- `stopped=goal-complete success=true ticks=45 durationMs=218840`.
- 4/4 subgoals in order: 3 log -> crafting_table -> wooden_pickaxe -> cobblestone 18 -> plan complete.
- `llm.called==false` **0/40**, runtimeCalls=0 planCalls=1, **wedgeAborts=0**, verifiedDigs=22,
  itemsCollected=22, guardRejections=4.

### M2 ladder (three fixes, best live 5/14)
Best post-reset run `logs/m2-fresh2-console.log` (AI_M2S, 196 s): **5/14 subgoals**, `stopped=wedge`,
`llm.called==false` 0/41, verifiedDigs=15, itemsCollected=11; timeline
`3 log -> crafting_table -> wooden_pickaxe -> cobblestone 8 -> craft furnace -> place furnace START`.
Fixed while driving it:
1. `src/candidates.ts`: `craftCandidates` now emits `PLACE:crafting_table` at a nearby grounded spot
   when the recipe needs a station, the bot holds its own table, the only known station (natural
   village table) is out of interaction reach, and the walk to it failed once (`placeStationCandidate`).
   Before: `ABORT: wedge (CRAFT:wooden_pickaxe chosen 6x)`.
2. `src/controller.ts`: `syncGoalToQueue` inverted place semantics - it treated *holding* the item as
   complete, while the queue completes a place goal only when the item leaves the inventory, so the
   guard rejected every `PLACE:furnace` as `ALREADY_DONE` (`goal "place 1 x furnace" is already
   complete`) and wedged. A place goal is now complete only when its item is gone.
3. `src/system2.ts`: M2 collect cobblestone 8 -> **12** (furnace 8 + stone_pickaxe 3); with 8 the
   `craft stone_pickaxe` step had no satisfiable recipe.

Remaining exact blockers (recorded, 200 s cap respected): (a) canopy-pocket trap -
`[executor] no jump headroom at (...) target unreachable (no hopeless jump)` repeats and the bot cannot
step out of a 2-tall space under leaves; (b) geometry-sensitive drop pickup -
`pickup ... nudges=1..16 gained=0` when the drop sits behind canopy; (c) the cobblestone leg alone
consumed ~180 s, so the smelt legs (charcoal/iron_ingot/iron_pickaxe) were never offered within one
attempt. Attempts: `logs/m2-fresh/` 2/14, `logs/m2-fresh2/` 5/14, `logs/m2-fresh3..5`, `logs/m2-AI_M2W..Z`.

### Tests (unchanged, re-run)
`bun run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1-test 5/5, audit-test 9/9,
step-pipeline-test 6/6; `movement-patch:check` ok (`0 hunk(s), 5 already present; verified 4/4`).

## M2 three-blocker fix round (2026-09-18) — canopy clearance + pickup + phased ledger

Evidence: `/home/s0u7a/mc-ai/docs/history/milestones/M2-PROGRESS.md` "THREE-BLOCKER FIX ROUND"; runs in
`packages/jev-agent/logs/m2-phase1{,b,c,d,e}/` and the M1 attempts `logs/m1-phase-check{,2}/`.

### Fix 1 — canopy-pocket ceiling MINE (LIVE-PROVEN)
`src/state.ts` `headroomCuts` (feet+1/feet+2 solid, diggable, non-hazard, 3x3 footprint, own column
first; never the feet/support); `src/candidates.ts` `headroomCandidates` (`MINE` with
`meta.clearance=true`, only when the goal has no in-reach MINE; route-opening options ordered before
MOVE); `src/policy.ts` `guardMine` validates a clearance target against `headroomCuts`;
`src/executor.ts` `runMine` verifies clearance by `blockRemoved` and skips `collectDrop`;
`src/jev.ts` fallback tries clearance last.
Evidence (`logs/m2-phase1d-console.log`): `no jump headroom at (0,72,-6)` ->
`action=MINE:b-1_74_-6 | mine the oak_leaves ceiling block at (-1,74,-6) to open jump headroom` ->
`executor action#2 MINE:b-1_74_-6` -> `VERIFIED MINE:b-1_74_-6 removed=true gained=0` ->
`STEP:W:b-2_74_-6` executed. `logs/m2-phase1e-console.log`: this fix is what collected the 3 logs
(identical prior runs wedged 0/14 on `no jump headroom`).

### Fix 2 — geometry-sensitive pickup (MITIGATED)
`PICKUP_SAME_LEVEL_RADIUS=1.15`, `PICKUP_NUDGE_TOTAL_MS=6000`, perpendicular `pickupAim` bearing retry
after 3 stalled nudges, and `ignoreFaceVeto` for a same-level drop (the 2-block-face fail-fast was
vetoing every ground-drop nudge). Residual: a drop that lands ~1.7 m above the bot on canopy leaves
(`pickup birch_log distance=1.77..2.1 gained=0`).

### Fix 3 — budget split: subgoal-grouped phases with a durable ledger
`GoalQueue.snapshot()/restore()`; controller `ledgerPath` + `stopAfterSubgoals` (bootstrap still calls
the planner once, so `planCalls==1` / `llm.called==false` hold; `finish()` saves the ledger);
`m2.mts --ledger <path> --stop-after <n> --no-clean` with the same offline username persists inventory
too. Restore evidence: `logs/m2-phase1b-console.log` `phase ledger restored: 0 subgoal(s) already
done; current=collect 3 x log`.

### Live ladder result
`logs/m2-phase1e-console.log` (AI_M2P5, 170 s): **2/14** in order (`collect 3 x log` -> `craft
crafting_table`), `llm.called==false` **0/19**, runtimeCalls=0 planCalls=1, FINAL INVENTORY
`{crafting_table:1, oak_planks:6, stick:4}`.
EXACT next blocker: `craft 1 x wooden_pickaxe` at a station — materials present (6 planks, 4 sticks)
but `bot.craft(recipe, 1, table)` gains 0 (`craft wooden_pickaxe gained 0 (after=0)`) -> `ABORT: wedge
(goal progress stayed 0 for 64546ms)`. The same failure blocks the M1 re-run
(`logs/m1-phase-check-console.log`, 2/4). The seed-2024 surface stone is now mined out
(`data/seed-scan.mts`: `exposed+standable=0`; trees `walkUp<=3=91`), so the cobblestone legs
additionally depend on DESCEND. `charcoal`/`iron_ingot`/`iron_pickaxe` were never offered.

### Tests
`bun run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1-test 5/5, audit-test 9/9,
step-pipeline-test 6/6; `movement-patch:check` ok (`0 hunk(s), 5 already present; verified 4/4`).

## CRAFT-AT-STATION BLOCKER FIXED (2026-09-18 00:29 JST) — `src/craftWindow.ts`

- Root cause (deeper than the prompt's guess of "open the container"): `mineflayer@4.39.0`
  `bot.craft(recipe, count, table)` sends `window_click` with the module-global `stateId` closure.
  While the crafting window is open the server keeps syncing window 0 (player inventory), and
  mineflayer adopts those packet stateIds globally, so a craft click is silently ignored
  (upstream `PrismarineJS/mineflayer#3906`). `bot.craft` resolves with no item and no error ->
  `gained 0` -> `ABORT: wedge`.
- Fix: new `src/craftWindow.ts` owns the window — `bot.openBlock(table)`, a forced
  `bot._syncWindow(win)` (a `stateId=-1` no-op click that makes the server resend the full window
  state) immediately before each click, the `craft.js` recipe-placement algorithm re-run locally,
  then `closeWindow`. `Executor.runCraft` uses it only for the table path; the proven 2x2 inventory
  path keeps stock `bot.craft`. On failure it logs recipe/delta/inventory/window and throws a clean
  `verify_failed` (no wedge).
- Secondary bug fixed: prismarine-recipe returns `outShape: null` for the pickaxe; the
  `=== undefined` guard let null through and `updateOutShape` threw `null.length` **after** the item
  was delivered. Now `== null`.
- Evidence: `logs/probe-direct3.log` (`DIRECT craftAtTable ok`, `AGENT-PATH result ... crafted 1x
  wooden_pickaxe gained=1`); `logs/m1-craftfix-console.log` live `craft recipe wooden_pickaxe ...
  table=crafting_table@-10,67,11` -> `subgoal COMPLETE [craft 1 x wooden_pickaxe] have=1`.
- Tests: `bun run typecheck` clean; guard 12/12, gating 6/6, loop 7/7, m1-test 5/5, audit-test 9/9,
  step-pipeline-test 6/6; `movement-patch:check` ok (4/4).
- NOT REACHED: M1 4/4 full re-run and the M2 charcoal/iron ladder. The seed-2024 surface stone is
  mined out (`data/seed-scan.mts`: `exposed+standable=0`) and log collection still hits the known
  canopy/pickup limit; a fresh-world phase needs a server restart/reconfig, which this task forbids.
