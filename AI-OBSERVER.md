# AI Buddy read-only observer

The observer serves a human dashboard at `http://127.0.0.1:4173/` and a compact
machine view at `http://127.0.0.1:4173/api/ai-summary`. The AI summary joins
the resident `report`, run-scoped `buddy.log` tail, a bounded tail of
`logs/jev/jev-calls.jsonl`, and one read-only current world probe; it does not
issue Minecraft actions.

`/api/ai-summary` returns `currentWorldProbe` alongside the model decision
snapshot. The probe samples player truth, nearby blocks and entities within
radius 6 / vertical radius 3. Its `summaryBinding.status` is `aligned` only
when run, world epoch/dimension and generation all match the summary. If a
death, reconnect or generation transition occurs between reads, the binding
shows `mismatch`; keep the decision-time snapshot and current probe separate.
The probe is on-demand per summary request and does not add work to the
observer's regular update loop.

For a fresh local scan around the resident, request
`http://127.0.0.1:4173/api/world-probe?radius=6&verticalRadius=3`. This
on-demand read-only probe samples player truth, nearby blocks, hazards, portals
and entities; its maximum scan is bounded to radius 8 and vertical radius 4.
It does not run on the observer's regular 2.5-second update loop. The response
brackets the state sample with resident reports and reports run/world/generation
alignment. It joins generation identity directly when the state response has an
ID, or by an explicitly inferred stable report bracket if both reports and the
sample keep the same run/world while the state response omits that ID. A
mismatched direct ID, or an unstable bracket when the state has no ID, leaves
generation alignment unknown/partial.
The `worldCache` object reports the player's chunk, a bounded list/count of
Mineflayer's loaded columns, which columns overlap the requested probe and
whether each is loaded, plus the dimension-provenance classification and load /
unload timestamps. `worldCacheBinding` checks that snapshot's run, world,
generation and capture time against the enclosing state response. Unloaded,
unattributed and foreign-dimension columns remain unknown; the diagnostic does
not treat them as air or infer a route. `worldCacheReadability` distinguishes an
unbound provenance view from unloaded columns and foreign / unknown provenance.
`worldCacheCapturedAt` gives the exact cache-sample timestamp. `entityCache` and
`entityCacheBinding` show the corresponding Mineflayer local entity-cache scope;
an empty nearby list does not establish that the server has no nearby entities.
`area.supportEvidence` is labeled as current player footing only if its support
cell lies inside the scanned bounds and matches the same capture's player
position and timestamp. Otherwise `supportScopeStatus` keeps it unverified or
marks it outside the requested sample; do not join stale support from another
generation or timestamp to the current player.
Local blocks and entities do not prove a village, fortress, or stronghold, so
structure detection stays unknown until a structure or POI sensor is added.

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

`choices.jevCombatDecision` condenses that same decision-time snapshot for the
fight-or-flee review: dimension/epoch, player health/food/equipment, current
objective/progress, observed threat count and nearby hostiles, plus the
ATTACK/RETREAT candidates retained in the bounded decision projection and their
recorded model preferences. It also shows the other ranked actions,
candidate-set size/truncation and Jev's emitted danger /
should-retreat estimates, so a reviewer can tell whether fight, flight, or
continued work were actually offered. A `null` candidate
probability means the call log did not record a probability for that candidate;
it is not interpreted as zero. The listed probabilities compare the model's
preferences among candidates and are not probabilities of winning a fight.
The model does not emit private reasoning, so `modelRationale.status` stays
`not_emitted`.

`execution.selectedChoiceOutcome` joins `CAUSAL` by the choice's exact
`chainId` when present. For `TOOL_CHOICE`, which has no chain ID, it matches by
action, generation and nearest timestamp and labels that link `inferred`. The
associated `SKILL_END` and `SKILL_OUTCOME_PACKET` are matched by action,
generation and nearby timestamp because those event types do not carry the
chain ID. `execution.selectedChoiceOutcome.pickupEvidence` correlates
`PICKUP_ACQUIRED` or `PICKUP_NOT_ACQUIRED` by action ID, generation ID, and a
60-second post-choice window. Pickup markers do not carry a unique chain ID,
so `pickupEvidenceBinding.confidence` is `inferred`; `pickupEvidenceMatchCount`
shows when multiple markers matched that scope. Missing records remain null
with a pending/not-observed status.

`execution.selectedChoiceInterruption` is populated only when a selected Skill
ended with a lease revoke and a same-generation `MODEL_UNAVAILABLE` event with
`action="stop-generation-for-recovery"` occurred between the choice and that
terminal event. This is an event-order correlation, labeled `inferred`; it does
not claim a direct chain-ID causal link. The same per-choice outcome, including
this interruption record, is available under each
`recentChoiceOutcomes.entries[].outcome` so a later decision does not hide the
previous choice's terminal result.

The top-level `recentChoiceOutcomes` contains up to 12 recent Jev/tool choices
from the current BOOT time window, read from at most the last 8 MiB of
`buddy.log` per request. Its run binding is inferred from that BOOT boundary,
not directly stored on each event. `status="not_recorded"` or an empty list
means no matching choice was found in that bounded window; it does not prove
that no earlier choice or outcome occurred.

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
