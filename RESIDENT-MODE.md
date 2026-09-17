# RESIDENT MODE — 正典要件ファイル

> このファイルが「常駐化（resident + hot-reload）」の唯一の正典。
> 設計レビュー全文（Oracle, 8項目）: `/home/s0u7a/.local/share/opencode/tool-output/tool_0afd7bb91001IGYUxrqG6rKUNb`
> 実装者は必ず「設計レビュー全文」を読んでから着手すること。独自解釈で先走らない。

## 0-A. ランタイム/バンドラ方針（ユーザー指示: 基盤をBunにして高速化）

### 採用: バンドラは **esbuild を既定（安定性優先）**、Bun はゲート通過後のみ
- **ユーザー最終判断: 安定性優先**。高速バンドラが使えるとしても、実績のある方を既定にする。
  → **バンドラ = esbuild**（devDependency に固定）。世代ごとのハッシュ付き新ファイル＋`import()` の運用は §2 のまま（原子的な世代交代は不変）。
  → **`Bun.build` はフラグ付きの実験経路**とし、§0-A下部の移行ゲートを全て通った場合のみ採用。通らなければ esbuild のまま。
  ```ts
  await esbuild.build({ entryPoints:['src/host/generation-entry.ts'], bundle:true, format:'esm',
    platform:'node', packages:'external', outfile:`data/resident/gen-${sha.slice(0,12)}.mjs` })
  ```
- **ランタイム Bun は許容（ただしゲート通過が条件）**。`bun run` でTS直実行＝tsx不要、`bun test` でテスト高速化、`Bun.serve({unix})` が制御ソケットに合致。
  通らなければ Node+tsx に戻す。どちらになったかを `ARCHITECTURE.md` / `M2-PROGRESS.md` に1行で記録する。

### 受け入れるリスクと検証ゲート（必須）
Bun の Node 互換で最大のリスクは **mineflayer / minecraft-protocol**（`net`・`zlib` gzip stream・`dns`・`crypto`）。
- 有利な事実: 本サーバーは **`online-mode=false`** のためプロトコルの暗号化ハンドシェイク（AES/CFB8）を通らない＝互換リスクの主要因が1つ消えている。
- **移行ゲート（これが通るまでNodeに戻せる状態を維持）**:
  1. `bun run` で接続でき `SPAWN` する（`bot.version==1.21.11`）。
  2. **移動パッチが有効**（`patches/mineflayer-4.39.0-locomotion.patch` / `movement-patch:check` が ok。Bun でも `node_modules` へのパッチ適用は同じ。postinstall 実行可否を確認）。
  3. **M1 回帰 4/4**（`llm.called==false`、wedge 0）を同一の決定論モードで再現。
  4. テスト全緑を **`bun test`** で再現（typecheck / guard 12/12 / gating 6/6 / loop 7/7 / m1-test 5/5 / audit-test 9/9 / step-pipeline-test 6/6）。
  5. 常駐モードの検証（§9）を Bun 上で通す。
- 上記1〜3が落ちる場合: ランタイムは **Node（tsx）に戻し、バンドラのみ Bun.build をサブプロセス/スクリプトとして利用**する（`bun build` をCLIとして呼ぶだけなら実行時の互換リスクはゼロ）。この hybrid は許容（高速バンドルの利得は保持）。
- 判断の記録: どちらの構成になったかを `ARCHITECTURE.md` と `M2-PROGRESS.md` に1行で残す。

---

