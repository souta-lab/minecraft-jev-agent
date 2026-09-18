# M2 heuristic audit — authority classification and fixes

Base: `f834867` (`merge: task/m2-headroom`), 2026-09-18. Scope: the heuristics
added on the M2 critical path (git log since `07465cf`) in

- `jev-agent/src/pillarJump.ts`
- `jev-agent/src/verticalPlan.ts`
- `jev-agent/src/executor.ts` (pillar/hop/headroom/climb code)
- `jev-agent/src/controller.ts` (stall/abandon/escalation branches)
- `jev-agent/src/candidates.ts`
- `jev-agent/src/moveFailMemory.ts`
- `jev-agent/src/prereqOption.ts`

plus the deterministic truth owners the above depend on (`state.ts`,
`gameData.ts`, `actionPostcondition.ts`), cited where the audit crosses them.

## Authority rule applied (owner directive + AGENTS.md §8)

| Class | Owner | Heuristic allowed? |
|---|---|---|
| Minecraft mechanics truth (obsidian needs a diamond pickaxe), authority boundary, safety, success/verification (`verified=false && progress=0` is NOT success), precondition/postcondition | deterministic code | NO — a heuristic deciding these is a DEFECT |
| Search order, cost estimation, retry/cooldown/timeout, "which of several valid candidates first" | policy object / Skill | YES, but LOCALIZED and loggable |

A localized heuristic must be able to log `chosen`, `score`, `alternatives`,
`reason`, so Jev/LLM/learned value functions can replace it later.

## Classification table

Line numbers are the audit baseline (`f834867`).

### pillarJump.ts

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `TAKEOFF_RISE = 0.02` | pillarJump.ts:40 | SUCCESS (verification predicate) | OK-localized | pure, fixed threshold; `jumpWithGroundCorrection` returns `airborne:false` unless velocity/position prove takeoff (pillarJump.ts:121); pinned by test-pillar-jump |
| `PILLAR_TAKEOFF_BUDGET_MS = 600` | pillarJump.ts:43 | TIMEOUT | OK-localized | injected `deps.budgetMs`, single bounded wait (pillarJump.ts:115-126) |
| `PILLAR_TAKEOFF_POLL_MS = 15` | pillarJump.ts:46 | TIMEOUT | OK-localized | injected `deps.pollMs`, no semantic authority |
| `correctStandingOnGround` / `installGroundCorrection` | pillarJump.ts:55,66 | TRUTH (physics workaround) | OK-localized | deterministic block-grid patch; documented Leaf 26.1 missing collision shapes |

### verticalPlan.ts

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `VERTICAL_GAP = 1` | verticalPlan.ts:21 | TRUTH (1-block drop is walkable) | OK-localized | deterministic rule; a drop ≤1 block needs no vertical leg (verticalPlan.ts:441) |
| `PILLAR_UP_STEP_CAP = 24` | verticalPlan.ts:36 | COST (bounded search) | OK-but-implicit → PillarSearchPolicy | module constant consumed by `planUpward` (verticalPlan.ts:407); chosen `steps` is carried in the plan but no alternatives/reason are emitted |
| `ASCENT_PROGRESS_EPSILON = 0.9` | verticalPlan.ts:44 | SUCCESS/progress | OK-localized | default parameter of pure `evaluateRetrievalProgress` (verticalPlan.ts:521), caller-injectable; counts progress, never declares success |
| `PILLAR_PLACE_PRIORITY` + `selectPlaceableBlock` | verticalPlan.ts:51,70 | SEARCH ("which valid block first") | OK-but-implicit → PillarSearchPolicy | first-owned-name wins; chosen is visible only via candidate meta, no score/alternatives/reason |
| `evaluatePillarStep` | verticalPlan.ts:88 | TRUTH/SAFETY gate | OK-localized | pure deterministic refusal ladder (`reached/no_placeable/unsafe_column/no_footing/no_headroom`) |
| `resolvePillarStep` | verticalPlan.ts:125 | TRUTH (footing) | OK-localized | pure contiguous feet/feet-1 scan |
| `classifyHeadroomBlocker` | verticalPlan.ts:191 | TRUTH/SAFETY | OK-localized | pure classification; `diggable`, `toolOk`, `fluidOrHazard`, `floodRisk` are measured inputs; refusal carries cell+name+cause |
| `selectPillarFallbackColumn` | verticalPlan.ts:224 | SEARCH | OK-but-implicit → PillarSearchPolicy | score `dy*100+horizontal` (verticalPlan.ts:234); returns only the cell, drops the probe ranking |
| `pillarColumnUnsafeFromBlocks` | verticalPlan.ts:274 | SAFETY | OK-localized | pure hazard scan of the bot column |
| `RETRIEVAL_STALL_TICKS_DEFAULT = 40` | verticalPlan.ts:292 | TIMEOUT | OK-localized | env-overridable pure resolver, no truth authority |
| `selectUpStep` scoring | verticalPlan.ts:372 | SEARCH/COST | OK-localized | bounded search inside the vertical planner module; chosen cut fully visible in candidate meta (`upDir/upDig*/upStep*`) |
| `planVerticalApproach` | verticalPlan.ts:425 | SEARCH | OK-localized | pure bounded-search module; deterministic preference order reuse-tunnel > grounded up-cut > pillar |
| `evaluateRetrievalProgress` | verticalPlan.ts:512 | SUCCESS/progress | OK-localized | pure; stall re-arms on distance OR altitude progress; never converts stall into success |
| `planRetrievalEscalation` | verticalPlan.ts:566 | SEARCH | OK-localized | pure nearest-known-resource / branch-mine choice; caller logs `RETRIEVAL_ESCALATION kind=...` |

