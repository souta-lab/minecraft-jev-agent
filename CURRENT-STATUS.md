# Current Status

Generated from real evidence only. Every section is labeled EVIDENCE or UNKNOWN; no value is invented.

## Base commit (origin/main) — EVIDENCE
- sha: `494a92b2162a2f3127506c8c367093e5eea54e01`
- subject: fix(guard): the smelt guard stops probing the furnace's own cell
- date: 2026-09-23T12:59:14+09:00

## Open pull requests — EVIDENCE
- count: 1
- #428 fix(portal): establish entry stand before transfer (head: support/m3-portal-entry-approach)

## Open issues — EVIDENCE
- count: 10
- P0: 0
- P1: 0
- priority source: labels first, then title prefix (0 counted from title only)
- labels: no labels
- #440 Movement OS: generalize MOVE into scaffold-capable locomotion — walk/jump/bridge/tower under a #11-safe effect envelope — no labels
- #439 Architecture: seal System2 behind a typed intent harness — natural-language WHAT in, grounded Option proposals out, zero direct LLM authority — no labels
- #437 Jev state hygiene: semantic event compression, stable candidate identity, and decision-epoch isolation — no labels
- #436 Architecture: deterministic Skill closure after Jev selection — reflex boundaries, target commitment, and #11-compliant execution — no labels
- #421 Execution focus: cap WIP and drive one generic M3 critical path to fresh ender_eye>=12 acceptance — no labels
- #416 Behavior quality gate: no recurrent wandering, redundant station crafting, purposeless actions, or unbounded idle — no labels
- #366 Repo-wide audit: close repository, runtime, evidence, test, and tooling boundary gaps — no labels
- #365 Generalization gate: production is still an M2/M3 tech-tree machine rather than a benchmark-independent runtime — no labels
- #308 Convergence tracker: migrate production to the #11 v3 Grounded Option OS — no labels
- #11 Architecture v3: Grounded Option OS — typed System2/Jev harnesses, Skill commitments, deterministic truth, and benchmark-independent authority — no labels

