# Jev / System One Best Practices for Minecraft

**Status: CANONICAL OPERATING CONSTITUTION for the Typed Decision Plane.**
**Priority: second only to the permanent V4.1.2 Concurrent Verified Transition Runtime (VTR) contracts.**
**Reviewed: 2026-10-05.**

This document defines how Minecraft state, grounded candidates, decision epochs, typed questions, probabilities, model calls, and decision evidence must be shaped for Jev or any compatible typed decision model. It is an operating guide under the frozen V4.1.2 authority constitution; it does not create a new authority layer and never overrides Kernel/VERIFY ownership.

If this guide conflicts with V4.1.2 Kernel contracts, VTR wins and this guide must be repaired. If ordinary gameplay/policy code conflicts with this guide without a VTR reason, the gameplay/policy code is wrong.

The central rule is:

> **Do not use Jev as a small fast chat model. Compile Minecraft into a bounded decision problem, ask narrow independent judgments over one canonical decision state, let code apply probabilities and invariants, keep the chosen semantic action committed across mechanical realization, and VERIFY outcomes independently.**

---

## 0. Why this is constitutional

The p21-p24 campaign spent substantial engineering effort on downstream mechanics while the decision interface itself was inefficient and semantically over-sensitive. The last healthy hour of p24 before provider credit exhaustion makes the problem measurable:

- 1,215 successful TypeSafe Jev calls in 60 minutes: **20.25 calls/minute**;
- 8,616,491 input tokens: **7,091.8 input tokens/call on average**;
- mean model-facing state JSON: about **11,899 characters**;
- mean questions JSON: about **3,458 characters**;
- mean embedded semantic projection: about **3,698 characters**;
- duplicated outer+semantic representations of `goal`, `candidates`, `recentOutcomes`, and `inventory`: about **3,269 characters/call**;
- all 1,215 calls had exactly **one semantic candidate**, of kind `MOVE`;
- all 1,215 calls were the same coarse semantic situation: goal `explore`, option `explore:cave`, one `MOVE` candidate kind;
- all 1,215 model-selected actions were `MOVE`;
- nevertheless all 1,215 calls had different `projectionHash` values.

At TypeSafe's published Jev input rate of $0.042/M tokens, that one hour is about $0.362 of Jev input. The bigger problem is architectural: **physical/progress micro-deltas were sufficient to manufacture fresh decision identities even though the semantic decision shape did not change.**

This is not proof that high call rates are inherently wrong. TypeSafe's own Doom launch demo ran roughly 10 queries/second. It is proof that **call cadence must be justified by decision cadence**, not by raw-state churn, and that state volume must consist of decision-relevant evidence rather than duplicated runtime/debug representations.

Until the compact-state + decision-epoch gates in §18 pass, resuming the portal campaign is lower priority than repairing this layer.

---

## 1. Evidence hierarchy used for this guide

### A. First-party TypeSafe sources — highest external weight

1. TypeSafe AI, *Introducing System One Models & Jev* (2026-09-15)  
   https://typesafe.ai/blog/introducing-system-one-models-and-jev
2. TypeSafe System One API / OpenAPI (`POST /v1/systemone`)  
   https://api.typesafe.ai/docs  
   https://api.typesafe.ai/redoc
3. TypeSafe Workflow Evals  
   https://evals.typesafe.ai/
4. TypeSafe product material / pricing  
   https://typesafe.ai/

First-party claims establish the intended primitive: structured program state, predeclared typed outputs, parallel answers, probabilities/confidence, code-composed workflows, and real-time use.

### B. Public implementations — implementation evidence, not vendor guarantees

- `fhshaik/typesafe-mario` — compact object-centric emulator state, code-derived timing facts, Choice+Noul+Score in one request.  
  https://github.com/fhshaik/typesafe-mario
- `shantanugoel/mario-jev` — movement/jump heads in one request, bounded history, landing interruption, recorded replay.  
  https://github.com/shantanugoel/mario-jev
- `sorrycc/typesafe-snake` — legal moves + flood-fill/dead-end facts computed in code; one Choice per tick; deadline fallback.  
  https://github.com/sorrycc/typesafe-snake
- `browser-use/jev-ultrafast` — dynamic observed action space, operation + speculative target heads in one request, freshness/occlusion checks, independent DONE verification.  
  https://github.com/browser-use/jev-ultrafast
- `HarnessRouter/SystemOneHarness` — observe→compile→encode→decide→gate→execute, finite action space, confidence gates, short history in realtime loops, complete traces.  
  https://github.com/HarnessRouter/SystemOneHarness
