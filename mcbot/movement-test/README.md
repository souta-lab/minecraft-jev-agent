# movement-test — bare-Mineflayer movement / rubber-band A/B/C harness

Minimal, **bare** Mineflayer reproduction harness for the rubber-banded movement
observed on the local Leaf **26.1.2** server (protocol **775**, `127.0.0.1:25565`).
No jev-agent, no pathfinder, no extra plugins — only `mineflayer` + its built-in plugins.

The question this answers:

> Is the rubber-banded movement a Mineflayer / protocol-layer problem (and not our
> agent code), and **which** upstream Mineflayer movement fix removes the server
> position correction?

**Short answer:** it is a Mineflayer problem (bare Mineflayer reproduces it, so
jev-agent is innocent), **but none of the PRs the task guessed do**. The only
upstream change that measurably removes the correction loop is
**PrismarineJS/mineflayer PR #4063** (`feat/vanilla-movement-packets`,
head `fc480ee8c456de87ce77769b31ba8bcf88703043`) — it breaks the loop in the matched
test (21 → 5) and roughly halves the forcing rate elsewhere, though it does not remove
the underlying client-side collision push. See [Conclusion](#8-conclusion).

---

## 1. Layout

```
movement-test/
  probe.mjs                  the harness (single file; loads a variant's mineflayer)
  package.json
  README.md                  this report
  logs/                      raw JSONL + per-run summary JSON (evidence)
  variants/
    A/ node_modules/mineflayer         stock mineflayer@4.39.0 (npm registry)
    B/mineflayer-src                   git PR #4107 head 4ac7233…
    C/mineflayer-src                   B + PR #4128 diff + local minecraft-data flag
    E/mineflayer-src                   git PR #4108 head 4f31b3e1…
    F/mineflayer-src                   C + PR #4108 diff
    G/mineflayer-src                   git PR #4063 head fc480ee8…   ← the fix
    H/I/J/K/L/mineflayer-src           G + one-line ablations (see §6)
    C/patch-minecraft-data.mjs         applies the minecraft-data#1304 flag (C only)
```

Nothing under `~/mc-ai/mcbot/node_modules` or `~/mc-ai/jev-agent/` was modified.

## 2. How to run

```bash
cd ~/mc-ai/mcbot/movement-test

# canonical run: stand 10 s, walk up to 5 blocks / 6 s, settle 1.5 s
node probe.mjs --variant A --username AI_Bot --stand-seconds 10 --walk-seconds 6 --settle-seconds 1.5 --terrain drop

# open-ground run (auto-picks the longest clear straight run)
node probe.mjs --variant G --username AI_QB --terrain flat
```

Output (stdout):

```
VERDICT: rubberband=yes|no corrections=N maxDelta=X.X
DETAIL: forcedRepositions=F selfPins=P snapBacks=S maxDisplacement=D expected~E stall=yes|no tickEnd=T finalClientVsServer=V
```

Per run it writes `logs/<variant>-<tag>-<ts>.jsonl` (raw, timestamped, both
directions) and `logs/<variant>-<tag>-<ts>.summary.json`.

### Probe procedure (as required)

1. `mineflayer.createBot({ host:'127.0.0.1', port:25565, username, auth:'offline' })` — **no pathfinder, no plugins**
2. join, **stand still 10 s** (`--stand-seconds`)
3. scan 8 compass directions for the longest flat, step-free run and face the best one
   (`--terrain flat|drop|auto`; `drop` deliberately aims at a ledge, ≤5 blocks)
4. `bot.setControlState('forward', true)`; walk until ≈5 blocks horizontal displacement or 6 s
5. stop, settle 1.5 s
6. compare client position vs server-side position (a second stand-still observer bot `AI_Observer`
   reads the server's authoritative view of the walker via `bot.players['AI_Bot'].entity.position`)

### Packet logging

Raw timestamped JSONL for both directions. S→C: `position`, `position_look`,
`player_auth_input`/`move_player` (if present), `ping`, `kick_disconnect`,
`disconnect`, `login`, `respawn`, `update_health`. C→S (captured by wrapping
`bot._client.write`): `teleport_confirm`, `position`, `look`, `position_look`,
`flying`, `player_input`, `player_auth_input`, **`tick_end`**.

The serverbound 26.1 protocol has no `player_auth_input` packet (Java uses
`position`/`position_look`/`look`/`flying` + `player_input`); it never appears.

### Correction classification

* `correction` — S→C `position` whose target differs from the bot's **last sent**
  position by **> 0.5 blocks** (the task's definition). Reported as `corrections` / `maxDelta`.
* `forcedReposition` — *any* S→C `position` after the initial spawn placement,
  during the measurement window. Reported as `forcedRepositions`.
* `selfPin` — a forced reposition whose target is where the client already is
  (`dClientAtReceive < 0.5`). This is the failure mode that the 0.5-block rule misses.
* `rubberband` — `corrections > 0` **OR** `forcedRepositions ≥ 2` **OR** the walk
  stalls short of its target while the server forces positions.

> In the reproduced failure the server re-sends the client's **own** position every
> tick, so `corrections` (target − last-sent) is ~0. The >0.5 metric therefore reads
> `corrections=0 maxDelta=0.0` even though the bot is visibly pinned. `forcedRepositions`
> is the metric that actually captures it. Both are reported.

## 3. Start position (documented, repeatable)

The Leaf server respawns each player at their **saved logout position**.

* `AI_Bot` inherits the position left by the jev-agent demo and, after the first
  drop run, respawns at the bottom of a small **2-block pit at `(3.305, 64.0, -67.698)`**.
  Reconnecting at the same spot makes the pit/wall-contact test **reproducible**
  (successive runs of different variants start from the same coordinates — verified
  in the `walker_spawn` log records, e.g. A and G both started at
  `3.305,64.0,-67.698` for matched trials).
* The world-spawn region (fresh offline usernames, `spawnRadius` spread) is open
  ground around `(25.5, 63, −62) ± 10`; used for the open-ground runs.

World is freshly generated, peaceful, `spawn-protection=0`; no terrain was modified.

## 4. Variants and upstream verification (`gh`, 2026-09-17)

| Variant | Contents | Source | State | Head SHA |
|---|---|---|---|---|
| **A** | unmodified published `mineflayer` | npm | 4.39.0 | — |
| **B** | A + PR **#4107** (answer pings/teleports at next tick, arrival order) | `PrismarineJS/mineflayer` | **OPEN** | `4ac7233799487bc7b105bb8504dd50e04dd9306b` |
| **C** | B + PR **#4128** (serverbound `tick_end` each tick; `lastSent.time` after forced move) | idem | **OPEN** | `5152c76759841d8e10605e01c3864a707c5bb53b` |
| **D** | PR **#4125** (`accept_teleportation` carries x/y/z/yaw/pitch on 26.3) | idem | **OPEN** | `93c8c160bd243716e75caad558f9492c5bc4e9be` |
| **E** | A + PR **#4108** (a teleport leaves the standing flag alone) | idem | **OPEN** | `4f31b3e149a462651e5744497f0d81a6d31990d6` |
| **F** | B + #4128 + #4108 (full guessed stack) | idem | — | B/C/E SHAs above |
| **G** | PR **#4063** (send the vanilla movement input packets; tick_end; hasHorizontalCollision; teleport reply) | idem | **OPEN** | `fc480ee8c456de87ce77769b31ba8bcf88703043` |

**D is skipped, and PR #4125 does not apply.** Our server is Leaf **26.1.2 /
protocol 775**; `minecraft-data@3.116.0` declares
`play.toServer.packet_teleport_confirm = { teleportId: varint }` for 26.1 — the
x/y/z/yaw/pitch fields #4125 adds only exist from 26.3 / protocol 777. Nothing to test.

Related PRs found while verifying:

| PR | Title | State | Head SHA | Note |
|---|---|---|---|---|
| **#4063** | physics: send the movement input packets the vanilla client sends | OPEN | `fc480ee8…` | **the fix** (§6) |
| #3947 | Send horizontal collision state in movement packets | CLOSED 2026-07-20 | `2ab709b6…` | based on mineflayer 4.37.1 — **does not support 26.1**, cannot connect |
| #4108 | physics: a teleport leaves the standing flag alone | OPEN | `4f31b3e1…` | tested as E; does not fix |
| #4099 | write no movement packets outside play | MERGED 2026-09-17 | `37ac6d99…` | not this scenario |
| `minecraft-data` #1304 | add `clientTickEndPacket` flag | OPEN | `ebd0242e…` | 3.116.0 already has `sendsClientTickEndPacket`; applied locally for C only |

C's `minecraft-data` flag was applied by `variants/C/patch-minecraft-data.mjs`
into **variant C's own** `node_modules` (exactly equivalent to #1304; the wire
`tick_end` packet id `0x0d` already exists in 26.1's `protocol.json`).

## 5. Results

### 5a. Canonical runs — stand 10 s, walk 6 s, ledge/pit start

Same start (pit bottom), ≥2 runs each; the final run below.

| Variant | rubberband | forcedRepositions | selfPins | maxDisplacement (of ~6.5) | `tick_end` sent | final client=server |
|---|---|---|---|---|---|---|
| **A** stock 4.39.0 | **yes** | **21** | 21 | 1.389 | no | yes (0.00) |
| **B** #4107 | **yes** | 16 | 16 | 1.391 | no | yes |
| **C** B+#4128 | **yes** | 16 | 16 | 1.398 | **yes (283)** | yes |
| **E** #4108 | **yes** | 20 | 20 | 1.373 | no | yes |
| **F** B+#4128+#4108 | **yes** | 19 | 19 | 1.382 | yes | yes |
| **G** #4063 | reduced → **transient** | **5** | 5 | 1.391 | yes | yes |

Repeats agree: A = 21,21,21,21; B = 16,16; C = 16,16; E = 19,20,20; F = 18,19; G = 5,5,5,5.
All variants print `VERDICT: rubberband=yes corrections=0 maxDelta=0.0` because the
server pins the client to its **own** position (see §4 note) — the differentiator is
`forcedRepositions` (A 21 endless vs G 5 transient).

### 5b. Open-ground runs (fresh username, clear straight path)

| Variant | forcedRepositions | maxDisplacement | tick_end |
|---|---|---|---|
| A | 0 | 5.52 / 5.81 | no |
| B | 0 | 5.4 | no |
| C | 0 (one terrain-confounded run: 18) | 5.3 | yes |
| E | 0 | 5.39 | no |
| G | 0 / 0 | 5.39 / 5.39 | yes |

**On open flat ground bare Mineflayer does not rubber-band** in any variant. The
endless correction needs the bot to be in contact with terrain (ledge, step-down,
pit wall). The correction loop is what broke the jev-agent demo.

### 5c. Random-terrain runs (fresh usernames, `--terrain drop`)

Terrain contact is the trigger, so the outcome tracks geometry, not the variant:

| Variant / user | walk outcome | forcedRepositions | maxDisplacement |
|---|---|---|---|
| A AI_DA1 | **stall** | 19 | 3.18 |
| A AI_DA2 | displacement | 0 | 5.39 |
| A AI_DA3 | displacement | 0 | 5.48 |
| G AI_DG1 | displacement | 0 | 5.48 |
| G AI_DG2 | **stall** | 13 | 2.20 |
| G AI_DG3 | displacement | 0 | 5.39 |

Walk outcome is dominated by whether the auto-chosen direction ends in a wall/pit,
for **both** variants. Where A loops every ~52 ms (A-slope1: 19 teleports,
`dLast=0.005` constant), G loops every ~92 ms (G-slope2: 13 teleports) — G halves
the forcing rate but does **not** remove it on deeper terrain. Neither variant can
leave a pit: the probe has no jump/climb logic (out of scope for a bare movement test).

## 6. Raw packet evidence

### A — stock mineflayer: the server re-teleports **every tick** while the bot pushes into the pit

`logs/A-final-…jsonl`, walk phase (1 s window), ids 8→13, forever (21 total):

```
S2C position          tpId=8   z=-66.3089  y=64.00     <- server target == client's own position
  -> CORRECTION       dLast=0.009
C2S teleport_confirm  tpId=8
C2S position_look     z=-66.3089  onGround=false
S2C position          tpId=9   z=-66.3089  y=64.00
  -> CORRECTION       dLast=0.009
C2S teleport_confirm  tpId=9
C2S position_look     z=-66.3089  onGround=false
S2C position          tpId=10  z=-66.3089  y=64.00
  -> CORRECTION       dLast=0.009
C2S teleport_confirm  tpId=10
C2S position_look     z=-66.3089  onGround=false
... (tpId 11,12,13,... every ~50 ms until the walk ends)
```

Full A-final teleport list: `tpId 2..22`, t=12389→13639, `dLast` constant `0.009`,
**one per server tick**, all `phase=walk`. The client reports `onGround=false` while
standing in the pit, so its physics keeps nudging forward 0.009, the server keeps
setting it back, and the loop never settles.

### G — PR #4063: same window, same start, no correction

```
C2S tick_end
C2S tick_end
C2S tick_end
C2S tick_end
C2S tick_end
C2S tick_end
```

G's teleports: `tpId 2..5` during the initial descent (dLast 0.136→0.002) plus one
`tpId 6` right after the walk stops, then **nothing** — the client settles at the
server position. `tick_end` is sent every physics tick (≈20/s).

### `tick_end` was never sent by stock Mineflayer

A/B/E logs contain zero C→S `tick_end`. C/F/G send it (283 / 283 / 288 in the
canonical runs). It made **no difference** to the rubber-band (C = 16 pins).

### Client/server agreement

Every run ends with `finalClientVsServer = 0.00`: once the loop stops, the client
and the server agree. The symptom is the *repeated forcing*, not a permanent offset.

## 7. Root cause + attribution

The correction loop is a **movement-packet bookkeeping** bug in Mineflayer, triggered
by terrain contact (wall / ledge / pit) — not the teleport reply *timing* of #4107 nor
the missing `tick_end` of #4128.

G's improvement was bisected by one-line ablations of PR #4063's changes
(same pit start, 2 runs each):

| Ablation | forcedRepositions | Meaning |
|---|---|---|
| G as-is | **5** | fix present |
| H: `collidedHorizontally()` forced false | **5** | `hasHorizontalCollision` is **not** the cause |
| I: `hasTickEndPacket = false` | **5** | `tick_end` is **not** the cause |
| J: `hasPlayerInputPacket = false` | **5** | `player_input` is **not** the cause |
| K: stock exact movement threshold instead of `2e-4` | **15** | vanilla `2e-4` threshold contributes |
| L: stock teleport reply (`sendPacketPositionAndLook`, which writes the teleport target into `lastSent`) | **21** | teleport-reply bookkeeping is the main fix |

Mechanism:

* Stock `physics.js` answers a clientbound teleport with
  `sendPacketPositionAndLook(pos,…)`, which **sets `lastSent` to the server's target**.
  Next tick the client physics nudges 0.009 into the terrain, `lastSent !== position`,
  so it sends a position packet the server rejects → teleport → repeat, forever.
* PR #4063's `sendTeleportReply()` answers the teleport **without touching `lastSent`**,
  so the next tick compares against the position the client itself last sent; the
  sub-threshold nudge no longer produces a packet, and the loop breaks. Its vanilla
  `2e-4` movement threshold (instead of exact inequality) removes the remaining
  sub-threshold churn (K = 15).

## 8. Conclusion

* **Is our jev-agent innocent?** **Yes.** Bare Mineflayer (no pathfinder, no agent
  code) reproduces repeated server position forcing on the same server; the
  corrections come from Mineflayer's own movement-packet emission, not from jev-agent.
* **Is it Mineflayer/protocol-layer?** **Yes** — Mineflayer 4.39.0 (a) answers a
  clientbound teleport with `sendPacketPositionAndLook`, which records the server's
  target as its own last-sent position, and (b) sends a movement packet for
  sub-threshold jitter (exact inequality instead of vanilla's `2e-4`). While the bot
  is in contact with terrain the server rejects that packet every tick and sends a
  new teleport with an incrementing `teleportId`.
* **Which fix removes it?** **PR #4063** (`feat/vanilla-movement-packets`, head
  `fc480ee8c456de87ce77769b31ba8bcf88703043`) is the only one that changes it:
  (a) answer a teleport **without** recording it in `lastSent`, plus
  (b) the vanilla `2e-4` movement threshold. In the matched pit test it breaks the
  loop (21 → 5 corrections, then the bot settles); on random terrain it roughly halves
  the forcing rate (≈52 ms → ≈92 ms between corrections) but does not eliminate
  forcing in deeper pits, because the client physics keeps pushing into the block.
  No client protocol patch can remove that last part; it is client-side collision
  resolution, and the server config must not be loosened.
* **Do the guessed PRs fix it?** **No.** #4107 → 16, #4128 → 16, #4108 → 20,
  #4107+#4128+#4108 → 19, all still loop. #4125 does not apply on 26.1.2/protocol 775.
  #3947 (horizontal collision) cannot run on 26.1 (its branch is mineflayer 4.37.1).
* **Server untouched.** No server config was modified; the only write outside
  `movement-test/` (a `features.json` edit made by a mis-resolving helper script) was
  reverted byte-for-byte and verified identical to the npm `minecraft-data@3.116.0`
  tarball.

### Recommended pin

In `~/mc-ai/mcbot/` and jev-agent, pin Mineflayer to PR #4063:

```
npm i github:PrismarineJS/mineflayer#fc480ee8c456de87ce77769b31ba8bcf88703043
```

Caveat: #4063 is an **open, unmerged** PR. If a minimal, self-contained patch is
preferred over an unmerged branch, port just its two movement changes into
`node_modules/mineflayer/lib/plugins/physics.js`:
1. a `sendTeleportReply()` that writes `position_look` for a teleport **without**
   mutating `lastSent.x/y/z` (leave `lastSent` on the pre-teleport value), and
2. change `updatePosition`'s `positionUpdated` to the vanilla threshold
   `dx*dx+dy*dy+dz*dz > 4e-8 || positionReminder >= 20`.

The ablations show those two changes are what matter (L 21→G 5, K 15→G 5).

### Bottom line for the jev-agent symptom

The demo's rubber-band is **not** the teleportId mismatch it guessed, and **not**
the teleport-reply-timing or `tick_end` PRs. It is bare Mineflayer sending a
rejectable movement packet while the bot is pressed against terrain, which the Leaf
server answers with a teleport every tick. Adopting #4063 removes the per-tick
amplification (and the false "corrections" that corrupt planner waypoints), but the
planner/agent should still treat "pressed against terrain" as a state to recover from
(jump/move away) rather than expecting client-side walking to always be accepted.

---

## 9. Vertical movement (M1 blocker): pit escape / step climb — diagnosis + fix

The M1 blocker was *not* "jump does not reach the server". A pure jump on flat ground
rises the full `1.2522` blocks on **both** stock 4.39.0 (A) and PR #4063 (G), and the
server accepts it (`forcedRepositions = 1`, the initial placement). The blocker is
**when** the jump is sent relative to terrain contact.

### 9.1 Mechanism (packet-level)

While the body is pressed into a solid block, the Leaf server **rejects a movement
packet that combines a blocked forward push with a jump**: it immediately answers with
a `position` teleport back to the client's own pre-jump position and the bot never
leaves the ground. A jump *initiated before contact* (horizontal move still free) is
accepted and carries the bot onto the step.

`_handle`: failure, log `G-step2G-…jsonl`, bot pinned at x=31.699 z=-59.301:

```
2627.5 C2S player_input   {forward:true, jump:true, …}
2627.7 C2S position_look  {x:31.768, y:63.420, z:-59.300, onGround:false,
                           flags:{onGround:false, hasHorizontalCollision:true}}
2628.1 S2C position       {teleportId:2, x:31.699, y:63.000, z:-59.301, dx:0,dy:0,dz:0}
       -> server teleport, dClient=0.426  (jump rejected)
2628.1 C2S teleport_confirm {teleportId:2}
       ... repeats every tick: tpId 2,3,4,…  (162 forced repos in 12 s)
```

Success, log `G-step1G-…jsonl`, pre-contact jump (free space ahead):

```
2987.9 C2S player_input   {forward:true, jump:true, …}
2988.1 C2S position_look  {x:31.542, y:63.420, z:-58.500, onGround:false,
                           flags:{onGround:false, hasHorizontalCollision:false}}
3039.6 C2S position       {x:31.677, y:63.753, …}        <- no teleport
3089.8 C2S position       {x:31.819, y:64.001, …}
3193.8 C2S position       {x:32.122, y:64.249, …}        <- apex, lands on the step
       forcedRepositions = 1 (initial placement only)
```

Controls: pure jump while pinned → accepted (`forcedRepositions=1`); walking *away*
from the obstacle → accepted (`forcedRepositions=1`); forcing the client's
`hasHorizontalCollision` flag to `false` → **no change** (the rejection is the server's
own collision validation, not the flag). `tick_end` is irrelevant here (A has zero
`tick_end` and still climbs/escapes).

### 9.2 Fix — `vertical.mjs` `navigateTo()` (harness-level actuator recipe)

File: `movement-test/vertical.mjs` (new). Core change vs `probe.mjs` (which had **no**
jump logic at all — that alone explains "the probe cannot leave a pit"):

1. `scanAhead(c, ux, uz)` scans 0.8…2.8 blocks along the travel direction for the first
   column whose surface is `1..2` above the current feet level.
2. If a climbable rise is within `2.2` blocks and the bot is grounded **and not yet
   colliding**, jump **pre-emptively** while keeping forward held. The packet therefore
   has a free horizontal component → the server accepts it.
3. If already pinned (`isCollidedHorizontally`), do a **vertical hop** (forward
   released, `jump` held ~180 ms) then push forward while airborne; if still pinned,
   back off ~300 ms so the next approach can jump before contact.
4. Never send `jump + blocked-forward` in one packet.

```js
// key loop body (vertical.mjs, navigateTo)
const ob = scanAhead(c, ux, uz)
const climbable = ob && ob.rise >= 1 && ob.rise <= 2 && ob.dist <= 2.2
if (climbable && bot.entity.onGround) {          // pre-emptive jump, forward held
  bot.setControlState('forward', true); bot.setControlState('jump', true)
  await sleep(110); bot.setControlState('jump', false); await sleep(220)
} else { bot.setControlState('forward', true); bot.setControlState('jump', false) }
// pinned recovery: forward=false + jump=true (accepted), then forward while airborne
```

`region-read.mjs` (new, read-only Anvil reader) and `digpit`/`fill` modes exist only to
build/inspect controlled terrain and restore it; they are not part of the fix.

### 9.3 Results (G unless noted)

| Scenario | Outcome | forcedRepositions |
|---|---|---|
| Pure jump, flat (A and G) | rises **1.2522** (exact vanilla) | **1** |
| 1-block step, pre-contact jump, axis-aligned approach | climbs, maxY +1.249, 1 jump | **1** |
| 1-block step, diagonal approach through a corner | climbs | 17–18 (recoveries) |
| 1-deep dry pit (5 independent runs) | escapes, 1 jump, +1.177 | **1** |
| 1-deep dry pit, **stock A** | escapes, 1 jump, +1.177, `tickEnd=0` | **1** |
| **2-deep pit** (vertical 2-block lip, dug) | **cannot escape** (all lips fail) | 302 |
| 2-deep pit **with a 1-block bench** (two 1-block hops) | **escapes**, +2, 3 jumps | 9 |

Success `forcedRepositions = 1` means only the initial spawn placement: zero
corrections during the climb. The 2-deep-pit numbers are the measured jump limit, not a
recipe failure: apex is `1.2522 < 2.0`, so a vertical 2-block face is impossible for a
vanilla-out-of-the-box client (no digging/placing). The bench run shows "2-block
terrain while walking" is solved as two 1-block hops.

1-deep pit success (log `G-dry_AI_M1Probe2-…jsonl`), zero teleports:

```
5986   pit_built: inPit {x:28.5, y:62, z:-60.5}  floorTop=61
5994.2 C2S player_input  {forward:true, jump:true}
5994.5 C2S position_look {x:28.598, y:62.420, flags:{hasHorizontalCollision:false}}
6044.1 C2S position      {x:28.671, y:62.753}
6093.3 C2S position      {x:28.757, y:63.001}
6194.3 C2S position      {x:28.964, y:63.249}   <- lands on the lip (y 62 -> 63)
       no S2C position teleport anywhere in the escape
```

2-deep pit failure (log `G-dig2d-…jsonl`): floorTop 63, feet 64; lips tried rise
`5,5,5,3,3,2`; `jumps=0..6`, all `onLip=false`, 302 forced repos. 2-deep + bench
(log `G-bench1-…jsonl`): `escape_attempts[0] = {lip: rise 2, viaBench:true, onLip:true,
jumps:3}`, `rose:2`.

### 9.4 Reproduce

```bash
cd ~/mc-ai/mcbot/movement-test

# terrain recon (live, via the bot)
node vertical.mjs --variant G --mode recon --username AI_R1

# flat jump sanity (expect rose=1.2522, forcedRepositions=1)
node vertical.mjs --variant G --mode jump  --username AI_J1

# climb a 1-block step / 1-deep pit (use a fresh or free saved username)
node vertical.mjs --variant G --mode nav    --username AI_N1 --target 32.5,64,-58.5
node vertical.mjs --variant G --mode digpit --username AI_P1 --depth 1
node vertical.mjs --variant A --mode digpit --username AI_P2 --depth 1   # stock baseline

# 2-deep pit (expect escaped=false) and 2-deep+bench (expect escaped=true)
node vertical.mjs --variant G --mode digpit --username AI_D2 --depth 2
node vertical.mjs --variant G --mode digpit --username AI_D3 --depth 2 --bench
```

Notes: use a fresh username per run so the offline server does not respawn the bot at a
previous (possibly stuck) position; `AI_Bot`/`AI_Stone` are owned by the concurrent
jev-agent M1 run. Do not dig where `--depth` reports `water` (the hole floods and the
measurement becomes a swim test) — `digpit` now aborts in that case.

### 9.5 Recommendation for the agent (movement-only, `canDig=false`)

Treat a 1–2 block rise as a **jump before contact** decision, not a collision reaction:
scan the block column ahead, and if the surface rises ≤2 and the horizontal move is
still free, jump while holding forward. Recover from an already-pinned state by hopping
vertically first, then moving in the air, or backing off one block. A vertical 2-block
face has no client-side solution without placing/digging and must be routed around
(natural terrain almost always offers a 1-block staircase, which the two-hop path climbs).

### 9.6 Residual test artifacts

Controlled pit construction left one small hole (2×1 footprint, 2 deep) at
`(40..41, 64..66, -57)`; all other test holes were refilled. No server config, world
backups, or other directories were touched.

---

## 10. Files added for this diagnosis

| File | Purpose |
|---|---|
| `vertical.mjs` | focused jump / step / pit / nav / digpit harness + the fix recipe |
| `region-read.mjs` | read-only Anvil (`.mca`) reader used to inspect terrain geometry |