## Resident snapshot — EVIDENCE
live: report received
```json
{
  "id": null,
  "ok": true,
  "data": {
    "runId": "run-mudkuea9-124kk",
    "frozen": false,
    "connected": true,
    "generations": 643,
    "reloads": 221,
    "recoveries": 0,
    "milestone": "blaze_rods",
    "worldKey": {
      "serverId": "127.0.0.1:25565",
      "dimension": "minecraft:overworld",
      "worldEpoch": 1
    },
    "generationId": "gen-mudkuerj-8ehpqk",
    "generationHash": "7310c11a8280",
    "contractVersion": 3,
    "lease": {
      "activeId": "gen-mudkuerj-8ehpqk",
      "acquisitions": 1,
      "revocations": 0
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
      "path": "/home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/data/resident/host.lock",
      "present": true,
      "filePid": 1778852,
      "acquiredByThisProcess": true,
      "pid": 1778852,
      "singleInstance": true,
      "outcome": "acquired",
      "reclaimedFrom": null
    },
    "durability": {
      "writeFailures": 0,
      "stateQuarantines": 0,
      "lockReclaims": 0,
      "lockLosses": 0,
      "fatalShutdowns": 0,
      "markers": [],
      "lastEvent": null,
      "stateQuarantinePath": null
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
      "reloadsChangedHash": 0,
      "reloadsSkippedUnchanged": 0,
      "reloadsFailed": 0,
      "freezeCycles": 0,
      "wedge": false,
      "goalComplete": false
    },
    "worldMemory": {
      "craftingTables": 0,
      "furnaces": 0,
      "discoveredOres": [
        "coal_ore",
        "copper_ore",
        "iron_ore",
        "deepslate_coal_ore",
        "deepslate_iron_ore",
        "deepslate_diamond_ore"
      ],
      "traversalFailures": 0,
      "knownTraversals": 128,
      "hazards": 57,
      "hardHazards": 1
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
    "acceptancePath": "/home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/data/resident/acceptance-run-mudkuea9-124kk.json",
    "status": {
      "running": true,
      "policyKind": "typesafe",
      "policyProvider": "typesafe-ai",
      "policyModel": "typesafe-ai/jev",
      "system2Provider": "muse-spark",
      "system2Model": "meta/muse-spark-1.3-contributor",
      "system2AuthorityStack": {
        "provider": "hybrid",
        "model": "typesafe-ai:typesafe-ai/jev|muse-spark:meta/muse-spark-1.3-contributor"
      },
      "system2LastAuthority": {
        "provider": "muse-spark",
        "model": "meta/muse-spark-1.3-contributor"
      },
      "deterministicFallbackEnabled": false,
      "queue": {
        "depth": 1,
        "current": {
          "id": "g198:explore",
          "kind": "explore",
          "description": "explore",
          "targetItem": null,
          "requiredCount": 1,
          "targetY": null,
          "dimension": null,
          "optionInstanceId": "explore:surface",
          "optionTemplateId": "explore:surface",
          "optionSpec": {
            "id": "explore:surface",
            "intent": "explore",
            "kind": "explore",
            "target": {
              "count": 1
            },
            "preconditions": [],
            "success": [
              {
                "kind": "custom",
                "id": "done:explore:unknown"
              }
            ],
            "skills": [
              "EXPLORE_FRONTIER"
            ],
            "abortThreshold": 0.5,
            "semanticOptionInstanceId": "explore:surface",
            "semanticOptionTemplateId": "explore:surface",
            "semanticOptionIntent": "explore"
          },
          "semanticOptionInstanceId": "explore:surface",
          "semanticOptionTemplateId": "explore:surface",
          "semanticOptionIntent": "explore",
          "planIdentity": {
            "rungId": "enter_nether",
            "rungIndex": 14,
            "objectiveItem": "nether_portal",
            "objectiveCount": 1
          },
          "startCount": 0,
          "haveCount": 0,
          "status": "active",
          "origin": "llm",
          "createdAt": 1790136152184,
          "updatedAt": 1790136152184,
          "detail": null,
          "protected": false,
          "core": false
        },
        "empty": false,
        "hasImpossible": true,
        "done": 1,
        "goals": [
          {
            "id": "g112:place:nether_portal",
            "kind": "place",
            "description": "verify_portal",
            "targetItem": "nether_portal",
            "requiredCount": 1,
            "targetY": null,
            "dimension": "minecraft:overworld",
            "targetPredicate": "portal_lit",
            "optionInstanceId": "verify_portal:goal#dminecraft_overworld~pportal_lit",
            "optionTemplateId": "verify_portal:goal",
            "optionSpec": {
              "id": "verify_portal:goal",
              "intent": "verify_portal",
              "kind": "place",
              "target": {
                "count": 1,
                "item": "nether_portal",
                "dimension": "minecraft:overworld",
                "predicate": "portal_lit"
              },
              "preconditions": [],
              "success": [
                {
                  "kind": "custom",
                  "id": "station:nether_portal"
                }
              ],
              "skills": [
                "PLACE_STATION"
              ],
              "abortThreshold": 0.5,
              "semanticOptionInstanceId": "verify_portal:goal#dminecraft_overworld~pportal_lit",
              "semanticOptionTemplateId": "verify_portal:goal",
              "semanticOptionIntent": "verify_portal"
            },
            "semanticOptionInstanceId": "verify_portal:goal#dminecraft_overworld~pportal_lit",
            "semanticOptionTemplateId": "verify_portal:goal",
            "semanticOptionIntent": "verify_portal",
            "planIdentity": {
              "rungId": "enter_nether",
              "rungIndex": 14,
              "objectiveItem": "nether_portal",
              "objectiveCount": 1
            },
            "startCount": 0,
            "haveCount": 1,
            "status": "done",
            "origin": "llm",
            "createdAt": 1790134403581,
            "updatedAt": 1790134403581,
            "detail": "retired: success predicate 'portal_lit' already holds (verified portal site recorded origin=25,66,9 frame=10 dimension=minecraft:overworld)",
            "protected": false,
            "core": false
          },
          {
            "id": "g197:place:nether_portal",
            "kind": "place",
            "description": "enter_portal",
            "targetItem": "nether_portal",
            "requiredCount": 1,
            "targetY": null,
            "dimension": "minecraft:the_nether",
            "targetPredicate": "portal_entered",
            "optionInstanceId": "enter_portal:goal#dminecraft_the_nether~pportal_entered",
            "optionTemplateId": "enter_portal:goal",
            "optionSpec": {
              "id": "enter_portal:goal",
              "intent": "enter_portal",
              "kind": "place",
              "target": {
                "count": 1,
                "item": "nether_portal",
                "dimension": "minecraft:the_nether",
                "predicate": "portal_entered"
              },
              "preconditions": [],
              "success": [
                {
                  "kind": "dimensionIs",
                  "dimension": "minecraft:the_nether"
                }
              ],
              "skills": [
                "PLACE_STATION"
              ],
              "abortThreshold": 0.5,
              "core": true,
              "semanticOptionInstanceId": "enter_portal:goal#dminecraft_the_nether~pportal_entered",
              "semanticOptionTemplateId": "enter_portal:goal",
              "semanticOptionIntent": "enter_portal"
            },
            "semanticOptionInstanceId": "enter_portal:goal#dminecraft_the_nether~pportal_entered",
            "semanticOptionTemplateId": "enter_portal:goal",
            "semanticOptionIntent": "enter_portal",
            "planIdentity": {
              "rungId": "enter_nether",
              "rungIndex": 14,
              "objectiveItem": "nether_portal",
              "objectiveCount": 1
            },
            "startCount": 0,
            "haveCount": 0,
            "status": "impossible",
            "origin": "llm",
            "createdAt": 1790136116492,
            "updatedAt": 1790136152183,
            "detail": "replaced by System2 answer: reason=action_impossible requestId=ff0c83a5-1e5f-44df-8875-02a181e6df72 note=\"cached mercury mercury_patch_explore_surface\"",
            "protected": false,
            "core": true,
            "starvedDecisions": 0
          },
          {
            "id": "g198:explore",
            "kind": "explore",
            "description": "explore",
            "targetItem": null,
            "requiredCount": 1,
            "targetY": null,
            "dimension": null,
            "optionInstanceId": "explore:surface",
            "optionTemplateId": "explore:surface",
            "optionSpec": {
              "id": "explore:surface",
              "intent": "explore",
              "kind": "explore",
              "target": {
                "count": 1
              },
              "preconditions": [],
              "success": [
                {
                  "kind": "custom",
                  "id": "done:explore:unknown"
                }
              ],
              "skills": [
                "EXPLORE_FRONTIER"
              ],
              "abortThreshold": 0.5,
              "semanticOptionInstanceId": "explore:surface",
              "semanticOptionTemplateId": "explore:surface",
              "semanticOptionIntent": "explore"
            },
            "semanticOptionInstanceId": "explore:surface",
            "semanticOptionTemplateId": "explore:surface",
            "semanticOptionIntent": "explore",
            "planIdentity": {
              "rungId": "enter_nether",
              "rungIndex": 14,
              "objectiveItem": "nether_portal",
              "objectiveCount": 1
            },
            "startCount": 0,
            "haveCount": 0,
            "status": "active",
            "origin": "llm",
            "createdAt": 1790136152184,
            "updatedAt": 1790136152184,
            "detail": null,
            "protected": false,
            "core": false
          }
        ],
        "revision": 3
      },
      "currentAction": null,
      "truth": {
        "position": {
          "x": 23.499958036225582,
          "y": 79,
          "z": 6.396955774787143
        },
        "health": 16,
        "food": 10,
        "dimension": "overworld",
        "onGround": true,
        "inventory": {
          "iron_ingot": 2,
          "dirt": 140,
          "oak_sapling": 17,
          "oak_log": 81,
          "birch_planks": 1,
          "raw_iron": 2,
          "birch_sapling": 4,
          "raw_copper": 31,
          "furnace": 1,
          "red_mushroom": 1,
          "leaf_litter": 92,
          "soul_soil": 228,
          "gravel": 16,
          "birch_log": 28,
          "granite": 30,
          "flint": 4,
          "coal": 3,
          "stick": 8,
          "flint_and_steel": 1,
          "diorite": 13,
          "cobbled_deepslate": 27,
          "charcoal": 1,
          "soul_sand": 59,
          "netherrack": 29,
          "diamond_sword": 1,
          "andesite": 48
        }
      },
      "milestonePredicates": [
        {
          "id": "portal_verified",
          "milestone": "M2",
          "satisfied": true,
          "observedAtMs": 1790136208678,
          "observedAt": "2026-09-23T04:03:28.678Z",
          "source": "host-observe:rung:nether_portal",
          "evidence": {
            "rungId": "nether_portal",
            "rungPredicate": true,
            "dimension": "minecraft:overworld",
            "portalVerified": true,
            "items": {
              "nether_portal": 0,
              "flint_and_steel": 1,
              "obsidian": 0
            }
          }
        },
        {
          "id": "nether_reached",
          "milestone": "M3",
          "satisfied": null,
          "observedAtMs": null,
          "observedAt": null,
          "source": "host-observe:rung:enter_nether",
          "evidence": {
            "rungId": "enter_nether",
            "rungPredicate": false,
            "dimension": "minecraft:overworld",
            "portalVerified": true,
            "items": {}
          }
        },
        {
          "id": "blaze_rods",
          "milestone": "M3",
          "satisfied": false,
          "observedAtMs": 1790136208678,
          "observedAt": "2026-09-23T04:03:28.678Z",
          "source": "host-observe:rung:blaze_rods",
          "evidence": {
            "rungId": "blaze_rods",
            "rungPredicate": false,
            "dimension": "minecraft:overworld",
            "portalVerified": true,
            "items": {
              "blaze_rod": 0
            }
          }
        },
        {
          "id": "ender_pearls",
          "milestone": "M3",
          "satisfied": false,
          "observedAtMs": 1790136208678,
          "observedAt": "2026-09-23T04:03:28.678Z",
          "source": "host-observe:rung:ender_pearls",
          "evidence": {
            "rungId": "ender_pearls",
            "rungPredicate": false,
            "dimension": "minecraft:overworld",
            "portalVerified": true,
            "items": {
              "ender_pearl": 0
            }
          }
        },
        {
          "id": "ender_eyes",
          "milestone": "M3",
          "satisfied": false,
          "observedAtMs": 1790136208678,
          "observedAt": "2026-09-23T04:03:28.678Z",
          "source": "host-observe:rung:ender_eyes",
          "evidence": {
            "rungId": "ender_eyes",
            "rungPredicate": false,
            "dimension": "minecraft:overworld",
            "portalVerified": true,
            "items": {
              "ender_eye": 0
            }
          }
        }
      ],
      "plannedGoals": 4,
      "rungIndex": 14,
      "rungId": "enter_nether",
      "goalItem": "nether_portal",
      "goalCount": 1,
      "ledgerBasis": {
        "worldKey": "127.0.0.1:25565|minecraft:overworld|1",
        "frontierRungId": "enter_nether",
        "frontierRungIndex": 14
      },
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

## CI gate (repo-invariants) — EVIDENCE
- verdict: INFRA_UNKNOWN
- run: 35816484423
- head: 494a92b2162a2f3127506c8c367093e5eea54e01
- jobs: 0/5 executed at least one step
- reason: no job executed a single step (5/5 never started)
- job jev-harness: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job core-deterministic: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job convergence: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job authority-contract: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job system2-harness: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- NOTE: no job executed a step. This run is NOT a code verdict (issue #299).
- NOTE: do not cite GitHub Actions as a passing or failing gate for this head until the workflow actually runs.

## Evidence commands — EVIDENCE
- `git log -1 --format=%H%n%s%n%cI origin/main`
- `gh pr list --state open --limit 1000 --json number,title,headRefName`
- `gh issue list --state open --limit 1000 --json number,title,labels`
- `socket /home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/data/resident/control.sock <- {"cmd":"report"} (2000ms timeout)`
- `gh run list --workflow=repo-invariants.yml --limit 1 --json databaseId,headSha,createdAt,conclusion,headBranch`
- `gh api repos/souta-lab/minecraft-jev-agent/actions/runs/35816484423/jobs`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/107039003506/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/107039003609/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/107039003626/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/107039003669/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/107039003690/annotations`
