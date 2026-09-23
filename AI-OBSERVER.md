# AI Buddy read-only observer

The observer serves a human dashboard at `http://127.0.0.1:4173/` and a compact
machine view at `http://127.0.0.1:4173/api/ai-summary`. It reads the resident
`report`, the run-scoped `buddy.log` tail, and a bounded tail of
`logs/jev/jev-calls.jsonl`; it does not issue Minecraft actions.

For a fresh local scan around the resident, request
`http://127.0.0.1:4173/api/world-probe?radius=6&verticalRadius=3`. This
on-demand read-only probe samples player truth, nearby blocks, hazards, portals
and entities; its maximum scan is bounded to radius 8 and vertical radius 4.
It does not run on the observer's regular 2.5-second update loop. The response
brackets the sample with resident reports and reports run/world/generation
alignment. A mismatch makes the result `partial`. Local blocks and entities do
not prove a village, fortress, or stronghold, so structure detection stays
unknown until a structure or POI sensor is added.

## Decision evidence

`choices.jevEvidence` joins a successful Jev evaluation to the matching
`JEV_HEADS` or `TOOL_CHOICE` event. It includes the action returned with its
probability and confidence, ranked candidate probabilities and labels, and a
compact copy of the state supplied to that call:

- world dimension/epoch, player position, health, food and inventory
- current goal and Option, goal progress, and the recorded non-progress signal
- hostile entities, threat status, and ATTACK/RETREAT candidate details
- known resources and nearby block candidates
- structures, when the decision snapshot records them

The Jev call log does not currently contain a resident `runId`. The observer
therefore reports `binding.directRunId=false` and binds by the current BOOT
time window, dimension, world epoch, selected action and nearest timestamp.
`binding.confidence` is `strong` when the call matches the choice within two
seconds; it remains an inferred join, not a direct identifier match. `partial`
or `unknown` must be treated as uncertain evidence. A call from a different
world epoch is excluded.

`execution.selectedChoiceOutcome` joins `CAUSAL` by the choice's exact
`chainId` when present. For `TOOL_CHOICE`, which has no chain ID, it matches by
action, generation and nearest timestamp and labels that link `inferred`. The
associated `SKILL_END` and `SKILL_OUTCOME_PACKET` are matched by action,
generation and nearby timestamp because those event types do not carry the
chain ID. Missing records remain null with a pending/not-observed status.

`progress.liveGoal` comes from the current resident report. In contrast,
`progress.atLatestJevDecision` and `progress.stall` describe the snapshot the
model received at decision time. The top-level `milestones` field exposes the
resident's recorded milestone predicates, including M3's Nether, blaze rod,
ender pearl and eye gates when available. `state.structures.status="not_recorded"`
means that decision call did not include structure evidence; it does not mean
no structures exist in the Minecraft world.

`worldObservation.live` follows recent resident heartbeat and connection state;
a Jev provider outage by itself does not mark Minecraft observation stale. Its
position is emitted as numeric coordinates when available. Authoritative
resident truth, heartbeat telemetry, and model call input remain separate
sources in the response.

The endpoint only exposes emitted evidence. `choices.jevEvidence.rationale`
stays `not_emitted` because Jev emits a selected answer and confidence, not
private reasoning. Candidate labels and probabilities are context for review,
not a claim about why the model selected an action. The summary omits the full
question prompt and caps candidate/entity/resource lists.

Validate the projection with the targeted fixture:

```bash
bun tools/test-buddy-observer.mjs
```
