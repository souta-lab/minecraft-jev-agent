# Nether survival: keep a usable weapon, keep armour on, eat when hurt, and be honest about a damage race

> **Historical lane report (2026-09-22).** Dated live-log investigation retained as evidence, not as current instruction.

Lane: `task/nether-survival`. Owning layer: the **candidate layer** (`jev-agent/src/candidates.ts`
enumeration + the contact threat envelope), the **gear-truth module** (`jev-agent/src/gearPlan.ts`),
the **executor**'s equip action (`jev-agent/src/executor.ts`), the **guard** that admits an EQUIP
(`jev-agent/src/policy.ts`), and the **survival evidence/control action** in
`jev-agent/src/threat.ts` mirrored by `jev-agent/src/controller-legacy.ts`.

Primary evidence: the live log
`/home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/buddy.log` (read twice while this lane ran: 553 301
lines at 2026-09-22T12:10Z, 1 335 209 lines at 2026-09-22T17:24Z — every number below carries its
snapshot) and the generation-local sink
`/home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/logs/jev/run.jsonl` (124 `EQUIP_WEAPON`, 2 `EQUIP_ARMOR`).

---

## 1. Measured death profile

**Snapshot boundary (the log is LIVE and grew while this lane ran).** All numbers below come from
ONE read of `/home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/buddy.log` at
`2026-09-21T08:06:00.437Z → 2026-09-22T17:24:10.703Z`, **1 335 209 lines**. An earlier pass during
this lane saw the same file at 553 301 lines / 104 `DEATH` lines / 98 real; the profile grew as the
resident kept dying, so any number quoted without its snapshot boundary is not reproducible. (The
fatal-window line numbers used in §1.3 are stable: they are ~463 k, far below either boundary.)

| | at 553 301 lines | at 1 335 209 lines |
| --- | --- | --- |
| `DEATH` lines | 104 | **133** |
| real deaths | 98 | **131** |
| `simulated=true` | 6 | **2** |
| `DEATH_CAUSE` records | 80 | **109** |
| deaths in `minecraft:the_nether` | 53 | **75** |
| deaths in `minecraft:overworld` | 51 | **56** |
| window | 28.07 h | **33.30 h** |
| real deaths / hour | 3.5 | **3.93** |
| overworld→nether expeditions | — | **79** |
| expeditions with ≥1 real death | — | **75 / 79 (95 %)** |
| expeditions with ≥1 **Nether** death | — | **74 / 79 (94 %)** |
| real deaths per expedition (all dimensions) | — | **1.62** |
| Nether deaths per expedition | — | **0.94** |
| max Nether deaths in one expedition | — | 1 |

The per-expedition number is the one that matters for this objective: **94 % of Nether expeditions
lost the body in the Nether at least once**, i.e. this is not an occasional accident but the normal
outcome of entering the dimension.

### 1.1 Who killed the body (`DEATH_CAUSE ... killer=`), at the 1 335 209-line snapshot

```text
Nether:  null 13 | fire 13 | magma_cube 11 | ender_dragon 11 (SUMMONED) | skeleton 6 | lava 6
         warden 2 (SUMMONED) | wither_skeleton 2 | ghast 2 | s0u7a 2 (PLAYER) | Hasilan 2 (PLAYER)
         blaze 1 | vex 1
Overworld: s0u7a 10 (PLAYER) | null 8 | Hasilan 7 (PLAYER) | fire 6 | warden 3 (SUMMONED)
         endermite 2 | zombie_villager 1
```

Grouped:

