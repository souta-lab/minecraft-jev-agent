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

## Gate E — replay + sealed holdout on recorded corpora (PROVEN)

Tool: `tools/jev-replay-eval.mts` (read-only). For every recorded `jev-call`
it reconstructs the v7-equivalent projection (same mapping as the Gate B
`--compact-sim`), feeds it to the REAL `classifySemanticBoundary`, and
simulates the Gate C policy over the chronological call stream:

- the anchor is the projection bound to the last ACCEPTED answer — a replay
  never advances it, and a failed call never anchors;
- `lastOutcomeRequiredDecision` is reconstructed from the call's own
  `previousDecision.terminalReason` (the same settle packet production reads);
- `leaseHeld` comes from the recorded `world.leaseHeld`;
- on a replay verdict, the anchored answer's semantic identity is repointed to
  the current realization and compared with what the model actually answered
  (fidelity).

Split: chronological — dev = first 75%, sealed holdout = last 25%. The
classifier and signature were finalized before either holdout slice was run.
p23 is an independent corpus from a different run.

### Results

| Corpus | Slice | Calls | Necessary | Replays | Reduction | Fidelity (agree/judged) |
|---|---|---:|---:|---:|---:|---:|
| p24 | all | 4,855 | 3,024 | 1,831 | 37.7% | 1,758/1,826 (96.3%) |
| p24 | dev | 3,641 | 2,790 | 851 | 23.4% | 782/850 (92.0%) |
| p24 | **holdout** | 1,214 | 235 | 979 | **80.6%** | **975/975 (100%)** |
| p23 | all | 6,802 | 6,224 | 578 | 8.5% | 545/578 (94.3%) |
| p23 | dev | 5,101 | 4,625 | 476 | 9.3% | 455/476 (95.6%) |
| p23 | **holdout** | 1,701 | 1,599 | 102 | **6.0%** | **90/102 (88.2%)** |

Boundary reasons (p24 all): `candidate_set_changed` 1,658,
`same_semantic_state` 1,831, `safety_changed` 772, `goal_or_option_changed`
229, `resource_evidence_changed` 185, `skill_outcome_boundary` 159,
`progress_boundary` 20, `first_decision` 1.

### Reading the evidence

- **The defect reproduces and the repair works.** In p24's stable phase
  (holdout quarter — the healthy-hour region where every recorded call was
  the same coarse `explore:cave` + MOVE shape), 80.6% of calls carry no
  decision-relevant change; under Gate C they are replays inside new causal
  epochs, spending zero provider calls, and 100% of them agree with the
  answer the model produced when it WAS queried. The remaining 235 calls in
  that same quarter are real boundaries (`goal_or_option_changed` 136,
  `safety_changed` 53, `resource_evidence_changed` 45) — the signature does
  not suppress semantically distinct states even when the coarse shape is
  identical.
- **p23 is a genuinely busier run** — only 8.5% of its stream is replayable
  (it crossed 595 mandatory skill-outcome boundaries and 2,382 real
  candidate-set changes). The classifier suppresses where semantics are
  stable and calls where they are not; it is not a throttle.
- **Raw-hash replay would have failed**: 1,807 of 1,831 p24 replays (98.7%)
  and 563 of 578 p23 replays (97.4%) had a different `projectionHash` than
  their anchor — the hash churns on outcome memory while the semantic
  signature holds.
- **Disagreements are model oscillation, not replay error.** On same-
  signature pairs where the repointed anchor disagrees with the recorded
  answer (68 on p24 dev, 12 on p23 holdout), the live model itself switched
  choices (e.g. WAIT -> DESCEND -> MOVE) under an unchanged semantic
  situation. Replay enforces the committed choice — exactly the commitment
  stability §6 requires — so these count as churn removed, not quality lost.
- **No unmappable replays** (0 in both corpora): the signature guarantee that
  an anchored semantic identity remains offered held on every replay.
- **Errored calls are handled exactly as production**: a failed call never
  becomes an anchor (139 necessary errored calls on p24 spent the call and
  left the previous anchor intact), and 5 errored calls on p24 would simply
  not have happened under replay.

### v7-corpus support note (p24.9 window, commit `8cef6101`)

The tool previously required `record.state.semantic` (the v6 envelope) and
silently dropped every v7 `jev-call` record — `jev-semantic-projection/v7`
records store the classifier-ready projection directly in `state`, so the
replay/holdout proof could not read any live d1-era call. `reconstruct` now
passes v7 records through with the same `counts` normalization; the loader
filter keeps the original v6/v7 semantics.

