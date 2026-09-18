# AGENTS.md — このディレクトリで作業するエージェントへの最優先指示

> あなたが `buddy-driver/` で作業するなら、**作業前にこのファイルを最後まで読むこと**。
> 詳細仕様: `/home/s0u7a/mc-ai/RESIDENT-MODE.md`（正典）／欠陥票: `/home/s0u7a/mc-ai/BUDDY-DEFECTS.md`／現状: `/home/s0u7a/mc-ai/ARCHITECTURE.md`

## 優先順位（外部レビュー Sol 準拠。これを勝手に並べ替えない）

> スコープ注記: このファイルは root `/home/s0u7a/mc-ai/AGENTS.md` を継承する **nearest scoped
> AGENTS.md** であり、root を supersede しない。root `AGENTS.md` §0.7 の正典順位（human 明示指示 >
> root AGENTS.md > nearest scoped AGENTS.md > TODO/operational queue > design/evidence docs >
> historical）に従う。下の P0-P6 と root `AGENTS.md` §2 が衝突する場合は root を優先する
> （`DEVELOPMENT-METHOD.md` §1.1）。
```
P0 green build へ戻す（typecheck clean / audit 9/9 / step-pipeline 6/6 / guard 12/12 / gating 6/6 / loop 7/7 / m1 5/5）
P1 resident の原子的スワップ
   data-only契約（Vec3DTO。class instanceを永続化しない）
   structural smoke は「空plan」で合格（mission preflight と分離）
   actuation lease（HOSTが activeGenerationId 所有、副作用直前に assert、LEASE SWITCH が commit点）
   HOST が唯一の writer／schemaVersion・revision・worldEpoch・generationId の整合
   WorldMemory は worldEpoch で namespace（同一seedでもリセット後は別世界）
   実リロード5回以上＋listener数・タイマー数が増えない
P2 freeze → 文脈ダンプ → reload → resume を1周
P3 M1 を resident の golden regression として完走（world reset なし・再接続なし）
P4 2ブロック移動ループを fixture 化して修正（1-block の upstream 問題とは別テスト）
P5 Jev を shadow → 権限移譲（planner.ts の配線はここ。P1では決定論フォールバックで走らせる）
P6 M2 ラダー再開
```

## 現在の最優先ブロッカー（00:35 実測・ホスト再起動後に発生）
```
BOOT pid=165685 runtime=node node=v25.9.0 bundle=none milestone=raw_iron generations=39 reloads=14
BUILD hash=4babbfa827e4 bytes=1125877 ms=35
CONNECT → SPAWN pos=16.5,65.0,25.5 version=1.21.11
CRAFT_COMPAT ok=true mineflayerTested=4.39.0 api=_syncWindow
ERROR where=unhandledRejection message=Cannot read properties of undefined (reading 'craftingTables')
→ GENERATION_READY が出ず世代が起動しない（Buddyは生存しているが WAIT で停止）
```
原因箇所:
```
generation-entry.ts:228  ctx.worldMemory.craftingTables      ← undefined
generation-entry.ts:203/245/254/263/338  world.craftingTables
planner.ts:136/669       w.craftingTables / this.world.craftingTables
```
修正要件:
```
1) worldMemory[worldEpoch] ??= { craftingTables: [], furnaces: [], mined: {}, ores: {}, explored: [] }
2) const world = ctx.worldMemory ?? { craftingTables: [], furnaces: [], mined: {}, ores: {}, explored: [] }
3) .length 参照前に空配列へ正規化（228 / 263 / 338 / 669）
4) 受け入れ: 起動ログに GENERATION_READY → ACTION / HEARTBEAT が継続
```

## もう一つの P1 欠陥: 再起動で状態がリセットされる
```
再起動前 done=9, depth=12  →  再起動後 done=0, depth=2
```
台帳（ledger）からの復元が効いていない。起動時に durable state から `done` を復元し、前後で維持されることを実測すること。