### executor.ts

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `PILLAR_APEX_BUDGET_MS = 700` | executor.ts:230 | TIMEOUT | OK-localized | single bounded wait; timeout logs and places while airborne |
| `PILLAR_LANDING_BUDGET_MS = 2000` | executor.ts:232 | TIMEOUT | OK-localized | single bounded landing wait (executor.ts:1501) |
| `MAX_PILLAR_RELOCATIONS = 2` | executor.ts:239 | RETRY | OK-but-implicit → PillarSearchPolicy | bound + refused-column set (executor.ts:1255-1257); `PILLAR_RELOCATE` logs from/to/obstacle but no alternatives/reason |
| `headroomSufficient` | executor.ts:264 | TRUTH | OK-localized | 2-cell clearance, deterministic |
| `VERTICAL_HOP_RISE_MS = 180` / `VERTICAL_HOP_PUSH_MS = 260` | executor.ts:274,275 | TIMEOUT (movement recipe) | OK-but-implicit → HopPolicy | harness-measured timings; used once at executor.ts:1801-1804; no structured decision line |
| `planClimbManeuver` | executor.ts:301 | SEARCH/mechanics | OK-localized | pure branch on contact/onGround; pinned by test-pit-escape |
| `hopHoldsForward` | executor.ts:317 | TRUTH (server packet rule) | OK-localized | deterministic pure function with live A/B evidence in the comment; pinned by test-pit-escape |
| `evaluateHop` | executor.ts:334 | SUCCESS/verification | OK-localized | pure measured-rise predicate; emits `JUMP_ESCAPE` only on real clearance |
| `clearPillarHeadroom` attempt bound `< 2` | executor.ts:1364 | RETRY | OK-but-implicit → PillarSearchPolicy | inline literal; no policy surface |
| climb-chunk early return `blockRemoved:true` | executor.ts:1051-1068 | TRUTH/SUCCESS flag | **VIOLATION (V2)** | a climb that removed no block is reported as `blockRemoved` and the controller's success branch keys on it (controller.ts:1951); see below |
| `findPillarFallbackColumn` | executor.ts:1431 | SEARCH | OK-but-implicit → PillarSearchPolicy | probes 8 neighbours in a fixed order, delegates the choice to `selectPillarFallbackColumn` |
| `UNBREAKABLE.has(upper.name)` | executor.ts:2615 | TRUTH | **VIOLATION (V1)** | hardcoded set at state.ts:799 marks obsidian unbreakable although minecraft-data marks it `diggable:true` with diamond/netherite harvest tools; see below |

### controller.ts

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `WAIT_REPLAN_LIMIT = 4` | controller.ts:372 | RETRY | OK-localized | consumed by pure `evaluateWaitWedge` (controller.ts:453) |
| `RETRIEVAL_STALL_TICKS` | controller.ts:374 | TIMEOUT | OK-localized | env resolver; drives escalation only |
| `DESCEND_STALL_TICKS` / `DESCEND_NO_CANDIDATE_TICKS` | controller.ts:376-378 | TIMEOUT | OK-localized | env resolvers; escalation only |
| `RETRIEVAL_PROGRESS_EPSILON = 0.5` | controller.ts:380 | SUCCESS/progress | OK-localized | passed into pure `evaluateRetrievalProgress`; no success authority |
| `MOVE_FAILMEM_LIMIT/COOLDOWN/MAX_ENTRIES` | controller.ts:382-386 | RETRY/cooldown | OK-localized | injected into `MoveFailMemory` (controller.ts:648); memory logs `MOVE_FAILMEM` / `MOVE_TARGET_SKIPPED` / `MOVE_FAILMEM_RESET` |
| `OSCILLATION_REPEAT_LOG_MS = 5000` | controller.ts:388 | log throttle | OK-localized | diagnostic only |
| `classifyMoveOutcome` | controller.ts:419 | SUCCESS | OK-localized | deterministic: unverified is never an arrival; `verified=false` keeps charging failure memory |
| `evaluateWaitWedge` | controller.ts:453 | RETRY | OK-localized | pure |
| `observeRetrievalStall` altitude epsilon | controller.ts:2830-2852 | SUCCESS/progress | OK-localized | pure decision consumed; altitude only re-arms the progress clock |
| `onRetrievalStall` / `onUnverifiedAction` / `checkWedge` | controller.ts:2949,2037,3024 | RETRY/escalation | OK-localized | deterministic branches with typed markers; no LLM veto |
| `MIRRORED_MARKERS` | controller.ts:477 | observability | extend | new policy markers must be added here to reach buddy.log |

