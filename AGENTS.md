# AGENTS.md — mc-ai グローバル指示（全エージェント必読）

> このファイルは `/home/s0u7a/mc-ai` で作業する**すべてのエージェント**に対する最上位の指示。
> 作業前に必ず読むこと。詳細は `buddy-driver/AGENTS.md`、設計は `RESIDENT-MODE.md`、現状は `ARCHITECTURE.md`。

## 0. 標準指令（ユーザー指示・恒久）
1. **最終目標は M4（Ender Dragon 討伐）**。M2（鉄器時代）は通過点。
2. **ユーザーの発言を待たない。指示待ちをしない。** やることが無ければ**自分で仕事を考えて着手する**。
3. 判断に迷ったら「**P1 durability を壊さない**」を優先し、次に「M4への距離を縮める」を基準にする。
4. 進捗は必ず一次証拠（ログ行・在庫・コミット）で残す。主観や推測で「できた」と言わない。
5. 作業単位ごとに小さくコミット＆push（秘密スキャン必須）。
6. 人間は基本不在。危険操作（サーバー停止・world削除・履歴改変・force push）はしない。

## 1. システム概要
```
Mineflayer   = メカニクス実行（連続モーター）
Jev          = 接地された局所方針・唯一の行動権限（現在: action Choice ＋ 各種意味質問）
LLM/Mercury  = 上位の意図生成・計画修復（例外駆動。System2Brain）
Code         = 安全性・物理的真実・事前条件・成功述語
常駐ホスト   = 接続保持＋世代ホットリロード＋制御ソケット＋状態ストア（HOSTだけが durable writer）
```
設計の本命: **Issue #11 Grounded Options**（Jev = π action ＋ β abandon_option、事前条件/成功述語はコード）。

## 2. 優先順（この順で前へ進める）
```
1. P1 durability/atomicity の確定
   ledger復元(done維持・rung後退防止) / lease前のdurable書き込み禁止 / listenerリーク0 /
   リロード<2s / 単一インスタンス強制 / worldEpoch名前空間 / server truth と durable state の分離
2. #12 PRECONDITION_MISSING → 前提チェーン差し替え（LADDER_PREREQ）。世代が長生きするようにする
3. movement root cause（#7 resourceTier / #8 hop順序・failure memory / #9 DESCEND暴走 / ジグザグ→階段掘り）
4. System2: Mercury 2.5 を例外駆動で稼働（mercury-calls.jsonl に error=null の実応答）
5. Issue #11 Grounded Options へ段階移行（旧質問は shadow へ降格）
6. M2 完走（furnace→charcoal→iron_ore→iron_ingot×3→iron_pickaxe を在庫で証明）
7. M3/M4（ダイヤ、ネザー、ブレイズ、エンダーパール、エンダーアイ、要塞、ジ・エンド、ドラゴン）
```

## 3. 現在の既知ブロッカー（2026-09-18 01:55 JST）
```
#12 PRECONDITION_MISSING が停止条件になっている（PRECONDITION_MISSING=128 / LADDER_PREREQ=0）
    → 世代が1tickで停止→回復を回転（generations=208 / recoveries=83）。これが critical path
listenerLeak=true（physicsTick が baseline を超過）
RETURN_TO_KNOWN_ORE 未実装（discoveredOres に iron_ore があるのに探索で停滞）
PR #2（Mercury adapter + CI）は CI が failure。mergeable でも CI green まで merge しない
movement 修正はコミット済み（f68224c）だが、#12 で掘削が始まるまで実効を観測できない
```

## 4. 運用手順（必ず守る）
```
・健全性の一括確認:      node tools/buddy-status.mjs        （--json で機械可読）
・常駐ホストは単一:      pgrep は bash ラッパーに誤マッチするので tools の判定を使う。kill は pid 指定
・デタッチ起動:          cd buddy-driver && setsid nohup node agent-runner.mts </dev/null > runner.out 2>&1 &
・サーバー:              127.0.0.1:25565 (Leaf 1.21.11, offline, peaceful)。停止時は
                         -DPaper.IgnoreJavaVersion=true を付けて起動（Java は 21.0.13-ea のため必須）
・制御ソケット:          data/resident/control.sock（0600, JSON Lines）
   照会のみ: report / status / goal / milestone / acceptance
   実行可:   freeze / resume / reload / gc / leakcheck / simdeath / quit
   注意:     goal/milestone は注入不可（照会だけ）。worldreset は破壊的なので使わない
・Bot名:                 AI_Buddy は常駐が占有。検証は AI_M1* / AI_M2* 等を使う。s0u7a は人間用
・秘密:                  /home/s0u7a/.config/kimaki-secrets/ 配下は絶対に出力しない
```

## 5. 完了の定義（M4までの到達点）
```
M1: 3 log → crafting_table → wooden_pickaxe → cobblestone（検証済み・維持）
M2: furnace → charcoal → iron_ore → iron_ingot×3 → iron_pickaxe（在庫で証明）
M3: ダイヤ入手 → ダイヤ装備 → ネザー到達 → ブレイズロッド・エンダーパール確保
M4: エンダーアイ生成 → 要塞発見 → ジ・エンド到達 → ドラゴン討伐
```
各段で「一次ログ＋在庫」を証拠として残し、`ARCHITECTURE.md` と issue を更新する。