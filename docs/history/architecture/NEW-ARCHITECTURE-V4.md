# Architecture Reset

> **Superseded by `docs/architecture/NEW-ARCHITECTURE-V4.1.2.md`.** Retained as semantic lineage (root `AGENTS.md` §0 precedence item 4), not as current instruction.

## Grounded Option OS を終わらせ、Verified Transition Runtime へ

**Repository:** `souta-lab/minecraft-jev-agent`
**Audit date:** 2026-09-24
**Audited main:** `355a26796c4891ecf68ab8ef70cfdd2b626df225`
**Scope:** repository全体、production path、git history、Issues/PRs、runtime evidence、Minecraft環境、既存prior work
**Original audit implementation status (2026-09-24):** なし。原監査はコード変更・Issue変更を行わずarchitecture提言のみを作成した。2026-09-25のJev role clarificationはarchitecture文言の更新であり、Reach VTR実装は別worktree/commitで進行している。

---

# 0. Executive Verdict

このprojectに対する提言は一つである。

> **#11 / #308 の Grounded Option OS をprojectの最終architectureとして扱うのをやめ、production runtimeを「Verified Transition Runtime」に再設計する。**
>
> Agentの基本単位を
> **Option → Jev π/β → Skill**
> から
> **世界状態predicateを成立させる、永続的で検証可能な閉ループTransition Controller**
> へ変更する。
>
> System2は常時WHAT authorityからsparse reasoningへ下げる。一方Jevは、このrepositoryでは**production-defaultの高速System-One decision policy**として維持・強化する。ただしJev π/βをuniversal execution/termination authorityにはしない。VTR kernelがJev providerなしでも検証・ownership・既commit mechanicsを維持できることと、projectの主知能としてJevを積極利用することは両立する。

これは #11 の改善案ではない。

**#11 の中心原則を部分的に否定する提言である。**

> **2026-09-25 Jev role clarification:** repo内の実装と外部Jev仕様を再監査した結果、V4で降格すべきなのはJevそのものではなく、`π = universal WHICH` / `β = universal WHETHER` というauthority splitである。現行Jev pathは `choice | score | boolean` のtyped questionsを一回のevaluate callへbatchでき、calibrated-confidence provenanceも保持できる。したがってVTR上では、Jevをgrounded Transition routing/scoring/in-contract arbitrationのprimary fast decision layerとして使う。一方、commit、actuation ownership、world truth、SUCCESS/terminationはVTRが保持する。

現在のarchitectureが誤って中心に置いているのは、

> 「誰が WHAT / WHICH / WHETHER を決めるか」

である。

Minecraft長期自律攻略で本当に中心に置くべきなのは、

> **「現実のworld stateを、外乱の中で、検証可能に、別のworld stateへ収束させ続けられるか」**

である。

この違いは抽象的な哲学論ではない。

現在repositoryに残っている複数の重大failureは、ほぼすべてこの一つの設計上の誤認から説明できる。

---

# 1. Fresh-contextで見た現在のproject

## 1.1 現在のproduction architectureはすでにかなり高度である

「まだ #11 がちゃんと実装されていないから動かない」という説明だけでは不十分である。

現在のrepositoryにはすでに、

* resident HOST
* hot reload
* actuation lease
* world epoch / world key
* durable world memory
* run provenance
* run-scoped evidence
* typed System2 path
* Jev π
* Jev β
* grounded candidate generation
* OptionSpec
* GoalQueue
* SkillCommitment
* effect envelope
* typed Skill outcome
* Guard
* deterministic postcondition verification
* locomotion Skill closure
* semantic projection
* stale-result fencing
* provider recovery
* benchmark gates

が存在する。

つまりこれは「雑なLLM botが失敗しているproject」ではない。

むしろ、

> **かなり真剣にauthority boundaryを設計し、数百のfailureを型・identity・ledger・evidence・guardで封じ込めてきたproject**

である。

それでも長期自律攻略は安定していない。

ここが最重要点である。

---

# 2. 実際のproduction path

現在のproductionは概念上、おおむね次の経路を通る。

**Resident HOST → generation-entry → System2/Planner → GoalQueue / OptionSpec → grounded candidate generation → Jev π/β → SkillCommitment → Executor → deterministic VERIFY → outcome → 再decision**

HOST部分はかなり健全である。

問題は中央のsemantic/control planeである。

しかも現在の「新architecture」はまだ相当量がlegacy implementationの上に構築されている。

代表的には、

* `buddy-driver/planner.ts`

  * production System2 authorityを名乗る
  * しかし `planner-legacy.ts` をexportしている
* `jev-agent/src/controller.ts`

  * #11 authority facade
  * 実体は `LegacyJevController` を継承
  * 14,000行超の `controller-legacy.ts` の内部関数を書き換えるstrangler
* `jev-agent/src/optionSpec.ts`

  * first-class Option facade
  * 実装本体は `optionSpec-legacy.ts`

となっている。

これは単なるcleanup debtではない。

新しいauthority modelを、**古い反応ループの上から制約によって矯正している**。

そのためarchitecture上の小さな境界変更が、

* failure memory
* retry
* candidate suppression
* beta
* GoalQueue
* prerequisite
* System2 escalation
* progress
* stale-result
* Skill identity
* world memory

へ波及する。

---

# 3. Repositoryの物理的形状も同じことを語っている

現在のtracked fileは約644。

主要text/codeだけでも約30万行ある。

特に中核は、

