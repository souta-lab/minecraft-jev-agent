# RESIDENT MODE — 正典要件ファイル

> このファイルが「常駐化（resident + hot-reload）」の唯一の正典。
> 設計レビュー全文（Oracle, 8項目）: `/home/s0u7a/.local/share/opencode/tool-output/tool_0afd7bb91001IGYUxrqG6rKUNb`
> 実装者は必ず「設計レビュー全文」を読んでから着手すること。独自解釈で先走らない。

## 0-A. ランタイム/バンドラ方針（ユーザー指示: 基盤をBunにして高速化）

### 採用: Bunをランタイム・バンドラ・テスト基盤として使用
- **canonical runtime = Bun 1.4.2**。`bun run` でTSを直接実行し、別のTypeScript runnerへの依存を持たない。
  世代ごとのハッシュ付き新ファイル＋`import()` の運用は §2 のまま（原子的な世代交代は不変）。
  ```ts
  await Bun.build({ entrypoints:['generation-entry.ts'], format:'esm', target:'bun',
    packages:'external', sourcemap:'inline' })
  ```
- **canonical test/build commands = `bun test` / `Bun.build`**。Bunの子プロセスで既存のトップレベルfixtureも隔離実行し、fixtureの終了コードを検証する。

### 受け入れるリスクと検証ゲート（必須）
Bunの互換層で最大のリスクは **mineflayer / minecraft-protocol**（`net`・`zlib` gzip stream・`dns`・`crypto`）。
- 有利な事実: 本サーバーは **`online-mode=false`** のためプロトコルの暗号化ハンドシェイク（AES/CFB8）を通らない＝互換リスクの主要因が1つ消えている。
- **移行ゲート（live証拠が揃うまでUNKNOWNを維持）**:
  1. `bun run` で接続でき `SPAWN` する（`bot.version==1.21.11`）。
  2. **移動パッチが有効**（`patches/mineflayer-4.39.0-locomotion.patch` / `movement-patch:check` が ok。Bun でも `node_modules` へのパッチ適用は同じ。postinstall 実行可否を確認）。
  3. **M1 回帰 4/4**（`llm.called==false`、wedge 0）を同一の決定論モードで再現。
  4. テスト全緑を **`bun test`** で再現（typecheck / guard 12/12 / gating 6/6 / loop 7/7 / m1-test 5/5 / audit-test 9/9 / step-pipeline-test 6/6）。
  5. 常駐モードの検証（§9）を Bun 上で通す。
- 1〜3が落ちた場合はBun互換性の一次証拠をFAIL/UNKNOWNとして記録し、該当するBun境界だけを修正する。別ランタイムを暗黙に復活させない。
- 判断の記録: effective runtime/provider、build hash、resident generation、live gate結果をrun artifactに残す。

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

正解＝**リロード層を `Bun.build` で1本のバンドルに固め、内容ハッシュ付きの新パスとして import する**:
```ts
await Bun.build({
  entrypoints: ['generation-entry.ts'],
  format: 'esm', target: 'bun',
  packages: 'external',                       // mineflayer/pathfinder/prismarine を共有
  sourcemap: 'inline',
})
const mod = await import(pathToFileURL(outfile).href)  // 1ファイル=1URL=グラフが原子的に世代交代
```
- `packages:'external'` で `new Movements(bot)` がホストのpathfinderプラグインと同一クラスになる。
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

## 4. Generation 契約（現行・正典）

> この節が HOST ↔ generation 契約の正典。値・ライフサイクル・スワップ・拒否の観測性・移行手順は
> すべてここに従う。コードと文書の不一致は `bun tools/check-contract-docs.mjs` が FAIL で検出する
> （`bun run contract-docs-check` / `bun run contract-docs-test`）。

### 4-A. 契約バージョン（値の唯一の doc 正典）

```
CONTRACT_VERSION = 3
STATE_SCHEMA_VERSION = 3
```