- `TypeSafeAI/typesafe-router` and community playground — closed-set selection, deterministic validation/gating, singleton/local graph behavior, explicit fallbacks.  
  https://github.com/TypeSafeAI/typesafe-router  
  https://github.com/TypeSafeAI/typesafe-playground

TypeSafe's official Doom launch description is useful evidence for high-frequency structured-state use, but as of this review the launch post promises an in-depth walkthrough rather than providing the original Doom controller source. Community “JevDoom” projects are separate demonstrations and must not be presented as the official implementation.

### C. Independent evaluation — secondary evidence

Recent independent work reinforces several design cautions:

- *Evaluating and Benchmarking the System One Model Jev* (2026) reports strong Choice calibration/selective prediction but shows that fixed Noul thresholds can be task-dependent.  
  https://arxiv.org/abs/2609.37647
- *Beyond Calibration: Do a Typed-Decision Model's Probabilities Obey the Probability Axioms?* (2026) finds item-level coherence gaps across logically related separately-worded questions.  
  https://arxiv.org/abs/2609.33209
- *JevAdvBench* (2026) reports that adversarial or merely persuasive text inserted into state can shift otherwise well-typed decisions.  
  https://arxiv.org/abs/2609.31142

These papers do not override first-party behavior or our own measurements. They justify enforcing logical invariants and trust boundaries in code rather than assuming probabilities from separate heads are mutually coherent or adversarially robust.

### D. This repository's own evidence — highest weight for Minecraft behavior

Private p21-p24 logs, exact source/provenance, replayable decision records, VERIFIED outcomes, and Mission conversion determine whether a proposed Minecraft integration is actually better. Public demos are patterns, not proof for our distribution.

---

## 2. The correct mental model

TypeSafe describes Jev as a System One Model: state goes in; typed probabilistic decisions come out. Its public API supports:

- **Choice** — one label from a caller-defined finite set + distribution/confidence;
- **Noul** — `P(true)` for one direct yes/no judgment;
- **Score** — an ordinal judgment over caller-defined ordered levels + distribution/confidence.

Multiple questions share one `state` and are evaluated in one request. TypeSafe explicitly frames reliable automation as **many independent, decomposed judgments plus ordinary program rules**, not one giant prompt that owns the whole policy.

For Minecraft:

```text
Mineflayer/world observations
        ↓
deterministic feature extraction
        ↓
canonical DecisionState
        ↓
grounded finite semantic candidate space
        ↓
independent typed heads in ONE System One request
        ↓
probabilities / distributions
        ↓
code-owned gate + freshness + VTR admission
        ↓
committed Transition Controller realization
        ↓
VERIFY + causal outcome trace
```

Jev is not a planner, world simulator, pathfinder, calculator, lifecycle owner, executor, or verifier.

---

## 3. Public implementation patterns that transfer to Minecraft

### 3.1 Doom: high frequency is legitimate when the decision is actually real-time

TypeSafe's launch demo describes roughly 10 queries/second and about $7/hour on a structured game-state representation. The important lesson is **not** “query constantly.” It is:

- high-frequency calls are an intended use case;
- the state is structured game state, not images;
- cost must be understood as `call rate × input size`;
- a reactive game may justify high call rates if each call corresponds to a fresh control decision.

Minecraft is not Doom. A `collect log` skill digging or walking for several seconds often does **not** create a new semantic WHICH decision every few ticks. We must distinguish real control boundaries from raw world updates.

### 3.2 TypeSafe Mario: canonical model state, raw debug state separate

`typesafe-mario` translates RAM/telemetry into compact object-centric JSON. Its raw local tile grid remains available for debugging/UI but is not duplicated in model input.

Transfer rule:

> **Maintain a rich debug/world snapshot for observability and a separate canonical decision snapshot for the model. Never send both representations simply because both exist.**

The Mario parser also computes timing arithmetic in code, including derived facts such as whether a jump must start on the current decision. Jev judges those facts rather than being asked to perform exact timing arithmetic.

Minecraft equivalent: code computes distances, inventory counts, reachability, tool tier, exposure, resource deltas, elapsed lease progress, trajectory recurrence, and threshold crossings. The decision model judges WHICH/WHETHER from those facts.

### 3.3 Mario-Jev: parallel heads + event-driven interruption + bounded history

`mario-jev` asks movement, start-jump, ceiling-hop, and sustain-jump judgments in one request. Code uses only the head relevant to the current grounded/airborne situation. The runner advances several emulator frames under the chosen action, but landing interrupts that commitment and immediately creates a new decision point.

It also makes history length explicit: more history increases input cost, not requests per decision. Jump state that must survive history truncation is maintained as a derived persistent feature (`current_jump`) rather than by keeping an unbounded raw transcript.