## 0. ユーザー指示（優先順位・最新）
1. **常駐化（resident）を最優先**。M2ラダーの完走より常駐化を先に着地させる。
2. バッチ型ループ（接続→≤200s走行→切断→コード修正→再接続→状態ゼロから再構築）がボトルネック。**同じ接続を保持したまま方針だけ差し替える**のが本命。
3. AI_Buddy に開発途中の知能を載せ、**泥臭くてもゲーム攻略を進め続けさせる**（失敗で死なない・回復して前進）。
4. 【観測事実＋根本原因】ワールドに**作業台が約20個**ある。
   **根本原因（ユーザー分析）: 毎回エージェントを作り直しているため**。M1を何十回も試行し、そのたびに作業台を1個設置して捨てている＝20個は試行回数の痕跡。
   → これは「バッチ型＝状態の記憶が無い」ことの**可視化された証拠**であり、常駐化の必要性そのもの。常駐化すれば作業台は**1回置けば以後ずっと再利用**される。
   → 対策（実装要件）:
     - 起動時（および再接続時）に**既存の作業台をスキャンして `WorldMemory.discoveredStations` に登録**し、以後はそれを優先使用する。
     - 設置は「スキャンしても周囲に1つも無い」場合のみ。設置したらホストの store に永続化し、以降の世代交代・再接続をまたいで再利用する。
     - 既存の作業台は**撤去しない**（無害なインフラとして活用する）。
   → 副次効果: 同一地点での無駄な再設置が消え、木材消費とクラフト試行時間が削減される。

## 1. 所有権マップ（衝突防止）
| ディレクトリ | 所有者 | 備考 |
|---|---|---|
| `/home/s0u7a/mc-ai/jev-agent/` | 単一の編集者（現: M2セッション） | 他は読み取りのみ |
| `/home/s0u7a/mc-ai/buddy-driver/` | AI_Buddy 常駐ドライバ | 常駐化の実装場所（推奨） |
| `/home/s0u7a/mc-ai/companion/` | 簡易buddy（終了予定） | AI_Buddy名は明け渡す |
| `/home/s0u7a/mc-ai/` 直下の md | 各タスクが追記 | `ARCHITECTURE.md` `MILESTONES.md` `M2-PROGRESS.md` |

- サーバー停止・再設定禁止／人間 `s0u7a` に干渉しない。
- `canDig=true` 禁止／テレポート禁止／sudo・apt禁止／コミット禁止／`any`・`@ts-ignore` 禁止／APIキー出力禁止。

## 2. 最重要の技術訂正（これを外すと必ず壊れる）
`import('./controller.ts?v=hash')` 単体では**壊れる**。controller の静的 import（`./executor.ts` `./candidates.ts` …）は世代0のURLに解決され、**新しい controller が古い executor/candidates に配線される**（stale graph）。

正解＝**リロード層を esbuild で1本のバンドルに固め、内容ハッシュ付きの新パスとして import する**:
```ts
esbuild.build({
  entryPoints: ['src/host/generation-entry.ts'],
  bundle: true, format: 'esm', platform: 'node',
  packages: 'external',                       // mineflayer/pathfinder/prismarine を共有
  outfile: `data/resident/gen-${sha.slice(0,12)}.mjs`,
})
const mod = await import(pathToFileURL(outfile).href)  // 1ファイル=1URL=グラフが原子的に世代交代
```
- `packages:'external'` で `new Movements(bot)` がホストのpathfinderプラグインと同一クラスになる。
- esbuild は devDependency として明示固定（tsx 経由の推移依存に頼らない）。
- 旧世代のバンドルはロールバック用に残す（`gen-<prevHash>.mjs`）。

## 3. 層分離
**HOST（再読込しない）**:
- `mineflayer.createBot` + プラグイン読込（pathfinder 等）／安定ユーザー名（`AI_Buddy`）
- プロセス系イベントのみ購読: `end` / `kicked` / `error` / `spawn`、再接続バックオフ
- **logger / JsonlWriter の所有**（現状 `JevController` が自前生成し `setOptions()` が新規作成するため、リロード毎に run.jsonl が二重オープンする: `controller.ts:345-349,420-423` → ホスト所有へ移して注入）
- **ResidentState ストア**（インメモリを真実＋`data/resident/state.json` へ tmp→rename の原子的ミラー。SQLite不採用）
- Unixソケット制御サーバ／リロード調停（build→import→smoke→quiesce→attach→start）

**RELOADABLE（バンドル単位で差し替え）**: `controller.ts` `executor.ts` `candidates.ts` `policy.ts` `jev.ts` `gating.ts` `scheduler.ts` `goalQueue.ts` `state.ts` `crafting.ts` `system2.ts` `decisionlog.ts` `resourceClass.ts`

