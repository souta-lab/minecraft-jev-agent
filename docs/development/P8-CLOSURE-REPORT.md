# P8 Closure Report — V4.1.2 Architecture Red-Team

**Control SHA:** `c73b74e2` (post-frontier checkpoint, clean HEAD == origin/main at start of pass)
**Final SHAs:** `d6aa847` (preemption integrity slice) → **`092a5b38` (freeze checkpoint; pushed to origin/main)**
**Verdict:** **V4.1.2 SURVIVED** the final red-team. **No constitutional counterexample was produced.** Every defect admitted an ownership-preserving fix; every remaining open item is a bounded mechanic or designed semantics, never an authority relocation.

**V4.1.2 ARCHITECTURE FROZEN** at the final validated checkpoint. Future routine work improves PBF, scenarios, proof coverage, and Minecraft capability. The constitution may only be reopened by a new minimized executable counterexample proving that the existing ownership/authority model cannot express a correct solution.

## Findings classification taxonomy

- **MUST_FIX_BEFORE_FREEZE_CHECKPOINT** — correctness/evidence defect fixed before this report froze.
- **FIXABLE_UNDER_FREEZE** — bounded mechanic inside the constitution; recorded and deferred to dedicated slices.
- **KNOWN_LIMITATION** — designed/pinned semantics; adversarially re-verified, no counterexample.
- **ARCHITECTURE_REOPEN_TRIGGER** — none found. Zero constitutional limitations were proven.

---

## MUST_FIX_BEFORE_FREEZE_CHECKPOINT (all resolved)

### Kernel — commit `d6aa847`

| Finding | Defect | Fix (in-constitution rationale) | Regression |
|---|---|---|---|
| F-K3 liveness | Preemptible never-yielding victim wedged a higher-priority preemptor indefinitely; COMMIT_PREEMPTION had no forced path. | Forced yield admitted once `hardYieldDeadlineMonoMs` (contract-declared bound) passes. Kernel already owns lease deadlines and commit; no authority moved — this is the bounded-yield mechanic the protocol always implied. | K34/K34b; sc-k-preempt-wedge, sc-k-ready-abort re-pinned |
| F-K4/K4b atomicity | `PAUSE_ACTIVE`/`ACK_PAUSE_YIELD` could bypass a live READY preemption transaction, splitting the atomic commit window. | Participant fence: a transition engaged in a live (PLANNED/READY, current-binding) transaction refuses pause-side commands until the tx resolves. | K35 |
| F-K5 stale transactions | Stale-of-binding transactions kept PLANNED/READY statuses with no resolution path. | `CANCEL_PREEMPTION` (scheduler-only, explicit, journaled); generation/world fences convert live→STALE. Authority stays with Kernel + existing scheduler capability. | K36/K36b |

### Kernel — closure commit

| Finding | Defect | Fix | Regression |
|---|---|---|---|
| Audit-F2 | Forced-yield deadline computed from *conflicting* leases only — a forced commit could truncate an unrelated non-preemptible critical section the victim had declared. (Introduced by the d6aa847 slice; caught by independent audit.) | Deadline = max over **all** victim-held non-preemptible bounds. | K37 |
| Audit-F4 | `CHANGE_GENERATION`/`CHANGE_WORLD` rewrote *resolved* tx records — COMMITTED/CANCELED verdicts falsified to STALE. | Only PLANNED/READY→STALE; resolved records durable. | K38 |
| Audit-F8 | `REPORT_PROGRESS` ungated vs quiesce/tx-ownership — progress journaled for transitions mid-terminalization or owned by a live tx. | Same gate shape as sibling transition verbs (TERMINAL/cancel/pending/yielded). | K39 |
| Audit-F9 | `ACK_PREEMPTION_YIELD`/`COMMIT_PREEMPTION` lacked a quiesce gate — commit could proceed against an already-quiescing victim. | `VICTIM_QUIESCING` reject on both paths. | K40 |
| Audit-F10a | Facts could cite `effectCommitId` on never-dispatched tokens (ISSUED/EXPIRED/REVOKED) — evidence for an effect that never ran. | `EFFECT_EVIDENCE_NEVER_DISPATCHED` reject. | K41 |
| K14 | `ACCEPT_WITNESS_PROOF` journaled proofs for TERMINAL/quiescing transitions — dead proof state. | `TRANSITION_NOT_WITNESS_ELIGIBLE` gate (same shape as progress). | K14 re-pinned |
| K30 | Reusing a `generationId` re-armed capabilities minted under the earlier era (`transitionId|contractHash|generationId`). | `usedGenerationIds` in KernelState; `GENERATION_ALREADY_USED` reject; replay rebuilds the set identically. | K30 re-pinned |