| class | count | detail |
| --- | --- | --- |
| **player-inflicted** | **21** | `s0u7a` 12 (10 overworld + 2 Nether), `Hasilan` 9 (7 + 2) — the operator's bow/crossbow from creative |
| operator-summoned | 16 | `ender_dragon` 11 (a dragon cannot spawn in the Nether) + `warden` 5 |
| **mob-inflicted in the Nether** | **23** | `magma_cube` 11, `skeleton` 6, `wither_skeleton` 2, `ghast` 2, `blaze` 1, `vex` 1 |
| environmental | 25 | `fire` 19, `lava` 6 |
| unattributed (`killer=null`) | 21 | 13 Nether + 8 overworld |
| mob, overworld | 3 | `endermite` 2, `zombie_villager` 1 |

So the Nether deaths are **not** mostly the operator: `magma_cube` is the single largest Nether
killer and the fatal "closest approach" death was one of them.

### 1.2 What the body was doing, what it held

`weapon=` on the `THREAT_NEARBY` lines (the item the body actually met the threat with):

```text
diamond_sword   101
stone_pickaxe    79
cobblestone      70
dirt              1
```

150 of 305 threat observations were met with **a non-weapon in hand** (at the 553 301-line
snapshot). `SURVIVAL_REGROUND`, `RETREAT` and `MOVE` dominate the actions around the Nether deaths.

### 1.3 The fatal window (`buddy.log:463026` → `463109`), file:line

```text
463026 10:49:55.909  THREAT_NEARBY threat=magma_cube threatId=45891 distance=2.98 contact=true
                     danger=true entryReason=contact weapon=stone_pickaxe food=20 health=16.704
463027 10:49:56.684  REACHABILITY candidate=ATTACK:e45891 kind=ATTACK reachable=true   <- ATTACK WAS offered
463054 10:49:57.157  ACTION_PREEMPT chosenId=RETREAT:p11_59_4                          <- Jev chose RETREAT
463055 10:49:57.527  SURVIVAL_REGROUND from=RETREAT:p11_59_4 to=RETREAT:p13_59_4
                     reason=same_threat_keep_distance distance=2.98 contact=true health=16.704
463066 10:49:57.910  THREAT_NEARBY ... distance=2.06 contact=true weapon=stone_pickaxe health=8.316
463098 10:49:59.570  SURVIVAL_REGROUND ... to=RETREAT:p13_58_-8 reason=same_threat_keep_distance health=8.316
463109 10:49:59.585  DEATH pos=19.8,59.3,-1.7 dimension=minecraft:the_nether
                     lostInventory={...,"stone_pickaxe":1,"diamond_sword":1} itemsLost=964
                     capturedBeforeDrop=true cause=damage healthBefore=2.557
463110               DEATH_CAUSE dimension=the_nether killer=magma_cube killerEvidence=mineflayer
                     killerId=45891 threatDistance=2.06 contact=true health=8.316 food=20
```

Health trajectory: **16.704 → 8.316 → 2.557 → dead in ~4.0 s**, i.e. two damage steps of ~8.4 and
~5.8 HP, while `food=20` (natural regeneration was active and irrelevant), the body executing
`RETREAT` and re-grounding onto cells at the same or a *shorter* distance from the cube
(2.98 m → 2.06 m). **Zero `kind=ATTACK` actions ran** in `462900–463125`; the reachable
`ATTACK:e45891` was on offer the whole time.

### 1.4 The `keepInventory` correction (this changes the whole analysis)

`grep -i keepinventory buddy.log` → **nothing**. The gamerule is never logged, so it must be read
from behaviour, and the behaviour is unambiguous:

```text
463121 10:49:59.613  SPAWN ... health=20 username=AI_Buddy respawn=true
463122 10:50:00.622  LADDER_INVENTORY_SETTLE reason=death readings=11 changed=false empty=false
                     itemCount=27 waitedMs=1007
                     counts={"iron_ingot":2,...,"stone_pickaxe":1,"diamond_sword":1}
463123 10:50:02.095  LADDER_RESET reason=death inventoryBasis=live invEmpty=false rungIndex=14
                     rungId=enter_nether resumeBasis=durable achievedRungId=nether_portal
```

