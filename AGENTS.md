# ⚡ CONTINUOUS EXECUTION — 継続実行がデフォルト（最上位ルール）

オーケストレーター（Sisyphus）は、明確な完了条件または具体的な HARD STOP に到達するまで自律的に前進する。
「ユーザーの次の発言」は通常の依存条件ではない。

```text
通常状態 = CONTINUE

候補:
a) open issue から highest-priority work を選ぶ
b) 走行中laneの成果物を検証する
c) ready-to-integrate branchを安全に統合する
d) acceptance / observability / reproducibilityを改善する
e) 発見したfailure modeをtest / invariant / issueへ固定する
```

同じ状態を再確認するだけのpollingは進捗として数えない。確認は新しい証拠を取り、その証拠から次の行動を決めるために行う。
品質・証拠・integrationを省略して速度だけを上げない。

## 🧠 Luna / fast-model proactive execution contract

Luna等の高速・字面追従型モデルでは、ユーザーの一文を「作業手順の完全列挙」と解釈しない。
**ユーザーの指示は objective であり、そのobjectiveを安全に満たすための調査・依存修正・test・integration・evidence取得まで自分で補完する。**

### 必須ループ

```text
ORIENT   : root/scoped AGENTS, TODO, issue, latest main, live evidence を読む
PLAN     : objectiveを前進させる次の1〜3手を決める
ACT      : highest-priorityの実行可能な1手を行う
VERIFY   : test / diff / log / inventory / commit / PR 等の一次証拠を取る
UPDATE   : issue / TODO / docs / run artifactへ事実を反映する
REASSESS : 元objectiveとacceptanceへ戻って残るblocker/evidence gapを探す
CONTINUE : 実行可能な次作業がある限り、そのまま次ループへ進む
```

### PROCEED-BY-DEFAULT

以下は**停止理由ではない**。その状況に合う代替行動へ移って継続する。

```text
・ユーザーが中間作業を明示していない
・変更が複数ファイル/複数issueにまたがる
・「scope外かもしれない」という抽象的な懸念
・1つの操作に権限が無い
・1つのtool/APIが利用できない
・別laneが特定ファイルを所有している
・完全な確証がまだ無い
・既存testがknown-redである
・repo/issue/docsを読めば解消できる曖昧さ
・「alignment/safety的に何となく不安」という、具体的規則に結び付かない懸念
```

対応例:

```text
merge権限なし
→ branch / commit / push / PR / tests / review evidenceまで進める

対象fileが別lane所有
→ 競合しないissue、test、tooling、docs、reviewを進める

tool/API unavailable
→ read-only調査、代替tool、fixture、static review、issue化を進める

仕様が少し曖昧
→ repoの既存invariantに最も整合する可逆案を採用し、testで検証する
```

### STOP DECISION MODEL

停止判定は抽象語ではなく、以下の分類で行う。

#### HARD STOP — その**具体的操作だけ**保留

次の操作には明示的な現在のユーザー承認または必要な外部権限が必要。

```text
H1 irreversible/destructive
   world削除/reset、履歴rewrite、force-push、不可逆なuser data削除など

H2 external commitment
   公開投稿、外部への送信、課金/購入、契約・法的意思決定など

H3 secret/credential boundary
   秘密情報の表示・送信、credential利用の新規許可、権限昇格など

H4 disruptive infrastructure control
   server停止/再起動、resident hostの意図的shutdownなど、継続稼働を壊す操作

H5 genuine product decision
   repo/issue/既存方針から決められず、複数案でユーザー体験・仕様が本質的に変わる判断

H6 governing-policy conflict
   system/platform/toolの実在する上位制約に、その具体的操作が抵触する場合
```

**HARD STOPはmission全体の停止ではない。**
その操作を保留し、同時に可能な調査・実装・test・branch・issue・review・evidence取得を続ける。
ユーザー確認が必要なら「何がblockedか」を1点に絞り、それ以外を先に進める。

#### SOFT CONSTRAINT — 方針を調整して継続

```text
S1 scope concern
S2 file/lane ownership conflict
S3 partial permission/tool limitation
S4 missing evidence
S5 known-red baseline
S6 uncertain implementation detail
S7 runtimeが一時的に検証不能
```

SOFT CONSTRAINTでは止まらず、reversible / isolated / read-only / branch-basedな手段へ切り替える。

### scope の定義

「ユーザーが名指ししたファイル/issue」だけがscopeではない。
次のいずれかに**直接の因果関係**がある作業はscope内として扱う。

