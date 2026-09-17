# BUDDY 欠陥票（ユーザー実プレイ・フィードバック）

> 対象: 常駐エージェント `AI_Buddy`（`/home/s0u7a/mc-ai/buddy-driver/agent-runner.mts`, pid 150528 で稼働中）
> 記録時刻: 2026-09-18 00:0x JST / 証拠はすべて一次ログ（推測なし）
> 注入先: buddy-driver のセッション（実行中はゲートで弾かれるため、空き次第）

## 稼働の事実（良いニュース）
```
GENERATION_READY id=gen-mu5nrths-p3mj3j rung=wood goals=["collect 3 x log","collect 12 x stone","craft 1 x fu..."]
RELOAD ok=false trigger=source-changed ms=313 message=smoke test failed: empty plan and no completed goals
→ 常駐プロセス稼働・世代システム稼働・ホットリロード機構も発火済み（313ms）。ただし smoke test が厳しすぎて ok=false。
```

---

## 欠陥A: DESCENDの直線掘り無限ループ（ユーザー「謎に直線で土を掘る」）
**証拠**
```
ACTION n=35..40 id=DESCEND:level:S/E:b*_66_* kind=DESCEND phase=digging pos=0.5..4.3,66.0,12.5..13.5
INVENTORY ... dirt:32 → dirt:34 → dirt:35
HEARTBEAT ... queue=collect 12 x stone depth=18 done=3 action=DESCEND
```
y=66 で `DESCEND:level:*` を反復し、**depth=18 まで降下しても dirt が増えるだけ**で目標（collect 12 x stone）が done=3 のまま動かない。＝直線掘り。

**修正要件**
1. **進捗なし降下の上限**: 同一目標で「新規資源を得られないままの連続 DESCEND」が N=4 を超えたら wedge 扱い → 降下を中断。
2. **代替戦略**: 横方向ブランチ掘り／既知の石レベルへの移動／露出石の探索に切替。降下は「目標yが下にあり数ステップで到達見込み」のときのみ。
3. **可視化**: `DESCEND_LIMIT depth=18 noProgress=4 -> strategy=lateral`。
4. 既存の穴（depth=18）は WorldMemory に登録し、次回は再利用して再掘削しない。

## 欠陥B: 原木の破壊を完了せず移動する（ユーザー「もくざいをこわすとちゅうで動いてしまう」）
**修正要件**
1. **単一アクションロックの厳守**: `phase=digging` のアクションはブロックが実際に破壊されるまで他の候補で preempt しない。キャンセルはタイムアウト/真の失敗時のみ。
2. 競合時は `PREEMPT_BLOCKED by=<candidate>` をログ。
3. 「破壊 → ドロップ取得（既存pickup）」までを1アクションとして扱う。

## 欠陥C: 土をツルハシで掘る（ユーザー「鶴橋で土を掘る」＝つるはしの誤変換）
**修正要件**
1. dirt/grass_block/sand/gravel は **シャベル**（無ければ素手）。ツルハシを使わない。
2. 資源クラス→道具のマッピングを可視化: `TOOL_CHOICE block=dirt tool=shovel reason=resourceClass`。
3. シャベルは必要性が生じたときのみクラフト（無駄なクラフトを増やさない）。

## 欠陥D: ホットリロードの smoke test が厳しすぎて必ず失敗（開発ループが回らない）
**証拠**
```
ERROR where=performReload trigger=source-changed message=smoke test failed: empty plan and no completed goals
RELOAD ok=false trigger=source-changed ms=313 message=smoke test failed: empty plan and no completed goals
```
**修正要件**
1. smoke test は「モジュール表面の妥当性＋純関数（buildWorldState/generateCandidates/guard）を合成スナップショットで実行して throw しないこと」を検証し、**「planが空」「完了ゴールが無い」は合格**とする（起動直後に必ず起きるため）。
2. `RELOAD ok=true` の実測と `build/import/swap` のmsを記録。リロード前後で listener数・タイマー数が増えないことも記録。
3. ロールバックは維持（smoke失敗時は旧世代で継続）。

---

## 併せて有効な既出要件
- **2ブロック壁**: 候補生成で `stepUpHeight > 1` を除外／迂回 or 階段化のみ／反復ジャンプは wedge（`CLIMB_FAIL wallHeight=2 attempts=N`）。物理: jump apex 1.2522。
- **作業台**: 既存（約20個）をスキャン→再利用。新規設置は皆無時のみ。撤去しない。
- **バンドラ**: esbuild 既定（安定性優先）。Bun は移行ゲート通過時のみ。
- **クラフト**: `bot.openContainer(tableBlock)` の window/`craftingTable` を `bot.craft(recipe,count,table)` に渡す。材料・レシピを事前検証し、失敗時は wedge せずクリーンに失敗。
- 常駐アーキテクチャ・状態持ち越し・制御チャネル・凍結/再開の詳細は `/home/s0u7a/mc-ai/RESIDENT-MODE.md`。

---