| File                                 | Approx. lines |
| ------------------------------------ | ------------: |
| `jev-agent/src/candidates.ts`        |        14,779 |
| `jev-agent/src/controller-legacy.ts` |        14,034 |
| `jev-agent/src/executor.ts`          |        12,715 |
| `jev-agent/src/state.ts`             |         5,291 |
| `buddy-driver/planner-legacy.ts`     |         3,623 |
| `buddy-driver/generation-entry.ts`   |         3,495 |
| `buddy-driver/mercury-system2.ts`    |         3,488 |
| `buddy-driver/agent-runner.mts`      |         3,147 |
| `jev-agent/src/optionSpec-legacy.ts` |         2,203 |
| `jev-agent/src/goalQueue.ts`         |         1,971 |

である。

`jev-agent/src` だけで約88k行、`buddy-driver` 約51k行。

これは「大きいから悪い」という話ではない。

問題は、これらの巨大化のかなりの部分が、

> **異なる時間スケールの制御責務を、毎回 semantic authority boundary を越えて受け渡すための bookkeeping**

になっていることである。

---

# 4. #11 が正しく発見したこと

#11 を全面的に否定する必要はない。

むしろ多くの発見は正しい。

特に以下は維持すべきである。

* world truthをLLMに決めさせない
* mechanical feasibilityをLLMに捏造させない
* action dispatchとverified successを分離する
* stale decisionを実行しない
* world/dimension/epoch identityを持つ
* raw model outputを直接actuationへ流さない
* benchmark ladderをproduction semanticsにしない
* Mineflayer executionをtyped postconditionで閉じる
* model failure時にこっそり別policyへfallbackしない
* primitive action一回をsemantic action一回と誤認しない

これらは残すべきである。

問題は、その上に置いた次の公理である。

> **semantic meaningのある選択はmodel policyへ戻す。**

さらに具体的には、

* System2 = WHAT
* Jev π = WHICH
* Jev β = WHETHER
* Skill = HOW

という分割である。

この分割がMinecraftでは安定しない。

---

# 5. 根本的に誤解しているもの

## 5.1 「semantic choice」と「mechanical continuation」の境界はMinecraftでは安定した境界ではない

Minecraftでは、

* 壁を掘る
* 回り込む
* 橋を作る
* pillarする
* staircaseを掘る
* lateral searchする
* 別の木へ向かう
* 別のmobを狙う
* swordを装備する
* 一度離脱して食べる

といった選択が存在する。

現在のarchitectureはこれらを、

「意味が変わるならJev」
「同じtargetを機械的に実現するだけならSkill」

と分類しようとしている。

しかし実世界の閉ループ制御では、この境界は非常に不自然である。

たとえば「30ブロック先の位置へ到達する」という目的に対して、

* 平地を歩く
* 小さい穴を飛び越える
* 一ブロック高をjumpする
* 崖で数ブロックbridgeする
* 行き止まりなら数ブロック戻って迂回する

はすべて、

**同じ到達predicateを満たす一つのnavigation controller内部の戦術**

として扱える。

それを「橋を使うか迂回するかはsemanticだからJevへ戻す」とすると、controllerが環境へ適応するたびに上位policy callになる。

現在 #476 がまさに、

* staircase
* lateral search
* detour

のようなcode-owned recovery strategyを消し、typed alternativesとしてJevへ返す方向を要求している。

私はこの方向を**逆向きだと判断する**。

---

# 6. Repository自身がすでに反証を持っている

## 6.1 `walkSkill.ts` が最も重要な証拠

現在の `walkSkill.ts` には、非常に重要な実測結果が明記されている。

以前はmovement mechanicsそのものは動いていた。

しかし一つのwalkがprimitive legごとに終了し、そのたびにJevへ戻っていた。

結果、

* 同じようなMOVEを何度もmodelが再選択
* mechanicsは成功
* semantic throughputは低い

という状態になっていた。

その修正として、一回のselectionから最大16 mechanical legを一つのSkillが所有できるようになった。

これは局所的なmovement fixではない。

**architecture experimentとして極めて重要である。**

成功した理由は、

> Jevをより賢くしたからではない。

> **Jevへdecisionを返さなくしたからである。**

---

# 7. #360 はさらに強い反証である

#360 の約48.5分のruntime auditでは、

* policy MOVE: **1,888**
* WAIT: **258**
* verified causal success: **1,882**
* execution failure: わずか **7**
* 累積移動距離: **約1,533 blocks**
* net displacement: **約0.815 blocks**
* locomotion efficiency: **約0.053%**
* goal progress: **0**
* search progress: **0**
* oscillation detection: **401**
* β output: **2,148**
* β abandonment threshold到達: **0**
* policy call: 約 **2,147**
* policy call input: 平均約 **7,737 tokens**
* 約48分でおよそ **16.6 million input tokens**

だった。

これは「movementが壊れている」failureではない。

movementはほぼ全部成功している。

これは、

> **世界を変えていないのに、decision systemだけが正常稼働し続けるfailure**

である。

つまり現architectureは、

**actuation successを大量生産できるが、state transitionを閉じられない。**

---

# 8. 2026-09-24 の最新runにも同じ構造がある

`run-mufel6fc-v84z` の8,925行のmetrics windowでは、

* Jev decisions: **78**
* Jev epoch/model calls: **115**
* top-level ACTION: **15**
* actions/modelCall: **0.13**
* Skill commitments: **76**
* Skill internal steps: **216**
* distinct Option IDs: **2**

である。

重要なのは216 internal Skill stepsである。

**Skill内部ではすでに複数stepをまとめられている。**

それにもかかわらず外側では115 model callsが発生している。

つまり次に最適化すべき対象は、

> model latency

ではない。

> **policy boundaryの数そのもの**

である。

---

# 9. β は問題を解決する層ではなく、問題によって必要になった層である

現在 Jev β は、

> 「このOptionをsemanticに続ける価値があるか」

を判断する。

しかし長期runtimeを見るとβを成立させるために、

* abandonment threshold
* attempt history
* hysteresis
* protected prerequisites
* progress deferral
* WAIT suppression
* oscillation evidence
* strategic non-progress
* locomotion efficiency
* forced exhaustion
* state recurrence
* deterministic override
* beta authority fencing

