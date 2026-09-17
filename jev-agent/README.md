# jev-agent

A **Mineflayer plugin** that drives a bot through a
`Sensor → WorldModel → deterministic candidates → Jev policy → deterministic guard → Executor → Verify`
loop, with a runnable proof-of-concept that finds a tree, chooses `oak_log`, digs it and verifies the result.

Mineflayer is not forked, patched or vendored here. Pathfinder and this agent are both ordinary
`bot.loadPlugin()` extensions, which is what Mineflayer was designed for:

```
mineflayer  →  pathfinder / tool plugins  →  jev-agent plugin  →  brain / policy / executor
```

## Architecture

```
        ┌──────────────────────────── mineflayer (≈50 ms, physics/execution) ───────────────────────────┐
        │                                                                                              │
 Minecraft │  bot.entity · bot.inventory · bot.entities · bot.blockAt · bot.dig · bot.pathfinder         │
        │                                                                                              │
        └───────────────▲───────────────────────────────────────────────────────────▲──────────────────┘
                        │                                                           │
             ┌──────────┴───────────┐   ┌──────────────────────┐   ┌────────────────┴──────────────┐
             │  SENSOR  state.ts    │──▶│ CANDIDATES           │──▶│  JEV POLICY      jev.ts       │
             │  JSON world state:   │   │ candidates.ts        │   │  ai v7 experimental_evaluate  │
             │  self, inventory,    │   │ deterministic ids:   │   │  model typesafe-ai/jev        │
             │  entities, blocks,   │   │ MINE:b12_64_-50      │   │  choice / score / boolean     │
             │  terrain, goal,      │   │ ATTACK:e19           │   │  or deterministic fallback    │
             │  recentEvents,       │   │ EAT:bread            │   └────────────────┬──────────────┘
             │  signals             │   │ MOVE:p1_64_0 / WAIT  │                    │ chosen candidate id
             └──────────────────────┘   │ RETREAT / ESCALATE   │                    ▼
                        ▲               └──────────────────────┘   ┌──────────────────────────────────┐
                        │                                          │ 2D GATE  gating.ts               │
                        │                                          │ score = (value x certainty); a   │
                        │                                          │ low-certainty score is ignored   │
                        │                                          └────────────────┬─────────────────┘
                        │                                                           ▼
                        │               ┌──────────────────────────────────────────────────────────┐
                        │               │  GUARD  policy.ts  - 100% mechanical, never a model call  │
                        │               │  UNKNOWN_CANDIDATE · EMPTY_HAND · TARGET_GONE             │
                        │               │  STALE_COORDS · OUT_OF_REACH · NO_SUPPORT · LAVA_RISK     │
                        │               │  CONFLICT_IN_FLIGHT · ALREADY_DONE                        │
                        │               └──────────────────────────┬───────────────────────────────┘
                        │                                          │ ok
                        │               ┌──────────────────────────▼───────────────────────────────┐
                        │               │  EXECUTOR  executor.ts  - single-action ownership         │
                        │               │  actionEpoch + AbortController + currentAction            │
                        │               │  pathfinder (canDig=false)  →  bot.dig()  →  VERIFY        │
                        └───────────────┴──────────────────────────────────────────────────────────┘
```

Rate tiers (the loop respects all three):

| Layer | Rate | Responsibility |
| --- | --- | --- |
| System 2 LLM (stub) | ~0.05 Hz | goal / strategy, long-horizon planning, recovery, replanning on escalation |
| **Jev** | **2–5 Hz at most, event-driven** | local policy, target selection |
| **Mineflayer** (physics / pathfinder) | ≈50 ms → 20 Hz | movement, physics, execution |

## Event-driven Jev scheduling (`src/scheduler.ts`)

Jev is **not called on a fixed period**. A decision is requested by world events, with a maximum
heartbeat as the fallback:

| Trigger | Source |
| --- | --- |
| `block_broken` | `bot.on('blockUpdate')`, old block → air |
| `path_completed` | `bot.on('goal_reached')` + the executor's pathing phase hook |
| `mob_appeared` | `bot.on('entitySpawn')` for a hostile mob |
| `hp_changed` | `bot.on('health')` |
| `inventory_changed` | `bot.on('playerCollect')` / `inventory.updateSlot` |
| `action_completed` | the executor's action promise resolves |
| `action_timeout` | the action failed with `path_timeout` / `dig_timeout` |
| `heartbeat` | every `heartbeatMs` (default 500 ms), **only while idle** |
| `start` | the agent starts |

