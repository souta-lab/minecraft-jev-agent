# system2-harness — the sealed System2 WHAT boundary (#439)

Status: **Phases B/C/D/E implemented as a workspace package with no production call
site yet.** Nothing in `buddy-driver/` or `jev-agent/` imports it, so landing this
changes no live behaviour. Phases C/D/E (wiring the four existing call sites onto
`System2Harness.propose`) and Phase F (removing the legacy deterministic WHAT
authority) are mapped below and deliberately NOT executed here.

```text
Mission / OptionGraph / causal outcomes / world facts
                        |
                        v
+---------------------------------------------------+
|                 system2-harness                  |
|  stateProjection  wakeReasons  provider adapter   |
|  schema (strict)  compiler (fail-closed)          |
|  grounding        epochs (stale fence)            |
|  cache identity   artifacts (JSONL)  replay       |
+---------------------------------------------------+
                        |
                        v
            immutable OptionGraphPatch
                        |
                        v
        HOST commit (compare-and-swap, atomic)
                        |
                        v
                  Jev pi / beta
```

The architectural rule (#439 thesis): **System2 may reason freely in natural
language about WHAT, but no free-form model text directly mutates GoalQueue,
OptionGraph, world state, candidate ranking or actuation.**

## Module layout (#439 §22)

| Module | Owns | Issue sections |
| --- | --- | --- |
| `contract.ts` | repo-owned request/result/proposal/patch/OptionGraph types, generic predicate vocabulary | 1,2,3,4,10,11,12,14,15,26 |
| `epistemic.ts` | `Epistemic<T>`: `known`/`unknown`/`not_observed`/`sensor_error`; `requireKnown` throws | 18 |
| `canonical.ts` | `canonicalJson`, `sha256Hex`, `hashId`, `stableSeed`, `deepFreeze`, `projectionHash`, `projectionVersionKey`, `assertPlainData`, `epistemicEntry` | 8,17,18,25 |
| `versions.ts` | independent versioning + explicit cache/replay invalidation | 17,25 |
| `stateProjection.ts` | ONE versioned semantic projection (compact, canonical, bounded, explicit unknowns, benchmark-order independent) | 8,18,19,20,26 |
| `wakeReasons.ts` | typed wake taxonomy + `evaluateWakePolicy` local-event gating | 9,29 |
| `predicateRegistry.ts` | generic predicate vocabulary + code-owned TRUE/CAN truth facts (additive enrichment only) | 4,13 |
| `grounding.ts` | grounded-id resolution, candidate exposure, symbolic search objectives | 5,27,28 |
| `schema.ts` | strict decode of the raw provider response; no prose salvage | 6,7 |
| `compiler.ts` | deterministic fail-closed compile → immutable `OptionGraphPatch` | 5,6,11,13,26 |
| `epochs.ts` | causal identity + field-priority currency check + retry eligibility | 10,16,21 |
| `optionGraph.ts` | authoritative graph, pure patch application, CAS commit, derived read-only queue, durable round trip | 11,12,14 |
| `cache.ts` | cache identity = the whole model-visible request; evidence-visible hits | 17, #412/#413/#414 |
| `artifacts.ts` | immutable decision artifact + sibling JSONL records (`STALE_*_DROPPED`, `DECISION_LINK`, `CODE_FALLBACK`) | 15,24 |
| `prompt.ts` | the ONE registered System2 prompt path | 1,2,4,22 |
| `provider.ts` | transport seam `{identity, dispatch(request, signal)}` + scripted provider | 1,15,16,22 |
| `providers/aiGateway.ts` | the only module that calls `generateText`/`tool`; classifies failures, never retries, never interprets | 1,15,16,22 |
| `replayAdapter.ts` | provider-free replay implementing the SAME seam: `exact \| malformed \| timeout \| provider_error \| stale_completion` | 23 |
| `index.ts` | the ONLY import surface production may use | 1,22 |

`bun-tests/` holds the executable acceptance: `s1-s15-invariants.test.ts` (§31),
`f32-fixtures.test.ts` (§32, all 25), `shared-shapes-parity.test.ts` (§438 parity),
`static-scan.ts` + `support.ts` (fixture builders).

## SHARED-SHAPES (#438 ⇄ #439)

The #438 lane (`jev-harness`) settled the cross-harness shapes; this package adopts
them so **one reader can consume both artifact corpora**. Per-file mapping:

| #439 module | #438 source | Adoption |
| --- | --- | --- |
| `canonical.ts` | `jev-harness/canonical.ts` | symbol-for-symbol: `NonCanonicalValueError`, `canonicalJson` (keys sorted; `undefined` object members dropped; `undefined`-in-array, `NaN`/`Infinity`, `bigint`/`symbol`/`function`, class instances, `Map`/`Set`/`Date` all THROW), `sha256Hex` (full 64 hex), `hashId(v, len=16)`, `stableSeed` (FNV-1a), `deepFreeze`, `projectionHash({projectionId,version,payload})` = `sha256Hex(canonicalJson(...))` with NO truncation, `projectionVersionKey` = `` `${projectionId}@${version}` ``, `assertPlainData`, `epistemicEntry` |
| `epistemic.ts` | `jev-harness/contract.ts` §6 (`Epistemic<T>`) | same four discriminators `known`/`unknown`/`not_observed`/`sensor_error`; `known`, `notObserved`, `sensorError`, `isKnown`, `requireKnown` (THROWS `UnknownFactError`), `epistemicToJson`; **no defaulting API** is exported (pinned by the parity test) |
| `artifacts.ts` | `jev-harness/artifacts.ts` | one JSONL record stream with a `record` discriminator, deterministic ids, deep-frozen plain data, and SIBLING records instead of mutation: `SYSTEM2_DECISION` (envelope `{artifactId, runId, sourceSha, sequence, createdAt}`), `STALE_SYSTEM2_RESULT_DROPPED`, `SYSTEM2_DECISION_LINK`, `CODE_FALLBACK` (`fallbackAuthority:'legacy_code'`, `system2AnswerPresent:false`, `architectureException`) |
| `provider.ts` | `jev-harness/provider.ts` | adapter seam `{identity:{providerId,modelId,transport}, dispatch(request, signal)}` with typed `ProviderFailure{kind, retryable}`; the adapter classifies, the harness owns retry currency |
| `epochs.ts` | `jev-harness/identity.ts` | `CausalIdentity` + `checkCurrency` with field priority **epoch advanced > generation changed > world key changed > world epoch changed > human intent changed > mission changed > option-graph revision changed > active option changed** |
| `replayAdapter.ts` | `jev-harness/replay.ts` | provider-free adapter over the same interface, modes `exact \| malformed \| timeout \| provider_error \| stale_completion` |

`candidateSetHash`/`candidateOrdering`/`candidateOrderSalt` (the #438 candidate
shape) has no System2 counterpart yet: System2's order-independent collection is
the *exposed candidate set* in `grounding.ts`, which carries no ordering at all
(see `exposeCandidates`). When a System2 candidate corpus appears, it must use the
#438 ordering + salt vocabulary rather than inventing one.

Two deliberate, type-level widenings (no semantic or byte-level effect):

1. `SemanticProjection<P = unknown>` — the #438 default of
   `Readonly<Record<string, unknown>>` makes the projection that
   `buildSystem2Projection` returns *unassignable* to `System2Request`. "Plain
   data" is enforced at runtime by `canonicalJson`/`assertPlainData`, which is the
   real fence.
2. `projectionHash`/`projectionVersionKey` accept `SemanticProjection<unknown>` for
   the same reason. The produced digest is unchanged.

`bun-tests/shared-shapes-parity.test.ts` freezes golden vectors **computed by
running the #438 implementation**, so this agreement is checkable forever:

```text
canonicalJson({b:1,a:[2,3],c:{d:null,e:'x'}})  = {"a":[2,3],"b":1,"c":{"d":null,"e":"x"}}
sha256Hex('system2-harness')                   = 78a68b72c23ff6db5fa93904c797fc7840af49fccef0618c5c3452cbb5700d53
hashId('abc') / hashId('abc',8)                = ba7816bf8f01cfea / ba7816bf
stableSeed('portal:P17')                       = 1960393293
projectionHash(system2.state@1,{b:2,a:1})      = 77449b0256950356d93536c856278efd1e8de622d065cf20a739708d5fea0380
rejects (10/10 with NonCanonicalValueError)    = NaN, ±Infinity, bigint, undefined-in-array, function, symbol, Date, Map, Set, class instance
```

### Planned extraction: `harness-core/` (whoever lands SECOND does it)

Both lanes must end up importing ONE copy. The extraction is mechanical because
the module names and semantics already match:

1. add `"harness-core"` to root `package.json` `workspaces` (a **workspace
   package**, not a plain relative directory — each harness must be able to
   resolve it independently and Bun workspaces already hoist `ai`);
2. move `canonical.ts` + the `Epistemic<T>` block into `harness-core/` with an
   `index.ts` barrel;
3. in the second-landing package, delete the local copies and re-export:
   `export * from 'harness-core'` from the local module path so no call site
   changes;
4. keep `shared-shapes-parity.test.ts` in the *second* package, retargeted at
   `harness-core` — the golden vectors are what proves the move was a move.

Until then, the golden vectors are the contract: if either harness changes a hash
rule without the other, this test says so by name.

## Contract, compiler, projection, artifacts, replay

**Request.** `System2Request{identity, projection, protectedIntent?, stage?}` where
`identity` binds `system2Epoch + missionId + optionGraphRevision +
activeOptionInstanceId + worldKey + worldEpoch + generationId +
humanIntentRevision`. The projection embeds the typed wake.

**Result algebra (§15).** `System2HarnessResult = {ok:true, proposal, commit,
artifactId} | {ok:false, kind, detail, modelAnswerPresent:false,
fallbackAuthority:'none', diagnostics, artifactId}` with
`kind ∈ provider_unavailable | timeout | invalid_response | ungroundable_intent |
compile_rejected | stale | invalid_request | aborted`. There is no accessor that
defaults; `unwrapProposalOrNull` returns `null`.

**Proposal (§3, verbatim).** `System2Proposal{operation: 'replace'|'append'|
'suspend'|'resume'|'repair', rationale? (diagnostic only), intents: IntentDraft[]}`
and `IntentDraft{intentText, desiredPredicates, dependencies?, targetRef?,
completionSemantics}`.

**Predicate vocabulary (§4).** `acquire | ensure | reach | find | establish |
interact | preserve | recover`, with role arguments only — **no `x`/`y`/`z`/`at`
argument exists anywhere**, so a hallucinated coordinate is not expressible (S8).
`${x:1}` cannot even be decoded.

**Compiler pipeline (§6) — every stage recorded in diagnostics.**
`strict schema decode → normalize → compile IntentDraft → validate predicate
kinds → resolve grounded refs → bind target → validate dependency graph →
validate authority scope → validate semantic epoch → immutable OptionGraphPatch`.
All-or-nothing: one invalid intent rejects the WHOLE patch
(`partialAcceptance:'unsupported'`), the old graph stays authoritative.

Boundaries that are structural, not conventional:

* **Additive only.** `findStrategySubstitution` runs on every accepted patch; the
  compiler may append truth-fact predicates (each carrying a `truth.*` id and
  `sourceDraftIndex:-1`) but may never drop, reorder or replace a proposed one.
* **Truth, not strategy.** An unusable/known-absent ref, an unverified portal, a
  contradictory dependency and an impossible dependency are typed rejections that
  return evidence — never a rewritten plan.
* **Ambiguity is exposed.** Several verified candidates become
  `TargetBinding{kind:'choice', candidates, selectionAuthority:'jev_pi'}`. Hidden
  nearest-site selection is inexpressible.
* **Zero verified + some unverified is a rejection**, not a downgrade into
  "go search for one" (`portal_not_verified`).
* **Bounded horizon (§26).** ≤8 intents, ≤6 predicates/intent, dependency depth
  ≤2, ≤24 kB serialized patch, ≤600 chars intent text, ≤4000 chars rationale.

**Authority scope (§21).** A non-expandable `ProtectedIntent` cannot be replaced or
suspended; a human-intent revision change mid-flight is stale.

**Projection (§8/§18/§19/§20).** `buildSystem2Projection` is the only producer.
Caps + explicit `truncations` records (never silent elision); stable sorting;
`sensor_error`/`not_observed` survive serialization; no positions/path nodes/ticks;
`benchmarkOrder` is accepted and **ignored**, and a forbidden-token guard
(`next_rung`, `recommended_strategy`, `descend_to_y16`, …) throws if evaluator
vocabulary reaches the payload.

**Cache (§17).** `cacheKeyFor` hashes the ENTIRE model-visible request
(prompt text, projection, wake reason + detail hash, causal identity, versions,
provider identity, protected intent, stage). There is no maintained field list that
can drift — the S11 test flips every leaf and asserts the key moves. Hits are
evidence-visible (`cacheHit`, `cacheSource`, `cachedArtifactId`) and a cached answer
is re-decoded, re-grounded, re-fenced and re-committed from scratch.

**Artifacts (§24).** Every request emits exactly one immutable `SYSTEM2_DECISION`
with `runId, sourceSha, dirtyTree, system2Epoch, missionId, worldKey, worldEpoch,
generationId, baseRevision, activeOptionInstanceId, wakeReason, wakeDetail,
projectionKey, projectionVersion, projectionHash, versions, provider, attempts,
cacheSource, cacheKey, cacheHit, cachedArtifactId, rawResponse, rationaleText,
rationaleExecutionDirectives, normalizedProposal, compilerDiagnostics,
acceptedIntentIndexes, rejectedIntentIndexes, finalPatch, newRevision, staleCheck,
resultKind, detail, createdAt, artifactId, decisionId, modelAnswerPresent,
fallbackAuthority`. Stale drops and downstream links are SIBLING records, so the
artifact itself is never mutated.

**Replay (§23).** `ReplayProviderAdapter` implements the same seam, so a replayed
request runs the identical pipeline. `cacheSource:'replay'` keeps the transport
evidence-visible. `requireCurrentSemanticContract` refuses to replay a corpus
recorded under a different semantic contract (`SEMANTIC_CONTRACT_CHANGED`).

## §31 — which invariants are executable and how they fail

| # | Invariant | Executable form | Fails when |
| --- | --- | --- | --- |
| S1 | no direct provider import outside the harness | **ratchet**: `providerSdkImporters()` must equal the pinned legacy set exactly; `deepHarnessImports()` must be empty | a new bypass appears, OR a migrated file is left in the allowlist, OR someone deep-imports `system2-harness/compiler.ts` |
| S2 | no unregistered prompt/call path | registry has exactly 1 entry pointing at `System2Harness.propose`; `buildSystem2Prompt` referenced only by `prompt.ts`+`harness.ts`; only `providers/aiGateway.ts` imports the SDK | a second prompt builder or call path appears |
| S3 | typed wake reason on every request | all 10 reasons round-trip with causal evidence; an unregistered reason → `invalid_request` with **zero provider calls** | a wake reason is invented or untyped |
| S4 | binds `system2Epoch` + base revision | a request with a non-live `optionGraphRevision` is `stale` before dispatch; epoch participates in `decisionId` | an unbound request reaches the model |
| S5 | stale cannot mutate | 7 mid-flight mutations → `stale`, graph revision 0, no links, `STALE_*_DROPPED` recorded, artifact `finalPatch:null`; priority order asserted | a late answer is rebased onto newer state |
| S6 | rationale cannot mutate | holding the typed intents + intentText identical, changing only `rationale` yields byte-identical graphs; prose-only intent → `prose_only_intent` | prose gains authority |
| S7 | unknown refs fail closed | unknown id, unknown arg ref, known-absent ref, unverified-portal, and "nothing known → symbolic" | an invented id becomes a target |
| S8 | no primitive action sequence | registry arg names contain no coordinate/sequence token; array/object/coordinate args cannot decode; `reach` rejects a number; >8 intents rejected | HOW leaks into WHAT |
| S9 | no silent strategy substitution | proposed predicates survive in order with `sourceDraftIndex`; every added dependency carries a truth id; no-truth-index adds nothing; impossible → rejection with zero additions | the compiler rewrites the plan |
| S10 | failure cannot activate a legacy plan | timeout/unavailable/abort → typed, `modelAnswerPresent:false`, `fallbackAuthority:'none'`, no ladder/legacy token in harness code, harness emits no `CODE_FALLBACK`; the Phase F record shape is asserted | a fallback becomes silent |
| S11 | cache key covers all model-visible WHAT state | every one of the >30 leaf paths of the REAL model-visible request changes the key when flipped; 28 named §17 variables are asserted present | a model-visible field is left out of the key |
| S12 | benchmark order absent | reordered `benchmarkOrder` → identical payload+hash; no `rung/milestone/preferred/recommended` leaf; the forbidden-token guard still throws | evaluator data reaches the projection |
| S13 | atomic commit | whole-patch rejection leaves revision 0; a racing authority → `stale` at commit; `applyOptionGraphPatch` is pure and bumps exactly one revision; a missing suspend target → `refused` | partial mutation |
| S14 | one origin per committed Option | every option has an origin; system2 origins carry `artifactId`/`baseRevision`; the graph's `committedArtifactId` and the `DECISION_LINK` agree; a deterministic origin must carry `architectureException` | an origin-less or ambiguous Option |
| S15 | provider swap = configuration only | two provider identities → identical committed semantics, different cache keys; no model identity in the harness core; versions independent | a model name leaks into logic |

`bun-tests/system2-harness.test.ts` (repo root) bridges the package suite into
`bun test ./bun-tests`, so the repository battery runs them.

Three further sections have executable form in the same file, because a prose-only
guarantee is not a guarantee:

* **§12** — the patch vocabulary is exactly `add|replace|suspend|resume`; no
  harness module contains execution-layer vocabulary (`GoalQueue`, `PlannedGoal`,
  `PlanOp`, `enqueue`, …); the compatibility queue is derived, idempotent and
  cannot mutate the graph it came from.
* **§30** — a self-certifying claim (`safe:true`, `grounded:true`,
  `complete:true`, `portalExists:true`) is not even *expressible*: unknown
  authoritative keys are rejected, so a model assertion cannot become a field.
* **§26** — the horizon caps are asserted (≤8 intents; >8 is refused at decode).

`bun-tests/ai-gateway-transport.test.ts` drives the REAL `generateText` path offline
through `ai/test`'s mock model: it proves the adapter forwards the harness-rendered
prompt unchanged, offers the typed tool in `tool-call` mode and none in `json-text`
mode, returns the raw response without interpreting it, and turns an SDK error into
a typed `provider_unavailable`. That is the one claim the scripted/replay providers
cannot cover, and it needs no network and no key.

## §32 — regression fixtures

All 25 exist in `bun-tests/f32-fixtures.test.ts` (1–25 in order, plus 5b/5c, 7b,
8b, 10b, 21b for the sub-cases that the issue's prose implies). The minimum set
required by this lane's brief — 3, 4, 5/6, 8, 9, 12, 13, 14, 18, 20, 22, 25 — is
covered directly, and fixtures 1, 2, 10, 11, 15, 16, 17, 19, 21, 23, 24 close the
rest.

## Phase C/D/E — call-site migration mapping (NOT executed here)

Phase A inventory (verified against `main` at `93030d2`):

| # | Call site | Current role | Phase | Migration |
| --- | --- | --- | --- | --- |
| 1 | `buddy-driver/mercury-system2.ts` — `import {generateText, tool}` :56, transports :1412 (json-text) / :1439 (tool-call), `class MercurySystem2` :1727, `.tryRepair` :1921, `SYSTEM_PROMPT` :1458, `isCurrent` staleness :1827/:1924 | **the only current WHAT authority** (`patch`/`replace` via `System2Brain`) | D+E | `MercurySystem2` becomes a thin wiring of `createSystem2Harness({provider: createAiGatewayProvider(...)})`: its `MERCURY_PLAN_SCHEMA`/`SYSTEM_PROMPT`/`MERCURY_INTENT` prose path is replaced by the typed `System2Proposal` contract; `tryRepair` builds one `System2Request` (projection from `plannerModelView` (:2637) + `System2PlanRequest.goalQueueState`/`objective`/`recentOutcomes` + the grounded index) and returns the committed patch. Its `isCurrent`/`StaleMercuryGenerationError` checks collapse into the harness epoch fence (`checkSystem2Currency`) and the HOST CAS commit. **`generateText`/`tool` move out of this file entirely.** |
| 2 | `buddy-driver/planner-legacy.ts` — `experimental_evaluate` :30, call :3520, `PlannerBrain` :2784, `askLlm` :3498 | legacy WHAT chooser (one grounded plan id from a horizon) | C+D | `askLlm` becomes `harness.propose()` with `wake: PLAN_REPAIR_REQUIRED`/`NO_SEMANTIC_FRONTIER`; `readChoice`'s "chose an id that may not exist" handling is replaced by the compiler's grounded intent validation (today :3046 silently substitutes `fallbackOption` when the chosen id is unknown). Cache/dedupe (:3009) moves behind `System2ProposalCache`. |
| 3 | `buddy-driver/planner.ts` — `experimental_evaluate` :19, call :605, `PlannerBrain` :272 | second WHAT chooser; the resident default (`resolvePlannerMode` :49 → `'llm'` when `BUDDY_PLANNER` is unset) | C+D | Same as (2): one `System2Request`, `opt_*` ids become `optionId`/`optionInstanceId` from the compiler, and the derived execution queue replaces the horizon list. `planner-legacy` remains reachable only through explicit `deterministic` mode. |
| 4 | `buddy-driver/advisor.ts` — `experimental_evaluate` :18, call :383, `class Advisor` :274, `.decide` :308 | **shadow/advisory, never authority** | D | Migrate last and keep it non-authoritative: it may consume the harness's typed diagnostics/evidence, but it must not become a second WHAT author. If it cannot be expressed as evidence input, delete it rather than duplicate the question. |

Order: **1 → 3 → 2 → 4**. (1) is the only live WHAT authority, so it proves the
boundary first; (3) is the resident default, so it determines what most runs
actually do; (2) then removes the second, divergent planner; (4) is advisory and
must not survive as a parallel authority. Each step must delete its row from
`ALLOWED_LEGACY_PROVIDER_CALLS`, which is what makes the ratchet tighten.

**Supersession note.** The repo already has a weaker stale fence:
`System2RequestContext`/`System2ApplyState`/`System2DiscardReason` +
`decideSystem2Apply` in `jev-agent/src/system2Authority.ts:8-64`, carried on
`System2PlanRequest.requestContext` (`jev-agent/src/system2.ts:73-83`). The harness
epoch fence is a strict superset and should replace it rather than sit beside it:

| `System2RequestContext` | `CausalIdentity` |
| --- | --- |
| `queueRevision` | `optionGraphRevision` |
| `optionInstanceId` | `activeOptionInstanceId` |
| `worldEpoch` | `worldEpoch` |
| `stateFingerprint` | `projectionHash` |
| `authorityEpoch` | `system2Epoch` |
| `requestId` | `decisionId` (derived, deterministic) |
| — | `missionId`, `worldKey`, `generationId`, `humanIntentRevision` (new) |
| `optionTemplateId` | covered by the compiled `optionId` |
| (unordered reason list) | field **priority** order (`system2_epoch_advanced` first) |
| `actionInFlight` | **not** semantic staleness: belongs to the HOST actuation lease |

Two semantic authorities for the same question is exactly the design smell
`AGENTS.md` §8 names, so the migration must delete `decideSystem2Apply` in the same
step that wires the harness.

## Phase F — legacy WHAT fallback staging map (report only, NOT executed)

Per `buddy-driver/AGENTS.md` §2/§3 the deterministic ladder may not silently author
WHAT. Today it can, in these exact places:

| # | Location | Why it is WHAT authority | Exception record needed |
| --- | --- | --- | --- |
| F1 | `planner-legacy.ts:2949` `ladderFloorGoals(...)` (definition :1864) on `reason === 'queue_empty'` → `floorOption{id:'ladder_'+rungId}` → `finishPlan(..., true)` | when the queue empties, deterministic code authors the next objective, i.e. it answers "what should hold next?" | `CODE_FALLBACK{fallbackAuthority:'legacy_code', system2AnswerPresent:false, architectureException:'#424'}` per occurrence |
| F2 | `planner-legacy.ts:2884` `fallbackOption = options[0] ?? FRONT_FALLBACK` (comment :2013 "Option 0 is always the ladder front (fallback)"; `FRONT_FALLBACK` :2147) | the ladder front is the implicit default plan whenever model output is unavailable or unusable | same |
| F3 | `planner-legacy.ts:2926` `deterministicOption = stalledOption ?? fallbackOption`, consumed at :3009 (`cached plan` whose id vanished), :3046 (model chose an unknown id), :2988 (`mode === 'deterministic'`) | three separate silent substitutions of a deterministic plan for a model decision; :3046 is the sharpest — a *successful* model call whose chosen id is stale silently becomes the ladder front | same for :3009/:3046; :2988 is an explicit mode and only needs the `DETERMINISTIC_BASELINE` run label |
| F4 | `planner-legacy.ts:81-85` `resolvePlannerMode()` defaults to `'deterministic'` when `BUDDY_PLANNER` is unset and accepts any value as deterministic | **a second, divergent default**: `planner.ts:49-58` makes model authority the default and THROWS on an invalid value, while `LegacyPlannerBrain` silently defaults to deterministic. Any construction path that omits `mode` therefore seizes semantic authority without being labelled `DETERMINISTIC_BASELINE`. | this is the first thing Phase F should fix: one `resolvePlannerMode`, fail-closed, explicit `DETERMINISTIC_BASELINE` labelling |
| F5 | `planner-legacy.ts:2945` `fatalModel('planner-mercury', 'mercury returned no repair')` | already fail-closed: a null repair fails loud instead of laddering | none — this is the pattern the rest should follow |

Phase F therefore has two separable steps: **(F4) make the deterministic default
explicit and single-sourced**, then **(F1–F3) replace each implicit substitution
with a typed `System2Failure` + `CODE_FALLBACK` record** (or, where the queue-empty
case is legitimately mechanical, with an explicitly labelled
`DETERMINISTIC_BASELINE` run rather than a silent fallback). `§15`'s required
evidence fields are already expressible: `CodeFallbackRecord` in `artifacts.ts`
carries `system2AnswerPresent:false`, `fallbackAuthority:'legacy_code'` and
`architectureException`.

## Deliberately not changed

* **No production call site is wired.** Nothing imports `system2-harness`, so
  Phase C/D/E cannot change live behaviour yet. This is intentional: the brief for
  this lane is the sealed boundary + executable invariants, and the four call
  sites are mapped above.
* **The legacy WHAT fallback is not removed and not annotated.** Adding
  `CODE_FALLBACK` records at F1–F3 would change live log/artifact output, which
  this lane must not do. The record shape exists and is tested so Phase F is a
  wiring change, not a design change.
* **`intentText` participates in `optionId`.** `optionIdFor` hashes the normalized
  intent text together with the typed predicates, so a re-proposal with identical
  semantics but different wording yields a different `optionId` (and therefore a
  new Option rather than a replacement). The rationale has no such effect, and the
  predicates remain the authority. Making identity purely predicate-derived would
  require an explicit duplicate-`optionId` rejection inside one patch (otherwise
  `applyOptionGraphPatch` would silently merge two distinct intents), so it is left
  as a reported finding rather than changed here.
* **`interact.target` is optional at the registry level** with a compiler rule
  that only `interact(operation:'enter')` may omit it (code-owned candidate
  source). The rule is what keeps "omit the target" from becoming a way to name
  nothing; the change was needed because the binder already had a no-target
  portal-entry path that the registry made unreachable.
* **`buddy-driver`'s prompt/transport code is untouched**, including
  `SYSTEM_PROMPT`, `MERCURY_PLAN_SCHEMA` and the `parseMercuryJsonText` repair
  path. `schema.ts` replaces that behaviour only for requests that go through the
  harness.
* **No control-socket command, no server/host restart, no world mutation.**

## Running

```bash
bun install --frozen-lockfile                       # root; workspace member
bun run --cwd system2-harness typecheck             # tsc --noEmit
bun run --cwd system2-harness test                  # §31 + §32 + parity
bun test --timeout=120000 --max-concurrency=1 ./bun-tests   # repo battery (includes the above)
```
