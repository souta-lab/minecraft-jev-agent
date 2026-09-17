# AGENT-TODO — AI_Buddy 常駐エージェントの最優先修正

> このファイルは buddy-driver を担当するエージェントへの指示。詳細と一次ログは `/home/s0u7a/mc-ai/BUDDY-DEFECTS.md` を読むこと。
> 状態: **常駐＋ホットリロードは完成済み**（`RELOAD ok=true ms=236〜502`、`generations=4`）。**知能の中身（移動・掘削・道具選択）が未熟**。修正は数秒で反映される。
> 更新: 2026-09-18 00:09 JST

## 実測されている現状（すべて一次ログ由来・推測なし）
```
効率（直近40サンプル）: box=3.4x2.4m  net=3.6m  traveled=45.3m  eff=8%
  → 同じ場所を多動症のように往復している（ユーザー報告と一致）
欠陥修正マーカーの出現数 = 0
  JUMP_ATTEMPT / JUMP_FAIL / DETOUR / MOVE_OSCILLATE / DESCEND_LIMIT / TOOL_CHOICE / PREEMPT_BLOCKED
最新アクション: DESCEND:level:E:b14_65_21 phase=digging pos=13.5,65.0,21.5 rung=cobblestone
在庫: stick:4, crafting_table:1, oak_planks:4, leaf_litter:69, dirt:...
ユーザー観察: 「Buddyはつるはしで土を掘っている」（＝欠陥Cが未修正）
```

## 最優先で直すもの（この順）
### F. 1ブロック段差でジャンプ失敗／迂回しない（ユーザー報告）
- 前提: **jump apex 1.2522 > 1.0 → 1ブロックはジャンプで越えられる**。失敗は実行の問題。
- 実装: `setControlState('jump',true)` と `setControlState('forward',true)` を**同時に**保持 → 400〜600ms 後に両方解放。成功判定は**座標**（`y` が +1 され目標セルに乗ったか）。
- **同一ブロックへの反復ジャンプは2回まで**。2回失敗で wedge → `JUMP_FAIL attempts=2 -> strategy=detour`。
- ログ: `JUMP_ATTEMPT dy=1 ok=false` / `JUMP_FAIL attempts=N` / `DETOUR via=...`。
- 起動時に `MOVEMENTS canJump=true canDig=false` を出力。

### E. 移動の振動（同じ場所を往復・効率8%）
- **沈黙禁止**: `path_update` の `noPath`/`timeout`/`success` を必ずログ（`PATH status=noPath target=...`）。
- **検知**: 直近 N=6 の MOVE で正味変位 < 1.5m → wedge（`MOVE_OSCILLATE net=0.8m -> strategy=detour`）。
- **迂回の強制**: 近傍点の選び直しをやめ、**中間ウェイポイント迂回**（目標方向に垂直 ±3m オフセット）→ それでも駄目なら階段化（`stepCuts`）→ 最後に探索。
- **訪問済み記憶**: 現在地から1m以内の目標で進捗が出なかった地点を再選択しない。

### C. 土をツルハシで掘っている（ユーザー報告・未修正）
- dirt / grass_block / sand / gravel = **シャベル**（無ければ素手）。ツルハシを使わない。
- 石系 = ツルハシ、木 = 斧（無ければ素手）。
- ログ: `TOOL_CHOICE block=dirt tool=shovel reason=resourceClass`。
- シャベルは必要性が生じたときだけクラフト。

### A. DESCENDの直線掘り無限ループ
- 進捗なし降下が N=4 超 → wedge（`DESCEND_LIMIT depth=18 noProgress=4 -> strategy=lateral`）。
- 代替: 横方向ブランチ掘り／既知の石レベルへ移動／露出石探索。降下は「目標yが下で数ステップ到達見込み」のときのみ。
- 既存の穴（depth=18 等）は WorldMemory に登録し再掘削しない。

