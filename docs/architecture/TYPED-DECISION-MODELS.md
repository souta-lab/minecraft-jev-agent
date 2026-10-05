# Typed Decision Models / System One in V4.1.2

Status: architecture companion for the permanent V4.1.2 Jev authority. This document explains the model class and the replaceable transport contract; it does **not** create a new authority layer.

## 1. What a typed decision model is

A typed decision model is a machine-facing decision primitive. The caller supplies bounded state plus one or more questions whose output spaces are fixed in advance. The model returns typed values and uncertainty information that ordinary code can consume directly.

This is materially different from asking a chat LLM to "return JSON":

- The output domain is defined before inference rather than generated as arbitrary text.
- The useful product is a decision/distribution, not prose or reasoning tokens.
- The software remains responsible for rules, thresholds, executable candidates, resource/lifecycle authority, and outcome verification.
- Several narrow questions can be answered together over one state snapshot.
- A typed answer can still be wrong. Calibration and reliability are empirical properties, not architectural assumptions.

TypeSafe calls this model class **System One Models**. Their public API exposes a `systemone` operation and the primitive family Noul / Choice / Score. Jev is TypeSafe's first public System One model. V4.1.2 uses the same conceptual primitive for Jev's WHICH/WHETHER role, but the role is not tied to that particular model or company.

## 2. Primitive semantics

### Noul

A yes/no question. Preserve `P(true)` as a number in `[0,1]`. Code decides the threshold and what either branch means. Internally this repository may call the mapped representation `boolean`; that spelling must not erase the raw probability.

### Choice

Select exactly one label from a finite caller-defined set and return the distribution/confidence information supplied by the backend. In Minecraft, those labels are grounded candidate ids. A backend must round-trip them exactly; it may not synthesize an action or target.

### Score

Evaluate against an ordered rubric. Preserve the order/legend and returned score/distribution. Code interprets the score; the backend does not own policy thresholds.

## 3. Ownership in Minecraft

The typed model is deliberately narrow:

`live facts -> semantic projection -> grounded candidates + typed questions -> typed model -> typed answers -> Kernel/controller adoption -> physical transition -> VERIFY`

Jev owns tactical WHICH/WHETHER. System2 owns sparse WHAT/decomposition/repair. Kernel owns lifecycle/resources/effects/trusted truth/Mission/SUCCESS. Changing the typed-model backend changes none of these owners.

A model must never invent coordinates, blocks, candidate ids, effects, or success facts. If the available grounded options are insufficient, that is a presentation/capability problem for code/System2, not a license for the model transport to become an LLM planner.

## 4. TypeSafe-compatible backend profile

Compatibility is a behavioral contract, not a vendor name. Each backend profile must declare:

- `providerId` and `modelId` (provenance)
- base URL / transport and wire dialect/version
- secret resolver and non-secret secret-origin label
- Noul/Choice/Score request mapping
- Noul/Choice/Score response mapping
- model/usage metadata mapping
- per-attempt timeout and caller cancellation
- bounded retries and status/error classification
- availability vs semantic failure classification
- whether confidence is calibrated, distribution-derived, absent, or provider-specific

Gameplay/controller code consumes one normalized Jev result. Vendor/model checks belong only in this adapter, configuration, focused tests, and telemetry.

### Acceptance probe for a new profile

Before production use, prove with the actual endpoint/model:

1. model discovery or an explicit model-id probe succeeds;
2. one request batches Noul + Choice + Score;
3. Choice labels round-trip exact arbitrary ids;
4. Noul returns raw `P(true)` and it survives normalization;
5. Score legend/order and returned score/distribution survive normalization;
6. response model identity and usage are recorded;
7. caller abort and timeout terminate the request;
8. 429 / 5xx / authentication-credit failures become typed availability outcomes;
9. malformed/missing answers fail closed rather than selecting a candidate;
10. no deterministic or alternate-model fallback occurs unless explicitly configured and provenance-visible.

A wire-compatible model is **not** assumed to share another model's calibration. Threshold changes require measured evidence.

## 5. Current Liquid D1 migration (2026-10-05)

The currently selected replacement backend is Liquid's direct decision API with primary model `d1`. `d1:free` exists as a distinct model and may be configured explicitly as an availability/cost fallback later; it must never be silently substituted for `d1`.

Live account discovery on 2026-10-05 returned both model ids:

- `d1` — text + image capability metadata
- `d1:free` — text capability metadata

Direct System One probes against Liquid's decision API succeeded for both. A small same-payload latency sample from the campaign host was:

| model | sample | p50 | mean | max |
| --- | ---: | ---: | ---: | ---: |
| `d1` | 5 single-Choice calls | 0.508 s | 0.493 s | 0.716 s |
| `d1:free` | 5 single-Choice calls | 0.496 s | 0.498 s | 0.711 s |
| `d1` | 3 four-question batches | 0.507 s | 0.481 s | 0.509 s |
| `d1:free` | 3 four-question batches | 0.392 s | 0.418 s | 0.512 s |

All sampled calls returned HTTP 200. This is a connectivity/latency sanity check, **not** a quality or calibration evaluation and not a future latency guarantee.

The API key lives outside the repository in a permission-restricted secret file. Never copy it into config, tests, handoff, logs, process arguments, or docs.

## 6. Audit-derived rules this abstraction is meant to protect

The p21-p24 campaign exposed a recurring pattern: a locally successful mechanism can be globally anti-goal when identity, progress accounting, availability, or provenance crosses layers incorrectly. Typed-model integration must therefore preserve the same anti-churn rules as gameplay:

- `VERIFY` of a physical action is not Mission progress.
- Plan / option / candidate / observed effect must tell one causal story.
- Three locally successful actions with no resource/frontier/reachability gain are trajectory churn.
- Three source-changing non-converting fixes require a conversion checkpoint.
- Repeated deaths/world scars can make a same-world episode less informative than a fresh major.
- Observer/tooling work is bounded by Mission leverage.
- Registry/source/generation/goal/handoff drift is a provenance defect, not harmless bookkeeping.
- Provider unavailability is infrastructure evidence, not semantic evidence; repeated same-fingerprint generation restarts are infra churn.
- A backend swap must happen at one adapter boundary instead of leaking vendor/model conditionals into candidate generation or controller policy.

## 7. Migration rule of thumb

When another typed model appears, do **not** ask "how do we rewrite Jev around this vendor?" Ask:

> Can this backend satisfy the normalized typed-decision profile while leaving candidate grounding, Kernel authority, System2 ownership, controller mechanics, and VERIFY untouched?

If yes: add/configure one backend profile, run the acceptance probe, record exact provenance, and compare live Mission conversion. If no: it is not a drop-in Jev backend; do not bend V4.1.2 around it.