The settled post-respawn read (11 readings over 1007 ms, `changed=false`) still holds all 27 items
including the `diamond_sword`. **`keepInventory` is effectively ON for this world.**

Therefore:

* `DEATH ... lostInventory={...}` is **not** a list of lost items. It is the inventory *at* death
  (`capturedBeforeDrop=true`; `simdeath.ts` captures before any toss/clear). The naming is
  misleading and this report reads it as "held at death".
* A `stone_pickaxe` in hand at death **never** means "the sword was destroyed". The sword was in the
  inventory and it survived the respawn. The body **never re-equipped it**.
* After the respawn the next threat was still met with `weapon=stone_pickaxe` (10:51:12), so the
  re-equip gap repeats across the whole expedition.

---

## 2. Why the best weapon was not armed — the first failed boundary (with the evidence-plane correction)

**Correction first, because the naive reading is wrong.** `grep -c EQUIP_WEAPON buddy.log` = **0**,
which looks like "the equip path never ran". It is an evidence-plane artefact: `EQUIP_WEAPON`,
`EQUIP_WEAPON_REFUSED`, `EQUIP_ARMOR`, `EQUIP_ARMOR_REFUSED` and `WEAPON_CHOICE_REQUIRED` were
**not in `MIRRORED_MARKERS`** (`controller-legacy.ts`), so the live sink dropped them. The
generation-local sink shows the truth:

```text
logs/jev/run.jsonl:  124 × EQUIP_WEAPON      (incl. 34 × `EQUIP_WEAPON item=diamond_sword replaced=stone_pickaxe reason=combat`)
                       2 × EQUIP_ARMOR        (`EQUIP_ARMOR slot=legs item=diamond_leggings from=inventory replaced=none`)
                       9 × EQUIP_ARMOR_REFUSED
                       0 × WEAPON_CHOICE_REQUIRED
```

So equip works, armour equip works, and the body *was* armed 124 times — **each time from inside an
ATTACK lease**.

**The boundary:** the only code that ever moves a weapon into the hand is
`equipCombatWeapon`, called from `runAttack` (`executor.ts`, `await this.equipCombatWeapon(...)` at
the top of the ATTACK lease). There was **no candidate kind that could express "arm the best carried
weapon"**: `EQUIP` existed but was armour-only (`guardEquip` and `runEquip` both rejected any slot
outside `head|torso|legs|feet`). Therefore:

```text
"Jev did not choose ATTACK this tick"  ==  "the body stayed disarmed"
```

which is exactly the fatal window: `ATTACK:e45891` reachable and offered, Jev chose `RETREAT` twice,
no lease started, no arm happened, and the damage race was lost with a `stone_pickaxe` while a
`diamond_sword` sat in the inventory. The same coupling explains the other measured shape: the hand
is overwritten by the next tool equip (MINE holds the pickaxe), and re-arming only happens if the
next fight starts with an ATTACK.

Secondary measured defects in the same layer:

* the ATTACK candidate's label/meta reported only the **held** item (`with stone_pickaxe`) while the
  lease would have armed and swung the `diamond_sword` — Jev was shown a weaker fight than the one
  it was choosing;
* `COMBAT_KIT_GAP` claimed a prerequisite that could not close the reported gap:
  `buddy.log:497643 swingDamage=7 armor=0 missing=armor prerequisite=CRAFT:iron_sword` while a
  `diamond_sword` was carried;
* at contact the survival envelope kept only `ATTACK|RETREAT|ESCALATE`
  (`CONTACT_THREAT_KINDS`), i.e. it was **stricter** than the wider danger envelope
  (`THREAT_SURVIVAL_KINDS`, which keeps `EAT` and `EQUIP`) — so eating and arming were erased exactly
  when the body was being hit;
* `survivalControlFallback` needs a `WAIT`/`ESCALATE` in the restricted offer to avoid ending a tick
  with no action, but the contact envelope removes both — the documented measured shape "the fresh
  offer still held a reachable `ATTACK:e23324` … the tick did nothing and the body was killed in the
  same second".

