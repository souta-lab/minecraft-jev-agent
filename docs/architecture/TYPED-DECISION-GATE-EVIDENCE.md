# Typed Decision Plane — §18 gate evidence ledger

Evidence ledger for `JEV-BEST-PRACTICES-FOR-MINECRAFT.md` §18 gates A–H. Gates
are checked in order against recorded exact-run evidence; this file is updated
as each gate is proven. V4.1.2 ownership is unchanged throughout: the Typed
Decision Plane still judges WHICH/WHETHER among code-grounded candidates and
owns nothing else.

## Canonical defect (root blocker)

portal-p24 healthy hour (`logs/jev/jev-calls.jsonl`, densest 60 min starting
2026-10-05T03:43:12Z): **1,237 calls, 20.62/min, mean 7,166 input tokens/call**,
mean recorded state 12,041 bytes + 3,463 bytes of questions. Of 1,218
consecutive same-coarse-signature pairs, **1,217 hashed differently** — nearly
every settled microstep opened a fresh WHICH epoch for the identical semantic
situation (`explore:cave` + one MOVE offer). Audit tool: `tools/jev-state-audit.mjs`.

## Gate A — canonical projection audit (PROVEN)

Measured on recorded payloads, no reconstruction. Full corpora:

| corpus | calls | span | calls/min | mean state B | mean Q B | mean input tok | p95 |
|---|---|---|---|---|---|---|---|
| p24 (full) | 4,855 | 543.7 min | 8.93 | 15,467 | 3,598 | 9,216 | 14,086 |
| p24 healthy hour | 1,237 | 60.0 min | 20.62 | 12,041 | 3,463 | 7,166 | 7,412 |
| p23 (full) | 6,802 | 801.8 min | 8.48 | 20,948 | 3,891 | 12,268 | 16,748 |

Duplication (p24): candidate id set identical outer↔semantic in 4,855/4,855
calls; all four `signals.progress` facts duplicated in `semantic.progress` in
4,855/4,855; outer `recentOutcomes` totals 37,353 entries vs the compact tail
already inside `semantic`. Outer-only sections per call (means): signals
3,542B, recentOutcomes 1,774B, nearestEntities 1,417B, candidates 1,330B,
nearestBlocks 1,045B, goalQueue 963B (the raw row embeds a full `optionSpec` —
`rungId` alone accumulated ~130KB), currentOption 456B, self 240B, goal 184B,
inventory 40B. The canonical `semantic` section: 4,263B mean.

Churn drivers inside identical coarse signatures (p24, ordered):
`semantic.recentOutcomes` (2,312), `projectionHash` (2,306), outer `candidates`
(2,295), `semantic.meaningfulDelta` (2,172), `currentOption.runtime.failures`
(2,130), `semantic.candidates` (1,937), `progress.consecutiveFailures` (1,831,
duplicated raw + semantic), `signals.failedCandidates.*`, `nearestEntities`,
`previousDecision.commitmentId`, `semantic.events`, `signals.threat.*` timers.
The projection embeds per-microstep causal memory and raw counters, so the
hash equality the epoch gate keys on is unreachable in steady state.

Disposition of every dropped model-facing block: `self` → banded `safety`;
`signals` → `progress` (+stall), `safety.*Key`, `combat`, `facts`, candidate
`failureBand`; `nearestBlocks`/`nearestEntities` → `sense` + `combat`;
outer `candidates`/`recentOutcomes`/`goalQueue`/`currentOption`/`goal`/
`inventory` → the single `semantic` representations (extended in v7);
`tick`/`recentEvents` → mechanical, never semantic.

## Gate B — canonical compact DecisionState + deterministic compiler (PROVEN)

Implementation (this commit): `jev-semantic-projection` **v7** is the
canonical compact `DecisionState`; `buildJevSemanticProjection` is the
deterministic compiler (pure function of goal/option/world/safety/combat/
progress/queue/sense/events/inventory/candidates/facts inputs). New v7 fields
fold the previously outer-only head-consumed facts: `option` gains the Option
contract (`semanticInstanceId`, `semanticTemplateId`, `intent`, code-rendered
`preconditions`/`success`, `allowedSkills`, `verifiedProgress`, `failures`),
`progress.stall` carries the full #360 recurrence block (`windowSize`,
`distinctStates`, `bodyDecisions`, `semanticDecisions`, `horizon`,
`maxDistinctStates`, `exhausted`, `exhaustedRepeats`), and `queue` carries the
bounded queue head. `authorityState` now returns the projection model view
plus `projectionHash` only — the raw outer blocks remain in the jev-call
journal as audit telemetry and never reach inference. Head instructions were
reduced to direct judgments with the corrected compact field paths
(`progress.stall`, `progress.oscillationsDetected`).

