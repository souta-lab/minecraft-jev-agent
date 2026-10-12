# minecraft-jev-agent

> **PERMANENT ARCHITECTURE LOCK:** the canonical and permanent architecture is
> **V4.1.2 Concurrent Verified Transition Runtime** (`AGENTS.md`,
> `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md`, validated checkpoint `092a5b38`).
> It is never replaced, reopened, superseded, or redesigned in this repository —
> there is no V4.1.3/V4.2/V5 and no successor architecture.

An embodied Minecraft Java agent. A sparse **LLM planner** synthesizes *what* to do; a **Typed
Decision Plane** (a System One / typed decision model — TypeSafe Jev or Liquid d1, selected by an
explicit profile) decides *which* grounded transition to take; a **Kernel** owns lifecycle, leases,
effects, trusted facts and SUCCESS; **Mineflayer** is the motor/reflex layer behind the runtime
adapter. The layers are separated by how far ahead they reason, not by a fixed tick rate.

There is **no Mineflayer fork** — stock `mineflayer@4.39.0` plus a single, reversible local
movement patch under `packages/jev-agent/patches/`.

## Architecture in one screen

The single production authority path is:

```text
proposal -> typed KernelCommand -> applyKernelCommand(KernelState, command)
         -> KernelState + KernelEvent[] -> transition-scoped adapter capability
         -> Mineflayer / server effect
```

Perception and control loop:

```text
sensor -> verified world model -> grounded enabled transitions
       -> Typed Decision Plane (WHICH / WHETHER, kernel-admitted)
       -> Kernel admission + resource/effect leases -> persistent Transition Controller
       -> Runtime Adapter / ActuationPort -> VERIFY over fresh facts -> frontier re-derivation
```

Fixed ownership:

| Layer | Owns |
| --- | --- |
| **Typed Decision Plane** (historically `Jev`) | tactical/semantic WHICH/WHETHER among *grounded, enabled* choices |
| **System2** | sparse WHAT: synthesis, repair, decomposition, causal hypotheses |
| **Kernel** | sole lifecycle / lease / effect / trusted-fact / revision / budget / Mission / SUCCESS authority |
| **Transition Controller** | realizing one admitted transition until VERIFY, typed terminal, or invalidation |
| **Viability Runtime** | suspend / stabilize / revalidate / resume without silently replacing mission intent |
| **Runtime Adapter / ActuationPort** | sole production mutation boundary |
| **VERIFY** | sole SUCCESS authority; trusted truth is TRUE / FALSE / UNKNOWN |
| **HOST** | connection, generation lifecycle, durable state, evidence — not gameplay policy |

Terminology note: `Jev` in existing V4.1.2 identifiers (`jev-agent`, `Jev frame`, `selectedBy=jev`)
is a historical component name. The architectural role is the **Typed Decision Plane**; the
concrete model is a configuration choice. See `docs/architecture/TYPED-DECISION-MODELS.md` and
`docs/architecture/JEV-BEST-PRACTICES-FOR-MINECRAFT.md`.

`packages/kernel/` is the executable authority kernel and is wired into the live host through
`packages/buddy-driver/kernel-authority-session.ts` / `generation-entry.ts`. The migration of the
Reach runtime onto VTR authority is gated separately; read
`docs/architecture/NEW-ARCHITECTURE-V4.1.2.md` before assuming a given code path is authoritative.

## Status

Milestone predicates are machine-readable in `MILESTONE-CONTRACT.json`; the ladder is described in
`docs/status/MILESTONES.md`. Current *derived* runtime state is never hand-written — use
`bun run current-status` (writes `docs/status/CURRENT-STATUS.md` with `--write`).

| Milestone | Meaning | State |
| --- | --- | --- |
| **M0** | closed loop: grounded MOVE → arrival → grounded MINE → verified drop/inventory | PASS — historical evidence under `packages/jev-agent/logs/m0-final/` |
| **M1** | Jev-only plan with `llm.called == false` (logs → table → wooden pickaxe → cobblestone) | historical PASS |
| **M2** | diamond ×3 → diamond pickaxe → flint_and_steel → obsidian ×10 → build/light/verify a Nether gate | **gate implemented** (`tools/m2-gate.mjs --run <runId>`), plus an offline end-to-end rehearsal of all 8 links (`M2-CHAIN-REHEARSAL.md`). An earlier campaign had a lit, transferring gate (operator decision 2026-09-21); that is *not* a run-scoped PASS for the current campaign |
| **M3** | Nether reached **and** `ender_eye >= 12` in the same run (`tools/m3-gate.mjs --run <runId>`) | not achieved |
| **M4** | stronghold → End portal → Ender Dragon | not started |

The current campaign objective is the **first clean verified autonomous Nether entry**: one
fresh exact-source live run, no manual gameplay help, with run-scoped evidence. Everything else is
subordinate to that.

Evidence discipline (see `AGENTS.md` §11 and `docs/development/DEVELOPMENT-METHOD.md`):

```text
POLICY       what should be true          IMPLEMENTED  what the code does
OBSERVED     what the runtime showed      COMPLIANCE   PASS / FAIL / UNKNOWN against POLICY
```

