# Current Status

Generated from real evidence only. Every section is labeled EVIDENCE or UNKNOWN; no value is invented.

## Base commit (origin/main) — EVIDENCE
- sha: `a29e4d47e38aab7db4dc2ca37cfb54965014740e`
- subject: Merge pull request #169 from souta-lab/task/m2-pillar-no-rise-relocation
- date: 2026-09-19T05:50:24+09:00

## Open pull requests — EVIDENCE
- count: 3
- #172 chore(#103): reconcile closed issue evidence state (head: task/113-issue-state-drift)
- #171 fix(evidence): resolve current run from BOOT boundaries (head: task/evidence-runid-guard)
- #170 fix(m2): explore when craft log prerequisite is withheld (head: task/m2-log-explore-craft)

## Open issues — EVIDENCE
- count: 38
- P0: 0
- P1: 6
- priority source: labels first, then title prefix (6 counted from title only)
- labels: no labels
- #136 P1 correctness: `return_to_surface` has false surface truth and conflicting DONE contracts — no labels
- #130 Research/Architecture: Jev speculative multi-head policy — compare flat action Choice vs action-kind + typed target heads — no labels
- #129 Research hypothesis: after a capability threshold, M2→M4 may be easier than M1→M2 because System2 can compose existing skills — no labels
- #128 Config: version and validate runtime/planner feature flags so rollout state is reproducible — no labels
- #126 Governance: make implementation/verification/observation/compliance states machine-readable for every significant issue — no labels
- #125 Architecture: document the full resident generation lifecycle and every commit/rollback point — no labels
- #124 Ops: track coding-agent/model configuration provenance outside canonical project policy — no labels
- #123 AGENTS: remove model-specific behavioral patches and replace them with model-agnostic orchestration contracts — no labels
- #122 Orchestration: represent issue dependencies and critical path explicitly instead of relying on prose priority — no labels
- #121 Observability: define a failure/progress taxonomy so success, mechanical motion, goal progress, and verification cannot be conflated — no labels
- #120 Code architecture: decompose JevController/generation-entry mega-orchestration into explicit state machines and services — no labels
- #119 Architecture: make state classes and ownership explicit in code, not only docs — no labels
- #115 Governance: add stale branch/worktree/PR cleanup and supersession rules — no labels
- #111 Observability: define one event schema and causal ID hierarchy across plan → option → action → verification — no labels
- #110 Observability: standardize run-scoped acceptance artifacts with commit/config/world identity — no labels
- #109 Testing: define an acceptance taxonomy for unit, fixture, replay, structural smoke, live smoke, and closed-loop proof — no labels
- #108 Architecture: add ADRs for resident state ownership, generation swap commit point, and rollback semantics — no labels
- #107 Architecture: publish one authoritative control/authority map for HOST, System One, Options, β, Advisor, and System2 — no labels
- #104 Docs: separate current operational truth from historical incident evidence in TODO/AGENTS — no labels
- #103 Governance: automatically reconcile merged PRs with issue acceptance and closure state — no labels
- #102 Meta: repository convergence hardening — make autonomous development auditable, current, and self-cleaning — no labels
- #80 M3: typed Nether portal plan path (gather obsidian with a diamond pickaxe, build the 4x5 frame, light and verify) - user stop condition — no labels
- #79 P1 live: unverified zero-progress actions report status=done (smelt never verifies), so the ladder can never advance — no labels
- #78 P1 live: smelt prereq loops on an unverified known furnace station instead of placing the held furnace (PREREQ_OPTION never fires, vertical oscillation) — no labels
- #73 P1 live: empty goal queue at rung=iron_ingot - the planner never supplies the smelt goal, so the agent idles — no labels
- #58 Flexibility: choose the cheapest/feasible way to satisfy a precondition (use known station vs place held item vs craft new), and switch paths when one stalls — no labels
- #56 Grounded Options integration gap: OptionSpec is compiled then collapsed back to PlannedGoal before Jev/β sees it — no labels
- #52 Grounded Options identity: stableOptionId dedupe can collapse repeated Option instances in one plan — no labels
- #46 M2 blocker: plan ordering skips a ready smelt in favour of long-horizon goals (diamond) while the ladder rung regresses to wood — no labels
- #41 Architecture for M3/M4: evolve item-centric linear ladder into a predicate-based capability/Option graph — no labels
- #39 Architecture boundary: resident integration reaches into JevController private fields via casts — no labels
- #37 M3/M4 roadmap: goal templates and required primitives (final goal = Ender Dragon) — no labels
- #35 Architecture cleanup after #11: avoid three competing semantic planners (horizon Jev, Advisor Jev, Mercury) — no labels
- #17 Advisor cache key omits position/world identity and can replay stale strategies — no labels
- #16 Mercury cache key is not world-scoped and can reuse plans across location/world changes — no labels
- #12 P1: PRECONDITION_MISSING treated as a stop condition causes 1-tick generation churn — no labels
- #11 Architecture v2: Grounded Options — heuristic-minimal Jev π/β with a deterministic affordance shell — no labels
- #3 P1: resident restart does not restore GoalQueue ledger in dynamic planner mode — no labels