境界の判定基準: **失うと「接続・世界・ログ」が失われるものはホスト／1決定ぶんの派生計算で済むものはリロード層。**

## 4. Generation 契約（原子スワップの要）
```
smokeTest(state)  // botに触れず、凍結データで buildWorldState→generateCandidates→guard を実行し throw しないこと
quiesce()         // タイマー停止 / cancelCurrent(stopDigging・setGoal(null)・abort) / in-flight settle を有界待ち / listener解除
attach(ctx)       // listener登録のみ。タイマー開始しない
start()           // スケジューリング開始
resume()          // スワップ失敗時に旧世代を復帰
snapshot()/dispose()
```
**スワップ順序（致命）**: `build` → `import` → `smokeTest` → ここまで全て成功してから旧世代 `quiesce` → `snapshot` を store へ → 新規 `attach`/`start`。
失敗時は旧世代が未破棄なので `resume()` で**ゼロダウンタイム・ロールバック**。

## 5. 状態の持ち越し（リロードで失ってはいけないもの）
- サブゴール台帳: 既存 `GoalQueue.snapshot()/restore()`（`goalQueue.ts:251-259`）＋`ledgerPath`
- 失敗記憶: `candidateFailures` / `failureStreak`（世界の真実。リセットすると同じ袋小路に再突入）
- wedgeカウンタ / tick・jev・llm カウンタ / `policyEpoch`・`candidateSetHash`（陳腐化不変条件。リセット禁止）
- **新規 WorldMemory（世界/枯渇モデル）**: 現状は毎tick再スキャンで枯渇知識が無い（`state.ts:1041` `scanRadius=48`）。
  `mined` / `discoveredOres` / `discoveredStations`（作業台の位置！）/ `explored` をホストに永続化し、
  `generateCandidates` が「枯れたlogを避ける／発見済み鉱石と作業台を優先」できるようにする（＝世界リセット不要化）。
- 在庫・位置・体力はホストの `bot` から生きているので**ストアに複製しない**（drift源）。

## 6. 制御チャネル
- 主: Unixドメインソケット `data/resident/control.sock`（0600＝権限が認証、双方向push、`{id,cmd,args}`→`{id,ok,data}`）
- 従: `control/inbox.jsonl` 追記（結果は `control/outbox.jsonl`、`id` で重複排除）
- コマンド: `goal` / `milestone` / `mode llm|deterministic` / `report` / `reload` / `retry` / `freeze` / `resume` / `leakcheck` / `gc` / `quit`
- **mode切替はフルリロードで行う**（`createJevPolicy` が構築時に種別固定のため。決定論モードの `llm.called==false` を clean に証明するため）

## 7. 介入ループ（wedgeは終了ではなく凍結）
現状: `abortWedge()→finish('wedge',false)`（`controller.ts:1547-1577`）で**プロセス終了**。
新フロー:
```
wedge検出 → ctx.requestFreeze(reason) → cancelCurrent → settle（≤3s）
  → FreezeReport を logs/resident/freeze-<ts>.json へ原子的に書く
     （buildWorldState / generateCandidates / 直近20決定 / queue.snapshot() / 在庫 /
       周辺ブロック / カウンタ / listener数 / heap）
  → ソケットへ {event:'frozen', reportPath, reason} を push
  → ★接続は生かしたままアイドル（位置保持）
  → 開発者/上位AIが src/** を修正 → reload
  → 新世代が state から復元（wedge状態のみクリア、失敗記憶は維持）→ 合成トリガ resume で凍結点から再開
```