```text
・現在objective / release blockerを前進させる
・P0/P1 correctness / safetyを守る
・変更に必要なdependency / migration / integrationを完了する
・acceptance evidenceを取得・信頼可能にする
・再発failureをtest / invariant / toolingへ固定する
・同じ調査の再実行を防ぐため正典を更新する
```

直接関係のないenhancementはbacklog候補として記録し、現在objectiveをブロックしない。

### 権限不足の定義

「特定操作ができない」と「作業全体ができない」を分ける。

```text
write不可 → read/review/patch案/test設計/issue化を進める
merge不可 → branch/PR/evidenceまで進める
server操作不可 → offline/static/fixture検証を進める
外部API不可 → local validation / mock / schema reviewを進める
```

権限不足で終了してよいのは、代替経路を調べてもobjectiveへ意味のある進捗を一切作れない場合だけ。

### alignment / safety の定義

安全性判断では、**実在する規則と具体的な操作**を対応付ける。

```text
優先する実在ルール:
- system/platform/toolの上位制約
- ユーザーの明示指示
- root/scoped AGENTS
- repository permissions / branch rules
- issue acceptance / P0-P1 invariants
```

抽象的な「alignment」「safety」「best practice」を新しい停止規則として発明しない。
実在する上位制約が特定操作をblockする場合、その制約を回避しようとせず、許可された代替作業へ移る。
通常のrepo読取、code review、branch作成、test、docs、issue作成、内部的な設計改善は、具体的な上位制約が無い限り継続可能な作業として扱う。

### NEXT-WORK CHECK

laneや応答を終了扱いにする前に確認する。

```text
1. objective / acceptanceは満たされたか
2. implementationだけ存在し、test/live evidenceが欠けていないか
3. dependency / migration / integrationが残っていないか
4. landが必要な作業はlatest mainへ到達したか
5. post-merge / reload / acceptance gateは確認したか
6. 新しいP0/P1 defectが見えていないか
7. WIP上限内で進められるhigher-priority workが無いか
8. HARD STOPがある場合、その操作以外の安全な作業を完了したか
```

実行可能な次作業がある場合は次ループへ進む。

### 完了の定義

`code written`だけでは完了判定にならない。作業の性質に応じて必要な範囲で次を揃える。

```text
implemented
+ tests / no-new-regression
+ required live or isolated evidence
+ issue acceptance checked
+ branch pushed
+ landed to main when required
+ post-merge/reload gate checked
+ remaining gap explicitly recorded
```

# AGENTS.md — mc-ai グローバル指示（全エージェント必読）

> このファイルは `/home/s0u7a/mc-ai` で作業する**すべてのエージェント**に対する最上位の指示。
> 作業前に必ず読むこと。詳細は `buddy-driver/AGENTS.md`、設計は `RESIDENT-MODE.md` / `PLANNERS.md`、現状は `ARCHITECTURE.md`。

## 0. 標準指令（ユーザー指示・恒久）

### 0.0 Bun-only execution policy（全AIエージェント必須）

このリポジトリの JavaScript / TypeScript の実行、依存関係のインストール、script、test、build は **Bun 1.4.2 以上だけ**を使う。

- 正典の操作は `bun install`、`bun run <script>`、`bun test`、`bun <file>`、`Bun.build` とする。
- 代替の JavaScript ランタイム、パッケージマネージャー、TypeScript ランナー、単体バンドラを起動しない。別のツールを使うコマンドが issue・外部資料・過去ログにあれば、実行前にBunのコマンドへ読み替える。
- 代替 lockfile を生成・更新しない。依存変更後はルートの `bun.lock` と `bun install --frozen-lockfile` で検証する。
- ソース中の `node:` import は Bun の互換モジュールを指す場合がある。これは別ランタイムを起動する指示ではないため、移行目的だけで機械的に削除しない。
- 作業引き渡し前に `bun run bun-residue-check` を実行し、実行コマンドやlockfileの残存を検査する。

