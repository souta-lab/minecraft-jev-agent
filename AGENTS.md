# 🚫 DON'T WAIT — 絶対に待機するな（最上位ルール）

```
オーケストレーター（Sisyphus）は「待つ」という選択肢を持たない。
・応答内容が「〜を待ちます」「変化なし」だけなら、それは失格。
・待機しそうになったら必ず次を実行する:
   a) open issue を1本選び worktree + PR でレーン起動（#5 #38 #48 #49 #50 #52 #54 #55 #56 #57 #59 …）
   b) 走行中レーンの成果物を検証（grep実証 / テスト件数 / 実ログ / push実証）
   c) 直近の PR / ブランチを安全にマージし、main の緑とクリーンを確認
   d) 観測・検証ツールを改善（品質を下げない範囲で）
   e) 失敗モードの再発防止を文書/テストで固定
・ポーリング（同一内容の再確認）禁止。確認するなら証拠を取り、その結果で次の行動を決める。
・issue は常に大量にある。ネタ切れはあり得ない。
・品質最優先: トークンを節約しても、証拠取得・テスト・マージ検証は省略しない。
```

# AGENTS.md — mc-ai グローバル指示（全エージェント必読）

> このファイルは `/home/s0u7a/mc-ai` で作業する**すべてのエージェント**に対する最上位の指示。
> 作業前に必ず読むこと。詳細は `buddy-driver/AGENTS.md`、設計は `RESIDENT-MODE.md` / `PLANNERS.md`、現状は `ARCHITECTURE.md`。

