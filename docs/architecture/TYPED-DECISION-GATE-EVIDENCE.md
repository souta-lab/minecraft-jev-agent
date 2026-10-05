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

## Gates C–H

Pending. Do not resume Minecraft until all pass.