## 8. 失敗モードと緩和（要約。詳細は設計ファイル）
| 失敗 | 緩和 |
|---|---|
| listener再登録リーク（`forcedMove` WeakMap `executor.ts:30` / `physicsTick` :775 / `goal_*` :1958-1960） | `detach()` 契約＋リロード前後で `bot.listenerCount(event)` が基準値に一致することを assert |
| pathfinderゴール残留 | `quiesce` で `cancelCurrent` → settle を有界待ち、listener数をassert |
| 二重ハンドラ/二重tick（Jev呼び出し2倍） | host が `generationEpoch` を持ち、陳腐化epochのイベント/クレームを破棄 |
| host↔世代のインターフェース齟齬 | `CONTRACT_VERSION` を export し、ホストが不一致バンドルを拒否（変更時はホスト再起動を許容） |
| サーバー再起動後のゾンビbot | ホストが再接続ループを所有。`bot` は新オブジェクトになるので世代を `attach(newBot)` で再装着（`bot` をキャッシュしない） |
| リロード途中のクラッシュ | 旧世代を破棄する前に新世代を検証。build/import 失敗時は稼働継続＋`error` を push |
| 旧世代がGCされない | ホストは世代オブジェクトを長期配列に保持しない（`WeakRef`＋`FinalizationRegistry` で検証） |
| mode切替で policy 不整合 | フルリロードで対応（§6） |

## 9. 検証（証拠必須 — これが通るまで「常駐化完了」と言わない）
1. **再接続0回で目標を連続5回**処理し、その間 (a) 在庫/位置が保持され続ける、(b) listener数・タイマー数・ヒープが単調増加しない、(c) 1回は**意図的にwedgeを起こして**凍結→修正→hot-reload→再開が成立する。→ 一次ログを引用。
2. **編集→実挙動変化の秒数**を計測（例: build/import/swap 合計 <2s、再接続0回）。
3. 素朴な `?v=hash` 単体importを使っていない（使うならグラフ全体が同一世代URLに解決されることを証明）。
4. 不変条件: System One が唯一の行動権限／LLMは有界質問のみ／決定論モードで `llm.called==false`／単調なサブゴール台帳／`policyEpoch`・`candidateSetHash`／hard hazards と Jev danger の分離／stock-Mineflayer優先／`canDig=false`。
5. テスト全緑と件数: typecheck / guard 12/12 / gating 6/6 / loop 7/7 / m1-test 5/5 / audit-test 9/9 / step-pipeline-test 6/6 / `movement-patch:check`。

## 10. 評価指標（ループが速くなったことの証明）
- edit→live（秒）: 目標 <2s（build+import+swap）
- 状態保持: N回リロード前後で `inventoryHash` / `queue.state.done` が一致、位置ドリフト0
- リーク: `bot.listenerCount(*)` の前後一致、`heapUsed` 増分、タイマー数、FinalizationRegistry の回収数
- 枯渇回避: `distinctOreBlocksMined` / 目標到達までの探索距離 を バッチ型 vs 常駐型 で比較

## 11. 移行手順（各段階に検証可能なマイルストーン）
1. `m2` からヘッドレス `ResidentHost` を抽出し、既存 `JevController` を無改造で装着。wedge/finish で**終了せず**接続を保持し freeze レポートを出す。（Short）
   検証: wedge を起こしてもプロセスが生存、`bot.health` が読める、freeze JSON が生成される。
2. Generation 契約＋esbuild バンドルによるホットリロード。ホストがbotを保持したまま世代交代。（Medium）
   検証: 5回リロードで listener数一定・在庫/queue 保持・`bot.username` 不変。
3. 制御チャネル（Unixソケット＋inboxフォールバック）。（Medium）
   検証: 1プロセスでソケット経由の目標を連続5回注入、再接続0回で全て完了報告。
4. WorldMemory（枯渇モデル＋作業台の既存探索）を `generateCandidates` に接続。（Medium/Large）
   検証: M2後に鉄を**spawnから再探索せず**見つけられる。探索距離が減少。作業台の新規設置が0〜1個に収まる。
  5. 再接続・再装着＋リーク/GCソーク。（Medium）
   検証: 走行中にサーバーを落として再起動 → 同一ユーザー名で再参加し、キュー/在庫が保持される。

---

