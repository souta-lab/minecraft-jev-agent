# M2 chain — the offline end-to-end rehearsal

> **Historical milestone evidence.** Rehearsal statement for the completed M2 milestone; the harness (`tools/m2-chain-execution*.mjs`) remains runnable for regression.

This document is the link-by-link statement of what a **fresh, no-assist M2 run
must do, in order**, what evidence each link emits, and which links are
**rehearsed** (driven, offline, through the real machinery) versus merely
**asserted** (a plan/profile claim that no Executor action has ever exercised).

It is generated from measurement, not intent. Every claim below is produced by

```bash
bun run m2-chain-execution          # the rehearsal itself (one run, one log)
bun run m2-chain-execution-test     # 12 checks over that run
bun run m2-chain-rehearsal-test     # the plan/marker half + the execution half
```

## 1. How the rehearsal drives the chain

`tools/m2-chain-execution.mjs` runs **one** fake body over **one** world model and
**one** `Executor` instance, writing **one** run-scoped JSONL log. For every link
it does exactly what the resident does, in this order:

```text
buildWorldState(fakeBot, sensorInput, defaultSensorOptions)   # the REAL sensor
  -> generateGroundedCandidates(state, {...defaultCandidateOptions, recipes})  # the REAL candidate layer
    -> executor.claim(candidate).completion                   # the REAL Executor
      -> inventory delta + the marker lines that link emitted # measured, never assumed
```

The fixture supplies **world truth only** (which cells hold which blocks, what the
body carries, what a furnace/crafting window answers). It hand-builds no
`Candidate`, hand-writes no marker line, and never reorders a link.

Not rehearsed here: the **tool bootstrap** (`logs -> planks -> crafting_table ->
pickaxe`). That link is owned by the tool-bootstrap lane and is reported as
`M2_CHAIN_EXEC_UNREHEARSED link=tool_bootstrap`. The chain below starts from a
post-bootstrap body that already holds a pickaxe:

```text
stone_pickaxe 1, crafting_table 1, furnace 1, coal 8, stick 4, cobblestone 16
```

## 2. The chain, link by link

| # | what the run must do | candidate the REAL layer must ground | evidence the link emits (run-scoped) | measured inventory delta | status |
|---|---|---|---|---|---|
| L1 | mine 3 iron ore | `MINE:b<x_y_z>` (sensed `iron_ore`) | `TOOL_CHOICE block=iron_ore tool=pickaxe reason=pickaxe_required` then `blockRemoved=true dropObserved=false raw_iron_in_inventory=N (gained 1, …)` per dig | `raw_iron +3` | **rehearsed** |
| L2 | smelt 3 `raw_iron` -> 3 `iron_ingot` | `SMELT:iron_ingot` (sensed furnace + carried coal/input) | `FURNACE_READY source=known at=x,y,z`, `SMELT_PLACED`, `SMELT_DONE item=iron_ingot gained=3 input=raw_iron fuel=coal output=3 delta=3` | `iron_ingot +3, raw_iron -3, coal -1` | **rehearsed** |
| L3 | craft the iron pickaxe | `CRAFT:iron_pickaxe` (sensed table + 3 ingot + 2 stick) | `CRAFT_DONE item=iron_pickaxe gained=1 recipe=[…] table=crafting_table@x,y,z attempt=0` | `iron_pickaxe +1, iron_ingot -3, stick -2` | **rehearsed** |
| L4 | mine 3 diamond | `MINE:b<x_y_z>` (sensed `diamond_ore`) | `TOOL_CHOICE` + `blockRemoved=true … diamond_in_inventory=N (gained 1, …)` | `diamond +3` | **rehearsed** |
| L5 | craft the diamond pickaxe | `CRAFT:diamond_pickaxe` (sensed table + 3 diamond + 2 stick) | `CRAFT_DONE item=diamond_pickaxe gained=1 …` | `diamond_pickaxe +1, diamond -3, stick -2` | **rehearsed** |
| L6 | obtain 10 obsidian from a legal source | `MINE:b<x_y_z>` (sensed `obsidian`, diamond pickaxe) — or `RETRIEVE:known:obsidian:b<x_y_z>` for a remembered far source | `TOOL_CHOICE block=obsidian …` + `blockRemoved=true … obsidian_in_inventory=N (gained 1, …)` ×10 | `obsidian +10` | **rehearsed** (sensed source); **asserted** for the >64 m remembered ruin (see §4) |
| L7 | place the 10-cell frame | `PLACE:obsidian:build:10@p<x_y_z>` carrying the geometry cells | `PORTAL_BLOCK_PLACED pos=x,y,z` ×10, then exactly one `PORTAL_FRAME_READY blocks=10 shape=ok` | `obsidian -10` | **rehearsed** |
| L8 | light it and verify it | `IGNITE:<x,y,z>` (held `flint_and_steel`, validated frame) | `PORTAL_LIT pos=x,y,z dimension=minecraft:overworld` then `PORTAL_VERIFIED=true` (6/6 interior cells become `nether_portal`) | — (world: portal lit) | **rehearsed** |
| L9 | the gate's own verdict on the run | — (no candidate kind exists; verification is the L8 action's postcondition) | `tools/m2-gate.mjs` reads the chain `PORTAL_BLOCK_PLACED -> PORTAL_FRAME_READY -> PORTAL_LIT -> PORTAL_VERIFIED` plus the `diamond`/`obsidian`/`flint_and_steel` inventory samples | — | **asserted** (by `bun run m2-chain-rehearsal-test`, which PASSes the real gate on a synthetic single-run fixture) |
| — | tool bootstrap: `logs -> planks -> crafting_table -> pickaxe` | owned by the tool-bootstrap lane | — | — | **not rehearsed here** (named once, by design) |