Minecraft transfer:

- batch independent heads sharing one state;
- hold an admitted semantic action across its mechanical microsteps;
- interrupt on meaningful events, not every position update;
- represent persistent causal memory as bounded derived facts, not a growing event dump.

### 3.4 Snake: exact affordances in code; Jev chooses among them

`typesafe-snake` computes legal moves, food-distance facts, flood-fill reachable-cell counts, and dead-end facts in code. Jev receives those exact facts and chooses among legal moves. If a decision misses the real-time deadline, the current direction continues rather than inventing a new action.

Minecraft transfer:

- path/reachability and exact geometry belong to code;
- “candidate A is reachable”, “candidate B consumes protected resource”, “candidate C reduces distance to sensed log” are compiled facts;
- model latency may delay a **new** semantic decision but must not erase a valid existing lease or fabricate a fallback semantic action.

### 3.5 Browser Use: dynamic observed action space + speculative parallel target heads

`jev-ultrafast` builds its action space from the current observed DOM. In one request it asks for an operation plus operation-specific target heads. Only the target head matching the chosen operation may execute. The executor rechecks freshness and occlusion before mutation; a valid `DONE` choice still requires independent verification.

Minecraft transfer:

- compile only currently grounded semantic actions;
- where a decision factors naturally into operation + target family, parallel heads can remove sequential round trips;
- unused speculative heads are evidence only and cannot execute;
- stale decisions are rejected against live VTR bindings;
- `DONE`/success is never trusted from model output; VERIFY owns it.

### 3.6 SystemOneHarness: compile first, then decide, then gate

SystemOneHarness describes the loop as:

```text
observe → compile → encode → decide → gate → execute → trace
```

It uses finite actions, risk-dependent probability thresholds, explicit terminal reasons, and complete state/question/distribution traces. In realtime environments it keeps history short and lets the last action remain active until it changes.

Minecraft transfer:

- candidate compilation precedes model inference;
- model probability is evidence entering a code-owned gate;
- execution happens only after VTR admission/freshness checks;
- real-time does not imply re-deciding an unchanged semantic action every frame/tick.

---

## 4. DecisionState constitution

### 4.1 Decision state, not world dump

Every field sent to the model must answer:

> **Which currently active typed question needs this field to distinguish among its legal answers?**

If there is no answer, the field belongs in debug/evidence storage, not `DecisionState`.

Forbidden by default:

- raw block/entity lists when code can summarize the relevant affordance;
- duplicate `goal`, `inventory`, `candidates`, `recentOutcomes`, or safety facts in outer + semantic forms;
- full scheduler/kernel/runtime objects;
- raw logs or arbitrary recent text;
- facts included “just in case” with no active question consumer;
- long narrative policy explanations that restate facts already represented structurally.

### 4.2 One canonical representation per semantic fact

A model-facing concept gets exactly one authoritative representation.

Bad:

```text
state.goal = ...
state.semantic.goal = ...
state.signals.currentGoal = ...
state.goalQueue.current = ...
```

Good:

```text
intent: {
  missionKey,
  optionKey,
  successGap
}
```

The rich originals remain available to logs, VTR, observer, and offline analysis. They are not all model input.

### 4.3 Compute precision in code

Code owns:

- arithmetic and counting;
- coordinates and vector math;
- distances, deltas, rates, elapsed time;
- inventory quantities and surplus;
- path/standability/reachability checks;
- geometry/collision facts;
- resource protection;
- exact threshold crossings;
- recurrence counts and causal-progress windows;
- dates/timers/budgets;
- deterministic success predicates.

This is consistent with TypeSafe's workflow guidance and public implementations. Jev judges the semantic consequence of the already-computed facts.

### 4.4 Suggested Minecraft state shape

The exact schema may evolve, but the shape should remain compact and semantic:

```ts
type DecisionState = {
  intent: {
    missionKey: string
    optionKey: string | null
    prerequisiteKey: string | null
    successGap: string
  }
  body: {
    healthBand: string
    foodBand: string
    airBand: string
    dimension: string
    threatBand: string
  }
  progress: {
    goalDelta: string
    searchDelta: string
    reachabilityDelta: string
    failureBand: string
    trajectoryChurn: boolean
  }
  commitment: {
    activeActionKey: string | null
    phase: string | null
    stillGrounded: boolean
  }
  candidates: Array<{
    id: string
    kind: string
    purpose: string
    relevantFacts: Record<string, string | number | boolean>
  }>
  recent: Array<{
    actionKey: string
    outcomeClass: string
    semanticDelta: string
  }>
}
```

