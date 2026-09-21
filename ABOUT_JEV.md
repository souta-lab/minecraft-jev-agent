# ABOUT_JEV

This note documents **what Jev actually is**, what is provider/gateway-specific, how this
repository uses it, and what our live evidence does and does not prove.

Updated 2026-09-21 after checking primary TypeSafe AI material, TypeSafe's published workflow
evals, Vercel AI Gateway's Jev integration, and this repository's live logs.

## 1. Executive summary

Jev is TypeSafe AI's first public **System One Model**: a model built for fast, bounded,
probabilistic decisions inside software rather than free-form string generation.

The useful mental model is not "a tiny chat LLM". TypeSafe describes a separate automation stack
with a new model architecture, a parallel sampler, and a training method called **Reinforcement
Learning for Calibrated Decisions (RLCD)**. A caller supplies program state plus typed questions;
Jev returns typed decisions and uncertainty estimates that code can consume directly.

For this Minecraft agent, Jev is therefore a natural fit for **WHICH** and **WHETHER** decisions
over already-grounded state. It is not, by itself, the long-horizon planner, the Minecraft world
model, the skill executor, or the source of deterministic game truth.

Jev's type-safe output does **not** imply that every decision is correct. TypeSafe's "no
hallucinations" claim should be read narrowly as a claim about the constrained output/schema
interface. The company explicitly discusses accuracy and calibration because the model can still
make wrong judgments.
## 2. What TypeSafe AI says Jev is

TypeSafe introduced Jev on 2026-09-15 as its first public System One Model. The "System One" name
borrows from the fast/intuitive side of the System 1 / System 2 distinction; "Jev" is named after
William Stanley Jevons. TypeSafe's point is economic as much as architectural: lowering the cost
of a unit of machine intelligence should make software use vastly more of it.

TypeSafe contrasts its System One stack with chat-style LLMs as follows:

| Dimension | Chat / generative LLMs | Jev / System One |
|---|---|---|
| Primary output | generated strings | typed decisions |
| Typical input framing | conversational/sequential messages | structured program state + questions |
| Sampling | autoregressive/sequential text generation | decisions sampled in parallel |
| Training target | commonly RLHF/RLVR objectives | RLCD: calibrated decisions |
| Uncertainty | often requested indirectly | probabilities/confidence are part of the interface |
| Intended use | prose, coding, reasoning, conversation | routing, scoring, classification, gating, verification |

TypeSafe calls Jev a "frontier-intelligence function call": state goes in and typed probabilistic
decisions come out.

Do **not** infer unpublished internals from that description. TypeSafe has publicly said it uses a
new model architecture and sampler, but it has not published enough detail to justify claims about
parameter count, Transformer vs. non-Transformer internals, hidden reasoning traces, exact training
corpus, or whether Jev is derived from any particular public LLM.
## 3. The three decision primitives

TypeSafe's first-party terminology has three primitives:

1. **Choice** — select one member of a caller-defined option set and return a probability
   distribution/confidence. TypeSafe says Jev supports Choice cardinality up to 255; very high
   cardinality choices may use a two-stage procedure internally.
2. **Score** — place the state on an ordered scale, returning a score plus a distribution/confidence.
3. **Noul** — a calibrated yes/no probability used for gates, filters, and boolean judgments.

The Vercel AI SDK exposes the Noul-shaped primitive as `type: 'boolean'`; that is an SDK/API naming
difference, not evidence that the model has a different fourth primitive.

Multiple questions can share one state and be evaluated in one request. TypeSafe emphasizes that
these outputs are produced in parallel rather than by generating prose token-by-token.

### Type safety is not semantic infallibility

TypeSafe states that schema/type matching is guaranteed: a Choice cannot suddenly become prose,
and a boolean-shaped answer cannot invent an arbitrary JSON shape. That is the strongest meaning
of the company's "can't hallucinate" / "zero hallucinations" language.

It does **not** mean Jev cannot choose the wrong option, assign a bad score, or produce a badly
calibrated probability on a particular example. TypeSafe's own evaluations compare accuracy and
calibration, and its product design explicitly encourages confidence thresholds and escalation of
uncertain cases. Treat Jev as bounded probabilistic intelligence, not an oracle.
## 4. Performance and cost claims — with caveats