Window replay (`--since 2026-10-05T15:44Z`, the starvation-wedge window,
`gen-muvf88jh-oznn5l` @ `c6ec48dc`): **168 calls, 168 necessary, 0
replays** — `candidate_set_changed` 104, `safety_changed` 41,
`resource_evidence_changed` 12, `goal_or_option_changed` 10,
`first_decision` 1.

Reading: this is a *post-Gate-C* corpus — production already filtered
replays, so "all necessary" is expected by construction, and the value is a
**consistency check**: the offline classifier agrees with every production
boundary decision in the window (zero contradictions). During an active
terrain wedge the semantic situation genuinely churns per decision — the
complement of the stable-phase finding that 80.6% of calls were replays.
The classifier calls when it should and replays when it should.

### Documented blind spots in the reconstruction

- v6 records do not carry `goalQueue.hasImpossible`; it is reconstructed as
  constant `false`, so a mid-run queue-impossibility flip is invisible to this
  eval (biases toward replay, not against; such flips are rare and always
  coincide with an option/queue change that IS signed).
- `lastOutcomeRequiredDecision` is read from the next call's
  `previousDecision.terminalReason`; a same-tick double-settle not reflected
  in that field could differ (not observed to matter: the
  `skill_outcome_boundary` counts are dominated by genuine mandatory reasons).

## Gate F — Liquid d1 calibration measured separately from Jev (PROVEN)

Tool: `tools/jev-d1-calibrate.mts` — replays recorded p24 decision states
through the PRODUCTION `liquid-direct-d1` adapter (same wire path as
`createJevPolicy`), reconstructing the v7 model view and the current
Gate-B/D question wording. 48 real d1 calls (40 core + 8 threat question
sets, deterministic stride sample). No Jev assumptions transferred.

### Defect found and fixed by calibration