While an action is in flight, non-preemptive triggers are **deferred**, not re-asked, so a
three-second walk asks Jev once instead of six times. The preemptive triggers (`mob_appeared`,
`hp_changed`, `action_timeout`) may interrupt an in-flight action. Both the heartbeat and the
enabled trigger set are configurable (`heartbeatMs`, `enabledTriggers` / `--heartbeat`,
`--triggers`), and the fired trigger is logged and written into every decision record.

`minDecisionIntervalMs` (default 150 ms) is a floor between decisions that also forces a macrotask
yield, which stops a fast-failing action from hot-looping and starving timers.

### Files

| File | Purpose |
| --- | --- |
| `src/state.ts` | SENSOR: live bot → JSON `WorldState`. Jev consumes this object directly. |
| `src/candidates.ts` | Deterministic candidate generator. Only emits actions that are executable *right now*. |
| `src/jev.ts` | `JevPolicy`: `TypeSafeJevPolicy` (`ai` v7 `experimental_evaluate`) + marked `FallbackJevPolicy`. JSONL logging. |
| `src/gating.ts` | The `(value x certainty)` gate for `score` answers; `DANGER_CONFIDENCE_THRESHOLD`, `applyDangerGate`, `preserveCurrentSafeAction`. |
| `src/scheduler.ts` | The event-driven `DecisionScheduler` (world events + configurable heartbeat). |
| `src/decisionlog.ts` | The decision record schema, the stable `stateHash`, and the reliability-diagram `calibration` block. |
| `src/policy.ts` | The deterministic guard. Two phases (`decision`, `dig`). Pure functions of the JSON state. |
| `src/executor.ts` | Single-action ownership, movement policy (`canDig=false`), obstacle-aware packet stepper, dig + collect + verify. |
| `src/controller.ts` | The one loop: scheduling, rate limiting, failure memory, escalation triggers, System 2 hook. |
| `src/index.ts` | The plugin: `bot.loadPlugin(jevAgent)` attaches `bot.jev`. |
| `demo.mts` | The runnable PoC (offline `AI_Bot` → find tree → dig → verify). |
| `test-guard.mts` | Deterministic guard rejections, no bot and no model. |
| `test-gating.mts` | Proof that a low-certainty `score` never changes behaviour. |

## Local Mineflayer movement patch (applied by `postinstall`)

Stock `mineflayer@4.39.0` has two movement-bookkeeping defects that make a Leaf
1.21.11 server rubber-band the bot while it is in contact with terrain (the server
replies to every sub-threshold movement packet with a position teleport, ~15–20x/s):
the clientbound-teleport reply writes the server's target into `lastSent`, and
`updatePosition` re-sends on any exact inequality instead of vanilla's `2e-4`
threshold. `patches/mineflayer-4.39.0-locomotion.patch` ports the two changes that
the upstream PR #4063 ablation attributes the fix to (L and K in
`mcbot/movement-test/README.md` §7). `scripts/apply-movement-patch.mjs` applies it
idempotently and is wired into `postinstall`, so the patch survives `npm install`:

```bash
npm install                       # postinstall applies + verifies the patch
npm run movement-patch:check      # assert it is already applied (exit 1 otherwise)
node scripts/apply-movement-patch.mjs --check
```

The patch is reversible: `rm -rf node_modules && npm ci --ignore-scripts` gives back
stock. It is a strict subset of PR #4063 — no git pin, no fork, no `any`, and the
five hunks each carry a `[jev-agent patch]` comment explaining the change. Scripts:
`movement-patch-test.mts` (bare-mineflayer step/pit/26 m verification with a
server-side observer bot) and `movement-ab.mjs` (loads any mineflayer dir for A/B).

Verified effect on Leaf 1.21.11 (bare mineflayer, `canDig=false`, `AI_MVAB` pinned
at a 1-block step face): forced repositions **339 → 266** in the same 18 s window.
The patch does **not** make the stock pathfinder climb the step: the server rejects
a movement packet that combines a jump with a blocked forward push, and the stock
pathfinder only jumps at contact (harness README §9.1). The full PR #4063 build
(`movement-test/variants/G`) fails the same way (forced **285**, `path_reset stuck`),
so this is not a missing PR hunk. The control-walk fallback is therefore retained.

## Quick start