が必要になっている。

#360 では48分間stalledしてもβは一度もthresholdを越えなかった。

その後、

* state recurrenceをβへ渡す
* body motionだけではcontinueさせない
* code-proven stallでsemantic layerへ戻す
* WAITがabandonを抑止し続けないようにする

などのfixが入った。

これは個々には妥当である。

しかし全体では別のことを示している。

> **「worth continuing」をmodelへ毎回推定させる抽象そのものが弱い。**

Transitionの終了は本来、

* postcondition achieved
* invariant violated
* required capability lost
* target class unavailable
* budget exhausted
* progress contract exhausted
* world changed
* transition proved infeasible

のような**観測可能なcontract result**で表現できる。

通常のtransitionにβは必要ない。

---

# 10. #442 は「progress」という共有scalarの危険性を示した

#442 ではstationary windowに対して、

`traveled=0, net=0`

なのに locomotion efficiency が **100%** と記録されていた。

その値は単なるtelemetryではなく、

* betaのprogress判定
* failure-memory reset

に利用されていた。

つまり、

> 一つのderived scalarの意味の混同が、termination・recovery・memoryへ連鎖する。

これも「βにもっと良いcontextを送る」だけの問題ではない。

各Transitionが、

> **自分にとって何がprogressなのか**

を明示すべきである。

Navigationなら距離やreachable frontier。

Searchなら新規観測・coverage・frontier expansion。

Acquireならinventory/postcondition。

Buildならverified structure predicate。

Combatならencounter objectiveとsurvival margin。

全Transition共通の曖昧なprogress scalarを作る必要はない。

---

# 11. GoalQueueもarchitectureの中心に置くべきではない

GoalQueueは現在非常に多くの責務を持つ。

* active goal
* pending goals
* prerequisites
* protected/core semantics
* lifecycle
* durable recovery
* plan reconciliation
* dependency ordering
* orphan retirement
* done history

などである。

しかしhistoryを見ると、

* 完了済みdependentのprerequisiteがqueue headに残る
* protected/core smeltが本当の次goalを塞ぐ
* live portalが存在するのに古いobsidian build goalがrestoreされる
* food goalがprotected headとして新しいvalid planを塞ぐ
* System2が出したintentがqueue/ladder compatibilityで別goalに変わる
* queue empty時にlegacy ladderがsemantic authorityを取り戻す

といったfailureが繰り返し発生している。

根本問題は、

> **履歴・予定・dependency・semantic authorityを一つのmutable queueに入れていること**

である。

Minecraftの「次に必要なもの」はqueueから読むべきではない。

**現在world factsとmission predicateから導出すべきである。**

---

# 12. Nether survivalは「candidate selection」の問題ではない

`docs/history/incidents/NETHER-SURVIVAL-2026-09-22.md` はさらに重要である。

33時間超のauditでは、

* Overworld→Nether expedition: 79
* 少なくとも一度real death: 75/79
* Nether death: 74/79

という非常に高い死亡率だった。

代表的なmagma cube caseでは、

* threatは約3m
* ATTACK可能
* JevはRETREAT選択
* retreatでむしろ敵との距離が縮む
* healthが急減
* ATTACKせず死亡

した。

さらに装備可能なweaponを持っていても、

ATTACKを選ぶまでweapon equipが起こらない時期もあった。

これは、

> ATTACK / RETREAT / EQUIP / EAT をco-equal semantic candidatesとして扱う

ことの弱さを示している。

生存は「次にどのactionを選ぶか」ではない。

**並行して維持すべきviability constraint**である。

---

# 13. Minecraftというenvironment自体が要求するarchitecture

現在のruntime stackは、

* Minecraft 1.21.11系
* Mineflayer `^4.39.0`
* mineflayer-pathfinder `^2.4.5`
* minecraft-data `^3.116.0`

を利用している。

Minecraftはcontrol architectureの観点ではかなり特殊なhybrid environmentである。

同時に存在するのは、

* discrete block world
* continuous/sub-block body physics
* asynchronous server truth
* moving entities
* partial observation
* inventory constraints
* tool capability
* recipes
* stations
* irreversible digging/placement
* long-distance navigation
* information-gathering search
* health/hunger/air
* combat
* deathによる巨大なstate regression
* dimension transition
* durable world modifications

である。

これは「次action classifier」が得意なenvironmentではない。

**symbolic dependency planning + feedback control + persistent memory + event-driven verification**が必要なenvironmentである。

言い換えれば、

> Minecraft攻略の自然な基本単位はactionではなく、**world-state transition**である。

---

# 14. 現projectの根本的category error

現在projectは、agentをおおむね次のように捉えている。

> 良いcandidate setを作る
> → 正しいauthorityへ選ばせる
> → Skillが実行する
> → 結果を返す
> → また正しいauthorityへ選ばせる

しかし長期自律攻略で必要なのは、

> desired stateを指定する
> → controllerが外乱へ適応しながら世界を変え続ける
> → condition成立を検証する
> → 成立/不成立というcausal resultだけを上位へ返す

である。

つまりrepositoryは、

> **decision qualityを中心に置きすぎている。**

本当に不足しているのは、

> **causal closureである。**

---

# 15. 一つの提言: Verified Transition Runtime

新architectureの中心を **Verified Transition Runtime (VTR)** とする。

Agentのcanonical stateを、

* Mission
* OptionGraph
* OptionLedger
* GoalQueue

ではなく、

1. **Desired Predicates**
2. **Verified World Facts**
3. **Transition Graph**
4. **Active Transition Contracts**
5. **Transition Journal**
6. **Viability State**

に置く。

全体の流れは、