## Resident snapshot — EVIDENCE
live: report received
```json
{
  "id": null,
  "ok": true,
  "data": {
    "runId": "run-mu7a4z6r-hcus",
    "frozen": false,
    "connected": true,
    "generations": 1759,
    "reloads": 297,
    "recoveries": 1425,
    "milestone": "iron_ingot",
    "worldKey": {
      "serverId": "127.0.0.1:25565",
      "dimension": "minecraft:overworld",
      "worldEpoch": 1
    },
    "generationId": "gen-mu7k1yzh-upi8o6",
    "generationHash": "fd9678dec799",
    "contractVersion": 3,
    "lease": {
      "activeId": "gen-mu7k1yzh-upi8o6",
      "acquisitions": 855,
      "revocations": 827
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
      "filePid": 809812,
      "acquiredByThisProcess": true,
      "pid": 809812,
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
      "reloadsSkippedUnchanged": 13,
      "reloadsFailed": 0,
      "freezeCycles": 0,
      "wedge": true,
      "goalComplete": false
    },
    "worldMemory": {
      "craftingTables": 1,
      "furnaces": 1,
      "discoveredOres": [
        "coal_ore",
        "copper_ore",
        "iron_ore",
        "gold_ore",
        "deepslate_iron_ore",
        "deepslate_diamond_ore"
      ],
      "traversalFailures": 0,
      "hazards": 2,
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
    "listenerExpected": {
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
    "acceptancePath": "/home/s0u7a/mc-ai/buddy-driver/data/resident/acceptance-run-mu7a4z6r-hcus.json",
    "status": {
      "running": true,
      "policyKind": "fallback",
      "policyModel": "deterministic-local-fallback+descend-aware",
      "system2Model": "typesafe-ai/jev",
      "queue": {
        "depth": 21,
        "current": {
          "id": "g15038:craft:wooden_pickaxe",
          "kind": "craft",
          "description": "craft 1 x wooden_pickaxe",
          "targetItem": "wooden_pickaxe",
          "requiredCount": 1,
          "targetY": null,
          "dimension": null,
          "startCount": 0,
          "haveCount": 0,
          "status": "active",
          "origin": "llm",
          "createdAt": 1789772027877,
          "updatedAt": 1789772031970,
          "detail": null,
          "protected": false,
          "core": true
        },
        "empty": false,
        "hasImpossible": false,
        "done": 0,
        "goals": [
          {
            "id": "g15038:craft:wooden_pickaxe",
            "kind": "craft",
            "description": "craft 1 x wooden_pickaxe",
            "targetItem": "wooden_pickaxe",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "active",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772031970,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15039:craft:stone_pickaxe",
            "kind": "craft",
            "description": "craft 1 x stone_pickaxe",
            "targetItem": "stone_pickaxe",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15040:collect:log",
            "kind": "collect",
            "description": "collect 1 x log",
            "targetItem": "log",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": false
          },
          {
            "id": "g15041:collect:flint",
            "kind": "collect",
            "description": "collect 1 x flint (from gravel)",
            "targetItem": "flint",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": true,
            "core": true
          },
          {
            "id": "g15042:place:nether_portal",
            "kind": "place",
            "description": "build the 4x5 obsidian portal frame (10 blocks)",
            "targetItem": "nether_portal",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15043:smelt:charcoal",
            "kind": "smelt",
            "description": "smelt 1 x charcoal",
            "targetItem": "charcoal",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15044:collect:raw_iron",
            "kind": "collect",
            "description": "collect 3 x raw_iron",
            "targetItem": "raw_iron",
            "requiredCount": 3,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15045:smelt:iron_ingot",
            "kind": "smelt",
            "description": "smelt 3 x iron_ingot",
            "targetItem": "iron_ingot",
            "requiredCount": 3,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15046:craft:iron_pickaxe",
            "kind": "craft",
            "description": "craft 1 x iron_pickaxe",
            "targetItem": "iron_pickaxe",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15047:collect:raw_iron",
            "kind": "collect",
            "description": "collect 26 x raw_iron",
            "targetItem": "raw_iron",
            "requiredCount": 26,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15048:smelt:iron_ingot",
            "kind": "smelt",
            "description": "smelt 26 x iron_ingot",
            "targetItem": "iron_ingot",
            "requiredCount": 26,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15049:craft:iron_chestplate",
            "kind": "craft",
            "description": "craft 1 x iron_chestplate",
            "targetItem": "iron_chestplate",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15050:craft:iron_leggings",
            "kind": "craft",
            "description": "craft 1 x iron_leggings",
            "targetItem": "iron_leggings",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15051:craft:iron_helmet",
            "kind": "craft",
            "description": "craft 1 x iron_helmet",
            "targetItem": "iron_helmet",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15052:craft:iron_boots",
            "kind": "craft",
            "description": "craft 1 x iron_boots",
            "targetItem": "iron_boots",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15053:craft:iron_sword",
            "kind": "craft",
            "description": "craft 1 x iron_sword",
            "targetItem": "iron_sword",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15054:collect:diamond",
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
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15055:craft:diamond_pickaxe",
            "kind": "craft",
            "description": "craft 1 x diamond_pickaxe",
            "targetItem": "diamond_pickaxe",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": false,
            "core": true
          },
          {
            "id": "g15056:craft:flint_and_steel",
            "kind": "craft",
            "description": "craft 1 x flint_and_steel",
            "targetItem": "flint_and_steel",
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": true,
            "core": true
          },
          {
            "id": "g15057:collect:diamond",
            "kind": "collect",
            "description": "collect 3 x diamond",
            "targetItem": "diamond",
            "requiredCount": 3,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": true,
            "core": true
          },
          {
            "id": "g15058:collect:obsidian",
            "kind": "collect",
            "description": "mine 10 x obsidian with diamond_pickaxe",
            "targetItem": "obsidian",
            "requiredCount": 10,
            "targetY": null,
            "dimension": null,
            "startCount": 0,
            "haveCount": 0,
            "status": "pending",
            "origin": "llm",
            "createdAt": 1789772027877,
            "updatedAt": 1789772027877,
            "detail": null,
            "protected": true,
            "core": true
          }
        ]
      },
      "currentAction": {
        "id": "WAIT",
        "kind": "WAIT",
        "phase": "waiting 300ms",
        "startedAt": 1789772032009
      },
      "truth": {
        "position": {
          "x": 39.38846558291214,
          "y": 11,
          "z": 32.55265596563287
        },
        "health": 20,
        "food": 20,
        "dimension": "overworld",
        "onGround": true,
        "inventory": {
          "birch_planks": 2,
          "stick": 2,
          "cobblestone": 170,
          "dirt": 37,
          "leaf_litter": 4,
          "andesite": 7
        }
      },
      "plannedGoals": 24,
      "rungIndex": 2,
      "rungId": "wooden_pickaxe",
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
- `gh pr list --state open --limit 1000 --json number,title,headRefName`
- `gh issue list --state open --limit 1000 --json number,title,labels`
- `socket /home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock <- {"cmd":"report"} (2000ms timeout)`