Requires **Node ≥ 22** (developed on Node 25). A Minecraft server must be reachable
(`127.0.0.1:25565`, offline mode).

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run guard-test    # 10/10 deterministic guard cases
npm run gating-test   # 6/6 (value x certainty) gating cases
npm run demo          # the PoC; add --help for options
```

Demo options:

```
--host --port --username     connection (default 127.0.0.1:25565 AI_Bot, auth=offline)
--seconds <n>                hard time limit (default 150)
--count <n>                  oak_log goal target (default 1)
--min <n>                    verified digs required for success (default 1)
--heartbeat <ms>             max idle heartbeat (default 500)
--settle <ms>                max settle after spawn before the first decision (default 8000)
--triggers <list>            comma-separated decision triggers (default all)
--scan-radius <n>            block scan radius (default 48)
--reach <n>                  block reach, clamped to 5 (default 4.5)
--actuation pathfinder|packet  movement actuation (default packet)
--log-dir <dir>              JSONL log directory (default logs)
--fallback                   force the deterministic fallback policy (no gateway)
--no-probe                   skip the single-action ownership probe
```

## Policy selection: one interface, two implementations

`src/jev.ts#createJevPolicy` is the **only** swap point:

* **A gateway key is resolvable** → `TypeSafeJevPolicy`, the proven real path:

  ```ts
  const response = await experimental_evaluate({
    model: 'typesafe-ai/jev',
    state,          // the JSON world state, verbatim
    questions,      // one batched evaluation, seven questions
    abortSignal,
    maxRetries: 0,  // rate-limit backoff is owned by the policy
  })
  ```

  The key is read from the 0600 file
  `/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key`, then from
  `AI_GATEWAY_API_KEY`. The value is never printed or logged.

* **No key** → `FallbackJevPolicy`, a deterministic local policy labelled
  `model: "deterministic-local-fallback"`. Its answers carry `note: "deterministic-fallback"`.

### Question types on the real path

The AI SDK v7 evaluation model supports exactly `choice` | `score` | `boolean` (there is **no
`noul`**). `action` / `mine_target` / `combat_target` are `choice`; `danger` / `route_danger` /
`goal_progress` are `score`; `need_replan` is `boolean`. Probabilities are rounded to 2 decimals
(`rounding.probabilityDecimals`), `usage.inputTokens` is available, and
`providerMetadata.typesafe.confidence[questionId]` carries TypeSafe's **calibrated** per-question
confidence — it is never assumed to be distribution sharpness and is validated against outcomes in
the decision log.

### Rate-limit handling

The free gateway tier is tightly rate-limited (observed: **4 requests / 300 s**). The real policy
detects a 429 even when the AI SDK wraps it in an `AI_RetryError`, and retries with linear backoff
(`rateLimitRetries`, `rateLimitBaseDelayMs`). The backoff time is **excluded** from the recorded
`latencyMs`, so the latency distribution stays clean. Each retry is written as a `jev-retry` record.

## 2D `score` gating: never act on a raw score (`src/gating.ts`)

A `score` answer is `(value x certainty)`. A high score with a low calibrated confidence must not
change behaviour:

```ts
export const DANGER_CONFIDENCE_THRESHOLD = 0.4

export function applyDangerGate(chosenId, gate, safeAction) {
  if (!gate.actionable) {
    // the danger score itself is not actionable
    return { chosenId: preserveCurrentSafeAction(chosenId), overridden: false, outcome: 'preserved' }
  }
  ...
}
```

`gate.actionable` is true only when the provider reported a confidence **and** it is `>= 0.4`.
The observed sample `danger.score = 0.91` with `providerMetadata.typesafe.confidence.danger = 0.09`
therefore leaves the executor's current action untouched. `npm run gating-test` proves the exact
sample, the severe override, the confident-safe case and the missing/`null` cases.

## Decision log (`logs/decisions.jsonl`)