- **code 正典**: `buddy-driver/resident-types.ts` の `export const CONTRACT_VERSION`（現行 **3**）。
- **同一値を持たなければならない code サイト**（`check-contract-docs.mjs` が全一致を検査）:
  - `buddy-driver/resident-types.ts`（契約定義・code 正典）
  - `buddy-driver/generation-entry.ts`（世代バンドルの export。structural smoke が `CONTRACT_VERSION === 3` を検査）
  - `buddy-driver/agent-runner.mts`（HOST。native TS stripping のため import せず、起動時に自分の定数として焼き込む）
- **STATE_SCHEMA_VERSION の code 正典**: `buddy-driver/state-snapshot.ts` の `AGENT_SNAPSHOT_SCHEMA_VERSION`
  （`agent-runner.mts` は `const STATE_SCHEMA_VERSION = AGENT_SNAPSHOT_SCHEMA_VERSION` で別名を持つ）。
- 他の文書（`ARCHITECTURE.md` / `buddy-driver/AGENTS.md` / root `AGENTS.md` など）は**この節を参照し、数値を再掲しない**。
  再掲は `check-contract-docs.mjs` の duplicate 検査で FAIL になる。

### 4-B. ライフサイクル（`resident-types.ts` の `ResidentGeneration`）

```
attach()            // listener 登録のみ。timer は開始しない。
start()             // スケジューリング開始。副作用の前に自世代の actuation lease を assert。
quiesce()           // timer / in-flight action を停止し ledger を persist。settle を有界待ち。
dispose()           // 同期 best-effort teardown。
status()            // GenerationStatus（contractVersion を含む。機械可読）
structuralSmoke()   // contract version / import 面 / 必須メソッド / snapshot schema /
                    // sensor 可読 / listener 数。空 plan・完了ゴール 0 で PASS しなければならない。
missionPreflight()  // goal 存在 / candidate 生成可能性。reload を gate しない。
stopReason() / hasStopped()
```

- 旧契約の `smokeTest(state)` / `resume()` / `snapshot()` は**現在のコードに存在しない**。
  これらを前提にした実装・文書は誤り（Issue #6 の drift はこれを指す）。
- HOST→generation の受け渡しは **DATA-ONLY**。`{x,y,z}` DTO（`Vec3Json`）のみで、Block / Entity /
  Vec3 / Window / Recipe / Bot インスタンスを永続化しない。必要箇所で `new Vec3(...)` により再水和する。

### 4-C. スワップ順序と commit 点（`buddy-driver/generation-swap.ts`）

```
build -> import -> createGeneration -> attach -> structuralSmoke
      -> missionPreflight -> 旧世代 quiesce
      -> ACTION LEASE SWITCH + snapshot generationId（単一 commit: commitOwner()）
      -> 新世代 start -> 旧世代 dispose
```

- commit 前に新世代は不可逆操作をできない。commit 点は `commitOwner()` が live 参照・lease・
  `AgentSnapshot.generationId` を同時に進める 1 箇所だけで、`getLive().id == lease.activeId == generationId` が保たれる。
- 新世代 `start()` 失敗時: `swapGeneration()` が **直前 module から新しい世代を構築**（`buildResume()`）して
  `attach -> structuralSmoke -> commitOwner -> start`。これを `RELOAD_ROLLBACK` として記録する。
  それも失敗したら **fail-closed**（`ROLLBACK_FAIL_CLOSED`、`generationId=null`、lease revoke）。
- 旧世代オブジェクトを `resume()` する経路は無い。ロールバックは常に「fresh generation from previous module」。
- state ownership: 永続ファイルの唯一の writer は **HOST**。generation は mutation proposal / snapshot を返す。
  `{ schemaVersion, revision, worldEpoch, generationId }` を単一の原子的スナップショットで整合させる。
