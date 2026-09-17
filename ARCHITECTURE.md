# Jev-agent / AI_Buddy architecture (as-built), external review handoff

対象読者: 外部シニアレビュア（Sol）。目的は宣伝ではなく、現状の実装・動いているもの・壊れているもの・詰まっているもの・次の一手を、証拠付きで渡して軌道修正してもらうこと。

読み方に関する注意:
- 本ドキュメントは 2026-09-18 00:03 JST 時点のスナップショット。この時点で **リポジトリは赤い**（typecheck が通らない、2 つのテストがロード不能）。同時に **常駐ホストが生きたプロセスとして走っている**（`node agent-runner.mts`, PID 150528）。つまり「実装中」の状態を写している。
- 検証できなかった主張は `UNVERIFIED: ...` と明記した。プロンプト側の主張でも、実ファイルと食い違うものは実測を優先し、差分を本文に書いた。
- ファイルパスは `/home/s0u7a/mc-ai/` 起点。ログは `jev-agent/logs/` 起点。

---

## 1. 目的とゴール

身体性を持つ Minecraft Java エージェント。LLM が長期計画を立て、Jev（TypeSafe の意味判断モデル）が「System One」として局所的に行動を選び、Mineflayer が motor/reflex を担う。3 層は固定周期ではなく「どれだけ先を考えるか」で分ける。

エンドポイント:
- **M2（iron age）**: furnace → charcoal → iron_ore → iron_ingot x3 → iron_pickaxe。
- **M4（Ender Dragon）**: stronghold → end portal → Ender Dragon 撃破。現状はユーザー判断で後回し。

マイルストーンのはしご:
| ID | 内容 | 状態 |
|---|---|---|
| M0 | 平坦な closed loop（MOVE → walk → MINE → 検証済み dig） | PASS（`logs/m0-final/`） |
| M1 | Jev-only 4 サブゴール計画（LLM 呼び出し 0 が目標） | PASS（fresh world, `logs/m1-fresh2-console.log`） |
| M2 | furnace + charcoal → iron ore → iron tools → diamond pickaxe | 進行中、最高 5/14（`logs/m2-fresh2-console.log`） |
| M3 | nether portal → blaze rods → ender pearls → eyes of ender | 未着手 |
| M4 | THE DRAGON | 後回し |

優先順位（ユーザー最終指示、`RESIDENT-MODE.md` §0）: **M2 ラダーの完走より常駐化（resident + hot-reload）を先に着地させる**。バッチ型ループ（接続 → 200 s 走行 → 切断 → 修正 → 再接続 → 状態ゼロ再構築）がボトルネックであり、同一接続を保ったまま方針だけ差し替えるのが本命。

---

## 2. システム構成（現状の実装）

### 2.1 層構造

```
sensor -> WorldModel(JSON) -> deterministic grounded CANDIDATES
      -> Jev (1 batched call; CORE + trigger-specific questions) -> deterministic GUARD
      -> fresh sensor re-validation -> Executor (single-action) -> VERIFY -> loop
```

実装モジュール（`/home/s0u7a/mc-ai/jev-agent/src/`）:

| モジュール | 役割 | 主な中身 |
|---|---|---|
| `state.ts` | BotState + event sensors | `buildWorldState`, `buildStepCuts` (StepCut), `buildHeadroomCuts` (HeadroomCut), `scanRadius=48`, 探索キャッシュ無し（毎 tick 再スキャン） |
| `candidates.ts` | 決定論的候補生成 | `CandidateKind = MINE\|MOVE\|ATTACK\|EAT\|RETREAT\|WAIT\|ESCALATE\|CRAFT\|PLACE\|SMELT\|DESCEND\|STEP`。`headroomCandidates` (ceiling clear), `stepCandidates` (STEP/stair-cut), `craftCandidates`, `placeStationCandidate`, `pickExplore`, `DESCEND_FAILURE_LIMIT=3` |
| `gating.ts` | LLM に問い合わせる条件 | `{value, confidence, threshold, actionable, reason}` の gated value。score は低信頼だと非 actionable |
| `policy.ts` | System One 行動ポリシー + guard | `guardStep`, `guardMine` (headroom clearance), `guardCraft`, `guardPlace`, `guardSmelt`, `guardDescend`, `ACTING_KINDS` |
| `controller.ts` | JevController: tick loop, wedge 検出, escalation, ledger | `policyEpoch`, `candidateSetHash`, `criticalArrivedDuringFlight()`, `syncGoalToQueue`, `ledgerPath`, `stopAfterSubgoals`, `abortWedge`（現状はプロセス終了） |
| `scheduler.ts` | イベント駆動スケジューラ | trigger の優先度合流、single-flight、`TRIGGER_PRIORITY` |
| `goalQueue.ts` | サブゴール台帳 | `GoalQueue.snapshot()` / `restore()`, `PlanOp = continue\|patch\|replace\|abort`, `applyPlan` |
| `decisionlog.ts` | 決定ログ (jsonl) | `decisions.jsonl`, `run.jsonl`, `jev-calls.jsonl` |
| `resourceClass.ts` | 意味クラス解決 | `log\|planks\|stone\|fuel\|food\|pickaxe` を実在アイテムへ解決 |
| `system2.ts` / `jev.ts` | LLM 側 | `experimental_evaluate({model,state,questions})` は `ai` v7 経由。fallback は `deterministic-local-fallback` |
| `crafting.ts` | 純粋なレシピ推論 | `RecipeIndex`, `planNextCraftStep()`（bot も network も持たない） |
| `craftWindow.ts` | **新規（実装中）** | `craftAtTable()`, `CraftRecipeLike`。stock `bot.craft` の stateId 問題を回避するためウィンドウを明示所有 |

