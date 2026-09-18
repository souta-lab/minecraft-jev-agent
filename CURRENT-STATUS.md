# Current Status

Generated from real evidence only. Every section is labeled EVIDENCE or UNKNOWN; no value is invented.

## Base commit (origin/main) — EVIDENCE
- sha: `f834867520c239af1a8b7d2c0bd92e4146f9e531`
- subject: merge: task/m2-headroom (pocket relocation)
- date: 2026-09-18T20:43:26+09:00

## Open pull requests — EVIDENCE
- count: 0
- no open pull requests

## Open issues — EVIDENCE
- count: 30
- P0: 0
- P1: 0
- labels: no labels
- #128 Config: version and validate runtime/planner feature flags so rollout state is reproducible — no labels
- #127 Testing: turn historical live failures into a named regression corpus with reproducible fixtures — no labels
- #126 Governance: make implementation/verification/observation/compliance states machine-readable for every significant issue — no labels
- #125 Architecture: document the full resident generation lifecycle and every commit/rollback point — no labels
- #124 Ops: track coding-agent/model configuration provenance outside canonical project policy — no labels
- #123 AGENTS: remove model-specific behavioral patches and replace them with model-agnostic orchestration contracts — no labels
- #122 Orchestration: represent issue dependencies and critical path explicitly instead of relying on prose priority — no labels
- #121 Observability: define a failure/progress taxonomy so success, mechanical motion, goal progress, and verification cannot be conflated — no labels
- #120 Code architecture: decompose JevController/generation-entry mega-orchestration into explicit state machines and services — no labels
- #119 Architecture: make state classes and ownership explicit in code, not only docs — no labels
- #118 Ops: generate CURRENT-STATUS from GitHub/main/runtime evidence instead of hand-maintaining stale TODO snapshots — no labels
- #117 Governance: add a PR template that records authority changes, evidence class, rollout mode, and live acceptance status — no labels
- #116 Governance: add issue templates for defect, architecture, experiment, and live-validation work — no labels
- #115 Governance: add stale branch/worktree/PR cleanup and supersession rules — no labels
- #114 Milestones: define executable M1/M2/M3/M4 exit criteria and forbid milestone claims without matching evidence — no labels
- #113 CI: detect contradictions and drift across AGENTS, TODO, README, architecture docs, and contract constants — no labels
- #112 Orchestration: prevent duplicate parallel lanes for the same issue/acceptance criteria — no labels
- #111 Observability: define one event schema and causal ID hierarchy across plan → option → action → verification — no labels
- #110 Observability: standardize run-scoped acceptance artifacts with commit/config/world identity — no labels
- #109 Testing: define an acceptance taxonomy for unit, fixture, replay, structural smoke, live smoke, and closed-loop proof — no labels
- #108 Architecture: add ADRs for resident state ownership, generation swap commit point, and rollback semantics — no labels
- #107 Architecture: publish one authoritative control/authority map for HOST, System One, Options, β, Advisor, and System2 — no labels
- #106 README: rewrite project onboarding around system boundaries, modes, milestones, and current status links — no labels
- #105 Dev method: define a repository-wide Definition of Done that includes land, verification, live evidence, and closure — no labels
- #104 Docs: separate current operational truth from historical incident evidence in TODO/AGENTS — no labels
- #103 Governance: automatically reconcile merged PRs with issue acceptance and closure state — no labels
- #102 Meta: repository convergence hardening — make autonomous development auditable, current, and self-cleaning — no labels
- #80 M3: typed Nether portal plan path (gather obsidian with a diamond pickaxe, build the 4x5 frame, light and verify) - user stop condition — no labels
- #79 P1 live: unverified zero-progress actions report status=done (smelt never verifies), so the ladder can never advance — no labels
- #78 P1 live: smelt prereq loops on an unverified known furnace station instead of placing the held furnace (PREREQ_OPTION never fires, vertical oscillation) — no labels