### Proof system — closure commit

| Finding | Defect | Fix | Regression |
|---|---|---|---|
| F1 graft hole | Milestone validation checked only a proof's *self-embedded* bytes — a comparison proof from another run/Transition could be grafted under the same source SHA. | `inspectReachComparisonProof` accepts `expectedVtrIdentity`; validator binds `runId`, `generationId`, `buildHash`, `worldKey`, `transitionId`, `contractHash` to the archive's own `probe.json`. Packager passes the same identity at seal time. Asserted-vs-unclaimed semantics preserve honest `INCOMPLETE` (absent fields on a non-accepting artifact stay incomplete; asserted mismatches FAIL; claimed-acceptance artifacts must match). | `vtr-reach-comparison-proof.test.mjs` graft-negative; packaging foreign-run fixture re-pinned |
| F3 exit code | A milestone FAIL could exit 0. | `status`/exit code reflect the strictest verdict; per-slice verdict preserved in `probeStatus`. | CLI pins updated |
| F4 ancestry | Comparator ignored the collector's pinned `originMainAtCollection`; baseline staleness invisible. | Prefer collector-pinned baseline SHA, fall back to tip equality for legacy artifacts; `baselineStaleness` surfaced in milestone detail. | F4 fixture |
| F5 ambiguity | Rejected journal-alignment alternatives dropped silently — vacuous-evidence risk. | Ambiguous alternative sets embedded in the proof artifact. | validator suite |
| F7 counter | `concurrentLegacyActuations` zeroed in comparator output regardless of probe value. | Passthrough with default 0. | unit pin |

---

## FIXABLE_UNDER_FREEZE (recorded; each is a bounded slice)

1. **Audit-F1: over-broad binding fence.** `txCurrent`/effect-token validity binds to the *global* `RuntimeBinding` (generationId + factRevision + registryRevision + missionRevision). Unrelated `ACCEPT_VERIFIED_SNAPSHOT`s, registry updates, mission updates, or grants staled READY transactions and issued tokens; sustained verifier traffic can livelock the commit path. Fix = scope tx/token binding to the revisions that actually invalidate them + explicit revalidation/rebind at COMMIT/BEGIN. No authority relocation — pure mechanic.
2. **Audit-F3: self-staling precondition/witness flows.** `ACQUIRE_DECLARED_RESOURCES` bumps `registryRevision`, killing proofs minted under the pre-grant binding → two/three-shot acceptance. Same root cause as F1; fix together.
3. **Audit-F5: unattributed kernel terminalizations.** Budget/generation/world terminalizations mutate without emitting per-transition journal events; audit attribution relies on sweep context only. Fix = emit attribution events.
4. **Audit-F6: inverse wedge.** A live tx pins its victim ACTIVE forever when binding goes quiet. `CANCEL_PREEMPTION` (landed) is the operator path; a bounded tx-expiry remains available if needed.
5. **Audit-F7: preemption ping-pong.** No anti-thrash bound on repeated plan/cancel cycles — scheduler-policy bound, not Kernel authority.
6. **K29: DISPATCHING never expires.** Wedge escapes via RECONCILE/cancel/generation; a TTL floor is available if wanted.
7. **K33: `ttlMs = Number.MAX_VALUE`** yields unbounded issued-token lifetime (binding fences it anyway; TTL ceiling optional).
8. **Comparator F2:** teleport-before-commit unverified for v1-schema probes (extend fixture-command parsing into the validator alignment path).
9. **Comparator F6:** ancestor-directory heuristic; emit `archiveRoot` + directory digest at package time.
10. **Audit-F10 minors:** `APPEND_RECORD` op-id squatting; `transitionSequences` event-attribution noise; dangling `factIds` after world purge; dead mechanics (`leaseFingerprint`, `schedulerEpoch` on leases, unreachable reject branches); empty-snapshot `factRevision` amplifier — see unresolved ambiguity below.
11. **Comparator CLI spawn failures (environmental):** 11 fixture failures reproduce identically on baseline (`SyntaxError: Unexpected EOF` reading spawned output) — infra issue, not semantic regression.

## KNOWN_LIMITATION (designed semantics; adversarially re-pinned)

