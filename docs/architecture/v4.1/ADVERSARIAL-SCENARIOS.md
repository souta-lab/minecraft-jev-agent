# V4.1 Counterexample / Adversarial Scenario Suite

> **PERMANENT ARCHITECTURE LOCK:** V4.1.2 is permanently locked (`AGENTS.md` PERMANENT ARCHITECTURE LOCK; checkpoint `092a5b38`). "Counterexample" here means *implementation/mechanics* counterexamples used to falsify and fix defects inside the constitution — never grounds for reopening or replacing the architecture, which no future finding can authorize.

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

Any scenario that requires silent shared mutation, an unbounded non-preemptible resource, model-owned truth, hidden target substitution outside the effect envelope, or action-return-as-success is evidence against the current V4.1.2 contract and must be escalated to architecture review rather than patched locally.

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

## V4.1.2 authority-kernel adversarial scenarios

44. **TERMINAL tries to reacquire** — Expected: lifecycle gate rejects before lease creation.
45. **SUSPENDED caller invokes acquire directly** — Expected: only RUNNABLE can acquire; current live revalidation must move it through resume first.
46. **ACTIVE pause during bounded window click** — Expected: scheduler PAUSE is rejected `SAFE_YIELD_REQUIRED`; controller ACK completes pause without force revoke.
47. **Deadline expires inside bounded critical section** — Expected: outcome is pending, lease remains, new effects are blocked, later safe yield terminalizes while preserving deadline evidence.
48. **VERIFY becomes true inside bounded critical section** — Expected: SUCCESS is pending rather than force-revoking; safe yield completes SUCCESS.
49. **Mission removes predicate inside bounded critical section** — Expected: MISSION_SUPERSEDED is pending; no new work; safe yield completes terminalization.
50. **Old preemption after victim regrant** — Expected: exact lease incarnation mismatch makes transaction stale; new lease is untouched.
51. **Two victims needed by one requester, one not ready** — Expected: no victim is suspended and no requester lease is granted until all victims ACK.
52. **Two non-preemptible conflicts with 10ms and 25ms bounds** — Expected: 10ms is the governing hard-yield deadline.
53. **Late safe yield after bound** — Expected: recovery proceeds only after ACK; `deadlineViolated=true` remains journal evidence.
54. **Stale preemption still claims priority inheritance** — Expected: currentness check removes inherited priority/execution preference.
55. **Same effect commit dispatched twice** — Expected: only first transition from ISSUED to DISPATCHING succeeds; maxCount is already charged.
56. **Crash after irreversible dispatch** — Expected: UNKNOWN may persist; no automatic replay/reissue until trusted world reconciliation.
57. **Caller supplies true verifier object/booleans** — Expected: no authority without runtime-branded registered verifier capability and accepted facts.
58. **Duplicate predicate true+false in one verifier snapshot** — Expected: whole snapshot rejected; factRevision unchanged.
59. **Old witness proof after a newer revision** — Expected: witness revision regression rejected; no resume authority gained.
60. **Forged/tampered replay journal** — Expected: regenerated full event mismatch rejects replay; audit replay result cannot be used as live KernelState.
61. **Trusted restart recovery** — Expected: only JOURNAL recovery capability may rebrand a fully replayed, invariant-valid snapshot.
62. **Jev ranks unknown id or tactic** — Expected: ungrounded output rejected even if frame hash/binding otherwise current.
63. **Jev frame survives witness/resource/lifecycle mutation** — Expected: it does not; relevant decision digests change and old frame is stale.
64. **Unknown mutating ResourceId domain from plugin** — Expected: canonical resource construction fails closed until adapter canonicalizer maps it to a reviewed domain/path/instance.
65. **Effect permit asks for resource not in contract claims** — Expected: contract construction rejects; permit cannot expand authority at runtime.
66. **APPEND duplicate id with changed payload** — Expected: fail closed; same id/same payload is the only duplicate suppression path.
67. **Generation changes while controller holds authority** — Expected: semantic contract remains stored; leases/effect authority become invalid and old controller capability cannot act.
68. **World epoch/dimension changes** — Expected: all old world-scoped mechanical/semantic evidence becomes invalid; old Transition runtime cannot resume blindly.

## V4.1.2 five-pass closure scenarios

69. **Forged VERIFY capability with valid current facts** — Expected: `UNTRUSTED_VERIFIER_CAPABILITY`; current truth does not authorize an arbitrary caller to close the Transition or choose causal credit.
70. **VERIFY uses a registered verifier id with the wrong contract version** — Expected: `VERIFICATION_DEFINITION_MISMATCH`; no SUCCESS.
71. **Victim ACKs preemption then tries to issue an effect before commit** — Expected: unused effect commits are revoked at ACK and all new effect/debit/APPEND work is rejected until the atomic ownership transfer completes.
72. **Victim claims safe yield while irreversible dispatch is still in flight** — Expected: ACK rejected `EFFECT_DISPATCH_IN_FLIGHT`; ownership is not transferred around an ambiguous side effect.
73. **Highly aged/max-urgency MISSION competes with zero-urgency MISSION_CRITICAL** — Expected: MISSION_CRITICAL remains higher; class order cannot be crossed.
74. **Same-class peers differ only in urgency** — Expected: bounded canonical urgency orders them deterministically.
75. **Same-class/urgency/age peers have different deadlines** — Expected: earlier deadline receives only a bounded tie-break; no class escalation.
76. **Current trusted but unrelated fact is supplied to effect reconciliation** — Expected: `EFFECT_CAUSAL_EVIDENCE_REQUIRED`; the fact must carry the exact effect commit id.
77. **Effect-causal fact references nonexistent/old-world commit** — Expected: snapshot rejected before it can become reconciliation evidence.
78. **Forged progress evaluator reports progress** — Expected: `UNTRUSTED_PROGRESS_CAPABILITY`; no progress revision change.
79. **Progress revision repeats/skips/regresses** — Expected: fail closed; only exact next revision is accepted.
80. **Old Jev frame after only progress changed** — Expected: binding/epoch may still match, but live frame re-derivation returns `STALE_FRAME_STATE`.
81. **Old Jev frame after only effect commit state changed** — Expected: `STALE_FRAME_STATE`; effect authority is part of decision context.
82. **Production `bot.attack` bypasses transition adapter** — Expected migration gate failure until attack is explicit in ActuationPort/resident guard and bound to attack/entity authority.
83. **Production `bot.openFurnace` bypasses transition adapter** — Expected migration gate failure until station/window/interaction authority is explicit.
84. **Audit-replayed snapshot is passed back as live KernelState** — Expected: `UNTRUSTED_KERNEL_STATE`; only trusted journal recovery may rebrand invariant-valid replay.