## Resident snapshot — EVIDENCE
live: report received
```json
{
  "id": null,
  "ok": true,
  "data": {
    "runId": "run-mu69pbe8-9gfa",
    "frozen": false,
    "connected": true,
    "generations": 735,
    "reloads": 226,
    "recoveries": 475,
    "milestone": "iron_ingot",
    "worldKey": {
      "serverId": "127.0.0.1:25565",
      "dimension": "minecraft:overworld",
      "worldEpoch": 1
    },
    "generationId": "gen-mu6w3xc0-f2cz8q",
    "generationHash": "5a4a290878d4",
    "contractVersion": 3,
    "lease": {
      "activeId": "gen-mu6w3xc0-f2cz8q",
      "acquisitions": 80,
      "revocations": 51
    },
    "reconnect": {
      "reconnects": 0,
      "reconnectsLastHour": 0,
      "reconnectAttempt": 0,
      "reconnectReasons": {
        "end": 0,
        "kicked": 0,
        "error": 0
      },
      "lastReconnectAt": null,
      "lastReconnectReason": null,
      "lastReconnectBackoffMs": null,
      "lastReconnectUptimeMs": null
    },
    "hostLock": {
      "path": "/home/s0u7a/mc-ai/buddy-driver/data/resident/host.lock",
      "present": true,
      "filePid": 441190,
      "acquiredByThisProcess": true,
      "pid": 441190,
      "singleInstance": true
    },
    "stats": {
      "reconnects": 0,
      "reconnectsLastHour": 0,
      "reconnectAttempt": 0,
      "reconnectReasons": {
        "end": 0,
        "kicked": 0,
        "error": 0
      },
      "reloadsChangedHash": 28,
      "reloadsSkippedUnchanged": 9,
      "reloadsFailed": 0,
      "freezeCycles": 0,
      "wedge": true,
      "goalComplete": false
    },
    "worldMemory": {
      "craftingTables": 14,
      "furnaces": 2,
      "discoveredOres": [
        "coal_ore",
        "copper_ore",
        "iron_ore",
        "gold_ore",
        "deepslate_iron_ore",
        "deepslate_diamond_ore"
      ],
      "traversalFailures": 0,
      "hazards": 1,
      "hardHazards": 0
    },
    "listeners": {
      "physicsTick": 2,
      "goal_reached": 1,
      "goal_updated": 0,
      "path_update": 0,
      "blockUpdate": 2,
      "entitySpawn": 1,
      "health": 2,
      "playerCollect": 1,
      "death": 4,
      "end": 3,
      "kicked": 2
    },
    "listenerBaseline": {
      "physicsTick": 2,
      "goal_reached": 1,
      "goal_updated": 0,
      "path_update": 0,
      "blockUpdate": 2,
      "entitySpawn": 1,
      "health": 2,
      "playerCollect": 1,
      "death": 4,
      "end": 3,
      "kicked": 2
    },
    "listenerLeak": false,
    "acceptancePath": "/home/s0u7a/mc-ai/buddy-driver/data/resident/acceptance-run-mu69pbe8-9gfa.json",
    "status": {
      "running": true,
      "policyKind": "fallback",
      "policyModel": "deterministic-local-fallback+descend-aware",
      "system2Model": "typesafe-ai/jev",
      "queue": {
        "depth": 2,
        "current": {
          "id": "g220:smelt:iron_ingot",
          "kind": "smelt",
          "description": "smelt 3 x iron_ingot",
          "targetItem": "iron_ingot",
          "requiredCount": 3,
          "targetY": null,
          "dimension": null,
          "startCount": 0,
          "haveCount": 0,
          "status": "active",
          "origin": "llm",
          "createdAt": 1789732373815,
          "updatedAt": 1789732453044,
          "detail": null,
          "protected": false,
          "core": false
        },
        "empty": false,
        "hasImpossible": false,
        "done": 0,
        "goals": [
          {
            "id": "g220:smelt:iron_ingot",
            "kind": "smelt",
            "description": "smelt 3 x iron_ingot",
            "targetItem": "iron_ingot",
            "requiredCount": 3,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "active",
            "origin": "llm",
            "createdAt": 1789732373815,
            "updatedAt": 1789732453044,
            "detail": null,
            "protected": false,
            "core": false
          },
          {
            "id": "g221:collect:diamond",
            "kind": "collect",
            "description": "collect 1 x diamond",
            "targetItem": "diamond",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789732373815,
            "updatedAt": 1789732373815,
            "detail": null,
            "protected": false,
            "core": true
          }
        ]
      },
      "currentAction": {
        "id": "WAIT",
        "kind": "WAIT",
        "phase": "waiting 300ms",
        "startedAt": 1789732453067
      },
      "truth": {
        "position": {
          "x": 40.01535538522843,
          "y": 12,
          "z": 31.014884162288805
        },
        "health": 20,
        "food": 20,
        "dimension": "overworld",
        "onGround": false,
        "inventory": {
          "diorite": 16,
          "dirt": 94,
          "raw_copper": 11,
          "andesite": 33,
          "raw_iron": 8,
          "leaf_litter": 30,
          "birch_button": 1,
          "wheat_seeds": 2,
          "cobblestone": 115,
          "coal": 7,
          "oak_planks": 1
        }
      },
      "plannedGoals": 19,
      "rungIndex": 8,
      "rungId": "iron_ingot",
      "ready": true,
      "contractVersion": 3,
      "worldKey": {
        "serverId": "127.0.0.1:25565",
        "dimension": "minecraft:overworld",
        "worldEpoch": 1
      }
    }
  }
}
```

## Evidence commands — EVIDENCE
- `git log -1 --format=%H%n%s%n%cI origin/main`
- `gh pr list --state open --json number,title,headRefName`
- `gh issue list --state open --json number,title,labels`
- `socket /home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock <- {"cmd":"report"} (2000ms timeout)`
