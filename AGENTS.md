最終目標は、汎用Minecraft AIとして M3 を live で達成すること。

M3 PASS の定義:
- Nether 到達を live で証明する
- ender_eye >= 12 を同一runの最終在庫で証明する
- run-scoped artifact に少なくとも以下を残す:
  - exact source SHA
  - runId
  - Minecraft version / difficulty / relevant environment configuration
  - 初期 inventory
  - 最終 inventory
  - dimension transition evidence
  - milestone predicate evidence
  - effective System2 provider/model
  - effective Jev provider/model
  - hidden deterministic fallback が無かったこと
- `tools/m3-gate.mjs --run <runId>` または現行canonical gateで PASS を確定する
- 推測・all-time log・別runの証拠混合では PASS としない

前提:
1. まず M2 Nether gate
   build -> light -> verify
   を fresh exact-source live run の run-scoped evidence で証明する。
2. 必要なら difficulty や server/runtime configuration を変更してよい。
   ただし変更内容・理由・runへの影響をartifactへ記録する。
3. benchmarkを簡単にするための既知座標、固定ルート、seed固有攻略、事前survey等をproduction AIへ埋め込まない。

最重要設計原則:
このプロジェクトの目的は M3 専用機械ではなく、汎用Minecraft AIを作ること。

authority:
- System2 LLM = WHAT
  長期的な意図、Option、戦略、依存関係の修復を決める。
  自然言語による意味理解・計画能力を活用する。
- Jev π = WHICH
  コードで接地された typed candidate / Skill の中から局所的な選択を行う。
- Jev β = WHETHER
  現在のOptionを継続するか、意味的に終了/放棄するかを判断する。
- Code = CAN / TRUE / SAFE / DONE
  Minecraftの真実、能力、合法性、安全性、reachability、recipe、geometry、
  success predicate、verificationを決める。
- Skill / Executor = HOW
  選ばれた一つの意味的行動をbounded closed-loopで物理実行する。
- HOST = connection / durable state / lifecycle / lease / evidence。
訂正；決定論は場合により使用許可。#11が聖典
禁止:
- M3の各場面専用の決定論攻略を追加してPASSさせない。
- 「blazeならこの方向」「M3ならこの順」「3回失敗したらこの戦略」
  のようなincident-specific semantic policyをproductionへ追加しない。
- benchmark RUNGS / milestone orderingをproduction WHATとして使わない。
- LLM/Jev失敗をsilent deterministic fallbackで隠さない。
- body movementをgoal/search progressとして扱わない。
- テストを通すためだけのfake evidenceを作らない。

許可される決定論:
- Minecraft mechanics
- recipe/tool legality
- block/entity truth
- pathfinding / geometry solver
- exact reachability
- hazard/safety guard
- bounded motor control
- deterministic verification
- state-conditioned mechanical invalidity

複数の意味的に妥当な選択肢が残るなら、コードで順位を決めずJev/System2へ渡す。

開発方針:
毎ターン最初に具体的なTODOを作る。
TODOは「調査する」だけではなく、
- audit
- implementation
- tests
- live validation
- integration
を可能な限り同じターンで複数進める。

TODOを書くだけでターンを終了しない。
現在地報告だけで終了しない。
一つ修正しただけで終了しない。
goalが未達なら、利用可能な作業を続ける。

サブエージェント:
- 毎ターン可能な限り最大限使用する。
- ただし同じ修正を複数agentへ重複して担当させない。
- subsystem / issue / audit対象ごとに独立laneへ分割する。
- サブエージェントが動いている間も自分自身は別laneで作業を続ける。
- サブエージェントを呼んだことを作業完了理由にしない。
- サブエージェントの結果は必ず自分でreview / integrate / verifyする。
- concurrent worktreeの他者作業をreset/overwriteしない。

並列laneの例:
A. live consolidated log監査
B. current M3 first causal blockerの実装修正
C. #11 / generalization違反監査
D. tests / regression fixture
E. run-scoped gate/evidence監査
F. open issue triage

issue / PR:
開発速度を落とすために、1つの小バグごとにissueやPRを作らない。
issueは以下の場合に作る:
- 独立したroot cause / acceptance boundaryがある
- 後続追跡が必要
- architecture invariantとして永続的価値がある
- live evidence付きの重要failure

同一root causeの小修正はまとめる。
既存issueがある場合は新規issueより既存issueへ統合する。
PRも意味のある一まとまりで作る。

M3優先順位:
active workを次の3種類に分類する。

A. M3_CRITICAL
   現在のfresh live runの最初のcausal blocker

B. ARCHITECTURE_BLOCKER
   #11 / generalization / truth / durability / authority違反で、
   M3 PASS自体を無効またはbenchmark-specificにするもの

C. DEFER
   M3達成に不要な研究、M4、cosmetic cleanup、将来機能

A/Bを優先する。
Cを理由なく実装し始めない。