### 2.2 Motor（`executor.ts`、約 93 KB と最大）

locomotion, actuator, dig/pickup, craft/smelt を担当。主要なもの:
- `approachPlacedBlock(block,label,...)`: craft/smelt station への接近。stock pathfinder の有界 slice + `directBearing` nudge + `findApproachStepCut`。
- `runStep`: 2-block face の上段を掘って 1-block step に変える。
- `runMine`: 通常 dig + drop pickup。`meta.clearance=true` のときは `collectDrop` をスキップ。
- stock `collectblock` を有界 slice（`STOCK_COLLECT_BUDGET_MS = 2500`）で使い、control nudge は専用の予約窓（`PICKUP_NUDGE_TOTAL_MS`）。
- `guardDescend` と対になる sensor の `state.descent`（`floor`/`wall`/`head`）。
- `walkByControls`（control 層の fallback actuator）: `scanAhead` 0.8〜2.8 m、接触前ジャンプ、`hasJumpHeadroom`/`headroomAt` は `Math.floor(feet)`。
- stock-first: `pathTo` は stock `pathfinder.setGoal` を先に試し、stuck/noPath/timeout のときだけ `walkByControls` → packet stepper に落ちる。`allowParkour` / `allow1by1towers` は `false`。

### 2.3 LLM（Jev）

- API: `experimental_evaluate({ model:'typesafe-ai/jev', state, questions })`（`ai` v7、`@typesafe-ai/sdk`）。`jev.ts:577` に `DEFAULT_JEV_MODEL = 'typesafe-ai/jev'`。
- question 型: `choice | score | boolean`（`noul` はドキュメント上の別名）。
- CORE（毎回）: `action` (choice、唯一の権威), `goal_progress` (score), `plan_still_valid` (score), `situation_understood` (score)。
- trigger 別: THREAT は `danger`, `should_retreat`。STALL/FAILURE は `goal_blocked`, `strategy_change_needed`。
- boolean は `probability` のみ（信頼度なし）。0.30/0.70 の不確実帯で読む。
- score の信頼度は `providerMetadata.typesafe.confidence`。`DANGER_CONFIDENCE_THRESHOLD = 0.4`、未満は `preserveCurrentSafeAction()`。
- 実測: コストは入力 $0.04/1M、実 run 平均 ~$0.00018/call（`logs/jev-calls.jsonl`, n=12: mean 4419 input tokens, p50 4901 => 平均 ~$0.000177、p50 ~$0.000196）。レイテンシ p50 ~410〜720 ms。
- **決定論モードの絶対条件**: `llm.called==false`。常駐ホストは現状 `policy=fallback model=deterministic-local-fallback` で走っており、この条件を満たす。`createJevPolicy` は構築時に種別固定のため、mode 切替はフルリロードで行う（`RESIDENT-MODE.md` §6）。

### 2.4 変更しないもの（by design）

- **Mineflayer を fork しない**。stock published `mineflayer@4.39.0` / `minecraft-protocol@1.68.0` / `minecraft-data@3.116.0` / `mineflayer-pathfinder@2.4.5`。`package.json` に `github:` / SHA pin は無い。
- ローカル patch: `patches/mineflayer-4.39.0-locomotion.patch`（upstream PR #4063 のサブセット）。内容は (1) `sendTeleportReply()` が clientbound teleport に応答する際 `lastSent` を server target で上書きしない、(2) `updatePosition` が vanilla の `dx*dx+dy*dy+dz*dz > 4e-8 || positionReminder >= 20` を使う。
- `scripts/apply-movement-patch.mjs` が `postinstall` で冪等適用、`npm run movement-patch:check` で検証。実測直近: `applied 0 hunk(s), 5 already present; verified 4/4 checks`（`npm run movement-patch:check`, 2026-09-18 00:02）。
- 撤退口: `npm ci --ignore-scripts`。

### 2.5 常駐ホスト（`buddy-driver/`、2026-09-17 深夜に実装済み）

| ファイル | 役割 |
|---|---|
| `agent-runner.mts` (689 行) | HOST。`mineflayer.createBot` + plugin、再接続 backoff、logger 所有、`buddy-state.json` の原子的ミラー、Unix socket 制御サーバ、reload 調停、source watcher |
| `generation-entry.ts` (404 行) | RELOADABLE 層の入口。`JevController` + `FixedPlanSystem2` をラップ。esbuild で 1 本の hash 付きファイルに束ねる |
| `resident-types.ts` (126 行) | HOST ↔ generation 契約。`CONTRACT_VERSION=1`、`ResidentWorldMemory`、`ResidentState`、`ResidentGeneration`（`attach`/`start`/`quiesce`/`dispose`/`status`/`stopReason`/`hasStopped`） |
| `build.mts` (90 行) | esbuild ビルド出力 `data/resident/gen-<sha12>.mjs` |
| `data/resident/control.sock` | mode 0600 の制御チャネル（実在を確認） |
| `buddy-state.json` | durable mirror（`worldMemory`, `ledger`, `generations`, `reloads`, `recoveries`） |

ホットリロード順序（致命）: `build → import → smokeTest → 旧世代 quiesce → snapshot → attach → start`。失敗時は旧世代を破棄する前に `resume()` でロールバック。naive な `import('./controller.ts?v=hash')` は **既知の壊れ方** で、新 controller の静的 import が古い executor/candidates に解決される（stale graph）。だから 1 ファイル 1 URL のバンドル単位でしか世代交代しない。