**Mission predicates → unsatisfied predicate frontier → Transition Scheduler → persistent Transition Controller → deterministic actuation/verification → verified world facts → frontier再導出**

となる。

System2はこの経路の常時必須componentではない。

Jev π/βも常時必須componentではない。

---

# 16. Transition Contractが新しい基本単位になる

一つのTransitionは最低限、

* **requires**

  * 開始に必要なworld predicate
* **ensures**

  * 終了時に成立させるpredicate
* **invariants**

  * 実行中に守るべき条件
* **allowed effects**

  * dig/place/attack/item consumptionなどの許容範囲
* **resource/risk budget**

  * 消費可能資源・危険量
* **progress contract**

  * このTransitionにとって何が前進か
* **controller**

  * closed-loop execution policy
* **terminal failures**

  * 何を観測したらこのTransitionでは達成不能とみなすか
* **world/epoch identity**

  * どの世界事実へbindされているか

を持つ。

重要なのはtarget coordinateではない。

**ensures predicateがidentityの中心になる。**

---

# 17. 新しいarchitectureの最重要ルール

#11 の現在のsemantic boundary ruleを、次へ置き換える。

> **desired predicate、許容されるirreversible effects、risk/resource budgetが変わらない限り、戦術変更はTransition Controllerの責務である。**

したがって、

同じ `reach(destination)` を満たすための、

* walk
* jump
* re-path
* detour
* short bridge
* pillar
* staircase
* clearance dig

は、contractが許しているなら同じTransition内部で選択してよい。

Jevへ戻す必要はない。

一方、

* 別のmission predicateへ移る
* 予定より大きなworld mutationが必要
* 許容budgetを越える
* lethal risk thresholdを越える
* dependency assumptionが崩れた

なら、そこで初めて上位Schedulerへ返す。

**これが本当に安定したpolicy boundaryである。**

---

# 18. 「大きなSkill」に名前を変えるだけではない

これは #436 のSkillCommitmentを大きくするだけではない。

両者には決定的な違いがある。

現在のSkillCommitmentは、

> Jevが選択したcandidate / exact target / effect envelopeを維持する

ことが中心である。

そのためtargetが無効になると、基本的にはpolicyへ戻る。

VTRでは、

> **exact targetはTransitionを実現するための一時的なwitness**

でしかない。

たとえば `acquire(log, 3)` なら、

* oak log Aを見つける
* Aが届かなくなる
* nearby birch log Bへretargetする
* Bへnavigate
* dig
* dropを追跡
* pickup
* count不足なら次のlogを探す

までを一つのTransitionが所有できる。

semantic identityは、

`log A`

ではない。

`inventory contains log-class >= 3`

である。

この差は非常に大きい。

---

# 19. Navigationをどう捉え直すべきか

現在の `walkSkill.ts` はVTRの最初のprototypeとみなせる。

ただしまだ #11 によって、

「普通のwalkが障害に遭遇しても、新しい意味的戦術を勝手に獲得してはいけない」

と強く制限されている。

VTRではここを広げる。

Navigation Transitionが、

* destination predicate
* damage risk
* block modification budget
* placement budget
* protected block constraints

を宣言していれば、

その範囲内でcontrollerが、

* walk
* jump
* bridge
* dig
* detour
* pillar

を組み合わせる。

「bridgeとdetourのどちらがsemanticか」をarchitecture全体で決める必要がなくなる。

単なるcontroller optimizationになる。

---

# 20. Searchもpersistent Transitionにする

現在のprojectでは探索が、

* EXPLORE
* local MOVE
* DESCEND
* staircase
* lateral search
* frontier move
* known resource RETRIEVE

など複数層へ分散している。

VTRではSearch Transition自身が、

> `find(resource/structure/entity class)`

というpredicateを所有する。

Searchのprogressは、

* unexplored frontier reduction
* new chunks/cells observed
* new structural evidence
* new relevant entities
* hypothesis elimination

で測る。

「身体が動いた」はSearch progressではない。

これだけで #360 型failureの大部分が構造的に消える。

---

# 21. SurvivalはTransitionではなく並行Invariant Runtimeへ

長期無人運転で、

* hunger
* oxygen
* imminent fall
* lava/fire
* lethal hostile pressure
* equipment
* immediate escape margin

は、通常missionと同じqueueへ並べるべきではない。

これらは**viability controller**が並行維持する。

Mission Transitionは、

> 「diamondを探している」

かもしれない。

しかしviability controllerは必要なら一時的に、

* evade
* block
* equip
* eat
* surface for air
* disengage
* fight

を行い、viabilityを回復させる。

回復後、元Transitionをfresh world stateから再評価する。

これは「semantic authority bypass」ではない。

**生存可能状態が全missionのinvariantなのである。**

Netherの95%級death rateを考えると、これはoptional featureではなくarchitecture coreである。

---

# 22. GoalQueueをderived viewへ落とす

新runtimeでpersistent queueをsemantic truthにしない。

代わりに、

> **Mission predicates − verified predicates = current unsatisfied frontier**

を常に導出する。

Dependency graphから現在実行可能なTransitionを求める。

これにより、

* 已に成立したportal build goalが復活する
* orphan prerequisiteがqueue headへ残る
* food recoveryが古い保護状態で次goalを塞ぐ
* restore時に古いfrontierが復活する

といった問題を根本から減らせる。

QueueをUI/debug viewとして生成するのはよい。

しかし**authorityにしない。**

---

# 23. Memory modelも変える

現在のmemoryは有用なものを大量に持っている。

ここは捨てるのではなく整理する。

必要なのは三種類である。

## 23.1 Fact Store

世界について知っていること。

* resources
* structures
* stations
* portal sites
* traversals
* hazards
* containers
* entities
* dimension/world epoch
* provenance
* observation age
* UNKNOWN / absent / verified の区別

これは現在のWorldMemoryを発展させればよい。

