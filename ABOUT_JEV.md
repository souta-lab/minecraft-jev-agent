# ABOUT_JEV

What Jev is, what the gateway says it can do, how this repository uses it, and what the live
logs prove about that usage. Written 2026-09-21 from the gateway model catalog plus live runs;
every claim below is measured, not assumed.

## 1. What the model actually is

Authoritative entry from the AI Gateway catalog (`GET https://ai-gateway.vercel.sh/v1/models`):

```json
{
  "id": "typesafe-ai/jev",
  "name": "Jev",
  "owned_by": "typesafe-ai",
  "description": "Jev is TypeSafe AI's System One evaluation model for fast, structured decisions in
     software. It evaluates shared state against typed questions and returns choices, scores, and
     boolean probabilities, supporting classification, routing, rubric-based assessment, and
     automated verification. Multiple questions can be evaluated in parallel within a single request.",
  "context_window": 32000,
  "max_tokens": 0,
  "type": "evaluation",
  "supported_specifications": ["v4"],
  "pricing": { "input": "0.000000042", "output": "0" }
}
```

Three consequences that matter operationally:

1. **`type: evaluation` is not decoration.** The gateway serves the *evaluation* API only for
   evaluation models. Verified directly:
   ```text
   evaluate('meta/muse-spark-1.3-contributor')
     -> "Model ... is a language model, not an evaluation model. Use the language generation API instead."
   evaluate('typesafe-ai/jev')
     -> OK {"horizon":{"type":"choice","choice":"b","probabilities":{"a":0.17,"b":0.83}}}
   ```
   So the Jev role cannot be handed to a language model by changing an id; the call shape has to
   change too (see §4).
2. **`max_tokens: 0`.** Jev does not return prose. It answers typed questions with structured
   values; there is no output text to parse, and no output-token cost.
3. **`context_window: 32000`.** Far smaller than the 1M-token muse models. The state sent to Jev
   must stay compact — which is why `authorityState()` projects a small view (see §3).

## 2. How this repository calls it

`jev-agent/src/jev-authority.ts` imports `experimental_evaluate as evaluate` from `ai` and issues
one request carrying **several typed questions in parallel** (the catalog advertises exactly this):

```ts
const response = await evaluate({ model: this.model, state: modelState, questions, maxRetries: 0, abortSignal })
```

Questions the repository asks (`jevQuestionSet`):

| name | type | role in the architecture |
|---|---|---|
| `action` | `choice` over the *grounded* candidate ids | Jev π: which grounded action to take |
| `abandon_option` | `boolean` (true = end the Option) | Jev β: whether the current Option is exhausted |
| `danger` | `score` | local safety estimate |
| `should_retreat` | `boolean` | local retreat decision |

Answer mapping (`mapAnswer`) keeps `probability` for boolean questions, exposes
`probabilities: { true, false }`, and stamps `note: 'model-authoritative-beta'` on β. A returned
`action` is rejected unless it names a candidate the code generated:

```ts
if (!grounded) throw new Error(`Jev invented non-grounded action id ${JSON.stringify(action.value)}`)
```

That check is the authority split in one line: **Jev chooses among CAN; it can never invent an
action the deterministic shell did not enumerate.**

## 3. What Jev is shown

`authorityState()` sends a deliberately small projection: `tick`, `self{position,health,food}`,
`inventory`, `goal`, `goalQueue{depth,empty,current}`, `currentOption`, the last 8
`recentOutcomes`, the grounded `candidates` (id/kind/label/target/meta), nearest blocks/entities and
`signals{failedCandidates, consecutiveFailures, ...}`.

Relevant to β, the projection contains the Option's identity and its recent outcomes, but **not a
summary of strategic progress** (goal/search/body progress counts, oscillation detections,
locomotion efficiency). §5 shows why that omission matters.

## 4. Practical notes for changing the model or the call

- Keep the `evaluate` API for the Jev role. Swapping in a language model breaks with the explicit
  gateway error in §1; a language model would need `generateText`/`generateObject` with local
  parsing (that is what Mercury does, with its own json-text transport).
- Model ids arrive with or without a provider prefix (`jev` vs `typesafe-ai/jev`); normalize before
  comparing (the muse transport bug in this repo was exactly a missed prefix).
- `max_tokens` is not a knob for Jev (`0`), so output-length tuning does not apply; question count
  and state size are the levers.
- Budget/limit accounting: the repo records one call per `evaluate()` request (multiple questions
  share it), so asking β/danger/retreat in the same request as the action choice is cheaper than
  separate round trips.

## 5. What the live logs prove about the current usage (issue #360 audit)

A 48.5-minute log-only audit of a live stall found:

```text
policy MOVE decisions 1888 / WAIT 258 ; executor arrivals travelled 1533 blocks
start-to-end net displacement 0.815 blocks          (~0.053% locomotion efficiency)
one semantic Option active the whole time: recover_vertical_access (plan g2:surface:log)
progress taxonomy: body 1881 / none 265 / goal 0 / search 0
OSCILLATION_DETECTED 401, LOCAL_MOVE_OSCILLATION 49, MOVE_EFFICIENCY 146 (median 3%)
beta outputs 2148 -> mean 0.25, median 0.25, min 0.18, max 0.36, threshold 0.5, beta>=0.5: 0
SHADOW_METRICS 2148, all identical: goal_progress=4 plan_still_valid=4 situation_understood=4
                                    goal_blocked=0 strategy_change_needed=0
SYSTEM2_AUTHORITY_INPUT 0 / SYSTEM2_AUTHORITY_DECISION 0 in the window
```

Reading that against §3: **β was asked to judge Option exhaustion while the state it received carried
none of the evidence that the Option was exhausted** (zero goal/search progress, 401 oscillation
detections, 0–6% locomotion efficiency). The detector worked; the semantic consumer was not given
its output. That is the actionable direction, and it is a *usage* fix (feed the progress taxonomy
into the β question state), not a threshold tweak — lowering 0.5 would only move where a blind
decision lands.

The invariant `SHADOW_METRICS` block is a second, independent smell: four identical values across
2148 records cannot be behaviourally plausible during a 48-minute stall, so those fields need
tracing (stale/defaulted/cached/not conditioned on outcomes) before any of them is trusted as
evidence again.

## 6. One-line summary

Jev is an **evaluation** model (not a language model): it answers typed questions over a shared
state with choices and probabilities, cannot invent actions, costs almost nothing, and must be
shown the evidence it is supposed to reason about — including, at present, the strategic
non-progress facts it is currently missing.