---

## 3. 環境

| 項目 | 値 | 検証 |
|---|---|---|
| サーバ | Leaf **1.21.11** build #178（`leaf-1.21.11-178.jar`, 83,955,502 bytes） | `sha256sum` 一致 |
| jar sha256 | `b01c2f6037f97a4e1cd1d23dc6574ebb4839de12395b62aa465fac63db263627` | 実測一致 |
| Java | `openjdk 21.0.12.1 2026-08-18`（`/usr/lib/jvm/java-21-openjdk-amd64`） | 実測 |
| 待受 | `127.0.0.1:25565` | `server.properties` |
| online-mode | `false` | `server.properties` |
| difficulty | `peaceful` | `server.properties` |
| spawn-protection | `0` | `server.properties` |
| view-distance / simulation-distance | `8` / `8` | `server.properties` |
| level-seed | `2024` | `server.properties` |
| その他 | `allow-flight=true`, `spawn-monsters=false`, `max-players=10` | `server.properties` |

WORLD リセットの履歴（枯渇対策）:
- `world`, `world_nether`, `world_the_end` → `world-*-depleted-20260917-223756`（2026-09-17 22:37 JST）に退避。fresh 再生成ログは `Done (13.198s)!`。
- さらに古い `world-26.1.2-backup`（旧 Leaf 26.1.2）、`world-26.2-backup` も残る。
- 注意: seed 2024 の地表面 stone は 2026-09-17 深夜時点で枯渇済み（`data/seed-scan.mts` が `exposed+standable=0`）。M1 の cobblestone 脚と M2 の stone/iron 脚は DESCEND に依存する。これが世界リセットを不要化する WorldMemory の動機。

人間クライアント:
- PrismLauncher AppImage + Fabulously Optimized 1.21.11 instance（`Fabulously Optimized(1)`）。`s0u7a` で参加。プロセス実測で PrismLauncher の Java 21 runtime が起動中。
- 簡易 buddy（`companion/buddy.cjs`）は `s0u7a` を追従。`companion/buddy.log` 実測: `SPAWN pos=(-3.5,73.0,6.5)` → `HEARTBEAT target=s0u7a dist=3.0` まで接近後、`dist=3.5〜10.3` で停滞（`REPATH_DISTANCE=5` + `GoalNear` の既知の追従失敗モード。`RESIDENT-MODE.md` §12）。

---

## 4. 不変条件（設計上の約束）

1. **System One が唯一の行動権限**。LLM は自由文を出さず、有界な質問にだけ答える。Jev が選べるのは決定論的に生成された候補だけ。
2. 決定論モードは `llm.called==false` を示さなければならない。
3. サブゴール台帳は **単調**（`pending|active|done|impossible`。`done` は再訪しない）。replan は `continue|patch|replace|abort`。
4. `policyEpoch` / `candidateSetHash` / `currentActionEpoch` / `criticalStateVersion` による陳腐化チェック。guard は `executor.claim` 直前に fresh sensor で再検証する。
5. **hard hazard は決定論的**で、Jev の danger score に上書きされない。低/不確実 danger は no-op。confident severe danger でさえ既存の `RETREAT`/`ESCALATE` 候補を置換できるだけ。
6. **stock-Mineflayer-first**。自前 actuator は文書化された fallback のみ。
7. `canDig=false`（movement pathfinder は掘らない。掘るのは明示的で guard 済みの `bot.dig` のみ）。
8. wedge detector: 同一候補が verified progress 0 のまま >5 回、または goal progress 0 >60 s で `ABORT: wedge detected`。
9. 候補は grounded（実在ブロック/実在アイテム/実在レシピに紐づく）。
10. action coalescing と single-flight（同時決定なし。critical trigger は flight 中の結果を stale として破棄）。

---

## 5. 検証済みの到達点（証拠付き）

### 5.1 M1 PASS（fresh world, 実測）

`logs/m1-fresh2-console.log`（AI_M1N, 240 s cap）:
- `[m1] stopped=goal-complete success=true durationMs=218840 ticks=45`
- `[m1] subgoals: planned=4 done=4 queueDepth=0`
- `[m1] LLM gate: decisions=40 with_llm_called_true=0 runtimeCalls=0 planCalls=1`
- `[m1] verifiedDigs=22 itemsCollected=22`
- サブゴール順序: `collect 3 x oak_log` → `craft crafting_table` → `craft wooden_pickaxe` → `collect 16 x cobblestone` → `plan complete`
- `FINAL INVENTORY={"stick":2,"oak_sapling":1,"dirt":5,"wooden_pickaxe":1,"cobblestone":18,"oak_log":1,"crafting_table":1,"oak_planks":3}`
- ハーネスの acceptance は `4/5`。落ちるのは「final inventory が 4 サブゴールを同時に満たす」check のみで、実際の run は oak_log を planks/table/pickaxe に消費し、置いた table は世界に残るため（既知の期待される失敗）。wedge は 0（`grep -c wedge` = 0）。

### 5.2 Movement