## 不変条件（破らない）
- System One が唯一の行動権限。LLM は有界な計画データのみ。
- 決定論モードで `llm.called==false` を維持。
- `canDig=false`／テレポート禁止／サーバー再起動禁止／コミット禁止／`any`・`@ts-ignore` 禁止／APIキー出力禁止。
- stock Mineflayer 優先。movement patch は現行2変更の subset を維持（PR #4063 全体は取り込まない）。
- 既存の作業台（世界に約20個）はスキャンして再利用。新規設置は皆無時のみ、撤去しない。

## 運用
- デタッチ起動: `cd /home/s0u7a/mc-ai/buddy-driver && setsid nohup node agent-runner.mts </dev/null > runner.out 2>&1 &`
- `pkill -f` は自分のコマンドラインにもマッチしてシェルごと死ぬ。停止は pid 指定で行う。
- 変更したら **ホットリロードで反映**（`RELOAD ok=true` を確認）。CONTRACT_VERSION 不一致時はホスト再起動で解消。

---

## 追記（00:39 実測）— P1の残り2点

```
15:36:56 ERROR unhandledRejection ... Cannot read properties of undefined (reading 'craftingTables')   ← まだ間欠で出る
15:37:25 GENERATION_READY rungIndex=4 rungId=furnace goals=["craft 1 x furnace","place 1 x fur...]
15:39:15 GENERATION_READY rungIndex=7 rungId=raw_iron goals=["collect 3 x raw_iron","smelt 3 x ...]
15:38:57 HEARTBEAT pos=17.8,65.0,26.7 running=true rung=furnace queue="craft 1 x furnace" depth=2 done=0 action=MOVE
```

### 残り1: craftingTables 例外の完全な解消
世代は起動するようになったが、起動時に `craftingTables` の undefined 例外が**間欠で残存**。
`worldMemory[worldEpoch]` の初期化を、参照より前の**単一箇所**（HOSTの state load 直後）に集約して二度と出ないようにする。
受け入れ: 再起動を5回行い、`unhandledRejection` が0件であること。

### 残り2: state ownership の完成（P1の中核）
観測: `done=0` のままで、rung が **furnace ↔ raw_iron を揺れる**。同名UUIDなので在庫は保持されているはずで、
「炉をまた作る」判定になっているのは **設置済み炉の位置（WorldMemory）と台帳が復元されていない**ため。
要件:
1. 起動時に durable state から `done` を復元（前後で維持。例: 再起動前 done=9 → 再起動後 done>=9）
2. WorldMemory から**設置済み炉・作業台の座標**を復元し、既存の炉を作り直さない
3. `schemaVersion / revision / worldEpoch / generationId` を1つの atomic snapshot で整合させる（HOSTが唯一のwriter）
4. server truth（位置・体力・在庫）は復元せず sensor から再観測する（現状は正しくそうなっている）
受け入れ: 再起動後も `rung` が後退しない（raw_iron のまま）／`done` が維持される／炉の再クラフトが発生しない。

---

## 追記2（00:42 実測）— WAITループの禁止と「鉄を探す」候補

```
HEARTBEAT pos=16.5,65.0,25.5 health=20 running=true rung=raw_iron queue="collect 3 x raw_iron" depth=1 done=0 action=WAIT
在庫: charcoal:1 / stone_pickaxe:1   ← 再接続をまたいで保持（server truth の再観測は正しい）
ACTION n=276 id=WAIT kind=WAIT phase=waiting 300ms
ACTION n=277 id=WAIT kind=WAIT phase=waiting 300ms
→ 世代は起動するが生産的候補が無く即WAIT → generation-stopped → recovery → またWAIT の循環
```

診断: `collect 3 x raw_iron` に対し、**候補生成が「鉄鉱石を見つける手段」を出せていない**（スキャン半径内に鉄鉱石が無く、探索系の行動が候補に無い）。

修正要件:
1. **WAITで無限ループしない**: 生産的候補が0のときは WAIT を返さず戦略変更を発火する
   `NO_PRODUCTIVE_CANDIDATE -> strategy=explore` を必ずログ。