## 23.2 Transition Journal

何をしようとして、何が起きたか。

* transition type
* context
* initial facts
* strategy/mode
* resource delta
* duration
* progress
* final outcome
* failure cause

append-onlyでよい。

Agendaではない。

## 23.3 Experience Model

長期的に、

* このterrainでこのnavigation modeは成功したか
* この装備でこのmob encounterは危険か
* どのsearch modeが有効だったか
* transitionのtime/resource/risk cost

を推定する。

これによって「同じ失敗を二度としない」が、個別blacklist/counterの寄せ集めではなくなる。

---

# 24. Schedulerではdeterministic policyを禁じない

現在の「A fact is not a policy」は、歴史的には必要な防波堤だった。

legacy codeが勝手に、

* benchmark route
* first strategy
* nearest candidate
* magic retry count

をsemantic authorityとして使うのを止めるためである。

しかし最終architectureの憲法としては強すぎる。

距離、成功確率、hazard、resource cost、expected progressが明示的にモデル化されているなら、

**codeがそれを使ってtransitionを選ぶことは禁止すべきではない。**

重要なのは、

> deterministicであること

ではなく、

> **何を最適化しているかがexplicitで、groundedで、検証可能であること**

である。

経路探索を毎回LLMに決めさせないのと同じである。

---

# 25. System2の新しい役割

System2は削除する必要はない。

しかし役割を大幅に下げる。

System2が呼ばれるのは、

* missionを初めてpredicate graphへ落とす
* capability graphに既知routeがない
  -複数の長期戦略が本当に意味的に異なる
* transition libraryに未知のcompositionが必要
* repeated typed failuresから新しいhypothesisが必要
* novel situationのplan repairが必要

といった**sparse reasoning boundary**だけにする。

System2 outputは引き続き、

* proposal
* typed
* grounded
* stale-fenced

であるべきである。

#439 のSystem2 Harnessの工学的内容は有用である。

しかしそれはagentのbrainそのものではなく、

> **Transition Graph repair service**

になる。

---

# 26. Jevの新しい役割 — VTR上のprimary fast decision plane

Jevは削除・周辺化しない。

このrepositoryではJevを、

> **production-defaultの高速System-One decision policy**

として扱う。

V4で廃止するのはJevそのものではなく、

> `Jev π = universal WHICH authority` / `Jev β = universal WHETHER authority`

というV3固有のauthority splitである。

Jevが得意なのは、groundされたstateとbounded alternativesに対する高速なtyped decisionである。repoの現行実装も、一つのevaluate callへ複数の `choice | score | boolean` questionをbatchし、answer provenance・latency・token usage・provider confidenceを記録できる。

したがってVTRではJevを主に次へ使う。

* enabled Transition群から次contractを選ぶ / rankする
* grounded alternativesのrisk / uncertainty / expected-value scoring
* active Transition内で、contractを変えないbounded tacticを選ぶ
* typed terminal outcome後の次Transition routing
* sparse System2を起こすべきかの高速判定

重要なのは、**Jev callとauthority handoffを同一視しないこと**である。

Controllerはactive Transitionを所有したままJevへbounded policy queryを出してよい。例えばReach contract内で `detour / bridge / staircase / backtrack` がすべてeffect/risk/resource envelope内なら、Jevがそのどれかを選んでもTransitionを終了・再commitする必要はない。

逆にJevは次を所有しない。

* world truth
* deterministic SUCCESS
* generic Transition termination
* actuation lease
* raw Mineflayer/Azalea client
* contract外effectの許可

推奨interfaceはV3の独立したπ/β callではなく、decision epochごとの **Jev Decision Frame** である。

入力は、

* bounded/versioned Verified World Model projection
* Mission frontier
* enabled Transition ids/contracts
* active budget / risk / uncertainty
* recent typed outcomes

出力は、

* grounded Choice
* Score
* boolean/probability
* calibrated confidence metadata

とする。VTR admission layerがstale identity、requires、effect envelope、budget、leaseを検証した後にのみcommitする。

「意味のある選択肢が一つしかない」「active controllerが次のmechanical continuationをcontractから一意に決められる」場合は、Jevを呼ぶ必要はない。これはJevの降格ではなく、**一回のJev decisionがより長いworld-state changeを買う**ようdecision timescaleを正すことである。

Jev provider outage中も、すでにcommit済みで新しいpolicy epochを必要としないmechanicsは継続できる。新しい意味ある選択が必要になった時点では、typed policy-unavailable/suspendか、明示的に設定されたoffline/test policyへ移る。model failureからsilentにsemantic fallbackへ切り替えてはならない。

特に **Jev β はgeneric runtime primitiveとして廃止する**。

Transition terminationはcontract outcomeとdeterministic verificationで閉じる。Jevはtermination後の次の判断を高速に行う。

---

# 27. Provider outage問題も一気に簡単になる

#471 は現在、

> provider outage時にsemantic fallbackはしてはいけない
> しかしresidentを殺すと無人運転にならない

という難しい問題になっている。

これは現architectureでは本当に難しい。

なぜならmodelがactuation hot path上のauthorityだからである。

VTRでは、すでにactiveなTransition Controllerはmodel outageと無関係に継続できる。

例えば、

`navigate_to(known portal)`

を実行中ならproviderが30秒落ちてもnavigation controllerは継続できる。

上位reasoningが必要な境界まで来た場合だけsafe holdする。

つまり、

> **model availabilityとmotor continuityを分離できる。**

これは長期無人運転に極めて重要である。

---

# 28. #476 についての明確な判断

#476 の方向、

> descent/search内部のcode-owned strategy switchを消してJevへ戻す

には賛成しない。

これは現在architectureのprincipleを純化するが、agentとしては逆効果になる可能性が高い。

必要なのは、

> strategy switchをなくすこと