Measured end state of the rehearsal run:

```text
iron_pickaxe 1, diamond_pickaxe 1, obsidian 0, flint_and_steel 1, lit=true
```

## 3. The first link that cannot be driven

**No link of the five classes fails to drive.** All eight links above are driven
end to end (`M2_CHAIN_EXEC result=DRIVEN links=8/8 first_undrivable=none`).

The first link that a rehearsal **could not drive without re-implementing a
server mechanism** was **L3 `craft the pickaxe`**, and the reason is structural:

```text
jev-agent/src/executor.ts:7204   await craftAtTable(this.bot, table, recipe as ..., faceVec)
jev-agent/src/craftWindow.ts:57  const win = await bot.openBlock(table, face)
                                 -> bot._syncWindow / bot.clickWindow / bot.putSelectedItemRange
jev-agent/src/executor.ts:7187   await this.bot.craft(recipe, craftCount)   # the 2x2 arm
```

Both craft arms actuate through the **raw `Bot`**, while the allowlisted
`ActuationPort.craft` capability (`jev-agent/src/actuationPort.ts`, implemented
and lease-asserted at `buddy-driver/resident-safety.ts:729`) is called from **nowhere
in the repository**. Consequence, measured: a fixture that supplies only world
truth cannot perform the craft — it must emulate prismarine's window protocol
(slots, click semantics, quick-shift, `selectedItem`) — and a protocol failure
surfaces as `failure=unknown_event` (`executor.ts`, the non-`ExecutorError`
branch), i.e. with **no typed reason**. The rehearsal now provides that window
emulation, which is why L3/L5 are rehearsed at all.

The naive fix (route the table craft through `port.craft`) was **not** taken: the
host port delegates to `bot.craft(recipe, count, table)`, which is exactly the
upstream path `craftWindow.ts` exists to replace (the `stateId` defect), so that
route would trade an evidence gap for a live crafting regression. The residual is
recorded in §5.

## 4. The measured frontier (where the chain still has no route)

`M2_CHAIN_EXEC_FRONTIER` measures the world shapes in which a source is sensed and
still yields nothing. All four are measured by the same real sensor + candidate
layer:

| case | world shape | measured result |
|---|---|---|
| `F1_unlit_complete_ring` | an **intact but unlit** obsidian ring (a frame-shaped ruin, or another body's cold gate), 14 cells in reach, diamond pickaxe | `frame=ok live_members=20 mine_candidates=0` — **no candidate, no withheld route** |
| `F2_lit_ring` | the same ring **lit** (the inherited portal) | `mine_candidates=0` — correctly protected |
| `F3_unlit_fragmented_ring` | the same ring with one required **edge** missing, unlit (the damaged ruin) | `frame=none live_members=0 mine_candidates=3` — **legal source, mineable** |
| `F4_wrong_tool_at_source` | 10 legal obsidian cells in reach and only an **iron** pickaxe (obsidian needs diamond) | `sensed=10 in_reach=10 mine_candidates=0` and **`withheld=none`** — the tool need is silent |

F1 and F4 are the two shapes a live obsidian run can still die on. F1 is a
deliberate, test-pinned protection (`test-live-structure-source.mts` asserts an
unlit complete ring is a live structure), so this lane **reports** it rather than
reversing it: in the operator's world the legal source is the ~399-block unlit
ruined portal, and the measurement says an intact ring there is not a source —
only a fragmented one is. F4 (`candidates.ts`, the tool-gated `continue` in
`mineCandidates`) is the class-level silence: a sensed producer whose harvest
tool the body lacks produces no candidate, no withheld entry and no typed fact,
so nothing can turn it into "obtain a tool".

## 5. What this lane fixed, and the honest residual

**Fixed (general, class-level, no coordinate/seed/order/milestone branch):** the
craft arm's missing typed, mirrored outcome evidence. `formatCraftLog` in
`jev-agent/src/executor.ts` now emits

```text
CRAFT_DONE   item=<item> gained=<verified inventory delta> recipe=<delta> table=<name@x,y,z|none> attempt=<n>
CRAFT_FAILED item=<item> reason=<reason> recipe=<delta> table=<name@x,y,z|none>
```

and both tokens are registered in `MIRRORED_MARKERS`
(`jev-agent/src/controller-legacy.ts`), so the host mirror carries them. Before
this, the "obtain a tool" link was the **only** link of the chain with no typed
run-scoped line: the acceptance artifact could show the pickaxe in an inventory
sample but could never show that a craft happened, for which item, or why it
failed. `CRAFT_DONE` is derived from the verified inventory delta, never from the
intent.

**Residual (named, not hidden):**

1. the craft arm still has no injectable execution seam
   (`executeFurnaceSmelt` is exported; `runCraft` is private and reaches the
   window protocol directly), so a rehearsal must emulate that protocol;
2. `F1` — an intact unlit obsidian ring is not a legal source (test-pinned
   protection; needs a product decision, not a lane change);
3. `F4` — a sensed source the held tool cannot harvest is silent
   (`candidates.ts`, `mineCandidates`' tool-gated `continue`), so the tool need
   never becomes a fact the acquisition closure can answer;
4. `RETRIEVE:known:obsidian:*` for the ~399 m ruin is **asserted, not rehearsed**:
   the rehearsal drives the sensed source (600 blocks of walking are a live
   question), and the retrieval route's own declaration is covered by the
   obsidian lane's suite.
5. This rehearsal proves the offline chain, not live obtainability: server-side
   acceptance of a dig/place/craft and real world geometry remain LIVE questions.