2. **「鉄を探す」候補を追加**（資源クラス=探索）:
   露出鉄鉱石の探索／洞窟探索／**Y=-59帯への計画的降下＋ブランチ掘り**／既知の掘削跡の再利用。
3. **同一目標で N 回 WAIT したら wedge 扱い**で目標を差し替える（WAITループの禁止。`WAIT_LIMIT n=3 -> replan`）。
4. 可視化: `EXPLORE kind=cave|descend|branch target=iron_ore depth=<n>` / `WAIT_LIMIT`。
受け入れ: WAITの連続が3回を超えない／鉄鉱石探索の行動（EXPLORE系）が ACTION ログに出る／`raw_iron` が在庫に出現する。

---

## P1.5（ユーザー指示・最優先で入れる）— 「次の一手」は上位LLMに決めさせる

方針: 停滞（生産的候補が無い／WAIT上限／同一目標で進捗ゼロ）を検知したら、**上位LLMに次の一手を指示させる**。
決定論ラダーはフォールバックとして残す（LLMが使えない時は従来どおり前進）。

### 設計（不変条件を壊さない）
1. **LLMに返させるのは「次の一手の指示」だけ**: 目標（例: `descend_to_y16` / `explore_cave` / `branch_mine` / `return_to_known_ore` / `smelt_and_craft`）と短い理由。**行動は返させない。行動権限は System One のまま。**
2. **質問は有界**: 現行の `experimental_evaluate({model,state,questions})` に `choice` 質問を1つ足す形が最も整合的（question=`next_strategy`、選択肢=上記列挙、`model='typesafe-ai/jev'`）。
   ※Mercury 2.5 は Gateway で `type: language` のため `experimental_evaluate` には使えない（type=evaluation は `typesafe-ai/jev` のみ）。
     文章で計画を書かせたい場合は `generateObject`/`Output.object` で `inception/mercury-2.5` を使う別経路（Gateway経由の構造化出力は未検証。直叩き or OpenRouter が確実）。
3. **状態サマリは圧縮**: 在庫（主要資源のみ）・位置・次元・達成済みマイルストーン・既知の作業台/炉/鉱石・直近の失敗（TraversalFailure/WAIT回数）。
4. **キャッシュ**: 状態ハッシュでキャッシュし重複呼び出しを排除（レート制限対策）。コスト目標 <$0.001/回。
5. **フォールバック**: LLM失敗・レート制限・無効時は決定論ラダーで即続行（エージェントを止めない）。
6. **決定論モードの保証**: LLM無効時は `llm.called==false` を維持。
7. **ログ必須**: `ADVISOR source=llm|fallback reason=wait_limit|no_candidate|no_progress strategy=<選んだ一手> cost=<usd> ms=<n>` と `STRATEGY_SET strategy=... goals=[...]`。
8. **再計画の契機**: ①生産的候補0 ②WAIT 3回 ③同一目標で進捗0が一定時間 ④ゴールが不可能判定。

### 受け入れ基準
```
1) WAITループ中に ADVISOR source=llm が出て、strategy が選ばれ、STRATEGY_SET で目標が差し替わる
2) 差し替え後の ACTION がその戦略に沿う（例: strategy=descend_to_y16 → DESCEND/EXPLORE系がログに出る）
3) LLM無効時は ADVISOR source=fallback で走行継続（llm.called==false）
4) コスト実測が記録される（<$0.001/回）
5) WAITの連続が3回を超えない
```

---

## 追記3（00:50 実測）— 死亡→リスポーン後の復帰が未実装（現在の律速）

```
SPAWN pos=16.5,65.0,25.5 username=AI_Buddy worldEpoch=1        ← 名前/UUIDは不変
最新 HEARTBEAT: pos=1.5,75.0,-5.4 inv={}                       ← ワールドスポーン付近で在庫ゼロ
GENERATION_STOP stopped=wedge success=false ticks=25 verifiedDigs=0 subgoalsDone=0
RECOVERY reason=generation-stopped stopped=wedge（約15秒ごとに反復）
```
診断: **死亡してリスポーンし在庫を失った**（木炭/石ツルハシが消えた）。ただしログに `DEATH` 行が無く、死亡検知が未実装。
その後 queue が `collect 3 x raw_iron` のまま（在庫は空＝ツルハシ無し）で原理的に不可能 → 世代が25tickで wedge → 回復 → 同じ目標 → wedge のループ。