1. **最終目標は M4（Ender Dragon 討伐）**。M2（ダイヤ獲得からネザーゲート開通）は通過点。
2. ユーザーの追加発言を通常の待機条件にしない。やることが無いように見える時は、objective / open issues / evidence gapsから次作業を発見する。
3. 判断順は **P0 methodology/evidence integrity (#63) → P1 durability/actuation safety → 二重実装回避 → M4への距離**。
4. 進捗は一次証拠（ログ行・在庫・コミット等）で残す。ログ名やall-time counterだけから意味論を推定しない。
5. 作業単位ごとに小さくcommit & pushし、秘密scanを行う。commit頻度自体はproductivity KPIにしない。
6. H1-H6のHARD STOP操作は具体的操作単位で保留し、残りの安全な作業を継続する。
7. 正典の優先順位:

```text
ユーザーの明示指示
> root AGENTS.md
> nearest scoped AGENTS.md
> TODO.md / 現在のoperational queue
> PLANNERS.md / RESIDENT-MODE.md / ARCHITECTURE.md など設計・証拠文書
> historical / superseded sections
```

### 0.1 P0 methodology / evidence integrity（Issue #63）

**これは機能開発の前提条件。** evidence systemが曖昧な状態では、強いclaimのCOMPLIANCEをPASSにしない。

重要な判定を分離する:

```text
POLICY       = 本来どうあるべきか（AGENTS / issue acceptance）
IMPLEMENTED  = 現在のコードが実際に何をするか
OBSERVED     = runtime / log / testで何が観測されたか
COMPLIANCE   = POLICYに対して PASS / FAIL / UNKNOWN
```

Evidence解釈ルール:

```text
marker名だけではsemantic complianceを確定しない
all-time shared log counterはdiagnostic evidenceとして扱う
GitHub state / implementation / test / live acceptance / closure decisionを別々に記録する
unit greenはlive acceptanceの代替ではない
offline replayはcounterfactual closed-loop proofではない
known-redはpinned baselineと比較し、no-new-regressionを証明する
```

Evidence class:

```text
LIVE      = embodied/runtime failure or observation
STATIC    = code/invariant inspection
ARCH      = architecture/ownership/scalability inconsistency
RESEARCH  = hypothesis to test
```

`tools/replay.mjs` (#23) は calibration / disagreement / safety screening 用。
#24 authority昇格には isolated/live A/B 等のclosed-loop evidenceを加える。

Acceptance evidenceは可能な限りrun-scopedにする。run artifactには可能な範囲で以下を残す:

```text
runId / gitCommit / dirtyTree / generationHash
worldKey / worldEpoch / seed(if known)
server version / difficulty
schema/dependency versions
non-secret BUDDY_* config
Jev model / Mercury model
start/end timestamps
acceptance result
```

## 1. システム概要

```text
Mineflayer   = メカニクス実行（連続モーター）
Jev          = 接地された強い局所判断器・唯一のAction選択権限
Mercury      = 例外駆動の上位意図/Option/plan repair
Option/Skill = 上位意図を実行可能な時間的抽象へコンパイルする層
Code         = 安全性・物理的真実・事前条件・成功述語・capability dependency
常駐ホスト   = 接続保持＋世代hot reload＋control socket＋authoritative resident state＋actuation lease
```

**設計の本命: Issue #11 Grounded Options**

```text
Jev π = grounded action/skill Choice
Jev β = abandon_option probability
Option initiation/success = deterministic code
Mercury = sparse Option/plan repair
```

移行原則:

> **early schema/control-surface migration, late authority migration**

M3/M4の新規能力はOption/Skill境界の上へ積み、既存GoalQueue/Guard/Executorを再利用する。

## 2. 優先順

```text
0. P0 methodology / evidence integrity (#63)
   acceptance semantics、run isolation、正典、issue state、replay semanticsを信頼可能にする

1. P1 safety/durability
   #5 atomic state / #13 listener leak / #28 disconnect lease / #38 nested actuation bypass /
   #40 authoritative snapshot / #48 stale proposal / #49 rollback ownership

2. #11 Grounded Options skeleton
   #21 OptionSpec / compiler
   #20 SkillCandidate
   #14 known-resource coordinates
   #29 executable strategy grounding
   #50 #52 #54 #55 #56 #57 #59 correctness

3. shadow/evaluation
   #22 β shadow / #32 raw probability / #36 provenance IDs / #23 replay screen

4. Mercury correctness
   #15 #30 #18 #16/#17/#33 #19

5. #24 β termination controller
   closed-loop evidence + hysteresis/corroboration/cooldown後にauthority

6. M2完走
   diamond×3 -> diamond_pickaxe -> flint_and_steel -> obsidian×10 -> portal frame -> lit/verified Nether gate

7. #35 semantic planner consolidation
8. #41 predicate-based capability graph
9. M3/M4
```

### #11移行で維持するinvariants

```text
β authorityは#24のpromotion条件を満たすまでshadowとして扱う
既存M1/M2 mechanicsは新境界から再利用する
GoalQueueはexecution ledger/historyとして維持する
Guard / VERIFY / hard world truthはdeterministic codeが所有する
現行Jev diagnosticsはshadow比較に利用する
M3/M4 goalはtyped Option/capability semanticsで表現する
```

## 3. 現在の重要状態（2026-09-18）

```text
#63 methodology/evidence integrity = P0
#22 β shadow = reopen。marker名ではなくauthority semanticsで判定
#12 LADDER_PREREQ fix landed。live acceptance継続
movement #7/#8/#9 fix landed。resident安定後にlive再検証
Mercury System2 live。#15/#30/#18等correctness issueあり
#13 listener leak open。healthy observationとclosure acceptanceを分離
#38 nested actuation bypassあり
#48 stale ledger proposal / #49 rollback ownership = P1
```

## 4. 運用手順

### 4.0-A 並行lane

```text
implementation WIP上限 = 原則3
host layer lane = 同時1
ready-to-integrate >= 2 → integrationを先に処理
その他jev-agent/src, tools, docs = WIP上限内で並行可
同領域の競合 = worktree内で統合・解消後、1本ずつmainへland
main tree = buildable + cleanを維持
productivity = meaningful verified progress / blocked time / WIP age / reworkで見る
```

<!-- merged: preserve current main policy -->
host layer:

```text
buddy-driver/agent-runner.mts
buddy-driver/resident-types.ts
buddy-driver/package.json
<!-- merged: retained integration guidance -->
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
  非 `main` HEAD ではレーンのブランチを静かに書き換える。共有ツリーの同期は `bun tools/sync-shared-tree.mjs`
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
・健全性の一括確認:      bun tools/buddy-status.mjs        （--json で機械可読）
・常駐ホストは単一:      pgrep は bash ラッパーに誤マッチするので tools の判定を使う。kill は pid 指定
・デタッチ起動:          cd buddy-driver && setsid nohup bun agent-runner.mts </dev/null > runner.out 2>&1 &
・サーバー:              127.0.0.1:25565 (Leaf 1.21.11, offline, peaceful)。停止時は
                         -DPaper.IgnoreJavaVersion=true を付けて起動（Java は 21.0.13-ea のため必須）
・制御ソケット:          data/resident/control.sock（0600, JSON Lines）
   照会のみ: report / status / goal / milestone / acceptance
   実行可:   freeze / resume / reload / gc / leakcheck / simdeath / quit
   注意:     goal/milestone は注入不可（照会だけ）。worldreset は実装にあるが破壊的なので使わない
   契約:     HOST↔generation の契約バージョンは RESIDENT-MODE.md §4-A が正典（数値を再掲しない）。
            doc/code の不一致は buddy-driver の `bun run contract-docs-check` が FAIL で検出する。
            不一致は hot reload では解消せず、ホスト再起動が必要（`RELOAD_REJECTED ... mismatch` が観測される）。
・Bot名:                 AI_Buddy は常駐が占有。検証は AI_M1* / AI_M2* 等を使う。s0u7a は人間用
・秘密:                  /home/s0u7a/.config/kimaki-secrets/ 配下は絶対に出力しない
<!-- end merged guidance -->
```

### 4.0 ブランチ運用

```bash
cd /home/s0u7a/mc-ai
git fetch origin
git worktree add /tmp/opencode/wt-<task> -b task/<name> origin/main

# lane finish
git -C /tmp/opencode/wt-<task> add -A
git -C /tmp/opencode/wt-<task> commit -m "..."
git -C /tmp/opencode/wt-<task> push -u origin task/<name>

# integration
git fetch
git merge --no-ff origin/task/<name>
git push

# cleanup
git worktree remove /tmp/opencode/wt-<task>
```

運用invariants:

```text
shared main treeのbranchを切替えて作業せず、worktreeを使う
branch fixのlanded判定 = mainへmerge + push + post-merge gate
他taskのWIPがmain treeにある時は、そのtreeをrebase/pullで動かさない
同じfileを複数laneが触る場合はownershipを調整する
HARD STOPに該当するintegration操作だけを保留し、review/test等は続ける
```

健全性/host:

```text
status: bun tools/buddy-status.mjs  (--json available)
resident host: single instance
start: cd buddy-driver && setsid nohup bun agent-runner.mts </dev/null > runner.out 2>&1 &
server: 127.0.0.1:25565 (Leaf 1.21.11, offline, peaceful)
Java: 21.0.13-ea; server startには -DPaper.IgnoreJavaVersion=true
control socket: data/resident/control.sock (0600, JSON Lines)
query: report / status / goal / milestone / acceptance
reversible resident controls: freeze / resume / reload / gc / leakcheck / soft simdeath
bot names: AI_Buddy=resident, AI_M1*/AI_M2*=verification, s0u7a=human
secret boundary: /home/s0u7a/.config/kimaki-secrets/
```

`worldreset`, server stop/restart, intentional resident shutdown等はH1/H4として扱う。
HOST↔generation contract versionは `RESIDENT-MODE.md §4-A` が正典。
`bun run contract-docs-check` がdoc/code mismatchを検出する。

### 4.0-B レーン重複防止 / supersession / CURRENT-STATUS（派生）

```text
・lane開始前（実装に触る前）: bun tools/lane-guard.mjs を実行する（読み取り専用）。
  DUPLICATE_LANE（exit 1）= 同一issueを主張するopen PR/worktreeが既にある。
  → 新laneを足さず、既存laneと調整・統合する（重複実装は後でマージ衝突の山になる）。
・stale branch/worktreeのsupersession: headが origin/main の祖先であり、追跡された変更が
  無いことを証明できたものだけをprune候補にする。未マージ・dirtyなworktreeは削除しない。
  判断材料は lane-guard の branches/worktrees/prs と UNKNOWN 表示（読めないソースを推測で埋めない）。
・現在状態はDERIVED（手書きしない）: bun tools/current-status.mjs が「今何が真か」の正典。
  再生成は bun run current-status:write。TODO/docsは古いruntime状態を現在として再掲しない
  （historical evidenceとしてのみ残す）。依存とfrontierは bun tools/issue-graph.mjs。
```

## 5. 完了の定義（M4）

```text
M1: 3 log -> crafting_table -> wooden_pickaxe -> cobblestone
M2: diamond×3 -> diamond_pickaxe -> flint_and_steel -> obsidian×10 -> Nether gate built/lit/verified
M3: ender_pearl×12
M4: enter Nether -> blaze rods -> ender_eye×12 -> stronghold -> End -> dragon
```

各段で一次ログ＋inventory/predicateをrun-scoped evidenceとして残し、ARCHITECTURE.mdとissueを更新する。
意味論が未検証の証拠はCOMPLIANCE=UNKNOWNとして扱う。

## 6. Issue queue

### 0. P0 methodology / evidence integrity
```text
#63 authority hierarchy / evidence taxonomy / run isolation / replay semantics / release scope
```

### A. P1 substrate correctness
```text
#5 speculative generation durable mutation
#13 listener leak
#28 disconnect lease revoke
#38 nested actuation capability bypass
#40 authoritative AgentSnapshot/state classes
#48 stale ledger proposal revision bypass
#49 reload rollback ownership mismatch
```

### B. #11 architecture skeleton/correctness
```text
#21 OptionSpec/compiler
#20 SkillCandidate
#14 known resources
#29 grounding
#50 blocked Option execution
#52 Option instance identity
#54 mechanics/recipe truth
#55 prerequisite/core-goal preservation
#56 OptionSpec -> Jev
#57 predicate round-trip
#59 unknown-health semantics
```

### C. shadow + evaluation
```text
#22 β shadow
#32 raw Boolean probability
#36 decision provenance IDs
#23 replay screen
```

### D. Mercury correctness
```text
#15 cache replay
#30 patch/replace tail
#18 retry accounting
#16/#17/#33 cache namespaces
#19 typed operation/capability
```

### E. authority/consolidation
```text
#24 β meta-controller
#35 semantic planner consolidation
#41 capability graph
```

### F. resident/world correctness
```text
#25 worldEpoch lifecycle
#27 reconnect storm
#31 stale station memory
#26/#34 simdeath semantics/telemetry
#39 explicit JevController integration API
```

## 7. M4設定blocker

現在difficulty=peaceful。M2のネザーゲート構築まではpeacefulで進められる。M3は`ender_pearl×12`と定義され、エンダーマン（敵対mob）のドロップが必須になるため、M3着手前にdifficulty変更をproduct decisionとして明示し、変更runを証拠化する（ブレイズはM4のeyes of ender×12で必要になる）。
それまではresident/Option/M2（ダイヤからゲートまで）の検証を進める。

## 8. 設計判定ルール

```text
Mission predicate / dependency -> capability graph
時間的にまとまった行動        -> Option / Skill
瞬間的な候補選択              -> Jev π
Option継続可否のsemantic判断  -> Jev β + deterministic meta-controller
安全性 / 成功 / world truth   -> deterministic code
物理実行                      -> Executor / Mineflayer
接続 / durable authority      -> HOST
```

<!-- merged: preserve current main policy -->
同じsemantic questionを複数layerが所有し始めた場合は、責務重複として整理対象にする。
<!-- merged: retained integration guidance -->
**2つ以上のsemantic layerが同じ問いに答え始めたら設計臭。**
<!-- end merged guidance -->
