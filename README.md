# minecraft-jev-agent

An embodied Minecraft Java agent. An **LLM planner answers bounded questions**; a **System One
policy** (Jev, a TypeSafe semantic-judgement model) holds **sole action authority**; **Mineflayer
is the motor/reflex layer**. The three layers are separated by how far ahead they reason, not by a
fixed tick rate. There is **no Mineflayer fork** — stock `mineflayer@4.39.0` plus a single local
movement patch under `jev-agent/patches/`.

Perception loop:

```
sensor -> WorldModel(JSON) -> deterministic grounded candidates
       -> Jev (1 batched call; CORE + trigger-specific questions)
       -> deterministic guard -> fresh sensor re-validation
       -> Executor (single action) -> VERIFY -> loop
```

Only the swap point `jev-agent/src/jev.ts#createJevPolicy` differs between the Jev policy and the
deterministic fallback policy. A batched-call scheduler (`src/scheduler.ts`) decides *when* to ask,
and `src/gating.ts` maps `(value, certainty)` to act / ask / refuse.

## Status

- **M0** — closed loop PASS (perception -> decision -> navigation -> re-observe -> dig -> verify).
- **M1** — **verified 4/4 on a fresh world with `llm.called == false`** (whole run Jev-only: oak_log
  >= 3 -> crafting_table >= 1 -> wooden_pickaxe >= 1 -> cobblestone >= 16, no LLM call).
- **M2 (iron age)** — **in progress**: furnace placed, **charcoal smelted 2026-09-18 00:13 JST**,
  now hunting `raw_iron`. Target: iron_ingot x3 -> iron_pickaxe.
- **M3/M4** — not started (nether -> End; Ender Dragon deprioritised).
- **Resident mode** — implemented: one persistent Mineflayer connection, hash-stamped esbuild
  **generation hot reload** (no reconnect), a control channel (`data/resident/control.sock`, 0600),
  and durable `WorldMemory` (`buddy-state.json`). Verified `RELOAD ok=true` across 4 generations.

Known open defects and their priority order are in `BUDDY-DEFECTS.md`; the as-built architecture
with verification evidence is in `ARCHITECTURE.md`.

## How to run

Requires **Node >= 22** (developed on Node 25). A local **Leaf 1.21.11 server in offline mode**
(`127.0.0.1:25565`) must be running for live runs. `npm install` applies the local movement patch
via `postinstall` (idempotent).

```bash
# jev-agent: agent, tests, M1/M2 ladders
cd jev-agent
npm install
npm run movement-patch:check      # assert the local patch is applied (exit 1 otherwise)
npm run typecheck                 # tsc --noEmit
npm run guard-test                # 10/10 deterministic guard cases
npm run gating-test               # 6/6 (value x certainty) gating cases
npm run m1                        # tsx m1.mts   - M1 Jev-only plan
npx tsx m2.mts                    # M2 iron-age ladder
npx tsx demo.mts --help           # PoC options

# resident host: persistent connection + generation hot reload
cd ../buddy-driver
node agent-runner.mts

# companion: minimal follower bot
node ../companion/buddy.cjs

# movement patch apply / check (run inside jev-agent)
node scripts/apply-movement-patch.mjs          # apply (idempotent)
node scripts/apply-movement-patch.mjs --check  # verify, non-zero on failure
```

The patch is reversible: `rm -rf node_modules && npm ci --ignore-scripts` restores stock
`mineflayer`. It ports the two locomotion-bookkeeping hunks that stop a Leaf 1.21.11 server from
rubber-banding the bot on terrain contact (clientbound-teleport reply writes the wrong `lastSent`;
`updatePosition` re-sends on exact inequality instead of vanilla's `2e-4` threshold).

## Layout

| Path | Purpose |
| --- | --- |
| `jev-agent/` | The agent: sensors, WorldModel, candidates, Jev policy, guard, Executor, VERIFY. Source in `src/**`, runnable `*.mts` ladders, `patches/`, `scripts/`, `data/*.mts` probes. |
| `buddy-driver/` | Resident host: one long-lived Mineflayer connection, generation hot reload, control socket, durable state, `WorldMemory`. Entry `agent-runner.mts`. |
| `companion/` | Minimal companion bot that follows the human player (`buddy.cjs`). |
| `launch/launch.mjs` | Launcher helper for the local play environment. |

## Docs

| File | Contents |
| --- | --- |
| `ARCHITECTURE.md` | As-built architecture, layer contracts, evidence, and open blockers (review handoff). |
| `MILESTONES.md` | M0-M4 ladder, acceptance criteria, and per-run evidence. |
| `M2-PROGRESS.md` | The M2 iron-age run log and failure analysis. |
| `RESIDENT-MODE.md` | Resident-mode spec: persistence, hot reload, control channel, WorldMemory. |
| `BUDDY-DEFECTS.md` | Measured defects in the resident agent's intelligence (movement, digging, tools). |

## Notes

- Live runs need a **local Leaf / Minecraft Java 1.21.11 server in offline mode**; the local server
  config (`server.properties`) is intentionally **not** part of this repo.
- Runtime artifacts (logs, JSONL traces, resident bundles, world/launcher data) are git-ignored.
- `buddy-driver` reads the same `mineflayer` install as `jev-agent` via a `node_modules` symlink;
  reinstall `jev-agent` dependencies to refresh it.