---

## 3. What changed

1. **`gearPlan.ts` — the arm offer (CAN, no ranking).** `weaponArmOffers(held, counts)` returns every
   carried weapon that out-damages the item in hand, **at most one per weapon class**; empty when the
   hand already holds a carried weapon (no churn) or nothing is better. `combatSwingFor(held, counts)`
   mirrors `equipCombatWeapon` decision-for-decision (single class → mechanical best instance; **two
   classes → the lease refuses**, so no swing is claimed), so the ATTACK line cannot describe a fight
   the Skill will not run.
2. **`candidates.ts` — the arm is an action.** `weaponArmCandidates(state, fightOnTheTable)` emits
   `EQUIP:hand:<item>` (kind `EQUIP`, `meta.slot='hand'`, `meta.weaponArm=true`), offered while a
   fight is on the table (a hostile is being answered or an `ATTACK` is enumerated) so a mining body
   never churns its tool. `CONTACT_THREAT_KINDS` gains `EAT` and `EQUIP` (the contact envelope is no
   longer stricter than the danger envelope). The ATTACK candidate now carries `swingItem`,
   `swingDamage` and `armOnAttackFrom` when arming will change the swing, and its label states it.
   `combatKitGap`'s measured prerequisite is gated on the gap the assessment actually reported.
3. **`policy.ts` — `guardEquip` accepts the `hand` destination** (still refuses anything outside
   `hand|head|torso|legs|feet`; the carried-item check is unchanged).
4. **`executor.ts` — `runEquip` gained the `hand` branch** (`runEquipWeapon`): same bounded
   retry, same **effect envelope** (`equipItemTo` → `assertEffect`), same **lease** (`ensureOwned`),
   live post-condition on the main hand, greppable `EQUIP_WEAPON item=… replaced=… reason=combat`,
   and a typed `item_unavailable` — never a substitute.