修正要件:
1. **死亡検知と記録**: `bot.on('death')` で `DEATH pos=<x,y,z> dimension=<dim> lostInventory=<要約>` を必ずログ。
   死因（落下/溶岩/窒息/奈落）を可能な範囲で推定して記録し、その座標を WorldMemory の hazard に登録。
2. **リスポーン後のラダー再計算**: 在庫が空なら必ず `wood → table → wooden_pickaxe → cobblestone → …` から再開。
   永続マイルストーン（iron段）を優先して**前提を満たさない目標を出さない**（`LADDER_RESET reason=death invEmpty=true` をログ）。
3. **wedgeループの禁止**: 目標の前提（必要ツール/材料）が在庫に無い場合は wedge にせず**ラダーをリセット**する
   （`PRECONDITION_MISSING goal=collect_raw_iron need=stone_pickaxe -> LADDER_RESET`）。
4. **死亡回避**: `DESCEND`（直下掘り）に hazard チェックを入れる。溶岩・水・奈落・窒息の可能性がある場合は掘らず迂回/階段掘り。
   同一地点での死亡が2回発生したらその座標を恒久 hazard として候補から除外。

受け入れ:
```
・DEATH 行がログに出る（座標・次元・失った在庫の要約つき）
・死亡→リスポーン後に LADDER_RESET が出て、wood段から再開する（不可能な raw_iron を出さない）
・同一座標での死亡が2回を超えない（hazard登録が効いている）
・wedge の反復（15秒ごとの generation-stopped=wedge）が解消する
```

### 追記3-補足（00:52 判明）— 死因はプレイヤーによる kill
```
ユーザー本人が Buddy を kill した（地形ハザードではない）。
→ 直下掘りの hazard 回避だけでは説明できない。死因判定を「攻撃者」まで見る必要がある。
```
追加要件:
1. **攻撃者の記録**: `entityHurt` 等から直近の攻撃元を保持し、死亡時に `DEATH cause=player:<username>` を出す。
   地形要因（落下/溶岩/窒息）と区別して `cause=fall|lava|suffocation|player:<name>|unknown` を必ず分類。
2. **hazard 登録の誤適用を防ぐ**: プレイヤーkill の座標を恒久 hazard にしない（地形要因のときだけ登録）。
3. **リスポーン復帰は死因に依存しない**: どの死因でも `LADDER_RESET` で在庫から再計算（今回は在庫ゼロ→wood段から）。
4. **将来オプション（今は実装しない）**: 敵対プレイヤーからの逃走/回避ポリシー。研究目的では「kill されても復帰して前進し続ける」ことが優先。
5. 受け入れ（更新）:
```
・DEATH cause=player:<name> がログに出る（地形死と区別される）
・kill→リスポーン後に LADDER_RESET → wood段から再開し、wedge反復に入らない
・同じ座標が恒久hazardに誤登録されない
```

---

## 追記4（01:01 実測）— 単一インスタンス強制（「消える」の構造的防止）

```
症状: Buddy が「入っては消える」を繰り返す
原因: 同名 AI_Buddy のホストが多重起動し、Javaが同名ログインを拒否して相互キック
      実測: buddy.log に kicked|duplicate_login が 56件
      （ホットリロードの世代差し替えは再接続を伴わない。無関係）
現在: node agent-runner.mts は 1プロセスのみ（pid 177324）。CONNECT 16:01:03 → HEARTBEAT 16:01:51
```

修正要件:
1. **単一インスタンス強制**: 起動時に `data/resident/host.lock` を取得（pid を書く）。既存ロックの pid が生存していれば**起動せず終了**する。
   ロックは正常終了・例外時に必ず解放（`process.on('exit'|'SIGINT'|'SIGTERM')`）。stale ロック（pid 死亡）は自動回収。