- stock pathfinder を primary、自前 actuator を fallback として維持。
- 接触前ジャンプ（`scanAhead` 0.8〜2.8 m, 接地かつ非衝突で forward 保持のまま jump）。
- `STEP` / `stepCuts` stair-cut: 実測 `STEP:E:b0_71_-8 status=done blockRemoved=true before=grass_block after=air`、結果の step は `landing=true headroom=true`、`wedge=done`。climb 実測 `climbed=2.25m`。
- ceiling-clear MINE for canopy pockets: `headroomCuts` + `headroomCandidates` + `guardMine` + `runMine(clearance)`。live 実測 `logs/m2-phase1d-console.log`: `no jump headroom at (0,72,-6)` → `MINE:b-1_74_-6` → `VERIFIED ... removed=true gained=0` → `STEP:W:b-2_74_-6` で経路が開く。`m2-phase1e` の 3 log 回収はこの修正で初めて成立した。
- これは `RESIDENT-MODE.md` §12 の「2-block 面は原理的に登れない（jump apex 1.2522）」制約への正しい対処の片翼。

### 5.3 Pickup

- stock `mineflayer-collectblock` は有界 slice（2.5 s）、drop が既に pickup volume 内なら skip。control nudge は予約 5 s（実測では `PICKUP_NUDGE_TOTAL_MS` 6000 に延長）、`directBearing` で 1.15 m 半径へ接近。
- 実測 `pickup oak_log distance=1.8 nudges=2 drop=yes gained=1`。M1/M2 の subgoal 1 は実際の pickup で完了。
- 残る弱点: 高低差に敏感（canopy leaf 上 ~1.7 m の drop は `nudges=2 gained=0`）。

### 5.4 station 接近と descend

- `approachPlacedBlock` / `guardDescend` sensor 修正 / `syncGoalToQueue` の place 意味論修正。
- `GoalQueue.snapshot()/restore()` + `m2.mts --ledger <path> --stop-after <n> --no-clean`。実測 `logs/m2-phase1b-console.log`: `[system2] phase ledger restored: 0 subgoal(s) already done; current=collect 3 x log {"done":0,"total":14}`。

### 5.5 Sol audit 由来の適用済み項目

CORE + trigger 別 question 集合、boolean 0.30/0.70 帯、action-only authority（`target` question 廃止）、trigger Map + priority drain、`policyEpoch`/`candidateSetHash`、単調サブゴール台帳、`resourceClass.ts`、`PlanOp continue|patch|replace|abort`。

### 5.6 craft-at-station: 修復が agent レベルで確認できた（ただしビルドは赤）

- `logs/probe-craft-diag2.log`（2026-09-17 23:49）: `[probe] AGENT-PATH result= {"status":"done","detail":"crafted 1x wooden_pickaxe","gained":1}`。
- `logs/m1-diag2-console.log`（23:57）: `CRAFTDBG item=wooden_pickaxe ... table=crafting_table@17,68,4 ... requiresTable=true` の後 `[queue] subgoal COMPLETE [craft 1 x wooden_pickaxe] -> [collect 16 x cobblestone]`。つまり station craft は通った。
- ただしこれは新しい `src/craftWindow.ts` を使う実装で、その最新コードは今コンパイルできない（§6.1）。

### 5.7 テスト現況（重要: 緑ではない）

2026-09-18 00:03 時点の実測:
| テスト | 結果 |
|---|---|
| `npm run typecheck` | **FAIL**（`src/craftWindow.ts` と `data/probe-craft.mts` にエラー） |
| `npm run guard-test` | PASS 12/12 |
| `npm run gating-test` | PASS 6/6 |
| `npm run loop-test` | PASS 7/7 |
| `npm run m1-test` | PASS 5/5 |
| `npm run audit-test` | **ロード失敗**（`prismarine-windows does not provide an export named 'Window'`） |
| `npm run step-pipeline-test` | **ロード失敗**（同上） |
| `npm run movement-patch:check` | PASS（`0 hunk(s), 5 already present; verified 4/4 checks`） |

`audit-test` は history 上 9/9、`step-pipeline-test` は 6/6 まで到達している（`M2-PROGRESS.md`）。今ロードできないのは `src/executor.ts` が新規 `src/craftWindow.ts` を import しており、その module の ESM export が壊れているため。typecheck エラーの実文:
```
src/craftWindow.ts(59,16): error TS2349: This expression is not callable.
  Type 'typeof import(".../prismarine-item/index")' has no call signatures.
data/probe-craft.mts(...): error TS2345 / TS2532 ...
```
以前の typecheck では `src/executor.ts(1170,44): error TS2304: Cannot find name 'CraftRecipeLike'` 等も出ていた（import 行が入る前の過渡状態）。

---

## 6. 現在の故障・ブロッカー（正直に、証拠付き）

### 6.1 BLOCKER（最優先）: ビルドが赤く、ladder を再実証できない

2026-09-18 00:01〜00:03 の live edit で `src/craftWindow.ts` が導入され、`executor.ts` がそれを import した。現時点で:
- `prismarine-windows` に named export `Window` が無い（runtime ESM error）。
- `prismarine-item` の default import に call signature が無い（typecheck TS2349）。
- この結果 `audit-test` と `step-pipeline-test` がロード不能、typecheck 不通過。

これは「craft を直すための新実装が着地途中」の状態であり、**M1/M2 の regression 再走も、常駐の smoke test も、この赤が消えるまで意味ある検証にならない**。

### 6.2 craft at a placed station: 以前は「gained 0 → wedge」だった（history）、今は赤のため未再実証

