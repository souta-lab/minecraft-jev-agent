# Typed Decision Models / System One Models

Status: conceptual and integration reference for the permanent V4.1.2 architecture.
Last reviewed: 2026-10-05.

This document exists because the project historically overloaded **Jev** to mean both a concrete TypeSafe AI model and the Minecraft component that used that model. Those are not the same thing. This reference separates the model class, concrete models, architectural responsibility, provider, transport, and compatibility contract so future decision-model backends can be swapped without changing V4.1.2 ownership.

## 1. Terminology map

Use these names precisely.

| Term | Meaning | Example here |
| --- | --- | --- |
| **System One Model** | TypeSafe AI's name for a new class of models built for machine-facing structured decisions rather than open-ended text generation. | Jev |
| **decision model / typed decision model** | Generic descriptive term used in this project for models that consume state + bounded typed questions and return typed probabilistic judgments. It is not assumed to be a universal industry standard or a specific training architecture. | Jev, Liquid d1 |
| **Jev** | TypeSafe AI's first concrete public System One Model. A model identity, not an architectural role. | TypeSafe Jev |
| **d1** | Liquid AI's separate concrete decision model. It is not Jev and need not share Jev's architecture/training. | Liquid d1 / `d1:free` |
| **Typed Decision Plane** | This project's generic architectural responsibility for bounded tactical/semantic WHICH/WHETHER judgments among grounded choices. | historically named the “Jev” plane/frame/authority in V4.1.2 code/docs |
| **System2** | This project's sparse WHAT synthesis/decomposition/repair authority. | Muse/LLM-backed planning lane |
| **provider/backend** | Service/account actually serving the model. | TypeSafe API, Liquid API |
| **transport/profile** | Endpoint, auth, wire dialect, timeout/retry/error mapping and normalization used to call one provider/model. | Liquid-direct profile |

### Historical V4.1.2 naming

The frozen V4.1.2 codebase contains names such as `Jev frame`, `Jev replay`, `Jev authority`, `jev-agent`, `JEV_DECISION_EPOCH_START`, and `selectedBy=jev`. These arose because TypeSafe Jev was the original implementation of the bounded decision component. They are **historical component/provenance names**. They do not make Jev a generic role or model class.

When reading old architecture prose, translate a role-level sentence like:

> Jev chooses WHICH grounded action runs.

as:

> The Typed Decision Plane chooses WHICH grounded action runs, using the configured decision model. In the original implementation that model was Jev.

Do not mass-rename stable V4.1.2 event/schema/code identifiers merely for terminology purity; that would create provenance and compatibility churn. New conceptual docs and new provider-neutral code should use the generic term.

## 2. What TypeSafe actually introduced

TypeSafe AI announced **System One Models** on 2026-09-15 as a new class of models designed for fast, structured decisions that software can use directly. Their launch material says the stack uses a new model architecture, a parallel sampler, and a training method called **Reinforcement Learning for Calibrated Decisions (RLCD)**. Their first public model is **Jev**.

TypeSafe summarizes Jev as:

> unstructured state in, typed probabilistic decisions out

That statement is a good mental model, but keep the scopes straight:

- **System One Model** is TypeSafe's model-class/product terminology.
- **Jev** is one concrete TypeSafe model in that class.
- **RLCD**, TypeSafe's parallel sampler, and Jev's internal architecture are TypeSafe/Jev implementation claims.
- Another decision model does **not** need to use RLCD or Jev internals to satisfy this project's normalized typed-decision contract.

Primary references checked for this document:

- TypeSafe launch: `https://typesafe.ai/blog/introducing-system-one-models-and-jev`
- TypeSafe API: `https://api.typesafe.ai/docs` / `POST /v1/systemone`
- TypeSafe workflow evals: `https://evals.typesafe.ai/`

## 3. The request/response shape

At the interface level, one System One-style request contains:

1. **state** — the shared content/context the questions refer to;
2. **questions** — a non-empty map of named, typed questions;
3. **model** — the concrete model identifier.

The response returns answers keyed by the same question names, plus model/usage metadata.

Conceptually:

```text
state + { named typed questions }
              |
              v
       decision model
              |
              v
{ same names -> typed probabilistic answers }
```

The surrounding application remains ordinary software. It decides what questions exist, what choices are legal, what thresholds are used, what effects are allowed, and how outcomes are verified.

## 4. The three primitive question types

### 4.1 Noul

A yes/no judgment represented as a probability.

Conceptual result:

```text
P(true) in [0, 1]
```

The model does **not** own the application threshold. Code may interpret `0.91` differently from `0.61`; collapsing the provider result immediately to `true/false` destroys useful information.