### candidates.ts

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `MOVE_FAILURE_LIMIT = 4` | candidates.ts:103 | RETRY | OK-but-implicit → `CandidateOptions.moveFailureLimit` | four call sites (candidates.ts:308,449,1444,1535,1600); a second retry limit beside `MoveFailMemory`'s 3, not part of the options policy struct |
| `DESCEND_FAILURE_LIMIT = 3` | candidates.ts:104 | RETRY | OK-but-implicit → `CandidateOptions.descendFailureLimit` | candidates.ts:672 |
| placement-spot retry `< 2` | candidates.ts:812-814,845-846,996-998,1034-1036 | RETRY | OK-but-implicit → `CandidateOptions.placeSpotRetryLimit` | four inline literals, including the M2 table-acquisition path |
| `PICKUP_MINE_HORIZONTAL/VERTICAL` | candidates.ts:106-108 | TRUTH (pickup volume) | OK-localized | measured volume constants; deterministic |
| move/tunnel distance caps (`48/24/6`) | candidates.ts:99-102 | COST | OK-localized | all fields of `CandidateOptions` (the generator's policy struct) |
| `eatBelowFood = 18` | candidates.ts:114 | SAFETY policy | OK-localized | `CandidateOptions` field |
| `HAZARD_DANGER_RADIUS = 3` | candidates.ts:139 | SAFETY | OK-localized | deterministic retreat trigger; conservative |
| `hasTool` tier check | candidates.ts:172-184 | TRUTH (mechanics) | OK-localized | ranks from `PICKAXE_RANKS` = `PICKAXE_TIER0` owned by `gameData.ts`; no hardcoded per-block table |

### moveFailMemory.ts

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `DEFAULT_MOVE_FAILURE_LIMIT = 3`, `DEFAULT_MOVE_COOLDOWN_MS = 30000`, `DEFAULT_MOVE_MAX_ENTRIES = 256` | moveFailMemory.ts:72-74 | RETRY/cooldown | OK-localized | `MoveFailMemoryOptions` policy object with clock injection; logs `MOVE_FAILMEM`, `MOVE_TARGET_SKIPPED`, `MOVE_FAILMEM_RESET` |
| `detectOscillation` epsilon/window/minCycles | moveFailMemory.ts:325-328 | RETRY (loop detection) | OK-localized | injectable options, pure function |

### prereqOption.ts

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `PREREQ_STALL_TICKS_DEFAULT = 40` | prereqOption.ts:30 | TIMEOUT | OK-localized | env-overridable pure resolver |
| `PREREQ_COSTS` + `prereqRank` | prereqOption.ts:46,194 | COST/SEARCH | OK-localized | `PrereqDecision` exposes `{chosen, options(cost,reason), line}`; logs `PREREQ_OPTION chosen=... over=[...] reason=...` + `PREREQ_SWITCH` |
| `selectPrereqPath` / `preferPrereqPath` | prereqOption.ts:240,258 | SEARCH | OK-localized | pure inventory-first rank guard (#78) |
| `RETRIEVE_UNVERIFIED_LIMIT = 3` + `evaluateRetrieveAbandon` | prereqOption.ts:270,288 | RETRY / SUCCESS | OK-localized | `verified=true progress=0` does not re-arm; abandon logs `ABANDON_REASON=retrieve_unverified` |
| `planPrereqOptions` | prereqOption.ts:372 | SEARCH/COST | OK-localized | this module IS the `PrereqResolver`: all alternatives kept with rejection reasons |
| `evaluatePrereqStall` | prereqOption.ts:421 | TIMEOUT | OK-localized | pure |

### Deterministic truth owners (supporting)

| Heuristic | file:line | Category | Verdict | Evidence |
|---|---|---|---|---|
| `PICKAXE_TIER0` + `resolveHarvest` | gameData.ts:52,119 | TRUTH | OK-localized | derived from minecraft-data `harvestTools`; tier ORDER is the irreducible wiki-cited game rule |
| `FUEL_BURN_TICKS` / `SMELT_INPUT` | gameData.ts:367,379 | TRUTH | OK-localized | not in minecraft-data@3.116.0; explicit single owner, pinned by test-game-data |
| `UNBREAKABLE` | state.ts:799 | TRUTH | **VIOLATION (V1)** | see below |

## Violations

### V1 — `UNBREAKABLE` overrides minecraft-data truth (obsidian)

`state.ts:799` declares
`new Set(['bedrock','barrier','end_portal','end_portal_frame','nether_portal','obsidian'])`.
minecraft-data (1.21.11, the live Leaf version) says:

| block | diggable | hardness | harvestTools |
|---|---|---|---|
| bedrock/barrier/end_portal/end_portal_frame/nether_portal | false | -1 | — |
| obsidian | **true** | 50 | diamond_pickaxe + netherite_pickaxe |

The five true unbreakables are already excluded by `block.diggable === false`
(the predicate the same expressions already test), so the only effect of the set
is to overrule the data for **obsidian**: descent steps, step cuts, headroom
cuts and executor approach cuts refuse an obsidian route even when the bot holds
the required diamond pickaxe. That is a heuristic deciding Minecraft mechanics
truth, and it contradicts `gameData.resolveHarvest` (which correctly reports
`pickaxe` rank 4).

Fix: delete the set; rely on the registry `diggable` flag as the deterministic
"can this block ever be broken" predicate. Tool adequacy stays where it already
lives (`hasTool` / `selectDigTool`), so an obsidian step is only offered when
the diamond pickaxe is actually held.

Regression test: `test-minecraft-truth.mts` — registry truth for obsidian
(diggable, diamond rank) plus the extracted pure predicate
`isBreakableSolidBlock`; a synthetic obsidian probe is accepted and a bedrock
probe is refused.

### V2 — climb chunk falsifies `blockRemoved` to route the success branch

`executor.ts:1051-1068` returns `verified: true, blockRemoved: true` for a
bounded PILLAR_UP chunk that gained altitude and removed no block. The
controller's retrieval success decision (`controller.ts:1951`) keys on
`result.blockRemoved || result.itemsGained > 0`, so success evidence is
smuggled through a boolean that literally means "a block was removed" — a truth
flag with a semantics nobody can verify from the name (#63: a marker name is
not evidence of semantics).

The altitude gain itself is deterministic (`verticalStep && climbedTo >
startFloorY`), so the fix is to make the evidence explicit, not to change the
behaviour:

- add `progressed: boolean` to `ExecutionResult` and to
  `ActionOutcomeInput` / `isZeroProgressOutcome`;
- set `blockRemoved: false, progressed: true` for the climb-chunk result;
- extract the controller condition into the deterministic predicate
  `retrievalDurableProgress(result)` = `blockRemoved || itemsGained > 0 ||
  progressed === true` and use it for retire/failure decisions.

Regression test: `test-retrieval-progress.mts` proves a climb chunk
(`blockRemoved=false, progressed=true`) is durable progress, and that an
`unverified` zero-delta result is not.

## OK-but-implicit extractions

| Extraction | Covers | Marker |
|---|---|---|
| `PillarSearchPolicy` (`src/pillarSearch.ts`) | `PILLAR_UP_STEP_CAP`, `MAX_PILLAR_RELOCATIONS`, headroom attempt bound, `PILLAR_PLACE_PRIORITY`/`selectPlaceableBlock`, `selectPillarFallbackColumn` ranking | `PILLAR_SEARCH kind=... chosen=... score=... alternatives=[...] reason=...` |
| `HopPolicy` (`src/hopPolicy.ts`) | `VERTICAL_HOP_RISE_MS`, `VERTICAL_HOP_PUSH_MS`, hold-forward choice | `HOP_PLAN chosen=... rise_ms=... push_ms=... alternatives=[...] reason=...` |
| `CandidateOptions` fields | `MOVE_FAILURE_LIMIT`, `DESCEND_FAILURE_LIMIT`, placement-spot retry `2` | no new marker: the generator's decision surface is the candidate list; limits become explicit policy inputs |

`hopHoldsForward`, `classifyHeadroomBlocker` causes, `ASCENT_PROGRESS_EPSILON`,
the `MoveFailMemory` cooldown and the `PrereqResolver` stay where they are: they
are already deterministic predicates or policy objects with structured logs
(justifications in the table).

## Non-goals

- No behaviour changes beyond V1/V2 and the policy extraction defaults (which
  reproduce the audited constants exactly).
- No new special-case branches for live symptoms.
- `planVerticalApproach` / `selectUpStep` / descend scoring are left as the
  bounded-search module they already are; their chosen plan is visible in
  candidate meta and their rule order is documented. A future change can move
  them behind the same decision-log interface.