2. ログ: `HOST_LOCK acquired pid=<n>` / `HOST_LOCK held-by=<pid> -> exit` を必ず出す。
3. 開発手順: 再起動は「kill → `pgrep -c -f 'node agent-runner.mts'` が 0 を確認 → 起動」の順で行う。
   起動前にロックが残っていれば stale 判定で回収されることも確認する。
4. 受け入れ:
```
・二重起動を試みても2つ目が即終了する（HOST_LOCK held-by が出る）
・kicked|duplicate_login の発生が 0 になる（1時間の連続稼働で）
・再起動を5回行ってもロックが残らない（stale回収が機能する）
```

---

## 追記5（01:06 実測）— 土をジグザグに浅く掘る（スクリーンショット証拠あり）

ユーザー提示のスクリーンショット: `AI_Buddy` が草原を**1ブロック深さのジグザグ溝**で掘り進んでいる（土/草のみ。石には到達していない）。
目標は `collect 12 x stone`。地表付近に石が無いため掘っているが、**方向が交互に反転して蛇行**し、無駄な掘削になっている。

推定原因:
1. 候補生成が「石に向かう方向」を毎tick選び直し、左右の候補が交互に勝つ → **ジグザグ（振動の一種）**
2. 目標が stone なのに、**既知の石レベル（例 y≈60-63）への計画的降下**ではなく地表を浅く掘っている
3. 既存の穴/坑道（WorldMemory）を再利用していない

修正要件:
1. **掘削方向の固定**: 一度掘削方向を決めたら、資源が出るか上限（例 8ブロック）に達するまで**方向転換しない**。
   `DIG_PATH dir=<N|S|E|W|down> depth=<n> target=<item>` をログ。
2. **目標が石なら降下優先**: 地表に石が無い場合は、既知の石レベルへ**まっすぐな階段掘り**（1ブロックずつ降下）で到達する。
   蛇行は禁止（`STAIRCASE dir=... from_y=<n> to_y=<n>` をログ）。
3. **既存穴の再利用**: WorldMemory に掘削跡を記録し、同一目標では既存の穴へ戻る（新規掘削を最小化）。
4. **振動検知の適用**: 直近6掘削で正味変位が小さい場合は `MOVE_OSCILLATE` と同様に wedge 扱い（`DIG_OSCILLATE net=<m> -> strategy=staircase`）。
5. 可視化: `DIG_PATH` / `STAIRCASE` / `DIG_OSCILLATE` / `REUSE_TUNNEL at=<x,y,z>`。

受け入れ:
```
・ジグザグが消え、`STAIRCASE` または `REUSE_TUNNEL` が出る
・`collect 12 x stone` が完了する（石が在庫に入る）／または石レベル到達がログで示される
・`DIG_OSCILLATE` が検知された場合は即座に staircase へ切替
```

---

## 追記6（01:06）— Jev/LLM応答の監査（覗き見）手順

すでに記録がある: `buddy-driver/logs/jev/jev-calls.jsonl`（5602件）
```
キー: record, callId, ts, policy, model, stage, latencyMs, rateLimitRetries, rateLimitWaitMs, state, questions, response, error
```
覗き方（例）:
```
cd /home/s0u7a/mc-ai/buddy-driver
tail -1 logs/jev/jev-calls.jsonl | python3 -m json.tool | head -60
# 実LLMのみ:
python3 - <<'PY'
import json
for l in open('logs/jev/jev-calls.jsonl'):
    d=json.loads(l)
    if d.get('model')!='deterministic-local-fallback':
        print(d['ts'], d['model'], d.get('latencyMs'), json.dumps(d.get('response'))[:200])
PY
```
要件: ①`model` が実モデル（`typesafe-ai/jev`）の行だけ抽出できること ②`state` は圧縮サマリ ③`response` に answers/probabilities が入る
④cost と rateLimit 情報が残る ⑤失敗時は `error` が入る。Mercury を使う場合も**同じスキーマで記録**する（`model='inception/mercury-2.5'`）。