- WorldMemory は **server identity + dimension + worldEpoch** で名前空間化する。
- SERVER TRUTH（position / health / inventory / entities / open window）は reload・reconnect 後に
  sensor から再観測し、JSON から復元しない。

### 4-D. Reload 拒否は必ず観測可能（silent 禁止）

契約バージョン不一致は `agent-runner.mts` の 2 か所で検出され、必ず次の 3 行が出る（`performReload` 経路）:

```
ERROR where=performReload trigger=<t> message=CONTRACT_VERSION mismatch: generation=<g> host=<h>
RELOAD_REJECTED trigger=<t> message=CONTRACT_VERSION mismatch: generation=<g> host=<h> action=keep-previous-generation
RELOAD ok=false trigger=<t> ms=<n> message=CONTRACT_VERSION mismatch: generation=<g> host=<h>
```

- 起動時（`loadGenerationModule`）も `ERROR where=loadGenerationModule` に同じ `generation=<g> host=<h>` を出す。
- 旧世代は稼働継続（ゼロダウンタイム）。**mismatch が silent に処理される経路は 0**。
- 稼働中ホストの値は機械可読に取得できる: control socket の `report` / `status` が `contractVersion` を返し、
  `BOOT` 行・`acceptance-<runId>.json`・`generation.status()` にも `contractVersion` が入る。
- 実障害例（2026-09-18 10:13 JST）:
  `RELOAD ok=false trigger=source-changed ms=63 message=CONTRACT_VERSION mismatch: generation=3 host=2`
  → 値は観測可能だったが、文書が追随していなかったため「なぜ reload が拒否され続けるか」が説明できなかった（Issue #6）。

### 4-E. 移行手順（CONTRACT_VERSION を変更するとき）

1. `buddy-driver/resident-types.ts` の `CONTRACT_VERSION` を上げる／下げる（code 正典）。
   同時に `buddy-driver/generation-entry.ts` と `buddy-driver/agent-runner.mts` のコピーを同じ値へ更新する
   （guard が 3 サイトの一致を強制）。
2. 本節 **4-A の `CONTRACT_VERSION = <n>`** を同じ値へ更新し、`STATE_SCHEMA_VERSION` も必要なら更新する。
3. 破壊的な snapshot 変更を伴うなら `state-snapshot.ts` の `AGENT_SNAPSHOT_SCHEMA_VERSION` と
   migration/reject 経路も更新する。互換変更なら上げない。
4. **HOST を再起動する（必須。hot reload では解消しない）。** 稼働中 HOST は起動時の `CONTRACT_VERSION` を
   自分の定数として持ち、世代バンドルの export と比較する。つまり新しい契約は reload では採用できず、
   不一致の間は `RELOAD ok=false` が繰り返されるだけ。手順:
   `kill <pid>`（`pkill -f` は自爆するので禁止）→ `data/resident/host.lock` が解放されたことを確認 →
   `cd buddy-driver && setsid nohup bun agent-runner.mts </dev/null > runner.out 2>&1 &`
5. **検証**: 新規ブートで `BOOT ... contractVersion=<n>` が出る、または `RELOAD ok=true`（hash 変化）が出る。
   そして `CONTRACT_VERSION mismatch` 行が 0 件であること。`bun tools/buddy-status.mjs --json` の report で
   `contractVersion == <n>` を確認する。
6. **guard を通す**: `bun run contract-docs-check` と `bun run contract-docs-test` を緑にする。
   片方でも赤なら移行未完了として扱う。


### 4-F. durable commit / quarantine / lock / fatal（P0 durability invariants）

HOST の durable claim は「失敗を表現できる」ことで初めて成立する。code 正典は
`buddy-driver/host-durability.ts`（marker 名もそこが定義）。数値は §4-A のみが持つ。