One `decision` record per Jev decision, with the `result` attached when the correlated action
finishes (keyed by the executor's `epoch`):

```jsonc
{
  "record": "decision",
  "decisionId": "…", "ts": "…",
  "stateHash": "sha256:…",              // canonical hash of the state (clock excluded)
  "tick": 1, "trigger": "start", "source": "jev",
  "candidates": [ { "id": "MINE:b6_63_-67", "kind": "MINE", "inReach": true, … } ],
  "jev": {
    "policy": "typesafe", "model": "typesafe-ai/jev", "latencyMs": 784,
    "usage": { "inputTokens": 4054, "outputTokens": 307, "totalTokens": 4361 },
    "answers": { "action": { "value": "MINE:b6_63_-67", "confidence": 0.99 }, … },
    "dangerGate": { "value": 0.33, "confidence": 0.67, "threshold": 0.4, "actionable": true }
  },
  "chosenAction": "MINE:b6_63_-67",
  "confidence": 0.99,
  "dangerOverride": null,
  "calibration": [ { "question": "action", "predictedConfidence": 0.99,
                     "observedSuccess": true, "observedDamageTaken": 0, "observedProgress": 0 } ],
  "result": { "actionId": "MINE:b6_63_-67", "success": true, "durationMs": 11224,
              "damageTaken": 0, "progress": 0, "verified": true }
}
```

The `calibration` array is the reliability-diagram input: bin by `predictedConfidence`, measure the
empirical success rate in each bin from `observedSuccess`. `logs/jev-calls.jsonl` additionally holds
one `jev-call` per call (exact request + response) and one `jev-outcome` per executed action;
`logs/run.jsonl` holds the structured agent events.

## The deterministic guard (mechanical vs semantic)

Mechanically decidable → **100% code**, in `policy.ts`, with no model involvement:

| Code | Check |
| --- | --- |
| `UNKNOWN_CANDIDATE` | the chosen id is not in this tick's candidate set |
| `EMPTY_HAND` | `requiresTool` and no matching tool, or `EAT:x` with no `x` |
| `TARGET_GONE` | the block/entity is no longer in the world state / not diggable |
| `STALE_COORDS` | older than `maxCandidateAgeTicks` sensor ticks |
| `OUT_OF_REACH` | at dig time, farther than `reach` from the eyes |
| `NO_SUPPORT` | no standable position adjacent → `canDig=false` forbids tunnelling |
| `LAVA_RISK` | a hazard block is adjacent to the target |
| `CONFLICT_IN_FLIGHT` | a second dig while one is already owned (deferred, not failed) |
| `ALREADY_DONE` | the goal is already complete |

Boolean questions are reserved for **semantic** judgements (`need_replan`).

## Single-action ownership

`executor.ts` guarantees `bot.dig()` never runs concurrently: `actionEpoch` (monotonic owner token),
`AbortController` (per action), `currentAction` (exactly one owner). A new higher-level decision
**cancels** the previous action; the same decision **retains** ownership.

## No incidental block breaking

`Executor.ensureMovements()` pins `movements.canDig = false`, `allow1by1towers = false`,
`scafoldingBlocks = []`, `allowParkour = false`. Order of operations is always: policy picks
`MINE:<block>` → executor walks to it (pathfinder planning only) → guard re-checks → `bot.dig()` on
that exact block.

## Escalation to System 2

`controller.escalate()` fires on: low action confidence, the same failure 3×, `pathfinder_no_path`,
`pathfinder_stuck`, goal progress 0 for `stallMs`, unexpected world state (`verify_failed`, death),
all candidates invalid, goal complete, unknown events, and policy errors. `StubSystem2` records the
escalation and returns `continue`.

## Environment findings (important)

Running the demo on **Leaf 26.1.2 / protocol 775 with `mineflayer@4.39.0` + `minecraft-data@3.116.0`**:

* `minecraft-data@3.116.0` ships **no block collision shapes** for 26.1, so `prismarine-physics`
  cannot build a correct collision set. Mineflayer's own physics frequently reports
  `onGround = false` and the server rubber-bands `position` packets with an incrementing
  `teleportId`, which makes client-side walking unreliable and also corrupts planner waypoints.
* Mitigations shipped: **failure memory** (`signals.failedCandidates`), the guard's
  `CONFLICT_IN_FLIGHT` deferral, `breakFailureDeadlock()` escalation, and `--actuation packet`
  (pathfinder plans, the executor actuates with explicit `position_look` packets). The packet
  stepper is obstacle-aware: it fans out ±45°/±90°/±135°/180° and tries one block up/down so it can
  slide around a leaf canopy or climb a one-block step.
* The server persists each player's last position; the demo waits (`--settle`) for the server to
  finish placing the bot before the first decision so the in-reach blocks are visible.

## Verification evidence

* `npm run typecheck` → clean (`tsc --noEmit`, exit 0).
* `npm run guard-test` → **12/12** guard cases.
* `npm run gating-test` → **6/6** cases, including the documented `danger` sample
  (score `0.91`, confidence `0.09` → `preserved`, action unchanged).
* Real-Jev demo (key from the secrets file, `--reach 5 --settle 8000`):
  `[agent] stopped reason=… success=true verifiedDigs=1`, `[verify] blockRemoved=true dropObserved=true`,
  and the server no longer has the dug `oak_log` at `(6,63,-67)`.
* Event-driven proof: in the 11,224 ms verified-dig action, the `heartbeat` trigger fired ~every
  500 ms and **every one was deferred** (`trigger=heartbeat deferred while action#1 … is in flight`),
  and exactly **1** Jev call was made for the whole action — the one that initiated it.
* Latency distribution from the successful real calls in `logs/jev-calls.jsonl`:
  `n=4, p50=787 ms, p95=845 ms, max=855 ms` (429 backoff excluded).

## Stubbed / not yet built

* **System 2 brain** — only the escalation triggers and the `System2Brain` hook exist (`StubSystem2`).
* **Item pickup / locomotion** — on this server the movement defect above still limits walking; the
  verified dig lands, but walking onto the drop is not reliable end-to-end.
* **Confidence calibration** — the decision log records predicted confidence next to the observed
  outcome; the thresholds are still defaults until enough real data accumulates.

## M0 closed loop (first out-of-reach navigation)

The first true closed loop — **perception → Jev decision → navigation → re-observe → Jev decision →
dig → verify** — runs end-to-end against the live Leaf server. The enabling change is in
`candidates.ts`: an out-of-reach log is no longer offered as a walk-and-dig `MINE`. It is
`MINE:<id>` only while already in reach; otherwise it is `MOVE:<id>` (a separate navigation
decision) whose target is the sensor's own `adjacentStandable` spot. When the walk completes, the
next sensor tick re-offers `MINE:<same id>` because the block is in reach, and `policy.ts`
re-validates the log-anchored `MOVE` against `state.blocks`.

Reproduce with:

```bash
cd /home/s0u7a/mc-ai/jev-agent
npx tsx demo.mts --username AI_M32 --seconds 60 --settle 9000 --log-dir logs/m0-final
```

Outcome (raw lines from `logs/m0-final/`):

* tick 1 candidates were all out-of-reach (`MINE` count 0), nearest `MOVE:b19_63_-65`, 5.52m.
* Jev #1: `trigger=start -> action=MOVE:b19_63_-65 kind=MOVE | walk to oak_log at (19,63,-65), 5.52m away (out of reach), stand at (20,63,-65)`, `latencyMs=610`, `inputTokens=4716`.
* the pathfinder moved the bot and arrival fired:
  `MOVE MOVE:b19_63_-65 arrival start=(24.5,63,-65.5) end=(22.92,63,-64.35) moved=1.96m targetDistance=4.53m->2.99m`,
  `trigger=path_completed … actionId=MOVE:b19_63_-65`, `packet locomotion complete -> (20,63,-65) forcedRepositions=0`.
* Jev #2 (re-observation after the walk): `trigger=action_completed -> action=MINE:b19_63_-65 kind=MINE | mine oak_log at (19,63,-65), in reach, walk-up access`, `latencyMs=493`, `inputTokens=5447`.
* dig verified: `blockRemoved=true dropObserved=true oak_log_in_inventory=1 (gained 1, settled 1363ms)`;
  `VERIFIED MINE:b19_63_-65 removed=true gained=1 goal=1/1 progress=100%`.
* run totals: **2 Jev calls**, `ticks=2`, `duration=6251ms`, `inputTokens=10163`, `cost=$0.000407`
  (`$0.04/1M` input), `forcedRepositions=1` (0 during the walk), `guardRejections=0`,
  `maxConcurrentActions=1`.
* server-side re-scan after the run: `(19,63,-65) = air`, `(19,64,-65) = oak_log`, `(19,65,-65) = oak_log`.
* clean stop: `[agent] stopped reason=goal-complete success=true verifiedDigs=1`.

A verified dig now advances the goal even when the pickup walk cannot reach the drop: the controller
counts a `MINE` result with `blockRemoved=true` and `targetName === goal.targetItem` as one obtained
item, matching the VERIFY rule that accepts `blockRemoved` + `dropObserved`.

Honest limitation: navigation is only reliable on **short, flat, open-ground routes**. The default
`AI_Bot` saved position had no flat access to any out-of-reach log — every executable target's
walk-up spot was 2–6 blocks up a hillside/canopy, and both actuations stalled with
`packet locomotion blocked before (2.5,65,-68.5)` / `path_reset stuck`. The run above uses a spawn
(`AI_M32`) whose nearest out-of-reach log has a flat 3-node route; terrain-contact climbing is still
the open problem for M1.

