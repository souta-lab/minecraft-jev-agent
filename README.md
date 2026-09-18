# minecraft-jev-agent

An embodied Minecraft Java agent. An **LLM planner answers bounded questions**; a **System One
policy** (Jev, a TypeSafe semantic-judgement model) holds **sole action authority**; **Mineflayer
is the motor/reflex layer**. The three layers are separated by how far ahead they reason, not by a
fixed tick rate. There is **no Mineflayer fork** — stock `mineflayer@4.39.0` plus a single local
movement patch under `jev-agent/patches/`.

Perception loop:

```text
sensor -> WorldModel(JSON) -> deterministic grounded candidates
       -> Jev (bounded semantic policy)
       -> deterministic guard -> fresh sensor re-validation
       -> Executor / Skill -> VERIFY -> loop
```

The target architecture is tracked in **Issue #11 (Grounded Options)**:

```text
Code      = CAN / TRUE / SAFE / DONE
Jev π     = WHICH grounded local action/Skill
Jev β     = WHETHER the current Option should end
System 2  = WHAT intent/Option comes next
Skill     = HOW the selected action is mechanically executed
HOST      = durable state / lifecycle / actuation lease
```

## Autonomous-development entry point

Do **not** scan every open issue and invent a priority order on every run. The repository may keep a
large historical/research backlog while only a few items are executable.

From the repository root:

```bash
npm run frontier          # small executable working set; NOW is capped at 3
npm run frontier:check    # fails if WIP exceeds the cap or a P0/P1 issue is unrouted
npm run current-status    # evidence-only repo/runtime snapshot
npm run lane-guard        # avoid duplicate parallel implementation lanes
```

`ISSUE-ROUTING.json` is the machine-readable routing layer. Its categories mean:

- `NOW` — the only normal source of new coding work; maximum 3 items.
- `NEXT` — may be promoted by the orchestrator after a NOW lane lands or is genuinely blocked.
- `WAITING_LIVE` — implementation/acceptance work; verify current main before writing more code.
- `RESEARCH` — non-blocking experiments/hypotheses.
- `FUTURE` — milestone work that is intentionally not on the current frontier.
- unclassified open issues — `BACKLOG`; do not enumerate them during normal ORIENT.

Before creating a new issue, search the existing backlog. Prefer updating/reopening an existing issue,
adding evidence to the active issue, or adding a regression fixture. A new issue is justified only
when it has a genuinely distinct acceptance boundary.

## Status

- **M0** — closed loop PASS.
- **M1** — verified Jev-only plan with `llm.called == false`.
- **M2** — in progress.
- **M3/M4** — later milestones; M4 remains the final game objective.
- **Resident mode** — persistent Mineflayer connection, generation hot reload, control socket, durable
  state and an actuation lease are implemented.

Runtime position, current rung, active queue, open PR/issue counts, and other time-sensitive facts
belong in `CURRENT-STATUS.md` / `npm run current-status`, not in this README.

## How to run

Requires **Node >= 22** (developed on Node 25). A local **Leaf 1.21.11 server in offline mode**
(`127.0.0.1:25565`) must be running for live runs. `npm install` applies the local movement patch
via `postinstall` (idempotent).

```bash
# jev-agent: agent, tests, M1/M2 ladders
cd jev-agent
npm install
npm run movement-patch:check
npm run typecheck
npm run guard-test
npm run gating-test
npm run m1
npx tsx m2.mts
npx tsx demo.mts --help

# resident host: persistent connection + generation hot reload
cd ../buddy-driver
node agent-runner.mts

# companion: minimal follower bot
node ../companion/buddy.cjs

# movement patch apply / check (run inside jev-agent)
node scripts/apply-movement-patch.mjs
node scripts/apply-movement-patch.mjs --check
```

The patch is reversible: `rm -rf node_modules && npm ci --ignore-scripts` restores stock
`mineflayer`. The local patch contains only experimentally justified locomotion bookkeeping changes;
keep it small so causality and rollback remain clear.

## Layout

| Path | Purpose |
| --- | --- |
| `jev-agent/` | Sensor/world state, grounded candidates, Jev policy, Guard, Skills/Executor, VERIFY. |
| `buddy-driver/` | Persistent host, generation hot reload, control socket, durable state/WorldMemory. |
| `companion/` | Minimal companion bot. |
| `launch/` | Local play-environment helpers. |
| `tools/` | Repository convergence, evidence and orchestration tools. |
| `ISSUE-ROUTING.json` | Small machine-readable execution frontier over the larger issue backlog. |

## Docs

| File | Contents |
| --- | --- |
| `CURRENT-STATUS.md` | Generated/derived operational evidence snapshot; may be regenerated at any time. |
| `DEVELOPMENT-METHOD.md` | Evidence standards, authority hierarchy, autonomous development process. |
| `ARCHITECTURE.md` | As-built/review evidence; timestamped sections may be historical. |
| `MILESTONES.md` | M0-M4 ladder and acceptance criteria. |
| `M2-PROGRESS.md` | Historical M2 run log / failure analysis. |
| `M2-HEURISTIC-AUDIT.md` | Heuristic/truth authority audit and migration evidence. |
| `PRIOR-WORK.md` | Prior-work survey and architecture implications. |
| `RESIDENT-MODE.md` | Resident persistence/hot-reload/state-ownership specification. |

## Notes

- Live runs need a local Leaf / Minecraft Java 1.21.11 server in offline mode; local server config is
  intentionally not part of this repo.
- Runtime artifacts (logs, JSONL traces, resident bundles, world/launcher data) are git-ignored.
- `buddy-driver` reads the same `mineflayer` install as `jev-agent` via a `node_modules` symlink;
  reinstall `jev-agent` dependencies to refresh it.
