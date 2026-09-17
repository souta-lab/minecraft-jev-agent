# PLANNERS.md — 3つの「プランナ」の責務分離（Issue #35 相当）

> このプロジェクトには名前が似た層が3つあり、混同すると設計が崩れる。ここで境界を確定する。
> 関連: `RESIDENT-MODE.md` §14（Grounded Options）、`AGENTS.md`（優先順）、issue #11 / #12 / #15 / #29 / #30 / #35

## 1. 三層と責務
```
(1) Deterministic ladder      = 通常経路のプランナ。在庫から次の一段を決定論で導出する
    （wood -> table -> pickaxe -> cobblestone -> furnace -> charcoal -> raw_iron -> iron_ingot -> ...）
    長所: 再現性・低コスト・デバッグ容易。短所: 状況適応しない

(2) Mercury System2Brain      = 例外駆動の plan repair。停滞/楔/死亡復帰など「ladderが詰まった」時だけ呼ぶ
    返すのは plan データのみ（op=continue|patch|replace|abort, goals[], reason）。行動は返さない
    長所: 状況に応じた方針転換。短所: 4〜7秒・$0.0002/call・確率的

(3) Jev                        = Option 内の即時方針。π(action) と β(abandon_option)
    「この Option の中で次にどの接地候補を選ぶか」と「この Option を放棄すべきか」だけを答える
    長所: 高速・接地・確率。短所: 長期意図は持てない
```

## 2. あるべきフロー（Issue #11 Grounded Options）
```
Mercury or deterministic ladder
        │  Option（意図）＋ 事前条件 I(o) ＋ 成功述語 success(s,o)（コードが所有）
        ▼
   GoalQueue（HOST が唯一の durable writer）
        │
        ▼
Jev:  action = π(a|s,o)   ／  abandon_option = β(s,o)
        │
        ▼
   Guard（決定論・物理的真実・hard hazards） → Executor → VERIFY（座標/在庫で検証）
        │
        └─ β が閾値超え → Mercury へ再計画要求（または決定論 ladder へフォールバック）
```

## 3. 現在の実装状態と既知の欠陥
```
・Mercury は live（実測 16/18成功・約4秒・$0.00019・op=replace で GoalQueue 反映）
・Jev は多質問構成（action / goal_progress / plan_still_valid / situation_understood /
  goal_blocked / strategy_change_needed）。#11 により action + abandon_option の2ヘッドへ移行予定
・#12: PRECONDITION_MISSING が停止条件になっていた（前提チェーン差し替えを実装中。LADDER_PREREQ 稼働）
・#15: cache hit 時に cached plan を捨てて continue [] を返し得る（未検証＝cache 経路が未踏）
・#30: patch/replace で plan の tail が PlannerBrain に捨てられ得る
・#29: ★重要 — advisor が explore_cave / branch_mine / return_to_known_ore を別戦略として選んでも、
        石ツルハシ以降は下位層では全部「collect raw_iron x3」に潰れて区別不能。
        つまり strategy ログが賢く見えても身体行動に反映されない
```

## 4. やってはいけないこと（アンチパターン）
```
・LLM を通常経路の唯一のプランナにする（再現性・コスト・失敗時の停止が壊れる）
・LLM に行動（Action）を返させる（行動権限は System One のみ）
・subgoal_done / goal_done をモデルに決めさせる（決定論的述語であるべき）
・戦略名だけログに出して、下位層の候補・目標が変わらない（#29）
・cache hit で plan を空にする（#15）／patch・replace で tail を落とす（#30）
・plan を lease commit 前に durable へ書く（#5）
```

## 5. M4 へ向けた拡張順（planner 側）
```
1. #12 前提チェーン差し替えを安定化（ticks>=100 が常態、churn 1桁/時）
2. #29 戦略 → 身体行動の接地（戦略ごとに候補・目標を実際に変える）
3. #15/#30 Mercury の plan 取り扱い（cache は plan を再生、patch/replace は tail を保持）
4. #20〜#24 Grounded Options の実装単位（skill candidates → OptionSpec → β shadow → A/B harness → β controller）
5. 新規 Option テンプレート（M3/M4: ダイヤ、ネザー、ブレイズ、パール、エンダーアイ、要塞、エンド、ドラゴン）
   → 必要プリミティブは issue #37 を参照
```

## 6. 検証（proxy signal を避ける）
```
・通常経路: 決定論 ladder が進んでいること（MILESTONE/在庫で確認）
・例外経路: PLAN/ADVISOR source=mercury と STRATEGY_SET、mercury-calls.jsonl の error=null
・接地: 選ばれた戦略に対応する候補/目標が実際に変わっていること（#29 の受け入れ）
・安全性: Guard が実行直前に再検証していること、hard hazards がコード側にあること
・道具: node tools/buddy-status.mjs / verify-issue12 / verify-issue13 / verify-mercury
```