TypeSafe publishes these first-party figures for Jev/System-One-shaped workloads:

- roughly **70–500 ms** end-to-end response time in its published material;
- **$0.042 per million input tokens** ($42/B input tokens) at the published first-party rate;
- output decisions are listed as free / too cheap to meter;
- up to **193.6x faster** and **444.6x cheaper** than comparison LLM configurations on TypeSafe's
  published workflow evaluations.

Those multipliers are **not general-purpose intelligence benchmarks**. TypeSafe explicitly says
they come from four System-One-shaped workflows, that the workflows were built by its own model
capabilities team, and that the reference probabilities use an average of very large external
models. TypeSafe itself says these gains are probably on the high end of real-world gains.

The more useful architectural result is that TypeSafe decomposes tasks into narrow independent
model judgments and ordinary code rules. On its published workflows, that structured harness is
more accurate, faster, and cheaper than asking a model to execute the whole policy as one large
prompt. That philosophy maps closely to this repository's Code/System2/Jev/Skill separation.

Published latency also depends on service location, network path, request size, and provider.
TypeSafe notes that its launch evals were generally measured from laptops on the US West Coast,
where its service was hosted. Do not treat 70 ms as a hard real-time guarantee.
## 5. Provider/gateway facts are not model-definition facts

This repository currently reaches Jev through Vercel AI Gateway / the Vercel AI SDK. Vercel lists
`typesafe-ai/jev` as an **evaluation model** and exposes it through `experimental_evaluate`:

```ts
const result = await evaluate({
  model: 'typesafe-ai/jev',
  state,
  questions,
})
```

That `evaluation` label describes Vercel's API surface. It should not replace TypeSafe's own model
class name, **System One Model**.

As of 2026-09-21, Vercel's public model listing shows a **32K context** for `typesafe-ai/jev` and a
promotional free price on AI Gateway (the listing says the promotion ends 2026-09-25). TypeSafe's
published base rate remains $0.042/M input tokens with free output. Provider-specific context,
pricing, quotas, and naming can differ, so keep these facts scoped to the transport being used.

Vercel's API calls the yes/no primitive `boolean`, while TypeSafe's first-party material calls the
underlying primitive **Noul**. Both represent a probability-shaped yes/no judgment.

`max_tokens` / prose-output tuning is not the useful control surface here. State size, question
decomposition, option cardinality, confidence handling, and the number of calls are the important
integration levers.
## 6. How this repository uses Jev

The repository's intended authority split is:

```text
Code    = CAN / TRUE / SAFE / DONE
System2 = WHAT
Jev π   = WHICH
Jev β   = WHETHER
Skill   = HOW
HOST    = lifecycle / durable state
```

The current Jev request asks several judgments over one projected world state:

| repository question | Jev primitive | intended role |
|---|---|---|
| `action` | Choice | π: choose one grounded candidate |
| `abandon_option` | Noul / SDK `boolean` | β: probability that the current Option should end |
| `danger` | Score | local risk estimate |
| `should_retreat` | Noul / SDK `boolean` | local retreat judgment |

The rule that Jev may choose only a code-generated candidate is **our architecture**, not an
intrinsic Jev limitation. The repository validates the returned Choice against the grounded
candidate set and rejects an unknown id.

Jev does not know Minecraft truth unless we put that truth in `state`. If a crucial fact is omitted,
stale, compressed away, or incorrectly summarized, a perfectly functioning Jev call can still
make a poor decision. Type safety cannot repair missing evidence.
## 7. Why Jev is a good fit for Minecraft — and where it is not

Jev's interface is unusually well matched to the high-frequency control layer of an embodied
agent when the environment adapter already provides grounded options:

- choose one action/Skill from a finite candidate set;
- score local danger;
- decide whether to retreat;
- estimate whether the current Option should be abandoned;
- make several of those judgments in one low-latency request.

That is much closer to a game policy head than to a chatbot turn.

But Jev should not be asked to compensate for a weak action abstraction. If the only Choices are
`MOVE:A`, `MOVE:B`, `MOVE:A`, `MOVE:B` at one-block granularity, Jev is still bounded to that poor
action manifold. A more intelligent model cannot choose a Skill that the system never exposes.