Real-corpus replay of the recorded payloads through the v7 transform
(`tools/jev-state-audit.mjs --compact-sim`):

| corpus | v6 mean | v7 mean | reduction | v7 p50 | v7 p95 |
|---|---|---|---|---|---|
| p24 (full) | 15,467 B | 4,863 B | 68.6% | 4,345 | 7,031 |
| p24 healthy hour | 12,041 B | 4,317 B | 64.1% | 4,295 | 4,369 |
| p23 (full) | 20,948 B | 5,803 B | 72.3% | 5,496 | 8,711 |

Focused proof: `test-decision-state.mts` — compact payload carries exactly the
hashed keys plus `projectionHash`, no outer duplicate sections, Option
contract/stall/queue facts present once, `counts` never model-facing,
deterministic rebuild, mechanical churn (realization ids, failure-kind
respellings) cannot change the hash, semantic changes (goal completion, stall
exhaustion, candidate-set change) still change it, unprojected callers keep
the raw legacy shape. `test-jev-semantic-projection.mts` (20/20),
`test-submersion.mts`, `test-beta-stall-evidence.mts`,
`test-threat-response.mts` (22/22), `test-jev-reach-route-policy.mts` (8/8)
green against v7.

Open work for later gates: the hash still tracks `recentOutcomes`/
`meaningfulDelta`/`previousDecision`/counters, which is correct for §5 hash
semantics but leaves epoch cadence to Gate C (typed `decisionReason`s +
commitment so settled microsteps replay rather than re-ask). Gate E must
confirm decision quality on the compact state (no hidden quality regression
behind the size cut) and Gate F calibrates d1 separately.

## Gate C — semantic decision epochs + controller commitment (PROVEN)

