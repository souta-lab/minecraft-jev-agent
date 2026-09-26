# AI Buddy read-only VTR observer

The human dashboard at `http://127.0.0.1:4173/` and the AI endpoint at
`http://127.0.0.1:4173/api/ai-summary` share the
`ai-buddy-vtr-observer/v1` read model. The dashboard receives that model over
`/events` and falls back to `/api/vtr-view`. The AI endpoint adds a bounded,
read-only current-world probe under `world.currentProbe`.

The dashboard labels are Japanese. If the resident report or exact run
identity is missing, it prominently shows unavailable/unknown values; a
Minecraft server process being alive is never used to infer a resident run.

The observer reads the resident `report`, run-scoped `buddy.log`, Jev call
journal, VTR run journal at `logs/jev/run.jsonl`, and run metadata needed to
bind the current `BOOT` / `GENERATION_READY` boundary. VTR records are
projected only after run, generation, source SHA, world identity, and journal
time pass the existing identity fence. A missing or mismatched boundary is
reported as unknown; the observer does not infer a current Transition from an
old run or from repository milestone names.

## Read model

The primary fields are:

- `run`: run ID, exact source commit, generation boundary, and world key.
- `mission`: the current run-bound Mission predicate and provenance.
- `transition`: committed Transition ID and contract hash, VTR owner,
  desired predicate, contract requirements/effects/budget, route-policy
  decision including the offered grounded route IDs, recorded probabilities,
  and selected route, predicate-relative progress, mechanical legs, deterministic
  verification, and typed terminal outcome.
- `transition.progress`: latest and best predicate distance, observation
  sequence, reachability, frontier/evidence IDs, bounded history, last
  observed best-distance change, and how long that best value has remained
  unchanged in the observed history. This is evidence, not a stall-policy
  decision; no arbitrary stall threshold is applied. Missing, malformed, or
  single-sample history remains unknown.
- `transition.mechanical`: reserved legs, observed actuator/authority,
  and whether each leg has a terminal step outcome. An action return alone
  does not prove Transition success.
- `transition.verification` and `transition.outcome`: deterministic VERIFY
  truth and evidence IDs, kept separate from the typed terminal result. A
  `SUCCESS` without a matching verified predicate is not presented as
  verified success.
- `transition.evidence.freshness`: event timestamps and ages relative to the
  current read-model observation. Ages are shown without treating an old
  historical terminal as a current world fact.
- `world` and `worldObservation`: resident truth, heartbeat freshness, and,
  on `/api/ai-summary`, a current probe with `summaryBinding.status`
  indicating whether run, generation, and world identity aligned across reads.

The response keeps `status`, `run`, and `freshnessMs` for exact-source
readiness consumers. `vtr.status` is a minimal VTR journal-presence
indicator. The primary response does not include the legacy GoalQueue,
Option, or Jev beta authority projection. `/api/snapshot` remains available
as a compatibility/debug view and is not the dashboard's data source.

## Current-world probe

For a bounded scan around the resident, request
`http://127.0.0.1:4173/api/world-probe?radius=6&verticalRadius=3`. The scan is
read-only, with a maximum radius of 8 and vertical radius of 4. It reports
player truth, nearby blocks, hazards, portals, and entities. The response
brackets the state sample with resident reports and reports run/world/generation
alignment. It joins generation identity directly when available, or marks a
stable report bracket as inferred when the state response omits that ID.

`worldCache` records the player's chunk, loaded-column coverage and dimension
provenance. `worldCacheBinding` checks the sample against the enclosing state
response; `provenanceSourceScope` identifies whether it came from the current
generation or a host-owned recovery snapshot. `entityCache` reports the local
entity-cache scope. An empty nearby list does not prove that the server has no
nearby entities. Unloaded, untagged, foreign-dimension, or generation-unbound
columns stay unknown; they are not treated as air and do not establish a route.
Current footing is labeled verified only when its support cell belongs to the
same bounded sample and matches the sampled player position/time. Local
block/entity samples alone do not prove a village, fortress, or stronghold.

`world.currentProbe.summaryBinding.status` is `aligned` only when its run,
generation, and world key match the read model. If a death, reconnect, or
generation transition occurs between reads, the probe is kept separate and
marked mismatched or unknown.

## Validation

Run the observer projection, VTR view-model, and bounded-world-probe fixtures:

```bash
bun tools/test-buddy-observer.mjs
bun tools/test-vtr-observer-read-model.mjs
bun tools/test-world-probe-diagnostics.mjs
```

The endpoint only exposes recorded facts and bounded derived summaries. It is
read-only and does not issue Minecraft actions.