以前の full run 実測（`logs/m2-phase1e-console.log`, AI_M2P5, 170 s, 2026-09-17 23:28）:
- `[m2] stopped=wedge success=false durationMs=125072 ticks=22`
- `[m2] LLM gate: decisions=19 with_llm_called_true=0 runtimeCalls=0 planCalls=1`
- `craft 1 x wooden_pickaxe` で materials（planks/stick）はあるのに `craft wooden_pickaxe gained 0 (after=0)` → `ABORT: wedge detected (goal progress stayed 0 for 64546ms)`。
- 同じ失敗が M1 regression も塞いだ（`logs/m1-phase-check-console.log`, 2/4）。

診断された根本原因（プロンプトの推測「window を開く/同じ table 参照を渡す」より深い）: `mineflayer@4.39.0` の `bot.craft(recipe, count, table)` は module global の `stateId` closure に依存して `window_click` を送る。crafting window を開いている間も server は player inventory（window 0）を同期し続け、mineflayer がその packet stateId を global に取り込むため、craft click が **エラーも無く item も出さずに無視される**（upstream `PrismarineJS/mineflayer#3906`）。executor は `gained 0` を見て wedge する。

現在の修復方針（`src/craftWindow.ts`, 実装中）: ウィンドウを明示所有する。`bot.openBlock(table)` で開き、click の直前に `bot._syncWindow(win)`（stateId=-1 の no-op click で server に full window state を再送させる）を強制し、mineflayer `craft.js` と同じ recipe 配置アルゴリズムを自前で実行、最後に `closeWindow`。agent レベルの diag では成功済み（§5.6）。ただし §6.1 の通り今は import できない。

教訓: 「open container + 正しい table 参照」だけでは足りない。**stateId の stale 化**まで見ないと再発する。

### 6.3 BUG: 2-block の壁を登ろうとする（ユーザー再報告、未修正）

物理限界: jump apex **1.2522**。よって 2-block の垂直面は原理的に登れない。「登ろうとする」こと自体がバグ。

最新の実測証拠（`logs/m1-diag2-console.log`, 2026-09-17 23:57）:
- `[executor] control locomotion 2-block face at (14,67,21) rise=2 is unclimbable: needs a STEP cut`（fail-fast 自体は新しい）
- しかし同じ run で `MOVE:b16_67_24` に対し `hop recoveries=21 (pinned=true still=false)`, `=22`, … と反復し、最終的に `[executor] action#9 MOVE:b16_67_24 FAILED {"failure":"path_stuck","message":"packet locomotion blocked before (14.5,68,25.5)"}` → `ABORT: wedge detected (goal progress stayed 0 for 67715ms)`。
- 候補一覧には `STEP:W:b13_70_23` が存在するのに選ばれていない。

不足している実装（コードに不在を確認）:
- `stepUpHeight > 1` を要求する移動候補の生成段階での除外が無い。
- 2-block 面に遭遇したときの「迂回 (detour) 経路探索」が第一級ではない。
- 同一壁への反復ジャンプを wedge として扱い `CLIMB_FAIL wallHeight=2 attempts=N` を出し、その面を候補から除外する仕組みが無い（`src/` に `CLIMB_FAIL` / `CLIMB_ATTEMPT` / `DETOUR` の文字列は存在しない）。
- 結果、可視化なしに無言で登り続け、最後は wedge detector が止めている。ユーザーには「まだ直っていない」と映る。

要件（`RESIDENT-MODE.md` §12 再報告）: (a) 迂回経路探索、(b) STEP/stepCuts による階段化（掘削が許される resource class のみ）、(c) 同一壁の反復ジャンプを wedge 扱いにして面を除外、(d) ログで可視化。迂回か階段化のみが正解。

### 6.4 symptom: world に作業台が約 20 個（根本原因はバッチ型の状態健忘）

ユーザー分析: 毎回エージェントを作り直すため、M1 を何十回も試行し、そのたびに作業台を 1 個設置して捨てている。約 20 個は試行回数の痕跡。

実測できる代理指標:
- サーバログの `joined the game`: 1 つのログ区間（`logs/2026-09-17-6.log.gz`）に **39 join**。保持ログ全体では 544 join（`AI_Bot` 174、`AI_Observer` 69 など多数のテスト用 username）。
- エージェント側: `PLACE:crafting_table` 文字列を含むログファイル **56 個**、その出現 **367 回**、`PLACE:crafting_table:p...` の distinct 座標 **13 個**、`subgoal COMPLETE [craft 1 x crafting_table]` が **81 回**。
- 注意: プロンプトの「56 crafting_table placement events」は実測では「56 log files contain the string」であり、event 数ではない。ここは訂正する。
- `UNVERIFIED: 現在の world 内の crafting_table ブロックの正確な個数`（ブロックスキャンをしていない）。ただし常駐ホストの起動時 WorldMemory scan は `craftingTables=9` を検出した（`buddy.log` 2026-09-18 00:02:20）。これは修正が実際に効き始めた証拠。

対策（実装要件、`RESIDENT-MODE.md` §0.4）: 起動時/再接続時に既存作業台をスキャンして `WorldMemory.discoveredStations`（実装では `craftingTables`）に登録し、以後優先使用。設置は周囲に 1 つも無い場合のみ。設置したら store に永続化し、世代交代・再接続をまたいで再利用。既存作業台は撤去しない。

### 6.5 Hot reload: 実装済み、ただし atomic swap は未成立