Acceptance evidence is run-scoped. Never combine runIds, all-time counters, offline rehearsals,
inherited world state, or body motion into a PASS. Missing or unbound evidence is `UNKNOWN`, and
`UNKNOWN` is never promoted to PASS.

## Requirements

- **Bun ≥ 1.4.2** — the only supported runtime here (`bun install`, `bun run`, `bun test`,
  `bun <file>`, `Bun.build`). Do not substitute another package manager, runtime or bundler, and do
  not create alternate lockfiles.
- A local **Minecraft Java 1.21.11** server in **offline mode** on `127.0.0.1:25565` for live runs
  (a Leaf build is what the campaign used). The server, its `server.properties`, and its world are
  deliberately **not** part of this repository.
- Credentials for the decision/planner models live **outside** the repo (0600 files referenced by
  env vars). Nothing in the repo contains a key; secret files are git-ignored.

## Quick start

```bash
bun install --frozen-lockfile     # applies the local movement patch (idempotent)
bun run movement-patch:check      # fails if the patch is not applied
bun run typecheck                 # jev-agent + buddy-driver
bun test ./bun-tests              # repository-wide battery
```

Package-level suites are the bulk of the coverage:

```bash
cd packages/jev-agent  && bun test .          # sensor/candidates/policy/executor/VERIFY fixtures
cd packages/buddy-driver && bun test .        # host, generations, durable state, authority
cd packages/kernel     && bun test .          # kernel state machine, property + adversarial suites
```

### Known failing checks (2026-10-12, `main` @ `33e11ca9`)

These are pre-existing red on `main` and are being worked case by case. They are listed so a fresh
clone is not surprised, not to excuse them:

| Check | Observed |
| --- | --- |
| `packages/jev-agent/test-craft-log-route.mts` | 3 cases: a prerequisite log route at 50,11,32 yields `MOVE:b50_11_32,WAIT` with no vertical/place route |
| `packages/jev-agent/test-column-descent.mts` | 5 cases: own-column pillar descent / staircase-overhead plans |
| `packages/jev-agent/test-acquisition-route.mts` | 2 cases: missing-material producer routing and the stone-only wood-tool cycle |
| `packages/jev-agent/test-obsidian-route.mts` | 2 cases: obsidian MINE/DESCEND grounding |
| `packages/jev-agent/test-threat-response.mts` | 1 case: a completed Goal from a retired Option and the empty-queue horizon |
| `packages/jev-agent/test-canopy-ground.mts` | 1 case: below-band canopy food-habitat refusal |
| `packages/jev-agent/test-food-route.mts` | slow fixture; fails within the repository battery |
| `bun run issue-state:check` | `#437`/`#439`/`#440` are closed on GitHub while their machine-readable `compliance` is `unknown`. The gate is right: a closed row must be verified-complete or recorded as a superseded fold, and neither is true. It is left red rather than written to `pass`, because that would be false evidence |

Everything else — the `bun-tests` repository battery (187/188), the M2 chain rehearsal
(`tools/m2-chain-execution.mjs` drives 8/8 links, fixture 12/12), the buddy-driver package suite
(82/82), `bun run typecheck`, `movement-patch:check`, `contract-docs-check` (5/5), `lane-guard`
(NO_DUPLICATES) and `frontier:check` (exit 0) — is green on this commit. GitHub Actions executes
again now that the repository is public (public repositories use the free tier), and its
`core-deterministic`, `system2-harness`, `authority-contract` and `jev-harness` jobs pass; the
`convergence` job stops at `issue-state:check` for the reason recorded above.

The movement patch is reversible: `rm -rf node_modules && bun install --frozen-lockfile
--ignore-scripts` restores stock `mineflayer`.

## Running the agent

```bash
# resident host: persistent Mineflayer connection + generation hot reload
cd packages/buddy-driver && bun agent-runner.mts
```

Execution modes and model configuration (all optional; production defaults are model-authoritative):

```bash
BUDDY_PLANNER=llm            # default: model-authored planning (also auto/jev/on/model)
BUDDY_PLANNER=deterministic  # explicit baseline only (also off/fallback/none)
BUDDY_POLICY=fallback        # deterministic semantic policy — baseline/A-B only, not acceptance evidence
BUDDY_SYSTEM2=on             # explicit opt-in for sparse System2 repair (also off; legacy `mercury` spelling)
BUDDY_DECISION_PROFILE=...   # Typed Decision Plane profile (default: liquid-direct-d1-free)
```

Fail-closed rules that matter when reading a run: if the requested decision model has no usable
credential the runtime refuses semantic authority instead of silently substituting the
deterministic policy, and if System2 is unavailable the durable objective is preserved or surfaced
as unavailable/UNKNOWN. Startup evidence distinguishes `requestedPolicy`, `resolvedPolicy`,
`plannerMode`, `resolvedSystem2` and `optionCompiler`, so a run can be audited for hidden fallback.

## Repository entry points

