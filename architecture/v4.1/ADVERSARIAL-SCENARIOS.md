# V4.1 Counterexample / Adversarial Scenario Suite

The purpose is to falsify the architecture, not to showcase it. Each row states the expected lifecycle, resource/effect ownership, and verification boundary.

| # | Scenario | Expected lifecycle | Ownership | Verification / required evidence |
|---|---|---|---|---|
| 1 | Reach while passive Search | Reach ACTIVE; Search ACTIVE/OBSERVING | Reach locomotion WRITE; Search observation READ + memory APPEND | independent fresh facts; Search cannot close Reach |
| 2 | Reach preempted by lava/air Viability | Reach ACTIVE->SUSPENDED; Viability RUNNABLE->ACTIVE | locomotion revoked from Reach then granted to Viability | stabilization fact, then fresh Reach revalidation |
| 3 | Reach resumes after food stabilization | same Reach SUSPENDED->RUNNABLE->ACTIVE | Viability releases inventory/equipment/body before Reach reacquires | same transitionId/hash; only destination VERIFY closes Reach |
| 4 | Smelting while exploring | Smelt ACTIVE->OBSERVING; Explore ACTIVE | furnace/inventory released after commit; Explore locomotion WRITE | furnace output/input-consumption facts wake Smelt |
| 5 | Hostile appears during container interaction | container critical section finishes/yields within bound; threat/Viability waits or preempts at safe point | bounded container+inventory lease, then threat body/attack lease | no half-applied hidden transfer; fresh inventory/window truth |
| 6 | Witness disappears while Reach suspended | Reach remains semantic owner; resume revalidation selects substitute or blocks/terminalizes | no body lease while suspended | witness loss is not SUCCESS/failure by itself |
| 7 | worldEpoch changes during suspend | Reach -> TERMINAL WORLD_CHANGED | all old leases/tokens revoked | old facts cannot resume contract |
| 8 | two Reach Transitions request locomotion | one ACTIVE, one RUNNABLE/BLOCKED/SUSPENDED | exactly one locomotion WRITE | scheduler record names winner/conflict |
| 9 | inventory mutation conflict: craft vs equip/withdraw | loser stays RUNNABLE/BLOCKED | atomic exclusive inventory/window bundle | no interleaved mutation; post-window inventory fact |
| 10 | simultaneous passive observation + block placement | both may stay live | observer READ; placer block-scope WRITE + locomotion/orientation as needed | observer sees post-placement fact with provenance |
| 11 | deadlock candidate A wants inventory+furnace, B furnace+inventory | one bundle granted, other none | atomic canonical bundle, no partial hold | journal proves zero hold-and-wait |
| 12 | priority inversion: background owns short inventory critical section, Viability needs equipment | background inherits priority only until bounded release | no new background effects under inheritance | bounded release latency and then Viability grant |
| 13 | starvation: passive Search repeatedly loses ordinary conflict | aging increases while runnable | no forced lease until score wins | eventually scheduled absent continuing emergency/deadline dominance |
| 14 | Jev outage while active Reach has unambiguous committed path leg | Reach remains ACTIVE until policy boundary | existing leases remain valid | mechanics may continue; no fabricated semantic fallback |
| 15 | Jev stale answer after preemption | answer dropped | no lease/effect derived from stale frame | stale marker binds old scheduler/fact/registry revisions |
| 16 | human Mission replacement | affected Transitions -> TERMINAL MISSION_SUPERSEDED/CANCELED; unrelated facts persist | leases revoked before replacement work runs | already completed effects stay journaled; no pretend rollback |
| 17 | reconnect during background process | world/epoch policy decides rebind vs terminal; never blind resume | old leases/tokens revoked | fresh world identity + process observation required |
| 18 | irreversible DIG/PLACE after cancellation races dispatch | cancellation invalidates unused token; already-dispatched effect is journaled | no new effect after revoke | fact revision + token expiry distinguish accepted/rejected commit |
| 19 | another actor satisfies active Transition predicate | Transition may VERIFY SUCCESS with external credit | its own leases are released | same predicate truth, `causalCredit=external` |
| 20 | two Transitions target same predicate | both may remain live until same fact closes them; scheduler should avoid redundant expensive work when observed | independent compatible claims only | one verified fact, per-Transition causal links/credit |
| 21 | generation hot reload while Reach suspended | same semantic Transition may rebind after fresh validation | no inherited old generation lease | new generation id + fresh fact revision; same contract hash |
| 22 | dimension transfer during portal entry | old-dimension contracts suspend/terminalize according to contract; no old lease crosses boundary | revoke old resource/effect authority before new-dimension grant | dimension fact is explicit transfer evidence |
| 23 | Search rotates camera during pathfinder Reach | if orientation is bundled with locomotion, Search must not actively rotate; remains passive or blocks | conservative body bundle wins until separability proven | adapter audit must show zero hidden look mutation |
| 24 | furnace disappears while Smelt OBSERVING | Smelt wakes -> BLOCKED/INFEASIBLE or substitutes station if contract allows | no station lease was held while absent | fresh block/station fact; no phantom success |
| 25 | dropped target item expires while Acquisition suspended | Acquisition revalidates witness and may Search/substitute within same predicate | no stale entity interaction lease | entity/item absence fact; budget/deadline still accounted |
| 26 | repeated equal-priority body contenders every tick | residency/hysteresis keeps current owner until material change or bound | no alternating dual control | journal shows bounded preemption frequency |
| 27 | server lag yields late action acknowledgement after fact revision advanced | late acknowledgement is evidence only and cannot authorize old token/decision | no stale dispatch | fresh postcondition VERIFY controls success |
| 28 | death during multi-Transition set | body/inventory-dependent Transitions suspend/terminalize/revalidate by family; passive durable facts survive | all body/inventory leases revoked | death/body/inventory/world facts define recovery boundary |