This repository historically maps Noul into an internal `boolean` representation. That spelling is acceptable only if the raw `P(true)` survives end-to-end.

### 4.2 Choice

A selection from a finite set defined by the caller.

Conceptual input:

```text
A -> description of A
B -> description of B
C -> description of C
```

Conceptual result:

```text
choice = B
probabilities = { A: ..., B: ..., C: ... }
confidence = provider/model-defined confidence signal when available
```

For Minecraft, the labels can be exact grounded candidate IDs. A valid backend must round-trip those labels exactly. The model does not get to invent a fourth action, coordinate, block, entity, tool call, or target outside the offered set.

### 4.3 Score

A judgment on an ordered rubric supplied by the caller.

Conceptual input:

```text
0 -> safe
1 -> caution
2 -> dangerous
3 -> lethal
```

Conceptual result includes a score, the ordered legend/rubric, a distribution over levels, and (when supplied) confidence.

Ordering is semantic. A transport that reorders the legend is not compatible even if its JSON validates.

## 5. Parallel questions and code-composed workflows

TypeSafe's API allows multiple question types in one request against the same state. Their workflow material explicitly encourages decomposing an automation task into several narrow judgments and ordinary program rules rather than asking a model to solve an entire policy in prose.

This matters for the Minecraft architecture:

```text
world facts
  -> bounded semantic projection
  -> multiple grounded typed questions
  -> Typed Decision Plane
  -> typed judgments
  -> deterministic adoption/guards
  -> transition execution
  -> VERIFY
```

The decision model contributes judgment. It does not become the planner, lifecycle manager, resource owner, actuator, or verifier.

## 6. Native decision model != LLM with JSON mode

A chat/generative LLM can be constrained by a schema or wrapper to return values shaped like Noul/Choice/Score. That can be useful, and TypeSafe's own eval harness compares LLMs through a System One-compatible wrapper.

But schema equality does not imply the same model class.

A generative LLM typically still performs autoregressive token/string generation underneath and is then constrained/parsed into a schema. TypeSafe describes Jev/System One as taking the opposite direction: the native product is the bounded probabilistic decision rather than a string.

For this project, the important distinction is operational rather than philosophical:

- Does the model natively or reliably preserve the bounded output domain?
- Does it return useful probabilities/distributions?
- Is latency/cost appropriate for frequent runtime decisions?
- Can the runtime fail closed without parsing arbitrary prose?
- Is calibration measured for our use rather than assumed?

Do not reject a future backend merely because its internals differ from Jev. Do not call it “Jev” merely because it speaks a Jev-shaped API.

## 7. Type safety is not correctness

This point is easy to get wrong.

TypeSafe markets Jev as unable to hallucinate/type-error in the sense that its output is constrained to the predefined typed output space. Their launch material explicitly says schema matching is guaranteed rather than an empirical claim.

That does **not** mean every Jev judgment is semantically correct.

A Choice can legally select the wrong offered candidate. A Noul probability can be poorly calibrated for a new domain. A Score can rank danger incorrectly while still being perfectly well-typed. TypeSafe's own workflow evals show disagreements and misses versus their reference models.

Therefore separate:

- **type/schema validity** — structurally admissible output;
- **semantic accuracy** — whether the judgment is right;
- **calibration** — whether stated probabilities/confidence correspond to observed success frequencies;
- **application safety** — whether surrounding code/Kernel/VERIFY prevents a wrong judgment from becoming an invalid effect or false fact.

Minecraft must rely on all four layers, not marketing shorthand such as “zero hallucinations.”

## 8. Calibration is model-specific

A compatible schema does not make confidence interchangeable.

Thresholds learned with Jev cannot automatically be reused for d1. Even if both expose a field called `confidence`, the statistical meaning and calibration may differ. The same is true for probability sharpness, failure distribution, and behavior under out-of-distribution states.

For every new model, measure:

- decision accuracy on representative private cases;
- reliability/calibration curves where probabilities drive behavior;
- high-confidence error rate;
- abstention/escalation behavior encoded by our workflow;
- latency tail, not only p50;
- availability/rate-limit/error distribution;
- Mission conversion in live Minecraft after focused contract proof.

## 9. Five identities that must remain separate

Never collapse these into one string such as `jev`:

1. **Architectural responsibility** — Typed Decision Plane.
2. **Model/interface class** — System One / typed decision model.
3. **Concrete model** — TypeSafe Jev, Liquid d1, future model X.
4. **Provider/backend** — TypeSafe, Liquid, gateway, self-hosted service, etc.
5. **Transport/profile** — base URL, API dialect/version, secret resolver, model id, timeout, retries, error mapping, response normalization.

A useful provenance record should be able to answer independently:

```text
which plane made the decision?
which concrete model made it?
which provider served it?
which transport/profile called it?
which exact model id/version did the provider report?
```

## 10. Compatibility is four different questions

“TypeSafe-compatible” is too vague unless the level is named.

### Level 1 — wire/schema compatibility

Can the client and server exchange the request/response at all?

Examples:

- endpoint/path/header shape;
- `state`, `questions`, `model` fields;
- answer object parses;
- batching works.

Necessary, not sufficient.

### Level 2 — primitive semantic compatibility

Do Noul/Choice/Score mean the same thing to our normalized adapter?

Must prove at least:

- Noul returns raw `P(true)`;
- Choice returns only an offered label and preserves exact label identity;
- Choice distribution keys match offered labels;
- Score preserves rubric order and value/distribution meaning;
- missing/malformed answers fail closed;
- mixed question batching preserves name-to-answer identity.

### Level 3 — behavioral/calibration compatibility

Does the model behave well enough for the same application policy?

This is empirical. Measure it. Never infer it from an identical API.

Questions include:

- Are confidence/probabilities calibrated similarly?
- Do existing thresholds still make sense?
- How does accuracy change by question type and Minecraft state?
- Does the model have different blind spots from Jev?

A Level-2-compatible model may still require different thresholds or may be unsuitable for production.

### Level 4 — operational compatibility

Can it safely survive long-running production use?

Prove:

- timeout and caller abort;
- bounded retry behavior;
- 429/rate-limit classification;
- authentication/credit/entitlement failures;
- 5xx/network failures;
- provider/model identity in logs;
- usage/cost metadata;
- no secret leakage;
- no silent alternate-model or deterministic fallback;
- resident recovery behavior without generation churn.

Only after all required levels pass should a model become a production Typed Decision Plane backend.

## 11. Mapping into V4.1.2

The generic ownership is:

- **Typed Decision Plane:** bounded tactical/semantic WHICH/WHETHER among grounded enabled choices;
- **System2:** sparse WHAT synthesis, repair, decomposition, causal hypotheses;
- **Kernel:** lifecycle/resources/effects/trusted facts/budgets/Mission/journal/SUCCESS;
- **Transition Controller:** realizes an admitted transition;
- **VERIFY:** sole SUCCESS authority.

The historical implementation used TypeSafe Jev, so many stable identifiers contain `Jev`. Keep those identifiers where changing them would provide no capability benefit. New provider-neutral adapter code should avoid baking `Jev` into abstractions that are actually model-agnostic.

The plane's normalized path is:

```text
semantic projection
  -> grounded candidate identities + typed questions
  -> configured decision-model profile
  -> normalized typed answers
  -> stale/binding/guard checks
  -> admitted controller action
```

The model may not create new grounded reality. Coordinates, entities, blocks, inventories, resources, effects, success facts, lifecycle transitions, and Mission progress remain owned by normal V4.1.2 code and VERIFY.

## 12. Jev and d1 are peers, not aliases

### TypeSafe Jev

Facts from TypeSafe's public material:

- concrete first public System One Model;
- announced 2026-09-15;
- System One API with Noul / Choice / Score;
- TypeSafe claims a new architecture, parallel sampler, and RLCD training;
- optimized for typed probabilistic decisions rather than open-ended strings.

### Liquid d1

For this project, d1 is treated as a **separate concrete decision model** made by Liquid AI. It is not “Jev hosted by Liquid” and should not inherit Jev's behavioral or calibration claims.

Our live Liquid account discovery on 2026-10-05 returned exact model ids:

- `d1` — metadata reported text + image modalities;
- `d1:free` — metadata reported text modality.

Direct calls using the System One-shaped Liquid endpoint succeeded with both. That establishes useful Level-1 evidence and some Level-2 smoke evidence; it does not prove Level-3 calibration equivalence to Jev.

Current measured host-side latency sanity sample:

| model | sample | p50 | mean | max |
| --- | ---: | ---: | ---: | ---: |
| `d1` | 5 single-Choice calls | 0.508 s | 0.493 s | 0.716 s |
| `d1:free` | 5 single-Choice calls | 0.496 s | 0.498 s | 0.711 s |
| `d1` | 3 four-question batches | 0.507 s | 0.481 s | 0.509 s |
| `d1:free` | 3 four-question batches | 0.392 s | 0.418 s | 0.512 s |

All sampled calls returned HTTP 200. This is a connectivity/latency sanity check, **not** a quality, calibration, cost, or future-latency guarantee.

The Liquid API key is stored outside the repository in a permission-restricted secret file. Never place it in docs, git, logs, prompts, handoff, test fixtures, or process arguments.

### Liquid-direct profile (implemented 2026-10-05)