ではない。

> **strategy switchがどのTransition contractの内側で正当なのかを明示すること**

である。

同じ `reach lower layer` Transitionが、

* vertical shaft
* staircase
* lateral continuation

をrisk/resource envelope内で切り替えることは許す。

Transitionそのものを変える必要が出たときだけschedulerへ戻す。

---

# 29. #436 / #440 は捨てずに一般化する

#436 Skill closureと #440 Movement OSは、現在architectureから新architectureへ繋がる最も有望な部分である。

ただし、

> semantically narrow Skill

として閉じるのではなく、

> **predicate-convergent Transition Controller**

へ発展させる。

`walkSkill.ts` が既に示した、

> one decision → many mechanical legs

を、

* navigation
* acquisition
* station use
* search
* combat
* portal interaction

へ拡張する。

---

# 30. #474 は脇役ではなくarchitecture coreになる

#474 の no-LLM Skill probe harness は非常に重要である。

現在issueでは、

> primitive capability available != agent can compose it

を検証するdiagnostic layerとして提案されている。

VTRではこれをさらに中心へ移す。

各Transition Controllerは単独で、

* initial facts
* transition
* expected predicate
* typed failure
* budget

をlive probeできるべきである。

そうするとlong-run failure時に、

> Transition単体が壊れたのか
> Scheduler/graph compositionが壊れたのか

を即座に分離できる。

---

# 31. #120 の「semanticsを変えずmega-controllerを分解」は不十分

#120 はcontroller/generation mega-orchestrationを、

> authority semanticsを変えずにcomponentへ分解する

ことを求めている。

私は先にそれを行うべきではないと判断する。

14k行のcontrollerを同じsemantic modelのまま10個のmoduleへ分けても、

**architecture上のcouplingは残る。**

先にTransition boundaryを定義する。

その結果、

* Navigation Controller
* Search Controller
* Acquisition Controller
* Craft/Station Controller
* Combat/Survival Controller
* Portal Controller

のように**自然なcausal ownership boundary**で分離できる。

---

# 32. 何を残し、何を捨てるか

| Existing concept                                 | Verdict                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| Resident HOST                                    | **KEEP**                                              |
| hot reload / atomic generation swap              | **KEEP**                                              |
| actuation lease                                  | **KEEP**                                              |
| worldKey / worldEpoch                            | **KEEP**                                              |
| run/source provenance                            | **KEEP**                                              |
| deterministic Guard                              | **KEEP**                                              |
| deterministic VERIFY                             | **KEEP / CENTER**                                     |
| minecraft-data truth                             | **KEEP / CENTER**                                     |
| typed outcomes                                   | **KEEP / CENTER**                                     |
| durable WorldMemory                              | **KEEP, redesign into fact store**                    |
| Skill mechanical implementations                 | **KEEP, promote into Transition controllers**         |
| no-LLM probes                                    | **KEEP / CENTER**                                     |
| System2 Harness                                  | **KEEP, demote to sparse graph repair**               |
| Jev Harness / typed batched decision path       | **KEEP / STRENGTHEN as primary fast decision policy** |
| Jev π universal WHICH authority                  | **REMOVE AS CORE**                                    |
| Jev β universal WHETHER authority                | **REMOVE**                                            |
| Option as fundamental runtime unit               | **REPLACE**                                           |
| OptionLedger as canonical semantic state         | **REPLACE**                                           |
| GoalQueue as semantic authority                  | **REMOVE; derived view only**                         |
| RUNGS                                            | **benchmark/baseline only**                           |
| fixed strategy menus                             | **REMOVE**                                            |
| global candidate set as brain interface          | **DEMOTE to controller-local affordances**            |
| retry/oscillation counters as cross-layer policy | **ABSORB into Transition progress/failure contracts** |
| #11 “all semantic choice returns to model”       | **SUPERSEDE**                                         |

---

# 33. 複数failureを一つの問題として説明できる

| Observed failure                 | 表面的原因                  | 共通する根本原因                                    |
| -------------------------------- | ---------------------- | ------------------------------------------- |
| #360 1.5km歩いて0.8mしか進まない          | MOVE oscillation       | action成功をTransition進捗として閉じられない              |
| βが48分Optionを続行                   | β context/threshold    | observable contract terminationをmodel推定に任せた |
| `walkSkill` primitive redecision | granularity            | controller ownershipが短すぎる                   |
| GoalQueue orphan prerequisite    | ledger bug             | agendaをmutable semantic authorityにした        |
| portalを再構築                       | memory/restore bug     | factsからfrontierを再導出せずqueueを信頼した             |
| System2 `explore` が別goalへ変換      | compiler/legacy ladder | semantic stateのauthorityが複数存在               |
| NetherでRETREATし死亡                | tactical policy        | survivalをco-equal action choiceとして扱った       |
| swordを持っているのにpickaxeで戦う          | equip timing           | encounterを一つのclosed controllerが所有していない      |
| staircase/lateral recoveryの論争    | authority boundary     | tacticsをsemantic/mechanicalの二分法で分類しようとした    |
| provider outageでresident停止       | availability           | modelがhot control pathのmandatory authority  |
| `0/0 = 100% efficiency`          | metric bug             | generic progress scalarを複数control layerが共有  |
| huge controller/candidate files  | implementation debt    | 短いownershipをcross-layer bookkeepingで補った     |

これらは別々のbugではある。

しかしarchitectureとして見ると、

> **長時間のcausal processを細かいdecision boundaryへ分解しすぎ、その境界を維持するためにmodel・queue・memory・counter・identityを増やしている**

という一つのfailure familyになる。

---

# 34. このarchitectureがbenchmark independenceにも強い理由

#365 が指摘する通り、production runtimeにはまだM2/M3-shaped semanticsが残っている。

VTRではbenchmarkを、