| Finding | Semantics |
|---|---|
| K6 | Cancel quiesces in-flight dispatch immediately — fail-closed crash-ambiguity rule. |
| K7 | Terminal safe-yield doesn't gate in-flight dispatch (same quiesce class). |
| K8 | World change discards pending verified SUCCESS — old-world verify cannot certify the new world. |
| K9 | Binding-moved evidence can't reconcile; re-attestation under the new binding can. |
| K10/K12 | Reordered/repeated completions and observation-time regression are fenced. |
| K11 | `NOT_OCCURRED` consumes irreversible dispatch budget — the attempt consumed real-world risk. |
| K13 | Progress/witness on never-ran transitions remains reportable (now gated vs quiesce/terminal); pinned. |
| K27 | Pending-terminal stickiness — first terminal request wins; deterministic. |
| K28 | Cancel vs deadline arm-order is order-dependent but deterministic per trace. |
| K31 | Resumability/deadline math computed from conflicting leases (pinned semantics). |
| K32 | `VERIFY_SUCCESS` terminalizes a never-executed transition when fresh facts satisfy the predicate — VERIFY is the sole SUCCESS authority; correct by design. |
| Audit-F12 | Proof format is self-certifying at the operator trust boundary — graft-binding mitigations landed; optional input hash-binding recorded under F6. |

## ARCHITECTURE_REOPEN_TRIGGER

**None.** The strongest constitutional candidates were attacked directly:

- Preemption liveness/atomicity/staleness resolved with one new scheduler command plus deadline/quiesce gates — no authority moved.
- The binding-fence questions (F1/F3) are permissiveness fixes *inside* the same fence model, not arguments the model is wrong.
- No trace demonstrated a correctness goal the constitution cannot express.

## Unresolved ambiguity

- **Empty-snapshot freshness semantics:** whether a verifier observing *nothing* should bump `factRevision` (current) or leave fact freshness unchanged. Changing it without a designed freshness model could mask real staleness; recorded with the F1 fence-narrowing slice.
- **Audit-F6 boundary:** operator-cancel (landed) vs automatic tx-expiry — a bounded design choice, not a constitutional question.

## Validation counts and provenance

| Suite | Result |
|---|---|
| `packages/kernel` (adversarial + scenarios + property + kernel) | **150 pass / 0 fail** — ~113,222 assertions, 4 files, ~1.2 s |
| `tools/vtr-reach-comparison-proof.test.mjs` | **22 pass / 0 fail** (incl. graft-negative) |
| Archive packaging tests | PASS |
| **Real sealed archive `vtr-reach-authority-d781f54-01`** | **142/142 PASS, 0 FAIL, 0 INCOMPLETE, exit 0** — post-graft-gate |
| Archive `vtr-reach-authority-83f44e5-01` (pre-kernel-authority) | **139 PASS / 0 FAIL / 3 INCOMPLETE** — expected: `authority:kernel-mode-on`, `authority:kernel-summary`, `authority:kernel-gates-live` |
| Typecheck (jev-agent + buddy-driver) | clean |
| Guard suite (v412-architecture, feature-authority-map, host-surface, repo-layout, experiment-contract) | green |
| **Full repository gate `bun test` (final tree)** | **798 pass / 0 fail** — 115,775 assertions, 34 files, 503 s |
| Comparator CLI fixture suite `compare-vtr-reach.test.mjs` | 11 fail — **pre-existing environmental spawn failures, identical on control baseline** (0/11 on `c73b74e2` too); recorded as infra issue, not a regression |

## Post-P8 bounded tasks (architecture frozen)

1. Fence-narrowing slice (Audit-F1/F3): scoped tx/token bindings + revalidation/rebind; includes the empty-snapshot freshness decision.
2. Journal attribution events for kernel-initiated terminalizations (Audit-F5).
3. Comparator hardening residue (F2 fixture alignment, F6 archiveRoot digest).
4. **Pivot to measurable Minecraft capability** — the primary objective. Capability ladder wood → stone tools → iron → food/survival → cave recovery → smelting → portal → Nether traversal → fortress/blaze → pearls → stronghold → End, via bounded experiments + deterministic/live scenarios. Metrics per bounded experiment: task success rate, time/actions to success, deaths, recovery rate, stalls, resource waste, replans, Jev decision quality, System2 invocation rate/cost, cross-seed and cross-biome robustness, novel-state recovery. Attack one measured failure cluster at a time; architecture stays frozen.
