# PLANNERS.md — planner / Option / Jev の責務分離

> このプロジェクトには名前が似た判断層が複数あり、混同すると設計が崩れる。ここで境界を確定する。
> 関連: `docs/operations/RESIDENT-MODE.md` §14（Grounded Options）、`AGENTS.md`（優先順）、issue #11 / #20-#24 / #35 / #41

## 1. 層と責務
```
(1) Deterministic ladder / capability graph
    = 通常経路の依存関係・前提・成功条件をコードで管理する
    現在: wood -> table -> pickaxe -> cobblestone -> furnace -> charcoal -> raw_iron -> ...
    将来: #41 predicate-based capability / Option graph
    長所: 再現性・低コスト・物理的真実。モデルに委譲しない

(2) Mercury System2Brain
    = 例外駆動の Option / plan repair。通常hot pathには入らない
    返すのは接地可能な高レベル意図/Optionだけ。Minecraftの即時Actionは返さない
    長所: 新しい候補構造を生成できる。短所: 数秒・確率的

(3) Option / Skill layer
    = 上位意図を、実行可能な時間的抽象へコンパイルする中間層
    Option: I(o) / success(s,o) / allowed skills / failure budget
    Skill: BRANCH_MINE / RETURN_TO_KNOWN_ORE / EXPLORE_FRONTIER 等をコードで接地

(4) Jev
    = Option 内の強い局所判断器
    π(action | s,o) : grounded candidate / skill Choice
    β(s,o)          : abandon_option Boolean probability
    長期plan生成ではなく、与えられた接地候補から賢く選ぶ
```

## 2. 本命フロー（Issue #11 Grounded Options）
```
Mission objective
        │
        ▼
deterministic capability/dependency graph
        │                  ▲
        │ executable Option│ sparse repair
        ▼                  │
OptionSpec / OptionRuntime ├──── Mercury System2
 I(o) / success(s,o)       │
        │
        ├─ grounded SkillCandidates / primitive candidates
        ▼
Jev: action = π(a|s,o)  +  abandon_option = β(s,o)
        │                          │
        ▼                          └─ deterministic meta-controller -> System2 when justified
Guard -> Executor -> VERIFY
        │
        └─ verified progress / world memory / success predicate
```

`GoalQueue` は移行中も捨てない。**実行台帳/履歴として維持し、PlannedGoal -> OptionSpec compiler を挟む**。

## 3. 移行方針: schemaを早く、authorityを遅く

Issue #11 は従来「P5研究」として後ろに置いていたが、今後 M2/M3/M4 の機能を旧表現へ大量追加してから変更すると二重実装になる。

したがって方針を変更する:

> **early schema/control-surface migration, late authority migration**

先に導入する:
```
OptionSpec / OptionRuntime の型
PlannedGoal -> Option compiler
SkillCandidate contract
predicate / capability registry
β の shadow logging / causal ids
```

まだ変更しない:
```
Guard / VERIFY の権限
Executor の単一Action所有
既存 GoalQueue の durable history
Jev β による自動replan authority
現在の多質問Jev diagnosticsの削除
```

これにより、M1/M2で既に動いたコードを捨てず、今後の機能を新しい境界の上へ積める。

## 4. 現在の実装状態と既知の欠陥
```
・Mercury は live。例外駆動 System2Brain として実応答・GoalQueue反映まで確認済み
・Jev は現在 multi-question 構成。action authorityは既にgrounded Choice
・#12 LADDER_PREREQ 実装は main に landed。live acceptance は継続確認
・#15 Mercury cache replay / #30 patch tail は現行correctnessとして修正・検証が必要
・#29 advisor strategy collapse: 別戦略が下位では同じ collect raw_iron へ潰れる
・#14 Known ore は名前のみで座標を失うため RETURN_TO_KNOWN_ORE を接地できない
・#38 actuation capability boundary / #40 authoritative snapshot は P1 substrate として並行して硬化
```

## 5. やってはいけないこと
```
・#11 のために resident / Guard / Executor / GoalQueue を一気に書き直す
・Mercury を通常hot pathのAction plannerにする
・Jev/Mercury に subgoal_done / world truth / safety を決めさせる
・新しいM3/M4機能を fake targetItem と自然言語strategyだけで増やす
・自由文の座標 / entity id / skill parameters をモデルに生成させる
・旧Planner/Advisorを大規模refactorしてから #11 でまた置換する
・現行correctness bug (#5/#13/#15/#30/#38 等) を「どうせアーキ変更するから」で放置する
```

## 6. 前倒しした実装順
```
0. P1 safety/correctness は常に優先
   #5 / #13 / #28 / #38 / #40 など、state/actuationの破壊につながるものは先に/並行して直す

1. #21 OptionSpec + PlannedGoal -> Option compiler
   - 既存 collect/craft/place/smelt をそのまま表現
   - initiation / success は決定論
   - GoalQueue は台帳として維持

2. #20 SkillCandidate contract + #14/#29 grounding
   - BRANCH_MINE
   - RETURN_TO_KNOWN_ORE
   - EXPLORE/FRONTIER
   - strategy名が本当に異なる身体行動へコンパイルされること

3. #22 + #32 + #36 shadow instrumentation
   - abandon_option β を authorityなしで追加
   - raw probabilityを保持
   - Option -> Jev -> Action -> VERIFY の causal id

4. #23 replay / A-B
   - current multi-signal controller vs π/β
   - guard rejection / progress / useful termination / calibration

5. #24 β termination controller
   - hysteresis / corroboration / cooldown
   - hard deterministic invalidity はβを待たず処理

6. #35 consolidation
   - #11が勝った後だけ PlannerBrain-Jev / Advisor-Jev / Mercury の意味重複を整理

7. #41 predicate-based capability graph
   - M3/M4の非item objectiveを新表現の上で追加
```

`#15/#30` など Mercury の現行 correctness bug は上記と**並行して最小修正**する。ただし旧planner表現を大規模に拡張しない。

## 7. M4 へ向けたルール

現在のM2境界は、旧鉄器時代の完走ではなく、ダイヤ獲得後からネザーゲートを
構築・着火・検証するまでとする。旧furnace/iron ladderはM2の前提能力を供給する
下位経路およびhistorical evidenceとして再利用する。ゲート以降のdimension entry
とblaze/pearl/eyesはM3以降で扱う。

M3/M4機能を追加する前に、その機能がどの層に属するか決める:

```
Mission predicate / dependency -> capability graph
時間的にまとまった行動        -> Option / Skill
瞬間的な候補選択              -> Jev π
Option継続可否のsemantic判断  -> Jev β + meta-controller
安全性 / 成功 / world truth   -> deterministic code
物理実行                      -> Executor / Mineflayer
```

M3/M4の具体プリミティブは issue #37、mission表現は #41 を参照。

## 8. 検証（proxy signal を避ける）
```
・通常経路: verified progress / 在庫 / predicate が進むこと
・Option: initiation/successを純粋テストできること
・Skill: strategyごとに実際のgrounded target/candidateが変わること
・Jev: actionはgrounded、βはraw probabilityを記録
・System2: sparse callが本当にplan/Optionを変更し、その後の行動へ因果接続すること
・安全性: Guard/VERIFY/hard hazards は常にコード権限
・resident: reload/restart後もOption/GoalQueue/world memoryが矛盾しないこと
```