ただし「M3優先」はM3専用heuristicを許可する意味ではない。
各修正は必ず
「このseed/incidentではなく、どの一般的Minecraft capability classを直すのか」
を説明できること。

live loop:
可能な限り以下を繰り返す。

exact origin/main SHAを固定
-> tests/typecheck
-> resident/live run
-> consolidated log監査
-> first causal blockerを特定
-> generic root-cause fix
-> regression test
-> merge/integrate
-> fresh exact-source live run
-> run-scoped gate
-> 次のblocker

一度のrunで複数の独立したfailureが明確なら並列で修正してよい。
ただし推測で大量の修正を入れない。

総合log監査:
毎ターン live run が存在するなら consolidated log を確認する。

最低限見る:
- active Option / OptionInstance
- System2 invocation / plan transition
- Jev π decisions
- Jev β outputs
- candidate distribution
- execution success/failure
- verification
- body/search/goal progress
- recurrent states
- oscillation
- WAIT streak / unbounded idle
- repeated station construction
- purposeless DIG/MOVE
- death/regression
- dimension transitions
- inventory deltas
- model calls / retries / fallback
- actuation lease / generation lifecycle anomalies

「動いている」ではなく、
semantic progress が発生しているかを見る。

行動品質:
以下を正常挙動として放置しない。
- 同じ場所の往復
- 4点以上の局所徘徊
- 目的のないDIG/MOVE
- usable crafting table / furnaceがあるのに同じ設備を量産
- bounded wake condition無しの永久WAIT
- body motionだけでsemantic stall timerがresetされる
- 同じ失敗をstate不変のまま繰り返す

これらは個別ルールで禁止するのではなく、
Option / postcondition / search novelty / typed recoveryとの因果関係を直す。

Jev:
Jevを普通のchat LLMとして扱わない。
Jevはtyped probabilistic System One decision modelとして使う。

原則:
- π: Choice over grounded typed candidates
- β: Noul/Boolean semantic termination probability
- Score: 本当にordered scaleが必要な場合のみ
- raw probability/distributionを保存
- probabilityをtruthにしない
- Guard/VERIFYを通す
- Option contextとrecent causal outcomesを入力する
- primitive motor controlを毎回Jevへ投げない
- candidate setが悪い場合をJevの知能不足として誤診しない

System2:
provider/model名をarchitectureに焼かない。
Mercury/Muse/DeepSeek等はprovider/model configuration。
architecture上は汎用 `System2 LLM` とする。

LLMに渡すstateは、
巨大な全ログではなく、
現在のMission / Option / predicates / recent outcomes /
world memory / blockers / grounded alternativesを
compactに表現する。

汎用性:
最重要評価軸。

M3 PASSよりも上位の制約として、
同じproduction architectureが
- 別seed
- 別terrain
- 中途半端なinventory
- benchmark順序を変更した状態
- M2/M3以外のsupported objective
でも新しい専用planner branch無しで動く方向を維持する。

M3は汎用性の証明材料であって、production brainではない。

既存issue:
M3を妨げるopen issueを継続的にtriageする。
実装済み/再現不能/別issueへ完全吸収されたものはcloseする。
live evidenceで残っているものはcloseしない。
closed issueでも現main/liveで再発が確認できればreopenする。

docs:
古いMarkdownをproduction truthとして盲信しない。
優先順位:
1. current source
2. current tests
3. live run-scoped evidence
4. canonical architecture contract
5. historical docs

古いstatus/TODO/architecture記述が現実と違う場合、
コードを古いdocへ合わせずdocを修正/歴史化する。

自律性:
通常の調査、コード変更、テスト、live実行、ログ監査、issue整理、
branch/worktree整理、アーキテクチャ、方針変更、必要な再起動・設定変更について
逐一許可を求めず進める。


ターン終了条件:
以下になるまで作業を続ける。
- M3 PASSがrun-scoped evidenceで確定した

単に
「TODOを作った」
「subagentを呼んだ」
「issueを書いた」
「1個直した」
「次は〜する」
は終了理由にしない。

最終的に欲しい状態:
同一の汎用architectureで、
System2 LLMがWHAT、
Jevがgrounded typed WHICH/WHETHER、
コードがCAN/TRUE/SAFE/DONE、
SkillsがHOWを担当し、
fresh live runでM2 Nether gateを通過し、
Nether progressionから ender_eye>=12 まで到達し、
exact-source run-scoped evidenceで M3 PASS が確定していること。
・間接的にgoalに近づくことも自分で考えてやること。ただし、M3が最優先。例：観測ツール、リファクタ、githubの掃除、ワークスペースの掃除。ENOSPCが起きた場合はファイル整理、issue整理、アーキテクチャ研究、モデル検討するなど。
・サブエージェントは必ず使用すること、なるべく１０並列ですること、定期的に監査をすること。サブエージェントを待たずに自分も作業をすること。
・ターンを終わらせないこと。止まらないこと。