### B. dig中断の禁止
- `phase=digging` 中はブロック破壊完了まで他候補で preempt しない。競合時は `PREEMPT_BLOCKED by=...`。
- 「破壊 → ドロップ取得（既存pickup）」を1アクションとして扱う。

## 併せて
- 2ブロック以上: 候補生成で `stepUpHeight > 1` を除外。迂回 or 階段化のみ。反復は `CLIMB_FAIL wallHeight=2 attempts=N`。
- 作業台: 既存（世界に約20個）をスキャンして再利用。新規設置は皆無時のみ。撤去しない。
- バンドラは esbuild 既定（安定性優先）。Bun は移行ゲート通過時のみ。
- 他のbot（`M1FIX` 等、別タスクの走行）と同じ世界に居る。名前空間（`AI_*`）は衝突させない。

## 受け入れ基準（これが出たら完了）
```
1) JUMP_ATTEMPT/JUMP_FAIL/DETOUR の実測行があり、1ブロック段差が「越える or 迂回する」ことを座標で示す
2) MOVE_OSCILLATE が出て、かつ直近40サンプルの efficiency が 8% → 50%以上に改善
3) TOOL_CHOICE block=dirt tool=shovel が出る（土にツルハシを使わない）
4) DESCEND_LIMIT が出て、depth が無制限に増えない
5) RELOAD ok=true が継続（ms < 2s）し、リロード前後で listener数・タイマー数が増えない
```

---

## ★最優先の新規ブロッカー（00:33 実測・ホスト再起動後に発生）

再起動した新ホストは起動直後に落ちており、**世代が開始されていない**（Buddyは生存しているが待機中）:
```
BOOT pid=165685 runtime=node node=v25.9.0 bundle=none milestone=raw_iron generations=39 reloads=14
BUILD hash=4babbfa827e4 bytes=1125877 ms=35
CONNECT → SPAWN pos=16.5,65.0,25.5 version=1.21.11
CRAFT_COMPAT ok=true mineflayerTested=4.39.0 api=_syncWindow
ERROR where=unhandledRejection message=Cannot read properties of undefined (reading 'craftingTables')
（以降 GENERATION_READY が出ない = 世代未起動）
```

原因箇所（読み取り調査）:
```
buddy-driver/generation-entry.ts:228  craftingTables: ctx.worldMemory.craftingTables.map(...)   ← ctx.worldMemory が undefined
buddy-driver/generation-entry.ts:203  ... || world.craftingTables ...
buddy-driver/generation-entry.ts:245/254/263/338  world.craftingTables
buddy-driver/planner.ts:136 / :669     w.craftingTables / this.world.craftingTables
```
推定原因: WorldMemory を worldEpoch で namespace 化した際、**その世代のエントリを初期化する前に参照**している（`worldMemory[worldEpoch] ??= {...}` の初期化漏れ）。

修正要件:
1. 復元時に必ず初期化: `worldMemory[worldEpoch] ??= { craftingTables: [], furnaces: [], mined: {}, ores: {}, explored: [] }`
2. 世代構築時も `const world = ctx.worldMemory ?? { craftingTables: [], furnaces: [], mined: {}, ores: {}, explored: [] }`
3. snapshot/report 系（228 / 263 / 338 / 669）は `.length` 参照前に空配列へ正規化
4. 受け入れ: 起動ログに `GENERATION_READY` が出て、以降 `ACTION` / `HEARTBEAT` が継続すること

## 併せて: 再起動で状態がリセットされる問題（P1の核心）
再起動前 `done=9, depth=12` → 再起動後 `done=0, depth=2`。**台帳からの復元が効いていない**。
要件: 起動時に durable state から `done` を復元し、前後で維持されることを実測（例: 再起動前 done=9 → 再起動後 done>=9）。

## 順序の注意（Sol レビュー準拠）
`planner.ts` は既に存在するが、**LLMプランナの配線は P5**（Phase B shadow → C authority）。
P1では「動くが決定論フォールバックで走る」状態に留め、プランナは後段に回すこと。