## Model-backed scenarios

The pure model currently exercises scenarios 1, 2, 3, 4, 7, 8, 11, 13, 15, 18 (token race abstraction), 19, and 21. The remaining scenarios are migration gates because they depend on Mineflayer adapter/window/entity/world behavior.

## Falsification triggers

Any scenario that requires silent shared mutation, an unbounded non-preemptible resource, model-owned truth, hidden target substitution outside the effect envelope, or action-return-as-success is evidence against the current V4.1.1 contract and must be escalated to architecture review rather than patched locally.

## V4.1.1 hardening scenarios

29. **Parent/child resource collision** — `body` WRITE vs `body.locomotion` WRITE. Expected: overlap conflict; second bundle is not granted.
30. **Mission revision changes while suspended** — old Mission rev cannot resume. Expected: typed current `ResumeProof`; complete revalidation required.
31. **Fact revision regression with apparently fresh proof** — proof fact rev < suspended binding. Expected: `STALE_REBIND`; no boolean override exists.
32. **Registry revision regression** — ATR changed then stale proof arrives. Expected: resume rejected before lease acquisition.
33. **Same predicate, wrong contract** — another contract verifies the same predicate. Expected: no SUCCESS because transition/contract binding mismatches.
34. **Stale VERIFY evidence** — fact is true but evidence binding is not current. Expected: no SUCCESS.
35. **Preempt request before safe yield** — high-priority contender requests resource. Expected: victim retains lease until controller ACK; requester gets nothing.
36. **Non-preemptible inventory critical section** — Viability waits on bounded click sequence. Expected: priority inheritance, bounded wait, safe yield; timeout is typed fault, not forced revoke.
37. **Jev decision binding differs from frame** — decision and live happen to match but request frame was older. Expected: stale drop.
38. **Effect token after lease/generation/permit change** — token otherwise unexpired. Expected: adapter refuses dispatch.
39. **ATR semantic identity mutation attempt** — mutator changes contract hash. Expected: throw/fail closed; registry does not launder identity.
40. **Resume proof newer than state but older than live ATR** — Expected: reject; proof must equal live binding exactly.
41. **Safe-yield arrives one tick after non-preemptible bound** — Expected: `DEADLINE_EXPIRED`; record fault, do not silently grant.
42. **Preemption transaction given wrong victim state** — Expected: fail closed before suspension.
43. **Duplicate ATR initialization id with different contractHash** — Expected: registry construction fails; identity cannot be laundered before first mutation.
