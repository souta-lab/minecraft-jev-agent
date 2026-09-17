# PRIOR-WORK.md — prior-work survey for the Jev/Mercury Minecraft agent

Issue: `souta-lab/minecraft-jev-agent#42`. Scope: literature positioning for an embodied Minecraft
Java agent whose System One (Jev) holds sole action authority over **grounded candidate sets**, whose
System Two (Mercury) is an **exception-driven** plan/Option repair layer, with a **resident host**
and a deterministic capability ladder.

**Method / verification legend.** Every citation below was checked against the arXiv abstract page or
the venue page on 2026-09-18. Claims drawn from a paper's own text are marked with the paper; claims
that came only from a secondary source, a GitHub issue, or that I could not load are marked
**UNVERIFIED**. Numbers are quoted only where the source states them. No citation is fabricated.

Legend: `[V]` verified source (arXiv/venue page loaded). `[U]` unverified — treat as a lead, not a fact.

---

## 1. Per-paper summaries

### 1.1 LLM planners / agents (Voyager and descendants)

**Voyager — Wang, Xie, Jiang, Mandlekar, Xiao, Zhu, Fan, Anandkumar, 2023. arXiv:2305.16291 `[V]`**
Three components: an automatic GPT-4 curriculum ("discover as many diverse things as possible"),
an ever-growing **skill library of executable JavaScript**, and an **iterative prompting** loop that
feeds environment feedback, execution errors, and a **self-verification** module back to the model
until a program passes. Reported: 63 unique items in 160 prompting iterations; 3.3× items / 2.3×
distance vs. baselines; wooden level 15.3× faster and *first* of the compared agents to reach diamond.
Ablations (paper §3.4): removing the skill library makes it plateau; a random curriculum cuts
discovered items by 93%; removing self-verification cuts discovered items by 73%. Limitations the
authors state (§4): GPT-4 cost (15× GPT-3.5), residual "gets stuck" cases, and hallucinations
(invented items like "copper sword"; wrong fuel). The live repo shows the operational version of
that: repeated identical tasks and crash/restart loops on small models (GitHub issues
MineDojo/Voyager#186, #21, #157) `[V as repos]`. **Takeaway:** code-as-action works only with a
strong model, and the parts that carry the result are grounding (skill library), progress-shaped
curricula, and verification against the environment — not the code generation per se.

**DEPS — Wang et al., NeurIPS 2023. arXiv:2302.01560 `[V]`**
"Describe, Explain, Plan and Select": an event-triggered **Descriptor** summarizes the failed
execution, an LLM **Explainer** diagnoses the plan, and an LLM **Planner** revises it; a *learned*
**goal Selector** ranks parallel sub-goals by predicted steps-to-completion. Report: 71 Minecraft
tasks, ~2× overall success over language-planner baselines, and the first planning-based agent to
reach diamond. The paper explicitly frames two open-world problems: long multi-step dependencies
(≥13 sub-goals for diamond) and **infeasible plans produced by ignoring how easily the current agent
can achieve each sub-goal**. At MT6+ almost all LLM planners fail (≈0), and results are capped by the
goal-conditioned controller. **Takeaway:** the *achievability/feasibility ranking* is a first-class
contribution; a static sub-goal order with no feasibility signal is exactly the failure DEPS names.

**GITM — Zhu et al., 2023. arXiv:2305.17144 `[V]`**
Hierarchical LLM decomposition (Decomposer → Planner → Interface) using a text knowledge base mined
from the Minecraft Wiki plus a **text-based memory** of successful action sequences keyed by sub-goal.
Reports +47.5% success on ObtainDiamond over prior methods, the first agent to collect the entire
Overworld tech tree, and no GPU training. Ablations: goal decomposition lifts stone-axe success from
5% to 67.5%; adding feedback is needed before diamond is reachable; the knowledge base multiplies
diamond success 7×; text memory lifts iron pickaxe and diamond success to 95.0% / 67.5% (+37.5 / +32.5
points). Structured action space (`(Object, Count, Material, Tool, Info)`), so actions are *grounded
symbols*, not free code. **Takeaway:** grounded structured actions + retrieved past plans + explicit
feedback is a strong, cheap recipe.

**MP5 — Qin et al., CVPR 2024. arXiv:2312.07472 `[V]`**
Five modules (Parser, Percipient MLLM, Planner, Performer, Patroller) with **active perception**:
multi-round question/answer between Patroller and Percipient before/while acting, to make planning
situation-aware and to verify each action. Reports 22% on difficult process-dependent tasks, 91% on
context-dependent tasks. Its Patroller is an explicit **self-verification gate** on observations.
**Takeaway:** verification can be implemented as an independent module that checks the perception
needed for the current action — closer to our VERIFY than to pure self-report.

**JARVIS-1 — Wang et al., 2023. arXiv:2311.05997 `[V]`**
Chains MineCLIP + an LLM, adds a **multimodal memory** (key = task + observation/situation, value =
successful plans) and self-instruct/self-improve. Reports >200 tasks, near-perfect short-horizon
tasks, and 5× the reliability of the prior state of the art on ObtainDiamondPickaxe. Memory retrieval
is conditioned on both text and the current observation. **Takeaway:** memory keys must include the
situation, not just the goal name; otherwise retrieval returns plans for the wrong context.

**Odyssey — Liu et al., IJCAI 2025. arXiv:2407.15325 `[V]`**
Replaces Voyager's GPT-4-written skills with a **fixed open-world skill library**: 40 primitive skills
and 183 compositional skills, executed by a planner/actor/critic loop; a fine-tuned LLaMA-3 on 390k+
Minecraft-Wiki instruction entries; a new benchmark with long-term planning, dynamic-immediate
planning, and autonomous-exploration tasks. It uses a **recursive skill execution method that checks
prerequisites**. States its own limitation: small-LLM hallucination; visual input out of scope.
**Takeaway:** a curated grounded skill set can match Voyager-class results without GPT-4, and
recursive precondition checking is called out as necessary.

**Cradle — Tan et al., 2024. arXiv:2403.03186 `[V]`**
General Computer Control: screenshots in, keyboard/mouse out, no game API. Six modules (Information
Gathering, Self-Reflection, Task Inference, Skill Curation, Action Planning, Memory). Strong across
RDR2/Stardew/Cities/Dealer's Life + OSWorld. Its own failures are instructive for us: real-time
combat and search fail on "poor spatial perception… ends up circling aimlessly"; OSWorld success is
7.81% without API grounding. **Takeaway:** pure vision/computer-control loops still lose on spatial
grounding; a grounded state model (our WorldModel) is a legitimate advantage, not a shortcut to
apologize for.

**OmniJARVIS — Wang et al., NeurIPS 2024. arXiv:2407.00114 `[V]`**
Vision-Language-Action model with self-supervised **behavior tokens** (FSQ) so the same model reasons
(chain-of-thought), plans, and acts, avoiding a text bottleneck. The paper's motivation section is
directly relevant: works that "emit textual goals to separate controllers" (naming DEPS, JARVIS-1,
Voyager) **"may fail to correctly pilot these controllers"**; communicating with a controller purely
through text is a recognized weak point. **Takeaway:** the semantic→action communication gap we see
(#29) is a named, published failure mode; the paper's fix (unified action tokens + IL decoder) is a
research-scale solution we should not adopt.

**MineDreamer — Zhou et al., 2024. arXiv:2403.12037 `[V]`**
Adds a Chain-of-Imagination (diffusion-based future frames) as precise visual prompts to a VPT policy
because STEVE-1 "struggles to understand natural language prompts" and direct text→control is
unstable. **Takeaway:** instruction-following through text into low-level control is brittle; another
confirmation of the semantic-action gap.

**Project Sid — Altera.AL et al., 2024. arXiv:2411.00114 `[V]`**
Many-agent Minecraft civilization sim with the PIANO architecture; agents exceed 70 items (> Voyager's
count in that setting). The report explicitly notes comparisons are hard because Voyager's agents had
wider nearby-block knowledge and **"recovered with their entire inventory intact when they died"**,
and Voyager measured by prompt iterations, not wall-clock. **Takeaway:** death/respawn semantics and
the unit of measurement must be stated explicitly, or comparisons are misleading. Directly relevant
to our `simdeath`/LADDER_RESET (#26/#34) and our inventory-predicate acceptance.

### 1.2 VLM / low-level control and imitation learning

**MineDojo + MineCLIP — Fan et al., NeurIPS 2022 Datasets & Benchmarks. arXiv:2206.08853 `[V]`**
A simulation suite + internet-scale knowledge base + MineCLIP, a contrastive video-language model
trained on 640K YouTube clip/transcript pairs, used as a dense language-conditioned reward and as an
automatic success metric. Language-conditioned MineAgents are trained with PPO on that reward.
**Takeaway:** MineDojo is the default benchmark a reviewer will expect; MineCLIP is also the
success-metric they will expect for open-vocabulary tasks.

**VPT — Baker et al., NeurIPS 2022. arXiv:2206.11795 `[V via MineDojo refs]`**
Learns an inverse-dynamics model from contractor labels to pseudo-label unlabeled gameplay video,
then behavior-clones a policy (contractor data + 70k hours of video). Purely motor-level; no language
or planning. **Takeaway:** the low-level "move the mouse/keyboard" problem is solved by large-scale
imitation, not by scripted actions. We deliberately do not compete here.

**STEVE-1 — Lifshitz, Paster, Chan, Ba, McIlraith, NeurIPS 2023. arXiv:2306.00937 `[V]`**
Instruction-tunes VPT by first aligning it to MineCLIP latents and then training a prior from text to
those latents; completes 12/13 early-game tasks, ~$60 of fine-tuning compute. **Takeaway:** short-
horizon instruction following is a solved-ish imitation problem; long-horizon progression is not.

**DreamerV3 — Hafner, Pašukonis, Ba, Lillicrap. arXiv:2301.04104; Nature 640:647–653 (2025),
doi:10.1038/s41586-025-08744-2 `[V]`**
Model-based RL with one fixed configuration across 150+ tasks; first agent to collect Minecraft
diamonds from scratch without human data or curricula, at 100M environment steps (0.4% of episodes
at the 100M budget, but 100% of trained agents discovered ≥1 diamond). **Takeaway:** the strongest
no-human-data diamond baseline is an RL method we have no compute to match; cite it as the upper
bound we are *not* trying to beat, and compare to LLM-agent lines instead.

### 1.3 Hierarchical control / Options

**Options framework — Sutton, Precup, Singh, "Between MDPs and semi-MDPs", Artificial Intelligence
112(1–2):181–211, 1999. doi:10.1016/S0004-3702(99)00052-1 `[V]`**
Defines an option as `(I, π, β)`: initiation set, intra-option policy, termination function. An MDP
with a fixed option set is an SMDP. Key results we care about: (a) **options may be interrupted at
execution time** when switching is better than continuing (interruption is proved not to lose value),
(b) **intra-option learning** lets an option be improved from fragments of its own execution, and
(c) a **subgoal notion to improve/create options**. Terminal conditions are explicit objects, which is
exactly our OptionSpec/β split. `[V]`

**Option-Critic — Bacon, Harb, Precup, AAAI 2017. arXiv:1609.05140 `[V]`**
Policy-gradient theorems for options that learn the intra-option policies **and the termination
functions** end-to-end from task reward, with no extra pseudo-rewards or subgoals required. Also
notes a practical knob: adding a **penalty on switching events** is an easy way to bias options toward
being temporally extended. **Takeaway:** β *can* be learned, but only where a reward/value signal
exists; the switching-penalty idea maps onto our proposed hysteresis/cooldown for #24.

**LLM + Options hybrids `[V, 2025–2026]`**
- **LDSC — "Option Discovery Using LLM-guided Semantic Hierarchical Reinforcement Learning",
  arXiv:2503.19007** `[V]`: LLM generates subgoal sequences *offline*; a hierarchical policy then
  learns reusable options and selects among them. The LLM is used only at pre-processing, not in the
  control loop — a direct precedent for treating LLM output as schema/proposal, not authority.
- **LLM-SOARL — arXiv:2603.01488** `[V]`: maps natural-language instructions into symbolic options
  `(pre, π, eff)` — explicit **preconditions** on options, semantic skill library keyed by labels,
  and a real-time constraint-monitoring module. Very close to our intended OptionSpec shape.
- **HiPER — arXiv:2602.16165** `[V]`: hierarchical plan–execute RL for LLM agents with an explicit
  **SWITCH/KEEP** decision and hierarchical advantage estimation; observes that Option-Critic-family
  methods fix the option inventory and leave cross-level coupling unaddressed.
- **LEHCA — Sci. Reports 2026, doi:10.1038/s41598-026-54971-6** `[V]`: LLM as a coarse-timescale
  "Commander" producing strategic sub-goals plus **semantic reward shaping and dynamic action
  masking** for low-level RL. **Takeaway:** the common pattern is LLM → semantic subgoals/constraints
  → a grounded executor with explicit preconditions and termination; authority stays with the lower
  layer. `[U]` for exact numbers (paywalled).

### 1.4 Benchmarks and their units

- **MineRL Diamond / ObtainDiamond** — Guss et al. 2019, arXiv:1904.10079 `[V via refs]`;
  Kanervisto et al., "MineRL Diamond 2021 Competition: Overview, Results, and Lessons Learned",
  arXiv:2202.10583 `[V]`. Unit: success within a fixed interaction/step budget; historically measured
  in *environment steps* and often with human-demonstration priors.
- **MineRL BASALT** — Shah et al., NeurIPS 2021, arXiv:2107.01969 `[V]`. Four natural-language tasks
  without crisp rewards; scored by **human pairwise preference** (TrueSkill). Note: the issue text
  cited arXiv:2109.13398 for BASALT; the verified id is **2107.01969**.
- **MineDojo** — arXiv:2206.08853 `[V]`: programmatic tasks across 8 meta-task groups (MT1–MT8),
  plus creative tasks scored by MineCLIP.
- **Odyssey benchmark** — arXiv:2407.15325 `[V]`: long-term planning, dynamic-immediate planning,
  autonomous exploration; metrics are success rate, remaining health, completion time, distinct items
  obtained, recipes/advancements unlocked, distance traveled.
- **MCU (Minecraft Universe)** and **Voyager's item-count metric** are both widely used in the
  LLM-agent line; cite them but be explicit about the unit (items discovered vs. wall-clock time).
- Normalization for stochastic worlds: MC competition/baselines report per-episode success across
  seeded worlds or several runs (DEPS: 30 runs/task; GITM: 40 games; Dreamer: per-agent across runs).
  Our current acceptance is inventory predicates on a single live world, which is *weaker* than any
  of these, and should be labelled as such.

---

## 2. Comparison table

| Work | Planner granularity | Action grounding | Memory / state | Self-verification | Termination / abandon | Benchmark |
|---|---|---|---|---|---|---|
| Voyager (2305.16291) | One curriculum task at a time; LLM writes a program | **Free-form executable JS code** over a fixed primitive API | Skill library (vector DB, description key); no durable world map | LLM self-verification on inventory/feedback; aborts after 4 iterations | Task switch after 4 failed rounds; curriculum picks next | 63 unique items in 160 iterations; tech-tree speedups |
| DEPS (2302.01560) | LLM plan of natural-language sub-goals | Sub-goals → goal-conditioned controller (oracle / learned) | Description of execution fed back; **learned selector predicts steps-to-goal** | Explain/revise on failure (LLM) | Planner revises on failure; selector chooses among parallel sub-goals | 71 Minecraft tasks (MineDojo), ALFWorld, Tabletop |
| GITM (2305.17144) | Recursive LLM goal decomposition | **Structured actions** `(Object,Count,Material,Tool,Info)` | Text memory of successful action sequences, keyed by sub-goal; Wiki knowledge base | Feedback message per failed action → planner revises | Max 30 LLM queries per sub-goal then fail; memory gives reference plan | ObtainDiamond (+47.5 pts); all Overworld items |
| MP5 (2312.07472) | Parser → sub-objectives; Planner → action sequences | Grounded actions + MLLM active perception | Knowledge memory + "Performer Memory" of successful sequences with situation | **Patroller** verifies perception/plan/action | Planner reschedules or updates sub-objectives on Patroller failure | 22% process-dependent / 91% context-dependent tasks |
| JARVIS-1 (2311.05997) | MLM produces K short-horizon goals | Textual goals → goal-conditioned controller | **Multimodal** memory (task+situation key), self-instruct/self-improve | None dedicated (controller failures) | Not central; re-plan on failure | >200 tasks; 5× ObtainDiamondPickaxe reliability |
| Odyssey (2407.15325) | Planner → subgoals; actor retrieves skills | **Curated 40 primitive + 183 compositional skills**, recursive precondition check | Skill library; critic refines strategy | Critic provides feedback/strategy refinement | Recursive prerequisite check; critic-driven refinement | Odyssey benchmark (long-term / immediate / exploration) |
| Cradle (2403.03186) | Task Inference → Action Planning | Screenshots → **generated code for keyboard/mouse** | Memory of experiences + curated skills | Self-reflection predicts infeasible tasks | Reflection triggers replanning | RDR2, Stardew, Cities, Dealer's Life, OSWorld (7.81%) |
| OmniJARVIS (2407.00114) | Single VLA; chain-of-thought then 32-step behavior tokens | **Unified vision-language-action tokens** (FSQ) + IL decoder | Memory as tokens in the sequence | Implicit (re-reason every 32 steps) | Re-reason window, no explicit β | Atomic/programmatic/creative Minecraft tasks |
| MineDreamer (2403.12037) | Instruction → imagined sub-goals | Diffusion "imaginations" → VPT policy (pixels/keyboard) | Chain-of-Imagination visual prompts | None explicit | Instruction re-fed per stage | Early-game item counts vs VPT/STEVE-1 |
| VPT / STEVE-1 (2206.11795 / 2306.00937) | None (no planner) | Mouse/keyboard from pixels; STEVE conditions on text | None | None | Fixed episode horizon | 12/13 early-game tasks (STEVE-1) |
| DreamerV3 (2301.04104; Nature 2025) | None (flat policy, world model) | Discrete action space incl. abstract crafting | Recurrent world model (latent) | None | Episode horizon / death | 100M-step Minecraft Diamond from scratch |
| Options (Sutton 1999) | Option = `(I, π, β)` selected by a policy over options | Abstract: option composes primitive actions | Value functions at two timescales | Not applicable | **β explicit; interruption is proved safe** | Theory + tabular/control |
| Option-Critic (1609.05140) | Learned options | Continuous/discrete primitive actions | Value critic `Q_U`, `Q_Ω` | None | **β learned by termination gradient**; switching penalty bias | ALE + continuous control |
| **Ours (Jev/Mercury)** | Deterministic ladder + Mercury sparse Option repair | **Grounded candidate set**; Jev `π` chooses id; no free-form code/coords | Durable `WorldMemory` + `GoalQueue` ledger (world-keyed in principle) | **Deterministic success predicate + VERIFY** (inventory/coords) | Jev `β` proposed; deterministic meta-controller holds final authority (#24) | M0/M1 PASS, M2 partial; inventory predicates, not a public suite |

---

## 3. What we adopt / reject

**Adopt**
1. **Grounded candidate selection over free-form action generation.** Voyager's code-as-action needs
   GPT-4 and still hallucinates APIs/items; GITM/Odyssey show grounded structured actions work with
   weaker models. Our grounded candidate set is the right side of this split.
2. **Explicit `(I, π, β)` Option shape with deterministic initiation/success** (Options 1999; our
   #21). Options-framework interruption result supports keeping a fast deterministic interrupt
   (wedge/cooldown) even while a higher-level policy exists.
3. **Feasibility-aware ordering.** DEPS's learned selector exists precisely because plans that ignore
   achievability are infeasible. Our deterministic ladder should expose cost/feasibility so repair can
   reorder, not just swap names (ties into #29, #41).
4. **Situation-conditioned memory keys.** JARVIS-1 keys memory on task+observation; GITM keys on
   sub-goal. Our `WorldMemory` must be keyed by world/dimension/epoch (#16/#17/#25/#31), not by name.
5. **Feedback loop into plan repair.** GITM and DEPS both show a descriptor/feedback step is required;
   Mercury being exception-driven and sparse matches this and avoids the cost of hot-path planning.
6. **Independent verification module.** MP5's Patroller and Voyager's self-verification (most important
   ablation, −73%) both put verification outside the acting decision. Our deterministic VERIFY is the
   same shape and is stronger.
7. **Switching penalty / hysteresis.** Option-Critic's switch penalty is the published analogue of
   our #24 hysteresis/corroboration/cooldown.
8. **State the comparison unit.** Project Sid's caveats about inventory-on-death and prompt-iterations
   vs. time mean we must publish wall-clock + inventory predicates + world seed.

**Reject**
1. **Free-form code / coordinates / entity ids from the model** (already rejected in PLANNERS.md §5).
   Voyager succeeds with it but pays GPT-4 cost and hits hallucination and API errors.
2. **Unified VLA tokenization / imitation learning** (OmniJARVIS, STEVE-1, VPT): needs huge labeled
   gameplay data and a GPU budget; also removes the interpretable layer we want for safety.
3. **World-model RL from scratch** (DreamerV3): 100M env steps and a different engineering universe.
4. **LLM on the hot decision path.** Every hot-path LLM planner here (Voyager, DEPS, MP5) accepts
   seconds of latency and, in Voyager's case, pauses the server. Jev is our batched local policy; this
   is a deliberate divergence and should be stated as such, not hidden.
5. **Blind plan replay from cache.** See §4 (stale/cached plan reuse).

---

## 4. Failure modes in the literature that match ours

| Our failure mode | Reported in prior work | Known fix to adopt? |
|---|---|---|
| **Oscillation / freezing / wedge** | Voyager: stuck after 4 code rounds → curriculum re-query; GitHub issues show identical-task loops; Cradle "circling aimlessly". Option-Critic: switching penalty. | **Yes.** Bounded retries + task switch (Voyager), and a switching penalty/cooldown (Option-Critic) → validates #24 hysteresis/cooldown. Our current wedge detector is a coarse version; add per-face attempt caps. |
| **Strategy labels not reaching the body (semantic-action gap)** | OmniJARVIS names "textual goals to separate controllers … may fail to correctly pilot these controllers" (cites DEPS/JARVIS-1/Voyager). MineDreamer: STEVE-1 "struggles to understand natural language prompts". | **Yes, as a check.** OmniJARVIS's fix (action tokens) is out of scope, but the finding demands our #29/#20 accept test: distinct strategy labels must compile to distinct grounded candidates. Otherwise do not ship the label. |
| **Stale / cached plan reuse** | GITM/JARVIS-1/Voyager reuse stored plans; reflexive-memory literature shows blind reuse harms: "Honest Lying" (arXiv:2605.29463) reports frozen memory with 0/121 reflections naming the correct target and RRR↑ predicting failure. | **Yes.** Re-validate cached plans against fresh state before replay (`GoalQueue` epoch/candidateSetHash); record refusals. Applies directly to #15/#30. Programmatic failure signals beat open-ended self-diagnosis. |
| **Precondition deadlock** | Odyssey uses a recursive prerequisite-check method; GITM decomposes with explicit Material/Tool fields; #12 LADDER_PREREQ exists for this. | **Yes.** Expand prerequisites from live inventory; stop only when provably unsatisfiable, and don't immediately re-stop on the same impossible goal. Matches our landed #12 fix and #41. |
| **Unbounded descending / digging** | No Minecraft paper I found treats "unbounded vertical digging" as a first-class failure; RL agents use fixed horizons and abstract action spaces. `[U]` | **No known fix found.** Our deterministic resource-class guard + a hard descent/attempt budget is the mitigation; add explicit horizon accounting and log `DESCENT_LIMIT`. |
| **Memory across death / respawn** | GITM/JARVIS-1 memory persists across episodes; Project Sid notes Voyager-style agents "recovered with their entire inventory intact when they died", i.e., different death semantics change results. | **Yes, partially.** Durable world-keyed memory (we have `buddy-state.json`) + explicit death semantics. Adopt "publish your death/respawn rule"; ties to #25/#26/#34. |
| **Dimension changes** | JARVIS-1 keys memory on situation (biome/weather); no paper I found isolates a memory namespace bug on Nether/End transition specifically. `[U]` | **Partial.** Namespace memory by dimension/world epoch (#16/#17/#25); treat as correctness, not research. |
| **Termination / abandon evaluation** | Option-Critic learns β only with a value signal; BASALT uses human pairwise eval; DEPS/GITM report success and steps. MineDojo/Odyssey report task-specific metrics. | **Yes, procedurally.** Our #23 replay/A-B should report useful-termination rate + guard rejection + progress, not just "did we stop". β authority only after calibration (#22 → #24). |
| **Self-verification reliability** | Voyager: self-verification is the single most important feedback (−73% without). Contrast: "LLMs Cannot Self-Correct Reasoning Yet" (Huang et al. 2024, arXiv:2310.01798) and the progress-mirage work (arXiv:2607.25152) show self-report/self-verdict ungrounded in the world is unreliable. | **Yes, and it validates our design.** Keep success in deterministic code; never let Jev's semantic scores gate progress. Voyager's self-verification worked because it read *inventory*, i.e., it was grounded. |

---

## 5. Roadmap implications and flagged claims

Mapping to our issues (verified titles fetched from the tracker):

- **#11 Grounded Options (`π`+`β`).** Directly backed by Sutton 1999 (option = `(I, π, β)`) and by the
  LLM+Options line (LDSC, LLM-SOARL, HiPER): LLM proposes subgoals/schema, a grounded lower layer
  selects and terminates. Our design is a standard, defensible shape. No dead end.
- **#20 SkillCandidate contract / grounded grounding.** Mandatory, per OmniJARVIS's named
  controller-piloting failure and MineDreamer's text-to-control instability. Acceptance must be
  "different strategy → different grounded candidate", not "different label".
- **#21 OptionSpec + deterministic initiation/success.** Exactly the Options 1999 triple; Odyssey's
  recursive prerequisite check and GITM's `(Material, Tool)` fields show the precondition encoding is
  necessary. Keep initiation/success deterministic (code truth).
- **#22 `abandon_option` β shadow.** Option-Critic shows β is learnable, but *only with a value/reward
  signal*. We have none yet; #23 must come first. Shadow-only is correct.
- **#23 replay/A-B harness.** Prior work evaluates termination by outcome metrics (success, steps,
  health, time). Mirror that: judge the controller on useful-termination rate, guard rejections,
  verified progress, and calibration — not on the model's own confidence.
- **#24 β termination controller (hysteresis/corroboration/cooldown).** Option-Critic's switching
  penalty is the published analogue. Adopt cooldown + corroboration; keep hard deterministic
  invalidation on the fast path (Sutton's interruption result: interrupting to a better option is
  safe and can beat the plan).
- **#41 predicate-based capability graph.** DEPS challenge #2 and its learned Selector are the
  strongest external argument that a capability graph must carry **achievability/feasibility**, not
  just item dependencies. Add a feasibility/cost signal to the graph so Mercury can reorder; this also
  addresses #29 at the planning layer. This is the single most important roadmap implication.

**Claims in our docs flagged as known dead ends / risks**

1. **A purely static, item-ordered ladder with no feasibility signal** (`PLANNERS.md` §1(1),
   `AGENTS.md` roadmap) matches DEPS's stated failure mode #2 (plans infeasible because achievability
   is ignored). Not a whole dead end — but the *ordering policy* should be declared known-incomplete
   and moved under #41/#29. Flagged.
2. **"Mercury cache hit plan replay" (#15)** as currently described is blind plan reuse. The memory-
   confabulation and stale-memory results show stored plans must be re-validated against fresh state.
   Flagged as a known dead end unless replay is epoch/hash-gated. `PLANNERS.md` §4 already lists #15 as
   a correctness bug — good; this survey says it is also a literature-recognized failure.
3. **Any plan to let self-reported semantic scores (`goal_progress`, `plan_still_valid`,
   `situation_understood`) steer actions** is the Reflexion/self-correction dead end; `ARCHITECTURE.md`
   (update 2026-09-18 §"Design direction") already demotes them to shadow metrics. This survey
   **endorses** that change; if any code path still acts on them, that path is the dead end.
4. **Giving Jev β authority before calibration** would repeat the progress-mirage error (a
   self-graded loop accepting non-progress). `AGENTS.md`/`PLANNERS.md` already require replay/calibration
   first — endorsed; do not shortcut it.
5. **Free-form coordinate/entity/skill-parameter generation** (rejected in `PLANNERS.md` §5) is
   confirmed as high-risk by Voyager hallucinations; maintained rejection.

---

## 6. What to cite when we publish

A reviewer will expect, at minimum:

- **LLM-planning baselines:** Voyager (2305.16291), DEPS (2302.01560), GITM (2305.17144),
  JARVIS-1 (2311.05997), Odyssey (2407.15325). If we claim "grounded candidates beat free-form code",
  Voyager is the baseline to argue against, and GITM/Odyssey are the fair grounded comparisons.
- **Low-level control baselines:** VPT (2206.11795), STEVE-1 (2306.00937), DreamerV3
  (2301.04104 / Nature 2025), and note Cradle (2403.03186) as the API-free counterpoint.
- **Hierarchical-control framing:** Sutton/Precup/Singh 1999 and Option-Critic (1609.05140) for
  `(I, π, β)` and for the termination term; a 2025–26 LLM+Options hybrid (LDSC 2503.19007,
  LLM-SOARL 2603.01488) to show the pattern is live.
- **Benchmarks:** MineDojo (2206.08853) and MineCLIP as the standard task suite/metric; MineRL
  Diamond / ObtainDiamond (1904.10079, 2202.10583); MineRL BASALT (2107.01969) for human-eval tasks;
  Odyssey benchmark (2407.15325). State our own setting (live Leaf 1.21.11, offline, peaceful, seed
  2024) and that M0/M1 are inventory-predicate passes, not benchmark scores.
- **Failure-mode / evaluation rigour:** Reflexion (2303.11366) and the self-correction critique
  (2310.01798); the progress-mirage (2607.25152) and memory-confabulation (2605.29463) work for why
  our verification is deterministic. Project Sid (2411.00114) for comparison hygiene.
- **Corrections to the issue's citation list, to avoid propagating errors:** BASALT is
  **arXiv:2107.01969** (not 2109.13398); STEVE-1 is **arXiv:2306.00937** (not 2311.16235); DEPS is
  **2302.01560**; MP5 is **2312.07472**. `[V]`

---

## 7. Timebox / remaining work

Covered within the box: Voyager; DEPS/GITM/MP5/Odyssey/JARVIS-1/Cradle; VLM/imitation (MineDojo/
MineCLIP, VPT, STEVE-1, DreamerV3); Options and Option-Critic; LLM+Options hybrids; benchmarks; the
full failure-mode mapping and roadmap mapping.

Remaining (not needed for acceptance, listed per instructions): deeper numeric extraction from
Cradle's per-task tables and LEHCA (paywalled) `[U]`; SIMA 1/2 comparison numbers beyond the SIMA 2
abstract `[U]`; a systematic 2026 successor sweep beyond the works cited; MCU benchmark internals
`[U]`.

Sources verified 2026-09-18 via arXiv/venue abstract pages and repository issue trackers. Anything
marked `[U]` is a lead and must be re-checked before it is used as a factual claim.