## 12. 運用ノート（実測で踏んだ罠 — 常駐化でも必ず再発する）
- **デタッチ起動**: `cd <dir> && NODE_PATH=/home/s0u7a/mc-ai/jev-agent/node_modules setsid nohup node x.cjs </dev/null > x.log 2>&1 &`
  これをしないと bash ツールが子プロセスを待ち続けてタイムアウトし、シェル終了時に bot も落ちる。
- **`pkill -f "buddy.cjs"` 自爆**: `pkill -f` は自分のコマンドラインにもマッチし得るため、実行シェルごと殺してツールがハングする。
  停止は PID 指定（`kill <pid>`）か、`pgrep -f` で自分のPIDを除外して行う。
- **`mineflayer-pathfinder@2.4.5` のエクスポート**: `GoalNear` は直下ではなく `goals` 経由。
  `const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')` → `new goals.GoalNear(x,y,z,range)`。
  （`mineflayer` は 1.21.11 = protocol 774 に対応済み。実測 `version=1.21.11` で接続成功）
- **実測ログ（簡易buddy）**: `SPAWN pos=(-3.5,73.0,6.5)` → `TARGET name=s0u7a` → `HEARTBEAT target=s0u7a dist=3.0 pos=-4.5,70.4,-1.7`（2〜3mまで接近成功）。ログ: `/home/s0u7a/mc-ai/companion/buddy.log`
- **★追従の失敗モード（ユーザー実測: 「直線上に壁が1mでもあれば動かん／登らない・迂回しない」）**:
  原因は pathfinder の能力ではなく**制御ロジック**。`REPATH_DISTANCE=5`（距離>5mのときだけ再パス）＋`GoalNear(..., STOP_RANGE=3)`（3m以内は到達済み判定）の組合せで、
  **壁越し3〜5mでは再パスも到達判定も「済み」になり完全に停止**する。静止しているので当然 段差も迂回もしない。
  対策（常駐エージェントでも必須）:
    1. 追従は閾値つき `GoalNear` ではなく **`GoalFollow(entity, range)` を `dynamic=true`** で使い、毎tick再パスさせる（A*が壁を迂回する）。
    2. **スタック検知**: 2秒ごとに「距離>2.5m かつ 移動量<0.3m」なら `STUCK` を記録 → 目標再発行 → 2回目でジャンプ → 3回目で中間ウェイポイント迂回。移動>0.5mでカウンタリセット。
    3. **沈黙禁止**: `path_update`/`noPath`/`timeout` を必ずログ。垂直到達不能（>1ブロック上・階段なし・設置不可）は `UNREACHABLE` を10s間隔で出す。
    4. 1ブロック段差は `canJump`（既定true）で登れる。`canDig=false` は維持。トゥワー設置は不可（`scafoldingBlocks=[]`）。
- **★2ブロック以上の壁を登ろうとする現象（ユーザー再報告: まだ直っていない）**
  物理限界: ジャンプ最高到達 **1.2522** → **2ブロック段差は原理的に登れない**。よって「登ろうとする」こと自体がバグ。
  要件:
    1. **候補生成の段階で除外**: 移動候補が「1ブロック超の段差」を要求する場合は候補にしない（`stepUpHeight > 1` を弾く）。
    2. 2ブロック面に遭遇したら選択肢は2つだけ: **(a) 迂回経路の探索**（周囲を回る）/ **(b) 階段化**（`STEP`/`stepCuts` で上段を1ブロック掘って段差を1にする。掘削が許される資源クラスのみ）。
    3. **同一壁への反復ジャンプは wedge として扱う**: 同一座標±1でのジャンプ試行が N 回を超えたら方向を変える（`CLIMB_FAIL wallHeight=2 attempts=N` をログに出し、候補からその面を除外）。
    4. ログで可視化: `CLIMB_ATTEMPT height=2` / `CLIMB_FAIL` / `DETOUR` / `STAIRCUT ok=true cuts=1`。無言で登り続けるのを禁止。
  根拠: 本プロジェクトで実測済みの物理定数（jump apex 1.2522）。過去に `STEP`/`stair-cut` ＋ 接触前ジャンプで 2.25m の段を攻略した実績があるため、**迂回か階段化のみ**が正解。