```text
STATE_WRITE_FAILED       durable write が landed しなかった。revision は進めず、in-memory の
                         commit marker を disk に合わせて roll back し、半端な tmp を削除して報告する。
                         `PROPOSALS_COMMITTED` の writes は landed した write だけを数える
                         （writeOk / writeError が実態を示す）。
STATE_QUARANTINED        unparseable JSON / 対応より新しい schemaVersion / 不正な state file を
                         `state-quarantine-<reason>-<stamp>-p<pid>.json` へ移動し、理由と foundVersion を記録。
                         memory は default で継続するが、退避した bytes は変更しない。
STATE_QUARANTINE_FAILED  退避自体に失敗。**boot を拒否する**（defaults で黙って上書きしない）。
                         `BOOT_REFUSED reason=state-unreadable-and-not-quarantinable` で exit 1。
HOST_LOCK_RECLAIMED      pid が死んでいると証明できた lock だけを、atomic take-away → 再検証 →
                         exclusive create (`wx`) の順で回収する。
HOST_LOCK_LOST           生きた holder、または pid を解析できない非空 lock file を検出。
                         後者は stale と証明できないため回収しない（fail closed）。
FATAL_SHUTDOWN           uncaughtException / unhandledRejection は log だけで終わらせない。
                         actuation lease を revoke してから non-zero exit する。
```

- boot の `saveState('boot')` は **host lock 取得後**にのみ実行する。lock を失った resident は
  自分が読み込んだ snapshot を一切書かない。
- graceful shutdown は **control server を close（await, bounded）してから** host.lock を release する。
  socket が受理可能なまま次 resident が boot することはない。
- 上記 marker は `buddy.log` と同時に、run-scoped な `acceptance-<runId>.json` の `durability`
  および control socket の `report` / `status` 応答 `durability` に mirror される
  （counts + その run で観測した marker 名）。acceptance record が示せない durability 主張はしない。
- これらの経路は HOST プロセスの lifecycle に属するため、**修正の反映には HOST 再起動が必要**
  （hot reload では変わらない）。fixture は `buddy-driver/test-host-durability.mts`。

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
- コマンド（`agent-runner.mts` のハンドラに実装されている実集合）:
  - 照会のみ: `report` / `status`（同義、全 state を返す） / `goal` / `milestone`
  - 照会のみ（ただし副作用あり）: `acceptance` は `writeAcceptance()` を呼び、run-scoped な
    `data/resident/acceptance-<runId>.json` を更新してから path を返す（run 状態・lease・generation は変えない）。
    この record は boot では書かれず、reload commit / `freeze` / `resume` / `reground` / この query / 正常 shutdown で書かれる
  - 実行: `reload` / `freeze` / `resume` / `gc` / `leakcheck` / `simdeath`（既定 soft。`simdeath --hard` または `{hard:true}` で破壊的）
  - 破壊的（使わない）: `worldreset`（worldEpoch が変わる。active generation を quiesce/dispose し、ledger を archive して新しい memory namespace で fresh generation を開始する operator assertion） / `quit`
  - 注意: `goal` / `milestone` は値を返すだけで注入できない。未実装の `mode` / `retry` は**コマンドではない**（mode 切替はフルリロードで行う）
- `report` / `status` の応答には `contractVersion`（稼働中 HOST の値）と `status.contractVersion`（世代の値）が入る（§4-D）。
  同じ応答の `durability` が §4-F の run-scoped marker counts（`markers` は観測した marker 名）を返す。
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
2. Generation 契約＋Bun.build バンドルによるホットリロード。ホストがbotを保持したまま世代交代。（Medium）
   検証: 5回リロードで listener数一定・在庫/queue 保持・`bot.username` 不変。
3. 制御チャネル（Unixソケット＋inboxフォールバック）。（Medium）
   検証: 1プロセスでソケット経由の目標を連続5回注入、再接続0回で全て完了報告。
