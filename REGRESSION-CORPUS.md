# Regression Corpus

This is the compact index of historical failures that must remain hard to reintroduce. It does **not** replace the source issue; it tells an autonomous worker which regression proves the root cause and whether a live counterpart is still required.

Evidence classes follow `DEFINITION-OF-DONE.md`.

| Failure / source | Invariant | Deterministic owner command | Evidence class | Live counterpart still required? |
| --- | --- | --- | --- | --- |
| wrong tool / hard-coded harvest assumptions — #7, #54 | tool legality and block breakability come from game mechanics/data, not incident tables | `cd jev-agent && bun run game-data-test && bun run minecraft-truth-test` | deterministic fixture | no for the mechanics contract |
| local movement repeats failed targets / pit hop makes no useful progress — #8 | unchanged failed movement is remembered; verified movement and recovery are not conflated | `cd jev-agent && bun run move-failmem-test && bun run pit-escape-test` | deterministic fixture | no for root-cause contract; gameplay generalization remains empirical |
| no visible resource incorrectly implies infinite downward digging — #9 | mechanical success cannot reset strategic no-progress forever; no-target descent is bounded | `cd jev-agent && bun run descend-plan-test` | deterministic fixture | no for the bounded-search invariant |
| PRECONDITION_MISSING caused 1-tick generation churn — #12 | unmet prerequisites expand/repair work instead of making the resident repeatedly stop/recover | `bun tools/verify-issue12.mjs` plus relevant ladder fixtures | integration + resident evidence | **yes** — issue requires sustained generation/recovery evidence |
| dynamic restart lost GoalQueue progress — #3 | durable semantic progress is restored before the first decision and remains monotonic | `cd buddy-driver && bun run ledger-restore-test` | integration fixture | **yes** — repeated resident restart/reload acceptance remains issue-owned |
| generation listener retained across churn — #13 | disposed generations cannot retain generation-owned listeners/timers or emit later actions | `cd buddy-driver && bun run reload-lifecycle-test` | lifecycle fixture | **yes** — stated acceptance requires >=20 changed-hash reloads + recovery cycles |
| stale station coordinates remain usable forever — #31 | station memory distinguishes known/verified/missing/unreachable and revalidates against live truth | `cd buddy-driver && bun run station-memory-test` | deterministic/integration fixture | no for the memory state machine |
| nested actuation bypasses lease — #38 | stale generations cannot actuate through top-level, plugin, raw packet, or shared pose paths | `cd buddy-driver && bun run actuation-port-test` | deterministic capability fixture | no for the boundary contract |
| failed reload rollback leaves divergent live/lease/snapshot owner — #49 | stable lifecycle point has exactly one generation owner and superseded instances are disposed | `cd buddy-driver && bun run reload-lifecycle-test` | lifecycle fixture | no for forced-failure transaction semantics; #13 owns long soak |
| repeated Option template collapsed a distinct runtime occurrence — #52 | template identity is not runtime occurrence identity; repeated Options survive as distinct instances | `cd jev-agent && bun run option-spec-test` | deterministic fixture | pending until #52 acceptance is fully implemented/verified |
| blocked Option/dependency reached executable queue — #50 | unmet deterministic initiation blocks the executable subtree | `cd jev-agent && bun run option-spec-test` | deterministic fixture | no |
| protected/core goal disappeared during plan patch/replace — #55 | plan repair cannot silently delete protected/core obligations | `cd jev-agent && bun run protected-goals-test` | deterministic fixture | no |
| stale known resource lost grounding after reload / distance — #14 | known resource retains world-scoped coordinates/freshness and can ground retrieval | `cd buddy-driver && bun run known-resource-test` | integration fixture | no for durable grounding; path execution remains separately tested |
| prereq path repeatedly chose a useless/stale furnace route — #58/#78 | feasible prereq alternatives are explicit; zero-progress/stale path does not loop forever | `cd jev-agent && bun run prereq-option-test && bun run prereq-oscillation-test`; `cd buddy-driver && bun run station-memory-test` | deterministic/integration fixture | **yes** for #78 end-to-end `FURNACE_READY -> SMELT_DONE` acceptance |
| ready smelt lost behind blocked long-horizon work — #46 | executable/ready dependency work cannot be starved by blocked future goals | `cd buddy-driver && bun run ladder-floor-test && bun run option-ladder-test` | integration fixture | **yes** for issue's iron-ingot/iron-pickaxe closed-loop acceptance |
| unverified zero-progress PLACE/SMELT looked successful — #79 | `done` is not semantic success; postcondition owns verified completion | `cd jev-agent && bun run action-verify-test`; `cd buddy-driver && bun run smelt-furnace-test && bun run furnace-place-test` | deterministic/integration fixture | **yes** — issue requires closed-loop smelt inventory evidence |
| queue emptied at iron rung and resident idled — #73 | achievable active milestone gets an executable horizon instead of persistent empty queue | `cd buddy-driver && bun run ladder-test && bun run option-ladder-test` | integration fixture | **yes** — issue explicitly requires live plan/prereq/smelt progression |
| traversal success was falsely reported as block removal — M2 heuristic audit V2 | mechanical movement progress and block-world mutation are separate facts | `cd jev-agent && bun run action-verify-test && bun run candidate-policy-test` | deterministic fixture | no for accounting semantics |
| obsidian treated as unbreakable despite game data — M2 heuristic audit V1 | registry/game-data truth cannot be overridden by a stale hard-coded “unbreakable” gameplay list | `cd jev-agent && bun run minecraft-truth-test` | deterministic fixture | no |
| pillar/headroom fallback reproduced one live pocket but could regress — M2 ascent chain | pillar feasibility/safety is deterministic; search policy is localized and observable | `cd jev-agent && bun run pillar-search-test && bun run pillar-jump-test && bun run vertical-plan-test` | deterministic fixture | live multi-terrain generalization is research/acceptance evidence, not implied by fixture |
| non-lossy death (per-world `keep_inventory`) reset the ladder to the earliest rung the leftover kit implied — `run-mubobiq6-12onv` | a death that kept the inventory resumes the run's DURABLE rung (archived ledger basis + `done` rows, scoped by worldKey, merged with durable world outcomes); a genuinely empty kit still resets to wood and discards that record | `cd buddy-driver && bun run death-resume-durable-test && bun run death-resume-settle-test && bun run ladder-test && bun run ledger-restore-test` | integration fixture | **yes** — a live `keep_inventory` death must show the resume rung surviving (`LADDER_RESUME ... resumeBasis=durable`) instead of `rung=charcoal` |
| offline M2 chain rehearsal asserted its emitter provenance as hand-written `file:line` text that had drifted (`executor.ts:825` claimed for `placedFrameCellLine`, which is at `executor.ts:1396`) | a derived marker's provenance is live source evidence: the probe searches the real emitter call and fails on a move, rename, or ambiguous match | `bun tools/test-m2-chain-rehearsal.mjs` | deterministic fixture | **yes** — the live executor path still has to emit the chain; the probe only proves the call sites exist |
| the M2 gate's build/light/verify verdict could not say WHICH evidence source proved each link (a frame from the snapshot plus a light from the log was indistinguishable from one ordered chain), so the run artifact carried no chain evidence | the ordered chain is reported per evidence source and carried by the run-scoped artifact; a `PASS` whose trace is not one ordered `built -> lit -> verified` chain is a GAP | `bun run m2-gate-test && bun tools/test-m2-chain-rehearsal.mjs && bun tools/test-milestone-run-artifact.mjs` | deterministic fixture | **yes** — `run-mubobiq6-12onv` inherited its portal; a fresh run must produce its own `m2_chain` trace |
| an ATTACK was offered from a position no swing could land from: an embedded/occluded hostile (operator screenshot, Nether tunnel: magma cube in the wall, `SKILL_END ... failure=verify_failed` / `out_of_reach`) and an enderman at 6.11 m (`pathfinder goal WAS set 5x`, distance frozen ~47 s, ZERO swings) | the offer is grounded on a STANCE, not on proximity: a cell that is standable (`isStandable`), hazard-free (`envHazard` classes + margin), inside the executor's own melee envelope (`MELEE_ATTACK_REACH`), with line of sight to the entity (the same `world.raycast` the cover logic casts) and walkable via the gate's `pathProbe`. No stance -> `no_attack_stand` + mirrored `NO_ATTACK_STAND`, never a 0-swing lease. An absent probe is NO verdict and leaves the previous gate exactly | `cd jev-agent && bun test ./test-attack-stand.mts` plus `bun run combat-closure-test`, `bun test ./test-hunt-contact.mts`, `bun test ./test-mob-survival.mts`, `bun test ./test-nether-survival.mts` | deterministic fixture (candidate gate + real Executor lease) | **yes** — the live shapes (a Nether-tunnel mob inside geometry, a producer no stance reaches) still need a run-scoped `NO_ATTACK_STAND` line instead of a repeated `verify_failed` lease |