This is an illustrative contract, not a new architecture. Fields exist only if replay evidence shows that the active questions need them.

---

## 5. Candidate-space best practices

### 5.1 Code owns CAN; the model owns judgment among CAN

Every Choice label must resolve to a code-grounded semantic action or explicitly defined control action (`WAIT`, `ESCALATE`, etc.). Unknown IDs fail closed.

The model must never emit:

- coordinates;
- block/entity IDs it invented;
- arbitrary tool names;
- path waypoints;
- controller code;
- free-form Minecraft actions.

### 5.2 Candidates should be semantic commitments, not actuator twitches

A healthy candidate should answer a meaningful question such as:

- continue toward the sensed log cluster;
- take the alternate surfaced route;
- retreat behind the grounded obstacle;
- mine the verified blocking cell to realize the active route;
- abandon the exhausted Option and escalate to System2.

A stream of `MOVE:x1`, `MOVE:x2`, `MOVE:x3` that all realize one already-chosen route should normally belong to one controller commitment, not three new semantic selections.

### 5.3 Stable semantic identity; variable realization underneath

Mechanically equivalent realizations may change as Mineflayer moves. Their semantic decision identity should remain stable until a fact appears that can change the relevant judgment.

Do not let changing coordinates, scheduler revisions, heartbeat counters, or a newly mined support block alone manufacture a new WHICH question if the semantic commitment is unchanged.

For generic explore `MOVE` candidates, key the commitment by the compiler's stable search purpose. A derived corridor anchor may appear or disappear as body alignment changes; named approach targets and changed search purposes remain distinct identities.

### 5.4 Singleton candidates: fix the epoch, not authority with a hack

Some public harnesses resolve deterministic singleton target heads locally. Our frozen V4.1.2 has stricter ownership rules and historical tests preventing an ad-hoc `candidateCount == 1 -> skip Typed Decision Plane` policy bypass.

Therefore:

> **Do not add a singleton shortcut merely to save calls. Instead, prevent mechanical continuation from opening a fresh semantic decision epoch.**

If a genuine V4.1.2 semantic epoch legally contains one candidate and the constitution requires model authority, preserve that rule. The defect is repeated false epochs, not the absence of a cheap bypass.

---

## 6. Question design

### 6.1 One judgment per head

Prefer direct heads:

- Choice: which grounded semantic action best advances the current Option?
- Noul: should the current Option terminate now?
- Noul: is the currently committed route no longer viable?
- Score: what is the immediate danger band?

Do not combine several predicates into one convoluted instruction and then rely on the model to implement a hidden state machine.

### 6.2 Positive, literal, local wording

Jev is a typed decision model, not an instruction-following chat model. Instructions should be:

- direct;
- positive where possible;
- scoped to one named state object;
- explicit about what each criterion means;
- free from double negatives and long policy essays.

Criteria carry option-specific meaning. Structural facts carry state. Instructions define the judgment. Do not make instructions carry the whole Minecraft architecture every call.

### 6.3 Batch independent heads sharing one snapshot

If multiple judgments genuinely refer to the same state, ask them in one System One request. TypeSafe's sampler is explicitly designed for parallel outputs.

Useful Minecraft batching can include:

```text
action Choice
abandon_option Noul
route_invalid Noul
immediate_danger Score
```

Only include a head if its answer can affect the current code path or if speculative batching avoids a known sequential round trip and the unused answer cannot execute anything.

### 6.4 Do not assume separate heads are logically coherent

Parallel heads do not see each other's answers. Independent research also finds item-level coherence gaps between logically related Jev questions.

Therefore code enforces identities such as:

```text
P(A) + P(not A) == 1     // do not assume separate Noul calls satisfy this
selected candidate exists
selected candidate is enabled
retreat and attack constraints are mutually admissible
abandon cannot itself establish Option success
```

If a logical relation is mandatory, encode it structurally or enforce it after inference.

### 6.5 Noul is a probability, not a boolean

Preserve raw `P(true)`. The threshold belongs to application policy and must be calibrated for the concrete model/domain.

`0.5` is not universally meaningful. Independent Jev evaluation shows some binary tasks improve materially with task-specific thresholds. d1 thresholds must be measured separately from Jev thresholds.

### 6.6 Score is ordinal evidence, not precision arithmetic

Use Score for ordered semantic rubrics such as danger bands. Do not reconstruct precise distances, time-to-contact, expected damage, or numeric risk by interpolating Score levels. Compute exact quantities in code.

---

## 7. Query cadence and decision epochs

### 7.1 A model call needs a decision reason