4. WorldMemory（枯渇モデル＋作業台の既存探索）を `generateCandidates` に接続。（Medium/Large）
   検証: M2後に鉄を**spawnから再探索せず**見つけられる。探索距離が減少。作業台の新規設置が0〜1個に収まる。
  5. 再接続・再装着＋リーク/GCソーク。（Medium）
   検証: 走行中にサーバーを落として再起動 → 同一ユーザー名で再参加し、キュー/在庫が保持される。

---

## 12. 運用ノート（実測で踏んだ罠 — 常駐化でも必ず再発する）
- **デタッチ起動**: `cd <dir> && setsid nohup bun x.cjs </dev/null > x.log 2>&1 &`
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

---

## 13-0. 優先順位（2026-09-18 外部レビュー改訂 — §13 を SUPERSEDE）

> この節は §13（LLM誘導プランナを先に）を **supersede** する。LLM プランナ（Jev shadow → authority）は **P5**。それまでは決定論フォールバックを維持し、常駐の原子性を先に証明する。上位段の gate を満たすまで次に進まない。
>
> **正典順位（root `AGENTS.md` §0.7 / `DEVELOPMENT-METHOD.md` §1.1）**: 本文書は design/evidence document であり、root `AGENTS.md` を supersede しない。この「SUPERSEDE §13」は同一ファイル内の §13 を置き換える意味に限る。ここでの P0-P6 が root `AGENTS.md` §2 の現行優先順（P0 = #63 methodology/evidence integrity → P1 safety/durability → #11 Grounded Options skeleton → shadow/eval → …）と衝突する場合は root `AGENTS.md` §2 を優先する。

- **P0（gate）: ビルドを緑に戻す。** `typecheck` clean / `audit-test` 9/9 / `step-pipeline-test` 6/6 / `guard-test` 12/12 / `gating-test` 6/6 / `loop-test` 7/7 / `m1-test` 5/5 / `movement-patch:check` ok。緑でない限り、他の検証は意味を持たない。
- **P1: 常駐 generation swap を原子的にする。**
  - HOST→generation 契約は **DATA-ONLY**。`{x,y,z}` DTO だけを永続化し、Block / Entity / Vec3 / Window / Recipe / Bot インスタンスを一切保存しない。必要な箇所で `new Vec3(...)` により再水和する。
  - **structural smoke と mission preflight を分離**。structural smoke（contract version / import / 必須メソッド / snapshot schema / sensor 可読 / listener 数）は **空 plan・完了ゴール 0 で PASS** しなければならない。hot reload は goal の有無に依存しない。
  - **ACTUATION LEASE**: HOST が `activeGenerationId` を所有し、executor は副作用のある bot 呼び出しの直前に lease を assert する。swap 順は `build → import → structural smoke → prepare(new) → old quiesce → snapshot → new attach → new healthcheck → ACTION LEASE SWITCH（commit 点）→ old dispose`。commit 前に新世代は不可逆操作をできない。rollback は lease を旧世代へ戻して resume する。
  - **state ownership**: 永続ファイルの唯一の writer は HOST。generation は mutation proposal / snapshot を返し、HOST が commit する。`{ schemaVersion, revision, worldEpoch, generationId }` を保持し、独立ファイルより単一の原子的スナップショットを優先する。
  - **WorldMemory の名前空間**: mined / discovered ores / crafting tables / explored regions を **server identity + dimension + worldEpoch** で名前空間化する。同一 seed の世界リセットでも別世界であり、古い座標を漏らしてはならない。
  - **SERVER TRUTH と DURABLE SEMANTIC STATE の分離**: position / health / inventory / entities / open window は SERVER TRUTH。reload / reconnect 後は sensor から再観測し、JSON から復元しない。durable 側は完了サブゴール / 既知 station 座標 / 枯渇地点 / 探索済み領域 / 既知鉱石 / 失敗記憶 / 高レベル plan。
  - **検証証拠**: 最低 5 回の実リロード（`RELOAD ok=true` かつ hash 変化。`skipped=unchanged` は数えない）、reconnect 0、reload 間で listener 数が安定、さらに freeze → context dump → reload → resume を 1 サイクル。run ごとに machine-readable な acceptance record（runId, gitCommit/generationHash, dependency versions, worldEpoch, seed, bot username, start position, mode, goalComplete/wedge/reconnects/reloads/listenerLeak）を出す。