プロンプトの「not delivered yet」は **stale**。現状:
- `buddy-driver/agent-runner.mts`（689 行）に host、`generation-entry.ts`（404 行）、`build.mts`、`resident-types.ts` が存在。
- esbuild build 成功: `BUILD hash=45ed55a58a16 bytes=1004535 ms=33 outfile=.../gen-45ed55a58a16.mjs`（`buddy.log` 2026-09-17 23:59:58）。
- control socket 実在: `data/resident/control.sock`（mode `srw-------`）。
- source watcher と reload 調停が動き、RELOAD ログが出ている（`buddy.log`）:
  - `15:01:30 RELOAD ok=true trigger=source-changed skipped=unchanged ms=22`
  - `15:01:45 RELOAD ok=false trigger=source-changed ms=218 message=pos.floored is not a function`
  - `15:01:56 RELOAD ok=false ... message=pos.floored is not a function`
  - `15:02:20 RELOAD ok=false ... message=smoke test failed: empty plan and no completed goals`（この直前の `GENERATION_READY` は `craftingTables=9`）
  - `15:02:52 RELOAD ok=false ... message=smoke test failed: empty plan and no completed goals`
- `buddy-state.json`: `"reloads": 0`, `"generations": 2`。つまり **実際に成功した世代交代はまだ 0 回**（1 回は `skipped=unchanged` で実質 no-op）。ロールバック用の旧世代保持はコード上あるが、成功 swap は未実測。
- `logs/resident/` は空。freeze report はまだ 1 度も書かれていない（wedge → freeze の介入ループは未 exercise）。
- 現在の live 状態（`runner.out` / `buddy.log`）: resident は `policy=fallback model=deterministic-local-fallback` で走り、`collect 12 x stone` に向けて DEMAND で DESCEND 階段を掘っている。観測されたバグ:
  - `DESCEND:level:E:b9_66_17: canDigBlock() returned false for air`（dig_error が 6/6 streak）
  - `pos.floored is not a function`（reload 失敗の直接原因）
  - `smoke test failed: empty plan and no completed goals`（generation 契約の smokeTest が空 plan を許容していない）

### 6.6 hot reload が使う**正しい** reload 単位（訂正）

`import('./controller.ts?v=hash')` 単体は壊れる。controller の静的 import（`./executor.ts`, `./candidates.ts` ...）は世代 0 の URL に解決され、新しい controller が古い executor/candidates に配線される（stale graph）。正解は reload 層を **esbuild で 1 本のバンドルに固め、内容ハッシュ付きの新パスとして import する**:
```ts
await esbuild.build({
  entryPoints: ['src/host/generation-entry.ts'],
  bundle: true, format: 'esm', platform: 'node',
  packages: 'external',                       // mineflayer/pathfinder/prismarine を共有
  outfile: `data/resident/gen-${sha.slice(0,12)}.mjs`,
})
const mod = await import(pathToFileURL(outfile).href)  // 1 file == 1 URL == 原子的な世代交代
```
`packages:'external'` により `new Movements(bot)` が host の pathfinder plugin と同一クラスになる。esbuild は devDependency 固定（`buddy-driver/package.json` に `esbuild: 0.28.2`）。

### 6.7 プロセス/オーケストレーションの病理（Sol に共有したい）

- 長時間走る background agent session は **mid-turn で修正できない**（`promptAsync skipped by gate: active`）。そのため軌道修正がキューに積まれ、作業が停滞した後に届くことがある。委譲した 2 タスクが 6 分間成果物なしで cancel された。
- world reset のたびに server を落とすので、人間 `s0u7a` も落ち、最初からやり直しになった。
- `UNVERIFIED: これらはユーザー報告/セッション観測であり、対応するログパスを提示できない`。プロセスログとして残っていないため。ここは証拠を残す仕組み（resident 側の orchestration journal）が要る。

---

## 7. 進行中/次の一手（ロードマップ）

順序付き。各項に verification gate を付ける。

1. **Movement 修正（2-block 面）**。生成段階で `stepUpHeight > 1` を要求する移動候補を除外。遭遇時は迂回 (DETOUR) か階段化 (STEP) のみ。同一壁の反復ジャンプを `CLIMB_FAIL wallHeight=2 attempts=N` として wedge 扱いし、その面を候補から除外。ログ可視化は `CLIMB_ATTEMPT` / `CLIMB_FAIL` / `DETOUR` / `STAIRCUT`。
   - Gate: `m1-diag2` の `MOVE:b16_67_24` 型の hop ループが消える。同一シードで cobblestone 脚が前進。`logs/` に `CLIMB_FAIL` が出る。

2. **Craft-at-station 修正の着地**。`src/craftWindow.ts` の import/型を直す（`prismarine-windows` の `Window` は named export では無い、`prismarine-item` の default import が callable でない）。reachability を事前検証し、失敗時は wedge せず clean に fail する。
   - Gate: `npm run typecheck` clean、`audit-test` 9/9、`step-pipeline-test` 6/6 が再びロード・pass。`logs/m1-diag2` 相当の craft 成功を full ladder run で再現。

3. **Resident mode（host layer + reloadable generation）の成立**。固定 username `AI_Buddy` で 1 回接続し接続を保持。決定層を esbuild で 1 本の hash 付きファイルに固めて `import()`。
   - Gate: reload を 5 回行い (a) listener 数が基準値で一定、(b) inventory/queue/position が保持、(c) `bot.username` 不変、(d) 少なくとも 1 回は意図的 wedge → freeze → 修正 → reload → resume が成立。現状の `reloads:0` を 1 以上にし、`RELOAD ok=true`（`skipped=unchanged` 以外）を出す。