Every production request must carry a typed `decisionReason`/epoch cause that is one of a bounded set such as:

- semantic candidate set materially changed;
- active Option changed;
- active candidate invalidated;
- controller reached a semantic completion/failure boundary;
- health/food/air/threat crossed a policy-relevant band;
- new grounded resource/route evidence changes candidate meaning;
- trajectory/progress evidence crossed an abandon/escalate boundary;
- action lease ended and a new semantic choice is required.

Forbidden as sole reasons:

- heartbeat elapsed;
- body position changed slightly;
- scheduler/fact revision incremented without decision-relevant meaning;
- the same controller action performed another microstep;
- a debug field changed;
- “we call Jev every N ticks” without a real-time control requirement.

### 7.2 Commit decisions across mechanical realization

Once VTR admits a semantic action, its controller realizes that action over many physical steps until:

- VERIFY succeeds;
- a typed terminal/failure occurs;
- the lease/contract becomes stale;
- a decision-relevant interrupt invalidates the commitment.

This is the Minecraft equivalent of Mario holding an action for several frames and re-querying immediately on landing.

### 7.3 Event interrupts must be meaningful

Examples that may create a new decision epoch:

- landing/takeoff/immersion changes locomotion class;
- selected target disappears or becomes unreachable;
- health crosses healthy→wounded→critical;
- hostile enters contact/reaction range;
- breathable space disappears;
- Option success/failure evidence changes;
- route acquires a new grounded alternative;
- target-resource/frontier delta changes;
- causal no-progress window crosses its policy threshold.

Raw event volume is not itself a decision boundary.

### 7.4 Real-time deadline behavior

If a fresh decision misses a bounded deadline:

- do not invent another semantic action;
- preserve the current still-valid committed action where its controller contract allows;
- otherwise transition to a code-owned safe hold/typed failure state;
- stale late answers are dropped by normal binding/freshness rules.

Snake's “keep going straight” pattern and SystemOneHarness realtime behavior demonstrate the general principle: **latency does not grant a fallback model semantic authority.**

---

## 8. Bounded causal memory

History is useful only when it changes the current judgment.

Prefer derived memory:

- last semantic action + outcome class;
- current committed route identity;
- current Option age band if relevant;
- consecutive causal failure class;
- target-resource/search/reachability delta;
- trajectory recurrence/churn flag;
- current threat-contact episode;
- persistent jump/vertical-route phase.

Avoid replaying large raw outcome histories on every call.

The Mario pattern is instructive: bounded recent transitions are kept, while `current_jump` persists separately so critical causal state is not lost when the history window slides.

For Minecraft, persistent causal state belongs in typed code-owned summaries, not an ever-growing transcript.

---

## 9. Probability, gating, and effective action

### 9.1 Record original model evidence separately from effective code action

A trace must distinguish:

```text
model choice/distribution
model/provider confidence
application threshold
VTR/freshness/guard verdict
effective admitted action
execution outcome
VERIFY outcome
```

Never overwrite a low-confidence or rejected model answer with the fallback/effective action in the log.

### 9.2 Consequence-aware thresholds

Threshold policy may differ by semantic consequence. A reversible local observation/WAIT can tolerate more uncertainty than an irreversible world mutation or dangerous combat commitment.

Thresholds are model-specific and distribution-specific. Jev calibration evidence does not transfer automatically to Liquid d1.

### 9.3 Low confidence means bounded escalation, not hidden policy

When uncertainty is too high, code may:

- keep a still-valid current lease;
- expose/choose an explicit `ESCALATE` control path;
- request System2 WHAT repair at a legitimate boundary;
- stop/hold under a typed failure if no safe continuation exists.

It must not silently choose the runner-up candidate as if the model had authorized it.

---

## 10. Freshness, trust, and verification

### 10.1 Bind answers to the exact state they judged

Every request/answer remains bound to the V4.1.2 decision epoch, world/generation identity, semantic projection version/hash, candidate-set identity, and relevant revisions. Re-derive/recheck before admission.

### 10.2 Treat untrusted text as data

Browser-use explicitly treats page text as untrusted. Minecraft normally has more trusted engine facts, but signs, books, chat, player names, server text, imported instructions, and external content may be adversarial or misleading.

Do not mix untrusted prose into model instructions. Tag it as data and keep deterministic authority facts structurally separate.

### 10.3 Typed output is not VERIFY

A valid `Choice`, a high probability, `DONE`, or `abandon=true` proves only what the model judged. World truth is established by normal VTR observation/VERIFY.

---

## 11. Retry and provider behavior