---

## ★自律運転モード（ユーザー指示: フィードバック無し・指示待ち禁止）

ユーザーはPCを閉じ、以後サーバー参加もフィードバックも無い。**このファイルと各issueを正として自律的に判断し、前進し続けること。** 確認待ち・許可待ちはしない。

### 自律時の優先順（外部共同監査の結論）
```
1. P1 durability/atomicity を最新mainで確定
   ledger復元(done維持・rung後退防止) / lease前のdurable書き込み禁止(HOSTだけがwriter) /
   craftingTables例外の完全解消 / リロード<2s・listener/タイマー非増加 / 単一インスタンス強制
2. movement の root cause 修正
   #7 resourceTier の unknown→0（土にツルハシ）
   #8 hop recovery の順序（forward=false→jump→解除→forward のその場ジャンプ）＋近傍座標でのfailure memory回避
   #9 DESCEND暴走（target===null→wantDown=true、土掘りが成功扱いでfailure limit回避）
   ＋ ジグザグ掘りの方向固定・階段掘り・既存穴再利用（DIG_PATH/STAIRCASE/DIG_OSCILLATE/REUSE_TUNNEL）
3. System2: Mercury 2.5 を System2Brain として例外駆動で稼働
   アボート誤設定の修正 / mercury-calls.jsonl に error=null の実応答(plan, latency, usage, cost) /
   失敗時は決定論ラダーへ即fallback / 決定論モードは llm.called==false
4. Issue #11 Grounded Options へ段階移行（Jev = π action + β abandon_option、事前条件・成功述語はコード）
5. M2完走（furnace→charcoal→iron_ore→iron_ingot×3→iron_pickaxe を在庫で証明）→ M3/M4
```

### 自律時の行動規則
```
・判断に迷ったら「P1 durability を壊さない」を優先する
・各作業単位で commit & push（秘密スキャン: server.properties/*.key/.env/accounts.json が0件であること）
・証拠は一次ログ/在庫/コミットで残す。テストは typecheck / audit 9/9 / step-pipeline 6/6 / guard 12/12 /
  gating 6/6 / loop 7/7 / m1 5/5 を維持
・サーバー再起動は最終手段（今は ops.json に s0u7a level4 を設定済み。RCONはLeafでは実際には開かない）
・Javaは 21.0.13-ea のため `-DPaper.IgnoreJavaVersion=true` を付けて起動する（付けないと起動失敗）
・常駐ホストは単一インスタンスのみ（pidでkill、`pkill -f` 自爆禁止）
・人間が居ないので、危険な変更（サーバー停止・world削除・履歴改変・force push）はしない
```

---

## 追記7（01:33 実測・control.sock の `report` より）— 自律運転で見えた優先修正

```
runId=run-mu5qd4ah-3xdh  connected=true frozen=false
generations=150 reloads=50 recoveries=72  milestone=raw_iron  contractVersion=2
stats: reconnects=65  reloadsChangedHash=12  reloadsSkippedUnchanged=2  reloadsFailed=0
       freezeCycles=0  wedge=true  goalComplete=false
worldMemory: craftingTables=13  furnaces=1  discoveredOres=[coal_ore, copper_ore, iron_ore]
             traversalFailures=0  hazards=1  hardHazards=0
listeners: physicsTick=3 (baseline=2)  death=4  end=3  kicked=2   → ★listenerLeak=true
status: running=true  policyKind=fallback  policyModel=deterministic-local-fallback+descend...
ledger: current=g3:collect:raw_iron  origin="llm"  done=0  hasImpossible=false
```

### 優先修正（この順）
1. **★listenerリークの解消（P1）**: `physicsTick` が baseline 2 に対し 3（`listenerLeak=true`）。
   reload のたびに executor 系リスナーが増えている疑い。世代 `detach()` で確実に解除し、
   リロード前後で全イベントの listenerCount が baseline と一致することを assert する。
   受け入れ: 10回リロード後も `listenerLeak=false`。
