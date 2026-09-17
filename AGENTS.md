# AGENTS.md — mc-ai グローバル指示（全エージェント必読）

> このファイルは `/home/s0u7a/mc-ai` で作業する**すべてのエージェント**に対する最上位の指示。
> 作業前に必ず読むこと。詳細は `buddy-driver/AGENTS.md`、設計は `RESIDENT-MODE.md` / `PLANNERS.md`、現状は `ARCHITECTURE.md`。

## 0. 標準指令（ユーザー指示・恒久）
1. **最終目標は M4（Ender Dragon 討伐）**。M2（鉄器時代）は通過点。
2. **ユーザーの発言を待たない。指示待ちをしない。** やることが無ければ**自分で仕事を考えて着手する**。
3. 判断に迷ったら「**P1 durability / actuation safety を壊さない**」を最優先し、次に「将来の二重実装を避ける」、次に「M4への距離を縮める」を基準にする。
4. 進捗は必ず一次証拠（ログ行・在庫・コミット）で残す。主観や推測で「できた」と言わない。
5. 作業単位ごとに小さくコミット＆push（秘密スキャン必須）。
6. 人間は基本不在。危険操作（サーバー停止・world削除・履歴改変・force push）はしない。

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
0. P1 safety/durability は常時ブロッカー
   #5 atomic state / #13 listener leak / #28 disconnect lease / #38 nested actuation bypass /
   #40 authoritative snapshot など。壊れている場合は他作業より先に直す。

1. #11 Grounded Options の骨格を前倒し
   #21 OptionSpec + PlannedGoal->Option compiler
   #20 SkillCandidate contract
   #14 known-resource coordinates + #29 strategy grounding
   ※ GoalQueue / Guard / Executor / resident は捨てない。

2. #11 shadow/評価基盤
   #22 abandon_option β shadow
   #32 raw Boolean probability保持
   #36 causal IDs
   #23 replay A/B harness

3. 現行Mercury correctnessを並行で最小修正
   #15 cache replay / #30 patch tail / #18 retry accounting / #16 world scope / #19 explicit operation
   旧plannerを大規模拡張しない。

4. #24 β termination controller
   replay/calibrationで勝ってからauthorityを与える。hysteresis/corroboration/cooldown必須。

5. M2を新しいOption境界の上で完走
   furnace -> charcoal -> raw_iron -> iron_ingot×3 -> iron_pickaxe

6. #35 semantic planner重複を整理
   #11が実測で勝った後だけ Advisor/PlannerBrain/Jev/Mercury の重複責務を削る。

7. #41 predicate-based capability graph
   M3/M4の非item objectiveを追加する前に依存関係/成功述語の表現を一般化。

8. M3/M4
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
#12 LADDER_PREREQ 修正は main に landed（3866d3d）。live acceptanceは継続確認する。
movement root cause #7/#8/#9 の修正も landed。live挙動はresident安定後に再検証する。
Mercury System2 は live。現行 correctness issue #15/#30/#18 等は残る。
listenerLeak=true の観測あり (#13)。
RETURN_TO_KNOWN_ORE は WorldMemory が ore座標を持たないため未接地 (#14)。
Advisor の複数strategyが身体側で同一goalへ潰れる (#29)。
actuation lease はあるが nested capability bypass が残る (#38)。
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
M1: 3 log -> crafting_table -> wooden_pickaxe -> cobblestone（検証済み・維持）
M2: furnace -> charcoal -> iron_ore -> iron_ingot×3 -> iron_pickaxe（在庫で証明）
M3: ダイヤ入手 -> ダイヤ装備 -> ネザー到達 -> ブレイズロッド・エンダーパール確保
M4: エンダーアイ生成 -> 要塞発見 -> ジ・エンド到達 -> ドラゴン討伐
```
各段で「一次ログ＋在庫/述語」を証拠として残し、`ARCHITECTURE.md` と issue を更新する。

## 6. Issueキュー（アーキ前倒し版）

### A. substrate correctness — いつでも最優先
```
#5  speculative generation durable mutation
#13 listener leak
#28 disconnect lease revoke
#38 nested actuation capability bypass
#40 authoritative AgentSnapshot / state classes
```

### B. #11 architecture skeleton — 新機能より先
```
#21 OptionSpec / deterministic predicates / PlannedGoal compiler
#20 grounded SkillCandidate contract
#14 known resource coordinates
#29 strategy -> executable skill grounding
```

### C. shadow + evaluation
```
#22 β shadow
#32 raw Jev Boolean probability
#36 end-to-end causal IDs
#23 replay A/B harness
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
#24 β meta-controller
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