- A semantic decision request has a bounded attempt budget.
- Provider retries must not duplicate world mutations.
- Non-retryable auth/credit/model-identity failures stop the provider lane immediately.
- Repeated identical availability errors do not create fresh Minecraft generations.
- No silent alternate-model fallback.
- Provider/model/profile/source identity is explicit in every decision trace.
- Secrets stay outside model state, logs, argv, repo, and evidence artifacts.

Public Mario implementations disable or tightly bound retries because each decision is a paid real-time request. This matches our existing no-infra-churn constitution.

---

## 12. Payload and cost discipline

### 12.1 There is no magic token cap

Do not optimize to an arbitrary small number and accidentally delete evidence. TypeSafe's own launch note says production workflows can be substantially more complex than its simplified side-by-side demo.

The correct rule is **dominance**:

> A smaller DecisionState is better only when it preserves or improves calibrated decisions and downstream verified outcomes on representative replay/holdout cases.

### 12.2 Structural budget rules are mandatory

Even without a fixed token cap:

1. one semantic fact appears once;
2. every field has at least one active question consumer;
3. raw/debug forms stay out when a canonical derived form exists;
4. exact computations are code-derived before inference;
5. history is bounded and causal;
6. fixed question instructions are concise and versioned;
7. input tokens, per-section serialized size, latency, and usage are logged;
8. any source change that materially increases median input size must explain the new decision evidence it buys.

### 12.3 Cost is call rate × input size

Do not debate call frequency in isolation. Doom shows that very high query frequency can be legitimate. Our p24 hour shows that a slower 20.25 calls/min still becomes expensive when each call is ~7.1K tokens and the same semantic shape is re-evaluated continuously.

Measure both:

```text
calls / semantic transition
calls / minute (diagnostic only)
input tokens / call
input tokens / verified transition
input dollars / Mission delta
```

The Mission-normalized metrics matter most.

---

## 13. Current p24 root diagnosis

The last healthy TypeSafe Jev hour is a canonical anti-pattern fixture.

Observed:

```text
1215 calls
1215 unique projectionHash values
1215 / 1215 coarse semantic signatures identical
1215 / 1215 semantic candidate count = 1
1215 / 1215 candidate kind = MOVE
1215 / 1215 selected action kind = MOVE
goal = explore:explore:1 throughout
option template = explore:cave throughout
```

This means:

1. `projectionHash` freshness was far more sensitive than actual semantic WHICH identity;
2. controller/body progress repeatedly reopened the Typed Decision Plane even though there was no alternate action class;
3. the action Choice was effectively a one-label confirmation request;
4. beta/abandon was polled at the same microstep cadence instead of at a deliberately designed causal-progress boundary;
5. state carried both compact semantic projection and overlapping outer runtime state;
6. long fixed instructions were resent on every call.

Do **not** fix this with a cost-only throttle or `candidateCount==1` bypass. Fix:

- semantic decision epoch definition;
- controller commitment lifetime;
- model-facing state projection;
- question decomposition/cadence;
- beta progress evidence and trigger policy.

A throttle can hide the defect while preserving the wrong interface.

---

## 14. Proposed Minecraft decision-plane split

A healthy V4.1.2 integration should look like:

```text
WORLD / KERNEL / CONTROLLER TRUTH
       │
       ├── rich debug snapshot ───────────────→ logs / observer / replay
       │
       └── deterministic compiler
                 │
                 ├── exact calculations
                 ├── relevant affordances
                 ├── stable semantic identities
                 ├── causal progress summary
                 └── bounded safety summary
                         │
                         v
                  DecisionState/vN
                         │
         ┌───────────────┼────────────────┐
         v               v                v
    action Choice   abandon Noul    optional heads
         └───────────────┼────────────────┘
                         v
                one System One call
                         v
              typed probabilities
                         v
          code gate + stale validation
                         v
              VTR admitted action
                         v
          controller many microsteps
                         v
                      VERIFY
```

The rich debug snapshot is intentionally **not** the model payload.

---

## 15. Replay-first redesign protocol

Before another portal run, use existing p23/p24 traces as a private evaluation corpus.

### 15.1 Freeze a baseline corpus

Sample across:

- ordinary resource progression;
- combat/survival;
- vertical recovery;
- post-death recovery;
- trajectory churn;
- candidate invalidation;
- Option abandonment/escalation;
- successful frontier conversion;
- known failures.

Keep a sealed holdout subset not used to design the compact schema.

### 15.2 Recompile old world states into candidate DecisionState versions

For each recorded decision, produce:

```text
old model payload
candidate compact payload
exact questions/version
legal candidate set
recorded model answer/distribution
recorded downstream execution + VERIFY + semantic/Mission delta
```