| the closest fortress approach died disarmed: the hand held a `stone_pickaxe` while a `diamond_sword` was carried, `ATTACK:e45891` was reachable and offered, Jev chose RETREAT, and the only code that could arm the body lived INSIDE the ATTACK lease (so "did not attack" == "stayed disarmed") — `buddy.log` 463026-463109, health 16.704 -> 8.316 -> dead in ~4 s | arming the best carried weapon is its OWN grounded action, offered whenever a fight is on the table, executed through the same guard/effect-envelope/lease/post-condition path as every other equip; one offer per weapon CLASS so code never ranks sword against axe; and an armed body gets no offer at all (no churn) | `cd jev-agent && bun ./test-nether-survival-gear.mts && bun ./test-equip-affordance.mts && bun ./test-combat-closure.mts && bun ./test-nether-survival.mts` | deterministic fixture (candidate enumeration + real Executor equip lease) | **yes** — a live Nether fight must show the body armed (`EQUIP_WEAPON ... reason=combat`, now mirrored into `buddy.log`) or an explicit refusal, instead of meeting the mob with a tool |
| the survival envelope at contact was STRICTER than the danger envelope: `CONTACT_THREAT_KINDS` kept only `ATTACK|RETREAT|ESCALATE` while `THREAT_SURVIVAL_KINDS` documents `EAT`/`EQUIP` as survival, so eating and arming were erased exactly when the body was hit; and with no control kind on offer `survivalControlFallback` had nothing to execute, so an unservable survival action ended the tick with NO action while a reachable ATTACK sat in the offer (documented measured shape, `ATTACK:e23324`) | the contact envelope keeps the local self-care kinds, and a tick with a hostile in contact always executes a grounded action or the code-owned control action (`reason=control_action_escalate_code_owned`), which mutates nothing and chooses no fight/flight | `cd jev-agent && bun ./test-nether-survival-gear.mts && bun ./test-threat-response-grounding.mts && bun ./test-mob-survival.mts` | deterministic fixture | **yes** — a live contact death must show either a self-care action or the control action, never an actionless tick |

## CI subset

`.github/workflows/repo-invariants.yml` runs an architecture-critical deterministic subset on every PR/push to main:

```text
typecheck
game-data-test
minecraft-truth-test
option-spec-test
action-verify-test
protected-goals-test
candidate-policy-test
move-failmem-test
pit-escape-test
pillar-search-test
hop-policy-test
```

The subset is intentionally fast and server-free. A test being absent from this subset does not weaken its source issue's closure requirement; workers run the focused owner command when touching that subsystem.

## Adding a regression

When a live run discovers a new failure:

1. add evidence to the currently active issue first;
2. identify the violated invariant rather than naming only the symptom;
3. produce the smallest deterministic fixture/replay possible;
4. add the owner command here if the failure is historically important;
5. mark whether the original claim still needs live/soak/closed-loop evidence;
6. create a new issue only if the new root cause has a genuinely independent acceptance boundary.

Never convert a live-only property into a fake deterministic PASS. Fixtures prevent known mechanisms from returning; live runs prove embodied/runtime claims.