## 追記（00:03 時点の一次ログ）— 欠陥Dの追加要因と欠陥Aの継続
```
RELOAD ok=false ... ms=212  message=pos.floored is not a function          ← ★新しい失敗要因（vec3 API誤用）
RELOAD ok=false ... ms=313  message=smoke test failed: empty plan and no completed goals
RELOAD ok=false ... ms=418  message=smoke test failed: empty plan and no completed goals
RELOAD ok=false ... ms=260  message=smoke test failed: empty plan and no completed goals
RELOAD ok=false ... ms=247  message=smoke test failed: empty plan and no completed goals
HEARTBEAT pos=10.5,65.0,21.5 ... queue=collect 12 x stone depth=18 done=3 action=DESCEND
HEARTBEAT pos=11.5,65.0,22.5 ... queue=collect 12 x stone depth=18 done=3 action=DESCEND
```
- **欠陥D-2**: `pos.floored is not a function` — 世代バンドル内で `Vec3.floored()` を誤って呼んでいる（prismarine-vec3 の API は `floored()` ではなく `floored()`... 実際は `vec.floored()` は存在しないため `pos.floored()` 不可。`new Vec3(Math.floor(x),...)` か `pos.offset(...)`/`pos.floored?` を使う）。**バンドル対象外の依存（prismarine-vec3）が external のため、世代側の Vec3 がホスト側と別インスタンスになっている可能性も疑う**（`instanceof`/拡張メソッドの不整合）。
- **欠陥Aは未解決のまま継続**: `action=DESCEND` が依然として支配的で、`depth=18` から増えず、`done=3` のまま。水平にも移動している（10.5,21.5 → 11.5,22.5）＝直線/斜めに掘り進んでいる。
- プロセスは再起動されている（pid 150528 → 152603）。

---

## 追記2（00:05 時点）— ★ホットリロード成功 & 新欠陥E（壁で迂回しない／訳の分からない行動）
```
RELOAD ok=true trigger=source-changed ms=236 hash=f5c0cf6d3d70 id=gen-mu5nud3n-lo1wje generations=4
  → D-1/D-2 は解消。ホットリロードが実測236msで成功（世代4）。常駐ループ成立。
ACTION n=86 id=MOVE:p11_66_20 kind=MOVE phase=pathing pos=11.5,66.0,19.6
ACTION n=87 id=MOVE:p12_66_19 kind=MOVE phase=pathing pos=12.4,66.0,20.0
ACTION n=88 id=MOVE:p10_66_20 kind=MOVE phase=pathing pos=10.9,66.0,20.5
```
**欠陥E: MOVEの振動（往復）＝「壁があっても迂回しようとしない・訳分からん行動」**
近接セル（11.5,19.6 ⇄ 12.4,20.0 ⇄ 10.9,20.5）を行き来して**正味の変位がほぼゼロ**。壁で直進が塞がると、迂回せずに別の近傍点を選び直す→また塞がる→振動、というループ。

**修正要件**
1. **沈黙禁止**: pathfinder の `path_update` ステータス（`noPath` / `timeout` / `success`）を必ずログ（`PATH status=noPath target=...`）。
2. **MOVE振動の検知**: 直近 N=6 の MOVE アクションで**正味変位 < 1.5m** なら wedge 扱い（`MOVE_OSCILLATE net=0.8m -> strategy=detour`）。
3. **迂回の強制**: 直進経路が塞がれたら、近傍点の選び直しではなく**中間ウェイポイントへの迂回**（目標方向に対して垂直に ±3m オフセットした点）を使う。それでも駄目なら階段化（`stepCuts`）→ 最後に探索。
4. **訪問済みの記憶**: 直近 M 個の位置を記録し、「現在地から1m以内の目標」で進捗が出なかった地点を再選択しない（WorldMemory と連携）。
5. **可視化**: `DETOUR from=... via=... ok=true|false`、`MOVE_OSCILLATE`、`PATH status=...`。無言の往復を禁止。

**実測（00:06・直近40サンプル=MOVE/HEARTBEATのpos）**
```
x: 10.1..12.4 (spread 2.3m) / y: 66.0..67.2 (1.2m) / z: 18.6..20.6 (2.0m)
net displacement = 2.3m  ／ traveled path = 43.9m  ／ efficiency = 5%
MOVE_OSCILLATE / DETOUR のログ出現数 = 0（＝検知・迂回は未実装）
```
⇒ **約2m四方の箱の中を43.9m歩いて正味2.3mしか進んでいない（効率5%）**。ユーザー報告「同じ場所を多動症のように目的もなくうろうろ」の定量的一致。欠陥Eは未実装のまま。

---

## 欠陥F: 1ブロック段差でジャンプ失敗し、迂回もしない（ユーザー「1個のブロック、明らかに迂回した方がいいのにジャンプしようとして失敗してる」）
**前提**: jump apex = **1.2522** > 1.0 なので、**1ブロック段差はジャンプで越えられるはず**。失敗しているのは能力ではなく**跳躍の実行**。
**推定原因（要確認）**
1. ジャンプ時に前進入力が無い（その場で跳ねて落下 → 越えられない）。正解は「jump + forward を同時に一定時間（約400〜600ms）保持してから解放」。
2. `movements` の設定（`canJump` 無効／parkour 設定との不整合）で pathfinder が段差ジャンプを発火できていない。
3. 自前アクチュエータの climb フォールバックが壊れている（ジャンプのみで前進なし）。
**修正要件**
1. 1ブロック段差: `setControlState('jump', true)` と `setControlState('forward', true)` を**同時**に保持 → 約400〜600ms後に両方解放。目視ではなく座標で成功判定（`y` が +1 され、目標側のセルに乗ったか）。
2. **2回失敗したら迂回に切替**（同一ブロックへの反復ジャンプ禁止）: `JUMP_FAIL attempts=2 -> strategy=detour`。
3. 可視化: `JUMP_ATTEMPT dy=1 ok=false` / `JUMP_FAIL attempts=N` / `DETOUR via=...`。
4. pathfinder の `canJump` が有効であることを起動時にログ（`MOVEMENTS canJump=true canDig=false`）。
5. 2ブロック以上の段差は従来どおり**迂回 or 階段化のみ**（`stepUpHeight>1` は候補から除外、反復ジャンプは `CLIMB_FAIL`）。