### 15.3 Compare decision quality, not textual similarity

Measure:

- chosen semantic candidate agreement where the old choice was later verified useful;
- probability assigned to candidates that later produced semantic progress;
- beta/termination discrimination on eventual progress vs churn;
- high-confidence wrong-decision rate;
- calibration/reliability by head;
- stale/invalid decision rejection;
- input tokens and latency;
- calls that would be suppressed by the new epoch rules.

The old model is not the ground truth. Recorded downstream evidence and VTR outcomes matter more.

### 15.4 Separate model migration from state redesign

Jev and Liquid d1 may react differently to the same compact state. Evaluate each concrete model separately. Do not change state schema, threshold, and backend simultaneously and then attribute improvement to one of them.

### 15.5 Holdout before live

A compact-state design is KEEP only if it dominates or acceptably trades off the old design on a sealed replay set. Token savings alone are `LOCAL_ONLY` and do not justify production.

---

## 16. Required instrumentation

Every Typed Decision Plane call must eventually make these inspectable without reconstructing giant logs:

```text
decisionStateVersion
decisionReason / semantic epoch cause
stateHash
candidateSetHash
provider / model / profile / reportedModel
question-set version
serialized bytes/tokens by state section
serialized bytes/tokens by question head
latency
usage
raw typed answers + distributions/confidence
application thresholds/gates
effective admitted action
stale/reject reason
controller terminal
VERIFY outcome
semantic progress delta
Mission delta
```

Maintain aggregate counters:

- calls per controller commitment;
- calls per semantic epoch cause;
- calls with 0/1/2+ semantic candidates;
- repeated coarse semantic signatures;
- input tokens per head/state section;
- provider cost per verified transition and Mission delta.

This turns future cost/quality questions into measurements rather than archaeology.

---

## 17. Anti-patterns — reject in review

1. **World-dump prompting:** serializing most runtime state because the model “might need it.”
2. **Dual representation:** sending raw + semantic copies of the same facts.
3. **Prompt-manual inflation:** thousands of characters of policy prose repeated every call instead of structural state/code rules.
4. **Heartbeat inference:** periodic queries with no semantic boundary.
5. **Microstep WHICH:** reopening semantic selection for every block/movement realization of an already-committed action.
6. **Jev as calculator:** asking the model to count, compare exact quantities, compute distance/time, or enforce resource arithmetic.
7. **Hidden selector code:** deterministic code silently ranking semantic alternatives that belong to the Typed Decision Plane.
8. **Model-owned reality:** accepting model output as target existence, success, resource truth, or safety truth without normal observations/VERIFY.
9. **Threshold inheritance:** reusing Jev confidence/Noul thresholds on d1 without calibration evidence.
10. **Question coupling assumptions:** assuming separately asked Noul/Choice heads satisfy logical identities.
11. **Infinite history:** replaying raw events instead of derived causal state.
12. **Retry churn:** repeated provider retries/generations after one decided availability fingerprint.
13. **Cost-only throttling:** lowering query frequency while preserving the wrong decision boundary.
14. **Benchmaxx compression:** removing difficult evidence because it lowers tokens or improves a familiar replay.
15. **Success by API health:** calling the integration fixed because requests are fast/cheap/well-typed while Mission conversion remains poor.

---

## 18. Mandatory gate before portal-p24 resumes

Minecraft gameplay remains parked until these are satisfied in order.

### Gate A — canonical projection audit

- enumerate every current model-facing state field;
- identify the question(s) that consume it;
- identify duplicate representations;
- classify exact-computable vs judgment evidence;
- log serialized size/token contribution by section.

### Gate B — compact DecisionState

- introduce one versioned canonical model-facing state;
- raw/debug runtime state remains in evidence logs but is not duplicated into inference;
- exact computations move to code-owned derived facts;
- question instructions are reduced to direct judgments + criteria.

### Gate C — semantic epoch/commitment repair

- physical microsteps of one admitted semantic action do not automatically reopen WHICH;
- query reasons are typed and logged;
- meaningful interrupt boundaries are explicit;
- no ad-hoc single-candidate authority bypass.

### Gate D — parallel-head contract

- independent heads sharing one snapshot batch in one request;
- unused speculative heads cannot execute;
- each head has a documented application consumer and threshold/gate.

### Gate E — replay + holdout proof

- p23/p24 representative replay corpus;
- sealed holdout;
- old vs compact state compared on decisions/probabilities/downstream outcome evidence;
- Jev and d1 evaluated separately where provider access exists;
- no quality regression hidden by token reduction.

### Gate F — calibration + threshold proof