## 0. 標準指令（ユーザー指示・恒久）
1. **最終目標は M4（Ender Dragon 討伐）**。M2（鉄器時代）は通過点。
2. **ユーザーの発言を待たない。指示待ちをしない。** やることが無ければ**自分で仕事を考えて着手する**。
3. 判断に迷ったら最初に「**方法論 / evidence integrity が壊れていないか**」を確認する。acceptanceの意味が壊れている、証拠が汚染されている、正典が矛盾している場合は **P0 (#63)** として先に直す。次に「**P1 durability / actuation safety を壊さない**」、次に「将来の二重実装を避ける」、次に「M4への距離を縮める」を基準にする。
4. 進捗は必ず一次証拠（ログ行・在庫・コミット）で残す。主観や推測で「できた」と言わない。ただし**ログ名やall-time counterだけを意味論の証拠として扱わない**。
5. 作業単位ごとに小さくコミット＆push（秘密スキャン必須）。ただし commit 頻度そのものを productivity KPI にしない。
6. 人間は基本不在。危険操作（サーバー停止・world削除・履歴改変・force push）はしない。
7. 正典の優先順位は明示的に次とする。下位文書は上位を暗黙に supersede してはならない。

```
ユーザーの明示指示
> root AGENTS.md
> nearest scoped AGENTS.md
> TODO.md / 現在のoperational queue
> PLANNERS.md / RESIDENT-MODE.md / ARCHITECTURE.md などの設計・証拠文書
> historical / superseded sections
```

### 0.1 P0 methodology / evidence integrity（Issue #63）

**これは機能開発の前提条件。** evidence system が壊れている状態で `fixed` / `accepted` / `authority-ready` / `SOTA-ready` 等を宣言しない。

重要な判定は必ず分離して扱う:

```
POLICY       = 本来どうあるべきか（AGENTS / issue acceptance）
IMPLEMENTED  = 現在のコードが実際に何をするか
OBSERVED     = runtime / log / test で何が観測されたか
COMPLIANCE   = POLICY に対して PASS / FAIL / UNKNOWN のどれか
```

禁止:

```
・marker 名が BETA_SHADOW だから shadow-only だった、と推論する
・all-time buddy.log counter を単一runのacceptanceとして扱う
・GitHub issueがopenなのに「closed」と書く
・unit test greenだけでlive acceptance済みと扱う
・offline replayだけでcounterfactual closed-loop性能を証明したと扱う
・既知redを無言で無視して「full green」と書く
```

Evidence class は少なくとも区別する:

```
LIVE      = embodied/runtime failure or observation
STATIC    = code/invariant inspection
ARCH      = architecture/ownership/scalability inconsistency
RESEARCH  = hypothesis to test
```

Test / issue state も分離する:

```
GitHub state
implementation state
unit/integration test state
live acceptance state
closure decision
```

`tools/replay.mjs` (#23) は **calibration / disagreement / safety screening 用**。recorded trajectory は現在policyが作った未来なので、別policyのclosed-loop counterfactual superiorityを単独では証明しない。#24 authority昇格には isolated/live A/B 等のclosed-loop evidenceが必要。

Acceptance evidence は可能な限り run-scoped にする。shared `buddy.log` は診断用であり、commit/config/world/runが混ざったall-time countだけでacceptanceを出さない。run artifactには可能な範囲で以下を残す:

```
runId / gitCommit / dirtyTree / generationHash
worldKey / worldEpoch / seed(if known)
server version / difficulty
schema/dependency versions
non-secret BUDDY_* config
Jev model / Mercury model
start/end timestamps
acceptance result
```

Known-red test が存在する場合は、pinned baseline と比較して **no new regression** を証明する。既知失敗を黙って許容しない。

## 1. システム概要
```
Mineflayer   = メカニクス実行（連続モーター）
Jev          = 接地された強い局所判断器・唯一のAction選択権限
Mercury      = 例外駆動の上位意図/Option/plan repair
Option/Skill = 上位意図を実行可能な時間的抽象へコンパイルする層
Code         = 安全性・物理的真実・事前条件・成功述語・capability dependency
常駐ホスト   = 接続保持＋世代ホットリロード＋制御ソケット＋authoritative resident state＋actuation lease
```

**設計の本命: Issue #11 Grounded Options**
```
Jev π = grounded action/skill Choice
Jev β = abandon_option probability
Option initiation/success = deterministic code
Mercury = sparse Option/plan repair
```

重要な移行原則:

> **early schema/control-surface migration, late authority migration**

#11を後回しにしてM3/M4機能を旧Goal表現へ大量追加しない。先にOption/Skillの契約を作り、既存のGoalQueue/Guard/Executorをその下で再利用する。

## 2. 優先順（この順で前へ進める）
```
0. P0 methodology / evidence integrity (#63) はグローバルgate
   acceptance semanticsの誤り、shared-log汚染、正典矛盾、issue state誤記、
   replayの過大解釈等が見つかった場合、強いclaimやauthority昇格より先に直す。

1. P1 safety/durability は常時ブロッカー
   #5 atomic state / #13 listener leak / #28 disconnect lease / #38 nested actuation bypass /
   #40 authoritative snapshot / #48 stale proposal / #49 rollback ownership など。
   壊れている場合はfeature workより先に直す。

2. #11 Grounded Options の骨格を前倒し
   #21 OptionSpec + PlannedGoal->Option compiler
   #20 SkillCandidate contract
   #14 known-resource coordinates + #29 strategy grounding
   ※ GoalQueue / Guard / Executor / resident は捨てない。

3. #11 shadow/評価基盤
   #22 abandon_option β shadow
   #32 raw Boolean probability保持
   #36 causal/provenance IDs
   #23 replay A/B harness（promotion screen。closed-loop proofではない）

4. 現行Mercury correctnessを並行で最小修正
   #15 cache replay / #30 patch tail / #18 retry accounting / #16 world scope / #19 explicit operation
   旧plannerを大規模拡張しない。

5. #24 β termination controller
   replay/calibrationだけではauthorityを与えない。closed-loop evidence + hysteresis/corroboration/cooldown必須。

6. M2を新しいOption境界の上で完走
   furnace -> charcoal -> raw_iron -> iron_ingot×3 -> iron_pickaxe

7. #35 semantic planner重複を整理
   #11が実測で勝った後だけ Advisor/PlannerBrain/Jev/Mercury の重複責務を削る。

8. #41 predicate-based capability graph
   M3/M4の非item objectiveを追加する前に依存関係/成功述語の表現を一般化。

9. M3/M4
   ダイヤ -> ネザー -> ブレイズ/パール -> エンダーアイ -> 要塞 -> End -> Dragon
```

### #11前倒しで「やらない」こと
```
・いきなりβにreplan authorityを与えない
・今までのM1/M2 mechanicsを全面書き直さない
・GoalQueueを削除しない（execution ledgerとして残す）
・Guard / VERIFYをモデル権限へ移さない
・現在の多質問Jev diagnosticsをすぐ削除しない（shadow比較に使う）
・M3/M4の新機能をfake targetItemや自然言語strategyだけで増やさない
```

## 3. 現在の重要状態（2026-09-18）
```
#63 methodology/evidence integrity をP0へ昇格。DEVELOPMENT-METHOD.md監査で正典順・evidence semantics・replay評価・shared log等の問題を確認。
#22 β shadow はGitHub上でreopen。marker名ではなく実authority semanticsで判定する。
#12 LADDER_PREREQ 修正は main に landed（3866d3d）。live acceptanceは継続確認する。
movement root cause #7/#8/#9 の修正も landed。live挙動はresident安定後に再検証する。
Mercury System2 は live。現行 correctness issue #15/#30/#18 等は残る。
#13 listener leak はopen。listenerLeak=falseの観測があってもclosure acceptanceとは分ける。
actuation lease はあるが nested capability bypass が残る (#38)。
#48 stale ledger proposal / #49 rollback ownership はP1 substrate correctness。
```

## 4. 運用手順（必ず守る）
### 4.0-A 並行レーンの分担規則（衝突を構造的に防ぐ）
```
・実装レーン全体のWIP上限は原則 **3本**。
・ホスト層（buddy-driver/agent-runner.mts, resident-types.ts, package.json）を触るレーンは
  **同時に1本まで**。同系統の変更が並行すると必ず衝突する（実例: #26/#34 と #27/#28 が
  agent-runner.mts と package.json で衝突し、merge を abort する事態になった）
・ready-to-integrate branch が2本以上溜まっている時は、原則として新しい実装laneを増やさず先に統合する。
・それ以外の領域（jev-agent/src/*, tools/, docs）は上限内で並行可
・複数レーンが同領域に触れた場合は、**worktree 内でマージして衝突を解消**し、
  解消済みブランチを報告してから 1本ずつ main へ取り込む（mainツリーでは絶対に merge/cherry-pick しない）
・main ツリーは常に「ビルド可能・クリーン」を保つ。壊れた状態をホストに読ませない
・「最後のcommitから何分」を成功指標にしない。meaningful verified progress / blocked time / WIP age / rework を優先する
```

### 4.0 ブランチ運用（競合防止・必須）
```
・サブエージェント／並行タスクは **必ず専用ブランチを切って作業する**（例: `task/issue-12-precondition-chain`）
・★共有ツリーで `git checkout` しない。**`git worktree add` で別ディレクトリを切る**:
    cd /home/s0u7a/mc-ai
    git fetch origin
    git worktree add /tmp/opencode/wt-<task> -b task/<name> origin/main
    # 作業後: git -C /tmp/opencode/wt-<task> add -A && git -C ... commit -m "..." && git -C ... push -u origin task/<name>
    # 終了時: git worktree remove /tmp/opencode/wt-<task>
  理由: 常駐ホストは**作業ツリーからバンドルを生成**してホットリロードするため、
        共有ツリーを checkout で切り替えると稼働中のエージェントが別ブランチのコードで動き出し、他のタスクの編集も壊れる
  （実例: #21 は /tmp/opencode/wt21 を使用。これが正しい）
・★共有ツリーの HEAD は常に `main` でなければならない。同期の `reset` は現在のブランチを動かすため、
  非 `main` HEAD ではレーンのブランチを静かに書き換える。共有ツリーの同期は `node tools/sync-shared-tree.mjs`
  を使い、`SYNC_HEAD_WRONG head=<branch>` で停止した場合は checkout や reset で回避しない。
・main へ直接コミットするのは「単一の作業者しか触っていない」ことが明確な場合のみ（例: tools/, docs のみ）
・★**ブランチ上の修正は main にマージされるまで稼働中エージェントに反映されない**
  （常駐ホストは main ツリーからバンドルを生成するため）。したがって修正の「着地」＝ マージまでを含む。
  マージは一度に1本ずつ、他タスクが未コミットのファイルを持つ間は行わない。
  マージ手順: `git worktree` 側で push → main ツリーで `git fetch && git merge --no-ff origin/task/<name> && git push`
  → 直後に `RELOAD ok=true` と該当ゲート（tools/verify-*.mjs）を確認する
・作業完了時に main へ取り込む（`git checkout main && git pull --rebase && git merge --no-ff <branch> && git push`）。
  force push・履歴改変は禁止
・**作業ツリーに他タスクの未コミット変更（WIP）があるときは rebase/pull しない**
  （ホットリロードは作業ツリーからバンドルを作るため、stash や rebase は稼働中のエージェントを壊す）
  その場合は自分のコミットを退避ブランチへ push しておき、WIP がコミットされた後に main へ取り込む
  （実例: `git push origin HEAD:refs/heads/tools/verify-mercury`）
・同じファイルを2つのタスクが編集しないよう、着手前に担当ファイルを宣言する
  （直近の分担: #12/#11=jev-agent/src/{jev,controller,policy,scheduler,system2}.ts + buddy-driver/{generation-entry,planner}.ts
   ／ movement=executor,candidates,state ／ Mercury/CI=PRブランチ `sol/system2-ci-mercury` ／ tools・docs=誰でも）
```
```
・健全性の一括確認:      node tools/buddy-status.mjs        （--json で機械可読）
・常駐ホストは単一:      pgrep は bash ラッパーに誤マッチするので tools の判定を使う。kill は pid 指定
・デタッチ起動:          cd buddy-driver && setsid nohup node agent-runner.mts </dev/null > runner.out 2>&1 &
・サーバー:              127.0.0.1:25565 (Leaf 1.21.11, offline, peaceful)。停止時は
                         -DPaper.IgnoreJavaVersion=true を付けて起動（Java は 21.0.13-ea のため必須）
・制御ソケット:          data/resident/control.sock（0600, JSON Lines）
   照会のみ: report / status / goal / milestone / acceptance
   実行可:   freeze / resume / reload / gc / leakcheck / simdeath / quit
   注意:     goal/milestone は注入不可（照会だけ）。worldreset は実装にあるが破壊的なので使わない
   契約:     HOST↔generation の契約バージョンは RESIDENT-MODE.md §4-A が正典（数値を再掲しない）。
            doc/code の不一致は buddy-driver の `npm run contract-docs-check` が FAIL で検出する。
            不一致は hot reload では解消せず、ホスト再起動が必要（`RELOAD_REJECTED ... mismatch` が観測される）。
・Bot名:                 AI_Buddy は常駐が占有。検証は AI_M1* / AI_M2* 等を使う。s0u7a は人間用
・秘密:                  /home/s0u7a/.config/kimaki-secrets/ 配下は絶対に出力しない
```

## 5. 完了の定義（M4までの到達点）
```
M1: 3 log -> crafting_table -> wooden_pickaxe -> cobblestone（検証済み・維持）
M2: furnace -> charcoal -> iron_ore -> iron_ingot×3 -> iron_pickaxe（在庫で証明）
M3: ダイヤ入手 -> ダイヤ装備 -> ネザー到達 -> ブレイズロッド・エンダーパール確保
M4: エンダーアイ生成 -> 要塞発見 -> ジ・エンド到達 -> ドラゴン討伐
```
各段で「一次ログ＋在庫/述語」を証拠として残し、`ARCHITECTURE.md` と issue を更新する。ただし一次ログ自体の意味論が未検証ならCOMPLIANCEはUNKNOWNとする。

## 6. Issueキュー（アーキ前倒し版）

### 0. methodology / evidence integrity — グローバルP0
```
#63 authority hierarchy / evidence taxonomy / run isolation / replay semantics / release scope
```

### A. substrate correctness — P1
```
#5  speculative generation durable mutation
#13 listener leak
#28 disconnect lease revoke
#38 nested actuation capability bypass
#40 authoritative AgentSnapshot / state classes（landed/closedでも派生P1は別issueで追う）
#48 stale ledger proposal revision bypass
#49 reload rollback ownership mismatch
```

### B. #11 architecture skeleton — 新機能より先
```
#21 OptionSpec / deterministic predicates / PlannedGoal compiler
#20 grounded SkillCandidate contract
#14 known resource coordinates
#29 strategy -> executable skill grounding
#50 blocked Option execution
#52 Option template/instance identity
#54 mechanics/recipe truth source
#55 protected prerequisite/core goals
#56 OptionSpec -> Jev integration
#57 typed predicate round-trip
#59 unknown health fail-open
```

### C. shadow + evaluation
```
#22 β shadow
#32 raw Jev Boolean probability
#36 end-to-end decision provenance IDs
#23 replay A/B harness（screen。closed-loop causal proofではない）
```

### D. current Mercury correctness — 並行・最小修正
```
#15 cache hit plan replay
#30 patch/replace tail preservation
#18 retry accounting
#16/#17/#33 cache world/schema namespacing
#19 explicit operation/capability id
```

### E. authority / consolidation
```
#24 β meta-controller（#63 evidence contract + closed-loop evidenceを満たしてから）
#35 semantic planner consolidation（#11が勝った後）
#41 predicate-based capability graph
```

### F. その他resident/world correctness
```
#25 worldEpoch switch lifecycle
#27 reconnect storm
#31 stale station memory
#26/#34 simdeath semantics/telemetry
#39 explicit JevController integration API
```

## 7. M4設定ブロッカー
`difficulty=peaceful` では blaze / enderman farming が成立せず、eye_of_ender 経路が止まる。
M3dへ入る前に明示的にdifficulty変更方針を決め、証拠を残す。それまではresident/Option architectureの検証とM2を優先し、mob由来の失敗とdurabilityバグを混同しない。

## 8. 設計判定ルール
新しい機能を追加する前に「どの層の責務か」を決める。

```
Mission predicate / dependency -> capability graph
時間的にまとまった行動        -> Option / Skill
瞬間的な候補選択              -> Jev π
Option継続可否のsemantic判断  -> Jev β + deterministic meta-controller
安全性 / 成功 / world truth   -> deterministic code
物理実行                      -> Executor / Mineflayer
接続 / durable authority      -> HOST
```

**2つ以上のsemantic layerが同じ問いに答え始めたら設計臭。**