Root defect (this commit's diagnosis): `emitSkillOutcomePacket` closes the
decision epoch on every settled Skill, so the next `decide()` tick saw
`active === null` → `first_decision` → a fresh provider call regardless of
whether the semantic situation changed. The old classifier then anchored on
`active.projectionHash`, which embeds per-microstep outcome memory
(`previousDecision`, `meaningfulDelta`, `recentOutcomes`, raw counters), so
hash equality was unreachable anyway. Result: every settled microstep bought
a call — the p24 1,215-call/hour cadence defect.

Repair (`semantic-projection.ts` / `decision-epochs.ts` / `controller.ts` /
`client.ts` / `authority.ts`):

- The boundary anchor is now the projection the last **ACCEPTED** answer was
  bound to (`host.lastAnsweredProjection`), not the per-settle-closed active
  epoch. Epoch lifecycle, lease binding, and `accept()` gating are unchanged
  — epochs still open/close per decision for provenance and causal isolation.
- `classifySemanticBoundary` compares the anchor against the current
  projection section-by-section and returns typed §7.1 `decisionReason`s:
  `first_decision` / `skill_outcome_boundary` / `world_or_lease_changed` /
  `goal_or_option_changed` / `safety_changed` / `candidate_set_changed` /
  `progress_boundary` / `resource_evidence_changed` / `same_semantic_state`.
  Signed sections: `world`, `goal`, Option **contract** (runtime counters
  excluded), queue identity/health, `safety`, `combat`, `sense.threats`,
  candidate identities (identity + kind + targetName + inReach +
  failureBand, never realization ids/labels/raw counts), banded progress
  (`consecutiveFailures`/`oscillationsDetected` via `failureBandOf`,
  `lastFailureCode`, `escalationRecommended`, `stall.exhausted`/
  `exhaustedRepeats`), and grounded evidence (fact kind+key set, event kind
  set, inventory TYPE presence + truncation). Churn-exempt by construction:
  `previousDecision`, `meaningfulDelta`, `recentOutcomes`, `counts`,
  `sense.blockNames` (terrain scroll — resource arrival surfaces via
  candidates/facts), stack sizes, and Option runtime counters. The walk is
  fail-closed: any model-visible key not explicitly classified is compared
  verbatim and a difference re-queries (`semantic_state_changed`).
- Replay preserves the semantic choice and re-points it at the current
  representative realization (`repointReplay`); the fresh epoch is stamped
  `cacheHit=true` with `reusedFrom` = the ANSWERED epoch
  (`host.lastAnsweredEpoch`), so causal attribution survives the intervening
  settle-close.
- Fail-closed authority: only an **accepted** answer may anchor or replay —
  `lastDecision`/`lastAnsweredProjection`/`lastAnsweredEpoch` are set after
  `accept()`, never on a stale-dropped result; a world/epoch invalidation
  clears the replay source before the boundary signature even runs; a lost
  candidate identity falls through to a real call.
- Provenance: `decisionReason` rides the `JevRequest` into the jev-call
  journal (`authority.decisionReason`) and every boundary/replay logs the
  typed reason via `logBoundary`.

Focused proof: `test-decision-epochs.mts` — drives the real `decide()` and
`emitSkillOutcomePacket()` against a counting stub policy: first unanswered
situation spends one call (`first_decision`); settled `done` + unchanged
semantics replays with zero calls in a new `cacheHit` epoch attributed to
the answered epoch; outcome-memory churn replays; a new semantic candidate
re-queries (`candidate_set_changed`); a mandatory `target_lost` outcome
re-queries (`skill_outcome_boundary`); `none→some` failure-band crossing
re-queries (`progress_boundary`) while `some→some` churn replays; a
mid-flight-invalidated (stale-dropped) result never becomes anchor or replay
source — the previously accepted answer is what replays; a world-epoch change
re-queries (`world_or_lease_changed`).

Regression: `test-jev-semantic-projection.mts` 20/20 (boundary fixtures
migrated to the anchored API), `test-decision-state.mts` PASS,
`test-skill-commitment.mts` 21/21, `test-ascend-exec.mts` 9/9,
`test-movefail-offer-suppression.mts` 16/16, `test-controller-authority.mts`,
`test-controller-transitions.mts` 7/7, `test-observability.mts` 12/12,
`test-provider-recovery.mts`, `test-typed-decision-backend.mts` 27/27,
`test-anti-flap.mts` 15/15, `test-audit.mts` 10/10 (pi instruction phrases
restored), `test-nether-survival.mts` 23/23, `test-threat-response.mts`
22/22, `test-submersion.mts`, `test-gating.mts`/`test-system2-handoff.mts`
(bun:test) 7/7. `tsc --noEmit` clean on `packages/jev-agent`.

Deliberately deferred: explore-MOVE candidate identities still key on the
destination cell when no `approachTarget`/`knownName` anchor exists — a real
frontier-set change SHOULD re-query (§11: distinct alternatives are genuine
choices), so no identity collapse was introduced. If Gate E replay evidence
shows per-leg identity turnover dominates in healthy exploration, the fix is
a semantic destination anchor, not boundary weakening.

## Gate D — concise independent parallel heads (PROVEN)

The head topology was already structurally conformant; this gate formalizes
the contract in `client.ts` (the canonical §6/§18-D table beside
`QUESTION_NAMES`) and proves it mechanically in `test-question-heads.mts`:

- **Batched**: every requested head is answered in ONE `evaluate()` over the
  same canonical DecisionState; no head sees another head's answer.
- **Exact sets per trigger**: `questionSetForTrigger` maps `core`/`stall`
  triggers to `[action, abandon_option]` and `threat` triggers to the pair
  plus `[danger, should_retreat]`; `questionNamesFor` cannot emit a shadow
  name (they are not in `QUESTION_NAMES`, and requesting one yields zero
  questions).
- **`action` (pi, Choice)** is the sole actuation authority — criteria keys
  are exactly the offered grounded ids; the authority kernel throws on a
  choice outside the offer (`Jev invented non-grounded action id`), so a
  head can never fabricate an action.
- **`abandon_option` (beta, Noul)** is WHETHER-only — `abandonRequested` /
  `abandonVerdict` / `applyAbandon` end the active Option under threshold +
  deferral/cooldown gates; beta cannot select WHICH candidate.
- **`danger` (Score) / `should_retreat` (Noul)** are calibration/evidence
  heads on threat triggers: `gateDanger` and the `shouldRetreatFrom` band
  feed the decision journal only — a result carrying only safety answers has
  `decisionIdFrom === null` and authorizes nothing.
- **Route frames** (`vtr-reach-route`) journal `jev-policy-input` per
  question, never `pi:'model'`/`beta:'model'` Option authority.
- **No singleton bypass**: `decide()` keeps the documented
  `candidates.length === 1` non-bypass; the §18 prohibition is preserved
  verbatim.
- `decisionReason` (Gate C) is journaled in `authority.decisionReason` on
  every call record.

Focused proof: `test-question-heads.mts` PASS; regression sweep green
(`test-audit.mts` 10/10, `test-typed-decision-backend.mts` 27/27).

## Gates E–H

Pending. Do not resume Minecraft until all pass.