- d1 Noul/Choice behavior measured separately from Jev;
- beta/abandon threshold justified by replay evidence;
- consequence-aware gate policy recorded;
- high-confidence error cases retained.

### Gate G — operational proof

- timeout/abort/stale/provider errors fail safely;
- no silent fallback;
- usage/provenance complete;
- no generation churn on provider outage.

### Gate H — bounded live composition proof

Only after A-G pass, run the smallest live source-bound sample that can falsify the new decision interface. Inspect **calls per semantic commitment, tokens per call, stale/requery causes, and verified semantic progress** before returning to ordinary portal progression.

No Nether campaign credit is awarded merely for lower Jev/d1 spend. The interface must improve or preserve autonomous composition quality.

---

## 19. Relationship to VTR, System2, and model backends

This guide changes no V4.1.2 owner:

- **VTR/Kernel** still owns lifecycle, truth, resources, effects, budgets, Mission, journal, and SUCCESS;
- **Typed Decision Plane** still owns bounded tactical/semantic WHICH/WHETHER according to the frozen architecture;
- **System2** still owns sparse WHAT/decomposition/repair;
- **Controllers** still realize admitted transitions;
- **VERIFY** still establishes success.

The guide changes **how evidence is compiled and when a decision is actually requested**.

Jev and Liquid d1 are concrete backends for the same normalized plane. Backend transport compatibility is governed by `TYPED-DECISION-MODELS.md`; this document governs Minecraft-side decision-state and runtime use.

---

## 20. Review checklist

Before merging any Typed Decision Plane change, answer all of these:

### State
- Does every field serve an active question?
- Is any semantic fact duplicated?
- Could any exact quantity be computed in code instead?
- Is raw/debug state leaking into model state?
- Is history causal and bounded?

### Candidates
- Are all candidate IDs grounded and executable?
- Are candidates semantic commitments rather than microsteps?
- Is mechanically variable realization hidden beneath stable semantic identity?
- Is there an explicit uncertainty/escalation path where needed?

### Questions
- Is each head one direct judgment?
- Are independent heads sharing one state batched?
- Are criteria direct and aligned with instructions?
- Are logical relations enforced in code rather than assumed across heads?

### Cadence
- What exact semantic boundary triggered this call?
- Could the existing lease/commitment continue instead?
- Would this call still happen if position/revision noise were removed?
- What interrupt ends the commitment?

### Probability/gating
- Is raw probability preserved?
- Is the threshold calibrated for this concrete model/domain?
- Are original and effective decisions logged separately?
- Can a low-confidence answer fail/escalate without hidden semantic fallback?

### Proof
- Is the exact model-facing payload replayable?
- Is cost/token size observable by section?
- Is the downstream VERIFY/Mission outcome joined to the decision?
- Did replay/holdout quality survive the optimization?

A “no” to any required item blocks production KEEP unless the V4.1.2 constitution explicitly requires otherwise and that exception is documented.

---

## 21. One-page Minecraft rule set

If only one section is remembered, remember this:

1. **Observe richly; infer narrowly.** Rich world/debug state is not model state.
2. **Compile before calling.** Code computes exact facts and legal semantic actions.
3. **One fact, one representation.** No raw+semantic duplicates.
4. **Ask gut-check-sized judgments.** One direct judgment per head.
5. **Batch parallel heads.** Same snapshot, one request, code consumes only relevant answers.
6. **Commit semantic actions.** Controllers get many mechanical steps; Jev/d1 is not a per-block joystick unless the task genuinely is real-time control.
7. **Re-query on meaning, not revision numbers.** Typed epoch causes only.
8. **Use probabilities in code.** Thresholds/gates are model-specific and consequence-aware.
9. **Never let the model create reality.** Candidates, resources, effects, and SUCCESS remain grounded/verified.
10. **Replay before live.** Compactness must preserve decision quality on private evidence.
11. **Measure per Mission delta.** Cheap calls that do not convert are still waste.
12. **VTR first, this guide second.** Do not “optimize Jev” by violating the permanent authority constitution.

---

## 22. Final principle

The System One advantage is not merely that Jev/d1 is cheap and fast. The advantage is that **software can own the compute graph while the model contributes bounded probabilistic judgment exactly where deterministic rules become brittle.**

For Minecraft, the best Typed Decision Plane is therefore not the one that sees the most world state or is called the most often. It is the one that receives the **smallest sufficient causal decision state**, sees **all and only the grounded semantic alternatives that matter now**, returns **well-measured probabilities**, and then stays out of the way while VTR/controllers realize and verify the chosen transition.

That is the standard this repository must meet before further portal-campaign tuning.