The seam lives at `packages/jev-harness/providers/systemone-direct.ts` (the only firewall-allowed home for a provider SDK) and plugs into the unchanged `AuthorityJevPolicy` transport seam; `createJevPolicy` selects exactly one profile (`BUDDY_DECISION_PROFILE`, default `liquid-direct-d1`; `typesafe-gateway-jev` and `liquid-direct-d1-free` are explicit-only). The policy never holds the Liquid credential and never installs it as `AI_GATEWAY_API_KEY`.

Live acceptance probe through the production policy path:

- discovery: the SDK root is `https://api.liquid.ai/decisions` (`/v1/models` -> `d1`, `d1:free`); the bare host serves the console web app (404 HTML);
- mixed Choice + Score + Noul batch: exact candidate ids round-trip, distribution keys equal the offered labels, raw Noul `P(true)` preserved, Score legend order preserved, reported model `d1`, `usage.output_tokens = 0`, 0.30-0.51 s per batch; identical input produced identical answers across samples;
- caller abort -> cancelled (non-retryable); 1 ms attempt timeout -> transient; invalid credential -> HTTP 401 `invalid_api_key` -> decisive `auth`, one attempt, no retry;
- explicit `d1:free` profile answers with reported model `d1:free`.

Level-3 calibration is **not** established. On two synthetic probe states without a current Option, d1's beta `P(abandon=true)` was 0.72-0.91, while historical Jev beta in comparable live states sat near 0.1-0.2. Treat beta adoption under d1 as a live measurement target; do not retune thresholds without measured evidence.

## 13. Backend profile contract

A production decision-model profile should explicitly declare:

```text
profile id
provider id
concrete model id
base URL / transport
wire dialect/version
secret resolver + non-secret origin label
question mapping
answer normalization
model/usage metadata mapping
timeout
retry policy
availability/error classification
capability metadata
```

Gameplay/controller code outside this narrow adapter/profile boundary must not branch on vendor/model names.

Changing the profile changes the implementation of the Typed Decision Plane. It does not change V4.1.2 ownership and must not create a second semantic authority.

## 14. Acceptance probe before production

For each concrete provider/model, focused proof should cover:

1. model discovery or exact model-id probe;
2. one mixed Noul + Choice + Score request;
3. exact arbitrary Choice-label round-trip;
4. Choice distribution keys/normalization;
5. raw Noul `P(true)` preservation;
6. Score legend/order + score/distribution preservation;
7. model identity and usage provenance;
8. caller abort;
9. per-attempt timeout;
10. 429 classification and bounded retries;
11. 5xx/network classification;
12. authentication/credit/entitlement failure classification;
13. malformed/missing answer fail-closed;
14. no silent deterministic or alternate-model fallback;
15. secret-origin logging without secret-value logging;
16. first production decision records intended plane/provider/model/profile/source identity.

Then perform model-specific Level-3 reliability/calibration evaluation before trusting old thresholds.

## 15. Audit-derived rules this abstraction protects

The p21-p24 campaign already established failure modes that must not be rediscovered as if new:

- physical `VERIFY` success is not Mission progress;
- plan / option / candidate / observed effect must tell one causal story;
- three local successes with no resource/frontier/reachability gain are trajectory churn;
- p23's 96 deaths plus heavy world scars demonstrated that a same-world episode can become less informative than a fresh major;
- p24 demonstrated `collect:log` / surface intent degenerating into deepslate `DESCEND` while `resourceDelta=0`, with local VERIFY incorrectly feeding progress accounting;
- run/generation/source/goal/handoff drift is a provenance defect;
- repeated observer/tooling repair can become its own churn lane;
- repeatedly starting fresh generations against the same unavailable provider is `INFRA_CHURN`, not progress;
- a backend migration belongs at one adapter/profile boundary rather than leaking provider/model checks into gameplay semantics.

## 16. Migration playbook for the next decision model

When model X appears, do not ask:

> How do we rewrite Jev around model X?

Ask:

> Can model X implement the normalized Typed Decision Plane contract without changing candidate grounding, System2 ownership, Kernel authority, controller mechanics, or VERIFY?

Then:

1. identify the concrete model and provider separately;
2. establish Level-1 wire compatibility;
3. prove Level-2 primitive semantics;
4. add one explicit provider/model profile;
5. run Level-4 operational/error tests;
6. measure Level-3 calibration/reliability on representative private cases;
7. commit exact source/provenance;
8. run the smallest live sample that can falsify the integration;
9. compare Mission conversion, not merely local API success.

If the backend requires inventing actions, bypassing Kernel/VERIFY, collapsing System2 into the same unconstrained model call, or weakening typed provenance, it is not a drop-in decision-model backend for V4.1.2.