```bash
bun run current-status        # evidence-only repo/runtime snapshot (CURRENT-STATUS.md)
bun run frontier              # small executable working set from ISSUE-ROUTING.json (NOW capped at 3)
bun run frontier:check        # routing invariant: closed rows must be historical, no unrouted P0/P1
bun run issue-state:check     # machine-readable policy/implementation/verification/compliance rows
bun run lane-guard            # avoid duplicate parallel implementation lanes
bun run campaign-current      # compact resume view derived from the live run registry
bun run bun-residue-check     # Bun-only execution policy gate
bun run contract-docs-check   # HOST <-> generation contract version agrees with the docs
```

Acceptance gates are run-scoped and mandatory-`--run`:

```bash
bun tools/m2-gate.mjs --run <runId>     # build -> light -> verify Nether gate
bun tools/m3-gate.mjs --run <runId>     # Nether reached + ender_eye >= 12
bun tools/milestone-run-artifact.mjs --run <runId> --pretty
```

## Layout

| Path | Purpose |
| --- | --- |
| `packages/jev-agent/` | Sensor / verified world model, grounded candidates, decision policy, Guard, Skills, Executor, VERIFY, reachability. |
| `packages/buddy-driver/` | Persistent HOST: connection, generation hot reload, control socket, durable state/WorldMemory, kernel authority session, planner/System2 wiring. |
| `packages/jev-harness/` | Typed Decision Plane harness: typed questions, heads registry, provider profiles, import firewall. |
| `packages/system2-harness/` | Sparse System2 reasoning harness: proposal → compile → commit, with a provider-free replay adapter. |
| `packages/kernel/` | V4.1.2 executable authority kernel (contracts, leases, effects, trusted facts, journal) + `v4.1/` subtree. |
| `packages/mcbot/` | Mineflayer movement substrate and the movement-variant workspace. |
| `packages/mcp-server/` | Bedrock MCP companion server, CLI and bot driver. |
| `packages/companion/` | Minimal follower bot. |
| `ops/` | Operator/runtime infrastructure (`launch/`, `deploy/`, `keydrop/`). |
| `tools/` | Repository convergence, evidence gates and orchestration tools. |
| `bun-tests/` | Repository-wide Bun battery (cross-package + tool fixtures). |
| `runs/` | Generated run output (git-ignored, never source). |
| `ISSUE-ROUTING.json` | Machine-readable execution frontier over the issue backlog. |

## Docs

Durable documentation lives under `docs/` (area map: `docs/README.md`).

| File | Contents |
| --- | --- |
| `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md` | Canonical, permanently locked architecture. |
| `docs/architecture/v4.1/` | Kernel contract prose mirroring `packages/kernel/` (`V4.1.2-HARDENING`, `INVARIANTS`, `KERNEL-EVENTS`). |
| `docs/architecture/JEV-BEST-PRACTICES-FOR-MINECRAFT.md` | Mandatory operating rules for the Typed Decision Plane in Minecraft. |
| `docs/architecture/TYPED-DECISION-MODELS.md` | Terminology, primitives (Noul / Choice / Score), backend compatibility levels. |
| `docs/architecture/TYPESCRIPT-PACKAGE-ARCHITECTURE.md` | Normative source/documentation organization. |
| `docs/status/CURRENT-STATUS.md` | Generated operational snapshot (regenerate any time). |
| `docs/development/DEVELOPMENT-METHOD.md` | Evidence standards, authority hierarchy, autonomous development process. |
| `docs/status/MILESTONES.md` | M0–M4 ladder and acceptance criteria (historical ledger). |
| `docs/operations/RESIDENT-MODE.md` | Resident persistence / hot reload / state ownership specification. |
| `docs/decision/AI-OBSERVER.md` | Read-only observer API and its run-binding limits. |
| `docs/history/` | Superseded material kept for provenance (old architecture versions, incidents, investigations, closed-milestone evidence). |

Precedence when documents disagree: **live server/world truth and current source** first, then the
V4.1.2 contracts, then `AGENTS.md`, then tests/evidence, then history and issues. A stale document is
repaired or marked historical — never used to bend runtime truth.

## Contributing

Small, causal, verifiable changes are the norm here:

1. start from an exact `origin/main` commit;
2. reproduce the failure with the smallest deterministic fixture you can (prefer extending an
   existing one over inventing a new framework);
3. make one causal change, and state which general capability class it fixes — not which seed or
   incident it unblocks;
4. prove it: focused fixture, then `bun run typecheck` and the relevant package suite;
5. land it with the evidence in the commit message, and re-run the gate that owns the behaviour.

Forbidden: seed coordinates, memorized resource locations, benchmark-specific branches, hidden task
selectors, weakened predicates/VERIFY, fabricated evidence, or identity resets that hide retries.

## Security

Please do not open a public issue for a vulnerability. Report it privately through GitHub's
**Security → Report a vulnerability** advisory flow. Never commit credentials: secrets are resolved
from permission-restricted files outside the repository and only non-secret origin metadata is
logged.

## License

No license has been selected for this repository yet, so it is **all rights reserved** by the
copyright holder: you may read and evaluate the code, but no license is granted to use, modify or
redistribute it. A license will be added explicitly if and when that changes.