- **P2: freeze → dump → reload → resume を 1 回通す。**（P1 の検証に含めてよい）
- **P3: M1 を常駐の golden regression にする**（world reset なし・reconnect なし）。
- **P4: 2-block movement fixture。** terrain graph や大きな movement subsystem を作らない。薄い `TraversalFailure` 記憶（obstacleSignature, from, toward, wallHeight, failureKind, attempts, lastSeenAt）と順序 `stock pathfinder detour → resource policy が許せば STEP/stair-cut → candidate を抑制して replan` のみ。同じ面で hop-hop-hop を繰り返さない。
- **P5: Jev を shadow モードで入れてから authority。** 決定論フォールバックは常駐が証明されるまで維持。
- **P6: M2 ラダーを再開。**

やらないこと: terrain graph を作らない / Mineflayer movement patch を拡張しない（現行 2-change subset、upstream PR #4063 は open のまま）/ Jev を複雑化しない / `need_llm` を制御信号として復活させない / LLM planning を今は足さない / 大規模 refactor・`any`・`@ts-ignore`・commit・server restart をしない。

### craft 根本原因の来歴（訂正）
`mineflayer@4.39.0` の 3x3 クラフトが**エラーも item も出さずに無言で失敗する**現象について、来歴を分離する:
- **upstream `PrismarineJS/mineflayer#3906`** は「同種/類似の silent 3x3 crafting failure」として参照する（上流の報告）。
- **stale `stateId`** という機序は **本プロジェクトのローカル診断**であり、1.21.11 の packet trace（`jev-agent/logs/probe-craft-diag2.log`）から導いたもの。upstream の説明として帰属させない。

---

## 13. LLM誘導プランナ（M2→M4 の自走方針）

### 方針（ユーザー認識）
低レベル（採掘・クラフト・製錬・移動）は概ね回るようになった。残る律速は**上位の方向づけ**である。
「作業台が作れるようになった後は、上位LLMが次の方向性を誘導するだけでよく、M2が通りLLMが正しく誘導できれば**無指示でM4まで素直に行ける**」というのがユーザーの読み。実装はこれを満たすように組む。

### 現状の欠落
常駐モードは `forceFallbackPolicy=true`（決定論のみ）で動いており、**戦略を決める主体が存在しない**。
そのため「鉄鉱石をどう探すか」のような方針依存の局面で前進が止まる（例: `rung=raw_iron` で探索が停滞）。

### 設計
1. **プランナは buddy-driver 側に置く**（`planner.ts` → `generation-entry.ts` に配線）。jev-agent は読み取り専用のままimportする。
2. **LLMに返させるのは有界な計画データのみ**（ゴール一覧・選択・スコア）。**行動権限は System One のまま**（不変条件を維持）。
3. **質問は有界**にする（自由会話にしない）。既存の Jev 経路 `experimental_evaluate({model,state,questions})` を再利用し、state は在庫・位置・次元・達成済みマイルストーン・既知の作業台/資源・直近の失敗に限定した圧縮サマリにする。
4. **決定論ラダーはフォールバック**として常備。LLM失敗・レート制限時は即座に切替え、`PLAN source=fallback` を記録（エージェントを止めない）。
5. **キャッシュ**: 状態ハッシュでプランをキャッシュし、同一状態の重複呼び出しを排除（レート制限対策）。コスト目標 <$0.001/plan（既存実測 ~$0.00018/call）。
6. **再計画の契機**: キューが空／ゴールが不可能と判定／スタック検出（頻度は上限つき）。
7. **ゴールテンプレートをM4まで用意**: 鉄装備→ダイヤ→ダイヤツルハシ→ネザーポータル＋火打石→ネザー移動→ブレイズロッド→エンダーパール→エンダーアイ→要塞→ジ・エンド→ドラゴン討伐。現行 executor で実行可能なものから段階的に対応し、未対応は future として明示。
8. **ログ**: `PLAN source=llm|fallback goals=[...] cost=<usd> ms=<n> reason=<queue_empty|impossible|stuck|start>` と `MILESTONE name=... done=...`。
9. **決定論モードの保証**: LLM無効時は `llm.called==false` を維持（既存の不変条件）。