5. **`threat.ts` — the damage race is typed.** `SURVIVAL_DAMAGE_RACE` carries the grounded
   escape facts (count, how many leave the threat's reach at decision time, best separation gain),
   `damageAgo` (ms since the last landed hit — the observed half of "health is dropping"), and the
   damage **source class** (`mob` / `player` / `environment` / `unattributed`, decided from the
   sensed entity: `username` ⇒ player). `SURVIVAL_ESCAPE_NONE … outcome=CAPABILITY_LOST` is the
   typed statement when no escape cell exists. `assessSurvivalRace` deliberately does **not** claim
   the body gets away: a mob that closes between ticks follows a destination that was outside its
   reach when the tick was decided, which is what the measured `magma_cube` did.
6. **`threat.ts` — never an actionless tick at contact.** `survivalControlFallback` accepts a
   `codeOwnedEscalate` and returns `control_action_escalate_code_owned` when the contact envelope has
   filtered the control kinds out. `ESCALATE` mutates nothing, picks no fight/flight, no target and no
   destination; the controller admits it into the revalidation offer before the guard runs.
7. **`controller-legacy.ts` — evidence plane.** `EQUIP_WEAPON`, `EQUIP_WEAPON_REFUSED`,
   `EQUIP_ARMOR`, `EQUIP_ARMOR_REFUSED`, `WEAPON_CHOICE_REQUIRED`, `SURVIVAL_DAMAGE_RACE` and
   `SURVIVAL_ESCAPE_NONE` are now in `MIRRORED_MARKERS`, and `logSurvivalRace` mirrors the race fact
   from the restricted offer (deduped on the line, so it re-logs per landed hit).

Declared shared files touched: `jev-agent/src/{candidates,controller-legacy,executor,gearPlan,policy,threat}.ts`.
No mob name is hard-coded in the decision path; the gear module owns what is best from what is held;
no reflex bypasses the effect envelope, the hazard guard or the lease (every equip goes through
`equipItemTo` + `ensureOwned`).

## 4. Markers added

| marker | owner | fields |
| --- | --- | --- |
| `SURVIVAL_DAMAGE_RACE` | `threat.ts` (pure `formatSurvivalDamageRace`), mirrored in `controller-legacy.ts` | `threat threatId distance contact damageAgo source sourceName sourceEvidence health food regenerating weapon swingDamage escapes escapesOutsideReach bestSeparationGain escape reason` |
| `SURVIVAL_ESCAPE_NONE` | same | `threat threatId distance contact source health food weapon reason outcome=CAPABILITY_LOST` |
| `EQUIP_WEAPON` (now mirrored) | `executor.ts` via `formatWeaponEquip` | `item replaced reason=combat` |
| `SURVIVAL_CONTROL_ACTION … reason=control_action_escalate_code_owned` | `controller-legacy.ts` | `from kind outcome to reason threat contact health` |

Every survival action names the fact that justified it and its outcome: the arm candidate carries
`weaponDamage`/`heldDamage`/`weaponClass`/`replaced`, the race line carries the escape facts and the
damage source, and the executor's equip result is a verified post-condition or a typed failure.

## 5. Fixtures

New: `jev-agent/test-nether-survival-gear.mts` (21 cases) — (i1–i5) the measured damage race
(grounded response at contact, typed facts, `outside_reach` vs `inside_reach` vs `none`, the typed
`CAPABILITY_LOST`, the mirroring), (ii1–ii3) the respawn case (arm + armour offered, Jev chooses;
one offer per weapon class; sword-vs-axe never ranked), (iii1–iii3) healthy-body no-churn (no offer
when the hand already holds the carried weapon, no offer with no fight on the table, and the ATTACK
line states the swing the lease will run), (iv1–iv3) eat when hurt / typed `FOOD_SOURCE_NONE` when
there is no food / no false EAT at a full hunger bar, (v1–v3) player vs mob vs environment vs
unattributed damage separated, (vii1–vii2) the code-owned control action at contact, and (ii4) the guard admits the `hand`
destination while still refusing a foreign slot.

Extended: `jev-agent/test-equip-affordance.mts` (+4 cases → 20/20) — the arm candidate is offered,
executed through the real `Executor` (equips the **named** weapon, verifies the live main hand,
emits `EQUIP_WEAPON`), the item-left-inventory case is a typed loss with no substitute, and no offer
when the hand already holds the best carried weapon.

## 6. Honest residual

* **The `outside_reach` escape fact is not a prediction.** `SURVIVAL_DAMAGE_RACE escape=outside_reach`
  means the destination left the threat's reach *at decision time*; the measured `magma_cube` closed
  the gap between ticks and killed the body anyway. A closing-rate model would be a guess, so it is
  not claimed. A live run is still required to show a body that arms/escapes and survives.
* **No armour is crafted anywhere.** `armorEquipOffers` equips carried armour (it is exercised live:
  `EQUIP_ARMOR slot=legs item=diamond_leggings`), but in the fatal window the body carried **no
  armour at all** (`armor=0/4`), so "keep armour on" is only satisfied when armour exists. The
  armour gap is now stated honestly (`missing=[armor] prerequisite=none`) instead of pointing at a
  sword craft; an armour craft route is not implemented and is not in this lane.
  **CLOSED 2026-09-22 by lane `task/armour-route`** (this bullet is kept as the measured state at
  38cbb22, which the armour lane started from). The route now exists as a capability class:
  `candidates.ts#armorCraftCandidates` offers `CRAFT:<any armour piece the data version can produce>`
  through the same `planNextCraftStep`/`craftPlanStepCandidate` machinery every other craft uses,
  `armorCraftTargets` (gearPlan.ts) supplies slot/tier truth for every material (leather, golden,
  iron, diamond, turtle scutes - no iron-specific branch), the ordinary EQUIP affordance wears the
  piece on the following tick, and `COMBAT_KIT_GAP`'s armour half now names that craft as its
  `prerequisite`. When nothing is affordable the tick emits
  `ARMOR_CRAFT_REFUSED slot=torso item=iron_chestplate material=iron_ingot need=8 have=2 shortfall=6`
  instead of silence, and when it IS affordable it emits `ARMOR_CRAFT ...`. Fixtures:
  `jev-agent/test-armour-route.mts`, including a byte-identical control for this lane's weapon-arm
  candidate (same sha256 as 38cbb22).
* **Arming is gated to "a fight is on the table"** (a threat envelope is active or an ATTACK is
  enumerated). A body mining with a pickaxe and carrying a sword is deliberately not offered the
  swap, to avoid churning the tool; whether a permanently-armed policy is better is a live question.
* **The unseen-attacker envelope still keeps only locomotion.** `restrictCandidatesDuringUnseenAttacker`
  removes stationary kinds, so while the operator's bow lands hits from outside perception the arm
  offer survives (`EQUIP` is not stationary) but the race evidence is only emitted at contact.
* **`buddy.log` alone is not sufficient evidence for the equip plane** — that is now fixed for the
  five EQUIP markers, but the general lesson stands: any marker missing from `MIRRORED_MARKERS` is
  invisible in the live log while being emitted (this lane's first conclusion was wrong because of it).
* **Corpus commands of the form `bun test ./test-x.mts` run 0 tests and exit 0** (Bun requires
  `.test`/`.spec` in the filename), so any acceptance evidence quoted from that form is a false
  green. The correct form is `bun ./test-x.mts` (or `bun test ./bun-tests`). This lane's battery uses
  the correct form; several `docs/development/REGRESSION-CORPUS.md` rows do not, which is a repo-wide evidence-integrity
  item outside this lane's file ownership.
* **No live acceptance run** was performed from this lane (resident control is H4): the evidence is
  the replayed measurement plus deterministic fixtures.

---

## 7. Verification (all on the committed tree unless noted)

```text
bun run typecheck                                    clean (jev-agent + buddy-driver)
bun jev-agent/test-mob-survival.mts                   23/23
bun jev-agent/test-nether-survival.mts                23/23
bun jev-agent/test-nether-survival-gear.mts           21/21   (new)
bun jev-agent/test-env-hazard.mts                     all passed
bun jev-agent/test-waypoint-hazard-guard.mts          all passed
bun jev-agent/test-threat-response.mts                9/9
bun jev-agent/test-threat-response-grounding.mts      28/28
bun jev-agent/test-combat-closure.mts                 26/26
bun jev-agent/test-candidate-policy.mts               12/12
bun jev-agent/test-equip-affordance.mts               20/20   (16 + 4 new)
bun test ./bun-tests                                  136 pass / 0 fail
bun run bun-residue-check                             PASS
bun run contract-docs-check                           5/5
```

Whole-corpus sweep, every `jev-agent/test-*.mts` + `buddy-driver/test-*.mts` run as
`bun <file>` in this worktree and in a pristine checkout of the same base (`b5325b3`):

```text
diff pristine-vs-worktree:
  jev-agent/test-equip-affordance.mts   16/16  ->  20/20     (the 4 added cases)
  jev-agent/test-nether-survival-gear.mts   absent -> 21/21  (new file)
  (nothing else changed)
known-red, IDENTICAL in pristine and worktree (pre-existing, no new regression):
  jev-agent/test-audit.mts
  jev-agent/test-pillar-takeoff-evidence.mts
  buddy-driver/test-dimension-observer.mts
```

Base: `b5325b3` (latest `origin/main` at the time of the rebase). Branch
`task/nether-survival`, commits `8d86862` (implementation + fixtures + report +
corpus rows) and `1136173` (guard-admission fixture), pushed.