> mission predicateの一例

に落とせる。

例えば、

* furnaceを作る
* sandを一定数集める
* Netherへ到達する
* ender_eyeを12個得る
* dragon_killed_verified

は全て同じpredicate/transition machineryを使う。

Benchmarkは、

> どのpredicateを評価するか

だけを定義する。

どう到達するかをproductionへ教えない。

これは現在 #11 が目指しているbenchmark independenceよりさらに自然である。

---

# 35. Prior workから見てもこの方向が整合する

Repository自身の `docs/history/investigations/PRIOR-WORK.md` が調べている先行研究を見ると、

重要なのは特定のLLM architectureではない。

共通して価値があるのは、

* temporally extended executable skills
* recursive prerequisites
* automatic curriculum
* environment feedback
* self-verification
* spatial grounding
* long-term memory
* world models

である。

特にVoyager型のexecutable skill ideaや、SeekerCraftから #474 が拾った「LLMなしでmechanicsをprobeする」disciplineは、

> capabilityを一度獲得したら、毎primitive stepをreasoning modelへ戻さない

という方向を支持する。

コピーすべき実装はない。

しかし**control timescaleについての教訓**は明確である。

---

# 36. Architecture acceptance criteria

この方向転換が成功したと言える条件を、M3 PASSだけにしてはいけない。

最低限、次が必要である。

## A. Model hot-path independence

active Transition実行中にJev/System2 providerを停止しても、

* stale actionを再生せず
* deterministic fallback WHATを捏造せず
* current Transitionがmodel不要な範囲では継続できる

こと。

## B. Target substitution

`acquire(log)` のようなTransitionで、

最初のexact targetが消失/到達不能になっても、

同じTransition contract内で別のvalid witnessへ変更できること。

## C. Navigation closure

一つのReach Transitionが、

複数のwalk/jump/path replanと、許可された小規模terrain adaptationを経て、

上位policyを呼ばずに目的predicateへ到達できること。

## D. Search closure

Searchが身体移動ではなくinformation/frontier progressを持ち、

A↔B運動をprogressとして扱わないこと。

## E. Viability

long-running mission中に、

food/air/health/threat対応がGoalQueue headやSystem2 availabilityに依存しないこと。

## F. Queue independence

GoalQueue stateを消失させても、

Mission + verified facts + transition graphから正しいfrontierを再構築できること。

## G. Benchmark absence

M2/M3 RUNGSなしでも、同じruntimeにpredicate missionを与えれば動くこと。

## H. Unknown partial start

途中まで進行した任意inventory/world stateから、

ordered rung prefixを仮定せず現在のpredicate frontierを導出できること。

## I. Multi-seed long-run

単一seedのM3成功ではなく、複数fresh worldで同じTransition libraryが再利用されること。

## J. M4/Dragon

Dragon到達時に、

「M4用production strategy branch」を追加せず、

新しい必要capability/Transitionだけを追加して到達できること。

---

# 37. 何を今やってはいけないか

このauditから見て、次をprojectの主戦略にするべきではない。

### 37.1 βをさらに賢くする

βにもっとcontext、もっとhistory、もっとcalibrationを追加しても、

generic Transition terminationをmodel predictionにしている問題は残る。

### 37.2 #476 をarchitecture cleanupとして先に完遂する

code-owned tactical recoveryをさらにJevへ戻すと、hot decision boundaryが増える。

### 37.3 OptionLedgerを完璧にしてGoalQueueを置き換えるだけ

semantic state representationは改善するが、control timescaleは変わらない。

### 37.4 巨大controllerを同じauthority semanticsのまま分割する

couplingを別fileへ移すだけになる。

### 37.5 System2 promptをさらに賢くする

現在最大の問題はlong-horizon prose qualityではない。

### 37.6 candidate alternativesをさらに豊富にする

より大きいcandidate setをmodelへ頻繁に渡すことはcausal closureではない。

### 37.7 新しいretry / cooldown / anti-flap counterを増やす

Transition controller内部のprogress/failure contractへ統合すべきである。

---

# 38. Project roadmapに対する意味

これは全面rewriteを意味しない。

むしろかなりの資産を保存できる。

現在最も価値があるのは、

* HOST
* lease
* world epoch
* durable facts
* Guard
* VERIFY
* typed outcomes
* executor mechanics
* movement mechanics
* portal mechanics
* recipes/tool truth
* station truth
* probes
* evidence tooling

である。

これらを捨てる理由はない。

捨てるべきなのは、

> **それらをつなぐ現在の「Option/Jev/βを中心にしたcontrol constitution」**

である。

---

# 39. 最終architecture

最終的にagentを次のように捉える。

### Layer 1 — Mission

何を最終的に真にしたいか。

### Layer 2 — Verified World Model

今、何が真・偽・未知なのか。

### Layer 3 — Causal Transition Graph

どのverified transitionがどのpredicateを作れるか。

### Layer 4 — Transition Scheduler

現在可能なTransitionから、cost・risk・uncertainty・mission relevanceに基づき次を選択する。

ここではdeterministic/learned/model-assistedのいずれも利用できる。

### Layer 5 — Persistent Transition Controllers

選ばれたworld-state changeを、closed-loopで最後まで所有する。

### Layer 6 — Viability Runtime

health/hunger/air/threatなどmission横断invariantを維持する。

### Layer 7 — Actuation + Verification

Mineflayerへ作用し、server truthで結果を検証する。

### Layer 8 — Sparse Reasoning Service

既知Transition Graphで解けないときだけSystem2等へ相談する。

### Layer 9 — Durable Fact/Transition Journal

world facts・outcome・experienceを次runへ残す。

これが、一つのarchitectureである。

---

# 40. 新しいconstitutionを一文で書くなら

現在 #11 のconstitutionを置き換えるなら、私は次を採用する。