Similarly, long-horizon open-ended planning is a different problem. Jev does not generate an
arbitrary plan string or invent a new Minecraft program from scratch. In this architecture,
System2 remains responsible for semantic WHAT decisions, while Jev makes frequent bounded WHICH /
WHETHER judgments over grounded state.

This is why the right comparison is not "Jev vs. System2". They solve different temporal and
interface problems; a healthy agent uses each where its inductive bias is useful.
## 8. What issue #360 actually says about Jev

The live #360 audit is evidence that **Jev was running**, not evidence that Jev was absent or that a
deterministic fallback had silently taken over.

Over the audited ~48.5 minutes:

```text
Jev policy calls             ~2147
Jev beta outputs              2148
MOVE decisions                1888
WAIT decisions                 258
verified causal successes     1882
body-progress outcomes        1881
goal-progress outcomes           0
search-progress outcomes         0
OSCILLATION_DETECTED           401
System2 authority inputs         0
System2 authority decisions      0
```

The bot travelled about 1533 blocks cumulatively while ending only ~0.815 blocks from its starting
point. β never crossed the 0.5 abandon threshold, and the logged `SHADOW_METRICS` were identical
2148/2148 times despite overwhelming evidence of a stall.

That does **not** prove "Jev is too stupid for Minecraft". It proves the Jev-controlled loop was
making bounded decisions inside a badly stalled action/state regime, while System2 was not being
reconsulted. The root cause may include state projection, candidate granularity, progress evidence,
β conditioning, recovery semantics, or integration bugs. Those have to be isolated separately.
## 9. Integration rules for this repository

1. **Feed evidence, not conclusions.** Give Jev compact causal facts: current Option identity,
   grounded candidates, recent typed outcomes, progress kinds, recurrent-state evidence, and
   relevant safety state. Do not hide the very signal β is expected to judge.
2. **Keep Choice grounded.** Code defines CAN; Jev chooses WHICH. An unknown candidate id is an
   integration failure and must not become an implicit new action.
3. **Use confidence as data.** Do not collapse every probability immediately into a hard boolean.
   Confidence/calibration is one of the main reasons to use Jev.
4. **Do not confuse body movement with semantic progress.** A verified MOVE can be mechanically
   successful while the Option is strategically stalled.
5. **Prefer meaningful bounded Skills over microscopic reversible moves.** Jev is strongest when
   the option set corresponds to useful decisions, not when it is forced to re-decide every tiny
   actuator twitch.
6. **Keep System2 separate.** Local Jev uncertainty/stall evidence can justify reaching a semantic
   boundary, but Jev should not silently become the long-horizon WHAT planner.
7. **Treat provider metadata as provider metadata.** Vercel's context window, promotional price,
   model type, and SDK names can change independently of TypeSafe's underlying model design.
8. **Measure calibration on our distribution.** TypeSafe's published workflow results are useful
   evidence, but Minecraft state/action decisions are a different distribution. Track Jev's own
   confidence against actual downstream success, abandonment correctness, and causal progress.

## 10. What is still unknown publicly

Do not document guesses as facts about Jev's parameter count, exact neural architecture, hidden
state/reasoning mechanism, complete training set, or private evaluation suite. TypeSafe has said
there is a new architecture, parallel sampler, and RLCD training stack; that is the justified level
of specificity until the company publishes more.
## 11. Sources checked for this note

Primary / first-party TypeSafe sources:

- TypeSafe AI, **Introducing System One Models & Jev** (2026-09-15):
  https://typesafe.ai/blog/introducing-system-one-models-and-jev
- TypeSafe AI home/product material:
  https://typesafe.ai/
- TypeSafe AI published workflow evaluations:
  https://evals.typesafe.ai/

Provider / integration sources:

- Vercel AI Gateway, Jev model page:
  https://vercel.com/ai-gateway/models/jev
- Vercel, **TypeSafe AI's Jev now available on AI Gateway**:
  https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway

Repository evidence:

- GitHub issue **#360** — `recover_vertical_access` live oscillation audit.
- `buddy-driver/logs/jev/run.jsonl` for the measured Jev π/β activity described in §8.

## 12. One-line summary

**Jev is TypeSafe AI's fast, calibrated, typed System One decision model; in this agent it should be
treated as a high-frequency bounded policy/termination head whose intelligence is only as useful as
the state and grounded decision set we expose to it.**
