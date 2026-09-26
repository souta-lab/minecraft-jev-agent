# minecraft-jev-agent

An embodied Minecraft Java agent. An **LLM planner answers bounded questions**; a **System One
policy** (Jev, a TypeSafe semantic-judgement model) holds **sole action authority**; **Mineflayer
is the motor/reflex layer**. The three layers are separated by how far ahead they reason, not by a
fixed tick rate. There is **no Mineflayer fork** — stock `mineflayer@4.39.0` plus a single local
movement patch under `packages/jev-agent/patches/`.

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
bun run frontier          # small executable working set; NOW is capped at 3
bun run frontier:check    # fails if WIP exceeds the cap or a P0/P1 issue is unrouted
bun run current-status    # evidence-only repo/runtime snapshot
bun run lane-guard        # avoid duplicate parallel implementation lanes
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
- **M2** — diamond-to-Nether-gate (diamond pickaxe, flint-and-steel, obsidian, frame, light, verify); **PASS** — a lit Nether gate exists on the live world and transfers: the resident entered and returned from the Nether three times in the current run (dimension transitions observed in `buddy.log`). The run-scoped `tools/m2-gate.mjs` fresh-build path stays available for a from-scratch rebuild, but the milestone is satisfied by the working gate (operator decision 2026-09-21).
- **Bun foundation** — clean-checkout PASS: frozen install, typecheck, build, and all 125 repository tests pass under Bun.
- **M3** — **12 Eyes of Ender** (`ender_eye`×12 = ender pearls + blaze powder).
- **M4** — stronghold → the End → the Ender Dragon (final game objective).
- **Resident mode** — persistent Mineflayer connection, generation hot reload, control socket, durable
  state and an actuation lease are implemented.

Runtime position, current rung, active queue, open PR/issue counts, and other time-sensitive facts
belong in `docs/status/CURRENT-STATUS.md` / `bun run current-status`, not in this README.

## Execution modes

Do not rely on implicit `auto` mode when proving reproducibility. Select the planner mode explicitly
for acceptance work:

```bash
# deterministic high-level planner: no planner network call
BUDDY_PLANNER=deterministic bun packages/buddy-driver/agent-runner.mts

# bounded Jev high-level horizon planner (requires configured Jev/Gateway credentials)
BUDDY_PLANNER=llm bun packages/buddy-driver/agent-runner.mts

# optional exception-driven Mercury System2 repair; explicit opt-in only
BUDDY_SYSTEM2=mercury bun packages/buddy-driver/agent-runner.mts
```

`BUDDY_PLANNER=auto` exists for convenience and currently selects the Jev planner when a usable API
key is present; **do not use `auto` as evidence for a deterministic acceptance claim**. Mercury is a
separate sparse System2 repair path and is never enabled merely because a key exists. Action safety,
mechanics and postcondition verification remain deterministic in every mode.

## How to run

Requires **Bun >= 1.4.2**. A local **Leaf 1.21.11 server in offline mode**
(`127.0.0.1:25565`) must be running for live runs. `bun install` applies the local movement patch
via `postinstall` (idempotent).

## Contributor and agent runtime policy

This repository is **Bun-only** for JavaScript/TypeScript execution, dependency installation,
scripts, tests, and builds. Use `bun install`, `bun run <script>`, `bun test`, `bun <file>`, and
`Bun.build`. Do not substitute another runtime, package manager, TypeScript runner, or standalone
bundler, and do not create alternate lockfiles. Translate copied commands from historical docs or
external issues to Bun before running them. The `node_modules` directory name is only Bun's normal
dependency layout here; it does not select another runtime.

```bash
# jev-agent: agent, tests, M1/M2 ladders
cd packages/jev-agent
bun install
bun run movement-patch:check
bun run typecheck
bun run guard-test
bun run gating-test
bun run m1
bun m2.mts
bun demo.mts --help

# resident host: persistent connection + generation hot reload
cd ../buddy-driver
bun agent-runner.mts

# companion: minimal follower bot
bun ../companion/buddy.cjs

# movement patch apply / check (run inside jev-agent)
bun scripts/apply-movement-patch.mjs
bun scripts/apply-movement-patch.mjs --check
```

The patch is reversible: `rm -rf node_modules && bun install --frozen-lockfile --ignore-scripts` restores stock
`mineflayer`. The local patch contains only experimentally justified locomotion bookkeeping changes;
keep it small so causality and rollback remain clear.

## Layout

| Path | Purpose |
| --- | --- |
| `packages/jev-agent/` | Sensor/world state, grounded candidates, Jev policy, Guard, Skills/Executor, VERIFY. |
| `packages/buddy-driver/` | Persistent host, generation hot reload, control socket, durable state/WorldMemory. |
| `packages/jev-harness/` | Jev decision-policy harness: typed questions, heads registry, import firewall. |
| `packages/system2-harness/` | Sparse System2 reasoning harness: proposal/compile/commit pipeline. |
| `packages/kernel/` | V4.1.2 shared executable kernel (authority/effects/facts), `v4.1/` subtree. |
| `packages/mcp-server/` | Bedrock MCP companion server, CLI, and bot driver. |
| `packages/mcbot/` | mineflayer movement substrate and variants workspace. |
| `packages/companion/` | Minimal companion bot. |
| `ops/` | Operator/runtime infrastructure: `launch/`, `deploy/`, `keydrop/`. |
| `tools/` | Repository convergence, evidence and orchestration tools. |
| `bun-tests/` | Repository-wide Bun test battery (package suites + tool fixtures). |
| `runs/` | Generated run-output sink (git-ignored, not source). |
| `ISSUE-ROUTING.json` | Small machine-readable execution frontier over the larger issue backlog. |

## Docs

Durable documentation lives under `docs/` (see `docs/README.md` for the area map). Entry points:

| File | Contents |
| --- | --- |
| `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md` | Current canonical architecture (V4.1.2 authority kernel). |
| `docs/architecture/TYPESCRIPT-PACKAGE-ARCHITECTURE.md` | Normative source/documentation organization guideline. |
| `docs/status/CURRENT-STATUS.md` | Generated/derived operational evidence snapshot; may be regenerated at any time. |
| `docs/development/DEVELOPMENT-METHOD.md` | Evidence standards, authority hierarchy, autonomous development process. |
| `docs/status/MILESTONES.md` | M0-M4 ladder and acceptance criteria. |
| `docs/operations/RESIDENT-MODE.md` | Resident persistence/hot-reload/state-ownership specification. |
| `docs/decision/AI-OBSERVER.md` | Read-only observer API, Jev decision evidence and run-binding limits. |
| `docs/history/` | Superseded/dated material: old architecture versions (`history/architecture/`), incident reports (`history/incidents/`), surveys and closed-milestone evidence (`history/investigations/`, `history/milestones/`). |

## Notes

- Live runs need a local Leaf / Minecraft Java 1.21.11 server in offline mode; local server config is
  intentionally not part of this repo.
- Runtime artifacts (logs, JSONL traces, resident bundles, world/launcher data) are git-ignored.
- `buddy-driver` reads the same `mineflayer` install as `jev-agent` via a `node_modules` symlink;
  reinstall `jev-agent` dependencies to refresh it.