> **The agent owns verified world-state transitions, not individual semantic actions. A controller may change tactics, targets, and mechanical realization freely while the desired predicate, admissible side effects, and risk/resource contract remain unchanged. Higher-level reasoning is required only when that contract itself must change.**

日本語では、

> **Agentの基本責務は「意味のある次actionを選ぶこと」ではなく、「約束したworld predicateを成立させるまで閉ループ制御を所有すること」である。目的predicate・許容副作用・risk/resource契約が同じなら、戦術や一時targetの変更はcontroller内部で行ってよい。契約そのものを変更するときだけ上位reasoningへ戻る。**

これをprojectの新しい中心原則にすべきである。

---

# 41. 最終判断

このrepositoryは、LLMを使いすぎたから失敗しているわけではない。

Mineflayerが弱いからでもない。

Jevが馬鹿だからでもない。

System2のpromptが足りないからでもない。

最も深い問題は、

> **世界を変える長時間processのownershipを短く切りすぎたこと**

である。

その結果、

* Option
* candidate
* Jev π
* Jev β
* GoalQueue
* failure memory
* retry counters
* anti-flap
* stall detector
* semantic projection
* escalation
* System2 wake
* cache identity
* stale fences

が、そのownership gapを埋めるために増え続けた。

これらの多くはそれぞれ正しい。

しかし全部を完璧にしても、

**agentが自然に強くなるとは限らない。**

`walkSkill.ts` はすでに出口を示している。

mechanicsが悪かったのではない。

**ownershipが短すぎた。**

同じ発見をmovementだけで終わらせず、agent全体へ適用するべきである。

---

# Recommendation

## Grounded Option OS をprojectの最終architectureとして廃止し、Verified Transition Runtimeへ移行する。

* **Optionを中心から外す。**
* **Jev自体はprimary fast decision policyとして維持・強化する。**
* **Jev πをmandatory per-action authorityから外し、decision-epoch単位のtyped Jev Decision Frameへ寄せる。**
* **Jev βをgeneric termination authorityとして廃止する。**
* **GoalQueueをsemantic source of truthから外す。**
* **System2を常時WHAT authorityからsparse graph-repair serviceへ降格する。**
* **Skillをpersistent Transition Controllerへ発展させる。**
* **Survivalをparallel viability invariantへ移す。**
* **world factsとmission predicatesからfrontierを再導出する。**
* **controller内部の戦術変更を許し、policy boundaryをcontract changeまで押し上げる。**
* **Guard / VERIFY / HOST / world identity / typed evidenceは維持し、むしろarchitectureの中心へ近づける。**

これが、このprojectを

> 「正しいauthorityを持つMinecraft bot」

から

> **「人間feedbackなしで世界を変え続けられるMinecraft agent」**

へ変えるための方向転換である。

---

# Evidence Index

本auditで重点的に確認したrepository evidence:

### Architecture / authority

* `docs/history/architecture/AI-AUTHORITY.md`
* `docs/history/architecture/ARCHITECTURE.md`
* `docs/operations/RESIDENT-MODE.md`
* `docs/decision/PLANNERS.md`
* `docs/history/investigations/PRIOR-WORK.md`
* Issue #11
* Issue #308
* Issue #359
* Issue #365
* Issue #436
* Issue #439
* Issue #440
* Issue #476

### Current production

* `buddy-driver/agent-runner.mts`
* `buddy-driver/generation-entry.ts`
* `buddy-driver/planner.ts`
* `buddy-driver/planner-legacy.ts`
* `buddy-driver/mercury-system2.ts`
* `jev-agent/src/controller.ts`
* `jev-agent/src/controller-legacy.ts`
* `jev-agent/src/candidates.ts`
* `jev-agent/src/executor.ts`
* `jev-agent/src/state.ts`
* `jev-agent/src/goalQueue.ts`
* `jev-agent/src/optionSpec.ts`
* `jev-agent/src/optionSpec-legacy.ts`
* `jev-agent/src/skillCommitment.ts`
* `jev-agent/src/walkSkill.ts`

### Runtime / liveness / truth

* Issue #360
* Issue #421
* Issue #442
* Issue #471
* `docs/history/incidents/NETHER-SURVIVAL-2026-09-22.md`
* `docs/history/milestones/M2-HEURISTIC-AUDIT.md`
* `docs/history/milestones/M2-PROGRESS.md`
* `runs/m3-live/acceptance-bundle-run-mufel6fc-v84z/metrics.json`

### Capability/evaluation direction

* Issue #474
* Issue #478
* M2/M3 gate tooling
* clean-run/reproducibility tooling

### Representative history

* PR #326 — stalled local recovery
* PR #328 — durable portal site
* PR #330 — smelt approach wedge
* PR #335 — vertical recovery
* PR #337 — repeated action failure escalation
* PR #339 — non-advancing candidate filtering
* PR #343 — action commitment
* PR #351 — orphan prerequisite retirement
* PR #355 — equipment/combat affordance
* PR #356 — durable traversal memory
* PR #358 — committed travel legs
* PR #429/#430 — survival food recovery
* PR #432 — strategic recurrence fingerprint
* PR #433 — unreachable station memory
* PR #435 — bounded route failure
* PR #441 — preserve System2 explore intent
* PR #458/#459/#460 — Skill closure / movement / lateral-search fixes

---

**Bottom line:**
#11 は、このprojectを無秩序なLLM botから厳密なcausal systemへ引き上げるためには有効だった。しかし、そのauthority splitを最終形にすると、Minecraftで最も必要な「長時間閉ループのownership」を細切れにしてしまう。次の飛躍は #11 を完成させることではない。**#11 が作ったtruth・verification・durabilityの土台を残したまま、その上のcontrol modelをVerified Transition Runtimeへ置き換えることである。**