4. **Control channel**（`data/resident/control.sock` は実在、JSON-lines、`control/inbox.jsonl` fallback）: `goal / milestone / mode / report / reload / retry / freeze / resume / leakcheck / gc / quit`。
   - Gate: 1 プロセスで socket 経由の goal を連続 5 回注入し、再接続 0 回で全て完了報告。

5. **Freeze-instead-of-abort の介入ループ**。wedge → freeze + 全 context dump（`FreezeReport`: `buildWorldState` / `generateCandidates` / 直近 20 決定 / `queue.snapshot()` / 在庫 / 周辺ブロック / カウンタ / listener 数 / heap）→ コード patch → reload → resume（接続と位置を保持）。現状 `logs/resident/` は空で未 exercise。`controller.abortWedge()` が `finish('wedge',false)` でプロセス終了する実装を host 側で freeze に置き換える必要がある。
   - Gate: wedge を起こしてもプロセス生存、`bot.health` が読める、`logs/resident/freeze-<ts>.json` 生成。

6. **Persistent WorldMemory**（mined coords, discovered ores, **discovered crafting tables**, explored regions）。候補が既知 station を優先し、枯渇資源を避ける。世界リセット不要化。
   - Gate: M2 後に、spawn から再探索せず鉄を見つけられる。探索距離が減少。作業台の新規設置が 0〜1 個に収まる（現状 scan で 9 個見つかっている土台あり）。

7. **Runtime/bundler の決定**。**esbuild を既定（安定性優先）**。`Bun.build` と Bun runtime はゲート通過後のみ: (1) `bun run` で接続 + SPAWN（`bot.version==1.21.11`）、(2) movement patch 有効、（3）M1 regression 4/4（deterministic, wedge 0）、(4) テスト全緑を `bun test` で再現、(5) resident 検証を Bun 上で通す。
   - 記録: 現時点の採用は **Node + tsx + esbuild**（`buddy.log`: `runtime=node node=v25.9.0`）。Bun は未検証。

8. その後に capability ladder: M2（charcoal/iron）、iron gear、diamond、… M4。

---

## 8. Solへの論点（ここを軌道修正してほしい）

1. **reload 単位**: generation bundle の swap は正しい単位か。それとも reload 層を worker に置き message protocol で通信させる方が安全か（クラッシュ分離、state 境界の明確化、`mineflayer` を host に固定したまま generation だけ差し替える）。
2. **movement の修正場所**: `stepUpHeight > 1` の候補除外は十分か。それとも移動を「climb / stair-cut / detour」を第一級に持つ明示的な terrain graph として planner に組み込むべきか。今の hop ループは「候補生成の失敗」と「actuator の失敗」のどちらとして扱うのが正しいか。
3. **LLM gating policy のスコープ**: 何を System One に降ろし、何を LLM に escalate すべきか。現状の semantic escalation（`plan_still_valid` low, `goal_blocked` strong）は適切か。決定論モード固定で resident を進めるのは正しいか（Jev の価値が実質未使用のままになる懸念）。
4. **sequence**: capability（M2）と infrastructure（resident）をどう交互に進めるか。ユーザーは residence を強く優先している。M2 を凍結してでも resident を先に完成させるべきか、それとも M1 の再現性を gate にしてからか。
5. **verifiability**: session が mid-turn で修正できない環境で、どうやって進捗を検証可能にするか。達成条件を「ログの exact line + 再現コマンド」に固定する運用は妥当か。
6. **state store**: in-memory truth + atomic JSON mirror（SQLite 不採用）は正しいか。crash 中の durability と `bot` との drift 防止の観点で、どの consumer が store を書くべきか（host のみ、generation は read-only か）。
7. **single highest-leverage change**: 今この瞬間に 1 つだけ直すなら、typecheck を通して craft path を着地させることか、2-block movement か、それとも resident の smokeTest 契約か。

---

## 9. 証拠インデックス