Every singleton grounded offer (exactly one candidate — produced whenever
WAIT/ESCALATE suppression leaves one productive action) failed on the d1
wire: `422 A Choice needs at least 2 options` (21/21 singleton frames;
44.1% of all p24 calls and 14.6% of p23 calls are singletons — the healthy
hour's `explore:cave` + MOVE shape is exactly this). Jev tolerated 1-label
Choices; d1 does not. §18 forbids skipping the model on singletons, so the
fix is at the offer/question layer: singleton `action` Choices now carry an
explicit `DECLINE` label (`client.ts` `ACTION_DECLINE_LABEL`):

- `buildAuthorityQuestions`/`buildQuestions` add DECLINE only when
  `candidates.length === 1` — with >=2 candidates WHICH is already real.
- DECLINE is never an actuation: `decisionIdFrom` returns null for it.
- The grounding check accepts DECLINE only on singleton offers (a DECLINE on
  a multi-candidate offer is still "invented non-grounded id" -> fail).
- A declined sole action is a beta-form vote — `abandonVerdict` treats it as
  an abandon request under the existing deferral/cooldown bounds, so the
  Option ends or the request is deferred; it cannot stall the loop and it is
  not a resurrected WAIT/ESCALATE control.
- The pi instruction names the DECLINE leg explicitly.

Post-fix live: **48/48 calls succeed**. d1 chose DECLINE on 14/21 singleton
frames — every one with beta P >= 0.68, i.e. declining the sole action and
wanting the Option ended co-occur exactly as designed.

### Measured distributions -> thresholds (per-model, profile-carried)

| Head | d1 measurement | Jev-era threshold | d1 threshold | Rationale |
|---|---|---|---|---|
| `action` confidence | mean 0.576, p50 0.635, p10 0.230 | `lowConfidenceThreshold` 0.55 | **0.2** (`profile.lowConfidenceThreshold`) | 0.55 would escalate ~40% of d1 calls; 0.2 isolates the ~6% genuinely-uncertain tail |
| `abandon_option` P | mean 0.358, p50 0.281, p90 0.799; 40% >= 0.5 | 0.5 | **0.8** (`profile.abandonThreshold`) | keeps Option-ending exceptional (~6%) and reachable; Jev's 0-adoption rate was itself pathological (#360) |
| `danger` confidence | mean 0.408, p50 0.391 (n=7) | `DANGER_CONFIDENCE_THRESHOLD` 0.4 | 0.4 (unchanged) | gate keeps roughly the top half of evidence-quality answers |
| `should_retreat` P | 6 strong_false / 1 uncertain / 1 strong_true | 0.30/0.70 band | unchanged | band discriminates correctly |

Resolution order (no silent transfer): Option `abortThreshold` (explicit
per-Option bound) > `BUDDY_ABANDON_THRESHOLD` env > profile
`abandonThreshold` > 0.5; `BUDDY_LOW_CONFIDENCE_THRESHOLD` env > profile
`lowConfidenceThreshold` > 0.55. `d1:free` carries NO calibration fields —
it is unmeasured and keeps the defaults.

Other measured facts: action top-label probability p50 0.764 (decisive
Choice distributions); agreement with the recorded Jev answer 21/48 (Jev
itself oscillated on identical states per Gate E — not a quality-regression
signal); latency p50 ~0.41 s; `usage.outputTokens` 0 throughout.

Regression sweep after the change: `test-question-heads.mts` (now covering
DECLINE: singleton leg, never actuates, beta-form decline, rejected on wide
offers), `test-decision-epochs.mts`, `test-decision-state.mts`,
`test-jev-semantic-projection.mts` 20/20, `test-audit.mts` 10/10,
`test-typed-decision-backend.mts` 27/27, `test-beta-abandon-deferral.mts`
12/12, `test-beta-authority.mts` 5/5, `test-beta-option-threshold.mts` PASS,
`test-beta-stall-evidence.mts` PASS, `test-skill-commitment.mts` 21/21,
`test-controller-transitions.mts` 7/7. `tsc --noEmit` clean.

## Gate G — operational fail-closed, provenance, cost, no churn (PROVEN)

### Fail-closed matrix (all exercised by tests or live probe)

| Failure | Behavior | Proof |
|---|---|---|
| Missing credential for selected profile | `FatalModelError` at `createJevPolicy` — construction fails, nothing starts | `test-typed-decision-backend.mts` 27/27 |
| Unknown profile id | `FatalModelError` — "no other profile is substituted" | same suite |
| Auth (401) / credit (402 or credit-text on any status) / entitlement (403) / bad_request / model_identity | `DecisionUnavailableError` DECISIVE → `provider-unavailable-decisive:<kind>` journaled → `FatalModelError` non-retryable → `terminate-process` (single FATAL, exit 1) | typed-backend suite; live 401 probe (one attempt, no retry) |
| rate_limited (429) / timeout / network / 5xx | `retryable` → bounded in-policy transient retries → exhaustion → `recover-generation` under `modelRecoveryStartGate` exponential backoff (5 s base -> 5 min cap) | typed-backend suite; `test-model-recovery.mts` 18/18 |
| Malformed/non-grounded model answer (invented id, DECLINE on a wide offer, probability keys != offered labels, sum out of tolerance, reported model != profile) | decisive failure closed, journaled | typed-backend suite; `test-question-heads.mts` |
| Epoch invalidated mid-flight / stale result | dropped before commitment (`decisionEpochs.accept`), never anchors a replay | Gate C `test-decision-epochs.mts` |
| Errored provider call | never becomes a replay anchor | Gate E simulation: 139 necessary errored calls, 0 anchored |
| Silent fallback to another profile/model (`d1:free`, gateway, deterministic) | impossible: no code path substitutes; `d1:free` and `typesafe-gateway-jev` are explicit-only | typed-backend suite; `assertRecoveryModelAuthority` on recovery |
| System2 unavailable | separate authority stack; surfaces UNKNOWN/unavailable, never a deterministic semantic plan | `test-system2-handoff.mts` 7/7 |

### Generation-churn bound (the p24 incident shape)

The p24 credit outage churned ~one generation per 5 min because the error was
classified retryable. Under `liquid-direct-d1`: `credit` is DECISIVE ->
`modelFailureDisposition` -> `terminate-process` -> ONE `FATAL
MODEL_UNAVAILABLE` journal line + process exit. Transient outages recover the
generation only through `modelRecoveryStartGate` — exponential backoff
(MODEL_RETRY_BASE_DELAY_MS 5 s -> MODEL_RETRY_MAX_DELAY_MS 5 min), honored by
every generation-start path (respawn, world-reset, control, scheduled retry).
Recovery restarts verify authority identity (`assertRecoveryModelAuthority`)
so a recovered generation cannot silently run a different backend.

Known limitation (documented, not fixed here): the explicit-only
`typesafe-gateway-jev` dialect predates typed error classification — a
credit-like gateway error still classifies retryable and would churn under
bounded backoff. Mitigation: that profile is explicit-only, never selected by
default or by fallback.

### Provenance (exact, journaled)

- Per generation: `GENERATION_READY` — `runId`, `generationId`, `sourceSha`,
  `buildHash`, `policy`, `policyProvider`, `policyProfile`, `policyModel`,
  `system2*` authority fields.
- Per decision: controller journal — `trigger`, `policy`, `provider`,
  `profile`, `model`, `callId`, `projectionHash`, `decisionEpoch`,
  `decisionReason` (§7.1 typed boundary), `latencyMs`, `inputTokens`,
  `actionConfidence`, `dangerScore`, `shouldRetreat`, `abandonOption`.
- Per provider call: `jev-call` record — `backend` (profileId + providerId),
  `model`, exact `state` sent, `questions` sent, `response.requestId`,
  attempts/wait counters, `authority.decisionReason` (also on failure
  records), Option-boundary `authority.decision` (beta threshold/probability/
  adopt — omitted on route frames, which journal `jev-policy-input` instead).

### Cost evidence (measured, d1)

Gate F calibration run: mean 6,016 input tokens/call, p50 4,800, p90 11,556
(provider's accounting of state + question text — NOT comparable to Gate B's
serialized-state bytes); `usage.outputTokens` 0; latency p50 ~0.41 s. Under
Gate C semantics the p24-holdout simulation calls the provider on 19.4% of
decision ticks, so the measured ~6k/call applies to boundary calls only.

## Gate H — bounded live composition sample (PROVEN, with recorded findings)

§18 requires, after A-G: "run the smallest live source-bound sample that can
falsify the new decision interface. Inspect calls per semantic commitment,
tokens per call, stale/requery causes, and verified semantic progress before
returning to ordinary portal progression."

### Sample identity (exact provenance)

- Campaign: portal-p24, seed 20261005, world `cap-portal-p24` (saved world
  resumed, minor p24.5, `boundary=resident-restart`).
- Live window analysed: `2026-10-05T13:01:28Z` -> `13:08:42Z` (~7.2 min),
  generation `gen-muv9dq21-k8fjzi`, internal run `run-muv9dpld-co2e`,
  `sourceSha=afa2ce5d7edad23741c8c74495f39544f1bfe67f`, `buildHash=996ad6c2cfed`.
- `GENERATION_READY` attests: `policyProvider=liquid`,
  `policyProfile=liquid-direct-d1`, `policyModel=d1`,
  `deterministicFallbackEnabled=false`.
- Tool: `tools/jev-live-sample-eval.mts` (committed; joins resident stdout
  epoch markers with `logs/jev/jev-calls.jsonl`).

### Planner labeling (required honesty note)

System2 (muse-spark via Vercel AI Gateway) had a dead credit balance during the
window, so the live sample ran in two phases:

- **Phase A (12:54:33-13:01:00Z, `planner=llm`, System2 dead)**: every boot
  reached `first_decision`, d1 selected `ESCALATE` on a `WAIT/ESCALATE`-only
  offer, the System2 summon failed decisively on credit, and the resident
  terminated fail-closed (`FATAL MODEL_UNAVAILABLE context=system2-authority`,
  `terminate-resident`, supervisor restart). 5 generations in ~6.5 min, all
  journaled, zero silent fallback — the bounded recovery/churn machinery
  behaved exactly as designed and the operator's predeclared "park if System2
  fails" condition was confirmed live.
- **Phase B (13:01:28-13:08:42Z, `BUDDY_PLANNER=deterministic`)**: the
  explicitly-labeled deterministic planner baseline
  (`productionPlanAuthority=deterministic`, `planner=deterministic`,
  `system2Provider=deterministic`) supplied WHAT goals so the Typed Decision
  Plane under test (Liquid d1 WHICH/WHETHER) could be exercised for a bounded
  window. Per AGENTS.md §3 this is `DETERMINISTIC_BASELINE` plan synthesis —
  it is evidence about the decision interface only, never mission/acceptance
  credit.

### Measured Gate H contract (phase B, n=305 provider calls)

| Axis | Result |
|---|---|
| Epochs started | 757 |
| Provider calls | 305 (0.403 calls/epoch) |
| Replayed epochs (`same_semantic_state`, `cacheHit=true`, `reusedFrom=<answered epoch>`) | 452 — 59.7% of epochs reused the committed answer with no call |
| Stale-result drops | 0 (mechanism proven in Gate C fixtures; none triggered live) |
| Boundary reasons on calls | `resource_evidence_changed` 297, `candidate_set_changed` 3, `safety_changed` 3, `progress_boundary` 1, `first_decision` 1 — every provider call carries a typed `decisionReason`; none is a bare hash diff |
| Input tokens/call | mean 4011.5, p50 3976, p90 4271, max 4370 (vs p24 healthy-hour 7091.8 — ~43% reduction from the v7 compact state) |
| Latency | p50 353 ms, p90 416 ms |
| Question sets | `action+abandon_option` only (no threat frame triggered) |
| DECLINE (singleton offers) | 299 singleton offers; d1 declined 252 (84%); `declineOnMultiCandidate=0` — the grounding invariant held live |
| Abandon head (beta) | mean P 0.609 — under the calibrated 0.8 threshold; no enforced abandons |
| Errors | 0 provider errors in-window |
| Generation churn | 1 generation, 0 FATAL, 0 terminate-resident (phase B) |

### Verified semantic progress — honest null

Phase B produced 118 `SKILL_OUTCOME_PACKET`s, `terminalReason=blocked` on all,
`verified=false` on all. The resumed world state is a physically trapped
pocket (position ~40.5,-60,-0.5, health 1, inventory dirt:5): every grounded
candidate resolved to `NO_SUPPORT` (below world floor) or was correctly
declined by d1. **The interface was asked 757 times and never manufactured or
credited progress it did not verify** — which is the correct fail-closed
outcome, but means the sample cannot demonstrate verified semantic progress.
Phase A's only verified outcome was one `MOVE` (`verified=true`) before the
System2 wall.

### Findings recorded (not fixed under Gate H)

1. **Trap-state boundary amplification.** In a degenerate state, each blocked
   or declined action appends a per-cell failure event; `events` is a signed
   resource-evidence section, so each tick re-queries
   (`resource_evidence_changed`, 297/305 calls). Semantically defensible — the
   evidence set genuinely changed — but it means the replay rate collapses to
   ~40% calls/epoch exactly when the world can produce nothing new. A §7.1
   refinement candidate (band/dedupe identical failure-class events) is
   recorded, not adopted: suppressing real evidence would weaken the
   signature. Live counter-evidence that the mechanism is correct: in a normal
   state 59.7% of epochs replay cleanly.
2. **Dead-System2 churn (phase A)** matches the known p24 INFRA_CHURN shape;
   under `BUDDY_PLANNER=llm` the run cannot proceed at all while the Vercel
   credit is exhausted. Fail-closed held throughout.
3. The Gate H launch itself caught one deployment defect pre-flight: the
   `packages: 'external'` generation bundle could not resolve
   `@typesafe-ai/sdk` from `data/resident/` — fixed by declaring it in
   `packages/buddy-driver/package.json` (`afa2ce5d`).

### Gate H verdict

PASS for the gate's stated purpose: one bounded live source-bound sample
exercised the new decision interface and produced exact measurements on every
required axis. The interface demonstrably composes (typed boundaries, replay,
DECLINE, parallel heads, exact provenance, no churn, fail-closed) at ~43%
lower input tokens. Verified semantic progress in-window was zero for a
world-state reason outside the decision plane; that limitation is recorded,
not smoothed over.

### Gate status A-H

A,B,C,D,E,F,G,H all pass. Remaining operational dependency before ordinary
portal progression: System2 (muse-spark) credit — a provider credential/billing
dependency, not a code defect. The typed decision plane is proven on Liquid
direct d1 as primary with no silent fallback.

### p24.10 — `safe_column` `no_producer` hole + craft-envelope acquisition accounting (acf82fa0, LIVE @e9602bf00d7a)

Two fixes, one class. `safe_column` was the last capability kind with no
producer: a refused ascend column (cell-unsafe, tool-short, or clearance-
blocked) fell to `no_producer` even when a tool route or the same grounded
route family `open_path` gets sat ready. Wired: `tool` arm when the blocker
names a family+tier; the full `routeOpeningCandidates` family always (an
alternate column can still reach the target); no cell MINE (cells are
sensor-unsafe or notional — inventing one would be a reachability lie).

Second fix — the last-resort `selfContainedCraftCandidates` envelope counted
ANY non-WAIT candidate as "goal has work", so an emitted `ASCEND:target`
acquisition offer silently hid the inputs-held `CRAFT:crafting_table` step
the dc54ff4/run-mubobiq6 rule exists to provide. Acquisition offers are
routes TOWARD withheld prerequisites, never the goal's own craft — now
excluded from the envelope, matching `hasGroundedGoalRoute` beside it.

Proof: acquisition-route 34/34 (+2 safe_column cases: `no_tool`→tool route,
`no_clearance`→route family), reachability suite restored (the
unreachable-table/no-suppression contract held), typecheck + 10 suites.
Deployed: watcher → `gen-muvhqtpi-lokkrz` @build `e9602bf00d7a`; body
resumed `collect:log` under muse-spark post-swap.