2. **★再接続が多すぎる（reconnects=65）**: 多重起動キック（解消済み）＋サーバー再起動＋ホスト再起動が原因。
   単一インスタンス強制（追記4）＋「ホスト再起動は最終手段」を徹底し、1時間あたり reconnects<=2 を目標にする。
3. **★既知鉱石があるのに探索で停滞**: `discoveredOres` に **iron_ore がある**のに `collect 3 x raw_iron` で wedge。
   → プランナは「目標資源が `discoveredOres`/WorldMemory に存在するなら `RETURN_TO_KNOWN_ORE:<id>` を最優先候補にする」。
   `ORE_KNOWN item=iron_ore at=<x,y,z> -> strategy=return_to_known_ore` をログ。
   受け入れ: 既知の鉄鉱石座標へ移動して採掘し、`raw_iron` が在庫に出現する。
4. **freezeCycles=0**: freeze→dump→reload→resume がまだ一度も実行されていない（P2）。一度実走させて証拠を残す。
5. **policyKind=fallback**: この世代は決定論で動いている。Mercury/Jev の実使用は設定（system2.config.json）で明示的に有効化し、
   `ADVISOR source=mercury` の実ログを残す（追記6の監査スキーマ）。

---

## 追記8（01:39 実測）— P2 freeze→dump→resume を実走で確認（未実走項目をクローズ）

制御ソケット `data/resident/control.sock` 経由で自律的に実行:
```
FREEZE  -> {"ok":true,"data":{"frozen":true,"report":".../logs/resident/freeze-2026-09-17T16-39-46-442Z.json","runId":"run-mu5qd4ah-3xdh"}}
REPORT  -> frozen:true, connected:true
RESUME  -> {"ok":true,"data":{"frozen":false,"started":true}}
REPORT2 -> frozen:false, connected:true, generations 176->178, reloads 73->74
```
証拠: `logs/resident/freeze-2026-09-17T16-39-46-442Z.json` が新規生成（既存は 15-44-56）。
→ **wedge で走行が死なず、凍結→文脈ダンプ→再開できることが実証された**（P2クローズ）。

残る観測: `recoveries=75` / `reloads=74` / `generations=178` と世代交代が非常に多い。
wedge→recovery の回転が速すぎるので、**世代が短命すぎる原因**（毎回 wedge している）を潰すのが次の本命。
併せて `listenerLeak=true`（physicsTick 3 vs baseline 2）も未解決のまま。

### 制御チャネル コマンドの実測仕様（自律運転で使える）
```
report            -> 全状態（runId/frozen/connected/generations/reloads/recoveries/milestone/worldKey/
                     stats/worldMemory/listeners/listenerBaseline/listenerLeak/acceptancePath/status）
goal {item,count} -> 現在の ledger mirror（milestone/goalItem/goalCount/depth/current/done/goals）を返す
freeze {reason}   -> frozen:true + freeze report パスを返す
resume            -> frozen:false, started:true
```
※ソケットは 0600、JSON Lines（`{"id":<n>,"cmd":"...","args":{...}}\n`）。応答は1行JSON。

---

## 追記9（01:41 実測）— ★Mercury稼働の証拠 ＋ ★世代短命の原因（PRECONDITION_MISSINGループ）

### Mercury 2.5 が実応答して GoalQueue に反映された（達成）
```
ADVISOR source=mercury reason=no_candidate strategy=mercury_continue_collect_raw_iron cost=0.000329 ms=6870 cached=false
STRATEGY_SET strategy=mercury_continue_collect_raw_iron source=mercury goals=["collect 3 x raw_iron"]
```
- 実モデル `inception/mercury-2.5` が **6870ms**（推論モデルとして妥当）で応答、**cost $0.000329**（目標 <$0.001 を満たす）
- structured output → shape validation → kind×target grounding → PlannedGoal → GoalQueue の経路が通った
- 以前の `aborted due to timeout`（52ms）は解消