| パス | 内容 |
|---|---|
| `/home/s0u7a/mc-ai/ARCHITECTURE.md` | 本ドキュメント（2026-09-18 00:03 JST 版） |
| `/home/s0u7a/mc-ai/RESIDENT-MODE.md` | 常駐化の正典要件（所有権、bundling 訂正、generation 契約、state store、制御チャネル、freeze/resume、検証、運用ノート） |
| `/home/s0u7a/mc-ai/MILESTONES.md` | M0〜M4 のマイルストーン台帳（559 行） |
| `/home/s0u7a/mc-ai/M2-PROGRESS.md` | M2 の全試行履歴（649 行） |
| `/home/s0u7a/mc-ai/jev-agent/src/` | 決定層 + motor + LLM の全実装（`craftWindow.ts` 含む 15 ファイル） |
| `/home/s0u7a/mc-ai/jev-agent/logs/m1-fresh2-console.log` | M1 PASS 4/4（fresh world, `llm.called==false 0/40`, verifiedDigs=22, wedge 0） |
| `/home/s0u7a/mc-ai/jev-agent/logs/m2-phase1e-console.log` | craft-at-station が gained 0 で wedge した full run（2/14, wedge 64546ms） |
| `/home/s0u7a/mc-ai/jev-agent/logs/m1-diag2-console.log` | craft 成功（subgoal COMPLETE）と、2-block 面 hop ループ wedge 67715ms の最新実測 |
| `/home/s0u7a/mc-ai/jev-agent/logs/probe-craft-diag2.log` | `AGENT-PATH result ... crafted 1x wooden_pickaxe gained=1` と window stateId の packet trace |
| `/home/s0u7a/mc-ai/jev-agent/logs/m2-phase1b-console.log` | `phase ledger restored` の実測 |
| `/home/s0u7a/mc-ai/jev-agent/data/seed-scan.mts`, `logs/seed-scan-2024.log` | seed 2024 の資源スキャン（oak 207+ standable、surface stone 枯渇） |
| `/home/s0u7a/mc-ai/jev-agent/data/step-pipeline-test.mts` | STEP/DESCEND guard の決定論テスト（history 6/6、現在ロード不能） |
| `/home/s0u7a/mc-ai/jev-agent/patches/mineflayer-4.39.0-locomotion.patch` | PR #4063 サブセットのローカル patch |
| `/home/s0u7a/mc-ai/jev-agent/scripts/apply-movement-patch.mjs` | postinstall 適用 + `--check`（実測 4/4 ok） |
| `/home/s0u7a/mc-ai/buddy-driver/agent-runner.mts` | 常駐 HOST（接続、reconnect、制御 socket、reload 調停、state mirror） |
| `/home/s0u7a/mc-ai/buddy-driver/generation-entry.ts` | RELOADABLE 層の入口（JevController + ladder planner） |
| `/home/s0u7a/mc-ai/buddy-driver/resident-types.ts` | HOST ↔ generation 契約（`CONTRACT_VERSION=1`） |
| `/home/s0u7a/mc-ai/buddy-driver/build.mts` | esbuild バンドラ |
| `/home/s0u7a/mc-ai/buddy-driver/buddy.log` | BOOT / BUILD / SPAWN / GENERATION_READY / RELOAD(ok=false) / SHUTDOWN |
| `/home/s0u7a/mc-ai/buddy-driver/runner.out` | generation の agent ログ（DESCEND dig_error, smoke 失敗の文脈） |
| `/home/s0u7a/mc-ai/buddy-driver/buddy-state.json` | durable mirror（`reloads:0`, `generations:2`, `worldMemory.craftingTables`） |
| `/home/s0u7a/mc-ai/buddy-driver/data/resident/control.sock` | mode 0600 の制御ソケット（実在） |
| `/home/s0u7a/mc-ai/buddy-driver/logs/jev/` | resident の `decisions.jsonl` / `jev-calls.jsonl` / `run.jsonl` |
| `/home/s0u7a/mc-ai/companion/buddy.log` | 簡易 buddy の追従ログ（`s0u7a` を 3 m まで接近後 3.5〜10.3 m で停滞） |
| `/home/s0u7a/mc-server/server.properties` | Leaf 設定（offline, peaceful, seed 2024, spawn-protection 0, view-distance 8） |
| `/home/s0u7a/mc-server/leaf-1.21.11-178.jar` | Leaf 本体（sha256 一致） |
| `/home/s0u7a/mc-server/world-depleted-20260917-223756/` | 枯渇 world の退避 backup（world / nether / end） |

---

## 10. 更新メタ

- timestamp: 2026-09-18 00:03 JST（`date` 実測は 2026-09-18 00:02:07 JST、その後 typecheck 再測定）
- author: Sisyphus-Junior（M2 セッションからの handoff。コードは変更していない。読み取りと検証のみ）
- 検証区分:
  - **VERIFIED（実測で確認）**: §3 の環境（jar sha256、Java 21.0.12.1、server.properties）、§5.1 M1 PASS の各数値、§5.6 craft diag 成功、§5.7 テスト現況、§6.1 のコンパイル/ロードエラー、§6.3 の hop ループと 2-block fail-fast、§6.5 の RELOAD ログ・`reloads:0`・`craftingTables=9`、§6.4 の join/PLACE 集計、movement patch check 4/4。
  - **UNVERIFIED**: (a) world 内 crafting_table の正確なブロック数（ブロックスキャン未実施）、(b) §6.7 の orchestration 病理（対応ログパス無し、ユーザー/セッション観測）、(c) Bun runtime の互換性（未検証）、(d) 敵モブ/戦闘系は peaceful のため未検証、(e) resident の freeze report 実生成（`logs/resident/` 空）。
  - **STALE CLAIM の訂正**: 「hot reload 未配達」は誤り（実装済み・atomic swap のみ未成立）、「テスト全緑」は現時点で誤り（typecheck と 2 テストが赤）、「56 crafting_table placement events」は「56 log files が文字列を含む」が正しい。

## AI_Buddy resident driver (added)

`buddy-driver/` runs the M2 intelligence as a **resident** agent: one long-lived
Mineflayer connection as `AI_Buddy`, with the reloadable layer bundled by
**esbuild** into one hash-stamped file and hot-swapped without reconnecting.
Runtime: **Node 25 native TypeScript stripping** (Bun not adopted — §0-A gates
not run; stability first). Bundler: **esbuild 0.28.2, pinned** (user decision).

- Host: `buddy-driver/agent-runner.mts` (bot, reconnect, logger, state mirror,
  control socket, reload arbiter).
- Reloadable: `buddy-driver/generation-entry.ts` + `jev-agent/src/**`.
- State: `buddy-driver/buddy-state.json` + `buddy-driver/buddy-ledger.json`.
- Logs: `buddy-driver/buddy.log`, `buddy-driver/logs/jev/*.jsonl`.
- Control: `buddy-driver/data/resident/control.sock` (0600) —
  `report|reload|freeze|resume|leakcheck|gc|goal|quit`.
- Deterministic policy (`forceFallbackPolicy=true`) → `llm.called === false`;
  System One remains the sole action authority. `canDig=false`, no teleports.

Full detail: `buddy-driver/ARCHITECTURE.md`.