### 検証（これが出たら達成）
```
1) PLAN source=llm がゴール一覧つきで出て、その後の ACTION/MILESTONE がその計画に一致して進む
2) LLM無効時は PLAN source=fallback で走行が継続（llm.called==false）
3) ソース変更 → RELOAD ok=true ms=<2s>、再接続なしで新プランナが有効
4) プラン単価が実測で記録され妥当（目標 <$0.001）
5) ハートビートが継続し、在庫が増え続ける（前進している）
```

---

## 14. ★本命設計: Grounded Options（Jev = π + β）— Issue #11（#10を置換）

ユーザー判断: **これを将来の正式設計とする**（#10の5値controlヘッドは破棄）。

### 役割分担
```
LLM / Mercury = Option（意図）の生成・修復。数十秒〜数分のスパン
Jev           = ① π(a|s,o): 接地済み候補ID上の action Choice
                ② β(s,o)  : その Option を abandon すべきかの Boolean 確率
Code          = 安全性・物理的真実・成功/完了述語（モデルに権威を持たせない）
Mineflayer    = メカニクスの実行と、検証済みの世界遷移の生成
```

### Jevコアは2つだけ
```
1. action        : Choice（接地済み候補IDの集合から1つ）
2. abandon_option: Boolean（確率）
＋ トリガ特化の補助診断（danger / should_retreat 等）は必要な時だけ追加
```

### なぜ5値controlより良いか
```
・recover は「Option内の行動戦略」であり計画状態ではない
・subgoal_done / goal_done は決定論的述語であるべき（モデル権威にしない）
・replan は自然には「終了/放棄」の決定である
・カテゴリ選択は、Booleanが既に与える連続確率を捨ててしまう
→ ACTION = このOption内で何をするか / TERMINATION = このOptionを止めてSystem2に新しいOptionを求めるか
```

### Options階層への対応
```
Option o: 事前条件 I(o) / intra-option policy π(a|s,o) / termination β(s,o) / 成功述語 success(s,o)
Mercury or 決定論プランナ → Option（意図） → 事前条件＋成功述語（コード）
   → Jev Choice(action)=π ／ Jev Boolean(abandon)=β → Guard → Executor → VERIFY
※RL訓練は不要（アーキテクチャ分解として導入する）
```

### 例
```
Option: collect 3 x raw_iron
状態: 石ツルハシ有り / 鉄は見えていない / 近くに既知の洞窟 / branch-mine候補が存在
→ Jev: action=BRANCH_MINE:N, abandon_option=0.08  ⇒ 同じOptionを継続
後刻: action=RETURN_TO_KNOWN_ORE:o17, abandon_option=0.17
```

### 実装上の含意（将来）
```
・事前条件 I(o) と成功述語 success(s,o) はコードで判定し、満たさなければOptionを開始しない/完了とする
・abandon_option が閾値を超えたら System2（Mercury or 決定論）へ再計画を要求（=βの発火）
・action は従来どおり接地済み候補IDのみ（自由文の行動生成は禁止）、Guardで実行直前に再検証
・補助診断（danger等）はトリガ条件付きでのみ質問に含める（トークン/コスト削減）
・決定論モードでは π を決定論ポリシー、β を決定論述語にフォールバック（llm.called==false を維持）
```
