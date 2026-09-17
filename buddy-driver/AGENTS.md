# AGENTS.md — このディレクトリで作業するエージェントへの最優先指示

> あなたが `buddy-driver/` で作業するなら、**作業前にこのファイルを最後まで読むこと**。
> 詳細仕様: `/home/s0u7a/mc-ai/RESIDENT-MODE.md`（正典）／欠陥票: `/home/s0u7a/mc-ai/BUDDY-DEFECTS.md`／現状: `/home/s0u7a/mc-ai/ARCHITECTURE.md`

## 優先順位（外部レビュー Sol 準拠。これを勝手に並べ替えない）
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