### 世代が短命な原因（新規・最優先で潰す）
```
PRECONDITION_MISSING goal=smelt 3 x iron_ingot need=furnace + raw_iron rungId=iron_ingot
GENERATION_STOP id=... stopped=stopped-by-caller success=false ticks=1 verifiedDigs=0 subgoalsDone=0
（16:41:17 / 16:41:31 / 16:41:39 … 約10〜15秒ごとに反復）
```
診断: 死亡復帰用に入れた **precondition-gated ladder が厳しすぎる**。キュー先頭が `smelt 3 x iron_ingot` で
前提（furnace + raw_iron）が無いと、**1tickで停止** → ホストが回復 → 同じ目標でまた停止、の無限回転
（generations=178 / recoveries=75 の正体）。

修正要件:
1. `PRECONDITION_MISSING` は**停止条件にしない**。代わりに **前提チェーンを在庫から再導出**して計画を差し替える:
   `smelt iron_ingot` → `collect raw_iron` → （ツルハシが無ければ）`craft stone_pickaxe` → `collect cobblestone` → …
   `LADDER_PREREQ goal=<g> need=<items> -> replace goals=[...]` をログ。
2. 前提が **原理的に充足不能**（例: 必要な資源が現在の次元/在庫/既知資源に存在しない）場合のみ停止し、その理由を残す。
3. 差し替え後は **少なくともN tick（例 20）は再停止しない**（1tick停止→回復の回転を禁止）。
4. 受け入れ:
```
・PRECONDITION_MISSING の直後に LADDER_PREREQ が出て、目標が前提チェーンへ差し替わる
・generation の ticks が 1 で終わらない（連続稼働 >= 100 ticks が普通になる）
・1時間あたりの generations/recoveries が大幅に減る（現状 178/75 → 目標 1桁台）
```
5. 併せて未解決: `listenerLeak=true`（physicsTick 3 vs baseline 2）、`RETURN_TO_KNOWN_ORE`（discoveredOres に iron_ore あり）。

---

## 追記10（01:51 実測）— 制御チャネルの実コマンド仕様（照会のみ／実行のみ）

`agent-runner.mts` のハンドラから確認した実装済みコマンド一覧:
```
照会系（値を返すだけ。差し替えはできない）: report / status / goal / milestone / acceptance
実行系（状態を変える）                    : freeze / resume / reload / gc / leakcheck / simdeath / worldreset / quit
```
実測で確認した挙動:
- `goal {item,count}` → ledger mirror を返すだけ（before/set/after で `collect 3 x raw_iron` のまま変化なし）
- `milestone {milestone|index}` → 現在値（raw_iron, index=7）を返すだけ
- `freeze {reason}` → `{frozen:true, report:<path>}` ／ `resume` → `{frozen:false, started:true}` ／ `report` で世代数・listener等が取れる

**含意（自律運転の重要制約）**: 目標・マイルストーンを外部から注入する手段は無い。
停滞（PRECONDITION_MISSING の1tick回転）を解くには**コード修正（#12 / #11 の前提チェーン差し替え）が唯一の道**。
`simdeath` は死亡復帰の決定的な再現に使える（kill相当を任意に起こせる）。
`worldreset` は破壊的（worldEpochが変わる）ので、人間不在の自律運転では使わない。
```

追記11（#26/#34）— `simdeath` の semantics:
```
・既定は soft（非破壊）: ledger / milestone / hazard memory を snapshot し、
  死亡復帰パス（DEATH → LADDER_RESET → generation 再起動）を実行した後に復元する。
  inventory は toss しない。log: SIMDEATH mode=soft ledgerRestored=true hazardsRestored=true
・破壊的版は明示的にのみ: {cmd:"simdeath --hard"} または {cmd:"simdeath", hard:true}
  （args:{hard:true} も可）。inventory を toss し後代で ladder を再計算する。
・simulated hazard は本番 memory に入らない（HAZARD_SKIPPED source=simulation、
  durableHazards は不変）。rehearsal 専用の非永続 namespace にのみ記録する。
・DEATH は toss/clear の前に inventory を取得する:
  lostInventory=<summary> itemsLost=<n> capturedBeforeDrop=true
```
