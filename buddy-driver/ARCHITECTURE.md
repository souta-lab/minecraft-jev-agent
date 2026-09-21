# AI_Buddy resident driver (`buddy-driver/`)

Resident agent for the local **Leaf / Minecraft Java 1.21.11** server
(`127.0.0.1:25565`, offline, peaceful). One long-lived Mineflayer connection; the
intelligence is hot-swappable without reconnecting. Spec: `../RESIDENT-MODE.md`.

## Runtime decision (recorded per §0-A)

**Bun 1.4.2 is the resident runtime and native bundler.**
- `bun agent-runner.mts` runs `.mts`/`.ts` directly with Bun's TypeScript transform.
- `Bun.build` creates the hash-stamped generation bundle while keeping Mineflayer,
  pathfinder, and Prismarine packages external so host and generation share classes.
- The migration gates remain explicit: Bun typecheck/build are isolated proof; live
  Mineflayer SPAWN and resident/M2 acceptance are separate live evidence gates.
- Revisit Bun only if the §0-A gates are run explicitly.

## Layering (mirrors §3)

```
HOST  agent-runner.mts        never reloaded
  ├─ mineflayer.createBot + pathfinder + collectblock plugins
  ├─ reconnect loop (5 s backoff); bot is recreated, generation re-attached
  ├─ logger  → buddy.log  (SPAWN · ACTION · INVENTORY · MILESTONE · HEARTBEAT ·
  │                          RELOAD · RECOVERY · FREEZE/RESUME · ERROR · CONTROL)
  ├─ durable state → buddy-state.json  (tmp→rename; world memory, ledger mirror,
  │                                     milestone, counters)
  ├─ control socket → data/resident/control.sock (0600)
  └─ reload arbiter: build → import → smokeTest → quiesce → attach → start

RELOADABLE  generation-entry.ts + ../jev-agent/src/**  (one bundled file)
  ├─ wraps the battle-tested `JevController` — **System One stays the sole action
  │   authority**; the host never issues an action
  ├─ deterministic "resident ladder" planner (single-shot contract) computed from
  │   live inventory + WorldMemory
  └─ WorldMemory scan: registers existing crafting tables / furnaces / ores
```

## Hot reload (canonical bundled-generation approach, §2/§4)

`build.mts` bundles `generation-entry.ts` and everything it imports from
`../jev-agent/src/**` into **one hash-stamped file**
(`data/resident/gen-<sha12>.mjs`, `packages:'external'` so
`new Movements(bot)` is the host's own pathfinder class). One file == one URL,
so the whole controller graph swaps atomically — never per-module `?v=`.

Swap order (P1 atomic): `build → import → structural smoke → prepare(new) → previous.quiesce()
→ snapshot → new healthcheck → ACTION LEASE SWITCH (commit point) → next.start() → previous.dispose()`.
The host owns `activeGenerationId`; the generation's bot is a Proxy that refuses every
side-effecting method while its id is not the active lease owner, so before the commit
the new generation cannot act and after it the old one cannot. Rollback re-creates a
generation from the previous module and switches the lease back. If build/import/smoke
fails, the previous generation keeps running (the failed bundle never touches the
connection). Contract is DATA-ONLY (`{x,y,z}` DTOs, rehydrated with `new Vec3(...)`);
`structural smoke` passes with an empty plan and zero completed goals, `mission preflight`
is logged separately and never gates reload. WorldMemory is namespaced by
`serverId|dimension|worldEpoch`; the host is the only writer of `buddy-state.json`.

State across a swap: `quiesce()` calls `controller.stop()`, which persists the
goal-queue ledger (`buddy-ledger.json`); the new generation bootstraps its ladder
then `bootstrapPlan()` restores the ledger. Inventory and position are **live on
the bot** — the host never copies them (no drift).

Stale-ledger guard: if the bot died and dropped its tools, the ledger's "done"
tools are no longer true. `resolveLedgerPath()` rejects/archives a ledger whose
recorded pickaxes/tables/furnaces no longer exist (consumables excluded), so the
new generation runs from the live inventory frontier instead of mining stone
bare-handed.

## State classes (issue #40)

Every durable artifact is exactly ONE class. `buddy-state.json` is the single
class-A snapshot (`AgentSnapshot` in `resident-types.ts`, validated/migrated in
`state-snapshot.ts`); the HOST is its only writer (tmp→rename, revision and
`schemaVersion` checked on commit). Generations PROPOSE class-A mutations
(`proposeWorldMemory`, `proposeLedger`) and the host commits them; the
generation restores its ledger from `ctx.ledgerSnapshot`, not from a cache/log.

| Artifact | Class | Authority |
| --- | --- | --- |
| `buddy-state.json` (`AgentSnapshot`) | A | HOST transactional, single writer |
| `buddy-ledger.json` | A (derived) | compatibility mirror of `AgentSnapshot.ledger` |
| position / health / food / inventory / entities | B | never persisted; re-observed from the live bot |
| `planner-cache.json`, `advisor-cache.json`, `mercury-cache.json` | C | disposable; loss changes cost only |
| `data/resident/gen-*.mjs` bundles | C | disposable; rebuilt on reload |
| `logs/jev/*.jsonl`, `buddy.log`, `logs/resident/freeze-*.json`, `acceptance-*.json` | D | append-only evidence; never read back |

On load, class-B keys found in a hand-edited/legacy file are logged as
`STATE_B_TRUTH_REJECTED` and stripped, never restored. An unknown/newer
`schemaVersion` is logged as `STATE_REJECTED` and the default snapshot is used;
known legacy versions (1/2) log `STATE_MIGRATED`. Cache writes stay best-effort
(try/catch) so a read-only or corrupt cache can never fail a generation.

## Control channel (§6)

Unix socket `data/resident/control.sock` (0600), newline-JSON
`{id,cmd,args}` → `{id,ok,data}`. Commands: `report`/`status`, `reload`, `freeze`,
`resume`, `leakcheck`, `gc`, `milestone`/`goal`, `quit`. `freeze` writes
`logs/resident/freeze-<ts>.json` (state + status) and quiesces while **leaving the
connection open and the position held**; `resume` starts a fresh generation.

## Resident ladder (what the bot tries to achieve)

Deterministic, inventory-aware, no LLM: `wood → crafting_table → wooden_pickaxe →
cobblestone(12) → furnace → stone_pickaxe → charcoal → raw_iron(3) →
iron_ingot(3) → iron_pickaxe → diamond → diamond_pickaxe → iron gear`. Rungs
already satisfied by **existing world stations** (scanned at startup/reconnect)
are skipped, so the ~20 pre-existing crafting tables are reused and never
re-placed. Beyond the ladder it keeps collecting (resident upkeep).

## Verification

- **Launch**: `cd /home/s0u7a/mc-ai/buddy-driver && setsid nohup bun
  agent-runner.mts </dev/null >> runner.out 2>&1 &`
- **Reload without reconnect**: `RELOAD ok=true ... ms=236/243/502` with **no
  `SPAWN`/`RECONNECT`** between reloads → the connection was preserved.
- **Rollback**: a broken generation build (`pos.floored is not a function`,
  `smoke test failed`) logged `RELOAD ok=false` and the previous generation kept
  running.
- **State preserved**: across a host restart the ledger (`done=3`) and
  WorldMemory (`craftingTables=9`, ores) reloaded; the bot re-crafted a lost
  pickaxe and advanced the rung to `cobblestone`.
- **Live gameplay**: `ACTION` lines are `MINE:`/`MOVE:`/`DESCEND:`/`CRAFT:` with
  coordinates; cobblestone climbed 1→3→5→9 while the bot advanced.
